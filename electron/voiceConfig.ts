import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_REMOTE_STT_MODEL, type VoiceSttRuntimeConfig } from './voiceSttProvider'

export const VOICE_CONFIG_VERSION = 1
export const VOICE_WAKE_PHRASE = 'Freya'
export const VOICE_FOLLOW_UP_WINDOW_MS = 45_000

export type VoiceSttProvider = 'off' | 'nanogpt'
export type VoiceTtsProvider = 'off' | 'platform'
export type VoiceWakeProvider = 'off' | 'selected-stt'

export interface VoiceConfig {
  version: typeof VOICE_CONFIG_VERSION
  sttProvider: VoiceSttProvider
  sttModel: string
  remoteSttEnabled: boolean
  ttsProvider: VoiceTtsProvider
  /** Platform voice id. Null means the operating-system default. */
  ttsVoiceId: string | null
  /** Reserved model label for future provider TTS. Platform TTS reports "system". */
  ttsModel: string
  /** Hands-free never auto-arms on launch; this selects how an explicit arm works. */
  wakeProvider: VoiceWakeProvider
  autoSpeak: boolean
}

export type VoiceConfigPatch = Partial<Omit<VoiceConfig, 'version'>>

export const DEFAULT_VOICE_CONFIG: VoiceConfig = Object.freeze({
  version: VOICE_CONFIG_VERSION,
  sttProvider: 'nanogpt',
  sttModel: DEFAULT_REMOTE_STT_MODEL,
  remoteSttEnabled: false,
  ttsProvider: 'platform',
  ttsVoiceId: null,
  ttsModel: 'system',
  wakeProvider: 'off',
  autoSpeak: true,
})

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,160}$/
const VOICE_ID_MAX = 200

export class VoiceConfigStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<VoiceConfig> {
    if (!existsSync(this.filePath)) return { ...DEFAULT_VOICE_CONFIG }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return parseVoiceConfig(parsed)
    } catch {
      return { ...DEFAULT_VOICE_CONFIG }
    }
  }

  async write(patch: VoiceConfigPatch): Promise<VoiceConfig> {
    const current = await this.read()
    const candidate = parseVoiceConfig({ ...current, ...patch, version: VOICE_CONFIG_VERSION })
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.new`
    await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporary, this.filePath)
    return candidate
  }
}

export function sttRuntimeConfig(config: VoiceConfig): VoiceSttRuntimeConfig {
  return {
    provider: config.sttProvider,
    model: config.sttModel,
    remoteEnabled: config.remoteSttEnabled,
  }
}

function parseVoiceConfig(input: unknown): VoiceConfig {
  const record = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}

  const sttProvider: VoiceSttProvider =
    record.sttProvider === 'off' || record.sttProvider === 'nanogpt'
      ? record.sttProvider
      : DEFAULT_VOICE_CONFIG.sttProvider

  const sttModel =
    typeof record.sttModel === 'string' && MODEL_ID.test(record.sttModel.trim())
      ? record.sttModel.trim()
      : DEFAULT_VOICE_CONFIG.sttModel

  const ttsProvider: VoiceTtsProvider =
    record.ttsProvider === 'off' || record.ttsProvider === 'platform'
      ? record.ttsProvider
      : DEFAULT_VOICE_CONFIG.ttsProvider

  const ttsVoiceId =
    record.ttsVoiceId === null
      ? null
      : typeof record.ttsVoiceId === 'string' &&
          record.ttsVoiceId.length > 0 &&
          record.ttsVoiceId.length <= VOICE_ID_MAX
        ? record.ttsVoiceId
        : DEFAULT_VOICE_CONFIG.ttsVoiceId

  const wakeProvider: VoiceWakeProvider =
    record.wakeProvider === 'off' || record.wakeProvider === 'selected-stt'
      ? record.wakeProvider
      : DEFAULT_VOICE_CONFIG.wakeProvider

  return {
    version: VOICE_CONFIG_VERSION,
    sttProvider,
    sttModel,
    remoteSttEnabled: record.remoteSttEnabled === true,
    ttsProvider,
    ttsVoiceId,
    ttsModel: 'system',
    wakeProvider,
    autoSpeak: record.autoSpeak !== false,
  }
}
