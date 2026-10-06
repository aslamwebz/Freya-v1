import { VOICE_LIMITS, type VoiceOption } from '../../core/voice/types'
import { hostBridge } from '../platform/host'
import { voiceMirror, type VoiceMirror } from '../platform/voiceClient'
import { openMicrophone, requestMicrophonePermission, MicrophoneError, type MicCapture } from '../ui/surfaces/microphone'
import { clearMicLevel } from '../presence/micLevel'
import { voiceEnvelope } from '../presence/voiceEnvelope'
import { WindowSpeechOutput } from './output'
import { detectRecognitionSupport, type RecognitionSupport } from './recognition'

export interface VoiceRuntimeEvents {
  onTranscript?: (text: string, turnId: string | null) => void
  onNotice?: (message: string) => void
}

/** Hardware only. Core owns transcripts, attention, conversation and speech policy. */
export class VoiceRuntime {
  private capture: MicCapture | null = null
  private standby = false
  private sessionId: string | null = null
  private opening = false
  private completedDuringOpening: boolean | null = null
  private pendingTranscriptions = new Set<number>()
  private armedUntil = 0
  private controller: AbortController | null = null
  private output: WindowSpeechOutput | null = null
  private handsFree = false
  private enabling: Promise<boolean> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private lastUtterance: string | null = null
  private epoch = 0
  constructor(private readonly mirror: VoiceMirror, private readonly events: VoiceRuntimeEvents = {}) {}

  capabilities(): { capture: boolean; recognition: RecognitionSupport } {
    return { capture: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function', recognition: detectRecognitionSupport() }
  }

  private enable(): Promise<boolean> {
    if (this.enabling) return this.enabling
    this.enabling = this.enableDevice().finally(() => { this.enabling = null })
    return this.enabling
  }
  private async enableDevice(): Promise<boolean> {
    if (this.disposed) return false
    if (!this.capabilities().capture) { this.notice('This window has no microphone API.'); return false }
    const enabled = await this.mirror.micEnable()
    if (!enabled.ok) { this.notice(enabled.reason ?? 'Microphone unavailable.'); return false }
    await this.mirror.refresh?.()
    if (this.mirror.projection?.permission !== 'granted') {
      try { await requestMicrophonePermission(); if (this.disposed || this.mirror.projection?.micEnabled === false) return false; await this.mirror.reportPermission('granted'); await this.mirror.refresh?.() }
      catch { await this.mirror.reportPermission('denied'); this.notice('Microphone permission was not granted.'); return false }
    }
    return !this.disposed
  }

  async press(): Promise<void> {
    if (this.disposed || this.opening) return
    if (this.standby) await this.release(true)
    if (this.capture) return
    const epoch = ++this.epoch
    this.opening = true
    try {
      if (!await this.enable() || epoch !== this.epoch) return
      await this.interrupt('the owner pressed to speak')
      if (epoch !== this.epoch) return
      await this.open(false, epoch)
    } finally { this.opening = false; this.drainCompletion() }
  }

  private async open(automatic: boolean, epoch: number): Promise<void> {
    const standby = automatic && !this.mirror.projection?.attention?.active
    if (!standby) {
      const started = await this.mirror.startCapture()
      if (!started.ok || !started.sessionId) { if (!automatic) this.notice(started.reason ?? 'Capture refused.'); return }
      if (this.disposed || epoch !== this.epoch) { await this.mirror.cancelCapture(); return }
      if (automatic && !this.mirror.projection?.attention?.active) { await this.mirror.cancelCapture(); return }
      this.sessionId = started.sessionId
    }
    this.standby = standby
    const controller = new AbortController()
    this.controller = controller
    try {
      const preferences = await hostBridge()?.voiceSettingsRead?.()
      if (controller.signal.aborted || epoch !== this.epoch) return
      const capture = await openMicrophone({
        maxDurationMs: standby ? VOICE_LIMITS.maxWakeArmedMs : this.mirror.projection?.limits.maxDurationMs ?? VOICE_LIMITS.maxDurationMs,
        standby, onPcm: audio => { if (this.handsFree && !this.mirror.projection?.attention?.active && epoch === this.epoch) hostBridge()?.voiceWakeAudio?.(audio) },
        maxBytes: VOICE_LIMITS.maxAudioBytes, sampleRate: VOICE_LIMITS.sampleRate, signal: controller.signal, deviceId: preferences?.inputDeviceId,
        ...(automatic ? {
          silenceMs: 750,
          onSpeechStart: () => { if (epoch === this.epoch && this.mirror.projection?.attention?.active) void this.interrupt('the owner started speaking') },
          onComplete: (result: { speechDetected: boolean }) => { if (epoch === this.epoch) this.complete(!result.speechDetected) },
        } : {
          onComplete: () => { if (epoch === this.epoch) this.complete(false) },
        }),
      })
      if (this.disposed || controller.signal.aborted || epoch !== this.epoch) { await capture.abandon(); return }
      this.capture = capture
      if (standby && this.mirror.projection?.attention?.active) void this.activateStandby()
      voiceEnvelope.setRealLevel(0)
    } catch (error) {
      if (epoch !== this.epoch) return
      await this.mirror.cancelCapture()
      this.sessionId = null
      if (error instanceof MicrophoneError && error.reason === 'permission-denied') await this.mirror.reportPermission('denied')
      this.notice(error instanceof MicrophoneError ? error.message : 'The microphone could not be opened.')
      if (automatic) await this.disarmWake()
    }
  }

  private async activateStandby(): Promise<void> {
    if (!this.standby || !this.capture || this.opening || !this.handsFree) return
    this.opening = true
    const epoch = this.epoch
    this.standby = false
    this.capture.promote?.()
    try {
      const started = await this.mirror.startCapture()
      if (!started.ok || !started.sessionId) { await this.disarmWake(); this.notice(started.reason ?? 'Speech recognition unavailable.'); return }
      if (this.disposed || epoch !== this.epoch || !this.capture) { await this.mirror.cancelCapture(); return }
      if (!this.mirror.projection?.attention?.active) { await this.release(true); return }
      this.sessionId = started.sessionId
    } finally { this.opening = false; this.drainCompletion() }
  }

  private complete(cancelled: boolean): void {
    if (this.opening) this.completedDuringOpening = cancelled
    else void this.release(cancelled)
  }
  private drainCompletion(): void {
    const completed = this.completedDuringOpening
    this.completedDuringOpening = null
    if (completed !== null && this.capture) void this.release(completed)
  }

  async release(cancelled = false): Promise<void> {
    const epoch = ++this.epoch
    this.completedDuringOpening = null
    const controller = this.controller
    const capture = this.capture
    const sessionId = this.sessionId
    this.capture = null
    this.standby = false
    this.sessionId = null
    this.controller = null
    voiceEnvelope.setRealLevel(null)
    clearMicLevel()
    if (!capture || !sessionId) { await capture?.abandon(); controller?.abort(); if (sessionId || this.pendingTranscriptions.size > 0) await this.mirror.cancelCapture(); return }
    // stop(false) must collect before aborting the graph; stop is idempotent.
    const result = await capture.stop(cancelled)
    controller?.abort()
    if (cancelled) { await this.mirror.cancelCapture(); return }
    if (this.disposed || epoch !== this.epoch) { await this.mirror.cancelCapture(); return }
    this.pendingTranscriptions.add(epoch)
    const outcome = await this.mirror.endCapture({ sessionId, ...result }).finally(() => { this.pendingTranscriptions.delete(epoch) })
    if (this.disposed || epoch !== this.epoch) return
    if (outcome.text) this.events.onTranscript?.(outcome.text, outcome.turnId)
    else if (!outcome.ok || outcome.reason !== 'completed') this.notice(outcome.detail ?? outcome.reason ?? 'Recording discarded.')
  }

  async cancel(): Promise<void> {
    if (this.pendingTranscriptions.size > 0 && this.mirror.projection?.state === 'submitting') await this.interrupt('the owner cancelled the voice response')
    await this.release(true)
  }

  start(): () => void {
    this.disposed = false
    const bridge = hostBridge()
    const output = new WindowSpeechOutput((id, outcome) => { this.lastUtterance = id; void this.mirror.settle(id, outcome) })
    this.output = output
    const detach = bridge?.onVoiceOutput?.(instruction => {
      if (instruction.kind === 'speak') output.play(instruction)
      else output.cancel()
    })
    const report = (): void => {
      const c = output.capabilities()
      bridge?.reportVoiceCapabilities?.({ available: c.available, voices: c.voices, detail: c.detail })
    }
    report()
    const watch = output.watchVoices(report)
    const retry = setTimeout(report, 750)
    const subscribe = this.mirror.subscribe(p => {
      if (!p || !p.micEnabled || p.state === 'stopped-by-STOP-ALL' || p.permission === 'revoked' || p.permission === 'denied') {
        this.handsFree = false
        void this.cancel()
        output.cancel()
      } else if (this.standby && p.attention?.active) void this.activateStandby()
      else if (this.handsFree && this.capture && !this.standby && !this.opening && !p.attention?.active) void this.cancel()
      else if (this.capture && !this.standby && !this.opening && !p.capturing) void this.cancel()
    })
    this.timer = setInterval(() => { void this.pump() }, 200)
    return () => { clearTimeout(retry); watch(); detach?.(); subscribe(); output.cancel(); if (this.timer) clearInterval(this.timer); this.timer = null }
  }

  private async pump(): Promise<void> {
    if (!this.handsFree || this.disposed) return
    if (Date.now() >= this.armedUntil) { await this.disarmWake(); this.notice('Hands-free timed out. Turn it on again to continue.'); return }
    if (this.standby && this.capture && this.mirror.projection?.attention?.active) { await this.activateStandby(); return }
    if (this.opening || this.capture || this.sessionId) return
    const p = this.mirror.projection
    if (!p?.wake.armed || !p.micEnabled || p.state === 'stopped-by-STOP-ALL') { this.handsFree = false; return }
    if (p.state === 'transcribing') return
    await this.mirror.refresh()
    if (this.disposed || !this.handsFree) return
    const epoch = ++this.epoch
    this.opening = true
    try { await this.open(true, epoch) } finally { this.opening = false; this.drainCompletion() }
  }

  async armWake(): Promise<void> {
    if (this.mirror.projection?.transcription.available !== true) { this.notice(this.mirror.projection?.transcription.detail ?? 'Configure speech recognition first.'); return }
    if (!await this.enable()) return
    const result = await this.mirror.armWake()
    if (!result.ok) { this.notice(result.reason ?? 'Hands-free unavailable.'); return }
    await this.mirror.refresh()
    this.armedUntil = Date.now() + (this.mirror.projection?.wake.maxArmedMs ?? VOICE_LIMITS.maxWakeArmedMs)
    this.handsFree = true
    await this.pump()
  }
  async disarmWake(): Promise<void> { this.handsFree = false; await this.cancel(); await this.mirror.disarmWake() }
  async speak(turnId: string): Promise<void> { const result = await this.mirror.speak(turnId); if (!result.ok) this.notice(result.reason ?? 'Speech unavailable.') }
  async stopSpeaking(): Promise<void> { this.output?.cancel(); await this.mirror.stopSpeaking() }
  async interrupt(reason = 'the owner interrupted Freya'): Promise<void> { this.output?.cancel(); await this.mirror.interruptSpeaking(reason) }
  async setMuted(muted: boolean): Promise<void> { if (muted) this.output?.cancel(); await this.mirror.setMuted(muted) }
  async voices(): Promise<VoiceOption[]> { return this.mirror.listVoices() }
  async selectVoice(id: string): Promise<void> { const result = await this.mirror.selectVoice(id); if (!result.ok) this.notice(result.reason ?? 'Voice unavailable.') }
  async setAutoSubmit(enabled: boolean): Promise<void> { await this.mirror.setAutoSubmit(enabled) }
  async micOn(): Promise<void> { await this.enable() }
  async micOff(): Promise<void> { await this.disarmWake(); await this.mirror.micDisable() }
  get listening(): boolean { return this.capture !== null }
  get playingUtteranceId(): string | null { return this.lastUtterance }
  private notice(message: string): void { this.events.onNotice?.(message) }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.handsFree = false; if (this.timer) clearInterval(this.timer); this.timer = null; await this.cancel(); this.output?.cancel() }
}
let shared: VoiceRuntime | null = null
export function voiceRuntime(events: VoiceRuntimeEvents = {}): VoiceRuntime { shared ??= new VoiceRuntime(voiceMirror(), events); return shared }
export function resetVoiceRuntime(): void { shared = null }
