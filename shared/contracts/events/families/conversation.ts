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
/**
 * One conversation turn's durable metadata.
 *
 * Every field here is either an id, a count, or a word a person would say out
 * loud. There is no field a message could hide in, and that is the whole
 * property: adding a field to a conversation event is a visible change to the
 * audit schema, not something that quietly starts retaining what someone typed.
 */
export interface ConversationTurnEvent {
  conversationId: string
  turnId: string
  /** Null only when the turn was refused before the message could be stored. */
  userMessageId: string | null
  /** Null until an answer exists, exactly as in the conversation store. */
  assistantMessageId: string | null
  /**
   * Size of the turn's largest stored message, in characters.
   *
   * A measurement, never the content. It is what lets an operator see that a turn
   * was substantial, and it is the only trace of anyone's words that leaves Core.
   */
  contentLength: number
  /** The single Model Gateway request for this turn, when it got that far. */
  requestId: string | null
  providerId: string | null
  model: string | null
  /** The terminal state, stated in the payload as well as implied by the type. */
  outcome: string
  reason: string | null
}

export interface ConversationEventPayloads {
/* --------------------------------------------------------- conversation */

  'conversation.created': {
    conversationId: string
    /** Length of the derived title. The title's text is not here. */
    titleLength: number
  }

'conversation.archived': {
    conversationId: string
    /** Length only; closing a chat never copies its title into the audit journal. */
    titleLength: number
  }

'conversation.renamed': {
    conversationId: string
    /** Title text remains exclusively in the encrypted conversation store. */
    titleLength: number
  }

/**
   * Shared shape for every conversation turn outcome.
   *
   * One shape rather than five, because the differences between them are
   * enumerated in `outcome` and keeping the rest identical is what makes the
   * events comparable in an audit without five field lists to keep in step.
   *
   * `contentLength` counts characters. It is the only measurement of anyone's
   * words that leaves Core, and it is what lets an operator see that a turn was
   * substantial without the journal becoming a transcript.
   */
  'conversation.turn.started': ConversationTurnEvent

'conversation.turn.completed': ConversationTurnEvent

'conversation.turn.cancelled': ConversationTurnEvent

'conversation.turn.failed': ConversationTurnEvent

'conversation.turn.denied': ConversationTurnEvent

'conversation.turn.interrupted': ConversationTurnEvent
}