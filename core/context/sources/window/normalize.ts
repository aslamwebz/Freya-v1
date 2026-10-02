import {
  WINDOW_OBSERVATION_LIMITS,
  type ActiveWindowInfo,
  type WindowObservationLimits,
  type WindowObservationReach,
} from './types'

/**
 * NORMALISATION — what this lane accepts from a provider, and nothing wider.
 *
 * A provider is host code, and host code gets the same suspicion the store
 * gives a caller's spec. Every string is scrubbed to one bounded line, the
 * reach must be one of the two honest words, and a record that cannot state a
 * non-empty app name with a real, non-future instant is not an observation —
 * it is dropped at the seam rather than admitted half-cleaned. An instant
 * claimed from the future is pinned to the read instant: an early claim is
 * late evidence, never a licence to be current before it was seen.
 *
 * Scrubbing happens here, once, so no downstream reader has to remember to
 * filter. What reaches a context item is already bounded reference knowledge —
 * and knowledge is not permission: this file hands over strings, never a uri,
 * never a permit.
 */

function scrub(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const collapsed = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (collapsed.length === 0) return null
  return collapsed.slice(0, Math.max(1, maxChars))
}

function isReach(value: unknown): value is WindowObservationReach {
  return value === 'own-app' || value === 'system'
}

/**
 * The provider's record as this lane will hold it, or null when the reading
 * cannot honestly describe a frontmost app/window. `expectedProviderId` is
 * enforced: a provider cannot report under somebody else's name.
 */
export function normalizeWindowInfo(
  info: ActiveWindowInfo,
  expectedProviderId: string,
  now: Date,
  limits: WindowObservationLimits,
): ActiveWindowInfo | null {
  if (info === null || typeof info !== 'object') return null
  if (!Number.isFinite(now.getTime())) return null

  const providerId = scrub(info.providerId, WINDOW_OBSERVATION_LIMITS.maxProviderIdChars)
  if (providerId === null || providerId !== expectedProviderId) return null

  const observationId = scrub(info.observationId, WINDOW_OBSERVATION_LIMITS.maxObservationIdChars)
  if (observationId === null) return null

  const appName = scrub(info.appName, limits.maxAppNameChars)
  if (appName === null) return null

  if (!isReach(info.reach)) return null

  const parsed = Date.parse(info.observedAt)
  if (!Number.isFinite(parsed)) return null
  const observedAt =
    parsed > now.getTime() ? now.toISOString() : new Date(parsed).toISOString()

  return {
    providerId,
    observationId,
    observedAt,
    reach: info.reach,
    appName,
    appIdentifier: scrub(info.appIdentifier, limits.maxAppNameChars),
    windowTitle: scrub(info.windowTitle, limits.maxTitleChars),
    isFullscreen: info.isFullscreen === true,
  }
}

/** Whether two readings describe the same front: identity, not identity-of-record. */
export function windowSpanKey(info: ActiveWindowInfo): string {
  return `${info.providerId}\u0000${info.reach}\u0000${info.appName}\u0000${info.windowTitle ?? ''}`
}
