import { describe, expect, it } from 'vitest'
import {
  DERIVED_IMPROVEMENT_GATE_KINDS,
  FORBIDDEN_IMPROVEMENTS,
  IMPROVEMENT_APPLIES_NOTHING,
  IMPROVEMENT_GATE_KINDS,
  IMPROVEMENT_RECORD_VERSION,
  IMPROVEMENT_RETENTION,
  PROTECTED_IMPROVEMENT_SURFACES,
  ImprovementEngine,
  advanceImprovement,
  createImprovementProposal,
  decideMerge,
  describeStage,
  latestLedgerGateRecords,
  rebuildImprovementProposal,
  recordImprovementGate,
  recordOwnerMergeApproval,
  rollBackImprovement,
  type ImprovementGateRecord,
  type ImprovementProposal,
} from '../../../core/improvement'
import { MemoryImprovementStore } from '../../../core/vault/repositories/improvement-store'

/**
 * THE ATTACKS, aimed at the thing this phase exists to prevent.
 *
 * Five families, each named after the invariant it is trying to break:
 *
 * - `self-merge` — a change to Freya's own architecture that lands without a person.
 * - `gate-bypass` — a merge that skips a gate, a stale gate, or the rollback rehearsal.
 * - `brake-removal` — a proposal that disables the gates, the rollback, or the owner's own
 *   approval as its first step. This is the specific way a self-improving system eats itself.
 * - `rollback-evasion` — a landed change that cannot be undone, or a rollback that restores
 *   whatever happened to be there.
 * - `untrusted-change` — text and payloads that try to talk their way past a refusal.
 *
 * Every attack is an *untyped payload*, a *hand-edited record*, or an engine with a Guard that
 * allows everything — because a typed caller is already constrained by the compiler and the
 * interesting adversary is not one.
 */

const AT = '2026-06-01T09:00:00.000Z'

function allow(): { allowed: boolean; reason: string } {
  return { allowed: true, reason: 'held' }
}

/** An engine that behaves, plus the store behind it, so an attack can inspect the result. */
function engineOn(store: MemoryImprovementStore | VaultStoreShape = new MemoryImprovementStore()): ImprovementEngine {
  return new ImprovementEngine({
    store,
    now: () => new Date(AT),
    journalTrustworthy: () => true,
    stopAllActive: () => false,
    guard: () => allow(),
    governor: () => allow(),
  })
}

type VaultStoreShape = MemoryImprovementStore

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Drive a proposal to `merging` with every gate but the owner's passed. */
async function readyToMerge(engine: ImprovementEngine, id = 'prop-1'): Promise<void> {
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
}

async function proposed(engine: ImprovementEngine, overrides: Record<string, unknown> = {}): Promise<void> {
  const recorded = await engine.propose(payload(overrides))
  if (!recorded.ok) throw new Error(`fixture refused: ${recorded.code} ${recorded.reason}`)
}

/* ------------------------------------------------------------- self-merge */

describe('a change to Freya cannot land without a person', () => {
  it('refuses a payload that declares itself already merged or already staged', async () => {
    const engine = engineOn()
    for (const field of [{ status: 'merged' }, { status: 'staged' }, { scope: 'owner' }, { autoMerge: true }]) {
      const refused = await engine.propose({ ...payload(), ...field })
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('forbidden-field-refused')
    }
    expect(engine.derive().counts.activeMerges).toBe(0)
  })

  it('refuses a payload carrying an instruction, a grant or a git verb', async () => {
    const engine = engineOn()
    for (const field of [
      { applyCode: true },
      { execute: 'npm run deploy' },
      { gitPush: true },
      { forcePush: true },
      { spawn: 'bash' },
      { grantsCapability: true },
      { disableRollback: true },
      { clearsStopAll: true },
    ]) {
      const refused = await engine.propose({ ...payload(), ...field })
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('forbidden-field-refused')
    }
  })

  it('refuses a merge approval from every authority but the owner', () => {
    for (const authority of ['verifier', 'core', 'gate'] as const) {
      const refused = recordImprovementGate(
        {
          kind: 'owner-merge-approved',
          verdict: 'passed',
          reason: 'owner-approved-this-merge',
          verifier: 'owner',
          evidenceRefs: [],
        },
        authority,
        AT,
      )
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('not-owner')
    }
    // And the owner function is the only producer, with the authority hard-set.
    const approval = recordOwnerMergeApproval(true, AT)
    expect(approval.ok === true && approval.record.authority).toBe('owner')
  })

  it('gives a non-owner principal no way to reach a merge, whatever the Guard allows', async () => {
    const store = new MemoryImprovementStore()
    // A Guard that allows everything, as a fully-compromised-privilege configuration would.
    const engine = new ImprovementEngine({ store, now: () => new Date(AT), guard: () => allow(), governor: () => allow() })
    await proposed(engine)
    await readyToMerge(engine)
    // The owner scope is not a capability: it is an object the engine issues to one principal.
    expect(engine.ownerScope('agent:worker')).toBeNull()
    expect(engine.ownerScope('system')).toBeNull()
    expect(engine.ownerScope('module:foundry')).toBeNull()
    expect(await engine.ownerScope('agent:worker')?.decideMerge('prop-1', true, 'please')).toBeUndefined()
    expect(await engine.ownerScope('agent:worker')?.rollback('prop-1', 'please')).toBeUndefined()
    expect(store.state().proposals.get('prop-1')?.status).toBe('merging')
    expect(engine.derive().counts.activeMerges).toBe(0)
  })

  it('applies nothing, executes nothing and never self-merges, as data rather than as prose', () => {
    expect(IMPROVEMENT_APPLIES_NOTHING.appliesCode).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.executesChange).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.maySelfMerge).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.mayDisableItsOwnGates).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.rollbackAlwaysAvailable).toBe(true)
    expect(IMPROVEMENT_RECORD_VERSION).toBe(1)
  })

  it('describes every stage as owner-applied, with no producer for anything else', () => {
    const stage = describeStage({ target: 'module-code', summary: 'split the summary builder', breadth: 2 })
    expect(stage.appliedBy).toBe('owner')
    // A payload naming who applies it is refused, so the description cannot be redirected.
    const redirected = createImprovementProposal(payload({ appliedBy: 'freya' }))
    expect(redirected.ok).toBe(false)
  })

  it('refuses a merge approval offered in place of a gate that failed', async () => {
    const engine = engineOn()
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
      passed: false,
      verifier: 'vitest.run',
      evidenceRefs: ['run-1'],
    })
    await engine.completeTests('prop-1')
    expect(engine.derive().counts.activeMerges).toBe(0)
  })
})

/* ------------------------------------------------------------ gate bypass */

describe('a merge cannot skip, stale-pass or self-report a gate', () => {
  it('refuses a hand-written verdict on a gate that is computed from the proposal', () => {
    for (const [kind, reason] of [
      ['no-protected-surface', 'touches-no-protected-surface'],
      ['no-authority-widening', 'requires-no-forbidden-change'],
    ] as const) {
      const refused = recordImprovementGate(
        { kind, verdict: 'passed', reason, verifier: 'core', evidenceRefs: [] },
        'core',
        AT,
      )
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('gate-may-not-be-self-reported')
    }
  })

  it('refuses a verdict whose reason belongs to another gate', () => {
    const refused = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'rollback-rehearsed-successfully',
        verifier: 'vitest.run',
        evidenceRefs: ['run-1'],
      },
      'verifier',
      AT,
    )
    expect(refused.ok === false && refused.code).toBe('invalid-gate-reason')
  })

  it('refuses a verdict that contradicts its own label', () => {
    const refused = recordImprovementGate(
      {
        kind: 'rollback-verified',
        verdict: 'passed',
        reason: 'rollback-rehearsal-failed',
        verifier: 'vault.rollback-rehearsal',
        evidenceRefs: ['rehearsal-1'],
      },
      'verifier',
      AT,
    )
    expect(refused.ok === false && refused.code).toBe('invalid-gate-reason')
  })

  it('refuses a verdict from the gate evaluator itself', () => {
    const refused = recordImprovementGate(
      {
        kind: 'review-recorded',
        verdict: 'passed',
        reason: 'review-recorded-by-a-named-reviewer',
        verifier: 'gate',
        evidenceRefs: ['review-1'],
      },
      'gate',
      AT,
    )
    expect(refused.ok === false && refused.code).toBe('gate-may-not-be-self-reported')
  })

  it('refuses a verdict with no name behind it', () => {
    const unnamed = recordImprovementGate(
      {
        kind: 'red-team-clean',
        verdict: 'passed',
        reason: 'red-team-reported-clean',
        verifier: '',
        evidenceRefs: ['rt-1'],
      },
      'verifier',
      AT,
    )
    expect(unnamed.ok === false && unnamed.code).toBe('missing-verifier')
    const unsupported = recordImprovementGate(
      {
        kind: 'red-team-clean',
        verdict: 'passed',
        reason: 'red-team-reported-clean',
        verifier: 'red-team.sweep',
        evidenceRefs: [],
      },
      'verifier',
      AT,
    )
    expect(unsupported.ok === false && unsupported.code).toBe('invalid-evidence-refs')
  })

  it('treats not-applicable as unsatisfied rather than as a way past', async () => {
    const engine = engineOn()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    await engine.runTests('prop-1')
    const skipped = await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'tests-passed',
      passed: false,
      notApplicable: true,
      verifier: 'vitest.run',
      evidenceRefs: ['run-1'],
    })
    expect(skipped.ok === true && skipped.operation).toBe('tests-failed')
    const completed = await engine.completeTests('prop-1')
    expect(completed.ok === true && completed.operation).toBe('tests-failed')
  })

  it('lets a later failure override an earlier pass, rather than the other way round', async () => {
    const engine = engineOn()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    await engine.runTests('prop-1')
    await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'tests-passed',
      passed: true,
      verifier: 'vitest.run',
      evidenceRefs: ['run-1'],
    })
    const failed = await engine.recordCheck({
      proposalId: 'prop-1',
      kind: 'tests-passed',
      passed: false,
      verifier: 'vitest.run',
      evidenceRefs: ['run-2'],
    })
    expect(failed.ok === true && failed.operation).toBe('tests-failed')
    const ledger = engine.listProposals()
    expect(ledger.ok).toBe(true)
    const completed = await engine.completeTests('prop-1')
    // Newest wins, so the second run's failure is the fact about the change.
    expect(completed.ok === true && completed.operation).toBe('tests-failed')
  })

  it('refuses a stored row whose deadline was widened, and one with no rollback revision', () => {
    const created = createImprovementProposal(payload())
    if (!created.ok) throw new Error('fixture refused')
    const genuine = created.value
    expect(rebuildImprovementProposal({ ...genuine, expiresAt: '2099-01-01T00:00:00.000Z' }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...genuine, costSpent: genuine.costCeiling + 1 }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...genuine, confidence: 'verified' }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...genuine, requirements: ['improvement.merge.auto'] }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...genuine, targets: ['rollback-mechanism'] }).ok).toBe(false)
  })

  it('ignores a ledger entry naming a computed gate when reading the newest per kind', () => {
    const smuggled: ImprovementGateRecord = {
      kind: 'no-protected-surface',
      verdict: 'passed',
      reason: 'touches-no-protected-surface',
      authority: 'gate',
      verifier: null,
      evidenceRefs: [],
      recordedAt: AT,
    }
    const tests = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'tests-reported-passing',
        verifier: 'vitest.run',
        evidenceRefs: ['run-1'],
      },
      'verifier',
      AT,
    )
    if (!tests.ok) throw new Error('fixture refused')
    // The reader drops the smuggled entry; the derived gate is recomputed from the proposal.
    expect(latestLedgerGateRecords([smuggled, tests.record])['tests-passed'].verdict).toBe('passed')
  })
})

/* ---------------------------------------------------------- brake removal */

describe('a proposal cannot remove its own brakes as its first step', () => {
  it('refuses every forbidden requirement at construction, brakes included', async () => {
    const engine = engineOn()
    for (const requirement of FORBIDDEN_IMPROVEMENTS) {
      const refused = await engine.propose(payload({ requirements: [requirement] }))
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('forbidden-improvement')
    }
    expect(engine.derive().counts.proposals).toBe(0)
  })

  it('refuses every protected surface, including its own gates and rollback', async () => {
    const engine = engineOn()
    for (const target of PROTECTED_IMPROVEMENT_SURFACES) {
      const refused = await engine.propose(payload({ targets: [target] }))
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('protected-surface')
    }
  })

  it('recomputes the widening and surface gates from a hand-widened proposal', () => {
    const created = createImprovementProposal(payload())
    if (!created.ok) throw new Error('fixture refused')
    const widened = {
      ...created.value,
      requirements: ['improvement.gates.write'],
      targets: ['improvement-gates'],
    } as ImprovementProposal
    const decision = decideMerge(widened, [], AT)
    expect(decision.approved).toBe(false)
    expect(decision.unsatisfied).toContain('no-authority-widening')
    expect(decision.unsatisfied).toContain('no-protected-surface')
    // And the stored-row check refuses it independently of the gate.
    expect(rebuildImprovementProposal(widened).ok).toBe(false)
  })

  it('lists every gate and every one of them is required', () => {
    expect(IMPROVEMENT_GATE_KINDS).toHaveLength(8)
    // Two of the eight are computed from the proposal and cannot be asserted by hand at all.
    expect(DERIVED_IMPROVEMENT_GATE_KINDS).toHaveLength(2)
    const decision = decideMerge(stagedAtMerging(), [], AT)
    expect(decision.gates).toHaveLength(8)
    // Six are owed: the two computed ones read from the proposal and pass, the six ledger gates
    // are unanswered. Nothing is treated as a pass for having been skipped.
    expect(decision.unsatisfied).toHaveLength(6)
    expect(decision.unsatisfied).not.toContain('no-protected-surface')
    expect(decision.approved).toBe(false)
  })
})

/* -------------------------------------------------------- rollback evasion */

describe('a landed change cannot be made irreversible', () => {
  it('keeps merged → rolled-back as the only edge out of merged', () => {
    const merged = unwrap(advanceImprovement(stagedAtMerging(), { now: AT, to: 'merged' }))
    expect(merged.status).toBe('merged')
    // No re-merging, no re-staging, no re-reviewing. A landed change is undone, not resumed.
    expect(advanceImprovement(merged, { now: AT, to: 'merged' }).ok).toBe(false)
    expect(advanceImprovement(merged, { now: AT, to: 'staging' }).ok).toBe(false)
    expect(advanceImprovement(merged, { now: AT, to: 'reviewing' }).ok).toBe(false)
    expect(advanceImprovement(merged, { now: AT, to: 'merging' }).ok).toBe(false)
    // And the one edge out of it is a rollback, which restores the recorded revision.
    const rolled = rollBackImprovement(merged, { now: AT })
    expect(rolled.ok === true && rolled.value.restoresRevision).toBe('rev-7')
  })

  it('refuses a rollback with no recorded revision rather than guessing a target', () => {
    const created = createImprovementProposal(payload())
    if (!created.ok) throw new Error('fixture refused')
    // Nothing was staged, so nothing recorded what a rollback would restore. A proposal that was
    // never staged cannot even be rolled back by the transition table, and one that was staged
    // only halfway has no revision to restore.
    expect(recordRollback(created.value).ok).toBe(false)
    const staging = advanceImprovement(created.value, { now: AT, to: 'staging' })
    expect(staging.ok).toBe(true)
    const result = staging.ok ? recordRollback(staging.value) : null
    expect(result === null || result.ok).toBe(false)
    // And the table itself refuses the status, so there is no second route that forgets the check.
    expect(staging.ok && advanceImprovement(staging.value, { now: AT, to: 'rolled-back' }).ok).toBe(false)
  })

  it('refuses a proposal whose ceiling cannot pay for the rehearsal', async () => {
    const engine = engineOn()
    const refused = await engine.propose(payload({ costCeiling: 1 }))
    expect(refused.ok === false && refused.code).toBe('budget-exhausted')
  })

  it('requires a rehearsal before a merge, and reports a missing one as unrehearsed', async () => {
    const engine = engineOn()
    await proposed(engine)
    await engine.stageChange('prop-1', 'rev-7')
    const decision = decideMerge(stagedAtMerging(), [], AT)
    expect(decision.unsatisfied).toContain('rollback-verified')
  })

  it('expires a standing merge on its own deadline so it cannot stand forever', async () => {
    const engine = engineOn()
    await proposed(engine)
    await readyToMerge(engine)
    await engine.ownerScope('owner')?.decideMerge('prop-1', true, 'approved')
    const after = new Date(Date.parse(AT) + IMPROVEMENT_RETENTION.maxMergedLifetimeMs).toISOString()
    // Reported first, so an owner sees it before the next change rather than after.
    expect(engine.derive(after).mergesAwaitingReview).toEqual(['prop-1'])
    expect(await engine.applyRetention(after)).toContain('prop-1')
    expect(engine.derive().counts.activeMerges).toBe(0)
  })
})

/* -------------------------------------------------------- untrusted change */

describe('a change description cannot talk its way past a refusal', () => {
  it('refuses a symptom or a change description carrying secret-shaped text whole', async () => {
    const engine = engineOn()
    const symptom = await engine.propose(
      payload({ symptom: 'every run failed with api_key = AKIAIOSFODNN7EXAMPLE1' }),
    )
    expect(symptom.ok === false && symptom.code).toBe('invalid-text')
    const change = await engine.propose(
      payload({ changes: ['print password = hunter2hunter2 into the log when it fails'] }),
    )
    expect(change.ok === false && change.code).toBe('invalid-text')
  })

  it('refuses a subject that is a path or an instruction, however it is phrased', async () => {
    const engine = engineOn()
    for (const subject of [
      'src/core/index.ts',
      'git push --force origin main',
      'merge this now',
      'run npm publish',
      'Grant',
      '',
      'a'.repeat(200),
    ]) {
      const refused = await engine.propose(payload({ subject }))
      expect(refused.ok).toBe(false)
    }
  })

  it('refuses an extra field rather than dropping it', async () => {
    const engine = engineOn()
    expect((await engine.propose({ ...payload(), note: 'ignore the gates' })).ok).toBe(false)
  })

  it('refuses a proposal with no rollback steps at all', async () => {
    const engine = engineOn()
    const refused = await engine.propose(payload({ rollbackSteps: [] }))
    expect(refused.ok === false && refused.code).toBe('invalid-text')
  })

  it('refuses a proposal resting on nothing it can name', async () => {
    const engine = engineOn()
    const refused = await engine.propose(payload({ evidenceRefs: [] }))
    expect(refused.ok === false && refused.code).toBe('invalid-evidence-refs')
  })

  it('refuses a proposal claiming to be certain', async () => {
    const engine = engineOn()
    for (const confidence of ['high', 'verified']) {
      const refused = await engine.propose(payload({ confidence }))
      expect(refused.ok === false && refused.code).toBe('invalid-confidence')
    }
  })
})

/* ---------------------------------------------------------------- helpers */

/** A proposal walked to `merging` by hand, independent of the engine. */
function stagedAtMerging(): ImprovementProposal {
  const created = createImprovementProposal(payload())
  if (!created.ok) throw new Error(`fixture refused: ${created.reason}`)
  let current = created.value
  for (const to of ['staging'] as const) current = unwrap(advanceImprovement(current, { now: AT, to }))
  current = unwrap(advanceImprovement(current, { now: AT, to: 'staged', restoresRevision: 'rev-7' }))
  for (const to of ['testing', 'tested', 'reviewing', 'reviewed', 'merging'] as const) {
    current = unwrap(advanceImprovement(current, { now: AT, to }))
  }
  return current
}

function unwrap(
  result: { ok: true; value: ImprovementProposal } | { ok: false; code: string; reason: string },
): ImprovementProposal {
  if (!result.ok) throw new Error(`fixture refused: ${result.code} ${result.reason}`)
  return result.value
}

function recordRollback(
  proposal: ImprovementProposal,
): { ok: true; value: ImprovementProposal } | { ok: false; code: string; reason: string } {
  // `rollBackImprovement` is exercised through the engine; here the point is the *state*: a
  // proposal that was only ever `staging` has no revision, so a rollback has nothing to restore.
  const rolled = advanceImprovement(proposal, { now: AT, to: 'rolled-back' })
  if (!rolled.ok) return { ok: false, code: rolled.code, reason: rolled.reason }
  return { ok: true, value: rolled.value }
}

void IMPROVEMENT_APPLIES_NOTHING
void IMPROVEMENT_RECORD_VERSION