import { describe, expect, it } from 'vitest'
import {
  ENTRY_INPUT_KEYS,
  ENTRY_KEYS,
  INTIMACY_FIELD_NAMES,
  OWNER_ONLY_LEDGER_KINDS,
  OWNER_ONLY_SOURCES,
  RELATIONSHIP_CEILING,
  RELATIONSHIP_LIMITS,
  RELATIONSHIP_MAX_CONFIDENCE,
  admitRelationshipEntry,
  applyEntry,
  canTransitionLedger,
  createRelationshipLedgerEntry,
  emptyRelationshipState,
  expireRelationshipEntry,
  isLedgerLifecycleConsistent,
  rebuildRelationshipEntry,
  rejectRelationshipEntry,
  retractRelationshipEntry,
  supersedeRelationshipEntry,
  validateRecord,
  type RelationshipLedgerEntry,
} from '../../core/relationship'

/**
 * PHASE 27 — RELATIONSHIP LEDGER CONTRACT.
 *
 * Pins the shape rules that make "relationship cannot fabricate intimacy or identity
 * facts" a property of the code: exact keys, refused intimacy fields, a ceiling with no
 * `verified` row, owner-only kinds, and an evidence rule.
 *
 * Deterministic throughout: fixed instants, no clock, no randomness, no model.
 */

const AT = '2026-01-05T09:00:00.000Z'
const LATER = '2026-01-05T10:00:00.000Z'

function candidateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryId: 'rel-1',
    kind: 'interaction-pattern',
    key: 'starts-with-a-question',
    text: 'the owner opens most sessions with a question',
    tags: ['sessions'],
    evidenceRefs: ['event-1', 'event-2'],
    observedAt: AT,
    recordedAt: AT,
    proposedConfidence: 'medium',
    actor: 'core',
    ...overrides,
  }
}

function admitted(overrides: Record<string, unknown> = {}, source: 'owner-assertion' | 'system-observation' = 'system-observation'): RelationshipLedgerEntry {
  const created = createRelationshipLedgerEntry(candidateInput(overrides), source)
  if (!created.ok) throw new Error(`fixture refused: ${created.reason}`)
  const admission = admitRelationshipEntry(created.entry, { now: LATER, reason: 'recorded by a trusted pathway' })
  if (!admission.ok) throw new Error(`fixture admission refused: ${admission.reason}`)
  return admission.entry
}

describe('relationship ledger construction', () => {
  it('accepts a well-formed candidate and assigns provenance from the pathway', () => {
    const created = createRelationshipLedgerEntry(candidateInput(), 'system-observation')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.entry.provenance.sourceType).toBe('system-observation')
    expect(created.entry.status).toBe('candidate')
    // The candidate input has no `source` field, which is the anti-poisoning hinge.
    expect(ENTRY_INPUT_KEYS).not.toContain('source')
  })

  it('refuses extra keys rather than ignoring them', () => {
    const result = createRelationshipLedgerEntry(candidateInput({ extra: 'value' }), 'system-observation')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('key-set-mismatch')
  })

  it('refuses every intimacy-shaped field in the vocabulary', () => {
    for (const field of INTIMACY_FIELD_NAMES) {
      const result = createRelationshipLedgerEntry(
        candidateInput({ [field.toLowerCase()]: 'anything' }),
        'system-observation',
      )
      expect(result.ok, `field ${field} should be refused`).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('intimacy-field-refused')
    }
  })

  it('refuses an intimacy field nested one level down', () => {
    const result = createRelationshipLedgerEntry(
      candidateInput({ meta: { feelings: ['lonely'] } }),
      'system-observation',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('intimacy-field-refused')
  })

  it('has no kind for an interior state, a feeling or a bond', () => {
    const kinds = [
      'affection',
      'bond',
      'attachment',
      'intimacy',
      'love',
      'mood',
      'feeling',
      'misses',
      'loyalty',
      'dependence',
      'closeness',
    ]
    for (const kind of kinds) {
      const result = createRelationshipLedgerEntry(candidateInput({ kind }), 'system-observation')
      expect(result.ok, `kind ${kind} should not exist`).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('invalid-kind')
    }
  })

  it('refuses secret-shaped text whole rather than redacting it', () => {
    const result = createRelationshipLedgerEntry(
      candidateInput({ text: 'the owner token is sk-abcdefghijklmnopqrstuvwxyz012345' }),
      'system-observation',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('secret-shaped-text-refused')
  })

  it('refuses an unknown source class', () => {
    const result = createRelationshipLedgerEntry(candidateInput(), 'the-owner-really' as never)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid-source')
  })
})

describe('the confidence ceiling', () => {
  it('has no row that yields verified, for any source', () => {
    for (const row of Object.values(RELATIONSHIP_CEILING)) {
      expect(row.confidence).not.toBe('verified')
      expect(row.epistemic).not.toBe('verified')
    }
    expect(Object.values(RELATIONSHIP_CEILING).map((r) => r.confidence)).not.toContain(
      RELATIONSHIP_MAX_CONFIDENCE === 'verified' ? 'low' : 'verified',
    )
  })

  it('refuses verified from the strongest source rather than capping it down', () => {
    const result = createRelationshipLedgerEntry(
      candidateInput({ proposedConfidence: 'verified' }),
      'owner-assertion',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('confidence-ceiling')
  })

  it('caps a model assertion at low', () => {
    const result = createRelationshipLedgerEntry(
      candidateInput({ proposedConfidence: 'high' }),
      'model-inference',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('confidence-ceiling')
  })
})

describe('owner-only kinds', () => {
  it('names exactly the four kinds a person alone can establish', () => {
    expect([...OWNER_ONLY_LEDGER_KINDS]).toEqual([
      'expressed-preference',
      'shared-history',
      'correction',
      'boundary-stated',
    ])
  })

  it('refuses an owner-only kind from a model, a page, a document or inference', () => {
    const untrusted = ['model-inference', 'external-untrusted', 'imported-document', 'freya-inference'] as const
    for (const kind of OWNER_ONLY_LEDGER_KINDS) {
      for (const source of untrusted) {
        const result = createRelationshipLedgerEntry(
          candidateInput({
            kind,
            key: 'boundary-recorded-history',
            text: 'a recorded thing happened once',
            evidenceRefs: ['event-1'],
          }),
          source,
        )
        expect(result.ok, `${kind} from ${source} should be refused`).toBe(false)
        if (result.ok) continue
        expect(result.code).toBe('owner-only-kind')
      }
    }
  })

  it('accepts an owner-only kind from the owner and from a system observation', () => {
    for (const source of OWNER_ONLY_SOURCES) {
      const result = createRelationshipLedgerEntry(
        candidateInput({
          kind: 'boundary-stated',
          key: 'boundary-recorded-history',
          text: 'no work after nine in the evening',
          evidenceRefs: ['turn-7'],
        }),
        source,
      )
      expect(result.ok, `${source} should be allowed`).toBe(true)
    }
  })
})

describe('the evidence rule', () => {
  it('treats the owner as the evidence', () => {
    const result = createRelationshipLedgerEntry(
      candidateInput({ kind: 'expressed-preference', key: 'likes-short-answers', evidenceRefs: [] }),
      'owner-assertion',
    )
    expect(result.ok).toBe(true)
  })

  it('refuses a non-owner record with no evidence rather than storing it at lower confidence', () => {
    const result = createRelationshipLedgerEntry(candidateInput({ evidenceRefs: [] }), 'system-observation')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('no-evidence')
  })

  it('refuses evidence refs that are not bounded opaque ids', () => {
    const result = createRelationshipLedgerEntry(
      candidateInput({ evidenceRefs: ['a'.repeat(RELATIONSHIP_LIMITS.maxRefChars + 1)] }),
      'system-observation',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid-evidence-refs')
  })
})

describe('the lifecycle', () => {
  it('permits only the declared edges', () => {
    expect(canTransitionLedger('candidate', 'admitted')).toBe(true)
    expect(canTransitionLedger('candidate', 'retracted')).toBe(false)
    expect(canTransitionLedger('admitted', 'superseded')).toBe(true)
    expect(canTransitionLedger('retracted', 'admitted')).toBe(false)
    expect(canTransitionLedger('expired', 'admitted')).toBe(false)
    expect(canTransitionLedger('rejected', 'admitted')).toBe(false)
  })

  it('admits only a candidate', () => {
    const entry = admitted()
    const again = admitRelationshipEntry(entry, { now: LATER, reason: 'again' })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe('not-candidate')
  })

  it('destroys the text on retraction and keeps the provenance', () => {
    const entry = admitted()
    const result = retractRelationshipEntry(entry, { now: LATER })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.text).toBe('')
    expect(result.entry.status).toBe('retracted')
    expect(result.entry.lifecycleReason).toBe('owner-withdrew-this-record')
    expect(result.entry.provenance.sourceType).toBe('system-observation')
    expect(result.entry.entryId).toBe(entry.entryId)
  })

  it('keeps the text on supersession, because the older record was true once', () => {
    const entry = admitted()
    const result = supersedeRelationshipEntry(entry, { now: LATER, supersedes: 'rel-2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.text).toBe(entry.text)
    expect(result.entry.status).toBe('superseded')
  })

  it('refuses a record superseding itself', () => {
    const entry = admitted()
    const result = supersedeRelationshipEntry(entry, { now: LATER, supersedes: entry.entryId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('self-supersession')
  })

  it('keeps a rejected candidate readable, with its reason', () => {
    const created = createRelationshipLedgerEntry(candidateInput(), 'system-observation')
    if (!created.ok) throw new Error(created.reason)
    const result = rejectRelationshipEntry(created.entry, { now: LATER, reason: 'not what the owner meant' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.status).toBe('rejected')
    expect(result.entry.admissionReason).toBe('not what the owner meant')
    expect(result.entry.text.length).toBeGreaterThan(0)
  })

  it('refuses an expiry reason that belongs to a different transition', () => {
    const entry = admitted()
    const result = expireRelationshipEntry(entry, { now: LATER, reason: 'owner-withdrew-this-record' as never })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('illegal-lifecycle-reason')
  })

  it('agrees with its own status/reason consistency table', () => {
    expect(isLedgerLifecycleConsistent('admitted', null, null)).toBe(true)
    expect(isLedgerLifecycleConsistent('admitted', LATER, 'owner-withdrew-this-record')).toBe(false)
    expect(isLedgerLifecycleConsistent('retracted', LATER, 'owner-withdrew-this-record')).toBe(true)
    expect(isLedgerLifecycleConsistent('retracted', null, null)).toBe(false)
    expect(isLedgerLifecycleConsistent('expired', LATER, 'stale-record-expired')).toBe(true)
  })
})

describe('the fold', () => {
  it('rebuilds a stored entry identically', () => {
    const entry = admitted()
    const rebuilt = rebuildRelationshipEntry(JSON.parse(JSON.stringify(entry)))
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.entry).toEqual(entry)
  })

  it('round-trips a retracted entry, which has no text left', () => {
    const retracted = retractRelationshipEntry(admitted(), { now: LATER })
    if (!retracted.ok) throw new Error(retracted.reason)
    const rebuilt = rebuildRelationshipEntry(JSON.parse(JSON.stringify(retracted.entry)))
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.entry.text).toBe('')
    expect(rebuilt.entry.status).toBe('retracted')
  })

  it('refuses a stored row whose confidence was hand-edited above its source ceiling', () => {
    const entry = JSON.parse(JSON.stringify(admitted())) as Record<string, unknown>
    entry.confidence = 'high'
    entry.provenance = { ...(entry.provenance as object), sourceType: 'model-inference' }
    const rebuilt = rebuildRelationshipEntry(entry)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('confidence-ceiling')
  })

  it('refuses a stored row that claims verified', () => {
    const entry = JSON.parse(JSON.stringify(admitted())) as Record<string, unknown>
    entry.confidence = 'verified'
    const rebuilt = rebuildRelationshipEntry(entry)
    expect(rebuilt.ok).toBe(false)
  })

  it('refuses a stored row that kept its text after retraction', () => {
    const entry = JSON.parse(JSON.stringify(admitted())) as Record<string, unknown>
    entry.status = 'retracted'
    entry.lifecycleAt = LATER
    entry.lifecycleReason = 'owner-withdrew-this-record'
    const rebuilt = rebuildRelationshipEntry(entry)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('invalid-record')
  })

  it('refuses a stored row whose lifecycle reason contradicts its status', () => {
    const entry = JSON.parse(JSON.stringify(admitted())) as Record<string, unknown>
    entry.status = 'superseded'
    entry.lifecycleAt = LATER
    entry.lifecycleReason = 'owner-withdrew-this-record'
    const rebuilt = rebuildRelationshipEntry(entry)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('invalid-record')
  })

  it('refuses an unknown wrapper version', () => {
    const entry = admitted()
    const checked = validateRecord({ version: 99, entry })
    expect(checked.ok).toBe(false)
  })

  it('is idempotent per entry id', () => {
    const state = emptyRelationshipState()
    const entry = admitted()
    applyEntry(state, entry)
    applyEntry(state, entry)
    expect(state.entries.size).toBe(1)
    expect(state.sequence).toBe(2)
  })

  it('grows no field beyond the declared entry keys', () => {
    expect(Object.keys(admitted()).sort()).toEqual([...ENTRY_KEYS].sort())
  })
})
