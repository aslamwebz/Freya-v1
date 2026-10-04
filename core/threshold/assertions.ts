import { findTimerUsageInSource, findUnboundedLoopInSource } from '../lifeloop/assertions'
import {
  THRESHOLD_ASSERTIONS,
  THRESHOLD_PAYLOAD_KEYS,
  isThresholdEventType,
  type ThresholdAssertionId,
  type ThresholdLimits,
} from './types'
import { forbiddenKeysIn } from './prohibition'
import type { ThresholdJournalEntry } from './state'

/**
 * The Phase 39 assertions, as checkable functions.
 */

export type ThresholdViolationCode =
  | 'real-money-key-in-payload'
  | 'real-venue-key-in-payload'
  | 'authority-key-in-payload'
  | 'budget-key-in-payload'
  | 'self-approval-in-payload'
  | 'inference-key-in-payload'
  | 'model-call-attributed-to-threshold'
  | 'model-call-while-stopped'
  | 'work-while-stopped'
  | 'unknown-event-type'
  | 'unknown-payload-key'
  | 'oversized-payload-text'
  | 'malformed-payload'
  | 'timer-in-threshold'
  | 'unbounded-loop-in-threshold'
  | 'self-modification-in-payload'
  | 'capability-widening-in-payload'
  | 'grant-creation-in-payload'
  | 'silent-resume-in-payload'
  | 'state-fabrication-in-payload'
  | 'degradation-hiding-in-payload'
  | 'capability-fabrication-in-payload'
  | 'evidence-fabrication-in-payload'
  | 'maturity-self-grant-in-payload'
  | 'maturity-authority-widening-in-payload'

export interface ThresholdViolation {
  readonly code: ThresholdViolationCode
  readonly assertion: ThresholdAssertionId
  readonly eventIndex: number
  readonly eventType: string
  readonly detail: string
}

export interface ThresholdAssertionReport {
  readonly holds: boolean
  readonly checks: Readonly<Record<ThresholdAssertionId, boolean>>
  readonly violations: readonly ThresholdViolation[]
  readonly counted: {
    readonly thresholdEvents: number
    readonly wakes: number
    readonly assessmentsStarted: number
    readonly assessmentsCompleted: number
    readonly evidenceCollected: number
    readonly evidenceVerified: number
    readonly failClosedTriggered: number
    readonly decisionsProven: number
    readonly decisionsNotProven: number
    readonly rollbacksStarted: number
    readonly rollbacksCompleted: number
    readonly modelCallsAttributedToThreshold: number
  }
}

export interface ThresholdAssertionInput {
  readonly entries: readonly ThresholdJournalEntry[]
  readonly limits?: ThresholdLimits
  readonly stopAllActive?: boolean
  readonly structural?: readonly ThresholdViolation[]
}

const DEFAULT_CHECKS: Readonly<Record<ThresholdAssertionId, boolean>> = Object.freeze(
  Object.fromEntries(THRESHOLD_ASSERTIONS.map((id) => [id, true])) as Record<
    ThresholdAssertionId,
    boolean
  >,
)

/** Payload keys that would mean a threshold event could reach a model. */
const INFERENCE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'provider',
  'prompt',
  'completion',
  'inference',
  'cognition',
])

/** Payload keys that would mean a threshold event could self-modify. */
const SELF_MODIFICATION_KEYS: ReadonlySet<string> = new Set([
  'selfModify',
  'self-modify',
  'modifyCode',
  'modify-code',
  'patch',
  'patchCode',
])

/** Payload keys that would mean a threshold event could widen capability. */
const CAPABILITY_WIDENING_KEYS: ReadonlySet<string> = new Set([
  'widenCapability',
  'widen-capability',
  'addCapability',
  'add-capability',
  'escalate',
])

/** Payload keys that would mean a threshold event could create a grant. */
const GRANT_CREATION_KEYS: ReadonlySet<string> = new Set([
  'createGrant',
  'create-grant',
  'grant',
  'grantId',
])

/** Payload keys that would mean a threshold event could silently resume. */
const SILENT_RESUME_KEYS: ReadonlySet<string> = new Set([
  'silentResume',
  'silent-resume',
  'autoResume',
  'auto-resume',
  'resume',
])

/** Payload keys that would mean a threshold event could fabricate state. */
const STATE_FABRICATION_KEYS: ReadonlySet<string> = new Set([
  'fabricateState',
  'fabricate-state',
  'fakeState',
  'fake-state',
  'pretend',
])

/** Payload keys that would mean a threshold event could hide degradation. */
const DEGRADATION_HIDING_KEYS: ReadonlySet<string> = new Set([
  'hideDegradation',
  'hide-degradation',
  'conceal',
  'suppress',
])

/** Payload keys that would mean a threshold event could fabricate capability. */
const CAPABILITY_FABRICATION_KEYS: ReadonlySet<string> = new Set([
  'fabricateCapability',
  'fabricate-capability',
  'fakeCapability',
  'fake-capability',
  'pretendCapability',
])

/** Payload keys that would mean a threshold event could fabricate evidence. */
const EVIDENCE_FABRICATION_KEYS: ReadonlySet<string> = new Set([
  'fabricateEvidence',
  'fabricate-evidence',
  'fakeEvidence',
  'fake-evidence',
])

/** Payload keys that would mean a threshold event could self-grant maturity. */
const MATURITY_SELF_GRANT_KEYS: ReadonlySet<string> = new Set([
  'selfGrantMaturity',
  'self-grant-maturity',
  'grantMaturity',
  'grant-maturity',
])

/** Payload keys that would mean a threshold event could widen authority through maturity. */
const MATURITY_AUTHORITY_WIDENING_KEYS: ReadonlySet<string> = new Set([
  'maturityWidensAuthority',
  'maturity-widens-authority',
])

/**
 * Analyse the journal against every assertion.
 */
export function analyseThresholdAssertions(
  input: ThresholdAssertionInput,
): ThresholdAssertionReport {
  const journal = input.entries
  const violations: ThresholdViolation[] = []
  const counted = {
    thresholdEvents: 0,
    wakes: 0,
    assessmentsStarted: 0,
    assessmentsCompleted: 0,
    evidenceCollected: 0,
    evidenceVerified: 0,
    failClosedTriggered: 0,
    decisionsProven: 0,
    decisionsNotProven: 0,
    rollbacksStarted: 0,
    rollbacksCompleted: 0,
    modelCallsAttributedToThreshold: 0,
  }

  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index]
    if (!entry) continue

    if (entry.type.startsWith('threshold.')) {
      counted.thresholdEvents += 1

      if (!isThresholdEventType(entry.type)) {
        violations.push({
          code: 'unknown-event-type',
          assertion: 'noAuthorityEscalation',
          eventIndex: index,
          eventType: entry.type,
          detail: `${entry.type} is not a known threshold event type`,
        })
        continue
      }

      const payload = entry.payload
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        violations.push({
          code: 'malformed-payload',
          assertion: 'noAuthorityEscalation',
          eventIndex: index,
          eventType: entry.type,
          detail: `${entry.type} carried no object payload`,
        })
        continue
      }

      const record = payload as Record<string, unknown>
      const allowed = THRESHOLD_PAYLOAD_KEYS[entry.type] ?? []

      const forbidden = forbiddenKeysIn(record)
      for (const key of forbidden) {
        if (INFERENCE_KEYS.has(key)) {
          violations.push({
            code: 'inference-key-in-payload',
            assertion: 'noModelCallWithoutWake',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries inference key "${key}"`,
          })
        } else if (SELF_MODIFICATION_KEYS.has(key)) {
          violations.push({
            code: 'self-modification-in-payload',
            assertion: 'noSelfModification',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries self-modification key "${key}"`,
          })
        } else if (CAPABILITY_WIDENING_KEYS.has(key)) {
          violations.push({
            code: 'capability-widening-in-payload',
            assertion: 'noCapabilityWidening',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries capability-widening key "${key}"`,
          })
        } else if (GRANT_CREATION_KEYS.has(key)) {
          violations.push({
            code: 'grant-creation-in-payload',
            assertion: 'noGrantCreation',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries grant-creation key "${key}"`,
          })
        } else if (SILENT_RESUME_KEYS.has(key)) {
          violations.push({
            code: 'silent-resume-in-payload',
            assertion: 'noSilentResume',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries silent-resume key "${key}"`,
          })
        } else if (STATE_FABRICATION_KEYS.has(key)) {
          violations.push({
            code: 'state-fabrication-in-payload',
            assertion: 'noStateFabrication',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries state-fabrication key "${key}"`,
          })
        } else if (DEGRADATION_HIDING_KEYS.has(key)) {
          violations.push({
            code: 'degradation-hiding-in-payload',
            assertion: 'noDegradationHiding',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries degradation-hiding key "${key}"`,
          })
        } else if (CAPABILITY_FABRICATION_KEYS.has(key)) {
          violations.push({
            code: 'capability-fabrication-in-payload',
            assertion: 'noCapabilityFabrication',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries capability-fabrication key "${key}"`,
          })
        } else if (EVIDENCE_FABRICATION_KEYS.has(key)) {
          violations.push({
            code: 'evidence-fabrication-in-payload',
            assertion: 'noEvidenceFabrication',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries evidence-fabrication key "${key}"`,
          })
        } else if (MATURITY_SELF_GRANT_KEYS.has(key)) {
          violations.push({
            code: 'maturity-self-grant-in-payload',
            assertion: 'noMaturitySelfGrant',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries maturity-self-grant key "${key}"`,
          })
        } else if (MATURITY_AUTHORITY_WIDENING_KEYS.has(key)) {
          violations.push({
            code: 'maturity-authority-widening-in-payload',
            assertion: 'noMaturityAuthorityWidening',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries maturity-authority-widening key "${key}"`,
          })
        } else {
          violations.push({
            code: 'authority-key-in-payload',
            assertion: 'noAuthorityEscalation',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries forbidden key "${key}"`,
          })
        }
      }

      for (const key of Object.keys(record)) {
        if (!allowed.includes(key) && !forbidden.includes(key)) {
          violations.push({
            code: 'unknown-payload-key',
            assertion: 'noAuthorityEscalation',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries unknown key "${key}"`,
          })
        }
      }

      if (entry.type === 'threshold.wake.received') counted.wakes += 1
      if (entry.type === 'threshold.assessment.started') counted.assessmentsStarted += 1
      if (entry.type === 'threshold.assessment.completed') counted.assessmentsCompleted += 1
      if (entry.type === 'threshold.evidence.collected') counted.evidenceCollected += 1
      if (entry.type === 'threshold.evidence.verified') counted.evidenceVerified += 1
      if (entry.type === 'threshold.fail-closed.triggered') counted.failClosedTriggered += 1
      if (entry.type === 'threshold.decision.proven') counted.decisionsProven += 1
      if (entry.type === 'threshold.decision.not-proven') counted.decisionsNotProven += 1
      if (entry.type === 'threshold.rollback.started') counted.rollbacksStarted += 1
      if (entry.type === 'threshold.rollback.completed') counted.rollbacksCompleted += 1
    }

    if (entry.type === 'model.request.started') {
      const payload = entry.payload as Record<string, unknown> | undefined
      if (
        payload &&
        typeof payload.correlationId === 'string' &&
        payload.correlationId.startsWith('threshold-')
      ) {
        counted.modelCallsAttributedToThreshold += 1
        violations.push({
          code: 'model-call-attributed-to-threshold',
          assertion: 'noModelCallWithoutWake',
          eventIndex: index,
          eventType: entry.type,
          detail: 'A model call was attributed to threshold',
        })
      }
    }
  }

  if (input.structural) {
    violations.push(...input.structural)
  }

  const checks: Record<ThresholdAssertionId, boolean> = { ...DEFAULT_CHECKS }
  for (const violation of violations) {
    checks[violation.assertion] = false
  }

  const timerViolations = violations.filter((v) => v.code === 'timer-in-threshold')
  const loopViolations = violations.filter((v) => v.code === 'unbounded-loop-in-threshold')
  if (timerViolations.length > 0) checks['noContinuousPolling'] = false
  if (loopViolations.length > 0) checks['noUnrestrictedLoops'] = false

  const holds = Object.values(checks).every((v) => v === true)

  return {
    holds,
    checks,
    violations,
    counted,
  }
}

/**
 * Scan a source file for timer usage.
 */
export function scanThresholdSource(source: string): readonly ThresholdViolation[] {
  const violations: ThresholdViolation[] = []
  const timerFindings = findTimerUsageInSource(source)
  if (timerFindings.length > 0) {
    violations.push({
      code: 'timer-in-threshold',
      assertion: 'noContinuousPolling',
      eventIndex: 0,
      eventType: 'source-scan',
      detail: `Timer usage found: ${timerFindings.join(', ')}`,
    })
  }
  const loopFindings = findUnboundedLoopInSource(source)
  if (loopFindings.length > 0) {
    violations.push({
      code: 'unbounded-loop-in-threshold',
      assertion: 'noUnrestrictedLoops',
      eventIndex: 0,
      eventType: 'source-scan',
      detail: `Unbounded loop found: ${loopFindings.join(', ')}`,
    })
  }
  return violations
}

/**
 * The passing assertions, for the absent projection.
 */
export function passingThresholdAssertions(): ThresholdAssertionReport {
  return {
    holds: true,
    checks: { ...DEFAULT_CHECKS },
    violations: [],
    counted: {
      thresholdEvents: 0,
      wakes: 0,
      assessmentsStarted: 0,
      assessmentsCompleted: 0,
      evidenceCollected: 0,
      evidenceVerified: 0,
      failClosedTriggered: 0,
      decisionsProven: 0,
      decisionsNotProven: 0,
      rollbacksStarted: 0,
      rollbacksCompleted: 0,
      modelCallsAttributedToThreshold: 0,
    },
  }
}
