/**
 * Runtime Activation (Phase 40) — the whole lane, as one barrel.
 *
 * The claim this phase makes is narrow and checkable:
 *
 * > Implemented is not available, and available is not active. Every domain in
 * > this Core can say which it is, why, and what is missing — and no domain can
 * > activate itself or widen its own authority to get there.
 *
 * The pieces:
 *   - `./types` — the closed status, dependency and activation vocabularies.
 *   - `./dependencies` — the pure dependency evaluator.
 *   - `./registry` — the canonical inventory of implemented domains.
 *   - `./state` — the idempotent fold over the durable activation journal.
 *   - `./controller` — the one owner of activation, start, stop and restart.
 *   - `./projection` — the diagnostics answers.
 *   - `./assertions` — structural audits. Not used by production code.
 */

export * from './types'
export {
  degradedRequirements,
  evaluateDependency,
  evaluateRequirements,
  missingRequirements,
  optional,
  require,
} from './dependencies'
export { RUNTIME_REGISTRY, orderedRegistry, registryById } from './registry'
export { initialRuntimeFold, reduceRuntimeEntry, reduceRuntimeState } from './state'
export {
  RuntimeActivationController,
  type RuntimeActivationControllerOptions,
  type RuntimeActivationHandler,
  type RuntimeJournalPort,
} from './controller'
export { runtimeAnswers, runtimeSummary, type RuntimeAnswers } from './projection'
export {
  FORBIDDEN_RUNTIME_IDENTIFIERS,
  PURE_RUNTIME_MODULES,
  findForbiddenIdentifiersInSource,
  stripComments,
  type RuntimeViolation,
} from './assertions'
