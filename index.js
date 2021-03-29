const App = require("@live-change/framework")
const validators = require("../validation")
const app = new App()

require('moment')
require('moment-timezone')
require('../../i18n/ejs-require.js')
const i18n = require('../../i18n')
const purify = require('../config/purify.js')

const definition = app.createServiceDefinition({
  name: 'messages',
  eventSourcing: true,
  validators
})

const { getAccess, hasRole, checkIfRole, getPublicInfo,
        Access, SessionAccess, PublicSessionInfo, Membership } =
    require("../access-control-service/access.js")(app, definition)

const User = definition.foreignModel('users', 'User')
const Session = definition.foreignModel('session', 'Session')

const messageFields = require('../config/messageFields.js')(definition)
const welcomeMessage = require('../config/welcomeMessage.js')(definition)

const Message = definition.model({
  name: "Message",
  userFields: Object.keys(messageFields),
  properties: {
    toType: {
      type: String,
      validation: ['nonEmpty']
    },
    toId: {
      type: String,
      validation: ['nonEmpty']
    },
    ...messageFields,
    timestamp: {
      type: Date,
      validation: ['nonEmpty']
    },
    user: {
      type: User
    },
    session: {
      type: PublicSessionInfo
    },
  },
  indexes: {
    byToTypeIdTimestamp: {
      property: ["toType", 'toId', 'timestamp']
    }
  },
  crud: {
    deleteTrigger: true,
    writeOptions: {
      access: (params, {client, service}) => {
        return client.roles.includes('admin')
      }
    },
    id: ({group, path}) => `${group}_${path}`
  }
})

function privateConversationParticipants(me, other) {
  const myId = me.user || me.session
  const otherId = other.user || other.session
  const amIFirst = myId < otherId
  const params = amIFirst
      ?({
        user1: me.user,
        session1: me.user ? undefined : me.session,
        user2: other.user,
        session2: other.user ? undefined : other.session
      })
      :({
        user1: other.user,
        session1: other.user ? undefined : other.session,
        user2: me.user,
        session2: me.user ? undefined : me.session
      })
  return params
}


definition.view({
  name: "messages",
  properties: {
    toType: {
      type: String,
      validation: ['nonEmpty']
    },
    toId: {
      type: String,
      validation: ['nonEmpty']
    },
    gt: {
      type: String,
    },
    lt: {
      type: String,
    },
    gte: {
      type: String,
    },
    lte: {
      type: String,
    },
    limit: {
      type: Number
    },
    reverse: {
      type: Boolean
    }
  },
  returns: {
    type: Array,
    of: {
      type: Message
    }
  },
  access: ({ toType, toId, text, pictures }, context) =>
      toType == 'priv'
          ? checkPrivAccess(toId, context)
          : checkIfRole(toType, toId, ['speaker', 'vip', 'moderator', 'owner'], context),
  async daoPath({ toType, toId, gt, lt, gte, lte, limit, reverse }, { client, service }, method) {

    const channelId = `${toType}_${toId}`
    if(!Number.isSafeInteger(limit)) limit = 100
    const range = {
      gt: gt ? `${channelId}_${gt.split('_').pop()}` : (gte ? undefined : `${channelId}_`),
      lt: lt ? `${channelId}_${lt.split('_').pop()}` : undefined,
      gte: gte ? `${channelId}_${gte.split('_').pop()}` : undefined,
      lte: lte ? `${channelId}_${lte.split('_').pop()}` : ( lt ? undefined : `${channelId}_\xFF\xFF\xFF\xFF`),
      limit,
      reverse
    }
    const messages = await Message.rangeGet(range)
    console.log("MESSAGES RANGE", JSON.stringify({ toType, toId, gt, lt, gte, lte, limit, reverse }) ,
        "\n  TO", JSON.stringify(range),
        "\n  RESULTS", messages.length, messages.map(m => m.id))

    /* console.log("MESSAGES RANGE", range, "RESULTS", messages.length)*/
    return Message.rangePath(range)
  }
})

definition.view({
  name: 'message',
  properties: {
    toType: {
      type: String,
      validation: ['nonEmpty']
    },
    toId: {
      type: String,
      validation: ['nonEmpty']
    },
    message: {
      type: Message,
      validation: ['nonEmpty']
    }
  },
  access: ({ message }, context) => {
    if(context.visibilityTest) return true
    if(!message) throw new Error("message id required")
    const [toType, toId] = message.split('_')
    return toType == 'priv'
        ? checkPrivAccess(toId, context)
        : checkIfRole(toType, toId, ['speaker', 'vip', 'moderator', 'owner'], context)
  },
  async daoPath({ message }, { client, service }, method) {
    return Message.path(message)
  }
})

const lastMessageTime = new Map()

async function postMessage(props, { client, service }, emit, conversation) {
  console.log("POST MESSAGE", props)
  const { toType, toId } = props
  const channelId = `${toType}_${toId}`
  let lastTime = lastMessageTime.get(channelId)
  const now = new Date()
  if(now.toISOString() <= lastTime) {
    lastTime.setTime(lastTime.getTime() + 1)
  } else {
    lastTime = now
  }
  if(lastTime.getTime() > now.getTime() + 100) { /// Too many messages per second, drop message
    return;
  }
  lastMessageTime.set(channelId, lastTime)
  const message = `${channelId}_${lastTime.toISOString()}`
  let data = { toType, toId }
  for(const key in messageFields) {
    data[key] = props[key]
  }
  data.user = client.user
  data.timestamp = now
  let publicInfo
  if(!data.user) {
    publicInfo = await app.assertTime('getting public info', 1000,
        () => getPublicInfo(client.sessionId), client.sessionId)
    data.session = publicInfo.id
  }
  emit({
    type: "MessageCreated",
    message,
    data
  })
  app.assertTime('triggering read history', 5000, async () => {
    if(toType == 'priv') {
      if(!conversation) conversation = await PrivateConversation.get(toId)
      const amIFirst = client.user
          ? conversation.user1 == client.user
          : conversation.session1 == data.session
      const toSession = amIFirst ? conversation.session2 : conversation.session1
      const toUser = amIFirst ? conversation.user2 : conversation.user1
      await app.trigger({ /// asynchronus trigger
        type: 'readHistoryEvent',
        fromUser: amIFirst ? conversation.user1 : conversation.user2,
        toUsers: toUser ? [toUser] : [],
        fromSession: amIFirst ? conversation.session1 : conversation.session2,
        toSessions: toSession ? [toSession] : [],
        toType, toId, eventId: message
      })
    } else {
      const access = await Access.indexObjectGet('byTo', [ toType, toId ])
      if(!access) throw new Error("no access")
      const [sessions, members] = await Promise.all([
        SessionAccess.indexRangeGet('byAccess', [ access.id ]),
        Membership.indexRangeGet('listMembers', [ toType, toId ])
      ])
      const toSessions = sessions.filter(s => s.session != client.sessionId).map(s => s.publicInfo)
      const toUsers = members.filter(m => m.user != client.user).map(m => m.user)
      console.log("SESSIONS", toSessions)
      console.log("MEMBERS", toUsers)
      await app.trigger({ /// asynchronus trigger
        type: 'readHistoryEvent',
        fromUser: client.user || null,
        toUsers,
        fromSession: client.user ? null : publicInfo.id,
        toSessions,
        toType, toId, eventId: message
      })
    }
  })
}

definition.action({
  name: "postMessage",
  properties: {
    ...messageFields
  },
  //queuedBy: (command) => `${command.toType}_${command.toId})`,
  access: ({ toType, toId, text, pictures }, context) =>
    toType == 'priv'
        ? checkPrivAccess(toId, context)
        : checkIfRole(toType, toId, ['speaker', 'vip', 'moderator', 'owner'], context),
  async execute(props, { client, service }, emit) {
    return postMessage(props, { client, service }, emit)
  }
})

const PrivateConversation = definition.model({
  name: "PrivateConversation",
  userFields: Object.keys(messageFields),
  properties: {
    user1: {
      type: User
    },
    user2: {
      type: User
    },
    session1: {
      type: PublicSessionInfo
    },
    session2: {
      type: PublicSessionInfo
    }
  },
  indexes: {
    byUserUser: {
      property: ["user1", "user2"]
    },
    bySessionSession: {
      property: ["session1", "session2"]
    },
    byUserSession: {
      property: ["user1", "session2"]
    },
    bySessionUser: {
      property: ["session1", "user2"]
    }
  }
})

definition.view({
  name: "privateConversation",
  properties: {
    privateConversation: {
      type: PrivateConversation
    }
  },
  async daoPath({ privateConversation }, { client, service }, method) {
    return PrivateConversation.path(privateConversation)
  }
})

definition.event({
  name: "privateConversationCreated",
  async execute({ conversation, user1, user2, session1, session2 }) {
    await PrivateConversation.create({ id: conversation, user1, user2, session1, session2 })
  }
})

function conversationPathByParticipants({ user1, user2, session1, session2 }) {
  if(user1) {
    if(user2) {
      return PrivateConversation.indexObjectPath('byUserUser', [user1, user2])
    } else {
      return PrivateConversation.indexObjectPath('byUserSession', [user1, session2])
    }
  } else {
    if(user2) {
      return PrivateConversation.indexObjectPath('bySessionUser', [user1, user2])
    } else {
      return PrivateConversation.indexObjectPath('bySessionSession', [user1, session2])
    }
  }
}

definition.action({
  name: "getOrCreatePrivateConversation",
  properties: {
    user1: {
      type: User
    },
    user2: {
      type: User
    },
    session1: {
      type: PublicSessionInfo
    },
    session2: {
      type: PublicSessionInfo
    }
  },
  async execute(participants, { client, service }, emit) {
    let conversation = await service.dao.get(conversationPathByParticipants(participants))
    if(!conversation) {
      const id = app.generateUid()
      conversation = { ...participants }
      emit({
        type: "privateConversationCreated",
        conversation: id,
        ...conversation
      })
      conversation = { id, ...conversation }
      await PrivateConversation.create(conversation)
    }
    return conversation
  }
})

definition.action({
  name: "postPrivateMessage",
  properties: {
    user: {
      type: User
    },
    session: {
      type: PublicSessionInfo
    },
    ...messageFields
  },
  async execute(props, { client, service }, emit) {
    const { user, session } = props
    delete props.user
    delete props.session
    const me = { user: client.user, session: client.sessionId }
    const other = { user, session }
    const participants = privateConversationParticipants(me, other)
    let conversation = await service.dao.get(conversationPathByParticipants(participants))
    if(!conversation) {
      const id = app.generateUid()
      conversation = { ...participants }
      emit({
        type: "privateConversationCreated",
        conversation: id,
        ...conversation
      })
      conversation = { id, ...conversation }
      await PrivateConversation.create(conversation)
    }
    return postMessage({ ...props, toType: 'priv', toId: conversation.id }, { client, service }, emit,
        conversation)
  }
})

definition.view({
  name: "privateConversationByParticipants",
  properties: {
    user1: {
      type: User
    },
    user2: {
      type: User
    },
    session1: {
      type: PublicSessionInfo
    },
    session2: {
      type: PublicSessionInfo
    }
  },
  daoPath(participants) {
    return conversationPathByParticipants(participants)
  }
})

definition.view({
  name: "privateConversationByOtherParticipant",
  properties: {
    user: {
      type: User
    },
    session: {
      type: PublicSessionInfo
    }
  },
  daoPath({ user, session }, { client, service }, method) {
    const me = { user: client.user, session: client.sessionId }
    const other = { user, session }
    const participants = privateConversationParticipants(me, other)
    return conversationPathByParticipants(participants)
  }
})

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
    const userData = { ...userEntity.userData, display: userEntity.display }

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

module.exports = definition

async function start () {
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


