import { deriveAcquisition } from './derive'
import { unsatisfiedGates } from './gates'
import {
  ACQUISITION_LIMITS,
  type AcquisitionRequest,
  type ActivationDecision,
  type AcquisitionState,
  type CapabilityGap,
  type GateVerdictRecord,
} from './types'
import {
  ACQUISITION_SCHEMA_VERSION,
  type AcquisitionGateView,
  type AcquisitionGapView,
  type AcquisitionPersistenceView,
  type AcquisitionProjection,
  type AcquisitionRequestDetailView,
  type AcquisitionRequestReadOutcome,
  type AcquisitionRequestView,
  type AcquisitionRequestsOutcome,
  type AcquisitionRequestsView,
} from '../protocol/acquisition'

/**
 * THE ACQUISITION PROJECTION.
 *
 * What Freya is trying to acquire, what is blocking it, and what it has cost — and nothing else.
 *
 * The privacy rule is the same one `core/learning` follows and it is worth restating because
 * this domain's text is the most tempting of all: a request's intent is a description of code
 * Freya intends to write about the owner's files, and a symptom describes what Freya could not
 * do. Neither crosses in any broad read. `intentLength` and `symptomLength` are measured and
 * carried, so a surface can show that there is something there without the something crossing.
 */

export interface AcquisitionProjectionInput {
  readonly state: AcquisitionState
  readonly persistence: AcquisitionPersistenceView
  readonly now: string
}

/** The broad projection. No symptom text, no intent text, no step list. */
export function projectAcquisition(input: AcquisitionProjectionInput): AcquisitionProjection {
  const derivation = deriveAcquisition(input.state, input.now)
  return Object.freeze({
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    mode: 'available' as const,
    counts: Object.freeze({
      openGaps: derivation.counts.openGaps,
      closedGaps: derivation.counts.closedGaps,
      requests: derivation.counts.requests,
      active: derivation.counts.active,
      terminal: derivation.counts.terminal,
      awaitingOwner: derivation.awaitingOwner.length,
      costSpent: derivation.counts.costSpent,
      costRemaining: derivation.counts.costRemaining,
      stale: derivation.counts.stale,
      byStatus: derivation.counts.byStatus,
      byGapKind: derivation.counts.byGapKind,
    }),
    furthestStatus: derivation.furthestStatus,
    awaitingOwner: derivation.awaitingOwner,
    blockedOn: derivation.blockedOn,
    activationAuthority: 'none' as const,
    trustClassFloor: derivation.trustClassFloor,
    persistence: input.persistence,
  })
}

/** A broad read of the ledger: gaps and requests as metadata. */
export function projectAcquisitionRequests(
  state: AcquisitionState,
  options: { limit?: number } = {},
): AcquisitionRequestsOutcome {
  const limit = boundLimit(options.limit)
  const gaps = [...state.gaps.values()].sort((a, b) => a.gapId.localeCompare(b.gapId))
  const requests = [...state.requests.values()].sort((a, b) => a.requestId.localeCompare(b.requestId))
  const kept = requests.slice(0, limit)
  const view: AcquisitionRequestsView = Object.freeze({
    gaps: Object.freeze(gaps.slice(0, limit).map(gapView)),
    items: Object.freeze(kept.map(requestView)),
    // Truncation is reported rather than silent: a read that quietly dropped half the ledger
    // would show a Freya with fewer outstanding builds than she actually has.
    truncated: gaps.length > limit || requests.length > limit,
    total: requests.length,
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
  })
  return { ok: true, view, reason: null }
}

/**
 * One request in full, for the owner reviewing an activation.
 *
 * The only read that carries intent text and the step list, because a person deciding whether to
 * activate something has to see what it is. It carries the gate ledger and the newest decision
 * beside it, and `unsatisfied` is computed rather than stored, so the screen cannot disagree
 * with the ledger about whether this is ready.
 */
export function projectAcquisitionRequest(
  state: AcquisitionState,
  requestId: string,
  now: string,
): AcquisitionRequestReadOutcome {
  const request = state.requests.get(requestId)
  if (request === undefined) {
    return { ok: false, code: 'no-such-request', reason: 'that acquisition request does not exist' }
  }
  const ledger = state.gates.get(requestId) ?? []
  const decision = state.decisions.get(requestId) ?? null
  const view = detailView(request, ledger, decision, now)
  return { ok: true, view, reason: null }
}

function detailView(
  request: AcquisitionRequest,
  ledger: readonly GateVerdictRecord[],
  decision: ActivationDecision | null,
  now: string,
): AcquisitionRequestDetailView {
  const unsatisfied = unsatisfiedGates(request, ledger, now)
  const view = requestView(request)
  return Object.freeze({
    request: view,
    intent: request.intent,
    requirements: Object.freeze([...request.requirements]),
    targets: Object.freeze([...request.targets]),
    steps: Object.freeze([...request.steps]),
    gates: Object.freeze([...(decision?.gates ?? ledger).map(gateView)]),
    unsatisfied: Object.freeze([...unsatisfied]),
    awaitsOwner: unsatisfied.length === 1 && unsatisfied[0] === 'owner-approval',
    decidedAt: decision?.decidedAt ?? null,
    ownerApproved: decision?.ownerApproved === true,
    grantsCapability: false as const,
    authority: 'none' as const,
  })
}

function gapView(gap: CapabilityGap): AcquisitionGapView {
  return Object.freeze({
    gapId: gap.gapId,
    kind: gap.kind,
    wanted: gap.wanted,
    occurrences: gap.occurrences,
    evidenceCount: gap.evidenceRefs.length,
    tags: Object.freeze([...gap.tags]),
    detectedBy: gap.detectedBy,
    detectedAt: gap.detectedAt,
    expiresAt: gap.expiresAt,
    status: gap.status,
    closedAt: gap.closedAt,
    closureReason: gap.closureReason,
    symptomLength: gap.symptom.length,
  })
}

function requestView(request: AcquisitionRequest): AcquisitionRequestView {
  return Object.freeze({
    requestId: request.requestId,
    gapId: request.gapId,
    subject: request.subject,
    intentLength: request.intent.length,
    requirementCount: request.requirements.length,
    targetCount: request.targets.length,
    stepCount: request.steps.length,
    chargedSteps: request.costSpent,
    costCeiling: request.costCeiling,
    costSpent: request.costSpent,
    tags: Object.freeze([...request.tags]),
    confidence: request.confidence,
    trustClass: request.trustClass,
    activation: request.activation,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    activationExpiresAt: request.activationExpiresAt,
    lifecycleAt: request.lifecycleAt,
    lifecycleReason: request.lifecycleReason,
  })
}

function gateView(verdict: GateVerdictRecord): AcquisitionGateView {
  return Object.freeze({
    kind: verdict.kind,
    verdict: verdict.verdict,
    reason: verdict.reason,
    authority: verdict.authority,
    verifier: verdict.verifier,
    evidenceCount: verdict.evidenceRefs.length,
    recordedAt: verdict.recordedAt,
  })
}

function boundLimit(limit: number | undefined): number {
  if (limit === undefined) return ACQUISITION_LIMITS.maxProjectionRecords
  if (!Number.isInteger(limit) || limit < 1) return 1
  return Math.min(limit, ACQUISITION_LIMITS.maxProjectionRecords)
}