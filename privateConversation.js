const app = require("@live-change/framework").app()
const definition = require('./definition.js')

const { getAccess, hasRole, checkIfRole, getPublicInfo,
  Access, SessionAccess, PublicSessionInfo, Membership } =
    require("../access-control-service/access.js")(definition)

const User = definition.foreignModel('users', 'User')

const messageFields = require('../config/messageFields.js')(definition)

const { Message, postMessage } = require('./message.js')

const PrivateConversation = definition.model({
  name: "PrivateConversation",
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

module.exports = { PrivateConversation, privateConversationParticipants, conversationPathByParticipants }
