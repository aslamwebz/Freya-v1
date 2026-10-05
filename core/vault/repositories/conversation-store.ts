import {
  ConversationStoreError,
  type ConversationStore,
} from '../../conversation/store'
import {
  CONVERSATION_LIMITS,
  type Conversation,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationTurn,
  type TerminalTurnOutcome,
  type TurnOutcome,
} from '../../conversation/types'
import type { Vault } from '../vault'

/**
 * Conversation persistence on Freya's canonical SQLCipher Vault.
 *
 * The renderer never sees this repository, the SQL connection, the database path or
 * its key. Core hands the conversation service the narrow ConversationStore
 * interface and this class translates that typed interface into relational rows.
 *
 * There is deliberately no plaintext fallback and no dual write. If the Vault cannot
 * be opened, Core constructs an explicitly ephemeral MemoryConversationStore instead
 * of calling this repository.
 */
export class VaultConversationStore implements ConversationStore {
  readonly mode = 'encrypted' as const
  private degraded: string | null = null
  private closed = false

  constructor(private readonly vault: Vault) {}

  get faultReason(): string | null {
    return this.degraded
  }

  async putConversation(conversation: Conversation): Promise<void> {
    this.ensureWritable()
    const value = validateConversation(conversation)
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO chat_conversations (conversation_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             title = excluded.title,
             updated_at = excluded.updated_at`,
          [value.conversationId, value.title, value.createdAt, value.updatedAt],
        )
      })
    } catch {
      throw new ConversationStoreError('write-failed', 'conversation metadata could not be written to the encrypted Vault')
    }
  }

  async listConversations(limit: number): Promise<ConversationSummary[]> {
    this.ensureReadable()
    const bounded = Math.max(0, Math.min(Math.floor(limit), CONVERSATION_LIMITS.maxConversationsListed))
    try {
      const rows = this.vault.all<SummaryRow>(
        `SELECT
           c.conversation_id,
           c.title,
           c.created_at,
           c.updated_at,
           (SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.conversation_id) AS message_count,
           (SELECT t.outcome FROM chat_turns t
              WHERE t.conversation_id = c.conversation_id
              ORDER BY t.started_at DESC, t.turn_id DESC LIMIT 1) AS last_turn_outcome
         FROM chat_conversations c
         ORDER BY c.updated_at DESC, c.conversation_id ASC
         LIMIT ?`,
        [bounded],
      )
      return rows.map((row) => decodeSummary(row))
    } catch (error) {
      if (error instanceof ConversationStoreError) throw error
      this.degrade('conversation rows in the encrypted Vault could not be read')
      throw new ConversationStoreError('invalid-record', this.degraded)
    }
  }

  async readConversation(conversationId: string): Promise<ConversationRecord | null> {
    this.ensureReadable()
    const id = validateId(conversationId, 'conversation')
    try {
      const row = this.vault.get<ConversationRow>(
        'SELECT conversation_id, title, created_at, updated_at FROM chat_conversations WHERE conversation_id = ?',
        [id],
      )
      if (row === undefined) return null
      const conversation = decodeConversation(row)
      const messages = this.vault
        .all<MessageRow>(
          `SELECT message_id, conversation_id, role, content, created_at, turn_id
           FROM chat_messages WHERE conversation_id = ?
           ORDER BY created_at ASC, message_id ASC`,
          [id],
        )
        .map((message) => decodeMessage(message, id))
      const turns = this.vault
        .all<TurnRow>(
          `SELECT turn_id, conversation_id, user_message_id, assistant_message_id, outcome,
                  started_at, ended_at, request_id, provider_id, model, reason
           FROM chat_turns WHERE conversation_id = ?
           ORDER BY started_at ASC, turn_id ASC`,
          [id],
        )
        .map((turn) => decodeTurn(turn, id))
      return { conversation, messages, turns }
    } catch (error) {
      if (error instanceof ConversationStoreError) throw error
      this.degrade('conversation history in the encrypted Vault could not be read')
      throw new ConversationStoreError('invalid-record', this.degraded)
    }
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    this.ensureWritable()
    const value = validateMessage(message)
    if (value.content.length > CONVERSATION_LIMITS.maxMessageCharacters) {
      throw new ConversationStoreError('too-large', 'message exceeds the per-message limit')
    }
    try {
      this.vault.transaction((tx) => {
        const parent = tx.get<{ conversation_id: string }>(
          'SELECT conversation_id FROM chat_conversations WHERE conversation_id = ?',
          [value.conversationId],
        )
        if (parent === undefined) {
          throw new ConversationStoreError('not-found', `no such conversation: ${value.conversationId}`)
        }
        tx.run(
          `INSERT INTO chat_messages (message_id, conversation_id, role, content, created_at, turn_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            value.messageId,
            value.conversationId,
            value.role,
            value.content,
            value.createdAt,
            value.turnId,
          ],
        )
      })
    } catch (error) {
      if (error instanceof ConversationStoreError) throw error
      throw new ConversationStoreError('write-failed', 'message could not be written to the encrypted Vault')
    }
  }

  async recordTurnStart(turn: ConversationTurn): Promise<void> {
    this.ensureWritable()
    const value = validateTurn(turn)
    if (value.outcome !== 'pending') {
      throw new ConversationStoreError('invalid-record', 'a new conversation turn must start pending')
    }
    try {
      this.vault.transaction((tx) => {
        const parent = tx.get<{ conversation_id: string }>(
          'SELECT conversation_id FROM chat_conversations WHERE conversation_id = ?',
          [value.conversationId],
        )
        if (parent === undefined) {
          throw new ConversationStoreError('not-found', `no such conversation: ${value.conversationId}`)
        }
        tx.run(
          `INSERT INTO chat_turns (
             turn_id, conversation_id, user_message_id, assistant_message_id, outcome,
             started_at, ended_at, request_id, provider_id, model, reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            value.turnId,
            value.conversationId,
            value.userMessageId,
            value.assistantMessageId,
            value.outcome,
            value.startedAt,
            value.endedAt,
            value.requestId,
            value.providerId,
            value.model,
            value.reason,
          ],
        )
      })
    } catch (error) {
      if (error instanceof ConversationStoreError) throw error
      throw new ConversationStoreError('write-failed', 'conversation turn could not be written to the encrypted Vault')
    }
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
    this.ensureWritable()
    const id = validateId(turnId, 'turn')
    validateOutcome(outcome)
    validateTime(detail.endedAt, 'turn end')
    try {
      this.vault.transaction((tx) => {
        const current = tx.get<{ outcome: TurnOutcome }>(
          'SELECT outcome FROM chat_turns WHERE turn_id = ?',
          [id],
        )
        if (current === undefined) throw new ConversationStoreError('not-found', `no such turn: ${id}`)
        if (current.outcome !== 'pending') {
          throw new ConversationStoreError('invalid-record', `turn ${id} already finished as ${current.outcome}`)
        }
        tx.run(
          `UPDATE chat_turns SET
             outcome = ?, ended_at = ?, assistant_message_id = ?, provider_id = ?, model = ?, reason = ?
           WHERE turn_id = ? AND outcome = 'pending'`,
          [
            outcome,
            detail.endedAt,
            detail.assistantMessageId ?? null,
            detail.providerId ?? null,
            detail.model ?? null,
            detail.reason ?? null,
            id,
          ],
        )
      })
    } catch (error) {
      if (error instanceof ConversationStoreError) throw error
      throw new ConversationStoreError('write-failed', 'conversation outcome could not be written to the encrypted Vault')
    }
  }

  async recoverInterruptedTurns(now: string): Promise<string[]> {
    this.ensureWritable()
    validateTime(now, 'recovery')
    try {
      return this.vault.transaction((tx) => {
        const rows = tx.all<{ turn_id: string }>(
          "SELECT turn_id FROM chat_turns WHERE outcome = 'pending' ORDER BY started_at ASC, turn_id ASC",
        )
        for (const row of rows) {
          tx.run(
            "UPDATE chat_turns SET outcome = 'interrupted', ended_at = ?, reason = NULL WHERE turn_id = ? AND outcome = 'pending'",
            [now, row.turn_id],
          )
        }
        return rows.map((row) => row.turn_id)
      })
    } catch (error) {
      if (error instanceof ConversationStoreError) throw error
      throw new ConversationStoreError('write-failed', 'interrupted turns could not be recovered in the encrypted Vault')
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private ensureReadable(): void {
    if (this.closed) throw new ConversationStoreError('store-unavailable', 'conversation store is closed')
    if (this.degraded !== null) throw new ConversationStoreError('invalid-record', this.degraded)
  }

  private ensureWritable(): void {
    this.ensureReadable()
  }

  private degrade(reason: string): void {
    this.degraded ??= reason
  }
}

interface ConversationRow {
  conversation_id: string
  title: string
  created_at: string
  updated_at: string
}

interface SummaryRow extends ConversationRow {
  message_count: number | bigint
  last_turn_outcome: TurnOutcome | null
}

interface MessageRow {
  message_id: string
  conversation_id: string
  role: string
  content: string
  created_at: string
  turn_id: string
}

interface TurnRow {
  turn_id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: string | null
  outcome: string
  started_at: string
  ended_at: string | null
  request_id: string | null
  provider_id: string | null
  model: string | null
  reason: string | null
}

function decodeConversation(row: ConversationRow): Conversation {
  return validateConversation({
    conversationId: row.conversation_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function decodeSummary(row: SummaryRow): ConversationSummary {
  const conversation = decodeConversation(row)
  if (row.last_turn_outcome !== null) validateOutcome(row.last_turn_outcome)
  const count = Number(row.message_count)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ConversationStoreError('invalid-record', 'conversation message count is invalid')
  }
  return {
    ...conversation,
    messageCount: count,
    lastTurnOutcome: row.last_turn_outcome,
  }
}

function decodeMessage(row: MessageRow, conversationId: string): ConversationMessage {
  if (row.conversation_id !== conversationId) {
    throw new ConversationStoreError('invalid-record', 'a message belongs to a different conversation')
  }
  return validateMessage({
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role as ConversationMessage['role'],
    content: row.content,
    createdAt: row.created_at,
    turnId: row.turn_id,
  })
}

function decodeTurn(row: TurnRow, conversationId: string): ConversationTurn {
  if (row.conversation_id !== conversationId) {
    throw new ConversationStoreError('invalid-record', 'a turn belongs to a different conversation')
  }
  return validateTurn({
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    outcome: row.outcome as TurnOutcome,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    requestId: row.request_id,
    providerId: row.provider_id,
    model: row.model,
    reason: row.reason,
  })
}

function validateConversation(value: Conversation): Conversation {
  validateId(value.conversationId, 'conversation')
  if (typeof value.title !== 'string' || value.title.length > CONVERSATION_LIMITS.maxTitleCharacters + 1) {
    throw new ConversationStoreError('invalid-record', 'conversation title is invalid')
  }
  validateTime(value.createdAt, 'conversation creation')
  validateTime(value.updatedAt, 'conversation update')
  return { ...value }
}

function validateMessage(value: ConversationMessage): ConversationMessage {
  validateId(value.messageId, 'message')
  validateId(value.conversationId, 'conversation')
  validateId(value.turnId, 'turn')
  if (value.role !== 'user' && value.role !== 'assistant') {
    throw new ConversationStoreError('invalid-record', 'message role is invalid')
  }
  if (typeof value.content !== 'string') {
    throw new ConversationStoreError('invalid-record', 'message content is invalid')
  }
  validateTime(value.createdAt, 'message creation')
  return { ...value }
}

function validateTurn(value: ConversationTurn): ConversationTurn {
  validateId(value.turnId, 'turn')
  validateId(value.conversationId, 'conversation')
  validateId(value.userMessageId, 'user message')
  if (value.assistantMessageId !== null) validateId(value.assistantMessageId, 'assistant message')
  validateOutcome(value.outcome)
  validateTime(value.startedAt, 'turn start')
  if (value.endedAt !== null) validateTime(value.endedAt, 'turn end')
  if (value.requestId !== null) validateId(value.requestId, 'request')
  for (const optional of [value.providerId, value.model, value.reason]) {
    if (optional !== null && typeof optional !== 'string') {
      throw new ConversationStoreError('invalid-record', 'turn metadata is invalid')
    }
  }
  return { ...value }
}

function validateOutcome(value: string): asserts value is TurnOutcome {
  if (!['pending', 'completed', 'denied', 'cancelled', 'failed', 'interrupted'].includes(value)) {
    throw new ConversationStoreError('invalid-record', 'turn outcome is invalid')
  }
}

function validateId(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new ConversationStoreError('invalid-record', `${name} id is invalid`)
  }
  return value
}

function validateTime(value: string, name: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ConversationStoreError('invalid-record', `${name} time is invalid`)
  }
}
