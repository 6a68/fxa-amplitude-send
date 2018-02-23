// Ideally this would have been written in python too but, alas, pyarrow fails
// with `pyarrow.lib.ArrowNotImplementedError` when reading `event_map_values`.
// That column contains the server timestamp, which we need.

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const { ParquetReader } = require('node-parquet')
const path = require('path')
const Promise = require('bluebird')
const request = require('request-promise')
const s3 = require('s3')

fs.unlinkAsync = Promise.promisify(fs.unlink)

const MARKER_PATH = path.resolve('.sync-marker')
const DATE = /^(20[1-9][0-9])-([01][0-9])-([0-3][0-9])$/
const PARQUET_FILE = /\.parquet$/i
const AWS_ACCESS_KEY = process.env.FXA_AWS_ACCESS_KEY
const AWS_SECRET_KEY = process.env.FXA_AWS_SECRET_KEY
const AWS_S3_BUCKET = 'telemetry-parquet'
const AWS_S3_PREFIX = 'sync_events/v1/'
const MAX_EVENTS_PER_BATCH = 10
const HMAC_KEY = process.env.SYNC_INSERTID_HMAC_KEY
const API_KEY = process.env.FXA_AMPLITUDE_API_KEY

const argc = process.argv.length
if (! (argc >= 2 && argc <= 4)) {
  console.error(`Usage: ${process.argv[1]} [YYYY-MM-DD | LOCAL PATH] [--report-only]`)
  console.error('If specifying YYYY-MM-DD as the arg, note that the script will try to send events')
  console.error('for all dates from YYYY-MM-DD to the most recent available in S3. If any dates in')
  console.error('that range are missing, they will be skipped without failing the process.')
  process.exit(1)
}

if (! HMAC_KEY || ! API_KEY) {
  console.error('Error: You must set SYNC_INSERTID_HMAC_KEY and FXA_AMPLITUDE_API_KEY environment variables')
  process.exit(1)
}

let localPath
const reportOnly = process.argv[argc - 1] === '--report-only'
const dateParts = getDateParts()
if (dateParts && dateParts.length === 4) {
  if (! AWS_ACCESS_KEY || ! AWS_SECRET_KEY) {
    console.error('Error: You must set AWS_ACCESS_KEY and AWS_SECRET_KEY environment variables')
    process.exit(1)
  }
} else {
  localPath = process.argv[2]
}

Promise.resolve()
  .then(() => {
    if (localPath) {
      return processData(readLocalData(process.argv[2]))
    }

    return processDataFromS3(`${dateParts[1]}${dateParts[2]}${dateParts[3]}`)
      .then(({ dates, eventCounts }) => {
        console.log('days:', dates.length, dates)
        const date = dates[0]
        fs.writeFileSync(MARKER_PATH, `${date.substr(0, 4)}-${date.substr(4, 2)}-${date.substr(6)}`)
        return eventCounts
      })
  })
  .then(eventCounts => {
    let sum = 0
    Object.entries(eventCounts).forEach(entry => {
      const [ key, eventCount ] = entry
      console.log(`${key}: ${eventCount}`)
      sum += eventCount
    })
    console.log('sum:', sum)
  })
  .catch(error => {
    console.error(error)
    process.exit(1)
  })

function getDateParts () {
  if (argc === 2 || (argc === 3 && reportOnly)) {
    return DATE.exec(fs.readFileSync(MARKER_PATH, 'utf8').trim())
  }

  return DATE.exec(process.argv[2])
}

function readLocalData (fileName) {
  const reader = new ParquetReader(fileName)
  const schema = parseSchema(reader.info().spark_schema)
  const rows = reader.rows()
  reader.close()
  return { schema, rows }
}

function parseSchema (source, shift = 0) {
  return Object.keys(source).reduce((target, key, index) => {
    const item = source[key]
    const nestedItem = item.key_value
    if (nestedItem) {
      target[key] = parseSchema(nestedItem, index + shift)
      shift += Object.keys(nestedItem).length - 1
    } else {
      target[key] = index + shift
    }
    return target
  }, {})
}

function processData ({ schema, rows }) {
  const eventCounts = createEventCounts()
  let batch = []

  return Promise.all(rows.map(row => {
    const event = createEvent(schema, row)
    if (! event) {
      eventCounts.skipped += 1
      return
    }

    eventCounts[event.event_type.split(' ')[2]] += 1

    batch.push(event)
    if (batch.length < MAX_EVENTS_PER_BATCH) {
      return
    }

    const localBatch = batch.slice()
    batch = []
    return sendBatch(localBatch)
  }))
    .then(() => {
      if (batch.length > 0) {
        return sendBatch(batch)
      }
    })
    .then(() => eventCounts)
}

function createEventCounts () {
  return {
    tab_sent: 0,
    tab_received: 0,
    repair_triggered: 0,
    repair_success: 0,
    skipped: 0
  }
}

function createEvent (schema, row) {
  const eventType = getEventType(row[schema.event_method], row[schema.event_object])
  if (! eventType) {
    return
  }

  // serverTime is not at all accurate as an event timing, but it's the best thing we have
  const time = getServerTime(row[schema.event_map_values.key], row[schema.event_map_values.value])
  if (! time || time < 0) {
    return
  }

  const uid = row[schema.uid]
  const syncFlowId = row[schema.event_flow_id]
  const appName = row[schema.app_name]
  const appVersion = row[schema.app_version]

  return Object.assign({
    event_type: `sync - ${eventType}`,
    time,
    // user_id is already hashed in Sync telemetry data
    user_id: uid,
    // TODO: include device_id when we have a plan for matching it to the other events
    session_id: -1,
    insert_id: hash(uid, row[schema.device_id], syncFlowId, time, row[schema.event_timestamp], eventType),
    app_version: appVersion,
    language: row[schema.device_os_locale],
    event_properties: {
      ua_browser: appName,
      ua_version: appVersion,
      flow_id: syncFlowId
    }
  }, getOs(row[schema.device_os_name], row[schema.device_os_version]))
}

function getEventType (method, object) {
  if (method === 'displayURI') {
    return getSendTabEventType(object)
  }

  if (object === 'repair') {
    return getRepairEventType(method)
  }
}

function getSendTabEventType (object) {
  switch (object) {
    case 'sendcommand':
      return 'tab_sent'

    case 'processcommand':
      return 'tab_received'
  }
}

function getRepairEventType (method) {
  switch (method) {
    case 'started':
      return 'repair_triggered'

    case 'finished':
      return 'repair_success'
  }
}

function getServerTime (keys, values) {
  let serverTimeIndex

  if (keys.some((key, index) => {
    if (key === 'serverTime') {
      serverTimeIndex = index
      return true
    }
  })) {
    return parseInt(values[serverTimeIndex] * 1000)
  }
}

function hash (...properties) {
  const hmac = crypto.createHmac('sha256', HMAC_KEY)

  properties.forEach(property => hmac.update(`${property}`))

  return hmac.digest('hex')
}

function getOs (deviceOsName, deviceOsVersion) {
  if (! deviceOsName) {
    return
  }

  switch (deviceOsName) {
    case 'Windows_NT':
      return {
        os_name: 'Windows',
        os_version: deviceOsVersion
      }

    case 'Darwin':
      return {
        os_name: 'Mac OS X',
        os_version: getMacOsVersion(deviceOsVersion)
      }

    default:
      return {
        os_name: deviceOsName,
        os_version: deviceOsVersion
      }
  }
}

function getMacOsVersion (deviceOsVersion) {
  const parts = deviceOsVersion.split('.')
  if (parts.length < 2) {
    return
  }

  const major = parseInt(parts[0])
  const minor = parseInt(parts[1])

  if (major >= 5 && minor >= 0) {
    // https://en.wikipedia.org/wiki/Darwin_(operating_system)#Release_history
    return `10.${major - 4}.${minor}`
  }
}

function sendBatch (batch) {
  if (! reportOnly) {
    return request('https://api.amplitude.com/httpapi', {
      method: 'POST',
      formData: {
        api_key: API_KEY,
        event: JSON.stringify(batch)
      }
    })
  }
}

function processDataFromS3 (fromDate) {
  const client = s3.createClient({
    s3Options: {
      accessKeyId: AWS_ACCESS_KEY,
      secretKey: AWS_SECRET_KEY,
    }
  })

  return getKeysFromS3(client, fromDate)
    .then(keys => processKeyFromS3(client, keys, 0))
}

function getKeysFromS3 (client, fromDate) {
  return new Promise((resolve, reject) => {
    const keys = []
    const emitter = client.listObjects({
      s3Params: {
        Bucket: AWS_S3_BUCKET,
        Marker: `${AWS_S3_PREFIX}submission_date_s3=${fromDate}`,
        Prefix: AWS_S3_PREFIX
      }
    })
    emitter.on('error', error => reject(error))
    emitter.on('data', data => data.Contents.forEach(datum => {
      const key = datum.Key
      if (PARQUET_FILE.test(key)) {
        keys.push(key)
      }
    }))
    emitter.on('end', () => resolve(keys))
  })
}

function processKeyFromS3 (client, keys, index) {
  if (index === keys.length) {
    return Promise.resolve({ eventCounts: createEventCounts(), dates: [] })
  }

  // Sadly, node-parquet doesn't read from in-memory data yet.
  // Feature request here: https://github.com/skale-me/node-parquet/issues/53
  //return readDataFromS3(client, keys, index)
  return downloadFileFromS3(client, keys, index)
    .then(fileName => {
      const data = readLocalData(fileName)
      return Promise.all([ processData(data), fs.unlinkAsync(fileName) ])
    })
    .spread(eventCounts =>
      processKeyFromS3(client, keys, index + 1)
        .then(result => ({
          eventCounts: Object.entries(eventCounts).reduce((sums, entry) => {
            const [ key, eventCount ] = entry
            sums[key] = eventCount + result.eventCounts[key]
            return sums
          }, createEventCounts()),
          dates: result.dates.concat(keys[index].split('=')[1].substr(0, 8))
        }))
    )
}

//function readDataFromS3 (client, keys, index) {
//  return new Promise((resolve, reject) => {
//    const emitter = client.downloadBuffer({
//      Bucket: AWS_S3_BUCKET,
//      Key: keys[index]
//    })
//    emitter.on('error', error => reject(error))
//    emitter.on('end', result => resolve(result))
//  })
//}

function downloadFileFromS3 (client, keys, index) {
  return new Promise((resolve, reject) => {
    const key = keys[index]
    const fileName = path.resolve(`${key.split('=')[1].replace('/', '-')}`)
    const emitter = client.downloadFile({
      localFile: fileName,
      s3Params: {
        Bucket: AWS_S3_BUCKET,
        Key: keys[index]
      }
    })
    emitter.on('error', error => reject(error))
    emitter.on('end', () => resolve(fileName))
  })
}
