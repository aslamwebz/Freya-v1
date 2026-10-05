/**
 * The local voice abstractions.
 *
 * Voice is a *surface*. The microphone produces text, and that text enters the
 * same Conversation pipeline as anything typed, which is the only reason voice
 * belongs in this codebase at all: there is one intelligence, and a spoken
 * message and a typed one are the same message.
 *
 * ## Voice is I/O, not authority
 *
 * Nothing in this directory can decide anything. There is no grant here, no
 * budget, no capability check and no model call, because a recogniser is a
 * transcriber and a transcriber does not think. Spoken input arrives as text at
 * the *same door* typed input arrives at, and everything downstream of that door
 * — the Mind, the Guard, the Governor, STOP ALL, the budget — is untouched.
 *
 * ## Provider-neutral, and the seam is the point
 *
 * Phase 3 declared the ports `local: true` and refused to imagine a network. That
 * was right for what existed then and it is wrong for what exists now: the
 * *shape* of the boundary is what matters, and a boundary that cannot express a
 * hosted engine is a boundary that will be broken open later by someone in a
 * hurry.
 *
 * So the ports are provider-neutral now, with `kind` naming where an adapter
 * runs — `local`, `platform`, `provider`. What did **not** change is the rule
 * that matters: an adapter that is not configured reports `unavailable` and the
 * recording is discarded. There is no default engine, no silent fallback, and no
 * adapter that reaches a network unless a host-side credential was deliberately
 * configured for it. The absence of a fallback is a property of `VoiceService`,
 * not of the adapters: `VoiceService` has no idea how to reach one.
 *
 * ## Audio is not kept
 *
 * `CapturedAudio` is a parameter, not a field. It exists for the length of one
 * `transcribe` call and is dropped when that call returns. There is no store
 * here, no journal payload that can hold samples, and no adapter interface with
 * a `save` on it.
 */

/* ------------------------------------------------------------------ states */

/**
 * The voice state machine, in the words a person would use.
 *
 * Named states rather than a boolean soup, because the UI has to be able to say
 * *which* of several very different things went wrong: "the microphone is off",
 * "you have not granted permission", "permission was granted and then taken
 * away", "there is no engine", "an engine timed out". Those are not one boolean
 * and a microphone button that cannot tell them apart will lie about one of
 * them.
 *
 * The transitions are enforced in `VoiceService`; this union exists so that a
 * state can never be spelled wrong.
 */
export type VoiceState =
  /** This platform exposes no capture path at all. Nothing can be tried. */
  | 'unsupported'
  /** Capture is possible but the operating system permission has not been asked for. */
  | 'permission-required'
  /** The permission was asked for and refused. Re-asking is the owner's choice. */
  | 'permission-denied'
  /** Permission held, microphone closed, nothing in flight. */
  | 'ready'
  /** Audio is being captured and has not been released. */
  | 'listening'
  /** Audio has been released and an engine is reading it. */
  | 'transcribing'
  /** A confirmed transcript is entering the canonical conversation path. */
  | 'submitting'
  /** Core has authorised playback and the output adapter is playing. */
  | 'speaking'
  /** Playback was cut short — by the owner, by barge-in, or by STOP ALL. */
  | 'interrupted'
  /** Working, but something is wrong that does not stop the feature. */
  | 'degraded'
  /** A capture, transcription or playback failed. Details are in `faults`. */
  | 'failed'
  /** STOP ALL is latched. Capture, transcription, submission and speech are all refused. */
  | 'stopped-by-STOP-ALL'

/** Why a capture session ended. Each of these is a different thing to a person. */
export type VoiceEndReason =
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

/* -------------------------------------------------------------------- audio */

/** The only sample format Freya will accept. PCM signed 16-bit little-endian. */
export const VOICE_FORMAT = 'pcm-s16le' as const

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
  format: VOICE_FORMAT,
  sampleRate: 16_000,
  channels: 1,
  /** Bytes per sample per channel. 16-bit, so two. */
  bytesPerSample: 2,
  /**
   * The longest a single transcription may take before it is abandoned.
   *
   * A recogniser that hangs is a stuck microphone indicator and a session that
   * never closes. This is a hard deadline, not a preference.
   */
  transcriptionTimeoutMs: 20_000,
  /** The longest a queued utterance may be. Past this it is clipped, not queued. */
  maxSpeechCharacters: 8_000,
  /** The longest an interim fragment may be before it is clipped. */
  maxInterimCharacters: 1_000,
  /** The longest a final transcript may be. Bounded for the same reason as a message. */
  maxTranscriptCharacters: 8_000,
  /** How many utterances may be queued for playback at once. */
  maxSpeechQueue: 8,
  /** The longest a wake gate may stay armed before it returns to idle by itself. */
  maxWakeArmedMs: 15 * 60_000,
})

/**
 * Codecs this build will read.
 *
 * A closed list, because "let the caller declare its own codec" is a request
 * buffer that happens to be named. A codec outside this set is refused at the
 * edge in `validateAudio` rather than being handed to an engine to fail at.
 */
export const VOICE_CODECS: ReadonlySet<string> = new Set(['pcm_s16le', 'pcm'])

/**
 * MIME types that may accompany PCM.
 *
 * Also closed, and for the same reason. Note what is *absent*: every compressed
 * container. A `.webm` or `.opus` payload would need a decoder, and a decoder in
 * the host is a new thing that parses attacker-shaped bytes.
 */
export const VOICE_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/pcm',
  'audio/l16',
  'audio/x-pcm',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
])

/** The sample rates a capture may declare. */
export const VOICE_SAMPLE_RATES: ReadonlySet<number> = new Set([8_000, 11_025, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000])

/** Channel counts a capture may declare. Mono is what the engine is defined at. */
export const VOICE_CHANNEL_COUNTS: ReadonlySet<number> = new Set([1, 2])

/** Audio handed to an engine. Never journalled, never stored, never returned. */
export interface CapturedAudio {
  format: typeof VOICE_FORMAT
  sampleRate: number
  channels: number
  bytes: Uint8Array
  durationMs: number
}

/** What a capture *claims* about itself, alongside the samples. */
export interface AudioDescriptor {
  format: string
  codec: string
  mimeType: string
  sampleRate: number
  channels: number
  /** Sample frames, as distinct from bytes. Checked against the byte ceiling too. */
  frames: number
  bytes: number
  durationMs: number
}

/* --------------------------------------------------------------- transcripts */

/**
 * Interim or final.
 *
 * The distinction is the whole transcript policy. An interim fragment is a guess
 * the engine is still revising; it is displayed, bounded, and *never* reaches the
 * conversation path. Only a final fragment does, and only through the canonical
 * command — which is why this is a closed two-value union rather than a boolean
 * that some future caller could get backwards.
 */
export type VoiceTranscriptKind = 'interim' | 'final'

/** One piece of recognised text. */
export interface VoiceTranscriptFragment {
  sessionId: string
  kind: VoiceTranscriptKind
  /** Bounded by `VOICE_LIMITS.maxInterimCharacters` or `maxTranscriptCharacters`. */
  text: string
  at: string
}

/** One open capture. At most one exists at a time. */
export interface VoiceCaptureSession {
  sessionId: string
  startedAt: string
  format: typeof VOICE_FORMAT
  sampleRate: number
  channels: number
  /** The interim text an engine has produced so far. Display only. */
  interim: string
}

/* --------------------------------------------------------------------- ports */

/**
 * How an adapter runs.
 *
 * `local` is a process on this machine. `platform` is an operating-system or
 * browser-provided facility. `provider` is a hosted service, and it is in the
 * union on purpose — the boundary has to be able to *describe* one before it can
 * refuse one honestly, and `kind` is what lets the UI say "your audio would be
 * sent to a third party" rather than "voice is broken".
 */
export type VoiceAdapterKind = 'local' | 'platform' | 'provider'

/**
 * Whether an adapter can actually run right now.
 *
 * Three states, not two. `configuration-required` is the one that matters: an
 * engine exists and the host simply has not been given a credential or a binary.
 * Collapsing it into `unavailable` produces the "it doesn't work" message for a
 * machine where one setting would make it work.
 */
export type VoiceAdapterAvailability = 'available' | 'unavailable' | 'configuration-required'

/** The common shape of both ports' read-only half. */
export interface VoiceAdapterDescriptor {
  readonly id: string
  readonly kind: VoiceAdapterKind
  readonly availability: VoiceAdapterAvailability
  /** In words, for a person. Never a stack, never a credential, never audio. */
  readonly detail: string
}

export interface SttRequest {
  sessionId: string
  audio: CapturedAudio
  /** Aborts on cancel, STOP ALL, timeout, or unmount. Checked by the adapter. */
  signal: AbortSignal
  /** A hard deadline in milliseconds. An adapter that ignores it is wrapped, not trusted. */
  timeoutMs: number
}

export interface SttResult {
  text: string
  /** Named engine, for the status line. Never a credential. */
  engine: string
}

/**
 * A speech-to-text engine.
 *
 * `transcribe` is required and returns only a final result. `stream` is optional
 * and is how interim text appears: an adapter that cannot revise its guesses
 * simply does not implement it, and the UI shows a recording indicator instead
 * of fake interim words.
 */
export interface VoiceSttAdapter {
  readonly id: string
  readonly kind: VoiceAdapterKind
  readonly availability: VoiceAdapterAvailability
  readonly detail: string
  /** True when this adapter can emit interim fragments while audio arrives. */
  readonly streaming: boolean
  transcribe(request: SttRequest): Promise<SttResult>
  stream?(
    request: SttRequest,
    onFragment: (fragment: { kind: VoiceTranscriptKind; text: string }) => void,
  ): Promise<SttResult>
}

/** One selectable voice. Named by the platform, never invented by Core. */
export interface VoiceOption {
  voiceId: string
  label: string
  /** BCP-47 tag when the platform reports one. Otherwise null, not a guess. */
  language: string | null
  /** The platform's own default flag, or null when it reports nothing. */
  isDefault: boolean | null
}

export interface TtsRequest {
  utteranceId: string
  /** Already resolved by Core from a stored turn. The adapter never chooses words. */
  text: string
  voiceId: string | null
  rate: number
  pitch: number
  signal: AbortSignal
}

/**
 * A text-to-speech engine.
 *
 * `speak` resolves when playback *finishes* and rejects when it is cut short, so
 * a caller can tell "Freya said the whole thing" from "Freya was interrupted"
 * without polling. `stop` ends the current utterance cleanly and `cancel` drops
 * it, matching the difference between finishing a sentence and being cut off
 * mid-word.
 */
export interface VoiceTtsAdapter {
  readonly id: string
  readonly kind: VoiceAdapterKind
  readonly availability: VoiceAdapterAvailability
  readonly detail: string
  /** The voices this adapter can actually select, discovered not configured. */
  voices(): Promise<VoiceOption[]>
  speak(request: TtsRequest): Promise<{ engine: string; completed: boolean }>
  /** End the current utterance at a boundary and drain the queue. */
  stop(): Promise<void>
  /** Drop the current utterance mid-word and drain the queue. */
  cancel(): Promise<void>
}

/** Whether the wake gate may be armed at all on this build. */
export type WakeAvailability = 'unavailable' | 'available'

/**
 * The wake gate.
 *
 * This is a *policy* port, not a speech port, and that is deliberate. Phase 45
 * has no wake-word model and will not pretend to have one. What exists is a
 * bounded local gate: the owner turns it on, the platform reports sustained
 * local speech energy, and after a fixed window the gate disarms itself.
 *
 * A wake signal is a *hint that a person is talking*. It is never authority: it
 * cannot submit a turn, cannot create a grant, and cannot bypass STOP ALL. The
 * only thing it does is ask the normal capture path to start, which then has to
 * satisfy every ordinary precondition.
 */
export interface WakeGate {
  readonly id: string
  readonly availability: WakeAvailability
  readonly detail: string
  /** Sustained-energy threshold in [0,1]. Above this, a frame counts as speech. */
  readonly threshold: number
  /** How long energy must stay above the threshold before the gate fires. */
  readonly sustainMs: number
  /** The longest the gate may stay armed. Reached, it disarms itself. */
  readonly maxArmedMs: number
}

/* ------------------------------------------------------------------- results */

export interface VoiceEndResult {
  sessionId: string
  reason: VoiceEndReason
  /**
   * The confirmed transcript, when there is one.
   *
   * Text for the composer or for the canonical conversation path. Not an answer,
   * not a message, and not anything that has been sent unless the owner turned
   * auto-submit on *before* speaking.
   */
  text: string | null
  /** In words, for the UI. Never a stack, never audio. */
  detail: string
  byteLength: number
  durationMs: number
  transcribed: boolean
  /** The turn id, when the transcript went through the canonical conversation path. */
  turnId: string | null
}

export type SpeakOutcome =
  | { ok: true; utteranceId: string; queued: number; engine: string }
  | { ok: false; reason: string }