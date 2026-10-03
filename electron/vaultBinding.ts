import BetterSqlite3 from 'better-sqlite3'
import type {
  NativeConnection,
  NativeStatement,
  VaultBinding,
} from '../core/vault/binding'

/**
 * Production adapter for Freya's pinned SQLCipher build.
 *
 * The JS API is MIT-licensed better-sqlite3. The native binding path is supplied
 * explicitly so neither Node nor Electron can silently load an ordinary SQLite
 * prebuild. The bundled binary is compiled from SQLCipher 4.19.0 + OpenSSL 3.5.9.
 */
export function createFreyaVaultBinding(nativeBindingPath: string): VaultBinding {
  class FreyaDatabase implements NativeConnection {
    private readonly database: BetterSqlite3.Database

    constructor(path = ':memory:') {
      this.database = new BetterSqlite3(path, { nativeBinding: nativeBindingPath })
    }

    exec(sql: string): void {
      this.database.exec(sql)
    }

    pragma(source: string, options?: { readonly simple?: true }): unknown {
      return this.database.pragma(source, options)
    }

    prepare(sql: string): NativeStatement {
      return new FreyaStatement(this.database.prepare(sql))
    }

    close(): void {
      this.database.close()
    }
  }

  return {
    name: 'freya-sqlcipher-4.19.0-openssl-3.5.9',
    Database: FreyaDatabase,
  }
}

class FreyaStatement implements NativeStatement {
  constructor(private readonly statement: BetterSqlite3.Statement) {}

  run(params?: readonly unknown[] | Readonly<Record<string, unknown>>): {
    changes: number
    lastInsertRowid: number
  } {
    const result = params === undefined
      ? this.statement.run()
      : this.statement.run(params as never)
    const rowId = result.lastInsertRowid
    if (typeof rowId === 'bigint' && !Number.isSafeInteger(Number(rowId))) {
      throw new RangeError('Vault insert row id exceeds JavaScript safe integer range')
    }
    return { changes: result.changes, lastInsertRowid: Number(rowId) }
  }

  get(params?: readonly unknown[] | Readonly<Record<string, unknown>>): unknown {
    return params === undefined
      ? this.statement.get()
      : this.statement.get(params as never)
  }

  all(params?: readonly unknown[] | Readonly<Record<string, unknown>>): unknown[] {
    return params === undefined
      ? this.statement.all()
      : this.statement.all(params as never)
  }

  // better-sqlite3 owns statement lifetime with the connection; there is no public
  // finalize method. Keeping this no-op satisfies Core's narrow portable seam.
  close(): void {}
}
