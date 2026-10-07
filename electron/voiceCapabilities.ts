import { DEFAULT_CAPABILITY_SELECTION, type CapabilityPreferences, type CapabilityReadiness, type ProviderId } from '../core/capabilities'
import type { VoiceSettings } from '../core/voice/settings'
import type { VoiceSttAdapter, VoiceTtsAdapter } from '../core/voice/types'
import { SttUnavailableError } from '../core/voice/stt'
import { TtsUnavailableError } from '../core/voice/tts'

export interface VoiceReadinessFacts { platformAvailable: boolean; localInstalled: boolean; nanoKeyPresent: boolean; remoteAudioEnabled: boolean }
/** Facts come from actual platform reporting, local installation and protected credential presence. */
export function voiceCapabilityReadiness(facts: VoiceReadinessFacts): CapabilityReadiness {
  return {
    tts: {
      native: { ready: facts.platformAvailable, reason: facts.platformAvailable ? 'The platform reported an installed speech engine.' : 'No platform speech engine has been reported.' },
      minimax: { ready: false, reason: 'No MiniMax speech-output adapter is installed.' },
      nanogpt: { ready: false, reason: 'NanoGPT speech output is not implemented by the installed adapter.' },
      local: { ready: false, reason: 'Select Device voice for the installed platform speech engine.' },
    },
    stt: {
      local: { ready: facts.localInstalled, reason: facts.localInstalled ? 'Local Whisper is installed.' : 'Local Whisper is not installed.' },
      nanogpt: { ready: facts.nanoKeyPresent && facts.remoteAudioEnabled, reason: !facts.remoteAudioEnabled ? 'Remote-audio consent is required for NanoGPT recognition.' : !facts.nanoKeyPresent ? 'No protected NanoGPT credential is configured.' : 'NanoGPT recognition is configured with explicit remote-audio consent.' },
      minimax: { ready: false, reason: 'No MiniMax speech-recognition adapter is installed.' },
      native: { ready: false, reason: 'The installed speech-recognition adapters are Local Whisper and NanoGPT.' },
    },
  }
}
export interface EffectiveVoiceSettings {
  readonly settings: VoiceSettings
  readonly inputProvider: 'local' | 'nanogpt' | null
  readonly outputProvider: 'native' | null
  readonly inputReason: string
  readonly outputReason: string
}
export function effectiveVoiceSettings(settings: VoiceSettings, preferences: CapabilityPreferences, readiness: CapabilityReadiness): EffectiveVoiceSettings {
  const inputOrder = preferences.stt ?? DEFAULT_CAPABILITY_SELECTION.stt
  const outputOrder = preferences.tts ?? DEFAULT_CAPABILITY_SELECTION.tts
  const inputProvider = inputOrder.find((id) => (id === 'local' || (id === 'nanogpt' && settings.remoteAudioEnabled)) && readiness.stt?.[id]?.ready === true) as 'local' | 'nanogpt' | undefined
  const outputProvider = outputOrder.find((id) => id === 'native' && readiness.tts?.native?.ready === true) as 'native' | undefined
  const detail = (order: readonly ProviderId[], capability: 'stt' | 'tts', fallback: string) => order.map((id) => readiness[capability]?.[id]?.reason).find(Boolean) ?? fallback
  return {
    // Model/device/timing preferences and remote-audio consent are preserved exactly.
    settings: { ...settings, ...(inputProvider ? { inputProvider: inputProvider === 'local' ? 'local-whisper' : 'nanogpt' } : {}), ...(outputProvider ? { outputProvider: 'platform' as const } : {}) },
    inputProvider: inputProvider ?? null,
    outputProvider: outputProvider ?? null,
    inputReason: inputProvider ? 'Selected speech-recognition adapter is configured.' : `No selected speech recognition adapter is available. ${detail(inputOrder, 'stt', 'No adapter is configured.')}`,
    outputReason: outputProvider ? 'Selected platform speech output is configured.' : `No selected speech output adapter is available. ${detail(outputOrder, 'tts', 'No adapter is configured.')}`,
  }
}
/** Gate the existing dynamic host adapter: unsupported-only settings cannot execute another provider. */
export function gateVoiceInput(adapter: VoiceSttAdapter, selection: () => EffectiveVoiceSettings): VoiceSttAdapter {
  const allowed = () => {
    const selected = selection().inputProvider
    return selected !== null && (selected === 'local' ? adapter.kind === 'local' : adapter.id === 'nanogpt')
  }
  const result: VoiceSttAdapter = {
    get id() { return adapter.id }, get kind() { return adapter.kind },
    get streaming() { return allowed() && adapter.streaming },
    get availability() { return allowed() ? adapter.availability : 'configuration-required' },
    get detail() { return allowed() ? adapter.detail : selection().inputReason },
    transcribe(request) {
      if (!allowed()) return Promise.reject(new SttUnavailableError('configuration-required', selection().inputReason))
      return adapter.transcribe(request)
    },
  }
  if (adapter.stream) result.stream = (request, fragment) => {
    if (!allowed()) return Promise.reject(new SttUnavailableError('configuration-required', selection().inputReason))
    return adapter.stream!(request, fragment)
  }
  return result
}
export function gateVoiceOutput(adapter: VoiceTtsAdapter, selection: () => EffectiveVoiceSettings): VoiceTtsAdapter {
  const allowed = () => selection().outputProvider === 'native' && adapter.kind === 'platform'
  return {
    get id() { return adapter.id }, get kind() { return adapter.kind },
    get availability() { return allowed() ? adapter.availability : 'configuration-required' },
    get detail() { return allowed() ? adapter.detail : selection().outputReason },
    voices: () => allowed() ? adapter.voices() : Promise.resolve([]),
    speak(request) {
      if (!allowed()) return Promise.reject(new TtsUnavailableError('configuration-required', selection().outputReason))
      return adapter.speak(request)
    },
    // STOP and cancellation must always reach any existing utterance, even after changing selection.
    stop: () => adapter.stop(), cancel: () => adapter.cancel(),
  }
}
