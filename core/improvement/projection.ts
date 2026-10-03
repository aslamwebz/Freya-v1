import { deriveImprovement } from './derive'
import { unsatisfiedImprovementGates } from './gates'
import {
  IMPROVEMENT_LIMITS,
  type ImprovementGateRecord,
  type ImprovementProposal,
  type ImprovementState,
  type MergeDecision,
} from './types'
import {
  IMPROVEMENT_SCHEMA_VERSION,
  type ImprovementDetailOutcome,
  type ImprovementDetailView,
  type ImprovementGateView,
  type ImprovementPersistenceView,
  type ImprovementProjection,
  type ImprovementProposalView,
  type ImprovementProposalsOutcome,
  type ImprovementProposalsView,
} from '../protocol/improvement'

/**
 * THE IMPROVEMENT PROJECTION.
 *
 * What Freya is trying to change about herself, what is blocking it, and what it has cost — and
 * nothing else.
 *
 * The privacy rule is the same one `core/learning` and `core/acquisition` follow and it is worth
 * restating because this domain's text is the most sensitive of all three: a symptom describes
 * something about the owner that was measurably costing Freya time or attention. None of it crosses
 * in any broad read. `symptomLength` and `changeCount` are measured and carried, so a surface can
 * show that there is something there without the something crossing.
 */

export interface ImprovementProjectionInput {
  readonly state: ImprovementState
  readonly persistence: ImprovementPersistenceView
  readonly now: string
}

/** The broad projection. No symptom text, no change text, no rollback steps. */
export function projectImprovement(input: ImprovementProjectionInput): ImprovementProjection {
  const derivation: ImprovementDerivationLike = deriveImprovement(input.state, input.now)
  return Object.freeze({
    schemaVersion: IMPROVEMENT_SCHEMA_VERSION,
    mode: 'available' as const,
    counts: Object.freeze({
      openProposals: derivation.counts.openProposals,
      proposals: derivation.counts.proposals,
      activeMerges: derivation.counts.activeMerges,
      terminal: derivation.counts.terminal,
      rolledBack: derivation.counts.rolledBack,
      awaitingOwner: derivation.awaitingOwner.length,
      awaitingReview: derivation.mergesAwaitingReview.length,
      costSpent: derivation.counts.costSpent,
      costRemaining: derivation.counts.costRemaining,
      stale: derivation.counts.stale,
      byStatus: derivation.counts.byStatus,
      byKind: derivation.counts.byKind,
    }),
    furthestStatus: derivation.furthestStatus,
    awaitingOwner: derivation.awaitingOwner,
    blockedOn: derivation.blockedOn,
    mergesAwaitingReview: derivation.mergesAwaitingReview,
    mergeAuthority: 'none' as const,
    persistence: input.persistence,
  })
}

type ImprovementDerivationLike = ReturnType<typeof deriveImprovement>

/** A broad read of the ledger: proposals as metadata. */
export function projectImprovementProposals(
  state: ImprovementState,
  options: { limit?: number } = {},
): ImprovementProposalsOutcome {
  const limit = boundLimit(options.limit)
  const proposals = [...state.proposals.values()].sort((a, b) => a.proposalId.localeCompare(b.proposalId))
  const view: ImprovementProposalsView = Object.freeze({
    items: Object.freeze(proposals.slice(0, limit).map(proposalView)),
    // Truncation is reported rather than silent: a read that quietly dropped half the ledger
    // would show a Freya with fewer outstanding changes than she actually has.
    truncated: proposals.length > limit,
    total: proposals.length,
    schemaVersion: IMPROVEMENT_SCHEMA_VERSION,
  })
  return { ok: true, view, reason: null }
}

/**
 * One proposal in full, for the owner reviewing a merge.
 *
 * The only read that carries symptom text, change descriptions and the rollback steps, because a
 * person deciding whether to merge something has to see what it is *and* how it would be undone.
 * `unsatisfied` is computed rather than stored, so the screen cannot disagree with the ledger
 * about whether this is ready.
 */
export function projectImprovementProposal(
  state: ImprovementState,
  proposalId: string,
  now: string,
): ImprovementDetailOutcome {
  const proposal = state.proposals.get(proposalId)
  if (proposal === undefined) {
    return { ok: false, code: 'no-such-proposal', reason: 'that improvement proposal does not exist' }
  }
  const ledger = state.gates.get(proposalId) ?? []
  const decision = state.decisions.get(proposalId) ?? null
  return { ok: true, view: detailView(proposal, ledger, decision, now), reason: null }
}

function detailView(
  proposal: ImprovementProposal,
  ledger: readonly ImprovementGateRecord[],
  decision: MergeDecision | null,
  now: string,
): ImprovementDetailView {
  const unsatisfied = unsatisfiedImprovementGates(proposal, ledger, now)
  const view = proposalView(proposal)
  return Object.freeze({
    proposal: view,
    symptom: proposal.symptom,
    changes: Object.freeze([...proposal.changes]),
    rollbackSteps: Object.freeze([...proposal.rollbackSteps]),
    requirements: Object.freeze([...proposal.requirements]),
    targets: Object.freeze([...proposal.targets]),
    gates: Object.freeze([...(decision?.gates ?? ledger).map(gateView)]),
    unsatisfied: Object.freeze([...unsatisfied]),
    awaitsOwner: unsatisfied.length === 1 && unsatisfied[0] === 'owner-merge-approved',
    decidedAt: decision?.decidedAt ?? null,
    ownerApproved: decision?.ownerApproved === true,
    appliesCode: false as const,
    executesChange: false as const,
    authority: 'none' as const,
    // Rendered rather than merely respected: the reviewer sees that undo is one edge away, which
    // is the reason they can reasonably say yes to a merge at all.
    rollbackAvailable: proposal.status === 'merged' || (proposal.status !== 'rejected' && proposal.status !== 'expired'),
  })
}

function proposalView(proposal: ImprovementProposal): ImprovementProposalView {
  return Object.freeze({
    proposalId: proposal.proposalId,
    kind: proposal.kind,
    subject: proposal.subject,
    occurrences: proposal.occurrences,
    evidenceCount: proposal.evidenceRefs.length,
    changeCount: proposal.changes.length,
    requirementCount: proposal.requirements.length,
    targetCount: proposal.targets.length,
    rollbackStepCount: proposal.rollbackSteps.length,
    costCeiling: proposal.costCeiling,
    costSpent: proposal.costSpent,
    tags: Object.freeze([...proposal.tags]),
    confidence: proposal.confidence,
    status: proposal.status,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    mergedAt: proposal.mergedAt,
    mergedExpiresAt: proposal.mergedExpiresAt,
    restoresRevision: proposal.restoresRevision,
    closedAt: proposal.closedAt,
    closedReason: proposal.closedReason,
    symptomLength: proposal.symptom.length,
  })
}

function gateView(record: ImprovementGateRecord): ImprovementGateView {
  return Object.freeze({
    kind: record.kind,
    verdict: record.verdict,
    reason: record.reason,
    authority: record.authority,
    verifier: record.verifier,
    evidenceCount: record.evidenceRefs.length,
    recordedAt: record.recordedAt,
  })
}

function boundLimit(limit: number | undefined): number {
  if (limit === undefined) return IMPROVEMENT_LIMITS.maxProjectionRecords
  if (!Number.isInteger(limit) || limit < 1) return 1
  return Math.min(limit, IMPROVEMENT_LIMITS.maxProjectionRecords)
}