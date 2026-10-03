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
 * The bounded first migration slice, end to end through a running Core.
 *
 * Mission content is written to the one encrypted Vault instead of the bespoke
 * per-domain file, survives a restart, and leaves no plaintext sentinel in the raw
 * database bytes. A missing Vault key fails closed to an explicitly ephemeral store
 * and never creates a database.
 */
const SENTINEL = 'FREYA-VAULT-CORE-SENTINEL-88e2'

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

async function createMission(instance: Core, intent: string): Promise<string> {
  const result = (await send(instance, 'mission.create', {
    title: 'Vault mission',
    intent,
  })) as { ok: boolean; mission?: { missionId?: string; reason?: string } }
  const id = result.mission?.missionId
  if (!result.ok || id === undefined) throw new Error(`mission.create failed: ${result.mission?.reason ?? 'unknown'}`)
  return id
}

describe.skipIf(!bindingAvailable)('Core Mission slice on the encrypted Vault', () => {
  it('stores content in the Vault, leaves no plaintext, and survives a restart', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const key = testVaultKey()

    const first = await startVaultCore(vaultPath, new StaticVaultKeyProvider(key))
    const id = await createMission(first, `carrying ${SENTINEL}`)
    const detail = await first.missionDetail(id)
    expect(detail?.content?.intent).toContain(SENTINEL)

    await first.stop('restart')
    core = undefined

    expect(existsSync(vaultPath)).toBe(true)
    expect(existsSync(join(dir, 'events.jsonl.missions'))).toBe(false)
    expect(readFileSync(vaultPath).includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)

    const second = await startVaultCore(vaultPath, new StaticVaultKeyProvider(key))
    const again = await second.missionDetail(id)
    expect(again?.content?.intent).toContain(SENTINEL)
  })

  it('fails closed to ephemeral with no key and creates no database', async () => {
    const vaultPath = join(dir, 'Freya', 'vault', 'freya.db')
    const instance = await startVaultCore(
      vaultPath,
      new StaticVaultKeyProvider(null, 'no Vault key is available on this machine'),
    )
    const id = await createMission(instance, 'held in memory only')
    const detail = await instance.missionDetail(id)
    expect(detail?.content?.intent).toContain('held in memory only')
    expect(existsSync(vaultPath)).toBe(false)
  })
})
