/**
 * THE SENSES ADMISSION PIPELINE — the gate before any capability action exists.
 *
 * Admission decides whether a capability action request may be *admitted*. It
 * is not execution: an admitted action stops at a typed `pending` decision with
 * a deadline, and this build has no executor that could take it further.
 *
 * ## The fixed order of refusal
 *
 * The same input always produces the same decision. The order below is the
 * precedence between refusal codes:
 *
 *  1. `stop_all` — the STOP ALL latch. Checked first, because a system told to
 *     stop owes nothing else an explanation, and no seam can override it.
 *  2. `invalid_context` — the admission context (caller, budget, instant, seam)
 *     must be well-formed. Garbage fails closed.
 *  3. `capability_unknown` — the kind must be one this build knows.
 *  4. `action_unsupported` — the kind must accept the action.
 *  5. `invalid_input` — the input must match the action's closed field table.
 *  6. `capability_unauthorized` — the caller's own facts, then Guard.
 *  7. `governor_denied` — cognition, when required, must be covered by a grant.
 *  8. `budget_exceeded` — the remaining budget must cover the action's cost.
 *  9. `approval_required` — an action that needs approval must have one.
 * 10. otherwise: admitted.
 *
 * ## What is deliberately absent
 *
 * No execution, no Electron, no browser/terminal/clipboard control, no model
 * calls. The seam is consulted, never implemented, here.
 */

import {
  PHASE25_LIMITS,
  instantMs,
  isPhase25CapabilityKind,
  type CapabilityActionRefusal,
  type CapabilityActionRequest,
  type Phase25CapabilityKind,
  type SensesRisk,
} from './types'
import {
  actionRegistration,
  capabilityRegistration,
  isCapabilityRegistry,
  validateInput,
} from './registry'
import type { CapabilityRegistration } from './types'
import { refuseCapabilityAction, type SensesRefusalCode } from './refusal'

/* ---------------------------------------------------------------- caller */

/**
 * The caller, as Core knows it.
 *
 * Supplied by the trusted pathway that asked for admission — never read out of
 * the request. `heldCapabilities` is possession: what the caller holds says
 * nothing about what it may do, which is Guard's decision.
 */
export interface SensesCaller {
  readonly principalId: string
  readonly trusted: boolean
  readonly scope: string
  readonly heldCapabilities: readonly string[]
}

/* ---------------------------------------------------------------- seam */

/** What Guard is asked: who is asking, for what, in which scope. */
export interface SensesGuardClaim {
  readonly principalId: string
  readonly trusted: boolean
  readonly heldCapabilities: readonly string[]
  readonly capabilityKind: Phase25CapabilityKind
  readonly action: string
  readonly callerScope: string
}

export type SensesGuardVerdict =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly reason: string }

/** The Guard half of the seam. */
export interface SensesGuardSeam {
  evaluate(claim: SensesGuardClaim): SensesGuardVerdict
}

/** What the Governor is asked: whether cognition is covered. */
export interface SensesGovernorClaim {
  readonly actionId: string
  readonly capabilityKind: Phase25CapabilityKind
  readonly action: string
  readonly requiresCognition: boolean
  readonly cognitionGrantId: string | null
  readonly now: string
}

export type SensesGovernorVerdict =
  | { readonly outcome: 'allow'; readonly reason: string }
  | { readonly outcome: 'deny'; readonly reason: string }

/** The Governor half of the seam. */
export interface SensesGovernorSeam {
  evaluate(claim: SensesGovernorClaim): SensesGovernorVerdict
}

/**
 * The seam the pipeline consults before anything can be admitted.
 *
 * Both halves are required: there is no configuration in which an action is
 * admitted without a Guard verdict and a Governor verdict.
 */
export interface SensesAuthoritySeam {
  readonly guard: SensesGuardSeam
  readonly governor: SensesGovernorSeam
}

/**
 * Guard's default policy.
 *
 * Deny by default: an untrusted principal carries no authority whatever it
 * claims to hold, and possession is checked last because holding a capability
 * is the weakest of the claims.
 */
export const defaultSensesGuard: SensesGuardSeam = {
  evaluate(claim: SensesGuardClaim): SensesGuardVerdict {
    if (!claim.trusted) {
      return { allowed: false, reason: 'the principal is not trusted' }
    }
    if (!claim.heldCapabilities.includes(claim.capabilityKind)) {
      return { allowed: false, reason: 'the caller does not hold the capability it named' }
    }
    return { allowed: true, reason: 'the caller holds the capability in its own scope' }
  },
}

/**
 * The Governor's default policy.
 *
 * Deny by default: an action that needs cognition and has no grant is refused,
 * never assumed. An action that needs no cognition is allowed.
 */
export const defaultSensesGovernor: SensesGovernorSeam = {
  evaluate(claim: SensesGovernorClaim): SensesGovernorVerdict {
    if (claim.requiresCognition && claim.cognitionGrantId === null) {
      return { outcome: 'deny', reason: 'cognition was required and no grant covers this action' }
    }
    return { outcome: 'allow', reason: 'no cognition grant is required, or one covers this action' }
  },
}

/** The seam used when a caller supplies none: the real policy, not a bypass. */
export const defaultSensesAuthoritySeam: SensesAuthoritySeam = {
  guard: defaultSensesGuard,
  governor: defaultSensesGovernor,
}

/** Whether a value has the shape of a seam. Checked before any consultation. */
export function isSensesAuthoritySeam(value: unknown): value is SensesAuthoritySeam {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { guard?: unknown; governor?: unknown }
  const half = (part: unknown): boolean =>
    typeof part === 'object' &&
    part !== null &&
    typeof (part as { evaluate?: unknown }).evaluate === 'function'
  return half(candidate.guard) && half(candidate.governor)
}

/* ------------------------------------------------------------- admission */

/**
 * Everything admission needs, and nothing else.
 *
 * Every field except `request` comes from the trusted pathway that asked for
 * admission. The request is the untrusted action; the rest are facts Core
 * already holds.
 */
export interface SensesAdmissionInput {
  /** The untrusted action request, exactly as it arrived. */
  readonly request: CapabilityActionRequest
  /** The caller, from the trusted pathway — never read out of the request. */
  readonly caller: SensesCaller
  /** The STOP ALL latch. True refuses everything, before anything is checked. */
  readonly stopAllActive: boolean
  /** The instant of admission. Injected, so decisions are deterministic. */
  readonly now: string
  /** Budget remaining for capability actions. */
  readonly budgetRemaining: number
  /** The cost this action would spend. */
  readonly requiredBudget: number
  /** Approval keys already granted. This pipeline never adds to it. */
  readonly approvals: ReadonlySet<string>
  /** Whether this action needs cognition. From the trusted pathway. */
  readonly requiresCognition: boolean
  /** The cognition grant covering this action, or `null`. */
  readonly cognitionGrantId: string | null
  /** The Guard/Governor seam. Defaults to the real deny-by-default policy. */
  readonly seam?: SensesAuthoritySeam
  /** The explicit registry. Defaults to what this build routes. */
  readonly registry?: ReadonlyMap<Phase25CapabilityKind, CapabilityRegistration>
}

/**
 * An admitted action, stopping at a typed pending decision.
 *
 * There is deliberately no field for a start instant, a result, an observation
 * or a verdict: admission cannot be walked forward into execution by writing
 * to it.
 */
export interface SensesAdmittedAction {
  readonly decision: 'admitted'
  readonly status: 'pending'
  readonly actionId: string
  readonly capabilityKind: Phase25CapabilityKind
  readonly action: string
  /** Validated, sanitised, and still untrusted. Content, never authority. */
  readonly input: Readonly<Record<string, unknown>>
  readonly admittedAt: string
  readonly timeoutMs: number
  readonly deadlineAt: string
  readonly risk: SensesRisk
  readonly requiresApproval: boolean
  readonly correlationId: string | null
}

/** The outcome of admission: a terminal refusal, or a pending decision. */
export type SensesAdmissionDecision =
  | { readonly decision: 'refused'; readonly code: SensesRefusalCode; readonly refusal: CapabilityActionRefusal }
  | { readonly decision: 'admitted'; readonly admitted: SensesAdmittedAction }

/**
 * Admit or refuse one capability action request.
 *
 * Pure: no clock, no randomness, no I/O, no mutation. The instant arrives on
 * the input, so the same input through the same seam produces the same
 * decision — which is what makes admission testable and auditable.
 */
export function admitCapabilityAction(input: SensesAdmissionInput): SensesAdmissionDecision {
  const request = input.request
  const kind = readKind(request)
  const actionId = readActionId(request)
  const at = instantMs(input.now) !== null ? input.now : ''
  const refuse = (code: SensesRefusalCode, detail?: string): SensesAdmissionDecision => ({
    decision: 'refused',
    code,
    refusal: refuseCapabilityAction(actionId, kind, code, at, detail),
  })

  // 1. STOP ALL outranks everything, including structure and any seam.
  if (input.stopAllActive === true) {
    return refuse('stop_all')
  }

  // 2. Context must be well-formed. Garbage fails closed.
  if (instantMs(input.now) === null) return refuse('invalid_context', 'the admission instant is not valid')
  if (typeof input.stopAllActive !== 'boolean') return refuse('invalid_context')
  if (!isValidCaller(input.caller)) return refuse('invalid_context')
  if (!isBudget(input.budgetRemaining) || !isBudget(input.requiredBudget)) {
    return refuse('invalid_context', 'the budget is not a finite non-negative number')
  }
  const seam = input.seam === undefined ? defaultSensesAuthoritySeam : input.seam
  if (!isSensesAuthoritySeam(seam)) return refuse('invalid_context', 'the decision seam is not well-formed')
  const registry = input.registry
  if (registry !== undefined && !isCapabilityRegistry(registry)) {
    return refuse('invalid_context', 'the registry is not well-formed')
  }

  // 3. The kind must be known.
  if (kind === null) return refuse('capability_unknown')
  const registration = resolveRegistration(kind, registry)
  if (registration === null) return refuse('capability_unknown')

  // 4. The kind must accept the action.
  const action = actionRegistration(kind, request.action)
  if (action === null) return refuse('action_unsupported')

  // 5. The input must match the closed field table.
  const validation = validateInput(kind, request.action, request.input)
  if (!validation.ok) return refuse('invalid_input', validation.reason)

  // 6. The caller's own facts, then Guard.
  if (input.caller.trusted !== true) {
    return refuse('capability_unauthorized', 'the principal is not trusted')
  }
  const guardVerdict: unknown = seam.guard.evaluate({
    principalId: input.caller.principalId,
    trusted: input.caller.trusted,
    heldCapabilities: input.caller.heldCapabilities,
    capabilityKind: kind,
    action: request.action,
    callerScope: input.caller.scope,
  })
  if (
    typeof guardVerdict !== 'object' ||
    guardVerdict === null ||
    (guardVerdict as { allowed?: unknown }).allowed !== true
  ) {
    return refuse('capability_unauthorized', verdictReason(guardVerdict) ?? undefined)
  }

  // 7. Governor: cognition, when required, must be covered by a grant.
  const governorVerdict: unknown = seam.governor.evaluate({
    actionId,
    capabilityKind: kind,
    action: request.action,
    requiresCognition: input.requiresCognition,
    cognitionGrantId: input.cognitionGrantId,
    now: input.now,
  })
  if (
    typeof governorVerdict !== 'object' ||
    governorVerdict === null ||
    (governorVerdict as { outcome?: unknown }).outcome !== 'allow'
  ) {
    return refuse('governor_denied', verdictReason(governorVerdict) ?? undefined)
  }

  // 8. Budget.
  if (input.requiredBudget > input.budgetRemaining) {
    return refuse('budget_exceeded')
  }

  // 9. Approval: only an approval that already exists counts.
  if (action.requiresApproval && !input.approvals.has(actionId)) {
    return refuse('approval_required')
  }

  // 10. Admitted: a typed pending decision and nothing more.
  const timeoutMs = effectiveTimeout(request.timeoutMs, action.timeoutMs)
  const admittedAt = input.now
  const deadlineMs = (instantMs(admittedAt) ?? 0) + timeoutMs
  // An instant at the very edge of the representable range cannot carry a
  // deadline. Admission is total, so refuse with a code rather than throw from
  // `toISOString` or clamp a deadline that did not happen.
  if (!Number.isFinite(deadlineMs) || deadlineMs > MAX_INSTANT_MS) {
    return refuse('invalid_context', 'the action deadline is not a representable instant')
  }
  const admitted: SensesAdmittedAction = {
    decision: 'admitted',
    status: 'pending',
    actionId,
    capabilityKind: kind,
    action: request.action,
    input: Object.freeze({ ...request.input }),
    admittedAt,
    timeoutMs,
    deadlineAt: new Date(deadlineMs).toISOString(),
    risk: action.risk,
    requiresApproval: action.requiresApproval,
    correlationId: request.correlationId ?? null,
  }
  return { decision: 'admitted', admitted }
}

/* ------------------------------------------------------------ internals */

/**
 * The largest instant a JavaScript `Date` can represent, in milliseconds.
 *
 * `Date.parse('+275760-09-13T00:00:00.000Z')` is a *valid* instant that lands
 * exactly here, so `now + timeoutMs` can leave the representable range and make
 * `toISOString` throw. Admission must stay total, so the overflow is refused.
 */
const MAX_INSTANT_MS = 8_640_000_000_000_000

function readKind(request: unknown): Phase25CapabilityKind | null {
  if (typeof request !== 'object' || request === null) return null
  const kind = (request as { capabilityKind?: unknown }).capabilityKind
  return isPhase25CapabilityKind(kind) ? kind : null
}

function readActionId(request: unknown): string {
  if (typeof request === 'object' && request !== null) {
    const id = (request as { actionId?: unknown }).actionId
    if (typeof id === 'string') return id
  }
  return ''
}

function isValidCaller(value: unknown): value is SensesCaller {
  if (typeof value !== 'object' || value === null) return false
  const caller = value as Record<string, unknown>
  if (typeof caller.principalId !== 'string' || caller.principalId.length === 0) return false
  if (caller.principalId.length > 128) return false
  if (typeof caller.trusted !== 'boolean') return false
  if (typeof caller.scope !== 'string' || caller.scope.length === 0) return false
  if (caller.scope.length > 128) return false
  if (!Array.isArray(caller.heldCapabilities)) return false
  return caller.heldCapabilities.every(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
  )
}

function isBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** A seam reason if it has one, bounded; otherwise null. */
function verdictReason(verdict: unknown): string | null {
  if (typeof verdict !== 'object' || verdict === null) return null
  const reason = (verdict as { reason?: unknown }).reason
  if (typeof reason !== 'string' || reason.trim().length === 0) return null
  return reason.slice(0, PHASE25_LIMITS.maxInputBytes)
}

/**
 * The effective timeout: a caller may lower the registration's bound and may
 * never raise it.
 */
function effectiveTimeout(requested: number | null | undefined, ceiling: number): number {
  const bound = Math.min(ceiling, PHASE25_LIMITS.maxActionTimeoutMs)
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return bound
  return Math.max(1, Math.min(Math.floor(requested), bound))
}

function resolveRegistration(
  kind: Phase25CapabilityKind,
  registry: ReadonlyMap<Phase25CapabilityKind, CapabilityRegistration> | undefined,
): CapabilityRegistration | null {
  if (registry === undefined) return capabilityRegistration(kind)
  return registry.get(kind) ?? null
}
