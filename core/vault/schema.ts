import { VaultError } from './errors'
import type { NativeConnection } from './binding'

/**
 * VERSIONED, TRANSACTIONAL SCHEMA MIGRATIONS.
 *
 * The Vault schema is owned by code, not by a model and not by Freya. Each migration
 * is a numbered, named step that runs **inside one transaction**: either the whole
 * pending set commits, or none of it does. SQLite makes DDL transactional, so a
 * migration that throws halfway leaves `PRAGMA user_version` and the tables exactly
 * as they were. There is no partial-schema state and no "best effort" upgrade.
 *
 * The version lives in SQLite's own `user_version`, which is a per-database integer
 * with no extra table to bootstrap.
 */

export const VAULT_SCHEMA_VERSION = 1

export interface VaultMigrationContext {
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[]): { changes: number }
  get<T>(sql: string, params?: readonly unknown[]): T | undefined
  now(): Date
}

export interface VaultMigration {
  readonly version: number
  readonly name: string
  readonly up: (context: VaultMigrationContext) => void
}

function contextFor(connection: NativeConnection, now: () => Date): VaultMigrationContext {
  return {
    exec: (sql) => connection.exec(sql),
    run: (sql, params) => {
      const statement = connection.prepare(sql)
      try {
        return statement.run(params)
      } finally {
        statement.close()
      }
    },
    get: <T>(sql: string, params?: readonly unknown[]): T | undefined => {
      const statement = connection.prepare(sql)
      try {
        return statement.get(params) as T | undefined
      } finally {
        statement.close()
      }
    },
    now,
  }
}

export function readUserVersion(connection: NativeConnection): number {
  const value = connection.pragma('user_version', { simple: true })
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return 0
}

/**
 * Apply every pending migration in one transaction.
 *
 * Migrations must be uniquely numbered and are applied in ascending order. A
 * duplicate version is a programming error and is refused before anything runs,
 * because two migrations claiming the same version is how a schema silently forks.
 */
export function applyMigrations(
  connection: NativeConnection,
  migrations: readonly VaultMigration[],
  now: () => Date,
): number {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (previous === undefined || current === undefined) continue
    if (current.version === previous.version) {
      throw new VaultError('migration_failed', `two Vault migrations claim version ${current.version}`)
    }
  }

  const current = readUserVersion(connection)
  const pending = ordered.filter((migration) => migration.version > current)
  if (pending.length === 0) return current

  const context = contextFor(connection, now)
  connection.exec('BEGIN IMMEDIATE')
  try {
    for (const migration of pending) {
      migration.up(context)
      // The integer is code-owned, never user input; there is no parameter binding
      // for PRAGMA, so it is interpolated only after the loop above proved it is a
      // finite migration version.
      connection.exec(`PRAGMA user_version = ${migration.version}`)
    }
    connection.exec('COMMIT')
  } catch {
    try {
      connection.exec('ROLLBACK')
    } catch {
      // The transaction is already gone; the original failure is what matters.
    }
    const failing = pending[pending.length - 1]
    const version = failing === undefined ? current : failing.version
    throw new VaultError(
      'migration_failed',
      `the Vault schema migration to version ${version} failed and was rolled back`,
    )
  }
  return readUserVersion(connection)
}

/**
 * The Vault's own base schema.
 *
 * `vault_meta` holds non-secret bookkeeping. `vault_kv` is the generic, domain-tagged
 * record table that lets a bounded migration slice store one domain's records inside
 * the single encrypted database without inventing a bespoke table per domain. A
 * domain's *bodies* live here; secrets and connector tokens do not — those stay in
 * the OS keyring/secrets layer, never in ordinary Vault tables.
 */
export const VAULT_MIGRATIONS: readonly VaultMigration[] = Object.freeze([
  {
    version: 1,
    name: 'vault-base',
    up: (context) => {
      context.exec(
        'CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      )
      context.exec(
        `CREATE TABLE IF NOT EXISTS vault_kv (
           domain TEXT NOT NULL,
           key TEXT NOT NULL,
           body TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY (domain, key)
         )`,
      )
      context.run('INSERT OR IGNORE INTO vault_meta (key, value) VALUES (?, ?)', [
        'created_at',
        context.now().toISOString(),
      ])
    },
  },
])
