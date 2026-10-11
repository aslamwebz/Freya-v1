/**
 * ATTENTION STATE — the fold of the durable `attention.*` events.
 *
 * Same rule as every other subsystem in this repository: there is no mutable state
 * that is not the journal's image. Budgets, cooldowns, dedupe keys and schedules
 * are all *derived* from events, which is what makes them survive a restart without
 * a second store and without a hidden preference on disk.
 *
 * ## What is not here
 *
 * The event **text** is deliberately absent. The journal is metadata only — ids,
 * closed labels, counts, instants and measured lengths — so the fold cannot hold a
 * private sentence even if it wanted to. The in-memory inbox in `engine.ts` holds
 * the text for the life of the process and is never written down, which is the same
 * bargain Work makes with a step's input.
 *
 * ## Bounded
 *
 * `seenKeys` and `decisions` are capped, because a fold that grew with every event
 * would be a memory leak shaped like a security feature. Two rules make the caps
 * safe rather than merely small:
 *
 *  - A `rate-limit` decision is journalled for the audit, but it is *not* retained
 *    in `decisions`. It is a `do-nothing`, and the policy reads this list only for
 *    cooldowns and budgets — outcomes that shouted. Retaining flood decisions
 *    would let a source that is already rate-limited push the history that caps
 *    *other* sources' interrupts out of the fold, which is exactly what the caps
 *    below promise cannot happen.
 *  - `maxRetainedDecisions` covers the most this fold can legally receive in one
 *    budget window — every closed source at its own ingest rate — so a budget
 *    never loses the history it needs within one window.
 */

import type { AnyCoreEvent } from '../events/envelope'
import {
  ATTENTION_LIMITS,
  type AttentionCueCode,
  type AttentionEventKind,
  type AttentionOutcome,
  type AttentionReason,
  type AttentionScheduleRecord,
  type AttentionSource,
  type FocusState,
  type ImportanceLevel,
  type UrgencyLevel,
} from './types'

export interface AttentionDecisionRecord {
  readonly decisionId: string
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly outcome: AttentionOutcome
  readonly importance: ImportanceLevel
  readonly urgency: UrgencyLevel
  readonly reason: AttentionReason
  readonly cueCode: AttentionCueCode | null
  readonly focus: FocusState
  readonly decidedAt: string
}

export interface AttentionCounts {
  readonly ingested: number
  readonly decisions: number
  readonly doNothing: number
  readonly remembered: number
  readonly cued: number
  readonly spoke: number
  readonly interrupted: number
  readonly budgetExceeded: number
}

/** One ingest instant per source, so the rate limit survives a restart. */
export interface AttentionIngestRecord {
  readonly source: AttentionSource
  readonly at: string
}

export interface AttentionState {
  readonly seenKeys: readonly string[]
  readonly decisions: readonly AttentionDecisionRecord[]
  readonly ingests: readonly AttentionIngestRecord[]
  readonly schedules: readonly AttentionScheduleRecord[]
  readonly counts: AttentionCounts
}

export function initialAttentionState(): AttentionState {
  return {
    seenKeys: [],
    decisions: [],
    ingests: [],
    schedules: [],
    counts: {
      ingested: 0,
      decisions: 0,
      doNothing: 0,
      remembered: 0,
      cued: 0,
      spoke: 0,
      interrupted: 0,
      budgetExceeded: 0,
    },
  }
}

function pushBounded<T>(list: readonly T[], value: T, max: number): readonly T[] {
  const next = [...list, value]
  return next.length > max ? next.slice(next.length - max) : next
}

/** True when this exact ingest has already been folded. */
export function hasSeenKey(state: AttentionState, key: string): boolean {
  return state.seenKeys.includes(key)
}

/** The decisions the policy may read, newest last, already bounded by the fold. */
export function recentDecisions(state: AttentionState): readonly AttentionDecisionRecord[] {
  return state.decisions
}

export function pendingSchedules(state: AttentionState): readonly AttentionScheduleRecord[] {
  return state.schedules.filter((schedule) => schedule.status === 'pending')
}

function countOutcome(counts: AttentionCounts, outcome: AttentionOutcome): AttentionCounts {
  switch (outcome) {
    case 'do-nothing':
      return { ...counts, doNothing: counts.doNothing + 1 }
    case 'remember':
      return { ...counts, remembered: counts.remembered + 1 }
    case 'subtle-cue':
      return { ...counts, cued: counts.cued + 1 }
    case 'speak':
      return { ...counts, spoke: counts.spoke + 1 }
    case 'interrupt':
      return { ...counts, interrupted: counts.interrupted + 1 }
  }
}

/**
 * Fold one durable event into attention state.
 *
 * Only `attention.*` events change it; everything else returns the same object, so
 * this can be called for every event in the log without cost.
 */
export function reduceAttention(state: AttentionState, event: AnyCoreEvent): AttentionState {
  switch (event.type) {
    case 'attention.event.ingested':
      return {
        ...state,
        seenKeys: pushBounded(state.seenKeys, event.payload.dedupeKey, ATTENTION_LIMITS.maxSeenKeys),
        ingests: pushBounded(
          state.ingests,
          { source: event.payload.source, at: event.occurredAt },
          ATTENTION_LIMITS.maxSeenKeys,
        ),
        counts: { ...state.counts, ingested: state.counts.ingested + 1 },
      }

    case 'attention.decision.made': {
      const record: AttentionDecisionRecord = {
        decisionId: event.payload.decisionId,
        eventId: event.payload.eventId,
        source: event.payload.source,
        kind: event.payload.kind,
        goalRef: event.payload.goalRef,
        outcome: event.payload.outcome,
        importance: event.payload.importance,
        urgency: event.payload.urgency,
        reason: event.payload.reason,
        cueCode: event.payload.cueCode,
        focus: event.payload.focus,
        decidedAt: event.occurredAt,
      }
      return {
        ...state,
        // A rate-limit `do-nothing` is written for the audit but never retained:
        // the policy reads this list only for cooldowns and budgets, so a flood of
        // refused events must not be able to evict the history that enforces them.
        decisions:
          event.payload.reason === 'rate-limit'
            ? state.decisions
            : pushBounded(state.decisions, record, ATTENTION_LIMITS.maxRetainedDecisions),
        counts: {
          ...countOutcome(state.counts, record.outcome),
          decisions: state.counts.decisions + 1,
        },
      }
    }

    case 'attention.budget.exceeded':
      return {
        ...state,
        counts: { ...state.counts, budgetExceeded: state.counts.budgetExceeded + 1 },
      }

    case 'attention.schedule.registered': {
      const record: AttentionScheduleRecord = {
        scheduleId: event.payload.scheduleId,
        kind: event.payload.kind,
        goalRef: event.payload.goalRef,
        text: '',
        severityHint: event.payload.severityHint,
        dueAt: event.payload.dueAt,
        intervalMs: event.payload.intervalMs,
        maxRepeats: event.payload.maxRepeats,
        condition: event.payload.condition,
        createdAt: event.occurredAt,
        repeats: 0,
        status: 'pending',
      }
      const without = state.schedules.filter((schedule) => schedule.scheduleId !== record.scheduleId)
      const pending = without.filter(schedule => schedule.status === 'pending')
      if (pending.length >= ATTENTION_LIMITS.maxSchedules) return state
      const terminal = without.filter(schedule => schedule.status !== 'pending')
      const remaining = ATTENTION_LIMITS.maxSchedules - pending.length - 1
      return { ...state, schedules: [...(remaining > 0 ? terminal.slice(-remaining) : []), ...pending, record] }
    }

    case 'attention.schedule.fired': {
      return {
        ...state,
        schedules: state.schedules.map((schedule) => {
          if (schedule.scheduleId !== event.payload.scheduleId) return schedule
          const repeats = schedule.repeats + 1
          const due = Date.parse(schedule.dueAt)
          const exhausted = schedule.intervalMs === null || (schedule.maxRepeats !== null && repeats >= schedule.maxRepeats)
          const interval = schedule.intervalMs ?? 0
          const observed = Date.parse(event.occurredAt)
          const advance = schedule.maxRepeats === null && interval > 0
            ? Math.max(1, Math.floor((observed - due) / interval) + 1) * interval
            : interval
          const nextDue =
            exhausted
              ? schedule.dueAt
              : new Date((Number.isFinite(due) ? due : observed) + advance).toISOString()
          return { ...schedule, repeats, dueAt: nextDue, status: exhausted ? 'fired' : 'pending' }
        }),
      }
    }

    case 'attention.schedule.cancelled':
      return {
        ...state,
        schedules: state.schedules.map((schedule) =>
          schedule.scheduleId === event.payload.scheduleId
            ? { ...schedule, status: 'cancelled' }
            : schedule,
        ),
      }

    default:
      return state
  }
}
