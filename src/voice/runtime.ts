import { VOICE_LIMITS, type VoiceOption } from '../../core/voice/types'
import { hostBridge } from '../platform/host'
import { voiceMirror, type VoiceMirror } from '../platform/voiceClient'
import { openMicrophone, requestMicrophonePermission, MicrophoneError, resampleFloat32ToInt16, type MicCapture } from '../ui/surfaces/microphone'
import { clearMicLevel, publishMicLevel } from '../presence/micLevel'
import { voiceEnvelope } from '../presence/voiceEnvelope'
import { WindowSpeechOutput } from './output'
import { detectRecognitionSupport, type RecognitionSupport } from './recognition'

/**
 * The voice runtime.
 *
 * One object that owns the *device* side of voice in the window, and asks Core
 * before every privileged step. It is the only place in the renderer that calls
 * `getUserMedia` and the only place that plays audio.
 *
 * ## The order, which is the security property
 *
 * ```
 * press → micEnable? → reportPermission? → Core: capture.start → getUserMedia
 * ```
 *
 * Core agrees before the device opens, and the host's permission gate reads Core's
 * own projection. So there is no path — from a bug, a race, or a compromised
 * window — in which a microphone is open without the trusted half having said yes
 * to this specific capture.
 *
 * ## Barge-in, honestly
 *
 * A barge-in needs to notice somebody starting to speak while Freya is talking.
 * Doing that *properly* means a microphone open during playback, which is exactly
 * the always-on capture this whole design refuses. So there are two real routes
 * and both are stated rather than implied:
 *
 * 1. **Press to talk while she is speaking.** Explicit, always available, and the
 *    usual way anybody interrupts an assistant. Playback is cancelled first, then
 *    capture begins.
 * 2. **Hands-free, when the owner has armed it.** Then the microphone is already
 *    open by their own decision and a sustained-energy reading is a real barge-in.
 *
 * Neither is simulated. On a build with no wake gate configured, route 2 does not
 * exist and the runtime says so rather than pretending to listen.
 */

/** How often the wake gate re-measures, in milliseconds. */
const WAKE_POLL_MS = 120

/** Energy must stay above the threshold for this long before the gate fires. */
const WAKE_SUSTAIN_MS = 480

/** Sustained speech energy above this level counts as somebody talking. */
const WAKE_THRESHOLD = 0.14
/** Enough local history to retain the beginning of the word "Freya". */
const WAKE_PRE_ROLL_MS = 1_200
/** A hands-free utterance is deliberately much shorter than push-to-talk. */
const WAKE_CLIP_MAX_MS = 8_000
/** Silence after speech that closes one hands-free utterance. */
const WAKE_END_SILENCE_MS = 900
const WAKE_MIN_CLIP_MS = 500

export interface VoiceRuntimeEvents {
  /** A confirmed transcript is ready. `turnId` is set when it became a turn. */
  onTranscript?: (text: string, turnId: string | null) => void
  /** Something worth saying happened. Never a stack, never audio. */
  onNotice?: (message: string) => void
}

export class VoiceRuntime {
  private readonly mirror: VoiceMirror
  private readonly events: VoiceRuntimeEvents
  private capture: MicCapture | null = null
  private sessionId: string | null = null
  private output: WindowSpeechOutput | null = null
  private wakeLevel = 0
  private wakeSustainedMs = 0
  private wakeTimer: ReturnType<typeof setInterval> | null = null
  private wakeMeter: WakeMeter | null = null
  private wakeSessionId: string | null = null
  private wakeClipStartedAt: number | null = null
  private wakeSilenceMs = 0
  private lastUtterance: string | null = null
  private disposed = false

  constructor(mirror: VoiceMirror, events: VoiceRuntimeEvents = {}) {
    this.mirror = mirror
    this.events = events
  }

  /**
   * What this build can actually do, detected rather than assumed.
   *
   * Reported to the owner before they press anything, which is the difference
   * between a microphone button and a lie.
   */
  capabilities(): { capture: boolean; recognition: RecognitionSupport } {
    const capture =
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function'
    return { capture, recognition: detectRecognitionSupport() }
  }

  /* ---------------------------------------------------------- push to talk */

  /**
   * Begin a capture from an explicit press.
   *
   * Every refusal is reported as a sentence and none of them is silent: no
   * Core, microphone off, permission not held, permission denied, already
   * recording, or a platform with no device. A person pressing a button deserves
   * to know which of those happened.
   */
  async press(): Promise<void> {
    if (this.capture !== null) return
    const capabilities = this.capabilities()
    if (!capabilities.capture) {
      this.notice('This build has no microphone API, so Freya cannot listen.')
      return
    }

    // Barge-in first: if Freya is talking, the interruption happens *before* the
    // microphone opens, so the owner never has to talk over her and be recorded
    // at the same time.
    if (this.mirror.projection?.speaking === true) {
      await this.mirror.interruptSpeaking('the owner started speaking')
    }

    const enabled = await this.mirror.micEnable()
    if (!enabled.ok) {
      this.notice(enabled.reason ?? 'the microphone could not be turned on')
      return
    }

    if (this.mirror.projection?.permission !== 'granted') {
      const request = await this.mirror.requestPermission()
      if (!request.ok) {
        this.notice(request.reason ?? 'microphone permission could not be requested')
        return
      }
      try {
        await requestMicrophonePermission()
        await this.mirror.reportPermission('granted')
      } catch (error) {
        if (error instanceof MicrophoneError && error.reason === 'permission-denied') {
          await this.mirror.reportPermission('denied')
        }
        this.notice(error instanceof Error ? error.message : 'microphone permission was not granted')
        return
      }
    }

    const started = await this.mirror.startCapture()
    if (!started.ok || started.sessionId === null) {
      this.notice(started.reason ?? 'the microphone could not be opened')
      return
    }
    this.sessionId = started.sessionId

    try {
      this.capture = await openMicrophone({
        maxDurationMs: this.mirror.projection?.limits.maxDurationMs ?? VOICE_LIMITS.maxDurationMs,
        maxBytes: this.mirror.projection?.limits.maxAudioBytes ?? VOICE_LIMITS.maxAudioBytes,
        sampleRate: VOICE_LIMITS.sampleRate,
      })
      voiceEnvelope.setRealLevel(0)
    } catch (error) {
      // The device did not open, so Core's session must not be left dangling. The
      // session is cancelled *and* the permission reported — a refusal is a fact
      // about the operating system, and a window that hid it would be reporting
      // "still ready" for a microphone the user has just declined at the OS level.
      const reason = error instanceof MicrophoneError ? error.message : 'the microphone could not be opened'
      if (error instanceof MicrophoneError && error.reason === 'permission-denied') {
        await this.mirror.reportPermission('denied')
      }
      await this.mirror.cancelCapture()
      this.sessionId = null
      this.notice(`${reason}.`)
    }
  }

  /** Finish a capture from the release of the same press. */
  async release(cancelled = false): Promise<void> {
    const capture = this.capture
    const sessionId = this.sessionId
    this.capture = null
    this.sessionId = null
    voiceEnvelope.setRealLevel(null)
    clearMicLevel()

    if (capture === null || sessionId === null) return
    const { audio, durationMs } = await capture.stop(cancelled)
    if (cancelled) {
      await this.mirror.cancelCapture()
      return
    }

    const outcome = await this.mirror.endCapture({ sessionId, audio, durationMs })
    if (outcome.text !== null && outcome.text.length > 0) {
      this.events.onTranscript?.(outcome.text, outcome.turnId)
      if (outcome.turnId !== null) this.notice('Sent.')
      return
    }
    this.notice(outcome.detail ?? outcome.reason ?? 'The recording was discarded.')
  }

  /** Throw the recording away. Used by a cancel control and by unmount. */
  async cancel(): Promise<void> {
    const capture = this.capture
    const sessionId = this.sessionId
    this.capture = null
    this.sessionId = null
    voiceEnvelope.setRealLevel(null)
    clearMicLevel()
    if (capture !== null) await capture.abandon()
    if (sessionId !== null) await this.mirror.cancelCapture()
  }

  /* --------------------------------------------------------------- playback */

  /** Attach playback and report what the platform offers. */
  start(): () => void {
    if (this.disposed) return () => {}
    const bridge = hostBridge()
    const output = new WindowSpeechOutput((utteranceId, outcome) => {
      this.lastUtterance = utteranceId
      void this.mirror.settle(utteranceId, outcome)
    })
    this.output = output

    // Presence-checked, for the same reason `voiceClient.attach` is: a bridge from
    // an older preload must leave playback inert rather than throwing inside a
    // React effect. A window that cannot hear Freya says so; it does not crash.
    const disposeOutput =
      typeof bridge?.onVoiceOutput === 'function'
        ? bridge.onVoiceOutput((instruction) => {
            if (instruction.kind === 'speak') {
              output.play({
                utteranceId: instruction.utteranceId,
                text: instruction.text,
                voiceId: instruction.voiceId,
                rate: instruction.rate,
                pitch: instruction.pitch,
              })
              return
            }
            if (instruction.kind === 'stop') {
              output.stop()
              return
            }
            output.cancel()
          })
        : null

    // The capability report is what makes `synthesis.available` truthful. Reporting
    // "I have no speech engine" is as welcome as reporting "I do", so there is no
    // default to be wrong about.
    const report = (): void => {
      const capabilities = output.capabilities()
      if (typeof bridge?.reportVoiceCapabilities === 'function') {
      bridge.reportVoiceCapabilities({
        available: capabilities.available,
        voices: capabilities.voices,
        detail: capabilities.detail,
      })
    }
    }
    report()
    const disposeWatch = output.watchVoices(report)
    // A second report after a tick, because Chromium populates the voice list
    // asynchronously on first load and an empty list on the first read is normal.
    const retry = setTimeout(report, 750)

    return () => {
      clearTimeout(retry)
      disposeWatch()
      disposeOutput?.()
      output.cancel()
    }
  }

  /** Read a stored turn aloud. */
  async speak(turnId: string): Promise<void> {
    const outcome = await this.mirror.speak(turnId)
    if (!outcome.ok) this.notice(outcome.reason ?? 'Freya could not speak that answer.')
  }

  async stopSpeaking(): Promise<void> {
    await this.mirror.stopSpeaking()
  }

  /** Cut Freya off. Barge-in, a stop control, and STOP ALL's renderer half. */
  async interrupt(reason = 'the owner interrupted Freya'): Promise<void> {
    this.output?.cancel()
    await this.mirror.interruptSpeaking(reason)
  }

  /* -------------------------------------------------------------- mute/wake */

  async setMuted(muted: boolean): Promise<void> {
    if (muted) this.output?.cancel()
    await this.mirror.setMuted(muted)
  }

  /**
   * Arm hands-free.
   *
   * Core refuses this on every build that has no local gate configured, and the
   * reason is shown rather than swallowed. Nothing here starts listening on its
   * own initiative: the interval below is only ever running because a person
   * pressed this.
   */
  async armWake(): Promise<void> {
    const enabled = await this.mirror.micEnable()
    if (!enabled.ok) {
      this.notice(enabled.reason ?? 'the microphone could not be enabled')
      return
    }

    if (this.mirror.projection?.permission !== 'granted') {
      const request = await this.mirror.requestPermission()
      if (!request.ok) {
        this.notice(request.reason ?? 'microphone permission could not be requested')
        return
      }
      try {
        await requestMicrophonePermission()
        await this.mirror.reportPermission('granted')
      } catch (error) {
        if (error instanceof MicrophoneError && error.reason === 'permission-denied') {
          await this.mirror.reportPermission('denied')
        }
        this.notice(error instanceof Error ? error.message : 'microphone permission was not granted')
        return
      }
    }

    const armed = await this.mirror.armWake()
    if (!armed.ok) {
      this.notice(armed.reason ?? 'hands-free is not available on this build')
      return
    }
    await this.openWakeCapture()
  }

  async disarmWake(): Promise<void> {
    if (this.wakeTimer !== null) {
      clearInterval(this.wakeTimer)
      this.wakeTimer = null
    }
    const capture = this.wakeMeter
    this.wakeMeter = null
    if (this.wakeSessionId !== null) await this.mirror.cancelCapture()
    this.wakeSessionId = null
    this.wakeClipStartedAt = null
    this.wakeSilenceMs = 0
    capture?.cancelClip()
    if (capture !== null) await capture.abandon()
    await this.mirror.disarmWake()
  }

  /**
   * Open the explicitly armed local hands-free meter.
   *
   * It retains only a tiny in-memory rolling pre-roll so the wake word itself is
   * present when speech crosses the local VAD threshold. Nothing is written to
   * disk and no network request happens until Core has opened one wake capture.
   */
  private async openWakeCapture(): Promise<void> {
    const capabilities = this.capabilities()
    if (!capabilities.capture || this.wakeMeter !== null) return
    try {
      this.wakeMeter = await openWakeMeter({
        threshold: WAKE_THRESHOLD,
        sampleRate: VOICE_LIMITS.sampleRate,
        preRollMs: WAKE_PRE_ROLL_MS,
        maxClipMs: WAKE_CLIP_MAX_MS,
      })
    } catch (error) {
      this.wakeMeter = null
      await this.mirror.disarmWake()
      this.notice(error instanceof Error ? error.message : 'Hands-free could not open the microphone.')
      return
    }
    this.wakeTimer = setInterval(() => {
      void this.tickWake()
    }, WAKE_POLL_MS)
  }

  private async tickWake(): Promise<void> {
    const meter = this.wakeMeter
    if (meter === null || this.capture !== null) return
    this.wakeLevel = meter.level

    if (this.wakeSessionId !== null) {
      const elapsed = this.wakeClipStartedAt === null ? 0 : performance.now() - this.wakeClipStartedAt
      this.wakeSilenceMs =
        this.wakeLevel < WAKE_THRESHOLD ? this.wakeSilenceMs + WAKE_POLL_MS : 0
      if (
        elapsed >= WAKE_CLIP_MAX_MS ||
        (elapsed >= WAKE_MIN_CLIP_MS && this.wakeSilenceMs >= WAKE_END_SILENCE_MS)
      ) {
        await this.finishWakeClip()
      }
      return
    }

    this.wakeSustainedMs =
      this.wakeLevel >= WAKE_THRESHOLD ? this.wakeSustainedMs + WAKE_POLL_MS : 0
    if (this.wakeSustainedMs < WAKE_SUSTAIN_MS) return

    if (this.output?.speaking === true) {
      await this.interrupt('the owner started speaking')
    }

    const outcome = await this.mirror.reportWakeEnergy(this.wakeLevel, this.wakeSustainedMs)
    this.wakeSustainedMs = 0
    if (!outcome.fired) {
      if (outcome.reason !== null) this.notice(outcome.reason)
      return
    }

    const sessionId = this.mirror.projection?.sessionId ?? null
    if (sessionId === null) {
      await this.mirror.cancelCapture()
      return
    }

    this.wakeSessionId = sessionId
    this.wakeClipStartedAt = performance.now()
    this.wakeSilenceMs = 0
    meter.beginClip()
  }

  private async finishWakeClip(): Promise<void> {
    const meter = this.wakeMeter
    const sessionId = this.wakeSessionId
    if (meter === null || sessionId === null) return

    this.wakeSessionId = null
    this.wakeClipStartedAt = null
    this.wakeSilenceMs = 0
    const clip = meter.finishClip()
    if (clip === null || clip.audio.byteLength === 0) {
      await this.mirror.cancelCapture()
      return
    }

    const outcome = await this.mirror.endCapture({
      sessionId,
      audio: clip.audio,
      durationMs: clip.durationMs,
    })
    if (!outcome.ok && outcome.detail !== null) this.notice(outcome.detail)
  }

  /** The voices this platform offers, for a picker. */
  async voices(): Promise<VoiceOption[]> {
    return this.mirror.listVoices()
  }

  async selectVoice(voiceId: string): Promise<void> {
    const outcome = await this.mirror.selectVoice(voiceId)
    if (!outcome.ok) this.notice(outcome.reason ?? 'that voice could not be selected')
  }

  async setAutoSubmit(enabled: boolean): Promise<void> {
    await this.mirror.setAutoSubmit(enabled)
  }

  /** Turn the microphone off entirely: meter, capture and Core's own flag. */
  async micOff(): Promise<void> {
    await this.disarmWake()
    await this.cancel()
    this.output?.cancel()
    await this.mirror.micDisable()
  }

  /** Whether this window currently holds an open capture. */
  get listening(): boolean {
    return this.capture !== null || this.wakeSessionId !== null
  }

  /** Whether anything is playing right now. */
  get playingUtteranceId(): string | null {
    return this.lastUtterance
  }

  /** Only the reasons worth surfacing: a capability this build lacks, or a refusal. */
  private notice(detail: string): void {
    if (detail.length === 0) return
    this.events.onNotice?.(detail)
  }

  /** Release everything. Called from a window teardown; safe twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.wakeTimer !== null) {
      clearInterval(this.wakeTimer)
      this.wakeTimer = null
    }
    const meter = this.wakeMeter
    this.wakeMeter = null
    if (this.wakeSessionId !== null) await this.mirror.cancelCapture()
    this.wakeSessionId = null
    this.wakeClipStartedAt = null
    meter?.cancelClip()
    if (meter !== null) await meter.abandon()
    await this.cancel()
    this.output?.cancel()
    clearMicLevel()
    voiceEnvelope.setRealLevel(null)
  }
}

interface WakeMeter {
  readonly level: number
  beginClip(): void
  finishClip(): { audio: Uint8Array; durationMs: number } | null
  cancelClip(): void
  abandon(): Promise<void>
}

/**
 * Local hands-free meter with a bounded in-memory pre-roll.
 *
 * The rolling buffer is capped to `preRollMs`; a promoted clip is capped to
 * `maxClipMs`. It is never persisted and has no network capability.
 */
async function openWakeMeter(options: {
  threshold: number
  sampleRate: number
  preRollMs: number
  maxClipMs: number
}): Promise<WakeMeter> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError('unsupported', 'this environment has no microphone API')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: { ideal: options.sampleRate }, echoCancellation: true },
    video: false,
  })
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    release(stream)
    throw new MicrophoneError('unsupported', 'this environment has no Web Audio support')
  }
  const context = new AudioContextCtor()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(2048, 1, 1)
  const preRollFrames = Math.round(options.sampleRate * options.preRollMs / 1000)
  const maxClipFrames = Math.round(options.sampleRate * options.maxClipMs / 1000)
  const ring: Int16Array[] = []
  let ringFrames = 0
  let clip: Int16Array[] | null = null
  let clipFrames = 0
  let currentLevel = 0
  let closed = false

  const finish = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      sink.disconnect()
    } catch {
      /* already down */
    }
    release(stream)
    try {
      await context.close()
    } catch {
      /* a context that will not close must not stop us releasing the device */
    }
  }

  processor.onaudioprocess = (event) => {
    if (closed) return
    const input = event.inputBuffer.getChannelData(0)
    if (!input || input.length === 0) return
    let sum = 0
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i] ?? 0
      sum += sample * sample
    }
    currentLevel = Math.min(1, Math.max(0, (Math.sqrt(sum / input.length) - 0.01) * 6))
    publishMicLevel(currentLevel)

    const pcm = resampleFloat32ToInt16(input, context.sampleRate, options.sampleRate)
    ring.push(pcm)
    ringFrames += pcm.length
    while (ringFrames > preRollFrames && ring.length > 1) {
      const removed = ring.shift()
      ringFrames -= removed?.length ?? 0
    }

    if (clip !== null && clipFrames < maxClipFrames) {
      clip.push(pcm)
      clipFrames += pcm.length
    }
  }

  source.connect(processor)
  const sink = context.createGain()
  sink.gain.value = 0
  processor.connect(sink)
  sink.connect(context.destination)

  return {
    get level() {
      return currentLevel
    },
    beginClip() {
      clip = ring.map((chunk) => chunk.slice())
      clipFrames = clip.reduce((total, chunk) => total + chunk.length, 0)
    },
    finishClip() {
      if (clip === null) return null
      const chunks = clip
      clip = null
      const frames = Math.min(maxClipFrames, chunks.reduce((total, chunk) => total + chunk.length, 0))
      const audio = new Uint8Array(frames * 2)
      let frameOffset = 0
      for (const chunk of chunks) {
        if (frameOffset >= frames) break
        const take = Math.min(chunk.length, frames - frameOffset)
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, take * 2)
        audio.set(bytes, frameOffset * 2)
        frameOffset += take
      }
      clipFrames = 0
      return { audio, durationMs: frames / options.sampleRate * 1000 }
    },
    cancelClip() {
      clip = null
      clipFrames = 0
    },
    abandon: finish,
  }
}

function release(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      /* a track that will not stop is not worth failing a release over */
    }
  }
}

/* ---------------------------------------------------------------- singleton */

let shared: VoiceRuntime | null = null

export function voiceRuntime(events: VoiceRuntimeEvents = {}): VoiceRuntime {
  shared ??= new VoiceRuntime(voiceMirror(), events)
  return shared
}

export function resetVoiceRuntime(): void {
  shared = null
}