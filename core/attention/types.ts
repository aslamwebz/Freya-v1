import { ATTENTION_CONDITIONS, ATTENTION_CUE_CODES, ATTENTION_EVENT_KINDS, ATTENTION_OUTCOMES, ATTENTION_REASONS, ATTENTION_SOURCES, FOCUS_STATES, IMPORTANCE_LEVELS, SEVERITY_HINTS, URGENCY_LEVELS, type AttentionCondition, type AttentionCueCode, type AttentionEventKind, type AttentionOutcome, type AttentionReason, type AttentionSource, type FocusState, type ImportanceLevel, type SeverityHint, type UrgencyLevel } from '../../shared/contracts/events/vocabulary/attention'
export { ATTENTION_CONDITIONS, ATTENTION_CUE_CODES, ATTENTION_EVENT_KINDS, ATTENTION_OUTCOMES, ATTENTION_REASONS, ATTENTION_SOURCES, FOCUS_STATES, IMPORTANCE_LEVELS, SEVERITY_HINTS, URGENCY_LEVELS } from '../../shared/contracts/events/vocabulary/attention'
export type { AttentionCondition, AttentionCueCode, AttentionEventKind, AttentionOutcome, AttentionReason, AttentionSource, FocusState, ImportanceLevel, SeverityHint, UrgencyLevel } from '../../shared/contracts/events/vocabulary/attention'


export function isAttentionOutcome(value: unknown): value is AttentionOutcome {
  return typeof value === 'string' && (ATTENTION_OUTCOMES as readonly string[]).includes(value)
}


/** An outcome's rank in the ladder. `do-nothing` is 0. */
export function outcomeRank(outcome: AttentionOutcome): number {
  return ATTENTION_OUTCOMES.indexOf(outcome)
}


export function isAttentionSource(value: unknown): value is AttentionSource {
  return typeof value === 'string' && (ATTENTION_SOURCES as readonly string[]).includes(value)
}


/** Closed reasons that may be persisted when a schedule stops without firing. */
export const ATTENTION_SCHEDULE_CANCEL_REASONS = [
  'owner-cancelled',
  'restart',
  'content-unavailable',
] as const

export type AttentionScheduleCancelReason = (typeof ATTENTION_SCHEDULE_CANCEL_REASONS)[number]


export function isAttentionScheduleCancelReason(value: unknown): value is AttentionScheduleCancelReason {
  return (
    typeof value === 'string' &&
    (ATTENTION_SCHEDULE_CANCEL_REASONS as readonly string[]).includes(value)
  )
}


export function isAttentionEventKind(value: unknown): value is AttentionEventKind {
  return typeof value === 'string' && (ATTENTION_EVENT_KINDS as readonly string[]).includes(value)
}


export function isImportanceLevel(value: unknown): value is ImportanceLevel {
  return typeof value === 'string' && (IMPORTANCE_LEVELS as readonly string[]).includes(value)
}


export function importanceRank(level: ImportanceLevel): number {
  return IMPORTANCE_LEVELS.indexOf(level)
}


export function isUrgencyLevel(value: unknown): value is UrgencyLevel {
  return typeof value === 'string' && (URGENCY_LEVELS as readonly string[]).includes(value)
}


export function urgencyRank(level: UrgencyLevel): number {
  return URGENCY_LEVELS.indexOf(level)
}


export function isSeverityHint(value: unknown): value is SeverityHint {
  return typeof value === 'string' && (SEVERITY_HINTS as readonly string[]).includes(value)
}


export function isFocusState(value: unknown): value is FocusState {
  return typeof value === 'string' && (FOCUS_STATES as readonly string[]).includes(value)
}


export function isAttentionReason(value: unknown): value is AttentionReason {
  return typeof value === 'string' && (ATTENTION_REASONS as readonly string[]).includes(value)
}


export function isAttentionCueCode(value: unknown): value is AttentionCueCode {
  return typeof value === 'string' && (ATTENTION_CUE_CODES as readonly string[]).includes(value)
}


export function isAttentionCondition(value: unknown): value is AttentionCondition {
  return typeof value === 'string' && (ATTENTION_CONDITIONS as readonly string[]).includes(value)
}


/* ------------------------------------------------------------------ limits */

export const ATTENTION_LIMITS = Object.freeze({
  /** The longest event text retained in memory. Never journalled, never projected. */
  maxEventTextChars: 1_000,
  /** How many retained events the in-memory inbox holds. */
  maxInboxEntries: 100,
  /**
   * How many recent decisions the fold keeps, for budgets and the projection.
   *
   * Sized to what one budget window can legitimately produce — every closed source
   * at its own ingest rate (6 × 60/hour) — so the history a cooldown or a budget
   * is measured against is never evicted inside the window that measures it.
   * Rate-limited refusals are journalled but not retained here; see `state.ts`.
   */
  maxRetainedDecisions: 384,
  /** How many dedupe keys the fold remembers. */
  maxSeenKeys: 512,
  /** How many schedules may exist at once. */
  maxSchedules: 64,
  /** The most times a repeating schedule may fire. */
  maxScheduleRepeats: 8,
  /** The shortest interval a repeating schedule may use. */
  minScheduleIntervalMs: 60_000,
  /** How far into the future a schedule may be set. */
  maxScheduleHorizonMs: 30 * 24 * 60 * 60 * 1_000,
  /** The rolling window budgets and rate limits are measured over. */
  budgetWindowMs: 60 * 60 * 1_000,
  /** Events accepted from one source in the rolling window. */
  maxIngestPerWindowPerSource: 60,
  /** `speak` outcomes allowed per source in the window. */
  maxSpeaksPerWindowPerSource: 4,
  /** `interrupt` outcomes allowed across all sources in the window. */
  maxInterruptsPerWindow: 2,
  /** `interrupt` outcomes allowed per source in the window. */
  maxInterruptsPerWindowPerSource: 1,
  /** `interrupt` outcomes allowed per goal in the window. */
  maxInterruptsPerWindowPerGoal: 1,
  /** Suppression after an interrupt, per source. */
  cooldownAfterInterruptMs: 10 * 60 * 1_000,
  /** Suppression after a speak, per source. */
  cooldownAfterSpeakMs: 2 * 60 * 1_000,
  /** A due time this close makes an event urgent. */
  urgentWindowMs: 5 * 60 * 1_000,
  /** A due time this close makes an event elevated. */
  elevatedWindowMs: 60 * 60 * 1_000,
  /** A due time this close makes an event at least normal. */
  normalWindowMs: 24 * 60 * 60 * 1_000,
  /** Bounds on an opaque reference. */
  maxRefChars: 128,
})


/* ------------------------------------------------------------------ shapes */

/**
 * One authorized event, as the domain holds it.
 *
 * `text` is **data**: it is retained in memory so a later phase can read it back
 * through an explicit owner detail read, and it is never written to the journal,
 * never projected, never parsed as an instruction and never read by the policy.
 * `source` is assigned by Core and is never taken from an untrusted payload.
 */
export interface AttentionEvent {
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly text: string
  readonly severityHint: SeverityHint
  readonly occurredAt: string
  readonly observedAt: string
  /** Optional absolute time this event becomes urgent. */
  readonly dueAt: string | null
}


/**
 * One retained event plus the outcome Core reached about it.
 *
 * This lives in the engine's in-memory inbox for the life of the process. The
 * `event.text` is never written down and never projected; it comes back only from
 * an explicit owner detail read. `outcome` is null only in the instant before a
 * decision is recorded.
 */
export interface AttentionInboxEntry {
  readonly event: AttentionEvent
  readonly outcome: AttentionOutcome | null
}


/** A decision the policy reached about one event. */
export interface AttentionDecision {
  readonly decisionId: string
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly importance: ImportanceLevel
  readonly urgency: UrgencyLevel
  readonly outcome: AttentionOutcome
  readonly reason: AttentionReason
  readonly cueCode: AttentionCueCode | null
  readonly focus: FocusState
  readonly decidedAt: string
}


/** One schedule, as the domain holds it. */
export interface AttentionSchedule {
  readonly scheduleId: string
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly text: string
  readonly severityHint: SeverityHint
  readonly dueAt: string
  readonly intervalMs: number | null
  /** Null repeats until cancelled; numeric schedules keep the existing ceiling. */
  readonly maxRepeats: number | null
  readonly condition: AttentionCondition
  readonly createdAt: string
}


/** A schedule's life in state, including how many times it has fired. */
export interface AttentionScheduleRecord extends AttentionSchedule {
  readonly repeats: number
  readonly status: 'pending' | 'fired' | 'cancelled' | 'expired'
}


/* --------------------------------------------------------------- utilities */

/** Whether a string is a bounded opaque reference id. */
export function isRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ATTENTION_LIMITS.maxRefChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}


/**
 * Sanitize event text into bounded, control-character-free data.
 *
 * This is not a security boundary on its own — the text is never authority — but
 * it keeps a pathological payload from becoming a 4MB in-memory string and keeps
 * terminal control sequences out of anything that might later render it. It never
 * *interprets* the text, and it never returns `null` for content: hostile text is
 * still data, and refusing it would hide the attempt.
 */
export function sanitizeEventText(value: unknown): string {
  if (typeof value !== 'string') return ''
  // Strip C0/C1 control characters except tab/newline, then collapse whitespace
  // runs. Written as a code-point filter rather than a control-character regex so
  // the intent is explicit and the linter's no-control-regex rule is not fighting
  // the one place control characters are the point.
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const isControl =
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    if (isControl) continue
    out += character
  }
  const collapsed = out.replace(/\s+/g, ' ').trim()
  return collapsed.length > ATTENTION_LIMITS.maxEventTextChars
    ? collapsed.slice(0, ATTENTION_LIMITS.maxEventTextChars)
    : collapsed
}


/** Whether a string parses as an instant. No clock read, no repair. */
export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}