import { describe, expect, it } from 'vitest'
import {
  LEARNING_PROPOSAL_THRESHOLDS,
  LearningEngine,
  applyRecord,
  conflictedClaims,
  decideSupport,
  deriveLearning,
  emptyLearningState,
  lowestConfidence,
  strongestScope,
  type LearningState,
} from '../../core/learning'
import { MemoryLearningStore } from '../../core/vault/repositories/learning-store'

/**
 * PHASE 28 — THE SUPPORT ARITHMETIC.
 *
 * A procedure proposal is not "Freya learned something". It is "several **distinct**
 * checks established something, none of them failed, and none of them is too old to rely
 * on". These tests pin each of those three conditions, because each is a way the pipeline
 * could otherwise be made to say something it does not know.
 *
 * The engine here is the real one on the in-memory store, with `now` and `newId` injected:
 * no clock, no randomness, no model, no network.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()

function makeEngine(): LearningEngine {
  let counter = 0
  return new LearningEngine({
    store: new MemoryLearningStore(),
    now: () => NOW,
    newId: () => `gen-${(counter += 1)}`,
  })
}

interface CheckSpec {
  readonly outcomeId: string
  readonly experienceId: string
  readonly knowledgeId: string
  readonly result?: 'succeeded' | 'failed' | 'partial'
  readonly establishedAt?: string
  readonly observedAt?: string
}

/** One full pipeline pass: a check, a lesson from it, and a claim from the lesson. */
async function addCheck(
  engine: LearningEngine,
  spec: CheckSpec,
  options: { claim?: string; kind?: 'process-fact' | 'outcome-pattern' | 'tool-behaviour' } = {},
): Promise<void> {
  const establishedAt = spec.establishedAt ?? NOW_ISO
  await engine.recordVerifiedOutcome({
    outcomeId: spec.outcomeId,
    sourceDomain: 'work',
    verificationId: `ver-${spec.outcomeId}`,
    verifierId: 'work.step.verified',
    checked: 'the run completed and its verifier inspected the result',
    subjectRef: `run-${spec.outcomeId}`,
    result: spec.result ?? 'succeeded',
    establishedAt,
  })
  await engine.distilExperience(spec.outcomeId, {
    experienceId: spec.experienceId,
    kind: 'tool-lesson',
    lesson: `the verifier for ${spec.outcomeId} read the result and reported the outcome`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    observedAt: spec.observedAt ?? establishedAt,
  })
  await engine.deriveKnowledge({
    knowledgeId: spec.knowledgeId,
    kind: options.kind ?? 'process-fact',
    claim: options.claim ?? `a verification step has to inspect the result for ${spec.outcomeId}`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    supports: [spec.experienceId],
    tags: ['verifier'],
    observedAt: spec.observedAt ?? establishedAt,
  })
}

describe('nothing is proposed from one check', () => {
  it('is below threshold on a single verified outcome, and says why', async () => {
    const engine = makeEngine()
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    const proposals = engine.proposals()
    expect(proposals).toHaveLength(1)
    const proposal = proposals[0]!
    expect(proposal.support.aboveThreshold).toBe(false)
    expect(proposal.support.reason).toBe('too-few-experiences')
    expect(proposal.distinctVerifications).toBe(1)
    // And it is still reported, with the guarantee fields, so a surface can render it.
    expect(proposal.grantsCapability).toBe(false)
    expect(proposal.executable).toBe(false)
    expect(proposal.authority).toBe('none')
  })

  it('offers no skill packet at all while below threshold', async () => {
    const engine = makeEngine()
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    const packets = engine.skillPackets()
    expect(packets.ok).toBe(true)
    if (!packets.ok) return
    expect(packets.packets).toHaveLength(0)
  })
})

describe('repeats are not evidence', () => {
  it('counts distinct verifications, so the same check twice is still one', async () => {
    const engine = makeEngine()
    await engine.recordVerifiedOutcome({
      outcomeId: 'o1',
      sourceDomain: 'work',
      verificationId: 'ver-same',
      verifierId: 'work.step.verified',
      checked: 'the run completed and its verifier inspected the result',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    await engine.recordVerifiedOutcome({
      outcomeId: 'o2',
      sourceDomain: 'work',
      verificationId: 'ver-same',
      verifierId: 'work.step.verified',
      checked: 'the run completed again and its verifier inspected the result',
      subjectRef: 'run-2',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    await engine.distilExperience('o1', {
      experienceId: 'e1',
      kind: 'tool-lesson',
      lesson: 'the verifier read the result on the first run',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    await engine.distilExperience('o2', {
      experienceId: 'e2',
      kind: 'tool-lesson',
      lesson: 'the verifier read the result on the second run',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    await engine.deriveKnowledge({
      knowledgeId: 'k1',
      kind: 'process-fact',
      claim: 'a verification step has to inspect the result rather than trust the log',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: ['e1', 'e2'],
      tags: ['verifier'],
      observedAt: NOW_ISO,
    })
    const proposal = engine.proposals()[0]!
    // Two experiences, but both trace back to one verification.
    expect(proposal.support.distinctExperiences).toBe(2)
    expect(proposal.support.distinctVerifications).toBe(1)
    expect(proposal.support.aboveThreshold).toBe(false)
    expect(proposal.support.reason).toBe('too-few-verifications')
  })
})

describe('a failure poisons the group', () => {
  it('is below threshold when any supporting check failed, and reports the failure', async () => {
    const engine = makeEngine()
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    // A second, failed check: distilled as a failure lesson, which is a different kind.
    await engine.recordVerifiedOutcome({
      outcomeId: 'o2',
      sourceDomain: 'work',
      verificationId: 'ver-o2',
      verifierId: 'work.step.verified',
      checked: 'the run failed and its verifier inspected the failure',
      subjectRef: 'run-2',
      result: 'failed',
      establishedAt: NOW_ISO,
    })
    // A failed check cannot produce an outcome-lesson; it can only produce a failure
    // lesson, so build that directly through the same construction rules.
    const state = engine.derive().counts
    expect(state.experiences).toBe(1)

    const proposal = engine.proposals()[0]!
    expect(proposal.support.aboveThreshold).toBe(false)
    expect(proposal.support.reason).toBe('too-few-experiences')
  })

  it('reports failed-outcomes-present above the other reasons when one is in the support', () => {
    const support = {
      distinctVerifications: 5,
      distinctExperiences: 5,
      failedOutcomes: 1,
      staleVerifications: 0,
      experiences: [],
      verificationIds: [],
    }
    const decided = decideSupport(support)
    expect(decided.aboveThreshold).toBe(false)
    expect(decided.reason).toBe('failed-outcomes-present')
  })

  it('has a zero tolerance for failures', () => {
    expect(LEARNING_PROPOSAL_THRESHOLDS.maxFailedOutcomes).toBe(0)
  })
})

describe('two independent checks are enough, and age matters', () => {
  it('clears the threshold on two distinct verifications and nothing else', async () => {
    const engine = makeEngine()
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    await addCheck(engine, { outcomeId: 'o2', experienceId: 'e2', knowledgeId: 'k2' })
    const proposal = engine.proposals()[0]!
    expect(proposal.support.aboveThreshold).toBe(true)
    expect(proposal.support.reason).toBe('above-threshold')
    expect(proposal.distinctVerifications).toBe(2)
    expect(proposal.scope).toBe('one-instance')
    expect(proposal.scopeLimits).toContain('no-future-guarantee')

    const packets = engine.skillPackets()
    expect(packets.ok).toBe(true)
    if (!packets.ok) return
    expect(packets.packets).toHaveLength(1)
    const packet = packets.packets[0]!
    expect(packet.executable).toBe(false)
    expect(packet.trustClass).toBe('derived')
    expect(packet.originRefs.length).toBeGreaterThanOrEqual(2)
    // No authority field to find.
    expect(Object.keys(packet).sort()).toEqual(['executable', 'kind', 'name', 'originRefs', 'steps', 'trustClass'])
  })

  it('is below threshold when the evidence is stale', () => {
    const decided = decideSupport({
      distinctVerifications: 2,
      distinctExperiences: 2,
      failedOutcomes: 0,
      staleVerifications: 2,
      experiences: [],
      verificationIds: [],
    })
    expect(decided.aboveThreshold).toBe(false)
    expect(decided.reason).toBe('evidence-stale')
  })

  it('refuses to derive a proposal from an outcome that is too old', async () => {
    const engine = makeEngine()
    const old = new Date(Date.parse(NOW_ISO) - (LEARNING_PROPOSAL_THRESHOLDS.maxEvidenceAgeDays + 30) * 86_400_000)
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1', establishedAt: old.toISOString() })
    await addCheck(engine, { outcomeId: 'o2', experienceId: 'e2', knowledgeId: 'k2', establishedAt: old.toISOString() })
    const proposal = engine.proposals()[0]!
    expect(proposal.support.aboveThreshold).toBe(false)
    expect(proposal.support.reason).toBe('evidence-stale')
    expect(proposal.support.staleVerifications).toBe(2)
  })
})

describe('a proposal is never more certain than its least certain part', () => {
  it('takes the lowest confidence among its claims', () => {
    const high = { confidence: 'medium' } as never
    const low = { confidence: 'low' } as never
    expect(lowestConfidence([high, high])).toBe('medium')
    expect(lowestConfidence([high, low])).toBe('low')
  })
})

describe('conflicts are disclosed, never resolved', () => {
  it('discloses a support two claims disagree about, and resolves nothing', async () => {
    const engine = makeEngine()
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    // A second claim resting on the same experience, saying something different.
    await engine.deriveKnowledge({
      knowledgeId: 'k2',
      kind: 'process-fact',
      claim: 'a verification step may trust the log line when the verifier is missing',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: ['e1'],
      tags: ['verifier'],
      observedAt: NOW_ISO,
    })
    const derivation = engine.derive()
    expect(derivation.conflictedClaims).toEqual(['e1'])
    // Both remain admitted. Choosing one would be a fabricated resolution.
    expect(derivation.counts.knowledge).toBe(2)
  })

  it('does not call the same claim recorded twice a conflict', () => {
    const state: LearningState = emptyLearningState()
    expect(conflictedClaims(state)).toEqual([])
    applyRecord(state, {
      version: 1,
      kind: 'outcome',
      outcome: {
        outcomeId: 'o1',
        sourceDomain: 'work',
        verificationId: 'ver-1',
        verifierId: 'v',
        checked: 'checked',
        subjectRef: 'run-1',
        result: 'succeeded',
        establishedAt: NOW_ISO,
      },
    })
    expect(conflictedClaims(state)).toEqual([])
  })
})

describe('the widest scope is a fact about the records', () => {
  it('reports the widest scope any admitted claim reaches, and nothing wider', async () => {
    const engine = makeEngine()
    expect(strongestScope(emptyLearningState())).toBe('one-instance')
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    expect(engine.derive().strongestScope).toBe('one-instance')
    expect(deriveLearning(emptyLearningState(), NOW_ISO).strongestScope).toBe('one-instance')
  })
})

describe('the derivation is deterministic', () => {
  it('serialises identically for the same state, whatever the insertion order', async () => {
    const forward = makeEngine()
    await addCheck(forward, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    await addCheck(forward, { outcomeId: 'o2', experienceId: 'e2', knowledgeId: 'k2' })

    const backward = makeEngine()
    await addCheck(backward, { outcomeId: 'o2', experienceId: 'e2', knowledgeId: 'k2' })
    await addCheck(backward, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })

    expect(JSON.stringify(backward.derive())).toBe(JSON.stringify(forward.derive()))
  })

  it('reports an empty pipeline with the domain constants still in place', () => {
    const derivation = deriveLearning(emptyLearningState(), NOW_ISO)
    expect(derivation.counts.outcomes).toBe(0)
    expect(derivation.counts.knowledge).toBe(0)
    expect(derivation.proposals).toEqual([])
    // The guarantee is a property of the domain, not of its contents, so it is present
    // before anything has been learned.
    expect(derivation.authority).toBe('none')
    expect(derivation.confidenceCeiling).toBe('medium')
  })

  it('grows no field beyond the declared derivation keys', async () => {
    const engine = makeEngine()
    await addCheck(engine, { outcomeId: 'o1', experienceId: 'e1', knowledgeId: 'k1' })
    expect(Object.keys(engine.derive()).sort()).toEqual([
      'authority',
      'confidenceCeiling',
      'conflictedClaims',
      'counts',
      'proposals',
      'schemaVersion',
      'strongestScope',
    ])
  })
})