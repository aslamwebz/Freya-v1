import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_VOICE_SETTINGS, voiceSettingsPatch, type VoiceSettings } from '../core/voice/settings'

/** Non-secret preferences only. Credentials remain in ProviderConfigStore. */
export class VoiceConfigStore {
  current: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS }
  constructor(private readonly path: string) {}
  async load(): Promise<void> {
    try { this.current = { ...DEFAULT_VOICE_SETTINGS, ...voiceSettingsPatch(JSON.parse(await readFile(this.path, 'utf8'))) } }
    catch { this.current = { ...DEFAULT_VOICE_SETTINGS } }
  }
  async write(input: unknown): Promise<VoiceSettings> {
    const next = { ...this.current, ...voiceSettingsPatch(input) }
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(`${this.path}.tmp`, JSON.stringify(next), 'utf8')
    await rename(`${this.path}.tmp`, this.path)
    this.current = next
    return { ...next }
  }
}
