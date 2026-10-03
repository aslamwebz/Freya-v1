import { safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The provider config store — the main process's secure home for the nano-gpt
 * credential and its non-secret companions.
 *
 * Two classes of value live here and they are deliberately not treated the same:
 *
 *   - `baseUrl`, `model` and `liveEnabled` are plain JSON. They are not secrets;
 *     the renderer already renders them, and a settings pane has to be able to
 *     show what is configured.
 *   - `apiKey` is a secret. It is wrapped by the OS (`safeStorage.encryptString`,
 *     i.e. DPAPI / Keychain / libsecret) and stored only as those wrapped bytes.
 *     The raw key is never written, returned to a window, logged or placed in an
 *     event. `read()` reports `hasKey` — a boolean — and nothing more.
 *
 * When `safeStorage.isEncryptionAvailable()` is false the store degrades the only
 * way that is safe: it refuses to persist the key at all and reports
 * `hasKey: false`. There is deliberately no plaintext fallback and no key stored
 * beside the data it would protect — a weaker secret silently standing in for a
 * protected one is a worse bug than a credential that has to be re-entered.
 *
 * The shape follows `electron/keyring.ts` on purpose: the same availability guard,
 * the same atomic write (temp file + rename) and the same refusal to log a value.
 */

/** Bumped only when the on-disk shape changes incompatibly. */
export const PROVIDER_CONFIG_VERSION = 1

/** The four environment names Core's nano-gpt provider reads. */
export const PROVIDER_ENV_NAMES = [
  'NANOGPT_API_KEY',
  'NANOGPT_BASE_URL',
  'NANOGPT_MODEL',
  'FREYA_ALLOW_LIVE_MODEL',
] as const

/** The non-secret half a window is allowed to see. Never carries the key. */
export interface ProviderConfig {
  baseUrl: string
  model: string
  liveEnabled: boolean
  hasKey: boolean
}

/** What a window may ask to change. `apiKey` is optional and write-only. */
export interface ProviderConfigInput {
  baseUrl?: string
  model?: string
  liveEnabled?: boolean
  apiKey?: string
}

interface ProviderConfigFile {
  version: number
  baseUrl: string
  model: string
  liveEnabled: boolean
  /** base64 of the OS-wrapped key, or null when no key is stored. */
  wrappedKey: string | null
}

const EMPTY: ProviderConfigFile = {
  version: PROVIDER_CONFIG_VERSION,
  baseUrl: '',
  model: '',
  liveEnabled: false,
  wrappedKey: null,
}

export class ProviderConfigStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** The non-secret config, plus whether a stored key can actually be opened. */
  async read(): Promise<ProviderConfig> {
    const file = (await this.readFile()) ?? EMPTY
    return this.viewOf(file, this.unwrap(file.wrappedKey))
  }

  private viewOf(file: ProviderConfigFile, key: string | null): ProviderConfig {
    return {
      baseUrl: file.baseUrl,
      model: file.model,
      liveEnabled: file.liveEnabled,
      hasKey: key !== null && key.length > 0,
    }
  }

  /**
   * Merge `input` over what is stored and persist it.
   *
   * `apiKey` is write-only: it goes straight into the OS wrapper. An explicitly
   * empty string clears the key; an omitted field leaves the stored one alone.
   * The returned view never contains the key, only `hasKey`.
   */
  async write(input: ProviderConfigInput): Promise<ProviderConfig> {
    const existing = (await this.readFile()) ?? EMPTY
    let wrappedKey = existing.wrappedKey
    if (input.apiKey !== undefined) {
      wrappedKey = input.apiKey.length > 0 ? this.wrap(input.apiKey) : null
    }
    const file: ProviderConfigFile = {
      version: PROVIDER_CONFIG_VERSION,
      baseUrl: input.baseUrl ?? existing.baseUrl,
      model: input.model ?? existing.model,
      liveEnabled: input.liveEnabled ?? existing.liveEnabled,
      wrappedKey,
    }
    await writeAtomically(this.filePath, file)
    return this.viewOf(file, this.unwrap(file.wrappedKey))
  }

  /**
   * Overlay the stored provider config onto `env`, in the exact names Core reads.
   *
   * Precedence, decided: **explicit launch environment > stored app setting >
   * `.env`.** `explicit` is the process launch environment captured before the
   * `.env` loader ran; any value in it is written back last. The stored app
   * setting is the user's explicit in-app choice, so it may override a `.env`
   * value — but only where it actually provides one.
   *
   * Overlays only the names the stored config provides, and never deletes a
   * variable. A store with no openable key leaves `NANOGPT_API_KEY` and
   * `FREYA_ALLOW_LIVE_MODEL` exactly as `.env`/the process set them, so a `.env`
   * credential and its live flag survive a store that has no credential of its
   * own. When no config has been stored at all, this does nothing.
   *
   * One file read, not two: the same record supplies both the non-secret view and
   * the wrapped key, so a concurrent write between the two cannot produce a view
   * and a key that disagree. Only the raw key bytes reach `env`, and `env` is
   * main-process memory — never a window, a log or a journal.
   */
  async applyToEnv(
    env: NodeJS.ProcessEnv,
    explicit: Record<string, string | undefined> = {},
  ): Promise<ProviderConfig> {
    const file = await this.readFile()
    if (file === null) return this.viewOf(EMPTY, null)
    const key = this.unwrap(file.wrappedKey)
    const view = this.viewOf(file, key)
    const resolved = resolveProviderEnv(env as Record<string, string | undefined>, {
      apiKey: key,
      baseUrl: file.baseUrl,
      model: file.model,
      liveEnabled: file.liveEnabled,
    })
    for (const [name, value] of Object.entries(resolved)) {
      if (value !== undefined) env[name] = value
    }
    for (const name of PROVIDER_ENV_NAMES) {
      if (explicit[name] !== undefined) env[name] = explicit[name]
    }
    return view
  }

  /**
   * Why OS secure storage cannot protect a key, or null when it can.
   *
   * The `basic_text` check is copied in shape from `electron/keyring.ts`: Electron
   * reports encryption as *available* on some Linux configurations while having
   * selected a backend whose wrapping key is a hard-coded plaintext password. That
   * is not a security boundary, so it is treated exactly like no storage at all.
   */
  private unavailableReason(): string | null {
    if (!safeStorage.isEncryptionAvailable()) {
      return 'this machine has no OS secure storage'
    }
    if (
      process.platform === 'linux' &&
      typeof safeStorage.getSelectedStorageBackend === 'function' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text'
    ) {
      return 'Electron selected the insecure basic_text storage backend'
    }
    return null
  }

  /** Wrap with the OS, or refuse. A refusal is reported to the caller by `hasKey`. */
  private wrap(value: string): string | null {
    const reason = this.unavailableReason()
    if (reason !== null) {
      // Fixed text, no value. The caller learns only that the key was not saved.
      console.warn(`[freya] the provider credential was not saved: ${reason}`)
      return null
    }
    try {
      return safeStorage.encryptString(value).toString('base64')
    } catch {
      // The OS error can contain the plaintext, so it is never formatted.
      console.warn('[freya] the provider credential was not saved: OS secure storage failed')
      return null
    }
  }

  /** Unwrap one stored key, with every failure reported as absence. */
  private unwrap(wrappedKey: string | null): string | null {
    if (wrappedKey === null) return null
    if (this.unavailableReason() !== null) return null
    try {
      const value = safeStorage.decryptString(Buffer.from(wrappedKey, 'base64'))
      return value.length > 0 ? value : null
    } catch {
      return null
    }
  }

  private async readFile(): Promise<ProviderConfigFile | null> {
    if (!existsSync(this.filePath)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch {
      // A malformed non-secret config is not worth failing a launch over; a
      // malformed *key* field is discarded, not repaired into plaintext.
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const raw = parsed as Partial<ProviderConfigFile>
    if (raw.version !== PROVIDER_CONFIG_VERSION) return null
    return {
      version: PROVIDER_CONFIG_VERSION,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      liveEnabled: raw.liveEnabled === true,
      wrappedKey:
        typeof raw.wrappedKey === 'string' && raw.wrappedKey.length > 0 ? raw.wrappedKey : null,
    }
  }
}

/**
 * The exact environment Core's nano-gpt provider reads.
 *
 * Names come from `core/model/nanogpt-provider.ts`: `NANOGPT_API_KEY`,
 * `NANOGPT_BASE_URL`, `NANOGPT_MODEL`, and `FREYA_ALLOW_LIVE_MODEL` where the
 * literal `'1'` is the explicit decision to spend inference.
 *
 * `base` seeds the result. Each name is overlaid only when the stored config
 * actually provides it, and `FREYA_ALLOW_LIVE_MODEL` is treated as provided only
 * alongside a credential: a store with no openable key must not force live
 * inference on or off, because that would silently overwrite a `.env` decision.
 */
export function resolveProviderEnv(
  base: Record<string, string | undefined>,
  stored: { apiKey: string | null; baseUrl: string; model: string; liveEnabled: boolean },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  const hasKey = stored.apiKey !== null && stored.apiKey.length > 0
  if (hasKey) {
    env.NANOGPT_API_KEY = stored.apiKey as string
    env.FREYA_ALLOW_LIVE_MODEL = stored.liveEnabled ? '1' : '0'
  }
  if (stored.baseUrl.length > 0) env.NANOGPT_BASE_URL = stored.baseUrl
  if (stored.model.length > 0) env.NANOGPT_MODEL = stored.model
  return env
}

/**
 * Write beside the target and rename into place.
 *
 * A crash or a full disk mid-write leaves the previous config intact rather than
 * a truncated file whose key can no longer be unwrapped.
 */
async function writeAtomically(path: string, file: ProviderConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.new`
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
