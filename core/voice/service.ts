import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { CoreEventPayloads } from '../events/envelope'
import { clipText, validateAudio, type AudioValidation } from './audio'
import { isSttUnavailable, SttTimeout, withTimeout } from './stt'
import { boundUtterance, clampSpeakingTuning, isTtsUnavailable } from './tts'
import { LOCAL_ENERGY_WAKE_GATE, crossesWakeThreshold } from './wake'
import type { VoiceProjection } from '../protocol/conversation'
import {
  VOICE_FORMAT,
  VOICE_LIMITS,
  type SpeakOutcome,
  type SttRequest,
  type SttResult,
  type VoiceAdapterKind,
  type VoiceCaptureSession,
  type VoiceEndReason,
  type VoiceEndResult,
  type VoiceOption,
  type VoiceState,
  type VoiceSttAdapter,
  type VoiceTranscriptFragment,
  type VoiceTranscriptKind,
  type VoiceTtsAdapter,
  type WakeGate,
} from './types'

/**
 * The Voice Service.
 *
 * It owns one thing: turning an explicit, bounded press-and-release into text
 * that enters the *same conversation door* as typing, and turning a stored Core
 * answer into speech. Nothing else.
 *
 * ## What it deliberately does not do
 *
 * - **It never spends a cognition credit.** There is no call to the Governor, the
 *   Gateway or a provider anywhere in this file. When the owner has turned
 *   auto-submit on, the service calls the *injected* conversation submitter —
 *   which is the same function `conversation.turn.submit` calls, so the Mind, the
 *   Guard, the Governor, the budget and STOP ALL are all still upstream of it.
 *   Voice has no route around any of them, because it has no route at all.
 * - **It never records in the background.** A session exists only between
 *   `beginCapture` and an end call. Nothing runs at start-up, on a timer, or on a
 *   wake event unless the owner armed the gate first.
 * - **It never keeps the audio.** Bytes are handed to an adapter and dropped.
 *   There is no store, no journal payload that can hold samples, and the one
 *   local variable holding them is released on every return path.
 * - **It never invents a transcript.** With no engine configured the answer is
 *   `no-engine`, which is a state the UI shows rather than a silent no-op.
 *
 * ## The state machine
 *
 * One `VoiceState`, advanced only by the methods here. A caller cannot set it,
 * and a refusal cannot leave it stale: every method that ends a capture ends it in
 * a named terminal state, and `publish()` fires on every move. That is what makes
 * "truthful indicators" checkable rather than aspirational — a window reading the
 * projection sees where the machine actually is.
 *
 * ## STOP ALL
 *
 * `onStopAll` is called from the same synchronous turn that closes the gateway,
 * and it is deliberately *synchronous in effect*: the capture is released, the
 * transcription aborted, the queue dropped and the state latched before any await
 * in this file. A voice session that survived a stop would be a microphone still
 * open after the owner asked Freya to stop.
 */

export interface VoiceServiceOptions {
  fabric: EventFabric

  /** Absent means "no speech engine is configured". Never a default engine. */
  stt?: VoiceSttAdapter
  /** Absent means "no speech output is configured". */
  tts?: VoiceTtsAdapter
  /** Absent means "no local wake detector is configured". */
  wake?: WakeGate

  /**
   * The canonical conversation entry point.
   *
   * Injected, and it is the *same* function typed input reaches. This service has
   * no store, no Mind, no grant and no Gateway, so the only way a spoken word
   * becomes a turn is by being handed to Core's own door. Anything that could
   * submit a turn by another route would be a second brain, and this file is
   * built so that one cannot exist here.
   */
  submitTurn?: (input: { text: string }) => Promise<VoiceSubmitResult>

  /**
   * Look up the stored answer for a turn, for playback.
   *
   * Also injected, for the same reason and with the opposite direction: Core reads
   * its own conversation store and hands over the words. The renderer never gets
   * to say what Freya says; it names a turn and Core decides.
   */
  resolveTurnText?: (turnId: string) => Promise<{ ok: boolean; text: string | null; reason: string | null }>

  /** Whether STOP ALL is latched. Read fresh on every check, never cached. */
  stopAll?: () => boolean

  /** Whether a speech-transcription surface exists on this platform at all. */
  captureSupported?: boolean

  /**
   * A tighter transcription deadline, for tests.
   *
   * Only ever able to *lower* the deadline — `withTimeout` clamps it against
   * `VOICE_LIMITS.transcriptionTimeoutMs`, so passing a larger number here buys
   * nothing. That asymmetry is the point: an option that could raise a hard limit
   * would be an option somebody eventually raises.
   */
  transcriptionTimeoutMs?: number

  now?: () => Date
  newId?: () => string
}

/** What the injected conversation submitter reports back. */
export interface VoiceSubmitResult {
  ok: boolean
  turnId: string | null
  outcome: 'completed' | 'denied' | 'cancelled' | 'failed' | 'interrupted' | 'none'
  reason: string | null
}

/** The permission outcomes a platform can report. Closed, and never inferred. */
export type VoicePermissionOutcome = 'granted' | 'denied' | 'revoked'

/** Where an activation came from. Only the owner may arm the microphone. */
export type VoiceActivationSource = 'owner' | 'wake'

type VoiceEventPayload =
  | CoreEventPayloads['voice.capture.started']
  | CoreEventPayloads['voice.capture.completed']
  | CoreEventPayloads['voice.capture.cancelled']
  | CoreEventPayloads['voice.transcribe.started']
  | CoreEventPayloads['voice.transcribe.completed']
  | CoreEventPayloads['voice.transcribe.failed']
  | CoreEventPayloads['voice.submitted']
  | CoreEventPayloads['voice.speech.started']
  | CoreEventPayloads['voice.speech.stopped']
  | CoreEventPayloads['voice.speech.interrupted']
  | CoreEventPayloads['voice.permission.changed']
  | CoreEventPayloads['voice.wake.armed']
  | CoreEventPayloads['voice.wake.fired']
  | CoreEventPayloads['voice.wake.disarmed']
  | CoreEventPayloads['voice.stopped']

interface QueuedUtterance {
  utteranceId: string
  turnId: string
  text: string
  voiceId: string | null
  rate: number
  pitch: number
}

export class VoiceService {
  private readonly fabric: EventFabric
  private readonly stt: VoiceSttAdapter | undefined
  private readonly tts: VoiceTtsAdapter | undefined
  private readonly wakeGate: WakeGate
  private readonly submitTurn: VoiceServiceOptions['submitTurn']
  private readonly resolveTurnText: VoiceServiceOptions['resolveTurnText']
  private readonly stopAllLatch: () => boolean
  private readonly captureSupported: boolean
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly newId: () => string

  private state: VoiceState
  private session: VoiceCaptureSession | null = null
  private abort: AbortController | null = null

  /**
   * The microphone, as an owner decision.
   *
   * `false` from construction and forever after a restart: there is no durable
   * flag, no preference store entry and no hydration path that could set it. The
   * only assignment in this class is from `enableMic`, which only an owner command
   * reaches.
   */
  private micEnabled = false

  private permission: 'unknown' | VoicePermissionOutcome = 'unknown'
  private muted = false
  private autoSubmit = false
  private selectedVoiceId: string | null = null
  private wakeArmedAt: string | null = null

  private queue: QueuedUtterance[] = []
  private speaking: QueuedUtterance | null = null
  private speakAbort: AbortController | null = null
  private lastInterruption: string | null = null
  private lastFinal: string | null = null
  private lastFinalAt: string | null = null

  private faults: string[] = []
  private readonly changeListeners = new Set<(projection: VoiceProjection) => void>()
  private readonly transcriptListeners = new Set<(fragment: VoiceTranscriptFragment) => void>()

  constructor(options: VoiceServiceOptions) {
    this.fabric = options.fabric
    this.stt = options.stt
    this.tts = options.tts
    this.wakeGate = options.wake ?? LOCAL_ENERGY_WAKE_GATE
    this.submitTurn = options.submitTurn
    this.resolveTurnText = options.resolveTurnText
    this.stopAllLatch = options.stopAll ?? (() => false)
    this.captureSupported = options.captureSupported ?? true
    this.timeoutMs = Math.max(1, Math.min(options.transcriptionTimeoutMs ?? VOICE_LIMITS.transcriptionTimeoutMs, VOICE_LIMITS.transcriptionTimeoutMs))
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    // Derived, never assigned from outside: a build with no capture path starts
    // in `unsupported` and no command can talk it out of it.
    this.state = this.captureSupported ? 'permission-required' : 'unsupported'
  }

  /* --------------------------------------------------------------- reading */

  get currentState(): VoiceState {
    return this.state
  }

  get microphoneEnabled(): boolean {
    return this.micEnabled
  }

  get captureOpen(): boolean {
    return this.session !== null
  }

  get wakeArmed(): boolean {
    return this.wakeArmedAt !== null
  }

  onChange(listener: (projection: VoiceProjection) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  onTranscript(listener: (fragment: VoiceTranscriptFragment) => void): () => void {
    this.transcriptListeners.add(listener)
    return () => {
      this.transcriptListeners.delete(listener)
    }
  }

  /* ------------------------------------------------------- mic + permission */

  /**
   * Turn the microphone on.
   *
   * Explicit, always, and `source: 'owner'` is the only way that reaches it from
   * outside. A wake event asks separately and must clear the same bar, so there
   * is no path here that runs because a sound was detected in the room.
   */
  async enableMic(source: VoiceActivationSource = 'owner'): Promise<
    { ok: true; state: VoiceState } | { ok: false; reason: string }
  > {
    if (!this.captureSupported) {
      return { ok: false, reason: 'this platform offers no microphone capture' }
    }
    if (this.stopAllLatch()) {
      return { ok: false, reason: 'Freya is stopped; resume before using the microphone' }
    }
    if (source === 'wake') {
      // A wake hint cannot grant the thing it is a hint for. It may only ask, and
      // the answer is the same bar the owner clears.
      if (!this.micEnabled) return { ok: false, reason: MIC_OFF_REASON }
      if (this.permission !== 'granted') {
        return { ok: false, reason: 'microphone permission has not been granted' }
      }
    }
    this.micEnabled = true
    this.move(this.baseState())
    this.publish()
    return { ok: true, state: this.state }
  }

  /** Turn the microphone off. Idempotent, and safe at any point in the machine. */
  async disableMic(reason = 'the owner turned the microphone off'): Promise<void> {
    this.micEnabled = false
    this.wakeArmedAt = null
    await this.releaseSession(reason)
    this.move(this.baseState())
    this.publish()
  }

  /**
   * Record what the operating system said about the microphone.
   *
   * A *report*, not a request: this service cannot grant permission and has no
   * way to ask for it. What it does is refuse to open a capture unless the last
   * thing it was told was `granted`, which is the fail-closed half. A renderer
   * that lies here can only get itself a capture it has already been refused by
   * the operating system — and the host grants the device from its own gate, not
   * from this flag.
   */
  async reportPermission(outcome: VoicePermissionOutcome): Promise<VoiceState> {
    this.permission = outcome
    await this.record(
      'voice.permission.changed',
      {
        category: 'microphone',
        outcome,
        source: this.session === null ? 'idle' : 'capturing',
      },
      this.session?.sessionId ?? this.newId(),
    )
    if (outcome === 'revoked') {
      // A revocation while the microphone is open is the race that matters: the
      // device is going away whether or not this process noticed, so the session
      // is ended here rather than left to fail later with an empty buffer.
      await this.releaseSession('microphone permission was revoked')
      this.wakeArmedAt = null
    }
    this.move(this.baseState())
    this.publish()
    return this.state
  }

  /* ------------------------------------------------------------- capturing */

  /**
   * Begin a capture.
   *
   * Explicit, bounded, and one at a time: a second press while one is open is
   * refused rather than interleaving two microphones.
   */
  async beginCapture(): Promise<
    { ok: true; session: VoiceCaptureSession } | { ok: false; reason: string }
  > {
    if (!this.captureSupported) return { ok: false, reason: 'this platform offers no microphone capture' }
    if (this.stopAllLatch()) return { ok: false, reason: 'Freya is stopped; resume before using the microphone' }
    if (!this.micEnabled) return { ok: false, reason: MIC_OFF_REASON }
    if (this.permission !== 'granted') {
      return {
        ok: false,
        reason:
          this.permission === 'denied'
            ? 'microphone permission was denied'
            : this.permission === 'revoked'
              ? 'microphone permission was revoked'
              : 'microphone permission has not been requested yet',
      }
    }
    if (this.session !== null) return { ok: false, reason: 'a recording is already in progress' }

    const session: VoiceCaptureSession = {
      sessionId: this.newId(),
      startedAt: this.now().toISOString(),
      format: VOICE_FORMAT,
      sampleRate: VOICE_LIMITS.sampleRate,
      channels: VOICE_LIMITS.channels,
      interim: '',
    }
    this.session = session
    this.abort = new AbortController()
    this.move('listening')
    this.publish()
    await this.record(
      'voice.capture.started',
      {
        sessionId: session.sessionId,
        format: session.format,
        sampleRate: session.sampleRate,
        channels: session.channels,
        activation: 'explicit',
      },
      session.sessionId,
    )
    return { ok: true, session }
  }

  /**
   * Record an interim fragment.
   *
   * Display only, and that is enforced structurally: the value is clipped, held
   * on the session for the projection, pushed to subscribers, and then dropped.
   * It is not journalled, it is not passed to the submitter, and there is no
   * return value a caller could treat as a transcript. An engine revising its
   * guess cannot authorise anything, because the only exit from this function is
   * a screen.
   */
  pushInterim(sessionId: string, text: unknown): { ok: boolean; reason?: string } {
    const session = this.session
    if (session === null || session.sessionId !== sessionId) {
      return { ok: false, reason: 'no recording is in progress' }
    }
    if (typeof text !== 'string') return { ok: false, reason: 'the interim fragment is not text' }
    const clipped = clipText(text.replace(/\s+/g, ' ').trim(), VOICE_LIMITS.maxInterimCharacters)
    if (clipped.length === 0) return { ok: true }
    session.interim = clipped
    this.pushTranscript({ sessionId, kind: 'interim', text: clipped, at: this.now().toISOString() })
    this.publish()
    return { ok: true }
  }

  /**
   * Finish a capture: validate, transcribe, and either hand the transcript over
   * or enter the canonical conversation path.
   *
   * The order is the design. Validation happens before an engine is named; the
   * adapter is chosen before `withTimeout` arms; the final transcript is bounded
   * before anything can read it; and submission is the *last* thing that happens,
   * after the transcript exists as a string and after the adapter's bytes are
   * unreferenced.
   */
  async endCapture(input: unknown): Promise<VoiceEndResult> {
    const session = this.session
    const sessionId = readId(input, 'sessionId') ?? session?.sessionId ?? ''
    if (session === null) {
      // No open session. Two different situations collapse into this branch and
      // they must not collapse into the same answer: a stop that already took the
      // microphone away, and a stale end for a session that closed normally.
      // Reporting the first as "cancelled" would hide the only state that matters
      // when somebody is trying to work out why their words did not arrive.
      if (this.stopAllLatch()) {
        return this.empty(
          sessionId,
          'stopped-by-STOP-ALL',
          'Freya was stopped, so that recording was discarded.',
        )
      }
      return this.empty(sessionId, 'cancelled', 'No recording was in progress.')
    }
    if (sessionId !== session.sessionId) {
      // A stale end for a session that has already closed. Refused rather than
      // applied, because applying it would transcribe audio into a dead session
      // and report a transcript the owner did not ask for.
      return this.empty(sessionId, 'cancelled', 'That recording had already finished.')
    }

    const cancelled = readFlag(input, 'cancelled') === true
    // The session is released before anything can fail, so no path below leaves an
    // open capture — but the *abort controller* is deliberately kept, and cleared
    // in the `finally` around the transcription. That is what lets a cancel
    // arriving mid-transcription reach an engine that is still reading the audio:
    // without it, a slow recogniser would hold the flow for its full timeout with
    // no way out, which is the one thing "cancel" has to mean.
    this.session = null
    const controller = this.abort ?? new AbortController()

    if (cancelled) {
      controller.abort(new Error('the owner released the microphone'))
      this.abort = null
      await this.record(
        'voice.capture.cancelled',
        { sessionId: session.sessionId, byteLength: 0, durationMs: 0, reason: 'the owner released the microphone' },
        session.sessionId,
      )
      this.move(this.baseState())
      this.publish()
      return this.empty(session.sessionId, 'cancelled', 'Recording discarded.')
    }

    if (this.stopAllLatch()) {
      controller.abort(new Error('STOP ALL'))
      this.abort = null
      await this.record(
        'voice.capture.cancelled',
        { sessionId: session.sessionId, byteLength: 0, durationMs: 0, reason: 'STOP ALL landed while this recording was open' },
        session.sessionId,
      )
      this.move('stopped-by-STOP-ALL')
      this.publish()
      return this.empty(session.sessionId, 'stopped-by-STOP-ALL', 'Freya was stopped, so the recording was discarded.')
    }

    const validation = validateAudio(input)
    if (!validation.ok) {
      this.abort = null
      this.note(validation.detail)
      await this.record(
        'voice.capture.cancelled',
        { sessionId: session.sessionId, byteLength: 0, durationMs: 0, reason: validation.detail },
        session.sessionId,
      )
      this.move(validation.reason === 'too-large' || validation.reason === 'too-long' ? 'failed' : 'degraded')
      this.publish()
      return {
        sessionId: session.sessionId,
        reason: validation.reason,
        text: null,
        detail: validation.detail,
        byteLength: 0,
        durationMs: 0,
        transcribed: false,
        turnId: null,
      }
    }

    const { audio, frames } = validation
    if (this.stt === undefined) {
      // The expected state on most machines. Said plainly, and the audio is
      // dropped: a transcript is better than silence, and inventing one is not.
      this.abort = null
      await this.record(
        'voice.capture.completed',
        {
          sessionId: session.sessionId,
          byteLength: audio.bytes.byteLength,
          durationMs: audio.durationMs,
          frames,
          transcribed: false,
          transcriptLength: 0,
          interimFragments: 0,
        },
        session.sessionId,
      )
      this.note('no speech-to-text engine is configured, so the recording was discarded')
      this.move('degraded')
      this.publish()
      return this.empty(
        session.sessionId,
        'no-engine',
        'No speech-to-text engine is configured, so the recording was discarded.',
      )
    }

    this.move('transcribing')
    this.publish()
    await this.record(
      'voice.transcribe.started',
      { sessionId: session.sessionId, engine: this.stt.id, kind: this.stt.kind, frames },
      session.sessionId,
    )

    const request: SttRequest = {
      sessionId: session.sessionId,
      audio,
      signal: controller.signal,
      timeoutMs: this.timeoutMs,
    }

    let interimFragments = 0
    const onFragment = (fragment: { kind: VoiceTranscriptKind; text: string }): void => {
      if (fragment.kind !== 'interim') return
      interimFragments += 1
      this.pushInterim(session.sessionId, fragment.text)
    }

    let text: string
    try {
      const adapter = this.stt
      const run = async (signal: AbortSignal): Promise<SttResult> => {
        const call: SttRequest = { ...request, signal }
        // The branch is explicit rather than an optional call with a fallback, so
        // "this adapter streams" and "this adapter does not" are two readable
        // lines rather than one expression with a hidden second call in it.
        if (adapter.streaming && typeof adapter.stream === 'function') {
          return adapter.stream(call, onFragment)
        }
        return adapter.transcribe(call)
      }
      text = (await withTimeout(request.signal, request.timeoutMs, run)).text.trim()
    } catch (error) {
      // An abort is a cancel, not a failure, and the distinction is the one a
      // person cares about: they pressed stop, or STOP ALL did, and nothing went
      // wrong with their microphone.
      if (request.signal.aborted) {
        this.abort = null
        await this.record(
          'voice.transcribe.failed',
          { sessionId: session.sessionId, engine: this.stt.id, reason: 'engine-failed' },
          session.sessionId,
        )
        await this.record(
          'voice.capture.cancelled',
          { sessionId: session.sessionId, byteLength: audio.bytes.byteLength, durationMs: audio.durationMs, reason: 'the transcription was cancelled' },
          session.sessionId,
        )
        this.move(this.stopAllLatch() ? 'stopped-by-STOP-ALL' : this.baseState())
        this.publish()
        return this.empty(
          session.sessionId,
          this.stopAllLatch() ? 'stopped-by-STOP-ALL' : 'cancelled',
          this.stopAllLatch()
            ? 'Freya was stopped, so the recording was discarded.'
            : 'The transcription was cancelled.',
        )
      }
      this.abort = null
      const timedOut = error instanceof SttTimeout
      const unavailable = isSttUnavailable(error)
      const detail = timedOut
        ? 'The speech engine did not finish in time, so the recording was discarded.'
        : unavailable
          ? error.message
          : `The speech engine could not read that recording (${describe(error)}).`
      await this.record(
        'voice.transcribe.failed',
        {
          sessionId: session.sessionId,
          engine: this.stt.id,
          reason: timedOut ? 'timeout' : unavailable ? 'unconfigured' : 'engine-failed',
        },
        session.sessionId,
      )
      await this.record(
        'voice.capture.completed',
        {
          sessionId: session.sessionId,
          byteLength: audio.bytes.byteLength,
          durationMs: audio.durationMs,
          frames,
          transcribed: false,
          transcriptLength: 0,
          interimFragments,
        },
        session.sessionId,
      )
      this.note(detail)
      this.move(unavailable ? 'degraded' : 'failed')
      this.publish()
      return this.empty(
        session.sessionId,
        timedOut ? 'timeout' : unavailable ? 'no-engine' : 'device-lost',
        detail,
      )
    }

    const bounded = clipText(text, VOICE_LIMITS.maxTranscriptCharacters)
    const finalAt = this.now().toISOString()
    this.abort = null
    this.lastFinal = bounded
    this.lastFinalAt = finalAt
    this.pushTranscript({ sessionId: session.sessionId, kind: 'final', text: bounded, at: finalAt })

    await this.record(
      'voice.transcribe.completed',
      {
        sessionId: session.sessionId,
        engine: this.stt.id,
        transcriptLength: bounded.length,
        interimFragments,
      },
      session.sessionId,
    )
    await this.record(
      'voice.capture.completed',
      {
        sessionId: session.sessionId,
        byteLength: audio.bytes.byteLength,
        durationMs: audio.durationMs,
        frames,
        transcribed: true,
        transcriptLength: bounded.length,
        interimFragments,
      },
      session.sessionId,
    )

    if (bounded.length === 0) {
      this.move(this.baseState())
      this.publish()
      return {
        sessionId: session.sessionId,
        reason: 'completed',
        text: '',
        detail: 'Nothing was said.',
        byteLength: audio.bytes.byteLength,
        durationMs: audio.durationMs,
        transcribed: true,
        turnId: null,
      }
    }

    // Auto-submit is the owner's earlier decision, not this method's. Off means
    // the transcript is text for a composer, and a microphone press has not
    // become a purchase.
    if (!this.autoSubmit) {
      this.move(this.baseState())
      this.publish()
      return {
        sessionId: session.sessionId,
        reason: 'completed',
        text: bounded,
        detail: 'Transcribed. Review it, then send.',
        byteLength: audio.bytes.byteLength,
        durationMs: audio.durationMs,
        transcribed: true,
        turnId: null,
      }
    }

    const submitted = await this.submitConfirmed(session.sessionId, bounded, audio.bytes.byteLength, audio.durationMs)
    return submitted
  }

  /**
   * Enter the canonical conversation path with a confirmed transcript.
   *
   * The transcript is a plain string and this is the ordinary submitter. That is
   * the entire trick: there is no `voiceTurn`, no second model call, no bypass
   * of the Guard — a spoken sentence and a typed one reach the same function and
   * are indistinguishable from there down.
   */
  private async submitConfirmed(
    sessionId: string,
    text: string,
    byteLength: number,
    durationMs: number,
  ): Promise<VoiceEndResult> {
    if (this.stopAllLatch()) {
      // The race the brief names: a final transcript landing after STOP ALL. It is
      // dropped here rather than submitted and refused downstream, because a turn
      // that exists and is denied still costs a store write and shows up in the
      // transcript as something the owner said when they did not get to.
      this.note('a finished transcript arrived after STOP ALL and was discarded')
      this.move('stopped-by-STOP-ALL')
      this.publish()
      return this.empty(sessionId, 'stopped-by-STOP-ALL', 'Freya was stopped, so that transcript was discarded.')
    }
    if (this.submitTurn === undefined) {
      this.move(this.baseState())
      this.publish()
      return {
        sessionId,
        reason: 'completed',
        text,
        detail: 'Transcribed. This window cannot reach the conversation, so it was not sent.',
        byteLength,
        durationMs,
        transcribed: true,
        turnId: null,
      }
    }

    this.move('submitting')
    this.publish()

    let result: VoiceSubmitResult
    try {
      result = await this.submitTurn({ text })
    } catch (error) {
      result = { ok: false, turnId: null, outcome: 'failed', reason: describe(error) }
    }

    await this.record(
      'voice.submitted',
      {
        sessionId,
        turnId: result.turnId ?? '',
        outcome: result.outcome,
        transcriptLength: text.length,
      },
      sessionId,
    )

    if (!result.ok || result.turnId === null) {
      this.note(result.reason ?? 'the conversation path refused the transcript')
      this.move('failed')
      this.publish()
      return {
        sessionId,
        reason: 'completed',
        text,
        detail: result.reason ?? 'The conversation path refused that transcript.',
        byteLength,
        durationMs,
        transcribed: true,
        turnId: null,
      }
    }

    this.move(this.baseState())
    this.publish()
    return {
      sessionId,
      reason: 'completed',
      text,
      detail: 'Sent.',
      byteLength,
      durationMs,
      transcribed: true,
      turnId: result.turnId,
    }
  }

  /** Release the device without transcribing. Used on unmount, teardown and cancel. */
  async cancelCapture(reason = 'the owner cancelled the recording'): Promise<void> {
    await this.releaseSession(reason)
    this.move(this.baseState())
    this.publish()
  }

  /* ------------------------------------------------------------------ TTS */

  /**
   * Speak a stored turn.
   *
   * The payload is a `turnId` and nothing else. Core resolves the words from its
   * own conversation store, so a renderer cannot make Freya say a sentence that is
   * not already in the transcript — which is the difference between reading an
   * answer and synthesising one.
   */
  async speakTurn(input: unknown): Promise<SpeakOutcome> {
    if (this.stopAllLatch()) return { ok: false, reason: 'Freya is stopped; resume before Freya speaks' }
    if (this.muted) return { ok: false, reason: 'Freya is muted' }
    if (this.tts === undefined || this.tts.availability !== 'available') {
      return { ok: false, reason: this.tts?.detail ?? 'no speech output engine is configured' }
    }
    const turnId = readId(input, 'turnId')
    if (turnId === null || turnId.length === 0) return { ok: false, reason: 'a turn id is required' }
    if (this.resolveTurnText === undefined) {
      return { ok: false, reason: 'this Core cannot read stored answers' }
    }

    const resolved = await this.resolveTurnText(turnId)
    if (!resolved.ok || resolved.text === null || resolved.text.trim().length === 0) {
      return { ok: false, reason: resolved.reason ?? 'that turn has no stored answer to read' }
    }

    if (this.queue.length >= VOICE_LIMITS.maxSpeechQueue) {
      return { ok: false, reason: 'the speech queue is full; cancel it before queueing more' }
    }

    const tuning = clampSpeakingTuning(readNumber(input, 'rate'), readNumber(input, 'pitch'))
    const utterance: QueuedUtterance = {
      utteranceId: this.newId(),
      turnId,
      text: boundUtterance(resolved.text),
      voiceId: this.selectedVoiceId,
      rate: tuning.rate,
      pitch: tuning.pitch,
    }
    this.queue.push(utterance)

    await this.record(
      'voice.speech.started',
      {
        utteranceId: utterance.utteranceId,
        turnId,
        characters: utterance.text.length,
        voice: this.selectedVoiceId === null ? 'default' : 'selected',
        queued: this.queue.length,
      },
      turnId,
    )

    this.move('speaking')
    this.publish()
    void this.drain()
    return { ok: true, utteranceId: utterance.utteranceId, queued: this.queue.length, engine: this.tts.id }
  }

  /** End the current utterance cleanly and drop the rest. */
  async stopSpeaking(): Promise<void> {
    if (this.speaking === null && this.queue.length === 0) return
    const current = this.speaking
    this.queue = []
    await this.tts?.stop()
    if (current !== null) {
      await this.record(
        'voice.speech.stopped',
        { utteranceId: current.utteranceId, turnId: current.turnId, completed: false },
        current.turnId,
      )
    }
    this.speaking = null
    this.move(this.baseState())
    this.publish()
  }

  /**
   * Cut playback off mid-word.
   *
   * The barge-in path and the STOP ALL path both come through here, so there is
   * one place where "Freya was talking and now is not" becomes true — and one
   * place that records why.
   */
  async cancelSpeaking(reason: string): Promise<void> {
    const current = this.speaking
    this.queue = []
    this.speakAbort?.abort(new Error(reason))
    await this.tts?.cancel()
    if (current !== null) {
      this.lastInterruption = reason
      await this.record(
        'voice.speech.interrupted',
        { utteranceId: current.utteranceId, turnId: current.turnId, reason },
        current.turnId,
      )
    }
    this.speaking = null
    this.move(this.stopAllLatch() ? 'stopped-by-STOP-ALL' : 'interrupted')
    this.publish()
  }

  /** The renderer reports that playback actually finished (or failed). */
  async settleSpeech(utteranceId: unknown, outcome: 'completed' | 'failed'): Promise<void> {
    const current = this.speaking
    if (current === null || current.utteranceId !== utteranceId) return
    await this.record(
      outcome === 'completed' ? 'voice.speech.stopped' : 'voice.speech.interrupted',
      outcome === 'completed'
        ? { utteranceId: current.utteranceId, turnId: current.turnId, completed: true }
        : { utteranceId: current.utteranceId, turnId: current.turnId, reason: 'the output adapter reported a failure' },
      current.turnId,
    )
    this.speaking = null
    this.move(outcome === 'completed' ? this.baseState() : 'failed')
    this.publish()
  }

  /** Whether the output adapter currently has the floor. */
  get isSpeaking(): boolean {
    return this.speaking !== null
  }

  async listVoices(): Promise<VoiceOption[]> {
    if (this.tts === undefined || this.tts.availability !== 'available') return []
    try {
      return await this.tts.voices()
    } catch {
      return []
    }
  }

  async selectVoice(voiceId: unknown): Promise<{ ok: boolean; reason?: string }> {
    if (typeof voiceId !== 'string' || voiceId.length === 0 || voiceId.length > 200) {
      return { ok: false, reason: 'a voice id is required and must be short' }
    }
    const known = await this.listVoices()
    // Selection is checked against what the adapter actually reports, so a window
    // cannot make Freya's voice a string it invented.
    if (known.length > 0 && !known.some((option) => option.voiceId === voiceId)) {
      return { ok: false, reason: 'that voice is not one this platform offers' }
    }
    this.selectedVoiceId = voiceId
    this.publish()
    return { ok: true }
  }

  async setMuted(muted: boolean): Promise<VoiceState> {
    this.muted = muted
    if (muted) await this.cancelSpeaking('Freya was muted')
    else this.move(this.baseState())
    this.publish()
    return this.state
  }

  async setAutoSubmit(enabled: boolean): Promise<VoiceState> {
    this.autoSubmit = enabled
    this.move(this.baseState())
    this.publish()
    return this.state
  }

  /* ----------------------------------------------------------------- wake */

  /**
   * Arm the wake gate.
   *
   * Off by default and never armed by anything but an owner command. It also
   * cannot be armed where there is no gate, which is the state of every build in
   * this repository until a local detector is configured — reported as
   * `unavailable` rather than pretended.
   */
  async armWake(): Promise<{ ok: boolean; reason?: string }> {
    if (this.wakeGate.availability !== 'available') {
      return { ok: false, reason: this.wakeGate.detail }
    }
    if (this.stopAllLatch()) return { ok: false, reason: 'Freya is stopped; resume before arming hands-free' }
    if (!this.micEnabled) return { ok: false, reason: MIC_OFF_REASON }
    if (this.permission !== 'granted') return { ok: false, reason: 'microphone permission has not been granted' }
    this.wakeArmedAt = this.now().toISOString()
    await this.record(
      'voice.wake.armed',
      {
        gate: this.wakeGate.id,
        threshold: this.wakeGate.threshold,
        maxArmedMs: this.wakeGate.maxArmedMs,
      },
      this.wakeGate.id,
    )
    this.move(this.baseState())
    this.publish()
    return { ok: true }
  }

  async disarmWake(reason = 'hands-free was turned off'): Promise<void> {
    if (this.wakeArmedAt === null) return
    this.wakeArmedAt = null
    await this.record('voice.wake.disarmed', { gate: this.wakeGate.id, reason }, this.wakeGate.id)
    this.move(this.baseState())
    this.publish()
  }

  /**
   * A local energy reading, from the platform.
   *
   * The gate only ever *asks* for a capture. It creates no turn, no grant and no
   * permission, and everything the capture path requires still applies. That is
   * why this returns the same shape `beginCapture` does rather than a boolean.
   */
  async reportWakeEnergy(level: unknown, sustainedMs: number): Promise<
    { fired: boolean; reason?: string }
  > {
    if (this.wakeArmedAt === null) return { fired: false, reason: 'hands-free is not armed' }
    if (!Number.isFinite(sustainedMs) || sustainedMs < this.wakeGate.sustainMs) return { fired: false }
    if (!crossesWakeThreshold(typeof level === 'number' ? level : 0, this.wakeGate)) return { fired: false }
    await this.record(
      'voice.wake.fired',
      { gate: this.wakeGate.id, sustainedMs: Math.round(sustainedMs) },
      this.wakeGate.id,
    )
    const started = await this.beginCapture()
    if (!started.ok) return { fired: false, reason: started.reason }
    this.publish()
    return { fired: true }
  }

  /** Whether the gate has been armed past its own ceiling. Read on every publish. */
  wakeExpired(at: Date): boolean {
    if (this.wakeArmedAt === null) return false
    const armed = Date.parse(this.wakeArmedAt)
    if (!Number.isFinite(armed)) return false
    return at.getTime() - armed >= this.wakeGate.maxArmedMs
  }

  /* ------------------------------------------------------------ STOP ALL */

  /**
   * Everything STOP ALL has to do to voice, in one place.
   *
   * Called from the same synchronous turn that closes the gateway. Capture is
   * dropped, the transcription is aborted, the queue is emptied and playback is
   * cut — before this file's first await — so a stop cannot be overtaken by an
   * audio callback that was already in flight.
   *
   * Note what it does **not** do: it does not clear `micEnabled`. Resuming does
   * not reopen the microphone either; that stays an explicit owner action, and the
   * state stays `stopped-by-STOP-ALL` until the latch is lifted.
   */
  async onStopAll(reason: string): Promise<void> {
    const session = this.session
    const current = this.speaking
    const queuedCount = this.queue.length
    // Idempotent, and that is a correctness property rather than tidiness.
    //
    // `Core` calls this twice around `security.stopAll`: once synchronously, before
    // the durable latch is written, and once after it lands. The first call closes
    // whatever was open at that instant; a capture whose command was already in
    // flight can still open in the window between the two, and the second call is
    // what takes it. Without the early return the second call would append a second
    // `voice.stopped` line for one stop — and a journal with two lines per event is
    // a journal nobody can reason about.
    if (session === null && current === null && queuedCount === 0 && this.state === 'stopped-by-STOP-ALL') {
      return
    }
    this.session = null
    this.abort?.abort(new Error(reason))
    this.abort = null
    this.queue = []
    this.speakAbort?.abort(new Error(reason))
    const queued = current
    // Moved before the first `await`, deliberately. A window that re-reads the
    // projection in the microtask between the stop command being dispatched and
    // this method's first journal write must see `stopped-by-STOP-ALL`, not the
    // state it was in a moment ago. Everything here that matters is synchronous
    // for that reason.
    this.move('stopped-by-STOP-ALL')
    this.publish()

    // The capture is recorded as cancelled with zero bytes: the device is gone,
    // and there is nothing left to describe.
    if (session !== null) {
      await this.record(
        'voice.capture.cancelled',
        { sessionId: session.sessionId, byteLength: 0, durationMs: 0, reason: `STOP ALL: ${reason}` },
        session.sessionId,
      )
    }
    if (queued !== null) {
      await this.record(
        'voice.speech.interrupted',
        { utteranceId: queued.utteranceId, turnId: queued.turnId, reason: `STOP ALL: ${reason}` },
        queued.turnId,
      )
    }
    this.speaking = null
    this.wakeArmedAt = null
    void this.tts?.cancel()
    await this.record('voice.stopped', { scope: 'all', reason }, this.newId())
    this.move('stopped-by-STOP-ALL')
    this.publish()
  }

  /** Called when the latch clears. Deliberately re-opens nothing. */
  onResume(): void {
    if (this.stopAllLatch()) return
    if (this.micEnabled && this.permission === 'granted') {
      this.move('ready')
    } else {
      this.move(this.baseState())
    }
    this.publish()
  }

  /* ---------------------------------------------------------- projection */

  projection(): VoiceProjection {
    return {
      state: this.state,
      micEnabled: this.micEnabled,
      permission: this.permission,
      capturing: this.session !== null,
      sessionId: this.session?.sessionId ?? null,
      interim: this.session?.interim ?? '',
      /**
       * The last confirmed transcript, and where it stopped.
       *
       * A composer needs somewhere to put the words a person said, and this is
       * that place. It is deliberately the *final* text only — an interim guess is
       * on `interim` and nowhere else, so a window cannot accidentally submit
       * half a sentence by reading the wrong field.
       */
      finalTranscript: this.lastFinal,
      finalTranscriptAt: this.lastFinalAt,
      lastInterruption: this.lastInterruption,
      transcription: {
        available: this.stt !== undefined && this.stt.availability === 'available',
        engine: this.stt?.id ?? null,
        kind: (this.stt?.kind ?? 'local') as VoiceAdapterKind,
        availability: this.stt?.availability ?? 'configuration-required',
        detail: this.stt?.detail ?? NO_ENGINE_DETAIL,
      },
      synthesis: {
        available: this.tts !== undefined && this.tts.availability === 'available',
        engine: this.tts?.id ?? null,
        kind: (this.tts?.kind ?? 'platform') as VoiceAdapterKind,
        availability: this.tts?.availability ?? 'unavailable',
        detail: this.tts?.detail ?? NO_OUTPUT_DETAIL,
      },
      speaking: this.speaking !== null,
      queued: this.queue.length,
      muted: this.muted,
      selectedVoiceId: this.selectedVoiceId,
      autoSubmit: this.autoSubmit,
      wake: {
        armed: this.wakeArmedAt !== null,
        available: this.wakeGate.availability === 'available',
        gate: this.wakeGate.id,
        kind: 'speech-activity' as const,
        detail: this.wakeGate.detail,
        maxArmedMs: this.wakeGate.maxArmedMs,
      },
      limits: {
        maxDurationMs: VOICE_LIMITS.maxDurationMs,
        maxAudioBytes: VOICE_LIMITS.maxAudioBytes,
        format: VOICE_FORMAT,
        maxTranscriptCharacters: VOICE_LIMITS.maxTranscriptCharacters,
        transcriptionTimeoutMs: VOICE_LIMITS.transcriptionTimeoutMs,
      },
      faults: [...new Set(this.faults)].slice(-8),
    }
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Where the machine should sit when nothing is happening.
   *
   * Derived from facts rather than set by hand, which is what keeps the
   * indicators honest: `listening` cannot survive a session ending because the
   * state is recomputed from `micEnabled` and `permission`.
   */
  private baseState(): VoiceState {
    if (!this.captureSupported) return 'unsupported'
    if (this.stopAllLatch()) return 'stopped-by-STOP-ALL'
    if (this.permission === 'denied') return 'permission-denied'
    if (this.permission !== 'granted') return 'permission-required'
    if (!this.micEnabled) return 'permission-required'
    return 'ready'
  }

  private move(next: VoiceState): void {
    if (this.state === next) return
    this.state = next
  }

  private publish(): void {
    const projection = this.projection()
    for (const listener of [...this.changeListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.voice] projection subscriber threw', error)
        this.changeListeners.delete(listener)
      }
    }
  }

  private pushTranscript(fragment: VoiceTranscriptFragment): void {
    for (const listener of [...this.transcriptListeners]) {
      try {
        listener(fragment)
      } catch (error) {
        console.error('[freya.voice] transcript subscriber threw', error)
        this.transcriptListeners.delete(listener)
      }
    }
  }

  private note(detail: string): void {
    this.faults = [...this.faults, detail].slice(-16)
  }

  /**
   * Release the device without transcribing, and stop anything still reading it.
   *
   * The abort happens **before** the session check, and that ordering is the point.
   * By the time a cancel arrives, `endCapture` has usually already taken the
   * session away and be inside an engine — so a method that returned early when
   * `session === null` would leave a slow recogniser running to its full timeout
   * with nothing able to interrupt it. Aborting unconditionally is what makes
   * "cancel" mean the same thing at every point in the capture's life.
   *
   * The single `why` is both the abort reason and the journalled explanation: one
   * source for the string means a caller cannot leave the log disagreeing with what
   * actually happened.
   */
  private async releaseSession(why: string): Promise<void> {
    this.abort?.abort(new Error(why))
    this.abort = null
    const session = this.session
    if (session === null) return
    this.session = null
    await this.record(
      'voice.capture.cancelled',
      { sessionId: session.sessionId, byteLength: 0, durationMs: 0, reason: why },
      session.sessionId,
    )
  }

  /** Play the queue in order, one utterance at a time. */
  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift()
      if (next === undefined) return
      if (this.muted || this.stopAllLatch()) {
        await this.record(
          'voice.speech.interrupted',
          { utteranceId: next.utteranceId, turnId: next.turnId, reason: this.muted ? 'Freya was muted' : 'STOP ALL' },
          next.turnId,
        )
        return
      }
      this.speaking = next
      this.speakAbort = new AbortController()
      this.move('speaking')
      this.publish()
      try {
        await this.tts?.speak({
          utteranceId: next.utteranceId,
          text: next.text,
          voiceId: next.voiceId,
          rate: next.rate,
          pitch: next.pitch,
          signal: this.speakAbort.signal,
        })
        if (this.speaking?.utteranceId === next.utteranceId) this.speaking = null
      } catch (error) {
        if (this.speaking?.utteranceId === next.utteranceId) this.speaking = null
        if (!isTtsUnavailable(error)) {
          this.note(`speech output failed: ${describe(error)}`)
          await this.record(
            'voice.speech.interrupted',
            { utteranceId: next.utteranceId, turnId: next.turnId, reason: 'the output adapter failed' },
            next.turnId,
          )
        }
      }
      this.move(this.baseState())
      this.publish()
    }
    this.move(this.baseState())
    this.publish()
  }

  private empty(sessionId: string, reason: VoiceEndReason, detail: string): VoiceEndResult {
    return { sessionId, reason, text: null, detail, byteLength: 0, durationMs: 0, transcribed: false, turnId: null }
  }

  /**
   * Append voice metadata.
   *
   * Never audio, and never the transcript — including an interim fragment, which
   * is not even given to this method. The payload shapes are named rather than
   * passed as a bag, so a field cannot be added to a voice event without this
   * signature changing, which is the point: the moment a voice event can carry
   * anything arbitrary is the moment the journal becomes a place recordings leak.
   */
  private async record(
    type:
      | 'voice.capture.started'
      | 'voice.capture.completed'
      | 'voice.capture.cancelled'
      | 'voice.transcribe.started'
      | 'voice.transcribe.completed'
      | 'voice.transcribe.failed'
      | 'voice.submitted'
      | 'voice.speech.started'
      | 'voice.speech.stopped'
      | 'voice.speech.interrupted'
      | 'voice.permission.changed'
      | 'voice.wake.armed'
      | 'voice.wake.fired'
      | 'voice.wake.disarmed'
      | 'voice.stopped',
    payload: VoiceEventPayload,
    correlationId: string,
  ): Promise<void> {
    await this.fabric.append(type, payload, { actor: 'owner', correlationId })
  }
}

const NO_ENGINE_DETAIL =
  'No speech-to-text engine is configured. Capture works, and recordings are discarded rather than sent anywhere.'

const NO_OUTPUT_DETAIL =
  'No speech output engine is configured, so Freya does not read replies aloud.'

/**
 * One sentence for "the microphone is off".
 *
 * Shared because three refusals say it — a capture, a wake arm and a wake-sourced
 * activation — and three different phrasings of the same fact is three chances for
 * a surface to match on one of them and miss the others.
 */
const MIC_OFF_REASON = 'the microphone is off; turn it on first'

function readFlag(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined
  return (input as Record<string, unknown>)[key]
}

/** A bounded id string, or null. Never trimmed of meaning — just of length. */
function readId(input: unknown, key: 'sessionId' | 'turnId'): string | null {
  const value = readFlag(input, key)
  if (typeof value !== 'string' || value.length === 0) return null
  return value.slice(0, 200)
}

function readNumber(input: unknown, key: string): number | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

export type { AudioValidation }