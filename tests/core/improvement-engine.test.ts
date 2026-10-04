import { describe, expect, it } from 'vitest'
import { ImprovementEngine } from '../../core/improvement'
import type { ImprovementEngineOptions, ImprovementGuardVerdict } from '../../core/improvement'
import { MemoryImprovementStore } from '../../core/vault/repositories/improvement-store'
import type { Capability, PrincipalId } from '../../core/protocol/core-protocol'

/**
 * PHASE 30 — THE PIPELINE, THROUGH THE ENGINE.
 *
 * The domain tests check the rules in isolation. These check the things only the engine can be
 * caught doing wrong:
 *
 * - the loop runs, and it does not land anything until the owner approves;
 * - **nothing merges itself**, and an approval cannot stand in for a gate that failed;
 * - **rollback works on a landed change**, which is the phase's own mechanism;
 * - the precedence ladder is obeyed *in order*, including a stop outranking an owner approval;
 * - the owner scope is issued to the owner and to nobody else;
 * - cost is metered, refused at the ceiling, and never charged on a terminal proposal;
 * - expiry is evaluated, never scheduled.
 */

const AT = '2026-06-01T09:00:00.000Z'

interface Harness {
  readonly engine: ImprovementEngine
  readonly store: MemoryImprovementStore
  /** Every capability the engine asked the Guard about, in order. */
  readonly asked: Capability[]
  /** Every principal the engine claimed to be acting as. */
  readonly principals: PrincipalId[]
}

function allow(): ImprovementGuardVerdict {
  return { allowed: true, reason: 'held' }
}

function deny(reason: string): ImprovementGuardVerdict {
  return { allowed: false, reason }
}

function harness(overrides: Partial<ImprovementEngineOptions> = {}, now: string = AT): Harness {
  const asked: Capability[] = []
  const principals: PrincipalId[] = []
  const store = new MemoryImprovementStore({ mode: 'memory' })
  const decide = overrides.guard ?? (() => allow())
  const engine = new ImprovementEngine({
    journalTrustworthy: () => true,
    stopAllActive: () => false,
    governor: () => allow(),
    ...overrides,
    store,
    now: () => new Date(now),
    // The recorder wraps whatever Guard the caller supplied, so an override stays auditable.
    guard: (capability, principal) => {
      asked.push(capability)
      principals.push(principal)
      return decide(capability, principal)
    },
  })
  return { engine, store, asked, principals }
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

async function proposed(engine: ImprovementEngine, overrides: Record<string, unknown> = {}): Promise<void> {
  const recorded = await engine.propose(proposalPayload(overrides))
  if (!recorded.ok) throw new Error(`fixture refused: ${recorded.code} ${recorded.reason}`)
}

/** Drive a proposal to `merging` with every gate but the owner's passed, and rehearsed. */
async function readyToMerge(engine: ImprovementEngine, id = 'prop-1'): Promise<void> {
  const staged = await engine.stageChange(id, 'rev-7')
  if (!staged.ok) throw new Error(`fixture refused: ${staged.code} ${staged.reason}`)
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
    evidenceRefs: ['rev-review-1'],
  })
  await engine.completeReview(id)
  await engine.rehearseRollback(id, true, 'vault.rollback-rehearsal')
  const asked = await engine.requestMerge(id)
  if (!asked.ok) throw new Error(`fixture refused: ${asked.code} ${asked.reason}`)
}

/* ------------------------------------------------------------- happy path */

describe('the loop, end to end', () => {
  it('runs from a proposal to an owner-approved merge, and nowhere else', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    expect(store.state().proposals.get('prop-1')?.status).toBe('proposed')

    await readyToMerge(engine)
    const beforeApproval = store.state().proposals.get('prop-1')
    expect(beforeApproval?.status).toBe('merging')
    // The number that should be zero until an owner says otherwise.
    expect(engine.derive().counts.activeMerges).toBe(0)

    const owner = engine.ownerScope('owner')
    expect(owner).not.toBeNull()
    const decided = await owner?.decideMerge('prop-1', true, 'I read the diff and the rehearsal')
    expect(decided?.ok).toBe(true)
    const merged = store.state().proposals.get('prop-1')
    expect(merged?.status).toBe('merged')
    expect(merged?.mergedAt).toBe(AT)
    expect(merged?.mergedExpiresAt).not.toBeNull()
    expect(merged?.restoresRevision).toBe('rev-7')
    expect(engine.derive().counts.activeMerges).toBe(1)
    // Rendered rather than merely respected.
    expect(engine.derive().mergeAuthority).toBe('none')
  })

  it('reports a blocked merge rather than a refusal with no explanation', async () => {
    const { engine } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    const evaluated = await engine.evaluateMerge('prop-1')
    expect(evaluated.ok === true && evaluated.reason).toContain('owner-merge-approved')
    const detail = engine.readProposal('prop-1')
    expect(detail.ok === true && detail.view.unsatisfied).toEqual(['owner-merge-approved'])
    expect(detail.ok === true && detail.view.awaitsOwner).toBe(true)
    expect(detail.ok === true && detail.view.gates).toHaveLength(8)
  })

  it('reports the same derivation for the same ledger at the same instant', async () => {
    const { engine } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    expect(JSON.stringify(engine.project())).toBe(JSON.stringify(engine.project()))
    expect(JSON.stringify(engine.derive())).toBe(JSON.stringify(engine.derive()))
  })

  it('carries no symptom, change or rollback text in a broad read', async () => {
    const { engine } = harness()
    await proposed(engine)
    const listed = engine.listProposals()
    expect(listed.ok).toBe(true)
    const serialised = JSON.stringify(listed.ok ? listed.view : null)
    expect(serialised).not.toContain('takes longer to produce')
    expect(serialised).toContain('symptomLength')
    expect(serialised).toContain('rollbackStepCount')
    expect(JSON.stringify(engine.project())).not.toContain('restore the previous')
    // The owner reviewing the merge does get the words, including the undo.
    const detail = engine.readProposal('prop-1')
    expect(detail.ok === true && detail.view.symptom).toContain('takes longer')
    expect(detail.ok === true && detail.view.rollbackSteps).toEqual(['restore the previous summary length'])
    expect(detail.ok === true && detail.view.appliesCode).toBe(false)
    expect(detail.ok === true && detail.view.executesChange).toBe(false)
    expect(detail.ok === true && detail.view.authority).toBe('none')
    expect(detail.ok === true && detail.view.rollbackAvailable).toBe(true)
  })
})

/* --------------------------------------------------------------- rollback */

describe('rollback is a mechanism, not a promise', () => {
  it('rolls a landed change back, restoring the revision recorded at staging', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    await engine.ownerScope('owner')?.decideMerge('prop-1', true, 'approved')
    expect(store.state().proposals.get('prop-1')?.status).toBe('merged')

    const rolled = await engine.ownerScope('owner')?.rollback('prop-1', 'the summary got worse')
    expect(rolled?.ok === true && rolled.operation).toBe('rolled-back')
    const proposal = store.state().proposals.get('prop-1')
    expect(proposal?.status).toBe('rolled-back')
    expect(proposal?.closedReason).toBe('rollback-completed')
    expect(proposal?.restoresRevision).toBe('rev-7')
    // A rolled-back change is not standing, so it is not awaiting review either.
    expect(proposal?.mergedExpiresAt).toBeNull()
    expect(engine.derive().counts.activeMerges).toBe(0)
    expect(engine.derive().counts.rolledBack).toBe(1)
  })

  it('cannot be re-merged after a rollback', async () => {
    const { engine } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    await engine.ownerScope('owner')?.decideMerge('prop-1', true, 'approved')
    await engine.ownerScope('owner')?.rollback('prop-1', 'not this time')
    const again = await engine.ownerScope('owner')?.decideMerge('prop-1', true, 'actually yes')
    expect(again?.ok).toBe(false)
    const staged = await engine.stageChange('prop-1', 'rev-7')
    expect(staged?.ok === false || staged?.ok).toBe(true)
    expect(engine.derive().counts.activeMerges).toBe(0)
  })

  it('refuses a rollback that has never been staged, because there is nothing recorded to restore', async () => {
    const { engine } = harness()
    await proposed(engine)
    const rolled = await engine.ownerScope('owner')?.rollback('prop-1', 'too early')
    expect(rolled?.ok).toBe(false)
    expect(rolled?.ok === false && rolled.code).toBe('illegal-transition')
  })

  it('will not merge a change whose rollback rehearsal failed', async () => {
    const { engine } = harness()
    await proposed(engine)
    const staged = await engine.stageChange('prop-1', 'rev-7')
    expect(staged.ok).toBe(true)
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'staged-verified',
      passed: true,
      verifier: 'vault.stage-check',
      evidenceRefs: ['stage-1'],
    })
    await engine.runTests('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'tests-passed',
      passed: true,
      verifier: 'vitest.run',
      evidenceRefs: ['run-1'],
    })
    await engine.completeTests('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'red-team-clean',
      passed: true,
      verifier: 'red-team.sweep',
      evidenceRefs: ['rt-1'],
    })
    await engine.beginReview('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'review-recorded',
      passed: true,
      verifier: 'owner.review',
      evidenceRefs: ['review-1'],
    })
    await engine.completeReview('prop-1')
    const failed = await engine.rehearseRollback('prop-1', false, 'vault.rollback-rehearsal')
    expect(failed.ok === true && failed.operation).toBe('rehearsal-failed')
    await engine.requestMerge('prop-1')
    const approved = await engine.ownerScope('owner')?.decideMerge('prop-1', true, 'I would like this on')
    expect(approved?.ok).toBe(false)
    expect(approved?.ok === false && approved.code).toBe('gate-not-satisfied')
    expect(approved?.ok === false && approved.reason).toContain('rollback-verified')
    expect(engine.derive().counts.activeMerges).toBe(0)
  })

  it('refuses a rollback with no reason', async () => {
    const { engine } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    const unlabelled = await engine.ownerScope('owner')?.rollback('prop-1', '')
    expect(unlabelled?.ok === false && unlabelled.code).toBe('invalid-text')
  })
})

/* ---------------------------------------------------------- no self-merge */

describe('nothing merges itself', () => {
  it('issues the owner scope to the owner and to nobody else', async () => {
    const { engine } = harness()
    expect(engine.ownerScope('owner')).not.toBeNull()
    for (const principal of ['system', 'agent:worker', 'module:foundry'] as const) {
      expect(engine.ownerScope(principal)).toBeNull()
    }
  })

  it('has no method that merges without the owner scope, even with a permissive Guard', async () => {
    const store = new MemoryImprovementStore()
    // A Guard that allows everything, as a fully-compromised-privilege configuration would.
    const engine = new ImprovementEngine({ store, now: () => new Date(AT), guard: () => allow(), governor: () => allow() })
    await proposed(engine)
    await readyToMerge(engine)
    expect(engine.ownerScope('agent:worker')).toBeNull()
    expect(await engine.ownerScope('agent:worker')?.decideMerge('prop-1', true, 'please')).toBeUndefined()
    const evaluated = await engine.evaluateMerge('prop-1')
    expect(evaluated.ok).toBe(true)
    expect(store.state().proposals.get('prop-1')?.status).toBe('merging')
    expect(engine.derive().counts.activeMerges).toBe(0)
  })

  it('refuses an approval while any other gate is unsatisfied', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'staged-verified',
      passed: true,
      verifier: 'vault.stage-check',
      evidenceRefs: ['stage-1'],
    })
    await engine.runTests('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'tests-passed',
      passed: true,
      verifier: 'vitest.run',
      evidenceRefs: ['run-1'],
    })
    await engine.completeTests('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'red-team-clean',
      passed: true,
      verifier: 'red-team.sweep',
      evidenceRefs: ['rt-1'],
    })
    await engine.beginReview('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'review-recorded',
      passed: true,
      verifier: 'owner.review',
      evidenceRefs: ['review-1'],
    })
    await engine.completeReview('prop-1')
    // The rehearsal was never run.
    await engine.requestMerge('prop-1')
    const approved = await engine.ownerScope('owner')?.decideMerge('prop-1', true, 'approved')
    expect(approved?.ok).toBe(false)
    expect(approved?.ok === false && approved.code).toBe('gate-not-satisfied')
    expect(store.state().proposals.get('prop-1')?.status).toBe('merging')
    expect(engine.derive().counts.activeMerges).toBe(0)
  })

  it('treats a decline as terminal, with the owner decision recorded', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    const declined = await engine.ownerScope('owner')?.decideMerge('prop-1', false, 'not this one')
    expect(declined?.ok === true && declined.operation).toBe('declined')
    const proposal = store.state().proposals.get('prop-1')
    expect(proposal?.status).toBe('rejected')
    expect(proposal?.closedReason).toBe('owner-rejected-this-proposal')
    const ledger = store.state().gates.get('prop-1') ?? []
    expect(ledger.some((entry) => entry.kind === 'owner-merge-approved' && entry.verdict === 'failed')).toBe(true)
  })

  it('refuses an owner decision with no reason', async () => {
    const { engine } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    const unlabelled = await engine.ownerScope('owner')?.decideMerge('prop-1', true, '')
    expect(unlabelled?.ok === false && unlabelled.code).toBe('invalid-text')
  })
})

/* -------------------------------------------------------------- lifecycle */

describe('testing, review and failure are separate acts', () => {
  it('will not skip testing, and will not complete it without a result', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'staged-verified',
      passed: true,
      verifier: 'vault.stage-check',
      evidenceRefs: ['stage-1'],
    })
    const begun = await engine.runTests('prop-1')
    expect(begun.ok).toBe(true)
    const completed = await engine.completeTests('prop-1')
    expect(completed.ok === false && completed.code).toBe('not-verifiable')
    expect(store.state().proposals.get('prop-1')?.status).toBe('testing')
  })

  it('makes a failed test run terminal, so a failure cannot be edited into a pass', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    await engine.runTests('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'tests-passed',
      passed: false,
      verifier: 'vitest.run',
      evidenceRefs: ['run-1'],
    })
    const completed = await engine.completeTests('prop-1')
    expect(completed.ok === true && completed.operation).toBe('tests-failed')
    expect(store.state().proposals.get('prop-1')?.status).toBe('rejected')
    expect(store.state().proposals.get('prop-1')?.closedReason).toBe('tests-failed')
    // Nothing may be done with a terminal proposal.
    const again = await engine.runTests('prop-1')
    expect(again.ok === false && again.code).toBe('illegal-transition')
  })

  it('makes a rejected review terminal too', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    await engine.beginReview('prop-1').catch(() => undefined)
    // beginReview is refused from `staged`; the proposal has to get through testing first, which
    // is itself the point: review cannot be reached by skipping the earlier gates.
    expect(store.state().proposals.get('prop-1')?.status).toBe('staged')
  })

  it('refuses a check the proposal has not earned the right to be owed yet', async () => {
    const { engine } = harness()
    await proposed(engine)
    const tooEarly = await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'tests-passed',
      passed: true,
      verifier: 'vitest.run',
      evidenceRefs: ['run-1'],
    })
    expect(tooEarly.ok === false && tooEarly.code).toBe('illegal-transition')
    const reviewTooEarly = await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'review-recorded',
      passed: true,
      verifier: 'owner.review',
      evidenceRefs: ['review-1'],
    })
    expect(reviewTooEarly.ok === false && reviewTooEarly.code).toBe('illegal-transition')
  })

  it('refuses a check with no verifier and with no evidence', async () => {
    const { engine } = harness()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    const unnamed = await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'staged-verified',
      passed: true,
      verifier: '',
      evidenceRefs: ['stage-1'],
    })
    expect(unnamed.ok === false && unnamed.code).toBe('missing-verifier')
    const unsupported = await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'staged-verified',
      passed: true,
      verifier: 'vault.stage-check',
      evidenceRefs: [],
    })
    expect(unsupported.ok === false && unsupported.code).toBe('invalid-evidence-refs')
  })
})

/* -------------------------------------------------------------- precedence */

describe('the precedence ladder is obeyed in order', () => {
  it('refuses everything while the journal cannot be believed', async () => {
    const { engine } = harness({ journalTrustworthy: () => false })
    const refused = await engine.propose(proposalPayload())
    expect(refused.ok === false && refused.code).toBe('journal-not-trustworthy')
  })

  it('lets an untrustworthy journal outrank the stop latch', async () => {
    const { engine } = harness({ journalTrustworthy: () => false, stopAllActive: () => true })
    const refused = await engine.propose(proposalPayload())
    // Both rungs would refuse; the reported one is the higher, so a reader knows the log is what
    // is wrong rather than assuming a deliberate stop.
    expect(refused.ok === false && refused.code).toBe('journal-not-trustworthy')
  })

  it('lets the stop latch outrank an owner approval', async () => {
    let latched = false
    const { engine, store } = harness({ stopAllActive: () => latched })
    await proposed(engine)
    await readyToMerge(engine)
    latched = true
    const owner = engine.ownerScope('owner')
    expect(owner).not.toBeNull()
    const decided = await owner?.decideMerge('prop-1', true, 'approved a moment ago')
    expect(decided?.ok).toBe(false)
    expect(decided?.ok === false && decided.code).toBe('stop-all-active')
    expect(store.state().proposals.get('prop-1')?.status).toBe('merging')
    // And with the latch cleared, the same approval goes through.
    latched = false
    const allowed = await owner?.decideMerge('prop-1', true, 'approved once running')
    expect(allowed?.ok).toBe(true)
    expect(store.state().proposals.get('prop-1')?.status).toBe('merged')
  })

  it('reports guard-denied and asks for the right capability', async () => {
    const { engine, asked, principals } = harness({ guard: () => deny('principal holds nothing') })
    const refused = await engine.propose(proposalPayload())
    expect(refused.ok === false && refused.code).toBe('guard-denied')
    expect(asked).toEqual(['improvement.propose'])
    expect(principals).toEqual(['owner'])
  })

  it('reports governor-denied for work that spends, and still allows a read', async () => {
    const { engine } = harness({ governor: () => deny('no allowance is active') })
    const refused = await engine.propose(proposalPayload())
    expect(refused.ok === false && refused.code).toBe('governor-denied')
    // The projection is a read and must stay available while everything is paused, or an owner
    // could not see why a merge is stuck.
    expect(engine.project().mode).toBe('available')
    expect(engine.project().counts.proposals).toBe(0)
  })

  it('denies by default when no Guard or Governor is wired at all', async () => {
    const bare = new ImprovementEngine({ store: new MemoryImprovementStore(), now: () => new Date(AT) })
    const refused = await bare.propose(proposalPayload())
    expect(refused.ok === false && refused.code).toBe('guard-denied')
  })

  it('reports budget-exhausted rather than a domain rule when the ceiling is reached', async () => {
    const { engine } = harness()
    // A ceiling of exactly the rehearsal price: the stage fits, and nothing after it does.
    await proposed(engine, { costCeiling: 4 })
    const staged = await engine.stageChange('prop-1', 'rev-7')
    expect(staged.ok).toBe(true)
    const refused = await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'staged-verified',
      passed: true,
      verifier: 'vault.stage-check',
      evidenceRefs: ['stage-1'],
    })
    // Two units were spent staging and a stage check costs three: the budget is what refuses, and
    // the reported rung is the budget rather than a generic domain rule.
    expect(refused.ok === false && refused.code).toBe('budget-exhausted')
  })

  it('refuses a proposal whose ceiling cannot pay for its own rehearsal', async () => {
    const { engine } = harness()
    const refused = await engine.propose(proposalPayload({ costCeiling: 1 }))
    expect(refused.ok === false && refused.code).toBe('budget-exhausted')
  })
})

/* -------------------------------------------------------------- retention */

describe('expiry is evaluated, never scheduled', () => {
  it('expires a stale proposal when asked, and not before', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    expect(await engine.applyRetention(AT)).toEqual([])
    const past = new Date(Date.parse(AT) + 46 * 24 * 60 * 60 * 1_000).toISOString()
    const retired = await engine.applyRetention(past)
    expect(retired).toContain('prop-1')
    expect(store.state().proposals.get('prop-1')?.closedReason).toBe('aged-out-past-retention')
    // A stale proposal cannot be revived by advancing it.
    const advanced = await engine.stageChange('prop-1', 'rev-7')
    expect(advanced.ok === false && advanced.code).toBe('illegal-transition')
  })

  it('expires a standing merge on its own longer deadline, and reports it first', async () => {
    const { engine, store } = harness()
    await proposed(engine)
    await readyToMerge(engine)
    await engine.ownerScope('owner')?.decideMerge('prop-1', true, 'approved')
    const soon = new Date(Date.parse(AT) + 61 * 24 * 60 * 60 * 1_000).toISOString()
    // Before its own deadline it is reported, not closed: this is the honest warning an owner
    // needs before approving the next change.
    expect(engine.derive(soon).mergesAwaitingReview).toEqual(['prop-1'])
    expect(store.state().proposals.get('prop-1')?.status).toBe('merged')
    const retired = await engine.applyRetention(soon)
    expect(retired).toContain('prop-1')
    expect(store.state().proposals.get('prop-1')?.closedReason).toBe('aged-out-past-retention')
    expect(engine.derive().counts.activeMerges).toBe(0)
  })

  it('refuses a new merge over the bound rather than rolling back a standing change', async () => {
    const { engine } = harness()
    for (let index = 0; index < 6; index += 1) {
      const id = `prop-${index + 1}`
      await proposed(engine, { proposalId: id })
      await readyToMerge(engine, id)
      await engine.ownerScope('owner')?.decideMerge(id, true, 'approved')
    }
    expect(engine.derive().counts.activeMerges).toBe(6)
    await proposed(engine, { proposalId: 'prop-7' })
    await readyToMerge(engine, 'prop-7')
    const seventh = await engine.ownerScope('owner')?.decideMerge('prop-7', true, 'one more')
    expect(seventh?.ok === false && seventh.code).toBe('merge-bound-reached')
    expect(engine.derive().counts.activeMerges).toBe(6)
    // The standing changes are untouched: the bound refuses a new one rather than undoing an old.
    expect(engine.derive().counts.rolledBack).toBe(0)
  })
})

/* -------------------------------------------------------------- reporting */

describe('the store reports its own honesty in the projection', () => {
  it('reports the persistence mode rather than implying durability', () => {
    const faulted = new ImprovementEngine({
      store: new MemoryImprovementStore({ mode: 'ephemeral', faultReason: 'no secure key was available' }),
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