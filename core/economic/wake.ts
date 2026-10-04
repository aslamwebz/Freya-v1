import {
  ECONOMIC_WAKE_KIND_SOURCE,
  ECONOMIC_WAKE_SOURCES,
  ECONOMIC_WAKE_SOURCE_ACTOR,
  isEconomicWakeActor,
  isEconomicWakeKind,
  isEconomicWakeSource,
  type EconomicExperimentState,
  type EconomicWake,
  type EconomicWakeActor,
  type EconomicWakeKind,
  type EconomicWakeRefusalCode,
  type EconomicWakeSource,
  type EconomicWakeValidationOutcome,
} from './types'

/**
 * The wake registry.
 *
 * A wake is an authorized event that says *look at this named experiment now*. It is
 * not a model call, it is not permission, it is not work, and — the thing that matters
 * most for this subsystem — it is not a licence to go looking for something new.
 *
 * Every wake names an experiment or it names a goal, and the difference is the whole of
 * `polling-prohibited`: a `deadline-reached` wake without an `experimentId` is refused,
 * because a scheduled check that names nothing in particular is the shape continuous
 * polling takes. `ECONOMIC_WAKE_KIND_SOURCE` then keeps a heartbeat from being
 * relabelled as owner interaction to buy a louder wake than the event deserves.
 *
 * Like the rest of this module it reads no clock and reaches nothing. `now`, the
 * journal-trust flag and the STOP ALL latch arrive as facts, and the experiment states
 * arrive as a lookup supplied by Core — so the whole registry is testable with an
 * object literal.
 */

/** Facts the registry cannot decide for itself. All of them already-authorized. */
export interface EconomicWakeContext {
  /** ISO instant, injected. The registry has no clock of its own. */
  readonly now: string
  readonly stopAllActive: boolean
  readonly journalTrustworthy: boolean
  /** The lifecycle state of the experiment a wake names, or null if it names none. */
  readonly experimentState: (experimentId: string) => EconomicExperimentState | null
  /** Whether the named experiment exists at all. */
  readonly experimentExists: (experimentId: string) => boolean
  /** Dedupe keys already consumed, in order. */
  readonly processedWakeKeys: readonly string[]
  /** Whether the runtime is mid-step, and so cannot accept a wake. */
  readonly busy: boolean
  readonly closed: boolean
}

/** A wake, as Core raises one. Attribution is Core's job; checking it is ours. */
export interface EconomicWakeRequest {
  readonly source: EconomicWakeSource
  readonly kind: EconomicWakeKind
  /**
   * Assigned by Core from the actor that raised it, never read out of a payload.
   *
   * Present as a parameter rather than inferred so this module cannot be told which
   * source a wake *claims*; it can only compare the attribution against the closed
   * table and refuse everything that does not match.
   */
  readonly actor: EconomicWakeActor
  readonly experimentId: string | null
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
}

const REFUSAL_REASONS: Readonly<Record<EconomicWakeRefusalCode, string>> = Object.freeze({
  'unknown-source': 'That is not a source an economic wake may arrive on.',
  'unknown-kind': 'That is not a kind of thing that wakes the economic subsystem.',
  'kind-source-mismatch': 'That kind of wake cannot arrive on that source.',
  'unauthorized-actor': 'Nobody may raise that kind of wake.',
  'missing-wake-id': 'A wake without an id cannot be deduplicated, so it is refused.',
  'unknown-experiment': 'That wake names an experiment that does not exist.',
  'experiment-terminal': 'That experiment has already finished, so there is nothing to wake for.',
  'malformed-timestamp': 'That timestamp could not be read as a moment in time.',
  'observed-before-occurred': 'A wake cannot be observed before it happened.',
  'stop-all-active': 'Freya is stopped, and nothing economic wakes while she is.',
  'journal-not-trustworthy': 'The journal cannot be believed, so nothing new is acted on.',
  'duplicate-wake': 'That exact wake has already been handled.',
  'runtime-busy': 'The economic subsystem is in the middle of a step and cannot take that now.',
  'runtime-closed': 'The economic subsystem has been shut down.',
  'polling-prohibited': 'A wake names an experiment or a goal. It is not a licence to go looking.',
  'real-money-prohibited': 'An economic wake is about simulated work, and that was not it.',
})

export function wakeRefusalReason(code: EconomicWakeRefusalCode): string {
  return REFUSAL_REASONS[code]
}

/**
 * The durable deduplication key for a wake.
 *
 * Derived from source, kind and reference — never from the wake's id, because the id is
 * minted per attempt and a key built from it would let the same event be handled once
 * per retry. Two wakes about the same experiment from the same source are one wake.
 */
export function economicWakeDedupeKey(wake: EconomicWake): string {
  return [wake.source, wake.kind, wake.experimentId ?? wake.goalRef ?? 'none'].join('|')
}

/**
 * Validate one wake.
 *
 * The order of the checks is the content of this function, and it is load-bearing:
 *
 *   1. **shape** — source, kind, pairing, actor. Everything here is about whether this
 *      *is* a wake at all, and none of it can be satisfied by a caller who supplies a
 *      better-looking payload.
 *   2. **latch and journal** — STOP ALL and trustworthiness, outranking everything
 *      below them for the same reason Phase 23's pre-cognition filter does it.
 *   3. **the thing it names** — does the experiment exist, is it still live, is this
 *      exact wake new.
 *   4. **capacity** — busy, closed.
 *   5. **timing** — and only now, timestamps, because a malformed instant on a wake
 *      that was going to be refused anyway is noise rather than information.
 *
 * The deferral is at the end deliberately. `deadline-not-reached` is not a refusal: the
 * wake is real, authorized and correctly shaped, but the instant it names has not come,
 * so the subsystem parks with a deadline instead of spending anything.
 */
export function validateEconomicWake(
  request: EconomicWakeRequest,
  wakeId: string,
  context: EconomicWakeContext,
): EconomicWakeValidationOutcome {
  const deny = (code: EconomicWakeRefusalCode): EconomicWakeValidationOutcome => ({
    outcome: 'denied',
    code,
    reason: REFUSAL_REASONS[code],
  })

  // (1) shape
  if (wakeId.length === 0) return deny('missing-wake-id')
  if (!isEconomicWakeSource(request.source)) return deny('unknown-source')
  if (!isEconomicWakeKind(request.kind)) return deny('unknown-kind')
  if (!isEconomicWakeActor(request.actor)) return deny('unauthorized-actor')
  if (ECONOMIC_WAKE_SOURCE_ACTOR[request.source] !== request.actor) return deny('unauthorized-actor')
  if (ECONOMIC_WAKE_KIND_SOURCE[request.kind] !== request.source) return deny('kind-source-mismatch')

  // A wake that names no experiment is only coherent when it names a goal instead, and
  // only two kinds may do that. Everything else must name the experiment it is about,
  // which is what makes "go and look for an opportunity" unrepresentable.
  if (request.experimentId === null) {
    const goalOnlyKinds: readonly EconomicWakeKind[] = [
      'owner-command',
      'owner-approval',
      'owner-dismissal',
      'long-horizon-continuation',
    ]
    if (request.goalRef === null || !goalOnlyKinds.includes(request.kind)) {
      return deny('polling-prohibited')
    }
  }

  // (2) latch and journal
  if (context.journalTrustworthy === false) return deny('journal-not-trustworthy')
  if (context.stopAllActive === true) return deny('stop-all-active')

  if (context.closed) return deny('runtime-closed')
  if (context.busy) return deny('runtime-busy')

  // (3) the thing it names
  if (request.experimentId !== null) {
    if (!context.experimentExists(request.experimentId)) return deny('unknown-experiment')
    const state = context.experimentState(request.experimentId)
    if (state === null) return deny('unknown-experiment')
    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      return deny('experiment-terminal')
    }
  }

  // (5) timing, last
  const occurred = Date.parse(request.occurredAt)
  const observed = Date.parse(context.now)
  if (!Number.isFinite(occurred) || !Number.isFinite(observed)) return deny('malformed-timestamp')

  const wake: EconomicWake = {
    wakeId,
    source: request.source,
    kind: request.kind,
    experimentId: request.experimentId,
    goalRef: request.goalRef,
    sourceRef: request.sourceRef,
    occurredAt: new Date(occurred).toISOString(),
    observedAt: new Date(observed).toISOString(),
  }
  const wakeKey = economicWakeDedupeKey(wake)

  if (context.processedWakeKeys.includes(wakeKey)) return deny('duplicate-wake')

  // (4') The deferral, and it is checked **before** the "observed before it happened"
  // rule, because for `deadline-reached` those two are the same fact.
  //
  // For every other kind, `occurredAt` is when the thing happened and a future instant is
  // a lie. But a deadline wake names the instant the deadline *is*, and the common case
  // is that it has not arrived — a heartbeat firing early, a scheduler a second ahead of
  // the clock, or a schedule the host fetched before its deadline passed. Refusing those
  // would make the deferral path unreachable, and an unreachable branch is exactly the
  // failure mode a deferral exists to prevent: it would read as covered and never run.
  if (request.kind === 'deadline-reached' && request.experimentId !== null) {
    if (occurred > observed) {
      return {
        outcome: 'deferred',
        wake,
        wakeKey,
        code: 'deadline-not-reached',
        reason: 'The experiment is not due yet, so nothing was spent on it.',
        deadline: new Date(occurred).toISOString(),
      }
    }
  } else if (observed < occurred) {
    return deny('observed-before-occurred')
  }

  return { outcome: 'accepted', wake, wakeKey }
}

/**
 * Order a batch of wakes: highest priority first, then earliest, then by id.
 *
 * Total and deterministic. The id tiebreak is not cosmetic — two wakes with the same
 * source, kind and instant are otherwise unordered, and an unordered batch means a
 * fold that depends on which one arrived first, which is the one thing a journal is
 * supposed to stop mattering.
 */
export function orderEconomicWakes(wakes: readonly EconomicWake[]): readonly EconomicWake[] {
  return [...wakes].sort((left, right) => {
    const byPriority =
      ECONOMIC_WAKE_SOURCES.indexOf(left.source) - ECONOMIC_WAKE_SOURCES.indexOf(right.source)
    if (byPriority !== 0) return byPriority
    const leftAt = Date.parse(left.observedAt)
    const rightAt = Date.parse(right.observedAt)
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
      return leftAt - rightAt
    }
    return left.wakeId < right.wakeId ? -1 : left.wakeId > right.wakeId ? 1 : 0
  })
}