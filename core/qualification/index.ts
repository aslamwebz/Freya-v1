/**
 * Release / Evaluation / System Qualification (Phase 49) — the whole lane, as one
 * barrel.
 *
 * The claim this phase makes, and the only one:
 *
 * > What this build can actually do is measurable, and what it cannot do is named.
 *
 * The pieces:
 *   - `./types` — the five readiness states, the six gate states, the closed
 *     evidence vocabulary and the two verdicts.
 *   - `./inventory` — the capability inventory, derived from the canonical runtime
 *     registry rather than a second hand-written list.
 *   - `./gates` — the release gate catalogue, with the one falsifiable sentence each
 *     gate exists to decide, plus the normalisation that stops an unexecuted gate
 *     from being reported as passing.
 *   - `./scope` — what the release claims it ships, and what it explicitly does not.
 *   - `./verdict` — the roll-up, as a pure function of gate results and inventory.
 */

export {
  EMPTY_READINESS_COUNTS,
  GATE_KINDS,
  GATE_STATES,
  isGateState,
  isReadinessState,
  isRunningReadiness,
  isVerdict,
  PASSING_GATE_STATE,
  READINESS_EVIDENCE_KINDS,
  READINESS_STATES,
  RUNNING_READINESS_STATES,
  VERDICTS,
  isPassing,
  type GateKind,
  type GateState,
  type ReadinessEvidence,
  type ReadinessEvidenceKind,
  type ReadinessState,
  type Verdict,
} from './types'

export {
  buildCapabilityInventory,
  buildInventoryFromProjection,
  capabilityReadiness,
  inventorySummary,
  readinessFromRuntimeStatus,
  type CapabilityInventory,
  type CapabilityRecord,
  type InventoryInput,
  type ProjectedInventoryInput,
} from './inventory'

export { startLiveQualification, type LiveQualification, type QualificationEnvironment, type StartLiveQualificationOptions } from './live'

/**
 * The canonical registry, re-exported.
 *
 * The runner has to walk the registry to check which implementations are physically
 * present in this tree. It could import `core/runtime/registry` directly, but going
 * through one barrel means there is exactly one module a consumer of this lane has to
 * know about.
 */
export { RUNTIME_REGISTRY, orderedRegistry, registryById, STOP_ALL_EXEMPT_DOMAIN } from '../runtime/registry'

export {
  blockingPrerequisites,
  eligibleGates,
  gateById,
  GATE_IDS,
  isGateId,
  normaliseGateState,
  RELEASE_GATES,
  requiredGates,
  type GateDeclaration,
  type GateId,
  type GateResult,
} from './gates'

export {
  nonRunningReadiness,
  satisfiesShippingClaim,
  SHIPPING_SCOPE,
  shippingCapabilities,
  shippingClaimFor,
  shippingReadinessFloor,
  notShippingCapabilities,
  type ShippingClaim,
  type ShippingDeclaration,
} from './scope'

export {
  blockingGates,
  canonicalReportJson,
  qualify,
  unrecordedRequiredGates,
  type CapabilityVerdict,
  type GateVerdict,
  type QualifyInput,
  type QualificationReport,
  type VerdictReason,
} from './verdict'

export { qualificationMarkdown } from './report'