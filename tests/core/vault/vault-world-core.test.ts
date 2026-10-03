// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../../core/vault'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from './binding'
import { makeVaultTempDir, removeVaultTempDir } from './tmp'

/**
 * Phase 22's Self & World slice on the canonical encrypted Vault, end to end.
 *
 * The claims under test:
 *
 *  1. An owner statement becomes durable evidence in the one per-user database, and no
 *     other file appears beside it.
 *  2. The raw database bytes contain no planted sentinel — a name, a relation, a summary.
 *  3. A restart recovers the same world: the same counts, the same graph, and a
 *     withdrawal that stays withdrawn.
 *  4. Mission content and world evidence share one database and one key.
 *  5. No Vault key or no Vault at all is fail-closed: an ephemeral world that says so,
 *     and no database created.
 *
 * Encryption proofs run only when `FREYA_VAULT_BINDING_MODULE` names the selected
 * binding. No binding is named in committed source and none is a dependency, because
 * selection is blocked pending the permissive Windows audit.
 */
const SENTINEL = 'FREYA-VAULT-WORLD-SENTINEL-4c17'
const SENTINEL_SUMMARY = 'FREYA-WORLD-SUMMARY-SENTINEL-91ab'

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

async function startVaultCore(vaultPath: string, keyProvider: StaticVaultKeyProvider): Promise<Core> {
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
    requestId: `w-${seq}`,
    ...(payload === undefined ? {} : { payload }),
  } as never)
}

/**
 * The entity id Core derived for a named person, asked through the bounded entity list.
 *
 * Note that the summary projection does not carry ids at all: a summary that named
 * every node would hand a window the map it did not ask for. Reading the id is a
 * separate, filtered, Guard-evaluated command, which is the point.
 */
async function entityIdOf(instance: Core, name: string): Promise<string> {
  const list = (await send(instance, 'world.entities.read', {
    kind: 'person',
    includeWithdrawn: true,
  })) as { world?: { entities?: { entities?: { entityId: string; name: string }[] } } }
  const node = list.world?.entities?.entities?.find((entry) => entry.name === name)
  if (node === undefined) throw new Error(`no entity named ${name} was reported`)
  return node.entityId
}

describe.skipIf(!bindingAvailable)('Core Self & World slice on the encrypted Vault', () => {
  it('stores evidence in the Vault, leaves no plaintext, and recovers it after a restart', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')

    const first = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    const submitted = (await send(first, 'world.statement.submit', {
      kind: 'entity',
      entityType: 'person',
      name: `Ana ${SENTINEL}`,
      evidenceSummary: SENTINEL_SUMMARY,
    })) as { ok: boolean; world?: { operation?: string; evidenceId?: string } }
    expect(submitted.ok).toBe(true)
    expect(submitted.world?.operation).toBe('submitted')
    const evidenceId = submitted.world?.evidenceId
    expect(typeof evidenceId).toBe('string')

    const before = first.world()
    await first.stop('restart')
    core = undefined

    // One database. No per-domain world file, no JSONL ledger, no plaintext anywhere.
    expect(existsSync(vaultPath)).toBe(true)
    expect(existsSync(join(dir, 'events.jsonl.world'))).toBe(false)
    expect(existsSync(join(dir, 'world.enc'))).toBe(false)
    const raw = readFileSync(vaultPath)
    for (const leak of [SENTINEL, SENTINEL_SUMMARY, 'works_on', 'owner-assertion']) {
      expect(raw.includes(Buffer.from(leak, 'utf8'))).toBe(false)
    }

    const second = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    const after = second.world()
    expect(after.counts.evidenceRecords).toBe(before.counts.evidenceRecords)
    expect(after.persistence.mode).toBe('encrypted')
    expect(after.persistence.durable).toBe(true)
    expect(after.persistence.faultReason).toBeNull()

    // A withdrawn claim stays withdrawn across the restart, by evidence id.
    const withdrawn = (await send(second, 'world.statement.withdraw', {
      targetEvidenceId: evidenceId,
      reason: 'the owner withdrew this claim',
    })) as { ok: boolean; world?: { operation?: string } }
    expect(withdrawn.ok).toBe(true)
    expect(withdrawn.world?.operation).toBe('withdrawn')
    await second.stop('restart')
    core = undefined

    const third = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    const entities = (await send(third, 'world.entities.read', {
      kind: 'person',
      includeWithdrawn: true,
    })) as { world?: { entities?: { entities?: { freshness: string }[] } } }
    const ana = entities.world?.entities?.entities?.[0]
    expect(ana?.freshness).toBe('withdrawn')
  })

  it('keeps a revision lineage across a restart, so a correction cannot come back', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    const original = (await send(first, 'world.statement.submit', {
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      attributes: { city: 'Lisbon' },
    })) as { ok: boolean; world?: { evidenceId?: string } }
    expect(original.ok).toBe(true)
    const originalId = original.world?.evidenceId
    const revision = (await send(first, 'world.statement.submit', {
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
      attributes: { city: 'Oporto' },
      supersedes: originalId,
    })) as { ok: boolean; world?: { evidenceId?: string } }
    expect(revision.ok).toBe(true)
    await first.stop('restart')
    core = undefined

    const second = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    const detail = (await send(second, 'world.entity.read', {
      entityId: await entityIdOf(second, 'Ana'),
    })) as { world?: { entity?: { evidenceIds: string[]; entity: { attributeKeys: { key: string; valueLength: number }[] } } } }
    const node = detail.world?.entity
    expect(node?.evidenceIds).toEqual([originalId, revision.world?.evidenceId].sort())
    expect(node?.entity.attributeKeys).toEqual([{ key: 'city', valueLength: 'Oporto'.length }])
  })

  it('keeps a Mission and world evidence in one database under one key', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const instance = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    const mission = (await send(instance, 'mission.create', {
      title: 'Vault mission',
      intent: 'shares the vault with the world ledger',
    })) as { ok: boolean; mission?: { missionId?: string } }
    expect(mission.ok).toBe(true)
    const id = mission.mission?.missionId
    expect(typeof id).toBe('string')
    await send(instance, 'world.statement.submit', {
      kind: 'entity',
      entityType: 'project',
      name: 'Shared Project',
    })
    await instance.stop('restart')
    core = undefined

    const second = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    // Both survived, from one file, and the detail read proves the Mission's private
    // body is still behind its own repository rather than folded into the world.
    const detail = await second.missionDetail(id ?? '')
    expect(detail?.content?.intent).toContain('shares the vault')
    expect(second.world().counts.evidenceRecords).toBe(1)
  })

  it('fails closed with no key: an ephemeral world that says so, and no database', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const instance = await startVaultCore(
      vaultPath,
      new StaticVaultKeyProvider(null, 'no Vault key is available on this machine'),
    )
    const submitted = await send(instance, 'world.statement.submit', {
      kind: 'entity',
      entityType: 'person',
      name: 'Ana',
    })
    expect(submitted.ok).toBe(true)
    const summary = instance.world()
    expect(summary.persistence.mode).toBe('ephemeral')
    expect(summary.persistence.durable).toBe(false)
    expect(summary.persistence.reason).toContain('will not survive a restart')
    expect(summary.counts.evidenceRecords).toBe(1)
    expect(existsSync(vaultPath)).toBe(false)
  })

  it('refuses a second Core with a wrong key rather than serving an empty world silently', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await startVaultCore(vaultPath, new StaticVaultKeyProvider(testVaultKey()))
    await send(first, 'world.statement.submit', { kind: 'entity', entityType: 'person', name: 'Ana' })
    await first.stop('restart')
    core = undefined

    // A different key cannot open the database at all, so the Vault fails closed and
    // Core degrades to an explicitly ephemeral world. What must never happen is a
    // *durable-looking* empty world: a person told her graph is empty when the truth is
    // that Freya could not open her own memory.
    const second = await startVaultCore(
      vaultPath,
      new StaticVaultKeyProvider(testVaultKey('not the key that wrote this')),
    )
    const summary = second.world()
    expect(summary.persistence.durable).toBe(false)
    expect(summary.counts.evidenceRecords).toBe(0)
  })
})

describe('the world slice needs no binding to be wired', () => {
  it('builds and reports an ephemeral world with no Vault configured at all', async () => {
    const instance = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await instance.start()
    core = instance
    const summary = instance.world()
    expect(summary.persistence.mode).toBe('ephemeral')
    expect(summary.health).toBe('ready')
    await instance.stop('test')
    core = undefined
  })
})