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
/**
 * Importance, a category rather than a number.
 *
 * Categories for the Brain's reason: a numeric score invites arithmetic nobody can
 * audit, and "0.73 important" is not a fact a person can check. A closed ladder is.
 */
export const IMPORTANCE_LEVELS = ['trivial', 'low', 'normal', 'high', 'critical'] as const
export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number]
/** Urgency, the same discipline as importance. */
export const URGENCY_LEVELS = ['background', 'normal', 'elevated', 'urgent'] as const
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number]
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