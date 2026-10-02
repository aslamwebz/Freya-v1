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
 * would be a memory leak shaped like a security feature. The caps are generous
 * relative to the rolling window the policy reads, so a budget decision never loses
 * the history it needs within one window.
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
        decisions: pushBounded(state.decisions, record, ATTENTION_LIMITS.maxRetainedDecisions),
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
      return { ...state, schedules: pushBounded(without, record, ATTENTION_LIMITS.maxSchedules) }
    }

    case 'attention.schedule.fired': {
      return {
        ...state,
        schedules: state.schedules.map((schedule) => {
          if (schedule.scheduleId !== event.payload.scheduleId) return schedule
          const repeats = schedule.repeats + 1
          const due = Date.parse(schedule.dueAt)
          const nextDue =
            schedule.intervalMs === null || repeats >= schedule.maxRepeats
              ? schedule.dueAt
              : new Date((Number.isFinite(due) ? due : Date.parse(event.occurredAt)) + schedule.intervalMs).toISOString()
          const exhausted = schedule.intervalMs === null || repeats >= schedule.maxRepeats
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
