import {
  ConversationStoreError,
  type ConversationStore,
} from './store'
import type {
  Conversation,
  ConversationMessage,
  ConversationRecord,
  ConversationSummary,
  ConversationTurn,
  TerminalTurnOutcome,
} from './types'

/**
 * The in-memory Conversation Store.
 *
 * Two jobs, and both are honest ones:
 *
 *   - **Tests.** Deterministic, with no key and no filesystem, so a Mind test can
 *     assert on conversation state without an encryption round trip in the way.
 *   - **Ephemeral production mode.** When the host's OS secure storage is
 *     unavailable, Freya still works for the session instead of either refusing
 *     to talk or — far worse — quietly writing plaintext to disk. It says which
 *     of those it is doing, in `mode`.
 *
 * The bounded copy it keeps is deliberate. A long session must not grow without
 * limit, and Phase 3 holds the most recent messages plus every turn, because the
 * turn records are what recovery needs.
 */

export interface MemoryConversationStoreOptions {
  mode?: 'ephemeral' | 'memory'
  faultReason?: string | null
  /** Most recent messages retained per conversation. */
  maxMessagesPerConversation?: number
}

const DEFAULT_MAX_MESSAGES = 500

export class MemoryConversationStore implements ConversationStore {
  /**
   * `memory` is a test/dev store and reports the mode that is literally true.
   * `ephemeral` is the production fallback when there is no key, and it says the
   * word that matters to a user: this conversation will not survive a restart.
   */
  readonly mode: 'ephemeral' | 'memory'
  readonly faultReason: string | null

  private readonly conversations = new Map<string, Conversation>()
  private readonly messages = new Map<string, ConversationMessage[]>()
  private readonly turns = new Map<string, ConversationTurn[]>()
  private readonly turnsById = new Map<string, ConversationTurn>()
  private readonly maxMessages: number
  private closed = false

  constructor(options: MemoryConversationStoreOptions = {}) {
    this.mode = options.mode ?? 'memory'
    this.faultReason = options.faultReason ?? null
    this.maxMessages = options.maxMessagesPerConversation ?? DEFAULT_MAX_MESSAGES
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ConversationStoreError('store-unavailable', 'conversation store is closed')
    }
  }

  async putConversation(conversation: Conversation): Promise<void> {
    this.assertOpen()
    if (!this.conversations.has(conversation.conversationId)) {
      this.messages.set(conversation.conversationId, [])
      this.turns.set(conversation.conversationId, [])
    }
    this.conversations.set(conversation.conversationId, { ...conversation })
  }

  async listConversations(limit: number): Promise<ConversationSummary[]> {
    this.assertOpen()
    return [...this.conversations.values()]
      .filter((conversation) => conversation.archivedAt == null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, Math.max(0, limit))
      .map((conversation) => this.summarise(conversation))
  }

  async readConversation(conversationId: string): Promise<ConversationRecord | null> {
    this.assertOpen()
    const conversation = this.conversations.get(conversationId)
    if (!conversation || conversation.archivedAt != null) return null
    return {
      conversation: { ...conversation },
      messages: [...(this.messages.get(conversationId) ?? [])],
      turns: [...(this.turns.get(conversationId) ?? [])],
    }
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    this.assertOpen()
    const list = this.messages.get(message.conversationId)
    if (!list) {
      throw new ConversationStoreError('not-found', `no such conversation: ${message.conversationId}`)
    }
    list.push({ ...message })
    // Bounded, keeping the newest. The Context Compiler only ever reads
    // backwards from the newest anyway, so this is invisible to it and it stops
    // an all-day session from being an unbounded allocation.
    if (list.length > this.maxMessages) list.splice(0, list.length - this.maxMessages)
  }

  async recordTurnStart(turn: ConversationTurn): Promise<void> {
    this.assertOpen()
    const list = this.turns.get(turn.conversationId)
    if (!list) {
      throw new ConversationStoreError('not-found', `no such conversation: ${turn.conversationId}`)
    }
    if (this.turnsById.has(turn.turnId)) {
      throw new ConversationStoreError('invalid-record', `turn already exists: ${turn.turnId}`)
    }
    const record = { ...turn }
    list.push(record)
    this.turnsById.set(turn.turnId, record)
  }

  async recordTurnOutcome(
    turnId: string,
    outcome: TerminalTurnOutcome,
    detail: {
      endedAt: string
      assistantMessageId?: string | null
      providerId?: string | null
      model?: string | null
      reason?: string | null
    },
  ): Promise<void> {
    this.assertOpen()
    const turn = this.turnsById.get(turnId)
    if (!turn) throw new ConversationStoreError('not-found', `no such turn: ${turnId}`)
    if (turn.outcome !== 'pending') {
      // One turn, one outcome. A second terminal write is a bug somewhere
      // upstream, and silently applying it would make the transcript disagree
      // with the journal.
      throw new ConversationStoreError(
        'invalid-record',
        `turn ${turnId} already finished as ${turn.outcome}`,
      )
    }
    turn.outcome = outcome
    turn.endedAt = detail.endedAt
    if (detail.assistantMessageId !== undefined) turn.assistantMessageId = detail.assistantMessageId
    if (detail.providerId !== undefined) turn.providerId = detail.providerId
    if (detail.model !== undefined) turn.model = detail.model
    if (detail.reason !== undefined) turn.reason = detail.reason
  }

  async recoverInterruptedTurns(now: string): Promise<string[]> {
    this.assertOpen()
    const recovered: string[] = []
    for (const turn of this.turnsById.values()) {
      if (turn.outcome !== 'pending') continue
      turn.outcome = 'interrupted'
      turn.endedAt = now
      // No reason, and deliberately not one. The process died; the record cannot
      // say why, and inventing a cause would be a fabrication about a real event.
      turn.reason = null
      recovered.push(turn.turnId)
    }
    return recovered
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Test and development seam: the whole store, for assertions. */
  snapshot(): { conversations: Conversation[]; messages: ConversationMessage[]; turns: ConversationTurn[] } {
    return {
      conversations: [...this.conversations.values()].map((c) => ({ ...c })),
      messages: [...this.messages.values()].flat().map((m) => ({ ...m })),
      turns: [...this.turnsById.values()].map((t) => ({ ...t })),
    }
  }

  private summarise(conversation: Conversation): ConversationSummary {
    const messages = this.messages.get(conversation.conversationId) ?? []
    const turns = this.turns.get(conversation.conversationId) ?? []
    const last = turns[turns.length - 1]
    return {
      conversationId: conversation.conversationId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: messages.length,
      lastTurnOutcome: last?.outcome ?? null,
    }
  }
}
