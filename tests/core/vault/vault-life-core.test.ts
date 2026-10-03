// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import { lifeOwnerScope } from '../../../core/testing'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../../core/vault'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from './binding'
import { makeVaultTempDir, removeVaultTempDir } from './tmp'

/**
 * Life History on the encrypted Vault.
 *
 * Life entries are written to the one encrypted SQLCipher database under
 * `domain = 'life'`, survive a restart, and leave no plaintext sentinel in the
 * raw database bytes. A missing Vault key fails closed to an explicitly
 * ephemeral store and never creates a database.
 */
const SENTINEL = 'FREYA_VAULT_LIFE_SENTINEL_91b3'

let dir = ''
let core: Core | undefined
let seq = 0

beforeEach(async () => {
  dir = await makeVaultTempDir()
  seq = 0
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = undefined
  await removeVaultTempDir(dir)
})

async function startVaultCore(
  vaultPath: string,
  keyProvider: StaticVaultKeyProvider,
): Promise<Core> {
  const instance = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    vault: { path: vaultPath, keyProvider, binding: await loadTestBinding() },
  })
  await instance.start()
  core = instance
  return instance
}

async function send(instance: Core, command: string, payload?: Record<string, unknown>) {
  seq += 1
  return instance.handleCommand({
    command,
    requestId: `r-${seq}`,
    ...(payload === undefined ? {} : { payload }),
  } as never)
}

describe.skipIf(!bindingAvailable)('Life History on the encrypted Vault', () => {
  it('stores entries in the Vault, leaves no plaintext, and survives a restart', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const key = testVaultKey()

    const first = await startVaultCore(vaultPath, new StaticVaultKeyProvider(key))
    const scope = lifeOwnerScope(first)
    const outcome = await scope.record({
      kind: 'episode',
      title: 'A day at the observatory',
      summary: 'The owner visited the observatory.',
      body: `The owner spent the afternoon at the observatory. ${SENTINEL}`,
      salience: 'medium',
      derivation: 'owner-stated',
      confidence: 'high',
      sourceDomain: 'owner',
      sourceId: null,
      actor: 'owner',
      references: [],
      occurredAt: '2026-03-01T12:00:00.000Z',
      tags: ['observatory'],
    })
    expect(outcome.outcome).toBe('recorded')
    const entryId = outcome.entry!.entryId

    const read = await send(first, 'life.entry.read', { entryId })
    expect(read.life?.entry?.body).toContain(SENTINEL)

    await first.stop('restart')
    core = undefined

    expect(existsSync(vaultPath)).toBe(true)
    expect(readFileSync(vaultPath).includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)

    const second = await startVaultCore(vaultPath, new StaticVaultKeyProvider(key))
    const again = await send(second, 'life.entry.read', { entryId })
    expect(again.life?.entry?.body).toContain(SENTINEL)
    const projection = second.life()
    expect(projection.persistence.durable).toBe(true)
    expect(projection.counts.total).toBe(1)
  })

  it('fails closed to ephemeral with no key and creates no database', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const instance = await startVaultCore(
      vaultPath,
      new StaticVaultKeyProvider(null, 'no Vault key is available on this machine'),
    )
    const scope = lifeOwnerScope(instance)
    const outcome = await scope.record({
      kind: 'episode',
      title: 'Held in memory only',
      summary: 'This will not survive a restart.',
      body: 'ephemeral',
      salience: 'low',
      derivation: 'owner-stated',
      confidence: 'high',
      sourceDomain: 'owner',
      sourceId: null,
      actor: 'owner',
      references: [],
      occurredAt: null,
      tags: [],
    })
    expect(outcome.outcome).toBe('recorded')
    expect(existsSync(vaultPath)).toBe(false)
    const projection = instance.life()
    expect(projection.persistence.mode).toBe('ephemeral')
    expect(projection.persistence.durable).toBe(false)
  })

  it('derives entries from the journal and is idempotent on restart', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const key = testVaultKey()

    const first = await startVaultCore(vaultPath, new StaticVaultKeyProvider(key))
    await send(first, 'brain.memory.write', {
      content: 'Freya learned that she prefers mornings.',
      subject: 'freya preference',
      kind: 'autobiographical',
    })

    let total = 0
    for (let attempt = 0; attempt < 40 && total === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      total = first.life().counts.total
    }
    expect(total).toBe(1)

    await first.stop('restart')
    core = undefined

    const second = await startVaultCore(vaultPath, new StaticVaultKeyProvider(key))
    expect(second.life().counts.total).toBe(1)
    expect(second.life().recent[0]?.sourceDomain).toBe('brain')
  })
})
