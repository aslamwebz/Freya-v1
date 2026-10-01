import type {
  ContextAdmission,
  ContextAdmissionResult,
  ContextScope,
} from '../../types'
import { activeWindowCandidate } from './candidate'
import type { ActiveWindowInfo } from './types'

/**
 * THE ADMISSION RUNTIME — where an observation lane meets a context store.
 *
 * It is deliberately shaped around a *sink the caller already controls*, never
 * a store it constructs: the Context domain belongs to Core, and an observation
 * lane that carried its own store would be a second source of truth wearing a
 * borrowed coat. `WindowAdmissionSink` is exactly the two methods of
 * `ContextStore` this lane may use — `admit` and `revoke` — and nothing else.
 *
 * Two properties make the lane safe to wire:
 *
 *  - **One live active-window item per scope, by construction.** Windows
 *    change focus; a store full of last-ten-title-bars would resolve "here"
 *    as `ambiguous` forever. When a new observation is admitted, the previous
 *    one this runtime admitted is revoked — which *destroys its content*
 *    rather than quietly deprioritising it, so the words about the old window
 *    stop existing the moment the new one exists. Only ids this runtime
 *    minted are ever revoked; it never reaches for somebody else's records.
 *  - **Refusals are kept, not swallowed.** If admission refuses (a future
 *    capture, a bad scope, a lying origin), the refusal result is returned
 *    and the previous state stands. The lane reports; it does not insist.
 *
 * Revocation reason is a fixed sentence, not a string built from window text —
 * a tombstone that quoted a title bar would smuggle the private part back
 * onto the inspectable surface.
 */

/** The slice of `ContextStore` this lane may use. Structural on purpose. */
export interface WindowAdmissionSink {
  admit(spec: ContextAdmission, now: Date): ContextAdmissionResult
  revoke(contextId: string, reason: string, now: Date): boolean
}

export const ACTIVE_WINDOW_SUPERSESSION_REASON =
  'superseded by a newer host window observation'

export interface ActiveWindowAdmitterOptions {
  readonly sink: WindowAdmissionSink
  readonly scope: ContextScope
  readonly clock?: () => Date
  /** Forwarded to the candidate; clamped at the domain ceiling, never honoured above it. */
  readonly ttlMs?: number | null
}

/**
 * A one-shot observer listener that admits current observations and takes the
 * superseded one back. Returns the admission result — ok or refusal — so a
 * host can report what happened without the lane owning any reporting.
 */
export function createActiveWindowAdmitter(
  options: ActiveWindowAdmitterOptions,
): (observation: ActiveWindowInfo, now?: Date) => ContextAdmissionResult {
  const clock = options.clock ?? ((): Date => new Date())
  let lastAdmittedId: string | null = null

  return (observation, now) => {
    const at = now ?? clock()
    const result = options.sink.admit(
      activeWindowCandidate(observation, options.scope, { ttlMs: options.ttlMs }),
      at,
    )
    if (!result.ok) return result

    const previous = lastAdmittedId
    lastAdmittedId = result.item.contextId
    if (previous !== null && previous !== result.item.contextId) {
      options.sink.revoke(previous, ACTIVE_WINDOW_SUPERSESSION_REASON, at)
    }
    return result
  }
}
