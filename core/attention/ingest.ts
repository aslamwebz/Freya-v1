/**
 * THE INGEST DOOR — how an event becomes an `AttentionEvent`, and what is refused.
 *
 * This file is the only place an untrusted payload becomes a domain value, so it is
 * where the "untrusted event text is data, never authority" rule is enforced rather
 * than described. Two things happen here and nowhere else:
 *
 *   1. **The source is assigned by Core.** A payload may not name one. The command
 *      layer fixes it to `owner`; an internal subsystem passes its own closed id.
 *      There is no field for a caller to claim `system`.
 *   2. **The text is sanitized into bounded data.** Control characters are
 *      stripped, whitespace is collapsed, and the string is truncated to the
 *      domain's ceiling. It is *never* parsed, matched against instructions, or
 *      returned as a reason for anything.
 *
 * Everything else — kind, references, due time, severity hint — is checked against
 * the closed vocabularies in `types.ts`. A malformed payload is refused whole
 * rather than repaired, for the Brain's reason: a silently repaired event looks
 * like valid attention about something slightly different.
 */

import {
  ATTENTION_LIMITS,
  isAttentionEventKind,
  isAttentionSource,
  isRef,
  isSeverityHint,
  instantMs,
  sanitizeEventText,
  type AttentionEvent,
  type AttentionEventKind,
  type AttentionSource,
  type SeverityHint,
} from './types'

export interface AttentionIngestInput {
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly text: string
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly severityHint: SeverityHint
  readonly dueAt: string | null
  readonly occurredAt: string
}

export interface NormalizedIngest {
  readonly event: AttentionEvent
  /**
   * The stable key replay dedupe uses.
   *
   * When a source supplies its own `sourceRef` — a run id, a mission id, a
   * schedule id — the key is derived from it, so a re-delivered or replayed event
   * is recognised across a restart. With no source ref, the key is the event id,
   * which is unique and therefore never dedupes: two owner reminders at the same
   * second are two reminders.
   */
  readonly dedupeKey: string
}

function readRef(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  if (!isRef(value)) return { ok: false }
  return { ok: true, value }
}

function readInstant(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  if (instantMs(value) === null) return { ok: false }
  return { ok: true, value: value as string }
}

/**
 * Validate a raw command payload into an ingest input.
 *
 * `source` is a parameter, never read from `payload`. The payload's `text` is
 * required and may be empty after sanitization only if the raw text was empty;
 * every other field is optional and bounded. An unexpected key is ignored rather
 * than refused, because the named fields are the entire contract and the journal
 * never sees this object — but a field the schema names with a bad value refuses
 * the whole ingest.
 */
export function parseIngestPayload(
  payload: unknown,
  source: AttentionSource,
  occurredAt: string,
): { ok: true; value: AttentionIngestInput } | { ok: false; reason: string } {
  if (!isAttentionSource(source)) return { ok: false, reason: 'the attention source is not authorized' }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'an attention event needs a payload object' }
  }
  const p = payload as Record<string, unknown>

  if (!isAttentionEventKind(p.kind)) {
    return { ok: false, reason: 'the event kind is not one attention understands' }
  }
  if (typeof p.text !== 'string') {
    return { ok: false, reason: 'an attention event needs text' }
  }
  const goal = readRef(p.goalRef)
  if (!goal.ok) return { ok: false, reason: 'the goal reference is malformed' }
  const sourceRef = readRef(p.sourceRef)
  if (!sourceRef.ok) return { ok: false, reason: 'the source reference is malformed' }
  const due = readInstant(p.dueAt)
  if (!due.ok) return { ok: false, reason: 'the due time is not an instant' }

  const hint = p.severityHint === undefined ? 'none' : p.severityHint
  if (!isSeverityHint(hint)) return { ok: false, reason: 'the severity hint is not a known level' }

  return {
    ok: true,
    value: {
      source,
      kind: p.kind,
      text: sanitizeEventText(p.text),
      goalRef: goal.value,
      sourceRef: sourceRef.value,
      severityHint: hint,
      dueAt: due.value,
      occurredAt,
    },
  }
}

/** Build the domain event and its dedupe key from a validated input. */
export function buildAttentionEvent(
  input: AttentionIngestInput,
  eventId: string,
  observedAt: string,
): NormalizedIngest {
  const text = sanitizeEventText(input.text)
  const event: AttentionEvent = {
    eventId,
    source: input.source,
    kind: input.kind,
    goalRef: input.goalRef,
    sourceRef: input.sourceRef,
    text,
    severityHint: input.severityHint,
    occurredAt: input.occurredAt,
    observedAt,
    dueAt: input.dueAt,
  }
  const dedupeKey =
    input.sourceRef === null
      ? `event:${eventId}`
      : `${input.source}:${input.kind}:${input.sourceRef}`.slice(0, ATTENTION_LIMITS.maxRefChars * 3)
  return { event, dedupeKey }
}

/**
 * Validate a schedule registration payload.
 *
 * The source is fixed to `system` when a schedule fires, so a schedule carries no
 * source of its own. The interval is bounded below and the repeat count above, so a
 * caller cannot ask for a schedule that fires every millisecond forever.
 */
export interface AttentionScheduleInput {
  readonly kind: AttentionEventKind
  readonly text: string
  readonly goalRef: string | null
  readonly severityHint: SeverityHint
  readonly dueAt: string
  readonly intervalMs: number | null
  readonly maxRepeats: number | null
  readonly condition: 'always' | 'focus-available' | 'goal-open'
}

export function parseSchedulePayload(
  payload: unknown,
): { ok: true; value: AttentionScheduleInput } | { ok: false; reason: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'a schedule needs a payload object' }
  }
  const p = payload as Record<string, unknown>

  if (!isAttentionEventKind(p.kind)) {
    return { ok: false, reason: 'the schedule kind is not one attention understands' }
  }
  if (typeof p.text !== 'string') return { ok: false, reason: 'a schedule needs text' }
  const goal = readRef(p.goalRef)
  if (!goal.ok) return { ok: false, reason: 'the goal reference is malformed' }
  const due = readInstant(p.dueAt)
  if (!due.ok || due.value === null) return { ok: false, reason: 'a schedule needs a due instant' }

  const hint = p.severityHint === undefined ? 'none' : p.severityHint
  if (!isSeverityHint(hint)) return { ok: false, reason: 'the severity hint is not a known level' }

  const condition = p.condition === undefined ? 'always' : p.condition
  if (condition !== 'always' && condition !== 'focus-available' && condition !== 'goal-open') {
    return { ok: false, reason: 'the schedule condition is not known' }
  }

  let intervalMs: number | null = null
  if (p.intervalMs !== undefined && p.intervalMs !== null) {
    if (typeof p.intervalMs !== 'number' || !Number.isInteger(p.intervalMs)) {
      return { ok: false, reason: 'the schedule interval is not a whole number of milliseconds' }
    }
    intervalMs = Math.max(ATTENTION_LIMITS.minScheduleIntervalMs, p.intervalMs)
  }

  let maxRepeats: number | null = 0
  if (intervalMs !== null) {
    const raw = p.maxRepeats === undefined ? 1 : p.maxRepeats
    if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1)) {
      return { ok: false, reason: 'the repeat count is not a positive whole number' }
    }
    maxRepeats = raw === null ? null : Math.min(ATTENTION_LIMITS.maxScheduleRepeats, raw as number)
  }

  return {
    ok: true,
    value: {
      kind: p.kind,
      text: sanitizeEventText(p.text),
      goalRef: goal.value,
      severityHint: hint,
      dueAt: due.value,
      intervalMs,
      maxRepeats,
      condition,
    },
  }
}
