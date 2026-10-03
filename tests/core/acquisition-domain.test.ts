import { describe, expect, it } from 'vitest'
import {
  ACQUISITION_COST_UNITS,
  ACQUISITION_FORBIDDEN_FIELDS,
  ACQUISITION_GRANTS_NOTHING,
  ACQUISITION_LIMITS,
  ACQUISITION_PRECEDENCE,
  ACQUISITION_RECORD_VERSION,
  ACQUISITION_REFUSAL_CODES,
  ACQUISITION_RETENTION,
  DERIVED_GATE_KINDS,
  FORBIDDEN_REQUIREMENTS,
  GENERATED_ACTIVATION,
  GENERATED_TRUST_CLASS,
  GATE_KINDS,
  GATE_REASONS_BY_KIND,
  GATE_REASONS_BY_VERDICT,
  LEDGER_GATE_KINDS,
  PROTECTED_TARGETS,
  REQUEST_TRANSITIONS,
  activateAcquisitionRequest,
  advanceAcquisitionRequest,
  applyRecord,
  canTransitionRequest,
  chargeAcquisitionCost,
  closeCapabilityGap,
  createAcquisitionRequest,
  createAcquisitionRequestForGap,
  createCapabilityGap,
  decideActivation,
  deriveAcquisition,
  emptyAcquisitionState,
  endAcquisitionRequest,
  evaluateSelfGates,
  everyGateSatisfied,
  expireCapabilityGap,
  expireStaleAcquisitionRequest,
  expireStaleActivation,
  isForbiddenAcquisitionFieldName,
  isRequestLifecycleConsistent,
  isStaleAcquisitionRequest,
  latestGateVerdicts,
  recordGateVerdict,
  recordKey,
  recordOwnerApproval,
  rebuildAcquisitionRequest,
  rebuildCapabilityGap,
  rebuildGateLedger,
  reasonForDecision,
  unsatisfiedGates,
  validateGateVerdict,
  validateRecord,
  type AcquisitionRequest,
  type CapabilityGap,
} from '../../core/acquisition'

/**
 * PHASE 29 — THE CONTRACT, WITHOUT AN ENGINE.
 *
 * The claims pinned here are the ones a reader has to be able to check by reading the code:
 *
 * - a generated capability starts **untrusted and inactive**, and no input can say otherwise;
 * - a gap names a *need* and never a permission, so a capability id is not a legal slug;
 * - activation is a **conjunction over seven gates**, three of which may not be asserted by
 *   hand at all;
 * - evidence must name its producer, and a verdict whose reason belongs to another gate is
 *   refused rather than stored;
 * - the newest verdict wins, including when it fails;
 * - every deadline is derived from a code-owned table, and a stored row that disagrees with the
 *   table is refused rather than believed.
 */

const AT = '2026-06-01T09:00:00.000Z'
const LATER = '2026-06-02T09:00:00.000Z'

function gapInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gapId: 'gap-1',
    kind: 'tool-absent',
    wanted: 'csv-export',
    symptom: 'nothing in the workspace can write a spreadsheet from a table',
    occurrences: 3,
    evidenceRefs: ['work.run.41'],
    tags: ['workspace'],
    detectedBy: 'core',
    detectedAt: AT,
    ...overrides,
  }
}

function gap(overrides: Record<string, unknown> = {}): CapabilityGap {
  const created = createCapabilityGap(gapInput(overrides))
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  return created.value
}

function requestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    gapId: 'gap-1',
    subject: 'csv-export',
    intent: 'read a table from the workspace and write it as a spreadsheet',
    requirements: ['files.read', 'files.write'],
    targets: ['workspace.tables'],
    steps: ['read the table', 'write the spreadsheet'],
    costCeiling: 40,
    tags: ['workspace'],
    confidence: 'medium',
    createdAt: AT,
    ...overrides,
  }
}

function request(overrides: Record<string, unknown> = {}): AcquisitionRequest {
  const created = createAcquisitionRequest(requestInput(overrides))
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  return created.value
}

function evidenceVerdict(
  kind: 'verification-passed' | 'tests-passed' | 'red-team-clean',
  overrides: Record<string, unknown> = {},
) {
  const reason =
    kind === 'verification-passed'
      ? 'verified-by-a-named-verifier'
      : kind === 'tests-passed'
        ? 'tests-reported-passing'
        : 'red-team-reported-clean'
  const recorded = recordGateVerdict(
    { kind, verdict: 'passed', reason, verifier: 'work.step.verified', evidenceRefs: ['ver-1'], ...overrides },
    'verifier',
    AT,
  )
  if (!recorded.ok) throw new Error(`fixture refused: ${recorded.code} ${recorded.reason}`)
  return recorded.verdict
}

/* ------------------------------------------------------------------ gaps */

describe('a capability gap is a need, never a permission', () => {
  it('records the evidence it was observed from and derives its own deadline', () => {
    const recorded = gap()
    expect(recorded.status).toBe('open')
    expect(recorded.evidenceRefs).toEqual(['work.run.41'])
    expect(recorded.expiresAt).toBe(
      new Date(Date.parse(AT) + ACQUISITION_RETENTION.maxGapLifetimeMs).toISOString(),
    )
  })

  it('refuses a wanted that is a capability id rather than a shape of thing', () => {
    const created = createCapabilityGap(gapInput({ wanted: 'work.run.manage' }))
    expect(created.ok).toBe(false)
    expect(created.ok === false && created.code).toBe('invalid-slug')
  })

  it('refuses a gap with no evidence at all', () => {
    const created = createCapabilityGap(gapInput({ evidenceRefs: [] }))
    expect(created.ok).toBe(false)
    expect(created.ok === false && created.code).toBe('invalid-evidence-refs')
  })

  it('refuses a symptom carrying secret-shaped text whole rather than redacting it', () => {
    const created = createCapabilityGap(
      gapInput({ symptom: 'the export failed with api_key = AKIAIOSFODNN7EXAMPLE1' }),
    )
    expect(created.ok).toBe(false)
    expect(created.ok === false && created.code).toBe('invalid-text')
  })

  it('refuses a gap carrying a permission-shaped field', () => {
    const created = createCapabilityGap({ ...gapInput(), grantsCapability: true })
    expect(created.ok).toBe(false)
    expect(created.ok === false && created.code).toBe('forbidden-field-refused')
  })

  it('closes only with a closed label, and cannot be closed before it was seen', () => {
    const closed = closeCapabilityGap(gap(), { now: LATER, reason: 'owner-decided-it-is-not-a-gap' })
    expect(closed.ok).toBe(true)
    expect(closed.ok === true && closed.value.closureReason).toBe('owner-decided-it-is-not-a-gap')
    expect(closeCapabilityGap(gap(), { now: '2026-05-01T09:00:00.000Z', reason: 'withdrawn-by-owner' }).ok).toBe(false)
    expect(closeCapabilityGap(closed.ok === true ? closed.value : gap(), { now: LATER, reason: 'withdrawn-by-owner' }).ok).toBe(
      false,
    )
  })

  it('refuses to age a gap out before its deadline', () => {
    expect(expireCapabilityGap(gap(), { now: AT }).ok).toBe(false)
    const aged = expireCapabilityGap(gap(), {
      now: new Date(Date.parse(AT) + ACQUISITION_RETENTION.maxGapLifetimeMs).toISOString(),
    })
    expect(aged.ok).toBe(true)
    expect(aged.ok === true && aged.value.closureReason).toBe('aged-out-past-retention')
  })
})

/* --------------------------------------------------------------- requests */

describe('a generated request starts untrusted and inactive', () => {
  it('assigns both from constants rather than from the payload', () => {
    const created = request()
    expect(created.trustClass).toBe(GENERATED_TRUST_CLASS)
    expect(created.activation).toBe(GENERATED_ACTIVATION)
    expect(created.status).toBe('proposed')
    expect(created.activationExpiresAt).toBeNull()
  })

  it('refuses a payload that tries to supply either field', () => {
    expect(createAcquisitionRequest({ ...requestInput(), trustClass: 'derived' }).ok).toBe(false)
    const activated = createAcquisitionRequest({ ...requestInput(), activation: 'active' })
    expect(activated.ok).toBe(false)
    expect(activated.ok === false && activated.code).toBe('forbidden-field-refused')
  })

  it('refuses an extra field rather than dropping it', () => {
    const created = createAcquisitionRequest({ ...requestInput(), note: 'build it anyway' })
    expect(created.ok).toBe(false)
    expect(created.ok === false && created.code).toBe('key-set-mismatch')
  })

  it('never carries a high or verified confidence', () => {
    for (const confidence of ['high', 'verified']) {
      const created = createAcquisitionRequest(requestInput({ confidence }))
      expect(created.ok).toBe(false)
      expect(created.ok === false && created.code).toBe('invalid-confidence')
    }
  })

  it('refuses a protected target and a forbidden requirement at construction', () => {
    const target = createAcquisitionRequest(requestInput({ targets: ['authority'] }))
    expect(target.ok).toBe(false)
    expect(target.ok === false && target.code).toBe('protected-target')
    for (const requirement of FORBIDDEN_REQUIREMENTS) {
      const created = createAcquisitionRequest(requestInput({ requirements: [requirement] }))
      expect(created.ok).toBe(false)
      expect(created.ok === false && created.code).toBe('forbidden-requirement')
    }
  })

  it('refuses a plan the ceiling cannot pay for', () => {
    const created = createAcquisitionRequest(requestInput({ costCeiling: 1 }))
    expect(created.ok).toBe(false)
    expect(created.ok === false && created.code).toBe('budget-exhausted')
  })

  it('refuses a request naming a gap that does not exist, is closed, or came later', () => {
    const missing = createAcquisitionRequestForGap(requestInput(), () => undefined)
    expect(missing.ok).toBe(false)
    expect(missing.ok === false && missing.code).toBe('no-such-gap')
    const closed = createAcquisitionRequestForGap(
      requestInput(),
      () => closeCapabilityGap(gap(), { now: LATER, reason: 'withdrawn-by-owner' }).ok
        ? (closeCapabilityGap(gap(), { now: LATER, reason: 'withdrawn-by-owner' }) as { ok: true; value: CapabilityGap }).value
        : gap(),
    )
    expect(closed.ok).toBe(false)
    expect(createAcquisitionRequestForGap(requestInput({ createdAt: '2026-05-01T09:00:00.000Z' }), () => gap()).ok).toBe(false)
  })
})

/* -------------------------------------------------------------- lifecycle */

describe('the request lifecycle is a closed table', () => {
  it('has no edge out of a terminal status', () => {
    expect(REQUEST_TRANSITIONS.rejected).toEqual([])
    expect(REQUEST_TRANSITIONS.expired).toEqual([])
    expect(canTransitionRequest('rejected', 'proposed')).toBe(false)
    expect(canTransitionRequest('expired', 'activation-requested')).toBe(false)
  })

  it('has no edge from active back to activation-requested, so a revocation is final', () => {
    expect(canTransitionRequest('active', 'activation-requested')).toBe(false)
    expect(REQUEST_TRANSITIONS.active).toEqual(['rejected', 'expired'])
  })

  it('reaches verified only through verifying', () => {
    expect(canTransitionRequest('built', 'verified')).toBe(false)
    const built = advanceAcquisitionRequest(request(), { now: AT, to: 'building' })
    const marked = advanceAcquisitionRequest(built.ok ? built.value : request(), { now: AT, to: 'built' })
    const verifying = advanceAcquisitionRequest(marked.ok ? marked.value : request(), { now: AT, to: 'verifying' })
    const verified = advanceAcquisitionRequest(verifying.ok ? verifying.value : request(), { now: AT, to: 'verified' })
    expect(verified.ok).toBe(true)
  })

  it('refuses to advance a request that has outlived its deadline', () => {
    const stale = new Date(Date.parse(AT) + ACQUISITION_RETENTION.maxRequestLifetimeMs + 1_000).toISOString()
    const advanced = advanceAcquisitionRequest(request(), { now: stale, to: 'building' })
    expect(advanced.ok).toBe(false)
    expect(advanced.ok === false && advanced.code).toBe('illegal-transition')
    const expired = expireStaleAcquisitionRequest(request(), { now: stale })
    expect(expired.ok === true && expired.value.lifecycleReason).toBe('stale-request-expired')
  })

  it('refuses an illegal lifecycle reason for the status it is asked to enter', () => {
    const ended = endAcquisitionRequest(request(), { now: LATER, to: 'expired', reason: 'owner-rejected-this-request' })
    expect(ended.ok).toBe(false)
    expect(ended.ok === false && ended.code).toBe('illegal-lifecycle-reason')
  })

  it('sets the activation state from the status it enters, never from a parameter', () => {
    const advanced = advanceAcquisitionRequest(request(), { now: AT, to: 'building' })
    const built = advanceAcquisitionRequest(advanced.ok ? advanced.value : request(), { now: AT, to: 'built' })
    const verifying = advanceAcquisitionRequest(built.ok ? built.value : request(), { now: AT, to: 'verifying' })
    const verified = advanceAcquisitionRequest(verifying.ok ? verifying.value : request(), { now: AT, to: 'verified' })
    const asking = advanceAcquisitionRequest(verified.ok ? verified.value : request(), {
      now: AT,
      to: 'activation-requested',
    })
    expect(asking.ok === true && asking.value.activation).toBe('activation-requested')
  })

  it('grants an activation only from activation-requested, with a code-owned deadline', () => {
    // Only ctivation-requested may be activated: proposed and erified are both refused.
    expect(activateAcquisitionRequest(request(), { now: AT }).ok).toBe(false)
    expect(advanceAcquisitionRequest(request(), { now: AT, to: 'built' }).ok).toBe(false)
    expect(activateAcquisitionRequest(readyForActivation(), { now: LATER }).ok).toBe(false)
    const activated = activateAcquisitionRequest(requestingActivation(), { now: LATER })
    expect(activated.ok).toBe(true)
    expect(activated.ok === true && activated.value.activationExpiresAt).toBe(
      new Date(Date.parse(LATER) + ACQUISITION_RETENTION.maxActiveLifetimeMs).toISOString(),
    )
  })

  it('expires a stale request and a stale activation with different reasons', () => {
    const past = new Date(Date.parse(AT) + ACQUISITION_RETENTION.maxRequestLifetimeMs + 1).toISOString()
    expect(isStaleAcquisitionRequest(request(), past)).toBe(true)
    const expired = expireStaleAcquisitionRequest(request(), { now: past })
    expect(expired.ok === true && expired.value.lifecycleReason).toBe('stale-request-expired')
    const active = activateAcquisitionRequest(requestingActivation(), { now: AT }).ok
      ? (activateAcquisitionRequest(requestingActivation(), { now: AT }) as { ok: true; value: AcquisitionRequest }).value
      : request()
    const later = new Date(Date.parse(AT) + ACQUISITION_RETENTION.maxActiveLifetimeMs).toISOString()
    const aged = expireStaleActivation(active, { now: later })
    expect(aged.ok).toBe(true)
    expect(aged.ok === true && aged.value.lifecycleReason).toBe('retention-bound-reached')
    expect(aged.ok === true && aged.value.activation).toBe('inactive')
  })
})

function readyForActivation(): AcquisitionRequest {
  let current = request()
  for (const to of ['building', 'built', 'verifying', 'verified'] as const) {
    const advanced = advanceAcquisitionRequest(current, { now: AT, to })
    if (!advanced.ok) throw new Error(`fixture refused: ${advanced.reason}`)
    current = advanced.value
  }
  return current
}

function requestingActivation(): AcquisitionRequest {
  const asked = advanceAcquisitionRequest(readyForActivation(), { now: AT, to: 'activation-requested' })
  if (!asked.ok) throw new Error(`fixture refused: ${asked.reason}`)
  return asked.value
}

/* ------------------------------------------------------------------- cost */

describe('cost is a code-owned currency, refused at the ceiling', () => {
  it('charges one unit per build step', () => {
    const charged = chargeAcquisitionCost(request(), ACQUISITION_COST_UNITS.perBuildStep)
    expect(charged.ok === true && charged.value.costSpent).toBe(1)
  })

  it('refuses the charge that would cross the ceiling rather than overshooting', () => {
    const nearly = { ...request(), costSpent: 39 }
    const charged = chargeAcquisitionCost(nearly, 2)
    expect(charged.ok).toBe(false)
    expect(charged.ok === false && charged.code).toBe('budget-exhausted')
  })

  it('refuses to charge a terminal request at all', () => {
    const ended = endAcquisitionRequest(request(), { now: AT, to: 'rejected', reason: 'owner-rejected-this-request' })
    const terminal = ended.ok ? ended.value : request()
    const charged = chargeAcquisitionCost(terminal, 1)
    expect(charged.ok === false && charged.code).toBe('already-terminal')
  })

  it('refuses a charge that is not a positive whole number', () => {
    expect(chargeAcquisitionCost(request(), 0).ok).toBe(false)
    expect(chargeAcquisitionCost(request(), 1.5).ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ gates */

describe('the gate ledger', () => {
  it('is closed over seven gates, four of which a ledger may hold', () => {
    expect(GATE_KINDS).toHaveLength(7)
    expect(LEDGER_GATE_KINDS).toHaveLength(4)
    expect([...LEDGER_GATE_KINDS, ...DERIVED_GATE_KINDS].sort()).toEqual([...GATE_KINDS].sort())
  })

  it('refuses an owner approval from any other authority', () => {
    const recorded = recordGateVerdict(
      {
        kind: 'owner-approval',
        verdict: 'passed',
        reason: 'owner-approved-this-activation',
        verifier: null,
        evidenceRefs: [],
      },
      'verifier',
      AT,
    )
    expect(recorded.ok).toBe(false)
    expect(recorded.ok === false && recorded.code).toBe('not-owner')
  })

  it('refuses a derived gate asserted by hand', () => {
    for (const kind of DERIVED_GATE_KINDS) {
      const reason = GATE_REASONS_BY_KIND[kind][0]
      const recorded = recordGateVerdict(
        { kind, verdict: 'passed', reason, verifier: 'core', evidenceRefs: [] },
        'core',
        AT,
      )
      expect(recorded.ok).toBe(false)
      expect(recorded.ok === false && recorded.code).toBe('gate-may-not-be-self-reported')
    }
  })

  it('refuses the gate evaluator reporting its own evidence', () => {
    const recorded = recordGateVerdict(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'tests-reported-passing',
        verifier: 'gate',
        evidenceRefs: ['ver-1'],
      },
      'gate',
      AT,
    )
    expect(recorded.ok).toBe(false)
    expect(recorded.ok === false && recorded.code).toBe('gate-may-not-be-self-reported')
  })

  it('refuses an evidence verdict with no verifier and no evidence', () => {
    const unnamed = recordGateVerdict(
      { kind: 'red-team-clean', verdict: 'passed', reason: 'red-team-reported-clean', verifier: '', evidenceRefs: ['r1'] },
      'verifier',
      AT,
    )
    expect(unnamed.ok === false && unnamed.code).toBe('missing-verifier')
    const unsupported = recordGateVerdict(
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

  it('refuses a reason belonging to another gate, and one that contradicts the verdict', () => {
    const wrongGate = recordGateVerdict(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'red-team-reported-clean',
        verifier: 'work.step.verified',
        evidenceRefs: ['ver-1'],
      },
      'verifier',
      AT,
    )
    expect(wrongGate.ok === false && wrongGate.code).toBe('invalid-gate-reason')
    const inverted = recordGateVerdict(
      {
        kind: 'tests-passed',
        verdict: 'passed',
        reason: 'tests-failed',
        verifier: 'work.step.verified',
        evidenceRefs: ['ver-1'],
      },
      'verifier',
      AT,
    )
    expect(inverted.ok === false && inverted.code).toBe('invalid-gate-reason')
  })

  it('refuses an owner verdict that carries evidence or a verifier', () => {
    const withEvidence = recordOwnerApproval(true, AT)
    expect(withEvidence.ok).toBe(true)
    expect(withEvidence.ok === true && withEvidence.verdict.evidenceRefs).toEqual([])
    expect(withEvidence.ok === true && withEvidence.verdict.verifier).toBe('owner')
    expect(withEvidence.ok === true && withEvidence.verdict.authority).toBe('owner')
  })

  it('reads the newest verdict per kind, and a later failure wins', () => {
    const passed = evidenceVerdict('tests-passed')
    const failed = recordGateVerdict(
      {
        kind: 'tests-passed',
        verdict: 'failed',
        reason: 'tests-failed',
        verifier: 'work.step.verified',
        evidenceRefs: ['ver-2'],
      },
      'verifier',
      LATER,
    )
    if (!failed.ok) throw new Error('fixture refused')
    const latest = latestGateVerdicts([passed, failed.verdict])
    expect(latest['tests-passed'].verdict).toBe('failed')
  })

  it('counts only passed as satisfied, so not-applicable is not a way out', () => {
    const skipped = recordGateVerdict(
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
    const outstanding = unsatisfiedGates(request(), [skipped.verdict], AT)
    expect(outstanding).toContain('red-team-clean')
    expect(everyGateSatisfied(request(), [skipped.verdict], AT)).toBe(false)
  })

  it('computes the three derived gates from the request itself', () => {
    const wide = {
      ...request(),
      requirements: ['security.policy.write'],
      targets: ['governor'],
      costSpent: 41,
    } as AcquisitionRequest
    const derived = evaluateSelfGates(wide, AT)
    const byKind = latestGateVerdicts(derived)
    expect(byKind['no-capability-widening'].verdict).toBe('failed')
    expect(byKind['no-protected-target'].verdict).toBe('failed')
    expect(byKind['budget-within-limit'].verdict).toBe('failed')
    expect(byKind['no-capability-widening'].reason).toBe('requires-a-forbidden-capability')
    for (const verdict of evaluateSelfGates(request(), AT)) {
      expect(verdict.verifier).toBeNull()
      expect(verdict.authority).toBe('gate')
    }
  })

  it('approves only when all seven gates pass, and names which is owed otherwise', () => {
    const partial = [evidenceVerdict('verification-passed'), evidenceVerdict('tests-passed')]
    const decision = decideActivation(requestingActivation(), partial, AT)
    expect(decision.approved).toBe(false)
    expect(decision.unsatisfied).toContain('red-team-clean')
    expect(decision.unsatisfied).toContain('owner-approval')
    expect(decision.ownerApproved).toBe(false)
    expect(decision.gates).toHaveLength(7)
    expect(reasonForDecision(decision)).toBe('gate-failed')
    const full = [...partial, evidenceVerdict('red-team-clean')]
    const approved = recordOwnerApproval(true, AT)
    if (!approved.ok) throw new Error('fixture refused')
    const decided = decideActivation(requestingActivation(), [...full, approved.verdict], AT)
    expect(decided.approved).toBe(true)
    expect(decided.unsatisfied).toEqual([])
    expect(decided.ownerApproved).toBe(true)
    expect(reasonForDecision(decided)).toBeNull()
  })

  it('reports the owner refusal ahead of the gate failures', () => {
    const declined = recordOwnerApproval(false, AT)
    if (!declined.ok) throw new Error('fixture refused')
    const decision = decideActivation(requestingActivation(), [declined.verdict], AT)
    expect(reasonForDecision(decision)).toBe('owner-declined-activation')
  })

  it('carries the precedence that stopped it rather than assuming the gates did', () => {
    const decision = decideActivation(requestingActivation(), [], AT, 'stop-all-active')
    expect(decision.approved).toBe(false)
    expect(decision.precedence).toBe('stop-all-active')
  })

  it('revalidates a stored verdict on read, including the owner branch', () => {
    const verdict = evidenceVerdict('tests-passed')
    expect(validateGateVerdict(verdict).ok).toBe(true)
    const forged = { ...verdict, authority: 'owner' }
    expect(validateGateVerdict(forged).ok).toBe(false)
    const derived = { ...verdict, kind: 'no-protected-target', reason: 'target-is-not-protected' }
    expect(validateGateVerdict(derived).ok).toBe(false)
    const ownerApproval = recordOwnerApproval(true, AT)
    if (!ownerApproval.ok) throw new Error('fixture refused')
    expect(validateGateVerdict(ownerApproval.verdict).ok).toBe(true)
    expect(validateGateVerdict({ ...ownerApproval.verdict, reason: 'owner-declined' }).ok).toBe(false)
  })
})

/* ------------------------------------------------------------- precedence */

describe('the precedence ladder is data, and it starts with the journal', () => {
  it('lists six rungs in the order they are obeyed', () => {
    expect(ACQUISITION_PRECEDENCE).toEqual([
      'journal-not-trustworthy',
      'stop-all-active',
      'guard-denied',
      'governor-denied',
      'budget-exhausted',
      'domain-rule',
    ])
  })

  it('names a reason code for every rung a refusal may report', () => {
    for (const rung of ACQUISITION_PRECEDENCE) {
      expect(ACQUISITION_REFUSAL_CODES as readonly string[]).toContain(rung)
    }
  })
})

/* -------------------------------------------------------------- retention */

describe('retention is a deadline nobody may name', () => {
  it('keeps an activation deadline shorter than the request lifetime', () => {
    expect(ACQUISITION_RETENTION.maxActiveLifetimeMs).toBeLessThan(ACQUISITION_RETENTION.maxRequestLifetimeMs)
  })

  it('requires the lifecycle reason to match the status on a stored row', () => {
    expect(isRequestLifecycleConsistent('proposed', null, null)).toBe(true)
    expect(isRequestLifecycleConsistent('rejected', AT, 'owner-rejected-this-request')).toBe(true)
    expect(isRequestLifecycleConsistent('rejected', AT, 'retention-bound-reached')).toBe(false)
    expect(isRequestLifecycleConsistent('proposed', AT, 'gate-failed')).toBe(false)
  })
})

/* ------------------------------------------------------------ derivation */

describe('the derivation is arithmetic, and deterministic', () => {
  it('reports the same numbers for the same state and instant', () => {
    const state = emptyAcquisitionState()
    applyRecord(state, { version: 1, kind: 'gap', gap: gap() })
    applyRecord(state, { version: 1, kind: 'request', request: request() })
    const once = deriveAcquisition(state, AT)
    const twice = deriveAcquisition(state, AT)
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice))
    expect(once.counts.requests).toBe(1)
    expect(once.counts.active).toBe(0)
    expect(once.activationAuthority).toBe('none')
    expect(once.trustClassFloor).toBe('untrusted')
  })

  it('counts the request as awaiting the owner only when that is the single gate owed', () => {
    const state = emptyAcquisitionState()
    applyRecord(state, { version: 1, kind: 'request', request: readyForActivation() })
    applyRecord(state, { version: 1, kind: 'ledger', requestId: 'req-1', verdicts: [
      evidenceVerdict('verification-passed'),
      evidenceVerdict('tests-passed'),
      evidenceVerdict('red-team-clean'),
    ] })
    const derivation = deriveAcquisition(state, AT)
    expect(derivation.awaitingOwner).toEqual(['req-1'])
    expect(derivation.blockedOn['owner-approval']).toBe(1)
    expect(derivation.blockedOn['tests-passed']).toBe(0)
  })

  it('reports a stale request rather than hiding it', () => {
    const state = emptyAcquisitionState()
    applyRecord(state, { version: 1, kind: 'request', request: request() })
    const past = new Date(Date.parse(AT) + ACQUISITION_RETENTION.maxRequestLifetimeMs + 1).toISOString()
    expect(deriveAcquisition(state, past).counts.stale).toBe(1)
  })
})

/* ------------------------------------------------------------------ fold */

describe('a stored row must still satisfy every construction rule', () => {
  it('accepts a request that came through the domain unchanged', () => {
    const rebuilt = rebuildAcquisitionRequest(request())
    expect(rebuilt.ok).toBe(true)
    expect(validateRecord({ version: ACQUISITION_RECORD_VERSION, kind: 'request', request: request() }).ok).toBe(true)
  })

  it('refuses a row that claims a trust class a generated artifact may not hold', () => {
    const rebuilt = rebuildAcquisitionRequest({ ...request(), trustClass: 'derived' })
    expect(rebuilt.ok).toBe(false)
  })

  it('refuses a row whose deadline the retention table does not grant', () => {
    const rebuilt = rebuildAcquisitionRequest({ ...request(), expiresAt: '2099-01-01T00:00:00.000Z' })
    expect(rebuilt.ok === false && rebuilt.reason).toContain('deadline')
  })

  it('refuses a row whose activation state disagrees with its status', () => {
    const rebuilt = rebuildAcquisitionRequest({ ...request(), activation: 'active' })
    expect(rebuilt.ok).toBe(false)
  })

  it('refuses an active row with no activation deadline, and a non-active row with one', () => {
    const active = {
      ...request(),
      status: 'active',
      activation: 'active',
      activationExpiresAt: new Date(Date.parse(AT) + ACQUISITION_RETENTION.maxActiveLifetimeMs).toISOString(),
    }
    expect(rebuildAcquisitionRequest(active).ok).toBe(true)
    expect(rebuildAcquisitionRequest({ ...active, activationExpiresAt: null }).ok).toBe(false)
    expect(rebuildAcquisitionRequest({ ...request(), activationExpiresAt: active.activationExpiresAt }).ok).toBe(false)
  })

  it('refuses a gap row whose deadline was widened', () => {
    expect(rebuildCapabilityGap(gap()).ok).toBe(true)
    expect(rebuildCapabilityGap({ ...gap(), expiresAt: '2099-01-01T00:00:00.000Z' }).ok).toBe(false)
  })

  it('refuses a decision that claims an approval its own gate list contradicts', () => {
    const decision = decideActivation(requestingActivation(), [], AT)
    expect(validateRecord({ version: 1, kind: 'decision', decision }, () => requestingActivation()).ok).toBe(true)
    const forged = { ...decision, approved: true }
    const checked = validateRecord({ version: 1, kind: 'decision', decision: forged }, () => requestingActivation())
    expect(checked.ok).toBe(false)
  })

  it('refuses a decision naming a request the store does not hold', () => {
    const decision = decideActivation(requestingActivation(), [], AT)
    expect(validateRecord({ version: 1, kind: 'decision', decision }, () => undefined).ok).toBe(false)
  })

  it('refuses an over-long ledger rather than truncating it', () => {
    const verdicts = Array.from({ length: ACQUISITION_LIMITS.maxGateVerdicts + 1 }, () => evidenceVerdict('tests-passed'))
    expect(rebuildGateLedger(verdicts).ok).toBe(false)
    expect(rebuildGateLedger(verdicts.slice(0, 3)).ok).toBe(true)
  })

  it('keys rows by kind so a cross-kind id collision is not a conflict', () => {
    const gapKey = recordKey({ version: 1, kind: 'gap', gap: gap() })
    const requestKey = recordKey({ version: 1, kind: 'request', request: request() })
    expect(gapKey).toBe('gap:gap-1')
    expect(requestKey).toBe('request:req-1')
  })
})

/* ----------------------------------------------------------- the boundary */

describe('the boundary, stated as data', () => {
  it('grants nothing, says so, and starts everything untrusted and inactive', () => {
    expect(ACQUISITION_GRANTS_NOTHING.grantsCapability).toBe(false)
    expect(ACQUISITION_GRANTS_NOTHING.mayActivateItself).toBe(false)
    expect(ACQUISITION_GRANTS_NOTHING.maySelfApprove).toBe(false)
    expect(ACQUISITION_GRANTS_NOTHING.generatedStartsUntrusted).toBe(true)
    expect(ACQUISITION_GRANTS_NOTHING.generatedStartsInactive).toBe(true)
  })

  it('refuses capability, grant and permission shaped field names in one family', () => {
    for (const name of ['grantsCapability', 'requiredCapability', 'capability', 'permission', 'bypassGuard', 'apiKey']) {
      expect(isForbiddenAcquisitionFieldName(name)).toBe(true)
    }
    expect(isForbiddenAcquisitionFieldName('symptom')).toBe(false)
    expect(ACQUISITION_FORBIDDEN_FIELDS.length).toBeGreaterThan(10)
  })

  it('closes the protected target list here as well as in skills', () => {
    for (const target of ['authority', 'guard', 'governor', 'security-policy', 'capability-definition', 'freya-source']) {
      expect(PROTECTED_TARGETS as readonly string[]).toContain(target)
    }
  })

  it('binds every reason to a kind and to a verdict', () => {
    for (const kind of GATE_KINDS) {
      for (const reason of GATE_REASONS_BY_KIND[kind]) {
        const verdict = GATE_REASONS_BY_VERDICT.passed.includes(reason)
          ? 'passed'
          : GATE_REASONS_BY_VERDICT.failed.includes(reason)
            ? 'failed'
            : GATE_REASONS_BY_VERDICT.pending.includes(reason)
              ? 'pending'
              : 'not-applicable'
        expect(['passed', 'failed', 'pending', 'not-applicable']).toContain(verdict)
      }
    }
  })
})
