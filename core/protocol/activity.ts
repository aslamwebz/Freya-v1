import type { CoreEventType } from '../events/envelope'

/**
 * Activity: the shell's read-only view of durable Core events.
 *
 * Core publishes these instead of exposing its event fabric to the renderer.
 * That boundary is the point. A renderer that could read `EventFabric` could
 * read the whole journal, including event ids, principal ids and correlation
 * ids — and, the moment a future event carried text, the prompts and responses
 * that went with it. This type is the entire contract, and it carries no field
 * that could hold a payload.
 *
 * The consequences are deliberate and are enforced by the mapping in
 * `describeActivity`:
 *
 * - **No command text, ever.** `command.received` becomes "A command was
 *   received" with a length. The journal has never held the text and neither
 *   does this.
 * - **No raw payloads.** Each entry is a fixed shape the Core chooses. Adding a
 *   field to an event does not automatically add it here.
 * - **Replay and live agree.** The same function maps an event whether it came
 *   off disk or off the fabric, so a renderer that attaches late sees the same
 *   list it would have seen had it been running the whole time.
 */

/**
 * The kinds of activity the shell can show.
 *
 * A closed set on purpose. An unrecognised event maps to `other` with its type
 * name preserved, so adding an event to Core degrades the activity list rather
 * than breaking it.
 */
export type ActivityKind =
  | 'core.started'
  | 'core.ready'
  | 'core.degraded'
  | 'integrity.fault'
  | 'command.received'
  | 'stop_all.activated'
  | 'stop_all.cleared'
  | 'cognition.allowed'
  | 'cognition.denied'
  | 'provider.started'
  | 'provider.completed'
  | 'provider.failed'
  | 'provider.cancelled'
  | 'grant.created'
  | 'grant.revoked'
  | 'other'

export interface CoreActivityEvent {
  /** Stable per event: `kind:sequence`. Two runs of the same log agree. */
  id: string
  kind: ActivityKind
  /** The event type as Core named it, for the detail view. */
  type: CoreEventType
  /** Durable sequence, so any row can be traced back to the journal. */
  sequence: number
  /** Epoch ms, taken from the event envelope, never from a UI clock. */
  at: number
  /** One sentence. Never contains command text, prompt text or a response. */
  text: string
  tone: 'neutral' | 'good' | 'busy' | 'warn' | 'bad'
}

/** How many entries a renderer may be handed at once. */
export const ACTIVITY_LIMIT = 60

/**
 * Map one durable event to at most one activity entry.
 *
 * Returns `null` for events that are not worth a line in the activity feed —
 * which is most of them. The journal records a great deal that no person wants
 * to read as news, and an activity feed that lists everything is a log file
 * with extra steps.
 */
export function describeActivity(event: {
  type: CoreEventType
  sequence: number
  at: number
  payload: Record<string, unknown>
}): CoreActivityEvent | null {
  const base = {
    id: `${event.type}:${event.sequence}`,
    type: event.type,
    sequence: event.sequence,
    at: event.at,
  }

  switch (event.type) {
    case 'core.started':
      return {
        ...base,
        kind: 'core.started',
        text: 'Core started.',
        tone: 'neutral',
      }

    case 'core.ready':
      return { ...base, kind: 'core.ready', text: 'Core ready.', tone: 'good' }

    case 'core.degraded':
      return {
        ...base,
        kind: 'core.degraded',
        text: `Core started degraded: ${text(event.payload.reason)}`,
        tone: 'bad',
      }

    case 'core.integrity_fault':
      return {
        ...base,
        kind: 'integrity.fault',
        text: `Event journal found corrupt at line ${number(event.payload.line, 0)}. Cognition stays refused until it is dealt with.`,
        tone: 'bad',
      }

    case 'command.received': {
      // The length is not a disclosure: it is how a person can tell an empty
      // submission from a pasted paragraph without the shell ever reading the
      // words themselves.
      const length = number(event.payload.contentLength, 0)
      return {
        ...base,
        kind: 'command.received',
        text:
          length > 0
            ? `Command received (${length} characters). Recorded, not yet acted on.`
            : 'Command received (empty).',
        tone: 'neutral',
      }
    }

    case 'security.stop_all.activated':
      return {
        ...base,
        kind: 'stop_all.activated',
        text: `STOP ALL activated: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'security.stop_all.cleared':
      return {
        ...base,
        kind: 'stop_all.cleared',
        text: 'STOP ALL cleared. Model requests can be authorised again.',
        tone: 'good',
      }

    case 'cognition.allowed': {
      const grant = event.payload.grantId
      return {
        ...base,
        kind: 'cognition.allowed',
        // An explicit user turn needs no grant, and saying "authorised by no
        // grant" would read as a problem where there is none.
        text:
          typeof grant === 'string' && grant.length > 0
            ? `Cognition authorised by grant ${grant}.`
            : 'Cognition authorised by an explicit user turn.',
        tone: 'neutral',
      }
    }

    case 'cognition.denied':
      return {
        ...base,
        kind: 'cognition.denied',
        text: `Cognition refused: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'cognition.authorization_required':
      return {
        ...base,
        kind: 'cognition.denied',
        text: `Cognition needs authorisation: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'model.request.started':
      return {
        ...base,
        kind: 'provider.started',
        text: `Model request started${modelSuffix(event.payload)}`,
        tone: 'busy',
      }

    case 'model.request.completed':
      return {
        ...base,
        kind: 'provider.completed',
        text: `Model request completed${modelSuffix(event.payload)}.`,
        tone: 'good',
      }

    case 'model.request.failed':
      return {
        ...base,
        kind: 'provider.failed',
        text: `Model request failed: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'model.request.cancelled':
      // The two cases read differently on purpose. One was stopped before it
      // cost anything; the other may already have been paid for, and saying
      // "cancelled" about that without qualification would be the most
      // reassuring lie in this feed.
      return {
        ...base,
        kind: 'provider.cancelled',
        text: event.payload.providerContacted
          ? `Model request cancelled after reaching the provider: ${text(event.payload.reason)}. Its usage is unknown, so the totals are a lower bound.`
          : `Model request cancelled before the provider was contacted: ${text(event.payload.reason)}. Nothing was spent.`,
        tone: 'warn',
      }

    case 'cognition.grant.created':
      return {
        ...base,
        kind: 'grant.created',
        text: `Grant ${text(event.payload.grantId)} created.`,
        tone: 'neutral',
      }

    case 'cognition.grant.revoked':
      return {
        ...base,
        kind: 'grant.revoked',
        text: `Grant ${text(event.payload.grantId)} revoked.`,
        tone: 'neutral',
      }

    default:
      // Kept, but not promoted to a headline: an event type nobody has given a
      // sentence yet still deserves a row rather than a silent gap.
      return { ...base, kind: 'other', text: event.type, tone: 'neutral' }
  }
}

/**
 * Fold a batch of activity events, newest last.
 *
 * Duplicate sequences are dropped rather than reordered, because a replayed log
 * and a live subscription can overlap and a feed that shows the same line twice
 * is worse than one that shows it once.
 */
export function mergeActivity(
  existing: readonly CoreActivityEvent[],
  incoming: readonly CoreActivityEvent[],
  limit = ACTIVITY_LIMIT,
): CoreActivityEvent[] {
  if (incoming.length === 0) return existing as CoreActivityEvent[]
  const seen = new Set(existing.map((item) => item.id))
  const added: CoreActivityEvent[] = []
  for (const item of incoming) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    added.push(item)
  }
  if (added.length === 0) return existing as CoreActivityEvent[]
  return [...existing, ...added].sort((a, b) => a.sequence - b.sequence).slice(-limit)
}

function text(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function modelSuffix(payload: Record<string, unknown>): string {
  const model = payload.model
  return typeof model === 'string' && model.length > 0 ? ` (${model})` : ''
}
