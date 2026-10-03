import { describe, expect, it } from 'vitest'
import {
  DERIVED_IMPROVEMENT_GATE_KINDS,
  FORBIDDEN_IMPROVEMENTS,
  IMPROVEMENT_APPLIES_NOTHING,
  IMPROVEMENT_COST_UNITS,
  IMPROVEMENT_FORBIDDEN_FIELDS,
  IMPROVEMENT_GATE_KINDS,
  IMPROVEMENT_GATE_REASONS_BY_KIND,
  IMPROVEMENT_GATE_REASONS_BY_VERDICT,
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_PRECEDENCE,
  IMPROVEMENT_RECORD_VERSION,
  IMPROVEMENT_REFUSAL_CODES,
  IMPROVEMENT_RETENTION,
  IMPROVEMENT_TRANSITIONS,
  LEDGER_IMPROVEMENT_GATE_KINDS,
  PROTECTED_IMPROVEMENT_SURFACES,
  advanceImprovement,
  applyRecord,
  canTransitionImprovement,
  chargeImprovementCost,
  closeImprovementProposal,
  createImprovementProposal,
  decideMerge,
  describeStage,
  deriveImprovement,
  emptyImprovementState,
  everyGateSatisfied,
  evaluateDerivedGates,
  expireStaleImprovement,
  expireStaleMerge,
  isForbiddenImprovementFieldName,
  isMergeStale,
  isStaleProposal,
  latestGateRecords,
  latestLedgerGateRecords,
  reasonForMergeDecision,
  recordImprovementGate,
  recordKey,
  recordOwnerMergeApproval,
  rebuildGateLedger,
  rebuildImprovementProposal,
  rebuildMergeDecision,
  rollBackImprovement,
  unsatisfiedImprovementGates,
  validateDecisionGate,
  validateImprovementGate,
  validateRecord,
  type ImprovementGateRecord,
  type ImprovementProposal,
} from '../../core/improvement'

/**
 * PHASE 30 — THE CONTRACT, WITHOUT AN ENGINE.
 *
 * The claims pinned here are the ones a reader has to be able to check by reading the code:
 *
 * - a change starts **unstaged**, and no input can say otherwise;
 * - a merge is a **conjunction over eight gates**, two of which may not be asserted by hand at all;
 * - evidence must name its producer, and a verdict whose reason belongs to another gate is
 *   refused rather than stored;
 * - **rollback is a mechanism, not a promise**: `merged → rolled-back` is the only edge out of
 *   `merged`, and a rollback with no recorded revision is refused rather than guessed at;
 * - a failure is **terminal**, so a failed change cannot be edited back into a pass;
 * - every deadline is derived from a code-owned table, and a stored row that disagrees with the
 *   table is refused rather than believed.
 */

const AT = '2026-06-01T09:00:00.000Z'
const LATER = '2026-06-02T09:00:00.000Z'

function proposalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: 'prop-1',
    kind: 'latency-too-high',
    subject: 'bounded-summary-length',
    symptom: 'the summary of a long run is taking longer to produce than the run it describes',
    occurrences: 6,
    evidenceRefs: ['work.run.41'],
    changes: ['cap the summary at a bounded length and say when it was truncated'],
    requirements: ['procedures.read'],
    targets: ['procedure-definition'],
    rollbackSteps: ['restore the previous summary length'],
    costCeiling: 80,
    tags: ['latency'],
    confidence: 'medium',
    createdAt: AT,
    ...overrides,
  }
}

function proposal(overrides: Record<string, unknown> = {}): ImprovementProposal {
  const created = createImprovementProposal(proposalInput(overrides))
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  return created.value
}

function check(
  kind: 'staged-verified' | 'tests-passed' | 'red-team-clean' | 'review-recorded' | 'rollback-verified',
  passed = true,
  overrides: Record<string, unknown> = {},
): ImprovementGateRecord {
  const reason =
    kind === 'staged-verified'
      ? passed
        ? 'stage-was-confirmed-by-a-named-check'
        : 'stage-was-not-confirmed'
      : kind === 'tests-passed'
        ? passed
          ? 'tests-reported-passing'
          : 'tests-failed'
        : kind === 'red-team-clean'
          ? passed
            ? 'red-team-reported-clean'
            : 'red-team-found-something'
          : kind === 'review-recorded'
            ? passed
              ? 'review-recorded-by-a-named-reviewer'
              : 'review-found-a-problem'
            : passed
              ? 'rollback-rehearsed-successfully'
              : 'rollback-rehearsal-failed'
  const recorded = recordImprovementGate(
    { kind, verdict: passed ? 'passed' : 'failed', reason, verifier: 'vitest.run', evidenceRefs: ['run-1'], ...overrides },
    'verifier',
    AT,
  )
  if (!recorded.ok) throw new Error(`fixture refused: ${recorded.code} ${recorded.reason}`)
  return recorded.record
}

function proposalAt(status: 'staged' | 'reviewed' | 'merging' | 'merged'): ImprovementProposal {
  let current = proposal()
  if (status === 'proposed' || status === 'staging') return current
  current = unwrap(advanceImprovement(current, { now: AT, to: 'staging' }))
  current = unwrap(advanceImprovement(current, { now: AT, to: 'staged', restoresRevision: 'rev-7' }))
  if (status === 'staged') return current
  for (const to of ['testing', 'tested', 'reviewing', 'reviewed'] as const) {
    current = unwrap(advanceImprovement(current, { now: AT, to }))
  }
  if (status === 'reviewed') return current
  current = unwrap(advanceImprovement(current, { now: AT, to: 'merging' }))
  if (status === 'merging') return current
  return unwrap(advanceImprovement(current, { now: AT, to: 'merged' }))
}

function unwrap(
  result: { ok: true; value: ImprovementProposal } | { ok: false; code: string; reason: string },
): ImprovementProposal {
  if (!result.ok) throw new Error(`fixture refused: ${result.code} ${result.reason}`)
  return result.value
}

/* ---------------------------------------------------------------- proposals */

describe('a proposal is a claim about a cost, not a wish', () => {
  it('records the evidence it rests on and derives its own deadline', () => {
    const recorded = proposal()
    expect(recorded.status).toBe('proposed')
    expect(recorded.evidenceRefs).toEqual(['work.run.41'])
    expect(recorded.expiresAt).toBe(
      new Date(Date.parse(AT) + IMPROVEMENT_RETENTION.maxProposalLifetimeMs).toISOString(),
    )
    expect(recorded.mergedAt).toBeNull()
    expect(recorded.mergedExpiresAt).toBeNull()
    expect(recorded.restoresRevision).toBeNull()
  })

  it('has no kind meaning make-me-better', () => {
    for (const kind of ['make-me-better', 'general-improvement', 'preferred', 'optimise']) {
      const created = createImprovementProposal(proposalInput({ kind }))
      expect(created.ok).toBe(false)
      expect(created.ok === false && created.code).toBe('invalid-kind')
    }
  })

  it('refuses a proposal with no evidence and one with no change', () => {
    expect(createImprovementProposal(proposalInput({ evidenceRefs: [] })).ok).toBe(false)
    expect(createImprovementProposal(proposalInput({ changes: [] })).ok).toBe(false)
  })

  it('refuses a symptom or a change description carrying secret-shaped text whole', () => {
    const symptom = createImprovementProposal(
      proposalInput({ symptom: 'the run kept failing with api_key = AKIAIOSFODNN7EXAMPLE1' }),
    )
    expect(symptom.ok === false && symptom.code).toBe('invalid-text')
    const change = createImprovementProposal(
      proposalInput({ changes: ['log the value of password = hunter2hunter2 when it fails'] }),
    )
    expect(change.ok === false && change.code).toBe('invalid-text')
  })

  it('never carries a high or verified confidence, even from the owner', () => {
    for (const confidence of ['high', 'verified']) {
      const created = createImprovementProposal(proposalInput({ confidence }))
      expect(created.ok).toBe(false)
      expect(created.ok === false && created.code).toBe('invalid-confidence')
    }
  })

  it('refuses a payload carrying an instruction, a grant or a lifecycle field', () => {
    for (const field of [
      { status: 'merged' },
      { scope: 'owner' },
      { applyCode: true },
      { autoMerge: true },
      { gitPush: true },
      { disableRollback: true },
      { grantsCapability: true },
    ]) {
      const created = createImprovementProposal({ ...proposalInput(), ...field })
      expect(created.ok).toBe(false)
      expect(created.ok === false && created.code).toBe('forbidden-field-refused')
    }
  })

  it('refuses every protected surface and every forbidden change at construction', () => {
    for (const target of PROTECTED_IMPROVEMENT_SURFACES) {
      const created = createImprovementProposal(proposalInput({ targets: [target] }))
      expect(created.ok).toBe(false)
      expect(created.ok === false && created.code).toBe('protected-surface')
    }
    for (const requirement of FORBIDDEN_IMPROVEMENTS) {
      const created = createImprovementProposal(proposalInput({ requirements: [requirement] }))
      expect(created.ok).toBe(false)
      expect(created.ok === false && created.code).toBe('forbidden-improvement')
    }
  })

  it('cannot name its own brakes among the forbidden list', () => {
    // The three entries that would make this phase a liability rather than a safeguard.
    expect(FORBIDDEN_IMPROVEMENTS as readonly string[]).toContain('improvement.gates.write')
    expect(FORBIDDEN_IMPROVEMENTS as readonly string[]).toContain('improvement.rollback.disable')
    expect(FORBIDDEN_IMPROVEMENTS as readonly string[]).toContain('improvement.merge.auto')
    // And its own gates and rollback mechanism are protected surfaces in their own right.
    expect(PROTECTED_IMPROVEMENT_SURFACES as readonly string[]).toContain('improvement-gates')
    expect(PROTECTED_IMPROVEMENT_SURFACES as readonly string[]).toContain('rollback-mechanism')
  })

  it('refuses a proposal with no rollback steps, and one whose ceiling cannot pay for the rehearsal', () => {
    expect(createImprovementProposal(proposalInput({ rollbackSteps: [] })).ok).toBe(false)
    const broke = createImprovementProposal(proposalInput({ costCeiling: 1 }))
    expect(broke.ok).toBe(false)
    expect(broke.ok === false && broke.code).toBe('budget-exhausted')
    // A ceiling that cannot pay for the rehearsal would make `rollback-verified` unsatisfiable,
    // which would make a change quietly unmergeable rather than refused. Refusing is the honest
    // outcome.
    expect(IMPROVEMENT_COST_UNITS.perRollbackRehearsal).toBeGreaterThan(0)
  })
})

/* --------------------------------------------------------------- lifecycle */

describe('the proposal lifecycle is a closed table', () => {
  it('has no edge out of a terminal status', () => {
    expect(IMPROVEMENT_TRANSITIONS['rolled-back']).toEqual([])
    expect(IMPROVEMENT_TRANSITIONS.rejected).toEqual([])
    expect(IMPROVEMENT_TRANSITIONS.expired).toEqual([])
    expect(canTransitionImprovement('rejected', 'proposed')).toBe(false)
    expect(canTransitionImprovement('rolled-back', 'staged')).toBe(false)
  })

  it('makes merged → rolled-back the only edge out of merged', () => {
    expect(IMPROVEMENT_TRANSITIONS.merged).toEqual(['rolled-back'])
    // No re-staging, no re-reviewing, no re-merging. A landed change is undone, not resumed.
    expect(canTransitionImprovement('merged', 'staging')).toBe(false)
    expect(canTransitionImprovement('merged', 'merging')).toBe(false)
    expect(canTransitionImprovement('merged', 'merged')).toBe(false)
  })

  it('separates testing from review, so one cannot sign for the other', () => {
    expect(canTransitionImprovement('tested', 'reviewed')).toBe(false)
    expect(canTransitionImprovement('tested', 'reviewing')).toBe(true)
    expect(canTransitionImprovement('reviewing', 'reviewed')).toBe(true)
    expect(canTransitionImprovement('tested', 'merged')).toBe(false)
  })

  it('refuses to advance a proposal that has outlived its deadline', () => {
    const past = new Date(Date.parse(AT) + IMPROVEMENT_RETENTION.maxProposalLifetimeMs + 1_000).toISOString()
    expect(isStaleProposal(proposal(), past)).toBe(true)
    const advanced = advanceImprovement(proposal(), { now: past, to: 'staging' })
    expect(advanced.ok).toBe(false)
    expect(advanced.ok === false && advanced.code).toBe('illegal-transition')
    const expired = expireStaleImprovement(proposal(), { now: past })
    expect(expired.ok === true && expired.value.closedReason).toBe('aged-out-past-retention')
  })

  it('refuses an illegal closure reason for the status it is asked to enter', () => {
    const ended = closeImprovementProposal(proposal(), {
      now: LATER,
      to: 'expired',
      reason: 'tests-failed',
    })
    expect(ended.ok).toBe(false)
    expect(ended.ok === false && ended.code).toBe('invalid-closed-reason')
  })

  it('records the revision to restore at staging and never after', () => {
    const staged = advanceImprovement(advanceImprovement(proposal(), { now: AT, to: 'staging' }).ok
      ? (advanceImprovement(proposal(), { now: AT, to: 'staging' }) as { ok: true; value: ImprovementProposal }).value
      : proposal(), { now: AT, to: 'staged', restoresRevision: 'rev-7' })
    expect(staged.ok === true && staged.value.restoresRevision).toBe('rev-7')
    // Later transitions carry it forward rather than dropping it.
    const tested = advanceImprovement(
      staged.ok ? staged.value : proposal(),
      { now: AT, to: 'testing' },
    )
    expect(tested.ok === true && tested.value.restoresRevision).toBe('rev-7')
  })

  it('refuses a rollback with no recorded revision rather than guessing a target', () => {
    const rolled = rollBackImprovement(proposalAt('staged'), { now: LATER })
    expect(rolled.ok).toBe(true)
    // A proposal that was never staged has no revision, so there is nothing to restore.
    const unstaged = rollBackImprovement(proposal(), { now: LATER })
    expect(unstaged.ok).toBe(false)
    expect(unstaged.ok === false && unstaged.code).toBe('illegal-transition')
  })

  it('expires a stale merge on its own deadline and keeps the two apart', () => {
    const merged = proposalAt('merged')
    expect(merged.mergedExpiresAt).toBe(
      new Date(Date.parse(AT) + IMPROVEMENT_RETENTION.maxMergedLifetimeMs).toISOString(),
    )
    const soon = new Date(Date.parse(AT) + IMPROVEMENT_RETENTION.maxMergedLifetimeMs).toISOString()
    expect(isMergeStale(merged, soon)).toBe(true)
    const expired = expireStaleMerge(merged, { now: soon })
    expect(expired.ok === true && expired.value.closedReason).toBe('aged-out-past-retention')
    // A proposal that is not merged has no merge deadline to expire against.
    expect(expireStaleMerge(proposal(), { now: soon }).ok).toBe(false)
    expect(expireStaleImprovement(merged, { now: soon }).ok).toBe(false)
  })

  it('keeps the merge deadline longer than the proposal lifetime, on purpose', () => {
    // A landed change needs more time than a proposal, because a proposal that has not merged has
    // changed nothing and is only clutter.
    expect(IMPROVEMENT_RETENTION.maxMergedLifetimeMs).toBeGreaterThan(
      IMPROVEMENT_RETENTION.maxProposalLifetimeMs,
    )
  })
})

/* ------------------------------------------------------------------- cost */

describe('cost is a code-owned currency, refused at the ceiling', () => {
  it('charges the stage, the test, the review, the rehearsal and the merge', () => {
    for (const [key, units] of Object.entries(IMPROVEMENT_COST_UNITS)) {
      expect(units).toBeGreaterThan(0)
      expect(key).toMatch(/^per[A-Z]/)
    }
    const charged = chargeImprovementCost(proposal(), IMPROVEMENT_COST_UNITS.perStage)
    expect(charged.ok === true && charged.value.costSpent).toBe(IMPROVEMENT_COST_UNITS.perStage)
  })

  it('refuses the charge that would cross the ceiling rather than overshooting', () => {
    const nearly = { ...proposal(), costSpent: 79 }
    const charged = chargeImprovementCost(nearly, 2)
    expect(charged.ok).toBe(false)
    expect(charged.ok === false && charged.code).toBe('budget-exhausted')
  })

  it('refuses to charge a terminal proposal at all', () => {
    const ended = closeImprovementProposal(proposal(), {
      now: AT,
      to: 'rejected',
      reason: 'owner-rejected-this-proposal',
    })
    const charged = chargeImprovementCost(ended.ok ? ended.value : proposal(), 1)
    expect(charged.ok === false && charged.code).toBe('already-terminal')
    const rolled = rollBackImprovement(proposalAt('staged'), { now: AT })
    const afterRollback = chargeImprovementCost(rolled.ok ? rolled.value : proposal(), 1)
    expect(afterRollback.ok === false && afterRollback.code).toBe('already-terminal')
  })

  it('refuses a charge that is not a positive whole number', () => {
    expect(chargeImprovementCost(proposal(), 0).ok).toBe(false)
    expect(chargeImprovementCost(proposal(), 2.5).ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ gates */

describe('the gate ledger', () => {
  it('is closed over eight gates, six of which a ledger may hold', () => {
    expect(IMPROVEMENT_GATE_KINDS).toHaveLength(8)
    expect(LEDGER_IMPROVEMENT_GATE_KINDS).toHaveLength(6)
    expect([...LEDGER_IMPROVEMENT_GATE_KINDS, ...DERIVED_IMPROVEMENT_GATE_KINDS].sort()).toEqual(
      [...IMPROVEMENT_GATE_KINDS].sort(),
    )
  })

  it('refuses a merge approval from every authority but the owner', () => {
    for (const authority of ['verifier', 'core', 'gate'] as const) {
      const refused = recordImprovementGate(
        { kind: 'owner-merge-approved', verdict: 'passed', reason: 'owner-approved-this-merge', verifier: 'owner', evidenceRefs: [] },
        authority,
        AT,
      )
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('not-owner')
    }
    const approval = recordOwnerMergeApproval(true, AT)
    expect(approval.ok === true && approval.record.authority).toBe('owner')
    expect(approval.ok === true && approval.record.verifier).toBe('owner')
    // An approval is a decision, not a check: it carries no evidence refs at all.
    expect(approval.ok === true && approval.record.evidenceRefs).toEqual([])
  })

  it('refuses a derived gate asserted by hand', () => {
    for (const kind of DERIVED_IMPROVEMENT_GATE_KINDS) {
      const refused = recordImprovementGate(
        {
          kind,
          verdict: 'passed',
          reason: kind === 'no-protected-surface' ? 'touches-no-protected-surface' : 'requires-no-forbidden-change',
          verifier: 'core',
          evidenceRefs: [],
        },
        'core',
        AT,
      )
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('gate-may-not-be-self-reported')
    }
  })

  it('refuses the gate evaluator reporting its own evidence', () => {
    const refused = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'tests-reported-passing',
        verifier: 'gate',
        evidenceRefs: ['run-1'],
      },
      'gate',
      AT,
    )
    expect(refused.ok === false && refused.code).toBe('gate-may-not-be-self-reported')
  })

  it('refuses a check with no verifier and with no evidence', () => {
    const unnamed = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'tests-reported-passing',
        verifier: '',
        evidenceRefs: ['run-1'],
      },
      'verifier',
      AT,
    )
    expect(unnamed.ok === false && unnamed.code).toBe('missing-verifier')
    const unsupported = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'tests-reported-passing',
        verifier: 'vitest.run',
        evidenceRefs: [],
      },
      'verifier',
      AT,
    )
    expect(unsupported.ok === false && unsupported.code).toBe('invalid-evidence-refs')
  })

  it('refuses a reason belonging to another gate, and one contradicting the verdict', () => {
    const wrongGate = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'red-team-reported-clean',
        verifier: 'vitest.run',
        evidenceRefs: ['run-1'],
      },
      'verifier',
      AT,
    )
    expect(wrongGate.ok === false && wrongGate.code).toBe('invalid-gate-reason')
    const inverted = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'tests-failed',
        verifier: 'vitest.run',
        evidenceRefs: ['run-1'],
      },
      'verifier',
      AT,
    )
    expect(inverted.ok === false && inverted.code).toBe('invalid-gate-reason')
  })

  it('reads the newest record per kind, and a later failure wins', () => {
    const passed = check('tests-passed')
    const failed = recordImprovementGate(
      {
        kind: 'tests-passed',
        verdict: 'failed',
        reason: 'tests-failed',
        verifier: 'vitest.run',
        evidenceRefs: ['run-2'],
      },
      'verifier',
      LATER,
    )
    if (!failed.ok) throw new Error('fixture refused')
    const latest = latestGateRecords([passed, failed.record])
    expect(latest['tests-passed'].verdict).toBe('failed')
  })

  it('counts only passed as satisfied, so not-applicable is not a way out', () => {
    const skipped = recordImprovementGate(
      {
        kind: 'red-team-clean',
        verdict: 'not-applicable',
        reason: 'marked-not-applicable-by-verifier',
        verifier: 'red-team.sweep',
        evidenceRefs: ['rt-1'],
      },
      'verifier',
      AT,
    )
    if (!skipped.ok) throw new Error('fixture refused')
    const outstanding = unsatisfiedImprovementGates(proposalAt('merging'), [skipped.record], AT)
    expect(outstanding).toContain('red-team-clean')
    expect(everyGateSatisfied(proposalAt('merging'), [skipped.record], AT)).toBe(false)
  })

  it('computes the two derived gates from the proposal itself', () => {
    const wide = {
      ...proposal(),
      requirements: ['improvement.merge.auto'],
      targets: ['rollback-mechanism'],
    } as ImprovementProposal
    const byKind = latestGateRecords(evaluateDerivedGates(wide, AT))
    expect(byKind['no-authority-widening'].verdict).toBe('failed')
    expect(byKind['no-protected-surface'].verdict).toBe('failed')
    expect(byKind['no-authority-widening'].reason).toBe('requires-a-forbidden-change')
    for (const record of evaluateDerivedGates(proposal(), AT)) {
      expect(record.verifier).toBeNull()
      expect(record.authority).toBe('gate')
    }
  })

  it('will not merge with a missing gate, a failed gate or an unproven rollback', () => {
    const target = proposalAt('merging')
    const everything = [
      check('staged-verified'),
      check('tests-passed'),
      check('red-team-clean'),
      check('review-recorded'),
      check('rollback-verified'),
    ]
    expect(unsatisfiedImprovementGates(target, everything, AT)).toEqual(['owner-merge-approved'])
    const approval = recordOwnerMergeApproval(true, AT)
    if (!approval.ok) throw new Error('fixture refused')
    const decided = decideMerge(target, [...everything, approval.record], AT)
    expect(decided.approved).toBe(true)
    expect(decided.ownerApproved).toBe(true)
    expect(reasonForMergeDecision(decided)).toBeNull()
    // Drop the rehearsal and the merge stops, even with every other gate and the owner present.
    const withoutRehearsal = decideMerge(
      target,
      [...everything.slice(0, 4), approval.record],
      AT,
    )
    expect(withoutRehearsal.approved).toBe(false)
    expect(withoutRehearsal.unsatisfied).toContain('rollback-verified')
    expect(reasonForMergeDecision(withoutRehearsal)).toBe('rollback-unverified-so-refused')
  })

  it('names the most fundamental failure rather than the first one', () => {
    const declined = recordOwnerMergeApproval(false, AT)
    if (!declined.ok) throw new Error('fixture refused')
    const decision = decideMerge(proposalAt('merging'), [check('tests-passed', false), declined.record], AT)
    expect(reasonForMergeDecision(decision)).toBe('owner-rejected-this-proposal')
    const brokenRollback = decideMerge(proposalAt('merging'), [check('rollback-verified', false)], AT)
    expect(reasonForMergeDecision(brokenRollback)).toBe('rollback-unverified-so-refused')
    const brokenTests = decideMerge(proposalAt('merging'), [check('tests-passed', false)], AT)
    expect(reasonForMergeDecision(brokenTests)).toBe('tests-failed')
    const brokenReview = decideMerge(proposalAt('merging'), [check('review-recorded', false)], AT)
    expect(reasonForMergeDecision(brokenReview)).toBe('review-rejected-the-change')
  })

  it('reports an unanswered owner gate as pending, not as a refusal', () => {
    const decision = decideMerge(proposalAt('merging'), [check('tests-passed')], AT)
    expect(decision.unsatisfied).toContain('owner-merge-approved')
    // Nobody has declined yet, so the ledger must not say they did.
    expect(reasonForMergeDecision(decision)).not.toBe('owner-rejected-this-proposal')
  })

  it('carries the precedence that stopped it rather than assuming the gates did', () => {
    const decision = decideMerge(proposalAt('merging'), [], AT, 'stop-all-active')
    expect(decision.approved).toBe(false)
    expect(decision.precedence).toBe('stop-all-active')
    expect(decideMerge(proposalAt('merging'), [], AT).precedence).toBeNull()
  })

  it('revalidates a stored record on read, including the owner branch', () => {
    expect(validateImprovementGate(check('tests-passed')).ok).toBe(true)
    expect(validateImprovementGate({ ...check('tests-passed'), authority: 'owner' }).ok).toBe(false)
    const derived = {
      ...check('tests-passed'),
      kind: 'no-protected-surface',
      reason: 'touches-no-protected-surface',
    }
    expect(validateImprovementGate(derived).ok).toBe(false)
    const approval = recordOwnerMergeApproval(true, AT)
    if (!approval.ok) throw new Error('fixture refused')
    expect(validateImprovementGate(approval.record).ok).toBe(true)
    expect(validateImprovementGate({ ...approval.record, reason: 'owner-declined' }).ok).toBe(false)
  })

  it('validates a decision gate separately, so a computed gate carries no producer', () => {
    const decision = decideMerge(proposalAt('merging'), [], AT)
    expect(decision.gates).toHaveLength(8)
    for (const gate of decision.gates) {
      expect(validateDecisionGate(gate).ok).toBe(true)
    }
    const forged = { ...decision.gates[0], verifier: 'vitest.run', evidenceRefs: ['run-1'] }
    expect(validateDecisionGate(forged).ok).toBe(false)
  })
})

/* --------------------------------------------------------------- staging */

describe('a stage description cannot say a machine applies it', () => {
  it('hard-sets appliedBy to owner, with no parameter for it', () => {
    const stage = describeStage({ target: 'module-code', summary: 'split the summary builder', breadth: 2 })
    expect(stage.appliedBy).toBe('owner')
    // And the type has no other member, so there is nothing to pass.
    expect(Object.keys(stage).sort()).toEqual(['appliedBy', 'breadth', 'summary', 'target'])
  })
})

/* ------------------------------------------------------------- precedence */

describe('the precedence ladder is data, and it starts with the journal', () => {
  it('lists six rungs in the order they are obeyed', () => {
    expect(IMPROVEMENT_PRECEDENCE).toEqual([
      'journal-not-trustworthy',
      'stop-all-active',
      'guard-denied',
      'governor-denied',
      'budget-exhausted',
      'domain-rule',
    ])
  })

  it('names a reason code for every rung a refusal may report', () => {
    for (const rung of IMPROVEMENT_PRECEDENCE) {
      expect(IMPROVEMENT_REFUSAL_CODES as readonly string[]).toContain(rung)
    }
  })
})

/* ------------------------------------------------------------- derivation */

describe('the derivation is arithmetic, and deterministic', () => {
  it('reports the same numbers for the same state and instant', () => {
    const state = emptyImprovementState()
    applyRecord(state, { version: 1, kind: 'proposal', proposal: proposal() })
    const once = deriveImprovement(state, AT)
    const twice = deriveImprovement(state, AT)
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice))
    expect(once.counts.openProposals).toBe(1)
    expect(once.counts.activeMerges).toBe(0)
    // Rendered rather than merely respected: a reader can see this domain merges nothing.
    expect(once.mergeAuthority).toBe('none')
  })

  it('counts a proposal as awaiting the owner only when that is the single gate owed', () => {
    const state = emptyImprovementState()
    applyRecord(state, { version: 1, kind: 'proposal', proposal: proposalAt('merging') })
    applyRecord(state, {
      version: 1,
      kind: 'ledger',
      proposalId: 'prop-1',
      verdicts: [
        check('staged-verified'),
        check('tests-passed'),
        check('red-team-clean'),
        check('review-recorded'),
        check('rollback-verified'),
      ],
    })
    const derivation = deriveImprovement(state, AT)
    expect(derivation.awaitingOwner).toEqual(['prop-1'])
    expect(derivation.blockedOn['owner-merge-approved']).toBe(1)
    expect(derivation.blockedOn['tests-passed']).toBe(0)
  })

  it('reports a standing merge past its own review date rather than hiding it', () => {
    const state = emptyImprovementState()
    applyRecord(state, { version: 1, kind: 'proposal', proposal: proposalAt('merged') })
    const soon = new Date(Date.parse(AT) + IMPROVEMENT_RETENTION.maxMergedLifetimeMs).toISOString()
    expect(deriveImprovement(state, soon).mergesAwaitingReview).toEqual(['prop-1'])
    expect(deriveImprovement(state, AT).mergesAwaitingReview).toEqual([])
  })
})

/* ------------------------------------------------------------------ fold */

describe('a stored row must still satisfy every construction rule', () => {
  it('accepts a proposal that came through the domain unchanged', () => {
    expect(rebuildImprovementProposal(proposal()).ok).toBe(true)
    expect(validateRecord({ version: IMPROVEMENT_RECORD_VERSION, kind: 'proposal', proposal: proposal() }).ok).toBe(true)
  })

  it('refuses a row whose deadline was widened', () => {
    const widened = rebuildImprovementProposal({ ...proposal(), expiresAt: '2099-01-01T00:00:00.000Z' })
    expect(widened.ok === false && widened.reason).toContain('deadline')
  })

  it('refuses a row whose forbidden content was added after the fact', () => {
    expect(rebuildImprovementProposal({ ...proposal(), requirements: ['improvement.merge.auto'] }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...proposal(), targets: ['guard'] }).ok).toBe(false)
  })

  it('refuses a row whose status and merge fields disagree', () => {
    expect(rebuildImprovementProposal({ ...proposal(), mergedAt: AT }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...proposal(), restoresRevision: 'rev-7' }).ok).toBe(false)
    const merged = proposalAt('merged')
    expect(rebuildImprovementProposal(merged).ok).toBe(true)
    expect(rebuildImprovementProposal({ ...merged, restoresRevision: null }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...merged, mergedExpiresAt: '2099-01-01T00:00:00.000Z' }).ok).toBe(false)
    expect(rebuildImprovementProposal({ ...merged, closedAt: AT, closedReason: 'tests-failed' }).ok).toBe(false)
  })

  it('refuses a decision that claims an approval its own gate list contradicts', () => {
    const decision = decideMerge(proposalAt('merging'), [], AT)
    expect(validateRecord({ version: 1, kind: 'decision', decision }, () => proposalAt('merging')).ok).toBe(true)
    const forged = { ...decision, approved: true }
    expect(
      validateRecord({ version: 1, kind: 'decision', decision: forged }, () => proposalAt('merging')).ok,
    ).toBe(false)
  })

  it('refuses a decision naming a proposal the store does not hold', () => {
    const decision = decideMerge(proposalAt('merging'), [], AT)
    expect(validateRecord({ version: 1, kind: 'decision', decision }, () => undefined).ok).toBe(false)
    expect(rebuildMergeDecision(decision, proposal()).ok).toBe(false)
  })

  it('refuses an over-long ledger rather than truncating it', () => {
    const records = Array.from({ length: IMPROVEMENT_LIMITS.maxGateVerdicts + 1 }, () => check('tests-passed'))
    expect(rebuildGateLedger(records).ok).toBe(false)
    expect(rebuildGateLedger(records.slice(0, 3)).ok).toBe(true)
  })

  it('keys rows by kind so a cross-kind id collision is not a conflict', () => {
    expect(recordKey({ version: 1, kind: 'proposal', proposal: proposal() })).toBe('proposal:prop-1')
    expect(recordKey({ version: 1, kind: 'ledger', proposalId: 'prop-1', verdicts: [] })).toBe('ledger:prop-1')
    expect(
      recordKey({ version: 1, kind: 'decision', decision: decideMerge(proposalAt('merging'), [], AT) }),
    ).toBe('decision:prop-1')
  })

  it('ignores a ledger entry naming a derived gate when reading the newest per kind', () => {
    const smuggled: ImprovementGateRecord = {
      kind: 'no-protected-surface',
      verdict: 'passed',
      reason: 'touches-no-protected-surface',
      authority: 'gate',
      verifier: null,
      evidenceRefs: [],
      recordedAt: AT,
    }
    // The reader drops it, and the derived gate is recomputed from the proposal instead.
    expect(latestLedgerGateRecords([smuggled, check('tests-passed')])['tests-passed'].verdict).toBe('passed')
    expect(unsatisfiedImprovementGates(proposalAt('merging'), [smuggled], AT)).not.toContain('no-protected-surface')
  })
})

/* ----------------------------------------------------------- the boundary */

describe('the boundary, stated as data', () => {
  it('applies nothing, merges nothing and always allows rollback', () => {
    expect(IMPROVEMENT_APPLIES_NOTHING.appliesCode).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.executesChange).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.grantsCapability).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.maySelfMerge).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.mayDisableItsOwnGates).toBe(false)
    expect(IMPROVEMENT_APPLIES_NOTHING.rollbackAlwaysAvailable).toBe(true)
  })

  it('refuses execute, merge, apply and disable shaped field names in one family', () => {
    for (const name of [
      'applyCode',
      'applies',
      'autoMerge',
      'gitPush',
      'forcePush',
      'execute',
      'spawn',
      'disableRollback',
      'grantsCapability',
      'permission',
      'apiKey',
      'clearsStopAll',
    ]) {
      expect(isForbiddenImprovementFieldName(name)).toBe(true)
    }
    expect(isForbiddenImprovementFieldName('symptom')).toBe(false)
    expect(IMPROVEMENT_FORBIDDEN_FIELDS.length).toBeGreaterThan(15)
  })

  it('binds every reason to a kind and to a verdict', () => {
    for (const kind of IMPROVEMENT_GATE_KINDS) {
      for (const reason of IMPROVEMENT_GATE_REASONS_BY_KIND[kind]) {
        const inSomeVerdict = (
          ['passed', 'failed', 'pending', 'not-applicable'] as const
        ).some((verdict) => IMPROVEMENT_GATE_REASONS_BY_VERDICT[verdict].includes(reason))
        expect(inSomeVerdict).toBe(true)
      }
    }
  })

  it('keeps every stage target a code-owned label rather than a path', () => {
    expect(IMPROVEMENT_LIMITS.maxSlugChars).toBeGreaterThan(0)
    // A path is not a slug, so a proposal cannot smuggle one through the subject field.
    expect(createImprovementProposal(proposalInput({ subject: 'src/core/index.ts' })).ok).toBe(false)
  })
})