const konnector = require('./konnector')
const {log} = require('cozy-konnector-libs')

const cozyFields = JSON.parse(process.env.COZY_FIELDS)

konnector.fetch({account: cozyFields.account}, err => {
  log('debug', 'The konnector has been run')
  if (err) {
    log('error', err)
    process.exit(1)
  }
})
