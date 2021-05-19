const app = require("@live-change/framework").app()
const definition = require('./definition.js')

const { getAccess, hasRole, checkIfRole, getPublicInfo,
  Access, SessionAccess, PublicSessionInfo, Membership } =
    require("../access-control-service/access.js")(app, definition)

const User = definition.foreignModel('users', 'User')
const Session = definition.foreignModel('session', 'Session')

const messageFields = require('../config/messageFields.js')(definition)
const messageAccess = require('../config/messageAccess.js')(definition)

const lastMessageTime = new Map()

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
  access: ({ toType, toId }, context) => messageAccess.readAccess({ toType, toId }, context),
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
    return messageAccess.readAccess({ toType, toId }, context)
  },
  async daoPath({ message }, { client, service }, method) {
    return Message.path(message)
  }
})

const PrivateConversation = definition.foreignModel('messages', 'PrivateConversation')


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
  access: (props, context) => messageAccess.writeAccess(props, context),
  async execute(props, { client, service }, emit) {
    return postMessage(props, { client, service }, emit)
  }
})

module.exports = { Message, postMessage, lastMessageTime }
