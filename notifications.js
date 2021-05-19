const definition = require('./definition.js')

const i18n = require('../../i18n')
const purify = require('../config/purify.js')

const { PrivateConversation } = require('./privateConversation.js')
const { Message } = require('./message.js')
const User = definition.foreignModel('users', 'User')

definition.trigger({
  name: "renderPrivateMessagesEmailNotification",
  properties: {
    user: {
      type: User
    },
    toId: {
      type: String
    },
    reply: {
      type: Boolean
    },
    gt: {
      type: String
    },
    lte: {
      type: String
    }
  },
  async execute({ user, toId, reply, gt, lte }, { service }, emit) {
    console.log("PRIVATE MESSAGES NOTIFICATION", { gt, lte })
    const msgRange = {
      gt: gt || ('priv_' + toId + '_'),
      lte: lte || ('priv_' + toId + '\xFF')
    }
    const messages = (await Message.rangeGet(msgRange)).filter(msg => msg.user != user)
    console.log("FOUND MESSAGES", msgRange, ":", messages.length)
    if(messages.length == 0) return "none"
    const userEntity = await User.get(user)
    if(!userEntity) {
      console.log("user deleted - no email!")
      return 'noemail'
    }
    const userData = { ...(userEntity.userData), display: userEntity.display }
    if(!userData.email) {
      console.log("No user email!")
      return 'noemail'
    }
    const conversation = await PrivateConversation.get(toId)
    const otherUser = conversation.user1 == user ? conversation.user2 : conversation.user1
    const otherSession = conversation.user1 == user ? conversation.session2 : conversation.session1
    const otherUserData = otherUser && await User.get(otherUser)
    const otherSessionData = otherSession && await PublicSessionInfo.get(otherSession)
    const lastSent = messages[messages.length-1].id

    const lang = userData.language || Object.keys(i18n.languages)[0]

    const email = i18n.languages[lang].emailNotifications.privateMessagesEmail({
      user: userData,
      email: userData.email,
      otherUser: otherUserData,
      otherSession: otherSessionData,
      messages,
      toId,
      purify
    })
    return { email, lastSent }
  }
})

definition.trigger({
  name: "renderPrivateMessagesSmsNotification",
  properties: {
    user: {
      type: User
    },
    toId: {
      type: String
    },
    reply: {
      type: Boolean
    },
    gt: {
      type: String
    },
    lte: {
      type: String
    }
  },
  async execute({ user, toId, reply, gt, lte }, { service }, emit) {
    console.log("PRIVATE MESSAGES NOTIFICATION", { gt, lte })
    const msgRange = {
      gt: gt || ('priv_' + toId + '_'),
      lte: lte || ('priv_' + toId + '\xFF')
    }
    const messages = (await Message.rangeGet(msgRange)).filter(msg => msg.user != user)
    console.log("FOUND MESSAGES", msgRange, ":", messages.length)
    if(messages.length == 0) return "none"
    const userEntity = await User.get(user)
    console.log("user", user, userEntity)
    if(!userEntity) return 'nouser'; // user deleted, no need to send messages
    const userData = { ...userEntity.userData, display: userEntity.display }

    if(!userData.phone) {
      console.log("No user phone!")
      return 'nosms'
    }
    const conversation = await PrivateConversation.get(toId)
    const otherUser = conversation.user1 == user ? conversation.user2 : conversation.user1
    const otherSession = conversation.user1 == user ? conversation.session2 : conversation.session1
    const otherUserData = otherUser && await User.get(otherUser)
    const otherSessionData = otherSession && await PublicSessionInfo.get(otherSession)
    const lastSent = messages[messages.length-1].id

    const lang = userData.language || Object.keys(i18n.languages)[0]

    console.log("RENDERING SMS")

    const sms = i18n.languages[lang].smsNotifications.privateMessagesSms({
      user: userData,
      phone: userData.phone,
      otherUser: otherUserData,
      otherSession: otherSessionData,
      messages,
      toId,
      purify
    })

    console.log("RENRED SMS", sms)

    return { sms, lastSent }
  }
})