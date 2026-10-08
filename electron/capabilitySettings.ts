import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { validateCapabilityPreferences, type CapabilityPreferences } from '../core/capabilities'

/** Contains IDs only: credentials are never accepted or persisted here. */
export class CapabilitySettingsStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string) {}
  async read(): Promise<CapabilityPreferences> {
    try {
      const content = await readFile(this.path, 'utf8')
      if (content.length > 16_384) return {}
      const file = JSON.parse(content) as { version?: unknown; preferences?: unknown }
      return file.version === 1 ? validateCapabilityPreferences(file.preferences) : {}
    } catch { return {} }
  }
  write(input: unknown): Promise<CapabilityPreferences> {
    // Validate before queuing, clone arrays so callers cannot alter pending writes.
    let patch: CapabilityPreferences
    try { patch = validateCapabilityPreferences(input) } catch (error) { return Promise.reject(error) }
    const operation = this.pending.then(async () => {
      const preferences = { ...await this.read(), ...patch }
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      await writeFile(temp, JSON.stringify({ version: 1, preferences }), { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.path)
      return preferences
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}
