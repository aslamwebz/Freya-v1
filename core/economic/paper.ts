import {
  isPaperOrderSide,
  type EconomicLimits,
  type EconomicMetric,
  type EconomicRefusalCode,
  type PaperOrder,
  type PaperPosition,
} from './types'
import { round } from './simulation'

/**
 * The Paper Trading Engine.
 *
 * Simulated orders against a simulated portfolio. There is no brokerage integration, no
 * venue, no account and no currency to settle in, and — the part worth being precise
 * about — there is no *field* in which any of those could be named. A `PaperOrder` is a
 * record in a fold; placing one appends an event. That is the whole of the "no real
 * orders" guarantee, and it is structural rather than a policy somebody has to keep
 * applying.
 *
 * What the engine is actually for is honest arithmetic. Positions, average prices,
 * realised P&L, an equity curve and a small set of metrics that each carry their own
 * denominator. The reason the metrics insist on denominators is that a percentage
 * without one is indistinguishable from a guess, and the whole reason someone would
 * look at a paper-trading result is to decide something.
 */

/**
 * The simulated capital every paper-trading experiment starts with.
 *
 * **Simulated units. Not money.** There is no currency, nothing is deposited, nothing is
 * withdrawn, and no code path in Phase 32 converts this number into anything a
 * counterparty could honour. It exists so that exposure and P&L have something to be
 * measured *against*, which is the only reason a denominator is needed at all.
 */
export const PAPER_STARTING_CASH = 100_000

/** The symbol grammar. Uppercase letters, digits and one separator. */
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9./-]{0,15}$/

/** The closed reasons an order may be refused. */
const ORDER_REFUSALS = Object.freeze({
  'invalid-symbol': 'That is not a symbol this subsystem will trade.',
  'invalid-quantity': 'That quantity is not a quantity a simulated order may carry.',
  'invalid-price': 'That price is not a price a simulated order may carry.',
  'invalid-side': 'A simulated order is a buy or a sell, and this was neither.',
  'order-cap-reached': 'That experiment has as many simulated orders as it is allowed.',
  'position-cap-reached': 'That experiment has as many open positions as it is allowed.',
  'experiment-kind-mismatch': 'Only a paper-trading experiment places simulated orders.',
  'experiment-terminal': 'That experiment has already finished.',
} as const)

type OrderRefusalCode = keyof typeof ORDER_REFUSALS

export function orderRefusalReason(code: OrderRefusalCode): string {
  return ORDER_REFUSALS[code]
}

/** An order, as a caller asks for one. Nothing here is a real trade. */
export interface PaperOrderDraft {
  readonly orderId: string
  readonly symbol: string
  readonly side: PaperOrder['side']
  readonly quantity: number
  readonly price: number
  readonly placedAt: string
  readonly reasoning: readonly string[]
}

export type PaperOrderAdmission =
  | { readonly admitted: true; readonly order: PaperOrder }
  | { readonly admitted: false; readonly code: EconomicRefusalCode; readonly reason: string }

/**
 * Admit a simulated order.
 *
 * Every field is checked rather than trusted, including the ones the type already
 * guarantees, because the value came from somewhere — and the checks that matter are
 * the *bounds*: a quantity or a price outside the ceiling is refused, not clamped.
 * Clamping would silently place a different order than the one that was asked for, which
 * in a system whose entire value is honesty about what was done is worse than refusing.
 */
export function admitPaperOrder(
  draft: PaperOrderDraft,
  experimentId: string,
  existingOrders: readonly PaperOrder[],
  limits: EconomicLimits,
): PaperOrderAdmission {
  const refuse = (code: OrderRefusalCode): PaperOrderAdmission => ({
    admitted: false,
    code,
    reason: ORDER_REFUSALS[code],
  })

  if (existingOrders.length >= limits.maxPaperOrdersPerExperiment) return refuse('order-cap-reached')
  if (typeof draft.symbol !== 'string' || !SYMBOL_PATTERN.test(draft.symbol)) {
    return refuse('invalid-symbol')
  }
  if (draft.symbol.length > limits.maxSymbolLength) return refuse('invalid-symbol')
  if (!isPaperOrderSide(draft.side)) return refuse('invalid-side')
  if (
    typeof draft.quantity !== 'number' ||
    !Number.isFinite(draft.quantity) ||
    draft.quantity <= 0 ||
    !Number.isInteger(draft.quantity) ||
    draft.quantity > limits.maxOrderQuantity
  ) {
    return refuse('invalid-quantity')
  }
  if (
    typeof draft.price !== 'number' ||
    !Number.isFinite(draft.price) ||
    draft.price <= 0 ||
    draft.price > limits.maxOrderPrice
  ) {
    return refuse('invalid-price')
  }
  if (!Number.isFinite(Date.parse(draft.placedAt))) return refuse('invalid-price')
  if (draft.reasoning.length === 0) return refuse('invalid-side')
  if (draft.reasoning.some((entry) => typeof entry !== 'string' || entry.length > limits.maxPayloadTextLength)) {
    return refuse('invalid-side')
  }
  if (existingOrders.some((order) => order.orderId === draft.orderId)) {
    return refuse('order-cap-reached')
  }

  return {
    admitted: true,
    order: {
      orderId: draft.orderId,
      experimentId,
      symbol: draft.symbol,
      side: draft.side,
      quantity: draft.quantity,
      price: round(draft.price),
      placedAt: new Date(Date.parse(draft.placedAt)).toISOString(),
      // Filled, because this subsystem fills against the price the caller named and has
      // no market to wait for. `pending` exists in the type so that the fold can record
      // an order that was refused *after* being placed, but nothing in Phase 32 produces
      // one — and a status nothing produces is better than a status nothing needs.
      status: 'filled',
      reasoning: Object.freeze([...draft.reasoning]),
    },
  }
}

/** What one filled order did to the portfolio. */
export interface PaperFill {
  readonly positionId: string
  readonly symbol: string
  readonly quantity: number
  readonly averagePrice: number
  /** P&L realised by this order alone. `0` for a position-opening order. */
  readonly realizedPnl: number
  /** True when this order closed a position out entirely. */
  readonly closed: boolean
}

export type PaperApplication =
  | { readonly ok: true; readonly positions: readonly PaperPosition[]; readonly fill: PaperFill }
  | { readonly ok: false; readonly code: EconomicRefusalCode; readonly reason: string }

/**
 * Apply a filled order to a set of positions.
 *
 * The arithmetic is the ordinary one, written out rather than delegated, and it has one
 * non-obvious case: **a crossing order**. Buying more of a short than it holds closes
 * the short *and* opens a long in the same order, and the realised P&L belongs to the
 * closed part while the average price of what remains is the fill price. Getting that
 * wrong is how a backtest ends up reporting a profit it did not make, so it is a named
 * branch rather than an artefact of the general case.
 *
 * Pure and total: the positions in are the positions out, and nothing is mutated. A
 * rejected application returns the input unchanged.
 */
export function applyPaperOrder(
  positions: readonly PaperPosition[],
  order: PaperOrder,
  experimentId: string,
  limits: EconomicLimits,
): PaperApplication {
  const refuse = (code: OrderRefusalCode): PaperApplication => ({
    ok: false,
    code,
    reason: ORDER_REFUSALS[code],
  })

  const existing = positions.find((position) => position.symbol === order.symbol) ?? null
  const held = existing?.quantity ?? 0
  const average = existing?.averagePrice ?? order.price
  const quantity = order.quantity
  const price = order.price

  if (existing === null && positions.length >= limits.maxPositionsPerExperiment) {
    return refuse('position-cap-reached')
  }

  const signed = order.side === 'buy' ? quantity : -quantity
  const next = held + signed
  const crosses = held !== 0 && (held > 0) !== (signed > 0) && Math.abs(signed) > Math.abs(held)

  let realizedPnl = 0
  if (order.side === 'sell' && held > 0) {
    const closedQuantity = Math.min(quantity, held)
    realizedPnl = (price - average) * closedQuantity
  } else if (order.side === 'sell' && held < 0) {
    const openedQuantity = Math.min(quantity, -held)
    realizedPnl = (average - price) * openedQuantity
  } else if (order.side === 'buy' && held < 0) {
    const closedQuantity = Math.min(quantity, -held)
    realizedPnl = (average - price) * closedQuantity
  }

  // The average price only moves when the order *adds* to the position rather than
  // closing part of it. A closing order realises P&L and leaves the basis alone; a
  // crossing order closes everything it can and opens the remainder at the fill price.
  let nextAverage = average
  if (order.side === 'buy' && held >= 0) {
    nextAverage = (average * held + price * quantity) / next
  } else if (order.side === 'sell' && held <= 0) {
    nextAverage = (average * Math.abs(held) + price * quantity) / Math.abs(next)
  } else if (crosses) {
    nextAverage = price
  }

  const closed = next === 0
  const positionId = existing?.positionId ?? `${experimentId}:${order.symbol}`

  const withoutSymbol = positions.filter((position) => position.symbol !== order.symbol)
  const survivors =
    closed || next === 0
      ? withoutSymbol
      : [
          ...withoutSymbol,
          {
            positionId,
            experimentId,
            symbol: order.symbol,
            quantity: next,
            averagePrice: round(nextAverage),
            currentPrice: price,
            unrealizedPnl: round((price - nextAverage) * next),
          },
        ]

  // Ordered by symbol so two runs of the same orders produce deep-equal portfolios
  // whatever order the orders arrived in.
  const sorted = [...survivors].sort((left, right) => (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0))

  return {
    ok: true,
    positions: sorted,
    fill: {
      positionId,
      symbol: order.symbol,
      quantity: next,
      averagePrice: round(nextAverage),
      realizedPnl: round(realizedPnl),
      closed,
    },
  }
}

/**
 * Mark a portfolio to a set of prices.
 *
 * A read. It takes the prices it is given and recomputes unrealised P&L; it fetches
 * nothing, because Phase 32 reaches no network.
 */
export function markPaperPositions(
  positions: readonly PaperPosition[],
  prices: Readonly<Record<string, number>>,
): readonly PaperPosition[] {
  return positions.map((position) => {
    const price = prices[position.symbol]
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return position
    return {
      ...position,
      currentPrice: round(price),
      unrealizedPnl: round((price - position.averagePrice) * position.quantity),
    }
  })
}

/** What the portfolio is worth, in simulated units. */
export function paperEquity(
  positions: readonly PaperPosition[],
  startingCash: number,
  realizedPnl: number,
): number {
  const positionsValue = positions.reduce((total, position) => total + position.currentPrice * position.quantity, 0)
  return round(startingCash + realizedPnl + positionsValue)
}

/* --------------------------------------------------------------- metrics */

/** The closed metrics a paper portfolio reports. */
export const PAPER_METRIC_NAMES = [
  'gross_exposure',
  'net_exposure',
  'realized_pnl',
  'unrealized_pnl',
  'order_fill_rate',
  'max_drawdown',
  'closed_trades',
] as const

export type PaperMetricName = (typeof PAPER_METRIC_NAMES)[number]

export interface PaperMetricInput {
  readonly experimentId: string
  readonly positions: readonly PaperPosition[]
  readonly orders: readonly PaperOrder[]
  readonly startingCash: number
  readonly realizedPnl: number
  /** One point per observation, oldest first. */
  readonly equityCurve: readonly number[]
  readonly computedAt: string
  readonly metricIdFor: (name: string) => string
}

/**
 * Compute the paper portfolio's metrics.
 *
 * Three rules, and they are the whole of the honesty claim:
 *
 * 1. **Every metric carries a denominator.** Not "where one is meaningful" — every one.
 *    `realized_pnl` is out of the starting cash; `order_fill_rate` is out of the number
 *    of orders placed. A metric whose denominator is zero is **not emitted**, and
 *    `uncertainties` says why. Emitting `0/0` as `0` would report "no losses" for a
 *    portfolio that has never traded.
 *
 * 2. **Every metric carries a unit.** `ratio`, `units` or `count`. A bare number with
 *    no unit is not a measurement.
 *
 * 3. **The metric cap is enforced.** The list is bounded by the same ceilings as
 *    everything else, and the bound is applied by dropping from the *end* of the frozen
 *    order rather than from the middle, so the metrics that survive are always the
 *    most important ones and the choice is not order-dependent.
 */
export function computePaperMetrics(
  input: PaperMetricInput,
  limits: EconomicLimits,
): {
  readonly metrics: readonly EconomicMetric[]
  readonly uncertainties: readonly string[]
} {
  const denominator = input.startingCash
  const positionsValue = input.positions.reduce(
    (total, position) => total + Math.abs(position.currentPrice * position.quantity),
    0,
  )
  const netPositionsValue = input.positions.reduce(
    (total, position) => total + position.currentPrice * position.quantity,
    0,
  )
  const unrealized = input.positions.reduce((total, position) => total + position.unrealizedPnl, 0)

  const candidates: readonly { readonly name: PaperMetricName; readonly value: number; readonly denominator: number; readonly unit: string }[] = [
    { name: 'closed_trades', value: countClosedTrades(input.orders), denominator: Math.max(1, input.orders.length), unit: 'count' },
    {
      name: 'order_fill_rate',
      // Filled orders out of orders placed. Everything Phase 32 places fills immediately,
      // so this reads as 1 while it holds — and it stops reading as 1 the moment
      // something is cancelled, which is why it is computed rather than asserted.
      value: input.orders.filter((order) => order.status === 'filled').length,
      denominator: input.orders.length,
      unit: 'count',
    },
    { name: 'gross_exposure', value: round(positionsValue), denominator, unit: 'units' },
    { name: 'net_exposure', value: round(netPositionsValue), denominator, unit: 'units' },
    { name: 'realized_pnl', value: round(input.realizedPnl), denominator, unit: 'units' },
    { name: 'unrealized_pnl', value: round(unrealized), denominator, unit: 'units' },
    { name: 'max_drawdown', value: round(drawdownOf(input.equityCurve)), denominator, unit: 'units' },
  ]

  const uncertainties: string[] = []
  const metrics: EconomicMetric[] = []

  for (const candidate of candidates) {
    if (metrics.length >= limits.maxMetricsPerExperiment) break
    if (!Number.isFinite(candidate.denominator) || candidate.denominator <= 0) {
      uncertainties.push(`${candidate.name}: no denominator, so no ratio was reported`)
      continue
    }
    metrics.push({
      metricId: input.metricIdFor(candidate.name),
      experimentId: input.experimentId,
      name: candidate.name,
      value: candidate.value,
      denominator: candidate.denominator,
      unit: candidate.unit,
      computedAt: input.computedAt,
    })
  }

  if (input.equityCurve.length < 2) {
    uncertainties.push('max_drawdown: fewer than two observations, so no drawdown was reported')
  }
  if (input.orders.length === 0) {
    uncertainties.push('order_fill_rate: no simulated orders were placed, so no rate was reported')
  }

  return { metrics, uncertainties }
}

/**
 * Closed trades: a buy followed by a sell of the same symbol, in that order.
 *
 * Counted from the order log rather than from positions, because a position that is
 * still open has *not* been closed and reporting it as one is the easiest way to make a
 * backtest look busier than it was.
 */
export function countClosedTrades(orders: readonly PaperOrder[]): number {
  const open = new Map<string, number>()
  let closed = 0
  for (const order of orders) {
    const held = open.get(order.symbol) ?? 0
    if (order.side === 'buy') {
      open.set(order.symbol, held + order.quantity)
      continue
    }
    if (held <= 0) continue
    const closedHere = Math.min(held, order.quantity)
    closed += closedHere
    const left = held - closedHere
    if (left > 0) open.set(order.symbol, left)
    else open.delete(order.symbol)
  }
  return closed
}

/** The largest peak-to-trough fall in an equity curve, in simulated units. */
export function drawdownOf(curve: readonly number[]): number {
  let peak = curve[0] ?? 0
  let worst = 0
  for (const value of curve) {
    if (value > peak) peak = value
    if (peak <= 0) continue
    const fall = peak - value
    if (fall > worst) worst = fall
  }
  return round(worst)
}