export const CONVERSATION_EVENT_TYPES = [
// Conversation — metadata only, never a word of what was said.
  //
  // The bodies live in the encrypted Conversation Store. What appears here is
  // enough to answer "did a turn happen, how big was it, which provider answered,
  // how did it end" and nothing more, because this file is audit surface: it is
  // read, copied and backed up far more freely than the conversation itself.
  'conversation.created',
'conversation.archived',
'conversation.renamed',
'conversation.turn.started',
'conversation.turn.completed',
'conversation.turn.cancelled',
'conversation.turn.failed',
'conversation.turn.denied',
'conversation.turn.interrupted',
] as const
