/**
 * THE ATTENTION DOMAIN — Phase 12's vocabulary.
 *
 * This file is types and closed tables only: no I/O, no clock read, no model, no
 * randomness. It is the shape everything else in `core/attention/` is built from,
 * so the policy, the ingest door, the schedule table and the projection can all
 * depend on it without depending on each other.
 *
 * ## What attention is, and is not
 *
 * Attention is the decision *whether an authorized event is worth Freya's
 * interrupting somebody for*. It is not a second intelligence and it is not a
 * notification centre with opinions: the importance, the urgency, the budget, the
 * cooldown and the focus reading are **code-owned**, deterministic, and derived
 * from closed tables in this file. An event's own text is *data*; it is never
 * authority, never an instruction, and never a value the policy reads to decide
 * anything.
 *
 * ## The five outcomes, and why "do nothing" is first
 *
 * ```
 *   do-nothing < remember < subtle-cue < speak < interrupt
 * ```
 *
 * `do-nothing` is a first-class, well-tested outcome, not the absence of one. Most
 * events should produce it, and the policy is written so that escalation requires a
 * code-owned reason rather than merely a source saying "this is urgent".
 *
 * ## What is deliberately absent
 *
 * - **No authority field.** There is no `capability`, `grant`, `allowed`,
 *   `override`, `bypassGuard` or `spend` anywhere in this vocabulary. An attention
 *   decision cannot mint a capability, widen a permission, clear STOP ALL or reach
 *   a model. Adding such a field would be a visible contract change.
 * - **No free-form urgency from an untrusted source.** A source may carry a
 *   bounded `severityHint`, but it is a *hint* the policy caps by source class and
 *   event kind. It cannot by itself produce `interrupt`.
 * - **No mental-state claim.** Focus is a bounded reading derived only from
 *   already-authorized Core state; there is no "mood", "stress" or "attention
 *   score" field, because Core cannot know those.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count, both
 * stated in `ATTENTION_LIMITS`. Unbounded "attention state" is how a notification
 * system quietly becomes a log of everything that ever happened.
 */

/* ------------------------------------------------------------- vocabularies */

/**
 * The closed outcome ladder, ordered from least to most disruptive.
 *
 * The order is load-bearing: `capOutcome` in `policy.ts` uses it to demote an
 * escalation that a budget, a cooldown or a focus reading refuses, and the
 * projection renders outcomes by index so two windows cannot disagree about which
 * one is louder.
 */
export const ATTENTION_OUTCOMES = [
  'do-nothing',
  'remember',
  'subtle-cue',
  'speak',
  'interrupt',
] as const
export type AttentionOutcome = (typeof ATTENTION_OUTCOMES)[number]

export function isAttentionOutcome(value: unknown): value is AttentionOutcome {
  return typeof value === 'string' && (ATTENTION_OUTCOMES as readonly string[]).includes(value)
}

/** An outcome's rank in the ladder. `do-nothing` is 0. */
export function outcomeRank(outcome: AttentionOutcome): number {
  return ATTENTION_OUTCOMES.indexOf(outcome)
}

/**
 * The sources authorized to hand attention an event.
 *
 * A **closed** set, and deliberately small. `owner` is the person's own UI;
 * `mission`, `work`, `research` and `context` are Core-owned subsystems; `system`
 * is Core's own health and lifecycle. There is no `renderer`, no `model`, no
 * `connector` and no `agent` source in this phase: a window that could name its own
 * source could launder an untrusted page's text in as a Core fact, and a model is
 * not an event source at all.
 *
 * The renderer's only ingestion route is the `attention.event.ingest` command,
 * where Core fixes the source to `owner` and never reads one from the payload.
 */
export const ATTENTION_SOURCES = [
  'owner',
  'mission',
  'work',
  'research',
  'context',
  'system',
] as const
export type AttentionSource = (typeof ATTENTION_SOURCES)[number]

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

/**
 * The kinds of event attention understands.
 *
 * A closed vocabulary, because the kind is what selects the base importance and
 * urgency in `policy.ts`. A free-form kind would let a caller pick its own
 * importance by naming an event something alarming.
 */
export const ATTENTION_EVENT_KINDS = [
  'reminder',
  'deadline',
  'work-finished',
  'work-failed',
  'mission-finished',
  'mission-failed',
  'research-finished',
  'system-health',
  'context-change',
  'message',
  'calendar',
] as const
export type AttentionEventKind = (typeof ATTENTION_EVENT_KINDS)[number]

export function isAttentionEventKind(value: unknown): value is AttentionEventKind {
  return typeof value === 'string' && (ATTENTION_EVENT_KINDS as readonly string[]).includes(value)
}

/**
 * Importance, a category rather than a number.
 *
 * Categories for the Brain's reason: a numeric score invites arithmetic nobody can
 * audit, and "0.73 important" is not a fact a person can check. A closed ladder is.
 */
export const IMPORTANCE_LEVELS = ['trivial', 'low', 'normal', 'high', 'critical'] as const
export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number]

export function isImportanceLevel(value: unknown): value is ImportanceLevel {
  return typeof value === 'string' && (IMPORTANCE_LEVELS as readonly string[]).includes(value)
}

export function importanceRank(level: ImportanceLevel): number {
  return IMPORTANCE_LEVELS.indexOf(level)
}

/** Urgency, the same discipline as importance. */
export const URGENCY_LEVELS = ['background', 'normal', 'elevated', 'urgent'] as const
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number]

export function isUrgencyLevel(value: unknown): value is UrgencyLevel {
  return typeof value === 'string' && (URGENCY_LEVELS as readonly string[]).includes(value)
}

export function urgencyRank(level: UrgencyLevel): number {
  return URGENCY_LEVELS.indexOf(level)
}

/**
 * A source's bounded hint about severity.
 *
 * This is the *only* urgency-shaped value a source may supply, and it is untrusted
 * by construction: the policy raises importance by at most one level for a hint,
 * and only up to the source class's own cap. `high` from the owner cannot make a
 * reminder `critical`, and no hint can produce `interrupt` without a due time or a
 * genuinely urgent kind.
 */
export const SEVERITY_HINTS = ['none', 'low', 'normal', 'high'] as const
export type SeverityHint = (typeof SEVERITY_HINTS)[number]

export function isSeverityHint(value: unknown): value is SeverityHint {
  return typeof value === 'string' && (SEVERITY_HINTS as readonly string[]).includes(value)
}

/**
 * The focus reading, derived only from already-authorized Core state.
 *
 * `focused` means the person is in the middle of something Freya can see through a
 * door that already exists (an explicit turn or running work). It is used to
 * *suppress* interruption for anything that is not genuinely urgent. `away` is in
 * the vocabulary for a future authorized signal; this phase never produces it.
 */
export const FOCUS_STATES = ['focused', 'available', 'away', 'unknown'] as const
export type FocusState = (typeof FOCUS_STATES)[number]

export function isFocusState(value: unknown): value is FocusState {
  return typeof value === 'string' && (FOCUS_STATES as readonly string[]).includes(value)
}

/**
 * Closed decision reasons.
 *
 * A reason is a code, never a sentence, so a decision can be counted, compared and
 * asserted on. The projection prints the code and the surface maps it to words.
 */
export const ATTENTION_REASONS = [
  'stop-all',
  'duplicate',
  'rate-limit',
  'cooldown',
  'budget',
  'focus-suppressed',
  'not-salient',
  'remembered',
  'cued',
  'spoke',
  'interrupted',
  'scheduled',
  'condition-unmet',
  'owner-requested',
] as const
export type AttentionReason = (typeof ATTENTION_REASONS)[number]

export function isAttentionReason(value: unknown): value is AttentionReason {
  return typeof value === 'string' && (ATTENTION_REASONS as readonly string[]).includes(value)
}

/**
 * Code-owned cue labels a Presence renderer may draw.
 *
 * The raw event text never crosses to a window. What crosses for a `subtle-cue`,
 * `speak` or `interrupt` is one of these closed labels, chosen by Core from the
 * event kind. A renderer can therefore show *that* attention was drawn and *what
 * class* of thing it was about, and cannot invent the urgency or the words.
 */
export const ATTENTION_CUE_CODES = [
  'gentle-nudge',
  'deadline-soon',
  'task-finished',
  'needs-attention',
  'status-update',
  'all-clear',
] as const
export type AttentionCueCode = (typeof ATTENTION_CUE_CODES)[number]

export function isAttentionCueCode(value: unknown): value is AttentionCueCode {
  return typeof value === 'string' && (ATTENTION_CUE_CODES as readonly string[]).includes(value)
}

/**
 * The conditions a scheduled attention may wait on.
 *
 * A closed set evaluated against already-authorized state, never against the
 * event's text and never against a model. `always` fires when due; `focus-available`
 * waits until the person is not `focused`; `goal-open` waits while the referenced
 * goal is still present in Core's own Mission/Work state.
 */
export const ATTENTION_CONDITIONS = ['always', 'focus-available', 'goal-open'] as const
export type AttentionCondition = (typeof ATTENTION_CONDITIONS)[number]

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
  readonly maxRepeats: number
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
