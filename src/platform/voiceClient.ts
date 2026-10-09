import type {
  VoiceCommandOutcome,
  VoiceProjection,
} from '../../core/protocol/conversation'
import { VOICE_LIMITS, type VoiceOption, type VoiceTranscriptFragment } from '../../core/voice/types'
import { hostBridge } from './host'

/**
 * The renderer's view of voice.
 *
 * A mirror, in the sense `conversationMirror` is one: every field arrived from
 * Core over the bridge, and the renderer cannot write one. What the renderer *does*
 * own is the device — opening the microphone is a Web Audio operation and there is
 * no way to do it in the main process — so this module is split deliberately:
 *
 * - **Core** decides whether a capture may open, what the transcript means, and
 *   whether anything becomes a turn.
 * - **The window** opens and closes the device, and only ever after Core has said
 *   yes.
 *
 * That ordering is the whole push-to-talk contract, and it is why `startCapture`
 * asks Core first and calls `getUserMedia` second. A window that called the
 * device first would have a microphone the trusted half never agreed to.
 */

export interface VoiceStartOutcome {
  ok: boolean
  sessionId: string | null
  reason: string | null
}

export interface VoiceEndOutcome {
  ok: boolean
  sessionId: string | null
  reason: string | null
  text: string | null
  detail: string | null
  /** The turn this transcript became, or null when it is waiting in a composer. */
  turnId: string | null
}

export interface VoiceMirror {
  readonly projection: VoiceProjection | null
  readonly interim: string
  subscribe(listener: (projection: VoiceProjection | null) => void): () => void
  subscribeTranscript(listener: (fragment: VoiceTranscriptFragment) => void): () => void
  attach(): Promise<() => void>
  refresh(): Promise<void>
  reset(): void

  micEnable(): Promise<{ ok: boolean; reason: string | null }>
  micDisable(): Promise<void>
  requestPermission(): Promise<{ ok: boolean; reason: string | null }>
  reportPermission(outcome: 'granted' | 'denied' | 'revoked'): Promise<void>

  startCapture(): Promise<VoiceStartOutcome>
  pushInterim(sessionId: string, text: string): Promise<void>
  endCapture(input: {
    sessionId: string
    audio: Uint8Array
    durationMs: number
    cancelled?: boolean
  }): Promise<VoiceEndOutcome>
  cancelCapture(): Promise<void>

  setAutoSubmit(enabled: boolean): Promise<void>
  speak(turnId: string, tuning?: { rate?: number; pitch?: number }): Promise<{ ok: boolean; reason: string | null; utteranceId: string | null }>
  stopSpeaking(): Promise<void>
  interruptSpeaking(reason: string): Promise<void>
  settle(utteranceId: string, outcome: 'completed' | 'failed'): Promise<void>
  listVoices(): Promise<VoiceOption[]>
  selectVoice(voiceId: string): Promise<{ ok: boolean; reason: string | null }>
  setMuted(muted: boolean): Promise<void>
  armWake(): Promise<{ ok: boolean; reason: string | null }>
  disarmWake(): Promise<void>
  reportWakeEnergy(level: number, sustainedMs: number): Promise<{ fired: boolean; reason: string | null }>
}

/** One sentence for when this window cannot reach Core at all. */
const UNREACHABLE = 'this window cannot reach Freya Core, so voice is unavailable'

let shared: VoiceMirror | null = null

export function voiceMirror(): VoiceMirror {
  shared ??= createVoiceMirror()
  return shared
}

/** Forget the shared mirror. For tests, and for a window that is going away. */
export function resetVoiceMirror(): void {
  shared?.reset()
  shared = null
}

export function createVoiceMirror(): VoiceMirror {
  const listeners = new Set<(projection: VoiceProjection | null) => void>()
  const transcriptListeners = new Set<(fragment: VoiceTranscriptFragment) => void>()
  let current: VoiceProjection | null = null
  let interimText = ''
  let disposeBridge: (() => void) | null = null
  let disposeTranscript: (() => void) | null = null

  const publish = (projection: VoiceProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Submit a command, resolving with a refusal rather than rejecting.
   *
   * Same reasoning as `conversationMirror`: "Core is not reachable from this
   * window" is a state the UI already models, so making it a resolved value stops
   * an unreachable host from becoming an unhandled rejection in somebody's console
   * instead of a microphone button that says why it is not working.
   */
  const submit = async (
    command: Parameters<NonNullable<ReturnType<typeof hostBridge>>['coreSubmit']>[0],
    payload?: unknown,
  ): Promise<{ ok: boolean; voice?: VoiceCommandOutcome; refusal: string | null }> => {
    const bridge = hostBridge()
    if (!bridge) return { ok: false, refusal: UNREACHABLE }
    try {
      const result = await bridge.coreSubmit(command, payload)
      return {
        ok: result.ok === true,
        voice: result.voice as VoiceCommandOutcome | undefined,
        refusal: result.refusal?.reason ?? null,
      }
    } catch (error) {
      return {
        ok: false,
        refusal: `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
  }

  const reasonOf = (outcome: { ok: boolean; voice?: VoiceCommandOutcome; refusal: string | null }): string | null => {
    if (outcome.ok) return null
    if (outcome.voice?.operation === 'refused') return outcome.voice.reason
    return outcome.refusal ?? 'the voice command was refused'
  }

  return {
    get projection() {
      return current
    },

    get interim() {
      return interimText
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    subscribeTranscript(listener) {
      transcriptListeners.add(listener)
      return () => {
        transcriptListeners.delete(listener)
      }
    },

    async attach(): Promise<() => void> {
      disposeBridge?.()
      disposeTranscript?.()
      disposeBridge = null
      disposeTranscript = null
      const bridge = hostBridge()
      // Presence-checked rather than assumed. A bridge from an older preload — or a
      // partial one in a test — must produce a voice panel that says it is not
      // connected, not an unhandled rejection inside a React effect. A missing push
      // channel is a real state; a thrown `TypeError` in a passive effect is a bug.
      if (!bridge || typeof bridge.onCoreVoice !== 'function') {
        publish(null)
        return () => {}
      }
      disposeBridge = bridge.onCoreVoice((projection) => publish(projection))
      disposeTranscript =
        typeof bridge.onCoreVoiceTranscript === 'function'
          ? bridge.onCoreVoiceTranscript((fragment) => {
              // The interim string is kept here as well as in the projection because
              // a fragment can arrive between two projections, and a caption that
              // lags a capture by a state push looks broken.
              interimText = fragment.kind === 'final' ? '' : fragment.text
              for (const listener of [...transcriptListeners]) listener(fragment)
            })
          : null
      await this.refresh()
      return () => {
        disposeBridge?.()
        disposeTranscript?.()
        disposeBridge = null
        disposeTranscript = null
      }
    },

    /**
     * Re-read the voice status.
     *
     * `null` on failure rather than a rejection, because "I do not know what the
     * voice subsystem is doing" is a state this UI already handles — as a
     * microphone button that says it does not know.
     */
    async refresh(): Promise<void> {
      const bridge = hostBridge()
      if (!bridge) {
        publish(null)
        return
      }
      try {
        publish(await bridge.coreVoice())
      } catch {
        publish(null)
      }
    },

    async micEnable() {
      const outcome = await submit('voice.mic.enable', { source: 'owner' })
      return { ok: outcome.ok, reason: reasonOf(outcome) }
    },

    async micDisable() {
      await submit('voice.mic.disable', { reason: 'the owner turned the microphone off' })
    },

    async requestPermission() {
      const outcome = await submit('voice.permission.request')
      return { ok: outcome.ok, reason: reasonOf(outcome) }
    },

    async reportPermission(outcome) {
      await submit('voice.permission.report', { outcome })
    },

    async startCapture() {
      const outcome = await submit('voice.capture.start')
      if (outcome.ok && outcome.voice?.operation === 'capture-started') {
        interimText = ''
        return { ok: true, sessionId: outcome.voice.sessionId, reason: null }
      }
      return { ok: false, sessionId: null, reason: reasonOf(outcome) }
    },

    async pushInterim(sessionId, text) {
      await submit('voice.transcript.interim', { sessionId, text })
    },

    async endCapture(input) {
      const outcome = await submit('voice.capture.end', {
        sessionId: input.sessionId,
        audio: input.audio,
        durationMs: input.durationMs,
        cancelled: input.cancelled === true,
        // The declared format is *not* a parameter. A window that could choose its
        // own codec would be choosing what Core's allowlist has to think about, and
        // a build with no compressor support would spend every capture being
        // refused for something the window chose. These four are constants here so
        // that cannot happen from this layer.
        format: VOICE_LIMITS.format,
        codec: 'pcm_s16le',
        mimeType: 'audio/pcm',
        sampleRate: VOICE_LIMITS.sampleRate,
        channels: VOICE_LIMITS.channels,
      })
      if (outcome.voice?.operation === 'capture-ended') {
        return {
          ok: true,
          sessionId: input.sessionId,
          reason: outcome.voice.reason,
          text: outcome.voice.text,
          detail: outcome.voice.detail,
          turnId: outcome.voice.turnId,
        }
      }
      return {
        ok: false,
        sessionId: input.sessionId,
        reason: reasonOf(outcome),
        text: null,
        detail: null,
        turnId: null,
      }
    },

    async cancelCapture() {
      await submit('voice.capture.cancel', { reason: 'the owner cancelled the recording' })
    },

    async setAutoSubmit(enabled) {
      await submit('voice.submit.set', { enabled })
    },

    async speak(turnId, tuning) {
      const outcome = await submit('voice.tts.speak', {
        turnId,
        ...(tuning?.rate === undefined ? {} : { rate: tuning.rate }),
        ...(tuning?.pitch === undefined ? {} : { pitch: tuning.pitch }),
      })
      const utteranceId = outcome.voice?.operation === 'speaking' ? outcome.voice.utteranceId : null
      return { ok: outcome.ok, reason: reasonOf(outcome), utteranceId }
    },

    async stopSpeaking() {
      await submit('voice.tts.stop')
    },

    async interruptSpeaking(reason) {
      await submit('voice.tts.cancel', { reason })
    },

    async settle(utteranceId, outcome) {
      await submit('voice.tts.settle', { utteranceId, outcome })
    },

    async listVoices() {
      const outcome = await submit('voice.tts.voice.read')
      return outcome.voice?.operation === 'voices' ? [...outcome.voice.voices] : []
    },

    async selectVoice(voiceId) {
      const outcome = await submit('voice.tts.voice.select', { voiceId })
      return { ok: outcome.ok, reason: reasonOf(outcome) }
    },

    async setMuted(muted) {
      await submit('voice.mute.set', { muted })
    },

    async armWake() {
      const outcome = await submit('voice.wake.arm')
      return { ok: outcome.ok, reason: reasonOf(outcome) }
    },

    async disarmWake() {
      await submit('voice.wake.disarm')
    },

    async reportWakeEnergy(level, sustainedMs) {
      const outcome = await submit('voice.wake.energy', { level, sustainedMs })
      const fired = outcome.ok && outcome.voice?.operation === 'capture-started'
      return {
        fired,
        reason: fired ? null : (outcome.voice?.operation === 'refused' ? outcome.voice.reason : null),
      }
    },

    reset() {
      disposeBridge?.()
      disposeTranscript?.()
      disposeBridge = null
      disposeTranscript = null
      interimText = ''
      publish(null)
    },
  }
}