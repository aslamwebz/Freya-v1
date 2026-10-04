// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  LEARNING_OVERCLAIM_MARKERS,
  LEARNING_SCOPES,
  LEARNING_SCOPE_LIMITS,
  LearningEngine,
  checkScopeLimits,
  decideSupport,
  findOverclaimMarkers,
  lowestConfidence,
} from '../../../core/learning'
import { MemoryLearningStore } from '../../../core/vault/repositories/learning-store'

/**
 * OVERGENERALISATION.
 *
 * The failure this phase is most likely to produce by accident: one check passes, Freya
 * concludes a rule, and the rule is now true for her. Every test here is an attempt to get
 * from one checked outcome to a general belief, and every one has to stop.
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

async function check(engine: LearningEngine, suffix: string, result: 'succeeded' | 'failed' | 'partial' = 'succeeded'): Promise<string> {
  await engine.recordVerifiedOutcome({
    outcomeId: `out-${suffix}`,
    sourceDomain: 'work',
    verificationId: `ver-${suffix}`,
    verifierId: 'work.step.verified',
    checked: 'the run completed and its verifier inspected the artefact',
    subjectRef: `run-${suffix}`,
    result,
    establishedAt: NOW_ISO,
  })
  await engine.distilExperience(`out-${suffix}`, {
    experienceId: `exp-${suffix}`,
    kind: result === 'failed' ? 'failure-lesson' : 'tool-lesson',
    lesson: `the verifier for run ${suffix} inspected the artefact and reported ${result}`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    observedAt: NOW_ISO,
  })
  return `exp-${suffix}`
}

describe('there is no scope that means in general', () => {
  it('names three scopes and none of them is generality', () => {
    expect([...LEARNING_SCOPES]).toEqual(['one-instance', 'one-environment', 'repeated-observations'])
    expect(LEARNING_SCOPES.some((scope) => /general|always|universal|any|every/i.test(scope))).toBe(false)
  })

  it('cannot be widened without adding a scope by name', () => {
    // The refusal that makes it a vocabulary rather than a string.
    const created = checkScopeLimits(['observed-once', 'no-future-guarantee'], 'applies-everywhere' as never)
    expect(created.ok).toBe(false)
  })
})

describe('every claim must say where it stops', () => {
  it('refuses a record with an empty limit set', () => {
    expect(checkScopeLimits([], 'one-instance').ok).toBe(false)
  })

  it('refuses a record that omits no-future-guarantee', () => {
    const checked = checkScopeLimits(['observed-once'], 'one-instance')
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.code).toBe('missing-scope-limits')
  })

  it('refuses a record whose limits contradict its own scope', () => {
    const contradicted = checkScopeLimits(
      ['observed-once', 'no-future-guarantee'],
      'repeated-observations',
    )
    expect(contradicted.ok).toBe(false)
    if (contradicted.ok) return
    expect(contradicted.code).toBe('invalid-scope-limits')
  })

  it('refuses a lesson that promises, in the words the phase forbids', async () => {
    const engine = makeEngine()
    await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-1',
      verifierId: 'work.step.verified',
      checked: 'the run completed and its verifier inspected the artefact',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    for (const lesson of [
      'this always works',
      'this never fails',
      'under all circumstances this is safe',
      'in general a verifier reads the result',
      'from now on the release check passes',
    ]) {
      const outcome = await engine.distilExperience('out-1', {
        experienceId: 'exp-1',
        kind: 'tool-lesson',
        lesson,
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        observedAt: NOW_ISO,
      })
      expect(outcome.ok, lesson).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('too-generic')
    }
  })

  it('reports the overclaim markers it found, so a refusal is reviewable', () => {
    expect(findOverclaimMarkers('this always works, and never fails')).toEqual(['always', 'never'])
    expect(findOverclaimMarkers('the verifier read the artefact bundle')).toEqual([])
    expect(LEARNING_OVERCLAIM_MARKERS.length).toBeGreaterThan(8)
  })

  it('carries the limits onto the claim and onto the proposal', async () => {
    const engine = makeEngine()
    const first = await check(engine, 'a')
    const second = await check(engine, 'b')
    await engine.deriveKnowledge({
      knowledgeId: 'kn-a',
      kind: 'process-fact',
      claim: 'a release check has to inspect the artefact bundle rather than trust the log',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: [first, second],
      tags: ['release'],
      observedAt: NOW_ISO,
    })
    const claim = engine.readClaim('kn-a')
    if (!claim.ok) throw new Error('the single read refused')
    expect(claim.claim.scopeLimits).toContain('no-future-guarantee')
    expect(claim.claim.scopeLimits).toContain('observed-once')

    const proposal = engine.proposals()[0]!
    expect(proposal.scope).toBe('one-instance')
    expect(proposal.scopeLimits).toContain('no-future-guarantee')
    // And the proposal crosses the projection carrying them.
    const view = engine.project().proposals[0]!
    expect(view.scopeLimits).toContain('no-future-guarantee')
  })
})

describe('one check is never enough', () => {
  it('is below threshold on a single check, however emphatic the claim tried to be', async () => {
    const engine = makeEngine()
    const only = await check(engine, 'a')
    const emphatic = await engine.deriveKnowledge({
      knowledgeId: 'kn-a',
      kind: 'process-fact',
      claim: 'the verifier definitely always inspects the artefact bundle in every situation',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: [only],
      tags: ['release'],
      observedAt: NOW_ISO,
    })
    // Even a claim this emphatic is refused for overclaiming before it is stored, so the
    // strongest thing a caller can do is a bounded claim — which is the point.
    expect(emphatic.ok).toBe(false)
    if (emphatic.ok) return
    expect(emphatic.code).toBe('too-generic')

    // And the strongest claim that *can* be stored from one check still proposes nothing.
    const bounded = await engine.deriveKnowledge({
      knowledgeId: 'kn-b',
      kind: 'process-fact',
      claim: 'the verifier inspected the artefact bundle on run a',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: [only],
      tags: ['release'],
      observedAt: NOW_ISO,
    })
    expect(bounded.ok).toBe(true)
    const proposal = engine.proposals()[0]!
    expect(proposal.support.aboveThreshold).toBe(false)
    expect(proposal.support.reason).toBe('too-few-experiences')
  })

  it('does not count repeats of the same check as separate evidence', async () => {
    const engine = makeEngine()
    // One outcome, two lessons distilled from it, one claim citing both.
    await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-1',
      verifierId: 'work.step.verified',
      checked: 'the run completed and its verifier inspected the artefact',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    await engine.distilExperience('out-1', {
      experienceId: 'exp-a',
      kind: 'tool-lesson',
      lesson: 'the verifier inspected the artefact on the first pass',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    await engine.distilExperience('out-1', {
      experienceId: 'exp-b',
      kind: 'tool-lesson',
      lesson: 'the verifier inspected the artefact on the second pass of the same run',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    await engine.deriveKnowledge({
      knowledgeId: 'kn-a',
      kind: 'process-fact',
      claim: 'a verification step has to inspect the result rather than trust the log',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: ['exp-a', 'exp-b'],
      tags: ['release'],
      observedAt: NOW_ISO,
    })
    const proposal = engine.proposals()[0]!
    expect(proposal.support.distinctExperiences).toBe(2)
    expect(proposal.support.distinctVerifications).toBe(1)
    expect(proposal.support.aboveThreshold).toBe(false)
    expect(proposal.support.reason).toBe('too-few-verifications')
  })

  it('is below threshold when a supporting check failed', () => {
    const decided = decideSupport({
      distinctVerifications: 4,
      distinctExperiences: 4,
      failedOutcomes: 1,
      staleVerifications: 0,
      experiences: [],
      verificationIds: [],
    })
    expect(decided.aboveThreshold).toBe(false)
    expect(decided.reason).toBe('failed-outcomes-present')
  })

  it('is below threshold when the evidence has aged out', () => {
    const decided = decideSupport({
      distinctVerifications: 3,
      distinctExperiences: 3,
      failedOutcomes: 0,
      staleVerifications: 3,
      experiences: [],
      verificationIds: [],
    })
    expect(decided.aboveThreshold).toBe(false)
    expect(decided.reason).toBe('evidence-stale')
  })
})

describe('a claim generalises, so it is never verified', () => {
  it('reports the ceiling as medium however much has been established', async () => {
    const engine = makeEngine()
    await check(engine, 'a')
    await check(engine, 'b')
    const derivation = engine.derive()
    expect(derivation.confidenceCeiling).toBe('medium')
    expect(engine.project().confidenceCeiling).toBe('medium')
  })

  it('gives the weakest confidence to a proposal whose parts disagree', () => {
    // The arithmetic form of "let one well-attested claim speak for several": a proposal is
    // never more certain than its least certain part.
    expect(lowestConfidence([{ confidence: 'medium' }, { confidence: 'medium' }] as never)).toBe('medium')
    expect(lowestConfidence([{ confidence: 'medium' }, { confidence: 'low' }] as never)).toBe('low')
  })
})

describe('the scope-limit vocabulary cannot be used to smuggle a promise', () => {
  it('has no member that asserts generality', () => {
    for (const limit of LEARNING_SCOPE_LIMITS) {
      expect(limit, limit).toMatch(/^[a-z-]+$/)
    }
    expect(LEARNING_SCOPE_LIMITS.filter((limit) => /^always|applies-to-all|universal/.test(limit))).toEqual([])
  })
})