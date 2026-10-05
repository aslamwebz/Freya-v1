import { VOICE_LIMITS, type TtsRequest, type VoiceAdapterAvailability, type VoiceAdapterKind, type VoiceOption, type VoiceTtsAdapter } from './types'

/**
 * Text-to-speech adapters.
 *
 * The same provider-neutral shape as the STT side, and the same asymmetry: a
 * local adapter ships, a hosted one does not. Speech *output* is less intimate
 * than speech input, but it is not nothing — a synthesised voice is a
 * representation of Freya, and a hosted engine is a third party that both stores
 * the text it was asked to say and gets to choose the voice. That is a host
 * decision with a credential that must stay in the main process, so the seam
 * exists and nothing in this repository constructs a provider adapter.
 *
 * ## Core does not speak; Core decides
 *
 * There is no audio device in Core and no synthesiser is called from here. What
 * Core owns is the *decision*: which stored turn may be spoken, in which order,
 * with which voice, and when playback is cut off. The adapter that actually
 * makes a sound lives in the desktop host, behind this port.
 *
 * The consequence worth stating: a renderer cannot name what Freya says. It
 * asks for a `turnId`, Core looks the words up in the conversation store, and
 * anything the renderer put in a `text` field is discarded rather than read.
 */

/** The refusal every unavailable adapter produces. */
export class TtsUnavailableError extends Error {
  constructor(readonly availability: VoiceAdapterAvailability, message: string) {
    super(message)
    this.name = 'TtsUnavailableError'
  }
}

export function isTtsUnavailable(error: unknown): error is TtsUnavailableError {
  return error instanceof TtsUnavailableError
}

/**
 * An output engine that is not configured.
 *
 * The default for a Core built without one. Like its transcription counterpart it
 * is an object rather than an `undefined`, so "Freya cannot speak" is a state the
 * service can report instead of a null check somebody will forget.
 */
export class UnavailableTtsAdapter implements VoiceTtsAdapter {
  readonly id: string
  readonly kind: VoiceAdapterKind
  readonly availability: VoiceAdapterAvailability
  readonly detail: string

  constructor(
    options: {
      id?: string
      kind?: VoiceAdapterKind
      availability?: VoiceAdapterAvailability
      detail?: string
    } = {},
  ) {
    this.id = options.id ?? 'no-speech-output'
    this.kind = options.kind ?? 'platform'
    this.availability = options.availability ?? 'unavailable'
    this.detail =
      options.detail ??
      (this.availability === 'configuration-required'
        ? 'No speech output engine is configured, so Freya does not read replies aloud.'
        : 'This platform offers no speech output, so Freya does not read replies aloud.')
  }

  async voices(): Promise<VoiceOption[]> {
    return []
  }

  async speak(): Promise<{ engine: string; completed: boolean }> {
    throw new TtsUnavailableError(this.availability, this.detail)
  }

  async stop(): Promise<void> {}

  async cancel(): Promise<void> {}
}

/**
 * A stand-in that records what it was asked to say.
 *
 * It makes no sound. It is what tests use to prove that Core chose the words, in
 * the right order, and cut them off at the right moment — and it names itself, so
 * a status line cannot show "Freya is speaking" over a machine that is silent.
 */
export class DeterministicTtsAdapter implements VoiceTtsAdapter {
  readonly id: string
  readonly kind: VoiceAdapterKind = 'platform'
  readonly availability: VoiceAdapterAvailability = 'available'
  readonly detail = 'A deterministic stand-in for a speech output engine. It makes no sound.'
  /** Everything it was asked to say, in order. Test-only. */
  spoken: { utteranceId: string; text: string; voiceId: string | null }[] = []
  stopped = 0
  cancelled = 0
  /** Set to hold playback open until the test releases it. */
  gate: (() => void) | null = null

  constructor(id = 'fake-local-synthesizer') {
    this.id = id
  }

  async voices(): Promise<VoiceOption[]> {
    return [
      { voiceId: 'stand-in', label: 'Stand-in voice', language: null, isDefault: true },
    ]
  }

  async speak(request: TtsRequest): Promise<{ engine: string; completed: boolean }> {
    this.spoken.push({ utteranceId: request.utteranceId, text: request.text, voiceId: request.voiceId })
    if (this.gate !== null) {
      await new Promise<void>((resolve) => {
        const previous = this.gate
        this.gate = () => {
          previous?.()
          resolve()
        }
      })
    }
    if (request.signal.aborted) throw new SttTimeoutLikeCancellation()
    return { engine: this.id, completed: true }
  }

  async stop(): Promise<void> {
    this.stopped += 1
    this.gate = null
  }

  async cancel(): Promise<void> {
    this.cancelled += 1
    this.gate = null
  }
}

class SttTimeoutLikeCancellation extends Error {
  constructor() {
    super('the utterance was cancelled')
    this.name = 'Cancellation'
  }
}

/**
 * Clamp a speaking rate into the range every engine accepts.
 *
 * Core exposes three numbers a renderer can set — rate, pitch, voice — and a
 * number that is `NaN`, negative or enormous has to be refused *somewhere*. It
 * is clamped here rather than trusted, because the caller is the window.
 */
export function clampSpeakingTuning(rate: unknown, pitch: unknown): { rate: number; pitch: number } {
  return {
    rate: clampUnit(rate, 1, 0.5, 2),
    pitch: clampUnit(pitch, 1, 0, 2),
  }
}

function clampUnit(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** The longest text a single utterance may carry. Clipped, never queued whole. */
export function boundUtterance(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= VOICE_LIMITS.maxSpeechCharacters) return collapsed
  return `${collapsed.slice(0, VOICE_LIMITS.maxSpeechCharacters).trimEnd()}…`
}