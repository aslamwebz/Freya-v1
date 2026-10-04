// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { VaultResearchSessionStore } from '../../../core/vault/repositories/research-session-store'
import type { Vault, VaultTransaction, VaultRunResult } from '../../../core/vault'
import type { SearchSession } from '../../../core/research/sessions'

class FakeVault implements VaultTransaction {
  private readonly rows = new Map<string, { domain: string; key: string; body: string; updated_at: string }>()

  exec(): void {}

  run(sql: string, params: readonly unknown[] = []): VaultRunResult {
    if (sql.startsWith('INSERT INTO vault_kv')) {
      const [domain, key, body, updatedAt] = params as [string, string, string, string]
      this.rows.set(`${domain}:${key}`, { domain, key, body, updated_at: updatedAt })
      return { changes: 1 }
    }
    if (sql.startsWith('DELETE FROM vault_kv')) {
      const [domain, key] = params as [string, string]
      return { changes: this.rows.delete(`${domain}:${key}`) ? 1 : 0 }
    }
    throw new Error('unexpected write')
  }

  get<T>(_sql: string, params: readonly unknown[] = []): T | undefined {
    const [domain, key] = params as [string, string]
    const row = this.rows.get(`${domain}:${key}`)
    return row as T | undefined
  }

  all<T>(_sql: string, params: readonly unknown[] = []): T[] {
    const [domain] = params as [string]
    return [...this.rows.values()]
      .filter((row) => row.domain === domain)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.key.localeCompare(b.key)) as T[]
  }

  transaction<T>(fn: (tx: VaultTransaction) => T): T {
    return fn(this)
  }
}

function session(id: string, updatedAt: string): SearchSession {
  return {
    sessionId: id,
    intent: {
      subject: 'cat',
      targetCount: 100,
      mediaType: 'video',
      constraints: ['in the barn'],
      exclusions: ['shorts'],
      site: 'youtube.com',
    },
    intentVersion: 2,
    state: 'paused',
    page: 3,
    results: [],
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt,
    lastError: null,
  }
}

describe("Freya's Eye Vault session store", () => {
  it('round-trips private search intent inside its own Vault domain', async () => {
    const vault = new FakeVault()
    const store = new VaultResearchSessionStore(vault as unknown as Vault)
    const input = session('eye-1', '2026-10-05T01:00:00.000Z')

    await store.put(input)
    expect(await store.read('eye-1')).toEqual(input)
    expect(store.mode).toBe('encrypted')
    expect(store.durable).toBe(true)
  })

  it('lists newest sessions first and removes only the named session', async () => {
    const vault = new FakeVault()
    const store = new VaultResearchSessionStore(vault as unknown as Vault)
    await store.put(session('older', '2026-10-05T01:00:00.000Z'))
    await store.put(session('newer', '2026-10-05T02:00:00.000Z'))

    expect((await store.list()).map((item) => item.sessionId)).toEqual(['newer', 'older'])
    expect(await store.remove('newer')).toBe(true)
    expect(await store.read('newer')).toBeNull()
    expect((await store.list()).map((item) => item.sessionId)).toEqual(['older'])
  })

  it('rejects a stored body whose session id does not match its Vault key', async () => {
    const vault = new FakeVault()
    const store = new VaultResearchSessionStore(vault as unknown as Vault)
    await store.put(session('eye-a', '2026-10-05T01:00:00.000Z'))

    // Reinsert the valid body under a different key to model corruption/tampering.
    const body = JSON.stringify(session('eye-a', '2026-10-05T01:00:00.000Z'))
    vault.run(
      `INSERT INTO vault_kv (domain, key, body, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      ['research_search_session', 'eye-b', body, '2026-10-05T01:00:00.000Z'],
    )

    await expect(store.read('eye-b')).rejects.toThrow(/does not match/)
  })
})
