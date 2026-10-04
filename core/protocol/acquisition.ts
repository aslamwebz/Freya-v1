import type { Confidence } from '../brain/types'
import type {
  GapClosureReason,
  GapKind,
  GateAuthority,
  GateKind,
  GateReason,
  GateVerdict,
  RequestLifecycleReason,
  RequestStatus,
  TrustClass,
} from '../acquisition/types'

/**
 * THE ACQUISITION PROTOCOL — what a window may know about what Freya is trying to acquire.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a renderer is typed
 * against, one frozen projection for a Core with no acquisition domain, and the outcome
 * vocabulary of the reads that exist.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed labels, statuses, instants, provenance *metadata* (which gate, which
 * authority, which named verifier, how many references), counts, cost units spent and remaining,
 * and the measured length of every text-bearing field.
 *
 * Does not cross, in any broad read:
 *
 * - **The symptom or intent text.** `acquisition.requests.read` carries `intentLength`. The one
 *   way to read a request's own words is the explicit, single-record `acquisition.request.read`.
 * - **Any status, gate verdict or approval a window could assert.** There is no write verb on
 *   this surface at all, and no `acquisition.*` command on the Core surface: a window cannot
 *   propose a build, cannot report a verification and cannot approve anything.
 * - **Any capability, permission or grant field.** Every request crosses carrying
 *   `grantsCapability: false` and `authority: 'none'` as values, so a surface can *render* the
 *   guarantee rather than merely not violate it.
 */

/* ------------------------------------------------------------------ views */

/** One gap as a broad read may hold it. The symptom is measured, never carried. */
export interface AcquisitionGapView {
  readonly gapId: string
  readonly kind: GapKind
  /** A slug describing the shape of what is missing. Never a capability id. */
  readonly wanted: string
  readonly occurrences: number
  /** Ids only — never content. */
  readonly evidenceCount: number
  readonly tags: readonly string[]
  readonly detectedBy: 'core' | 'owner'
  readonly detectedAt: string
  readonly expiresAt: string
  readonly status: 'open' | 'closed'
  readonly closedAt: string | null
  readonly closureReason: GapClosureReason | null
  readonly symptomLength: number
}

/** One request as a broad read may hold it. The intent is measured, never carried. */
export interface AcquisitionRequestView {
  readonly requestId: string
  readonly gapId: string
  readonly subject: string
  readonly intentLength: number
  readonly requirementCount: number
  readonly targetCount: number
  readonly stepCount: number
  /** How many steps have been charged. Never a completion claim: nothing verifies a build here. */
  readonly chargedSteps: number
  readonly costCeiling: number
  readonly costSpent: number
  readonly tags: readonly string[]
  readonly confidence: Confidence
  readonly trustClass: TrustClass
  readonly activation: string
  readonly status: RequestStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly activationExpiresAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: RequestLifecycleReason | null
}

/** One gate as a broad read may hold it. Names who produced it; carries ids, not content. */
export interface AcquisitionGateView {
  readonly kind: GateKind
  readonly verdict: GateVerdict
  readonly reason: GateReason
  readonly authority: GateAuthority
  /** The named producer, or null for a gate nothing produced a verdict for. */
  readonly verifier: string | null
  readonly evidenceCount: number
  readonly recordedAt: string
}

export interface AcquisitionPersistenceView {
  readonly mode: 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'
  readonly durable: boolean
  readonly degraded: boolean
  readonly reason: string | null
}

export interface AcquisitionCountsView {
  readonly openGaps: number
  readonly closedGaps: number
  readonly requests: number
  readonly active: number
  readonly terminal: number
  readonly awaitingOwner: number
  readonly costSpent: number
  readonly costRemaining: number
  readonly stale: number
  readonly byStatus: Readonly<Record<RequestStatus, number>>
  readonly byGapKind: Readonly<Record<GapKind, number>>
}

export interface AcquisitionProjection {
  readonly schemaVersion: number
  /** `'unavailable'` only for a build with no acquisition domain. */
  readonly mode: 'available' | 'unavailable'
  readonly counts: AcquisitionCountsView
  readonly furthestStatus: RequestStatus | null
  /** Requests finished and waiting on the one gate only a person can pass. */
  readonly awaitingOwner: readonly string[]
  /** Every gate kind any request still has unsatisfied, counted. */
  readonly blockedOn: Readonly<Record<GateKind, number>>
  /** Always `'none'`. This domain grants nothing and activates nothing. */
  readonly activationAuthority: 'none'
  /** Always `'untrusted'`. Nothing here is ever better than the class it starts in. */
  readonly trustClassFloor: TrustClass
  readonly persistence: AcquisitionPersistenceView
}

export interface AcquisitionRequestsView {
  readonly gaps: readonly AcquisitionGapView[]
  readonly items: readonly AcquisitionRequestView[]
  readonly truncated: boolean
  readonly total: number
  readonly schemaVersion: number
}

/**
 * One request in full, on an explicit single-record read.
 *
 * Carries the intent and the step list because somebody reviewing an activation has to see what
 * is being activated, and it carries `grantsCapability: false` and `authority: 'none'` in the
 * same view so the reviewer's screen can show the boundary next to the thing being reviewed.
 */
export interface AcquisitionRequestDetailView {
  readonly request: AcquisitionRequestView
  readonly intent: string
  readonly requirements: readonly string[]
  readonly targets: readonly string[]
  readonly steps: readonly string[]
  readonly gates: readonly AcquisitionGateView[]
  /** Every gate kind not currently passed. Never empty in a view that says `approved`. */
  readonly unsatisfied: readonly GateKind[]
  readonly awaitsOwner: boolean
  readonly decidedAt: string | null
  readonly ownerApproved: boolean
  /** Always `false`. Rendered so the guarantee can be shown, not merely respected. */
  readonly grantsCapability: false
  /** Always `'none'`. */
  readonly authority: 'none'
}

/* --------------------------------------------------------------- outcomes */

export type AcquisitionRequestsOutcome =
  | { readonly ok: true; readonly view: AcquisitionRequestsView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export type AcquisitionRequestReadOutcome =
  | { readonly ok: true; readonly view: AcquisitionRequestDetailView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * The outcome of one trusted write.
 *
 * Core-internal. A window receives the *projection*, not the outcome of writing, and there is no
 * `acquisition.*` command on the Core surface for a renderer to send one to. This is the same
 * rule `work.approval.decide` exists to protect: the one surface where a person is being
 * trusted is not a surface a window can reach.
 */
export type AcquisitionWriteOutcome =
  | {
      readonly ok: true
      readonly operation:
        | 'gap-detected'
        | 'requested'
        | 'built'
        | 'verified'
        | 'verification-failed'
        | 'activation-requested'
        | 'evaluated'
        | 'activated'
        | 'declined'
        | 'rejected'
        | 'withdrawn'
        | 'revoked'
        | 'expired'
      readonly requestId: string | null
      readonly reason: string
      readonly spent: number
    }
  | {
      readonly ok: false
      readonly operation: 'refused'
      readonly requestId: string | null
      readonly reason: string
      readonly code: string
      readonly spent: number
    }

/** The fixed reason a build with no acquisition domain reports. */
export const NO_ACQUISITION_DOMAIN_REASON = 'this build has no acquisition domain and none is simulated'

/** The fixed reason a window receives when no Core has started. */
export const NO_CORE_REASON = 'no Core has started yet'

export const ACQUISITION_SCHEMA_VERSION = 1

function zeroStatuses(): Readonly<Record<RequestStatus, number>> {
  return Object.freeze({
    proposed: 0,
    building: 0,
    built: 0,
    verifying: 0,
    verified: 0,
    'activation-requested': 0,
    active: 0,
    rejected: 0,
    expired: 0,
  })
}

function zeroGapKinds(): Readonly<Record<GapKind, number>> {
  return Object.freeze({
    'tool-absent': 0,
    'format-unsupported': 0,
    'step-not-automatable': 0,
    'evidence-missing': 0,
    'environment-limit': 0,
  })
}

function zeroGates(): Readonly<Record<GateKind, number>> {
  return Object.freeze({
    'verification-passed': 0,
    'tests-passed': 0,
    'red-team-clean': 0,
    'no-protected-target': 0,
    'no-capability-widening': 0,
    'budget-within-limit': 0,
    'owner-approval': 0,
  })
}

/** One frozen projection for a Core with no acquisition domain and none simulated. */
export const ABSENT_ACQUISITION_PROJECTION: AcquisitionProjection = Object.freeze({
  schemaVersion: ACQUISITION_SCHEMA_VERSION,
  mode: 'unavailable' as const,
  counts: Object.freeze({
    openGaps: 0,
    closedGaps: 0,
    requests: 0,
    active: 0,
    terminal: 0,
    awaitingOwner: 0,
    costSpent: 0,
    costRemaining: 0,
    stale: 0,
    byStatus: zeroStatuses(),
    byGapKind: zeroGapKinds(),
  }),
  furthestStatus: null,
  awaitingOwner: Object.freeze([]),
  blockedOn: zeroGates(),
  activationAuthority: 'none' as const,
  trustClassFloor: 'untrusted' as TrustClass,
  persistence: Object.freeze({
    mode: 'unavailable' as const,
    durable: false,
    degraded: false,
    reason: NO_ACQUISITION_DOMAIN_REASON,
  }),
})