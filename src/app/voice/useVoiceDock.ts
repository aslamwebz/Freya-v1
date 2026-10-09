import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VoiceProjection } from '../../../core/protocol/conversation'
import type { VoiceOption } from '../../../core/voice/types'
import { voiceMirror } from '../../platform/voiceClient'
import { hostBridge } from '../../platform/host'
import type { VoiceConfig, VoiceConfigPatch } from '../../../electron/voiceConfig'
import { VoiceRuntime } from '../../voice/runtime'
import { detectRecognitionSupport, type RecognitionSupport } from '../../voice/recognition'

/**
 * App Mode's voice wiring.
 *
 * Four responsibilities and no more, because App Mode is a board and this is a
 * composer button:
 *
 * 1. **Show the truth.** Every label below is derived from Core's projection. There
 *    is no local "is listening" flag to drift out of step with it — that was the
 *    decorative placeholder this replaced, and its whole problem was that it could
 *    not be wrong about Core because it never asked.
 * 2. **Push to talk.** Pointer down opens, pointer up closes. A press that began on
 *    the button and ended anywhere still closes, because a person who slid off the
 *    button while talking did not mean to hold the microphone open.
 * 3. **Put a confirmed transcript in the composer.** Not a turn. Sending stays the
 *    send button, unless the owner has deliberately turned auto-submit on, in which
 *    case Core has already entered it and `turnId` is reported so the composer can
 *    say so rather than showing words that went nowhere.
 * 4. **Say what this build cannot do.** No speech engine, no microphone API, no
 *    hands-free gate — each is a sentence on the button, not a silent no-op.
 */

export interface VoiceView {
  /** Core's own state string, for `data-voice-state` and assistive text. */
  state: VoiceProjection['state'] | 'unreachable'
  projection: VoiceProjection | null
  interim: string
  micEnabled: boolean
  capturing: boolean
  speaking: boolean
  muted: boolean
  wakeArmed: boolean
  /** In words. Empty when there is nothing worth interrupting the user to say. */
  notice: string
  /** Why the microphone button cannot work, in one sentence. */
  unavailableReason: string | null
  capabilities: { capture: boolean; recognition: RecognitionSupport }
  voices: readonly VoiceOption[]
  /** Persistent voice configuration, separate from Chat/model settings. */
  config: VoiceConfig | null
  configBusy: boolean
}

export interface VoiceDock {
  view: VoiceView
  press: () => void
  release: (cancelled?: boolean) => void
  cancel: () => void
  toggleMic: () => void
  toggleMute: () => void
  toggleWake: () => void
  toggleAutoSubmit: () => void
  stopSpeaking: () => void
  chooseVoice: (voiceId: string) => void
  speak: (turnId: string) => void
  saveConfig: (patch: VoiceConfigPatch) => void
}

/**
 * The dock.
 *
 * One runtime per window, attached on mount and disposed on unmount — and the
 * disposal is not optional. A window that goes away mid-press is the commonest way
 * a microphone leaks, so `dispose` is what releases the device, and it is
 * idempotent so React's double-invoked effects in development cannot double-release
 * something.
 */
export function useVoiceDock(
  onTranscript: (text: string, turnId: string | null) => void,
): VoiceDock {
  const mirror = useMemo(() => voiceMirror(), [])
  const runtime = useMemo(() => {
    const sinks: { transcript: ((text: string, turnId: string | null) => void) | null; notice: ((message: string) => void) | null } = {
      transcript: null,
      notice: null,
    }
    const instance = new VoiceRuntime(mirror, {
      onTranscript: (text, turnId) => sinks.transcript?.(text, turnId),
      onNotice: (message) => sinks.notice?.(message),
    })
    return { instance, sinks }
  }, [mirror])

  const [projection, setProjection] = useState<VoiceProjection | null>(mirror.projection)
  const [interim, setInterim] = useState(mirror.interim)
  const [notice, setNotice] = useState('')
  const [voices, setVoices] = useState<readonly VoiceOption[]>([])
  const [config, setConfig] = useState<VoiceConfig | null>(null)
  const [configBusy, setConfigBusy] = useState(false)
  const [reach, setReach] = useState<'ok' | 'unreachable'>('ok')

  // The transcript and notice sinks are held on the runtime rather than captured,
  // so a re-render does not rebuild the object and detach the device.
  useEffect(() => {
    runtime.sinks.transcript = onTranscript
    runtime.sinks.notice = setNotice
  }, [runtime, onTranscript])

  useEffect(() => {
    const disposeProjection = mirror.subscribe(setProjection)
    const disposeTranscript = mirror.subscribeTranscript((fragment) => setInterim(fragment.text))
    let disposed = false
    void mirror.attach().then((dispose) => {
      if (disposed) dispose()
      else disposeAttach = dispose
    })
    let disposeAttach: (() => void) | null = null
    const disposeOutput = runtime.instance.start()
    return () => {
      disposed = true
      disposeAttach?.()
      disposeProjection()
      disposeTranscript()
      disposeOutput()
      void runtime.instance.dispose()
    }
  }, [mirror, runtime])

  useEffect(() => {
    setReach(projection === null && mirror.projection === null ? 'unreachable' : 'ok')
  }, [projection, mirror])

  useEffect(() => {
    const bridge = hostBridge()
    if (typeof bridge?.voiceConfig !== 'function') return
    let disposed = false
    void bridge.voiceConfig()
      .then((value) => {
        if (!disposed) setConfig(value)
      })
      .catch(() => {
        if (!disposed) setNotice('Voice settings could not be loaded in this window.')
      })
    return () => {
      disposed = true
    }
  }, [])

  const saveConfig = useCallback((patch: VoiceConfigPatch) => {
    const bridge = hostBridge()
    if (typeof bridge?.saveVoiceConfig !== 'function') {
      setNotice('Voice settings cannot be saved in this window.')
      return
    }
    setConfigBusy(true)
    void bridge.saveVoiceConfig(patch)
      .then((value) => {
        setConfig(value)
        setNotice('')
      })
      .catch((error) => {
        setNotice(error instanceof Error ? error.message : 'Voice settings could not be saved.')
      })
      .finally(() => setConfigBusy(false))
  }, [])

  const capabilities = useMemo(
    () => runtime.instance.capabilities(),
    // Detected once per mount: the platform's answer cannot change under us, and
    // re-asking on every render would be a way to make this hook a polling loop.
    // The dependency is the memoised runtime, which is itself created once.
    [runtime],
  )

  const press = useCallback(() => {
    setNotice('')
    void runtime.instance.press()
  }, [runtime])

  const release = useCallback(
    (cancelled = false) => {
      void runtime.instance.release(cancelled)
    },
    [runtime],
  )

  const cancel = useCallback(() => {
    setNotice('')
    void runtime.instance.cancel()
  }, [runtime])

  const toggleMic = useCallback(() => {
    if (mirror.projection?.micEnabled === true) {
      void runtime.instance.micOff()
      return
    }
    void runtime.instance.micOn()
  }, [mirror, runtime])

  const toggleMute = useCallback(() => {
    void runtime.instance.setMuted(!(mirror.projection?.muted ?? false))
  }, [mirror, runtime])

  const toggleWake = useCallback(() => {
    if (mirror.projection?.wake.armed === true) {
      saveConfig({ wakeProvider: 'off' })
      void runtime.instance.disarmWake()
      return
    }
    saveConfig({ wakeProvider: 'selected-stt' })
    void runtime.instance.armWake()
  }, [mirror, runtime, saveConfig])

  const toggleAutoSubmit = useCallback(() => {
    void runtime.instance.setAutoSubmit(!(mirror.projection?.autoSubmit ?? false))
  }, [mirror, runtime])

  const stopSpeaking = useCallback(() => {
    void runtime.instance.stopSpeaking()
  }, [runtime])

  const speak = useCallback(
    (turnId: string) => {
      void runtime.instance.speak(turnId)
    },
    [runtime],
  )

  const chooseVoice = useCallback(
    (voiceId: string) => {
      saveConfig({ ttsVoiceId: voiceId === '' ? null : voiceId })
      if (voiceId !== '') void runtime.instance.selectVoice(voiceId)
    },
    [runtime, saveConfig],
  )

  const unavailableReason = useMemo(() => {
    if (reach === 'unreachable') return 'This window cannot reach Freya Core, so voice is off.'
    const p = projection
    if (p === null) return null
    if (p.state === 'unsupported') return 'This build offers no microphone capture.'
    if (p.state === 'permission-denied') return 'Microphone permission was denied. Turn it back on in system settings.'
    if (p.state === 'stopped-by-STOP-ALL') return 'Freya is stopped. Resume before using the microphone.'
    if (!capabilities.capture) return 'This window has no microphone API, so Freya cannot listen.'
    if (!p.micEnabled) return 'The microphone is off. Tap to turn it on.'
    if (!p.transcription.available) return 'No speech engine is configured, so recordings are discarded.'
    return null
  }, [capabilities.capture, projection, reach])

  const view = useMemo<VoiceView>(() => {
    const p = projection
    return {
      state: reach === 'unreachable' ? 'unreachable' : (p?.state ?? 'unreachable'),
      projection: p,
      interim,
      micEnabled: p?.micEnabled ?? false,
      capturing: p?.capturing ?? false,
      speaking: p?.speaking ?? false,
      muted: p?.muted ?? false,
      wakeArmed: p?.wake.armed ?? false,
      notice,
      unavailableReason,
      capabilities,
      voices,
      config,
      configBusy,
    }
  }, [capabilities, config, configBusy, interim, notice, projection, reach, unavailableReason, voices])

  // Voices are read when a voice picker could plausibly be opened, and not before:
  // it is a `speechSynthesis.getVoices()` call in the window, and asking at
  // start-up would be a platform query nobody has asked for yet.
  useEffect(() => {
    if (view.projection?.synthesis.available !== true) return
    void runtime.instance.voices().then(setVoices)
  }, [runtime, view.projection?.synthesis.available])

  // A notice lives for a bounded time so a refusal does not sit on the board
  // pretending to be the current state.
  useEffect(() => {
    if (notice.length === 0) return
    const timer = setTimeout(() => setNotice(''), 6_000)
    return () => clearTimeout(timer)
  }, [notice])

  return {
    view,
    press,
    release,
    cancel,
    toggleMic,
    toggleMute,
    toggleWake,
    toggleAutoSubmit,
    stopSpeaking,
    chooseVoice,
    speak,
    saveConfig,
  }
}

/** Re-exported so a screen can state the recognition finding without a second import. */
export { detectRecognitionSupport }
