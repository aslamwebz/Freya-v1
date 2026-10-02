/**
 * Skill persistence failures, as closed codes.
 *
 * A code rather than a message because these are *decisions* the caller has to react
 * to differently: `unauthenticated` means never read this file again, `closed` means
 * the lifecycle is over, `too_large` means a body exceeded its bound, and
 * `write_failed` means the disk is unhappy. Collapsing them into one "storage error"
 * would make degraded and shut-down indistinguishable to a surface.
 */
export const SKILL_PERSISTENCE_ERROR_CODES = [
  'unavailable',
  'unauthenticated',
  'too_large',
  'write_failed',
  'invalid',
  'closed',
  'degraded',
] as const

export type SkillPersistenceErrorCode = (typeof SKILL_PERSISTENCE_ERROR_CODES)[number]

export class SkillPersistenceError extends Error {
  readonly code: SkillPersistenceErrorCode

  constructor(code: SkillPersistenceErrorCode, message: string) {
    super(message)
    this.name = 'SkillPersistenceError'
    this.code = code
  }
}

export function isSkillPersistenceError(error: unknown): error is SkillPersistenceError {
  return error instanceof SkillPersistenceError
}