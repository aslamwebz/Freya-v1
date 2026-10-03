/**
 * THE CAPABILITY TESTING FRAMEWORK — deterministic, repeatable action tests.
 *
 * Every capability action can be tested through the same pipeline the runtime
 * uses, with a trusted caller, a generous budget and pre-granted approval, so a
 * test exercises the registry and the admission precedence rather than a mock.
 *
 * It is deterministic by construction: no wall clock (the instant is injected
 * and fixed), no external service, no model call, no randomness. A test that
 * cannot be re-run to the same result is not evidence.
 */

import {
  PHASE25_CAPABILITY_KINDS,
  PHASE25_LIMITS,
  instantMs,
  isSensesId,
  type CapabilityActionRequest,
  type CapabilityActionResult,
  type CapabilityObservationRecord,
  type CapabilityTestResult,
  type CapabilityTestCase,
  type CapabilityVerificationResult,
  type Phase25CapabilityKind,
} from './types'
import {
  admitCapabilityAction,
  type SensesAdmissionDecision,
  type SensesAuthoritySeam,
  type SensesCaller,
} from './admission'
import { capabilityRegistration, type InputValidation } from './registry'

/** The fixed instant every capability test runs at. Injected, never read. */
export const SENSES_TEST_NOW = '2026-10-01T12:00:00.000Z'

/** Options for a capability test run. Every field has a safe default. */
export interface SensesTestOptions {
  readonly now?: string
  readonly caller?: SensesCaller
  readonly budgetRemaining?: number
  readonly requiredBudget?: number
  readonly approvals?: readonly string[]
  readonly stopAllActive?: boolean
  readonly requiresCognition?: boolean
  readonly cognitionGrantId?: string | null
  readonly seam?: SensesAuthoritySeam
}

/**
 * Build the trusted caller a capability test runs as.
 *
 * The caller holds every capability kind, which is exactly what makes the test
 * about the *registry and pipeline* rather than about Guard policy.
 */
export function testCaller(overrides: Partial<SensesCaller> = {}): SensesCaller {
  return {
    principalId: 'principal-test',
    trusted: true,
    scope: 'test',
    heldCapabilities: [...PHASE25_CAPABILITY_KINDS],
    ...overrides,
  }
}

/** Create a test action request with a stable id derived from the test id. */
export function createTestActionRequest(
  testId: string,
  capabilityKind: Phase25CapabilityKind,
  action: string,
  input: Record<string, unknown>,
): CapabilityActionRequest {
  return { actionId: `action-${testId}`, capabilityKind, action, input }
}

/**
 * Run one capability test through the admission pipeline.
 *
 * An admitted action maps to `completed`, a refusal maps to `refused` with its
 * closed code. `failed` is reserved for a future executor and never produced
 * here. `durationMs` is always `0`: a deterministic test has no duration to
 * report.
 *
 * ## `completed` here means *admitted*, not *executed*
 *
 * The outcome vocabulary overlaps with {@link CapabilityActionResult}'s status
 * by design, so read it precisely: `completed` says the registry accepted the
 * action and every gate opened. It does **not** say a browser navigated or a
 * command ran — this build has no executor, and the admitted action stops at
 * `pending`. A `CapabilityTestResult` is a verdict about the *registry and the
 * admission pipeline*; it is never execution evidence, carries no observation
 * ids and no settle instant, and must not be recorded as an action result or
 * projected as one.
 */
export function runCapabilityTest(
  test: CapabilityTestCase,
  options: SensesTestOptions = {},
): CapabilityTestResult {
  const request = createTestActionRequest(
    test.testId,
    test.capabilityKind,
    test.action,
    test.input,
  )
  const decision = admitCapabilityAction({
    request,
    caller: options.caller ?? testCaller(),
    stopAllActive: options.stopAllActive ?? false,
    now: options.now ?? SENSES_TEST_NOW,
    budgetRemaining: options.budgetRemaining ?? Number.MAX_SAFE_INTEGER,
    requiredBudget: options.requiredBudget ?? 0,
    approvals: new Set(options.approvals ?? [request.actionId]),
    requiresCognition: options.requiresCognition ?? false,
    cognitionGrantId: options.cognitionGrantId ?? null,
    ...(options.seam === undefined ? {} : { seam: options.seam }),
  })
  const actualOutcome: CapabilityTestResult['actualOutcome'] =
    decision.decision === 'admitted' ? 'completed' : 'refused'
  const actualReason = decision.decision === 'refused' ? decision.code : null
  const passed =
    actualOutcome === test.expectedOutcome &&
    (test.expectedReason === undefined || test.expectedReason === actualReason)
  return { testId: test.testId, passed, actualOutcome, actualReason, durationMs: 0 }
}

/** Run a suite of capability tests. */
export function runCapabilityTests(
  tests: readonly CapabilityTestCase[],
  options: SensesTestOptions = {},
): readonly CapabilityTestResult[] {
  return tests.map((test) => runCapabilityTest(test, options))
}

/** One row of the capability matrix: every action this build routes. */
export interface CapabilityMatrixRow {
  readonly capabilityKind: Phase25CapabilityKind
  readonly action: string
  readonly inputFields: readonly string[]
  readonly timeoutMs: number
  readonly risk: string
  readonly requiresApproval: boolean
}

/**
 * Every routed (kind, action) pair, in declaration order.
 *
 * This is the closed surface a capability test suite must cover.
 */
export function capabilityMatrix(): readonly CapabilityMatrixRow[] {
  const rows: CapabilityMatrixRow[] = []
  for (const kind of PHASE25_CAPABILITY_KINDS) {
    const registration = capabilityRegistration(kind)
    if (registration === null) continue
    for (const action of registration.actions) {
      rows.push({
        capabilityKind: kind,
        action: action.action,
        inputFields: action.inputFields,
        timeoutMs: action.timeoutMs,
        risk: action.risk,
        requiresApproval: action.requiresApproval,
      })
    }
  }
  return rows
}

/* ------------------------------------------------------- record factories */

/**
 * The record factories fail closed.
 *
 * These are exported from the domain surface, so they hold the same line as the
 * admission pipeline: garbage in yields `null` out, never a plausible-looking
 * record. In particular they never
 *
 * - fabricate an instant they were not given,
 * - report a duration that is `NaN`, infinite, or clamped from a nonsensical
 *   pair of instants,
 * - truncate an over-long observation silently, or
 * - accept an id or status outside its closed vocabulary.
 *
 * `null` is the module's own "not known" value (`durationMs`, `settledAt`,
 * `verdictAt`), so failing closed needs no new vocabulary.
 */

const RESULT_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'timed_out'] as const
const OBSERVATION_KINDS = ['result', 'exit', 'change', 'failure', 'input'] as const
const VERIFICATION_STATUSES = ['requested', 'passed', 'failed'] as const

/** Whether a value is one of a closed string set. */
function isOneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value)
}

/**
 * Create a bounded action result record.
 *
 * Records what happened; it is not evidence the action worked. Returns `null`
 * when the inputs cannot produce an honest record:
 *
 * - the action id is not a bounded opaque id;
 * - the status is outside the closed set;
 * - `startedAt` is not an instant;
 * - a terminal status carries no valid `settledAt`, or one that precedes the
 *   start — a negative span is not a zero-length action, so it is refused
 *   rather than clamped to `0`.
 *
 * A `running` action has not settled, so it must arrive with `settledAt: null`
 * and reports `durationMs: null`.
 */
export function createActionResult(
  actionId: string,
  status: CapabilityActionResult['status'],
  startedAt: string,
  settledAt: string | null,
): CapabilityActionResult | null {
  if (!isSensesId(actionId)) return null
  if (!isOneOf(RESULT_STATUSES, status)) return null
  const startedMs = instantMs(startedAt)
  if (startedMs === null) return null

  if (status === 'running') {
    if (settledAt !== null) return null
    return Object.freeze({
      actionId,
      status,
      startedAt,
      settledAt: null,
      durationMs: null,
      reason: null,
      observationIds: [],
    })
  }

  const settledMs = settledAt === null ? null : instantMs(settledAt)
  if (settledAt === null || settledMs === null) return null
  const durationMs = settledMs - startedMs
  if (!Number.isFinite(durationMs) || durationMs < 0) return null

  return Object.freeze({
    actionId,
    status,
    startedAt,
    settledAt,
    durationMs,
    reason: null,
    observationIds: [],
  })
}

/**
 * Create a bounded observation record. An observation is not a conclusion.
 *
 * Returns `null` when the record would be dishonest or unbounded: a malformed
 * observation or action id, a `recordedAt` that is not an instant, a `kind`
 * outside the closed vocabulary, or a `summary` longer than
 * {@link PHASE25_LIMITS.maxInputBytes}. An over-long summary is refused rather
 * than truncated, because a silently shortened observation is not the
 * observation that happened.
 *
 * `data` is always empty: this factory attaches no payload, so no private
 * content can reach a record through it.
 */
export function createObservation(
  observationId: string,
  actionId: string,
  kind: CapabilityObservationRecord['kind'],
  summary: string,
  recordedAt: string,
): CapabilityObservationRecord | null {
  if (!isSensesId(observationId) || !isSensesId(actionId)) return null
  if (!isOneOf(OBSERVATION_KINDS, kind)) return null
  if (typeof summary !== 'string' || summary.length > PHASE25_LIMITS.maxInputBytes) return null
  if (instantMs(recordedAt) === null) return null
  return Object.freeze({
    observationId,
    actionId,
    kind,
    summary,
    data: {},
    recordedAt,
  })
}

/**
 * Create a bounded verification record. Only this can close an action as verified.
 *
 * Returns `null` when the record would be dishonest: a malformed verification or
 * action id, a status outside the closed vocabulary, a terminal status with no
 * valid `verdictAt`, or a `requested` status that claims one. The verdict instant
 * is the caller's to state — this factory never substitutes an instant of its
 * own, because a stamped verdict time that did not happen is a fabricated
 * instant.
 */
export function createVerification(
  verificationId: string,
  actionId: string,
  status: CapabilityVerificationResult['status'],
  verdictAt: string | null,
): CapabilityVerificationResult | null {
  if (!isSensesId(verificationId) || !isSensesId(actionId)) return null
  if (!isOneOf(VERIFICATION_STATUSES, status)) return null
  if (status === 'requested') {
    if (verdictAt !== null) return null
    return Object.freeze({
      verificationId,
      actionId,
      status,
      reason: null,
      verdictAt: null,
    })
  }
  if (verdictAt === null || instantMs(verdictAt) === null) return null
  return Object.freeze({
    verificationId,
    actionId,
    status,
    reason: null,
    verdictAt,
  })
}

/** Re-export for callers that validate inputs directly. */
export type { InputValidation }
export type { SensesAdmissionDecision }
