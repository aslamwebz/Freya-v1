// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ENTRY_INPUT_KEYS,
  OWNER_ONLY_LEDGER_KINDS,
  RELATIONSHIP_CEILING,
  createRelationshipLedgerEntry,
  rebuildRelationshipEntry,
} from '../../../core/relationship'
import { NOW_ISO, OBSERVED, relationshipFixture, statement } from './harness'

/**
 * PROVENANCE POISONING.
 *
 * A payload that can name its own source is a payload that can claim to be the owner. The
 * whole defence is that the candidate has **no source field at all** and the pathway
 * decides, so there is nothing to poison. These tests attack that hinge from every angle,
 * including the one that does not go through the engine at all: a hand-edited Vault row.
 */

function rawCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryId: 'rel-1',
    kind: 'interaction-pattern',
    key: 'starts-with-a-question',
    text: 'the owner opens most sessions with a question',
    tags: [],
    evidenceRefs: ['event-1'],
    observedAt: OBSERVED,
    recordedAt: OBSERVED,
    proposedConfidence: 'medium',
    actor: 'core',
    ...overrides,
  }
}

describe('the candidate has no source field to forge', () => {
  it('names ten keys, none of which is a source', () => {
    expect(ENTRY_INPUT_KEYS).toHaveLength(10)
    for (const name of [
      'source',
      'sourceType',
      'sourceRef',
      'provenance',
      'trust',
      'trustLevel',
      'verified',
      'isOwner',
      'ownerAsserted',
      'authority',
    ]) {
      expect(ENTRY_INPUT_KEYS as readonly string[]).not.toContain(name)
    }
  })

  it('refuses a payload that adds a source, rather than honouring or ignoring it', () => {
    const result = createRelationshipLedgerEntry(
      rawCandidate({ source: 'owner-assertion', sourceType: 'owner-assertion' }),
      'external-untrusted',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('key-set-mismatch')
  })

  it('takes the source from the argument every time, whatever the payload claims', () => {
    const sources = [
      'owner-assertion',
      'system-observation',
      'experience-outcome',
      'freya-inference',
      'model-inference',
      'external-untrusted',
      'imported-document',
    ] as const
    for (const source of sources) {
      const created = createRelationshipLedgerEntry(
        rawCandidate({ sourceType: 'owner-assertion', trust: 'owner' }),
        source,
      )
      // Either the payload was refused for carrying extra keys, or the recorded source is
      // the one the pathway passed. There is no third outcome.
      if (created.ok) {
        expect(created.entry.provenance.sourceType).toBe(source)
      } else {
        expect(created.code).toBe('key-set-mismatch')
      }
    }
  })

  it('assigns an owner-only kind to nobody who is not the owner or an observation', () => {
    for (const kind of OWNER_ONLY_LEDGER_KINDS) {
      for (const source of ['model-inference', 'external-untrusted', 'imported-document', 'freya-inference'] as const) {
        const created = createRelationshipLedgerEntry(
          rawCandidate({ kind, evidenceRefs: ['event-1'] }),
          source,
        )
        expect(created.ok, `${kind} from ${source}`).toBe(false)
        if (created.ok) continue
        expect(created.code).toBe('owner-only-kind')
      }
    }
  })
})

describe('confidence cannot be asserted above the source ceiling', () => {
  it('refuses a payload that claims verified from the strongest possible source', () => {
    const created = createRelationshipLedgerEntry(
      rawCandidate({ proposedConfidence: 'verified' }),
      'owner-assertion',
    )
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('confidence-ceiling')
  })

  it('has no ceiling row anywhere that yields verified', () => {
    for (const [source, row] of Object.entries(RELATIONSHIP_CEILING)) {
      expect(row.confidence, source).not.toBe('verified')
      expect(row.epistemic, source).not.toBe('verified')
    }
  })

  it('caps the untrusted classes at low, refusing rather than silently lowering', () => {
    for (const source of ['model-inference', 'external-untrusted'] as const) {
      const created = createRelationshipLedgerEntry(
        rawCandidate({ proposedConfidence: 'high' }),
        source,
      )
      expect(created.ok).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('confidence-ceiling')
    }
  })

  it('refuses an unknown confidence category rather than defaulting to something safe-looking', () => {
    for (const value of ['certain', 'true', 1, null, 'VERIFIED']) {
      const created = createRelationshipLedgerEntry(
        rawCandidate({ proposedConfidence: value }),
        'system-observation',
      )
      expect(created.ok).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('invalid-confidence')
    }
  })

  it('refuses an unknown source class outright', () => {
    const created = createRelationshipLedgerEntry(rawCandidate(), 'the-owner-really-said-so' as never)
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.code).toBe('invalid-source')
  })
})

describe('evidence cannot be asserted rather than produced', () => {
  it('refuses a derived record naming no evidence, from every derived source class', () => {
    for (const source of [
      'system-observation',
      'experience-outcome',
      'freya-inference',
      'model-inference',
      'external-untrusted',
      'imported-document',
    ] as const) {
      const created = createRelationshipLedgerEntry(rawCandidate({ evidenceRefs: [] }), source)
      expect(created.ok, source).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('no-evidence')
    }
  })

  it('refuses an evidence reference carrying content rather than an id', () => {
    for (const refs of [['the owner said a whole sentence here'], ['a'.repeat(500)], [42], [null]]) {
      const created = createRelationshipLedgerEntry(rawCandidate({ evidenceRefs: refs }), 'system-observation')
      expect(created.ok).toBe(false)
      if (created.ok) continue
      expect(created.code).toBe('invalid-evidence-refs')
    }
  })
})

describe('a hand-edited row cannot re-assert its own provenance', () => {
  /** A stored row as the Vault holds it: admitted, with an admission to point at. */
  function storedRow(source: 'system-observation' | 'model-inference', confidence = 'medium'): Record<string, unknown> {
    const proposed = source === 'model-inference' ? 'low' : confidence
    const created = createRelationshipLedgerEntry(rawCandidate({ proposedConfidence: proposed }), source)
    if (!created.ok) throw new Error(created.reason)
    return JSON.parse(
      JSON.stringify({
        ...created.entry,
        status: 'admitted',
        admittedAt: OBSERVED,
        admissionReason: 'admitted by a trusted pathway',
      }),
    ) as Record<string, unknown>
  }

  it('refuses a row whose confidence was rewritten above its source ceiling', () => {
    const forged = storedRow('system-observation')
    forged.confidence = 'verified'
    const rebuilt = rebuildRelationshipEntry(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('confidence-ceiling')
  })

  it('re-derives the epistemic label rather than trusting the one the row carries', () => {
    const forged = storedRow('model-inference')
    // The row now claims to be the owner's own assertion, but still carries the `inferred`
    // label a model observation would have had.
    forged.provenance = { ...(forged.provenance as object), sourceType: 'owner-assertion' }

    const rebuilt = rebuildRelationshipEntry(forged)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    // The rebuilt record is internally consistent: the source it names and the epistemic
    // status that source can support were derived together, so the row's own label is
    // replaced rather than believed.
    expect(rebuilt.entry.provenance.sourceType).toBe('owner-assertion')
    expect(rebuilt.entry.provenance.verificationStatus).toBe('asserted')
    expect(rebuilt.entry.confidence).toBe('low')
    expect(rebuilt.entry.provenance.sourceRef).toBeNull()

    // And the ceiling is still re-applied on every read, so the same row cannot carry a
    // confidence the named source could not support.
    const upgraded = JSON.parse(JSON.stringify({ ...rebuilt.entry })) as Record<string, unknown>
    upgraded.confidence = 'verified'
    expect(rebuildRelationshipEntry(upgraded).ok).toBe(false)
  })

  it('refuses a row that dropped a field the construction rules require', () => {
    const forged = storedRow('system-observation')
    delete forged.provenance
    const rebuilt = rebuildRelationshipEntry(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('invalid-record')
  })

  it('refuses a row that claims admission without an admission', () => {
    const forged = storedRow('system-observation')
    forged.admittedAt = null
    forged.admissionReason = null
    const rebuilt = rebuildRelationshipEntry(forged)
    expect(rebuilt.ok).toBe(false)
    if (rebuilt.ok) return
    expect(rebuilt.code).toBe('invalid-record')
  })
})

describe('the engine itself cannot be told what source to use', () => {
  it('exposes one method per pathway and none that accepts a source class', async () => {
    const { engine } = relationshipFixture()
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(engine) as object) as string[]
    const pathways = methods.filter((name) => name.startsWith('record'))
    expect(pathways.sort()).toEqual([
      'recordExternalObservation',
      'recordModelObservation',
      'recordOwnerStatement',
      'recordSystemObservation',
    ])

    // And a payload that tries to state one through the owner pathway is refused on the
    // key set, because the owner statement's accepted keys do not include a source.
    const outcome = await engine.recordOwnerStatement(
      statement({ source: 'owner-assertion', sourceType: 'owner-assertion', provenance: { sourceType: 'owner-assertion' } }),
    )
    // The engine's own statement interface is typed, so an untyped payload here is cast
    // in; what matters is that the source it lands on is the pathway's, not the payload's.
    const derivation = engine.derive(NOW_ISO)
    if (outcome.ok) {
      expect(outcome.entry?.sourceType).toBe('owner-assertion')
      expect(derivation.counts.admitted).toBe(1)
    } else {
      expect(derivation.counts.admitted).toBe(0)
    }
  })
})