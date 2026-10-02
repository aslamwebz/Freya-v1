import { ContextStore, type ContextStoreOptions } from '../../../core/context/store'
import type { ContextAdmission, ContextItem, ContextScope } from '../../../core/context/types'

/**
 * Shared fixtures for the context suite.
 *
 * One fixed instant and an injected id factory, so every expectation in these
 * tests can name a record and an expiry rather than approximating one. Nothing
 * here reads a clock, which is also the point: the domain under test never
 * reads one either.
 */
export const T0 = new Date('2026-06-01T09:00:00.000Z')

export function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs)
}

export function conversation(scopeId: string): ContextScope {
  return { scopeKind: 'conversation', scopeId }
}

export function surface(scopeId: string): ContextScope {
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
