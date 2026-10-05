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
  | { operation: 'archived'; archived: boolean }
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
 * `state` is the honest answer to "what is the microphone doing right now", and
 * it is a closed union rather than a set of booleans because the states are
 * genuinely different: "off", "you have not granted permission", "permission was
 * taken away", "listening", "transcribing", "speaking" and "STOP ALL is latched"
 * are seven different sentences, and a surface that cannot tell them apart will
 * eventually say the wrong one.
 *
 * ## Nothing here is a capability
 *
 * There is no provider name, no endpoint, no key and no audio. `transcription.kind`
 * and `synthesis.kind` are the *class* of an adapter — `local`, `platform` or
 * `provider` — carried so a window can say "this would be sent to a third party"
 * before the first press. Which third party, and with what credential, is a
 * host-side matter and does not cross.
 */
export interface VoiceProjection {
  /** The machine's actual position. Never inferred by the renderer. */
  state: VoiceStateView
  /** Whether the owner has turned the microphone on. False from construction. */
  micEnabled: boolean
  /** What the operating system last reported. `unknown` until it reports at all. */
  permission: 'unknown' | 'granted' | 'denied' | 'revoked'
  capturing: boolean
  sessionId: string | null
  /**
   * The engine's current guess, bounded.
   *
   * Display only. It never becomes a turn, and a window reading it has no way to
   * submit it — the conversation command takes text from a composer, and this is
   * not on one.
   */
  interim: string
  /** The last confirmed transcript, for a composer. */
  finalTranscript: string | null
  finalTranscriptAt: string | null
  /** Why playback stopped, in words, or null. Never a stack. */
  lastInterruption: string | null
  transcription: {
    available: boolean
    engine: string | null
    /** `local`, `platform` or `provider`. Not a vendor. */
    kind: 'local' | 'platform' | 'provider'
    /** `configuration-required` is the state one setting away from working. */
    availability: 'available' | 'unavailable' | 'configuration-required'
    detail: string
  }
  synthesis: {
    available: boolean
    engine: string | null
    kind: 'local' | 'platform' | 'provider'
    availability: 'available' | 'unavailable' | 'configuration-required'
    detail: string
  }
  speaking: boolean
  queued: number
  muted: boolean
  selectedVoiceId: string | null
  /**
   * Whether a confirmed transcript is submitted on the owner's behalf.
   *
   * Off by default and durable in exactly one sense: it lives for this process
   * and nothing else. Turning voice on does not turn this on.
   */
  autoSubmit: boolean
  wake: {
    armed: boolean
    available: boolean
    gate: string
    /**
     * What the gate actually is.
     *
     * A literal, so a status line cannot call it a wake *word*. This build has a
     * speech-activity gate and no wake-phrase model, and the type is where that
     * fact is written down.
     */
    kind: 'speech-activity'
    detail: string
    maxArmedMs: number
  }
  /** The deterministic bounds, so the UI can show them. */
  limits: {
    maxDurationMs: number
    maxAudioBytes: number
    format: string
    maxTranscriptCharacters: number
    transcriptionTimeoutMs: number
  }
  faults: string[]
}

/**
 * The voice state machine, as it crosses into the window.
 *
 * A separate alias rather than a re-export so the protocol module owns its
 * vocabulary: a change to what a window may be told is a change to this file.
 */
export type VoiceStateView =
  | 'unsupported'
  | 'permission-required'
  | 'permission-denied'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'submitting'
  | 'speaking'
  | 'interrupted'
  | 'degraded'
  | 'failed'
  | 'stopped-by-STOP-ALL'

/**
 * The result of a voice command.
 *
 * `text` is a confirmed transcript when one exists, and it has been through the
 * deterministic length bound. Whether it also became a turn is `turnId`: present
 * means the canonical conversation path took it, and its absence with a non-null
 * `text` means it is sitting in a composer waiting for the owner.
 */
export type VoiceCommandOutcome =
  | { operation: 'state'; state: VoiceStateView }
  | { operation: 'permission'; state: VoiceStateView; outcome: 'granted' | 'denied' | 'revoked' }
  | { operation: 'capture-started'; sessionId: string; startedAt: string }
  | {
      operation: 'capture-ended'
      reason:
        | 'completed'
        | 'cancelled'
        | 'too-long'
        | 'too-large'
        | 'malformed'
        | 'no-engine'
        | 'timeout'
        | 'device-lost'
        | 'permission-revoked'
        | 'stopped-by-STOP-ALL'
      text: string | null
      detail: string
      transcribed: boolean
      byteLength: number
      durationMs: number
      /** The turn this transcript became, or null when it is waiting for a Send. */
      turnId: string | null
    }
  | { operation: 'interim'; sessionId: string; accepted: boolean; reason: string | null }
  | { operation: 'cancelled' }
  | { operation: 'speaking'; utteranceId: string; queued: number }
  | { operation: 'speech-stopped'; utteranceId: string | null }
  | { operation: 'speech-interrupted'; utteranceId: string | null; reason: string }
  | { operation: 'wake-armed' }
  | { operation: 'wake-disarmed' }
  | { operation: 'muted'; muted: boolean; state: VoiceStateView }
  | { operation: 'voice-selected'; voiceId: string }
  | { operation: 'voices'; voices: readonly { voiceId: string; label: string; language: string | null; isDefault: boolean | null }[] }
  | { operation: 'auto-submit'; enabled: boolean }
  | { operation: 'refused'; reason: string }
