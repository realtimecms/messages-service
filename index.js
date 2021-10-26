const app = require("@live-change/framework").app()

require('moment')
require('moment-timezone')
require('../../i18n/ejs-require.js')


const definition = require('./definition.js')

require('./message.js')
require("./privateConversation.js")
require('./notifications.js')
require('./welcomeMessage.js')

module.exports = definition

async function start () {
  if(!app.dao) {
    await require('@live-change/server').setupApp({})
    await require('@live-change/elasticsearch-plugin')(app)
  }

  app.processServiceDefinition(definition, [...app.defaultProcessors])
  await app.updateService(definition)//, { force: true })
  const service = await app.startService(definition, { runCommands: true, handleEvents: true })

  /*require("../config/metricsWriter.js")(definition.name, () => ({

  }))*/
}

if (require.main === module) start().catch(error => {
  console.error(error)
  process.exit(1)
})


