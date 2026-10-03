import {
  FORBIDDEN_PAYLOAD_KEYS,
  LIFE_LOOP_EVENT_TYPES,
  LIFE_LOOP_EVENT_TYPE_SET,
  LIFE_LOOP_PAYLOAD_KEYS,
  ZERO_IDLE_ASSERTIONS,
  type LifeLoopEventType,
  type ZeroIdleAssertionId,
} from './types'
import { allInterruptions, allOrdinaryTransitions } from './machine'
import type { LifeLoopJournalEntry } from './state'

/**
 * The zero-idle-inference assertions, as checkable functions.
 *
 * Immutable Principle 6 is a promise about money: *an idle Freya makes no paid
 * model call and performs no hidden background reasoning.* A promise like that is
 * worth only as much as the thing that tests it, so this module turns the promise
 * into eight named checks that read a journal and return a verdict.
 *
 * The interesting one is `noAuthorityEscalation`. The obvious checks — no model
 * call without a wake, no call while stopped — are easy. What actually protects
 * the owner is that a life-loop event cannot *carry* authority at all: the payload
 * vocabulary is closed and enumerated, authority-shaped keys are refused, and a
 * string longer than the ceiling is a violation rather than a very verbose field.
 * So the journal cannot become the place where a capability quietly appears.
 *
 * Two of the eight are structural rather than journal-shaped — "no continuous
 * polling" and "no unrestricted loops" are claims about source text. They are
 * checkable too, by `findTimerUsageInSource` and `findUnboundedLoopInSource`, and
 * the red-team suite runs both over the whole of Core.
 */

export type InferenceViolationCode =
  | 'model-call-without-wake'
  | 'model-call-while-idle'
  | 'model-call-while-stop-all'
  | 'allowed-without-request'
  | 'denied-without-request'
  | 'background-call-without-grant'
  | 'loop-exceeded-iteration-bound'
  | 'loop-exceeded-action-bound'
  | 'loop-exceeded-verification-bound'
  | 'authority-key-in-payload'
  | 'unknown-payload-key'
  | 'oversized-payload-text'
  | 'timer-in-core'
  | 'timer-in-life-loop'
  | 'unbounded-loop-in-life-loop'

export interface InferenceViolation {
  readonly code: InferenceViolationCode
  readonly assertion: ZeroIdleAssertionId
  readonly eventIndex: number
  readonly eventType: string
  readonly detail: string
}

export interface ZeroIdleInferenceReport {
  readonly holds: boolean
  readonly checks: Readonly<Record<ZeroIdleAssertionId, boolean>>
  readonly violations: readonly InferenceViolation[]
  /** Model requests and provider starts counted from the journal. */
  readonly counted: {
    readonly cognitionRequests: number
    readonly providerStarts: number
    readonly wakes: number
    readonly lifeLoopEvents: number
  }
}

export interface ZeroIdleInferenceInput {
  readonly entries: readonly LifeLoopJournalEntry[]
  readonly limits?: {
    readonly maxLoopIterations: number
    readonly maxActionsPerIteration: number
    readonly maxVerificationsPerIteration: number
  }
  /** Whether a STOP ALL latch is in force for the whole journal. */
  readonly stopAllActive?: boolean
  /** Findings from the structural source scan, when the caller ran one. */
  readonly structural?: readonly InferenceViolation[]
}

/** The default ceilings, mirrored here so this module needs no other import. */
const DEFAULT_LIMITS = { maxLoopIterations: 10, maxActionsPerIteration: 128, maxVerificationsPerIteration: 64 }

/** The longest text a life-loop payload may carry. Mirrors the frozen limit. */
const MAX_PAYLOAD_TEXT = 200

/** How many open cognition requests are remembered across for the grant rule. */
const MAX_TRACKED_REQUESTS = 256

const DEFAULT_CHECKS: Readonly<Record<ZeroIdleAssertionId, boolean>> = Object.freeze(
  Object.fromEntries(ZERO_IDLE_ASSERTIONS.map((id) => [id, true])) as Record<ZeroIdleAssertionId, boolean>,
)

function payloadOf(entry: LifeLoopJournalEntry): Record<string, unknown> | null {
  const payload = entry.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

/** The request id a cognition or model event refers to, or null if unnamed. */
function requestIdOf(payload: Record<string, unknown>): string | null {
  const value = payload.requestId
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Is this cognition request the owner's own turn?
 *
 * The single exemption in the "no model call without a wake" rule, and it is
 * narrow on purpose: the request must name the user as its origin *and* a direct
 * message from them as its cause. `origin: 'user'` on its own is not enough — a
 * `user`-origin request caused by `explicit_review` is still Freya deciding to
 * think about something on her own, and that needs a wake like everything else.
 *
 * These are the fields the envelope actually carries. `cognition.requested` has
 * no `kind`, no `userInitiated`, no `background` and no `grantId`; reading those
 * would make the exemption permanently unreachable and every real owner turn
 * would report as a model call with no wake behind it. What the Governor itself
 * keys on is `userInitiated && origin === 'user' && !background`, of which
 * `origin` and `cause` are the two that reach the journal.
 */
function isOwnerTurn(payload: Record<string, unknown>): boolean {
  return payload.origin === 'user' && payload.cause === 'user_message'
}

/**
 * Read the whole journal and decide whether zero-idle-inference holds.
 *
 * The checks are ordered so the most alarming failure is reported first, and the
 * report is complete either way: every violation found is listed, not just the
 * first, because "there was exactly one" versus "there were forty" is the
 * difference between a bug and a design problem.
 */
export function analyseZeroIdleInference(
  input: ZeroIdleInferenceInput,
): ZeroIdleInferenceReport {
  const limits = input.limits ?? DEFAULT_LIMITS
  const violations: InferenceViolation[] = []
  const structural = input.structural ?? []

  let wakeSeen = false
  let requestOpen = false
  let filterCleared = false
  let wakeSegments = 0
  let currentIteration = 0
  let actionsInIteration = 0
  let verificationsInIteration = 0
  let stopAllSeen = false
  /** requestId -> whether that request was the owner's own turn. */
  const userTurnRequests = new Map<string, boolean>()

  let cognitionRequests = 0
  let providerStarts = 0
  let wakes = 0
  let lifeLoopEvents = 0

  const fail = (
    code: InferenceViolationCode,
    assertion: ZeroIdleAssertionId,
    index: number,
    eventType: string,
    detail: string,
  ): void => {
    violations.push({ code, assertion, eventIndex: index, eventType, detail })
  }

  input.entries.forEach((entry, index) => {
    const type = entry.type

    if (type.startsWith('lifeloop.')) {
      lifeLoopEvents += 1
      if (!LIFE_LOOP_EVENT_TYPE_SET.has(type)) {
        fail(
          'unknown-payload-key',
          'noHiddenDurableState',
          index,
          type,
          `${type} is not one of the ${LIFE_LOOP_EVENT_TYPES.length} life-loop event types`,
        )
        return
      }
      const payload = payloadOf(entry)
      if (payload !== null) {
        inspectLifeLoopPayload(type as LifeLoopEventType, payload, index, fail)
      }
    }

    switch (type) {
      case 'lifeloop.wake.received': {
        wakeSeen = true
        filterCleared = false
        wakeSegments += 1
        currentIteration = numberField(payloadOf(entry), 'iteration') ?? currentIteration + 1
        // The iteration number a wake declares is checked against the ceiling
        // here, not only on the continuation event: a wake that *claims* to be
        // the fifteenth pass is the thing worth catching, and by then it has
        // already told us.
        if (currentIteration > limits.maxLoopIterations) {
          fail(
            'loop-exceeded-iteration-bound',
            'noUnrestrictedLoops',
            index,
            type,
            `a wake declared iteration ${currentIteration}, over the ${limits.maxLoopIterations} ceiling`,
          )
        }
        actionsInIteration = 0
        verificationsInIteration = 0
        wakes += 1
        break
      }

      case 'lifeloop.filter.passed':
        filterCleared = true
        break

      case 'lifeloop.filter.denied':
        // A denial clears the standing permission. Whatever was allowed before
        // is no longer allowed, which is what stops a loop from thinking again on
        // the strength of a filter that has since said no.
        filterCleared = false
        break

      case 'lifeloop.cognition.denied':
        filterCleared = false
        break

      case 'security.stop_all.activated':
        stopAllSeen = true
        break

      case 'cognition.requested': {
        const payload = payloadOf(entry)
        cognitionRequests += 1
        requestOpen = true
        const ownerTurn = isOwnerTurn(payload ?? {})
        const requestId = payload === null ? null : requestIdOf(payload)
        // Remembered per request id, because that is how `model.request.started`
        // finds the turn it belongs to. Bounded like everything else here: the
        // journal is replayed, and a replay of a year of thinking must not become
        // a map of a year of thinking.
        if (requestId !== null) {
          if (userTurnRequests.size >= MAX_TRACKED_REQUESTS) {
            const oldest = userTurnRequests.keys().next()
            if (oldest.done !== true) userTurnRequests.delete(oldest.value)
          }
          userTurnRequests.set(requestId, ownerTurn)
        }
        if (ownerTurn) break
        if (!wakeSeen) {
          fail(
            'model-call-without-wake',
            'noModelCallWithoutWake',
            index,
            type,
            'a cognition request appeared with no preceding life-loop wake',
          )
        }
        if (!filterCleared) {
          fail(
            'model-call-while-idle',
            'noIdleModelCall',
            index,
            type,
            'a cognition request appeared with no standing lifeloop.filter.passed',
          )
        }
        if (stopAllSeen || input.stopAllActive === true) {
          fail(
            'model-call-while-stop-all',
            'noIdleModelCall',
            index,
            type,
            'a cognition request appeared while STOP ALL was in force',
          )
        }
        // No grant is recorded here: `cognition.requested` names no provider and
        // no grant by design, and authorization happens after it. The grant rule
        // is enforced at `model.request.started`, which is where a provider is
        // actually contacted and which does carry the grant.
        break
      }

      case 'model.request.started': {
        providerStarts += 1
        const payload = payloadOf(entry)
        // A provider contact with no grant is legal in exactly one case: the
        // owner asked, in their own turn. Every other route to a provider must
        // show the grant that paid for it, which is the Governor's own rule read
        // back off the journal rather than taken on trust.
        // A request id we never saw is treated as not-an-owner-turn: the journal
        // is the only evidence available here, and an unbacked exemption is worse
        // than a reported violation.
        const grantId = payload === null ? undefined : payload.grantId
        const requestId = requestIdOf(payload ?? {})
        const ownerTurn = requestId !== null && userTurnRequests.get(requestId) === true
        if (grantId === null && !ownerTurn) {
          fail(
            'background-call-without-grant',
            'noBackgroundReasoning',
            index,
            type,
            'a provider was contacted with no grant and no owner turn behind it',
          )
        }
        break
      }

      case 'cognition.allowed':
        if (!requestOpen) {
          fail(
            'allowed-without-request',
            'noHiddenReasoning',
            index,
            type,
            'cognition was allowed with no open cognition request',
          )
        }
        requestOpen = false
        break

      case 'cognition.denied':
        if (!requestOpen) {
          fail(
            'denied-without-request',
            'noHiddenReasoning',
            index,
            type,
            'cognition was denied with no open cognition request',
          )
        }
        requestOpen = false
        break

      case 'lifeloop.action.started':
        actionsInIteration += 1
        if (actionsInIteration > limits.maxActionsPerIteration) {
          fail(
            'loop-exceeded-action-bound',
            'noUnrestrictedLoops',
            index,
            type,
            `a single wake performed ${actionsInIteration} actions, over the ${limits.maxActionsPerIteration} ceiling`,
          )
        }
        break

      case 'lifeloop.verification.started':
        verificationsInIteration += 1
        if (verificationsInIteration > limits.maxVerificationsPerIteration) {
          fail(
            'loop-exceeded-verification-bound',
            'noUnrestrictedLoops',
            index,
            type,
            `a single wake performed ${verificationsInIteration} verifications, over the ${limits.maxVerificationsPerIteration} ceiling`,
          )
        }
        break

      case 'lifeloop.continuation.decided': {
        const iteration = numberField(payloadOf(entry), 'iteration')
        if (iteration !== null) currentIteration = iteration
        if (currentIteration > limits.maxLoopIterations) {
          fail(
            'loop-exceeded-iteration-bound',
            'noUnrestrictedLoops',
            index,
            type,
            `a single wake reached iteration ${currentIteration}, over the ${limits.maxLoopIterations} ceiling`,
          )
        }
        break
      }

      default:
        break
    }
  })

  for (const finding of structural) violations.push(finding)

  // A provider start with no cognition request at all is the most direct possible
  // evidence of a hidden call, and is checked over the whole journal rather than
  // in sequence: `model.request.started` is written by the gateway, and the
  // request it belongs to is the one thing that must have been authorized.
  if (providerStarts > 0 && cognitionRequests === 0) {
    fail(
      'model-call-without-wake',
      'noModelCallWithoutWake',
      -1,
      'model.request.started',
      'a provider was contacted without any cognition request in the journal',
    )
  }
  // More provider starts than authorized requests cannot be explained by
  // bookkeeping, so it is a violation in its own right.
  if (providerStarts > cognitionRequests) {
    fail(
      'model-call-without-wake',
      'noModelCallWithoutWake',
      -1,
      'model.request.started',
      `${providerStarts} provider start(s) against ${cognitionRequests} cognition request(s)`,
    )
  }
  if (wakeSegments > 0 && lifeLoopEvents > 0 && cognitionRequests > wakeSegments * limits.maxLoopIterations) {
    fail(
      'loop-exceeded-iteration-bound',
      'noUnrestrictedLoops',
      -1,
      'lifeloop',
      `${cognitionRequests} cognition requests across ${wakeSegments} wake(s), over the per-wake ceiling`,
    )
  }

  const checks = { ...DEFAULT_CHECKS }
  for (const violation of violations) checks[violation.assertion] = false

  return {
    holds: violations.length === 0,
    checks,
    violations,
    counted: { cognitionRequests, providerStarts, wakes, lifeLoopEvents },
  }
}

function numberField(payload: Record<string, unknown> | null, key: string): number | null {
  if (payload === null) return null
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.floor(value)
}

function inspectLifeLoopPayload(
  type: LifeLoopEventType,
  payload: Record<string, unknown>,
  index: number,
  fail: (
    code: InferenceViolationCode,
    assertion: ZeroIdleAssertionId,
    eventIndex: number,
    eventType: string,
    detail: string,
  ) => void,
): void {
  const allowed = LIFE_LOOP_PAYLOAD_KEYS[type]
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      fail(
        'authority-key-in-payload',
        'noAuthorityEscalation',
        index,
        type,
        `${type} carried "${key}", which is an authority shape no life-loop event may hold`,
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
    if (typeof value === 'string' && value.length > MAX_PAYLOAD_TEXT) {
      fail(
        'oversized-payload-text',
        'noHiddenDurableState',
        index,
        type,
        `${type} carried a ${value.length}-character string, over the ${MAX_PAYLOAD_TEXT}-character ceiling`,
      )
    }
  }
}

/* ------------------------------------------------------- structural checks */

/** The token patterns that would mean Core is polling itself. */
const TIMER_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: 'setInterval', pattern: /\bsetInterval\s*\(/ },
  { name: 'setTimeout', pattern: /\bsetTimeout\s*\(/ },
  { name: 'requestAnimationFrame', pattern: /\brequestAnimationFrame\s*\(/ },
  { name: 'while-true', pattern: /\bwhile\s*\(\s*true\s*\)/ },
  { name: 'do-forever', pattern: /\bdo\s*\{/ },
  { name: 'recursive-timer', pattern: /\btick\s*\(\s*\)\s*;?\s*$/m },
])

/**
 * Find self-scheduling in a source file.
 *
 * A life loop that schedules its own next tick is a life loop nobody bounded, and
 * a heartbeat that re-arms itself is a heartbeat that runs on a stopped Freya.
 * So the check is textual and blunt on purpose: it does not try to tell a
 * legitimate one-shot `setTimeout` from a poll, because a module in the middle of
 * the loop is not a place where that distinction is safe to leave to a reader.
 *
 * Comment text is stripped first, so the word "setInterval" in a doc comment
 * explaining why there is no `setInterval` is not a finding.
 */
export function findTimerUsageInSource(
  source: string,
  options?: { readonly commentStripped?: boolean },
): readonly string[] {
  const text = options?.commentStripped === true ? source : stripComments(source)
  const findings: string[] = []
  for (const { name, pattern } of TIMER_PATTERNS) {
    if (pattern.test(text)) findings.push(name)
  }
  return findings
}

/**
 * Find a loop with no condition at all.
 *
 * Deliberately narrow: only `for (;;)`, `while (true)` and a bare `do` block are
 * reported. A cleverer heuristic that tried to judge whether a loop's bound was
 * "real" would produce false positives on every `for..of` in the codebase and
 * would get switched off within a week — and a check people switch off protects
 * nothing. So this asks the one question with an unambiguous answer, and the
 * *real* bounds live where they belong: in `LIFE_LOOP_LIMITS`, in the counters in
 * the journal, and in `analyseZeroIdleInference`.
 */
export function findUnboundedLoopInSource(source: string): readonly string[] {
  const text = stripComments(source)
  const findings: string[] = []
  const candidates: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: 'for-ever', pattern: /\bfor\s*\(\s*;\s*;\s*\)/ },
    { name: 'while-true', pattern: /\bwhile\s*\(\s*(?:true|1)\s*\)/ },
    { name: 'do-forever', pattern: /\bdo\s*\{/ },
  ]
  for (const { name, pattern } of candidates) {
    if (pattern.test(text)) findings.push(name)
  }
  return findings
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/* --------------------------------------------------- state-machine audit */

/**
 * Re-derive the invariants from the tables themselves.
 *
 * Used by the suite as an exhaustion check rather than by production code, which
 * is why it is here and not in `machine.ts`: these are statements *about* the
 * machine, and they belong next to the things they are about.
 */
export function auditContinuationTable(): readonly string[] {
  const findings: string[] = []
  for (const { from, signal, to } of allOrdinaryTransitions()) {
    if (to === from) findings.push(`self-transition ${from} on "${signal}"`)
  }
  for (const { from, signal, to } of allOrdinaryTransitions()) {
    if ((from === 'DENY' || from === 'STOP') && to !== null && signal !== 'reset') {
      findings.push(`terminal state ${from} has an outgoing edge on "${signal}"`)
    }
  }
  for (const { from, source, to } of allInterruptions()) {
    if (source === 'stop-all' && to === null && from !== 'STOP' && from !== 'DENY') {
      findings.push(`STOP ALL does not reach ${from}`)
    }
  }
  return findings
}