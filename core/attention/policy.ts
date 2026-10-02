/**
 * THE ATTENTION POLICY — deterministic importance, urgency and outcome.
 *
 * This is the whole of "how Freya decides whether to bother somebody", and it is a
 * pure function. It reads a closed table per event kind, caps what a source may
 * claim by that source's class, reads the passage of time only through an injected
 * `now`, and reads budgets and cooldowns from a bounded history. There is no model,
 * no randomness, no clock read, and no field of the event's text anywhere in it.
 *
 * ## The escalation ladder is code-owned
 *
 * A source may send a `severityHint`, but the hint can raise importance by at most
 * one level and never above the source's own cap. `interrupt` additionally requires
 * either a genuinely urgent due time or an urgent kind. That is what makes "forged
 * urgency" a bug this file cannot have rather than one it merely discourages: there
 * is no input a caller can supply that produces `interrupt` on its own.
 *
 * ## Budgets are caps, never refusals of memory
 *
 * A cooldown or an exhausted budget demotes an outcome down the ladder; it never
 * causes an event to be forgotten entirely unless the event was never salient. An
 * urgent event during a cooldown is still `remember`ed, so the information is not
 * lost — it is simply not allowed to shout.
 */

import {
  ATTENTION_LIMITS,
  importanceRank,
  isImportanceLevel,
  outcomeRank,
  urgencyRank,
  type AttentionCueCode,
  type AttentionEvent,
  type AttentionEventKind,
  type AttentionOutcome,
  type AttentionReason,
  type AttentionSource,
  type FocusState,
  type ImportanceLevel,
  type UrgencyLevel,
} from './types'

/* ---------------------------------------------------------- code-owned tables */

/**
 * The base importance of an event kind, before any source or hint.
 *
 * A table rather than a formula because the numbers are a product decision: a
 * failed run matters more than a finished one, and a reminder matters less than a
 * deadline. Writing them down makes them reviewable and testable.
 */
export const KIND_IMPORTANCE: Readonly<Record<AttentionEventKind, ImportanceLevel>> = Object.freeze({
  reminder: 'normal',
  deadline: 'high',
  'work-finished': 'low',
  'work-failed': 'high',
  'mission-finished': 'normal',
  'mission-failed': 'high',
  'research-finished': 'low',
  'system-health': 'high',
  'context-change': 'trivial',
  message: 'normal',
  calendar: 'normal',
})

/** The base urgency of an event kind, before any due time. */
export const KIND_URGENCY: Readonly<Record<AttentionEventKind, UrgencyLevel>> = Object.freeze({
  reminder: 'normal',
  deadline: 'elevated',
  'work-finished': 'background',
  'work-failed': 'elevated',
  'mission-finished': 'background',
  'mission-failed': 'elevated',
  'research-finished': 'background',
  'system-health': 'elevated',
  'context-change': 'background',
  message: 'normal',
  calendar: 'normal',
})

/**
 * The highest importance a source may reach, however it is phrased.
 *
 * `owner` is capped at `high`: the owner's UI is trusted to speak, but a person
 * typing "URGENT" is not a reason to interrupt them, and only Core's own system
 * health can reach `critical`. `research` is capped lower still, because a research
 * result is never a reason to interrupt.
 */
export const SOURCE_IMPORTANCE_CAP: Readonly<Record<AttentionSource, ImportanceLevel>> =
  Object.freeze({
    owner: 'high',
    mission: 'high',
    work: 'high',
    research: 'normal',
    context: 'low',
    system: 'critical',
  })

/** The cue label a kind maps to, when an outcome is expressive. */
export const KIND_CUE: Readonly<Record<AttentionEventKind, AttentionCueCode>> = Object.freeze({
  reminder: 'gentle-nudge',
  deadline: 'deadline-soon',
  'work-finished': 'task-finished',
  'work-failed': 'needs-attention',
  'mission-finished': 'task-finished',
  'mission-failed': 'needs-attention',
  'research-finished': 'status-update',
  'system-health': 'needs-attention',
  'context-change': 'status-update',
  message: 'status-update',
  calendar: 'deadline-soon',
})

/* ------------------------------------------------------------------ history */

/**
 * The bounded slice of history the policy may read.
 *
 * Only a source, a goal, an outcome and an instant. No text, no event id and no
 * importance — the policy needs to count what was *said* and *when*, and nothing
 * else, so there is nothing here for a caller to forge a score with.
 */
export interface AttentionHistoryEntry {
  readonly source: AttentionSource
  readonly goalRef: string | null
  readonly outcome: AttentionOutcome
  readonly at: string
}

export interface AttentionIngestHistoryEntry {
  readonly source: AttentionSource
  readonly at: string
}

export interface AttentionPolicyInput {
  readonly event: AttentionEvent
  readonly now: Date
  readonly focus: FocusState
  readonly stopAll: boolean
  readonly recentDecisions: readonly AttentionHistoryEntry[]
  readonly recentIngests: readonly AttentionIngestHistoryEntry[]
  /** True when this decision was produced by a due schedule rather than an ingest. */
  readonly scheduled: boolean
}

export interface AttentionPolicyResult {
  readonly importance: ImportanceLevel
  readonly urgency: UrgencyLevel
  readonly outcome: AttentionOutcome
  readonly reason: AttentionReason
  readonly cueCode: AttentionCueCode | null
}

/* ------------------------------------------------------------------ helpers */

function maxLevel<T extends string>(
  left: T,
  right: T,
  rank: (value: T) => number,
): T {
  return rank(right) > rank(left) ? right : left
}

function countWithin(
  entries: readonly AttentionHistoryEntry[],
  nowMs: number,
  predicate: (entry: AttentionHistoryEntry) => boolean,
): number {
  let count = 0
  for (const entry of entries) {
    const at = Date.parse(entry.at)
    if (!Number.isFinite(at)) continue
    if (nowMs - at > ATTENTION_LIMITS.budgetWindowMs) continue
    if (predicate(entry)) count += 1
  }
  return count
}

function lastWithin(
  entries: readonly AttentionHistoryEntry[],
  nowMs: number,
  windowMs: number,
  predicate: (entry: AttentionHistoryEntry) => boolean,
): number | null {
  let newest: number | null = null
  for (const entry of entries) {
    const at = Date.parse(entry.at)
    if (!Number.isFinite(at)) continue
    if (nowMs - at > windowMs) continue
    if (!predicate(entry)) continue
    if (newest === null || at > newest) newest = at
  }
  return newest
}

/** Importance from the kind table, capped by source, nudged at most one level. */
export function scoreImportance(event: AttentionEvent): ImportanceLevel {
  let level = KIND_IMPORTANCE[event.kind]
  if (event.severityHint === 'high') {
    const raised = importanceRank(level) + 1
    const ceiling = Math.min(raised, importanceRank(SOURCE_IMPORTANCE_CAP[event.source]))
    level = importanceRank(level) >= ceiling ? level : IMPORTANCE_LADDER[ceiling] ?? level
  }
  const cap = SOURCE_IMPORTANCE_CAP[event.source]
  return importanceRank(level) > importanceRank(cap) ? cap : level
}

const IMPORTANCE_LADDER: readonly ImportanceLevel[] = [
  'trivial',
  'low',
  'normal',
  'high',
  'critical',
]

/** Urgency from the kind table and the due time, nudged by a `high` hint. */
export function scoreUrgency(event: AttentionEvent, now: Date): UrgencyLevel {
  let level = KIND_URGENCY[event.kind]
  if (event.dueAt !== null) {
    const due = Date.parse(event.dueAt)
    if (Number.isFinite(due)) {
      const delta = due - now.getTime()
      if (delta <= ATTENTION_LIMITS.urgentWindowMs) {
        level = maxLevel(level, 'urgent' as UrgencyLevel, urgencyRank)
      } else if (delta <= ATTENTION_LIMITS.elevatedWindowMs) {
        level = maxLevel(level, 'elevated' as UrgencyLevel, urgencyRank)
      } else if (delta <= ATTENTION_LIMITS.normalWindowMs) {
        level = maxLevel(level, 'normal' as UrgencyLevel, urgencyRank)
      }
    }
  }
  if (event.severityHint === 'high') {
    level = maxLevel(level, 'elevated' as UrgencyLevel, urgencyRank)
  }
  return level
}

/** The outcome the raw score implies, before any focus, cooldown or budget. */
export function baseOutcome(importance: ImportanceLevel, urgency: UrgencyLevel): AttentionOutcome {
  const i = importanceRank(importance)
  const u = urgencyRank(urgency)
  if (u >= urgencyRank('urgent')) return 'interrupt'
  if (u >= urgencyRank('elevated') || i >= importanceRank('high')) return 'speak'
  if (i >= importanceRank('normal') || u >= urgencyRank('normal')) return 'subtle-cue'
  if (i >= importanceRank('low')) return 'remember'
  return 'do-nothing'
}

function outcomeReason(outcome: AttentionOutcome): AttentionReason {
  switch (outcome) {
    case 'do-nothing':
      return 'not-salient'
    case 'remember':
      return 'remembered'
    case 'subtle-cue':
      return 'cued'
    case 'speak':
      return 'spoke'
    case 'interrupt':
      return 'interrupted'
  }
}

/**
 * Decide one event's importance, urgency and outcome.
 *
 * Pure and total: every input produces a decision, and `do-nothing` is a normal
 * result rather than an error. The order of suppression is fixed and documented so
 * that two callers cannot reach different outcomes from the same history:
 * focus, then cooldown, then budget, then the scheduled-reason override.
 */
export function decideAttention(input: AttentionPolicyInput): AttentionPolicyResult {
  const { event, now, focus, stopAll } = input
  const nowMs = now.getTime()

  const importance = scoreImportance(event)
  const urgency = scoreUrgency(event, now)

  // STOP ALL is above every other consideration. Freya being stopped is not a
  // reason to shout louder; it is a reason to be silent.
  if (stopAll) {
    return { importance, urgency, outcome: 'do-nothing', reason: 'stop-all', cueCode: null }
  }

  const ingestedInWindow = input.recentIngests.filter((entry) => {
    const at = Date.parse(entry.at)
    return entry.source === event.source && Number.isFinite(at) && nowMs - at <= ATTENTION_LIMITS.budgetWindowMs
  }).length
  if (ingestedInWindow >= ATTENTION_LIMITS.maxIngestPerWindowPerSource) {
    return { importance, urgency, outcome: 'do-nothing', reason: 'rate-limit', cueCode: null }
  }

  let outcome = baseOutcome(importance, urgency)
  let reason = outcomeReason(outcome)

  const capTo = (cap: AttentionOutcome, why: AttentionReason): void => {
    if (outcomeRank(outcome) > outcomeRank(cap)) {
      outcome = cap
      reason = why
    }
  }

  // Focus awareness. A person who is visibly in the middle of something is not
  // interrupted for anything short of genuinely urgent, and even a `speak` becomes
  // a cue. `interrupt` survives only on `urgent`.
  if (focus === 'focused') {
    if (outcome === 'interrupt' && urgency !== 'urgent') capTo('speak', 'focus-suppressed')
    else if (outcome === 'speak') capTo('subtle-cue', 'focus-suppressed')
    else if (outcome === 'subtle-cue') capTo('remember', 'focus-suppressed')
  }

  // Cooldown, per source, measured from the most recent expressive decision. This
  // is absolute: a forged urgency cannot jump it, which is the whole point.
  const lastInterrupt = lastWithin(
    input.recentDecisions,
    nowMs,
    ATTENTION_LIMITS.cooldownAfterInterruptMs,
    (entry) => entry.source === event.source && entry.outcome === 'interrupt',
  )
  if (lastInterrupt !== null) {
    capTo('remember', 'cooldown')
  } else {
    const lastSpeak = lastWithin(
      input.recentDecisions,
      nowMs,
      ATTENTION_LIMITS.cooldownAfterSpeakMs,
      (entry) => entry.source === event.source && entry.outcome === 'speak',
    )
    if (lastSpeak !== null) capTo('subtle-cue', 'cooldown')
  }

  // Interruption budget, across all sources, per source, and per goal.
  const interruptsTotal = countWithin(
    input.recentDecisions,
    nowMs,
    (entry) => entry.outcome === 'interrupt',
  )
  const interruptsSource = countWithin(
    input.recentDecisions,
    nowMs,
    (entry) => entry.source === event.source && entry.outcome === 'interrupt',
  )
  const interruptsGoal =
    event.goalRef === null
      ? 0
      : countWithin(
          input.recentDecisions,
          nowMs,
          (entry) => entry.goalRef === event.goalRef && entry.outcome === 'interrupt',
        )
  if (
    interruptsTotal >= ATTENTION_LIMITS.maxInterruptsPerWindow ||
    interruptsSource >= ATTENTION_LIMITS.maxInterruptsPerWindowPerSource ||
    (event.goalRef !== null && interruptsGoal >= ATTENTION_LIMITS.maxInterruptsPerWindowPerGoal)
  ) {
    capTo('speak', 'budget')
  }

  // Speech budget, per source.
  const speaksSource = countWithin(
    input.recentDecisions,
    nowMs,
    (entry) => entry.source === event.source && entry.outcome === 'speak',
  )
  if (speaksSource >= ATTENTION_LIMITS.maxSpeaksPerWindowPerSource) {
    capTo('subtle-cue', 'budget')
  }

  // A due schedule's decision reads as scheduled unless a suppression already
  // explains why it was quieter than the score implied.
  if (input.scheduled && reason === outcomeReason(outcome)) {
    reason = 'scheduled'
  }

  const cueCode = outcomeRank(outcome) >= outcomeRank('subtle-cue') ? KIND_CUE[event.kind] : null
  return { importance, urgency, outcome, reason, cueCode }
}

/** Re-export for callers that want to validate a level without importing types. */
export { isImportanceLevel }
