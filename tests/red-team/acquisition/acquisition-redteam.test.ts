import { describe, expect, it } from 'vitest'
import {
  ACQUISITION_RECORD_VERSION,
  ACQUISITION_RETENTION,
  AcquisitionEngine,
  advanceAcquisitionRequest,
  createAcquisitionRequest,
  decideActivation,
  recordGateVerdict,
  recordOwnerApproval,
  rebuildAcquisitionRequest,
  validateRecord,
  type AcquisitionRequest,
  type GateVerdictRecord,
} from '../../../core/acquisition'
import { MemoryAcquisitionStore } from '../../../core/vault/repositories/acquisition-store'
import type { VaultAcquisitionStore } from '../../../core/vault/repositories/acquisition-store'

/**
 * THE ATTACKS, aimed at the one thing this phase exists to prevent.
 *
 * Five families, each named after the invariant it is trying to break:
 *
 * - `self-grant` — a generated capability that reaches `active` without a person.
 * - `authority-widening` — a request that acquires a capability, a scope or a protected target.
 * - `precedence-spoofing` — a refusal that pretends to be a domain rule, or a decision that
 *   pretends the gates were the thing that stopped it.
 * - `ledger-forgery` — a verdict, ledger or row edited to say a gate passed.
 * - `untrusted-build` — text that tries to talk its way past a refusal.
 *
 * Every attack here is expressed as an *untyped payload* or a *hand-edited record*, because a
 * typed caller is already constrained by the compiler and the interesting adversary is not one.
 */

const AT = '2026-06-01T09:00:00.000Z'

function allow(): { allowed: boolean; reason: string } {
  return { allowed: true, reason: 'held' }
}

/** An engine that behaves, plus the store behind it, so an attack can inspect the result. */
function engineOn(store: MemoryAcquisitionStore | VaultAcquisitionStore): AcquisitionEngine {
  return new AcquisitionEngine({
    store,
    now: () => new Date(AT),
    journalTrustworthy: () => true,
    stopAllActive: () => false,
    guard: () => allow(),
    governor: () => allow(),
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
    costCeiling: 40,
    tags: [],
    confidence: 'medium',
    createdAt: AT,
    ...overrides,
  }
}

/** Drive a request to `activation-requested` with every evidence gate passed. */
async function readyToActivate(engine: AcquisitionEngine, id = 'req-1'): Promise<void> {
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
}

async function proposed(engine: AcquisitionEngine, overrides: Record<string, unknown> = {}): Promise<void> {
  await engine.detectGap(gapPayload())
  const refused = await engine.proposeRequest(requestPayload(overrides))
  if (!refused.ok) throw new Error(`fixture refused: ${refused.code} ${refused.reason}`)
}

/* ------------------------------------------------------------- self-grant */

describe('a generated capability cannot reach active without a person', () => {
  it('refuses a payload that declares itself trusted or already running', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    await engine.detectGap(gapPayload())
    for (const field of [
      { trustClass: 'derived' },
      { trustClass: 'owner-declared' },
      { activation: 'active' },
      { activation: 'activation-requested' },
      { status: 'active' },
    ]) {
      const refused = await engine.proposeRequest({ ...requestPayload(), ...field })
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('forbidden-field-refused')
    }
    expect(engine.derive().counts.active).toBe(0)
  })

  it('refuses a payload carrying a grant, a scope or a permission under any of its names', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    await engine.detectGap(gapPayload())
    for (const field of [
      { grantsCapability: true },
      { requiredCapability: 'work.run.manage' },
      { scope: 'owner' },
      { permissions: ['files.write'] },
      { approval: 'granted' },
      { register: 'skills' },
    ]) {
      const refused = await engine.proposeRequest({ ...requestPayload(), ...field })
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('forbidden-field-refused')
    }
  })

  it('refuses an owner approval from every authority but the owner', () => {
    for (const authority of ['verifier', 'core', 'gate'] as const) {
      const refused = recordGateVerdict(
        {
          kind: 'owner-approval',
          verdict: 'passed',
          reason: 'owner-approved-this-activation',
          verifier: null,
          evidenceRefs: [],
        },
        authority,
        AT,
      )
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('not-owner')
    }
    // And the owner function is the only producer, with the authority hard-set.
    const approval = recordOwnerApproval(true, AT)
    expect(approval.ok === true && approval.verdict.authority).toBe('owner')
  })

  it('gives a non-owner principal no way to reach an approval, whatever it holds', async () => {
    const store = new MemoryAcquisitionStore()
    // A Guard that allows everything, as a fully-compromised-privilege configuration would.
    const engine = new AcquisitionEngine({
      store,
      now: () => new Date(AT),
      guard: () => allow(),
      governor: () => allow(),
    })
    await proposed(engine)
    await readyToActivate(engine)
    // The owner scope is not a capability: it is an object the engine issues to one principal.
    expect(engine.ownerScope('agent:worker')).toBeNull()
    expect(engine.ownerScope('system')).toBeNull()
    expect(engine.ownerScope('module:foundry')).toBeNull()
    // Even with the object in hand, there is no method that approves without the owner.
    const decided = await engine.ownerScope('agent:worker')?.decide('req-1', true, 'please')
    expect(decided).toBeUndefined()
    expect(store.state().requests.get('req-1')?.status).toBe('activation-requested')
    expect(engine.derive().counts.active).toBe(0)
  })

  it('will not let an approval stand in for a gate that failed', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine)
    await engine.chargeBuildStep('req-1', 1)
    await engine.markBuilt('req-1')
    await engine.beginVerification('req-1')
    await engine.recordVerification({
      requestId: 'req-1',
      kind: 'red-team-clean',
      passed: false,
      verifier: 'red-team.sweep',
      evidenceRefs: ['rt-1'],
    })
    await engine.completeVerification('req-1')
    await engine.requestActivation('req-1')
    const approved = await engine.ownerScope('owner')?.decide('req-1', true, 'I approve it anyway')
    expect(approved?.ok).toBe(false)
    expect(approved?.ok === false && approved.code).toBe('gate-not-satisfied')
    expect(approved?.ok === false && approved.reason).toContain('verification-passed')
    expect(engine.derive().counts.active).toBe(0)
  })
})

/* ------------------------------------------------------- authority widening */

describe('an acquisition cannot widen what Freya may do', () => {
  it('refuses every forbidden requirement at construction', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    await engine.detectGap(gapPayload())
    const forbidden = [
      'security.authority.manage',
      'security.policy.write',
      'security.budget.manage',
      'security.stop.clear',
      'cognition.grant.manage',
      'work.approval.decide',
      'work.run.manage',
      'mission.manage',
      'guard.policy.write',
    ]
    for (const requirement of forbidden) {
      const refused = await engine.proposeRequest(requestPayload({ requirements: [requirement] }))
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('forbidden-requirement')
    }
    expect(engine.derive().counts.requests).toBe(0)
  })

  it('refuses every protected target at construction', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    await engine.detectGap(gapPayload())
    const protectedTargets = [
      'authority',
      'guard',
      'governor',
      'security-policy',
      'capability-definition',
      'key-material',
      'trusted-runtime',
      'constitution',
      'budget-policy',
      'freya-source',
    ]
    for (const target of protectedTargets) {
      const refused = await engine.proposeRequest(requestPayload({ targets: [target] }))
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('protected-target')
    }
  })

  it('refuses a gap whose wanted is a capability rather than a shape of thing', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    for (const wanted of ['work.run.manage', 'security.authority.manage', 'capability.grant']) {
      const refused = await engine.detectGap(gapPayload({ wanted }))
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('invalid-slug')
    }
  })

  it('recomputes the widening gate from the request even when the ledger says nothing', async () => {
    // A request that somehow carries a forbidden requirement anyway — a hand-edited record, or a
    // weakened construction rule — still meets a gate that refuses it.
    const engine = engineOn(new MemoryAcquisitionStore())
    await proposed(engine)
    expect(engine.persistence().degraded).toBe(false)
    const store = new MemoryAcquisitionStore()
    const manual = engineOn(store)
    await manual.detectGap(gapPayload())
    await manual.proposeRequest(requestPayload())
    const widened = {
      ...store.state().requests.get('req-1')!,
      requirements: ['security.policy.write'],
    } as AcquisitionRequest
    const decision = decideActivation(widened, [], AT)
    expect(decision.approved).toBe(false)
    expect(decision.unsatisfied).toContain('no-capability-widening')
    expect(validateRecord({ version: ACQUISITION_RECORD_VERSION, kind: 'request', request: widened }).ok).toBe(false)
    // And the stored-row check refuses it independently of the gate.
    expect(rebuildAcquisitionRequest(widened).ok).toBe(false)
  })

  it('refuses a request whose cost ceiling is above the domain bound', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    await engine.detectGap(gapPayload())
    const refused = await engine.proposeRequest(requestPayload({ costCeiling: 10_000 }))
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('invalid-id')
  })
})

/* ------------------------------------------------------ precedence spoofing */

describe('a refusal cannot be dressed up as a domain rule', () => {
  it('reports the stop latch, not a gate failure, while Freya is stopped', async () => {
    let latched = true
    const store = new MemoryAcquisitionStore()
    const engine = new AcquisitionEngine({
      store,
      now: () => new Date(AT),
      stopAllActive: () => latched,
      guard: () => allow(),
      governor: () => allow(),
    })
    // Set up while running, then latch: the fixture must not depend on the latch to exist.
    latched = false
    await proposed(engine)
    latched = true
    const refused = await engine.detectGap(gapPayload({ gapId: 'gap-2' }))
    expect(refused.ok === false && refused.code).toBe('stop-all-active')
    latched = false
    const allowed = await engine.detectGap(gapPayload({ gapId: 'gap-2' }))
    expect(allowed.ok).toBe(true)
  })

  it('reports the journal, not the stop, when the log cannot be believed', async () => {
    let trustworthy = false
    const engine = new AcquisitionEngine({
      store: new MemoryAcquisitionStore(),
      now: () => new Date(AT),
      journalTrustworthy: () => trustworthy,
      stopAllActive: () => true,
      guard: () => allow(),
      governor: () => allow(),
    })
    const refused = await engine.detectGap(gapPayload())
    // The higher rung is reported even though both would have refused.
    expect(refused.ok === false && refused.code).toBe('journal-not-trustworthy')
    trustworthy = true
    const stillStopped = await engine.detectGap(gapPayload())
    expect(stillStopped.ok === false && stillStopped.code).toBe('stop-all-active')
  })

  it('records which rung stopped a decision, so a later reader is not misled', async () => {
    // A decision taken with no precedence reports null, not a guess.
    const decision = decideActivation(requestingActivation(), [], AT)
    expect(decision.precedence).toBeNull()
    const underStop = decideActivation(requestingActivation(), [], AT, 'stop-all-active')
    expect(underStop.precedence).toBe('stop-all-active')
    expect(underStop.approved).toBe(false)
  })

  it('records a refused approval as charged and decided rather than silently doing nothing', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine)
    await readyToActivate(engine)
    // Revoke nothing: the owner declines, and the ledger keeps both the charge and the reason.
    const declined = await engine.ownerScope('owner')?.decide('req-1', false, 'not now')
    expect(declined?.ok === true && declined.spent).toBeGreaterThan(0)
    expect(store.state().requests.get('req-1')?.lifecycleReason).toBe('owner-declined-activation')
    const ledger = store.state().gates.get('req-1') ?? []
    expect(ledger.some((entry) => entry.kind === 'owner-approval' && entry.verdict === 'failed')).toBe(true)
  })
})

/* ------------------------------------------------------------ ledger forgery */

describe('a gate verdict cannot be edited into a pass', () => {
  it('refuses a hand-written verdict on a gate that is computed from the request', () => {
    for (const [kind, reason] of [
      ['no-protected-target', 'target-is-not-protected'],
      ['no-capability-widening', 'requires-no-forbidden-capability'],
      ['budget-within-limit', 'spend-stayed-within-the-bound'],
    ] as const) {
      const refused = recordGateVerdict(
        { kind, verdict: 'passed', reason, verifier: 'core', evidenceRefs: [] },
        'core',
        AT,
      )
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.code).toBe('gate-may-not-be-self-reported')
    }
  })

  it('refuses a verdict whose reason belongs to another gate', () => {
    const refused = recordGateVerdict(
      {
        kind: 'verification-passed',
        verdict: 'passed',
        reason: 'tests-reported-passing',
        verifier: 'work.step.verified',
        evidenceRefs: ['ver-1'],
      },
      'verifier',
      AT,
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('invalid-gate-reason')
  })

  it('refuses a verdict that contradicts its own label', () => {
    const refused = recordGateVerdict(
      {
        kind: 'red-team-clean',
        verdict: 'passed',
        reason: 'red-team-found-something',
        verifier: 'red-team.sweep',
        evidenceRefs: ['rt-1'],
      },
      'verifier',
      AT,
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('invalid-gate-reason')
  })

  it('refuses a verdict from the gate evaluator itself', () => {
    const refused = recordGateVerdict(
      {
        kind: 'red-team-clean',
        verdict: 'passed',
        reason: 'red-team-reported-clean',
        verifier: 'gate',
        evidenceRefs: ['rt-1'],
      },
      'gate',
      AT,
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('gate-may-not-be-self-reported')
  })

  it('treats not-applicable as unsatisfied rather than as a way past', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine)
    await engine.chargeBuildStep('req-1', 1)
    await engine.markBuilt('req-1')
    await engine.beginVerification('req-1')
    await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: false,
      notApplicable: true,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-1'],
    })
    const completed = await engine.completeVerification('req-1')
    expect(completed.ok === true && completed.operation).toBe('verification-failed')
    expect(store.state().requests.get('req-1')?.status).toBe('rejected')
  })

  it('lets a later failure override an earlier pass, rather than the other way round', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine)
    await engine.chargeBuildStep('req-1', 1)
    await engine.markBuilt('req-1')
    await engine.beginVerification('req-1')
    // The tests pass, and then they fail a second time. The newest verdict is the one that counts.
    await engine.recordVerification({
      requestId: 'req-1',
      kind: 'tests-passed',
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-1'],
    })
    await engine.recordVerification({
      requestId: 'req-1',
      kind: 'verification-passed',
      passed: true,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-0'],
    })
    const failed = await engine.recordVerification({
      requestId: 'req-1',
      kind: 'tests-passed',
      passed: false,
      verifier: 'work.step.verified',
      evidenceRefs: ['ver-2'],
    })
    expect(failed.ok === true && failed.operation).toBe('verification-failed')
    const ledger = store.state().gates.get('req-1') ?? []
    expect(ledger.filter((entry) => entry.kind === 'tests-passed')).toHaveLength(2)
    const newest = [...ledger].reverse().find((entry) => entry.kind === 'tests-passed')
    expect(newest?.verdict).toBe('failed')
    const detail = engine.readRequest('req-1')
    expect(detail.ok === true && detail.view.unsatisfied).toContain('tests-passed')
    // Verification itself still passes — the artifact verified — so completion succeeds. What the
    // later failure blocks is the *activation*: a failed test gate is not something an owner can
    // approve around, and completion is not where it is caught.
    const completed = await engine.completeVerification('req-1')
    expect(completed.ok === true && completed.operation).toBe('verified')
    await engine.requestActivation('req-1')
    const approved = await engine.ownerScope('owner')?.decide('req-1', true, 'approved anyway')
    expect(approved?.ok).toBe(false)
    expect(approved?.ok === false && approved.reason).toContain('tests-passed')
    expect(store.state().requests.get('req-1')?.status).toBe('activation-requested')
    expect(engine.derive().counts.active).toBe(0)
  })

  it('refuses a stored row whose trust class or deadline was edited', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine)
    const row = store.state().requests.get('req-1')!
    expect(validateRecord({ version: ACQUISITION_RECORD_VERSION, kind: 'request', request: row }).ok).toBe(true)
    for (const forged of [
      { ...row, trustClass: 'derived' },
      { ...row, trustClass: 'owner-declared' },
      { ...row, expiresAt: '2099-01-01T00:00:00.000Z' },
      { ...row, activation: 'active' },
      { ...row, confidence: 'verified' },
      { ...row, costSpent: row.costCeiling + 1 },
    ]) {
      const checked = validateRecord({ version: ACQUISITION_RECORD_VERSION, kind: 'request', request: forged })
      expect(checked.ok).toBe(false)
    }
  })

  it('refuses a stored decision that claims an approval its own gates contradict', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine)
    await readyToActivate(engine)
    await engine.ownerScope('owner')?.decide('req-1', true, 'approved')
    const decision = store.state().decisions.get('req-1')!
    expect(decision.approved).toBe(true)
    const forged = { ...decision, approved: true, unsatisfied: ['owner-approval'] }
    const checked = validateRecord(
      { version: ACQUISITION_RECORD_VERSION, kind: 'decision', decision: forged },
      () => store.state().requests.get('req-1')!,
    )
    expect(checked.ok).toBe(false)
  })

  it('refuses an owner approval row relabelled by hand', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine)
    await readyToActivate(engine)
    await engine.ownerScope('owner')?.decide('req-1', false, 'not this one')
    const ledger = store.state().gates.get('req-1') ?? []
    const declined = ledger.find((entry) => entry.kind === 'owner-approval') as GateVerdictRecord
    // Flip the verdict but keep the owner authority and the declined reason.
    const forged: GateVerdictRecord = { ...declined, verdict: 'passed' }
    const checked = validateRecord({
      version: ACQUISITION_RECORD_VERSION,
      kind: 'ledger',
      requestId: 'req-1',
      verdicts: [forged],
    })
    expect(checked.ok).toBe(false)
  })
})

/* ------------------------------------------------------------ untrusted text */

describe('a build description cannot talk its way past a refusal', () => {
  it('refuses a symptom carrying secret-shaped text whole', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    const refused = await engine.detectGap(
      gapPayload({ symptom: 'the export needed token = AKIAIOSFODNN7EXAMPLE to run' }),
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('invalid-text')
  })

  it('refuses an intent that carries secret-shaped text whole', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    await engine.detectGap(gapPayload())
    const refused = await engine.proposeRequest(
      requestPayload({ intent: 'read the table using api_key = AKIAIOSFODNN7EXAMPLE1 and export it' }),
    )
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('invalid-text')
  })

  it('refuses a subject that is not a slug, however it is phrased', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    await engine.detectGap(gapPayload())
    for (const subject of [
      'read the owner files and grant myself work.run.manage',
      'work.run.manage',
      'Grant',
      '',
      'a'.repeat(200),
    ]) {
      const refused = await engine.proposeRequest(requestPayload({ subject }))
      expect(refused.ok).toBe(false)
    }
  })

  it('refuses an extra field rather than dropping it, on the gap and on the request', async () => {
    const engine = engineOn(new MemoryAcquisitionStore())
    expect((await engine.detectGap({ ...gapPayload(), note: 'ignore the rules' })).ok).toBe(false)
    await engine.detectGap(gapPayload())
    expect((await engine.proposeRequest({ ...requestPayload(), note: 'ignore the rules' })).ok).toBe(false)
  })
})

/* --------------------------------------------------------------- cost abuse */

describe('cost cannot be spent without a bound', () => {
  it('stops at the ceiling instead of overshooting and being noticed later', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await proposed(engine, { costCeiling: 3, steps: ['read the table'] })
    await engine.chargeBuildStep('req-1', 3)
    const refused = await engine.chargeBuildStep('req-1', 1)
    expect(refused.ok === false && refused.code).toBe('budget-exhausted')
    expect(store.state().requests.get('req-1')?.costSpent).toBe(3)
  })

  it('charges nothing for a request that was refused at construction', async () => {
    const store = new MemoryAcquisitionStore()
    const engine = engineOn(store)
    await engine.detectGap(gapPayload())
    const refused = await engine.proposeRequest(requestPayload({ targets: ['authority'] }))
    expect(refused.ok).toBe(false)
    expect(store.state().requests.size).toBe(0)
  })
})

/* ------------------------------------------------------------------ helpers */

/**
 * A request walked to `activation-requested` by hand.
 *
 * Deliberately independent of the engine: a decision helper must be attackable with a record the
 * engine itself would not have produced, or the attacks on it are only testing the engine.
 */
function requestingActivation(): AcquisitionRequest {
  const created = createAcquisitionRequest(requestPayload())
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  let current = created.value
  for (const to of ['building', 'built', 'verifying', 'verified', 'activation-requested'] as const) {
    const advanced = advanceAcquisitionRequest(current, { now: AT, to })
    if (!advanced.ok) throw new Error(`fixture refused: ${advanced.code} ${advanced.reason}`)
    current = advanced.value
  }
  return current
}

void ACQUISITION_RETENTION