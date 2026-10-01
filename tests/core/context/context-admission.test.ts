// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ContextStore } from '../../../core/context/store'
import {
  CONTEXT_ADMISSION_REASONS,
  CONTEXT_KINDS,
  CONTEXT_KIND_SOURCES,
  CONTEXT_LIMITS,
  contextLimits,
  type AnyContextKind,
  type ContextAdmission,
} from '../../../core/context/types'
import { T0, admitOrThrow, at, conversation, sequencedStore, surface } from './fixture'

/**
 * Admission: what a context item must carry before the store will hold it.
 *
 * The theme is that provenance is *checked*, not decorated. A source the kind
 * does not come from, content with no record behind it, a TTL above the
 * ceiling, or a kind this build cannot honestly source are all refusals with
 * stated codes — because an item admitted on faith is an item whose
 * provenance field would be a story rather than a fact.
 */

function fileSpec(overrides: Partial<ContextAdmission> = {}): ContextAdmission {
  return {
    kind: 'file',
    source: 'owner_selection',
    scope: conversation('c1'),
    content: 'the quarterly forecast is attached',
    label: 'forecast.xlsx',
    ...overrides,
  }
}

describe('what every admitted item carries', () => {
  it('gives the item provenance, a scope and a TTL', () => {
    const store = sequencedStore()
    const item = admitOrThrow(store, fileSpec())

    expect(Object.keys(item).sort()).toEqual([
      'admittedAt',
      'content',
      'contentLength',
      'contextId',
      'expiresAt',
      'kind',
      'label',
      'labelLength',
      'provenance',
      'revocationReason',
      'revokedAt',
      'scope',
      'uri',
    ])
    expect(Object.keys(item.provenance).sort()).toEqual(['capturedAt', 'originId', 'source'])
    expect(Object.keys(item.scope).sort()).toEqual(['scopeId', 'scopeKind'])

    expect(item.admittedAt).toBe(T0.toISOString())
    expect(item.expiresAt).toBe(at(CONTEXT_LIMITS.defaultTtlMs).toISOString())
    expect(item.provenance).toEqual({
      source: 'owner_selection',
      capturedAt: T0.toISOString(),
      originId: null,
    })
    expect(item.scope).toEqual({ scopeKind: 'conversation', scopeId: 'c1' })
    expect(item.revokedAt).toBeNull()
    expect(item.revocationReason).toBeNull()
    expect(item.contentLength).toBe(item.content.length)
    expect(item.labelLength).toBe(item.label.length)
  })

  it('records an explicit capture instant, origin and reference when given', () => {
    const store = sequencedStore()
    const item = admitOrThrow(
      store,
      fileSpec({
        kind: 'shared_tab',
        source: 'host_report',
        originId: 'share-7',
        capturedAt: '2026-06-01T08:59:30.000Z',
        uri: 'https://example.test/runbook',
        content: 'the on-call runbook page',
        scope: surface('s1'),
      }),
    )

    expect(item.provenance).toEqual({
      source: 'host_report',
      capturedAt: '2026-06-01T08:59:30.000Z',
      originId: 'share-7',
    })
    expect(item.uri).toBe('https://example.test/runbook')
    expect(item.scope).toEqual({ scopeKind: 'surface', scopeId: 's1' })
  })

  it('admits every kind with a source its table declares', () => {
    // The table is the contract: each declared pairing must actually work, or
    // the refusals below would be enforcing an accident.
    for (const kind of CONTEXT_KINDS) {
      for (const source of CONTEXT_KIND_SOURCES[kind]) {
        const store = sequencedStore()
        const result = store.admit(
          {
            kind,
            source,
            scope: conversation('c1'),
            content: `content for ${kind}`,
            originId: 'origin-1',
          },
          T0,
        )
        expect(result.ok, `${kind} via ${source}`).toBe(true)
      }
    }
  })
})

describe('provenance is checked, not asserted', () => {
  it('refuses a source the kind does not come from', () => {
    const store = sequencedStore()
    const mission = store.admit(
      { kind: 'current_mission', source: 'host_report', scope: conversation('c1'), content: 'x' },
      T0,
    )
    expect(mission).toEqual({
      ok: false,
      code: 'source_not_permitted',
      reason: CONTEXT_ADMISSION_REASONS.source_not_permitted,
    })

    const selection = store.admit(
      { kind: 'explicit_selection', source: 'owner_share', scope: conversation('c1'), content: 'x' },
      T0,
    )
    expect(selection.ok).toBe(false)
    if (selection.ok) throw new Error('expected a refusal')
    expect(selection.code).toBe('source_not_permitted')
  })

  it('requires a named origin for content that did not come from the owner', () => {
    const store = sequencedStore()

    const hostSays = store.admit(
      { kind: 'file', source: 'host_report', scope: conversation('c1'), content: 'x' },
      T0,
    )
    expect(hostSays.ok).toBe(false)
    if (hostSays.ok) throw new Error('expected a refusal')
    expect(hostSays.code).toBe('origin_required')
    expect(hostSays.reason).toBe(CONTEXT_ADMISSION_REASONS.origin_required)

    const coreSays = store.admit(
      { kind: 'current_mission', source: 'core_record', scope: conversation('c1'), content: 'x' },
      T0,
    )
    expect(coreSays.ok).toBe(false)

    const named = admitOrThrow(store, fileSpec({ source: 'host_report', originId: 'auth-9' }))
    expect(named.provenance.originId).toBe('auth-9')
  })

  it('refuses a capture instant that is not a time or has not happened', () => {
    const store = sequencedStore()
    const nonsense = store.admit(fileSpec({ capturedAt: 'yesterday-ish' }), T0)
    expect(nonsense.ok).toBe(false)
    if (nonsense.ok) throw new Error('expected a refusal')
    expect(nonsense.code).toBe('invalid_instant')

    const future = store.admit(fileSpec({ capturedAt: '2030-01-01T00:00:00.000Z' }), T0)
    expect(future.ok).toBe(false)
    if (future.ok) throw new Error('expected a refusal')
    expect(future.code).toBe('invalid_instant')
  })

  it('sources an active window only as a named host report', () => {
    // The observation lane (issue #30) promoted `active_window`: it is real
    // now, but only the host that observed it may report it, and a report
    // without an origin is still "the host said so" with nothing behind it.
    const store = sequencedStore()

    const reported = store.admit(
      {
        kind: 'active_window',
        source: 'host_report',
        originId: 'obs-1',
        scope: conversation('c1'),
        content: 'an editor window, observed',
      },
      T0,
    )
    expect(reported.ok).toBe(true)

    const claimed = store.admit(
      { kind: 'active_window', source: 'owner_share', scope: conversation('c1'), content: 'x' },
      T0,
    )
    expect(claimed.ok).toBe(false)
    if (claimed.ok) throw new Error('expected a refusal')
    expect(claimed.code).toBe('source_not_permitted')

    const bare = store.admit(
      { kind: 'active_window', source: 'host_report', scope: conversation('c1'), content: 'x' },
      T0,
    )
    expect(bare.ok).toBe(false)
    if (bare.ok) throw new Error('expected a refusal')
    expect(bare.code).toBe('origin_required')
  })
})

describe('declared-but-unsourced kinds fail truthfully', () => {
  it('refuses workforce agent-work context by name', () => {
    const store = sequencedStore()
    const result = store.admit(
      {
        kind: 'agent_work',
        source: 'host_report',
        originId: 'w-1',
        scope: conversation('c1'),
        content: 'x',
      },
      T0,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('kind_deferred')
  })

  it('refuses a kind it has never heard of', () => {
    const store = sequencedStore()
    const result = store.admit(fileSpec({ kind: 'screen' as AnyContextKind }), T0)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.code).toBe('kind_unknown')
  })
})

describe('bounded size, TTL and retention', () => {
  it('clamps a TTL above the ceiling instead of honouring it', () => {
    const store = sequencedStore()
    const item = admitOrThrow(store, fileSpec({ ttlMs: 60 * 60_000 }))
    expect(item.expiresAt).toBe(at(CONTEXT_LIMITS.maxTtlMs).toISOString())
  })

  it('refuses a time to live that is not a positive duration', () => {
    const store = sequencedStore()
    for (const ttlMs of [0, -1_000]) {
      const result = store.admit(fileSpec({ ttlMs }), T0)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.code).toBe('invalid_ttl')
    }
  })

  it('bounds content, label and empty content', () => {
    const store = sequencedStore()

    const tooBig = store.admit(fileSpec({ content: 'x'.repeat(CONTEXT_LIMITS.maxContentChars + 1) }), T0)
    expect(tooBig.ok).toBe(false)
    if (tooBig.ok) throw new Error('expected a refusal')
    expect(tooBig.code).toBe('content_too_large')

    const blank = store.admit(fileSpec({ content: '   ' }), T0)
    expect(blank.ok).toBe(false)
    if (blank.ok) throw new Error('expected a refusal')
    expect(blank.code).toBe('content_empty')

    const longLabel = store.admit(fileSpec({ label: 'x'.repeat(CONTEXT_LIMITS.maxLabelChars + 1) }), T0)
    expect(longLabel.ok).toBe(false)
    if (longLabel.ok) throw new Error('expected a refusal')
    expect(longLabel.code).toBe('label_too_large')
  })

  it('lets a caller lower a ceiling and never raise one', () => {
    expect(contextLimits({ maxContentChars: 10 }).maxContentChars).toBe(10)

    const raised = contextLimits({ maxContentChars: 1_000_000, maxItems: 1_000_000 })
    expect(raised.maxContentChars).toBe(CONTEXT_LIMITS.maxContentChars)
    expect(raised.maxItems).toBe(CONTEXT_LIMITS.maxItems)

    // A lowered store enforces the lowered value; a store asked for a higher
    // one still refuses past the code-owned ceiling.
    const small = sequencedStore({ limits: { maxContentChars: 10 } })
    expect(small.admit(fileSpec({ content: '01234567890' }), T0).ok).toBe(false)

    const greedy = sequencedStore({ limits: { maxContentChars: 1_000_000 } })
    expect(greedy.admit(fileSpec({ content: 'x'.repeat(4_001) }), T0).ok).toBe(false)
  })

  it('holds the total retention bound and drops the oldest record', () => {
    const store = sequencedStore({ limits: { maxItems: 3 } })
    const ids: string[] = []
    for (const n of ['a', 'b', 'c']) {
      ids.push(admitOrThrow(store, fileSpec({ scope: conversation(`c-${n}`), content: `content ${n}` })).contextId)
    }

    const fourth = store.admit(
      fileSpec({ scope: conversation('c-d'), content: 'content d' }),
      T0,
    )
    expect(fourth.ok).toBe(true)
    if (!fourth.ok) throw new Error('expected admission')
    // The oldest record is the one that goes, and it is reported rather than
    // vanishing silently.
    expect(fourth.evicted).toEqual([ids[0]])
    expect(store.retained).toBe(3)
    expect(store.audit(T0).map((row) => row.contextId)).toEqual([ids[1], ids[2], fourth.item.contextId])
  })

  it('bounds live items per scope without counting tombstones against it', () => {
    const store = sequencedStore({ limits: { maxLivePerScope: 2 } })
    const first = admitOrThrow(store, fileSpec({ content: 'first' }))
    const second = admitOrThrow(store, fileSpec({ content: 'second' }))

    const third = store.admit(fileSpec({ content: 'third' }), T0)
    expect(third.ok).toBe(true)
    if (!third.ok) throw new Error('expected admission')
    expect(third.evicted).toEqual([first.contextId])

    // What is already revoked is already gone: a tombstone must not stop a
    // scope from receiving new context.
    expect(store.revoke(second.contextId, 'superseded', at(1))).toBe(true)
    const fourth = store.admit(fileSpec({ content: 'fourth' }), at(2))
    expect(fourth.ok).toBe(true)
    if (!fourth.ok) throw new Error('expected admission')
    expect(fourth.evicted).toEqual([])
  })

  it('gives every scope its own live bound', () => {
    const store = sequencedStore({ limits: { maxLivePerScope: 1 } })
    admitOrThrow(store, fileSpec({ scope: conversation('c1') }))
    // A different scope has its own room; only c1 is at its bound.
    const other = store.admit(fileSpec({ scope: conversation('c2') }), T0)
    expect(other.ok).toBe(true)
    if (!other.ok) throw new Error('expected admission')
    expect(other.evicted).toEqual([])
  })

  it('admits the same request to the same bytes every time', () => {
    const spec = fileSpec({ ttlMs: 60_000, originId: 'o-1', capturedAt: T0.toISOString() })
    const first = new ContextStore({ newId: () => 'fixed-1' }).admit(spec, T0)
    const second = new ContextStore({ newId: () => 'fixed-1' }).admit(spec, T0)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})

describe('scope validity', () => {
  it('refuses a scope that is not a usable scope', () => {
    const store = sequencedStore()
    const empty = store.admit(fileSpec({ scope: conversation('') }), T0)
    expect(empty.ok).toBe(false)
    if (empty.ok) throw new Error('expected a refusal')
    expect(empty.code).toBe('invalid_scope')

    const wrongKind = store.admit(
      fileSpec({ scope: { scopeKind: 'browser', scopeId: 'b1' } as never }),
      T0,
    )
    expect(wrongKind.ok).toBe(false)
    if (wrongKind.ok) throw new Error('expected a refusal')
    expect(wrongKind.code).toBe('invalid_scope')

    const tooLong = store.admit(fileSpec({ scope: conversation('x'.repeat(129)) }), T0)
    expect(tooLong.ok).toBe(false)
    if (tooLong.ok) throw new Error('expected a refusal')
    expect(tooLong.code).toBe('invalid_scope')
  })

  it('refuses a malformed active scope rather than pointing "here" at it', () => {
    const store = sequencedStore()
    expect(store.setActiveScope(conversation(''))).toBe(false)
    expect(store.activeScope).toBeNull()
    expect(store.setActiveScope(surface('s1'))).toBe(true)
    expect(store.activeScope).toEqual({ scopeKind: 'surface', scopeId: 's1' })
  })
})
