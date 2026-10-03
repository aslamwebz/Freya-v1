// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  StaticVaultKeyProvider,
  VAULT_MIGRATIONS,
  VAULT_SCHEMA_VERSION,
  Vault,
  VaultError,
  VaultMissionStore,
  restoreEncryptedVault,
  verifyEncryptedDatabase,
  type VaultMigration,
} from '../../../core/vault'
import type { MissionContent } from '../../../core/missions/types'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from './binding'
import { makeVaultTempDir, removeVaultTempDir } from './tmp'

const SENTINEL = 'FREYA-VAULT-PLAINTEXT-SENTINEL-4d1c'
const PLAIN_SQLITE_HEADER = 'SQLite format 3\u0000'

function keyProvider(key: Uint8Array | null, reason: string | null = null) {
  return new StaticVaultKeyProvider(key, reason)
}

function mission(id: string): MissionContent {
  return {
    missionId: id,
    title: 'A private intention',
    intent: `the body carrying ${SENTINEL}`,
    successCriteria: ['it stays encrypted'],
    createdAt: '2026-10-03T00:00:00.000Z',
  }
}

let dir = ''
let path = ''

beforeEach(async () => {
  dir = await makeVaultTempDir()
  path = join(dir, 'Freya', 'vault', 'freya.db')
})

afterEach(async () => {
  await removeVaultTempDir(dir)
})

async function openVault(
  key: Uint8Array | null = testVaultKey(),
  migrations?: readonly VaultMigration[],
): Promise<Vault> {
  return Vault.open({
    path,
    keyProvider: keyProvider(key),
    binding: await loadTestBinding(),
    ...(migrations ? { migrations } : {}),
  })
}

describe.skipIf(!bindingAvailable)('Vault runtime encryption proof', () => {
  it('reports a non-empty SQLCipher runtime version', async () => {
    const vault = await openVault()
    try {
      expect(vault.cipherVersion().length).toBeGreaterThan(0)
      expect(vault.health()).toEqual({
        mode: 'encrypted',
        durable: true,
        reason: null,
        cipherVersion: vault.cipherVersion(),
      })
      expect(vault.schemaVersion()).toBe(VAULT_SCHEMA_VERSION)
    } finally {
      vault.close()
    }
  })

  it('creates a database whose raw bytes contain no planted plaintext sentinel', async () => {
    const vault = await openVault()
    try {
      const store = new VaultMissionStore(vault)
      await store.write(mission('m-1'))
    } finally {
      vault.close()
    }
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path)
    expect(raw.length).toBeGreaterThan(0)
    expect(raw.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)
    expect(raw.subarray(0, 16).toString('latin1')).not.toBe(PLAIN_SQLITE_HEADER)
  })

  it('reopens deterministically with the correct key across a restart', async () => {
    const first = await openVault()
    try {
      await new VaultMissionStore(first).write(mission('m-restart'))
    } finally {
      first.close()
    }
    const second = await openVault()
    try {
      const result = await new VaultMissionStore(second).read('m-restart')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.intent).toContain(SENTINEL)
    } finally {
      second.close()
    }
  })

  it('fails safely with a wrong key and never names the key', async () => {
    const good = await openVault()
    good.close()
    const wrong = testVaultKey('freya-test-vault-key-wrong')
    let caught: unknown
    try {
      await openVault(wrong)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(VaultError)
    expect((caught as VaultError).code).toBe('open_failed')
    const message = (caught as Error).message
    expect(message).not.toContain(Buffer.from(wrong).toString('hex'))
    expect(message).not.toContain(Buffer.from(testVaultKey()).toString('hex'))
  })

  it('fails closed with no key and creates no plaintext database', async () => {
    let caught: unknown
    try {
      await openVault(null)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(VaultError)
    expect((caught as VaultError).code).toBe('key_unavailable')
    expect(existsSync(path)).toBe(false)
  })

  it('rejects a key that is not 256 bits before touching the filesystem', async () => {
    let caught: unknown
    try {
      await openVault(new Uint8Array(16))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(VaultError)
    expect((caught as VaultError).code).toBe('key_invalid')
    expect(existsSync(path)).toBe(false)
  })
})

describe.skipIf(!bindingAvailable)('Vault transactions', () => {
  it('commits a transaction atomically', async () => {
    const vault = await openVault()
    try {
      vault.transaction((tx) => {
        tx.run('INSERT INTO vault_meta (key, value) VALUES (?, ?)', ['a', '1'])
        tx.run('INSERT INTO vault_meta (key, value) VALUES (?, ?)', ['b', '2'])
      })
      const rows = vault.all<{ key: string }>('SELECT key FROM vault_meta ORDER BY key')
      expect(rows.map((row) => row.key)).toEqual(['a', 'b', 'created_at'])
    } finally {
      vault.close()
    }
  })

  it('rolls back a failed transaction and leaves no partial write', async () => {
    const vault = await openVault()
    try {
      expect(() =>
        vault.transaction((tx) => {
          tx.run('INSERT INTO vault_meta (key, value) VALUES (?, ?)', ['partial', 'x'])
          throw new Error('boom')
        }),
      ).toThrow('boom')
      const row = vault.get<{ key: string }>('SELECT key FROM vault_meta WHERE key = ?', ['partial'])
      expect(row).toBeUndefined()
    } finally {
      vault.close()
    }
  })
})

describe.skipIf(!bindingAvailable)('Vault schema migrations', () => {
  it('rolls back a failing migration and leaves the previous schema version intact', async () => {
    const failing: VaultMigration = {
      version: VAULT_SCHEMA_VERSION + 1,
      name: 'failing',
      up: (context) => {
        context.exec('CREATE TABLE should_not_survive (id INTEGER)')
        throw new Error('migration exploded')
      },
    }
    let caught: unknown
    try {
      await openVault(testVaultKey(), [...VAULT_MIGRATIONS, failing])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(VaultError)
    expect((caught as VaultError).code).toBe('migration_failed')

    const reopened = await openVault()
    try {
      expect(reopened.schemaVersion()).toBe(VAULT_SCHEMA_VERSION)
      const table = reopened.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['should_not_survive'],
      )
      expect(table).toBeUndefined()
    } finally {
      reopened.close()
    }
  })
})

describe.skipIf(!bindingAvailable)('Vault encrypted backup and restore', () => {
  it('writes an encrypted backup with no plaintext sentinel and restores it', async () => {
    const backupPath = join(dir, 'backups', 'freya.backup.db')
    const restoredPath = join(dir, 'restored', 'freya.db')

    const vault = await openVault()
    try {
      await new VaultMissionStore(vault).write(mission('m-backup'))
      await vault.backupTo(backupPath)
    } finally {
      vault.close()
    }

    const raw = readFileSync(backupPath)
    expect(raw.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)
    expect(raw.subarray(0, 16).toString('latin1')).not.toBe(PLAIN_SQLITE_HEADER)
    await expect(verifyEncryptedDatabase(backupPath, testVaultKey(), await loadTestBinding())).resolves.toEqual(
      expect.any(String),
    )

    await restoreEncryptedVault({
      backupPath,
      livePath: restoredPath,
      keyProvider: keyProvider(testVaultKey()),
      binding: await loadTestBinding(),
    })
    const restored = await Vault.open({
      path: restoredPath,
      keyProvider: keyProvider(testVaultKey()),
      binding: await loadTestBinding(),
    })
    try {
      const result = await new VaultMissionStore(restored).read('m-backup')
      expect(result.ok).toBe(true)
    } finally {
      restored.close()
    }
  })

  it('refuses to restore a backup that the key cannot open', async () => {
    const backupPath = join(dir, 'backups', 'freya.backup.db')
    const livePath = join(dir, 'live', 'freya.db')
    const vault = await openVault()
    try {
      await vault.backupTo(backupPath)
    } finally {
      vault.close()
    }
    await expect(
      restoreEncryptedVault({
        backupPath,
        livePath,
        keyProvider: keyProvider(testVaultKey('a-different-vault-key')),
        binding: await loadTestBinding(),
      }),
    ).rejects.toBeInstanceOf(VaultError)
    expect(existsSync(livePath)).toBe(false)
  })
})
