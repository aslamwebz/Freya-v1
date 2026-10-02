/**
 * THE ATTENTION PROTOCOL — what a window may know about events and attention.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a
 * renderer is typed against, one frozen projection for a Core with no Attention
 * domain, and the outcome vocabulary of the few commands that exist. Nothing here
 * is writable by a window in the sense that matters: a window may submit an event
 * and ask for a schedule, and it may not name its own source, choose an importance,
 * assert an urgency, decide an outcome, spend an interruption budget, bypass a
 * cooldown or reach a model.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: counts, the focus reading Core derived, the last decision as metadata,
 * at most one bounded directive for Presence to draw, inbox item *metadata* (ids,
 * source, kind, measured length, instants), and schedule *metadata*.
 *
 * Does not cross: the event **text** (it stays in Core and comes back only from an
 * explicit `attention.inbox.read`), any source's own claim of severity beyond the
 * closed hint Core already bounded, any budget figure a window could raise, and —
 * because none exists in this vocabulary — any capability, grant, permission or
 * model parameter.
 *
 * ## The two absences, kept apart
 *
 * `'unavailable'` with `NO_ATTENTION_DOMAIN_REASON` means *this build has no
 * Attention domain and none is simulated*. `null` from the host means *no Core has
 * started yet*. Rendering the first as "nothing needs attention" would be telling a
 * person they are caught up when nothing is watching at all.
 */

import type {
  AttentionCueCode,
  AttentionEventKind,
  AttentionOutcome,
  AttentionReason,
  AttentionSource,
  FocusState,
  ImportanceLevel,
  SeverityHint,
  UrgencyLevel,
} from '../attention/types'

/* ----------------------------------------------------------------- views */

/**
 * One decision, as metadata.
 *
 * Every field is an id, a closed label or an instant Core assigned. There is no
 * text and no free-form reason sentence, so a window holding this holds a report
 * about a decision rather than the decision's material.
 */
export interface AttentionDecisionView {
  readonly decisionId: string
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly outcome: AttentionOutcome
  readonly importance: ImportanceLevel
  readonly urgency: UrgencyLevel
  readonly reason: AttentionReason
  readonly cueCode: AttentionCueCode | null
  readonly focus: FocusState
  readonly decidedAt: string
}

/**
 * The one expressive decision Presence may draw.
 *
 * Bounded to a single object by construction: `AttentionProjection` has one
 * `directive` slot. `cueCode` is a code-owned label, never the event's words, so
 * drawing this is drawing *that Core decided to cue* rather than reproducing
 * content. Only `subtle-cue`, `speak` and `interrupt` can appear here; a
 * `do-nothing` or `remember` is never surfaced as a gesture.
 */
export interface AttentionDirectiveView {
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly outcome: Extract<AttentionOutcome, 'subtle-cue' | 'speak' | 'interrupt'>
  readonly cueCode: AttentionCueCode | null
  readonly importance: ImportanceLevel
  readonly urgency: UrgencyLevel
  readonly decidedAt: string
}

/**
 * One retained event, as metadata.
 *
 * `textLength` is a measurement, exactly like a conversation turn's
 * `contentLength`: enough for an operator to see that something substantial
 * arrived, and not one character of it. The text itself is available only from an
 * explicit `attention.inbox.read`.
 */
export interface AttentionInboxItemView {
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly severityHint: SeverityHint
  readonly textLength: number
  readonly observedAt: string
  readonly dueAt: string | null
  readonly outcome: AttentionOutcome | null
}

/** One schedule, as metadata. No text, no condition internals beyond the label. */
export interface AttentionScheduleView {
  readonly scheduleId: string
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly dueAt: string
  readonly intervalMs: number | null
  readonly maxRepeats: number
  readonly repeats: number
  readonly condition: 'always' | 'focus-available' | 'goal-open'
  readonly status: 'pending' | 'fired' | 'cancelled' | 'expired'
}

export interface AttentionCountsView {
  readonly ingested: number
  readonly decisions: number
  readonly doNothing: number
  readonly remembered: number
  readonly cued: number
  readonly spoke: number
  readonly interrupted: number
  readonly budgetExceeded: number
}

/** The ceilings this projection was built under, so a window can show them. */
export interface AttentionLimitsView {
  readonly maxInboxEntries: number
  readonly maxSchedules: number
  readonly maxInterruptsPerWindow: number
  readonly maxSpeaksPerWindowPerSource: number
  readonly cooldownAfterInterruptMs: number
  readonly budgetWindowMs: number
}

/**
 * Everything a window may know about attention, in one read-only object.
 *
 * A mirror, in the same sense as every other subsystem's: Core builds it, a window
 * holds what Core last sent, and nothing a window can do writes a field of it.
 * `sequence` lets a window prove *which* Core state it is looking at.
 */
export interface AttentionProjection {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly schemaVersion: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
  /** What Core derived from already-authorized state. Never a guess. */
  readonly focus: FocusState
  readonly counts: AttentionCountsView
  readonly lastDecision: AttentionDecisionView | null
  /** The one gesture Presence may draw, or null when Core chose none. */
  readonly directive: AttentionDirectiveView | null
  readonly inbox: readonly AttentionInboxItemView[]
  readonly schedules: readonly AttentionScheduleView[]
  readonly limits: AttentionLimitsView
}

/**
 * One retained event's private detail, for the owner's explicit read.
 *
 * This is the counterpart to the metadata projection, and the reason the inbox
 * exists at all: the owner can read back what arrived, and a standing feed cannot.
 * It never enters a projection, the journal or an activity row.
 */
export interface AttentionEventDetail {
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly text: string
  readonly severityHint: SeverityHint
  readonly observedAt: string
  readonly dueAt: string | null
  readonly outcome: AttentionOutcome | null
}

/* ------------------------------------------------------------- read-back */

export type AttentionOperation = 'status' | 'ingested' | 'scheduled' | 'cancelled' | 'detail' | 'refused'

/**
 * What an attention command produced.
 *
 * `refused` is an outcome rather than an exception everywhere: a missing event, a
 * bad payload and a Core that is not up all answer in words, and none is papered
 * over. The `decision` slot carries the outcome of *this* command, never a second
 * copy of the projection — the projection arrives on its own channel.
 */
export interface AttentionCommandOutcome {
  readonly operation: AttentionOperation
  readonly ok: boolean
  /** Why the answer could not be had, in words. Never evidence, never a stack. */
  readonly reason?: string
  /** Present when an ingest produced a decision. */
  readonly decision?: AttentionDecisionView
  /** Present on an explicit `attention.inbox.read`. The owner's own content. */
  readonly detail?: AttentionEventDetail
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has no Attention domain.
 *
 * `unavailable`, never `ready` with empty counts: "nothing needs attention" and
 * "nothing is watching for events" are different facts, and a surface that
 * rendered the second as the first would be telling a person they are caught up
 * when Freya is not listening at all.
 */
export const ABSENT_ATTENTION_PROJECTION: AttentionProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported an Attention domain yet',
  schemaVersion: 1,
  sequence: 0,
  focus: 'unknown' as const,
  counts: Object.freeze({
    ingested: 0,
    decisions: 0,
    doNothing: 0,
    remembered: 0,
    cued: 0,
    spoke: 0,
    interrupted: 0,
    budgetExceeded: 0,
  }),
  lastDecision: null,
  directive: null,
  inbox: Object.freeze([]) as readonly AttentionInboxItemView[],
  schedules: Object.freeze([]) as readonly AttentionScheduleView[],
  limits: Object.freeze({
    maxInboxEntries: 0,
    maxSchedules: 0,
    maxInterruptsPerWindow: 0,
    maxSpeaksPerWindowPerSource: 0,
    cooldownAfterInterruptMs: 0,
    budgetWindowMs: 0,
  }),
})

/**
 * The sentence Core reports when nothing has built an Attention domain.
 *
 * Exported so the host, the surface and the tests quote the same words instead of
 * paraphrasing the absence into four slightly different claims.
 */
export const NO_ATTENTION_DOMAIN_REASON =
  'this Core has no Attention domain: no event is watched, and none is simulated'

/** The projection schema this lane speaks. */
export const ATTENTION_SCHEMA_VERSION = 1

/** The sentence a window gets when a payloadless read carried something. */
export const ATTENTION_NO_PAYLOAD =
  'attention.status.read carries no payload: a window may ask what Core decided and may not supply a source, an importance, an urgency or an outcome'
