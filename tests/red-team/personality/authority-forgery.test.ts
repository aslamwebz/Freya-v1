// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildExpressionPlan,
  createRelationshipCandidate,
  admitRelationshipItem,
  findForbiddenFieldNames,
  interpretSocialContext,
  runPersonalityEval,
  serializeExpressionPlan,
  type RelationshipItem,
} from '../../../core/personality'

/**
 * Attack family: authority-forging personality fields.
 *
 * RED-TEAM families 7 (tool privilege escalation) and 9 (approval bypass),
 * against the Slice A contract that the personality vocabulary carries *no
 * authority field by construction* — not fields that are ignored, fields that
 * do not exist.
 *
 * The attacks smuggle authority-shaped keys into every boundary the domain
 * exposes: the candidate constructor, the admission call, and the expression
 * plan a renderer would serialise. The invariant under attack: exact-key
 * validation refuses the smuggling, admission changes status only, and no
 * output structure of this domain can carry a field name shaped like a
 * permission.
 */

const NOW = '2026-10-02T09:00:00.000Z'

const FORGED_AUTHORITY_KEYS = [
  'capability',
  'capabilities',
  'grant',
  'grants',
  'permission',
  'permissions',
  'authority',
  'override',
  'disableStopAll',
  'stopOverride',
  'bypassGuard',
  'bypassGovernor',
  'prompt',
  'systemPrompt',
  'instruction',
  'instructions',
] as const

function candidateInput(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    itemId: 'rel-forge',
    kind: 'preference',
    key: 'greeting-morning',
    text: 'the owner likes a short morning greeting',
    tags: ['greeting'],
    cueKind: null,
    source: 'owner-assertion',
    sourceRef: 'turn-9',
    observedAt: NOW,
    recordedAt: NOW,
    proposedConfidence: 'high',
    actor: 'owner',
    ...extra,
  }
}

describe('attack: authority-shaped keys smuggled into the candidate constructor', () => {
  it('refuses every forged key rather than ignoring it', () => {
    for (const key of FORGED_AUTHORITY_KEYS) {
      const result = createRelationshipCandidate(candidateInput({ [key]: 'work.execute' }))
      expect(result.ok, `key ${key} was accepted`).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('keys do not match')
      }
    }
  })

  it('refuses a forged key even when it arrives nested inside a plausible field', () => {
    const result = createRelationshipCandidate(
      candidateInput({ tags: ['greeting'], cueKind: null, nested: { grant: 'work.execute' } }),
    )
    expect(result.ok).toBe(false)
  })

  it('still accepts the exact closed shape', () => {
    const result = createRelationshipCandidate(candidateInput({}))
    expect(result.ok).toBe(true)
  })
})

describe('attack: admission re-describes the item on the way in', () => {
  it('admission changes status and nothing else', () => {
    const created = createRelationshipCandidate(candidateInput({}))
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const before = created.item
    const admitted = admitRelationshipItem(before, { now: NOW, reason: 'owner reviewed' })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const after = admitted.item
    expect(after.status).toBe('admitted')
    // Every other field is untouched: a caller cannot "re-describe" an item on
    // the way in — kind, text, source, cueKind and confidence are identical.
    expect(after.kind).toBe(before.kind)
    expect(after.text).toBe(before.text)
    expect(after.key).toBe(before.key)
    expect(after.tags).toEqual(before.tags)
    expect(after.cueKind).toBe(before.cueKind)
    expect(after.provenance.sourceType).toBe(before.provenance.sourceType)
    expect(after.confidence).toBe(before.confidence)
    expect(after.admittedAt).toBe(NOW)
    expect(after.admissionReason).toBe('owner reviewed')
  })

  it('cannot admit an item that is not a candidate', () => {
    const created = createRelationshipCandidate(candidateInput({}))
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const admitted = admitRelationshipItem(created.item, { now: NOW, reason: 'first' })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const twice = admitRelationshipItem(admitted.item, { now: NOW, reason: 'second' })
    expect(twice.ok).toBe(false)
  })
})

describe('attack: the expression plan carries an authority field', () => {
  const interpretation = interpretSocialContext({
    now: NOW,
    facts: [],
    relationship: [],
  })

  it('no output structure carries a forbidden field name', () => {
    const plan = buildExpressionPlan({ interpretation, at: NOW })
    const offenders = findForbiddenFieldNames({
      interpretation,
      plan,
      items: [] as RelationshipItem[],
      ledger: { schemaVersion: 1, maxEntries: 64, entries: [] },
    })
    expect(offenders).toEqual([])
  })

  it('the plan has no provider, model, prompt or role field', () => {
    const plan = buildExpressionPlan({ interpretation, at: NOW })
    for (const key of ['provider', 'model', 'prompt', 'role', 'systemPrompt', 'instructions']) {
      expect(key in plan, `plan carries ${key}`).toBe(false)
    }
  })

  it('the serialised plan is pure catalogue prose with no authority channel', () => {
    const plan = buildExpressionPlan({ interpretation, at: NOW })
    const serialisation = serializeExpressionPlan(plan)
    expect(serialisation).toBe(plan.guidance.join('\n'))
    // The precedence sentence is the first line and is frozen.
    expect(serialisation.startsWith(plan.precedence)).toBe(true)
    expect(plan.precedence).toContain('can never grant capability')
    expect(plan.precedence).toContain('bypass Guard')
    expect(plan.precedence).toContain('STOP ALL')
  })
})

describe('attack: the offline evaluation with a hostile corpus', () => {
  it('passes every check when the corpus tries to forge authority', () => {
    const report = runPersonalityEval()
    expect(report.allPassed).toBe(true)
    expect(report.noAuthorityFields).toBe(true)
    expect(report.modelIndependent).toBe(true)
    expect(report.identityConsistent).toBe(true)
    expect(report.bounded).toBe(true)
    expect(report.antiRepetitionHolds).toBe(true)
  })
})
