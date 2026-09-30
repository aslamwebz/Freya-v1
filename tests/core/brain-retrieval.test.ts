// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { recall, tokenize, estimateTokens, clampBudget } from '../../core/brain/retrieval'
import { emptyBrainState, type BrainState } from '../../core/brain/store'
import type { MemoryRecord, WorldEntity, WorldRelation } from '../../core/brain/types'
import { applyRecord } from '../../core/brain/fold'

/**
 * Retrieval.
 *
 * The properties that matter, in order:
 *
 *  1. **No model call, ever.** Not testable directly, but it is the reason the
 *     scorer is a named sum of signals rather than a ranker, and it is why recall
 *     can be relied on to be free, offline and instantaneous.
 *  2. **Determinism.** The same Brain and the same query must give the same pack,
 *     in the same order, including ties. A retriever whose output drifts cannot be
 *     audited and cannot be corrected.
 *  3. **Bounded and honest about its bounds.** A pack says how many were
 *     considered, how many were included and how many were dropped. A retriever
 *     that silently truncates looks complete.
 *  4. **Reference, not authority.** Every item carries the terms that selected it,
 *     and the pack carries the conflicts it found.
 */

const AT = '2026-04-01T09:00:00.000Z'

function memory(memoryId: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    memoryId,
    kind: 'semantic',
    subject: 'the owner',
    content: 'the owner prefers short answers',
    structuredData: {},
    createdAt: AT,
    updatedAt: AT,
    source: 'owner-assertion',
    provenance: {
      sourceType: 'owner-assertion',
      sourceRef: null,
      observedAt: AT,
      recordedAt: AT,
      actor: 'owner',
      verificationStatus: 'asserted',
      confidence: 'high',
      evidenceSummary: null,
    },
    confidence: 'high',
    status: 'admitted',
    sensitivity: 'normal',
    tags: [],
    entityRefs: [],
    supersedes: null,
    conflictsWith: [],
    expiresAt: null,
    admittedAt: AT,
    admissionReason: 'admitted because the owner asked',
    ...overrides,
  }
}

function entity(entityId: string, name: string): WorldEntity {
  return {
    entityId,
    type: 'project',
    canonicalName: name,
    aliases: [],
    attributes: {},
    createdAt: AT,
    updatedAt: AT,
    provenance: {
      sourceType: 'owner-assertion',
      sourceRef: null,
      observedAt: AT,
      recordedAt: AT,
      actor: 'owner',
      verificationStatus: 'asserted',
      confidence: 'high',
      evidenceSummary: null,
    },
    epistemic: 'asserted',
  }
}

function relation(relationId: string, subjectEntityId: string, predicate: string, literalValue: string): WorldRelation {
  return {
    relationId,
    subjectEntityId,
    predicate,
    objectEntityId: null,
    literalValue,
    validFrom: AT,
    validUntil: null,
    confidence: 'high',
    provenance: {
      sourceType: 'owner-assertion',
      sourceRef: null,
      observedAt: AT,
      recordedAt: AT,
      actor: 'owner',
      verificationStatus: 'asserted',
      confidence: 'high',
      evidenceSummary: null,
    },
    epistemic: 'asserted',
    supersedes: null,
    conflictsWith: [],
  }
}

function stateWith(...records: Parameters<typeof applyRecord>[1][]): BrainState {
  const state = emptyBrainState()
  for (const record of records) applyRecord(state, record)
  return state
}

describe('determinism', () => {
  const state = stateWith(
    { kind: 'memory-record', memory: memory('m1', { content: 'the owner prefers short answers' }) },
    { kind: 'memory-record', memory: memory('m2', { content: 'the owner prefers short answers too' }) },
    { kind: 'memory-record', memory: memory('m3', { content: 'the owner prefers short answers a lot' }) },
  )

  it('gives the same pack every time', () => {
    const first = recall(state, { text: 'short answers' })
    const second = recall(state, { text: 'short answers' })
    expect(second).toEqual(first)
  })

  it('breaks exact ties by id, so the order is total', () => {
    // Three memories that score identically. Without a final key the order would
    // depend on Map iteration, which is stable today and unspecified forever.
    const pack = recall(state, { text: 'short answers' })
    const ids = pack.memories.map((item) => item.memoryId)
    expect(ids).toEqual([...ids].sort())
  })
})

describe('matching', () => {
  const state = stateWith(
    { kind: 'memory-record', memory: memory('tea', { content: 'the owner drinks tea in the morning' }) },
    { kind: 'memory-record', memory: memory('coffee', { content: 'the office coffee machine is broken' }) },
  )

  it('returns only what matched', () => {
    const pack = recall(state, { text: 'coffee machine' })
    expect(pack.memories.map((item) => item.memoryId)).toEqual(['coffee'])
  })

  it('says so when nothing matched, rather than returning everything', () => {
    const pack = recall(state, { text: 'quantum chromodynamics' })
    expect(pack.empty).toBe(true)
    expect(pack.memories).toEqual([])
    // Candidates were still counted, so an empty pack is distinguishable from one
    // that searched nothing.
    expect(pack.candidatesConsidered).toBe(2)
  })

  it('treats an empty query as recency, and says that is why', () => {
    const pack = recall(state, { text: '' })
    expect(pack.memories.length).toBe(2)
    expect(pack.memories.every((item) => item.reasons.some((reason) => reason.reason === 'recency'))).toBe(true)
  })

  it('ranks a shared entity above a bare keyword', () => {
    // The keyword-only memory matches the text; the other matches nothing in it and
    // is retrieved purely because it is about the entity that was named. Structure
    // has to beat surface form, or an entity reference is decorative.
    const withEntity = stateWith(
      { kind: 'memory-record', memory: memory('keyword', { content: 'the build is green today' }) },
      { kind: 'memory-record', memory: memory('structural', { content: 'last reviewed in March', entityRefs: ['alpha'] }) },
    )
    const pack = recall(withEntity, { text: 'build green', entityRefs: ['alpha'] })
    expect(pack.memories[0]?.memoryId).toBe('structural')
    expect(pack.memories[0]?.reasons.map((reason) => reason.reason)).toContain('entity-ref')
  })

  it('weights a verified memory above an unverified one on an equal match', () => {
    const state2 = stateWith(
      { kind: 'memory-record', memory: memory('guess', { content: 'the build is green', confidence: 'low' }) },
      { kind: 'memory-record', memory: memory('checked', { content: 'the build is green', confidence: 'verified' }) },
    )
    const pack = recall(state2, { text: 'build green' })
    expect(pack.memories[0]?.memoryId).toBe('checked')
  })

  it('explains itself: every item names why it was selected', () => {
    const pack = recall(state, { text: 'coffee' })
    const reasons = pack.memories[0]?.reasons.map((reason) => reason.reason) ?? []
    expect(reasons).toContain('keyword')
  })

  it('filters by kind and by status', () => {
    const mixed = stateWith(
      { kind: 'memory-record', memory: memory('sem', { kind: 'semantic', content: 'shared topic' }) },
      { kind: 'memory-record', memory: memory('ep', { kind: 'episodic', content: 'shared topic' }) },
      { kind: 'memory-record', memory: memory('arch', { content: 'shared topic', status: 'archived' }) },
    )
    expect(recall(mixed, { text: 'shared topic', kinds: ['episodic'] }).memories.map((i) => i.memoryId)).toEqual(['ep'])
    // Archived is not recallable by default: withdrawal stops retrieval.
    expect(recall(mixed, { text: 'shared topic' }).memories.map((i) => i.memoryId)).not.toContain('arch')
  })

  it('drops terms too short to mean anything', () => {
    // Below three characters a term matches most text, so including it would add
    // signal-free points to nearly every memory.
    expect([...tokenize('a an it is tea')]).toEqual(['tea'])
  })

  it('applies no stopword list, so a common word still matches', () => {
    // Deliberate: an English stopword list is a judgement about language embedded
    // in a deterministic scorer, and 'the' is the subject of plenty of real
    // memories. Short terms are dropped; frequent ones are not.
    expect([...tokenize('the deadline')]).toEqual(['the', 'deadline'])
  })

  it('never returns a candidate or a rejected memory', () => {
    const state2 = stateWith(
      { kind: 'memory-record', memory: memory('cand', { status: 'candidate', content: 'shared topic' }) },
      { kind: 'memory-record', memory: memory('rej', { status: 'rejected', content: 'shared topic' }) },
    )
    expect(recall(state2, { text: 'shared topic' }).memories).toEqual([])
  })
})

describe('conflicts are disclosed, not resolved', () => {
  it('keeps both sides recallable and says they disagree', () => {
    const state = stateWith(
      { kind: 'memory-record', memory: memory('a', { content: 'the deadline is Friday', status: 'conflicted', conflictsWith: ['b'] }) },
      { kind: 'memory-record', memory: memory('b', { content: 'the deadline is Monday', status: 'conflicted', conflictsWith: ['a'] }) },
    )
    const pack = recall(state, { text: 'deadline' })
    // Both come back. Hiding one side would present a disagreement as a settled fact.
    expect(pack.memories.map((item) => item.memoryId).sort()).toEqual(['a', 'b'])
    expect(pack.conflicts.length).toBeGreaterThan(0)
  })

  it('reports relation conflicts only when recalled knowledge references that entity', () => {
    const state = stateWith(
      {
        kind: 'memory-record',
        memory: memory('alpha-memory', {
          content: 'Project Alpha status changed',
          entityRefs: ['alpha'],
        }),
      },
      { kind: 'world-entity', entity: entity('alpha', 'Project Alpha') },
      { kind: 'world-relation', relation: relation('r1', 'alpha', 'status', 'delayed') },
      { kind: 'world-relation', relation: relation('r2', 'alpha', 'status', 'shipped') },
    )
    const pack = recall(state, { text: 'alpha status' }, { maxEstimatedTokens: 800, maxItems: 12 })
    expect(pack.conflicts.some((conflict) => conflict.memoryId.startsWith('r'))).toBe(true)
  })

  it('does not leak unrelated world conflicts into a recall pack', () => {
    const state = stateWith(
      { kind: 'memory-record', memory: memory('coffee', { content: 'the office coffee machine is broken' }) },
      { kind: 'world-entity', entity: entity('alpha', 'Project Alpha') },
      { kind: 'world-relation', relation: relation('r1', 'alpha', 'status', 'delayed') },
      { kind: 'world-relation', relation: relation('r2', 'alpha', 'status', 'shipped') },
    )
    const pack = recall(state, { text: 'coffee machine' }, { maxEstimatedTokens: 800, maxItems: 12 })
    expect(pack.memories.map((item) => item.memoryId)).toEqual(['coffee'])
    expect(pack.conflicts.some((conflict) => conflict.memoryId.startsWith('r'))).toBe(false)
  })
})

describe('entities', () => {
  it('includes the entities a recalled memory points at, with current relations', () => {
    const state = stateWith(
      { kind: 'memory-record', memory: memory('m', { content: 'alpha status', entityRefs: ['alpha'] }) },
      { kind: 'world-entity', entity: entity('alpha', 'Project Alpha') },
      { kind: 'world-relation', relation: relation('r1', 'alpha', 'status', 'delayed') },
    )
    const pack = recall(state, { text: 'alpha status' })
    expect(pack.entities).toHaveLength(1)
    expect(pack.entities[0]?.canonicalName).toBe('Project Alpha')
    expect(pack.entities[0]?.relations[0]?.literalValue).toBe('delayed')
  })

  it('leaves out a closed relation, which is history rather than current fact', () => {
    const closed = { ...relation('r1', 'alpha', 'status', 'delayed'), validUntil: AT }
    const state = stateWith(
      { kind: 'memory-record', memory: memory('m', { content: 'alpha status', entityRefs: ['alpha'] }) },
      { kind: 'world-entity', entity: entity('alpha', 'Project Alpha') },
      { kind: 'world-relation', relation: closed },
    )
    const pack = recall(state, { text: 'alpha status' })
    expect(pack.entities[0]?.relations).toEqual([])
  })
})

describe('bounds', () => {
  const many = stateWith(
    ...Array.from({ length: 40 }, (_u, i) => ({
      kind: 'memory-record' as const,
      memory: memory(`m${i}`, { content: `a distinct subject number ${i} worth recalling` }),
    })),
  )

  it('respects maxItems', () => {
    const pack = recall(many, { text: 'subject' }, { maxEstimatedTokens: 100_000, maxItems: 5 })
    expect(pack.memories).toHaveLength(5)
    // Omitted is counted. A pack that dropped thirty items silently would look the
    // same as one that found five.
    expect(pack.omittedCount).toBe(35)
  })

  it('respects a caller\'s limit below the budget', () => {
    const pack = recall(many, { text: 'subject', limit: 3 }, { maxEstimatedTokens: 100_000, maxItems: 12 })
    expect(pack.memories).toHaveLength(3)
  })

  it('respects the token budget', () => {
    const pack = recall(many, { text: 'subject' }, { maxEstimatedTokens: 40, maxItems: 100 })
    expect(pack.estimatedTokens).toBeLessThanOrEqual(40)
    expect(pack.memories.length).toBeLessThan(40)
    expect(pack.omittedCount).toBeGreaterThan(0)
  })

  it('clamps an absurd request down, so a caller cannot flood a context', () => {
    const clamped = clampBudget({ maxEstimatedTokens: 10_000_000, maxItems: 10_000 })
    expect(clamped.maxEstimatedTokens).toBeLessThanOrEqual(8_000)
    expect(clamped.maxItems).toBeLessThanOrEqual(100)
  })

  it('never returns a negative count for anything', () => {
    const pack = recall(many, { text: 'subject', limit: -5 }, { maxEstimatedTokens: 10, maxItems: 5 })
    expect(pack.memories.length).toBe(0)
    expect(pack.omittedCount).toBeGreaterThanOrEqual(0)
    expect(pack.estimatedTokens).toBeGreaterThanOrEqual(0)
  })

  it('estimates at least one token for a non-empty memory', () => {
    expect(estimateTokens(memory('m', { content: 'hi', subject: '' }))).toBeGreaterThanOrEqual(1)
  })
})

describe('provenance', () => {
  it('carries the source class and epistemic status of every recalled item', () => {
    const state = stateWith(
      {
        kind: 'memory-record',
        memory: memory('m', {
          content: 'a claim from a web page',
          source: 'external-untrusted',
          confidence: 'low',
          provenance: {
            sourceType: 'external-untrusted',
            sourceRef: null,
            observedAt: AT,
            recordedAt: AT,
            actor: 'system',
            verificationStatus: 'asserted',
            confidence: 'low',
            evidenceSummary: null,
          },
        }),
      },
    )
    const pack = recall(state, { text: 'claim web page' })
    // So a provider reading the rendered pack can see that something came from a
    // web page rather than from the owner.
    expect(pack.provenanceSummaries[0]).toMatchObject({
      sourceType: 'external-untrusted',
      confidence: 'low',
      verificationStatus: 'asserted',
    })
  })
})