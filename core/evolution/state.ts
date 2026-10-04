import {
  EVOLUTION_EVENT_TYPES,
  EVOLUTION_EVENT_SET,
  EVOLUTION_PAYLOAD_KEYS,
  FORBIDDEN_EVOLUTION_PAYLOAD_KEYS,
  isDriftCheckOutcome,
  isEvidenceQuality,
  isEvidenceSource,
  type DriftCheckOutcome,
  type EvidenceQuality,
  type EvidenceSource,
  type EvolutionEventType,
  type EvolutionState,
  type ImprovementKind,
  type ImprovementState,
  type EvolutionRefusalCode,
  type EvolutionRefusalSubject,
} from './types'
import { transition, type EvolutionSignal } from './machine'

/**
 * The event-sourced fold.
 */

export interface EvolutionJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

export type EvolutionFoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'unknown-evidence-quality'
  | 'unknown-evidence-source'
  | 'unknown-improvement-kind'
  | 'unknown-improvement-state'
  | 'unknown-drift-outcome'
  | 'self-modification-attempt'

export interface EvolutionFoldAnomaly {
  readonly code: EvolutionFoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

export interface EvolutionEvidenceFoldRecord {
  readonly evidenceId: string
  readonly source: EvidenceSource
  readonly quality: EvidenceQuality
  readonly statement: string
  readonly verifiedAt: string
  readonly expiresAt: string
}

export interface EvolutionImprovementFoldRecord {
  readonly improvementId: string
  readonly kind: ImprovementKind
  readonly state: ImprovementState
  readonly evidenceIds: readonly string[]
  readonly description: string
  readonly createdAt: string
  readonly appliedAt: string | null
}

export interface EvolutionDriftCheckFoldRecord {
  readonly checkId: string
  readonly improvementId: string
  readonly outcome: DriftCheckOutcome
  readonly reason: string
  readonly checkedAt: string
}

export interface EvolutionRefusal {
  readonly refusalId: string
  readonly code: EvolutionRefusalCode
  readonly subject: EvolutionRefusalSubject
  readonly at: string
}

export interface EvolutionFoldedState {
  readonly currentState: EvolutionState
  readonly evidence: readonly EvolutionEvidenceFoldRecord[]
  readonly improvements: readonly EvolutionImprovementFoldRecord[]
  readonly driftChecks: readonly EvolutionDriftCheckFoldRecord[]
  readonly refusals: readonly EvolutionRefusal[]
  readonly processedWakeKeys: readonly string[]
  readonly stopAllLatched: boolean
  readonly stopCode: string | null
  readonly lastRefusalCode: string | null
  readonly lastRefusalAt: string | null
  readonly lastContinuationDecision: string | null
  readonly lastContinuationAt: string | null
}

export interface EvolutionFoldResult {
  readonly state: EvolutionFoldedState
  readonly anomalies: readonly EvolutionFoldAnomaly[]
}

export interface EvolutionFoldContext {
  readonly ownerClearedStop: boolean
}

export const FOLD_CONTEXT_CLOSED: EvolutionFoldContext = Object.freeze({ ownerClearedStop: false })

const MAX_RETAINED_REFUSALS = 256
const MAX_PROCESSED_WAKE_KEYS = 256
const MAX_RETAINED_EVIDENCE = 256
const MAX_RETAINED_IMPROVEMENTS = 64
const MAX_RETAINED_DRIFT_CHECKS = 128

const BLOCKING_ANOMALY_CODES: ReadonlySet<EvolutionFoldAnomalyCode> = new Set([
  'forbidden-payload-key',
  'self-modification-attempt',
])

export function initialEvolutionState(): EvolutionFoldedState {
  return {
    currentState: 'STABLE',
    evidence: [],
    improvements: [],
    driftChecks: [],
    refusals: [],
    processedWakeKeys: [],
    stopAllLatched: false,
    stopCode: null,
    lastRefusalCode: null,
    lastRefusalAt: null,
    lastContinuationDecision: null,
    lastContinuationAt: null,
  }
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function reduceEvolutionEntry(
  state: EvolutionFoldedState,
  entry: EvolutionJournalEntry,
  context: EvolutionFoldContext = FOLD_CONTEXT_CLOSED,
): EvolutionFoldResult {
  if (!entry.type.startsWith('evolution.')) {
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
          currentState: 'STABLE',
        },
        anomalies: [],
      }
    }
    return { state, anomalies: [] }
  }

  if (!EVOLUTION_EVENT_SET.has(entry.type)) {
    return {
      state,
      anomalies: [
        {
          code: 'unknown-event-type',
          eventType: entry.type,
          detail: `${entry.type} is not one of the ${EVOLUTION_EVENT_TYPES.length} evolution event types`,
        },
      ],
    }
  }

  const type = entry.type as EvolutionEventType
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
  const anomalies = inspectPayload(type, payload)
  const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : null

  const hasBlocking = anomalies.some((a) => BLOCKING_ANOMALY_CODES.has(a.code))
  if (hasBlocking) {
    return { state, anomalies }
  }

  const result = applyEntry(state, type, payload, recordedAt, anomalies)
  return { state: result, anomalies: [...anomalies] }
}

export function reduceEvolutionState(
  entries: readonly EvolutionJournalEntry[],
): EvolutionFoldResult {
  let state = initialEvolutionState()
  const anomalies: EvolutionFoldAnomaly[] = []
  let ownerClearedStop = false
  for (const entry of entries) {
    if (!entry) continue
    if (entry.type === 'security.stop_all.cleared') ownerClearedStop = true
    if (entry.type === 'security.stop_all.activated') ownerClearedStop = false
    const result = reduceEvolutionEntry(state, entry, { ownerClearedStop })
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

export function reduceEvolutionEntryOnly(
  state: EvolutionFoldedState,
  entry: EvolutionJournalEntry,
  context: EvolutionFoldContext = FOLD_CONTEXT_CLOSED,
): EvolutionFoldResult {
  return reduceEvolutionEntry(state, entry, context)
}

function inspectPayload(
  type: EvolutionEventType,
  payload: Record<string, unknown>,
): EvolutionFoldAnomaly[] {
  const anomalies: EvolutionFoldAnomaly[] = []
  const allowed = EVOLUTION_PAYLOAD_KEYS[type] ?? []
  const maxText = 300

  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      if (FORBIDDEN_EVOLUTION_PAYLOAD_KEYS.has(key)) {
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

function applyEntry(
  state: EvolutionFoldedState,
  type: EvolutionEventType,
  payload: Record<string, unknown>,
  recordedAt: string | null,
  anomalies: EvolutionFoldAnomaly[],
): EvolutionFoldedState {
  const at = recordedAt ?? ''

  switch (type) {
    case 'evolution.evidence.verified': {
      const evidenceId = readString(payload, 'evidenceId')
      const source = readString(payload, 'source')
      const quality = readString(payload, 'quality')
      const statement = readString(payload, 'statement')
      const verifiedAt = readString(payload, 'verifiedAt') ?? at
      const expiresAt = readString(payload, 'expiresAt') ?? at

      if (!evidenceId || !source || !quality || !statement) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'evidence.verified missing required fields',
        })
        return state
      }
      if (!isEvidenceSource(source)) {
        anomalies.push({
          code: 'unknown-evidence-source',
          eventType: type,
          detail: `unknown evidence source: ${source}`,
        })
        return state
      }
      if (!isEvidenceQuality(quality)) {
        anomalies.push({
          code: 'unknown-evidence-quality',
          eventType: type,
          detail: `unknown evidence quality: ${quality}`,
        })
        return state
      }

      const record: EvolutionEvidenceFoldRecord = {
        evidenceId,
        source,
        quality,
        statement,
        verifiedAt,
        expiresAt,
      }

      return {
        ...state,
        evidence: [...state.evidence.slice(-MAX_RETAINED_EVIDENCE + 1), record],
      }
    }

    case 'evolution.improvement.proposed':
    case 'evolution.improvement.evaluating':
    case 'evolution.improvement.approved':
    case 'evolution.improvement.staged':
    case 'evolution.improvement.applied':
    case 'evolution.improvement.failed': {
      const improvementId = readString(payload, 'improvementId')
      const kind = readString(payload, 'kind')
      const description = readString(payload, 'description')
      const createdAt = readString(payload, 'createdAt') ?? at

      if (!improvementId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'improvement event missing required fields',
        })
        return state
      }

      const stateForEvent: Record<string, ImprovementState> = {
        'evolution.improvement.proposed': 'proposed',
        'evolution.improvement.evaluating': 'evaluating',
        'evolution.improvement.approved': 'approved',
        'evolution.improvement.staged': 'staged',
        'evolution.improvement.applied': 'applied',
        'evolution.improvement.failed': 'failed',
      }
      const improvementState = stateForEvent[type]
      if (improvementState === undefined) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'improvement event has no state mapping',
        })
        return state
      }

      const existing = state.improvements.find((i) => i.improvementId === improvementId)
      const evidenceIds = existing?.evidenceIds ?? []
      const appliedAt =
        type === 'evolution.improvement.applied'
          ? (readString(payload, 'appliedAt') ?? at)
          : existing?.appliedAt ?? null

      const record: EvolutionImprovementFoldRecord = {
        improvementId,
        kind: (kind as ImprovementKind) ?? existing?.kind ?? 'planning',
        state: improvementState,
        evidenceIds,
        description: description ?? existing?.description ?? '',
        createdAt,
        appliedAt,
      }

      const improvements = state.improvements.filter((i) => i.improvementId !== improvementId)
      return {
        ...state,
        improvements: [...improvements.slice(-MAX_RETAINED_IMPROVEMENTS + 1), record],
      }
    }

    case 'evolution.drift-check.passed':
    case 'evolution.drift-check.failed':
    case 'evolution.drift-check.boundary-violation': {
      const checkId = readString(payload, 'checkId')
      const improvementId = readString(payload, 'improvementId')
      const outcome = readString(payload, 'outcome')
      const reason = readString(payload, 'reason') ?? ''
      const checkedAt = readString(payload, 'checkedAt') ?? at

      if (!checkId || !improvementId || !outcome) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'drift-check missing required fields',
        })
        return state
      }
      if (!isDriftCheckOutcome(outcome)) {
        anomalies.push({
          code: 'unknown-drift-outcome',
          eventType: type,
          detail: `unknown drift outcome: ${outcome}`,
        })
        return state
      }

      const record: EvolutionDriftCheckFoldRecord = {
        checkId,
        improvementId,
        outcome,
        reason,
        checkedAt,
      }

      return {
        ...state,
        driftChecks: [...state.driftChecks.slice(-MAX_RETAINED_DRIFT_CHECKS + 1), record],
      }
    }

    case 'evolution.self-modification.attempted':
    case 'evolution.self-modification.refused': {
      return state
    }

    case 'evolution.continuation.decided': {
      const decision = readString(payload, 'decision')

      return {
        ...state,
        lastContinuationDecision: decision,
        lastContinuationAt: at,
      }
    }

    case 'evolution.wake.received': {
      const wakeKey = readString(payload, 'wakeKey')
      if (wakeKey && !state.processedWakeKeys.includes(wakeKey)) {
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

    case 'evolution.wake.denied': {
      const code = readString(payload, 'code')
      const record: EvolutionRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: (code as EvolutionRefusalCode) ?? 'unknown',
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

export { transition, type EvolutionSignal }
