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

/**
 * Two different quantities, deliberately not the same field.
 *
 * - `outputTokenBudgetReserved` is **authorisation arithmetic**: the allowance
 *   taken out of the grant's budget before the provider is called. It moves
 *   whether or not the call succeeds, whether or not the provider ever answers,
 *   and it survives a crash. A grant with 1000 tokens and 300 reserved has 700
 *   left, whatever the provider went on to do.
 *
 * - `outputTokens` is **reported usage**: what the provider said it consumed.
 *   It stays `null` when the provider says nothing, because guessing would
 *   make an unaccounted call look like a free one.
 *
 * Collapsing these is how a budget silently stops meaning anything, so they are
 * separate fields with separate rules.
 */
/**
 * What an owner asks for when creating a grant.
 *
 * Note what is absent: no `createdBy`, no `revokedBy`, no principal of any
 * kind. Identity is assigned by Core from the authority the call arrived on. A
 * spec that could name its own author would be a way to forge a durable record
 * of who authorised something.
 */
export interface CognitionGrantSpec {
  grantId: string
  expiresAt: string
  allowedOrigins: readonly CognitionOrigin[]
  allowedCauses: readonly CognitionCause[]
  goalId?: string | null
  runId?: string | null
  /** Narrow this grant to one principal. Null means any principal. */
  actor?: PrincipalId | null
  backgroundAllowed: boolean
  /** Hard ceilings. Neither may be infinite, and neither may be zero. */
  maxCalls: number
  maxOutputTokens: number
  parentGrantId?: string | null
}

export interface CognitionGrantUsage {
  calls: number
  /** Allowance consumed by authorisation. Monotonic. Never refunded. */
  outputTokenBudgetReserved: number
  /**
   * Usage the provider reported, accumulated. `null` means nothing was ever
   * reported, and `unknownUsageCalls` says how many calls failed to report — so
   * the two figures are a lower bound whenever that counter is above zero, and
   * never an assumption that an unreported call was free.
   */
  inputTokens: number | null
  outputTokens: number | null
  unknownUsageCalls: number
}

export function emptyGrantUsage(): CognitionGrantUsage {
  return {
    calls: 0,
    outputTokenBudgetReserved: 0,
    inputTokens: null,
    outputTokens: null,
    unknownUsageCalls: 0,
  }
}

/** How much of the grant's output allowance is still unreserved. */
export function remainingOutputTokenBudget(grant: CognitionGrant): number {
  return grant.maxOutputTokens - grant.usage.outputTokenBudgetReserved
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
  // The budget is measured against *reserved*, not against reported usage. A
  // provider that reported nothing has therefore spent nothing against the
  // budget — and the caller is about to reserve the full requested allowance,
  // so the whole request has to fit in what is left.
  const remaining = remainingOutputTokenBudget(grant)
  if (context.maxOutputTokens > remaining) {
    return {
      ok: false,
      reason: 'token-budget-exhausted',
      detail:
        `grant ${grant.id} has ${remaining} of ${grant.maxOutputTokens} output tokens ` +
        `unreserved, which will not cover ${context.maxOutputTokens}`,
    }
  }
  return { ok: true }
}
