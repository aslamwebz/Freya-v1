/**
 * CONTEXT PERSISTENCE FAILURES.
 *
 * One error class and one closed code table, kept in their own file so the port
 * can name a failure without importing an adapter — a caller can catch a
 * `ContextPersistenceError` without this directory's crypto or filesystem
 * having been loaded.
 *
 * ## A Context fault is not a security event
 *
 * Losing context cannot grant cognition, clear a stop, widen a budget or lock
 * Freya out, and it is not treated as one. This is the same line the Mission
 * content store and the conversation store draw: the failure is a *data* fact,
 * reported in words, confined to the data that is missing, and nothing else in
 * Core changes because of it. Nothing outside `core/context/persistence/`
 * imports this module, so a Context fault cannot reach another subsystem even
 * by accident.
 *
 * What it does do is refuse loudly. Every code here means "this store will not
 * pretend": it will not serve records it could not authenticate, and it will not
 * write a snapshot built from a partial view of the file.
 */

/**
 * Why persistence could not do what was asked.
 *
 * Each code is a different fact, because the fixes are different:
 *
 *  - `unavailable` — the storage could not be opened, read or written. A disk,
 *    a permission, a directory that is not one.
 *  - `unauthenticated` — the bytes did not open with this key. Either the wrong
 *    key or the file was altered; Core cannot tell those apart and does not try.
 *  - `corrupt` — the plaintext opened but is not a legal Context snapshot. A
 *    record that authenticates can still be nonsense, and nonsense is refused
 *    rather than coerced into shape.
 *  - `degraded` — the port is damaged, so it serves nothing and writes nothing.
 *  - `closed` — the port was released.
 *  - `write_failed` — the commit itself failed.
 *  - `too_large` — the snapshot exceeds a ceiling this build refuses to exceed.
 *  - `invalid` — a caller handed this something that is not a snapshot.
 */
export const CONTEXT_PERSISTENCE_ERROR_CODES = [
  'unavailable',
  'unauthenticated',
  'corrupt',
  'degraded',
  'closed',
  'write_failed',
  'too_large',
  'invalid',
] as const

export type ContextPersistenceErrorCode = (typeof CONTEXT_PERSISTENCE_ERROR_CODES)[number]

/**
 * A Context persistence failure, in words.
 *
 * Not a security event, and never allowed to become one: nothing here widens a
 * capability, clears a stop or changes a decision. The message is written to be
 * shown to a person, because the only useful response to "context is not being
 * kept" is knowing which of eight things went wrong.
 */
export class ContextPersistenceError extends Error {
  constructor(
    readonly code: ContextPersistenceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ContextPersistenceError'
  }
}

/** A fault is described, never swallowed, and never guessed at from a message. */
export function isContextPersistenceError(error: unknown): error is ContextPersistenceError {
  return error instanceof ContextPersistenceError
}