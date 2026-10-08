import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_VOICE_SETTINGS, voiceSettingsPatch, type VoiceSettings } from '../core/voice/settings'
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
  ttsVoiceId: string | null
  ttsModel: string
  wakeProvider: VoiceWakeProvider
  autoSpeak: boolean
  proactiveAlerts: boolean
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
  proactiveAlerts: false,
})

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,160}$/
const VOICE_ID_MAX = 200
const CURRENT_KEYS = new Set([
  'inputProvider',
  'inputModel',
  'inputDeviceId',
  'outputProvider',
  'outputModel',
  'speaker',
  'remoteAudioEnabled',
  'attentionTimeoutMs',
])

function currentFields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).filter(([key]) => CURRENT_KEYS.has(key)))
}

/**
 * One non-secret voice preference store with two typed views.
 *
 * The desktop's current VoiceSettings shape is canonical. The older E.V.-style
 * VoiceConfig API is kept as a compatibility view so the wake/STT work can land
 * without creating a second voice.json schema or a second source of truth.
 */
export class VoiceConfigStore {
  current: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS }
  private legacy: VoiceConfig = { ...DEFAULT_VOICE_CONFIG }

  constructor(private readonly path: string) {}

  get legacyCurrent(): VoiceConfig {
    return this.legacyView()
  }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const current = currentFields(parsed)
      this.current = {
        ...DEFAULT_VOICE_SETTINGS,
        ...(Object.keys(current).length > 0 ? voiceSettingsPatch(current) : {}),
      }
      this.legacy = parseVoiceConfig({
        ...(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}),
        sttProvider: this.current.inputProvider === 'nanogpt' ? 'nanogpt' : undefined,
        sttModel: this.current.inputModel,
        remoteSttEnabled: this.current.remoteAudioEnabled,
        ttsProvider: this.current.outputProvider === 'platform' ? 'platform' : undefined,
      })
    } catch {
      this.current = { ...DEFAULT_VOICE_SETTINGS }
      this.legacy = { ...DEFAULT_VOICE_CONFIG }
    }
  }

  /** Current desktop settings API. */
  async write(input: unknown): Promise<VoiceSettings> {
    const next = { ...this.current, ...voiceSettingsPatch(input) }
    this.current = next
    this.legacy = parseVoiceConfig({
      ...this.legacy,
      sttProvider: next.inputProvider === 'nanogpt' ? 'nanogpt' : this.legacy.sttProvider,
      sttModel: next.inputModel,
      remoteSttEnabled: next.remoteAudioEnabled,
      ttsProvider: next.outputProvider === 'platform' ? 'platform' : this.legacy.ttsProvider,
    })
    await this.persist()
    return { ...next }
  }

  /** E.V.-style compatibility view used by the historical voice surface. */
  async readLegacy(): Promise<VoiceConfig> {
    return this.legacyView()
  }

  /** Update the E.V.-style view and map its overlapping fields to VoiceSettings. */
  async writeLegacy(patch: VoiceConfigPatch): Promise<VoiceConfig> {
    this.legacy = parseVoiceConfig({ ...this.legacy, ...patch, version: VOICE_CONFIG_VERSION })

    const mapped: Partial<VoiceSettings> = {}
    if (patch.sttProvider === 'nanogpt') mapped.inputProvider = 'nanogpt'
    if (typeof patch.sttModel === 'string') mapped.inputModel = this.legacy.sttModel
    if (typeof patch.remoteSttEnabled === 'boolean') mapped.remoteAudioEnabled = this.legacy.remoteSttEnabled
    if (patch.ttsProvider === 'platform') mapped.outputProvider = 'platform'
    if (typeof patch.ttsModel === 'string' && this.legacy.ttsModel !== 'system') mapped.outputModel = this.legacy.ttsModel

    if (Object.keys(mapped).length > 0) {
      this.current = { ...this.current, ...voiceSettingsPatch(mapped) }
    }
    await this.persist()
    return this.legacyView()
  }

  private legacyView(): VoiceConfig {
    return {
      ...this.legacy,
      version: VOICE_CONFIG_VERSION,
      sttProvider: this.current.inputProvider === 'nanogpt' ? 'nanogpt' : this.legacy.sttProvider,
      sttModel: this.current.inputModel,
      remoteSttEnabled: this.current.remoteAudioEnabled,
      ttsProvider: this.current.outputProvider === 'platform' ? this.legacy.ttsProvider : this.legacy.ttsProvider,
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const payload = {
      ...this.current,
      // Compatibility aliases for the E.V.-style voice API. They mirror the
      // canonical current settings and contain no credential or endpoint.
      sttProvider: this.legacy.sttProvider,
      sttModel: this.legacy.sttModel,
      remoteSttEnabled: this.legacy.remoteSttEnabled,
      wakeProvider: this.legacy.wakeProvider,
      autoSpeak: this.legacy.autoSpeak,
      proactiveAlerts: this.legacy.proactiveAlerts,
      legacyTtsProvider: this.legacy.ttsProvider,
      legacyTtsVoiceId: this.legacy.ttsVoiceId,
      legacyTtsModel: this.legacy.ttsModel,
    }
    await writeFile(`${this.path}.tmp`, JSON.stringify(payload), 'utf8')
    await rename(`${this.path}.tmp`, this.path)
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

  const legacyTtsProvider = record.legacyTtsProvider ?? record.ttsProvider
  const legacyTtsVoiceId = record.legacyTtsVoiceId ?? record.ttsVoiceId
  const legacyTtsModel = record.legacyTtsModel ?? record.ttsModel

  const sttProvider: VoiceSttProvider =
    record.sttProvider === 'off' || record.sttProvider === 'nanogpt'
      ? record.sttProvider
      : DEFAULT_VOICE_CONFIG.sttProvider

  const sttModel =
    typeof record.sttModel === 'string' && MODEL_ID.test(record.sttModel.trim())
      ? record.sttModel.trim()
      : DEFAULT_VOICE_CONFIG.sttModel

  const ttsProvider: VoiceTtsProvider =
    legacyTtsProvider === 'off' || legacyTtsProvider === 'platform'
      ? legacyTtsProvider
      : DEFAULT_VOICE_CONFIG.ttsProvider

  const ttsVoiceId =
    legacyTtsVoiceId === null
      ? null
      : typeof legacyTtsVoiceId === 'string' &&
          legacyTtsVoiceId.length > 0 &&
          legacyTtsVoiceId.length <= VOICE_ID_MAX
        ? legacyTtsVoiceId
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
    ttsModel: typeof legacyTtsModel === 'string' && MODEL_ID.test(legacyTtsModel.trim())
      ? legacyTtsModel.trim()
      : DEFAULT_VOICE_CONFIG.ttsModel,
    wakeProvider,
    autoSpeak: record.autoSpeak !== false,
    proactiveAlerts: record.proactiveAlerts === true,
  }
}
