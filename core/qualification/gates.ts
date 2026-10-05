import type { GateKind, GateState } from './types'

/**
 * The release gate catalogue.
 *
 * Every gate a release decision may rest on is declared here, once, with the single
 * sentence it is meant to prove. That sentence is load-bearing: a gate whose claim
 * is "things work" is not a gate, because nothing can falsify it and so nothing can
 * hold it accountable.
 *
 * Two kinds of gate exist, and both are executed rather than asserted:
 *
 *   - `command` — a declared command whose exit status is the evidence. Type-checks,
 *     lint, the three test tiers, the Electron end-to-end run, and the build plus the
 *     release policy and the extension artifact.
 *   - `scenario` — a bounded cross-layer suite under `tests/qualification/scenarios`
 *     whose own assertions are the evidence. A scenario crosses at least two layers
 *     (Core, host, storage, provider, Device Hands, extension) and is bounded: a
 *     temporary data directory, no network, and a hard time budget.
 *
 * What is deliberately not here: any gate whose only evidence is a note, a
 * checklist, a claim in a document, or a test that a human says they ran. A
 * declaration with `command: null` is an admitted gap and can only ever be
 * `not-run`, which is a non-pass.
 *
 * Prerequisites exist so a broken foundation cannot be laundered into eleven green
 * lines. When a prerequisite does not pass, the dependent gate is `blocked` — never
 * skipped, and never quietly counted as satisfied.
 */

/** The closed set of gate ids. A new gate has to be added to this list. */
export const GATE_IDS = [
  'typescript',
  'lint',
  'tests-unit-core',
  'tests-host',
  'tests-red-team',
  'build',
  'e2e-electron',
  'release-policy',
  'extension-build',
  'startup-shutdown',
  'persistence-recovery',
  'stop-all',
  'provider-lifecycle-security',
  'runtime-activation-truth',
  'device-hands',
  'browser-extension',
] as const

export type GateId = (typeof GATE_IDS)[number]

export function isGateId(value: unknown): value is GateId {
  return typeof value === 'string' && (GATE_IDS as readonly string[]).includes(value)
}

export interface GateDeclaration {
  readonly id: GateId
  readonly title: string
  /** The one falsifiable sentence this gate exists to decide. */
  readonly claim: string
  readonly kind: GateKind
  /**
   * The command to execute, or `null`.
   *
   * `null` means there is nothing to run. That is a declared gap: the gate can only
   * be `not-run`, and `not-run` is not a pass. It exists in the type so that a future
   * gate cannot omit its evidence source and inherit a green mark by silence.
   */
  readonly command: readonly string[] | null
  /** Gates that must pass before this one is worth running. */
  readonly requires: readonly GateId[]
  /** False only for a gate explicitly recorded as not yet release-blocking. */
  readonly required: boolean
  /** Runtime capability ids this gate is evidence for. */
  readonly capabilities: readonly string[]
}

function gate(declaration: GateDeclaration): GateDeclaration {
  return Object.freeze(declaration)
}

export const RELEASE_GATES: readonly GateDeclaration[] = Object.freeze([
  /* ------------------------------------------------------------ commands */
  gate({
    id: 'typescript',
    title: 'TypeScript, every project',
    claim: 'Every TypeScript project in this repository type-checks with no errors.',
    kind: 'command',
    command: ['npm', 'run', 'typecheck'],
    requires: [],
    required: true,
    capabilities: ['core.security-spine'],
  }),
  gate({
    id: 'lint',
    title: 'Lint, app and extension',
    claim: 'Every linted source file in this repository passes ESLint with no findings.',
    kind: 'command',
    command: ['npm', 'run', 'verify:lint'],
    requires: [],
    required: true,
    capabilities: ['core.security-spine'],
  }),
  gate({
    id: 'tests-unit-core',
    title: 'Unit and Core suites',
    claim: 'The Core domain suites and the renderer unit suites pass with no failures.',
    kind: 'command',
    command: ['npm', 'run', 'test:unit-core'],
    requires: [],
    required: true,
    capabilities: [
      'core.missions',
      'core.work',
      'core.conversation',
      'core.context',
      'core.workforce',
      'core.brain',
      'core.personality',
      'core.attention',
      'core.office',
      'core.relay',
      'core.skills',
      'core.voice',
      'core.world',
      'core.life',
      'core.consciousness',
      'core.lifeloop',
      'core.foundry',
    ],
  }),
  gate({
    id: 'tests-host',
    title: 'Host and integration suites',
    claim: 'The Electron host bridge suites pass, so every seam Core is given is proved end to end.',
    kind: 'command',
    command: ['npm', 'run', 'test:host'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.security-spine', 'core.vault'],
  }),
  gate({
    id: 'tests-red-team',
    title: 'Red-team gauntlet',
    claim: 'Every adversarial suite passes, so no known forgery, escalation or bypass is open.',
    kind: 'command',
    command: ['npm', 'run', 'test:redteam'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.security-spine', 'core.sovereignty'],
  }),
  gate({
    id: 'build',
    title: 'Production build',
    claim: 'The renderer bundle and the unminified host artifacts build from this tree.',
    kind: 'command',
    command: ['npm', 'run', 'build'],
    requires: ['typescript', 'lint'],
    required: true,
    capabilities: [],
  }),
  gate({
    id: 'e2e-electron',
    title: 'Electron end-to-end',
    claim: 'A real Electron process boots this build, drives it and shuts it down with every check passing.',
    kind: 'command',
    command: ['npm', 'run', 'test:e2e'],
    requires: ['build'],
    required: true,
    capabilities: ['core.attention', 'core.conversation', 'core.brain', 'core.work', 'core.missions'],
  }),
  gate({
    id: 'release-policy',
    title: 'Release policy, lockfile and artifact budgets',
    claim:
      'The dependency lock is pinned and install-script allowlisted, Core stays clear of Electron and React, and every shipped artifact is inside its budget.',
    kind: 'command',
    command: ['npm', 'run', 'release:check'],
    requires: ['build'],
    required: true,
    capabilities: ['core.security-spine'],
  }),
  gate({
    id: 'extension-build',
    title: 'Browser extension artifact',
    claim: 'The Manifest V3 extension type-checks, lints and bundles into a loadable artifact.',
    kind: 'command',
    command: ['npm', 'run', 'extension:verify'],
    requires: [],
    required: true,
    capabilities: ['core.browserext'],
  }),

  /* ----------------------------------------------------------- scenarios */
  gate({
    id: 'startup-shutdown',
    title: 'Startup and shutdown, across Core and host',
    claim:
      'A Core started by the real host seam reaches ready, stops on request, releases its handlers and stays stopped across a restart.',
    kind: 'scenario',
    command: ['npm', 'run', 'test:scenario:startup-shutdown'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.security-spine'],
  }),
  gate({
    id: 'persistence-recovery',
    title: 'Persistence and recovery, across journal and stores',
    claim:
      'State written to a real journal and a real store on disk is read back by a fresh Core, and a record that fails validation is reported as corrupt rather than quietly skipped.',
    kind: 'scenario',
    command: ['npm', 'run', 'test:scenario:persistence-recovery'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.vault', 'core.missions'],
  }),
  gate({
    id: 'stop-all',
    title: 'STOP ALL, across every lane',
    claim:
      'A latched STOP ALL refuses work on every lane, survives a real restart and is lifted only by an explicit owner resume.',
    kind: 'scenario',
    command: ['npm', 'run', 'test:scenario:stop-all'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.security-spine', 'core.workforce', 'core.attention'],
  }),
  gate({
    id: 'provider-lifecycle-security',
    title: 'Provider lifecycle and credential security',
    claim:
      'A model provider is contacted only when a credential is stored, live traffic stays disabled without an explicit owner switch, and no key reaches a projection, a journal or a window.',
    kind: 'scenario',
    command: ['npm', 'run', 'test:scenario:provider-lifecycle-security'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.sovereignty'],
  }),
  gate({
    id: 'runtime-activation-truth',
    title: 'Runtime activation truth',
    claim:
      'Every registered runtime domain derives the same readiness from the release inventory as from the live activation controller, and none claims to be running without a handler.',
    kind: 'scenario',
    command: ['npm', 'run', 'test:scenario:runtime-activation-truth'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.sovereignty', 'core.evolution', 'core.threshold'],
  }),
  gate({
    id: 'device-hands',
    title: 'Device Hands, across Core and host adapters',
    claim:
      'Device Hands refuses every effect without an owner grant, refuses everything under STOP ALL, replays its journal after a restart, and keeps its blocked actions blocked.',
    kind: 'scenario',
    command: ['npm', 'run', 'test:scenario:device-hands'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.device-hands'],
  }),
  gate({
    id: 'browser-extension',
    title: 'Browser extension, across bridge and Device Hands',
    claim:
      'The extension bridge pairs, reads and refuses every page boundary its policy names, and routes every page-touching act through Device Hands rather than acting itself.',
    kind: 'scenario',
    command: ['npm', 'run', 'test:scenario:browser-extension'],
    requires: ['typescript'],
    required: true,
    capabilities: ['core.browserext', 'core.device-hands'],
  }),
])

const BY_ID: ReadonlyMap<GateId, GateDeclaration> = new Map(
  RELEASE_GATES.map((declaration) => [declaration.id, declaration]),
)

export function gateById(id: GateId): GateDeclaration {
  const found = BY_ID.get(id)
  if (found === undefined) throw new Error(`no such release gate: ${id}`)
  return found
}

/** The gates that have to pass for a release verdict of `ship`. */
export function requiredGates(): readonly GateDeclaration[] {
  return RELEASE_GATES.filter((declaration) => declaration.required)
}

/* ------------------------------------------------------------------ results */

/**
 * What actually happened when a gate was run.
 *
 * `command` is null when nothing ran — and that is exactly why `state` exists as a
 * separate field with `not-run` in it. A result with a null command can never carry
 * `pass`, and `normaliseGateState` below enforces that rather than trusting the
 * caller to have been careful.
 */
export interface GateResult {
  readonly id: GateId
  readonly state: GateState
  /** The command that ran, or null when nothing ran. */
  readonly command: readonly string[] | null
  /** The process exit status, or null when no process ran. */
  readonly exitCode: number | null
  /** Milliseconds the gate took, or null when nothing ran. */
  readonly durationMs: number | null
  /** A sentence explaining the state. Required. */
  readonly detail: string
  /** Up to a bounded number of output lines, kept for the report. */
  readonly output: readonly string[]
}

/**
 * Force a result into a state its own evidence permits.
 *
 * This is the anti-self-deception choke point, and it is deliberately unforgiving:
 *
 *   - No command means nothing ran, so `pass` becomes `not-run`.
 *   - A `pass` with a non-zero exit status becomes `fail`.
 *   - A `pass` with no exit status at all becomes `not-run`.
 *
 * The reason a runner, a test or a human could otherwise report `pass` for a gate
 * that never executed is that `pass` was just a string anybody could write. Now it
 * is a string only a function with evidence can write.
 */
export function normaliseGateState(result: GateResult): GateResult {
  if (result.state !== 'pass') return result
  if (result.command === null || result.exitCode === null) {
    return {
      ...result,
      state: 'not-run',
      detail:
        result.detail === ''
          ? 'reported as passing but no command ran, so it is recorded as never run'
          : `${result.detail}; reported as passing but no command ran, so it is recorded as never run`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      ...result,
      state: 'fail',
      detail: `reported as passing but exited ${String(result.exitCode)}, so it is recorded as failed`,
    }
  }
  return result
}

/**
 * The gates that can usefully run next, given what has already been decided.
 *
 * A gate is eligible when nothing has decided it yet *and* every prerequisite is
 * passing. A gate that has already failed is not re-listed: the answer to "can this
 * run?" is then "again, after you fix it", which is a different question from the one
 * this answers, and answering it by omission would hide the failure.
 *
 * A gate whose prerequisite did not pass is withheld. It is reported as `blocked` by
 * `blockingPrerequisites`, never dropped, and never counted as satisfied.
 */
export function eligibleGates(results: readonly GateResult[]): readonly GateId[] {
  const decided = new Map(results.map((result) => [result.id, result.state]))
  return RELEASE_GATES.filter(
    (declaration) =>
      !decided.has(declaration.id) &&
      declaration.requires.every((id) => decided.get(id) === 'pass'),
  ).map((declaration) => declaration.id)
}

/** The prerequisite ids that are not passing, for a gate that cannot run. */
export function blockingPrerequisites(
  declaration: GateDeclaration,
  results: readonly GateResult[],
): readonly GateId[] {
  const decided = new Map(results.map((result) => [result.id, result.state]))
  return declaration.requires.filter((id) => decided.get(id) !== 'pass')
}