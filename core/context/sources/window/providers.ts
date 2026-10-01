import { WINDOW_OBSERVATION_LIMITS } from './types'
import type {
  ActiveWindowAvailability,
  ActiveWindowProvider,
  ActiveWindowReading,
  WindowObservationReach,
} from './types'

/**
 * THE HONEST DEFAULT PROVIDERS.
 *
 * A capture lane is only safe if its *off* states are real objects, not
 * missing ones. These two providers let any host wire the lane without having
 * — or inventing — a sensing capability:
 *
 *  - `unsupported` is a build or platform fact that does not change by
 *    polling: the source starts, hears it, and stops touching the provider.
 *    A host with no read-only OS foreground source wires this and is telling
 *    the truth; the service treats it as terminal, so "we cannot see" never
 *    degrades into a silent repeated attempt.
 *  - `unavailable` is a moment, not a verdict — a provider that *could*
 *    observe but has nothing to report right now. The source keeps the lane
 *    open and lets the held observation expire honestly.
 *
 * Neither one reaches outward: `read` is a pure refusal, no capture, no model,
 * and the returned reason is scrubbed and bounded like any other string.
 */

function scrubReason(reason: unknown): string {
  if (typeof reason !== 'string') return 'not stated'
  const collapsed = reason.replace(/\s+/gu, ' ').trim().slice(0, WINDOW_OBSERVATION_LIMITS.maxReasonChars)
  return collapsed.length > 0 ? collapsed : 'not stated'
}

function refusedReading(
  availability: Exclude<ActiveWindowAvailability, 'ready'>,
  reason: string,
): ActiveWindowReading {
  return { availability, window: null, reason }
}

export interface HonestProviderOptions {
  readonly providerId: string
  readonly reach?: WindowObservationReach
  readonly reason?: string
}

/** A provider that states the lane is not available in this build at all. */
export function createUnsupportedProvider(options: HonestProviderOptions): ActiveWindowProvider {
  const reason = scrubReason(options.reason ?? 'this build has no active-window provider')
  return {
    providerId: options.providerId,
    reach: options.reach ?? 'own-app',
    availability: () => 'unsupported',
    read: () => refusedReading('unsupported', reason),
  }
}

/** A provider that could observe, and honestly says there is nothing right now. */
export function createUnavailableProvider(options: HonestProviderOptions): ActiveWindowProvider {
  const reason = scrubReason(options.reason ?? 'no active window to report right now')
  return {
    providerId: options.providerId,
    reach: options.reach ?? 'own-app',
    availability: () => 'unavailable',
    read: () => refusedReading('unavailable', reason),
  }
}
