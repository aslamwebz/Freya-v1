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
 * An admitted action maps to `completed` (there is no executor to fail), a
 * refusal maps to `refused` with its closed code. `failed` is reserved for a
 * future executor and never produced here. `durationMs` is always `0`: a
 * deterministic test has no duration to report.
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
 * Create a bounded action result record.
 *
 * Records what happened; it is not evidence the action worked.
 */
export function createActionResult(
  actionId: string,
  status: CapabilityActionResult['status'],
  startedAt: string,
  settledAt: string | null,
): CapabilityActionResult {
  return {
    actionId,
    status,
    startedAt,
    settledAt,
    durationMs: settledAt === null ? null : Math.max(0, Date.parse(settledAt) - Date.parse(startedAt)),
    reason: null,
    observationIds: [],
  }
}

/** Create a bounded observation record. An observation is not a conclusion. */
export function createObservation(
  observationId: string,
  actionId: string,
  kind: CapabilityObservationRecord['kind'],
  summary: string,
  recordedAt: string,
): CapabilityObservationRecord {
  return { observationId, actionId, kind, summary, data: {}, recordedAt }
}

/** Create a verification record. Only this can close an action as verified. */
export function createVerification(
  verificationId: string,
  actionId: string,
  status: CapabilityVerificationResult['status'],
): CapabilityVerificationResult {
  return {
    verificationId,
    actionId,
    status,
    reason: null,
    verdictAt: status === 'requested' ? null : SENSES_TEST_NOW,
  }
}

/** Re-export for callers that validate inputs directly. */
export type { InputValidation }
export type { SensesAdmissionDecision }
