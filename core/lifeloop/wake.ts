import {
  WAKE_KIND_SOURCE,
  WAKE_SOURCE_ACTOR,
  isWakeKind,
  isWakeSource,
  justifiesCognition,
  wakePriority,
  type PendingSchedule,
  type WakeActor,
  type WakeEvent,
  type WakeKind,
  type WakeRefusalCode,
  type WakeSource,
  type WakeValidationOutcome,
} from './types'

/**
 * The Wake Source Registry.
 *
 * A closed registry of who may wake the Continuous Life Loop, and on what. It
 * answers exactly one question — *is this wake authorized, well-formed and due?*
 * — and it answers it before anything else runs, so that a wake which should
 * never have been raised costs nothing to refuse.
 *
 * Pure. No clock of its own, no journal, no provider, no capability. The caller
 * supplies the time and the already-authorized facts, and gets back the same
 * answer every time for the same inputs. That is what makes "no renderer may
 * drive the loop" a property of a table rather than of anybody's vigilance.
 */

/** The already-authorized facts a wake is judged against. */
export interface WakeValidationInput {
  /**
   * Who is claiming this wake, as Core assigned it.
   *
   * Never read from the wake's own payload. If the payload could name its own
   * source then the closed source set would be decorative.
   */
  readonly actor: WakeActor
  /** ISO instant, injected so validation is deterministic. */
  readonly now: string
  readonly stopAllActive: boolean
  readonly journalTrustworthy: boolean
  /** Where the loop currently is. Only `IDLE` and `WAIT` accept a wake. */
  readonly loopState: string
  /** Schedules registered and still pending. A heartbeat must name one of these. */
  readonly schedules?: readonly PendingSchedule[]
  /** Deterministic condition probe. Absent means "no condition to evaluate". */
  readonly conditionHolds?: (scheduleId: string) => boolean
  /** Stable dedupe keys already consumed, across restarts. */
  readonly processedWakeKeys?: readonly string[]
}

const WAKE_REFUSAL_REASONS: Readonly<Record<WakeRefusalCode, string>> = Object.freeze({
  'unknown-source': 'That is not a source Freya wakes from.',
  'unknown-kind': 'That is not a kind of event Freya wakes from.',
  'kind-source-mismatch':
    'That kind of event does not arrive from that source, so the wake was refused rather than relabelled.',
  'unauthorized-actor': 'That source may not be raised by the caller that raised it.',
  'missing-wake-id': 'The wake could not be identified, so it was refused.',
  'missing-kind': 'The wake did not say what kind of event it was, so it was refused.',
  'missing-source-reference':
    'That kind of wake must name the thing it is about, and did not.',
  'malformed-timestamp': 'The wake carried a timestamp that is not a time.',
  'observed-before-occurred':
    'The wake says it was observed before it happened, so it was refused rather than guessed at.',
  'stop-all-active': 'Freya is stopped. Nothing wakes while she is stopped.',
  'journal-not-trustworthy':
    "Freya's record of what happened could not be believed, so she will not act on anything new.",
  'duplicate-wake': 'That has already been looked at.',
  'loop-busy': 'Freya is already in the middle of something.',
  'awaiting-reset': 'The previous loop has not been closed out yet.',
  'unknown-schedule': 'That schedule is not registered, so it cannot fire.',
  'heartbeat-not-due': 'That schedule is not due yet.',
  'heartbeat-condition-unmet': 'That schedule is due, but its condition does not hold.',
})

/**
 * The refusal sentence for a code.
 *
 * Fixed sentences, never an interpolation of the rejected value. A refusal that
 * echoed the caller's own text would put an attacker's string into the journal
 * and into a log line, which is the one place untrusted text must never arrive.
 */
export function wakeRefusalReason(code: WakeRefusalCode): string {
  return WAKE_REFUSAL_REASONS[code]
}

/**
 * The stable key a wake is deduplicated on.
 *
 * Derived from the source, the kind and the reference — never from the wake id,
 * which is freshly minted per attempt and would therefore never deduplicate
 * anything. A retry of the same fact about the same thing collapses onto the
 * same key and is refused as a duplicate.
 */
export function wakeDedupeKey(wake: {
  readonly source: WakeSource
  readonly kind: WakeKind
  readonly sourceRef: string | null
  readonly goalRef: string | null
}): string {
  const reference = wake.sourceRef ?? wake.goalRef ?? 'none'
  return `${wake.source}|${wake.kind}|${reference}`
}

function denied(code: WakeRefusalCode): WakeValidationOutcome {
  return { outcome: 'denied', code, reason: wakeRefusalReason(code) }
}

function isIsoInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

/**
 * Validate a wake against the registry.
 *
 * The order of the checks is the contract, and it is checked in this order:
 *
 *   1. is the source one of the five;
 *   2. is the kind one of the fourteen, and does it belong to that source;
 *   3. does the wake carry the fields its kind requires;
 *   4. can the journal be believed;
 *   5. is STOP ALL clear;
 *   6. is the actor Core attributed allowed to raise that source;
 *   7. is the loop in a state that accepts a wake;
 *   8. has this exact wake already been consumed;
 *   9. for a heartbeat only: is the named schedule registered, due, and satisfied.
 *
 * (4) and (5) come before (6) and (9) on purpose. A stopped or untrustworthy
 * Freya reports the same thing to everybody, and does not evaluate schedule
 * conditions against state it should not be reading at all. The precedence
 * between (4) and (5) matches the Governor's, so the two gates never disagree
 * about why the same wake was refused.
 */
export function validateWake(
  wake: unknown,
  input: WakeValidationInput,
): WakeValidationOutcome {
  // (1) Source. Refusing here means an unauthenticated string never reaches the
  // rest of the pipeline, let alone a model.
  if (typeof wake !== 'object' || wake === null) {
    return denied('unknown-source')
  }
  const raw = wake as Record<string, unknown>
  const source = raw.source
  if (!isWakeSource(source)) return denied('unknown-source')

  // (2) Kind, and the kind/source pairing.
  const kind = raw.kind
  if (typeof kind !== 'string' || kind.length === 0) return denied('missing-kind')
  if (!isWakeKind(kind)) return denied('unknown-kind')
  if (WAKE_KIND_SOURCE[kind] !== source) return denied('kind-source-mismatch')

  // (3) Fields. The wake id must be present because the journal has to be able
  // to say which wake a later refusal was about.
  const wakeId = raw.wakeId
  if (typeof wakeId !== 'string' || wakeId.length === 0) return denied('missing-wake-id')
  if (raw.goalRef !== null && raw.goalRef !== undefined && typeof raw.goalRef !== 'string') {
    return denied('missing-source-reference')
  }
  const sourceRef = raw.sourceRef
  if (sourceRef !== null && sourceRef !== undefined && typeof sourceRef !== 'string') {
    return denied('missing-source-reference')
  }
  // Kinds that describe something happening to a thing must name the thing. A
  // `run-completed` with no run behind it cannot be acted on or audited.
  const requiresReference = source !== 'owner-interaction' && kind !== 'periodic-check'
  if (requiresReference && (typeof sourceRef !== 'string' || sourceRef.length === 0)) {
    return denied('missing-source-reference')
  }

  const occurredAt = raw.occurredAt
  const observedAt = raw.observedAt
  if (typeof occurredAt !== 'string' || !isIsoInstant(occurredAt)) return denied('malformed-timestamp')
  if (typeof observedAt !== 'string' || !isIsoInstant(observedAt)) return denied('malformed-timestamp')
  if (!isIsoInstant(input.now)) return denied('malformed-timestamp')
  // A wake cannot be observed before it happened. Either the clock moved
  // backwards or the event was fabricated, and both are refused rather than
  // clamped into something that looks plausible.
  if (Date.parse(observedAt) < Date.parse(occurredAt)) return denied('observed-before-occurred')

  // (4) Journal integrity, above everything.
  //
  // Checked *before* STOP ALL, and that order is not a preference: it is the
  // order `core/cognition/governor.ts` already uses, because a log with a hole
  // in it may have lost the very STOP ALL that would have refused this, so the
  // replayed latch cannot be trusted to be the whole latch. A life loop that
  // ranked the two the other way round would disagree with the gate beneath it
  // about why something was refused.
  if (!input.journalTrustworthy) return denied('journal-not-trustworthy')

  // (5) STOP ALL, above everything below it.
  if (input.stopAllActive) return denied('stop-all-active')

  // (6) Attribution. This is where a renderer, a model, an agent, a connector,
  // an external webhook and a self-scheduling timer all stop — and it sits below
  // the latch deliberately, so that a stopped Freya reports "stopped" to
  // everyone rather than answering differently depending on who asked.
  if (WAKE_SOURCE_ACTOR[source] !== input.actor) return denied('unauthorized-actor')

  // (7) Where the loop is. A wake into a running loop would stack a second
  // continuation onto the first; the loop is single-threaded by construction.
  if (input.loopState === 'DENY' || input.loopState === 'STOP') return denied('awaiting-reset')
  if (input.loopState !== 'IDLE' && input.loopState !== 'WAIT') return denied('loop-busy')

  const normalised: WakeEvent = {
    wakeId,
    source,
    kind,
    goalRef: typeof raw.goalRef === 'string' ? raw.goalRef : null,
    sourceRef: typeof sourceRef === 'string' ? sourceRef : null,
    occurredAt,
    observedAt,
  }
  const wakeKey = wakeDedupeKey(normalised)

  // (8) Deduplication, across restarts, from the durable key rather than from
  // memory — which is why the processed keys are an input and not a field.
  if ((input.processedWakeKeys ?? []).includes(wakeKey)) return denied('duplicate-wake')

  // (9) Heartbeat only. Every other source has already had its authority
  // established by (2) and (6); there is nothing left to defer.
  if (source === 'scheduled-heartbeat') {
    const scheduleId = normalised.sourceRef
    if (scheduleId === null) return denied('missing-source-reference')
    const schedule = (input.schedules ?? []).find((candidate) => candidate.scheduleId === scheduleId)
    if (schedule === undefined) return denied('unknown-schedule')
    const dueAt = Date.parse(schedule.dueAt)
    if (!Number.isFinite(dueAt)) return denied('unknown-schedule')
    if (dueAt > Date.parse(input.now)) {
      return {
        outcome: 'deferred',
        wake: normalised,
        wakeKey,
        code: 'heartbeat-not-due',
        reason: wakeRefusalReason('heartbeat-not-due'),
        // Deferred wakes never sleep forever: the deadline is the moment the
        // schedule is due, so a deferred wake cannot outlive its own reason.
        deadline: schedule.dueAt,
      }
    }
    const holds = input.conditionHolds?.(scheduleId) ?? false
    if (!holds) {
      return {
        outcome: 'deferred',
        wake: normalised,
        wakeKey,
        code: 'heartbeat-condition-unmet',
        reason: wakeRefusalReason('heartbeat-condition-unmet'),
        deadline: schedule.dueAt,
      }
    }
  }

  return { outcome: 'accepted', wake: normalised, wakeKey }
}

/**
 * Order a set of wakes for processing.
 *
 * Pure, and total: ties are broken by `occurredAt` and then by `wakeId`, so two
 * calls with the same input produce the same order. A non-deterministic tiebreak
 * would make "which wake did Freya answer first" unreproducible from the journal
 * alone, which is exactly the kind of unanswerable question this module exists to
 * avoid.
 */
export function orderWakes(wakes: readonly WakeEvent[]): readonly WakeEvent[] {
  return [...wakes].sort((left, right) => {
    const byPriority = wakePriority(left.source) - wakePriority(right.source)
    if (byPriority !== 0) return byPriority
    const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    if (byTime !== 0) return byTime
    return left.wakeId < right.wakeId ? -1 : left.wakeId > right.wakeId ? 1 : 0
  })
}

/**
 * Read a wake off an untrusted payload.
 *
 * Deliberately returns `null` for anything malformed rather than repairing it.
 * `validateWake` is the only place that decides whether a wake is acceptable,
 * and it needs to see the original value so it can refuse the *reason*.
 */
export function readWakePayload(payload: unknown): WakeEvent | null {
  if (typeof payload !== 'object' || payload === null) return null
  const raw = payload as Record<string, unknown>
  const nested = typeof raw.wake === 'object' && raw.wake !== null ? (raw.wake as Record<string, unknown>) : raw
  if (!isWakeSource(nested.source)) return null
  if (!isWakeKind(nested.kind)) return null
  if (typeof nested.wakeId !== 'string' || nested.wakeId.length === 0) return null
  if (typeof nested.occurredAt !== 'string') return null
  if (typeof nested.observedAt !== 'string') return null
  const sourceRef = typeof nested.sourceRef === 'string' ? nested.sourceRef : null
  const goalRef = typeof nested.goalRef === 'string' ? nested.goalRef : null
  return {
    wakeId: nested.wakeId,
    source: nested.source,
    kind: nested.kind,
    goalRef,
    sourceRef,
    occurredAt: nested.occurredAt,
    observedAt: nested.observedAt,
  }
}

/**
 * Re-exported so a caller can ask the same question the filter will ask.
 *
 * There is one implementation of "is this worth a model call", and it is
 * `justifiesCognition`. Anything that needed a second opinion would be a second
 * policy, and two policies is one more than this loop is allowed.
 */
export { justifiesCognition }