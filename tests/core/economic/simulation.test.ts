import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SMA_WINDOW,
  SCENARIO_PARAMETERS,
  defineScenario,
  maxDrawdown,
  meanAbsoluteMove,
  round,
  runSimulation,
  validateSeries,
  type ScenarioDraft,
} from '../../../core/economic/simulation'
import {
  PAPER_METRIC_NAMES,
  PAPER_STARTING_CASH,
  admitPaperOrder,
  applyPaperOrder,
  computePaperMetrics,
  countClosedTrades,
  drawdownOf,
  markPaperPositions,
  paperEquity,
  type PaperOrderDraft,
} from '../../../core/economic/paper'
import { ECONOMIC_LIMITS, type PaperOrder } from '../../../core/economic/types'
import { narrowEconomicLimits } from '../../../core/economic/limits'
import { T0, series } from './harness'

/**
 * The Simulation and Paper Trading engines.
 *
 * Both are pure arithmetic over inputs somebody else supplied, so the interesting tests
 * are about two things: that the same inputs always give the same numbers, and that the
 * *shape* of what comes out is honest — every metric with a denominator and a unit, and
 * no metric emitted at all when there is nothing to divide by.
 */

const LIMITS = ECONOMIC_LIMITS

const RUNNING = [100, 101, 102, 101, 103, 105, 104, 106, 108, 107]

function draft(overrides: Partial<ScenarioDraft> = {}): ScenarioDraft {
  return {
    scenarioId: 'sc-1',
    name: 'a scenario',
    strategy: 'buy-and-hold',
    parameters: {},
    assumptions: [],
    symbol: 'ACME',
    ...overrides,
  }
}

function run(scenarioDraft: ScenarioDraft, closes: readonly number[]) {
  const defined = defineScenario(scenarioDraft, 'exp-1', [], LIMITS)
  if (!defined.ok) throw new Error(`scenario refused: ${defined.code}`)
  return runSimulation(
    {
      scenario: defined.scenario,
      series: series(closes),
      resultId: 'res-1',
      startedAt: T0,
      completedAt: T0,
    },
    LIMITS,
  )
}

describe('defining a scenario', () => {
  it('accepts a well-formed draft and freezes it', () => {
    const result = defineScenario(draft(), 'exp-1', [], LIMITS)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.scenario.status).toBe('pending')
      expect(result.scenario.result).toBeNull()
    }
  })

  it('refuses a strategy outside the closed set', () => {
    const result = defineScenario(draft({ strategy: 'crystal-ball' as never }), 'exp-1', [], LIMITS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-strategy')
  })

  it('refuses a parameter the strategy does not read', () => {
    // A scenario that could name any knob at all is a scenario whose rule set could
    // change between two runs of the same inputs, which is not a rule set.
    const result = defineScenario(draft({ parameters: { leverage: 5 } }), 'exp-1', [], LIMITS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-parameters')
  })

  it('refuses a parameter whose value is not a positive integer', () => {
    for (const window of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = defineScenario(
        draft({ strategy: 'sma-crossover', parameters: { window } }),
        'exp-1',
        [],
        LIMITS,
      )
      expect(result.ok, `window ${window}`).toBe(false)
    }
  })

  it('refuses a parameter name that is not a slug', () => {
    const result = defineScenario(
      draft({ strategy: 'sma-crossover', parameters: { 'Window Size': 3 } as never }),
      'exp-1',
      [],
      LIMITS,
    )
    expect(result.ok).toBe(false)
  })

  it('refuses more scenarios than the ceiling allows', () => {
    const narrow = narrowEconomicLimits({ maxScenariosPerExperiment: 1 })
    const held = [defineScenario(draft({ scenarioId: 'sc-0' }), 'exp-1', [], LIMITS)]
    const existing = held.flatMap((entry) => (entry.ok ? [entry.scenario] : []))
    const result = defineScenario(draft(), 'exp-1', existing, narrow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('experiment-cap-reached')
  })

  it('publishes the parameters each strategy reads', () => {
    // A closed list per strategy, so a caller can be told what is tunable without being
    // able to guess.
    expect(SCENARIO_PARAMETERS.cash).toEqual([])
    expect(SCENARIO_PARAMETERS['buy-and-hold']).toEqual([])
    expect(SCENARIO_PARAMETERS['sma-crossover']).toEqual(['window'])
  })
})

describe('validating a price series', () => {
  it('accepts a strictly increasing series of positive closes', () => {
    expect(validateSeries(series(RUNNING), LIMITS)).toBeNull()
  })

  it('refuses an empty series', () => {
    expect(validateSeries([], LIMITS)).toBe('invalid-series')
  })

  it('refuses a series that goes backwards in time', () => {
    // A series with no defined order to walk cannot be sorted into one: that would be a
    // silent correction of the caller's data.
    const backwards = [
      { at: '2026-03-01T10:00:00.000Z', close: 100 },
      { at: '2026-03-01T09:00:00.000Z', close: 101 },
    ]
    expect(validateSeries(backwards, LIMITS)).toBe('invalid-series')
  })

  it('refuses two observations at the same instant', () => {
    const repeated = [
      { at: '2026-03-01T09:00:00.000Z', close: 100 },
      { at: '2026-03-01T09:00:00.000Z', close: 101 },
    ]
    expect(validateSeries(repeated, LIMITS)).toBe('invalid-series')
  })

  it('refuses a non-positive or unreadable close', () => {
    for (const close of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = [
        { at: '2026-03-01T09:00:00.000Z', close: 100 },
        { at: '2026-03-01T10:00:00.000Z', close },
      ]
      expect(validateSeries(bad, LIMITS)).toBe('invalid-series')
    }
  })

  it('refuses a series longer than the ceiling', () => {
    const narrow = narrowEconomicLimits({ maxSeriesLength: 3 })
    expect(validateSeries(series(RUNNING), narrow)).toBe('invalid-series')
  })
})

describe('running a simulation', () => {
  it('is deterministic: the same series gives deep-equal results', () => {
    const first = run(draft(), RUNNING)
    const second = run(draft(), RUNNING)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(first.result).toEqual(second.result)
  })

  it('gives every metric a unit and a denominator', () => {
    const outcome = run(draft(), RUNNING)
    if (!outcome.ok) throw new Error('expected a result')
    for (const metric of outcome.result.metrics) {
      expect(metric.unit.length).toBeGreaterThan(0)
      expect(Number.isFinite(metric.denominator)).toBe(true)
      expect(metric.denominator).toBeGreaterThan(0)
    }
  })

  it('reports observations out of observations', () => {
    // `n - 1` moves between `n` observations, and reporting it as `n` would overstate the
    // sample by one in a way no reader could detect.
    const outcome = run(draft(), RUNNING)
    if (!outcome.ok) throw new Error('expected a result')
    const moves = outcome.result.metrics.find((metric) => metric.name === 'mean_absolute_move')
    expect(moves?.denominator).toBe(RUNNING.length - 1)
  })

  it('holds cash flat and takes no risk', () => {
    const outcome = run(draft({ strategy: 'cash' }), RUNNING)
    if (!outcome.ok) throw new Error('expected a result')
    const total = outcome.result.metrics.find((metric) => metric.name === 'total_return')
    const exposure = outcome.result.metrics.find((metric) => metric.name === 'exposure')
    expect(total?.value).toBe(0)
    expect(exposure?.value).toBe(0)
  })

  it('makes money and loses money symmetrically for buy and hold', () => {
    const up = run(draft(), [100, 110])
    const down = run(draft(), [100, 90])
    if (!up.ok || !down.ok) throw new Error('expected a result')
    const upReturn = up.result.metrics.find((metric) => metric.name === 'total_return')
    const downReturn = down.result.metrics.find((metric) => metric.name === 'total_return')
    expect(round(upReturn?.value ?? 0)).toBeCloseTo(0.1, 10)
    expect(round(downReturn?.value ?? 0)).toBeCloseTo(-0.1, 10)
  })

  it('reports a maximum drawdown as a positive ratio', () => {
    // "-12% drawdown" is a sentence two people read two ways; a ratio that means "how
    // much it fell" is the only honest version.
    const outcome = run(draft(), [100, 120, 90, 110])
    if (!outcome.ok) throw new Error('expected a result')
    const drawdown = outcome.result.metrics.find((metric) => metric.name === 'max_drawdown')
    expect(drawdown?.value).toBeGreaterThan(0)
    expect(drawdown?.value).toBeLessThanOrEqual(1)
  })

  it('refuses a series too short to produce a return', () => {
    const outcome = run(draft(), [100])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('insufficient-series')
  })

  it('refuses a crossover whose window the series cannot support', () => {
    // Shortening the window silently would turn a refusal into a result nobody asked for.
    const outcome = run(draft({ strategy: 'sma-crossover', parameters: { window: 8 } }), [100, 101, 102])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('insufficient-series')
  })

  it('runs a crossover once the window fits', () => {
    const outcome = run(draft({ strategy: 'sma-crossover' }), RUNNING)
    expect(outcome.ok).toBe(true)
  })

  it('uses a documented default window', () => {
    expect(DEFAULT_SMA_WINDOW).toBeGreaterThanOrEqual(2)
  })

  it('rounds to a fixed precision so two runs compare exactly', () => {
    expect(round(1 / 3)).toBe(0.333333333333)
    // `-0` and `0` are `toEqual` but not `Object.is` equal, and a metric that reads as
    // `-0` in a journal is a small lie about a number.
    expect(Object.is(round(-0), 0)).toBe(true)
    expect(round(Number.NaN)).toBe(0)
  })
})

describe('the drawing-down helpers', () => {
  it('reports zero for a curve that never fell', () => {
    expect(maxDrawdown([1, 2, 3])).toBe(0)
  })

  it('reports the largest fall, not the last one', () => {
    expect(round(maxDrawdown([1, 0.5, 0.9]))).toBe(0.5)
  })

  it('measures a drawdown in units for a portfolio', () => {
    expect(drawdownOf([100, 80, 90])).toBe(20)
  })

  it('averages moves over the moves, not over the points', () => {
    expect(round(meanAbsoluteMove(series([100, 110])))).toBe(0.1)
    expect(meanAbsoluteMove(series([100]))).toBe(0)
  })
})

/* ----------------------------------------------------------- paper trading */

function orderDraft(overrides: Partial<PaperOrderDraft> = {}): PaperOrderDraft {
  return {
    orderId: 'o-1',
    symbol: 'ACME',
    side: 'buy',
    quantity: 10,
    price: 100,
    placedAt: T0,
    reasoning: ['scenario:entry'],
    ...overrides,
  }
}

function admitted(overrides: Partial<PaperOrderDraft> = {}): PaperOrder {
  const result = admitPaperOrder(orderDraft(overrides), 'exp-1', [], LIMITS)
  if (!result.admitted) throw new Error(`order refused: ${result.code}`)
  return result.order
}

describe('admitting a simulated order', () => {
  it('admits a well-formed order and fills it', () => {
    const result = admitPaperOrder(orderDraft(), 'exp-1', [], LIMITS)
    expect(result.admitted).toBe(true)
    if (result.admitted) expect(result.order.status).toBe('filled')
  })

  it('refuses a symbol outside the grammar', () => {
    for (const symbol of ['acme', 'ACME CO', 'ACME; DROP TABLE', '']) {
      const result = admitPaperOrder(orderDraft({ symbol }), 'exp-1', [], LIMITS)
      expect(result.admitted, symbol).toBe(false)
      if (!result.admitted) expect(result.code).toBe('invalid-symbol')
    }
  })

  it('refuses a quantity outside the bounds rather than clamping it', () => {
    // Clamping would silently place a different order than the one that was asked for,
    // which in a system whose value is honesty about what was done is worse than refusing.
    for (const quantity of [0, -5, 1.5, LIMITS.maxOrderQuantity + 1]) {
      const result = admitPaperOrder(orderDraft({ quantity }), 'exp-1', [], LIMITS)
      expect(result.admitted, String(quantity)).toBe(false)
      if (!result.admitted) expect(result.code).toBe('invalid-quantity')
    }
  })

  it('refuses a price outside the bounds', () => {
    for (const price of [0, -1, LIMITS.maxOrderPrice + 1]) {
      const result = admitPaperOrder(orderDraft({ price }), 'exp-1', [], LIMITS)
      expect(result.admitted, String(price)).toBe(false)
      if (!result.admitted) expect(result.code).toBe('invalid-price')
    }
  })

  it('refuses a side that is neither a buy nor a sell', () => {
    const result = admitPaperOrder(orderDraft({ side: 'short-cover' as never }), 'exp-1', [], LIMITS)
    expect(result.admitted).toBe(false)
  })

  it('refuses an order with no reasoning', () => {
    const result = admitPaperOrder(orderDraft({ reasoning: [] }), 'exp-1', [], LIMITS)
    expect(result.admitted).toBe(false)
  })

  it('refuses once the experiment has as many orders as it may place', () => {
    const narrow = narrowEconomicLimits({ maxPaperOrdersPerExperiment: 1 })
    const first = admitted()
    const result = admitPaperOrder(orderDraft({ orderId: 'o-2' }), 'exp-1', [first], narrow)
    expect(result.admitted).toBe(false)
    if (!result.admitted) expect(result.code).toBe('order-cap-reached')
  })
})

describe('the simulated portfolio', () => {
  it('averages the price when adding to a long position', () => {
    const first = admitted({ orderId: 'o-1', quantity: 10, price: 100 })
    const after = applyPaperOrder([], first, 'exp-1', LIMITS)
    if (!after.ok) throw new Error('expected an application')
    const second = admitted({ orderId: 'o-2', quantity: 10, price: 120 })
    const added = applyPaperOrder(after.positions, second, 'exp-1', LIMITS)
    if (!added.ok) throw new Error('expected an application')
    expect(added.positions[0]?.quantity).toBe(20)
    expect(added.positions[0]?.averagePrice).toBe(110)
  })

  it('realises P&L on a close and leaves the basis alone', () => {
    const buy = admitted({ orderId: 'o-1', quantity: 10, price: 100 })
    const opened = applyPaperOrder([], buy, 'exp-1', LIMITS)
    if (!opened.ok) throw new Error('expected an application')
    const sell = admitted({ orderId: 'o-2', side: 'sell', quantity: 10, price: 130 })
    const closed = applyPaperOrder(opened.positions, sell, 'exp-1', LIMITS)
    if (!closed.ok) throw new Error('expected an application')
    expect(closed.fill.realizedPnl).toBe(300)
    expect(closed.fill.closed).toBe(true)
    expect(closed.positions).toHaveLength(0)
  })

  it('handles a crossing order as a close plus an open', () => {
    // Buying more of a short than it holds closes the short *and* opens a long. Getting
    // this wrong is how a backtest reports a profit it did not make.
    const short = admitted({ orderId: 'o-1', side: 'sell', quantity: 10, price: 100 })
    const opened = applyPaperOrder([], short, 'exp-1', LIMITS)
    if (!opened.ok) throw new Error('expected an application')
    expect(opened.positions[0]?.quantity).toBe(-10)

    const cover = admitted({ orderId: 'o-2', side: 'buy', quantity: 15, price: 90 })
    const crossed = applyPaperOrder(opened.positions, cover, 'exp-1', LIMITS)
    if (!crossed.ok) throw new Error('expected an application')
    // Ten units closed at a 10-point gain; five remain long at the fill price.
    expect(crossed.fill.realizedPnl).toBe(100)
    expect(crossed.positions[0]?.quantity).toBe(5)
    expect(crossed.positions[0]?.averagePrice).toBe(90)
  })

  it('refuses a new symbol once the experiment has as many positions as it may hold', () => {
    const narrow = narrowEconomicLimits({ maxPositionsPerExperiment: 1 })
    const first = admitted({ orderId: 'o-1', symbol: 'ACME' })
    const opened = applyPaperOrder([], first, 'exp-1', narrow)
    if (!opened.ok) throw new Error('expected an application')
    const other = admitted({ orderId: 'o-2', symbol: 'WIDGET' })
    const result = applyPaperOrder(opened.positions, other, 'exp-1', narrow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('position-cap-reached')
  })

  it('orders positions by symbol so two runs of the same orders agree', () => {
    const a = admitted({ orderId: 'o-1', symbol: 'ZZZ' })
    const b = admitted({ orderId: 'o-2', symbol: 'AAA' })
    const first = applyPaperOrder([], a, 'exp-1', LIMITS)
    if (!first.ok) throw new Error('expected an application')
    const both = applyPaperOrder(first.positions, b, 'exp-1', LIMITS)
    if (!both.ok) throw new Error('expected an application')
    expect(both.positions.map((position) => position.symbol)).toEqual(['AAA', 'ZZZ'])
  })

  it('marks a position to a price without touching the quantity', () => {
    const opened = applyPaperOrder([], admitted(), 'exp-1', LIMITS)
    if (!opened.ok) throw new Error('expected an application')
    const marked = markPaperPositions(opened.positions, { ACME: 150 })
    expect(marked[0]?.currentPrice).toBe(150)
    expect(marked[0]?.unrealizedPnl).toBe(500)
    expect(marked[0]?.quantity).toBe(10)
  })

  it('leaves a position alone when no price is supplied for it', () => {
    const opened = applyPaperOrder([], admitted(), 'exp-1', LIMITS)
    if (!opened.ok) throw new Error('expected an application')
    const marked = markPaperPositions(opened.positions, { OTHER: 150 })
    expect(marked[0]?.currentPrice).toBe(opened.positions[0]?.currentPrice)
  })

  it('adds up equity from the starting cash and the positions', () => {
    const opened = applyPaperOrder([], admitted({ quantity: 10, price: 100 }), 'exp-1', LIMITS)
    if (!opened.ok) throw new Error('expected an application')
    expect(paperEquity(opened.positions, PAPER_STARTING_CASH, 0)).toBe(PAPER_STARTING_CASH + 1000)
  })
})

describe('performance metrics', () => {
  const emptyInput = {
    experimentId: 'exp-1',
    positions: [],
    orders: [] as readonly PaperOrder[],
    startingCash: PAPER_STARTING_CASH,
    realizedPnl: 0,
    equityCurve: [PAPER_STARTING_CASH, PAPER_STARTING_CASH] as readonly number[],
    computedAt: T0,
    metricIdFor: (name: string) => `exp-1:${name}`,
  }

  it('gives every metric a denominator and a unit', () => {
    const opened = applyPaperOrder([], admitted({ quantity: 10, price: 100 }), 'exp-1', LIMITS)
    if (!opened.ok) throw new Error('expected an application')
    const { metrics } = computePaperMetrics(
      { ...emptyInput, positions: opened.positions, orders: [admitted()] },
      LIMITS,
    )
    expect(metrics.length).toBeGreaterThan(0)
    for (const metric of metrics) {
      expect(metric.denominator).toBeGreaterThan(0)
      expect(metric.unit).toMatch(/^(ratio|units|count)$/)
      expect(Number.isFinite(metric.value)).toBe(true)
    }
  })

  it('emits no metric at all rather than reporting 0/0 as zero', () => {
    // A portfolio that has never traded reporting "no losses" would be the single most
    // misleading sentence this subsystem could produce.
    const { metrics, uncertainties } = computePaperMetrics(emptyInput, LIMITS)
    expect(metrics.some((metric) => metric.denominator === 0)).toBe(false)
    expect(uncertainties.some((note) => note.includes('order_fill_rate'))).toBe(true)
  })

  it('explains every metric it declined to report', () => {
    const { metrics, uncertainties } = computePaperMetrics(emptyInput, LIMITS)
    expect(uncertainties.length).toBeGreaterThan(0)
    for (const note of uncertainties) expect(note.length).toBeGreaterThan(10)
    expect(metrics.length + uncertainties.length).toBeGreaterThan(0)
  })

  it('enforces the metric ceiling', () => {
    const narrow = narrowEconomicLimits({ maxMetricsPerExperiment: 2 })
    const opened = applyPaperOrder([], admitted(), 'exp-1', LIMITS)
    if (!opened.ok) throw new Error('expected an application')
    const { metrics } = computePaperMetrics(
      { ...emptyInput, positions: opened.positions, orders: [admitted()], equityCurve: [100, 90] },
      narrow,
    )
    expect(metrics).toHaveLength(2)
  })

  it('counts only closed trades as closed', () => {
    // An open position has not been closed, and reporting it as one is the easiest way
    // to make a backtest look busier than it was.
    const buys = [admitted({ orderId: 'o-1', quantity: 5 }), admitted({ orderId: 'o-2', quantity: 5 })]
    expect(countClosedTrades(buys)).toBe(0)
    const withSell = [...buys, admitted({ orderId: 'o-3', side: 'sell', quantity: 3 })]
    expect(countClosedTrades(withSell)).toBe(3)
  })

  it('ignores a sell with nothing behind it', () => {
    const orphan = [admitted({ orderId: 'o-1', side: 'sell', quantity: 7 })]
    expect(countClosedTrades(orphan)).toBe(0)
  })

  it('publishes the metrics it may report', () => {
    // A closed list, so a surface can build a legend without guessing.
    expect(PAPER_METRIC_NAMES).toContain('gross_exposure')
    expect(PAPER_METRIC_NAMES).toContain('realized_pnl')
  })
})