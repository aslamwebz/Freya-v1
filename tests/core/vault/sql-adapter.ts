import { DatabaseSync } from 'node:sqlite'

/**
 * A TEST-ONLY SQL adapter over Node's built-in SQLite.
 *
 * ## Why this exists, and what it is not
 *
 * Binding selection is **blocked pending an isolated permissive (non-copyleft) Windows
 * audit**, so no SQLCipher-capable binding is named in this repository and none is a
 * dependency. That is correct, and it has one bad consequence: every assertion about
 * the world ledger's SQL — that migration 2 really creates the table, that a commit is
 * one transaction, that a row round-trips through typed columns, that eviction leaves
 * no orphan, that a nested claim survives as JSON and comes back re-validated — would
 * otherwise be *skipped*, because `Vault.open` refuses to run without a binding.
 *
 * This adapter lets those assertions run. It is reached **only** by constructing the
 * repositories directly against a `Vault`-shaped harness; it is never a production
 * path, never a `VaultBinding` the Vault would accept, and it is not a fallback for
 * anything.
 *
 * ## The one thing it cannot prove
 *
 * Encryption. Node's SQLite is plain SQLite: `PRAGMA cipher_version` does not answer,
 * which is exactly the signal `Vault.open` uses to refuse a non-SQLCipher runtime. So
 * this harness deliberately does **not** go through `Vault.open`, and it proves nothing
 * about what is on disk. The encryption proofs — raw sentinel absent, wrong key refused,
 * no database without a key — stay gated on `FREYA_VAULT_BINDING_MODULE` and run against
 * whatever the audit selects. Nothing here weakens that gate; it fills in a different
 * one.
 */

export interface SqlStatement {
  run(params?: readonly unknown[] | Readonly<Record<string, unknown>>): { changes: number }
  get(params?: readonly unknown[] | Readonly<Record<string, unknown>>): unknown
  all(params?: readonly unknown[] | Readonly<Record<string, unknown>>): unknown[]
  close(): void
}

export interface SqlConnection {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  /** Enough of the Vault's connection surface for the schema reader. */
  pragma(source: string, options?: { readonly simple?: true }): unknown
  close(): void
}

/** An in-memory database, so nothing is written to disk by a test double. */
export function openMemoryConnection(): SqlConnection {
  const db = new DatabaseSync(':memory:')
  return {
    exec(sql) {
      db.exec(sql)
    },
    prepare(sql) {
      const statement = db.prepare(sql)
      // `node:sqlite` takes anonymous parameters spread positionally and named
      // parameters as one object, which is the same split the Vault's callers already
      // make.
      type BindValue = string | number | bigint | null | Uint8Array
      const bind = (
        params?: readonly unknown[] | Readonly<Record<string, unknown>>,
      ): BindValue[] | Record<string, BindValue> => {
        if (params === undefined) return []
        if (Array.isArray(params)) return [...params] as BindValue[]
        return params as Record<string, BindValue>
      }
      return {
        run: (params) => {
          const values = bind(params)
          const result = Array.isArray(values)
            ? statement.run(...values)
            : statement.run(values)
          return { changes: Number(result.changes) }
        },
        get: (params) => {
          const values = bind(params)
          const row = Array.isArray(values) ? statement.get(...values) : statement.get(values)
          return row ?? undefined
        },
        all: (params) => {
          const values = bind(params)
          return Array.isArray(values) ? statement.all(...values) : statement.all(values)
        },
        // `node:sqlite` exposes no explicit statement close.
        close: () => undefined,
      }
    },
    pragma(source, options) {
      const statement = db.prepare(`PRAGMA ${source}`)
      try {
        const row = statement.get()
        if (options?.simple !== true) return [row]
        const value = row === undefined ? undefined : Object.values(row as Record<string, unknown>)[0]
        return value
      } finally {
        // `node:sqlite` has no `StatementSync.close`; letting it be collected is fine
        // for a statement that has already run to completion.
      }
    },
    close: () => db.close(),
  }
}