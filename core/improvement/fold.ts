import { rebuildGateLedger, rebuildImprovementProposal, rebuildMergeDecision } from './rebuild'
import type {
  ImprovementGateRecord,
  ImprovementProposal,
  ImprovementState,
  MergeDecision,
} from './types'

export const IMPROVEMENT_RECORD_VERSION = 1

/**
 * The wrapper a store persists.
 *
 * A version and one record, rather than a bare record, so a future shape change is detectable on
 * read instead of being inferred from a field that happens to be absent.
 *
 * Three kinds, and the keyspace is namespaced by kind (`proposal:`, `ledger:`, `decision:`) for
 * the same reason Learning and Acquisition do it: one table, one fold, one degradation rule, and a
 * cross-kind id collision that cannot be mistaken for a conflict.
 *
 * A **ledger** is stored as the whole ordered list under one key rather than one row per record.
 * Verdicts are appends to one decision, so the list is the unit of meaning: a ledger split across
 * rows could be read half of, and "half the gates have been checked" is exactly the state a reader
 * must not be able to observe.
 */
export type ImprovementRecord =
  | { readonly version: number; readonly kind: 'proposal'; readonly proposal: ImprovementProposal }
  | {
      readonly version: number
      readonly kind: 'ledger'
      readonly proposalId: string
      readonly verdicts: readonly ImprovementGateRecord[]
    }
  | { readonly version: number; readonly kind: 'decision'; readonly decision: MergeDecision }

/** How the store finds the proposal a stored decision refers to. */
export type RequestLookup = (proposalId: string) => ImprovementProposal | undefined

export function emptyImprovementState(): ImprovementState {
  return {
    proposals: new Map(),
    gates: new Map(),
    decisions: new Map(),
    sequence: 0,
  }
}

/**
 * Apply one record. Idempotent per key.
 *
 * A later write for the same key replaces the earlier one: a status change *is* the advance of a
 * proposal, and a gate ledger *is* the ordered list, so keeping both would be a second source of
 * truth about one thing.
 */
export function applyRecord(state: ImprovementState, record: ImprovementRecord): void {
  state.sequence += 1
  if (record.kind === 'proposal') state.proposals.set(record.proposal.proposalId, record.proposal)
  else if (record.kind === 'ledger') state.gates.set(record.proposalId, record.verdicts)
  else state.decisions.set(record.decision.proposalId, record.decision)
}

/**
 * Validate a stored value, re-running every construction rule the row would face.
 *
 * A decision is validated **against its own proposal** rather than on its own, because `approved`
 * is a claim about that proposal's gates and checking it in isolation would mean believing whatever
 * the row says about which proposal it belongs to. `lookup` supplies that proposal; a store reading
 * its rows must fold proposals first, then ledgers and decisions.
 */
export function validateRecord(
  value: unknown,
  lookup?: RequestLookup,
): { ok: true; record: ImprovementRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'an improvement record is not an object' }
  }
  const wrapper = value as Record<string, unknown>
  if (wrapper.version !== IMPROVEMENT_RECORD_VERSION) {
    return { ok: false, reason: 'an improvement record carried an unknown wrapper version' }
  }
  if (wrapper.kind === 'proposal') {
    const rebuilt = rebuildImprovementProposal(wrapper.proposal)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return {
      ok: true,
      record: { version: IMPROVEMENT_RECORD_VERSION, kind: 'proposal', proposal: rebuilt.value },
    }
  }
  if (wrapper.kind === 'ledger') {
    if (typeof wrapper.proposalId !== 'string' || wrapper.proposalId.length === 0) {
      return { ok: false, reason: 'a stored gate ledger names no proposal' }
    }
    const rebuilt = rebuildGateLedger(wrapper.verdicts)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return {
      ok: true,
      record: {
        version: IMPROVEMENT_RECORD_VERSION,
        kind: 'ledger',
        proposalId: wrapper.proposalId,
        verdicts: rebuilt.value,
      },
    }
  }
  if (wrapper.kind === 'decision') {
    const candidate = wrapper.decision as Record<string, unknown> | null
    const proposalId =
      candidate !== null && typeof candidate.proposalId === 'string' ? candidate.proposalId : null
    if (proposalId === null) {
      return { ok: false, reason: 'a stored merge decision names no proposal' }
    }
    const proposal = lookup?.(proposalId)
    if (proposal === undefined) {
      return { ok: false, reason: 'a stored merge decision names a proposal this store does not hold' }
    }
    const rebuilt = rebuildMergeDecision(candidate, proposal)
    if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
    return {
      ok: true,
      record: { version: IMPROVEMENT_RECORD_VERSION, kind: 'decision', decision: rebuilt.value },
    }
  }
  return { ok: false, reason: 'an improvement record named an unknown kind' }
}

/** The row key a store persists one record under. */
export function recordKey(record: ImprovementRecord): string {
  if (record.kind === 'proposal') return `proposal:${record.proposal.proposalId}`
  if (record.kind === 'ledger') return `ledger:${record.proposalId}`
  return `decision:${record.decision.proposalId}`
}