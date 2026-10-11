import type {
  AttentionCondition,
  AttentionCueCode,
  AttentionEventKind,
  AttentionOutcome,
  AttentionReason,
  AttentionSource,
  FocusState,
  ImportanceLevel,
  SeverityHint,
  UrgencyLevel,
} from '../vocabulary/attention.ts'

export const ATTENTION_EVENT_TYPES = [
// Attention (Phase 12) — metadata only, and the family where "do nothing" is a
  // first-class outcome rather than an absence.
  //
  // An attention event describes *that an authorized source delivered something*
  // and *what Core decided about it*. There is no slot for the event's text: the
  // text is process-local data, never written here, and comes back only from an
  // explicit owner detail read. Every field is an id, a closed label, an instant or
  // a measured length.
  //
  // None of these is a security event. A decision cannot grant cognition, clear a
  // stop or widen a permission, and a budget that ran out says nothing about the
  // authority to run anything — the same argument that keeps `work.*` and
  // `brain.degraded` out of `SECURITY_EVENT_TYPES`.
  'attention.event.ingested',
'attention.decision.made',
'attention.budget.exceeded',
'attention.schedule.registered',
'attention.schedule.fired',
'attention.schedule.cancelled',
] as const

export interface AttentionEventPayloads {
/* ------------------------------------------------------------- attention */

  /**
   * An authorized source delivered an event.
   *
   * `dedupeKey` is the stable key replay uses: derived from the source's own
   * `sourceRef` when it has one, so a re-delivered event is recognised across a
   * restart. `textLength` is a measurement — the text is not here and never will
   * be. `source` is assigned by Core and is not a value a payload can supply.
   */
  'attention.event.ingested': {
    eventId: string
    dedupeKey: string
    source: AttentionSource
    kind: AttentionEventKind
    goalRef: string | null
    textLength: number
    severityHint: SeverityHint
    occurredAt: string
    dueAt: string | null
  }

/**
   * Core reached a decision about one event.
   *
   * Every field is a closed label. `do-nothing` is written here like any other
   * outcome, because a decision not to act is a decision and a journal that only
   * recorded the loud ones would misrepresent how often Freya stays quiet.
   */
  'attention.decision.made': {
    decisionId: string
    eventId: string
    source: AttentionSource
    kind: AttentionEventKind
    goalRef: string | null
    outcome: AttentionOutcome
    importance: ImportanceLevel
    urgency: UrgencyLevel
    reason: AttentionReason
    cueCode: AttentionCueCode | null
    focus: FocusState
  }

/** A code-owned ceiling demoted an outcome. Recorded so a restart cannot hide it. */
  'attention.budget.exceeded': {
    source: AttentionSource
    goalRef: string | null
    limit: string
    observed: number
  }

/**
   * A schedule was registered.
   *
   * Metadata only, like everything else here. The schedule's text is process-local;
   * a schedule recovered from the journal after a restart therefore cannot fire and
   * is cancelled with a stated reason instead.
   */
  'attention.schedule.registered': {
    scheduleId: string
    kind: AttentionEventKind
    goalRef: string | null
    severityHint: SeverityHint
    dueAt: string
    intervalMs: number | null
    maxRepeats: number | null
    condition: AttentionCondition
  }

/** A due schedule fired. One event, one fact; the resulting ingest follows. */
  'attention.schedule.fired': {
    scheduleId: string
    eventId: string
    repeats: number
  }

'attention.schedule.cancelled': {
    scheduleId: string
    reason: string
  }
}