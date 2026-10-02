import type { AnyCoreEvent } from '../events/envelope'
import type { OfficePresenceRequest } from './types'

/**
 * OFFICE STATE: the bounded set of presence requests.
 *
 * The Office owns almost no state. Its stations, history and layout are pure
 * functions of the Work, Workforce and status projections, which are themselves
 * folds over the journal. The one thing the Office owns is the set of pending
 * presence requests — the bounded record that the owner asked for an agent to
 * join the desktop Presence.
 *
 * ## Why this is a fold and not a plain set
 *
 * A presence request is a request the owner made, and a request the owner made
 * is an auditable fact. It is journalled as `office.presence.requested` and
 * replayed on every start, so a request survives a restart exactly like every
 * other durable fact in Core — and so a restart cannot quietly forget that the
 * owner asked.
 *
 * ## What a request is not
 *
 * A request is not a command to Presence. It carries a workerId and nothing
 * else: no principal, no authority, no capability, no expression, no position.
 * Whether and how the agent appears on the desktop is a Presence concern (Phase
 * 13), and this fold has no field that could influence it. The Office can ask,
 * and it can show that it asked, and it can do nothing else.
 */

export interface OfficeState {
  /** workerId → the pending request. Bounded by `OFFICE_LIMITS.maxPresenceRequests`. */
  readonly requests: ReadonlyMap<string, OfficePresenceRequest>
  /** Last durable sequence folded in. */
  readonly sequence: number
}

export function initialOfficeState(): OfficeState {
  return { requests: new Map(), sequence: 0 }
}

const OFFICE_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'office.presence.requested',
  'office.presence.fulfilled',
])

export function isOfficeEvent(type: string): boolean {
  return OFFICE_EVENT_TYPES.has(type)
}

export function reduceOfficeState(state: OfficeState, event: AnyCoreEvent): OfficeState {
  if (!isOfficeEvent(event.type)) {
    return event.sequence > state.sequence ? { ...state, sequence: event.sequence } : state
  }

  const payload = event.payload as Record<string, unknown>
  const workerId = readWorkerId(payload.workerId)
  if (workerId === null) return { ...state, sequence: event.sequence }

  switch (event.type) {
    case 'office.presence.requested': {
      const requests = new Map(state.requests)
      // One pending request per worker. A second request for the same worker
      // replaces the first rather than adding a duplicate, so a repeated ask
      // cannot grow the set without bound.
      requests.set(workerId, {
        workerId,
        requestedAt: event.occurredAt,
        fulfilled: false,
      })
      // Bounded: the oldest request is dropped past the ceiling, so a flood of
      // requests cannot grow the set without bound either.
      while (requests.size > 8) {
        const oldest = requests.keys().next().value
        if (oldest === undefined) break
        requests.delete(oldest)
      }
      return { requests, sequence: event.sequence }
    }

    case 'office.presence.fulfilled': {
      const existing = state.requests.get(workerId)
      if (existing === undefined) return { ...state, sequence: event.sequence }
      const requests = new Map(state.requests)
      requests.set(workerId, { ...existing, fulfilled: true })
      return { requests, sequence: event.sequence }
    }

    default:
      return { ...state, sequence: event.sequence }
  }
}

function readWorkerId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}
