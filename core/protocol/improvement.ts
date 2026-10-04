import type { Confidence } from '../brain/types'
import type {
  ImprovementClosedReason,
  ImprovementDerivation,
  ImprovementGateAuthority,
  ImprovementGateKind,
  ImprovementGateReason,
  ImprovementGateRecord,
  ImprovementGateVerdict,
  ImprovementKind,
  ImprovementStatus,
  MergeDecision,
} from '../improvement/types'

/**
 * THE IMPROVEMENT PROTOCOL — what a window may know about what Freya wants to change.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a renderer is typed
 * against, one frozen projection for a Core with no improvement domain, and the outcome vocabulary
 * of the reads that exist.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed labels, statuses, instants, provenance *metadata* (which gate, which
 * authority, which named verifier, how many references), counts, cost units spent and remaining,
 * and the measured length of every text-bearing field.
 *
 * Does not cross, in any broad read:
 *
 * - **The symptom or change text.** `improvement.proposals.read` carries `symptomLength` and
 *   `changeCount`. The one way to read a proposal's own words is the explicit, single-record
 *   `improvement.proposal.read`.
 * - **Any status, gate verdict or approval a window could assert.** There is no write verb on this
 *   surface at all, and no `improvement.*` command on the Core surface: a window cannot propose a
 *   change, cannot report a test result and cannot merge anything.
 * - **Any capability, permission or grant field.** Every proposal crosses carrying
 *   `appliesCode: false` and `authority: 'none'` as values, so a surface can *render* the
 *   guarantee rather than merely not violate it.
 */

/* ------------------------------------------------------------------ views */

/** One proposal as a broad read may hold it. The symptom is measured, never carried. */
export interface ImprovementProposalView {
  readonly proposalId: string
  readonly kind: ImprovementKind
  /** A slug describing the change. Never a file path, a command or a capability. */
  readonly subject: string
  readonly occurrences: number
  /** Ids only — never content. */
  readonly evidenceCount: number
  readonly changeCount: number
  readonly requirementCount: number
  readonly targetCount: number
  /** How many undo steps the proposal declared. A number, never the steps. */
  readonly rollbackStepCount: number
  readonly costCeiling: number
  readonly costSpent: number
  readonly tags: readonly string[]
  readonly confidence: Confidence
  readonly status: ImprovementStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly mergedAt: string | null
  readonly mergedExpiresAt: string | null
  /** The revision a rollback would restore. Null until staging recorded one. */
  readonly restoresRevision: string | null
  readonly closedAt: string | null
  readonly closedReason: ImprovementClosedReason | null
  readonly symptomLength: number
}

/** One gate as a broad read may hold it. Names who produced it; carries ids, not content. */
export interface ImprovementGateView {
  readonly kind: ImprovementGateKind
  readonly verdict: ImprovementGateVerdict
  readonly reason: ImprovementGateReason
  readonly authority: ImprovementGateAuthority
  /** The named producer, or null for a gate nothing produced a verdict for. */
  readonly verifier: string | null
  readonly evidenceCount: number
  readonly recordedAt: string
}

export interface ImprovementPersistenceView {
  readonly mode: 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'
  readonly durable: boolean
  readonly degraded: boolean
  readonly reason: string | null
}

export interface ImprovementCountsView {
  readonly openProposals: number
  readonly proposals: number
  readonly activeMerges: number
  readonly terminal: number
  readonly rolledBack: number
  readonly awaitingOwner: number
  readonly awaitingReview: number
  readonly costSpent: number
  readonly costRemaining: number
  readonly stale: number
  readonly byStatus: Readonly<Record<ImprovementStatus, number>>
  readonly byKind: Readonly<Record<ImprovementKind, number>>
}

export interface ImprovementProjection {
  readonly schemaVersion: number
  /** `'unavailable'` only for a build with no improvement domain. */
  readonly mode: 'available' | 'unavailable'
  readonly counts: ImprovementCountsView
  readonly furthestStatus: ImprovementStatus | null
  /** Proposals finished and waiting on the one gate only a person can pass. */
  readonly awaitingOwner: readonly string[]
  /** Every gate kind any live proposal still has unsatisfied, counted. */
  readonly blockedOn: Readonly<Partial<Record<ImprovementGateKind, number>>>
  /**
   * Merged changes whose own retention bound has passed and which have not been rolled back.
   *
   * Reported at breadth on purpose: "nothing has changed since March" is a fact an owner needs
   * before approving the next change, not a detail behind an id.
   */
  readonly mergesAwaitingReview: readonly string[]
  /** Always `'none'`. This domain applies nothing and merges nothing. */
  readonly mergeAuthority: 'none'
  readonly persistence: ImprovementPersistenceView
}

export interface ImprovementProposalsView {
  readonly items: readonly ImprovementProposalView[]
  readonly truncated: boolean
  readonly total: number
  readonly schemaVersion: number
}

/**
 * One proposal in full, on an explicit single-record read.
 *
 * Carries the symptom, the changes and the rollback steps because somebody reviewing a merge has
 * to see what is being merged *and how it would be undone* — the second is the part a reviewer
 * most often skips and most needs. It carries `appliesCode: false` and `authority: 'none'` in the
 * same view so the reviewer's screen can show the boundary next to the thing being reviewed.
 */
export interface ImprovementDetailView {
  readonly proposal: ImprovementProposalView
  readonly symptom: string
  readonly changes: readonly string[]
  readonly rollbackSteps: readonly string[]
  readonly requirements: readonly string[]
  readonly targets: readonly string[]
  readonly gates: readonly ImprovementGateView[]
  /** Every gate kind not currently passed. Never empty in a view that says `approved`. */
  readonly unsatisfied: readonly ImprovementGateKind[]
  readonly awaitsOwner: boolean
  readonly decidedAt: string | null
  readonly ownerApproved: boolean
  /** Always `false`. Rendered so the guarantee can be shown, not merely respected. */
  readonly appliesCode: false
  /** Always `false`. Nothing here executes. */
  readonly executesChange: false
  /** Always `'none'`. */
  readonly authority: 'none'
  /** Always `true`: `merged → rolled-back` is the only edge out of `merged`. */
  readonly rollbackAvailable: boolean
}

/* --------------------------------------------------------------- outcomes */

export type ImprovementProposalsOutcome =
  | { readonly ok: true; readonly view: ImprovementProposalsView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export type ImprovementDetailOutcome =
  | { readonly ok: true; readonly view: ImprovementDetailView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * The outcome of one trusted write.
 *
 * Core-internal. A window receives the *projection*, not the outcome of writing, and there is no
 * `improvement.*` command on the Core surface for a renderer to send one to. This is the same rule
 * `work.approval.decide` exists to protect: the one surface where a person is being trusted is not
 * a surface a window can reach.
 */
export type ImprovementWriteOutcome =
  | {
      readonly ok: true
      readonly operation:
        | 'proposed'
        | 'staged'
        | 'stage-confirmed'
        | 'tests-run'
        | 'tests-failed'
        | 'red-team-run'
        | 'reviewed'
        | 'rehearsed'
        | 'rehearsal-failed'
        | 'merge-requested'
        | 'evaluated'
        | 'merged'
        | 'declined'
        | 'rejected'
        | 'withdrawn'
        | 'rolled-back'
        | 'expired'
      readonly proposalId: string | null
      readonly reason: string
      readonly spent: number
    }
  | {
      readonly ok: false
      readonly operation: 'refused'
      readonly proposalId: string | null
      readonly reason: string
      readonly code: string
      readonly spent: number
    }

/** The fixed reason a build with no improvement domain reports. */
export const NO_IMPROVEMENT_DOMAIN_REASON =
  'this build has no improvement domain and none is simulated'

/** The fixed reason a window receives when no Core has started. */
export const NO_CORE_REASON = 'no Core has started yet'

export const IMPROVEMENT_SCHEMA_VERSION = 1

function zeroStatuses(): Readonly<Record<ImprovementStatus, number>> {
  return Object.freeze({
    proposed: 0,
    staging: 0,
    staged: 0,
    testing: 0,
    tested: 0,
    reviewing: 0,
    reviewed: 0,
    merging: 0,
    merged: 0,
    'rolled-back': 0,
    rejected: 0,
    expired: 0,
  })
}

function zeroKinds(): Readonly<Record<ImprovementKind, number>> {
  return Object.freeze({
    'latency-too-high': 0,
    'work-failing-repeatedly': 0,
    'token-budget-overrun': 0,
    'knowledge-gap-repeated': 0,
    'retrieval-missing': 0,
    'tool-limitation': 0,
    'procedure-too-weak': 0,
    'crash-or-degradation-recovered': 0,
  })
}

/** One frozen projection for a Core with no improvement domain and none simulated. */
export const ABSENT_IMPROVEMENT_PROJECTION: ImprovementProjection = Object.freeze({
  schemaVersion: IMPROVEMENT_SCHEMA_VERSION,
  mode: 'unavailable' as const,
  counts: Object.freeze({
    openProposals: 0,
    proposals: 0,
    activeMerges: 0,
    terminal: 0,
    rolledBack: 0,
    awaitingOwner: 0,
    awaitingReview: 0,
    costSpent: 0,
    costRemaining: 0,
    stale: 0,
    byStatus: zeroStatuses(),
    byKind: zeroKinds(),
  }),
  furthestStatus: null,
  awaitingOwner: Object.freeze([]),
  blockedOn: Object.freeze({}),
  mergesAwaitingReview: Object.freeze([]),
  mergeAuthority: 'none' as const,
  persistence: Object.freeze({
    mode: 'unavailable' as const,
    durable: false,
    degraded: false,
    reason: NO_IMPROVEMENT_DOMAIN_REASON,
  }),
})

/** Re-exported so a consumer holding one import has the decision shape too. */
export type { ImprovementDerivation, ImprovementGateRecord, MergeDecision }