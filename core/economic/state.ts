import { defaultRetryCeiling, narrowRetryCeiling, type EconomicRetryCeiling } from './deadlines'
import { refreshEvidence } from './evidence'
import { transition } from './machine'
import { applyPaperOrder } from './paper'
import { round } from './simulation'
import {
  CRITERION_PATTERN,
  CRITERION_SEPARATOR,
  ECONOMIC_EVENT_TYPES,
  ECONOMIC_EVENT_TYPE_SET,
  ECONOMIC_PAYLOAD_KEYS,
  ECONOMIC_LIMITS,
  FORBIDDEN_ECONOMIC_PAYLOAD_KEYS,
  LATCHED_ECONOMIC_STOP_CODE,
  isClearableEconomicStopCode,
  isEconomicExperimentKind,
  isEconomicExperimentState,
  isEconomicReconciliationCode,
  isEconomicSignal,
  isEconomicRefusalCode,
  isEconomicRefusalSubject,
  isEconomicStage,
  isEvidenceState,
  type EconomicEventType,
  type EconomicExperiment,
  type EconomicExperimentState,
  type EconomicLimits,
  type EconomicMetric,
  type EconomicRefusal,
  type EconomicStage,
  type EconomicWake,
  type PaperOrder,
  type PaperPosition,
  type ResearchEvidence,
  type SimulationMetric,
  type SimulationScenario,
} from './types'

/**
 * The event-sourced fold.
 *
 * Everything the economic subsystem knows about itself is derived from its journal, by
 * this file, and from nothing else. There is no field here that is not computed, which
 * is what "no hidden durable state" means in practice: kill the process, replay the same
 * events, get the same state.
 *
 * The fold is deliberately untrusting of its own input, and there are three ways it
 * says so that are worth reading:
 *
 *   1. **The stage comes from the machine, never from the payload.** An entry names the
 *      *signal*; the fold asks `transition()` where that signal goes from where the
 *      experiment actually is. A journal that claims an experiment went from `RESEARCHING`
 *      to `PAPER_TRADING` on `paper-complete` is refused as tampering rather than
 *      believed, because `paper-complete` is not a signal `RESEARCHING` has an edge for.
 *   2. **`from` is checked against what is recorded.** A stale or forged `from` is an
 *      anomaly, so the journal cannot rewind a stage by claiming it used to be somewhere
 *      else.
 *   3. **Forbidden keys are named, and the real-money half separately.** A payload
 *      carrying `venue` is reported under `real-money-payload-key` rather than lumped in
 *      with an authority escalation, because they are different failures and the release
 *      gate reads them differently.
 */

/** The shape this module needs from a journal entry. Anything wider is ignored. */
export interface EconomicJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

export type EconomicFoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'real-money-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'terminal-stage-re-entered'
  | 'unknown-experiment'
  | 'self-approval'
  | 'cap-reached'
  | 'stage-disagreement'

export interface EconomicFoldAnomaly {
  readonly code: EconomicFoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

/** An experiment that was mid-step when a process ended. Visible, never silently resumed. */
export interface EconomicInterruption {
  readonly experimentId: string
  readonly stage: EconomicStage
  readonly at: string
  readonly code: 'restart-recovery' | 'owner-preempted'
}

export interface EconomicExperimentRecord extends EconomicExperiment {
  readonly stage: EconomicStage
}

export interface EconomicState {
  readonly experiments: readonly EconomicExperimentRecord[]
  readonly evidence: readonly ResearchEvidence[]
  readonly scenarios: readonly SimulationScenario[]
  readonly orders: readonly PaperOrder[]
  readonly positions: readonly PaperPosition[]
  readonly metrics: readonly EconomicMetric[]
  /**
   * Realised P&L per experiment, in simulated units.
   *
   * Accumulated from `economic.paper-order.filled` rather than held on a position,
   * because a realised gain belongs to the *trade* and a closed position takes its
   * history with it. Deriving it from the fold rather than tracking it in memory is what
   * makes it survive a restart, and a backtest whose realised P&L resets on every launch
   * is not a backtest.
   */
  readonly realizedPnl: Readonly<Record<string, number>>
  readonly refusals: readonly EconomicRefusal[]
  /** Interrupted experiments, visible to the owner until something explicitly moves them. */
  readonly interrupted: readonly EconomicInterruption[]
  readonly processedWakeKeys: readonly string[]
  readonly currentWake: EconomicWake | null
  /** How many bounded economic steps this wake has taken. Bounded per wake. */
  readonly stepCount: number
  readonly stopAllLatched: boolean
  readonly stopCode: string | null
  /**
   * Failed attempts at the step in hand, this experiment.
   *
   * Journaled rather than held, for the reason Phase 23 gives: a retry ceiling that
   * resets on restart is not a ceiling.
   */
  readonly attemptCount: number
  /** The experiment the attempt count belongs to. */
  readonly unitRef: string | null
  readonly lastRefusalCode: string | null
  readonly lastRefusalAt: string | null
  readonly lastReason: string | null
}

export interface EconomicFoldResult {
  readonly state: EconomicState
  readonly anomalies: readonly EconomicFoldAnomaly[]
}

/**
 * Facts the single-entry fold cannot see for itself.
 *
 * `ownerClearedStop` decides whether a stop may be lifted, and defaulting it to `false`
 * is the direction that fails closed: a caller who knows nothing about the latch cannot
 * lift one.
 */
export interface EconomicFoldContext {
  readonly ownerClearedStop: boolean
}

export const FOLD_CONTEXT_CLOSED: EconomicFoldContext = Object.freeze({ ownerClearedStop: false })

/** How many refusal records the fold keeps. A bound, like everything else here. */
const MAX_RETAINED_REFUSALS = 256

/**
 * The anomalies that make an entry *unusable* rather than merely suspicious.
 *
 * A payload carrying a capability, a verdict, a grant, a venue, a broker or an approval
 * is not a field that was added by mistake: it is someone trying to write authority into
 * the record. The whole entry is refused for those, and refused silently as to state —
 * the anomaly is the trace.
 */
const BLOCKING_ANOMALY_CODES: ReadonlySet<EconomicFoldAnomalyCode> = new Set([
  'forbidden-payload-key',
  'real-money-payload-key',
  'self-approval',
])

/** How many dedupe keys are retained. */
const MAX_PROCESSED_WAKE_KEYS = 256


export function initialEconomicState(): EconomicState {
  return {
    experiments: [],
    evidence: [],
    scenarios: [],
    orders: [],
    positions: [],
    metrics: [],
    realizedPnl: {},
    refusals: [],
    interrupted: [],
    processedWakeKeys: [],
    currentWake: null,
    stepCount: 0,
    stopAllLatched: false,
    stopCode: null,
    attemptCount: 0,
    unitRef: null,
    lastRefusalCode: null,
    lastRefusalAt: null,
    lastReason: null,
  }
}

/* -------------------------------------------------------------- readers */

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readInteger(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.floor(value)
  return rounded < 0 ? null : rounded
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Rebuild the current wake from a flat `economic.wake.received` payload. */
function readFlatWake(payload: Record<string, unknown>): EconomicWake | null {
  const source = payload.source
  const kind = payload.kind
  const wakeId = payload.wakeId
  const occurredAt = payload.occurredAt
  const observedAt = payload.observedAt
  if (
    typeof source !== 'string' ||
    typeof kind !== 'string' ||
    typeof wakeId !== 'string' ||
    wakeId.length === 0 ||
    typeof occurredAt !== 'string' ||
    typeof observedAt !== 'string'
  ) {
    return null
  }
  return {
    wakeId,
    source: source as EconomicWake['source'],
    kind: kind as EconomicWake['kind'],
    experimentId: typeof payload.experimentId === 'string' ? payload.experimentId : null,
    goalRef: typeof payload.goalRef === 'string' ? payload.goalRef : null,
    sourceRef: typeof payload.sourceRef === 'string' ? payload.sourceRef : null,
    occurredAt,
    observedAt,
  }
}

/**
 * The closed reasons a payload key may be rejected for.
 *
 * The forbidden set is split in two on the way out, because "this payload named a
 * broker" and "this payload named a capability" are different failures and an owner
 * reading the gate's output needs to be able to tell them apart at a glance.
 */
function inspectPayload(
  type: EconomicEventType,
  payload: Record<string, unknown>,
  limits: EconomicLimits,
): EconomicFoldAnomaly[] {
  const anomalies: EconomicFoldAnomaly[] = []
  const allowed = ECONOMIC_PAYLOAD_KEYS[type]

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_ECONOMIC_PAYLOAD_KEYS.has(key)) {
      const realMoney = REAL_MONEY_KEYS.has(key)
      anomalies.push({
        code: realMoney ? 'real-money-payload-key' : 'forbidden-payload-key',
        eventType: type,
        detail: realMoney
          ? `${type} carried "${key}", which names somewhere a real order could be placed. There is nowhere.`
          : `${type} carried "${key}", which is an authority shape no economic event may hold.`,
      })
      continue
    }
    if (!allowed.includes(key)) {
      anomalies.push({
        code: 'unknown-payload-key',
        eventType: type,
        detail: `${type} carried "${key}", which is not in its closed payload vocabulary`,
      })
    }
  }

  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.length > limits.maxPayloadTextLength) {
      anomalies.push({
        code: 'oversized-payload-text',
        eventType: type,
        detail: `${type} carried a ${value.length}-character string, over the ${limits.maxPayloadTextLength}-character ceiling`,
      })
    }
  }

  return anomalies
}

/** The forbidden keys that are about money rather than about authority. */
const REAL_MONEY_KEYS: ReadonlySet<string> = new Set([
  'venue',
  'broker',
  'brokerage',
  'exchange',
  'account',
  'accountId',
  'wallet',
  'custodian',
  'capital',
  'notional',
  'currencyPair',
  'withdrawal',
  'deposit',
  'live',
  'realMoney',
  'realOrder',
])

function withState(state: EconomicState, patch: Partial<EconomicState>): EconomicState {
  return { ...state, ...patch }
}

function ring<T>(items: readonly T[], limit: number): readonly T[] {
  return items.length > limit ? items.slice(items.length - limit) : items
}

function findExperiment(
  state: EconomicState,
  experimentId: string,
): EconomicExperimentRecord | undefined {
  return state.experiments.find((entry) => entry.experimentId === experimentId)
}

/**
 * Split the joined criteria back out of a journal payload.
 *
 * Drops anything that is not a criterion rather than refusing the entry: the *admission*
 * of a criterion happens at `defineExperiment`, where a caller can be told, and by the
 * time it is in the journal the only remaining question is what to reconstruct. Dropping
 * an unrecognised piece here is bounded and total, where throwing inside a fold would
 * take the whole replay with it.
 */
function splitCriteria(joined: string | null): readonly string[] {
  if (joined === null || joined.length === 0) return []
  return joined
    .split(CRITERION_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => CRITERION_PATTERN.test(entry))
}

function replaceExperiment(
  experiments: readonly EconomicExperimentRecord[],
  next: EconomicExperimentRecord,
): readonly EconomicExperimentRecord[] {
  return experiments.map((entry) => (entry.experimentId === next.experimentId ? next : entry))
}

/* ---------------------------------------------------------------- apply */

/**
 * Apply one journal entry.
 *
 * Never repairs and never guesses. Where an entry would move a stage the machine does
 * not permit, says the wrong thing about where it came from, names an experiment that
 * does not exist, or carries a key the vocabulary does not contain, the state is left
 * alone and an anomaly is recorded. A tampered journal therefore produces a *visible*
 * wrong answer, never a quietly plausible one.
 */
export function reduceEconomicEntry(
  state: EconomicState,
  entry: EconomicJournalEntry,
  context: EconomicFoldContext = FOLD_CONTEXT_CLOSED,
  limits: EconomicLimits = ECONOMIC_LIMITS,
): EconomicFoldResult {
  if (!entry.type.startsWith('economic.')) return { state, anomalies: [] }
  if (!ECONOMIC_EVENT_TYPE_SET.has(entry.type)) {
    return {
      state,
      anomalies: [
        {
          code: 'unknown-event-type',
          eventType: entry.type,
          detail: `${entry.type} is not one of the ${ECONOMIC_EVENT_TYPES.length} economic event types`,
        },
      ],
    }
  }

  const type = entry.type as EconomicEventType
  const raw = entry.payload
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      state,
      anomalies: [
        { code: 'malformed-payload', eventType: type, detail: `${type} carried no object payload` },
      ],
    }
  }
  const payload = raw as Record<string, unknown>
  const anomalies = inspectPayload(type, payload, limits)
  const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : null

  // An entry carrying an authority shape, a real-money shape or an approval is refused
  // **whole**, rather than recorded as an anomaly and then applied anyway.
  //
  // This is the difference between a journal that is auditable and one that is merely
  // noisy. An anomaly nobody acts on is a comment; a forged payload carrying
  // `venue: 'live'` would otherwise still place a paper order into the fold, and the
  // anomaly would sit beside it in the log looking like a warning rather than a refusal.
  // Unknown and oversized keys are *not* blocking: those are mistakes rather than
  // escalations, and refusing a whole entry over a stray field would lose real work.
  if (anomalies.some((anomaly) => BLOCKING_ANOMALY_CODES.has(anomaly.code))) {
    return { state, anomalies }
  }

  switch (type) {
    case 'economic.experiment.created': {
      const experimentId = readString(payload, 'experimentId')
      const kind = payload.kind
      const title = readString(payload, 'title')
      const question = readString(payload, 'question')
      if (
        experimentId === null ||
        !isEconomicExperimentKind(kind) ||
        title === null ||
        title.length > limits.maxTitleLength ||
        question === null ||
        question.length > limits.maxQuestionLength
      ) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe an experiment`)
      }
      if (findExperiment(state, experimentId) !== undefined) {
        return refuse(
          state,
          type,
          anomalies,
          'illegal-transition',
          `${type} named experiment "${experimentId}", which already exists`,
        )
      }
      if (state.experiments.length >= limits.maxExperiments) {
        return refuse(state, type, anomalies, 'cap-reached', `there are already ${limits.maxExperiments} experiments`)
      }
      // The completion criteria travel as one bounded, joined string of slugs rather than
      // as a nested array. Two reasons, and both are about the journal rather than about
      // tidiness: a durable payload is scalars, and a nested array would be the first
      // open-ended structure in a file whose whole value is that it cannot hold one. The
      // count is recorded alongside so a reader can tell a truncated list from a
      // complete one.
      const criteria = splitCriteria(readString(payload, 'criteria'))
      if (criteria.length > limits.maxCompletionCriteria) {
        return refuse(
          state,
          type,
          anomalies,
          'cap-reached',
          `${type} named ${criteria.length} completion criteria, over the ${limits.maxCompletionCriteria} ceiling`,
        )
      }
      const created = readString(payload, 'createdAt') ?? recordedAt ?? ''
      return {
        state: withState(state, {
          experiments: [
            ...state.experiments,
            {
              experimentId,
              kind,
              // `draft`, and stage `IDLE`: an experiment exists but nothing has been done
              // to it. The move into its first real stage is a machine transition on
              // `experiment-opened`, which is where the kind is consulted.
              state: 'draft',
              stage: 'IDLE',
              title,
              question,
              completionCriteria: criteria,
              progress: 0,
              deadlineAt: typeof payload.deadlineAt === 'string' ? payload.deadlineAt : null,
              createdAt: created,
              updatedAt: created,
              completedAt: null,
            },
          ],
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.experiment.state-changed':
    case 'economic.experiment.completed':
    case 'economic.experiment.failed':
    case 'economic.experiment.cancelled': {
      return applyStageChange(type, payload, recordedAt, state, anomalies)
    }

    case 'economic.evidence.gathered': {
      const experimentId = readString(payload, 'experimentId')
      const evidenceId = readString(payload, 'evidenceId')
      const claim = readString(payload, 'claim')
      const source = payload.source
      const sourceRef = readString(payload, 'sourceRef')
      const citation = readString(payload, 'citation')
      const observedAt = readString(payload, 'observedAt')
      if (
        experimentId === null ||
        evidenceId === null ||
        claim === null ||
        sourceRef === null ||
        citation === null ||
        observedAt === null ||
        typeof source !== 'string'
      ) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe an observation`)
      }
      if (findExperiment(state, experimentId) === undefined) {
        return refuse(state, type, anomalies, 'unknown-experiment', `${type} named an experiment that does not exist`)
      }
      if (state.evidence.some((entry) => entry.evidenceId === evidenceId)) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} repeated evidence "${evidenceId}"`)
      }
      const forExperiment = state.evidence.filter((entry) => entry.experimentId === experimentId)
      if (forExperiment.length >= limits.maxEvidencePerExperiment) {
        return refuse(
          state,
          type,
          anomalies,
          'cap-reached',
          `experiment "${experimentId}" already holds ${limits.maxEvidencePerExperiment} pieces of evidence`,
        )
      }
      const stateName = payload.state
      const confidence = payload.confidence
      return {
        state: withState(state, {
          evidence: [
            ...state.evidence,
            {
              evidenceId,
              experimentId,
              source: source as ResearchEvidence['source'],
              sourceRef,
              citation,
              claim,
              observedAt,
              state: isEvidenceState(stateName) ? stateName : 'fresh',
              confidence:
                confidence === 'high' || confidence === 'medium' || confidence === 'low' || confidence === 'unknown'
                  ? confidence
                  : 'unknown',
            },
          ],
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.simulation.started': {
      const scenarioId = readString(payload, 'scenarioId')
      const experimentId = readString(payload, 'experimentId')
      const strategy = readString(payload, 'strategy')
      if (scenarioId === null || experimentId === null || strategy === null) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe a scenario`)
      }
      if (findExperiment(state, experimentId) === undefined) {
        return refuse(state, type, anomalies, 'unknown-experiment', `${type} named an experiment that does not exist`)
      }
      if (state.scenarios.some((entry) => entry.scenarioId === scenarioId)) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} repeated scenario "${scenarioId}"`)
      }
      return {
        state: withState(state, {
          scenarios: [
            ...state.scenarios,
            {
              scenarioId,
              experimentId,
              name: scenarioId,
              strategy: strategy as SimulationScenario['strategy'],
              parameters: {},
              assumptions: [],
              status: 'running',
              result: null,
            },
          ],
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.simulation.completed': {
      const scenarioId = readString(payload, 'scenarioId')
      const experimentId = readString(payload, 'experimentId')
      const resultId = readString(payload, 'resultId')
      const strategy = readString(payload, 'strategy')
      const completedAt = readString(payload, 'completedAt')
      if (scenarioId === null || experimentId === null || resultId === null || completedAt === null) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe a result`)
      }
      const index = state.scenarios.findIndex((entry) => entry.scenarioId === scenarioId)
      const existing = index >= 0 ? state.scenarios[index] : undefined
      if (existing === undefined) {
        return refuse(state, type, anomalies, 'unknown-experiment', `${type} named a scenario that was never started`)
      }
      const failed = payload.failed === true
      // The metrics of a run are **not** in this payload, and that is a deliberate
      // omission rather than an oversight. A metric carries a name, a value, a
      // denominator and a unit — four bounded strings and two numbers — and letting an
      // event carry them would make the journal the place a simulation's numbers live,
      // which is a schema the reader would then have to trust. Results are recomputed
      // from the series on demand; the journal records that a run happened and what it
      // was over.
      const scenarios = [...state.scenarios]
      scenarios[index] = {
        ...existing,
        status: failed ? 'failed' : 'completed',
        result: failed
          ? null
          : {
              resultId,
              scenarioId,
              experimentId,
              strategy: (strategy ?? existing.strategy) as SimulationScenario['strategy'],
              metrics: [],
              observations: readInteger(payload, 'observationCount') ?? 0,
              startedAt: readString(payload, 'startedAt') ?? completedAt,
              completedAt,
            },
      }
      return { state: withState(state, { scenarios, lastReason: type }), anomalies }
    }

    case 'economic.paper-order.placed': {
      const orderId = readString(payload, 'orderId')
      const experimentId = readString(payload, 'experimentId')
      const symbol = readString(payload, 'symbol')
      const side = readString(payload, 'side')
      const quantity = readNumber(payload, 'quantity')
      const price = readNumber(payload, 'price')
      const placedAt = readString(payload, 'placedAt')
      if (
        orderId === null ||
        experimentId === null ||
        symbol === null ||
        side === null ||
        quantity === null ||
        price === null ||
        placedAt === null
      ) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe a simulated order`)
      }
      if (findExperiment(state, experimentId) === undefined) {
        return refuse(state, type, anomalies, 'unknown-experiment', `${type} named an experiment that does not exist`)
      }
      if (state.orders.some((entry) => entry.orderId === orderId)) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} repeated order "${orderId}"`)
      }
      const forExperiment = state.orders.filter((entry) => entry.experimentId === experimentId)
      if (forExperiment.length >= limits.maxPaperOrdersPerExperiment) {
        return refuse(
          state,
          type,
          anomalies,
          'cap-reached',
          `experiment "${experimentId}" already placed ${limits.maxPaperOrdersPerExperiment} simulated orders`,
        )
      }
      const order: PaperOrder = {
        orderId,
        experimentId,
        symbol,
        side: side as PaperOrder['side'],
        quantity,
        price,
        placedAt,
        status: 'filled',
        reasoning: [],
      }
      return { state: withState(state, { orders: [...state.orders, order], lastReason: type }), anomalies }
    }

    case 'economic.paper-order.filled': {
      const orderId = readString(payload, 'orderId')
      const experimentId = readString(payload, 'experimentId')
      if (orderId === null || experimentId === null) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe a fill`)
      }
      const order = state.orders.find((entry) => entry.orderId === orderId)
      if (order === undefined) {
        return refuse(state, type, anomalies, 'unknown-experiment', `${type} named an order that was never placed`)
      }
      const positions = state.positions.filter((entry) => entry.experimentId === experimentId)
      const applied = applyPaperOrder(positions, order, experimentId, limits)
      if (!applied.ok) {
        return refuse(state, type, anomalies, 'cap-reached', `${type} could not be applied: ${applied.reason}`)
      }
      const others = state.positions.filter((entry) => entry.experimentId !== experimentId)
      const declared = readNumber(payload, 'realizedPnl') ?? 0
      // The fold **recomputes** the fill rather than trusting the declared figure, and
      // the declared one is only used when the recomputation agrees to the last unit of
      // rounding. A journal that claims a different P&L than the arithmetic supports is
      // evidence of tampering, and the arithmetic wins.
      const realised = applied.fill.realizedPnl
      const extra: EconomicFoldAnomaly[] =
        Math.abs(declared - realised) > 1e-9
          ? [
              {
                code: 'stage-disagreement',
                eventType: type,
                detail: `${type} claimed realised P&L of ${declared}, but the position arithmetic gives ${realised}`,
              },
            ]
          : []
      return {
        state: withState(state, {
          positions: [...others, ...applied.positions],
          realizedPnl: {
            ...state.realizedPnl,
            [experimentId]: round((state.realizedPnl[experimentId] ?? 0) + realised),
          },
          lastReason: type,
        }),
        anomalies: [...anomalies, ...extra],
      }
    }

    case 'economic.metric.computed': {
      const metricId = readString(payload, 'metricId')
      const experimentId = readString(payload, 'experimentId')
      const name = readString(payload, 'name')
      const value = readNumber(payload, 'value')
      const denominator = readNumber(payload, 'denominator')
      const unit = readString(payload, 'unit')
      const computedAt = readString(payload, 'computedAt')
      if (
        metricId === null ||
        experimentId === null ||
        name === null ||
        value === null ||
        denominator === null ||
        unit === null ||
        computedAt === null
      ) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe a metric`)
      }
      if (findExperiment(state, experimentId) === undefined) {
        return refuse(state, type, anomalies, 'unknown-experiment', `${type} named an experiment that does not exist`)
      }
      const forExperiment = state.metrics.filter((entry) => entry.experimentId === experimentId)
      if (forExperiment.length >= limits.maxMetricsPerExperiment) {
        return refuse(
          state,
          type,
          anomalies,
          'cap-reached',
          `experiment "${experimentId}" already holds ${limits.maxMetricsPerExperiment} metrics`,
        )
      }
      return {
        state: withState(state, {
          metrics: [
            ...state.metrics,
            { metricId, experimentId, name, value, denominator, unit, computedAt },
          ],
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.continuation.decided': {
      // Bookkeeping. The decision is *about* the next move, and the move itself is
      // journaled by the event for it — so recording the decision keeps "what was
      // concluded" legible even if the process died between deciding and moving.
      const experimentId = readString(payload, 'experimentId')
      const unit = experimentId === null ? state.unitRef : experimentId
      return {
        state: withState(state, {
          unitRef: unit,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.gate.decided': {
      // The most important entry in this family for auditability and the least
      // important for state: it records which gates cleared and which one refused,
      // so a reader can see "three cleared, then the budget ran out" rather than a bare
      // denial. Nothing about the gate can change the state — a gate that could refuse
      // *and* move the experiment would be a second authority path.
      return { state: withState(state, { lastReason: type }), anomalies }
    }

    case 'economic.refusal.recorded': {
      const refusalId = readString(payload, 'refusalId')
      const code = payload.code
      const subject = payload.subject
      const at = readString(payload, 'at') ?? recordedAt ?? ''
      if (refusalId === null || !isEconomicRefusalCode(code) || !isEconomicRefusalSubject(subject)) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} did not carry a closed refusal code`)
      }
      const extra: EconomicFoldAnomaly[] = []
      // An approval claim that *arrives* on a refusal record is worth naming on its
      // own, because "the subsystem tried to approve itself" is a different failure
      // from "the subsystem recorded a refusal" even though both are refusals.
      if (code === 'self-approval-prohibited' && payload.approved === true) {
        extra.push({
          code: 'self-approval',
          eventType: type,
          detail: `${type} recorded a self-approval refusal while also claiming an approval`,
        })
      }
      const refusal: EconomicRefusal = {
        refusalId,
        code,
        subject,
        experimentId: readString(payload, 'experimentId'),
        wakeId: readString(payload, 'wakeId'),
        at,
      }
      return {
        state: withState(state, {
          refusals: ring([...state.refusals, refusal], MAX_RETAINED_REFUSALS),
          lastRefusalCode: code,
          lastRefusalAt: at,
          lastReason: type,
        }),
        anomalies: [...anomalies, ...extra],
      }
    }

    case 'economic.wake.received': {
      const wake = readFlatWake(payload)
      const wakeKey = readString(payload, 'wakeKey')
      if (wake === null || wakeKey === null) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} could not describe a wake`)
      }
      const sameUnit = wake.experimentId !== null && wake.experimentId === state.unitRef
      return {
        state: withState(state, {
          currentWake: wake,
          // Per-wake counters start again. The attempt counter is the exception, for
          // the same reason as everywhere else in this codebase: a retry budget belongs
          // to the unit of work and not to the wake that noticed it.
          stepCount: 0,
          processedWakeKeys: ring([...state.processedWakeKeys, wakeKey], MAX_PROCESSED_WAKE_KEYS),
          unitRef: wake.experimentId ?? state.unitRef,
          attemptCount: sameUnit ? state.attemptCount : 0,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.wake.denied': {
      // Bookkeeping, and deliberately not a move: a refused wake never entered the
      // continuation, so the subsystem is exactly where it was. The dedupe key is not
      // consumed, because a wake that was never processed may legitimately arrive again.
      const code = readString(payload, 'code')
      return {
        state: withState(state, {
          lastRefusalCode: code,
          lastRefusalAt: recordedAt,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.reconciled': {
      const code = readString(payload, 'code')
      if (code === null || !isEconomicReconciliationCode(code)) {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} carried no reconciliation code from the closed list`)
      }
      if (state.stopAllLatched) {
        return refuse(
          state,
          type,
          anomalies,
          'illegal-transition',
          `${type} arrived while STOP ALL was latched; only the owner clears that`,
        )
      }
      // A reconciliation is not a continuation step and is not in the ordinary table on
      // purpose. A process that died mid-stage cannot be resumed, because the plan was
      // in memory, so the experiment is *recorded as interrupted* rather than moved —
      // it stays where it was, it becomes visible, and only an explicit wake may move
      // it again. That is what makes "no silent continuation" checkable.
      const experimentId = readString(payload, 'experimentId')
      const atStage = payload.atStage
      const experiment = experimentId === null ? undefined : findExperiment(state, experimentId)
      if (experimentId !== null && experiment === undefined) {
        return refuse(state, type, anomalies, 'unknown-experiment', `${type} named an experiment that does not exist`)
      }
      const stage = experiment?.stage ?? (isEconomicStage(atStage) ? atStage : 'IDLE')
      if (code === 'stop-latch-cleared') {
        return { state: withState(state, { lastReason: type }), anomalies }
      }
      const interruption: EconomicInterruption = {
        experimentId: experimentId ?? '',
        stage,
        at: recordedAt ?? '',
        code,
      }
      return {
        state: withState(state, {
          interrupted: ring([...state.interrupted, interruption], MAX_PROCESSED_WAKE_KEYS),
          currentWake: null,
          stepCount: 0,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.stopped': {
      // STOP ALL reaches every state, so this does not consult the machine at all. It is
      // the one event that can override terminality, and it can only ever *set* the
      // latch.
      //
      // Re-asserting a latched stop is an anomaly — somebody reached for the panic
      // button twice. But one re-assertion of a *clearable* stop is legitimate: a
      // subsystem that had closed out cleanly sits latched with a clearable code, and
      // the owner pressing STOP ALL in the same turn must leave a latch behind. The
      // upgrade is strictly one-directional, so accepting it cannot release anything.
      const code = readString(payload, 'code') ?? LATCHED_ECONOMIC_STOP_CODE
      if (state.stopAllLatched) {
        return refuse(state, type, anomalies, 'terminal-stage-re-entered', `${type} arrived while already latched`)
      }
      const experimentId = readString(payload, 'experimentId')
      const stage = experimentId === null ? null : findExperiment(state, experimentId)?.stage ?? null
      return {
        state: withState(state, {
          stopAllLatched: true,
          stopCode: isClearableEconomicStopCode(code) ? LATCHED_ECONOMIC_STOP_CODE : code,
          interrupted: ring(
            experimentId === null || stage === null || stage === 'IDLE' || stage === 'COMPLETE' || stage === 'FAILED'
              ? state.interrupted
              : [
                  ...state.interrupted,
                  { experimentId, stage, at: recordedAt ?? '', code: 'restart-recovery' as const },
                ],
            MAX_PROCESSED_WAKE_KEYS,
          ),
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'economic.unstopped': {
      // The only lift that exists, and it needs two independent facts. The obvious one
      // is that the latch was set; the one that matters is that the **owner** cleared
      // it, evidenced by a `security.stop_all.cleared` in the record. Without the
      // second, one line written into the journal would lift the panic button and turn
      // "Freya can be stopped" into "Freya can be un-stopped by whoever can write to a
      // text file".
      const code = readString(payload, 'code')
      if (!state.stopAllLatched) {
        return refuse(state, type, anomalies, 'illegal-transition', `${type} arrived while nothing was latched`)
      }
      if (!context.ownerClearedStop) {
        return refuse(
          state,
          type,
          anomalies,
          'illegal-transition',
          `${type} arrived with no cleared stop behind it; only the owner lifts that`,
        )
      }
      if (code !== 'stop-latch-cleared') {
        return refuse(state, type, anomalies, 'malformed-payload', `${type} named a lift that is not the owner's`)
      }
      return {
        state: withState(state, {
          stopAllLatched: false,
          stopCode: null,
          lastReason: type,
        }),
        anomalies,
      }
    }

    default: {
      // Unreachable: `type` is narrowed to the closed set above.
      const exhaustive: never = type
      return {
        state,
        anomalies: [
          ...anomalies,
          { code: 'unknown-event-type', eventType: String(exhaustive), detail: 'an economic event type this fold does not handle' },
        ],
      }
    }
  }
}

/**
 * The four stage-changing events, in one place.
 *
 * They differ in which lifecycle state they land the experiment in and in which signal
 * they carry, and nothing else — so they share the code that actually matters: the stage
 * is recomputed by the machine from where the experiment *is*, and the payload's own
 * claims about `from` and `to` are checked against it rather than believed.
 */
function applyStageChange(
  type: EconomicEventType,
  payload: Record<string, unknown>,
  recordedAt: string | null,
  state: EconomicState,
  anomalies: readonly EconomicFoldAnomaly[],
): EconomicFoldResult {
  const experimentId = readString(payload, 'experimentId')
  const signal = readString(payload, 'signal')
  if (experimentId === null) {
    return refuse(state, type, anomalies, 'malformed-payload', `${type} named no experiment`)
  }
  const experiment = findExperiment(state, experimentId)
  if (experiment === undefined) {
    return refuse(state, type, anomalies, 'unknown-experiment', `${type} named an experiment that does not exist`)
  }

  const declaredFrom = readString(payload, 'from')
  if (declaredFrom !== null && declaredFrom !== experiment.stage) {
    return refuse(
      state,
      type,
      anomalies,
      'stage-disagreement',
      `${type} said the experiment was in ${declaredFrom}, but the journal has it in ${experiment.stage}`,
    )
  }

  // A signal read out of a payload is only honoured if it is in the closed list. Anything
  // else is a malformed record, refused here rather than cast into the machine — which is
  // the one place a journal could otherwise have invented a signal of its own.
  const effectiveSignal = signal ?? defaultSignalFor(type)
  if (effectiveSignal === null || !isEconomicSignal(effectiveSignal)) {
    return refuse(
      state,
      type,
      anomalies,
      'malformed-payload',
      `${type} named "${String(effectiveSignal)}", which is not a signal the economic state machine understands`,
    )
  }
  const move = transition(experiment.stage, effectiveSignal, experiment.kind)
  if (!move.ok) {
    return refuse(
      state,
      type,
      anomalies,
      isTerminalStageFor(experiment.stage) ? 'terminal-stage-re-entered' : 'illegal-transition',
      `${type} tried to move ${experiment.stage} on "${String(effectiveSignal)}" (${move.code})`,
    )
  }

  const declaredTo = readString(payload, 'to')
  if (declaredTo !== null && declaredTo !== move.to) {
    return refuse(
      state,
      type,
      anomalies,
      'stage-disagreement',
      `${type} said the experiment would reach ${declaredTo}, but "${String(effectiveSignal)}" from ${experiment.stage} reaches ${move.to}`,
    )
  }

  const lifecycle = lifecycleStateFor(type, move.to, experiment.state)
  const progress = readNumber(payload, 'progress') ?? progressFor(move.to, experiment.progress)
  const updatedAt = readString(payload, 'updatedAt') ?? recordedAt ?? experiment.updatedAt
  const next: EconomicExperimentRecord = {
    ...experiment,
    stage: move.to,
    state: lifecycle,
    progress,
    updatedAt,
    completedAt:
      lifecycle === 'completed' || lifecycle === 'failed' || lifecycle === 'cancelled'
        ? (readString(payload, 'completedAt') ?? updatedAt)
        : experiment.completedAt,
  }

  return {
    state: withState(state, {
      experiments: replaceExperiment(state.experiments, next),
      // An explicit move is the *only* thing that clears an interruption. There is no
      // timer, no resume-on-boot and no path here that does it automatically.
      interrupted: state.interrupted.filter((entry) => entry.experimentId !== experimentId),
      // A stage that ended in failure counts the attempt, because that is what a retry
      // ceiling counts.
      attemptCount:
        lifecycle === 'failed' && move.to === 'FAILED' ? state.attemptCount + 1 : state.attemptCount,
      unitRef: experimentId,
      lastReason: type,
    }),
    anomalies,
  }
}

function defaultSignalFor(type: EconomicEventType): string | null {
  switch (type) {
    case 'economic.experiment.state-changed':
      return null
    case 'economic.experiment.completed':
      return 'analysis-complete'
    case 'economic.experiment.failed':
    case 'economic.experiment.cancelled':
      return 'experiment-failed'
    default:
      return null
  }
}

function lifecycleStateFor(
  type: EconomicEventType,
  to: EconomicStage,
  current: EconomicExperimentState,
): EconomicExperimentState {
  if (type === 'economic.experiment.cancelled') return 'cancelled'
  if (to === 'COMPLETE') return 'completed'
  if (to === 'FAILED') return 'failed'
  if (to === 'IDLE') return 'draft'
  if (current === 'failed' || current === 'completed' || current === 'cancelled') return current
  return 'active'
}

/**
 * Progress when an entry did not state one.
 *
 * Derived from the stage, and *never* taken from a claim. A stage that has been entered
 * is not progress in the sense the owner cares about, which is criteria met — but a
 * terminal stage is unambiguously finished, and everything before it keeps whatever it
 * had.
 */
function progressFor(stage: EconomicStage, current: number): number {
  if (stage === 'COMPLETE') return 1
  if (stage === 'FAILED') return current
  return current
}

function isTerminalStageFor(stage: EconomicStage): boolean {
  return stage === 'COMPLETE' || stage === 'FAILED'
}

/**
 * Refuse an entry: state unchanged, anomaly recorded.
 *
 * Taking `state` explicitly rather than closing over it is the point. A refusal path
 * that rebuilt a default state would look correct in a unit test with one entry and
 * silently discard an entire experiment history in production — and because the fold is
 * what everything else is derived from, that failure would surface as "Freya has no
 * experiments" rather than as an error anywhere.
 */
function refuse(
  state: EconomicState,
  eventType: EconomicEventType,
  anomalies: readonly EconomicFoldAnomaly[],
  code: EconomicFoldAnomalyCode,
  detail: string,
): EconomicFoldResult {
  return {
    state,
    anomalies: [...anomalies, { code, eventType, detail }],
  }
}

/**
 * Fold a journal into the subsystem's state.
 *
 * Total and deterministic: the same entries in the same order always produce the same
 * state and the same anomalies. Entries belonging to other subsystems are passed over
 * untouched, so this can be handed a whole Core journal.
 */
export function reduceEconomicState(
  entries: readonly EconomicJournalEntry[],
  limits: EconomicLimits = ECONOMIC_LIMITS,
): EconomicFoldResult {
  let state = initialEconomicState()
  const anomalies: EconomicFoldAnomaly[] = []
  // Whether the owner has cleared a stop, tracked from the *security* events rather than
  // from this subsystem's own — for the same reason Phase 23's fold does: this
  // subsystem's own latched state cannot tell a panic button from a clean close-out,
  // and treating them alike is what would let one line in the log lift a stop.
  let ownerClearedStop = false
  for (const entry of entries) {
    if (entry.type === 'security.stop_all.cleared') ownerClearedStop = true
    if (entry.type === 'security.stop_all.activated') ownerClearedStop = false
    const result = reduceEconomicEntry(state, entry, { ownerClearedStop }, limits)
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

/**
 * Fold exactly one entry onto a state already derived from the journal.
 *
 * The single-entry form of {@link reduceEconomicState}, so the runtime does not have to
 * re-read the whole log after every append. It is the same code path — the whole-journal
 * form calls it — so the live subsystem and a later replay cannot disagree about what an
 * event means.
 *
 * `context` defaults to the closed form, which cannot lift a stop: forgetting to pass
 * the latch fails closed rather than quietly granting the only transition in this module
 * an outside party would want.
 */
export function reduceEconomicEntryOnly(
  state: EconomicState,
  entry: EconomicJournalEntry,
  context: EconomicFoldContext = FOLD_CONTEXT_CLOSED,
  limits: EconomicLimits = ECONOMIC_LIMITS,
): EconomicFoldResult {
  return reduceEconomicEntry(state, entry, context, limits)
}

/**
 * Everything about one experiment, as the fold holds it.
 *
 * The single place the three per-experiment lists are joined, so the runtime and the
 * projection cannot disagree about what belongs to what.
 */
export function experimentBundle(
  state: EconomicState,
  experimentId: string,
): {
  readonly experiment: EconomicExperimentRecord | null
  readonly evidence: readonly ResearchEvidence[]
  readonly scenarios: readonly SimulationScenario[]
  readonly orders: readonly PaperOrder[]
  readonly positions: readonly PaperPosition[]
  readonly metrics: readonly EconomicMetric[]
} {
  return {
    experiment: findExperiment(state, experimentId) ?? null,
    evidence: state.evidence.filter((entry) => entry.experimentId === experimentId),
    scenarios: state.scenarios.filter((entry) => entry.experimentId === experimentId),
    orders: state.orders.filter((entry) => entry.experimentId === experimentId),
    positions: state.positions.filter((entry) => entry.experimentId === experimentId),
    metrics: state.metrics.filter((entry) => entry.experimentId === experimentId),
  }
}

/** The retry ceiling for the step in hand, derived from the journaled attempt count. */
export function retryCeilingForState(state: EconomicState, limits: EconomicLimits): EconomicRetryCeiling {
  return narrowRetryCeiling(defaultRetryCeiling(state.attemptCount, limits), limits.maxRetryCeiling)
}

/**
 * The evidence as the projection will show it, re-derived against `now`.
 *
 * The fold stores what was written; the projection shows what is *true*, which is a
 * different thing and the whole reason freshness is a read-time derivation rather than a
 * field somebody had to remember to update.
 */
export function evidenceAsOf(
  state: EconomicState,
  now: string,
  limits: EconomicLimits,
): readonly ResearchEvidence[] {
  return refreshEvidence(state.evidence, now, limits)
}

/** The simulation metrics a fold produced, typed for callers that read the scenarios. */
export type FoldedSimulationMetric = SimulationMetric

export { ECONOMIC_EVENT_TYPES, isEconomicExperimentState }