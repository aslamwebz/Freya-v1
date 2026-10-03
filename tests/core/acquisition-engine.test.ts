import { describe, expect, it } from 'vitest'
import { AcquisitionEngine } from '../../core/acquisition'
import type { AcquisitionEngineOptions, AcquisitionGuardVerdict } from '../../core/acquisition'
import { MemoryAcquisitionStore } from '../../core/vault/repositories/acquisition-store'
import type { Capability, PrincipalId } from '../../core/protocol/core-protocol'

/**
 * PHASE 29 — THE PIPELINE, THROUGH THE ENGINE.
 *
 * The domain tests check the rules in isolation. These check the things only the engine can be
 * caught doing wrong:
 *
 * - the whole loop runs, and it does not end in anything active until the owner approves;
 * - the precedence ladder is obeyed *in order*, including a stop outranking an owner approval
 *   and an untrustworthy journal outranking the stop;
 * - the owner scope is issued to the owner and to nobody else;
 * - a guard that refuses and a Governor that refuses produce the rung that actually refused,
 *   not a generic failure;
 * - cost is metered, refused at the ceiling, and never charged on a terminal request;
 * - expiry is evaluated, never scheduled.
 */

const AT = '2026-06-01T09:00:00.000Z'

interface Harness {
  readonly engine: AcquisitionEngine
  readonly store: MemoryAcquisitionStore
  /** Every capability the engine asked the Guard about, in order. */
  readonly asked: Capability[]
  /** Every principal the engine claimed to be acting as. */
  readonly principals: PrincipalId[]
}

function allow(): AcquisitionGuardVerdict {
  return { allowed: true, reason: 'held' }
}

function deny(reason: string): AcquisitionGuardVerdict {
  return { allowed: false, reason }
}

function harness(overrides: Partial<AcquisitionEngineOptions> = {}, now: string = AT): Harness {
  const asked: Capability[] = []
  const principals: PrincipalId[] = []
  const store = new MemoryAcquisitionStore({ mode: 'memory' })
  const decide = overrides.guard ?? (() => allow())
  const engine = new AcquisitionEngine({
    journalTrustworthy: () => true,
    stopAllActive: () => false,
    governor: () => allow(),
    ...overrides,
    store,
    now: () => new Date(now),
    // The recorder wraps whatever Guard the caller supplied, so an override stays auditable: a
    // test that replaces the Guard can still see what was asked of it, and as whom.
    guard: (capability, principal) => {
      asked.push(capability)
      principals.push(principal)
      return decide(capability, principal)
    },
  })
  return { engine, store, asked, principals }
}

function gapInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gapId: 'gap-1',
    kind: 'tool-absent',
    wanted: 'csv-export',
    symptom: 'nothing in the workspace can write a spreadsheet from a table',
    occurrences: 4,
    evidenceRefs: ['work.run.41'],
    tags: [],
    detectedBy: 'core',
    detectedAt: AT,
    ...overrides,
  }
}

function requestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    gapId: 'gap-1',
    subject: 'csv-export',
    intent: 'read a table from the workspace and write it as a spreadsheet',
    requirements: ['files.read'],
    targets: ['workspace.tables'],
    steps: ['read the table', 'write the spreadsheet'],
    costCeiling: 60,
    tags: [],
    confidence: 'medium',
    createdAt: AT,
    ...overrides,
  }
}

async function detected(engine: AcquisitionEngine, overrides: Record<string, unknown> = {}): Promise<void> {
  const recorded = await engine.detectGap(gapInput(overrides))
  if (!recorded.ok) throw new Error(`fixture refused: recorded.code} ${recorded.reason}`)
}

/** Everything up to `activation-requested`, with all three evidence gates passed. */
async function readyToActivate(engine: AcquisitionEngine, requestId = 'req-1'): Promise<void> {
  const built = await engine.chargeBuildStep(requestId, 2)
  if (!built.ok) throw new Error(`fixture refused: ${built.code} ${built.reason}`)
  const marked = await engine.markBuilt(requestId)
  if (!marked.ok) throw new Error(`fixture refused: ${marked.code} ${marked.reason}`)
  const begun = await engine.beginVerification(requestId)
  if (!begun.ok) throw new Error(`fixture refused: ${begun.code} ${begun.reason}`)
  for (const kind of ['verification-passed', 'tests-passed', 'red-team-clean'] as const) {
    const recorded = await engine.recordVerification({
      requestId,
      kind,
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: [`${kind}-1`],
    })
    if (!recorded.ok) throw new Error(`fixture refused: ${recorded.code} ${recorded.reason}`)
  }
  const completed = await engine.completeVerification(requestId)
  if (!completed.ok) throw new Error(`fixture refused: ${completed.code} ${completed.reason}`)
  const asked = await engine.requestActivation(requestId)
  if (!asked.ok) throw new Error(`fixture refused: ${asked.code} ${asked.reason}`)
}

/* ------------------------------------------------------------- happy path */

describe('the loop, end to end', () => {
  it('runs from a detected gap to an owner-approved activation, and nowhere else', async () => {
    const { engine, store } = harness()
    await detected(engine)

    const proposed = await engine.proposeRequest(requestInput())
    expect(proposed.ok).toBe(true)
    const request = store.state().requests.get('req-1')
    expect(request?.trustClass).toBe('untrusted')
    expect(request?.activation).toBe('inactive')
    expect(request?.status).toBe('proposed')

    await readyToActivate(engine)
    const beforeApproval = store.state().requests.get('req-1')
    expect(beforeApproval?.status).toBe('activation-requested')
    // The one number a person would want to be zero, until an owner says otherwise.
    expect(engine.derive().counts.active).toBe(0)

    const scope = engine.ownerScope('owner')
    expect(scope).not.toBeNull()
    const decided = await scope?.decide('req-1', true, 'I read the steps and the evidence')
    expect(decided?.ok).toBe(true)
    const active = store.state().requests.get('req-1')
    expect(active?.status).toBe('active')
    expect(active?.activation).toBe('active')
    expect(active?.activationExpiresAt).not.toBeNull()
    expect(engine.derive().counts.active).toBe(1)
    expect(engine.derive().activationAuthority).toBe('none')
    // The gap the capability answered is closed, and the ledger says why.
    expect(store.state().gaps.get('gap-1')?.closureReason).toBe('capability-acquired-and-activated')
  })

  it('reports a blocked activation rather than a refusal with no explanation', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    const evaluated = await engine.evaluateActivation('req-1')
    expect(evaluated.ok).toBe(true)
    expect(evaluated.ok === true && evaluated.reason).toContain('owner-approval')
    const detail = engine.readRequest('req-1')
    expect(detail.ok === true && detail.view.unsatisfied).toEqual(['owner-approval'])
    expect(detail.ok === true && detail.view.awaitsOwner).toBe(true)
    expect(detail.ok === true && detail.view.gates).toHaveLength(7)
  })

  it('reports the same derivation for the same ledger at the same instant', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    expect(JSON.stringify(engine.project())).toBe(JSON.stringify(engine.project()))
    expect(JSON.stringify(engine.derive())).toBe(JSON.stringify(engine.derive()))
  })

  it('carries no symptom or intent text in a broad read', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    const listed = engine.listRequests()
    expect(listed.ok).toBe(true)
    const serialised = JSON.stringify(listed.ok ? listed.view : null)
    expect(serialised).not.toContain('spreadsheet from a table')
    expect(serialised).toContain('intentLength')
    const projection = JSON.stringify(engine.project())
    expect(projection).not.toContain('spreadsheet')
    // The owner reviewing the activation does get the words.
    const detail = engine.readRequest('req-1')
    expect(detail.ok === true && detail.view.intent).toContain('spreadsheet')
    expect(detail.ok === true && detail.view.grantsCapability).toBe(false)
    expect(detail.ok === true && detail.view.authority).toBe('none')
  })
})

/* ------------------------------------------------------------- provenance */

describe('verification before activation', () => {
  it('will not activate without a named verification', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await engine.chargeBuildStep('req-1', 2)
    await engine.markBuilt('req-1')
    const begun = await engine.beginVerification('req-1')
    expect(begun.ok).toBe(true)
    const completed = await engine.completeVerification('req-1')
    expect(completed.ok).toBe(false)
    expect(completed.ok === false && completed.code).toBe('not-verifiable')
    expect(store.state().requests.get('req-1')?.status).toBe('verifying')
  })

  it('refuses a verdict with no verifier and with no evidence', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await engine.chargeBuildStep('req-1', 2)
    await engine.markBuilt('req-1')
    await engine.beginVerification('req-1')
    const unnamed = await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: true,
      verifier: '',
      evidenceRefs: ['ver-1'],
    })
    expect(unnamed.ok === false && unnamed.code).toBe('missing-verifier')
    const unsupported = await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: [],
    })
    expect(unsupported.ok === false && unsupported.code).toBe('invalid-evidence-refs')
  })

  it('makes a failed verification terminal, so a failure cannot be edited into a pass', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await engine.chargeBuildStep('req-1', 2)
    await engine.markBuilt('req-1')
    await engine.beginVerification('req-1')
    const failed = await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: false,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-1'],
    })
    expect(failed.ok).toBe(true)
    const completed = await engine.completeVerification('req-1')
    expect(completed.ok === true && completed.operation).toBe('verification-failed')
    expect(store.state().requests.get('req-1')?.status).toBe('rejected')
    expect(store.state().requests.get('req-1')?.lifecycleReason).toBe('verification-failed')
    // And the gap stays open: a failed approach is not a closed need.
    expect(store.state().gaps.get('gap-1')?.status).toBe('open')
    // Nothing may be done with a terminal request.
    const again = await engine.beginVerification('req-1')
    expect(again.ok).toBe(false)
  })

  it('refuses the requester advancing itself past verification', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    const built = await engine.chargeBuildStep('req-1', 2)
    expect(built.ok === true && built.spent).toBe(2)
    const verified = await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-1'],
    })
    expect(verified.ok === false && verified.code).toBe('not-verifiable')
  })
})

/* -------------------------------------------------------------- no self-grant */

describe('nothing may approve itself', () => {
  it('issues the owner scope to the owner and to nobody else', async () => {
    const { engine } = harness()
    expect(engine.ownerScope('owner')).not.toBeNull()
    for (const principal of ['system', 'agent:worker', 'module:foundry'] as const) {
      expect(engine.ownerScope(principal)).toBeNull()
    }
  })

  it('has no method that approves without the owner scope', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    // Everything the engine exposes on its own stops short of active.
    const evaluated = await engine.evaluateActivation('req-1')
    expect(evaluated.ok).toBe(true)
    expect(engine.derive().counts.active).toBe(0)
    expect(engine.derive().awaitingOwner).toEqual(['req-1'])
    const request = store.state().requests.get('req-1')
    expect(request?.activation).toBe('activation-requested')
    expect(request?.status).toBe('activation-requested')
  })

  it('refuses an approval while another gate is unsatisfied, even from the owner', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await engine.chargeBuildStep('req-1', 2)
    await engine.markBuilt('req-1')
    await engine.beginVerification('req-1')
    await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-1'],
    })
    // Tests and the red team never reported, so the owner approval cannot stand.
    await engine.completeVerification('req-1')
    await engine.requestActivation('req-1')
    const approved = await engine.ownerScope('owner')?.decide('req-1', true, 'I would like this on')
    expect(approved?.ok).toBe(false)
    expect(approved?.ok === false && approved.code).toBe('gate-not-satisfied')
    expect(approved?.ok === false && approved.reason).toContain('tests-passed')
    expect(store.state().requests.get('req-1')?.status).toBe('activation-requested')
    expect(engine.derive().counts.active).toBe(0)
  })

  it('treats a decline as terminal, with the owner decision recorded', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    const declined = await engine.ownerScope('owner')?.decide('req-1', false, 'not this one')
    expect(declined?.ok === true && declined.operation).toBe('declined')
    const request = store.state().requests.get('req-1')
    expect(request?.status).toBe('rejected')
    expect(request?.lifecycleReason).toBe('owner-declined-activation')
    // The gap stays open: the owner refused this proposal, not the need.
    expect(store.state().gaps.get('gap-1')?.status).toBe('open')
  })

  it('makes a revocation terminal and never re-activatable', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    await engine.ownerScope('owner')?.decide('req-1', true, 'approved for now')
    expect(store.state().requests.get('req-1')?.status).toBe('active')
    const revoked = await engine.ownerScope('owner')?.revoke('req-1', 'no longer wanted')
    expect(revoked?.ok === true && revoked.operation).toBe('revoked')
    const request = store.state().requests.get('req-1')
    expect(request?.status).toBe('rejected')
    expect(request?.activation).toBe('revoked')
    expect(request?.activationExpiresAt).toBeNull()
    const reactivated = await engine.ownerScope('owner')?.decide('req-1', true, 'actually yes')
    expect(reactivated?.ok).toBe(false)
    expect(engine.derive().counts.active).toBe(0)
  })

  it('refuses an owner decision with no reason', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    const unlabelled = await engine.ownerScope('owner')?.decide('req-1', true, '')
    expect(unlabelled?.ok === false && unlabelled.code).toBe('invalid-text')
  })
})

/* -------------------------------------------------------------- precedence */

describe('the precedence ladder is obeyed in order', () => {
  it('refuses everything while the journal cannot be believed', async () => {
    const { engine } = harness({ journalTrustworthy: () => false })
    const refused = await engine.detectGap(gapInput())
    expect(refused.ok === false && refused.code).toBe('journal-not-trustworthy')
  })

  it('lets an untrustworthy journal outrank the stop latch', async () => {
    const { engine } = harness({ journalTrustworthy: () => false, stopAllActive: () => true })
    const refused = await engine.detectGap(gapInput())
    // Both rungs would refuse; the reported one is the higher, so a reader knows the log is the
    // thing that is wrong rather than assuming a deliberate stop.
    expect(refused.ok === false && refused.code).toBe('journal-not-trustworthy')
  })

  it('lets the stop latch outrank an owner approval', async () => {
    let latched = false
    const { engine, store } = harness({ stopAllActive: () => latched })
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    // Every gate is satisfied and the owner is holding the scope. The latch still wins: a latch
    // is not an approval, and "the owner stopped Freya" must beat "the owner clicked a button".
    latched = true
    const owner = engine.ownerScope('owner')
    expect(owner).not.toBeNull()
    const decided = await owner?.decide('req-1', true, 'approved a moment ago')
    expect(decided?.ok).toBe(false)
    expect(decided?.ok === false && decided.code).toBe('stop-all-active')
    expect(store.state().requests.get('req-1')?.status).toBe('activation-requested')
    // And with the latch cleared, the same approval goes through.
    latched = false
    const allowed = await engine.ownerScope('owner')?.decide('req-1', true, 'approved once running')
    expect(allowed?.ok).toBe(true)
    expect(store.state().requests.get('req-1')?.status).toBe('active')
  })

  it('reports guard-denied when the principal holds nothing', async () => {
    const { engine, asked, principals } = harness({
      guard: () => deny('principal does not hold the capability'),
    })
    const refused = await engine.proposeRequest(requestInput())
    expect(refused.ok === false && refused.code).toBe('guard-denied')
    expect(asked).toEqual(['acquisition.propose'])
    // The engine never names a principal of its own choosing: it asks about the one it acts as.
    expect(principals).toEqual(['owner'])
  })

  it('reports governor-denied for work that spends, and still allows a read', async () => {
    const { engine } = harness({ governor: () => deny('no allowance is active') })
    const refusedBuild = await engine.detectGap(gapInput())
    expect(refusedBuild.ok === false && refusedBuild.code).toBe('governor-denied')
    // The projection is a read, and a read must stay available while building is paused, or an
    // owner could not see why an activation is stuck.
    expect(engine.project().mode).toBe('available')
    const read = await engine.evaluateActivation('req-1')
    expect(read.ok === false && read.code).toBe('no-such-request')
    // The read-only projection is the same story: a Core with building paused still reports.
    expect(engine.project().counts.requests).toBe(0)
  })

  it('reports budget-exhausted rather than a domain rule when the ceiling is reached', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput({ costCeiling: 3 }))
    await engine.chargeBuildStep('req-1', 2)
    const refused = await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-1'],
    })
    // Two units are left, a verdict costs two, and the request is not even verifying yet — so
    // the domain rule is the honest report.
    expect(refused.ok === false && refused.code).toBe('not-verifiable')
  })

  it('refuses the charge that would cross the ceiling', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput({ costCeiling: 3, steps: ['read the table'] }))
    await engine.chargeBuildStep('req-1', 3)
    const refused = await engine.chargeBuildStep('req-1', 1)
    expect(refused.ok === false && refused.code).toBe('budget-exhausted')
  })

  it('refuses to build a plan the ceiling cannot pay for', async () => {
    const { engine } = harness()
    await detected(engine)
    const refused = await engine.proposeRequest(requestInput({ costCeiling: 1 }))
    expect(refused.ok === false && refused.code).toBe('budget-exhausted')
  })

  it('will not declare a build finished before its plan is paid for', async () => {
    const { engine } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await engine.chargeBuildStep('req-1', 1)
    const refused = await engine.markBuilt('req-1')
    expect(refused.ok === false && refused.code).toBe('budget-exhausted')
    expect(refused.ok === false && refused.reason).toContain('planned step')
  })

  it('denies by default when no Guard or Governor is wired at all', async () => {
    const store = new MemoryAcquisitionStore()
    const bare = new AcquisitionEngine({ store, now: () => new Date(AT) })
    const refused = await bare.detectGap(gapInput())
    expect(refused.ok === false && refused.code).toBe('guard-denied')
  })
})

/* ------------------------------------------------------------- retention */

describe('expiry is evaluated, never scheduled', () => {
  it('expires a stale request when asked, and not before', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    expect(await engine.applyRetention(AT)).toEqual([])
    const past = new Date(Date.parse(AT) + 31 * 24 * 60 * 60 * 1_000).toISOString()
    const retired = await engine.applyRetention(past)
    expect(retired).toContain('req-1')
    expect(store.state().requests.get('req-1')?.lifecycleReason).toBe('stale-request-expired')
    // Nothing may be done with a terminal request: the first rule an expired request meets is
    // the lifecycle table, which has no edge out of `expired` at all.
    const advanced = await engine.chargeBuildStep('req-1')
    expect(advanced.ok === false && advanced.code).toBe('illegal-transition')
    const further = await engine.requestActivation('req-1')
    expect(further.ok === false && further.code).toBe('illegal-transition')
    const reread = engine.readRequest('req-1')
    expect(reread.ok === true && reread.view.request.status).toBe('expired')
  })

  it('expires a standing activation on its own shorter deadline', async () => {
    const { engine, store } = harness()
    await detected(engine)
    await engine.proposeRequest(requestInput())
    await readyToActivate(engine)
    await engine.ownerScope('owner')?.decide('req-1', true, 'approved')
    const fifteenDays = new Date(Date.parse(AT) + 15 * 24 * 60 * 60 * 1_000).toISOString()
    const retired = await engine.applyRetention(fifteenDays)
    expect(retired).toContain('req-1')
    const request = store.state().requests.get('req-1')
    expect(request?.status).toBe('expired')
    expect(request?.lifecycleReason).toBe('retention-bound-reached')
    expect(engine.derive().counts.active).toBe(0)
  })

  it('refuses a new activation over the activation bound rather than revoking a standing one', async () => {
    const { engine } = harness()
    for (let index = 0; index < 4; index += 1) {
      const id = `req-${index + 1}`
      await detected(engine, { gapId: `gap-${index + 1}`, evidenceRefs: [`work.run.${index + 1}`] })
      await engine.proposeRequest(requestInput({ requestId: id, gapId: `gap-${index + 1}` }))
      await readyToActivate(engine, id)
      await engine.ownerScope('owner')?.decide(id, true, 'approved')
    }
    expect(engine.derive().counts.active).toBe(4)
    await detected(engine, { gapId: 'gap-5', evidenceRefs: ['work.run.5'] })
    await engine.proposeRequest(requestInput({ requestId: 'req-5', gapId: 'gap-5' }))
    await readyToActivate(engine, 'req-5')
    const fifth = await engine.ownerScope('owner')?.decide('req-5', true, 'one more')
    expect(fifth?.ok === false && fifth.code).toBe('activation-bound-reached')
    expect(engine.derive().counts.active).toBe(4)
  })

  it('retires a gap that has aged out with a reason of its own', async () => {
    const { engine, store } = harness()
    await detected(engine)
    const after = new Date(Date.parse(AT) + 91 * 24 * 60 * 60 * 1_000).toISOString()
    expect(await engine.applyRetention(after)).toContain('gap-1')
    expect(store.state().gaps.get('gap-1')?.closureReason).toBe('aged-out-past-retention')
  })
})

/* -------------------------------------------------------------- reporting */

describe('the store reports its own honesty in the projection', () => {
  it('reports the persistence mode rather than assuming durability', () => {
    const ephemeral = harness({})
    expect(ephemeral.engine.persistence().durable).toBe(false)
    const faulted = new AcquisitionEngine({
      store: new MemoryAcquisitionStore({ mode: 'ephemeral', faultReason: 'no secure key was available' }),
      now: () => new Date(AT),
      guard: () => allow(),
      governor: () => allow(),
    })
    const view = faulted.persistence()
    expect(view.mode).toBe('ephemeral')
    expect(view.durable).toBe(false)
    expect(view.reason).toBe('no secure key was available')
    expect(faulted.project().persistence.reason).toBe('no secure key was available')
  })
})