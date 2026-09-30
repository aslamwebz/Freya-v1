import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type {
  CapturedAudio,
  VoiceCaptureSession,
  VoiceEndResult,
  VoiceSynthesizer,
  VoiceTranscriber,
} from './types'
import { VOICE_LIMITS } from './types'
import type { VoiceProjection } from '../protocol/conversation'
import type { CoreEventPayloads } from '../events/envelope'

type VoiceEventPayload =
  | CoreEventPayloads['voice.capture.started']
  | CoreEventPayloads['voice.capture.completed']
  | CoreEventPayloads['voice.capture.cancelled']

/**
 * The Voice Service.
 *
 * It owns exactly one thing: turning an explicit, bounded press-and-release into
 * text, and reporting honestly when it cannot.
 *
 * ## What it deliberately does not do
 *
 * - **It never spends a cognition credit.** There is no call to the Governor, the
 *   Gateway or a provider anywhere in this file, and a finished transcript is text
 *   in a composer rather than a submitted turn. Speech recognition and thinking
 *   are different systems, and this is the line between them.
 * - **It never records in the background.** A session exists only between
 *   `beginCapture` and an end call. Nothing runs when the app starts, and there is
 *   no always-on mode or wake-word daemon.
 * - **It never keeps the audio.** The bytes are handed to a local engine and
 *   dropped. They are never journalled, never written to disk, and never become
 *   "memory" — a recording of someone's room is not a fact worth keeping.
 * - **It never falls back to the network.** With no local engine configured the
 *   answer is `unavailable`, which is a real state shown in the UI rather than a
 *   silent no-op.
 *
 * ## The seam
 *
 * A production transcriber is injected. The phase ships a deterministic fake for
 * tests and development; a local binary adapter is a future piece of work and its
 * absence is what `available: false` means. What matters now is that the
 * architecture is the one that will hold a real engine, and that no part of the
 * path is willing to reach a network if it is missing.
 */

export interface VoiceServiceOptions {
  fabric: EventFabric
  /** Absent means "no local speech engine is configured". Never a cloud default. */
  transcriber?: VoiceTranscriber
  synthesizer?: VoiceSynthesizer
  now?: () => Date
  newId?: () => string
}

export class VoiceService {
  private readonly fabric: EventFabric
  private readonly transcriber: VoiceTranscriber | undefined
  private readonly synthesizer: VoiceSynthesizer | undefined
  private readonly now: () => Date
  private readonly newId: () => string

  private session: VoiceCaptureSession | null = null
  private faults: string[] = []

  constructor(options: VoiceServiceOptions) {
    this.fabric = options.fabric
    this.transcriber = options.transcriber
    this.synthesizer = options.synthesizer
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
  }

  /** Whether a local speech-to-text engine is configured. */
  get transcriptionAvailable(): boolean {
    return this.transcriber !== undefined
  }

  /**
   * Begin a capture.
   *
   * Explicit, always: this is reachable only from a control the user pressed, and
   * there is no path here that runs at start-up or on a timer. One session at a
   * time — a second press while one is open is refused rather than interleaving
   * two microphones.
   */
  async beginCapture(): Promise<
    { ok: true; session: VoiceCaptureSession } | { ok: false; reason: string }
  > {
    if (this.session !== null) {
      return { ok: false, reason: 'a recording is already in progress' }
    }
    const session: VoiceCaptureSession = {
      sessionId: this.newId(),
      startedAt: this.now().toISOString(),
      format: VOICE_LIMITS.format,
      sampleRate: VOICE_LIMITS.sampleRate,
      channels: VOICE_LIMITS.channels,
    }
    this.session = session
    await this.record(
      'voice.capture.started',
      { sessionId: session.sessionId, format: session.format, sampleRate: session.sampleRate },
      session.sessionId,
    )
    return { ok: true, session }
  }

  /**
   * Finish a capture and transcribe it locally.
   *
   * The bounds are checked *before* the audio is accepted, so an oversized buffer
   * is refused rather than handed to an engine. `cancelled` is a first-class
   * reason rather than a failure: releasing the microphone is a thing the user
   * does routinely, and it should not leave a fault behind.
   */
  async endCapture(input: {
    sessionId: string
    audio?: Uint8Array
    durationMs?: number
    cancelled?: boolean
  }): Promise<VoiceEndResult> {
    const session = this.session
    if (session === null || session.sessionId !== input.sessionId) {
      return {
        sessionId: input.sessionId,
        reason: 'cancelled',
        text: null,
        detail: 'no recording was in progress',
        byteLength: 0,
        durationMs: 0,
        transcribed: false,
      }
    }
    // Released first, so no path below can leave a session open.
    this.session = null

    const durationMs = Math.max(0, input.durationMs ?? 0)
    const bytes = input.audio ?? new Uint8Array(0)

    if (input.cancelled === true) {
      await this.record(
        'voice.capture.cancelled',
        {
          sessionId: session.sessionId,
          byteLength: bytes.byteLength,
          reason: 'the owner released the microphone before speaking',
        },
        session.sessionId,
      )
      return {
        sessionId: session.sessionId,
        reason: 'cancelled',
        text: null,
        detail: 'Recording discarded.',
        byteLength: bytes.byteLength,
        durationMs,
        transcribed: false,
      }
    }

    if (durationMs > VOICE_LIMITS.maxDurationMs) {
      return await this.refuseBounds(session, bytes.byteLength, durationMs, 'too-long')
    }
    if (bytes.byteLength > VOICE_LIMITS.maxAudioBytes) {
      return await this.refuseBounds(session, bytes.byteLength, durationMs, 'too-large')
    }
    if (bytes.byteLength === 0) {
      return {
        sessionId: session.sessionId,
        reason: 'cancelled',
        text: null,
        detail: 'Nothing was recorded.',
        byteLength: 0,
        durationMs,
        transcribed: false,
      }
    }

    if (this.transcriber === undefined) {
      // The expected state on most machines. Said plainly, and the audio is
      // dropped: a transcript is better than silence, and inventing one is not.
      await this.record(
        'voice.capture.completed',
        {
          sessionId: session.sessionId,
          byteLength: bytes.byteLength,
          durationMs,
          transcribed: false,
          transcriptLength: 0,
        },
        session.sessionId,
      )
      this.faults = [
        ...this.faults,
        'no local speech engine is configured, so the recording was discarded',
      ]
      return {
        sessionId: session.sessionId,
        reason: 'no-engine',
        text: null,
        detail: 'No local speech engine is configured, so the recording was discarded.',
        byteLength: bytes.byteLength,
        durationMs,
        transcribed: false,
      }
    }

    let text: string
    try {
      const audio: CapturedAudio = {
        format: VOICE_LIMITS.format,
        sampleRate: session.sampleRate,
        channels: session.channels,
        bytes,
        durationMs,
      }
      text = (await this.transcriber.transcribe(audio)).text.trim()
    } catch (error) {
      await this.record(
        'voice.capture.cancelled',
        {
          sessionId: session.sessionId,
          byteLength: bytes.byteLength,
          reason: 'the local speech engine failed',
        },
        session.sessionId,
      )
      this.faults = [
        ...this.faults,
        `the local speech engine failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      ]
      return {
        sessionId: session.sessionId,
        reason: 'device-lost',
        text: null,
        detail: 'The local speech engine could not read that recording.',
        byteLength: bytes.byteLength,
        durationMs,
        transcribed: false,
      }
    }

    // Bounded, so a pathological transcript cannot become one enormous request.
    const bounded =
      text.length > VOICE_LIMITS.maxTranscriptCharacters
        ? `${text.slice(0, VOICE_LIMITS.maxTranscriptCharacters).trimEnd()}…`
        : text

    await this.record(
      'voice.capture.completed',
      {
        sessionId: session.sessionId,
        byteLength: bytes.byteLength,
        durationMs,
        transcribed: true,
        transcriptLength: bounded.length,
      },
      session.sessionId,
    )

    return {
      sessionId: session.sessionId,
      reason: 'completed',
      text: bounded,
      detail: bounded.length > 0 ? 'Transcribed locally. Review it, then send.' : 'Nothing was said.',
      byteLength: bytes.byteLength,
      durationMs,
      transcribed: true,
    }
  }

  /**
   * Speak a reply, if a local engine is configured.
   *
   * Explicitly opt-in per call and never automatic. Freya does not read every
   * answer aloud in this phase, because an assistant that talks over you is a
   * worse assistant than one that waits to be asked.
   */
  async speak(text: string): Promise<
    { ok: true; bytes: Uint8Array; format: string; engine: string } | { ok: false; reason: string }
  > {
    if (this.synthesizer === undefined) {
      return { ok: false, reason: 'no local speech engine is configured for playback' }
    }
    const bounded = text.slice(0, VOICE_LIMITS.maxTranscriptCharacters)
    try {
      const result = await this.synthesizer.synthesize(bounded)
      return { ok: true, bytes: result.bytes, format: result.format, engine: result.engine }
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'local speech synthesis failed',
      }
    }
  }

  projection(): VoiceProjection {
    return {
      transcription: this.transcriber
        ? {
            available: true,
            engine: this.transcriber.id,
            detail: 'A local speech-to-text engine is configured. Audio never leaves this machine.',
          }
        : {
            available: false,
            engine: null,
            detail:
              'No local speech-to-text engine is configured. Microphone capture is available but ' +
              'recordings are discarded rather than sent anywhere.',
          },
      synthesis: this.synthesizer
        ? {
            available: true,
            engine: this.synthesizer.id,
            detail: 'A local text-to-speech engine is configured.',
          }
        : {
            available: false,
            engine: null,
            detail: 'No local text-to-speech engine is configured, so Freya does not speak replies.',
          },
      capturing: this.session !== null,
      sessionId: this.session?.sessionId ?? null,
      limits: {
        maxDurationMs: VOICE_LIMITS.maxDurationMs,
        maxAudioBytes: VOICE_LIMITS.maxAudioBytes,
        format: VOICE_LIMITS.format,
      },
      localOnly: true,
      faults: [...new Set(this.faults)],
    }
  }

  /** Release the microphone without transcribing. Used on window teardown. */
  async abandon(reason: string): Promise<void> {
    const session = this.session
    if (session === null) return
    this.session = null
    await this.record(
      'voice.capture.cancelled',
      { sessionId: session.sessionId, byteLength: 0, reason },
      session.sessionId,
    )
  }

  private async refuseBounds(
    session: VoiceCaptureSession,
    byteLength: number,
    durationMs: number,
    reason: 'too-long' | 'too-large',
  ): Promise<VoiceEndResult> {
    const detail =
      reason === 'too-long'
        ? `That recording is longer than the ${Math.round(VOICE_LIMITS.maxDurationMs / 1000)}s limit, ` +
          'so it was discarded.'
        : `That recording is larger than the ${Math.round(VOICE_LIMITS.maxAudioBytes / 1024 / 1024)}MB ` +
          'limit, so it was discarded.'
    await this.record(
      'voice.capture.cancelled',
      { sessionId: session.sessionId, byteLength, reason: detail },
      session.sessionId,
    )
    return { sessionId: session.sessionId, reason, text: null, detail, byteLength, durationMs, transcribed: false }
  }

  /**
   * Append voice metadata.
   *
   * Never audio, and never the transcript. The three payload shapes are named
   * rather than passed as a bag, so a fourth field cannot be added to a voice
   * event without this signature changing — which is the point, because the
   * moment a voice event can carry anything arbitrary is the moment the journal
   * becomes a place recordings leak.
   */
  private async record(
    type: 'voice.capture.started' | 'voice.capture.completed' | 'voice.capture.cancelled',
    payload: VoiceEventPayload,
    sessionId: string,
  ): Promise<void> {
    await this.fabric.append(type, payload, { actor: 'owner', correlationId: sessionId })
  }
}

/**
 * A deterministic local transcriber for tests and development.
 *
 * Not a mock of a *cloud* service pretending to be local — it is a stand-in for
 * a local engine, and it says so in its own `id` so a status line can never
 * present a test engine as a real one. It reads nothing from the audio: the
 * transcript is a fixed string, so a test asserts on a known value and a
 * development session cannot be mistaken for recognition.
 */
export class FakeVoiceTranscriber implements VoiceTranscriber {
  readonly id: string
  readonly local = true as const
  calls = 0

  constructor(
    private readonly text = 'this is a local transcription placeholder, not recognition',
    id = 'fake-local-transcriber',
  ) {
    this.id = id
  }

  async transcribe(_audio: CapturedAudio): Promise<{ text: string; engine: string }> {
    this.calls += 1
    return { text: this.text, engine: this.id }
  }
}

/** A deterministic local synthesizer for tests and development. */
export class FakeVoiceSynthesizer implements VoiceSynthesizer {
  readonly id: string
  readonly local = true as const
  calls = 0

  constructor(id = 'fake-local-synthesizer') {
    this.id = id
  }

  async synthesize(text: string): Promise<{ bytes: Uint8Array; format: string; engine: string }> {
    this.calls += 1
    // A length marker rather than audio. Enough to prove the seam works, and
    // impossible to mistake for a real synthesiser's output.
    const bytes = new Uint8Array(Math.min(text.length, 1024))
    return { bytes, format: 'fake-local-pcm', engine: this.id }
  }
}
