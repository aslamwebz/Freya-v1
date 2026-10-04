import { findTimerUsageInSource, findUnboundedLoopInSource } from '../lifeloop/assertions'
import { ECONOMIC_LIMITS } from './types'
import {
  ECONOMIC_ASSERTIONS,
  ECONOMIC_EVENT_TYPES,
  ECONOMIC_PAYLOAD_KEYS,
  isEconomicEventType,
  type EconomicAssertionId,
  type EconomicLimits,
} from './types'
import { forbiddenKeysIn } from './prohibition'
import type { EconomicJournalEntry } from './state'

/**
 * The Phase 32 assertions, as checkable functions.
 *
 * Phase 32 promises two negative things — *no real money* and *no paid inference* — and
 * a promise like that is worth only as much as the thing that tests it. So this module
 * reads the journal and returns a verdict, and the runtime runs it once at open rather
 * than whenever a window asks.
 *
 * Eleven assertions, and the two that define the phase are `noRealMoneyAction` and
 * `noRealOrder`. They are not read off a policy document; they are read off a payload
 * vocabulary that has no field capable of naming a venue, a broker, an account, a wallet
 * or an amount. If somebody adds one, the assertion fires — which is the point of having
 * the assertion *and* the closed table rather than either alone.
 *
 * `noModelCallWithoutWake` is the interesting money one, and it works from the other
 * direction: rather than looking for a model call inside Phase 32, it looks for a Core
 * model call that is *correlated to* an economic wake or experiment. Phase 32 declares
 * that it spends nothing; this is how that declaration is checked against a whole
 * journal rather than taken on trust.
 *
 * The structural pair — `noContinuousPolling` and `noUnrestrictedLoops` — are claims
 * about source text rather than about the journal, so the caller passes their findings
 * in. The two scanners are imported from Phase 23 rather than reimplemented, so there is
 * one set of patterns in the repository rather than two that could disagree about what
 * `setInterval` looks like.
 */

export type EconomicViolationCode =
  | 'real-money-key-in-payload'
  | 'real-venue-key-in-payload'
  | 'authority-key-in-payload'
  | 'budget-key-in-payload'
  | 'self-approval-in-payload'
  | 'inference-key-in-payload'
  | 'model-call-attributed-to-economic'
  | 'model-call-while-stopped'
  | 'work-while-stopped'
  | 'unknown-event-type'
  | 'unknown-payload-key'
  | 'oversized-payload-text'
  | 'malformed-payload'
  | 'loop-exceeded-step-bound'
  | 'loop-exceeded-experiment-bound'
  | 'loop-exceeded-scenario-bound'
  | 'loop-exceeded-order-bound'
  | 'loop-exceeded-evidence-bound'
  | 'timer-in-economic'
  | 'unbounded-loop-in-economic'

export interface EconomicViolation {
  readonly code: EconomicViolationCode
  readonly assertion: EconomicAssertionId
  readonly eventIndex: number
  readonly eventType: string
  readonly detail: string
}

export interface EconomicAssertionReport {
  readonly holds: boolean
  readonly checks: Readonly<Record<EconomicAssertionId, boolean>>
  readonly violations: readonly EconomicViolation[]
  readonly counted: {
    readonly economicEvents: number
    readonly wakes: number
    readonly experimentsCreated: number
    /** Core events that referenced an economic id. Must be zero. */
    readonly modelCallsAttributedToEconomic: number
  }
}

export interface EconomicAssertionInput {
  readonly entries: readonly EconomicJournalEntry[]
  readonly limits?: EconomicLimits
  /** STOP ALL was in force for the whole journal. */
  readonly stopAllActive?: boolean
  /** Findings from the structural source scan, when the caller ran one. */
  readonly structural?: readonly EconomicViolation[]
}

/** How many payload keys one entry may contribute to a verdict. */
const MAX_SCAN_KEYS = 128

const DEFAULT_CHECKS: Readonly<Record<EconomicAssertionId, boolean>> = Object.freeze(
  Object.fromEntries(ECONOMIC_ASSERTIONS.map((id) => [id, true])) as Record<EconomicAssertionId, boolean>,
)

/** Payload keys that would mean an economic event could reach a model. */
const INFERENCE_KEYS: ReadonlySet<string> = new Set([
  'cognitionRequest',
  'cognitionRequestId',
  'maxOutputTokens',
  'prompt',
  'providerId',
  'model',
  'requestedModel',
  'origin',
  'cause',
])

/** The real-venue half: keys that name somewhere an order could be placed. */
const REAL_VENUE_KEYS: ReadonlySet<string> = new Set([
  'venue',
  'broker',
  'brokerage',
  'exchange',
  'account',
  'accountId',
  'wallet',
  'custodian',
  'currencyPair',
  'realOrder',
])

/** The real-money half: keys that name an amount or a state of being real. */
const REAL_MONEY_KEYS: ReadonlySet<string> = new Set([
  'capital',
  'notional',
  'withdrawal',
  'deposit',
  'live',
  'realMoney',
  'spend',
  'spendingAuthority',
])

const AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  'capability',
  'capabilities',
  'grant',
  'grantId',
  'authority',
  'verdict',
  'allowed',
  'approvalId',
  'principal',
  'actor',
  'token',
  'secret',
  'credential',
  'priority',
])

function payloadOf(entry: EconomicJournalEntry): Record<string, unknown> | null {
  const payload = entry.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

function stringsIn(payload: Record<string, unknown>, depth = 0): readonly string[] {
  if (depth > 2) return []
  const found: string[] = []
  for (const value of Object.values(payload)) {
    if (typeof value === 'string') {
      found.push(value)
      continue
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      found.push(...stringsIn(value as Record<string, unknown>, depth + 1))
    }
  }
  return found
}

/**
 * Read the whole journal and decide whether the Phase 32 invariants hold.
 *
 * The checks are ordered so the most alarming failure is reported first, and the report
 * is complete either way: every violation found is listed, because "there was exactly
 * one" and "there were forty" is the difference between a bug and a design problem.
 */
export function analyseEconomicAssertions(
  input: EconomicAssertionInput,
): EconomicAssertionReport {
  const limits = input.limits ?? ECONOMIC_LIMITS
  const violations: EconomicViolation[] = []

  /** Ids this subsystem owns. A model call that mentions one is a finding. */
  const economicIds = new Set<string>()
  const wakeIds = new Set<string>()
  const experimentsCreated: string[] = []
  const scenariosPerExperiment = new Map<string, number>()
  const ordersPerExperiment = new Map<string, number>()
  const evidencePerExperiment = new Map<string, number>()

  let economicEvents = 0
  let wakes = 0
  let modelCallsAttributed = 0
  let stopped = false
  let stoppedAt = -1
  let stepsThisWake = 0
  let wakeIndex = 0

  const fail = (
    code: EconomicViolationCode,
    assertion: EconomicAssertionId,
    index: number,
    eventType: string,
    detail: string,
  ): void => {
    violations.push({ code, assertion, eventIndex: index, eventType, detail })
  }

  input.entries.forEach((entry, index) => {
    const type = entry.type
    const payload = payloadOf(entry)

    if (type.startsWith('economic.')) {
      economicEvents += 1
      // Narrowed by a predicate rather than by a `has()` call, which does not narrow.
      if (!isEconomicEventType(type)) {
        fail(
          'unknown-event-type',
          'noHiddenDurableState',
          index,
          type,
          `${type} is not one of the ${ECONOMIC_EVENT_TYPES.length} economic event types`,
        )
        return
      }
      if (payload === null) {
        fail('malformed-payload', 'noHiddenDurableState', index, type, `${type} carried no object payload`)
        return
      }
      inspectPayload(type, payload, index, limits, fail)
      trackCounters(type, payload, {
        experimentsCreated,
        scenariosPerExperiment,
        ordersPerExperiment,
        evidencePerExperiment,
      })

      // Anything an economic entry does after STOP ALL is work performed after the owner
      // asked for none. `economic.stopped` and `economic.unstopped` are excluded because
      // they *are* the latch, and a reconciliation is included on purpose: recording
      // what the stop interrupted is bookkeeping about the stop, not work despite it.
      if (stopped && type !== 'economic.unstopped' && type !== 'economic.reconciled' && type !== 'economic.refusal.recorded') {
        fail(
          'work-while-stopped',
          'noIdleModelCall',
          index,
          type,
          `${type} was written while STOP ALL was latched`,
        )
      }
    }

    switch (type) {
      case 'economic.stopped':
        stopped = true
        stoppedAt = index
        break

      case 'economic.unstopped':
        stopped = false
        break

      case 'economic.wake.received': {
        wakes += 1
        wakeIndex = index
        stepsThisWake = 0
        if (payload !== null) {
          for (const value of stringsIn(payload)) economicIds.add(value)
        }
        break
      }

      case 'economic.experiment.created':
        if (payload !== null) {
          const id = payload.experimentId
          if (typeof id === 'string') economicIds.add(id)
        }
        break

      case 'economic.continuation.decided':
      case 'economic.gate.decided':
      case 'economic.evidence.gathered':
      case 'economic.simulation.started':
      case 'economic.simulation.completed':
      case 'economic.paper-order.placed':
      case 'economic.paper-order.filled':
      case 'economic.metric.computed':
      case 'economic.experiment.state-changed':
      case 'economic.experiment.completed':
      case 'economic.experiment.failed':
      case 'economic.experiment.cancelled': {
        stepsThisWake += 1
        if (stepsThisWake > limits.maxExperiments * 8) {
          fail(
            'loop-exceeded-step-bound',
            'noUnrestrictedLoops',
            index,
            type,
            `a single wake wrote ${stepsThisWake} economic entries`,
          )
        }
        break
      }

      case 'cognition.requested':
      case 'model.request.started': {
        if (payload === null) break
        const attributed = stringsIn(payload).some((value) => economicIds.has(value) || wakeIds.has(value))
        if (attributed) {
          modelCallsAttributed += 1
          fail(
            'model-call-attributed-to-economic',
            'noModelCallWithoutWake',
            index,
            type,
            'a model call referenced an economic wake or experiment; this subsystem spends nothing',
          )
        }
        if (stopped && index > stoppedAt) {
          fail(
            'model-call-while-stopped',
            'noIdleModelCall',
            index,
            type,
            'a model call was made while STOP ALL was latched',
          )
        }
        break
      }

      case 'security.stop_all.activated':
        stopped = true
        stoppedAt = index
        break

      default:
        break
    }

    // Wakes are collected as they are seen, so a Core event that arrived *before* the
    // economic wake is not attributed to it — which is correct, since the reference
    // could not have come from a wake that had not been written yet.
    if (type === 'economic.wake.received' && payload !== null) {
      const id = payload.wakeId
      if (typeof id === 'string') wakeIds.add(id)
    }
    void wakeIndex
  })

  for (const finding of input.structural ?? []) violations.push(finding)

  const checks = { ...DEFAULT_CHECKS }
  for (const violation of violations) checks[violation.assertion] = false

  return {
    holds: violations.length === 0,
    checks,
    violations,
    counted: {
      economicEvents,
      wakes,
      experimentsCreated: experimentsCreated.length,
      modelCallsAttributedToEconomic: modelCallsAttributed,
    },
  }
}

function trackCounters(
  type: string,
  payload: Record<string, unknown>,
  buckets: {
    experimentsCreated: string[]
    scenariosPerExperiment: Map<string, number>
    ordersPerExperiment: Map<string, number>
    evidencePerExperiment: Map<string, number>
  },
): void {
  const experimentId = typeof payload.experimentId === 'string' ? payload.experimentId : null
  if (type === 'economic.experiment.created' && experimentId !== null) {
    buckets.experimentsCreated.push(experimentId)
  }
  if (experimentId === null) return
  if (type === 'economic.simulation.started') {
    buckets.scenariosPerExperiment.set(experimentId, (buckets.scenariosPerExperiment.get(experimentId) ?? 0) + 1)
  }
  if (type === 'economic.paper-order.placed') {
    buckets.ordersPerExperiment.set(experimentId, (buckets.ordersPerExperiment.get(experimentId) ?? 0) + 1)
  }
  if (type === 'economic.evidence.gathered') {
    buckets.evidencePerExperiment.set(experimentId, (buckets.evidencePerExperiment.get(experimentId) ?? 0) + 1)
  }
}

function inspectPayload(
  type: (typeof ECONOMIC_EVENT_TYPES)[number],
  payload: Record<string, unknown>,
  index: number,
  limits: EconomicLimits,
  fail: (
    code: EconomicViolationCode,
    assertion: EconomicAssertionId,
    index: number,
    eventType: string,
    detail: string,
  ) => void,
): void {
  const allowed = ECONOMIC_PAYLOAD_KEYS[type]
  const keys = Object.keys(payload).slice(0, MAX_SCAN_KEYS)

  for (const key of keys) {
    if (REAL_VENUE_KEYS.has(key)) {
      fail(
        'real-venue-key-in-payload',
        'noRealOrder',
        index,
        type,
        `${type} carried "${key}", which names somewhere a real order could be placed`,
      )
      continue
    }
    if (REAL_MONEY_KEYS.has(key)) {
      fail(
        'real-money-key-in-payload',
        'noRealMoneyAction',
        index,
        type,
        `${type} carried "${key}", which names an amount or a state of being real`,
      )
      continue
    }
    if (key === 'budget') {
      fail(
        'budget-key-in-payload',
        'noBudgetWidening',
        index,
        type,
        `${type} carried "${key}"; a budget comes from durable state and is never widened by an event`,
      )
      continue
    }
    if (key === 'approved' || key === 'approvalId') {
      fail(
        'self-approval-in-payload',
        'noSelfApproval',
        index,
        type,
        `${type} carried "${key}"; only the owner approves, and no economic event may hold an approval`,
      )
      continue
    }
    if (AUTHORITY_KEYS.has(key)) {
      fail(
        'authority-key-in-payload',
        'noAuthorityEscalation',
        index,
        type,
        `${type} carried "${key}", which is an authority shape no economic event may hold`,
      )
      continue
    }
    if (INFERENCE_KEYS.has(key)) {
      fail(
        'inference-key-in-payload',
        'noHiddenReasoning',
        index,
        type,
        `${type} carried "${key}"; the economic subsystem makes no model call and holds no token count`,
      )
      continue
    }
    if (!allowed.includes(key)) {
      fail(
        'unknown-payload-key',
        'noHiddenDurableState',
        index,
        type,
        `${type} carried "${key}", which is not in its closed payload vocabulary`,
      )
    }
    if (typeof payload[key] === 'string' && String(payload[key]).length > limits.maxPayloadTextLength) {
      fail(
        'oversized-payload-text',
        'noHiddenDurableState',
        index,
        type,
        `${type} carried a ${String(payload[key]).length}-character string, over the ${limits.maxPayloadTextLength}-character ceiling`,
      )
    }
  }
}

/** Every assertion in its passing state. Used by the absent projection and by tests. */
export function passingEconomicAssertions(): Readonly<Record<EconomicAssertionId, boolean>> {
  return DEFAULT_CHECKS
}

/**
 * The forbidden keys a payload carries, for the fold's own anomaly wording.
 *
 * Re-exported rather than reimplemented so the door and the wall agree: the scan at the
 * boundary and the anomaly the fold records are reading the same frozen set.
 */
export { forbiddenKeysIn }

/**
 * Scan this lane's own source for self-scheduling and unbounded loops.
 *
 * A convenience wrapper so a caller runs the two Phase 23 scanners over a set of files
 * with one call and gets violations in this module's shape. The scan is deliberately
 * blunt — it does not try to tell a legitimate bounded loop from a runaway — because a
 * check that produces false positives gets switched off within a week, and a check
 * people switch off protects nothing.
 */
export function scanEconomicSource(
  sources: Readonly<Record<string, string>>,
): readonly EconomicViolation[] {
  const findings: EconomicViolation[] = []
  for (const [name, source] of Object.entries(sources)) {
    for (const pattern of findTimerUsageInSource(source)) {
      findings.push({
        code: 'timer-in-economic',
        assertion: 'noContinuousPolling',
        eventIndex: -1,
        eventType: name,
        detail: `${name} uses ${pattern}; the economic subsystem schedules nothing`,
      })
    }
    for (const pattern of findUnboundedLoopInSource(source)) {
      findings.push({
        code: 'unbounded-loop-in-economic',
        assertion: 'noUnrestrictedLoops',
        eventIndex: -1,
        eventType: name,
        detail: `${name} contains ${pattern}, which has no condition at all`,
      })
    }
  }
  return findings
}