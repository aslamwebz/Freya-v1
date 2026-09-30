/**
 * The local voice abstractions.
 *
 * Voice is a *surface*. The microphone produces text, and that text enters the
 * same Conversation pipeline as anything typed, which is the only reason voice
 * belongs in this codebase at all: there is one intelligence, and a spoken
 * message and a typed one are the same message.
 *
 * ## Local-only, and not as a preference
 *
 * `local: true` is a literal type, not a field that could be set to `false`.
 * There is no cloud transcriber to configure, no endpoint, no API key, and no
 * fallback that reaches the network if a local engine is missing. The reason is
 * not squeamishness about audio: microphone audio is the most intimate data a
 * person produces on a machine, and a design that *can* ship it to a third party
 * will eventually ship it to one.
 *
 * ## Transcription is not cognition
 *
 * A transcriber turns sound into text. It does not decide anything, and it does
 * not reach a language model. Conflating the two is the mistake this separation
 * exists to prevent: a local STT engine and a paid LLM are different systems with
 * different costs, different privacy properties and different failure modes, and
 * the boundary between them is where a "helpful" automatic send would end up.
 *
 * So a finished transcript is *text in a composer*. Someone still presses Send.
 */

/** One active capture. At most one exists at a time. */
export interface VoiceCaptureSession {
  sessionId: string
  startedAt: string
  format: 'pcm-s16le'
  sampleRate: number
  channels: number
}

/** Audio handed to a local transcriber. Never journalled, never stored. */
export interface CapturedAudio {
  format: 'pcm-s16le'
  sampleRate: number
  channels: number
  bytes: Uint8Array
  durationMs: number
}

export interface TranscriptionResult {
  text: string
  /** Named engine, for the status line. Never a cloud service name. */
  engine: string
}

export interface SynthesisResult {
  bytes: Uint8Array
  format: string
  engine: string
}

/**
 * A local speech-to-text engine.
 *
 * `local: true` is required and cannot be anything else, so a remote engine is a
 * compile error rather than a configuration mistake discovered in production.
 */
export interface VoiceTranscriber {
  readonly id: string
  readonly local: true
  transcribe(audio: CapturedAudio): Promise<TranscriptionResult>
}

/**
 * A local text-to-speech engine.
 *
 * Present as a seam and not wired to anything automatic. Freya does not speak
 * every answer in this phase; an answer is text on a screen, and a future phase
 * may offer to read it aloud *if a local engine is configured*.
 */
export interface VoiceSynthesizer {
  readonly id: string
  readonly local: true
  synthesize(text: string): Promise<SynthesisResult>
}

/**
 * Deterministic capture bounds.
 *
 * Fixed here rather than negotiated, for the same reason conversation limits are:
 * a limit that depends on who is asking is a limit somebody can raise. These are
 * the things that must fail visibly rather than quietly becoming a large buffer
 * somewhere in the process.
 */
export const VOICE_LIMITS = Object.freeze({
  /** The longest a single press may record. */
  maxDurationMs: 30_000,
  /** The largest audio payload accepted from a capture. */
  maxAudioBytes: 4 * 1024 * 1024,
  /** The only accepted wire format. PCM signed 16-bit little-endian. */
  format: 'pcm-s16le' as const,
  sampleRate: 16_000,
  channels: 1,
  /** The longest transcript inserted into a composer. */
  maxTranscriptCharacters: 8_000,
})

export type VoiceEndReason = 'completed' | 'cancelled' | 'too-long' | 'too-large' | 'no-engine' | 'device-lost'

export interface VoiceEndResult {
  sessionId: string
  reason: VoiceEndReason
  /**
   * The transcript, when there is one.
   *
   * Text for the composer. Not an answer, not a message, and not anything that has
   * been sent: the user still presses Send, and that press is the only thing that
   * authorises cognition.
   */
  text: string | null
  /** In words, for the UI. Never a stack, never audio. */
  detail: string
  byteLength: number
  durationMs: number
  transcribed: boolean
}
