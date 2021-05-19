const app = require("@live-change/framework").app()
const definition = require('./definition.js')
const welcomeMessage = require('../config/welcomeMessage.js')(definition)
const { PrivateConversation, privateConversationParticipants } = require('./privateConversation.js')

const User = definition.foreignModel('users', 'User')
const Session = definition.foreignModel('session', 'Session')

if(welcomeMessage.welcomeMessage) {
  definition.trigger({
    name: "OnRegisterComplete",
    properties: {
      session: {
        type: Session
      },
      user: {
        type: User
      },
      userData: {
        type: Object
      }
    },
    async execute({ user, session, userData }, context, emit) {
      let message = await welcomeMessage.welcomeMessage(userData)
      if(!message) return
      const me = { user: message.user }
      const other = { user }
      const participants = privateConversationParticipants(me, other)
      const conversationId = app.generateUid()
      let conversation = { ...participants }
      emit({
        type: "privateConversationCreated",
        conversation: conversationId,
        ...conversation
      })
      conversation = { id: conversationId, ...conversation }
      await PrivateConversation.create(conversation)
      const toType = 'priv'
      const toId = conversation.id
      const channelId = `${toType}_${toId}`
      const messageId = `${channelId}_${message.timestamp}`
      message = {
        ...message,
        toType,
        toId
      }
      emit({
        type: "MessageCreated",
        message: messageId,
        data: message
      })
      await app.trigger({
        type: 'readHistoryEvent',
        fromUser: message.user,
        toUsers: [user],
        toSessions: [],
        toType, toId, eventId: messageId
      })
    }
  })
}
