import {
  SOVEREIGNTY_EVENT_TYPES,
  SOVEREIGNTY_EVENT_SET,
  SOVEREIGNTY_PAYLOAD_KEYS,
  FORBIDDEN_SOVEREIGNTY_PAYLOAD_KEYS,
  isOfflineMode,
  type SovereigntyEventType,
  type SovereigntyLimits,
  type SovereigntyState,
  type ProviderStatus,
  type OfflineMode,
  type PortableDataOperation,
  type SovereigntyRefusalCode,
  type SovereigntyRefusalSubject,
} from './types'
import { transition, type SovereigntySignal } from './machine'

/**
 * The event-sourced fold.
 */

export interface SovereigntyJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

export type SovereigntyFoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'unknown-provider-status'
  | 'unknown-offline-mode'
  | 'unknown-portable-operation'
  | 'self-approval'
  | 'plaintext-key'
  | 'integrity-fabrication'

export interface SovereigntyFoldAnomaly {
  readonly code: SovereigntyFoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

export interface SovereigntyProviderRecord {
  readonly providerId: string
  readonly name: string
  readonly status: ProviderStatus
  readonly priority: number
  readonly isLocal: boolean
  readonly isOfflineCapable: boolean
}

export interface SovereigntyRoutingRecord {
  readonly decisionId: string
  readonly providerId: string
  readonly reason: string
  readonly routedAt: string
}

export interface SovereigntyOfflineSessionRecord {
  readonly sessionId: string
  readonly mode: OfflineMode
  readonly startedAt: string
  readonly endedAt: string | null
  readonly reasoningCount: number
}

export interface SovereigntyPortableDataRecord {
  readonly recordId: string
  readonly operation: PortableDataOperation
  readonly status: 'pending' | 'in-progress' | 'completed' | 'failed'
  readonly dataHash: string
  readonly encryptionVersion: string
  readonly createdAt: string
  readonly completedAt: string | null
}

export interface SovereigntyRefusal {
  readonly refusalId: string
  readonly code: SovereigntyRefusalCode
  readonly subject: SovereigntyRefusalSubject
  readonly at: string
}

export interface SovereigntyFoldedState {
  readonly currentState: SovereigntyState
  readonly providers: readonly SovereigntyProviderRecord[]
  readonly routingDecisions: readonly SovereigntyRoutingRecord[]
  readonly offlineSessions: readonly SovereigntyOfflineSessionRecord[]
  readonly portableDataRecords: readonly SovereigntyPortableDataRecord[]
  readonly refusals: readonly SovereigntyRefusal[]
  readonly processedWakeKeys: readonly string[]
  readonly stopAllLatched: boolean
  readonly stopCode: string | null
  readonly lastRefusalCode: string | null
  readonly lastRefusalAt: string | null
  readonly lastContinuationDecision: string | null
  readonly lastContinuationAt: string | null
}

export interface SovereigntyFoldResult {
  readonly state: SovereigntyFoldedState
  readonly anomalies: readonly SovereigntyFoldAnomaly[]
}

export interface SovereigntyFoldContext {
  readonly ownerClearedStop: boolean
}

export const FOLD_CONTEXT_CLOSED: SovereigntyFoldContext = Object.freeze({ ownerClearedStop: false })

const MAX_RETAINED_REFUSALS = 256
const MAX_PROCESSED_WAKE_KEYS = 256

const BLOCKING_ANOMALY_CODES: ReadonlySet<SovereigntyFoldAnomalyCode> = new Set([
  'forbidden-payload-key',
  'self-approval',
  'plaintext-key',
  'integrity-fabrication',
])

export function initialSovereigntyState(): SovereigntyFoldedState {
  return {
    currentState: 'ONLINE',
    providers: [],
    routingDecisions: [],
    offlineSessions: [],
    portableDataRecords: [],
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

function readInteger(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.floor(value)
  return rounded < 0 ? null : rounded
}

export function reduceSovereigntyEntry(
  state: SovereigntyFoldedState,
  entry: SovereigntyJournalEntry,
  context: SovereigntyFoldContext = FOLD_CONTEXT_CLOSED,
  limits?: SovereigntyLimits,
): SovereigntyFoldResult {
  if (!entry.type.startsWith('sovereignty.')) {
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
          currentState: 'ONLINE',
        },
        anomalies: [],
      }
    }
    return { state, anomalies: [] }
  }

  if (!SOVEREIGNTY_EVENT_SET.has(entry.type)) {
    return {
      state,
      anomalies: [
        {
          code: 'unknown-event-type',
          eventType: entry.type,
          detail: `${entry.type} is not one of the ${SOVEREIGNTY_EVENT_TYPES.length} sovereignty event types`,
        },
      ],
    }
  }

  const type = entry.type as SovereigntyEventType
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

export function reduceSovereigntyState(
  entries: readonly SovereigntyJournalEntry[],
  limits?: SovereigntyLimits,
): SovereigntyFoldResult {
  let state = initialSovereigntyState()
  const anomalies: SovereigntyFoldAnomaly[] = []
  let ownerClearedStop = false
  for (const entry of entries) {
    if (!entry) continue
    if (entry.type === 'security.stop_all.cleared') ownerClearedStop = true
    if (entry.type === 'security.stop_all.activated') ownerClearedStop = false
    const result = reduceSovereigntyEntry(state, entry, { ownerClearedStop }, limits)
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

export function reduceSovereigntyEntryOnly(
  state: SovereigntyFoldedState,
  entry: SovereigntyJournalEntry,
  context: SovereigntyFoldContext = FOLD_CONTEXT_CLOSED,
  limits?: SovereigntyLimits,
): SovereigntyFoldResult {
  return reduceSovereigntyEntry(state, entry, context, limits)
}

function inspectPayload(
  type: SovereigntyEventType,
  payload: Record<string, unknown>,
  _limits?: SovereigntyLimits,
): SovereigntyFoldAnomaly[] {
  const anomalies: SovereigntyFoldAnomaly[] = []
  const allowed = SOVEREIGNTY_PAYLOAD_KEYS[type] ?? []
  const maxText = 300

  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      if (FORBIDDEN_SOVEREIGNTY_PAYLOAD_KEYS.has(key)) {
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
  state: SovereigntyFoldedState,
  type: SovereigntyEventType,
  payload: Record<string, unknown>,
  recordedAt: string | null,
  anomalies: SovereigntyFoldAnomaly[],
): SovereigntyFoldedState {
  const at = recordedAt ?? ''

  switch (type) {
    case 'sovereignty.provider.routed': {
      const decisionId = readString(payload, 'decisionId')
      const providerId = readString(payload, 'providerId')
      const reason = readString(payload, 'reason') ?? 'Provider selected'
      const routedAt = readString(payload, 'routedAt') ?? at

      if (!decisionId || !providerId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'provider.routed missing required fields',
        })
        return state
      }

      const record: SovereigntyRoutingRecord = {
        decisionId,
        providerId,
        reason,
        routedAt,
      }

      return {
        ...state,
        routingDecisions: [...state.routingDecisions, record],
      }
    }

    case 'sovereignty.provider.fallback': {
      const decisionId = readString(payload, 'decisionId')
      const fromProviderId = readString(payload, 'fromProviderId')
      const toProviderId = readString(payload, 'toProviderId')

      if (!decisionId || !fromProviderId || !toProviderId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'provider.fallback missing required fields',
        })
        return state
      }

      const transResult = transition(state.currentState, 'fallback-succeeded')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        currentState: newState,
      }
    }

    case 'sovereignty.provider.failed': {
      const providerId = readString(payload, 'providerId')

      if (!providerId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'provider.failed missing required fields',
        })
        return state
      }

      const transResult = transition(state.currentState, 'provider-failed')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        currentState: newState,
      }
    }

    case 'sovereignty.offline.started': {
      const sessionId = readString(payload, 'sessionId')
      const mode = readString(payload, 'mode')
      const startedAt = readString(payload, 'startedAt') ?? at

      if (!sessionId || !mode) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'offline.started missing required fields',
        })
        return state
      }
      if (!isOfflineMode(mode)) {
        anomalies.push({
          code: 'unknown-offline-mode',
          eventType: type,
          detail: `unknown offline mode: ${mode}`,
        })
        return state
      }

      const record: SovereigntyOfflineSessionRecord = {
        sessionId,
        mode,
        startedAt,
        endedAt: null,
        reasoningCount: 0,
      }

      const transResult = transition(state.currentState, 'offline-started')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        offlineSessions: [...state.offlineSessions, record],
        currentState: newState,
      }
    }

    case 'sovereignty.offline.ended': {
      const sessionId = readString(payload, 'sessionId')
      const endedAt = readString(payload, 'endedAt') ?? at
      const reasoningCount = readInteger(payload, 'reasoningCount') ?? 0

      if (!sessionId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'offline.ended missing required fields',
        })
        return state
      }

      const offlineSessions = state.offlineSessions.map((s) =>
        s.sessionId === sessionId ? { ...s, endedAt, reasoningCount } : s,
      )

      const transResult = transition(state.currentState, 'offline-ended')
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        offlineSessions,
        currentState: newState,
      }
    }

    case 'sovereignty.portable-data.exported':
    case 'sovereignty.portable-data.imported': {
      const recordId = readString(payload, 'recordId')
      const dataHash = readString(payload, 'dataHash')
      const encryptionVersion = readString(payload, 'encryptionVersion')
      const createdAt = readString(payload, 'createdAt') ?? at

      if (!recordId || !dataHash || !encryptionVersion) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: `${type} missing required fields`,
        })
        return state
      }

      const operation: PortableDataOperation = type === 'sovereignty.portable-data.exported' ? 'export' : 'import'
      const record: SovereigntyPortableDataRecord = {
        recordId,
        operation,
        status: 'completed',
        dataHash,
        encryptionVersion,
        createdAt,
        completedAt: at,
      }

      const signal: SovereigntySignal = type === 'sovereignty.portable-data.exported' ? 'export-completed' : 'import-completed'
      const transResult = transition(state.currentState, signal)
      const newState = transResult.ok ? transResult.to : state.currentState

      return {
        ...state,
        portableDataRecords: [...state.portableDataRecords, record],
        currentState: newState,
      }
    }

    case 'sovereignty.portable-data.verified': {
      const recordId = readString(payload, 'recordId')
      const dataHash = readString(payload, 'dataHash')

      if (!recordId || !dataHash) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'portable-data.verified missing required fields',
        })
        return state
      }

      return state
    }

    case 'sovereignty.portable-data.failed': {
      const recordId = readString(payload, 'recordId')

      if (!recordId) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'portable-data.failed missing required fields',
        })
        return state
      }

      return state
    }

    case 'sovereignty.state-changed': {
      const from = readString(payload, 'from')
      const to = readString(payload, 'to')
      const signal = readString(payload, 'signal')

      if (!from || !to || !signal) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: type,
          detail: 'state-changed missing required fields',
        })
        return state
      }

      return state
    }

    case 'sovereignty.continuation.decided': {
      const decision = readString(payload, 'decision')

      return {
        ...state,
        lastContinuationDecision: decision,
        lastContinuationAt: at,
      }
    }

    case 'sovereignty.wake.received': {
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

    case 'sovereignty.wake.denied': {
      const code = readString(payload, 'code')
      const record: SovereigntyRefusal = {
        refusalId: `ref-${state.refusals.length + 1}`,
        code: (code as SovereigntyRefusalCode) ?? 'unknown',
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
