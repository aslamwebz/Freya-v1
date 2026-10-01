import {
  CONTEXT_LIMITS,
  type ContextAdmission,
  type ContextScope,
} from '../../types'
import {
  WINDOW_OBSERVATION_LIMITS,
  type ActiveWindowInfo,
} from './types'

/**
 * THE CANDIDATE ADAPTER — an observation becomes a request to hold, or nothing.
 *
 * This is the whole crossing between the capture lane and the Context store,
 * and it is a pure function over an already-normalised observation: it states
 * what the host saw as bounded reference knowledge, cites the observation as
 * its origin, and expires on the observation's own TTL. It adds nothing the
 * reading did not contain, and three absences are load-bearing:
 *
 *  - **no `uri`.** The store's `uri` is "a name, not a permit", and a permit
 *    is exactly what a window observation cannot justify — so the field is
 *    null, permanently, and the candidate says in its own content what it is
 *    *not*: no pixels, no document contents, no hands.
 *  - **no owner voice.** `source` is `host_report`, full stop — an "I selected
 *    the active window" claim would launder sensing into consent, and the
 *    kind table refuses it anyway; this file simply never offers it.
 *  - **no extended memory.** The TTL is what the lane's limits already
 *    clamped, restated at the boundary where a caller could otherwise widen
 *    it; admission's own clamp backstops this, and nobody gets more.
 *
 * The returned record is a *request*: the store still refuses it for any
 * reason of its own — this adapter has no power to admit.
 */

export interface ActiveWindowCandidateOptions {
  /** Clamped to `[1, CONTEXT_LIMITS.maxTtlMs]` — never honoured above it. */
  readonly ttlMs?: number | null
}

function originIdOf(observation: ActiveWindowInfo): string {
  const origin = `${observation.providerId}:${observation.observationId}`
  return origin.slice(0, CONTEXT_LIMITS.maxOriginIdChars)
}

function labelOf(observation: ActiveWindowInfo): string {
  const joined =
    observation.windowTitle === null
      ? observation.appName
      : `${observation.appName} — ${observation.windowTitle}`
  return joined.slice(0, CONTEXT_LIMITS.maxLabelChars)
}

function contentOf(observation: ActiveWindowInfo): string {
  const where =
    observation.reach === 'system' ? 'frontmost app' : 'focused Freya window'
  const title =
    observation.windowTitle === null ? '' : ` — "${observation.windowTitle}"`
  const full = observation.isFullscreen ? ', fullscreen' : ''
  return (
    `Host observation (provider ${observation.providerId}, ${observation.observedAt}): ` +
    `the ${where} is ${observation.appName}${title}${full}. ` +
    'Identity metadata only — no pixels, no document contents, no control.'
  ).slice(0, CONTEXT_LIMITS.maxContentChars)
}

/**
 * The `ContextAdmission` for a normalised active-window observation.
 *
 * `capturedAt` is the observation's instant (pinned non-future by the
 * normaliser, and the store refuses future captures again at this door);
 * `originId` names the specific observation so "the host saw it" points at
 * the record behind it; and the whole candidate is safe to hand to any
 * consumer of `ContextAdmission` without widening what was observed.
 */
export function activeWindowCandidate(
  observation: ActiveWindowInfo,
  scope: ContextScope,
  options: ActiveWindowCandidateOptions = {},
): ContextAdmission {
  const requested = options.ttlMs
  const ttlMs =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), WINDOW_OBSERVATION_LIMITS.maxTtlMs)
      : WINDOW_OBSERVATION_LIMITS.defaultTtlMs
  return {
    kind: 'active_window',
    source: 'host_report',
    scope,
    content: contentOf(observation),
    label: labelOf(observation),
    uri: null,
    originId: originIdOf(observation),
    capturedAt: observation.observedAt,
    ttlMs,
  }
}
