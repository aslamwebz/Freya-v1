import type {
  CognitionCause,
  CognitionOrigin,
  PrincipalId,
} from '../protocol/core-protocol'

/**
 * A finite, durable authorisation to think.
 *
 * A grant never implies unlimited inference. It carries a hard ceiling on calls
 * and on output tokens, and usage is durable so a restart cannot reset it to
 * zero.
 *
 * The invariant that shapes the shape of this record: **a child worker receives
 * a part of its parent's budget, never a new budget.** `parentGrantId` exists
 * so that a future split is a division of a parent's remaining allowance rather
 * than a fresh allocation.
 */
export interface CognitionGrant {
  id: string
  createdBy: PrincipalId
  createdAt: string
  /** An absolute instant. Grants expire; there is no "until further notice". */
  expiresAt: string

  /** The grant is good for these origins only. */
  allowedOrigins: readonly CognitionOrigin[]
  /** ...and for these causes only. */
  allowedCauses: readonly CognitionCause[]

  /** Optional narrowing. Present now so future scoping has a home. */
  goalId: string | null
  runId: string | null
  actor: PrincipalId | null

  /** Whether this grant covers unattended work. Default intent is no. */
  backgroundAllowed: boolean

  /** Hard ceilings. Neither may be infinite. */
  maxCalls: number
  maxOutputTokens: number

  /** Durable consumption. Rebuilt by replay, never reset on restart. */
  usage: CognitionGrantUsage

  revokedAt: string | null
  revokedBy: PrincipalId | null

  /** Set when this grant was divided out of a parent. */
  parentGrantId: string | null
}

export interface CognitionGrantUsage {
  calls: number
  inputTokens: number | null
  outputTokens: number | null
}

export function emptyGrantUsage(): CognitionGrantUsage {
  return { calls: 0, inputTokens: null, outputTokens: null }
}

export function isGrantActive(grant: CognitionGrant, now: Date): boolean {
  if (grant.revokedAt !== null) return false
  return new Date(grant.expiresAt).getTime() > now.getTime()
}

export type GrantRejection =
  | 'revoked'
  | 'expired'
  | 'origin-not-allowed'
  | 'cause-not-allowed'
  | 'goal-mismatch'
  | 'run-mismatch'
  | 'actor-mismatch'
  | 'background-not-allowed'
  | 'call-budget-exhausted'
  | 'token-budget-exhausted'

export type GrantCheck =
  | { ok: true }
  | { ok: false; reason: GrantRejection; detail: string }

export interface GrantContext {
  origin: CognitionOrigin
  cause: CognitionCause
  goalId: string | null
  runId: string | null
  actor: PrincipalId | null
  /** True when nobody is watching: no user turn is currently open. */
  background: boolean
  /** Output tokens this call would be allowed to consume. */
  maxOutputTokens: number
}

/**
 * Decide whether one grant covers one request.
 *
 * Every rejection is a named reason. There is no fallback branch that waves a
 * request through because it seemed reasonable.
 */
export function checkGrant(grant: CognitionGrant, context: GrantContext, now: Date): GrantCheck {
  if (grant.revokedAt !== null) {
    return { ok: false, reason: 'revoked', detail: `grant ${grant.id} was revoked` }
  }
  if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired', detail: `grant ${grant.id} expired at ${grant.expiresAt}` }
  }
  if (!grant.allowedOrigins.includes(context.origin)) {
    return {
      ok: false,
      reason: 'origin-not-allowed',
      detail: `grant ${grant.id} does not cover origin ${context.origin}`,
    }
  }
  if (!grant.allowedCauses.includes(context.cause)) {
    return {
      ok: false,
      reason: 'cause-not-allowed',
      detail: `grant ${grant.id} does not cover cause ${context.cause}`,
    }
  }
  if (grant.goalId !== null && grant.goalId !== context.goalId) {
    return {
      ok: false,
      reason: 'goal-mismatch',
      detail: `grant ${grant.id} is scoped to goal ${grant.goalId}`,
    }
  }
  if (grant.runId !== null && grant.runId !== context.runId) {
    return {
      ok: false,
      reason: 'run-mismatch',
      detail: `grant ${grant.id} is scoped to run ${grant.runId}`,
    }
  }
  if (grant.actor !== null && grant.actor !== context.actor) {
    return {
      ok: false,
      reason: 'actor-mismatch',
      detail: `grant ${grant.id} is scoped to actor ${grant.actor}`,
    }
  }
  if (context.background && !grant.backgroundAllowed) {
    return {
      ok: false,
      reason: 'background-not-allowed',
      detail: `grant ${grant.id} does not permit unattended cognition`,
    }
  }
  if (grant.usage.calls >= grant.maxCalls) {
    return {
      ok: false,
      reason: 'call-budget-exhausted',
      detail: `grant ${grant.id} has spent all ${grant.maxCalls} calls`,
    }
  }
  const spent = grant.usage.outputTokens ?? 0
  if (spent + context.maxOutputTokens > grant.maxOutputTokens) {
    return {
      ok: false,
      reason: 'token-budget-exhausted',
      detail:
        `grant ${grant.id} has ${grant.maxOutputTokens - spent} output tokens left, ` +
        `which will not cover ${context.maxOutputTokens}`,
    }
  }
  return { ok: true }
}
