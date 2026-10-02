/**
 * THE ATTENTION PROJECTION — Core's only route from attention facts to a window.
 *
 * A pure function over the folded state, the engine's in-memory inbox and the one
 * directive the engine decided to surface. It exists so that the vocabulary a
 * renderer receives is *derived* rather than assembled: the engine supplies domain
 * values, and this function decides — in one place, testable without a Core — which
 * fields may cross and which may not.
 *
 * ## What never crosses at all
 *
 * `event.text` is not a field of `AttentionInboxItemView`, so it is not read here:
 * what arrived stays in Core, and a window learns only its length. A decision's
 * reason is a closed code, never a sentence. The directive is a single bounded
 * object with a code-owned cue label, so a renderer can draw *that attention was
 * drawn* and cannot reproduce the event or invent an urgency.
 *
 * ## Nothing is invented
 *
 * `health` is `'ready'` because a caller that reached this function *has* an
 * Attention domain; the `'unavailable'` half is `ABSENT_ATTENTION_PROJECTION`. A
 * `null` `directive` means Core chose no gesture, which is the ordinary case and
 * must not be rendered as a gesture that was suppressed.
 */

import {
  ATTENTION_SCHEMA_VERSION,
  type AttentionDecisionView,
  type AttentionDirectiveView,
  type AttentionInboxItemView,
  type AttentionProjection,
  type AttentionScheduleView,
} from '../protocol/attention'
import {
  ATTENTION_LIMITS,
  type AttentionInboxEntry,
  type FocusState,
  outcomeRank,
} from './types'
import type { AttentionState } from './state'

export { ABSENT_ATTENTION_PROJECTION, NO_ATTENTION_DOMAIN_REASON } from '../protocol/attention'

/** How many recent decisions the projection lists. Enough to see the pattern. */
const PROJECTED_DECISIONS = 24

export interface AttentionProjectionInput {
  /** Highest sequence folded in. Absent reads as `0`, never as an estimate. */
  readonly sequence?: number
  readonly state: AttentionState
  readonly inbox: readonly AttentionInboxEntry[]
  readonly focus: FocusState
  /** The engine's current gesture, or null when Core chose none. Never replayed. */
  readonly directive: AttentionDirectiveView | null
}

function decisionView(record: AttentionState['decisions'][number]): AttentionDecisionView {
  return {
    decisionId: record.decisionId,
    eventId: record.eventId,
    source: record.source,
    kind: record.kind,
    outcome: record.outcome,
    importance: record.importance,
    urgency: record.urgency,
    reason: record.reason,
    cueCode: record.cueCode,
    focus: record.focus,
    decidedAt: record.decidedAt,
  }
}

function inboxView(entry: AttentionInboxEntry): AttentionInboxItemView {
  return {
    eventId: entry.event.eventId,
    source: entry.event.source,
    kind: entry.event.kind,
    goalRef: entry.event.goalRef,
    severityHint: entry.event.severityHint,
    textLength: entry.event.text.length,
    observedAt: entry.event.observedAt,
    dueAt: entry.event.dueAt,
    outcome: entry.outcome,
  }
}

function scheduleView(schedule: AttentionState['schedules'][number]): AttentionScheduleView {
  return {
    scheduleId: schedule.scheduleId,
    kind: schedule.kind,
    goalRef: schedule.goalRef,
    dueAt: schedule.dueAt,
    intervalMs: schedule.intervalMs,
    maxRepeats: schedule.maxRepeats,
    repeats: schedule.repeats,
    condition: schedule.condition,
    status: schedule.status,
  }
}

/**
 * Build the projection a window may hold.
 *
 * Pure: same input, same output, no clock read and no randomness. `now` is never
 * consulted because nothing here is derived from the passage of time — instants
 * arrive on the records themselves.
 */
export function projectAttention(input: AttentionProjectionInput): AttentionProjection {
  const decisions = input.state.decisions
  const last = decisions.length === 0 ? null : decisions[decisions.length - 1]

  // The directive is trusted only if it is genuinely expressive; a caller that
  // handed back a `do-nothing` in the directive slot is refused rather than
  // rendered as a gesture.
  const directive =
    input.directive !== null && outcomeRank(input.directive.outcome) >= outcomeRank('subtle-cue')
      ? input.directive
      : null

  return {
    health: 'ready',
    reason: null,
    schemaVersion: ATTENTION_SCHEMA_VERSION,
    sequence: input.sequence ?? 0,
    focus: input.focus,
    counts: { ...input.state.counts },
    lastDecision: last === undefined || last === null ? null : decisionView(last),
    directive,
    inbox: input.inbox.map(inboxView),
    schedules: input.state.schedules.map(scheduleView),
    limits: {
      maxInboxEntries: ATTENTION_LIMITS.maxInboxEntries,
      maxSchedules: ATTENTION_LIMITS.maxSchedules,
      maxInterruptsPerWindow: ATTENTION_LIMITS.maxInterruptsPerWindow,
      maxSpeaksPerWindowPerSource: ATTENTION_LIMITS.maxSpeaksPerWindowPerSource,
      cooldownAfterInterruptMs: ATTENTION_LIMITS.cooldownAfterInterruptMs,
      budgetWindowMs: ATTENTION_LIMITS.budgetWindowMs,
    },
  }
}

/** The most recent decisions, newest first, bounded for a window. */
export function recentDecisionViews(state: AttentionState): readonly AttentionDecisionView[] {
  const start = Math.max(0, state.decisions.length - PROJECTED_DECISIONS)
  return state.decisions.slice(start).reverse().map(decisionView)
}
