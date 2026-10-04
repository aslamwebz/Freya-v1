import {
  THRESHOLD_EVENT_TYPES,
  THRESHOLD_EVENT_SET,
  THRESHOLD_PAYLOAD_KEYS,
  FORBIDDEN_THRESHOLD_PAYLOAD_KEYS,
  isThresholdEvidenceQuality,
  isMaturityLevel,
  isMaturityDimension,
  isFailClosedKind,
  isRollbackReason,
  type ThresholdEventType,
  type ThresholdLimits,
  type ThresholdState,
  type MaturityLevel,
  type MaturityDimension,
  type FailClosedKind,
  type RollbackReason,
  type ThresholdRefusalCode,
  type ThresholdRefusalSubject,
  type ThresholdEvidenceQuality,
} from './types'
import { transition } from './machine'

/**
 * The event-sourced fold.
 *
 * Everything the threshold subsystem knows about itself is derived from its
 * journal, by this file, and from nothing else.
 */

/** The shape this module needs from a journal entry. */
export interface ThresholdJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

export type ThresholdFoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'terminal-state-re-entered'
  | 'unknown-maturity-level'
  | 'unknown-maturity-dimension'
  | 'unknown-fail-closed-kind'
  | 'unknown-rollback-reason'
  | 'unknown-evidence-quality'
  | 'self-approval'
  | 'cap-reached'

export interface ThresholdFoldAnomaly {
  readonly code: ThresholdFoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

export interface ThresholdAssessmentRecord {
  readonly assessmentId: string
  readonly dimension: MaturityDimension
  readonly level: MaturityLevel | null
  readonly criteriaCount: number
  readonly evidenceCount: number
  readonly startedAt: string
  readonly completedAt: string | null
}

export interface ThresholdEvidenceRecord {
  readonly evidenceId: string
  readonly criterionId: string
  readonly source: string
  readonly quality: ThresholdEvidenceQuality | null
  readonly collectedAt: string
  readonly verifiedAt: string | null
  readonly expiresAt: string | null
}

export interface ThresholdFailClosedRecord {
  readonly recordId: string
  readonly kind: FailClosedKind
  readonly reason: string
  readonly triggeredAt: string
  readonly resolution: string | null
}

export interface ThresholdRollbackRecord {
  readonly rollbackId: string
  readonly reason: RollbackReason
  readonly triggeredAt: string
  readonly approvedBy: string | null
  readonly completedAt: string | null
}

export interface ThresholdRefusal {
  readonly refusalId: string
  readonly code: ThresholdRefusalCode
  readonly subject: ThresholdRefusalSubject
  readonly at: string
}

export interface ThresholdFoldedState {
  readonly currentState: ThresholdState
  readonly assessments: readonly ThresholdAssessmentRecord[]
  readonly evidence: readonly ThresholdEvidenceRecord[]
  readonly failClosed: readonly ThresholdFailClosedRecord[]
  readonly rollbacks: readonly ThresholdRollbackRecord[]
  readonly refusals: readonly ThresholdRefusal[]
  readonly processedWakeKeys: readonly string[]
  readonly stopAllLatched: boolean
  readonly stopCode: string | null
  readonly lastRefusalCode: string | null
  readonly lastRefusalAt: string | null
  readonly attemptCount: number
  readonly lastDecision: string | null
  readonly lastDecisionAt: string | null
}

export interface ThresholdFoldResult {
  readonly state: ThresholdFoldedState
  readonly anomalies: readonly ThresholdFoldAnomaly[]
}

/**
 * Facts the single-entry fold cannot see for itself.
 */
export interface ThresholdFoldContext {
  readonly ownerClearedStop: boolean
}

export const FOLD_CONTEXT_CLOSED: ThresholdFoldContext = Object.freeze({ ownerClearedStop: false })

/** How many refusal records the fold keeps. */
const MAX_RETAINED_REFUSALS = 256

/** How many processed wake keys are retained. */
const MAX_PROCESSED_WAKE_KEYS = 256

/** The anomalies that make an entry *unusable* rather than merely suspicious. */
const BLOCKING_ANOMALY_CODES: ReadonlySet<ThresholdFoldAnomalyCode> = new Set([
  'forbidden-payload-key',
  'self-approval',
])

export function initialThresholdState(): ThresholdFoldedState {
  return {
    currentState: 'UNPROVEN',
    assessments: [],
    evidence: [],
    failClosed: [],
    rollbacks: [],
    refusals: [],
    processedWakeKeys: [],
    stopAllLatched: false,
    stopCode: null,
    lastRefusalCode: null,
    lastRefusalAt: null,
    attemptCount: 0,
    lastDecision: null,
    lastDecisionAt: null,
  }
}

/* -------------------------------------------------------------- readers */

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/* -------------------------------------------------------------- fold */

/**
 * Fold exactly one entry onto a state already derived from the journal.
 */
export function reduceThresholdEntry(
  state: ThresholdFoldedState,
  entry: ThresholdJournalEntry,
  context: ThresholdFoldContext = FOLD_CONTEXT_CLOSED,
  limits?: ThresholdLimits,
): ThresholdFoldResult {
  if (!entry.type.startsWith('threshold.')) {
    if (entry.type === 'security.stop_all.activated') {
      return {
        state: {
          ...state,
          stopAllLatched: true,
          stopCode: 'stop-all-latched',
          currentState: 'SUSPENDED',
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
          currentState: 'UNPROVEN',
        },
        anomalies: [],
      }
    }
    return { state, anomalies: [] }
  }

  if (!THRESHOLD_EVENT_SET.has(entry.type)) {
    return {
      state,
      anomalies: [
        {
          code: 'unknown-event-type',
          eventType: entry.type,
          detail: `${entry.type} is not one of the ${THRESHOLD_EVENT_TYPES.length} threshold event types`,
        },
      ],
    }
  }

  const type = entry.type as ThresholdEventType
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
export function reduceThresholdState(
  entries: readonly ThresholdJournalEntry[],
  limits?: ThresholdLimits,
): ThresholdFoldResult {
  let state = initialThresholdState()
  const anomalies: ThresholdFoldAnomaly[] = []
  let ownerClearedStop = false
  for (const entry of entries) {
    if (!entry) continue
    if (entry.type === 'security.stop_all.cleared') ownerClearedStop = true
    if (entry.type === 'security.stop_all.activated') ownerClearedStop = false
    const result = reduceThresholdEntry(state, entry, { ownerClearedStop }, limits)
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

/**
 * Fold exactly one entry onto a state (single-entry form).
 */
export function reduceThresholdEntryOnly(
  state: ThresholdFoldedState,
  entry: ThresholdJournalEntry,
  context: ThresholdFoldContext = FOLD_CONTEXT_CLOSED,
  limits?: ThresholdLimits,
): ThresholdFoldResult {
  return reduceThresholdEntry(state, entry, context, limits)
}

/* -------------------------------------------------------------- payload inspection */

function inspectPayload(
  type: ThresholdEventType,
  payload: Record<string, unknown>,
  _limits?: ThresholdLimits,
): ThresholdFoldAnomaly[] {
  const anomalies: ThresholdFoldAnomaly[] = []
  const allowed = THRESHOLD_PAYLOAD_KEYS[type] ?? []
  const maxText = 300

  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      if (FORBIDDEN_THRESHOLD_PAYLOAD_KEYS.has(key)) {
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
  state: ThresholdFoldedState,
  type: ThresholdEventType,
  payload: Record<string, unknown>,
  recordedAt: string | null,
  anomalies: ThresholdFoldAnomaly[],
): ThresholdFoldedState {
  const at = recordedAt ?? ''

  switch (type) {
    case 'threshold.assessment.started': {
      const assessmentId = readString(payload, 'assessmentId')
      const dimension = readString(payload, 'dimension')
      const startedAt = readString(payload, 'startedAt') ?? at

      if (!assessmentId || !dimension) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'assessment.started missing required fields',
        })
        return state
      }
      if (!isMaturityDimension(dimension)) {
        anomalies.push({
          code: 'unknown-maturity-dimension',
          eventType: type,
          detail: `unknown maturity dimension: ${dimension}`,
        })
        return state
      }

      const record: ThresholdAssessmentRecord = {
        assessmentId,
        dimension,
        level: null,
        criteriaCount: 0,
        evidenceCount: 0,
        startedAt,
        completedAt: null,
      }

      const transResult = transition(state.currentState, 'assessment-started')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        assessments: [...state.assessments, record],
        currentState: newState,
        attemptCount: state.attemptCount + 1,
      }
    }

    case 'threshold.assessment.completed': {
      const assessmentId = readString(payload, 'assessmentId')
      const level = readString(payload, 'level')
      const criteriaCount = payload.criteriaCount
      const evidenceCount = payload.evidenceCount
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!assessmentId || !level) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'assessment.completed missing required fields',
        })
        return state
      }
      if (!isMaturityLevel(level)) {
        anomalies.push({
          code: 'unknown-maturity-level',
          eventType: type,
          detail: `unknown maturity level: ${level}`,
        })
        return state
      }

      const assessments = state.assessments.map((a) =>
        a.assessmentId === assessmentId
          ? {
              ...a,
              level,
              criteriaCount:
                typeof criteriaCount === 'number' && Number.isInteger(criteriaCount) && criteriaCount >= 0
                  ? criteriaCount
                  : a.criteriaCount,
              evidenceCount:
                typeof evidenceCount === 'number' && Number.isInteger(evidenceCount) && evidenceCount >= 0
                  ? evidenceCount
                  : a.evidenceCount,
              completedAt,
            }
          : a,
      )

      const transResult = transition(state.currentState, 'assessment-completed')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        assessments,
        currentState: newState,
      }
    }

    case 'threshold.evidence.collected': {
      const evidenceId = readString(payload, 'evidenceId')
      const criterionId = readString(payload, 'criterionId')
      const source = readString(payload, 'source')
      const quality = readString(payload, 'quality')
      const collectedAt = readString(payload, 'collectedAt') ?? at

      if (!evidenceId || !criterionId || !source) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'evidence.collected missing required fields',
        })
        return state
      }

      const record: ThresholdEvidenceRecord = {
        evidenceId,
        criterionId,
        source,
        quality: quality && isThresholdEvidenceQuality(quality) ? quality : null,
        collectedAt,
        verifiedAt: null,
        expiresAt: null,
      }

      const transResult = transition(state.currentState, 'evidence-collected')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        evidence: [...state.evidence, record],
        currentState: newState,
      }
    }

    case 'threshold.evidence.verified': {
      const evidenceId = readString(payload, 'evidenceId')
      const quality = readString(payload, 'quality')
      const verifiedAt = readString(payload, 'verifiedAt') ?? at
      const expiresAt = readString(payload, 'expiresAt')

      if (!evidenceId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'evidence.verified missing required fields',
        })
        return state
      }

      const evidence = state.evidence.map((e) =>
        e.evidenceId === evidenceId
          ? {
              ...e,
              quality: quality && isThresholdEvidenceQuality(quality) ? quality : e.quality,
              verifiedAt,
              expiresAt: expiresAt ?? e.expiresAt,
            }
          : e,
      )

      const transResult = transition(state.currentState, 'evidence-verified')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        evidence,
        currentState: newState,
      }
    }

    case 'threshold.evidence.fabrication-detected': {
      const evidenceId = readString(payload, 'evidenceId')
      const detectedAt = readString(payload, 'detectedAt') ?? at

      if (!evidenceId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'evidence.fabrication-detected missing required fields',
        })
        return state
      }

      const record: ThresholdRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: 'evidence-fabrication-prohibited',
        subject: 'evidence',
        at: detectedAt,
      }

      const transResult = transition(state.currentState, 'evidence-fabrication-detected')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        refusals: [...state.refusals.slice(-MAX_RETAINED_REFUSALS + 1), record],
        lastRefusalCode: record.code,
        lastRefusalAt: detectedAt,
        currentState: newState,
      }
    }

    case 'threshold.fail-closed.triggered': {
      const recordId = readString(payload, 'recordId')
      const kind = readString(payload, 'kind')
      const reason = readString(payload, 'reason') ?? 'Fail-closed condition triggered'
      const triggeredAt = readString(payload, 'triggeredAt') ?? at

      if (!recordId || !kind) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'fail-closed.triggered missing required fields',
        })
        return state
      }
      if (!isFailClosedKind(kind)) {
        anomalies.push({
          code: 'unknown-fail-closed-kind',
          eventType: type,
          detail: `unknown fail-closed kind: ${kind}`,
        })
        return state
      }

      const record: ThresholdFailClosedRecord = {
        recordId,
        kind,
        reason,
        triggeredAt,
        resolution: null,
      }

      const transResult = transition(state.currentState, 'fail-closed-triggered')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        failClosed: [...state.failClosed, record],
        currentState: newState,
      }
    }

    case 'threshold.fail-closed.resolved': {
      const recordId = readString(payload, 'recordId')
      const resolution = readString(payload, 'resolution')

      if (!recordId || !resolution) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'fail-closed.resolved missing required fields',
        })
        return state
      }

      const failClosed = state.failClosed.map((f) =>
        f.recordId === recordId ? { ...f, resolution } : f,
      )

      const transResult = transition(state.currentState, 'fail-closed-resolved')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        failClosed,
        currentState: newState,
      }
    }

    case 'threshold.decision.proven': {
      const decisionId = readString(payload, 'decisionId')
      const decidedAt = readString(payload, 'decidedAt') ?? at

      if (!decisionId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'decision.proven missing required fields',
        })
        return state
      }

      const transResult = transition(state.currentState, 'decision-proven')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        currentState: newState,
        lastDecision: 'proven',
        lastDecisionAt: decidedAt,
      }
    }

    case 'threshold.decision.not-proven': {
      const decisionId = readString(payload, 'decisionId')
      const decidedAt = readString(payload, 'decidedAt') ?? at

      if (!decisionId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'decision.not-proven missing required fields',
        })
        return state
      }

      const transResult = transition(state.currentState, 'decision-not-proven')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        currentState: newState,
        lastDecision: 'not-proven',
        lastDecisionAt: decidedAt,
      }
    }

    case 'threshold.suspended': {
      const transResult = transition(state.currentState, 'suspended')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        currentState: newState,
      }
    }

    case 'threshold.resumed': {
      const transResult = transition(state.currentState, 'resumed')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        currentState: newState,
      }
    }

    case 'threshold.rollback.started': {
      const rollbackId = readString(payload, 'rollbackId')
      const reason = readString(payload, 'reason')
      const startedAt = readString(payload, 'startedAt') ?? at

      if (!rollbackId || !reason) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'rollback.started missing required fields',
        })
        return state
      }
      if (!isRollbackReason(reason)) {
        anomalies.push({
          code: 'unknown-rollback-reason',
          eventType: type,
          detail: `unknown rollback reason: ${reason}`,
        })
        return state
      }

      const record: ThresholdRollbackRecord = {
        rollbackId,
        reason,
        triggeredAt: startedAt,
        approvedBy: null,
        completedAt: null,
      }

      const transResult = transition(state.currentState, 'rollback-started')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        rollbacks: [...state.rollbacks, record],
        currentState: newState,
      }
    }

    case 'threshold.rollback.completed': {
      const rollbackId = readString(payload, 'rollbackId')
      const approvedBy = readString(payload, 'approvedBy')
      const completedAt = readString(payload, 'completedAt') ?? at

      if (!rollbackId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'rollback.completed missing required fields',
        })
        return state
      }

      const rollbacks = state.rollbacks.map((r) =>
        r.rollbackId === rollbackId ? { ...r, approvedBy, completedAt } : r,
      )

      const transResult = transition(state.currentState, 'rollback-completed')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        rollbacks,
        currentState: newState,
      }
    }

    case 'threshold.wake.received': {
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

    case 'threshold.wake.denied': {
      const code = readString(payload, 'code')
      const record: ThresholdRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: (code as ThresholdRefusalCode) ?? 'unknown',
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

    default:
      return state
  }
}
