import type { ConversationPersistenceMode } from '../conversation/store'

/**
 * The renderer-safe conversation projection.
 *
 * This is the *only* conversation shape that crosses into the window, and it is
 * built here rather than in the renderer so the renderer has no business truth
 * to hold. It is a mirror: Core overwrites it whenever its own state moves, and
 * the renderer cannot write a field of it.
 *
 * Conversation **content** does cross — the transcript has to be rendered
 * somewhere — and that is a deliberate, narrow exception. It is not a leak of the
 * store, the keys, or the filesystem: the window is shown the words of the
 * conversation it is displaying, and nothing else about how they are stored.
 */

/** One rendered message. The full content, because this is the transcript. */
export interface ConversationMessageView {
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  turnId: string
}

export interface ConversationSummaryView {
  conversationId: string
  title: string
  updatedAt: string
  messageCount: number
  lastTurnOutcome: 'pending' | 'completed' | 'denied' | 'cancelled' | 'failed' | 'interrupted' | null
}

/**
 * How a turn finished, as the window sees it.
 *
 * A projection of the Mind's own result, not the result itself. The Mind's type
 * carries its reasoning; this carries the facts a panel needs and nothing else,
 * so the window cannot come to depend on how the Mind is built.
 */
export interface ConversationTurnView {
  turnId: string
  conversationId: string
  outcome: 'completed' | 'denied' | 'cancelled' | 'failed' | 'interrupted'
  /** In words. Never content. */
  reason: string | null
  providerId: string | null
  model: string | null
  /**
   * Whether a provider had the request before it ended.
   *
   * Carried to the window on purpose. A turn that was cancelled mid-generation may
   * already have been paid for, and a UI that reported "stopped, nothing spent"
   * would be the more comfortable lie.
   */
  providerContacted: boolean
  /** The stored answer, when one exists. Null for every other outcome. */
  assistantMessage: ConversationMessageView | null
}

/**
 * The result of a conversation command.
 *
 * One discriminated union rather than a bag of optional fields, so a caller has to
 * look at `operation` before it reads anything — which is what stops a panel
 * treating a refusal as a list, or an empty transcript as "no messages yet".
 */
export type ConversationCommandOutcome =
  | { operation: 'created'; conversation: ConversationSummaryView }
  | { operation: 'listed'; conversations: ConversationSummaryView[] }
  | {
      operation: 'read'
      conversation: ConversationSummaryView | null
      messages: ConversationMessageView[]
    }
  | { operation: 'turn'; turn: ConversationTurnView }
  | { operation: 'cancelled'; cancelled: boolean }
  | { operation: 'refused'; reason: string }

export interface ActiveTurnView {  turnId: string
  conversationId: string
  startedAt: string
  /**
   * True only while a provider is genuinely executing.
   *
   * Read from `CoreStatus.activeProviderCalls`, which Core reads from the Model
   * Gateway's registry. A turn that is authorised, stored and compiling context
   * is *not* generating, and saying it were would be claiming paid work is
   * running when nothing is being asked for.
   */
  providerExecuting: boolean
}

/** What Freya can and cannot do about thinking right now. */
export interface CognitionAvailability {
  available: boolean
  /** In words. Null when available. */
  reason: string | null
}

export interface ConversationProjection {
  /**
   * How durable this history really is.
   *
   * Surfaced rather than hidden, because "your conversations are not being saved"
   * is something a person is entitled to know before they say something they would
   * rather not lose.
   */
  persistence: {
    mode: ConversationPersistenceMode
    reason: string | null
  }
  conversations: ConversationSummaryView[]
  activeConversationId: string | null
  messages: ConversationMessageView[]
  activeTurn: ActiveTurnView | null
  cognition: CognitionAvailability
  stopAll: {
    active: boolean
    /** Mirrors the durable latch. Chat cannot be more permissive than this. */
    activatedAt: string | null
  }
  /** Deterministic, so the UI can refuse a paste before it becomes a request. */
  maxMessageCharacters: number
  /** Non-empty when conversation data is damaged or unwritable. */
  faults: string[]
}

/**
 * The voice projection.
 *
 * `available: false` is a real, expected state — most machines have no local
 * speech engine configured, and Phase 3 does not download one. It is reported as
 * unavailable rather than silently doing nothing, because a microphone button
 * that looks live and does nothing is the exact thing the whole voice section is
 * built to avoid.
 */
export interface VoiceProjection {
  transcription: {
    available: boolean
    /** Named engine, e.g. `fake-local`. Never a cloud service. */
    engine: string | null
    detail: string
  }
  synthesis: {
    available: boolean
    engine: string | null
    detail: string
  }
  /** True while a capture session is open. Drives Presence = listening. */
  capturing: boolean
  sessionId: string | null
  /** The deterministic bounds, so the UI can show them. */
  limits: {
    maxDurationMs: number
    maxAudioBytes: number
    format: string
  }
  /** Invariant, stated rather than assumed. */
  localOnly: true
  faults: string[]
}

/**
 * The result of a voice command.
 *
 * `transcript` is text for a composer, nothing more. It has already been through
 * the deterministic length bound, and whoever receives it still has to press Send
 * before a single model credit is spent. That is the whole reason transcription
 * and cognition are separate operations.
 */
export type VoiceCommandOutcome =
  | { operation: 'capture-started'; sessionId: string; startedAt: string }
  | {
      operation: 'capture-ended'
      reason: 'completed' | 'cancelled' | 'too-long' | 'too-large' | 'no-engine' | 'device-lost'
      text: string | null
      detail: string
      transcribed: boolean
      byteLength: number
      durationMs: number
    }
  | { operation: 'cancelled' }
  | { operation: 'refused'; reason: string }
