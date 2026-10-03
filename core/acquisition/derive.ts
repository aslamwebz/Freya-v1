import { unsatisfiedGates } from './gates'
import {
  ACQUISITION_LIMITS,
  GAP_KINDS,
  GENERATED_TRUST_CLASS,
  GATE_KINDS,
  REQUEST_STATUSES,
  instantMs,
  type AcquisitionDerivation,
  type AcquisitionState,
  type GapKind,
  type GateKind,
  type RequestStatus,
  type TrustClass,
} from './types'

export const ACQUISITION_DERIVATION_SCHEMA_VERSION = 1

/**
 * THE ACQUISITION DERIVATION.
 *
 * Pure arithmetic over the folded state: what is being acquired, how far each has got, what is
 * blocking it and what it has cost. No clock of its own — `now` is an argument, so the same
 * state at the same instant always produces the same numbers.
 *
 * The two counts worth reading are `active` and `awaitingOwner`. `active` is the number a person
 * would want to be zero: it is generated capabilities that Freya is currently running. And
 * `awaitingOwner` is the queue of work that is finished and is now somebody's decision — the one
 * place this phase is *supposed* to need a human, so it is counted rather than buried.
 */

export function emptyAcquisitionDerivation(): AcquisitionDerivation {
  const byStatus = {} as Record<RequestStatus, number>
  for (const status of REQUEST_STATUSES) byStatus[status] = 0
  const byGapKind = {} as Record<GapKind, number>
  for (const kind of GAP_KINDS) byGapKind[kind] = 0
  const blockedOn = {} as Record<GateKind, number>
  for (const kind of GATE_KINDS) blockedOn[kind] = 0
  return Object.freeze({
    schemaVersion: ACQUISITION_DERIVATION_SCHEMA_VERSION,
    counts: Object.freeze({
      openGaps: 0,
      closedGaps: 0,
      requests: 0,
      byStatus: Object.freeze(byStatus),
      byGapKind: Object.freeze(byGapKind),
      active: 0,
      terminal: 0,
      costSpent: 0,
      costRemaining: 0,
      stale: 0,
    }),
    furthestStatus: null,
    awaitingOwner: Object.freeze([]),
    blockedOn: Object.freeze(blockedOn),
    activationAuthority: 'none' as const,
    trustClassFloor: GENERATED_TRUST_CLASS,
  })
}

/** How far along `status` is. A fact about the lifecycle table, not a priority score. */
const STATUS_ORDER: Readonly<Record<RequestStatus, number>> = Object.freeze({
  proposed: 0,
  building: 1,
  built: 2,
  verifying: 3,
  verified: 4,
  'activation-requested': 5,
  active: 6,
  rejected: 7,
  expired: 7,
})

export function deriveAcquisition(state: AcquisitionState, now: string): AcquisitionDerivation {
  const byStatus = {} as Record<RequestStatus, number>
  for (const status of REQUEST_STATUSES) byStatus[status] = 0
  const byGapKind = {} as Record<GapKind, number>
  for (const kind of GAP_KINDS) byGapKind[kind] = 0
  const blockedOn = {} as Record<GateKind, number>
  for (const kind of GATE_KINDS) blockedOn[kind] = 0

  let openGaps = 0
  let closedGaps = 0
  for (const gap of state.gaps.values()) {
    if (gap.status === 'open') openGaps += 1
    else closedGaps += 1
    byGapKind[gap.kind] += 1
  }

  let active = 0
  let terminal = 0
  let costSpent = 0
  let costRemaining = 0
  let stale = 0
  let furthest: RequestStatus | null = null
  const awaitingOwner: string[] = []
  const at = instantMs(now)

  for (const request of state.requests.values()) {
    byStatus[request.status] += 1
    costSpent += request.costSpent
    costRemaining += request.costCeiling - request.costSpent
    if (request.status === 'active') active += 1
    if (request.status === 'rejected' || request.status === 'expired') terminal += 1
    if (at !== null && instantMs(request.expiresAt) !== null && at > (instantMs(request.expiresAt) as number)) {
      stale += 1
    }
    if (furthest === null || STATUS_ORDER[request.status] < STATUS_ORDER[furthest]) {
      furthest = request.status
    }
    // "Awaiting the owner" is one specific state, not "not finished": every gate is satisfied
    // except `owner-approval`, which is the gate only a person can pass. Anything else blocking
    // is Core's problem to clear first. Both `verified` and `activation-requested` qualify —
    // asking for an activation does not change who owes the decision.
    const ledger = state.gates.get(request.requestId) ?? []
    const asking = request.status === 'verified' || request.status === 'activation-requested'
    if (asking) {
      const unsatisfied = unsatisfiedGates(request, ledger, now)
      if (unsatisfied.length === 1 && unsatisfied[0] === 'owner-approval') {
        awaitingOwner.push(request.requestId)
      }
    }
  }

  for (const request of state.requests.values()) {
    const ledger = state.gates.get(request.requestId) ?? []
    for (const kind of unsatisfiedGates(request, ledger, now)) blockedOn[kind] += 1
  }

  // Sorted, so the derivation of the same state is byte-identical whatever order the map was
  // built in. A derivation whose output depends on Map insertion order is not a derivation.
  awaitingOwner.sort()

  return Object.freeze({
    schemaVersion: ACQUISITION_DERIVATION_SCHEMA_VERSION,
    counts: Object.freeze({
      openGaps,
      closedGaps,
      requests: state.requests.size,
      byStatus: Object.freeze(byStatus),
      byGapKind: Object.freeze(byGapKind),
      active,
      terminal,
      costSpent,
      costRemaining,
      stale,
    }),
    furthestStatus: furthest,
    awaitingOwner: Object.freeze(awaitingOwner.slice(0, ACQUISITION_LIMITS.maxProjectionRecords)),
    blockedOn: Object.freeze(blockedOn),
    // Rendered rather than merely respected: a reader can see that this domain grants nothing
    // and that nothing it holds is better than untrusted.
    activationAuthority: 'none' as const,
    trustClassFloor: GENERATED_TRUST_CLASS as TrustClass,
  })
}