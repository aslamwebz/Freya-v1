import type {
  Conversation,
  ConversationMessage,
  ConversationRecord,
  ConversationSummary,
  ConversationTurn,
  TerminalTurnOutcome,
} from './types'

/**
 * The Conversation Store.
 *
 * Conversation bodies live here and nowhere else. The Event Fabric records that
 * a turn happened; this records what was said. Keeping them apart is what lets
 * the journal stay readable and shippable, and it is why this is an interface
 * with two implementations rather than a file the Core writes.
 *
 * ## The Phase 4 seam
 *
 * The methods are entity-shaped and nothing else, and that is the whole migration
 * story: a later Brain can back this interface with structured, indexed, still
 * encrypted storage without the Mind, the Context Compiler or the conversation
 * service changing. Nothing here knows about SQL, about tables, or about how a
 * record is laid out on disk. Phase 4 replaces the implementation, not Mind.
 */

/**
 * How durable the conversation history actually is.
 *
 * A truthful answer, and the reason the UI can say something useful when there is
 * no key: `encrypted` is real persistence, `ephemeral` is a working conversation
 * that will not survive a restart, `memory` is a test or browser-dev store that
 * never claimed otherwise, and `unavailable` is a store that could not be opened
 * at all. None of them is silently upgraded into the one above.
 */
export type ConversationPersistenceMode =
  /** AES-256-GCM records, key supplied by the host's OS secure storage. */
  | 'encrypted'
  /** In-memory only, reported as such. Conversation works and vanishes on exit. */
  | 'ephemeral'
  /** An in-memory store used by tests and the browser dev build. */
  | 'memory'
  /** No store. Conversation commands are refused truthfully. */
  | 'unavailable'

export type ConversationFaultCode =
  /** The store could not be opened, or is closed. */
  | 'store-unavailable'
  /** A record failed authenticated decryption, or its header did not match. */
  | 'unauthenticated'
  /** A record is structurally invalid, or a future version. */
  | 'invalid-record'
  /** A write failed. The turn's outcome is unknown to the store. */
  | 'write-failed'
  /** The content exceeded a deterministic limit. */
  | 'too-large'
  /** No such conversation, message or turn. */
  | 'not-found'

/**
 * A conversation-store failure.
 *
 * Note what this is not. A conversation store has no authority over anything: it
 * cannot grant cognition, clear a stop, or widen a budget. So a fault here is
 * reported as a **conversation-data fault** and is never allowed to change
 * Core's security state in either direction. Corrupt conversation data must not
 * become permission, and it must not become a lockout either — the honest answer
 * is "this conversation could not be read", and the rest of Freya carries on.
 */
export class ConversationStoreError extends Error {
  constructor(
    readonly code: ConversationFaultCode,
    message: string,
  ) {
    super(message)
    this.name = 'ConversationStoreError'
  }
}

export interface ConversationStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: ConversationPersistenceMode
  /** Why, when it is not `encrypted`. Null when it is. */
  readonly faultReason: string | null

  /**
   * Write a conversation's own record.
   *
   * An upsert, not an insert: renaming a conversation or moving its `updatedAt`
   * is a new record that later wins. Append-only storage plus a fold gives
   * update-without-a-mutation-API, which keeps the encrypted file a log and keeps
   * "no in-place edit of personal data" structurally true.
   */
  putConversation(conversation: Conversation): Promise<void>
  listConversations(limit: number): Promise<ConversationSummary[]>
  readConversation(conversationId: string): Promise<ConversationRecord | null>

  /**
   * Persist a message.
   *
   * Complete only. There is no partial write and no "pending" message, because a
   * half-stored answer is a thing the transcript could show as a message that
   * Freya never actually gave.
   */
  appendMessage(message: ConversationMessage): Promise<void>

  /** Record that a turn began, with no outcome yet. */
  recordTurnStart(turn: ConversationTurn): Promise<void>

  /**
   * Record how a turn finished.
   *
   * Idempotent per turn: the first terminal outcome wins, and a later attempt to
   * change it is refused rather than applied. One turn gets one outcome, exactly
   * as one request gets one terminal event.
   */
  recordTurnOutcome(turnId: string, outcome: TerminalTurnOutcome, detail: {
    endedAt: string
    assistantMessageId?: string | null
    providerId?: string | null
    model?: string | null
    reason?: string | null
  }): Promise<void>

  /**
   * Find turns that started and never finished, and mark them interrupted.
   *
   * Called once at start-up. Returns the turn ids it changed so the change can
   * be journalled. It never completes a turn, never retries it, and never
   * guesses why it stopped: a question is on disk and no answer is, and that is
   * the entire claim.
   */
  recoverInterruptedTurns(now: string): Promise<string[]>

  /** Release handles. Safe to call more than once. */
  close(): Promise<void>
}
