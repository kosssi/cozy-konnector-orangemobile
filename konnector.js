'use strict'

const request = require('request')
// require('request-debug')(request)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// const localization = require('../lib/localization_manager')
const {log, updateOrCreate, models, cozyClient} = require('cozy-konnector-libs')
const baseKonnector = require('./base_konnector_with_remember')

const GeoPoint = models.baseModel.createNew({name: 'org.fing.mesinfos.geopoint', displayName: 'geopoint'})
const PhoneCommunicationLog = models.baseModel.createNew({name: 'org.fing.mesinfos.phonecommunicationlog', displayName: 'phonecommunicationlog'})

const API_ROOT = 'https://mesinfos.orange.fr'

/*
 * The goal of this connector is to fetch event from facebook and store them
 * in the Cozy
 */
const connector = module.exports = baseKonnector.createNew({
  name: 'Orange Mobile',
  customView: '<%t konnector customview orange_mobile %>',

  connectUrl: 'https://mesinfos.orange.fr/auth?redirect_url=',
  category: 'telecom',
  color: {
    hex: '#FF6600',
    css: '#FF6600'
  },

  fields: {
    frequency: {
      type: 'dropdown',
      default: 'weekly',
      advanced: true,
      options: ['hourly', 'daily', 'weekly', 'monthly']
    },
    access_token: {
      type: 'hidden'
    },

    orangeGeolocOptin: {
      type: 'checkbox'
    }
  },
  dataType: ['geopoint', 'phonecommunicationlog'],
  models: [GeoPoint, PhoneCommunicationLog],

  fetchOperations: [
    initProperties,
    checkToken,
    setGeolocOptin,
    checkGeolocOptinState,
    downloadGeoloc,
    downloadCRA,
    updateOrCreate(log, GeoPoint, ['msisdn', 'timestamp']),
    updateOrCreate(log, PhoneCommunicationLog, ['msisdn', 'timestamp']),
  ],
})

function initProperties (requiredFields, entries, data, next) {
  requiredFields.remember = requiredFields.remember || {}
  next()
}

function checkToken (requiredFields, entries, data, next) {
  log('info', 'requiredFields')
  log('info', requiredFields)
  const token = requiredFields.access_token
  if (!token) { return next('token not found') }

  try {
    let payload = token.split('.')[1]
    payload = JSON.parse(new Buffer(payload, 'base64').toString())

    if (payload.token_type !== 'mobile') {
      log('error', `Wronk token_type for this konnector: ${payload.token_type}`)
    // TODO: stub !   return next('not mobile token')
    }

    next()
  } catch (e) {
    log('error', `Unexpected token format: ${e}`)
    next('token not found')
  }
}


function setGeolocOptin (requiredFields, entries, data, next) {
  // if user change, set token.
  if (requiredFields.orangeGeolocOptin !== requiredFields.remember.orangeGeolocOptinPreviousState) {
    log('info', 'Setting geoloc optin for Orange...')
    const setOpt = requiredFields.orangeGeolocOptin ? 'in' : 'out'
    requestOrange(`${API_ROOT}/profile/locopt?opt=${setOpt}`,
      requiredFields.access_token,
      (err, body) => {
        if (err) {
          log('error', `While setting geoloc optin: ${err}`)
          data.errors = data.errors || []
          data.errors.push('setting orange optin error')

          // continue on error (to fetch CRA data at least)
          return next()
        }
        log('info', `Just set: ${body.result}`)
        next()
      })
  } else {
    next()
  }
}


function checkGeolocOptinState (requiredFields, entries, data, next) {
  log('info', 'Check geoloc opt-in state for Orange...')

  requestOrange(`${API_ROOT}/profile/locopt`, requiredFields.access_token,
    (err, res) => {
      // Default: set as no optin.
      let optin = false

      if (err) {
        log('error', `Can't check orange Geoloc opt-in: ${err}`)
        data.errors.push('checking orange optin error')
        // Continue on errors
      }

      if (!err && res && res.result === 'geolc opt-in') {
        optin = true
      }

      requiredFields.remember.orangeGeolocOptinPreviousState = optin

      // update in datasystem if changed
      if (optin !== requiredFields.orangeGeolocOptin) {
        return cozyClient.data.updateAttributes('io.cozy.accounts', requiredFields.konnectorAccountId,
          {
            auth: {
              access_token: requiredFields.access_token,
              orangeGeolocOptin: optin,
            }
          })
        .then(() => next())
        .catch((err) => next(err))
      }

      next()
    })
}


function downloadGeoloc (requiredFields, entries, data, next) {
  if (!requiredFields.orangeGeolocOptin) {
    log('info', 'No geoloc optin, skiping')
    data.errors = data.errors || []
    data.errors.push('no orange geoloc optin')
    return next()
  }

  log('info', 'Downloading geoloc data from Orange...')

  // TODO: don't download if opt out.
  let uri = `${API_ROOT}/data/loc`
  if (requiredFields.remember.lastGeoPoint) {
    uri += `?start=${requiredFields.remember.lastGeoPoint.slice(0, 19)}`
  }

  requestOrange(uri, requiredFields.access_token, (err, body) => {
    if (err) { return next(err) }
    entries.geopoints = []
    body.forEach((point) => {
      if (point.ts && (!requiredFields.remember.lastGeoPoint
        || requiredFields.remember.lastGeoPoint < point.ts)) {
        requiredFields.remember.lastGeoPoint = point.ts
      }
      if (point.err) { return }

      entries.geopoints.push({
        docType: 'GeoPoint',
        docTypeVersion: connector.docTypeVersion,
        msisdn: point.msisdn,
        timestamp: point.ts,
        longitude: point.loc[0],
        latitude: point.loc[1],
        radius: point.rad
      })
    })

    next()
  })
}


function downloadCRA (requiredFields, entries, data, next) {
  log('info', 'Downloading CRA data from Orange...')

  let uri = `${API_ROOT}/data/cra`
  if (requiredFields.remember.lastPhoneCommunicationLog) {
    uri += `?start=${requiredFields.remember.lastPhoneCommunicationLog.slice(0, 19)}`
  }

  requestOrange(uri, requiredFields.access_token, (err, body) => {
    if (err) { return next(err) }

    // map SMS_C for further concat in one SMS object.
    const smsCByTs = body.filter(cra => cra.desc.indexOf('SMS_C') === 0)
      .reduce((agg, smsC) => {
        agg[smsC.ts] = smsC
        return agg
      }, {})

    entries.phonecommunicationlogs = []

    body.forEach((cra) => {
      try {
        if (cra.time && (!requiredFields.remember.lastPhoneCommunicationLog
          || requiredFields.remember.lastPhoneCommunicationLog < cra.time)) {
          requiredFields.remember.lastPhoneCommunicationLog = cra.time
        }
        if (cra.err || cra.desc.indexOf('SMS_C') === 0) { return }

        if (cra.desc.indexOf('SMS ') === 0) {
          // Try to merge informations
          const smsC = smsCByTs[cra.ts]
          if (smsC) {
            cra.length = smsC.units
            cra.chipType = 'c'
          }
        }

        entries.phonecommunicationlogs.push({
          docType: 'PhoneCommunicationLog',
          docTypeVersion: connector.docTypeVersion,
          timestamp: cra.time,
          msisdn: cra.msisdn,
          partner: cra.partner,
          length: cra.units,
          chipType: cra.typ_units,
          longitude: cra.loc ? cra.loc[0] : undefined,
          latitude: cra.loc ? cra.loc[1] : undefined,
          networkType: cra.net_lbl,
          type: cra.desc,
          endCause: cra.end_cause
        })
      } catch (e) {
        log('error', 'While parsing CRA.')
        log('error', e)
      }
    })
    next()
  })
}


// // // // //
// Helpers //


function requestOrange (uri, token, callback) {
  log('info', uri)

  request.get(uri, { auth: { bearer: token }, json: true }, (err, res, body) => {
    if (err) {
      log('error', `Download failed: ${err}`)
      return callback(err)
    }
    if (res.statusCode.toString() !== '200') {
      err = `${res.statusCode} - ${res.statusMessage} ${err || ''}`
      log('error', body)
    }

    callback(null, body)
  })
}

// function buildNotifContent (requiredFields, entries, data, next) {
//   // data.updated: we don't sepak about update, beacause we don't now if the
//   // update actually changes the data or not.

//   // Signal all add of document.
//   const addedList = []
//   Object.keys(data.created).forEach((docsName) => {
//     const count = data.created[docsName]
//     if (count > 0) {
//       addedList.push(localization.t(
//         `notification ${docsName}`, { smart_count: count }))
//     }
//   })

//   entries.notifContent = addedList.join(', ')
//   next()
// }
