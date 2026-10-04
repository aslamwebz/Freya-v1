// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACQUISITION_LIMITS,
  ACQUISITION_RECORD_VERSION,
  AcquisitionEngine,
  type AcquisitionWrite,
} from '../../../core/acquisition'
import {
  MAX_VAULT_ACQUISITION_RECORD_BYTES,
  MemoryAcquisitionStore,
  VaultAcquisitionStore,
} from '../../../core/vault/repositories/acquisition-store'
import { StaticVaultKeyProvider, Vault, type VaultKeyProvider } from '../../../core/vault'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from './binding'
import { makeVaultTempDir, removeVaultTempDir } from './tmp'

/**
 * THE ACQUISITION LEDGER ON THE CANONICAL VAULT.
 *
 * What the domain tests cannot cover, and what this phase most needs on disk:
 *
 * - a restart rebuilds an identical state from re-validated rows;
 * - a **damaged row degrades** the store rather than being skipped, and the degraded store then
 *   refuses writes rather than stacking records on a chain it cannot vouch for;
 * - a row that claims `active` without the owner's approval in its ledger is refused, and so is
 *   one whose deadline was widened;
 * - an owner decision validated against a request folded later in the same read — the two-pass
 *   ordering, which is the one thing a single `ORDER BY rowid` pass would get wrong;
 * - **no plaintext sentinel survives** in the raw database bytes;
 * - the memory store's per-record size ceiling is a real bound rather than a comment.
 */

const SENTINEL = 'FREYA_VAULT_ACQUISITION_SENTINEL_4d17'
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

function engineOn(store: VaultAcquisitionStore | MemoryAcquisitionStore): AcquisitionEngine {
  return new AcquisitionEngine({
    store,
    now: () => new Date(AT),
    journalTrustworthy: () => true,
    stopAllActive: () => false,
    guard: () => ({ allowed: true, reason: 'held' }),
    governor: () => ({ allowed: true, reason: 'within grant' }),
  })
}

function gapPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gapId: 'gap-1',
    kind: 'tool-absent',
    wanted: 'csv-export',
    symptom: 'nothing in the workspace can write a spreadsheet from a table',
    occurrences: 2,
    evidenceRefs: ['work.run.41'],
    tags: [],
    detectedBy: 'core',
    detectedAt: AT,
    ...overrides,
  }
}

function requestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    gapId: 'gap-1',
    subject: 'csv-export',
    intent: 'read a table from the workspace and write it as a spreadsheet',
    requirements: ['files.read'],
    targets: ['workspace.tables'],
    steps: ['read the table'],
    costCeiling: 60,
    tags: [],
    confidence: 'medium',
    createdAt: AT,
    ...overrides,
  }
}

/** Drive a request all the way to an owner-approved activation. */
async function activated(engine: AcquisitionEngine, id = 'req-1'): Promise<void> {
  await engine.detectGap(gapPayload())
  await engine.proposeRequest(requestPayload({ requestId: id, gapId: 'gap-1' }))
  await engine.chargeBuildStep(id, 1)
  await engine.markBuilt(id)
  await engine.beginVerification(id)
  for (const kind of ['verification-passed', 'tests-passed', 'red-team-clean'] as const) {
    await engine.recordVerification({
      requestId: id,
      kind,
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: [`${kind}-1`],
    })
  }
  await engine.completeVerification(id)
  await engine.requestActivation(id)
  await engine.ownerScope('owner')?.decide(id, true, 'approved for this fortnight')
}

/** Write one raw row into the acquisition domain, bypassing every validator. */
function writeRaw(vault: Vault, key: string, body: string): void {
  vault.transaction((tx) => {
    tx.run(
      `INSERT INTO vault_kv (domain, key, body, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      ['acquisition', key, body, AT],
    )
  })
}

const vaultAvailable = bindingAvailable ? it : it.skip

describe('the acquisition ledger on the canonical Vault', () => {
  vaultAvailable('rebuilds an identical state from re-validated rows after a restart', async () => {
    const path = join(dir, 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const writer = engineOn(await new VaultAcquisitionStore(first).open())
    await activated(writer)
    const before = JSON.stringify(writer.derive())
    first.close()

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const restarted = engineOn(await new VaultAcquisitionStore(second).open())
    expect(JSON.stringify(restarted.derive())).toBe(before)
    // The activation survives the round trip, which means the owner approval in the ledger was
    // re-validated rather than assumed.
    const detail = restarted.readRequest('req-1')
    expect(detail.ok === true && detail.view.request.status).toBe('active')
    expect(detail.ok === true && detail.view.ownerApproved).toBe(true)
    expect(restarted.persistence().durable).toBe(true)
    expect(restarted.persistence().degraded).toBe(false)
  })

  vaultAvailable('keeps no plaintext sentinel in the raw database bytes', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const engine = engineOn(await new VaultAcquisitionStore(vault).open())
    await engine.detectGap(gapPayload({ symptom: `the export could not read ${SENTINEL} without a converter` }))
    await engine.proposeRequest(requestPayload({ intent: `write ${SENTINEL} as a spreadsheet` }))
    const bytes = await readFile(path)
    expect(bytes.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)
  })

  vaultAvailable('degrades on a row that is not valid JSON, and then refuses writes', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    writeRaw(vault, 'request:req-9', '{ this is not json')
    const store = await new VaultAcquisitionStore(vault).open()
    expect(store.health().health).toBe('degraded')
    expect(store.degradedReason).toContain('valid JSON')
    // Degraded means read-only, not "carry on and hope": a gate ledger written onto an
    // unreadable chain is a chain that says a capability was verified by somebody.
    await expect(engineOn(store).detectGap(gapPayload({ gapId: 'gap-2' }))).rejects.toThrow(/degraded/)
  })

  vaultAvailable('degrades on a row whose trust class was edited on disk', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultAcquisitionStore(vault).open()
    // Write through the engine so the row is genuine, then edit it behind the engine's back.
    const engine = engineOn(store)
    await engine.detectGap(gapPayload())
    await engine.proposeRequest(requestPayload())
    const genuine = store.state().requests.get('req-1')
    expect(genuine).toBeDefined()
    writeRaw(
      vault,
      'request:req-1',
      JSON.stringify({ version: ACQUISITION_RECORD_VERSION, kind: 'request', request: { ...genuine, trustClass: 'derived' } }),
    )
    const reopened = await new VaultAcquisitionStore(vault).open()
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.health().reason).toContain('trust class')
  })

  vaultAvailable('degrades on a row whose deadline was widened', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultAcquisitionStore(vault).open()
    const engine = engineOn(store)
    await engine.detectGap(gapPayload())
    await engine.proposeRequest(requestPayload())
    const genuine = store.state().requests.get('req-1')
    writeRaw(
      vault,
      'request:req-1',
      JSON.stringify({
        version: ACQUISITION_RECORD_VERSION,
        kind: 'request',
        request: { ...genuine, expiresAt: '2099-01-01T00:00:00.000Z' },
      }),
    )
    const reopened = await new VaultAcquisitionStore(vault).open()
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.health().reason).toContain('deadline')
  })

  vaultAvailable('validates a decision against its own request, whichever order the rows are in', async () => {
    const path = join(dir, 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    await activated(engineOn(await new VaultAcquisitionStore(vault).open()))
    const decisionRow = vault.all<{ key: string; body: string }>(
      `SELECT key, body FROM vault_kv WHERE domain = 'acquisition' ORDER BY rowid`,
    )
    // Reverse the physical order so the decision is read *before* the request it talks about.
    for (const row of [...decisionRow].reverse()) {
      vault.transaction((tx) => {
        tx.run(`DELETE FROM vault_kv WHERE domain = 'acquisition' AND key = ?`, [row.key])
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at) VALUES (?, ?, ?, ?)`,
          ['acquisition', row.key, row.body, AT],
        )
      })
    }
    // Two passes, so this still folds: the ordering must not be load-bearing.
    const reordered = await new VaultAcquisitionStore(vault).open()
    expect(reordered.health().health).toBe('healthy')
    expect(reordered.state().requests.get('req-1')?.status).toBe('active')
    expect(reordered.state().decisions.get('req-1')?.approved).toBe(true)
  })

  vaultAvailable('refuses to open a database with the wrong key', async () => {
    const path = join(dir, 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    await activated(engineOn(await new VaultAcquisitionStore(first).open()))
    first.close()
    await expect(
      openVault(path, new StaticVaultKeyProvider(new Uint8Array(32).fill(9))),
    ).rejects.toThrow()
  })

  it('reports the memory store honestly rather than implying durability', async () => {
    const ephemeral = new MemoryAcquisitionStore({ mode: 'ephemeral', faultReason: 'no secure key was available' })
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
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await engine.detectGap(gapPayload())
    const gap = store.state().gaps.get('gap-1')
    expect(gap).toBeDefined()
    // A gap whose symptom is far past the bound is a refusal, not a shortened symptom.
    const oversize: AcquisitionWrite = { ...gap!, symptom: 'x'.repeat(64 * 1024) }
    await expect(store.write(oversize)).rejects.toThrow(/exceeds the per-record limit/)
    // And the bound is the tighter of the two, checked rather than asserted.
    expect(ACQUISITION_LIMITS.maxRecordBodyBytes).toBeLessThanOrEqual(MAX_VAULT_ACQUISITION_RECORD_BYTES)
  })
})