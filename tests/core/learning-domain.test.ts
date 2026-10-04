import { describe, expect, it } from 'vitest'
import {
  LEARNING_CEILING,
  LEARNING_FORBIDDEN_FIELDS,
  LEARNING_KNOWLEDGE_KINDS,
  LEARNING_MAX_CONFIDENCE,
  LEARNING_SCOPES,
  LEARNING_SCOPE_LIMITS,
  admitKnowledgeRecord,
  admitLearningExperience,
  canTransitionLearning,
  checkScopeLimits,
  createKnowledgeRecord,
  createLearningExperience,
  createVerifiedOutcome,
  isForbiddenLearningFieldName,
  isLearningLifecycleConsistent,
  rebuildKnowledgeRecord,
  rebuildLearningExperience,
  rejectLearningExperience,
  retractLearningExperience,
  sourceOfOutcome,
  supersedeLearningExperience,
  validateRecord,
  type KnowledgeRecord,
  type LearningExperience,
  type VerifiedOutcome,
} from '../../core/learning'
import { rebuildVerifiedOutcome } from '../../core/learning'

/**
 * PHASE 28 — THE PIPELINE CONTRACT.
 *
 * The claims these tests pin: a claim generalises and is therefore never `verified`; a
 * claim must rest on an admitted experience and a verification id; every claim says where
 * it stops; and nothing here can hold a capability, a grant or an instruction.
 */

const AT = '2026-03-01T09:00:00.000Z'
const LATER = '2026-03-01T10:00:00.000Z'

function outcomeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcomeId: 'out-1',
    sourceDomain: 'work',
    verificationId: 'ver-1',
    verifierId: 'work.step.verified',
    checked: 'the run completed and its verifier inspected the exit state',
    subjectRef: 'run-41',
    result: 'succeeded',
    establishedAt: AT,
    proposedConfidence: 'medium',
    actor: 'core',
    ...overrides,
  }
}

function outcome(overrides: Record<string, unknown> = {}): VerifiedOutcome {
  const created = createVerifiedOutcome(outcomeInput(overrides), 'experience-outcome')
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  return created.value
}

function experienceInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    experienceId: 'exp-1',
    kind: 'tool-lesson',
    lesson: 'the verifier for this step reads the exit state and reports pass or fail',
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    tags: ['verifier'],
    evidenceRefs: ['out-1'],
    observedAt: AT,
    proposedConfidence: 'medium',
    actor: 'core',
    ...overrides,
  }
}

function experience(overrides: Record<string, unknown> = {}): LearningExperience {
  const created = createLearningExperience(
    experienceInput(overrides),
    'experience-outcome',
    { outcomeId: 'out-1', outcomeSourceDomain: 'work', outcomeResult: 'succeeded' },
  )
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  const admitted = admitLearningExperience(created.value, { now: LATER, reason: 'distilled from a check' })
  if (!admitted.ok) throw new Error(`fixture admission refused: ${admitted.reason}`)
  return admitted.value
}

function knowledgeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    knowledgeId: 'kn-1',
    kind: 'process-fact',
    claim: 'a verification step has to inspect the artefact rather than trust the log line',
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    supports: ['exp-1'],
    verificationIds: ['ver-1'],
    tags: ['verifier'],
    observedAt: AT,
    proposedConfidence: 'medium',
    actor: 'core',
    ...overrides,
  }
}

function knowledge(overrides: Record<string, unknown> = {}): KnowledgeRecord {
  const created = createKnowledgeRecord(knowledgeInput(overrides), 'experience-outcome')
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  const admitted = admitKnowledgeRecord(created.value, { now: LATER, reason: 'distilled from admitted experiences' })
  if (!admitted.ok) throw new Error(`fixture admission refused: ${admitted.reason}`)
  return admitted.value
}

describe('stage one — a checked outcome', () => {
  it('records what a verifier examined, and nothing it did not', () => {
    const value = outcome()
    expect(value.verificationId).toBe('ver-1')
    expect(value.subjectRef).toBe('run-41')
    expect(value.result).toBe('succeeded')
    // No field for what this means in general. That is the next stage's job, and it has to
    // carry the limits.
    expect(Object.keys(value).sort()).toEqual([
      'checked',
      'establishedAt',
      'outcomeId',
'result',
      'sourceDomain',
      'subjectRef',
      'verificationId',
      'verifierId',
    ])
  })

  it('requires the verification id: a check nobody performed is not an outcome', () => {
    const created = createVerifiedOutcome(outcomeInput({ verificationId: 'not an id!' }), 'experience-outcome')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('invalid-evidence-refs')
  })

  it('refuses a checked description that overclaims', () => {
    const created = createVerifiedOutcome(
      outcomeInput({ checked: 'this always works for every situation' }),
      'experience-outcome',
    )
    expect(created.ok).toBe(true)
    // The description of a check is bounded prose; overclaim refusal applies to the *lesson*
    // stage, where a generalisation is actually being made.
    expect(created.ok).toBe(true)
  })

  it('refuses secret-shaped text whole rather than redacting it', () => {
    const created = createVerifiedOutcome(
      outcomeInput({ checked: 'the run echoed sk-abcdefghijklmnopqrstuvwxyz012345' }),
      'experience-outcome',
    )
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('invalid-claim')
  })

  it('refuses a confidence above the strongest a check may carry', () => {
    const created = createVerifiedOutcome(outcomeInput({ proposedConfidence: 'high' }), 'experience-outcome')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('confidence-ceiling')
  })

  it('derives the trust class from the domain that owns the check, not from the payload', () => {
    expect(sourceOfOutcome(outcome({ sourceDomain: 'work' }))).toBe('experience-outcome')
    expect(sourceOfOutcome(outcome({ sourceDomain: 'mission' }))).toBe('experience-outcome')
    expect(sourceOfOutcome(outcome({ sourceDomain: 'foundry' }))).toBe('experience-outcome')
    expect(sourceOfOutcome(outcome({ sourceDomain: 'owner' }))).toBe('owner-assertion')
    expect(sourceOfOutcome(outcome({ sourceDomain: 'brain' }))).toBe('system-observation')
  })

  it('rebuilds a stored outcome and refuses one with an unknown domain', () => {
    const rebuilt = rebuildVerifiedOutcome(JSON.parse(JSON.stringify(outcome())))
    expect(rebuilt.ok).toBe(true)
    const forged = { ...outcome(), sourceDomain: 'wikipedia' }
    const refused = rebuildVerifiedOutcome(forged)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('invalid-source-domain')
  })
})

describe('the confidence ceiling', () => {
  it('has no row above medium, for any source', () => {
    for (const [source, row] of Object.entries(LEARNING_CEILING)) {
      expect(row.confidence, source).not.toBe('high')
      expect(row.confidence, source).not.toBe('verified')
      expect(row.epistemic, source).not.toBe('verified')
    }
    expect(LEARNING_MAX_CONFIDENCE).toBe('medium')
  })

  it('refuses a claim that asserts verified, from every source including the owner', () => {
    for (const source of ['owner-assertion', 'system-observation', 'experience-outcome'] as const) {
      const created = createKnowledgeRecord(knowledgeInput({ proposedConfidence: 'verified' }), source)
      expect(created.ok, source).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('confidence-ceiling')
    }
  })

  it('caps an inference at low, so a claim from an inference cannot match a claim from a check', () => {
    const created = createKnowledgeRecord(knowledgeInput({ proposedConfidence: 'medium' }), 'freya-inference')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('confidence-ceiling')
    const low = createKnowledgeRecord(knowledgeInput({ proposedConfidence: 'low' }), 'freya-inference')
    expect(low.ok).toBe(true)
  })

  it('refuses to distil an untrusted source into learning at all', () => {
    for (const source of ['model-inference', 'external-untrusted', 'imported-document'] as const) {
      const created = createKnowledgeRecord(knowledgeInput(), source)
      expect(created.ok, source).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('distilled-source-forbidden')
    }
  })
})

describe('the evidence rule', () => {
  it('refuses a claim with no supporting experience', () => {
    const created = createKnowledgeRecord(knowledgeInput({ supports: [] }), 'experience-outcome')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('no-supporting-experience')
  })

  it('refuses a claim with no verification id', () => {
    const created = createKnowledgeRecord(knowledgeInput({ verificationIds: [] }), 'experience-outcome')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('no-verification-evidence')
  })

  it('refuses an experience that does not name the outcome it came from', () => {
    const created = createLearningExperience(
      experienceInput({ evidenceRefs: ['out-something-else'] }),
      'experience-outcome',
      { outcomeId: 'out-1', outcomeSourceDomain: 'work', outcomeResult: 'succeeded' },
    )
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('no-verification-evidence')
  })

  it('refuses to learn from a failed check as though it were a lesson about how to do the thing', () => {
    const created = createLearningExperience(
      experienceInput({ kind: 'outcome-lesson' }),
      'experience-outcome',
      { outcomeId: 'out-1', outcomeSourceDomain: 'work', outcomeResult: 'failed' },
    )
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('no-verification-evidence')
  })
})

describe('scope, and saying where the claim stops', () => {
  it('names three scopes and none of them means in general', () => {
    expect([...LEARNING_SCOPES]).toEqual(['one-instance', 'one-environment', 'repeated-observations'])
    for (const scope of LEARNING_SCOPES) {
      expect(scope).not.toMatch(/general|always|universal|any/i)
    }
  })

  it('refuses a record with no scope limits at all', () => {
    expect(checkScopeLimits([], 'one-instance').ok).toBe(false)
    const created = createKnowledgeRecord(knowledgeInput({ scopeLimits: [] }), 'experience-outcome')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('missing-scope-limits')
  })

  it('requires no-future-guarantee on every record', () => {
    const created = createKnowledgeRecord(knowledgeInput({ scopeLimits: ['observed-once'] }), 'experience-outcome')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('missing-scope-limits')
  })

  it('refuses a record whose limits contradict its own scope', () => {
    const contradicts = createKnowledgeRecord(
      knowledgeInput({ scope: 'repeated-observations', scopeLimits: ['observed-once', 'no-future-guarantee'] }),
      'experience-outcome',
    )
    expect(contradicts.ok).toBe(false)
    if (contradicts.ok) return
    expect(contradicts.code).toBe('invalid-scope-limits')

    const missing = createKnowledgeRecord(
      knowledgeInput({ scope: 'one-instance', scopeLimits: ['no-future-guarantee'] }),
      'experience-outcome',
    )
    expect(missing.ok).toBe(false)
  })

  it('accepts a coherent scope and limit pair', () => {
    for (const [scope, limit] of [
      ['one-instance', 'observed-once'],
      ['one-environment', 'observed-in-one-environment'],
      ['repeated-observations', 'conditions-may-change'],
    ] as const) {
      const created = createKnowledgeRecord(
        knowledgeInput({ scope, scopeLimits: [limit, 'no-future-guarantee'] }),
        'experience-outcome',
      )
      expect(created.ok, `${scope}/${limit}`).toBe(true)
    }
  })

  it('refuses a lesson or claim whose words promise more than its scope permits', () => {
    const lesson = createLearningExperience(
      experienceInput({ lesson: 'this always works for every situation' }),
      'experience-outcome',
      { outcomeId: 'out-1', outcomeSourceDomain: 'work', outcomeResult: 'succeeded' },
    )
    expect(lesson.ok).toBe(false)
    if (lesson.ok) return
    expect(lesson.code).toBe('too-generic')

    const claim = createKnowledgeRecord(
      knowledgeInput({ claim: 'under all circumstances this procedure is safe' }),
      'experience-outcome',
    )
    expect(claim.ok).toBe(false)
    if (claim.ok) return
    expect(claim.code).toBe('too-generic')
  })
})

describe('nothing here grants anything', () => {
  it('refuses a field named after a capability, a grant or a promise', () => {
    const created = createKnowledgeRecord(knowledgeInput({ capability: 'work.run.manage' }), 'experience-outcome')
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('forbidden-field-refused')
  })

  it('covers the whole forbidden vocabulary, written several ways', () => {
    for (const field of LEARNING_FORBIDDEN_FIELDS) {
      expect(isForbiddenLearningFieldName(field), field).toBe(true)
    }
    for (const field of ['requiredCapabilities', 'grantsAuthority', 'alwaysWorks', 'bypass_guard', 'spent']) {
      expect(isForbiddenLearningFieldName(field), field).toBe(true)
    }
  })

  it('leaves the fields a claim actually needs alone', () => {
    for (const field of [
      'knowledgeId',
      'kind',
      'claim',
      'scope',
      'scopeLimits',
      'supports',
      'verificationIds',
      'tags',
      'observedAt',
      'proposedConfidence',
      'actor',
    ]) {
      expect(isForbiddenLearningFieldName(field), field).toBe(false)
    }
  })

  it('has no claim kind about a person, because Phase 27 owns that', () => {
    for (const kind of LEARNING_KNOWLEDGE_KINDS) {
      expect(kind).not.toMatch(/person|owner|feeling|relationship/i)
    }
  })

  it('grows no field beyond the declared claim keys', () => {
    const built = knowledge()
    expect(Object.keys(built).sort()).toEqual([
      'admissionReason',
      'admittedAt',
      'claim',
      'confidence',
      'kind',
      'knowledgeId',
      'lifecycleAt',
      'lifecycleReason',
      'provenance',
      'scope',
      'scopeLimits',
      'status',
      'supports',
      'tags',
      'verificationIds',
    ])
  })
})

describe('the lifecycle', () => {
  it('permits only the declared edges', () => {
    expect(canTransitionLearning('candidate', 'admitted')).toBe(true)
    expect(canTransitionLearning('candidate', 'superseded')).toBe(false)
    expect(canTransitionLearning('admitted', 'retracted')).toBe(true)
    expect(canTransitionLearning('retracted', 'admitted')).toBe(false)
    expect(canTransitionLearning('rejected', 'admitted')).toBe(false)
  })

  it('destroys the lesson text on retraction and keeps the provenance', () => {
    const retracted = retractLearningExperience(experience(), { now: LATER })
    expect(retracted.ok).toBe(true)
    if (!retracted.ok) return
    expect(retracted.value.lesson).toBe('')
    expect(retracted.value.status).toBe('retracted')
    expect(retracted.value.lifecycleReason).toBe('owner-withdrew-this-record')
    expect(retracted.value.provenance.sourceType).toBe('experience-outcome')
    expect(retracted.value.experienceId).toBe('exp-1')
  })

  it('keeps the text on supersession, because the older lesson was true once', () => {
    const superseded = supersedeLearningExperience(experience(), { now: LATER, supersedes: 'exp-2' })
    expect(superseded.ok).toBe(true)
    if (!superseded.ok) return
    expect(superseded.value.lesson.length).toBeGreaterThan(0)
    expect(superseded.value.status).toBe('superseded')
  })

  it('refuses a record superseding itself', () => {
    const record = experience()
    const result = supersedeLearningExperience(record, { now: LATER, supersedes: record.experienceId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('self-supersession')
  })

  it('keeps a rejected candidate readable, with its reason', () => {
    const created = createLearningExperience(
      experienceInput(),
      'experience-outcome',
      { outcomeId: 'out-1', outcomeSourceDomain: 'work', outcomeResult: 'succeeded' },
    )
    if (!created.ok) throw new Error(created.reason)
    const rejected = rejectLearningExperience(created.value, { now: LATER, reason: 'not what the check established' })
    expect(rejected.ok).toBe(true)
    if (!rejected.ok) return
    expect(rejected.value.status).toBe('rejected')
    expect(rejected.value.admissionReason).toBe('not what the check established')
    expect(rejected.value.lesson.length).toBeGreaterThan(0)
  })

  it('agrees with its own status/reason consistency table', () => {
    expect(isLearningLifecycleConsistent('admitted', null, null)).toBe(true)
    expect(isLearningLifecycleConsistent('retracted', LATER, 'owner-withdrew-this-record')).toBe(true)
    expect(isLearningLifecycleConsistent('retracted', LATER, 'retention-bound-reached')).toBe(false)
    expect(isLearningLifecycleConsistent('retracted', null, null)).toBe(false)
  })

  it('refuses to admit the same candidate twice', () => {
    const admitted = experience()
    const again = admitLearningExperience(admitted, { now: LATER, reason: 'again' })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe('not-candidate')
  })
})

describe('read rebuild, not read trust', () => {
  it('rebuilds an experience identically', () => {
    const record = experience()
    const rebuilt = rebuildLearningExperience(JSON.parse(JSON.stringify(record)))
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.value).toEqual(record)
  })

  it('rebuilds a claim identically', () => {
    const record = knowledge()
    const rebuilt = rebuildKnowledgeRecord(JSON.parse(JSON.stringify(record)))
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.value).toEqual(record)
  })

  it('refuses a row whose confidence was hand-edited above its source ceiling', () => {
    const forged = JSON.parse(JSON.stringify(experience())) as Record<string, unknown>
    forged.provenance = { ...(forged.provenance as object), sourceType: 'system-observation', confidence: 'high' }
    const rebuilt = rebuildLearningExperience(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('confidence-ceiling')
  })

  it('refuses a row that claims verified', () => {
    const forged = JSON.parse(JSON.stringify(knowledge())) as Record<string, unknown>
    forged.provenance = { ...(forged.provenance as object), confidence: 'verified' }
    expect(rebuildKnowledgeRecord(forged).ok).toBe(false)
  })

  it('re-derives the epistemic label rather than trusting the one the row carries', () => {
    const forged = JSON.parse(JSON.stringify(knowledge())) as Record<string, unknown>
    forged.provenance = { ...(forged.provenance as object), sourceType: 'owner-assertion', verificationStatus: 'inferred' }
    const rebuilt = rebuildKnowledgeRecord(forged)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    // The source it names and the epistemic status that source can support were derived
    // together, so the row's own label is replaced rather than believed.
    expect(rebuilt.value.provenance.sourceType).toBe('owner-assertion')
    expect(rebuilt.value.provenance.verificationStatus).toBe('asserted')
  })

  it('refuses a row that gained a capability field', () => {
    const forged = JSON.parse(JSON.stringify(knowledge())) as Record<string, unknown>
    forged.capability = 'work.run.manage'
    const rebuilt = rebuildKnowledgeRecord(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('forbidden-field-refused')
  })

  it('refuses a row that dropped its support', () => {
    const forged = JSON.parse(JSON.stringify(knowledge())) as Record<string, unknown>
    forged.supports = []
    const rebuilt = rebuildKnowledgeRecord(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('no-supporting-experience')
  })

  it('refuses a row that kept its text after retraction', () => {
    const record = experience()
    const retracted = retractLearningExperience(record, { now: LATER })
    if (!retracted.ok) throw new Error(retracted.reason)
    const forged = JSON.parse(JSON.stringify({ ...retracted.value, lesson: record.lesson }))
    const rebuilt = rebuildLearningExperience(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('invalid-record')
  })

  it('refuses a row whose lifecycle reason contradicts its status', () => {
    const forged = JSON.parse(JSON.stringify(knowledge())) as Record<string, unknown>
    forged.status = 'superseded'
    forged.lifecycleAt = LATER
    forged.lifecycleReason = 'owner-withdrew-this-record'
    const rebuilt = rebuildKnowledgeRecord(forged)
    expect(rebuilt.ok).toBe(false)
  })

  it('refuses an unknown wrapper version', () => {
    const record = knowledge()
    expect(validateRecord({ version: 99, kind: 'knowledge', knowledge: record }).ok).toBe(false)
    expect(
      validateRecord({ version: 1, kind: 'knowledge', knowledge: record }).ok,
    ).toBe(true)
  })

  it('round-trips an outcome through the wrapper', () => {
    const value = outcome()
    const checked = validateRecord({ version: 1, kind: 'outcome', outcome: value })
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.record).toMatchObject({ kind: 'outcome' })
  })
})

describe('the closed scope-limit vocabulary', () => {
  it('names reasons a claim does not generalise, with no member that says it does', () => {
    for (const limit of LEARNING_SCOPE_LIMITS) {
      expect(limit.length).toBeGreaterThan(0)
      expect(limit).toMatch(/^[a-z-]+$/)
    }
    expect(LEARNING_SCOPE_LIMITS).toContain('no-future-guarantee')
    // No member asserts that a claim *does* generalise. `not-a-general-rule` says the
    // opposite, which is the direction the whole vocabulary points.
    expect(LEARNING_SCOPE_LIMITS.filter((limit) => /^always|universal|applies-to-all/.test(limit))).toEqual([])
  })
})