/**
 * Release / Evaluation / System Qualification (Phase 49) — the closed vocabularies.
 *
 * Two sentences hold this lane together:
 *
 * > A gate that did not run is not a gate that passed.
 * > A capability that is not in this build is not a capability that is merely quiet.
 *
 * Phase 40 already established that *implemented* is not *available* and *available*
 * is not *active*, for a single Core at runtime. This phase answers the different
 * question a release decision actually asks: given what is in this tree and what is
 * installed on this machine, what is genuinely working, what is running with less
 * than it claims, what is held back by a missing dependency, and what is simply not
 * here at all.
 *
 * That is the five-state readiness vocabulary below, and it is deliberately not the
 * same as a boolean. `active` and `available` both mean "yes"; collapsing them would
 * hide the difference between "running under this Core right now" and "every
 * dependency is satisfied but nothing started it".
 *
 * Data only: no clock, no journal, no port, no `node:` import, no Electron, no React.
 */

/* ======================================================================== *
 * Capability readiness
 * ======================================================================== */

/**
 * The five readiness states.
 *
 * - `active` — running under this Core in this build, with every declared
 *   dependency satisfied and no reduced capability.
 * - `available` — every declared dependency is satisfied and nothing is stopping
 *   it, but no handler is wired, so it has not been started. This is a real
 *   capability that is genuinely not running, and saying `active` would be a lie.
 * - `degraded` — running, but with at least one optional dependency absent. The
 *   reason is always stated.
 * - `blocked` — deliberately not running: a required dependency is missing, a
 *   domain is declared fail-closed, or STOP ALL is latched.
 * - `unavailable` — the implementation is not in this build, or the tooling that
 *   would exercise it is not installed. There is nothing here to run, and nothing
 *   here to have been skipped quietly either.
 */
export const READINESS_STATES = [
  'active',
  'available',
  'degraded',
  'blocked',
  'unavailable',
] as const

export type ReadinessState = (typeof READINESS_STATES)[number]

export function isReadinessState(value: unknown): value is ReadinessState {
  return typeof value === 'string' && (READINESS_STATES as readonly string[]).includes(value)
}

/**
 * The states that mean "this capability is running in some form".
 *
 * `degraded` counts. A Capability whose Vault key is absent still serves the owner,
 * and reporting it as not-running would understate what ships. What it does not do
 * is let a degraded capability be reported as a whole one — that is why `degraded`
 * is its own state instead of a boolean flag on `active`.
 */
export const RUNNING_READINESS_STATES: readonly ReadinessState[] = Object.freeze([
  'active',
  'degraded',
])

export function isRunningReadiness(state: ReadinessState): boolean {
  return RUNNING_READINESS_STATES.includes(state)
}

export const EMPTY_READINESS_COUNTS: Readonly<Record<ReadinessState, number>> = Object.freeze({
  active: 0,
  available: 0,
  degraded: 0,
  blocked: 0,
  unavailable: 0,
})

/** What the repository check that backs a readiness claim has to be. */
export type ReadinessEvidenceKind =
  /** A module file this repository actually ships, checked on disk. */
  | 'module-present'
  /** A unit or Core suite in this repository that exercises the module. */
  | 'test-suite'
  /** A host seam this repository actually wires. */
  | 'host-seam'
  /** A tool or binary that has to be installed before the claim can be checked. */
  | 'external-tool'
  /** A Phase 49 scenario gate that exercises this capability across layers. */
  | 'qualification-gate'

export const READINESS_EVIDENCE_KINDS: readonly ReadinessEvidenceKind[] = Object.freeze([
  'module-present',
  'test-suite',
  'host-seam',
  'external-tool',
  'qualification-gate',
])

/** One checked thing a readiness claim rests on, or the gap in it. */
export interface ReadinessEvidence {
  readonly kind: ReadinessEvidenceKind
  /** A repository path, a test path, an npm script name or a tool name. */
  readonly reference: string
  /** False when the evidence could not be found, which lowers the claim. */
  readonly present: boolean
  /** A sentence a person can read. Never a secret. */
  readonly detail: string
}

/* ======================================================================== *
 * Gate outcomes
 * ======================================================================== */

/**
 * The six gate outcomes.
 *
 * Note what is absent: there is no `skipped` that means "fine". A gate that could
 * not be evaluated is `unavailable` or `blocked`, and both of those count against
 * the verdict. `not-run` exists so an unexecuted gate can be recorded at all —
 * which is the difference between an honest gap and a silent success.
 */
export const GATE_STATES = [
  /** Executed, and it proved the claim. */
  'pass',
  /** Executed, and it did not. */
  'fail',
  /** Executed and proved the required half; an optional part is missing. */
  'degraded',
  /** Not executed because a gate it depends on is not passing. */
  'blocked',
  /** Not executable here: the tool, binary or artifact it needs is not present. */
  'unavailable',
  /** Never executed. Recorded so the gap is visible rather than absent. */
  'not-run',
] as const

export type GateState = (typeof GATE_STATES)[number]

export function isGateState(value: unknown): value is GateState {
  return typeof value === 'string' && (GATE_STATES as readonly string[]).includes(value)
}

/**
 * The only state a gate may be in for the release to be considered clear.
 *
 * Everything else — including `degraded` and `not-run` — is a non-pass. This is the
 * single most important predicate in the phase, and it is a predicate rather than a
 * convention so that a future gate author cannot quietly widen it.
 */
export const PASSING_GATE_STATE: GateState = 'pass'

export function isPassing(state: GateState): boolean {
  return state === PASSING_GATE_STATE
}

/** How a gate is satisfied: by running a command, or by nothing at all. */
export type GateKind =
  /** A declared command whose exit code is the evidence. */
  | 'command'
  /** A bounded cross-layer scenario suite whose own assertions are the evidence. */
  | 'scenario'

export const GATE_KINDS: readonly GateKind[] = Object.freeze(['command', 'scenario'])

/* ======================================================================== *
 * Verdicts
 * ======================================================================== */

export const VERDICTS = ['ship', 'no-ship'] as const
export type Verdict = (typeof VERDICTS)[number]

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value)
}