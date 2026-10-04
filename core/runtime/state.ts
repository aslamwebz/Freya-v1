import type {
  RuntimeDomainState,
  RuntimeFoldState,
  RuntimeJournalEntry,
  RuntimeStatus,
} from './types'
import { isRuntimeStatus } from './types'

/**
 * The activation fold.
 *
 * One pure reducer serves replay and live operation, so the state a reader sees
 * cannot drift from the state a restart would rebuild. It is idempotent in the
 * strong sense: an entry whose sequence is not greater than the last applied is
 * ignored, so a redelivered or replayed entry moves nothing.
 */

export function initialRuntimeFold(): RuntimeFoldState {
  return {
    lastSequence: 0,
    domains: new Map(),
    stopAllLatched: false,
    lastStopReason: null,
    lastReconciledAt: null,
    recoveredDomains: [],
  }
}

function readString(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function readStrings(payload: Record<string, unknown>, key: string): readonly string[] {
  const value = payload[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function readStatus(payload: Record<string, unknown>, key: string, fallback: RuntimeStatus): RuntimeStatus {
  const value = payload[key]
  return isRuntimeStatus(value) ? value : fallback
}

function upsert(
  state: RuntimeFoldState,
  domainId: string,
  update: Partial<RuntimeDomainState> & { status: RuntimeStatus },
): RuntimeFoldState {
  const previous = state.domains.get(domainId) ?? emptyDomain(domainId)
  const next: RuntimeDomainState = { ...previous, ...update }
  const domains = new Map(state.domains)
  domains.set(domainId, next)
  return { ...state, domains }
}

function emptyDomain(id: string): RuntimeDomainState {
  return {
    id,
    status: 'registered',
    reason: 'registered but not yet evaluated',
    missing: [],
    evidence: [],
    requestedAt: null,
    decidedAt: null,
    activatedAt: null,
    changedAt: null,
    lastOutcome: null,
  }
}

export function initialDomainState(id: string): RuntimeDomainState {
  return emptyDomain(id)
}

/**
 * Fold one entry.
 *
 * The type is trusted only as far as the journal validator already trusted it;
 * every field is read defensively so a hand-edited line degrades a status rather
 * than throwing.
 */
export function reduceRuntimeEntry(state: RuntimeFoldState, entry: RuntimeJournalEntry): RuntimeFoldState {
  if (!Number.isFinite(entry.sequence) || entry.sequence <= state.lastSequence) return state

  const payload = entry.payload as unknown as Record<string, unknown>
  const at = entry.recordedAt
  let next = state

  switch (entry.type) {
    case 'runtime.activation.decided': {
      const domainId = readString(payload, 'domainId', '')
      if (domainId === '') return { ...state, lastSequence: entry.sequence }
      const outcome = payload.outcome === 'allowed' ? 'allowed' : 'blocked'
      const status = readStatus(payload, 'status', outcome === 'allowed' ? 'available' : 'blocked')
      const reason = readString(payload, 'reason', '')
      next = upsert(state, domainId, {
        status,
        reason,
        missing: readStrings(payload, 'missing'),
        requestedAt: readString(payload, 'requestedAt', at),
        decidedAt: at,
        changedAt: at,
        lastOutcome: outcome,
      })
      break
    }
    case 'runtime.activation.changed': {
      const domainId = readString(payload, 'domainId', '')
      if (domainId === '') return { ...state, lastSequence: entry.sequence }
      const to = readStatus(payload, 'to', 'available')
      const previous = state.domains.get(domainId) ?? emptyDomain(domainId)
      next = upsert(state, domainId, {
        status: to,
        reason: readString(payload, 'reason', ''),
        missing: readStrings(payload, 'missing'),
        changedAt: at,
        activatedAt: to === 'active' || to === 'degraded' ? at : previous.activatedAt,
        lastOutcome: to === 'active' || to === 'degraded' ? 'allowed' : previous.lastOutcome,
      })
      break
    }
    case 'runtime.activation.stopped': {
      const domainId = readString(payload, 'domainId', '')
      if (domainId === '') return { ...state, lastSequence: entry.sequence }
      next = upsert(state, domainId, {
        status: 'blocked',
        reason: readString(payload, 'reason', 'stopped'),
        missing: readStrings(payload, 'missing'),
        changedAt: at,
        lastOutcome: 'stopped',
      })
      next = { ...next, lastStopReason: readString(payload, 'reason', 'stopped') }
      break
    }
    case 'runtime.activation.reconciled': {
      const domainId = readString(payload, 'domainId', '')
      if (domainId === '') return { ...state, lastSequence: entry.sequence }
      next = upsert(state, domainId, {
        status: readStatus(payload, 'status', 'available'),
        reason: readString(payload, 'reason', ''),
        missing: readStrings(payload, 'missing'),
        changedAt: at,
        lastOutcome: 'reconciled',
      })
      next = {
        ...next,
        lastReconciledAt: at,
        recoveredDomains: next.recoveredDomains.includes(domainId)
          ? next.recoveredDomains
          : [...next.recoveredDomains, domainId],
      }
      break
    }
    default:
      break
  }

  return { ...next, lastSequence: entry.sequence }
}

export function reduceRuntimeState(entries: readonly RuntimeJournalEntry[]): RuntimeFoldState {
  let state = initialRuntimeFold()
  for (const entry of entries) state = reduceRuntimeEntry(state, entry)
  return state
}

/** The evidence column for a domain, or an empty list when none was recorded. */
export function domainEvidence(state: RuntimeFoldState, id: string): RuntimeDomainState['evidence'] {
  return state.domains.get(id)?.evidence ?? []
}
