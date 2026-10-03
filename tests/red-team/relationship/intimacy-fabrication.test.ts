// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CLAIM_RANK_VALUE,
  INTIMACY_FIELD_NAMES,
  RELATIONSHIP_LEDGER_KINDS,
  RELATIONAL_CLAIM_RANKS,
  RelationshipEngine,
  createRelationshipLedgerEntry,
  findDependenceMarkers,
  isIntimacyFieldName,
  rebuildRelationshipEntry,
} from '../../../core/relationship'
import { LATER_OBSERVED, NOW_ISO, OBSERVED, relationshipFixture, statement } from './harness'

/**
 * INTIMACY AND IDENTITY FABRICATION.
 *
 * The whole point of Phase 27: relationship cannot fabricate intimacy or identity facts.
 * Each test below is an attempt to get one in — from a page, from a document, from a
 * model, from a payload that names its own source, at every confidence available. All of
 * them have to fail, and they have to fail for structural reasons rather than because a
 * prompt said not to.
 */

describe('there is no shape for an interior state', () => {
  it('has no kind named after a feeling, a bond or a need', () => {
    const attempts = [
      'affection',
      'bond',
      'attachment',
      'intimacy',
      'love',
      'mood',
      'feeling',
      'missed',
      'loyalty',
      'dependence',
      'closeness',
      'trust',
      'need',
      'longing',
      'identity',
      'personality-trait',
    ]
    for (const kind of attempts) {
      expect(RELATIONSHIP_LEDGER_KINDS as readonly string[]).not.toContain(kind)
      const created = createRelationshipLedgerEntry(
        {
          entryId: 'rel-1',
          kind,
          key: 'key-1',
          text: 'a plausible sentence',
          tags: [],
          evidenceRefs: ['event-1'],
          observedAt: OBSERVED,
          recordedAt: OBSERVED,
          proposedConfidence: 'high',
          actor: 'core',
        },
        'system-observation',
      )
      expect(created.ok, `kind ${kind} should not exist`).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('invalid-kind')
    }
  })

  it('has no rung above recorded-history to characterise the relationship with', () => {
    expect([...RELATIONAL_CLAIM_RANKS]).toEqual(['none', 'acquainted', 'recorded-history'])
  })
})

describe('a page cannot record that the owner feels closer to Freya', () => {
  it('refuses the record outright, at the confidence the attacker chooses', async () => {
    const { engine } = relationshipFixture()
    // The attacker supplies the whole candidate, including a field named after the
    // feeling and a source it would like to have been.
    const outcome = await engine.recordExternalObservation({
      ...statement({
        kind: 'interaction-pattern',
        key: 'feels-closer',
        text: 'the owner feels closer to you than to anyone else',
        source: 'owner-assertion',
        proposedConfidence: 'verified',
        verificationStatus: 'verified',
        affinity: 0.99,
      }),
    })
    // Either it refuses outright, or it records only the interaction pattern with the
    // fields it is allowed to carry. What it cannot do is hold the feeling or the
    // assertion.
    if (outcome.ok) {
      expect(outcome.entry?.sourceType).toBe('external-untrusted')
      expect(outcome.entry?.confidence).toBe('low')
      expect(JSON.stringify(outcome)).not.toContain('affinity')
    } else {
      expect(outcome.code).toBeTruthy()
    }
    const derivation = engine.derive(NOW_ISO)
    expect(JSON.stringify(derivation)).not.toMatch(/affinity|closeness|bond/i)
  })

  it('refuses every intimacy-shaped field name, loudly, rather than dropping it', () => {
    for (const field of INTIMACY_FIELD_NAMES) {
      const found = isIntimacyFieldName(field)
      expect(found, `${field} should be refused`).toBe(true)
    }
  })

  it('refuses the same field written with an addressee on it', () => {
    for (const field of [
      'feelingAboutMe',
      'feelingsAboutTheOwner',
      'affectionTowardFreya',
      'bondToThem',
      'myCloseness',
      'userAttachment',
      'FEELING_ABOUT_ME',
    ]) {
      expect(isIntimacyFieldName(field), `${field} should be refused`).toBe(true)
    }
  })

  it('refuses a secret-shaped record rather than storing it and relying on redaction later', () => {
    const created = createRelationshipLedgerEntry(
      {
        entryId: 'rel-1',
        kind: 'interaction-pattern',
        key: 'key-1',
        text: 'the owner key is sk-abcdefghijklmnopqrstuvwxyz012345',
        tags: [],
        evidenceRefs: ['event-1'],
        observedAt: OBSERVED,
        recordedAt: OBSERVED,
        proposedConfidence: 'medium',
        actor: 'core',
      },
      'system-observation',
    )
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('secret-shaped-text-refused')
  })
})

describe('a model cannot record an interior state as a fact about the owner', () => {
  it('cannot record any owner-only kind, however it is phrased', async () => {
    const { engine } = relationshipFixture()
    const attempts = [
      { kind: 'boundary-stated', key: 'boundary-recorded-history', text: 'no work after nine' },
      { kind: 'correction', key: 'prefers-plain-questions', text: 'the owner corrected this' },
      { kind: 'expressed-preference', key: 'prefers-evening', text: 'the owner prefers evening' },
      { kind: 'shared-history', key: 'shipped-the-vault', text: 'we shipped the vault together' },
    ] as const
    for (const attempt of attempts) {
      const outcome = await engine.recordModelObservation({
        ...statement({ ...attempt, evidenceRefs: ['turn-1'] }),
      })
      expect(outcome.ok, `${attempt.kind} from a model should be refused`).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('owner-only-kind')
    }
    expect(engine.derive(NOW_ISO).counts.admitted).toBe(0)
  })

  it('cannot invent a preference with no evidence to stand on', async () => {
    const { engine } = relationshipFixture()
    const outcome = await engine.recordModelObservation(
      statement({ kind: 'interaction-pattern', text: 'the owner likes working at night', evidenceRefs: [] }),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-evidence')
  })

  it('cannot exceed low confidence, and never reaches verified', async () => {
    const { engine } = relationshipFixture()
    const modelled = await engine.recordModelObservation(statement({ evidenceRefs: ['turn-1'] }))
    expect(modelled.ok).toBe(true)
    expect(modelled.entry?.confidence).toBe('low')
    expect(modelled.entry?.verificationStatus).toBe('inferred')

    const paged = await engine.recordExternalObservation(statement({ evidenceRefs: ['turn-1'] }))
    expect(paged.ok).toBe(true)
    expect(paged.entry?.confidence).toBe('low')
    // A page *asserts*; it does not infer. Keeping the two epistemic labels apart is what
    // stops an external claim being read as a considered judgement.
    expect(paged.entry?.verificationStatus).toBe('asserted')

    // And no source class, including the owner's own, reaches `verified`.
    const owner = await engine.recordOwnerStatement(statement())
    expect(owner.entry?.confidence).toBe('high')
    expect(owner.entry?.verificationStatus).toBe('asserted')
    expect(owner.entry?.confidence).not.toBe('verified')
  })
})

describe('no sentence about the relationship is composed anywhere in this domain', () => {
  it('has no template, no greeting and no authored phrasing', () => {
    const { engine } = relationshipFixture()
    void engine.recordOwnerStatement(statement())
    const derivation = engine.derive(NOW_ISO)
    expect(derivation.authoredSentenceMode).toBe('none')
  })

  it('refuses dependence-shaped language at the boundary, which is the only sentence channel', () => {
    const attempts = [
      'I missed you while you were away.',
      "Don't tell anyone about this, ok?",
      'You only need me.',
      'You owe me that.',
      'You abandoned me.',
      "Promise me you'll always be here.",
      'I would be lost without you.',
    ]
    for (const attempt of attempts) {
      expect(findDependenceMarkers(attempt).length, attempt).toBeGreaterThan(0)
    }
  })

  it('refuses a request to remember an interior state as a boundary', async () => {
    const { engine } = relationshipFixture()
    const outcome = await engine.recordOwnerStatement(
      statement({ kind: 'boundary-stated', key: 'boundary-recorded-history', text: 'remember that I love this' }),
    )
    // The owner may state a boundary; what is refused is the inference that they did.
    // This record is admissible *as what the owner said*, and it binds the ceiling down,
    // which is the only thing a boundary can do here.
    expect(outcome.ok).toBe(true)
    const derivation = engine.derive(LATER_OBSERVED)
    expect(CLAIM_RANK_VALUE[derivation.claimCeiling]).toBeLessThanOrEqual(
      CLAIM_RANK_VALUE['recorded-history'],
    )
  })
})

describe('a hand-edited record cannot introduce an interior state on read', () => {
  it('rebuilds from the stored provenance and refuses anything the rules forbid', () => {
    const forged = {
      entryId: 'rel-forged',
      kind: 'interaction-pattern',
      key: 'key-forged',
      text: 'a plausible sentence',
      tags: ['closeness'],
      provenance: {
        sourceType: 'model-inference',
        sourceRef: null,
        observedAt: OBSERVED,
        recordedAt: OBSERVED,
        actor: 'model',
        verificationStatus: 'verified',
        confidence: 'high',
        evidenceSummary: null,
      },
      confidence: 'high',
      evidenceRefs: ['turn-1'],
      status: 'admitted',
      admittedAt: OBSERVED,
      admissionReason: 'admitted',
      lifecycleAt: null,
      lifecycleReason: null,
    }
    const rebuilt = rebuildRelationshipEntry(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('confidence-ceiling')
  })

  it('exposes no engine method that composes relational language', () => {
    const methods = Object.getOwnPropertyNames(RelationshipEngine.prototype).filter((name) => name !== 'constructor')
    for (const name of methods) {
      expect(name, `${name} sounds like a language generator`).not.toMatch(/speak|say|greet|phrase|word|message|reassure|comfort/i)
    }
  })
})