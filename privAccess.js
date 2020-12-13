const { combineRoles } = require('../config/roles.js')

function privAccess(app, definition) {

  const Conversation = definition.foreignModel('messages', 'Conversation')
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
