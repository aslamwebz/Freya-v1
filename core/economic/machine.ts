import {
  ECONOMIC_SIGNALS,
  ECONOMIC_STAGES,
  OPENED_STAGE,
  isEconomicExperimentKind,
  isTerminalStage,
  type EconomicEventType,
  type EconomicExperimentKind,
  type EconomicSignal,
  type EconomicStage,
  type EconomicTransitionOutcome,
} from './types'

/**
 * The Economic State Machine.
 *
 * Seven stages, a closed set of ordinary signals, and one edge — `IDLE` on
 * `experiment-opened` — whose target is derived from the experiment's *kind* rather
 * than written in the table. Everything is a total function over finite inputs, so the
 * machine is provable by exhaustion rather than by review: every (stage, signal) pair
 * has exactly one answer, and any pair not in the table is refused with a code rather
 * than reaching for a default.
 *
 * The invariants it exists to hold:
 *
 *   1. only table transitions happen;
 *   2. `COMPLETE` and `FAILED` have no outgoing edge except `experiment-closed`;
 *   3. no stage is entered holding a deadline without one being written down — that is
 *      the runtime's job, and the fold refuses an entry that arrives without one;
 *   4. every stage change is journaled, and one journal event names exactly one change;
 *   5. the table contains no self-transition.
 *
 * ## Why cancellation lands in `FAILED`
 *
 * It does not, semantically. The stage machine tracks *progress*, and a cancelled
 * experiment has none — so it lands in the terminal stage that means "no longer in
 * progress" and journals `economic.experiment.cancelled`. The distinction the owner
 * actually cares about — finished, failed, or cancelled — lives in the experiment's
 * **lifecycle state** in `types.ts`, which has three separate terminal values. Two
 * vocabularies with two jobs, so neither has to lie about the other.
 */

/**
 * The ordinary transition table, keyed `[from][signal]`.
 *
 * Written out rather than computed, because a transition table that is *derived* is a
 * transition table that can be derived wrongly.
 *
 * Two entries deserve their reasons stated:
 *
 *   - `RESEARCHING` has both `research-complete` and `research-sufficient`, and the
 *     difference is whether there is a simulation to run. `sufficient` is how a kind
 *     skips a stage it has no work for: a research experiment goes straight to
 *     `ANALYZING` rather than passing through a `SIMULATING` stage it would traverse
 *     empty. A table that cannot express a skip is a table that forces fake work.
 *
 *   - `experiment-closed` appears only under the two terminal stages. Treating it as a
 *     no-op anywhere else would put a self-transition in the table and quietly destroy
 *     invariant 5.
 */
const ORDINARY_TRANSITIONS: Readonly<
  Record<EconomicStage, Readonly<Partial<Record<EconomicSignal, EconomicStage>>>>
> = Object.freeze({
  IDLE: Object.freeze({ 'experiment-failed': 'FAILED' }),
  RESEARCHING: Object.freeze({
    'research-complete': 'SIMULATING',
    'research-sufficient': 'ANALYZING',
    'experiment-failed': 'FAILED',
  }),
  SIMULATING: Object.freeze({
    'simulation-complete': 'PAPER_TRADING',
    'simulation-sufficient': 'ANALYZING',
    'experiment-failed': 'FAILED',
  }),
  PAPER_TRADING: Object.freeze({ 'paper-complete': 'ANALYZING', 'experiment-failed': 'FAILED' }),
  ANALYZING: Object.freeze({ 'analysis-complete': 'COMPLETE', 'experiment-failed': 'FAILED' }),
  COMPLETE: Object.freeze({ 'experiment-closed': 'IDLE' }),
  FAILED: Object.freeze({ 'experiment-closed': 'IDLE' }),
})

/**
 * Which journal event each stage change writes.
 *
 * One event per change and one change per event, so a reader can reconstruct the stage
 * from the journal without interpreting payloads. `IDLE -> *` on an opening is
 * recorded by `economic.experiment.created`, which *is* the opening — the experiment
 * does not exist before that entry, so there is nothing to move away from.
 */
type TransitionKey = `${EconomicStage}>${EconomicStage}`

const TRANSITION_EVENTS: Readonly<Partial<Record<TransitionKey, EconomicEventType | null>>> =
  Object.freeze({
    // An experiment that fails the instant it opens is still an opening that failed —
    // the event exists, and the fold refuses it when no experiment has been created.
    'IDLE>FAILED': 'economic.experiment.failed',
    'RESEARCHING>SIMULATING': 'economic.experiment.state-changed',
    'RESEARCHING>ANALYZING': 'economic.experiment.state-changed',
    'RESEARCHING>FAILED': 'economic.experiment.failed',
    'SIMULATING>PAPER_TRADING': 'economic.experiment.state-changed',
    'SIMULATING>ANALYZING': 'economic.experiment.state-changed',
    'SIMULATING>FAILED': 'economic.experiment.failed',
    'PAPER_TRADING>ANALYZING': 'economic.experiment.state-changed',
    'PAPER_TRADING>FAILED': 'economic.experiment.failed',
    'ANALYZING>COMPLETE': 'economic.experiment.completed',
    'ANALYZING>FAILED': 'economic.experiment.failed',
    'COMPLETE>IDLE': null,
    'FAILED>IDLE': null,
  })

const SIGNAL_REASONS: Readonly<Record<EconomicSignal, string>> = Object.freeze({
  'experiment-opened': 'An experiment was opened, in the stage its kind dictates.',
  'research-complete': 'The research finished and there is a simulation to run.',
  'research-sufficient': 'There is enough evidence, and nothing left to simulate.',
  'simulation-complete': 'The simulation finished and there is paper trading to do.',
  'simulation-sufficient': 'The simulation finished, and there is no paper trading to do.',
  'paper-complete': 'The simulated trading finished, and the results are ready to read.',
  'analysis-complete': 'The results were read, and the experiment is finished.',
  'experiment-failed': 'The experiment could not continue.',
  'experiment-closed': 'The experiment is closed out and its stage released.',
})

export function economicSignalReason(signal: EconomicSignal): string {
  return SIGNAL_REASONS[signal]
}

/**
 * Apply an ordinary signal.
 *
 * Refuses rather than throwing, because the callers are the journal writer and the
 * recovery path, and both need a refusal they can record.
 *
 * `kind` is required only for `experiment-opened`, because that is the only edge whose
 * target is not in the table. It is validated rather than trusted: an unknown kind is
 * refused with `missing-experiment-kind` instead of being coerced to the first stage,
 * so a caller cannot get a research experiment into `PAPER_TRADING` by naming a kind
 * that does not exist.
 */
export function transition(
  from: EconomicStage,
  signal: EconomicSignal,
  kind?: EconomicExperimentKind,
): EconomicTransitionOutcome {
  if (!(ECONOMIC_STAGES as readonly string[]).includes(from)) {
    return {
      ok: false,
      from,
      signal,
      code: 'unknown-stage',
      reason: 'That is not a stage an economic experiment can be in.',
    }
  }
  if (!(ECONOMIC_SIGNALS as readonly string[]).includes(signal)) {
    return {
      ok: false,
      from,
      signal,
      code: 'illegal-transition',
      reason: 'That is not a signal the economic state machine understands.',
    }
  }

  const to = targetFor(from, signal, kind)
  if (to === null) {
    // Opening an experiment needs the kind, because the kind decides the stage. Reporting
    // that as "that move is not in the table" would be the same class of wrong as telling
    // a reader debugging a stuck experiment that a stage they never named is unreachable.
    if (from === 'IDLE' && signal === 'experiment-opened' && !isEconomicExperimentKind(kind)) {
      return {
        ok: false,
        from,
        signal,
        code: 'missing-experiment-kind',
        reason:
          'An experiment opens in the stage its kind dictates, and the kind is what says which. None was given, so no stage is chosen.',
      }
    }
    // Terminal states get their own code, because "you cannot move a finished
    // experiment" is a different fact from "that move is not in the table", and a
    // reader debugging a stuck experiment needs to tell them apart.
    const code = isTerminalStage(from) ? 'already-terminal' : 'illegal-transition'
    return {
      ok: false,
      from,
      signal,
      code,
      reason: isTerminalStage(from)
        ? 'This experiment has already finished. It has to be closed out before anything else happens.'
        : 'The economic state machine cannot make that move from where it is.',
    }
  }
  if (to === from) {
    // Unreachable by construction over the frozen table, and asserted by exhaustion in
    // the suite. Kept as a guard because a future edit that introduced one would
    // otherwise be invisible.
    return {
      ok: false,
      from,
      signal,
      code: 'self-transition',
      reason: 'That move would not have changed anything.',
    }
  }

  return {
    ok: true,
    from,
    to,
    signal,
    event: TRANSITION_EVENTS[`${from}>${to}` as TransitionKey] ?? null,
    reason: SIGNAL_REASONS[signal],
  }
}

/**
 * Where a signal takes the machine from where it is.
 *
 * The single edge outside the table is resolved here, and returning `null` for it when
 * the kind is missing or unknown is what turns "somebody opened an experiment without
 * saying what kind it is" into a refusal rather than a guess.
 */
function targetFor(
  from: EconomicStage,
  signal: EconomicSignal,
  kind: EconomicExperimentKind | undefined,
): EconomicStage | null {
  if (from === 'IDLE' && signal === 'experiment-opened') {
    if (!isEconomicExperimentKind(kind)) return null
    return OPENED_STAGE[kind]
  }
  return ORDINARY_TRANSITIONS[from][signal] ?? null
}

/** Every ordinary transition, for exhaustion tests. */
export function allEconomicTransitions(): readonly {
  readonly from: EconomicStage
  readonly signal: EconomicSignal
  readonly to: EconomicStage | null
}[] {
  const rows: { from: EconomicStage; signal: EconomicSignal; to: EconomicStage | null }[] = []
  for (const from of ECONOMIC_STAGES) {
    for (const signal of ECONOMIC_SIGNALS) {
      const to =
        from === 'IDLE' && signal === 'experiment-opened'
          ? null
          : (ORDINARY_TRANSITIONS[from][signal] ?? null)
      rows.push({ from, signal, to })
    }
  }
  return rows
}

/**
 * The signals legal from a stage, in table order.
 *
 * Used by the fold to reject an entry that claims a move the table does not contain,
 * and by the runtime to pick the next step without a `default` branch — there is no
 * default branch, because there is no "otherwise".
 */
export function signalsFrom(stage: EconomicStage): readonly EconomicSignal[] {
  return (Object.keys(ORDINARY_TRANSITIONS[stage]) as EconomicSignal[]).filter(
    (signal) => !(stage === 'IDLE' && signal === 'experiment-opened'),
  )
}

/**
 * Re-derive the machine's invariants from the table itself.
 *
 * Used by the suite as an exhaustion check rather than by production code, which is
 * why it lives here and not in the tests: these are statements *about* the machine, and
 * they belong next to the thing they are about.
 */
export function auditEconomicTable(): readonly string[] {
  const findings: string[] = []
  for (const from of ECONOMIC_STAGES) {
    for (const signal of ECONOMIC_SIGNALS) {
      const to =
        from === 'IDLE' && signal === 'experiment-opened'
          ? null
          : (ORDINARY_TRANSITIONS[from][signal] ?? null)
      if (to === null) continue
      if (to === from) findings.push(`self-transition ${from} on "${signal}"`)
      if (isTerminalStage(from) && signal !== 'experiment-closed') {
        findings.push(`terminal stage ${from} has an outgoing edge on "${signal}"`)
      }
      if (TRANSITION_EVENTS[`${from}>${to}` as TransitionKey] === undefined) {
        findings.push(`${from}>${to} names no journal event`)
      }
    }
  }
  for (const kind of Object.keys(OPENED_STAGE) as EconomicExperimentKind[]) {
    if (ORDINARY_TRANSITIONS[OPENED_STAGE[kind]]['experiment-failed'] === undefined) {
      findings.push(`a ${kind} experiment cannot fail from the stage it opens in`)
    }
  }
  return findings
}