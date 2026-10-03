import {
  rebuildActivationDecision,
  rebuildAcquisitionRequest,
  rebuildCapabilityGap,
  rebuildGateLedger,
} from './rebuild'
import type {
  AcquisitionRequest,
  AcquisitionState,
  ActivationDecision,
  CapabilityGap,
  GateVerdictRecord,
} from './types'

export const ACQUISITION_RECORD_VERSION = 1

/**
 * The wrapper a store persists.
 *
 * A version and one record, rather than a bare record, so a future shape change is detectable
 * on read instead of being inferred from a field that happens to be absent.
 *
 * Four kinds, and the keyspace is namespaced by kind (`gap:`, `request:`, `ledger:`,
 * `decision:`) for the same reason Learning does it: one table, one fold, one degradation rule,
 * and a cross-kind id collision that cannot be mistaken for a conflict.
 *
 * A **ledger** is stored as the whole ordered list under one key rather than one row per
 * verdict. Verdicts are appends to one decision, so the list is the unit of meaning: a ledger
 * split across rows could be read half of, and "half the gates have been checked" is exactly
 * the state a reader must not be able to observe.
 */
export type AcquisitionRecord =
  | { readonly version: number; readonly kind: 'gap'; readonly gap: CapabilityGap }
  | { readonly version: number; readonly kind: 'request'; readonly request: AcquisitionRequest }
  | {
      readonly version: number
      readonly kind: 'ledger'
      readonly requestId: string
      readonly verdicts: readonly GateVerdictRecord[]
    }
  | { readonly version: number; readonly kind: 'decision'; readonly decision: ActivationDecision }

/** How the store finds the request a stored decision refers to. */
export type RequestLookup = (requestId: string) => AcquisitionRequest | undefined

export function emptyAcquisitionState(): AcquisitionState {
  return {
    gaps: new Map(),
    requests: new Map(),
    gates: new Map(),
    decisions: new Map(),
    sequence: 0,
  }
}

/**
 * Apply one record. Idempotent per key.
 *
 * A later write for the same key replaces the earlier one: a status change *is* the advance of
 * a request, and a gate ledger *is* the ordered list, so keeping both would be a second source
 * of truth about one thing.
 */
export function applyRecord(state: AcquisitionState, record: AcquisitionRecord): void {
  state.sequence += 1
  if (record.kind === 'gap') state.gaps.set(record.gap.gapId, record.gap)
  else if (record.kind === 'request') state.requests.set(record.request.requestId, record.request)
  else if (record.kind === 'ledger') state.gates.set(record.requestId, record.verdicts)
  else state.decisions.set(record.decision.requestId, record.decision)
}

/**
 * Validate a stored value, re-running every construction rule the row would face.
 *
 * A decision is validated **against its own request** rather than on its own, because `approved`
 * is a claim about that request's gates and checking it in isolation would mean believing
 * whatever the row says about which request it belongs to. `lookup` supplies that request; a
 * store reading its rows must fold gaps and requests first, then ledgers and decisions.
 */
export function validateRecord(
  value: unknown,
  lookup?: RequestLookup,
): { ok: true; record: AcquisitionRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'an acquisition record is not an object' }
  }
  const wrapper = value as Record<string, unknown>
  if (wrapper.version !== ACQUISITION_RECORD_VERSION) {
    return { ok: false, reason: 'an acquisition record carried an unknown wrapper version' }
  }
  if (wrapper.kind === 'gap') {
    const rebuilt = rebuildCapabilityGap(wrapper.gap)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return { ok: true, record: { version: ACQUISITION_RECORD_VERSION, kind: 'gap', gap: rebuilt.value } }
  }
  if (wrapper.kind === 'request') {
    const rebuilt = rebuildAcquisitionRequest(wrapper.request)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return { ok: true, record: { version: ACQUISITION_RECORD_VERSION, kind: 'request', request: rebuilt.value } }
  }
  if (wrapper.kind === 'ledger') {
    if (typeof wrapper.requestId !== 'string' || wrapper.requestId.length === 0) {
      return { ok: false, reason: 'a stored gate ledger names no request' }
    }
    const rebuilt = rebuildGateLedger(wrapper.verdicts)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return {
      ok: true,
      record: {
        version: ACQUISITION_RECORD_VERSION,
        kind: 'ledger',
        requestId: wrapper.requestId,
        verdicts: rebuilt.value,
      },
    }
  }
  if (wrapper.kind === 'decision') {
    const candidate = wrapper.decision as Record<string, unknown> | null
    const requestId =
      candidate !== null && typeof candidate.requestId === 'string' ? candidate.requestId : null
    if (requestId === null) {
      return { ok: false, reason: 'a stored activation decision names no request' }
    }
    const request = lookup?.(requestId)
    if (request === undefined) {
      return { ok: false, reason: 'a stored activation decision names a request this store does not hold' }
    }
    const rebuilt = rebuildActivationDecision(candidate, request)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return { ok: true, record: { version: ACQUISITION_RECORD_VERSION, kind: 'decision', decision: rebuilt.value } }
  }
  return { ok: false, reason: 'an acquisition record named an unknown kind' }
}

/** The row key a store persists one record under. */
export function recordKey(record: AcquisitionRecord): string {
  if (record.kind === 'gap') return `gap:${record.gap.gapId}`
  if (record.kind === 'request') return `request:${record.request.requestId}`
  if (record.kind === 'ledger') return `ledger:${record.requestId}`
  return `decision:${record.decision.requestId}`
}