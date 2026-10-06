export interface VoiceSettings {
  inputProvider: 'nanogpt' | 'local-whisper'
  inputModel: string
  inputDeviceId: string
  outputProvider: 'platform' | 'nanogpt'
  outputModel: string
  speaker: string
  remoteAudioEnabled: boolean
  attentionTimeoutMs: number
}
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = Object.freeze({
  inputProvider: 'nanogpt', inputDeviceId: '', inputModel: 'Whisper-Large-V3', outputProvider: 'platform',
  outputModel: 'tts-1', speaker: 'alloy', remoteAudioEnabled: false, attentionTimeoutMs: 60_000,
})

/** Closed preferences. No endpoint, credential, or authority may be supplied. */
export function voiceSettingsPatch(value: unknown): Partial<VoiceSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Voice settings must be an object.')
  const input = value as Record<string, unknown>
  const patch: Partial<VoiceSettings> = {}
  for (const [key, item] of Object.entries(input)) {
    if (key === 'inputProvider' && (item === 'nanogpt' || item === 'local-whisper')) patch.inputProvider = item
    else if (key === 'outputProvider' && (item === 'platform' || item === 'nanogpt')) patch.outputProvider = item
    else if (key === 'inputDeviceId' && typeof item === 'string' && item.length <= 256 && /^[a-zA-Z0-9_-]*$/.test(item)) patch.inputDeviceId = item
    else if (key === 'remoteAudioEnabled' && typeof item === 'boolean') patch.remoteAudioEnabled = item
    else if (key === 'attentionTimeoutMs' && typeof item === 'number' && Number.isInteger(item) && item >= 5000 && item <= 300000) patch.attentionTimeoutMs = item
    else if ((key === 'inputModel' || key === 'outputModel' || key === 'speaker') && typeof item === 'string' && item.trim().length > 0 && item.length <= 200 && !Array.from(item).some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) patch[key] = item.trim()
    else throw new Error('Invalid voice setting.')
  }
  return patch
}


