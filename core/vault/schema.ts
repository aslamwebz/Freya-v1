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

export const VAULT_SCHEMA_VERSION = 3

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
  {
    version: 2,
    name: 'world-evidence',
    up: (context) => {
      // Phase 22's evidence ledger, in the same encrypted database.
      //
      // One row per admitted piece of evidence, in its own table rather than in a
      // `vault_kv` blob, because this domain's durable shape *is* relational: replay
      // order is a column, a withdrawal is a row that names an older row, and a
      // revision names the record it replaces. All three are properties the fold and
      // the withdrawal path depend on, and none of them survive being packed into one
      // opaque body.
      //
      // Every scalar the fold and the codec need is a real column so a query never has
      // to parse JSON to decide whether a record is legal. Only the three genuinely
      // nested claims — the entity, the relation and the withdrawal — are stored as
      // canonical JSON, because they are optional sub-documents of a record rather
      // than fields of a row. They are re-validated on read exactly like everything
      // else, so a stored sub-document is never trusted because it parsed.
      //
      // There is deliberately no `authority`, `capability`, `permission`, `grant` or
      // `trust` column here, and the evidence `source` column records *evidential*
      // provenance only. Nothing in this schema can express permission, so no row
      // written through it can widen what Freya may do.
      context.exec(
        `CREATE TABLE IF NOT EXISTS world_evidence (
           evidence_id      TEXT PRIMARY KEY,
           sequence         INTEGER NOT NULL,
           kind             TEXT NOT NULL,
           channel          TEXT NOT NULL,
           recorded_at      TEXT NOT NULL,
           observed_at      TEXT NOT NULL,
           source           TEXT NOT NULL,
           actor            TEXT NOT NULL,
           source_ref       TEXT,
           sensitivity      TEXT NOT NULL,
           epistemic        TEXT NOT NULL,
           confidence       TEXT NOT NULL,
           evidence_summary TEXT,
           supersedes       TEXT,
           entity           TEXT,
           relation         TEXT,
           withdrawal       TEXT
         )`,
      )
      // Replay order. `evidence_id` is the tie-break so that an ordering is total even
      // if a hand-edited row ever claimed a sequence another row already holds.
      context.exec(
        'CREATE INDEX IF NOT EXISTS world_evidence_sequence ON world_evidence (sequence, evidence_id)',
      )
      // Withdrawals and revisions are looked up by what they name, not by scanning.
      context.exec('CREATE INDEX IF NOT EXISTS world_evidence_supersedes ON world_evidence (supersedes)')
      // Non-secret bookkeeping for this domain: the highest evidence counter the Core
      // had issued when the ledger was last committed, so a restart re-seeds exactly
      // rather than from whatever the retained rows happen to say.
      context.exec('CREATE TABLE IF NOT EXISTS world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      context.run('INSERT OR IGNORE INTO world_meta (key, value) VALUES (?, ?)', [
        'evidence_sequence',
        '0',
      ])
    },
  },  {
    version: 3,
    name: 'conversation-relational',
    up: (context) => {
      // Conversation bodies are private user data and therefore live in the same
      // SQLCipher Vault as the other structured durable domains. They are relational
      // rather than packed into vault_kv because ordering, turn outcomes and message
      // ownership are first-class query properties of a conversation.
      context.exec(
        `CREATE TABLE IF NOT EXISTS chat_conversations (
           conversation_id TEXT PRIMARY KEY,
           title           TEXT NOT NULL,
           created_at      TEXT NOT NULL,
           updated_at      TEXT NOT NULL
         )`,
      )
      context.exec(
        'CREATE INDEX IF NOT EXISTS chat_conversations_updated ON chat_conversations (updated_at DESC, conversation_id)',
      )
      context.exec(
        `CREATE TABLE IF NOT EXISTS chat_messages (
           message_id      TEXT PRIMARY KEY,
           conversation_id TEXT NOT NULL,
           role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
           content         TEXT NOT NULL,
           created_at      TEXT NOT NULL,
           turn_id         TEXT NOT NULL
         )`,
      )
      context.exec(
        'CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages (conversation_id, created_at, message_id)',
      )
      context.exec(
        `CREATE TABLE IF NOT EXISTS chat_turns (
           turn_id              TEXT PRIMARY KEY,
           conversation_id      TEXT NOT NULL,
           user_message_id      TEXT NOT NULL,
           assistant_message_id TEXT,
           outcome              TEXT NOT NULL CHECK (outcome IN ('pending', 'completed', 'denied', 'cancelled', 'failed', 'interrupted')),
           started_at           TEXT NOT NULL,
           ended_at             TEXT,
           request_id           TEXT,
           provider_id          TEXT,
           model                TEXT,
           reason               TEXT
         )`,
      )
      context.exec(
        'CREATE INDEX IF NOT EXISTS chat_turns_conversation ON chat_turns (conversation_id, started_at, turn_id)',
      )
    },
  },

])
