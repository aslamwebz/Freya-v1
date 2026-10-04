// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LEARNING_RECORD_VERSION,
  LearningEngine,
  type KnowledgeRecord,
  type LearningExperience,
  type VerifiedOutcome,
} from '../../../core/learning'
import { StaticVaultKeyProvider, Vault, type VaultKeyProvider } from '../../../core/vault'
import { MemoryLearningStore, VaultLearningStore } from '../../../core/vault/repositories/learning-store'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from './binding'
import { makeVaultTempDir, removeVaultTempDir } from './tmp'

/**
 * THE LEARNING PIPELINE ON THE CANONICAL VAULT.
 *
 * Outcomes, lessons and claims live in the one encrypted SQLCipher database under
 * `domain = 'learning'`. What the domain tests cannot cover: that a restart rebuilds an
 * identical state from re-validated rows, that a damaged row **degrades** the store
 * rather than being skipped, that a withdrawn claim stays withdrawn across a restart, that
 * a forgotten record is really gone from disk, and that no plaintext sentinel survives in
 * the raw database bytes.
 */

const SENTINEL = 'FREYA_VAULT_LEARNING_SENTINEL_9b41'
const AT = '2026-05-01T09:00:00.000Z'

let dir = ''
const opened: Vault[] = []

beforeEach(async () => {
  dir = await makeVaultTempDir()
  opened.length = 0
})

afterEach(async () => {
  for (const vault of opened.splice(0)) {
    try {
      vault.close()
    } catch {
      // Already closed by the test itself.
    }
  }
  await removeVaultTempDir(dir)
})

async function openVault(path: string, keyProvider: VaultKeyProvider): Promise<Vault> {
  const vault = await Vault.open({ path, keyProvider, binding: await loadTestBinding() })
  opened.push(vault)
  return vault
}

function engineOn(store: VaultLearningStore | MemoryLearningStore): LearningEngine {
  let counter = 0
  return new LearningEngine({
    store,
    now: () => new Date(AT),
    newId: () => `gen-${(counter += 1)}`,
  })
}

async function fullPipeline(engine: LearningEngine, suffix: string): Promise<{ knowledgeId: string }> {
  await engine.recordVerifiedOutcome({
    outcomeId: `out-${suffix}`,
    sourceDomain: 'work',
    verificationId: `ver-${suffix}`,
    verifierId: 'work.step.verified',
    checked: 'the run completed and its verifier inspected the artefact',
    subjectRef: `run-${suffix}`,
    result: 'succeeded',
    establishedAt: AT,
  })
  await engine.distilExperience(`out-${suffix}`, {
    experienceId: `exp-${suffix}`,
    kind: 'tool-lesson',
    lesson: `the release verifier inspected the artefact bundle for ${suffix}`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    observedAt: AT,
  })
  const claim = await engine.deriveKnowledge({
    knowledgeId: `kn-${suffix}`,
    kind: 'process-fact',
    claim: `a release check has to inspect the artefact bundle rather than trust the log (${suffix})`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    supports: [`exp-${suffix}`],
    tags: ['release'],
    observedAt: AT,
  })
  if (!claim.ok) throw new Error(`fixture refused: ${claim.code} ${claim.reason}`)
  return { knowledgeId: `kn-${suffix}` }
}

describe.skipIf(!bindingAvailable)('the learning store on the encrypted Vault', () => {
  it('round trips the whole pipeline through a restart with an identical state', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const firstStore = await new VaultLearningStore(first).open()
    await fullPipeline(engineOn(firstStore), 'a')
    await fullPipeline(engineOn(firstStore), 'b')
    expect(firstStore.mode).toBe('encrypted')
    expect(firstStore.health().health).toBe('healthy')
    await firstStore.close()

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const reopened = await new VaultLearningStore(second).open()
    const state = reopened.state()
    expect(state.outcomes.size).toBe(2)
    expect(state.experiences.size).toBe(2)
    expect(state.knowledge.size).toBe(2)
    expect(state.knowledge.get('kn-a')?.claim).toContain('(a)')
    expect(state.experiences.get('exp-a')?.lesson).toContain('the release verifier inspected')
    expect(reopened.health().health).toBe('healthy')

    // And the derivation over the restored state matches the one over the live state.
    const restored = new LearningEngine({ store: reopened, now: () => new Date(AT) })
    expect(restored.derive().counts.knowledge).toBe(2)
    expect(restored.proposals()[0]?.support.aboveThreshold).toBe(true)
    await reopened.close()
  })

  it('writes one row per record under namespaced keys', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultLearningStore(vault).open()
    await fullPipeline(engineOn(store), 'a')
    const rows = vault.all<{ key: string }>(
      'SELECT key FROM vault_kv WHERE domain = ? ORDER BY key',
      ['learning'],
    )
    expect(rows.map((row) => row.key)).toEqual([
      'experience:exp-a',
      'knowledge:kn-a',
      'outcome:out-a',
    ])
    await store.close()
  })

  it('leaves no plaintext sentinel in the raw database bytes', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultLearningStore(vault).open()
    await fullPipeline(engineOn(store), 'a')
    await store.write({
      ...(store.state().knowledge.get('kn-a') as KnowledgeRecord),
      claim: `a release check inspected ${SENTINEL} rather than trust the log`,
    } satisfies KnowledgeRecord)
    await store.close()

    const raw = await readFile(path)
    expect(raw.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)
    expect(raw.includes(Buffer.from('a release check', 'utf8'))).toBe(false)
    expect(raw.includes(Buffer.from('release verifier', 'utf8'))).toBe(false)
  })

  it('survives a restart as a withdrawal, not as the words that were taken back', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const engine = engineOn(await new VaultLearningStore(first).open())
    const { knowledgeId } = await fullPipeline(engine, 'a')
    await engine.withdraw(knowledgeId)

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultLearningStore(second).open()
    const restored = store.state().knowledge.get(knowledgeId)
    expect(restored?.status).toBe('retracted')
    expect(restored?.claim).toBe('')
    expect(restored?.lifecycleReason).toBe('owner-withdrew-this-record')
    const raw = await readFile(path)
    expect(raw.includes(Buffer.from('rather than trust the log', 'utf8'))).toBe(false)
    await store.close()
  })

  it('removes a forgotten record from disk, not only from memory', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultLearningStore(first).open()
    const engine = engineOn(store)
    const { knowledgeId } = await fullPipeline(engine, 'a')
    await engine.withdraw(knowledgeId)
    await engine.forget(knowledgeId)
    expect(store.state().knowledge.has(knowledgeId)).toBe(false)

    const rows = first.all<{ n: number }>(
      'SELECT count(*) AS n FROM vault_kv WHERE domain = ? AND key = ?',
      ['learning', `knowledge:${knowledgeId}`],
    )
    expect(rows[0]?.n).toBe(0)
    await store.close()
  })

  it('degrades on a damaged row rather than skipping it and believing the rest', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultLearningStore(first).open()
    await fullPipeline(engineOn(store), 'a')

    // A hand-edited claim: a well-formed wrapper whose entry carries a capability field and
    // a confidence its source class could not support.
    const claim = store.state().knowledge.get('kn-a') as KnowledgeRecord
    first.transaction((tx) => {
      tx.run(`INSERT INTO vault_kv (domain, key, body, updated_at) VALUES (?, ?, ?, ?)`, [
        'learning',
        'knowledge:kn-forged',
        JSON.stringify({
          version: LEARNING_RECORD_VERSION,
          kind: 'knowledge',
          knowledge: { ...claim, knowledgeId: 'kn-forged', confidence: 'verified', capability: 'work.run.manage' },
        }),
        AT,
      ])
    })
    await store.close()

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const reopened = await new VaultLearningStore(second).open()
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.degradedReason).toMatch(/capability|forbidden|confidence/i)
    // Degraded means read-only: a store that could not fully believe what it read does not
    // accept new claims on top of a chain it does not trust.
    await expect(
      reopened.write({
        ...claim,
        knowledgeId: 'kn-after',
        claim: 'a claim written onto a chain Core could not fully believe',
      }),
    ).rejects.toThrow(/degraded/)
    await reopened.close()
  })

  it('fails closed on a wrong key, and does not create a second database', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultLearningStore(first).open()
    await fullPipeline(engineOn(store), 'a')
    await store.close()

    await expect(openVault(path, new StaticVaultKeyProvider(testVaultKey('a-different-key')))).rejects.toThrow()
  })

  it('refuses an oversized record rather than truncating it', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultLearningStore(vault).open()
    const experience = store.state().experiences.get('exp-a') as LearningExperience | undefined
    expect(experience).toBeUndefined()
    await store.write({
      outcomeId: 'out-big',
      sourceDomain: 'work',
      verificationId: 'ver-big',
      verifierId: 'work.step.verified',
      checked: 'x'.repeat(400),
      subjectRef: 'run-big',
      result: 'succeeded',
      establishedAt: AT,
    } satisfies VerifiedOutcome)
    const rows = vault.all<{ n: number }>('SELECT count(*) AS n FROM vault_kv WHERE domain = ?', ['learning'])
    expect(rows[0]?.n).toBe(1)
    await store.close()
  })
})

describe('the ephemeral store', () => {
  it('is labelled as ephemeral, with the reason it fell back', () => {
    const store = new MemoryLearningStore({ mode: 'ephemeral', faultReason: 'no Vault key was available' })
    expect(store.mode).toBe('ephemeral')
    expect(store.faultReason).toBe('no Vault key was available')
    expect(store.health()).toEqual({ health: 'healthy', reason: 'no Vault key was available' })
  })

  it('reports memory as not durable, so nothing can claim it will be remembered', () => {
    const engine = engineOn(new MemoryLearningStore())
    const projection = engine.project()
    expect(projection.persistence.mode).toBe('memory')
    expect(projection.persistence.durable).toBe(false)
  })

  it('refuses writes once closed', async () => {
    const store = new MemoryLearningStore()
    await store.close()
    await expect(
      store.write({
        outcomeId: 'out-1',
        sourceDomain: 'work',
        verificationId: 'ver-1',
        verifierId: 'v',
        checked: 'a check',
        subjectRef: 'run-1',
        result: 'succeeded',
        establishedAt: AT,
      }),
    ).rejects.toThrow(/closed/)
  })

  it('refuses to forget a record it does not hold', async () => {
    const store = new MemoryLearningStore()
    await expect(store.forget('knowledge:kn-nope')).rejects.toThrow(/no such/)
  })
})