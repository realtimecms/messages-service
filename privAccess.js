const { combineRoles } = require('../config/roles.js')
const app = require("@live-change/framework").app()

function privAccess(definition) {


  const { getAccess, hasRole, checkIfRole, getPublicInfo,
    Access, SessionAccess, PublicSessionInfo, Membership } =
      require("../access-control-service/access.js")(app, definition)

  const PrivateConversation = definition.foreignModel('messages', 'PrivateConversation')

  async function checkPrivAccess(id, { client }) {
    const conversation = await PrivateConversation.get(id)
    if(!conversation) return false
    if(client.user) {
      return conversation.user1 == client.user || conversation.user2 == client.user
    } else {
      const publicSessionInfo = await getPublicInfo(client.sessionId)
      return conversation.session1 == publicSessionInfo || conversation.session2 == publicSessionInfo
    }
  }

  return { checkPrivAccess }

}

module.exports = privAccess
