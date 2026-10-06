import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { VaultError } from './errors'
import { assertVaultKey, type VaultKeyProvider } from './key-provider'
import { applyMigrations, readUserVersion, VAULT_MIGRATIONS, type VaultMigration } from './schema'
import { readCipherVersion, requireBinding, type NativeConnection, type NativeStatement, type VaultBinding } from './binding'

/**
 * THE ENCRYPTED FREYA VAULT.
 *
 * One SQLCipher database per user, holding the structured durable state of the
 * domains that have migrated onto it. It is **Core-private**: the native connection,
 * the key and the file path are fields of this object, which is constructed in the
 * main process and handed to Core-owned repositories. It is never placed on the
 * `Core` interface, never serialised into a projection, and never named by the
 * preload bridge.
 *
 * ## What opening proves
 *
 * `Vault.open` refuses to return unless it has established, at runtime:
 *
 *  1. the addon is actual SQLCipher — `PRAGMA cipher_version` answers non-empty;
 *  2. the supplied key opens the database — a wrong key, a plaintext SQLite file and
 *     a missing key all fail here;
 *  3. the schema is at the code-owned version after a transactional migration.
 *
 * Any failure closes the connection and throws. There is no plaintext fallback, no
 * "start fresh" on a wrong key, and no weaker store standing in.
 *
 * ## Transactions
 *
 * `transaction(fn)` is synchronous, like the underlying addon: SQLite is fast enough
 * that an async transaction would only create a window for interleaving. A nested
 * call reuses the outer transaction rather than opening a savepoint, because the
 * Vault's own callers are single-writer and a nested rollback would be a partial
 * commit in disguise.
 */

export interface VaultHealth {
  readonly mode: 'encrypted'
  readonly durable: true
  readonly reason: null
  /** The SQLCipher runtime version, or the fixed reason it was unavailable. */
  readonly cipherVersion: string
}

export type VaultRunResult = { readonly changes: number }

/** The synchronous surface a domain repository is given inside a transaction. */
export interface VaultTransaction {
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): VaultRunResult
  get<T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T | undefined
  all<T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T[]
}

export interface VaultOpenOptions {
  /** Absolute path to `freya.db`. The directory is created if it does not exist. */
  readonly path: string
  /** The injected source of the one random 256-bit Vault key. */
  readonly keyProvider: VaultKeyProvider
  /**
   * The selected SQLCipher-capable binding, injected by the host.
   *
   * Absent means no binding has been selected (the current, deliberate state while
   * the permissive Windows audit runs), and the Vault fails closed.
   */
  readonly binding?: VaultBinding
  /** Defaults to the Vault's own base schema. Injected for tests. */
  readonly migrations?: readonly VaultMigration[]
  readonly now?: () => Date
}

export class Vault implements VaultTransaction {
  private closed = false
  private inTransaction = false

  private constructor(
    private readonly connection: NativeConnection,
    private readonly keyHex: string,
    private readonly version: string,
  ) {}

  static async open(options: VaultOpenOptions): Promise<Vault> {
    const keyResult = await options.keyProvider.load()
    if (keyResult.key === null) {
      throw new VaultError(
        'key_unavailable',
        keyResult.reason ?? 'no Vault key is available, so the encrypted Vault cannot be opened',
      )
    }
    try {
      assertVaultKey(keyResult.key)
    } catch {
      throw new VaultError('key_invalid', 'the Vault key is not a 256-bit key and will not be used')
    }

    const migrations = options.migrations ?? VAULT_MIGRATIONS
    const clock = options.now ?? (() => new Date())
    const keyHex = Buffer.from(keyResult.key).toString('hex')
    // A selected binding is required before any filesystem effect. The key is checked
    // first so a missing key reports as such without a binding present.
    const binding = requireBinding(options.binding)

    try {
      await mkdir(dirname(options.path), { recursive: true })
    } catch {
      throw new VaultError('open_failed', 'the Vault directory could not be created')
    }

    const { Database } = binding
    let connection: NativeConnection
    try {
      connection = new Database(options.path)
    } catch {
      throw new VaultError('open_failed', 'the encrypted Vault could not be opened')
    }

    let version: string | null
    try {
      version = readCipherVersion(connection)
      if (version === null) {
        throw new VaultError(
          'not_encrypted',
          'the SQLCipher runtime did not report a cipher version, so the Vault will not be treated as encrypted',
        )
      }
      // The key never appears in an error message: the SQL that carries it is
      // executed here and any native failure is replaced with a fixed sentence.
      connection.pragma(`key = "x'${keyHex}'"`)
      // A wrong key, a plaintext database and a missing key all fail at this first
      // read. Refusing here is what makes "no plaintext fallback" a property of the
      // code rather than a promise.
      const statement = connection.prepare('SELECT count(*) AS n FROM sqlite_master')
      try {
        statement.get()
      } finally {
        statement.close()
      }
      applyMigrations(connection, migrations, clock)
    } catch (error) {
      try {
        connection.close()
      } catch {
        // The connection is already unusable; the original refusal is what matters.
      }
      if (error instanceof VaultError) throw error
      throw new VaultError('open_failed', 'the Vault could not be opened with the supplied key')
    }

    return new Vault(connection, keyHex, version)
  }

  health(): VaultHealth {
    return { mode: 'encrypted', durable: true, reason: null, cipherVersion: this.version }
  }

  cipherVersion(): string {
    return this.version
  }

  schemaVersion(): number {
    this.ensureOpen()
    return readUserVersion(this.connection)
  }

  exec(sql: string): void {
    this.ensureOpen()
    this.connection.exec(sql)
  }

  run(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): VaultRunResult {
    this.ensureOpen()
    return this.withStatement(sql, (statement) => statement.run(params))
  }

  get<T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T | undefined {
    this.ensureOpen()
    return this.withStatement(sql, (statement) => statement.get(params) as T | undefined)
  }

  all<T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T[] {
    this.ensureOpen()
    return this.withStatement(sql, (statement) => statement.all(params) as T[])
  }

  transaction<T>(fn: (tx: VaultTransaction) => T): T {
    this.ensureOpen()
    if (this.inTransaction) return fn(this)
    this.connection.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    try {
      const result = fn(this)
      this.connection.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK')
      } catch {
        // The transaction is already gone; the original failure is what matters.
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  /**
   * Write an encrypted copy of the whole Vault to `destination`.
   *
   * SQLCipher's `sqlcipher_export` copies the database into an attached, separately
   * keyed database, so the backup is encrypted with the same key and contains no
   * plaintext. The destination must not already exist, so a backup can never
   * overwrite a file it did not create.
   */
  async backupTo(destination: string): Promise<void> {
    this.ensureOpen()
    if (existsSync(destination)) {
      throw new VaultError('backup_failed', 'the backup destination already exists and was not overwritten')
    }
    try {
      await mkdir(dirname(destination), { recursive: true })
    } catch {
      throw new VaultError('backup_failed', 'the backup directory could not be created')
    }
    const escaped = destination.replace(/\\/g, '/').replace(/'/g, "''")
    try {
      this.connection.exec(`ATTACH DATABASE '${escaped}' AS vault_backup KEY "x'${this.keyHex}'"`)
      try {
        this.connection.exec(`SELECT sqlcipher_export('vault_backup')`)
        // sqlcipher_export copies schema/data but SQLite PRAGMA metadata such as
        // user_version is not part of the exported schema. Preserve the code-owned
        // migration version explicitly so a restored current backup is not treated
        // as version 0 and migrated a second time.
        this.connection.exec(`PRAGMA vault_backup.user_version = ${this.schemaVersion()}`)
      } finally {
        this.connection.exec('DETACH DATABASE vault_backup')
      }
    } catch {
      throw new VaultError('backup_failed', 'the encrypted Vault backup could not be written')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.connection.close()
    } catch {
      // Closing a connection that is already gone is not a caller-visible failure.
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new VaultError('closed', 'the Vault is closed')
  }

  private withStatement<T>(sql: string, use: (statement: NativeStatement) => T): T {
    const statement = this.connection.prepare(sql)
    try {
      return use(statement)
    } finally {
      statement.close()
    }
  }
}
