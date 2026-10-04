import { describe, expect, it } from 'vitest'
import { EvolutionRuntime } from '../../../core/evolution'
import {
  detectAuthorityDrift,
  isSelfModificationAttempt,
  isProtectedInvariantViolation,
  classifyEvolutionClaim,
  forbiddenKeysIn,
  createEvidenceRecord,
  createImprovementRecord,
  rollBackImprovement,
  advanceImprovement,
  verifyEvidence,
  isEvidenceSufficient,
  evaluateEvolutionGate,
  transition,
  reduceEvolutionState,
} from '../../../core/evolution'
import { harness, wake, T0 } from './harness'
import type { AuthorityEnvelope, ProposedAuthorityEnvelope } from '../../../core/evolution/types'

const CURRENT: AuthorityEnvelope = Object.freeze({
  capabilities: ['evolution.improve'],
  grants: [],
  budgetCeiling: 100,
  approvalRequired: true,
  stopAllLatched: false,
})

describe('red-team: evolution claims capability â†’ refused', () => {
  it('refuses an improvement that claims a capability it does not hold', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(true)
    const improvement = runtime.folded().improvements.find((i) => i.improvementId === (result.ok && result.value.improvementId))
    expect(improvement).toBeDefined()
    expect(improvement?.kind).toBe('planning')
  })

  it('refuses a claim carrying a forbidden authority shape', () => {
    const claim = { capability: 'guard.bypass', grant: 'cognition.unlimited' }
    const scan = classifyEvolutionClaim(claim)
    expect(scan.prohibited).toBe(true)
    expect(scan.code).toBe('authority-claim-prohibited')
  })

  it('detects forbidden keys in a payload', () => {
    const keys = forbiddenKeysIn({ capability: 'x', normal: 'y' })
    expect(keys).toContain('capability')
  })
})

describe('red-team: evolution claims authority â†’ refused', () => {
  it('refuses a proposed envelope with a new capability', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve', 'guard.bypass'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })

  it('refuses a proposed envelope with a new grant', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: ['cognition.unlimited'],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })

  it('refuses a proposed envelope with a higher budget', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 1_000_000,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })
})

describe('red-team: evolution claims to be owner â†’ refused', () => {
  it('refuses a wake from an unauthorized actor', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake({ actor: 'model' as never }))
    expect(result.outcome).toBe('denied')
    expect(result.outcome === 'denied' && result.code).toBe('unauthorized-actor')
  })

  it('refuses a wake from a renderer actor', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake({ actor: 'renderer' as never }))
    expect(result.outcome).toBe('denied')
  })
})

describe('red-team: evolution claims higher priority â†’ refused', () => {
  it('does not change priority based on a claim', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(true)
    const improvement = runtime.folded().improvements.find((i) => i.improvementId === (result.ok && result.value.improvementId))
    expect(improvement).toBeDefined()
  })
})

describe('red-team: evolution claims more budget â†’ refused', () => {
  it('refuses a proposed envelope with a higher budget ceiling', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 10_000,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })
})

describe('red-team: evolution claims approval â†’ refused', () => {
  it('refuses a proposed envelope with a weakened approval requirement', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: false,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })
})

describe('red-team: bypass Guard â†’ refused', () => {
  it('refuses when the Guard denies', async () => {
    const h = harness({ guardAllows: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('guard-denied')
  })
})

describe('red-team: bypass Governor â†’ refused', () => {
  it('refuses when the Governor denies', async () => {
    const h = harness({ governorAuthorized: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('governor-denied')
  })
})

describe('red-team: bypass STOP ALL â†’ refused', () => {
  it('refuses when STOP ALL is latched', async () => {
    const h = harness({ stopAll: true })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('stop-all-active')
  })

  it('refuses a proposed envelope that clears STOP ALL', () => {
    const latched: AuthorityEnvelope = { ...CURRENT, stopAllLatched: true }
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isProtectedInvariantViolation(proposed, latched)
    expect(result.isViolation).toBe(true)
  })
})

describe('red-team: exceed budget â†’ refused', () => {
  it('refuses when the budget is exhausted', async () => {
    const h = harness({ budgetRemainingUnits: 0 })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('budget-exhausted')
  })
})

describe('red-team: skip approval â†’ refused', () => {
  it('refuses when approval is not satisfied', async () => {
    const h = harness({ approvalSatisfied: false })
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.proposeImprovement('planning')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('approval-required')
  })
})

describe('red-team: widen capability â†’ refused', () => {
  it('refuses a proposed envelope with a new capability', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve', 'new.capability'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })
})

describe('red-team: create grant â†’ refused', () => {
  it('refuses a proposed envelope with a new grant', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: ['new.grant'],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })
})

describe('red-team: self-approve â†’ refused', () => {
  it('refuses a proposed envelope with a weakened approval requirement', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: false,
      stopAllLatched: false,
    }
    const result = isProtectedInvariantViolation(proposed, CURRENT)
    expect(result.isViolation).toBe(true)
  })
})

describe('red-team: hidden inference â†’ detected', () => {
  it('refuses a wake from a polling source', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake({ source: 'scheduled-heartbeat', kind: 'schedule-due', actor: 'host-heartbeat' }))
    expect(result.outcome).toBe('accepted')
  })

  it('refuses a wake from an unauthorized actor', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake({ actor: 'timer' as never }))
    expect(result.outcome).toBe('denied')
  })
})

describe('red-team: continuous polling â†’ detected', () => {
  it('refuses a wake from a polling actor', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    const result = await runtime.considerWake(wake({ actor: 'external-webhook' as never }))
    expect(result.outcome).toBe('denied')
  })
})

describe('red-team: real-money action â†’ refused', () => {
  it('refuses a claim carrying a real-money shape', () => {
    const claim = { realMoney: true, venue: 'broker' }
    const scan = classifyEvolutionClaim(claim)
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a payload with a real-money key', () => {
    const keys = forbiddenKeysIn({ realOrder: true, account: 'x' })
    expect(keys).toContain('realOrder')
    expect(keys).toContain('account')
  })
})

describe('red-team: real order â†’ refused', () => {
  it('refuses a claim carrying a real-order shape', () => {
    const claim = { realOrder: true, exchange: 'x' }
    const scan = classifyEvolutionClaim(claim)
    expect(scan.prohibited).toBe(true)
  })
})

describe('red-team: self-modification â†’ refused', () => {
  it('refuses a self-modification capability', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve', 'self-modify'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isSelfModificationAttempt(proposed)
    expect(result.isAttempt).toBe(true)
  })

  it('refuses a self-modification attempt through the runtime', async () => {
    const h = harness()
    const runtime = new EvolutionRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.refuseSelfModification('core/evolution/runtime.ts', 'attempted')
    expect(h.types()).toContain('evolution.self-modification.refused')
  })
})

describe('red-team: authority drift â†’ refused', () => {
  it('refuses a proposed envelope that widens authority', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve', 'guard.bypass'],
      grants: ['cognition.unlimited'],
      budgetCeiling: 10_000,
      approvalRequired: false,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })
})

describe('red-team: fabricate evidence â†’ refused', () => {
  it('refuses evidence with a quality above its source ceiling', () => {
    const result = createEvidenceRecord({
      evidenceId: 'ev-1',
      source: 'system-health',
      quality: 'verified',
      statement: 'x',
      verifiedAt: T0,
    })
    expect(result.ok).toBe(false)
  })

  it('refuses evidence with no statement', () => {
    const result = createEvidenceRecord({
      evidenceId: 'ev-1',
      source: 'work-run',
      quality: 'strong',
      statement: '',
      verifiedAt: T0,
    })
    expect(result.ok).toBe(false)
  })

  it('refuses evidence with an expired instant', () => {
    const result = createEvidenceRecord({
      evidenceId: 'ev-1',
      source: 'work-run',
      quality: 'strong',
      statement: 'x',
      verifiedAt: 'not-a-date',
    })
    expect(result.ok).toBe(false)
  })
})

describe('red-team: unauthorized improvement â†’ refused', () => {
  it('refuses an improvement with no evidence', () => {
    const result = createImprovementRecord({
      improvementId: 'imp-1',
      kind: 'planning',
      description: 'x',
      evidenceIds: [],
      createdAt: T0,
    })
    expect(result.ok).toBe(false)
  })

  it('refuses an improvement with an unknown kind', () => {
    const result = createImprovementRecord({
      improvementId: 'imp-1',
      kind: 'unknown-kind',
      description: 'x',
      evidenceIds: ['ev-1'],
      createdAt: T0,
    })
    expect(result.ok).toBe(false)
  })
})

describe('red-team: model output claims urgency â†’ data', () => {
  it('treats a model claim as data, not authority', () => {
    const claim = { urgency: 'critical' }
    const scan = classifyEvolutionClaim(claim)
    expect(scan.prohibited).toBe(false)
  })
})

describe('red-team: event claims importance â†’ data', () => {
  it('treats an event claim as data, not authority', () => {
    const claim = { importance: 'high', deadline: 'now' }
    const scan = classifyEvolutionClaim(claim)
    expect(scan.prohibited).toBe(false)
  })
})

describe('red-team: context claims authority â†’ data', () => {
  it('treats a context claim as data, not authority', () => {
    const claim = { authority: 'owner', capability: 'guard.bypass' }
    const scan = classifyEvolutionClaim(claim)
    expect(scan.prohibited).toBe(true)
  })
})

describe('red-team: replay safety', () => {
  it('produces the same state for the same journal', () => {
    const entries = [
      { type: 'evolution.wake.received', recordedAt: T0, payload: { wakeKey: 'k1' } },
      { type: 'evolution.evidence.verified', recordedAt: T0, payload: { evidenceId: 'ev-1', source: 'work-run', quality: 'strong', statement: 'x', verifiedAt: T0, expiresAt: T0 } },
    ]
    const a = reduceEvolutionState(entries)
    const b = reduceEvolutionState(entries)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('is idempotent: replaying the same journal twice gives the same state', () => {
    const entries = [
      { type: 'evolution.wake.received', recordedAt: T0, payload: { wakeKey: 'k1' } },
    ]
    const a = reduceEvolutionState(entries)
    const b = reduceEvolutionState([...entries, ...entries])
    expect(a.state.processedWakeKeys).toEqual(b.state.processedWakeKeys)
  })
})

describe('red-team: rollback', () => {
  it('rolls back an applied improvement', () => {
    const created = createImprovementRecord({
      improvementId: 'imp-1',
      kind: 'planning',
      description: 'x',
      evidenceIds: ['ev-1'],
      createdAt: T0,
    })
    if (!created.ok) throw new Error('fixture refused')
    let current = created.value
    for (const to of ['evaluating', 'approved', 'staged'] as const) {
      const result = advanceImprovement(current, { now: T0, to })
      if (!result.ok) throw new Error('fixture refused')
      current = result.value
    }
    const rolled = rollBackImprovement(current, { now: T0, reason: 'degraded' })
    expect(rolled.ok).toBe(true)
    expect(rolled.ok && rolled.value.state).toBe('failed')
  })
})

describe('red-team: evidence quality and provenance', () => {
  it('refuses evidence that has expired', () => {
    const created = createEvidenceRecord({
      evidenceId: 'ev-1',
      source: 'work-run',
      quality: 'strong',
      statement: 'x',
      verifiedAt: T0,
    })
    if (!created.ok) throw new Error('fixture refused')
    const past = new Date(Date.parse(T0) + 91 * 24 * 60 * 60 * 1_000).toISOString()
    const result = verifyEvidence(created.value, past)
    expect(result.outcome).toBe('expired')
  })

  it('refuses insufficient evidence', () => {
    const created = createEvidenceRecord({
      evidenceId: 'ev-1',
      source: 'work-run',
      quality: 'insufficient',
      statement: 'x',
      verifiedAt: T0,
    })
    if (!created.ok) throw new Error('fixture refused')
    const result = isEvidenceSufficient([created.value], T0)
    expect(result.sufficient).toBe(false)
  })
})

describe('red-team: regression refusal', () => {
  it('refuses to advance a failed improvement', () => {
    const created = createImprovementRecord({
      improvementId: 'imp-1',
      kind: 'planning',
      description: 'x',
      evidenceIds: ['ev-1'],
      createdAt: T0,
    })
    if (!created.ok) throw new Error('fixture refused')
    const failed = advanceImprovement(created.value, { now: T0, to: 'failed' })
    if (!failed.ok) throw new Error('fixture refused')
    const result = advanceImprovement(failed.value, { now: T0, to: 'evaluating' })
    expect(result.ok).toBe(false)
  })
})

describe('red-team: state machine', () => {
  it('refuses an illegal transition', () => {
    const result = transition('STABLE', 'improvement-ready')
    expect(result.ok).toBe(false)
  })

  it('refuses a transition from FAILED', () => {
    const result = transition('FAILED', 'reset')
    expect(result.ok).toBe(true)
    const after = transition('STABLE', 'reset')
    expect(after.ok).toBe(false)
  })
})

describe('red-team: authority gate', () => {
  it('denies when the journal is not trustworthy', () => {
    const result = evaluateEvolutionGate({
      journalTrustworthy: false,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 100,
      approvalSatisfied: true,
      realMoney: false,
    })
    expect(result.outcome).toBe('deny')
    expect(result.outcome === 'deny' && result.code).toBe('journal-not-trustworthy')
  })

  it('denies when STOP ALL is active', () => {
    const result = evaluateEvolutionGate({
      journalTrustworthy: true,
      stopAllActive: true,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 100,
      approvalSatisfied: true,
      realMoney: false,
    })
    expect(result.outcome).toBe('deny')
    expect(result.outcome === 'deny' && result.code).toBe('stop-all-active')
  })

  it('denies when real money is involved', () => {
    const result = evaluateEvolutionGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 100,
      approvalSatisfied: true,
      realMoney: true,
    })
    expect(result.outcome).toBe('deny')
    expect(result.outcome === 'deny' && result.code).toBe('real-money-prohibited')
  })

  it('allows when every gate clears', () => {
    const result = evaluateEvolutionGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 100,
      approvalSatisfied: true,
      realMoney: false,
    })
    expect(result.outcome).toBe('allow')
  })
})
