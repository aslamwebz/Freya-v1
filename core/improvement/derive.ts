import { unsatisfiedImprovementGates } from './gates'
import {
  IMPROVEMENT_GATE_KINDS,
  IMPROVEMENT_KINDS,
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_STATUSES,
  instantMs,
  type ImprovementDerivation,
  type ImprovementGateKind,
  type ImprovementKind,
  type ImprovementState,
  type ImprovementStatus,
} from './types'

export const IMPROVEMENT_DERIVATION_SCHEMA_VERSION = 1

/**
 * THE IMPROVEMENT DERIVATION.
 *
 * Pure arithmetic over the folded state: what Freya is trying to change about herself, how far
 * each proposal has got, what is blocking it, and what it has cost. No clock of its own — `now` is
 * an argument, so the same state at the same instant always produces the same numbers.
 *
 * Three counts worth reading:
 *
 * - **`activeMerges`** is the number of landed changes currently standing. It should be small and
 *   known, because every one of them is a thing Freya now does differently.
 * - **`awaitingOwner`** is the queue of work that is finished and is now somebody's decision — the
 *   one place this phase is *supposed* to need a human, so it is counted rather than buried.
 * - **`mergesAwaitingReview`** is the honest one: changes whose own retention bound has passed
 *   and which have not been rolled back. A non-empty list here means Freya's architecture has
 *   drifted past the point where anybody re-decided it, and it is reported rather than smoothed
 *   over.
 */

export function emptyImprovementDerivation(): ImprovementDerivation {
  const byStatus = {} as Record<ImprovementStatus, number>
  for (const status of IMPROVEMENT_STATUSES) byStatus[status] = 0
  const byKind = {} as Record<ImprovementKind, number>
  for (const kind of IMPROVEMENT_KINDS) byKind[kind] = 0
  const blockedOn = {} as Record<ImprovementGateKind, number>
  for (const kind of IMPROVEMENT_GATE_KINDS) blockedOn[kind] = 0
  return Object.freeze({
    schemaVersion: IMPROVEMENT_DERIVATION_SCHEMA_VERSION,
    counts: Object.freeze({
      openProposals: 0,
      proposals: 0,
      byStatus: Object.freeze(byStatus),
      byKind: Object.freeze(byKind),
      activeMerges: 0,
      terminal: 0,
      rolledBack: 0,
      costSpent: 0,
      costRemaining: 0,
      stale: 0,
    }),
    furthestStatus: null,
    awaitingOwner: Object.freeze([]),
    blockedOn: Object.freeze(blockedOn),
    mergesAwaitingReview: Object.freeze([]),
    mergeAuthority: 'none' as const,
  })
}

/** How far along `status` is. A fact about the lifecycle table, not a priority score. */
const STATUS_ORDER: Readonly<Record<ImprovementStatus, number>> = Object.freeze({
  proposed: 0,
  staging: 1,
  staged: 2,
  testing: 3,
  tested: 4,
  reviewing: 5,
  reviewed: 6,
  merging: 7,
  merged: 8,
  'rolled-back': 9,
  rejected: 9,
  expired: 9,
})

export function deriveImprovement(state: ImprovementState, now: string): ImprovementDerivation {
  const byStatus = {} as Record<ImprovementStatus, number>
  for (const status of IMPROVEMENT_STATUSES) byStatus[status] = 0
  const byKind = {} as Record<ImprovementKind, number>
  for (const kind of IMPROVEMENT_KINDS) byKind[kind] = 0
  const blockedOn = {} as Record<ImprovementGateKind, number>
  for (const kind of IMPROVEMENT_GATE_KINDS) blockedOn[kind] = 0

  let openProposals = 0
  let activeMerges = 0
  let terminal = 0
  let rolledBack = 0
  let costSpent = 0
  let costRemaining = 0
  let stale = 0
  let furthest: ImprovementStatus | null = null
  const awaitingOwner: string[] = []
  const mergesAwaitingReview: string[] = []
  const at = instantMs(now)

  for (const proposal of state.proposals.values()) {
    byStatus[proposal.status] += 1
    byKind[proposal.kind] += 1
    costSpent += proposal.costSpent
    costRemaining += proposal.costCeiling - proposal.costSpent
    if (proposal.status === 'merged') activeMerges += 1
    if (proposal.status === 'rolled-back') rolledBack += 1
    if (proposal.status === 'rejected' || proposal.status === 'expired' || proposal.status === 'rolled-back') {
      terminal += 1
    } else {
      openProposals += 1
    }
    if (at !== null && instantMs(proposal.expiresAt) !== null && at > (instantMs(proposal.expiresAt) as number)) {
      stale += 1
    }
    if (proposal.status === 'merged' && at !== null) {
      const until = instantMs(proposal.mergedExpiresAt)
      if (until !== null && at >= until) mergesAwaitingReview.push(proposal.proposalId)
    }
    if (furthest === null || STATUS_ORDER[proposal.status] < STATUS_ORDER[furthest]) {
      furthest = proposal.status
    }
    // "Awaiting the owner" is one specific state, not "not finished": every gate is satisfied
    // except `owner-merge-approved`, which is the gate only a person can pass. Anything else
    // blocking is Core's problem to clear first. Both `reviewed` and `merging` qualify — asking
    // for a merge does not change who owes the decision.
    const ledger = state.gates.get(proposal.proposalId) ?? []
    if (proposal.status === 'reviewed' || proposal.status === 'merging') {
      const unsatisfied = unsatisfiedImprovementGates(proposal, ledger, now)
      if (unsatisfied.length === 1 && unsatisfied[0] === 'owner-merge-approved') {
        awaitingOwner.push(proposal.proposalId)
      }
    }
    for (const kind of unsatisfiedImprovementGates(proposal, ledger, now)) {
      blockedOn[kind] += 1
    }
  }

  // Sorted, so the derivation of the same state is byte-identical whatever order the map was built
  // in. A derivation whose output depends on Map insertion order is not a derivation.
  awaitingOwner.sort()
  mergesAwaitingReview.sort()

  return Object.freeze({
    schemaVersion: IMPROVEMENT_DERIVATION_SCHEMA_VERSION,
    counts: Object.freeze({
      openProposals,
      proposals: state.proposals.size,
      byStatus: Object.freeze(byStatus),
      byKind: Object.freeze(byKind),
      activeMerges,
      terminal,
      rolledBack,
      costSpent,
      costRemaining,
      stale,
    }),
    furthestStatus: furthest,
    awaitingOwner: Object.freeze(awaitingOwner.slice(0, IMPROVEMENT_LIMITS.maxProjectionRecords)),
    blockedOn: Object.freeze(blockedOn),
    mergesAwaitingReview: Object.freeze(mergesAwaitingReview.slice(0, IMPROVEMENT_LIMITS.maxProjectionRecords)),
    // Rendered rather than merely respected: a reader can see that this domain merges nothing.
    mergeAuthority: 'none' as const,
  })
}