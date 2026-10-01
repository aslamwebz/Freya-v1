/**
 * THE HANDS DOMAIN — Phase 10 foundation.
 *
 * This file is the vocabulary for Freya's computer/action capabilities: what she
 * may be asked to do, what she observed, and whether the intent was satisfied.
 * It is types and closed tables only — no logic, no I/O, no clock — so the
 * contract, the lifecycle and any future engine can depend on the shapes
 * without depending on each other.
 *
 * ## What is deliberately absent
 *
 * - **No authority, in any field.** Nothing here is a permission, a capability,
 *   a grant or a trust decision. Capability possession does not imply authority:
 *   holding a capability id says nothing about whether the caller may use it.
 * - **No execution.** Nothing in this domain reaches for a browser, a desktop,
 *   a file or a process. Actions are *requested* and *recorded*; the actual
 *   execution is a later phase.
 * - **No model-triggered actions.** No field here can be set by a model output.
 *   Every field is either an id, an instant, a closed label or a measured length.
 *
 * ## The lifecycle
 *
 * ```
 *   Action → Observation → Verification
 * ```
 *
 * An Action is *attempted*. An Observation is *what came back*. A Verification
 * is *whether the intent was satisfied*. Collapsing any two of them produces
 * the failure this architecture calls out by name:
 *
 * > An action is not evidence that it worked. An observation is not a success.
 * > Only a separately registered verifier can close a step.
 */

/* ------------------------------------------------------- capability kinds */

/**
 * The capability kinds this build can honestly route.
 *
 * Each one names a *domain of action*, not a specific tool. A future module
 * that can be expressed as "ask this, get evidence back, verify it against
 * that" attaches by registering under one of these — it does not get a new
 * vocabulary entry.
 */
export const HANDS_CAPABILITY_KINDS = [
  /** Browser automation: navigate, click, type, read page content. */
  'browser',
  /** Desktop automation: app/window control, screen interaction. */
  'desktop',
  /** File system: read, write, list, delete files. */
  'file',
  /** Shell/terminal: execute commands in a shell. */
  'shell',
  /** Network: HTTP requests, API calls. */
  'network',
] as const
export type HandsCapabilityKind = (typeof HANDS_CAPABILITY_KINDS)[number]

export function isHandsCapabilityKind(value: unknown): value is HandsCapabilityKind {
  return typeof value === 'string' && (HANDS_CAPABILITY_KINDS as readonly string[]).includes(value)
}

/**
 * Declared, not routed.
 *
 * These exist so a request for them fails with an honest reason rather than a
 * quiet absence.
 */
export const DEFERRED_HANDS_CAPABILITY_KINDS = ['clipboard', 'media'] as const
export type DeferredHandsCapabilityKind = (typeof DEFERRED_HANDS_CAPABILITY_KINDS)[number]

export function isDeferredHandsCapabilityKind(value: unknown): value is DeferredHandsCapabilityKind {
  return (
    typeof value === 'string' &&
    (DEFERRED_HANDS_CAPABILITY_KINDS as readonly string[]).includes(value)
  )
}

export type AnyHandsCapabilityKind = HandsCapabilityKind | DeferredHandsCapabilityKind

export function isAnyHandsCapabilityKind(value: unknown): value is AnyHandsCapabilityKind {
  return isHandsCapabilityKind(value) || isDeferredHandsCapabilityKind(value)
}

/* --------------------------------------------------------- action statuses */

/**
 * An Action's lifecycle.
 *
 * `running` → one of four terminal states. Terminal states have no outgoing
 * edges: a completed, failed, cancelled or timed-out Action is never rewritten.
 * A retry is a *new* Action.
 */
export const HANDS_ACTION_STATUSES = [
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const
export type HandsActionStatus = (typeof HANDS_ACTION_STATUSES)[number]

export const HANDS_ACTION_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const
export type HandsActionTerminalStatus = (typeof HANDS_ACTION_TERMINAL_STATUSES)[number]

export function isTerminalHandsActionStatus(
  status: HandsActionStatus,
): status is HandsActionTerminalStatus {
  return HANDS_ACTION_TERMINAL_STATUSES.includes(status as HandsActionTerminalStatus)
}

/* ------------------------------------------------------ observation kinds */

/**
 * What kind of evidence an Observation is.
 *
 * `result` is deliberately *not* called `success`. A capability that returned
 * data has produced an observation, and whether the data satisfies the intent
 * is a separate question answered by a verifier.
 */
export const HANDS_OBSERVATION_KINDS = ['result', 'exit', 'change', 'failure', 'input'] as const
export type HandsObservationKind = (typeof HANDS_OBSERVATION_KINDS)[number]

/* ---------------------------------------------------- verification statuses */

/**
 * A Verification's lifecycle.
 *
 * `requested` → `passed` | `failed`. Terminal states have no outgoing edges.
 */
export const HANDS_VERIFICATION_STATUSES = ['requested', 'passed', 'failed'] as const
export type HandsVerificationStatus = (typeof HANDS_VERIFICATION_STATUSES)[number]

export const HANDS_VERIFICATION_TERMINAL_STATUSES = ['passed', 'failed'] as const
export type HandsVerificationTerminalStatus =
  (typeof HANDS_VERIFICATION_TERMINAL_STATUSES)[number]

export function isTerminalHandsVerificationStatus(
  status: HandsVerificationStatus,
): status is HandsVerificationTerminalStatus {
  return HANDS_VERIFICATION_TERMINAL_STATUSES.includes(
    status as HandsVerificationTerminalStatus,
  )
}

/* ------------------------------------------------------------ refusal codes */

/**
 * Why an action was refused.
 *
 * A closed set, because a refusal code that a caller can invent is decoration.
 * Each code maps to a human-readable reason in `HANDS_REFUSAL_REASONS`.
 */
export const HANDS_REFUSAL_CODES = [
  /** The capability kind is not one this Core knows. */
  'capability_unknown',
  /** The capability kind is known but not routed in this build. */
  'capability_deferred',
  /** The caller does not hold the capability it named. */
  'capability_unauthorized',
  /** The action envelope failed exact-key validation. */
  'invalid_envelope',
  /** The action request failed schema validation. */
  'invalid_request',
  /** The budget for this action was exceeded. */
  'budget_exceeded',
  /** The timeout for this action was exceeded. */
  'timeout_exceeded',
] as const
export type HandsRefusalCode = (typeof HANDS_REFUSAL_CODES)[number]

/** Why a code is a refusal, in words a person can act on. */
export const HANDS_REFUSAL_REASONS: Readonly<Record<HandsRefusalCode, string>> = Object.freeze({
  capability_unknown: 'that is not a capability kind this Core knows',
  capability_deferred: 'this Core build does not route that capability kind yet',
  capability_unauthorized: 'the caller does not hold the capability it named',
  invalid_envelope: 'the action envelope does not match the expected shape',
  invalid_request: 'the action request is not valid',
  budget_exceeded: 'the action budget was exceeded',
  timeout_exceeded: 'the action timeout was exceeded',
})

/* ------------------------------------------------------------------ limits */

/**
 * Code-owned ceilings.
 *
 * A caller may *lower* any of these and may never raise one, so bounds are
 * facts about this build rather than values a caller supplies.
 */
export const HANDS_LIMITS = Object.freeze({
  /** Actions a single session may record. */
  maxActions: 256,
  /** Observations a single action may produce. */
  maxObservationsPerAction: 8,
  /** Verifications a single action may request. */
  maxVerificationsPerAction: 4,
  /** Wall-clock milliseconds a single action may occupy. */
  maxActionTimeoutMs: 5 * 60_000,
  /** Characters in a human-readable label. */
  maxLabelChars: 200,
  /** Characters in a human-readable summary. */
  maxSummaryChars: 400,
  /** Characters in a reason a person is shown for a refusal. */
  maxReasonChars: 400,
  /** Bytes of serialised action input. */
  maxInputBytes: 8_192,
  /** Depth and breadth of a sanitised input value. */
  maxInputDepth: 4,
  /** Fields in one sanitised input value. */
  maxInputFields: 32,
  /** Retained action records. */
  maxRetainedActions: 512,
})

export interface HandsLimits {
  readonly maxActions: number
  readonly maxObservationsPerAction: number
  readonly maxVerificationsPerAction: number
  readonly maxActionTimeoutMs: number
  readonly maxLabelChars: number
  readonly maxSummaryChars: number
  readonly maxReasonChars: number
  readonly maxInputBytes: number
  readonly maxInputDepth: number
  readonly maxInputFields: number
  readonly maxRetainedActions: number
}

/**
 * Resolve a partial limit set against the ceiling.
 *
 * Every override is clamped into `[1, HANDS_LIMITS[key]]`.
 */
export function handsLimits(overrides: Partial<HandsLimits> = {}): HandsLimits {
  const clamped = (key: keyof HandsLimits): number => {
    const requested = overrides[key]
    if (requested === undefined) return HANDS_LIMITS[key]
    if (typeof requested !== 'number' || !Number.isFinite(requested)) return HANDS_LIMITS[key]
    return Math.max(1, Math.min(Math.floor(requested), HANDS_LIMITS[key]))
  }
  return {
    maxActions: clamped('maxActions'),
    maxObservationsPerAction: clamped('maxObservationsPerAction'),
    maxVerificationsPerAction: clamped('maxVerificationsPerAction'),
    maxActionTimeoutMs: clamped('maxActionTimeoutMs'),
    maxLabelChars: clamped('maxLabelChars'),
    maxSummaryChars: clamped('maxSummaryChars'),
    maxReasonChars: clamped('maxReasonChars'),
    maxInputBytes: clamped('maxInputBytes'),
    maxInputDepth: clamped('maxInputDepth'),
    maxInputFields: clamped('maxInputFields'),
    maxRetainedActions: clamped('maxRetainedActions'),
  }
}

/* --------------------------------------------------------- state machine table */

/**
 * Every Action transition that exists.
 *
 * Declared centrally so that nothing can move an Action by writing to it.
 * The lifecycle enforcer refuses any edge that is not in this table.
 */
export const HANDS_ACTION_TRANSITIONS: Readonly<Record<HandsActionStatus, readonly HandsActionStatus[]>> =
  Object.freeze({
    running: ['completed', 'failed', 'cancelled', 'timed_out'],
    completed: [],
    failed: [],
    cancelled: [],
    timed_out: [],
  })

export function canTransitionHandsAction(from: HandsActionStatus, to: HandsActionStatus): boolean {
  return HANDS_ACTION_TRANSITIONS[from].includes(to)
}

/**
 * Every Verification transition that exists.
 */
export const HANDS_VERIFICATION_TRANSITIONS: Readonly<
  Record<HandsVerificationStatus, readonly HandsVerificationStatus[]>
> = Object.freeze({
  requested: ['passed', 'failed'],
  passed: [],
  failed: [],
})

export function canTransitionHandsVerification(
  from: HandsVerificationStatus,
  to: HandsVerificationStatus,
): boolean {
  return HANDS_VERIFICATION_TRANSITIONS[from].includes(to)
}
