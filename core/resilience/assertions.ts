import { findTimerUsageInSource, findUnboundedLoopInSource } from '../lifeloop/assertions'
import {
  RESILIENCE_ASSERTIONS,
  RESILIENCE_PAYLOAD_KEYS,
  isResilienceEventType,
  type ResilienceAssertionId,
  type ResilienceLimits,
} from './types'
import { forbiddenKeysIn } from './prohibition'
import type { ResilienceJournalEntry } from './state'

/**
 * The Phase 36 assertions, as checkable functions.
 */

export type ResilienceViolationCode =
  | 'real-money-key-in-payload'
  | 'real-venue-key-in-payload'
  | 'authority-key-in-payload'
  | 'budget-key-in-payload'
  | 'self-approval-in-payload'
  | 'inference-key-in-payload'
  | 'model-call-attributed-to-resilience'
  | 'model-call-while-stopped'
  | 'work-while-stopped'
  | 'unknown-event-type'
  | 'unknown-payload-key'
  | 'oversized-payload-text'
  | 'malformed-payload'
  | 'timer-in-resilience'
  | 'unbounded-loop-in-resilience'
  | 'self-modification-in-payload'
  | 'capability-widening-in-payload'
  | 'grant-creation-in-payload'
  | 'silent-resume-in-payload'
  | 'state-fabrication-in-payload'
  | 'degradation-hiding-in-payload'
  | 'capability-fabrication-in-payload'

export interface ResilienceViolation {
  readonly code: ResilienceViolationCode
  readonly assertion: ResilienceAssertionId
  readonly eventIndex: number
  readonly eventType: string
  readonly detail: string
}

export interface ResilienceAssertionReport {
  readonly holds: boolean
  readonly checks: Readonly<Record<ResilienceAssertionId, boolean>>
  readonly violations: readonly ResilienceViolation[]
  readonly counted: {
    readonly resilienceEvents: number
    readonly wakes: number
    readonly failuresDetected: number
    readonly recoveriesStarted: number
    readonly repairsStarted: number
    readonly backupsCreated: number
    readonly restoresStarted: number
    readonly degradedModeEntries: number
    readonly modelCallsAttributedToResilience: number
  }
}

export interface ResilienceAssertionInput {
  readonly entries: readonly ResilienceJournalEntry[]
  readonly limits?: ResilienceLimits
  readonly stopAllActive?: boolean
  readonly structural?: readonly ResilienceViolation[]
}

const DEFAULT_CHECKS: Readonly<Record<ResilienceAssertionId, boolean>> = Object.freeze(
  Object.fromEntries(RESILIENCE_ASSERTIONS.map((id) => [id, true])) as Record<
    ResilienceAssertionId,
    boolean
  >,
)

/** Payload keys that would mean a resilience event could reach a model. */
const INFERENCE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'provider',
  'prompt',
  'completion',
  'inference',
  'cognition',
])

/** Payload keys that would mean a resilience event could self-modify. */
const SELF_MODIFICATION_KEYS: ReadonlySet<string> = new Set([
  'selfModify',
  'self-modify',
  'modifyCode',
  'modify-code',
  'patch',
  'patchCode',
])

/** Payload keys that would mean a resilience event could widen capability. */
const CAPABILITY_WIDENING_KEYS: ReadonlySet<string> = new Set([
  'widenCapability',
  'widen-capability',
  'addCapability',
  'add-capability',
  'escalate',
])

/** Payload keys that would mean a resilience event could create a grant. */
const GRANT_CREATION_KEYS: ReadonlySet<string> = new Set([
  'createGrant',
  'create-grant',
  'grant',
  'grantId',
])

/** Payload keys that would mean a resilience event could silently resume. */
const SILENT_RESUME_KEYS: ReadonlySet<string> = new Set([
  'silentResume',
  'silent-resume',
  'autoResume',
  'auto-resume',
  'resume',
])

/** Payload keys that would mean a resilience event could fabricate state. */
const STATE_FABRICATION_KEYS: ReadonlySet<string> = new Set([
  'fabricateState',
  'fabricate-state',
  'fakeState',
  'fake-state',
  'pretend',
])

/** Payload keys that would mean a resilience event could hide degradation. */
const DEGRADATION_HIDING_KEYS: ReadonlySet<string> = new Set([
  'hideDegradation',
  'hide-degradation',
  'conceal',
  'suppress',
])

/** Payload keys that would mean a resilience event could fabricate capability. */
const CAPABILITY_FABRICATION_KEYS: ReadonlySet<string> = new Set([
  'fabricateCapability',
  'fabricate-capability',
  'fakeCapability',
  'fake-capability',
  'pretendCapability',
])

/**
 * Analyse the journal against every assertion.
 */
export function analyseResilienceAssertions(
  input: ResilienceAssertionInput,
): ResilienceAssertionReport {
  const journal = input.entries
  const violations: ResilienceViolation[] = []
  const counted = {
    resilienceEvents: 0,
    wakes: 0,
    failuresDetected: 0,
    recoveriesStarted: 0,
    repairsStarted: 0,
    backupsCreated: 0,
    restoresStarted: 0,
    degradedModeEntries: 0,
    modelCallsAttributedToResilience: 0,
  }

  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index]
    if (!entry) continue

    if (entry.type.startsWith('resilience.')) {
      counted.resilienceEvents += 1

      if (!isResilienceEventType(entry.type)) {
        violations.push({
          code: 'unknown-event-type',
          assertion: 'noAuthorityEscalation',
          eventIndex: index,
          eventType: entry.type,
          detail: `${entry.type} is not a known resilience event type`,
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
      const allowed = RESILIENCE_PAYLOAD_KEYS[entry.type] ?? []

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

      if (entry.type === 'resilience.wake.received') counted.wakes += 1
      if (entry.type === 'resilience.failure.detected') counted.failuresDetected += 1
      if (entry.type === 'resilience.recovery.started') counted.recoveriesStarted += 1
      if (entry.type === 'resilience.repair.started') counted.repairsStarted += 1
      if (entry.type === 'resilience.backup.created') counted.backupsCreated += 1
      if (entry.type === 'resilience.restore.started') counted.restoresStarted += 1
      if (entry.type === 'resilience.degraded-mode.entered') counted.degradedModeEntries += 1
    }

    if (entry.type === 'model.request.started') {
      const payload = entry.payload as Record<string, unknown> | undefined
      if (
        payload &&
        typeof payload.correlationId === 'string' &&
        payload.correlationId.startsWith('resilience-')
      ) {
        counted.modelCallsAttributedToResilience += 1
        violations.push({
          code: 'model-call-attributed-to-resilience',
          assertion: 'noModelCallWithoutWake',
          eventIndex: index,
          eventType: entry.type,
          detail: 'A model call was attributed to resilience',
        })
      }
    }
  }

  if (input.structural) {
    violations.push(...input.structural)
  }

  const checks: Record<ResilienceAssertionId, boolean> = { ...DEFAULT_CHECKS }
  for (const violation of violations) {
    checks[violation.assertion] = false
  }

  const timerViolations = violations.filter((v) => v.code === 'timer-in-resilience')
  const loopViolations = violations.filter((v) => v.code === 'unbounded-loop-in-resilience')
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
export function scanResilienceSource(source: string): readonly ResilienceViolation[] {
  const violations: ResilienceViolation[] = []
  const timerFindings = findTimerUsageInSource(source)
  if (timerFindings.length > 0) {
    violations.push({
      code: 'timer-in-resilience',
      assertion: 'noContinuousPolling',
      eventIndex: 0,
      eventType: 'source-scan',
      detail: `Timer usage found: ${timerFindings.join(', ')}`,
    })
  }
  const loopFindings = findUnboundedLoopInSource(source)
  if (loopFindings.length > 0) {
    violations.push({
      code: 'unbounded-loop-in-resilience',
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
export function passingResilienceAssertions(): ResilienceAssertionReport {
  return {
    holds: true,
    checks: { ...DEFAULT_CHECKS },
    violations: [],
    counted: {
      resilienceEvents: 0,
      wakes: 0,
      failuresDetected: 0,
      recoveriesStarted: 0,
      repairsStarted: 0,
      backupsCreated: 0,
      restoresStarted: 0,
      degradedModeEntries: 0,
      modelCallsAttributedToResilience: 0,
    },
  }
}
