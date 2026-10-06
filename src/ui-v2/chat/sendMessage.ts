import type { ModelAttachment } from '../../../core/model/provider'
import type { ConversationCommandOutcome } from '../../../core/protocol/conversation'

/**
 * Sending one message, as a pure function.
 *
 * Kept out of the component for one reason: the composer's job is a sequence of
 * Core commands with an ordering that matters — create a conversation only when
 * there is none, then submit the turn — and that ordering is the part worth
 * testing. The component supplies a sender; this decides what happens and what
 * sentence, if any, the owner should see.
 *
 * Nothing here invents a message or a reply. The transcript arrives as a Core
 * projection; this only reports whether the send was accepted, and why not when
 * it was not.
 */

export interface ConversationSender {
  create(): Promise<ConversationCommandOutcome>
  submitTurn(conversationId: string, text: string, attachments?: readonly ModelAttachment[]): Promise<ConversationCommandOutcome>
}

export interface SendResult {
  readonly ok: boolean
  readonly conversationId: string | null
  /** A sentence to show the owner. Empty when the message was accepted. */
  readonly notice: string
}

export async function sendMessage(
  sender: ConversationSender,
  currentConversationId: string | null,
  rawText: string,
  attachments?: readonly ModelAttachment[],
): Promise<SendResult> {
  const text = rawText.trim()
  // An empty draft is not a message. Nothing is sent and nothing is claimed.
  if (text.length === 0) return { ok: false, conversationId: currentConversationId, notice: '' }

  let conversationId = currentConversationId
  if (conversationId === null) {
    const created = await sender.create()
    if (created.operation !== 'created') {
      return {
        ok: false,
        conversationId: null,
        notice:
          created.operation === 'refused'
            ? created.reason
            : 'No conversation is available, so the message was not sent.',
      }
    }
    conversationId = created.conversation.conversationId
  }

  const outcome = await (attachments?.length ? sender.submitTurn(conversationId, text, attachments) : sender.submitTurn(conversationId, text))
  if (outcome.operation === 'turn') {
    return outcome.turn.outcome === 'completed'
      ? { ok: true, conversationId, notice: '' }
      : { ok: false, conversationId, notice: outcome.turn.reason ?? 'That turn did not complete.' }
  }
  if (outcome.operation === 'refused') {
    return { ok: false, conversationId, notice: outcome.reason }
  }
  return { ok: false, conversationId, notice: 'The message was not sent.' }
}
