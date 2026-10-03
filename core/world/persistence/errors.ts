/**
 * World-model persistence failures, as closed codes.
 *
 * A code rather than a message because these are *decisions* the caller has to
 * react to differently: `unauthenticated` means never read this file again,
 * `closed` means the lifecycle is over, `too_large` means a record exceeded its
 * bound, and `write_failed` means the disk is unhappy. Collapsing them into one
 * "storage error" would make degraded and shut-down indistinguishable to a
 * surface — and for a store holding claims about people's lives, those are very
 * different things to be told.
 */
export const WORLD_PERSISTENCE_ERROR_CODES = [
  'unavailable',
  'unauthenticated',
  'too_large',
  'write_failed',
  'invalid',
  'closed',
  'degraded',
] as const

export type WorldPersistenceErrorCode = (typeof WORLD_PERSISTENCE_ERROR_CODES)[number]

export class WorldPersistenceError extends Error {
  readonly code: WorldPersistenceErrorCode

  constructor(code: WorldPersistenceErrorCode, message: string) {
    super(message)
    this.name = 'WorldPersistenceError'
    this.code = code
  }
}

export function isWorldPersistenceError(error: unknown): error is WorldPersistenceError {
  return error instanceof WorldPersistenceError
}