import {
  isSimulationStrategy,
  type EconomicLimits,
  type EconomicRefusalCode,
  type PricePoint,
  type SimulationMetric,
  type SimulationResult,
  type SimulationScenario,
  type SimulationStrategy,
} from './types'

/**
 * The Simulation Engine.
 *
 * Deterministic backtests and bounded scenarios. Given the same series and the same
 * parameters it produces the same numbers, every time, on every machine — which is the
 * only property that makes a backtest worth having. A simulator whose output depended
 * on a clock, a random seed, or a version of itself would be an anecdote.
 *
 * Three things this module deliberately does not have:
 *
 *   - **No model.** Nothing here calls a provider, and nothing here takes a function
 *     that could. The strategy set is a frozen list of three, implemented here, because
 *     a rule set that could change between two runs of the same inputs is not a rule
 *     set.
 *   - **No fetching.** The price series is a parameter. Phase 32 reaches no network, so
 *     "get me the data" is somebody else's job and the seam for it is a port.
 *   - **No rounding surprise.** Every emitted number is rounded to a fixed number of
 *     decimal places *before* it is compared or journalled, so two runs are `toEqual`
 *     rather than merely close. Floating point drift is the quiet enemy of a claim like
 *     this one.
 *
 * Every metric carries its own `unit` and `denominator`. A backtest that reported a
 * percentage without saying out of what would be indistinguishable from a result, and
 * a result that cannot be told apart from a guess is worse than no result.
 */

/** Decimal places every emitted number is rounded to. Twelve is past float noise and short of pretence. */
export const SIMULATION_PRECISION = 12

/** The default short window for the crossover strategy. */
export const DEFAULT_SMA_WINDOW = 3

/** Parameter names a scenario may set, per strategy. Closed. */
export const SCENARIO_PARAMETERS: Readonly<Record<SimulationStrategy, readonly string[]>> = Object.freeze({
  cash: [],
  'buy-and-hold': [],
  'sma-crossover': ['window'],
})

const PARAMETER_NAME = /^[a-z0-9_]{1,32}$/

export interface ScenarioDraft {
  readonly scenarioId: string
  readonly name: string
  readonly strategy: SimulationStrategy
  readonly parameters: Readonly<Record<string, number>>
  readonly assumptions: readonly string[]
  /**
   * Which series to run against.
   *
   * Named here rather than passed separately because a scenario that does not say what it
   * is about is not reproducible: this is the field that answers "the same inputs, twice"
   * when somebody re-runs it in six months. Phase 32 fetches nothing itself, so it is
   * used to ask the port for a series and nothing else.
   */
  readonly symbol: string
}

export type ScenarioDefinition =
  | { readonly ok: true; readonly scenario: SimulationScenario }
  | { readonly ok: false; readonly code: EconomicRefusalCode; readonly reason: string }

const SCENARIO_REFUSALS = Object.freeze({
  'invalid-strategy': 'That is not a strategy this subsystem knows how to run.',
  'invalid-parameters': 'Those simulation parameters are not usable.',
  'invalid-series': 'That price series is not usable.',
  'insufficient-series': 'There were not enough observations to run that.',
  'experiment-cap-reached': 'That experiment has as many scenarios as it is allowed.',
  'criteria-over-long': 'That scenario named more assumptions than it may.',
} as const)

type ScenarioRefusalCode = keyof typeof SCENARIO_REFUSALS

export function scenarioRefusalReason(code: EconomicRefusalCode): string {
  const entry = (SCENARIO_REFUSALS as Readonly<Record<string, string>>)[code]
  return entry ?? 'That scenario could not be run.'
}

/**
 * Turn a draft into a scenario, or refuse it.
 *
 * Refuses rather than throwing, and every refusal is a closed code. The parameter
 * checks are the interesting part: names must be slugs from the strategy's own closed
 * set, and values must be finite — so a scenario cannot smuggle a string through a
 * `Record<string, number>` by way of an `as` cast from untrusted JSON, and cannot name
 * a knob no strategy reads.
 */
export function defineScenario(
  draft: ScenarioDraft,
  experimentId: string,
  existing: readonly SimulationScenario[],
  limits: EconomicLimits,
): ScenarioDefinition {
  const refuse = (code: ScenarioRefusalCode): ScenarioDefinition => ({
    ok: false,
    code,
    reason: SCENARIO_REFUSALS[code],
  })

  if (existing.length >= limits.maxScenariosPerExperiment) return refuse('experiment-cap-reached')
  if (!isSimulationStrategy(draft.strategy)) return refuse('invalid-strategy')
  if (draft.assumptions.length > limits.maxAssumptionsPerScenario) return refuse('criteria-over-long')
  if (Object.keys(draft.parameters).length > limits.maxParametersPerScenario) {
    return refuse('invalid-parameters')
  }

  const permitted = SCENARIO_PARAMETERS[draft.strategy]
  for (const [key, value] of Object.entries(draft.parameters)) {
    if (!PARAMETER_NAME.test(key)) return refuse('invalid-parameters')
    if (!permitted.includes(key)) return refuse('invalid-parameters')
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return refuse('invalid-parameters')
    }
    if (!Number.isInteger(value)) return refuse('invalid-parameters')
  }

  if (draft.assumptions.some((entry) => typeof entry !== 'string' || entry.length > limits.maxPayloadTextLength)) {
    return refuse('criteria-over-long')
  }

  return {
    ok: true,
    scenario: {
      scenarioId: draft.scenarioId,
      experimentId,
      name: draft.name.slice(0, limits.maxTitleLength),
      strategy: draft.strategy,
      // Copied and re-keyed, so a caller mutating its object afterwards cannot reach
      // into a scenario the runtime is holding.
      parameters: Object.freeze({ ...draft.parameters }),
      assumptions: Object.freeze([...draft.assumptions]),
      status: 'pending',
      result: null,
    },
  }
}

/** Validate a price series. Returns a refusal code, or null when it is usable. */
export function validateSeries(
  series: readonly PricePoint[],
  limits: EconomicLimits,
): EconomicRefusalCode | null {
  if (!Array.isArray(series) || series.length === 0) return 'invalid-series'
  if (series.length > limits.maxSeriesLength) return 'invalid-series'
  for (const point of series) {
    if (typeof point !== 'object' || point === null) return 'invalid-series'
    if (typeof point.at !== 'string' || !Number.isFinite(Date.parse(point.at))) return 'invalid-series'
    if (typeof point.close !== 'number' || !Number.isFinite(point.close) || point.close <= 0) {
      return 'invalid-series'
    }
  }
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1]
    const current = series[index]
    if (previous === undefined || current === undefined) return 'invalid-series'
    // Strictly increasing. A series that goes backwards in time has no defined order
    // to walk, and sorting it would be a silent correction of the caller's data.
    if (Date.parse(current.at) <= Date.parse(previous.at)) return 'invalid-series'
  }
  return null
}

export interface SimulationRunRequest {
  readonly scenario: SimulationScenario
  readonly series: readonly PricePoint[]
  readonly resultId: string
  readonly startedAt: string
  readonly completedAt: string
}

export type SimulationRun =
  | { readonly ok: true; readonly result: SimulationResult }
  | { readonly ok: false; readonly code: EconomicRefusalCode; readonly reason: string }

/**
 * Run one scenario and produce its metrics.
 *
 * Pure: the only inputs are the scenario, the series and two instants supplied by the
 * caller. There is no clock read, no allocation of an id, and no I/O — so the runtime
 * can call it twice with the same arguments and get deep-equal results, and a test can
 * assert exact numbers.
 */
export function runSimulation(request: SimulationRunRequest, limits: EconomicLimits): SimulationRun {
  const { scenario, series } = request
  const refuse = (code: EconomicRefusalCode, reason: string): SimulationRun => ({
    ok: false,
    code,
    reason,
  })

  const seriesProblem = validateSeries(series, limits)
  if (seriesProblem !== null) return refuse(seriesProblem, scenarioRefusalReason(seriesProblem))

  if (series.length < 2) {
    return refuse('insufficient-series', scenarioRefusalReason('insufficient-series'))
  }

  const window = resolveWindow(scenario)
if (scenario.strategy === 'sma-crossover' && window === null) {
    return refuse(
      'insufficient-series',
      'A crossover needs a window of at least two observations to look back over, and this one names less.',
    )
  }
  // The window has to *fit* the series, not merely exist. A crossover whose window can
  // never be satisfied produces a flat curve, and a flat curve is indistinguishable from
  // a strategy that correctly held cash throughout — so a backtest would report a result
  // for a rule that never ran. That is the exact failure this engine exists to avoid, so
  // the run is refused instead.
  if (window !== null && series.length - 1 < window) {
    return refuse(
      'insufficient-series',
      `A crossover looking back over ${window} observations needs at least that many intervals, and this series has ${series.length - 1}.`,
    )
  }

  const equity = equityCurve(scenario.strategy, series, window)
  const first = equity[0] ?? 1
  const last = equity[equity.length - 1] ?? first
  const held = exposure(scenario.strategy, series, window)

  const metrics: SimulationMetric[] = [
    {
      name: 'total_return',
      value: round(last / first - 1),
      unit: 'ratio',
      denominator: 1,
    },
    { name: 'max_drawdown', value: round(maxDrawdown(equity)), unit: 'ratio', denominator: 1 },
    { name: 'exposure', value: round(held), unit: 'ratio', denominator: 1 },
    { name: 'observations', value: series.length, unit: 'count', denominator: series.length },
    {
      name: 'mean_absolute_move',
      value: round(meanAbsoluteMove(series)),
      // The denominator is `n - 1` because there are exactly `n - 1` moves between `n`
      // observations. Reporting it as `n` would overstate the sample by one and no
      // reader would be able to tell.
      denominator: series.length - 1,
      unit: 'ratio',
    },
  ]

  return {
    ok: true,
    result: {
      resultId: request.resultId,
      scenarioId: scenario.scenarioId,
      experimentId: scenario.experimentId,
      strategy: scenario.strategy,
      metrics,
      observations: series.length,
      startedAt: request.startedAt,
      completedAt: request.completedAt,
    },
  }
}

/**
 * The crossover window, or null when the series cannot support one.
 *
 * Read from the scenario's own parameters and clamped to the closed list, so a caller
 * asking for a window of `0` or `-5` or `1e9` gets `null` — a refusal — rather than a
 * number that would make the strategy meaningless.
 */
function resolveWindow(scenario: SimulationScenario): number | null {
  if (scenario.strategy !== 'sma-crossover') return null
  const asked = scenario.parameters.window ?? DEFAULT_SMA_WINDOW
  if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 2) return null
  return asked
}

/**
 * The strategy's equity curve, starting at exactly 1.
 *
 * Written as three explicit loops rather than a dispatch through a table of functions,
 * because each strategy's rule *is* the interesting part and hiding them behind an
 * indirection would make the module's honesty claim untestable by reading it.
 */
function equityCurve(
  strategy: SimulationStrategy,
  series: readonly PricePoint[],
  window: number | null,
): readonly number[] {
  const curve: number[] = [1]
  if (strategy === 'cash') {
    // One unit of cash, held. The curve is flat by construction rather than by special
    // case at every consumer.
    for (let index = 1; index < series.length; index += 1) curve.push(1)
    return curve
  }

  let equity = 1
  if (strategy === 'buy-and-hold') {
    for (let index = 0; index < series.length; index += 1) {
      if (index > 0) {
        const previous = series[index - 1]
        const current = series[index]
        if (previous !== undefined && current !== undefined) {
          equity *= current.close / previous.close
        }
      }
      curve.push(equity)
    }
    return curve
  }

  const lookback = window ?? DEFAULT_SMA_WINDOW
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1]
    const current = series[index]
    if (previous === undefined || current === undefined) break
    const short = shortMean(series, index, lookback)
    const wantHeld = short !== null && current.close > short
    if (wantHeld) equity *= current.close / previous.close
    curve.push(equity)
  }
  return curve
}

/**
 * The mean of the `lookback` closes before `index`, or null when there are not enough.
 *
 * Null rather than a partial mean: a crossover over two observations instead of three
 * is a *different strategy*, and silently shortening the window would turn a refusal
 * into a result nobody asked for.
 */
function shortMean(series: readonly PricePoint[], index: number, lookback: number): number | null {
  if (index - lookback < 0) return null
  let total = 0
  for (let offset = 1; offset <= lookback; offset += 1) {
    const point = series[index - offset]
    if (point === undefined) return null
    total += point.close
  }
  return total / lookback
}

/** The fraction of observations the strategy was not holding cash. */
function exposure(
  strategy: SimulationStrategy,
  series: readonly PricePoint[],
  window: number | null,
): number {
  if (series.length === 0) return 0
  if (strategy === 'cash') return 0
  if (strategy === 'buy-and-hold') return 1

  const lookback = window ?? DEFAULT_SMA_WINDOW
  let held = 0
  for (let index = 1; index < series.length; index += 1) {
    const current = series[index]
    if (current === undefined) continue
    const short = shortMean(series, index, lookback)
    if (short !== null && current.close > short) held += 1
  }
  return held / (series.length - 1)
}

/**
 * The largest peak-to-trough fall in the curve, as a positive ratio.
 *
 * Positive, because "a maximum drawdown of `-12%`" is a sentence two people will read
 * two different ways, and a ratio that means "how much it fell" is the only honest
 * version. `0` for a curve that never fell.
 */
export function maxDrawdown(curve: readonly number[]): number {
  let peak = curve[0] ?? 1
  let worst = 0
  for (const value of curve) {
    if (value > peak) peak = value
    if (peak <= 0) continue
    const fall = (peak - value) / peak
    if (fall > worst) worst = fall
  }
  return worst
}

/** The mean absolute close-to-close move. `0` when there are no moves to average. */
export function meanAbsoluteMove(series: readonly PricePoint[]): number {
  if (series.length < 2) return 0
  let total = 0
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1]
    const current = series[index]
    if (previous === undefined || current === undefined) continue
    total += Math.abs(current.close / previous.close - 1)
  }
  return total / (series.length - 1)
}

/**
 * Round to the module's fixed precision.
 *
 * `+ 0` normalises `-0` to `0`, which matters because `-0` and `0` are `toEqual` in
 * vitest but are *not* `Object.is` equal, and a metric that reads as `-0` in a
 * journal is a small lie about a number.
 */
export function round(value: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = Math.pow(10, SIMULATION_PRECISION)
  const rounded = Math.round(value * factor) / factor
  return rounded === 0 ? 0 : rounded
}

/**
 * Compare two results on total return.
 *
 * Returns a **sort key** rather than a verdict, and returns `null` for a tie. It is used
 * to rank scenarios, never to declare a winner: a simulation says what happened under
 * stated assumptions, and picking a strategy from it is a decision this subsystem
 * refuses to make on the owner's behalf. That refusal is why there is no
 * "recommended strategy" anywhere in Phase 32.
 */
export function totalReturnOf(result: SimulationResult): number {
  return result.metrics.find((metric) => metric.name === 'total_return')?.value ?? 0
}