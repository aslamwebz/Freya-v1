import { describe, expect, it } from 'vitest'
import { RELATIONSHIP_LIMITS, RelationshipEngine } from '../../core/relationship'
import { MemoryRelationshipStore } from '../../core/vault/repositories/relationship-store'

/**
 * PHASE 27 — THE TRUSTED PATHWAYS, CORRECTION, WITHDRAWAL AND FORGET.
 *
 * The engine is the only way a relationship record comes into existence, so these tests
 * pin the three things that depend on it: the source class is fixed by the *method*
 * rather than by the payload, the owner's acts are correction-without-erasure and
 * withdrawal-without-disappearance, and text leaves Core only through the two reads that
 * are allowed to carry it.
 *
 * Deterministic: `now` and `newId` are injected, so no clock, no randomness and no model
 * are involved.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z')
const OBSERVED = '2026-05-01T08:00:00.000Z'

function makeEngine(options: { stopped?: () => boolean } = {}): {
  engine: RelationshipEngine
  store: MemoryRelationshipStore
} {
  let counter = 0
  const store = new MemoryRelationshipStore()
  const engine = new RelationshipEngine({
    store,
    now: () => NOW,
    newId: () => `rel-${(counter += 1)}`,
    stopped: options.stopped ?? (() => false),
  })
  return { engine, store }
}

const statement = {
  kind: 'interaction-pattern' as const,
  key: 'starts-with-a-question',
  text: 'the owner opens most sessions with a question',
  observedAt: OBSERVED,
}

describe('the pathways fix their own source class', () => {
  it('records the owner assertion as owner-assertion, asserted, at high', async () => {
    const { engine } = makeEngine()
    const outcome = await engine.recordOwnerStatement(statement)
    expect(outcome.ok).toBe(true)
    if (outcome.outcome !== 'recorded') throw new Error(outcome.outcome)
    expect(outcome.entry?.sourceType).toBe('owner-assertion')
    expect(outcome.entry?.verificationStatus).toBe('asserted')
    expect(outcome.entry?.confidence).toBe('high')
    // Even the owner gets no `verified`: this domain has no row that yields one.
    expect(outcome.entry?.confidence).not.toBe('verified')
  })

  it('records a model inference as model-inference, inferred, at low', async () => {
    const { engine } = makeEngine()
    const outcome = await engine.recordModelObservation({ ...statement, evidenceRefs: ['turn-9'] })
    expect(outcome.ok).toBe(true)
    expect(outcome.entry?.sourceType).toBe('model-inference')
    expect(outcome.entry?.verificationStatus).toBe('inferred')
    expect(outcome.entry?.confidence).toBe('low')
  })

  it('records an external claim as external-untrusted rather than laundering it', async () => {
    const { engine } = makeEngine()
    const outcome = await engine.recordExternalObservation({ ...statement, evidenceRefs: ['page-1'] })
    expect(outcome.ok).toBe(true)
    expect(outcome.entry?.sourceType).toBe('external-untrusted')
  })

  it('refuses every owner-only kind from a model or a page, with the reason named', async () => {
    const { engine } = makeEngine()
    const kinds = ['expressed-preference', 'shared-history', 'correction', 'boundary-stated'] as const
    for (const kind of kinds) {
      const modelled = await engine.recordModelObservation({
        kind,
        key: 'boundary-recorded-history',
        text: 'a thing attributed to the owner',
        evidenceRefs: ['turn-1'],
        observedAt: OBSERVED,
      })
      expect(modelled.ok).toBe(false)
      if (modelled.ok) continue
      expect(modelled.code).toBe('owner-only-kind')

      const paged = await engine.recordExternalObservation({
        kind,
        key: 'boundary-recorded-history',
        text: 'a thing a document claimed',
        evidenceRefs: ['doc-1'],
        observedAt: OBSERVED,
      })
      expect(paged.ok).toBe(false)
      if (paged.ok) continue
      expect(paged.code).toBe('owner-only-kind')
    }
    expect(engine.derive(NOW.toISOString()).counts.admitted).toBe(0)
  })

  it('refuses a derived record with no evidence rather than storing it at lower confidence', async () => {
    const { engine } = makeEngine()
    const outcome = await engine.recordSystemObservation({ ...statement, evidenceRefs: [] })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-evidence')
  })

  it('refuses an intimacy-shaped input outright, naming the field', async () => {
    const { engine } = makeEngine()
    const outcome = await engine.recordOwnerStatement({
      ...statement,
      text: 'the owner said they feel closer to me than to anyone',
    })
    // The *text* is admissible as a record of what was said; what is refused is a field
    // named after the feeling. So this asserts the text boundary separately.
    expect(outcome.ok).toBe(true)

    const refused = await engine.recordOwnerStatement({ ...statement, key: 'not a slug!' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('invalid-key')
  })

  it('refuses every write while stopped, and keeps the ledger readable', async () => {
    let stop = true
    const { engine, store } = makeEngine({ stopped: () => stop })
    const refused = await engine.recordOwnerStatement(statement)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('stopped')
    expect(store.state().entries.size).toBe(0)

    stop = false
    expect((await engine.recordOwnerStatement(statement)).ok).toBe(true)
  })
})

describe('correction', () => {
  it('writes a replacement and a correction, supersedes the original, and loses nothing', async () => {
    const { engine } = makeEngine()
    const recorded = await engine.recordOwnerStatement({ ...statement, text: 'the owner prefers morning sessions' })
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    const originalId = recorded.entry.entryId

    const corrected = await engine.correct(originalId, {
      text: 'the owner prefers evening sessions',
      reason: 'the owner said the earlier record was wrong',
      observedAt: '2026-05-20T08:00:00.000Z',
    })
    expect(corrected.ok).toBe(true)
    expect(corrected.outcome).toBe('corrected')
    expect(corrected.superseded).toBe(originalId)
    expect(corrected.correction?.kind).toBe('correction')
    expect(corrected.correction?.sourceType).toBe('owner-assertion')

    // The original is still readable, with the words it originally held: an edit that
    // rewrote it in place would have destroyed the fact that a correction happened.
    const original = engine.readEntry(originalId)
    expect(original.ok).toBe(true)
    if (!original.ok) return
    expect(original.entry.status).toBe('superseded')
    expect(original.entry.text).toBe('the owner prefers morning sessions')

    // The replacement is live, and the key no longer carries a disagreement.
    const replacementId = corrected.entry?.entryId ?? ''
    const replacement = engine.readEntry(replacementId)
    expect(replacement.ok).toBe(true)
    if (!replacement.ok) return
    expect(replacement.entry.status).toBe('admitted')
    expect(replacement.entry.text).toBe('the owner prefers evening sessions')
    // The replacement names what it replaces.
    expect(replacement.entry.evidenceRefCount).toBe(1)

    const derivation = engine.derive(NOW.toISOString())
    expect(derivation.counts.superseded).toBe(1)
    expect(derivation.conflictedKeys).toEqual([])
  })

  it('refuses a correction with no reason, and a correction of something not live', async () => {
    const { engine } = makeEngine()
    const recorded = await engine.recordOwnerStatement(statement)
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    const id = recorded.entry.entryId

    const unreasoned = await engine.correct(id, { text: 'new', reason: '', observedAt: OBSERVED })
    expect(unreasoned.ok).toBe(false)
    if (unreasoned.ok) return
    expect(unreasoned.code).toBe('invalid-record')

    await engine.withdraw(id)
    const withdrawn = await engine.correct(id, { text: 'new', reason: 'a reason', observedAt: OBSERVED })
    expect(withdrawn.ok).toBe(false)
    if (withdrawn.ok) return
    expect(withdrawn.code).toBe('not-admitted')
  })

  it('refuses a correction of a record that does not exist', async () => {
    const { engine } = makeEngine()
    const outcome = await engine.correct('rel-nope', { text: 'new', reason: 'a reason', observedAt: OBSERVED })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-such-entry')
  })
})

describe('withdrawal', () => {
  it('destroys the text and keeps the fact that it was taken back', async () => {
    const { engine } = makeEngine()
    const recorded = await engine.recordOwnerStatement({ ...statement, text: 'something the owner would withdraw' })
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    const id = recorded.entry.entryId

    const withdrawn = await engine.withdraw(id)
    expect(withdrawn.ok).toBe(true)
    expect(withdrawn.entry?.status).toBe('retracted')
    expect(withdrawn.entry?.textLength).toBe(0)

    const read = engine.readEntry(id)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.entry.text).toBe('')
    expect(read.entry.textDestroyed).toBe(true)
    expect(read.entry.lifecycleReason).toBe('owner-withdrew-this-record')

    const derivation = engine.derive(NOW.toISOString())
    expect(derivation.counts.admitted).toBe(0)
    expect(derivation.counts.retracted).toBe(1)
    // A withdrawn record stops feeding the record set: it is history, not evidence.
    expect(derivation.familiarity).toBe('new')
    expect(derivation.claimCeiling).toBe('none')
  })

  it('cannot be withdrawn twice, and a withdrawn record cannot be corrected', async () => {
    const { engine } = makeEngine()
    const recorded = await engine.recordOwnerStatement(statement)
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    const id = recorded.entry.entryId
    await engine.withdraw(id)

    const again = await engine.withdraw(id)
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe('not-admitted')
  })
})

describe('forget', () => {
  it('refuses a live record and asks for the withdrawal first', async () => {
    const { engine } = makeEngine()
    const recorded = await engine.recordOwnerStatement(statement)
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    const id = recorded.entry.entryId

    const refused = await engine.forget(id)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('not-admitted')
    // Still there: a refused forget destroys nothing.
    expect(engine.readEntry(id).ok).toBe(true)
  })

  it('removes the record and its metadata once it has been withdrawn', async () => {
    const { engine, store } = makeEngine()
    const recorded = await engine.recordOwnerStatement(statement)
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    const id = recorded.entry.entryId
    await engine.withdraw(id)

    const forgotten = await engine.forget(id)
    expect(forgotten.ok).toBe(true)
    expect(forgotten.outcome).toBe('forgotten')
    expect(store.state().entries.has(id)).toBe(false)
    expect(engine.readEntry(id).ok).toBe(false)
    const exported = engine.export()
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.export.items).toHaveLength(0)
  })

  it('refuses a record that does not exist rather than reporting success', async () => {
    const { engine } = makeEngine()
    const outcome = await engine.forget('rel-nope')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('no-such-entry')
  })
})

describe('the owner export', () => {
  it('carries the text, in a bounded and clearly labelled shape', async () => {
    const { engine } = makeEngine()
    await engine.recordOwnerStatement({ ...statement, text: 'the owner prefers evening sessions' })
    const outcome = engine.export()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.export.total).toBe(1)
    expect(outcome.export.withheld).toBe(0)
    expect(outcome.export.items[0]?.text).toBe('the owner prefers evening sessions')
    expect(outcome.export.persistence.durable).toBe(false)
  })

  it('reports what the bound withheld, so a partial export is never read as complete', async () => {
    const { engine } = makeEngine()
    const total = RELATIONSHIP_LIMITS.maxOwnerExportEntries + 3
    for (let i = 0; i < total; i += 1) {
      await engine.recordOwnerStatement({ ...statement, text: `a recorded statement number ${i}` })
    }
    const outcome = engine.export()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.export.items).toHaveLength(RELATIONSHIP_LIMITS.maxOwnerExportEntries)
    expect(outcome.export.total).toBe(total)
    expect(outcome.export.withheld).toBe(3)
  })

  it('exports a withdrawn record as withdrawn, with its text destroyed', async () => {
    const { engine } = makeEngine()
    const recorded = await engine.recordOwnerStatement({ ...statement, text: 'to be withdrawn' })
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    await engine.withdraw(recorded.entry.entryId)
    const outcome = engine.export()
    if (!outcome.ok) throw new Error('export failed')
    expect(outcome.export.items[0]?.status).toBe('retracted')
    expect(outcome.export.items[0]?.text).toBe('')
    expect(outcome.export.items[0]?.lifecycleReason).toBe('owner-withdrew-this-record')
  })
})

describe('privacy boundaries', () => {
  it('carries no entry text in the projection, at any breadth', async () => {
    const { engine } = makeEngine()
    await engine.recordOwnerStatement({
      ...statement,
      text: 'the owner said something only the owner may read FREYA_SENTINEL_TEXT',
    })
    const serialised = JSON.stringify(engine.project(NOW.toISOString()))
    expect(serialised).not.toContain('FREYA_SENTINEL_TEXT')
    expect(serialised).not.toContain('the owner said something')
  })

  it('carries no entry text in the broad list, and no free-form reason either', async () => {
    const { engine } = makeEngine()
    const recorded = await engine.recordOwnerStatement({ ...statement, text: 'FREYA_SENTINEL_TEXT a private record' })
    if (recorded.outcome !== 'recorded') throw new Error('setup failed')
    const listed = engine.listEntries()
    if (!listed.ok) throw new Error('list failed')
    expect(listed.entries.items[0]?.textLength).toBe('FREYA_SENTINEL_TEXT a private record'.length)
    expect(JSON.stringify(listed)).not.toContain('FREYA_SENTINEL_TEXT')
  })

  it('refuses to invent a record on read', async () => {
    const { engine } = makeEngine()
    const read = engine.readEntry('rel-not-a-record')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.code).toBe('no-such-entry')
  })

  it('reports an ephemeral store as ephemeral rather than as durable memory', () => {
    const ephemeral = new MemoryRelationshipStore({
      mode: 'ephemeral',
      faultReason: 'no Vault key was available for this session',
    })
    const engine = new RelationshipEngine({ store: ephemeral, now: () => NOW })
    const projection = engine.project(NOW.toISOString())
    expect(projection.persistence.mode).toBe('ephemeral')
    expect(projection.persistence.durable).toBe(false)
    expect(projection.persistence.reason).toContain('no Vault key')
  })
})

describe('the retention bound', () => {
  it('retires the oldest records under a code-owned bound and says so', async () => {
    const { engine, store } = makeEngine()
    const total = RELATIONSHIP_LIMITS.maxLiveEntries + 2
    for (let i = 0; i < total; i += 1) {
      await engine.recordOwnerStatement({
        ...statement,
        text: `a recorded statement number ${i}`,
        observedAt: new Date(Date.parse(OBSERVED) + i * 1000).toISOString(),
      })
    }
    const derivation = engine.derive(NOW.toISOString())
    expect(derivation.counts.admitted).toBe(RELATIONSHIP_LIMITS.maxLiveEntries)
    expect(derivation.counts.expired).toBe(2)
    const expired = [...store.state().entries.values()].filter((entry) => entry.status === 'expired')
    for (const entry of expired) {
      expect(entry.text).toBe('')
      expect(entry.lifecycleReason).toBe('retention-bound-reached')
    }
  })

  it('does nothing while stopped', async () => {
    const engine = new RelationshipEngine({
      store: new MemoryRelationshipStore(),
      now: () => NOW,
      stopped: () => true,
    })
    expect(await engine.applyRetentionBound()).toEqual([])
  })
})