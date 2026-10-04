/**
 * THE SELF-IMPROVEMENT DOMAIN — Phase 30.
 *
 * Everything here is pure except the store in `core/vault/repositories`, which is the only module
 * in this phase that touches a database. The domain itself does no I/O, reads no clock, uses no
 * randomness and calls no model — `now` is always an explicit argument to every constructor and
 * every decision, which is what makes the lifecycle and the gate conjunction testable.
 *
 * ## The pipeline
 *
 * ```
 *   ImprovementProposal → StagedChange → GateLedger → MergeDecision → merged
 *   a claim that          what would be   every gate,   may this land  never alone,
 *   something is costing  different, and   with a       and stay?     and never by
 *   Freya                 what it undoes   a verdict                 a machine
 * ```
 *
 * ## The five contracts
 *
 * 1. **Nothing is applied by anything here.** `IMPROVEMENT_APPLIES_NOTHING` is a value, and
 *    `StageExecution.appliedBy` is hard-set to `'owner'` with no producer. A self-merge is not
 *    prevented here; it is *unrepresentable*.
 * 2. **A change starts unstaged.** `status` is a constant assigned inside
 *    `createImprovementProposal` and is absent from its input keys, so no call shape — typed or
 *    untyped — produces a proposal arriving `staged`, `tested` or `merged`.
 *    `rebuildImprovementProposal` re-checks the derived fields on read.
 * 3. **Rollback is a first-class state, not a revert.** `merged → rolled-back` is the only edge
 *    out of `merged`, because a landed change that cannot be undone is a change that happened.
 * 4. **Rollback must be *proven*, not promised.** `rollback-verified` is a gate like any other, and
 *    the rehearsal happens while the change is still staged. A rollback discovered to be
 *    impossible during an incident is not a rollback, it is a post-mortem.
 * 5. **No authority widening, ever.** `FORBIDDEN_IMPROVEMENTS` and
 *    `PROTECTED_IMPROVEMENT_SURFACES` are refused at construction *and* recomputed as derived
 *    gates on every decision, so a hand-edited row still meets a gate that refuses it. The
 *    forbidden list includes `improvement.gates.write`, `improvement.rollback.disable` and
 *    `improvement.merge.auto`: a change that can turn off its own brakes is not an improvement.
 */

export * from './types'
export {
  PROPOSAL_INPUT_KEYS,
  PROPOSAL_KEYS,
  closeImprovementProposal,
  createImprovementProposal,
  describeStage,
  isKnownStageTarget,
  type ImprovementResult,
} from './proposal'
export {
  IMPROVEMENT_GATE_INPUT_KEYS,
  RECORDABLE_IMPROVEMENT_GATES,
  advanceImprovement,
  chargeImprovementCost,
  decideMerge,
  everyGateSatisfied,
  evaluateDerivedGates,
  expireStaleImprovement,
  expireStaleMerge,
  isMergeStale,
  isStaleProposal,
  latestGateRecords,
  latestLedgerGateRecords,
  reasonForMergeDecision,
  recordImprovementGate,
  recordOwnerMergeApproval,
  rollBackImprovement,
  unsatisfiedImprovementGates,
  validateDecisionGate,
  validateImprovementGate,
  type GateOutcome,
} from './gates'
export {
  rebuildGateLedger,
  rebuildImprovementProposal,
  rebuildMergeDecision,
  type Rebuild,
} from './rebuild'
export {
  IMPROVEMENT_RECORD_VERSION,
  applyRecord,
  emptyImprovementState,
  recordKey,
  validateRecord,
  type ImprovementRecord,
  type RequestLookup,
} from './fold'
export {
  IMPROVEMENT_DERIVATION_SCHEMA_VERSION,
  deriveImprovement,
  emptyImprovementDerivation,
} from './derive'
export {
  projectImprovement,
  projectImprovementProposal,
  projectImprovementProposals,
  type ImprovementProjectionInput,
} from './projection'
export {
  ImprovementStoreError,
  type GateLedgerWrite,
  type ImprovementFaultCode,
  type ImprovementHealth,
  type ImprovementPersistenceMode,
  type ImprovementStore,
  type ImprovementWrite,
} from './store'
export {
  ImprovementEngine,
  type ImprovementEngineOptions,
  type ImprovementGuardVerdict,
  type ImprovementOwnerScope,
} from './engine'