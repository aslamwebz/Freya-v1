/**
 * THE CAPABILITY ACQUISITION DOMAIN — Phase 29.
 *
 * Everything here is pure except the store in `core/vault/repositories`, which is the only module
 * in this phase that touches a database. The domain itself does no I/O, reads no clock, uses no
 * randomness and calls no model — `now` is always an explicit argument to every constructor and
 * every decision, which is what makes the lifecycle and the gate conjunction testable.
 *
 * ## The pipeline
 *
 * ```
 *   CapabilityGap → AcquisitionRequest → GateLedger → ActivationDecision → active
 *   a need, named   what would close it    every gate,   may this become     never, and
 *   but never held   and at what cost       with a verdict  active?          never alone
 * ```
 *
 * ## The four boundaries, stated as contracts
 *
 * 1. **A generated capability starts untrusted and inactive.** `trustClass` and `activation` are
 *    constants assigned inside `createAcquisitionRequest` and are absent from its input keys, so
 *    there is no call shape — typed or untyped — that produces a request arriving trusted or
 *    running. `rebuildAcquisitionRequest` refuses a stored row that claims otherwise, so the
 *    guarantee survives the round trip through the database.
 * 2. **A gap is a need, not a permission.** `wanted` is a bounded slug, never a capability id,
 *    and this domain never mints, names, resolves or holds a `Capability`.
 * 3. **Promotion requires verification *and* gates.** All seven gates, always. `owner-approval`
 *    is reachable only through the owner scope, and `no-capability-widening` is computed from the
 *    request rather than asserted.
 * 4. **No hidden loops, no unapproved spend.** Work is metered in `ACQUISITION_COST_UNITS` — a
 *    code-owned currency with no money in it — and refused **at** the ceiling. There is no
 *    scheduler, no timer and no retry anywhere in the phase.
 */

export * from './types'
export {
  REQUEST_INPUT_KEYS,
  REQUEST_KEYS,
  GAP_INPUT_KEYS,
  GAP_KEYS,
  activateAcquisitionRequest,
  advanceAcquisitionRequest,
  chargeAcquisitionCost,
  closeCapabilityGap,
  createAcquisitionRequest,
  createAcquisitionRequestForGap,
  createCapabilityGap,
  endAcquisitionRequest,
  expireCapabilityGap,
  expireStaleAcquisitionRequest,
  expireStaleActivation,
  isStaleAcquisitionRequest,
  isStaleActivation,
  type AcquisitionResult,
  type GapLookup,
} from './request'
export {
  GATE_VERDICT_INPUT_KEYS,
  RECORDABLE_GATE_KINDS,
  decideActivation,
  everyGateSatisfied,
  evaluateSelfGates,
  latestGateVerdicts,
  latestLedgerVerdicts,
  reasonForDecision,
  recordGateVerdict,
  recordOwnerApproval,
  unsatisfiedGates,
  validateDecisionGate,
  validateGateVerdict,
  type GateResult,
} from './gates'
export {
  rebuildActivationDecision,
  rebuildAcquisitionRequest,
  rebuildCapabilityGap,
  rebuildGateLedger,
  type Rebuild,
} from './rebuild'
export {
  ACQUISITION_RECORD_VERSION,
  applyRecord,
  emptyAcquisitionState,
  recordKey,
  validateRecord,
  type AcquisitionRecord,
  type RequestLookup,
} from './fold'
export {
  ACQUISITION_DERIVATION_SCHEMA_VERSION,
  deriveAcquisition,
  emptyAcquisitionDerivation,
} from './derive'
export {
  projectAcquisition,
  projectAcquisitionRequest,
  projectAcquisitionRequests,
  type AcquisitionProjectionInput,
} from './projection'
export {
  AcquisitionStoreError,
  type AcquisitionFaultCode,
  type AcquisitionHealth,
  type AcquisitionPersistenceMode,
  type AcquisitionStore,
  type AcquisitionWrite,
  type GateLedgerWrite,
} from './store'
export {
  AcquisitionEngine,
  emptyAcquisitionLedger,
  type AcquisitionEngineOptions,
  type AcquisitionGuardVerdict,
  type AcquisitionOwnerScope,
} from './engine'