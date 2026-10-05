/**
 * THE KEYRING-BACKED TOKEN STORE — the only place a connector token lives.
 *
 * Each connector's whole record is encrypted by the OS (`safeStorage`) and
 * written to one file, atomically, mode 0600. The file is worthless on another
 * machine or another account, exactly like the keyring itself.
 *
 * ## Fail-closed
 *
 * When `isEncryptionAvailable()` is false — or Electron selected the
 * `basic_text` backend, whose wrapping key is a hard-coded plaintext password —
 * the factory returns a `NullConnectorTokenStore`. There is deliberately no
 * fallback that writes a token in plaintext: a connector whose token cannot be
 * stored securely stays `credentials-missing`.
 *
 * ## Never logged
 *
 * Nothing here formats a token. A load failure returns null with a fixed
 * reason; a save failure throws `TokenStoreUnavailableError` with a fixed
 * message. `redactTokenRecord` is the only way a record leaves this module for
 * a diagnostic, and it removes both tokens.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  NullConnectorTokenStore,
  TokenStoreUnavailableError,
  type ConnectorTokenRecord,
  type ConnectorTokenStore,
} from '../../core/connectors/token-store'
import type { ConnectorKind } from '../../core/connectors/types'

/** The slice of Electron's `safeStorage` this module uses. */
export interface SecureStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?: () => string
}

export interface SecureTokenStoreOptions {
  safeStorage: SecureStorageLike
  /** Where the encrypted token file lives, derived from the Core data path. */
  filePath: string
  now?: () => Date
}

interface TokenFile {
  version: number
  protection: string
  /** One independently encrypted record per connector, base64. */
  records: Partial<Record<ConnectorKind, string>>
}

export const CONNECTOR_TOKEN_FILE_VERSION = 1

/**
 * Why no secure storage is available, or null when it is.
 *
 * `basic_text` is checked explicitly because Electron reports encryption as
 * available on Linux while deriving the wrapping key from a hard-coded
 * plaintext password. A token protected by it is a token anyone with the file
 * can read.
 */
function unavailableReason(safeStorage: SecureStorageLike): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    return 'this machine has no OS secure storage available, so connector credentials are not persisted'
  }
  if (
    process.platform === 'linux' &&
    typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    return 'Electron selected the insecure basic_text storage backend, so connector credentials are not persisted'
  }
  return null
}

function describeProtection(safeStorage: SecureStorageLike): string {
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    return safeStorage.getSelectedStorageBackend()
  }
  return process.platform
}

/**
 * Build the token store for this machine.
 *
 * Returns a fail-closed store when no secure storage exists, so the caller
 * never has to special-case the absence — it simply cannot save a token.
 */
export function createSecureTokenStore(options: SecureTokenStoreOptions): ConnectorTokenStore {
  const reason = unavailableReason(options.safeStorage)
  if (reason !== null) return new NullConnectorTokenStore(reason)
  return new FileTokenStore(options)
}

class FileTokenStore implements ConnectorTokenStore {
  readonly kind = 'secure' as const
  readonly reason: string | null = null
  private readonly safeStorage: SecureStorageLike
  private readonly filePath: string
  private readonly now: () => Date

  constructor(options: SecureTokenStoreOptions) {
    this.safeStorage = options.safeStorage
    this.filePath = options.filePath
    this.now = options.now ?? (() => new Date())
  }

  private async readFile(): Promise<TokenFile | null> {
    if (!existsSync(this.filePath)) return null
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<TokenFile>
      if (parsed.version !== CONNECTOR_TOKEN_FILE_VERSION) return null
      return { version: parsed.version, protection: parsed.protection ?? '', records: parsed.records ?? {} }
    } catch {
      // A malformed file is not an empty one; report nothing and let the
      // connector stay credentials-missing rather than inventing a token.
      return null
    }
  }

  async load(connector: ConnectorKind): Promise<ConnectorTokenRecord | null> {
    const file = await this.readFile()
    if (file === null) return null
    const wrapped = file.records[connector]
    if (typeof wrapped !== 'string' || wrapped.length === 0) return null
    try {
      const plaintext = this.safeStorage.decryptString(Buffer.from(wrapped, 'base64'))
      if (plaintext.length === 0) return null
      const record = JSON.parse(plaintext) as ConnectorTokenRecord
      if (record.connector !== connector) return null
      return record
    } catch {
      // Never surface the underlying error: it can contain the value.
      return null
    }
  }

  async save(record: ConnectorTokenRecord): Promise<void> {
    const existing = (await this.readFile()) ?? { version: CONNECTOR_TOKEN_FILE_VERSION, protection: '', records: {} }
    const encrypted = this.safeStorage.encryptString(JSON.stringify(record)).toString('base64')
    const records = { ...existing.records, [record.connector]: encrypted }
    const file: TokenFile = {
      version: CONNECTOR_TOKEN_FILE_VERSION,
      protection: describeProtection(this.safeStorage),
      records,
    }
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.new`
      await writeFile(temporary, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.filePath)
    } catch {
      throw new TokenStoreUnavailableError('the connector credential could not be written by OS secure storage')
    }
    void this.now
  }

  async clear(connector: ConnectorKind): Promise<void> {
    const existing = await this.readFile()
    if (existing === null) return
    const records = { ...existing.records }
    delete records[connector]
    const file: TokenFile = {
      version: CONNECTOR_TOKEN_FILE_VERSION,
      protection: describeProtection(this.safeStorage),
      records,
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.new`
    await writeFile(temporary, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}
