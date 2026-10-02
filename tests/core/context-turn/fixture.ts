// @vitest-environment node

import { ContextStore, type ContextStoreOptions } from '../../../core/context/store'
import type { ContextAdmission, ContextItem, ContextScope } from '../../../core/context/types'
import type { TurnContextRequest, TurnContextSource } from '../../../core/mind/turn-context'

/**
 * Shared fixtures for the turn Context suite.
 *
 * One fixed instant and an injected id factory, so an expectation can name a record
 * and an expiry rather than approximating one. Nothing here reads a clock, which is
 * also the point: neither the Context domain nor the turn compiler reads one, and a
 * test that supplied `new Date()` would be testing a different system.
 */
export const T0 = new Date('2026-06-01T09:00:00.000Z')

export function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs)
}

export function conversation(scopeId = 'c1'): ContextScope {
  return { scopeKind: 'conversation', scopeId }
}

export function surface(scopeId = 's1'): ContextScope {
  return { scopeKind: 'surface', scopeId }
}

export function sessionScope(): ContextScope {
  return { scopeKind: 'session', scopeId: 'session' }
}

/** A store whose ids are `t-1`, `t-2`, … so a test can name its records. */
export function sequencedStore(options: ContextStoreOptions = {}): ContextStore {
  let next = 0
  return new ContextStore({
    newId: () => {
      next += 1
      return `t-${next}`
    },
    ...options,
  })
}

/** Admit, or fail the test with the refusal's own words. */
export function admitOrThrow(
  store: ContextStore,
  spec: ContextAdmission,
  now: Date = T0,
): ContextItem {
  const result = store.admit(spec, now)
  if (!result.ok) throw new Error(`admission refused (${result.code}): ${result.reason}`)
  return result.item
}

/** A file the owner selected, which is the ordinary case in these tests. */
export function fileSpec(overrides: Partial<ContextAdmission> = {}): ContextAdmission {
  return {
    kind: 'file',
    source: 'owner_selection',
    scope: conversation(),
    content: 'the licence renewal is on Friday',
    label: 'licence.txt',
    ...overrides,
  }
}

export interface RecordingSource extends TurnContextSource {
  /** How many times the compiler asked the source anything at all. */
  readonly calls: number
  /** How many of those were reference resolutions. */
  readonly resolutions: number
  /** Every turn handed to the compiler, in order. */
  readonly requests: readonly TurnContextRequest[]
}

/**
 * The real store behind a counting face.
 *
 * The counters exist so that "zero idle calls" and "one compile per turn" are
 * measurements rather than claims. The store underneath is the production
 * `ContextStore`, unmodified — nothing here re-implements resolution to make a test
 * easier.
 */
export function recordingSource(store: ContextStore): RecordingSource {
  const state = { calls: 0, resolutions: 0, requests: [] as TurnContextRequest[] }
  return {
    get calls() {
      return state.calls
    },
    get resolutions() {
      return state.resolutions
    },
    get requests() {
      return state.requests
    },
    get activeScope() {
      return store.activeScope
    },
    list: (now: Date) => {
      state.calls += 1
      return store.list(now)
    },
    resolve: (reference, now: Date) => {
      state.calls += 1
      state.resolutions += 1
      return store.resolve(reference, now)
    },
  }
}

/** A store with one conversation already in scope. */
export function scopedStore(scope: ContextScope = conversation()): ContextStore {
  const store = sequencedStore()
  store.setActiveScope(scope)
  return store
}
