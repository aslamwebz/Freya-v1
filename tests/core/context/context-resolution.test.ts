// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ContextStore } from '../../../core/context/store'
import type {
  AnyContextKind,
  ContextAdmission,
  ContextItem,
  ContextResolution,
  ContextTerm,
} from '../../../core/context/types'
import {
  T0,
  admitOrThrow,
  at,
  conversation,
  sequencedStore,
  sessionScope,
  surface,
} from './fixture'

/**
 * Resolution: what "this" and "here" may point at.
 *
 * Every test here is about the same property from a different angle: the
 * resolver answers only when the answer is forced. A tie is not broken by
 * recency, an expired item is not quietly dropped in favour of a live one from
 * another conversation, and a scope boundary is checked before candidacy so an
 * item from elsewhere is not even a candidate. Refusals carry ids and a
 * reason — never content.
 */

function spec(overrides: Partial<ContextAdmission> = {}): ContextAdmission {
  return {
    kind: 'file',
    source: 'owner_selection',
    scope: conversation('c1'),
    content: 'the shared content',
    label: 'shared.txt',
    ...overrides,
  }
}

function readyStore(): ContextStore {
  const store = sequencedStore()
  store.setActiveScope(conversation('c1'))
  return store
}

function refusal(resolution: ContextResolution): { reason: string; candidateIds: readonly string[] } {
  if (resolution.ok) throw new Error('expected a refusal, got a resolution')
  return resolution
}

function admitMany(store: ContextStore, count: number, overrides: Partial<ContextAdmission> = {}): ContextItem[] {
  const items: ContextItem[] = []
  for (let i = 0; i < count; i += 1) {
    items.push(admitOrThrow(store, spec({ content: `content ${i}`, ...overrides })))
  }
  return items
}

describe('a unique live match resolves', () => {
  it('answers "this" with the only item in scope', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())

    const resolution = store.resolve({ term: 'this' }, T0)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.reason)
    expect(resolution.item.contextId).toBe(item.contextId)
  })

  it('answers "here" with the only item in scope', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec({ kind: 'shared_tab', source: 'owner_share' }))
    const resolution = store.resolve({ term: 'here' }, T0)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.reason)
    expect(resolution.item.contextId).toBe(item.contextId)
  })

  it('narrows by kind, so "this file" is not confused with a tab', () => {
    const store = readyStore()
    const file = admitOrThrow(store, spec())
    admitOrThrow(store, spec({ kind: 'shared_tab', source: 'owner_share', content: 'a shared tab' }))

    const broad = store.resolve({ term: 'this' }, T0)
    expect(refusal(broad).reason).toBe('ambiguous')

    const narrowed = store.resolve({ term: 'this', kind: 'file' }, T0)
    expect(narrowed.ok).toBe(true)
    if (!narrowed.ok) throw new Error(narrowed.reason)
    expect(narrowed.item.contextId).toBe(file.contextId)
  })

  it('resolves session-scoped context from any current scope', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec({ scope: sessionScope(), content: 'pinned for the session' }))

    const resolution = store.resolve({ term: 'here' }, T0)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.reason)
    expect(resolution.item.contextId).toBe(item.contextId)
  })
})

describe('ambiguity fails truthfully rather than guessing', () => {
  it('refuses when two live items match, and names both', () => {
    const store = readyStore()
    const items = admitMany(store, 2)

    const resolution = store.resolve({ term: 'this', kind: 'file' }, T0)
    const failure = refusal(resolution)
    expect(failure.reason).toBe('ambiguous')
    expect(failure.candidateIds).toEqual([items[0]?.contextId, items[1]?.contextId])
    // Nothing was chosen: the verdict has no item to hand back.
    expect(resolution).not.toHaveProperty('item')
  })

  it('never breaks the tie with recency', () => {
    // A newer match is still a guess about which one was meant, so the
    // verdict must not depend on admission order beyond listing ids.
    const store = readyStore()
    admitOrThrow(store, spec({ content: 'older' }))
    admitOrThrow(store, spec({ content: 'newer' }), at(60_000))

    const atT0 = refusal(store.resolve({ term: 'this' }, T0))
    const later = refusal(store.resolve({ term: 'this' }, at(60_000)))
    expect(atT0.reason).toBe('ambiguous')
    expect(later.reason).toBe('ambiguous')
    expect(atT0.candidateIds).toEqual(later.candidateIds)
  })

  it('carries ids and a reason, and nothing that could be content', () => {
    const store = readyStore()
    admitMany(store, 2)
    const resolution = store.resolve({ term: 'here' }, T0)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(Object.keys(resolution).sort()).toEqual(['candidateIds', 'ok', 'reason'])
  })
})

describe('no match, said precisely', () => {
  it('says no_candidates when nothing was ever shared here', () => {
    const store = readyStore()
    expect(refusal(store.resolve({ term: 'this' }, T0)).reason).toBe('no_candidates')
  })

  it('fails closed when no scope is current', () => {
    const store = sequencedStore()
    admitOrThrow(store, spec())
    expect(store.activeScope).toBeNull()
    expect(refusal(store.resolve({ term: 'here' }, T0)).reason).toBe('no_active_scope')
    expect(store.list(T0)).toEqual([])
  })

  it('names a deferred kind instead of reporting no match', () => {
    const store = readyStore()
    expect(
      refusal(store.resolve({ term: 'this', kind: 'active_window' as AnyContextKind }, T0)).reason,
    ).toBe('kind_deferred')
    expect(
      refusal(store.resolve({ term: 'this', kind: 'agent_work' as AnyContextKind }, T0)).reason,
    ).toBe('kind_deferred')
  })

  it('refuses a reference it does not understand', () => {
    const store = readyStore()
    admitOrThrow(store, spec())
    expect(
      refusal(store.resolve({ term: 'that' as ContextTerm }, T0)).reason,
    ).toBe('invalid_reference')
    expect(
      refusal(store.resolve({ term: 'this', kind: 'screen' as AnyContextKind }, T0)).reason,
    ).toBe('invalid_reference')
  })

  it('refuses an unusable instant rather than judging everything live', () => {
    const store = readyStore()
    admitOrThrow(store, spec())
    expect(refusal(store.resolve({ term: 'this' }, new Date(Number.NaN))).reason).toBe(
      'invalid_clock',
    )
  })
})

describe('expired and revoked context cannot resolve', () => {
  it('reports expiry as expiry, with the id of what expired', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec({ ttlMs: 1_000 }))

    expect(store.resolve({ term: 'this' }, at(999)).ok).toBe(true)

    const failure = refusal(store.resolve({ term: 'this' }, at(1_000)))
    expect(failure.reason).toBe('expired')
    expect(failure.candidateIds).toEqual([item.contextId])
    expect(store.list(at(1_000))).toEqual([])
  })

  it('reports revocation as revocation, with the id of what was taken back', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())
    expect(store.revoke(item.contextId, 'the owner stopped sharing', at(10))).toBe(true)

    const failure = refusal(store.resolve({ term: 'this' }, at(11)))
    expect(failure.reason).toBe('revoked')
    expect(failure.candidateIds).toEqual([item.contextId])
  })

  it('lets a revocation speak for itself even after the TTL has passed', () => {
    // A person took it back. The clock running out afterwards does not turn
    // that into an expiry.
    const store = readyStore()
    const item = admitOrThrow(store, spec({ ttlMs: 1_000 }))
    store.revoke(item.contextId, 'taken back', T0)

    const failure = refusal(store.resolve({ term: 'this' }, at(2_000)))
    expect(failure.reason).toBe('revoked')
    expect(failure.candidateIds).toEqual([item.contextId])
  })
})

describe('scope is a wall', () => {
  it('does not resolve another conversation\'s context', () => {
    const store = sequencedStore()
    const secret = 'projected revenue for the acquisition'
    const elsewhere = admitOrThrow(store, spec({ scope: conversation('other'), content: secret }))
    store.setActiveScope(conversation('c1'))

    const failure = refusal(store.resolve({ term: 'this' }, T0))
    expect(failure.reason).toBe('no_candidates')
    // Not even the id crosses: scope is checked before candidacy.
    expect(failure.candidateIds).toEqual([])
    expect(JSON.stringify(store.list(T0))).not.toContain(secret)
    expect(JSON.stringify(store.resolve({ term: 'this' }, T0))).not.toContain(secret)
    expect(elsewhere.scope.scopeId).toBe('other')
  })

  it('does not resolve a conversation\'s context while the session is current', () => {
    const store = sequencedStore()
    admitOrThrow(store, spec({ scope: conversation('c1') }))
    store.setActiveScope(sessionScope())

    // A narrower scope is more private, not less: the broad scope does not
    // contain it.
    expect(refusal(store.resolve({ term: 'this' }, T0)).reason).toBe('no_candidates')
    expect(store.list(T0)).toEqual([])
  })

  it('resolves a surface share only while that surface is current', () => {
    const store = sequencedStore()
    const tab = admitOrThrow(
      store,
      spec({ kind: 'shared_tab', source: 'owner_share', scope: surface('s1'), content: 'shared page' }),
    )

    store.setActiveScope(surface('s1'))
    const here = store.resolve({ term: 'here' }, T0)
    expect(here.ok).toBe(true)
    if (!here.ok) throw new Error(here.reason)
    expect(here.item.contextId).toBe(tab.contextId)

    store.setActiveScope(conversation('c1'))
    expect(refusal(store.resolve({ term: 'here' }, T0)).reason).toBe('no_candidates')
  })
})

describe('determinism', () => {
  it('gives byte-identical verdicts for the same state and instant', () => {
    const build = (): ContextStore => {
      const store = readyStore()
      admitOrThrow(store, spec({ content: 'one' }))
      admitOrThrow(store, spec({ content: 'two' }))
      return store
    }

    const first = build().resolve({ term: 'this' }, T0)
    const second = build().resolve({ term: 'this' }, T0)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.ok).toBe(false)

    const store = build()
    const again = store.resolve({ term: 'this' }, T0)
    expect(JSON.stringify(store.resolve({ term: 'this' }, T0))).toBe(JSON.stringify(again))
  })

  it('lists in a stable order', () => {
    const store = readyStore()
    admitOrThrow(store, spec({ content: 'first' }))
    admitOrThrow(store, spec({ content: 'second' }))

    const ids = () => store.list(T0).map((item) => item.contextId)
    expect(ids()).toEqual(ids())
    // Presentation is newest-first; resolution never uses this order to choose.
    expect(ids()[0]).toBe('t-2')
  })
})
