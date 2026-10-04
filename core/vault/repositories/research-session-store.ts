import type { SearchSession, SearchSessionStore } from '../../research/sessions'
import { validateSearchSession } from '../../research/sessions'
import type { Vault } from '../vault'

const DOMAIN = 'research_search_session'
export const MAX_VAULT_SEARCH_SESSION_BYTES = 1024 * 1024

interface SessionRow {
  key: string
  body: string
  updated_at: string
}

/**
 * Freya's Eye session persistence on the canonical SQLCipher Vault.
 *
 * Search queries, result URLs and collections are private user data, so they
 * belong in the encrypted Vault and never in the event journal. There is no
 * plaintext fallback and no dual write.
 */
export class VaultResearchSessionStore implements SearchSessionStore {
  readonly mode = 'encrypted' as const
  readonly durable = true
  readonly reason = null

  constructor(private readonly vault: Vault) {}

  async put(session: SearchSession): Promise<void> {
    const valid = validateSearchSession(session)
    const body = JSON.stringify(valid)
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_SEARCH_SESSION_BYTES) {
      throw new Error('the search session exceeds the encrypted record limit')
    }
    this.vault.transaction((tx) => {
      tx.run(
        `INSERT INTO vault_kv (domain, key, body, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(domain, key) DO UPDATE SET
           body = excluded.body,
           updated_at = excluded.updated_at`,
        [DOMAIN, valid.sessionId, body, valid.updatedAt],
      )
    })
  }

  async read(sessionId: string): Promise<SearchSession | null> {
    const id = validateId(sessionId)
    const row = this.vault.get<SessionRow>(
      'SELECT key, body, updated_at FROM vault_kv WHERE domain = ? AND key = ?',
      [DOMAIN, id],
    )
    if (!row) return null
    return decode(row, id)
  }

  async list(): Promise<SearchSession[]> {
    const rows = this.vault.all<SessionRow>(
      'SELECT key, body, updated_at FROM vault_kv WHERE domain = ? ORDER BY updated_at DESC, key ASC LIMIT 100',
      [DOMAIN],
    )
    return rows.map((row) => decode(row, row.key))
  }

  async remove(sessionId: string): Promise<boolean> {
    const id = validateId(sessionId)
    return this.vault.transaction((tx) =>
      tx.run('DELETE FROM vault_kv WHERE domain = ? AND key = ?', [DOMAIN, id]),
    ).changes > 0
  }
}

function decode(row: SessionRow, expectedId: string): SearchSession {
  if (Buffer.byteLength(row.body, 'utf8') > MAX_VAULT_SEARCH_SESSION_BYTES) {
    throw new Error('an encrypted search session exceeds the record limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.body)
  } catch {
    throw new Error('an encrypted search session could not be parsed')
  }
  const session = validateSearchSession(parsed as SearchSession)
  if (session.sessionId !== expectedId || row.key !== expectedId) {
    throw new Error('an encrypted search session does not match its key')
  }
  return session
}

function validateId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('the search session id is invalid')
  }
  return value
}
