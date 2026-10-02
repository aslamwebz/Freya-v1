// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { contextItemState, retireContextItem } from '../../../core/context/item'
import type { ContextStore } from '../../../core/context/store'
import type { ContextAdmission } from '../../../core/context/types'
import { T0, admitOrThrow, at, conversation, sequencedStore, surface } from './fixture'

/**
 * Lifecycle: TTL, revocation and bounded retention.
 *
 * The rule under test is that *retirement destroys the private part*. Both
 * paths — a clock reaching a deadline and a person taking something back —
 * end in emptied content with the measured lengths kept, so audit can still
 * say how big the thing was without holding a single character of it. A flag
 * would have left the words in memory for the next mistake to find.
 */

const SECRET = 'my passport number is XX000000 and the code is 4417'

function spec(overrides: Partial<ContextAdmission> = {}): ContextAdmission {
  return {
    kind: 'explicit_selection',
    source: 'owner_selection',
    scope: conversation('c1'),
    content: SECRET,
    label: 'passport application.txt',
    uri: 'file:///home/owner/documents/passport.txt',
    ...overrides,
  }
}

function readyStore(): ContextStore {
  const store = sequencedStore()
  store.setActiveScope(conversation('c1'))
  return store
}

/** Everything this store would currently hand to anybody, as text. */
function reachable(store: ContextStore, now: Date): string {
  return JSON.stringify({
    list: store.list(now),
    audit: store.audit(now),
    this: store.resolve({ term: 'this' }, now),
    here: store.resolve({ term: 'here' }, now),
  })
}

describe('retirement destroys the private part', () => {
  it('empties content, label and reference while keeping the measurements', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())

    const retired = retireContextItem(item)
    expect(retired.content).toBe('')
    expect(retired.label).toBe('')
    expect(retired.uri).toBeNull()
    expect(retired.contentLength).toBe(SECRET.length)
    expect(retired.labelLength).toBe('passport application.txt'.length)
    expect(JSON.stringify(retired)).not.toContain('passport')
    expect(JSON.stringify(retired)).not.toContain('XX000000')
    expect(JSON.stringify(retired)).not.toContain('4417')
    // The live item is untouched: destruction happens on the way out.
    expect(item.content).toBe(SECRET)
    expect(contextItemState(item, T0)).toBe('live')
  })
})

describe('TTL expiry', () => {
  it('stops resolving at the deadline and says expired', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec({ ttlMs: 2_000 }))

    const before = store.resolve({ term: 'this' }, at(1_999))
    expect(before.ok).toBe(true)

    const after = store.resolve({ term: 'this' }, at(2_000))
    if (after.ok) throw new Error('expected expiry')
    expect(after.reason).toBe('expired')
    expect(after.candidateIds).toEqual([item.contextId])
  })

  it('destroys the content the first time anything looks after the deadline', () => {
    const store = readyStore()
    admitOrThrow(store, spec({ ttlMs: 2_000 }))

    // Expiry is not a filter applied at read time: observing the store retires
    // the record, and the words stop existing.
    store.audit(at(3_000))

    expect(reachable(store, at(3_000))).not.toContain('XX000000')
    expect(reachable(store, at(3_000))).not.toContain('passport application.txt')

    const rows = store.audit(at(3_000))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'expired',
      contentLength: SECRET.length,
      labelLength: 'passport application.txt'.length,
    })
    expect(JSON.stringify(rows)).not.toContain('XX000000')
  })

  it('keeps an expired record out of the list without being asked', () => {
    const store = readyStore()
    admitOrThrow(store, spec({ ttlMs: 500 }))
    expect(store.list(at(501))).toEqual([])
    expect(store.list(T0)).toHaveLength(1)
  })

  it('leaves a tombstone that says the clock did it, not a person', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec({ ttlMs: 1_000 }))

    expect(store.tombstones(at(999))).toEqual([])
    expect(store.tombstones(at(1_000))).toEqual([
      {
        contextId: item.contextId,
        kind: 'explicit_selection',
        scope: { scopeKind: 'conversation', scopeId: 'c1' },
        admittedAt: T0.toISOString(),
        expiresAt: at(1_000).toISOString(),
        state: 'expired',
        revokedAt: null,
        reason: null,
      },
    ])
  })
})

describe('explicit revocation', () => {
  it('destroys the content and records why', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())

    expect(store.revoke(item.contextId, 'the owner stopped sharing this', T0)).toBe(true)

    const resolution = store.resolve({ term: 'this' }, at(1))
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('revoked')

    expect(reachable(store, at(1))).not.toContain('XX000000')
    expect(reachable(store, at(1))).not.toContain('passport application.txt')
    expect(reachable(store, at(1))).not.toContain('file:///')

    const [row] = store.audit(at(1))
    expect(row).toMatchObject({
      state: 'revoked',
      revokedAt: T0.toISOString(),
      contentLength: SECRET.length,
    })
    // The stated why is free text, so it is not part of the audit shape.
    expect(JSON.stringify(store.audit(at(1)))).not.toContain('the owner stopped sharing this')
    expect(store.tombstones(at(1))).toEqual([
      {
        contextId: item.contextId,
        kind: 'explicit_selection',
        scope: { scopeKind: 'conversation', scopeId: 'c1' },
        admittedAt: T0.toISOString(),
        expiresAt: item.expiresAt,
        state: 'revoked',
        revokedAt: T0.toISOString(),
        reason: 'the owner stopped sharing this',
      },
    ])
  })

  it('changes nothing the second time', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())
    expect(store.revoke(item.contextId, 'first reason', T0)).toBe(true)
    expect(store.revoke(item.contextId, 'second reason', at(1))).toBe(false)

    const [row] = store.audit(at(2))
    expect(row?.revokedAt).toBe(T0.toISOString())
    expect(store.tombstones(at(2))[0]?.reason).toBe('first reason')
  })

  it('refuses a reason that is empty or longer than the ceiling', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())

    expect(store.revoke(item.contextId, '   ', T0)).toBe(false)
    expect(store.revoke(item.contextId, 'x'.repeat(201), T0)).toBe(false)
    // Still live: a tombstone with no intelligible "why" is not worth making.
    expect(store.resolve({ term: 'this' }, T0).ok).toBe(true)
  })

  it('takes back a whole scope in one act, and only that scope', () => {
    const store = sequencedStore()
    store.setActiveScope(surface('s1'))
    const tabs = [0, 1, 2].map((i) =>
      admitOrThrow(
        store,
        spec({
          kind: 'shared_tab',
          source: 'owner_share',
          scope: surface('s1'),
          content: `shared page ${i}`,
        }),
      ),
    )
    const elsewhere = admitOrThrow(store, spec({ scope: conversation('c1'), content: 'other chat' }))

    expect(store.revokeScope(surface('s1'), 'the owner closed the share', T0)).toBe(3)

    const after = store.resolve({ term: 'here' }, at(1))
    if (after.ok) throw new Error('expected a refusal')
    expect(after.reason).toBe('revoked')
    expect(after.candidateIds).toEqual(tabs.map((tab) => tab.contextId))

    store.setActiveScope(conversation('c1'))
    const other = store.resolve({ term: 'this' }, at(1))
    expect(other.ok).toBe(true)
    if (!other.ok) throw new Error(other.reason)
    expect(other.item.contextId).toBe(elsewhere.contextId)

    // Revoking the surface again has nothing left to take back.
    expect(store.revokeScope(surface('s1'), 'again', at(2))).toBe(0)
  })

  it('never resurrects a revoked item, even after its record is purged', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())
    store.revoke(item.contextId, 'taken back', T0)

    expect(store.purge(at(1))).toEqual([item.contextId])
    expect(store.retained).toBe(0)

    const resolution = store.resolve({ term: 'this' }, at(2))
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('no_candidates')
    expect(reachable(store, at(2))).not.toContain('XX000000')
  })
})

describe('purge forgets metadata, never live context', () => {
  it('drops retired records and leaves live ones alone', () => {
    const store = readyStore()
    const doomed = admitOrThrow(store, spec({ content: SECRET }))
    const kept = admitOrThrow(store, spec({ content: 'the live selection' }))
    store.revoke(doomed.contextId, 'superseded', T0)

    expect(store.purge(at(1))).toEqual([doomed.contextId])
    expect(store.retained).toBe(1)

    const resolution = store.resolve({ term: 'this' }, at(2))
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.reason)
    expect(resolution.item.contextId).toBe(kept.contextId)
    expect(resolution.item.content).toBe('the live selection')
  })

  it('purges nothing when the instant is not a time', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())
    store.revoke(item.contextId, 'taken back', T0)
    expect(store.purge(new Date(Number.NaN))).toEqual([])
    expect(store.retained).toBe(1)
  })
})

describe('bounded retention holds under churn', () => {
  it('never exceeds the ceiling, whatever is admitted or revoked', () => {
    const store = sequencedStore({ limits: { maxItems: 4 } })
    store.setActiveScope(conversation('c1'))

    for (let i = 0; i < 12; i += 1) {
      const result = store.admit(
        spec({
          content: `${SECRET} ${i}`,
          scope: i % 3 === 0 ? conversation('c1') : surface(`s${i}`),
        }),
        at(i * 1_000),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.reason)
      expect(result.evicted.length).toBeLessThanOrEqual(1)
      expect(store.retained).toBeLessThanOrEqual(4)

      if (i % 4 === 3) store.purge(at(i * 1_000))
      if (i % 5 === 4 && result.ok) {
        store.revoke(result.item.contextId, 'churn', at(i * 1_000 + 1))
      }
    }

    expect(store.retained).toBeLessThanOrEqual(4)
    expect(store.audit(at(60_000)).length).toBe(store.retained)
  })
})

describe('an unusable instant changes nothing', () => {
  it('refuses revocation, purge, listing and audit rather than guessing', () => {
    const store = readyStore()
    const item = admitOrThrow(store, spec())
    const broken = new Date(Number.NaN)

    expect(store.revoke(item.contextId, 'because', broken)).toBe(false)
    expect(store.purge(broken)).toEqual([])
    expect(store.list(broken)).toEqual([])
    expect(store.audit(broken)).toEqual([])
    // Still resolvable with its content: nothing was judged from a bad clock.
    const resolution = store.resolve({ term: 'this' }, broken)
    if (resolution.ok) throw new Error('expected a refusal')
    expect(resolution.reason).toBe('invalid_clock')
    expect(store.resolve({ term: 'this' }, T0).ok).toBe(true)
  })
})
