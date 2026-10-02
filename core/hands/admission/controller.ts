/**
 * THE HANDS ADMISSION CONTROLLER — the gate before any action exists.
 *
 * This file decides whether an action request may be *admitted*. Admission is
 * not execution: an admitted action stops at a typed `pending` decision with a
 * deadline and a budget snapshot, and this build has no executor that could
 * take it further.
 *
 * ## The fixed order of refusal
 *
 * The same input always produces the same decision, and the order below is the
 * precedence between refusal codes — documented so a caller who is owed an
 * answer knows which of several true things it will be told:
 *
 *  1. `stopped` — the STOP ALL latch. Checked before structure, because a
 *     system that has been told to stop owes nothing else an explanation, and
 *     no seam can override the latch.
 *  2. `malformed` — the envelope must match the contract's exact keys, and the
 *     admission context (caller, budget, grant, instant, seam) must be
 *     well-formed. Garbage fails closed; it is never repaired into something
 *     that would pass.
 *  3. `unsupported` — the capability id must exist in the explicit catalog and
 *     the action must be in that capability's closed vocabulary.
 *  4. `unauthorized` — the caller's own facts (trusted, its own scope), then
 *     Guard. Possession is weighed by Guard and never by this file: holding a
 *     capability is not authority, and untrusted input never reaches the claim.
 *  5. `expired_grant` — no grant, a revoked grant or an expired grant refuses
 *     outright; then the Governor's own denial.
 *  6. `over_budget` — the Governor's denial, then this controller's own hard
 *     concurrency and session bounds, so a permissive seam cannot exceed them.
 *  7. otherwise: admitted.
 *
 * ## What is deliberately absent
 *
 * No execution, no Electron, no browser/desktop/file control, no model calls.
 * The seam is consulted, never implemented, here — and the claims it receives
 * carry ids, scopes, instants and counts, never the untrusted `input`.
 */

import { validateActionEnvelope } from '../validation'
import { HANDS_LIMITS } from '../types'
import { HANDS_CAPABILITY_CATALOG, resolveCapability, type HandsCapabilityCatalog } from './catalog'
import {
  defaultHandsAdmissionSeam,
  guardClaim,
  governorClaim,
  isHandsAdmissionSeam,
  type HandsAdmissionSeam,
} from './seam'
import {
  HANDS_ADMISSION_LIMITS,
  HANDS_ADMISSION_REFUSAL_REASONS,
  type HandsAdmissionBudget,
  type HandsAdmissionCaller,
  type HandsAdmissionDecision,
  type HandsAdmissionGrant,
  type HandsAdmissionRefusal,
  type HandsAdmissionRefusalCode,
  type HandsAdmittedAction,
} from './types'

/**
 * Everything admission needs, and nothing else.
 *
 * Every field except `envelope` comes from the trusted pathway that asked for
 * admission. The envelope is the untrusted request; the rest are facts Core
 * already holds (who is asking, whether STOP ALL is latched, what the budget
 * and grant currently are).
 */
export interface HandsAdmissionInput {
  /** The untrusted action envelope, exactly as it arrived. */
  readonly envelope: unknown
  /** The caller, from the trusted pathway — never read out of the envelope. */
  readonly caller: HandsAdmissionCaller
  /** The STOP ALL latch. True refuses everything, before anything is checked. */
  readonly stopAllActive: boolean
  /** The instant of admission. Injected, so decisions are deterministic. */
  readonly now: string
  /** Bounded concurrency/admission budget metadata. Limits are code-owned. */
  readonly budget: HandsAdmissionBudget
  /** The grant this action relies on. `null` is refused, never assumed. */
  readonly grant: HandsAdmissionGrant | null
  /** The Guard/Governor seam. Defaults to the real deny-by-default policy. */
  readonly seam?: HandsAdmissionSeam
  /** The explicit capability catalog. Defaults to what this build routes. */
  readonly catalog?: HandsCapabilityCatalog
}

/**
 * Build a terminal refusal.
 *
 * The reason defaults to the code's table entry; a `detail` replaces it when
 * the deciding layer (this controller or the seam) can say something more
 * actionable. Either way the record is frozen: a refusal cannot be softened
 * after the fact.
 */
export function refuseHandsAdmission(
  actionId: string,
  capabilityId: string | null,
  code: HandsAdmissionRefusalCode,
  refusedAt: string,
  detail?: string,
): HandsAdmissionRefusal {
  const reason = (detail ?? HANDS_ADMISSION_REFUSAL_REASONS[code]).slice(
    0,
    HANDS_LIMITS.maxReasonChars,
  )
  return Object.freeze({
    actionId,
    code,
    reason,
    capabilityId,
    refusedAt,
    terminal: true as const,
  })
}

/**
 * Admit or refuse one action request.
 *
 * Pure: no clock, no randomness, no I/O, no mutation. The instant arrives on
 * the input, so the same input through the same seam produces the same
 * decision — which is what makes admission testable and auditable.
 */
export function admitHandsAction(input: HandsAdmissionInput): HandsAdmissionDecision {
  // Best-effort reads so even a malformed envelope gets a truthful refusal
  // attached to the id it actually carried, or to '' when it carried none.
  const actionId = readActionId(input.envelope)
  const capabilityId = readCapabilityId(input.envelope)
  const at = isValidInstant(input.now) ? input.now : ''
  const refuse = (
    code: HandsAdmissionRefusalCode,
    detail?: string,
  ): HandsAdmissionDecision => ({
    decision: 'refused',
    refusal: refuseHandsAdmission(actionId, capabilityId, code, at, detail),
  })

  // 1. STOP ALL outranks everything, including a malformed envelope and any
  //    seam. The latch is a fact Core holds; nothing about a request can widen
  //    past it.
  if (input.stopAllActive === true) {
    return refuse('stopped')
  }

  // 2. Malformed: the envelope must match the contract exactly, and the
  //    admission context must be well-formed. Garbage fails closed.
  const validation = validateActionEnvelope(input.envelope)
  if (!validation.ok) {
    return refuse('malformed')
  }
  const request = validation.request
  if (!isValidInstant(input.now)) return refuse('malformed')
  if (typeof input.stopAllActive !== 'boolean') return refuse('malformed')
  const budget = normalizeBudget(input.budget)
  if (budget === null) return refuse('malformed')
  if (!isValidCaller(input.caller)) return refuse('malformed')
  if (input.grant !== null && !isValidGrant(input.grant)) return refuse('malformed')
  const seam = input.seam === undefined ? defaultHandsAdmissionSeam : input.seam
  if (!isHandsAdmissionSeam(seam)) return refuse('malformed')
  const catalog = input.catalog === undefined ? HANDS_CAPABILITY_CATALOG : input.catalog
  if (typeof catalog !== 'object' || catalog === null) return refuse('malformed')
  if (typeof (catalog as { get?: unknown }).get !== 'function') return refuse('malformed')

  // 3. Unsupported: an explicit catalog lookup. Unknown id, unroutable kind
  //    and unknown action are each their own honest reason, never repaired.
  const resolved = resolveCapability(
    catalog,
    request.capabilityRef.capabilityId,
    request.action,
  )
  if (!resolved.ok) {
    return refuse('unsupported', resolved.reason)
  }

  // 4. Unauthorized: the caller's own facts first — they are Core's, they are
  //    cheap, and a forged scope in the envelope dies here before it reaches
  //    Guard as a request. Then Guard decides authority, because possession is
  //    not authority and only Guard weighs it.
  if (input.caller.trusted !== true) {
    return refuse('unauthorized', 'the principal is not trusted')
  }
  if (request.capabilityRef.scope !== input.caller.scope) {
    return refuse('unauthorized', 'the capability was named in a scope the caller is not acting in')
  }
  const guardVerdict: unknown = seam.guard.evaluate(
    guardClaim(input.caller, request.capabilityRef, request.action),
  )
  if (
    typeof guardVerdict !== 'object' ||
    guardVerdict === null ||
    (guardVerdict as { allowed?: unknown }).allowed !== true
  ) {
    return refuse('unauthorized', verdictReason(guardVerdict) ?? HANDS_ADMISSION_REFUSAL_REASONS.unauthorized)
  }

  // 5. Expired grant: an active grant is a fact this controller checks itself,
  //    so no seam can revive a revoked or expired one. Then the Governor's
  //    own verdict, whose denial codes are a closed pair.
  const grant = input.grant
  if (grant === null) {
    return refuse('expired_grant', 'no grant covers this action')
  }
  if (grant.revokedAt !== null) {
    return refuse('expired_grant', 'the grant was revoked')
  }
  if (Date.parse(grant.expiresAt) <= Date.parse(input.now)) {
    return refuse('expired_grant', 'the grant has expired')
  }

  const timeoutMs = request.timeoutMs ?? HANDS_LIMITS.maxActionTimeoutMs
  const governorVerdict: unknown = seam.governor.evaluate(
    governorClaim({
      actionId: request.actionId,
      capabilityRef: request.capabilityRef,
      grant,
      budget,
      timeoutMs,
      now: input.now,
    }),
  )
  if (typeof governorVerdict !== 'object' || governorVerdict === null) {
    return refuse('malformed', 'the decision seam returned a verdict outside the closed vocabulary')
  }
  const governor = governorVerdict as { outcome?: unknown; code?: unknown }
  if (governor.outcome === 'deny') {
    if (governor.code === 'expired_grant' || governor.code === 'over_budget') {
      return refuse(
        governor.code,
        verdictReason(governorVerdict) ?? HANDS_ADMISSION_REFUSAL_REASONS[governor.code],
      )
    }
    // A denial wearing a code this vocabulary does not have is not a code: it
    // is a malformed seam answer, and it fails closed.
    return refuse('malformed', 'the decision seam returned a denial outside the closed vocabulary')
  }
  if (governor.outcome !== 'allow') {
    return refuse('malformed', 'the decision seam returned a verdict outside the closed vocabulary')
  }

  // 6. Over budget: this controller's own hard bounds, checked after the seam
  //    so the documented precedence holds — and enforced regardless of what
  //    the seam said, because a bound the seam can waive is not a bound.
  if (budget.inFlightActions >= budget.maxConcurrentActions) {
    return refuse('over_budget', 'the concurrency bound for admitted actions is reached')
  }
  if (budget.admittedActions >= budget.maxAdmittedActions) {
    return refuse('over_budget', 'the session admission cap is reached')
  }

  // 7. Admitted: a typed pending decision and nothing more. No execution
  //    fields exist on this type, so nothing can walk it forward by writing.
  const admittedAt = input.now
  const admitted: HandsAdmittedAction = {
    decision: 'admitted',
    status: 'pending',
    actionId: request.actionId,
    capabilityRef: request.capabilityRef,
    action: request.action,
    input: Object.freeze({ ...request.input }),
    admittedAt,
    timeoutMs,
    deadlineAt: new Date(Date.parse(admittedAt) + timeoutMs).toISOString(),
    correlationId: request.correlationId ?? null,
    caller: Object.freeze({
      principalId: input.caller.principalId,
      scope: input.caller.scope,
    }),
    grantId: grant.grantId,
    budget: Object.freeze({
      maxConcurrentActions: budget.maxConcurrentActions,
      inFlightAfter: budget.inFlightActions + 1,
      maxAdmittedActions: budget.maxAdmittedActions,
      admittedAfter: budget.admittedActions + 1,
    }),
  }
  return { decision: 'admitted', admitted }
}

/* ------------------------------------------------------------ internals */

function isValidInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function readActionId(envelope: unknown): string {
  if (typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)) {
    const value = (envelope as { actionId?: unknown }).actionId
    if (typeof value === 'string') return value
  }
  return ''
}

function readCapabilityId(envelope: unknown): string | null {
  if (typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)) {
    const ref = (envelope as { capabilityRef?: unknown }).capabilityRef
    if (typeof ref === 'object' && ref !== null) {
      const id = (ref as { capabilityId?: unknown }).capabilityId
      if (typeof id === 'string') return id
    }
  }
  return null
}

/** A seam reason if it has one, bounded; otherwise null so the caller falls back. */
function verdictReason(verdict: unknown): string | null {
  if (typeof verdict !== 'object' || verdict === null) return null
  const reason = (verdict as { reason?: unknown }).reason
  if (typeof reason !== 'string' || reason.trim().length === 0) return null
  return reason.slice(0, HANDS_LIMITS.maxReasonChars)
}

/**
 * Validate and clamp budget metadata.
 *
 * Counts must be finite non-negative integers; limits must be finite integers
 * of at least one and are clamped down to the code-owned ceiling. Anything
 * else is `null` → malformed: a budget this build cannot read is a budget it
 * does not spend against.
 */
function normalizeBudget(value: unknown): HandsAdmissionBudget | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : null
  const limit = (v: unknown, ceiling: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 1
      ? Math.min(v, ceiling)
      : null
  const maxConcurrentActions = limit(raw.maxConcurrentActions, HANDS_ADMISSION_LIMITS.maxConcurrentActions)
  const inFlightActions = count(raw.inFlightActions)
  const maxAdmittedActions = limit(raw.maxAdmittedActions, HANDS_ADMISSION_LIMITS.maxAdmittedActions)
  const admittedActions = count(raw.admittedActions)
  if (
    maxConcurrentActions === null ||
    inFlightActions === null ||
    maxAdmittedActions === null ||
    admittedActions === null
  ) {
    return null
  }
  return { maxConcurrentActions, inFlightActions, maxAdmittedActions, admittedActions }
}

function isValidCaller(value: unknown): value is HandsAdmissionCaller {
  if (typeof value !== 'object' || value === null) return false
  const caller = value as Record<string, unknown>
  if (typeof caller.principalId !== 'string' || caller.principalId.length === 0) return false
  if (caller.principalId.length > 128) return false
  if (typeof caller.trusted !== 'boolean') return false
  if (typeof caller.scope !== 'string' || caller.scope.length === 0) return false
  if (caller.scope.length > 128) return false
  const held = caller.heldCapabilities
  if (!Array.isArray(held)) return false
  return held.every(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
  )
}

function isValidGrant(value: unknown): value is HandsAdmissionGrant {
  if (typeof value !== 'object' || value === null) return false
  const grant = value as Record<string, unknown>
  if (typeof grant.grantId !== 'string' || grant.grantId.length === 0) return false
  if (grant.grantId.length > 128) return false
  if (!isValidInstant(grant.expiresAt)) return false
  if (grant.revokedAt !== null && !isValidInstant(grant.revokedAt)) return false
  return true
}
