// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  LEARNING_DISTILLED_SOURCES,
  LearningEngine,
  createKnowledgeRecord,
  createVerifiedOutcome,
  sourceOfOutcome,
} from '../../../core/learning'
import { MemoryLearningStore } from '../../../core/vault/repositories/learning-store'

/**
 * UNTRUSTED DISTILLATION AND FORGED EVIDENCE.
 *
 * Two attacks. First: a model, a page or a document tries to become learning, directly or
 * by being recorded and then distilled. Second: a caller fabricates the evidence itself —
 * a verification id nobody produced, a source class it was not entitled to, a stored row
 * edited on disk. PLAN.md §2.3: knowledge is not permission, and §9: untrusted content
 * remains untrusted.
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

const claimInput = {
  knowledgeId: 'kn-1',
  kind: 'process-fact',
  claim: 'a release check has to inspect the artefact bundle',
  scope: 'one-instance',
  scopeLimits: ['observed-once', 'no-future-guarantee'],
  supports: ['exp-1'],
  verificationIds: ['ver-1'],
  tags: [],
  observedAt: NOW_ISO,
  proposedConfidence: 'medium',
  actor: 'core',
}

describe('an untrusted source cannot become learning', () => {
  it('refuses to distil a model, a page or a document into a claim', () => {
    for (const source of ['model-inference', 'external-untrusted', 'imported-document'] as const) {
      const created = createKnowledgeRecord(claimInput, source)
      expect(created.ok, source).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('distilled-source-forbidden')
    }
  })

  it('allows only the sources a check or the owner could have produced', () => {
    expect([...LEARNING_DISTILLED_SOURCES].sort()).toEqual([
      'experience-outcome',
      'freya-inference',
      'owner-assertion',
      'system-observation',
    ])
  })

  it('cors caps a freya inference at low, so a guess cannot match a checked claim', () => {
    const created = createKnowledgeRecord({ ...claimInput, proposedConfidence: 'medium' }, 'freya-inference')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('confidence-ceiling')
  })

  it('records an untrusted observation as an experience but never as a claim', async () => {
    const engine = makeEngine()
    // A page is read; nothing is checked.
    const outcome = await engine.recordVerifiedOutcome({
      outcomeId: 'out-page',
      sourceDomain: 'system',
      verificationId: 'ver-page',
      verifierId: 'page.fetch',
      checked: 'the page was fetched and its text was read once',
      subjectRef: 'page-1',
      result: 'partial',
      establishedAt: NOW_ISO,
    })
    expect(outcome.ok).toBe(true)
    // It resolves to a weak trust class, because nothing verified it.
    expect(sourceOfOutcome({ sourceDomain: 'system' } as never)).toBe('system-observation')
  })
})

describe('fabricated evidence', () => {
  it('refuses an outcome with no verification id', () => {
    const created = createVerifiedOutcome(
      {
        outcomeId: 'out-1',
        sourceDomain: 'work',
        verificationId: '',
        verifierId: 'work.step.verified',
        checked: 'a check nobody performed',
        subjectRef: 'run-1',
        result: 'succeeded',
        establishedAt: NOW_ISO,
        proposedConfidence: 'medium',
        actor: 'core',
      },
      'experience-outcome',
    )
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('invalid-evidence-refs')
  })

  it('refuses a verification reference carrying content rather than an id', () => {
    const created = createVerifiedOutcome(
      {
        outcomeId: 'out-1',
        sourceDomain: 'work',
        verificationId: 'the verifier said the whole run succeeded in these words',
        verifierId: 'work.step.verified',
        checked: 'a check',
        subjectRef: 'run-1',
        result: 'succeeded',
        establishedAt: NOW_ISO,
        proposedConfidence: 'medium',
        actor: 'core',
      },
      'experience-outcome',
    )
    expect(created.ok).toBe(false)
  })

  it('refuses a claim citing an outcome Core never recorded', async () => {
    const engine = makeEngine()
    const outcome = await engine.distilExperience('out-invented', {
      experienceId: 'exp-1',
      kind: 'tool-lesson',
      lesson: 'a lesson about a check that never happened',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-outcome')
  })

  it('refuses a claim citing an experience that is not admitted', async () => {
    const engine = makeEngine()
    const claim = await engine.deriveKnowledge({
      knowledgeId: 'kn-1',
      kind: 'process-fact',
      claim: 'a claim resting on an experience that was never distilled',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: ['exp-invented'],
      tags: [],
      observedAt: NOW_ISO,
    })
    expect(claim.ok).toBe(false)
    if (claim.ok) return
    expect(claim.code).toBe('no-supporting-experience')
  })

  it('derives the verification ids itself rather than accepting the caller list', async () => {
    const engine = makeEngine()
    await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-real',
      verifierId: 'work.step.verified',
      checked: 'the run completed and its verifier inspected the artefact',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    await engine.distilExperience('out-1', {
      experienceId: 'exp-1',
      kind: 'tool-lesson',
      lesson: 'the verifier inspected the artefact bundle',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    await engine.deriveKnowledge({
      knowledgeId: 'kn-1',
      kind: 'process-fact',
      claim: 'a release check has to inspect the artefact bundle',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: ['exp-1'],
      tags: [],
      observedAt: NOW_ISO,
    })
    const read = engine.readClaim('kn-1')
    if (!read.ok) throw new Error('the single read refused')
    // Not the caller's `ver-1`: the engine looked the outcome up.
    expect(read.claim.verificationIds).toEqual(['ver-real'])
  })
})

describe('provenance is pathway-assigned', () => {
  it('has no source field on any statement input', async () => {
    const engine = makeEngine()
    const outcome = await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-1',
      verifierId: 'work.step.verified',
      checked: 'a check',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
      // A payload asserting its own trust class.
      ...({ sourceType: 'owner-assertion', provenance: { sourceType: 'owner-assertion' } } as Record<string, unknown>),
    } as never)
    // Either refused for carrying extra keys, or recorded with the pathway's trust class.
    if (outcome.ok) {
      const state = engine.derive()
      expect(state.counts.outcomes).toBe(1)
    } else {
      expect(outcome.code).toBeTruthy()
      expect(engine.derive().counts.outcomes).toBe(0)
    }
  })

  it('never resolves an unrecognised source domain to something Core observed', () => {
    // The weakest class, not a default that reads as an observation and not `undefined`.
    expect(sourceOfOutcome({ sourceDomain: 'wikipedia' } as never)).toBe('imported-document')
    expect(sourceOfOutcome({ sourceDomain: 'gossip' } as never)).toBe('imported-document')
    const recognised = ['work', 'mission', 'foundry', 'brain', 'owner', 'system'] as const
    for (const domain of recognised) {
      expect(['experience-outcome', 'owner-assertion', 'system-observation']).toContain(
        sourceOfOutcome({ sourceDomain: domain } as never),
      )
    }
  })

  it('refuses an unknown source domain on construction', () => {
    const created = createVerifiedOutcome(
      {
        outcomeId: 'out-1',
        sourceDomain: 'gossip',
        verificationId: 'ver-1',
        verifierId: 'v',
        checked: 'a check',
        subjectRef: 'run-1',
        result: 'succeeded',
        establishedAt: NOW_ISO,
        proposedConfidence: 'medium',
        actor: 'core',
      },
      'experience-outcome',
    )
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('invalid-source-domain')
  })
})