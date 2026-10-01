// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as contextProtocol from '../../core/protocol/context'
import {
  ABSENT_CONTEXT_PROJECTION,
  NO_CONTEXT_DOMAIN_REASON,
  type ContextItemView,
  type ContextProjection,
  type ContextReferenceView,
  type ContextSource,
} from '../../core/protocol/context'

/**
 * The Context protocol, on its own.
 *
 * The file now carries two vocabularies — Core's own (admissions, boundary
 * refusals, audit rows, command outcomes) and the window's read-only view — so
 * what this lane pins down is the part the *window's* half is on the hook for:
 *
 *  1. The runtime surface of the protocol is data and one guard. No projection
 *     can be *submitted* through this file because there is nothing here that
 *     accepts one, and the list below is pinned exactly so that a runtime
 *     export added later has to be argued here rather than arriving quietly.
 *  2. The absent projection is absent — `unavailable`, frozen, and never a
 *     `ready` frame with invented zeroes dressed as a report.
 *  3. The key set of every view is exactly what it declares, so a field added
 *     is a visible vocabulary change and a field left out is reported as null
 *     rather than guessed.
 *  4. The seam a reader fills is *readable and nothing else* — the smallest
 *     object that satisfies `ContextSource` really is just a reader.
 */

function item(over: Partial<ContextItemView> = {}): ContextItemView {
  return {
    itemId: 'ctx-item-1',
    kind: 'explicit-selection',
    label: 'the paragraph in the editor',
    state: 'current',
    provenance: {
      sourceClass: 'owner',
      detail: 'selected by the owner',
      admittedAt: '2026-10-01T09:00:00.000Z',
    },
    scope: { label: 'session', detail: null },
    expiresAt: '2026-10-01T09:15:00.000Z',
    ttlSeconds: 900,
    ...over,
  }
}

describe('the protocol exposes a report and no verbs', () => {
  it('has a runtime surface of closed vocabularies, two absences and one guard', () => {
    // Everything in the file is a *shape* except these: closed vocabularies
    // Core's boundary quotes, the words a refusal is worded in, the two
    // sentences a surface prints, and one predicate over a list. Nothing here
    // accepts a projection, so there is still no path through this file into
    // anything — and the list is exact, so a runtime export added later is a
    // visible change to this test rather than a quiet widening of what a
    // caller can reach.
    expect(Object.keys(contextProtocol).sort()).toEqual([
      'ABSENT_CONTEXT_PROJECTION',
      'CONTEXT_ADMISSION_CHANNELS',
      'CONTEXT_AUTHORITY_FIELDS',
      'CONTEXT_BOUNDARY_REFUSALS',
      'CONTEXT_BOUNDARY_REFUSAL_TEXT',
      'CONTEXT_SCOPE_KINDS',
      'NO_ACTIVE_AGENT_CONTEXT_REASON',
      'NO_CONTEXT_DOMAIN_REASON',
      'SESSION_CONTEXT_SCOPE',
      'isContextAdmissionChannel',
    ])
    // One callable thing, and it is a guard over a closed list: a predicate,
    // not an operation. Every other export is data.
    const callable = Object.keys(contextProtocol).filter(
      (name) => typeof (contextProtocol as Record<string, unknown>)[name] === 'function',
    )
    expect(callable).toEqual(['isContextAdmissionChannel'])
  })

  it('names no mutating verb anywhere in its runtime surface', () => {
    // The Workforce lane exported a payloadless-read sentence because it owns a
    // read command. Context owns no command at all, so there is not even a
    // refusal constant here — nothing to submit against.
    for (const name of Object.keys(contextProtocol)) {
      expect(name.toLowerCase()).not.toMatch(/submit|create|write|assign|grant|revoke|capture|set/)
    }
  })
})

describe('the absent projection is an absence, not a quiet frame', () => {
  it('is unavailable with Core-not-reported words', () => {
    expect(ABSENT_CONTEXT_PROJECTION.health).toBe('unavailable')
    expect(ABSENT_CONTEXT_PROJECTION.reason).toBe('Core has not reported a Context yet')
    expect(ABSENT_CONTEXT_PROJECTION.items).toEqual([])
    expect(ABSENT_CONTEXT_PROJECTION.references).toEqual([])
    expect(ABSENT_CONTEXT_PROJECTION.counts).toEqual({
      items: 0,
      current: 0,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
    expect(ABSENT_CONTEXT_PROJECTION.sequence).toBe(0)
  })

  it('is frozen all the way down, so a mirror cannot be edited into a lie', () => {
    expect(Object.isFrozen(ABSENT_CONTEXT_PROJECTION)).toBe(true)
    expect(Object.isFrozen(ABSENT_CONTEXT_PROJECTION.items)).toBe(true)
    expect(Object.isFrozen(ABSENT_CONTEXT_PROJECTION.references)).toBe(true)
    expect(Object.isFrozen(ABSENT_CONTEXT_PROJECTION.counts)).toBe(true)
    // ESM is already strict mode: a window that received this object and tried
    // to redraw `unavailable` as `ready` gets a throw, not a silent lie.
    const mutatable = ABSENT_CONTEXT_PROJECTION as unknown as { health: string }
    expect(() => {
      mutatable.health = 'ready'
    }).toThrow(TypeError)
  })

  it('keeps "no domain" a separate sentence from "not reported yet"', () => {
    // The surface matches on this constant rather than paraphrasing it, and the
    // two absences must never collapse into each other: a build without the
    // domain and a window that opened before the first push are different facts.
    expect(NO_CONTEXT_DOMAIN_REASON).toContain('no Context domain')
    expect(NO_CONTEXT_DOMAIN_REASON).toContain('none is simulated')
    expect(NO_CONTEXT_DOMAIN_REASON).not.toBe(ABSENT_CONTEXT_PROJECTION.reason)
  })
})

describe('the view vocabulary is exactly its declared keys', () => {
  it('carries an item with provenance, scope and TTL as fields, or nulls', () => {
    // Key sets are checked exactly, the way the Workforce lane checks its
    // payloads: a field is either reported or null, and the appearance of a
    // new one has to be a visible change to this file rather than a quiet
    // widening of what a window may hold.
    expect(Object.keys(item()).sort()).toEqual([
      'expiresAt',
      'itemId',
      'kind',
      'label',
      'provenance',
      'scope',
      'state',
      'ttlSeconds',
    ])
    expect(Object.keys(item().provenance ?? {}).sort()).toEqual([
      'admittedAt',
      'detail',
      'sourceClass',
    ])
    expect(Object.keys(item().scope ?? {}).sort()).toEqual(['detail', 'label'])
  })

  it('gives an item no content field', () => {
    // The point of `label` is that it is Core's display handle, and the point
    // of the absence is that a standing projection of context content would
    // copy private material into every window that caches a projection. The
    // text behind a selection, the bytes of a file: none of it is here.
    const row = item({ label: 'a document' }) as unknown as Record<string, unknown>
    for (const forbidden of ['content', 'text', 'body', 'excerpt', 'payload', 'trust', 'authority']) {
      expect(row).not.toHaveProperty(forbidden)
    }
  })

  it('shows a reference with every candidate and nothing that picks one', () => {
    const reference: ContextReferenceView = {
      reference: 'this',
      status: 'ambiguous',
      itemIds: ['ctx-item-1', 'ctx-item-2'],
      reason: 'two items match the phrase and Core will not choose',
    }
    expect(Object.keys(reference).sort()).toEqual(['itemIds', 'reason', 'reference', 'status'])
    expect(reference.itemIds).toHaveLength(2)
    // There is no `chosenItemId` to read and no `resolve()` to call: an open
    // reference stays open on screen exactly as Core left it.
    expect(reference).not.toHaveProperty('chosenItemId')
    expect(reference).not.toHaveProperty('resolution')
  })

  it('is a projection of views, in Core\'s words, with a sequence', () => {
    const projection: ContextProjection = {
      health: 'ready',
      reason: null,
      items: [item()],
      references: [],
      counts: {
        items: 1,
        current: 1,
        expired: 0,
        revoked: 0,
        references: 0,
        unresolvedReferences: 0,
      },
      sequence: 9,
    }
    expect(Object.keys(projection).sort()).toEqual([
      'counts',
      'health',
      'items',
      'reason',
      'references',
      'sequence',
    ])
    // `kind` and `state` are strings, not enums, and a word this lane has never
    // heard of is a legal value: the availability and taxonomy vocabularies
    // belong to #15's domain, and a union written here would be guessing.
    expect(item({ state: 'between-reads' }).state).toBe('between-reads')
  })
})

describe('the ContextSource seam, which #15 fills and nothing else assumes', () => {
  it('is satisfiable by the smallest thing that can be read', () => {
    // If this file can drive the whole seam with an object this small, the seam
    // really is this small — which is the same argument the Workforce lane made
    // by writing its fake down first. A source is a reader with an optional
    // heartbeat; it cannot take an instruction, because it has no methods that
    // accept one.
    let current: ContextProjection = ABSENT_CONTEXT_PROJECTION
    const listeners = new Set<(projection: ContextProjection) => void>()
    const source: ContextSource = {
      projection: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    expect(source.projection().health).toBe('unavailable')
    const seen: ContextProjection[] = []
    const dispose = source.subscribe?.((projection) => seen.push(projection))
    current = { ...ABSENT_CONTEXT_PROJECTION, health: 'ready', reason: null, sequence: 1 }
    for (const listener of [...listeners]) listener(source.projection())
    expect(seen[0]?.health).toBe('ready')
    dispose?.()
    expect(listeners.size).toBe(0)
  })

  it('makes subscribe optional, because a source that only moves with Core has nothing to push', () => {
    const pullOnly: ContextSource = { projection: () => ABSENT_CONTEXT_PROJECTION }
    expect(pullOnly.subscribe).toBeUndefined()
  })
})
