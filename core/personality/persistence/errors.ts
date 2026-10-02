/**
 * PERSONALITY PERSISTENCE FAILURES.
 *
 * One error class and one closed code table, kept in their own file so the port
 * can name a failure without importing an adapter — a caller can catch a
 * `PersonalityPersistenceError` without this directory's crypto or filesystem
 * having been loaded.
 *
 * ## A Personality fault is not a security event
 *
 * Losing personality data cannot grant cognition, clear a stop, widen a budget
 * or lock Freya out, and it is not treated as one. The failure is a *data*
 * fact, reported in words, confined to the data that is missing, and nothing
 * else in Core changes because of it.
 *
 * What it does do is refuse loudly. Every code here means "this store will not
 * pretend": it will not serve records it could not authenticate, and it will
 * not write a snapshot built from a partial view of the file.
 */

/**
 * Why persistence could not do what was asked.
 *
 * Each code is a different fact, because the fixes are different:
 *
 *  - `unavailable` — the storage could not be opened, read or written.
 *  - `unauthenticated` — the bytes did not open with this key.
 *  - `corrupt` — the plaintext opened but is not a legal Personality snapshot.
 *  - `degraded` — the port is damaged, so it serves nothing and writes nothing.
 *  - `closed` — the port was released.
 *  - `write_failed` — the commit itself failed.
 *  - `too_large` — the snapshot exceeds a ceiling this build refuses to exceed.
 *  - `invalid` — a caller handed this something that is not a snapshot.
 */
export const PERSONALITY_PERSISTENCE_ERROR_CODES = [
  'unavailable',
  'unauthenticated',
  'corrupt',
  'degraded',
  'closed',
  'write_failed',
  'too_large',
  'invalid',
] as const

export type PersonalityPersistenceErrorCode = (typeof PERSONALITY_PERSISTENCE_ERROR_CODES)[number]

/**
 * A Personality persistence failure, in words.
 *
 * Not a security event, and never allowed to become one. The message is
 * written to be shown to a person, because the only useful response to
 * "personality data is not being kept" is knowing which of eight things went
 * wrong.
 */
export class PersonalityPersistenceError extends Error {
  constructor(
    readonly code: PersonalityPersistenceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PersonalityPersistenceError'
  }
}

/** A fault is described, never swallowed, and never guessed at from a message. */
export function isPersonalityPersistenceError(error: unknown): error is PersonalityPersistenceError {
  return error instanceof PersonalityPersistenceError
}
