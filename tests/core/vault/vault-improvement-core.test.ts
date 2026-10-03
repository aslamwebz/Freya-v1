// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_RECORD_VERSION,
  ImprovementEngine,
  type ImprovementWrite,
} from '../../../core/improvement'
import {
  MAX_VAULT_IMPROVEMENT_RECORD_BYTES,
  MemoryImprovementStore,
  VaultImprovementStore,
} from '../../../core/vault/repositories/improvement-store'
import { StaticVaultKeyProvider, Vault, type VaultKeyProvider } from '../../../core/vault'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from './binding'
import { makeVaultTempDir, removeVaultTempDir } from './tmp'

/**
 * THE IMPROVEMENT LEDGER ON THE CANONICAL VAULT.
 *
 * What the domain tests cannot cover, and what this phase most needs on disk:
 *
 * - a restart rebuilds an identical state from re-validated rows;
 * - a **damaged row degrades** the store rather than being skipped, and the degraded store then
 *   refuses writes rather than stacking records on a chain it cannot vouch for;
 * - a row whose rollback revision or merge deadline was edited is refused — those two are how a
 *   rolled-back change could be made to look reversible;
 * - a decision validated against a proposal folded later in the same read — the two-pass ordering,
 *   which is the one thing a single `ORDER BY rowid` pass would get wrong;
 * - **no plaintext sentinel survives** in the raw database bytes;
 * - the memory store's per-record ceiling is a real bound rather than a comment.
 */

const SENTINEL = 'FREYA_VAULT_IMPROVEMENT_SENTINEL_8c52'
const AT = '2026-06-01T09:00:00.000Z'

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

function engineOn(store: VaultImprovementStore | MemoryImprovementStore): ImprovementEngine {
  return new ImprovementEngine({
    store,
    now: () => new Date(AT),
    journalTrustworthy: () => true,
    stopAllActive: () => false,
    guard: () => ({ allowed: true, reason: 'held' }),
    governor: () => ({ allowed: true, reason: 'within grant' }),
  })
}

function proposalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: 'prop-1',
    kind: 'latency-too-high',
    subject: 'bounded-summary-length',
    symptom: 'the summary of a long run takes longer to produce than the run it describes',
    occurrences: 6,
    evidenceRefs: ['work.run.41'],
    changes: ['cap the summary at a bounded length and say when it was truncated'],
    requirements: ['procedures.read'],
    targets: ['procedure-definition'],
    rollbackSteps: ['restore the previous summary length'],
    costCeiling: 80,
    tags: [],
    confidence: 'medium',
    createdAt: AT,
    ...overrides,
  }
}

/** Drive a proposal all the way to an owner-approved merge. */
async function merged(engine: ImprovementEngine, id = 'prop-1'): Promise<void> {
  await engine.propose(proposalPayload({ proposalId: id }))
  await engine.stageChange(id, 'rev-7')
  await engine.recordCheck({
    proposalId: id,
    kind: 'staged-verified',
    passed: true,
    verifier: 'vault.stage-check',
    evidenceRefs: ['stage-1'],
  })
  await engine.runTests(id)
  await engine.recordCheck({
    proposalId: id,
    kind: 'tests-passed',
    passed: true,
    verifier: 'vitest.run',
    evidenceRefs: ['run-1'],
  })
  await engine.completeTests(id)
  await engine.recordCheck({
    proposalId: id,
    kind: 'red-team-clean',
    passed: true,
    verifier: 'red-team.sweep',
    evidenceRefs: ['rt-1'],
  })
  await engine.beginReview(id)
  await engine.recordCheck({
    proposalId: id,
    kind: 'review-recorded',
    passed: true,
    verifier: 'owner.review',
    evidenceRefs: ['review-1'],
  })
  await engine.completeReview(id)
  await engine.rehearseRollback(id, true, 'vault.rollback-rehearsal')
  await engine.requestMerge(id)
  await engine.ownerScope('owner')?.decideMerge(id, true, 'approved for two months')
}

/** Write one raw row into the improvement domain, bypassing every validator. */
function writeRaw(vault: Vault, key: string, body: string): void {
  vault.transaction((tx) => {
    tx.run(
      `INSERT INTO vault_kv (domain, key, body, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      ['improvement', key, body, AT],
    )
  })
}

const vaultAvailable = bindingAvailable ? it : it.skip

describe('the improvement ledger on the canonical Vault', () => {
  vaultAvailable('rebuilds an identical state from re-validated rows after a restart', async () => {
    const path = join(dir, 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const writer = engineOn(await new VaultImprovementStore(first).open())
    await merged(writer)
    const before = JSON.stringify(writer.derive())
    first.close()

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const restarted = engineOn(await new VaultImprovementStore(second).open())
    expect(JSON.stringify(restarted.derive())).toBe(before)
    // The merge survives the round trip, which means the owner's approval in the ledger was
    // re-validated rather than assumed, and the revision to restore with it.
    const detail = restarted.readProposal('prop-1')
    expect(detail.ok === true && detail.view.proposal.status).toBe('merged')
    expect(detail.ok === true && detail.view.proposal.restoresRevision).toBe('rev-7')
    expect(detail.ok === true && detail.view.ownerApproved).toBe(true)
    expect(restarted.persistence().durable).toBe(true)
    expect(restarted.persistence().degraded).toBe(false)
  })

  vaultAvailable('keeps no plaintext sentinel in the raw database bytes', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const engine = engineOn(await new VaultImprovementStore(vault).open())
    await engine.propose(
      proposalPayload({
        symptom: `the summary of ${SENTINEL} took longer than the run it described`,
        rollbackSteps: [`restore the previous length for ${SENTINEL}`],
      }),
    )
    const bytes = await readFile(path)
    expect(bytes.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)
  })

  vaultAvailable('degrades on a row that is not valid JSON, and then refuses writes', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    writeRaw(vault, 'proposal:prop-9', '{ this is not json')
    const store = await new VaultImprovementStore(vault).open()
    expect(store.health().health).toBe('degraded')
    expect(store.degradedReason).toContain('valid JSON')
    // Degraded means read-only, not "carry on and hope": a merge decision written onto an
    // unreadable chain is a chain that says the owner approved a change.
    await expect(engineOn(store).propose(proposalPayload({ proposalId: 'prop-2' }))).rejects.toThrow(/degraded/)
  })

  vaultAvailable('degrades on a row whose rollback revision was edited on disk', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultImprovementStore(vault).open()
    const engine = engineOn(store)
    await merged(engine)
    const genuine = store.state().proposals.get('prop-1')
    expect(genuine?.restoresRevision).toBe('rev-7')
    writeRaw(
      vault,
      'proposal:prop-1',
      JSON.stringify({
        version: IMPROVEMENT_RECORD_VERSION,
        kind: 'proposal',
        proposal: { ...genuine, restoresRevision: null },
      }),
    )
    const reopened = await new VaultImprovementStore(vault).open()
    // A merged change with no recorded revision would be a landed change that cannot be undone.
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.health().reason).toContain('revision')
  })

  vaultAvailable('degrades on a row whose merge deadline was widened', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultImprovementStore(vault).open()
    await merged(engineOn(store))
    const genuine = store.state().proposals.get('prop-1')
    writeRaw(
      vault,
      'proposal:prop-1',
      JSON.stringify({
        version: IMPROVEMENT_RECORD_VERSION,
        kind: 'proposal',
        proposal: { ...genuine, mergedExpiresAt: '2099-01-01T00:00:00.000Z' },
      }),
    )
    const reopened = await new VaultImprovementStore(vault).open()
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.health().reason).toContain('deadline')
  })

  vaultAvailable('validates a decision against its own proposal, whichever order the rows are in', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    await merged(engineOn(await new VaultImprovementStore(vault).open()))
    const rows = vault.all<{ key: string; body: string }>(
      `SELECT key, body FROM vault_kv WHERE domain = 'improvement' ORDER BY rowid`,
    )
    // Reverse the physical order so the decision is read *before* the proposal it talks about.
    for (const row of [...rows].reverse()) {
      vault.transaction((tx) => {
        tx.run(`DELETE FROM vault_kv WHERE domain = 'improvement' AND key = ?`, [row.key])
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at) VALUES (?, ?, ?, ?)`,
          ['improvement', row.key, row.body, AT],
        )
      })
    }
    // Two passes, so this still folds: the ordering must not be load-bearing.
    const reordered = await new VaultImprovementStore(vault).open()
    expect(reordered.health().health).toBe('healthy')
    expect(reordered.state().proposals.get('prop-1')?.status).toBe('merged')
    expect(reordered.state().decisions.get('prop-1')?.approved).toBe(true)
  })

  vaultAvailable('refuses to open a database with the wrong key', async () => {
    const path = join(dir, 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    await merged(engineOn(await new VaultImprovementStore(first).open()))
    first.close()
    await expect(
      openVault(path, new StaticVaultKeyProvider(new Uint8Array(32).fill(9))),
    ).rejects.toThrow()
  })

  it('reports the memory store honestly rather than implying durability', () => {
    const ephemeral = new MemoryImprovementStore({
      mode: 'ephemeral',
      faultReason: 'no secure key was available',
    })
    const engine = engineOn(ephemeral)
    expect(engine.persistence()).toEqual({
      mode: 'ephemeral',
      durable: false,
      degraded: false,
      reason: 'no secure key was available',
    })
    expect(engine.project().persistence.reason).toBe('no secure key was available')
  })

  it('refuses a record over the per-record ceiling rather than truncating it', async () => {
    const store = new MemoryImprovementStore()
    const engine = engineOn(store)
    await engine.propose(proposalPayload())
    const proposal = store.state().proposals.get('prop-1')
    expect(proposal).toBeDefined()
    const oversize: ImprovementWrite = { ...proposal!, symptom: 'x'.repeat(64 * 1024) }
    await expect(store.write(oversize)).rejects.toThrow(/exceeds the per-record limit/)
    // And the bound is the tighter of the two, checked rather than asserted.
    expect(IMPROVEMENT_LIMITS.maxRecordBodyBytes).toBeLessThanOrEqual(MAX_VAULT_IMPROVEMENT_RECORD_BYTES)
  })
})
