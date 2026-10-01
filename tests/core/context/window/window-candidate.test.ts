// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ContextStore } from '../../../../core/context/store'
import { CONTEXT_LIMITS, type ContextAdmissionResult } from '../../../../core/context/types'
import {
  ACTIVE_WINDOW_SUPERSESSION_REASON,
  WindowObservationService,
  activeWindowCandidate,
  createActiveWindowAdmitter,
  type ActiveWindowInfo,
} from '../../../../core/context/sources/window'
import { T0, at, conversation, sequencedStore, sessionScope } from '../fixture'
import { FakeActiveWindowProvider } from './fakeProvider'

/**
 * THE CANDIDATE ADAPTER — from observation to a request the real store answers.
 *
 * This is the typed bridge issue #30 asked for: an active-window observation
 * crosses into Context only as a `ContextAdmission` naming the observation it
 * came from, admitted by the actual `ContextStore` so every provenance, size
 * and TTL rule enforced here is the domain's own, never a lane-local
 * re-reading of them. The properties worth naming: an observation carries no
 * uri and never an owner's voice (it is `host_report`, and reporting is not
 * doing); a request that the store refuses stays a refusal the caller can
 * see; and while windows change, the runtime holds *one* live active-window
 * item — the superseded one is revoked, content destroyed, so "here" resolves
 * instead of calcifying into `ambiguous`.
 */

function observation(overrides: Partial<ActiveWindowInfo> = {}): ActiveWindowInfo {
  const provider = new FakeActiveWindowProvider({ providerId: 'host-observer' })
  return provider.info(
    'Code Editor',
    'notes.md — Code Editor',
    T0.toISOString(),
    { observationId: 'obs-0001', ...overrides },
  )
}

function liveWindows(store: ContextStore): string[] {
  return store
    .list(T0)
    .filter((item) => item.kind === 'active_window')
    .map((item) => item.contextId)
}

describe('the candidate is typed and narrow', () => {
  it('names the kind, the only lawful source, and the observation behind it', () => {
    const candidate = activeWindowCandidate(observation(), sessionScope())
    expect(candidate.kind).toBe('active_window')
    expect(candidate.source).toBe('host_report')
    expect(candidate.originId).toBe('host-observer:obs-0001')
    expect(candidate.capturedAt).toBe(T0.toISOString())
    expect(candidate.scope).toEqual({ scopeKind: 'session', scopeId: 'session' })
  })

  it('carries no uri: an observation is not a permit', () => {
    const candidate = activeWindowCandidate(observation(), conversation('c1'))
    expect(candidate.uri).toBeNull()
    expect(candidate.content).toMatch(/no pixels/)
    expect(candidate.content).toMatch(/no control/)
  })

  it('bounds label and content inside the store ceilings before the door', () => {
    const monster = observation({ appName: 'A'.repeat(500), windowTitle: 'T'.repeat(400) })
    const candidate = activeWindowCandidate(monster, sessionScope())
    expect((candidate.label ?? '').length).toBeLessThanOrEqual(CONTEXT_LIMITS.maxLabelChars)
    expect(candidate.content.length).toBeLessThanOrEqual(CONTEXT_LIMITS.maxContentChars)
  })

  it('clamps a requested TTL to the domain ceiling and honours a smaller one', () => {
    const short = activeWindowCandidate(observation(), sessionScope(), { ttlMs: 5_000 })
    expect(short.ttlMs).toBe(5_000)
    const greedy = activeWindowCandidate(observation(), sessionScope(), {
      ttlMs: 10 * 60 * 60_000,
    })
    expect(greedy.ttlMs).toBe(CONTEXT_LIMITS.maxTtlMs)
  })

  it('the store itself keeps the kind host-only and origin-required', () => {
    const store = sequencedStore()
    const claimed = store.admit(
      { ...activeWindowCandidate(observation(), conversation('c1')), source: 'owner_share' },
      T0,
    )
    expect(claimed.ok).toBe(false)
    if (claimed.ok) throw new Error('expected refusal')
    expect(claimed.code).toBe('source_not_permitted')

    const bare = store.admit(
      { ...activeWindowCandidate(observation(), conversation('c1')), originId: null },
      T0,
    )
    expect(bare.ok).toBe(false)
    if (bare.ok) throw new Error('expected refusal')
    expect(bare.code).toBe('origin_required')
  })
})

describe('the real store answers the candidate', () => {
  it('admits a host-reported active window and expires it on its TTL', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const admitted = store.admit(
      activeWindowCandidate(observation(), conversation('c1'), { ttlMs: 60_000 }),
      T0,
    )
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) throw new Error('expected admission')
    expect(admitted.item.kind).toBe('active_window')
    expect(admitted.item.provenance.source).toBe('host_report')
    expect(admitted.item.provenance.originId).toBe('host-observer:obs-0001')
    expect(admitted.item.expiresAt).toBe(at(60_000).toISOString())
    expect(admitted.item.uri).toBeNull()

    expect(store.resolve({ term: 'this', kind: 'active_window' }, T0).ok).toBe(true)

    const later = store.resolve({ term: 'this', kind: 'active_window' }, at(60_000))
    expect(later.ok).toBe(false)
    if (later.ok) throw new Error('expected expiry')
    expect(later.reason).toBe('expired')
    expect(store.tombstones(at(60_000)).map((row) => row.state)).toEqual(['expired'])
  })

  it('two live active-window items refuse as ambiguous — why the runtime supersedes', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    store.admit(activeWindowCandidate(observation(), conversation('c1')), T0)
    store.admit(
      activeWindowCandidate(observation({ observationId: 'obs-0002' }), conversation('c1')),
      T0,
    )
    const ambiguous = store.resolve({ term: 'this', kind: 'active_window' }, T0)
    expect(ambiguous.ok).toBe(false)
    if (ambiguous.ok) throw new Error('expected ambiguity')
    expect(ambiguous.reason).toBe('ambiguous')
  })
})

describe('the admission runtime holds one window at a time', () => {
  it('admits the first observation and takes the superseded one back', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const admit = createActiveWindowAdmitter({
      sink: store,
      scope: conversation('c1'),
      clock: () => T0,
    })

    const first = admit(observation(), T0)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected admission')

    const second = admit(observation({ observationId: 'obs-0002' }), T0)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected admission')
    expect(second.item.contextId).not.toBe(first.item.contextId)

    expect(liveWindows(store)).toEqual([second.item.contextId])
    const superseded = store.tombstones(T0).find((row) => row.contextId === first.item.contextId)
    expect(superseded?.state).toBe('revoked')
    expect(superseded?.reason).toBe(ACTIVE_WINDOW_SUPERSESSION_REASON)
  })

  it('a refusal is returned, not swallowed, and the previous state stands', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const admit = createActiveWindowAdmitter({
      sink: store,
      scope: conversation('c1'),
      clock: () => T0,
    })
    const first = admit(observation(), T0)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected admission')

    const refused = admit(
      observation({
        observationId: 'obs-0002',
        observedAt: at(60_000).toISOString(),
      }),
      T0,
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected refusal')
    expect(refused.code).toBe('invalid_instant')
    expect(liveWindows(store)).toEqual([first.item.contextId])
  })

  it('end to end: fake provider, service, adapter, real store — zero model calls', () => {
    const provider = new FakeActiveWindowProvider({ providerId: 'host-observer' })
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const admit = createActiveWindowAdmitter({
      sink: store,
      scope: conversation('c1'),
      clock: () => T0,
    })
    const admitted: ContextAdmissionResult[] = []
    const service = new WindowObservationService({
      provider,
      clock: () => T0,
      timer: null,
      ttlMs: 60_000,
      onObservation: (info) => {
        admitted.push(admit(info, T0))
      },
    })

    provider.queue(provider.info('Code Editor', 'notes.md', T0.toISOString()))
    expect(service.start()).toBe('observed')
    expect(liveWindows(store)).toHaveLength(1)

    provider.queue(provider.info('Browser', 'Search results', T0.toISOString()))
    service.poll()
    expect(liveWindows(store)).toHaveLength(1)

    const resolved = store.resolve({ term: 'this', kind: 'active_window' }, T0)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.item.kind).toBe('active_window')
      expect(resolved.item.provenance.source).toBe('host_report')
      expect(resolved.item.provenance.originId).toBe('host-observer:obs-0002')
    }

    // The window nobody re-observed retires on the item's own TTL, and the
    // superseded one came back revoked — both retirements are inspectable,
    // and the refusal wording keeps the documented order: a human act
    // outranks the clock when both have happened.
    expect(admitted.every((result) => result.ok)).toBe(true)
    const gone = store.resolve({ term: 'this', kind: 'active_window' }, at(CONTEXT_LIMITS.maxTtlMs))
    expect(gone.ok).toBe(false)
    if (gone.ok) throw new Error('expected a refusal')
    expect(gone.reason).toBe('revoked')
    const states = store
      .tombstones(at(CONTEXT_LIMITS.maxTtlMs))
      .filter((row) => row.kind === 'active_window')
      .map((row) => row.state)
      .sort()
    expect(states).toEqual(['expired', 'revoked'])

    // and everything that happened was counted provider I/O, never inference
    expect(provider.calls).toMatchObject({ availability: 3, reads: 2, subscribe: 1 })
  })
})
