import {
  RESILIENCE_EVENT_TYPES,
  RESILIENCE_EVENT_SET,
  RESILIENCE_PAYLOAD_KEYS,
  FORBIDDEN_RESILIENCE_PAYLOAD_KEYS,
  isFailureKind,
  isRecoveryOutcome,
  isBackupOutcome,
  isDegradedLevel,
  isRepairOutcome,
  type ResilienceEventType,
  type ResilienceLimits,
  type ResilienceState,
  type FailureKind,
  type RecoveryOutcome,
  type BackupOutcome,
  type DegradedLevel,
  type RepairOutcome,
  type ResilienceRefusalCode,
  type ResilienceRefusalSubject,
} from './types'
import { transition, type ResilienceSignal } from './machine'

/**
 * The event-sourced fold.
 *
 * Everything the resilience subsystem knows about itself is derived from its
 * journal, by this file, and from nothing else.
 */

/** The shape this module needs from a journal entry. */
export interface ResilienceJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

export type ResilienceFoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'terminal-state-re-entered'
  | 'unknown-failure-kind'
  | 'unknown-recovery-outcome'
  | 'unknown-backup-outcome'
  | 'unknown-degraded-level'
  | 'unknown-repair-outcome'
  | 'self-approval'
  | 'cap-reached'

export interface ResilienceFoldAnomaly {
  readonly code: ResilienceFoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

export interface ResilienceFailureRecord {
  readonly failureId: string
  readonly kind: FailureKind
  readonly detectedAt: string
  readonly context: string
  readonly recoverable: boolean
}

export interface ResilienceRecoveryRecord {
  readonly recoveryId: string
  readonly failureId: string
  readonly outcome: RecoveryOutcome | null
  readonly reason: string
  readonly startedAt: string
  readonly completedAt: string | null
  readonly progress: number
}

export interface ResilienceRepairRecord {
  readonly repairId: string
  readonly failureId: string
  readonly outcome: RepairOutcome | null
  readonly reason: string
  readonly authorizedBy: string | null
  readonly startedAt: string
  readonly completedAt: string | null
  readonly progress: number
}

export interface ResilienceBackupRecord {
  readonly backupId: string
  readonly environmentId: string
  readonly outcome: BackupOutcome | null
  readonly reason: string
  readonly createdAt: string
  readonly verifiedAt: string | null
}

export interface ResilienceRestoreRecord {
  readonly restoreId: string
  readonly backupId: string
  readonly outcome: BackupOutcome | null
  readonly reason: string
  readonly startedAt: string
  readonly completedAt: string | null
}

export interface ResilienceDegradedModeRecord {
  readonly recordId: string
  readonly level: DegradedLevel
  readonly reason: string
  readonly capabilities: readonly string[]
  readonly startedAt: string
  readonly endedAt: string | null
}

export interface ResilienceRefusal {
  readonly refusalId: string
  readonly code: ResilienceRefusalCode
  readonly subject: ResilienceRefusalSubject
  readonly at: string
}

export interface ResilienceFoldedState {
  readonly currentState: ResilienceState
  readonly failures: readonly ResilienceFailureRecord[]
  readonly recoveries: readonly ResilienceRecoveryRecord[]
  readonly repairs: readonly ResilienceRepairRecord[]
  readonly backups: readonly ResilienceBackupRecord[]
  readonly restores: readonly ResilienceRestoreRecord[]
  readonly degradedModes: readonly ResilienceDegradedModeRecord[]
  readonly refusals: readonly ResilienceRefusal[]
  readonly processedWakeKeys: readonly string[]
  readonly stopAllLatched: boolean
  readonly stopCode: string | null
  readonly lastRefusalCode: string | null
  readonly lastRefusalAt: string | null
  readonly attemptCount: number
  readonly lastContinuationDecision: string | null
  readonly lastContinuationAt: string | null
}

export interface ResilienceFoldResult {
  readonly state: ResilienceFoldedState
  readonly anomalies: readonly ResilienceFoldAnomaly[]
}

/**
 * Facts the single-entry fold cannot see for itself.
 */
export interface ResilienceFoldContext {
  readonly ownerClearedStop: boolean
}

export const FOLD_CONTEXT_CLOSED: ResilienceFoldContext = Object.freeze({ ownerClearedStop: false })

/** How many refusal records the fold keeps. */
const MAX_RETAINED_REFUSALS = 256

/** How many processed wake keys are retained. */
const MAX_PROCESSED_WAKE_KEYS = 256

/** The anomalies that make an entry *unusable* rather than merely suspicious. */
const BLOCKING_ANOMALY_CODES: ReadonlySet<ResilienceFoldAnomalyCode> = new Set([
  'forbidden-payload-key',
  'self-approval',
])

export function initialResilienceState(): ResilienceFoldedState {
  return {
    currentState: 'HEALTHY',
    failures: [],
    recoveries: [],
    repairs: [],
    backups: [],
    restores: [],
    degradedModes: [],
    refusals: [],
    processedWakeKeys: [],
    stopAllLatched: false,
    stopCode: null,
    lastRefusalCode: null,
    lastRefusalAt: null,
    attemptCount: 0,
    lastContinuationDecision: null,
    lastContinuationAt: null,
  }
}

/* -------------------------------------------------------------- readers */

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key]
  return typeof value === 'boolean' ? value : null
}

/* -------------------------------------------------------------- fold */

/**
 * Fold exactly one entry onto a state already derived from the journal.
 */
export function reduceResilienceEntry(
  state: ResilienceFoldedState,
  entry: ResilienceJournalEntry,
  context: ResilienceFoldContext = FOLD_CONTEXT_CLOSED,
  limits?: ResilienceLimits,
): ResilienceFoldResult {
  if (!entry.type.startsWith('resilience.')) {
    if (entry.type === 'security.stop_all.activated') {
      return {
        state: {
          ...state,
          stopAllLatched: true,
          stopCode: 'stop-all-latched',
          currentState: 'FAILED',
        },
        anomalies: [],
      }
    }
    if (entry.type === 'security.stop_all.cleared') {
      if (!context.ownerClearedStop) {
        return {
          state,
          anomalies: [
            {
              code: 'illegal-transition',
              eventType: entry.type,
              detail: 'stop_all.cleared without owner clearance',
            },
          ],
        }
      }
      return {
        state: {
          ...state,
          stopAllLatched: false,
          stopCode: null,
          currentState: 'HEALTHY',
        },
        anomalies: [],
      }
    }
    return { state, anomalies: [] }
  }

  if (!RESILIENCE_EVENT_SET.has(entry.type)) {
    return {
      state,
      anomalies: [
        {
          code: 'unknown-event-type',
          eventType: entry.type,
          detail: `${entry.type} is not one of the ${RESILIENCE_EVENT_TYPES.length} resilience event types`,
        },
      ],
    }
  }

  const type = entry.type as ResilienceEventType
  const raw = entry.payload
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      state,
      anomalies: [
        { code: 'malformed-payload', eventType: type, detail: `${type} carried no object payload` },
      ],
    }
  }
  const payload = raw as Record<string, unknown>
  const anomalies = inspectPayload(type, payload, limits)
  const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : null

  const hasBlocking = anomalies.some((a) => BLOCKING_ANOMALY_CODES.has(a.code))
  if (hasBlocking) {
    return { state, anomalies }
  }

  const result = applyEntry(state, type, payload, recordedAt, anomalies)
  return { state: result, anomalies: [...anomalies] }
}

/**
 * Fold the whole journal into a state.
 */
export function reduceResilienceState(
  entries: readonly ResilienceJournalEntry[],
  limits?: ResilienceLimits,
): ResilienceFoldResult {
  let state = initialResilienceState()
  const anomalies: ResilienceFoldAnomaly[] = []
  let ownerClearedStop = false
  for (const entry of entries) {
    if (!entry) continue
    if (entry.type === 'security.stop_all.cleared') ownerClearedStop = true
    if (entry.type === 'security.stop_all.activated') ownerClearedStop = false
    const result = reduceResilienceEntry(state, entry, { ownerClearedStop }, limits)
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

/**
 * Fold exactly one entry onto a state (single-entry form).
 */
export function reduceResilienceEntryOnly(
  state: ResilienceFoldedState,
  entry: ResilienceJournalEntry,
  context: ResilienceFoldContext = FOLD_CONTEXT_CLOSED,
  limits?: ResilienceLimits,
): ResilienceFoldResult {
  return reduceResilienceEntry(state, entry, context, limits)
}

/* -------------------------------------------------------------- payload inspection */

function inspectPayload(
  type: ResilienceEventType,
  payload: Record<string, unknown>,
  _limits?: ResilienceLimits,
): ResilienceFoldAnomaly[] {
  const anomalies: ResilienceFoldAnomaly[] = []
  const allowed = RESILIENCE_PAYLOAD_KEYS[type] ?? []
  const maxText = 300

  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      if (FORBIDDEN_RESILIENCE_PAYLOAD_KEYS.has(key)) {
        anomalies.push({
          code: 'forbidden-payload-key',
          eventType: type,
          detail: `${type} carries forbidden key "${key}"`,
        })
      } else {
        anomalies.push({
          code: 'unknown-payload-key',
          eventType: type,
          detail: `${type} carries unknown key "${key}"`,
        })
      }
    }
  }

  for (const key of allowed) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > maxText) {
      anomalies.push({
        code: 'oversized-payload-text',
        eventType: type,
        detail: `${type}.${key} exceeds ${maxText} characters`,
      })
    }
  }

  return anomalies
}

/* -------------------------------------------------------------- entry application */

function applyEntry(
  state: ResilienceFoldedState,
  type: ResilienceEventType,
  payload: Record<string, unknown>,
  recordedAt: string | null,
  anomalies: ResilienceFoldAnomaly[],
): ResilienceFoldedState {
  const at = recordedAt ?? ''

  switch (type) {
    case 'resilience.failure.detected': {
      const failureId = readString(payload, 'failureId')
      const kind = readString(payload, 'kind')
      const detectedAt = readString(payload, 'detectedAt')
      const context = readString(payload, 'context') ?? ''
      const recoverable = readBoolean(payload, 'recoverable')

      if (!failureId || !kind || !detectedAt) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'failure.detected missing required fields',
        })
        return state
      }
      if (!isFailureKind(kind)) {
        anomalies.push({
          code: 'unknown-failure-kind',
          eventType: type,
          detail: `unknown failure kind: ${kind}`,
        })
        return state
      }

      const record: ResilienceFailureRecord = {
        failureId,
        kind,
        detectedAt,
        context,
        recoverable: recoverable ?? true,
      }

      const transResult = transition(state.currentState, 'failure-detected')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        failures: [...state.failures, record],
        currentState: newState,
      }
    }

    case 'resilience.recovery.started': {
      const recoveryId = readString(payload, 'recoveryId')
      const failureId = readString(payload, 'failureId')
      const startedAt = readString(payload, 'startedAt') ?? at

      if (!recoveryId || !failureId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'recovery.started missing required fields',
        })
        return state
      }

      const record: ResilienceRecoveryRecord = {
        recoveryId,
        failureId,
        outcome: null,
        reason: 'Recovery in progress',
        startedAt,
        completedAt: null,
        progress: 0,
      }

      const transResult = transition(state.currentState, 'recovery-started')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        recoveries: [...state.recoveries, record],
        currentState: newState,
        attemptCount: state.attemptCount + 1,
      }
    }

    case 'resilience.recovery.completed': {
      const recoveryId = readString(payload, 'recoveryId')
      const outcome = readString(payload, 'outcome')
      const reason = readString(payload, 'reason') ?? 'Recovery completed'
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!recoveryId || !outcome) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'recovery.completed missing required fields',
        })
        return state
      }
      if (!isRecoveryOutcome(outcome)) {
        anomalies.push({
          code: 'unknown-recovery-outcome',
          eventType: type,
          detail: `unknown recovery outcome: ${outcome}`,
        })
        return state
      }

      const recoveries = state.recoveries.map((r) =>
        r.recoveryId === recoveryId
          ? { ...r, outcome, reason, completedAt, progress: 1 }
          : r,
      )

      const signal: ResilienceSignal =
        outcome === 'success'
          ? 'recovery-succeeded'
          : outcome === 'partial'
            ? 'recovery-partial'
            : 'recovery-failed'
      const transResult = transition(state.currentState, signal)
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        recoveries,
        currentState: newState,
      }
    }

    case 'resilience.recovery.failed': {
      const recoveryId = readString(payload, 'recoveryId')
      const reason = readString(payload, 'reason') ?? 'Recovery failed'
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!recoveryId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'recovery.failed missing required fields',
        })
        return state
      }

      const recoveries = state.recoveries.map((r) =>
        r.recoveryId === recoveryId
          ? { ...r, outcome: 'failed' as const, reason, completedAt, progress: 0 }
          : r,
      )

      const transResult = transition(state.currentState, 'recovery-failed')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        recoveries,
        currentState: newState,
      }
    }

    case 'resilience.backup.created': {
      const backupId = readString(payload, 'backupId')
      const environmentId = readString(payload, 'environmentId')
      const outcome = readString(payload, 'outcome')
      const reason = readString(payload, 'reason') ?? 'Backup created'
      const createdAt = readString(payload, 'createdAt') ?? at

      if (!backupId || !environmentId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'backup.created missing required fields',
        })
        return state
      }

      const record: ResilienceBackupRecord = {
        backupId,
        environmentId,
        outcome: outcome && isBackupOutcome(outcome) ? outcome : null,
        reason,
        createdAt,
        verifiedAt: null,
      }

      return {
        ...state,
        backups: [...state.backups, record],
      }
    }

    case 'resilience.backup.verified': {
      const backupId = readString(payload, 'backupId')
      const verifiedAt = readString(payload, 'verifiedAt') ?? at
      const outcome = readString(payload, 'outcome')

      if (!backupId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'backup.verified missing required fields',
        })
        return state
      }

      const backups = state.backups.map((b) =>
        b.backupId === backupId
          ? {
              ...b,
              verifiedAt,
              outcome: outcome && isBackupOutcome(outcome) ? outcome : b.outcome,
            }
          : b,
      )

      return { ...state, backups }
    }

    case 'resilience.restore.started': {
      const restoreId = readString(payload, 'restoreId')
      const backupId = readString(payload, 'backupId')
      const startedAt = readString(payload, 'startedAt') ?? at

      if (!restoreId || !backupId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'restore.started missing required fields',
        })
        return state
      }

      const record: ResilienceRestoreRecord = {
        restoreId,
        backupId,
        outcome: null,
        reason: 'Restore in progress',
        startedAt,
        completedAt: null,
      }

      return {
        ...state,
        restores: [...state.restores, record],
      }
    }

    case 'resilience.restore.completed': {
      const restoreId = readString(payload, 'restoreId')
      const outcome = readString(payload, 'outcome')
      const reason = readString(payload, 'reason') ?? 'Restore completed'
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!restoreId || !outcome) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'restore.completed missing required fields',
        })
        return state
      }
      if (!isBackupOutcome(outcome)) {
        anomalies.push({
          code: 'unknown-backup-outcome',
          eventType: type,
          detail: `unknown backup outcome: ${outcome}`,
        })
        return state
      }

      const restores = state.restores.map((r) =>
        r.restoreId === restoreId ? { ...r, outcome, reason, completedAt } : r,
      )

      return { ...state, restores }
    }

    case 'resilience.restore.failed': {
      const restoreId = readString(payload, 'restoreId')
      const reason = readString(payload, 'reason') ?? 'Restore failed'
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!restoreId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'restore.failed missing required fields',
        })
        return state
      }

      const restores = state.restores.map((r) =>
        r.restoreId === restoreId ? { ...r, outcome: 'failed' as const, reason, completedAt } : r,
      )

      return { ...state, restores }
    }

    case 'resilience.degraded-mode.entered': {
      const recordId = readString(payload, 'recordId')
      const level = readString(payload, 'level')
      const reason = readString(payload, 'reason') ?? 'Degraded mode entered'
      const capabilities = payload.capabilities
      const startedAt = readString(payload, 'startedAt') ?? at

      if (!recordId || !level) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'degraded-mode.entered missing required fields',
        })
        return state
      }
      if (!isDegradedLevel(level)) {
        anomalies.push({
          code: 'unknown-degraded-level',
          eventType: type,
          detail: `unknown degraded level: ${level}`,
        })
        return state
      }

      const caps = Array.isArray(capabilities)
        ? capabilities.filter((c): c is string => typeof c === 'string')
        : []

      const record: ResilienceDegradedModeRecord = {
        recordId,
        level,
        reason,
        capabilities: caps,
        startedAt,
        endedAt: null,
      }

      const transResult = transition(state.currentState, 'degraded-entered')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        degradedModes: [...state.degradedModes, record],
        currentState: newState,
      }
    }

    case 'resilience.degraded-mode.exited': {
      const recordId = readString(payload, 'recordId')
      const endedAt = readString(payload, 'endedAt') ?? at

      if (!recordId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'degraded-mode.exited missing required fields',
        })
        return state
      }

      const degradedModes = state.degradedModes.map((d) =>
        d.recordId === recordId ? { ...d, endedAt } : d,
      )

      const transResult = transition(state.currentState, 'degraded-exited')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        degradedModes,
        currentState: newState,
      }
    }

    case 'resilience.repair.started': {
      const repairId = readString(payload, 'repairId')
      const failureId = readString(payload, 'failureId')
      const authorizedBy = readString(payload, 'authorizedBy')
      const startedAt = readString(payload, 'startedAt') ?? at

      if (!repairId || !failureId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'repair.started missing required fields',
        })
        return state
      }

      const record: ResilienceRepairRecord = {
        repairId,
        failureId,
        outcome: null,
        reason: 'Repair in progress',
        authorizedBy,
        startedAt,
        completedAt: null,
        progress: 0,
      }

      const transResult = transition(state.currentState, 'repair-started')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        repairs: [...state.repairs, record],
        currentState: newState,
      }
    }

    case 'resilience.repair.completed': {
      const repairId = readString(payload, 'repairId')
      const outcome = readString(payload, 'outcome')
      const reason = readString(payload, 'reason') ?? 'Repair completed'
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!repairId || !outcome) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'repair.completed missing required fields',
        })
        return state
      }
      if (!isRepairOutcome(outcome)) {
        anomalies.push({
          code: 'unknown-repair-outcome',
          eventType: type,
          detail: `unknown repair outcome: ${outcome}`,
        })
        return state
      }

      const repairs = state.repairs.map((r) =>
        r.repairId === repairId
          ? { ...r, outcome, reason, completedAt, progress: 1 }
          : r,
      )

      const signal: ResilienceSignal =
        outcome === 'success' || outcome === 'partial' ? 'repair-succeeded' : 'repair-failed'
      const transResult = transition(state.currentState, signal)
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        repairs,
        currentState: newState,
      }
    }

    case 'resilience.repair.failed': {
      const repairId = readString(payload, 'repairId')
      const reason = readString(payload, 'reason') ?? 'Repair failed'
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!repairId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'repair.failed missing required fields',
        })
        return state
      }

      const repairs = state.repairs.map((r) =>
        r.repairId === repairId
          ? { ...r, outcome: 'failed' as const, reason, completedAt, progress: 0 }
          : r,
      )

      const transResult = transition(state.currentState, 'repair-failed')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        repairs,
        currentState: newState,
      }
    }

    case 'resilience.repair.unauthorized': {
      const record: ResilienceRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: 'self-approval-prohibited',
        subject: 'repair',
        at,
      }

      return {
        ...state,
        refusals: [...state.refusals.slice(-MAX_RETAINED_REFUSALS + 1), record],
        lastRefusalCode: record.code,
        lastRefusalAt: at,
      }
    }

    case 'resilience.self-modification.attempted':
    case 'resilience.self-modification.refused': {
      const record: ResilienceRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: 'self-modification-prohibited',
        subject: 'continuation',
        at,
      }

      return {
        ...state,
        refusals: [...state.refusals.slice(-MAX_RETAINED_REFUSALS + 1), record],
        lastRefusalCode: record.code,
        lastRefusalAt: at,
      }
    }

    case 'resilience.continuation.decided': {
      const decision = readString(payload, 'decision')

      return {
        ...state,
        lastContinuationDecision: decision,
        lastContinuationAt: at,
      }
    }

    case 'resilience.wake.received': {
      const wakeKey = readString(payload, 'wakeKey')
      if (wakeKey) {
        return {
          ...state,
          processedWakeKeys: [
            ...state.processedWakeKeys.slice(-MAX_PROCESSED_WAKE_KEYS + 1),
            wakeKey,
          ],
        }
      }
      return state
    }

    case 'resilience.wake.denied': {
      const code = readString(payload, 'code')
      const record: ResilienceRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: (code as ResilienceRefusalCode) ?? 'unknown',
        subject: 'wake',
        at,
      }

      return {
        ...state,
        refusals: [...state.refusals.slice(-MAX_RETAINED_REFUSALS + 1), record],
        lastRefusalCode: record.code,
        lastRefusalAt: at,
      }
    }

    case 'resilience.stopped': {
      return {
        ...state,
        stopAllLatched: true,
        stopCode: 'stop-all-latched',
        currentState: 'FAILED',
      }
    }

    case 'resilience.unstopped': {
      return {
        ...state,
        stopAllLatched: false,
        stopCode: null,
        currentState: 'HEALTHY',
      }
    }

    case 'resilience.reconciled': {
      return state
    }

    case 'resilience.gate.decided': {
      return state
    }

    case 'resilience.refusal.recorded': {
      const code = readString(payload, 'code')
      const record: ResilienceRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: (code as ResilienceRefusalCode) ?? 'unknown',
        subject: 'continuation',
        at,
      }

      return {
        ...state,
        refusals: [...state.refusals.slice(-MAX_RETAINED_REFUSALS + 1), record],
        lastRefusalCode: record.code,
        lastRefusalAt: at,
      }
    }

    default:
      return state
  }
}
