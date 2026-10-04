import { findTimerUsageInSource, findUnboundedLoopInSource } from '../lifeloop/assertions'
import {
  SOVEREIGNTY_ASSERTIONS,
  SOVEREIGNTY_PAYLOAD_KEYS,
  isSovereigntyEventType,
  type SovereigntyAssertionId,
  type SovereigntyLimits,
} from './types'
import { forbiddenKeysIn } from './prohibition'
import type { SovereigntyJournalEntry } from './state'

export type SovereigntyViolationCode =
  | 'real-money-key-in-payload'
  | 'authority-key-in-payload'
  | 'self-approval-in-payload'
  | 'inference-key-in-payload'
  | 'model-call-attributed-to-sovereignty'
  | 'unknown-event-type'
  | 'unknown-payload-key'
  | 'oversized-payload-text'
  | 'malformed-payload'
  | 'timer-in-sovereignty'
  | 'unbounded-loop-in-sovereignty'
  | 'self-modification-in-payload'
  | 'capability-widening-in-payload'
  | 'grant-creation-in-payload'
  | 'silent-resume-in-payload'
  | 'state-fabrication-in-payload'
  | 'plaintext-key-in-payload'
  | 'integrity-fabrication-in-payload'

export interface SovereigntyViolation {
  readonly code: SovereigntyViolationCode
  readonly assertion: SovereigntyAssertionId
  readonly eventIndex: number
  readonly eventType: string
  readonly detail: string
}

export interface SovereigntyAssertionReport {
  readonly holds: boolean
  readonly checks: Readonly<Record<SovereigntyAssertionId, boolean>>
  readonly violations: readonly SovereigntyViolation[]
  readonly counted: {
    readonly sovereigntyEvents: number
    readonly wakes: number
    readonly providerRouted: number
    readonly providerFallback: number
    readonly providerFailed: number
    readonly offlineStarted: number
    readonly offlineEnded: number
    readonly portableDataExported: number
    readonly portableDataImported: number
    readonly portableDataVerified: number
    readonly modelCallsAttributedToSovereignty: number
  }
}

export interface SovereigntyAssertionInput {
  readonly entries: readonly SovereigntyJournalEntry[]
  readonly limits?: SovereigntyLimits
  readonly stopAllActive?: boolean
  readonly structural?: readonly SovereigntyViolation[]
}

const DEFAULT_CHECKS: Readonly<Record<SovereigntyAssertionId, boolean>> = Object.freeze(
  Object.fromEntries(SOVEREIGNTY_ASSERTIONS.map((id) => [id, true])) as Record<
    SovereigntyAssertionId,
    boolean
  >,
)

const INFERENCE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'provider',
  'prompt',
  'completion',
  'inference',
  'cognition',
])

const SELF_MODIFICATION_KEYS: ReadonlySet<string> = new Set([
  'selfModify',
  'self-modify',
  'modifyCode',
  'modify-code',
])

const CAPABILITY_WIDENING_KEYS: ReadonlySet<string> = new Set([
  'widenCapability',
  'widen-capability',
  'addCapability',
  'add-capability',
])

const GRANT_CREATION_KEYS: ReadonlySet<string> = new Set([
  'createGrant',
  'create-grant',
  'grant',
  'grantId',
])

const SILENT_RESUME_KEYS: ReadonlySet<string> = new Set([
  'silentResume',
  'silent-resume',
  'autoResume',
  'auto-resume',
])

const STATE_FABRICATION_KEYS: ReadonlySet<string> = new Set([
  'fabricateState',
  'fabricate-state',
  'fakeState',
  'fake-state',
])

const PLAINTEXT_KEYS: ReadonlySet<string> = new Set([
  'plaintext',
  'unencrypted',
  'plainText',
  'plain-text',
])

const INTEGRITY_FABRICATION_KEYS: ReadonlySet<string> = new Set([
  'fabricateIntegrity',
  'fabricate-integrity',
  'fakeHash',
  'fake-hash',
  'fakeChecksum',
  'fake-checksum',
])

export function analyseSovereigntyAssertions(
  input: SovereigntyAssertionInput,
): SovereigntyAssertionReport {
  const journal = input.entries
  const violations: SovereigntyViolation[] = []
  const counted = {
    sovereigntyEvents: 0,
    wakes: 0,
    providerRouted: 0,
    providerFallback: 0,
    providerFailed: 0,
    offlineStarted: 0,
    offlineEnded: 0,
    portableDataExported: 0,
    portableDataImported: 0,
    portableDataVerified: 0,
    modelCallsAttributedToSovereignty: 0,
  }

  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index]
    if (!entry) continue

    if (entry.type.startsWith('sovereignty.')) {
      counted.sovereigntyEvents += 1

      if (!isSovereigntyEventType(entry.type)) {
        violations.push({
          code: 'unknown-event-type',
          assertion: 'noAuthorityEscalation',
          eventIndex: index,
          eventType: entry.type,
          detail: `${entry.type} is not a known sovereignty event type`,
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
      const allowed = SOVEREIGNTY_PAYLOAD_KEYS[entry.type] ?? []

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
        } else if (PLAINTEXT_KEYS.has(key)) {
          violations.push({
            code: 'plaintext-key-in-payload',
            assertion: 'noPlaintextStorage',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries plaintext key "${key}"`,
          })
        } else if (INTEGRITY_FABRICATION_KEYS.has(key)) {
          violations.push({
            code: 'integrity-fabrication-in-payload',
            assertion: 'noIntegrityFabrication',
            eventIndex: index,
            eventType: entry.type,
            detail: `${entry.type} carries integrity-fabrication key "${key}"`,
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

      if (entry.type === 'sovereignty.wake.received') counted.wakes += 1
      if (entry.type === 'sovereignty.provider.routed') counted.providerRouted += 1
      if (entry.type === 'sovereignty.provider.fallback') counted.providerFallback += 1
      if (entry.type === 'sovereignty.provider.failed') counted.providerFailed += 1
      if (entry.type === 'sovereignty.offline.started') counted.offlineStarted += 1
      if (entry.type === 'sovereignty.offline.ended') counted.offlineEnded += 1
      if (entry.type === 'sovereignty.portable-data.exported') counted.portableDataExported += 1
      if (entry.type === 'sovereignty.portable-data.imported') counted.portableDataImported += 1
      if (entry.type === 'sovereignty.portable-data.verified') counted.portableDataVerified += 1
    }

    if (entry.type === 'model.request.started') {
      const payload = entry.payload as Record<string, unknown> | undefined
      if (
        payload &&
        typeof payload.correlationId === 'string' &&
        payload.correlationId.startsWith('sovereignty-')
      ) {
        counted.modelCallsAttributedToSovereignty += 1
        violations.push({
          code: 'model-call-attributed-to-sovereignty',
          assertion: 'noModelCallWithoutWake',
          eventIndex: index,
          eventType: entry.type,
          detail: 'A model call was attributed to sovereignty',
        })
      }
    }
  }

  if (input.structural) {
    violations.push(...input.structural)
  }

  const checks: Record<SovereigntyAssertionId, boolean> = { ...DEFAULT_CHECKS }
  for (const violation of violations) {
    checks[violation.assertion] = false
  }

  const timerViolations = violations.filter((v) => v.code === 'timer-in-sovereignty')
  const loopViolations = violations.filter((v) => v.code === 'unbounded-loop-in-sovereignty')
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

export function scanSovereigntySource(source: string): readonly SovereigntyViolation[] {
  const violations: SovereigntyViolation[] = []
  const timerFindings = findTimerUsageInSource(source)
  if (timerFindings.length > 0) {
    violations.push({
      code: 'timer-in-sovereignty',
      assertion: 'noContinuousPolling',
      eventIndex: 0,
      eventType: 'source-scan',
      detail: `Timer usage found: ${timerFindings.join(', ')}`,
    })
  }
  const loopFindings = findUnboundedLoopInSource(source)
  if (loopFindings.length > 0) {
    violations.push({
      code: 'unbounded-loop-in-sovereignty',
      assertion: 'noUnrestrictedLoops',
      eventIndex: 0,
      eventType: 'source-scan',
      detail: `Unbounded loop found: ${loopFindings.join(', ')}`,
    })
  }
  return violations
}

export function passingSovereigntyAssertions(): SovereigntyAssertionReport {
  return {
    holds: true,
    checks: { ...DEFAULT_CHECKS },
    violations: [],
    counted: {
      sovereigntyEvents: 0,
      wakes: 0,
      providerRouted: 0,
      providerFallback: 0,
      providerFailed: 0,
      offlineStarted: 0,
      offlineEnded: 0,
      portableDataExported: 0,
      portableDataImported: 0,
      portableDataVerified: 0,
      modelCallsAttributedToSovereignty: 0,
    },
  }
}
