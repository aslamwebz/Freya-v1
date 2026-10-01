import { CONTEXT_LIMITS } from '../../types'

/**
 * ACTIVE-APP / WINDOW OBSERVATION — the Phase 9 capture lane (issue #30).
 *
 * This is the vocabulary for the only sensing Context permits: a host-side,
 * explicitly opt-in reading of *which application and window identity is in
 * front*. The foundation declared `active_window` and refused it until the
 * capture lane existed; this lane is that capture lane, and the lane is a
 * seam, not a sensor:
 *
 *  - **identity and safe metadata only** — an app name, an optional bounded
 *    window title, an optional identifier, and a fullscreen boolean. Never
 *    pixels, never document contents, never an accessibility tree;
 *  - **observation is not permission** — there is no field here a downstream
 *    reader could mistake for a capability, the admitted item carries no URI,
 *    and the candidate's own words say so (Constitution C3 at the capture
 *    edge);
 *  - **opt-in only** — nothing is read until `start()` is called on a source
 *    somebody constructed, a disabled source polls nothing and holds nothing,
 *    and a platform with no honest read-only way to know says `unsupported`
 *    instead of inventing an observation;
 *  - **bounded and dumb** — a cadence floor so no host is hammered, an event
 *    mode that needs no polling at all, and not one call that could reach a
 *    model: keeping window context current costs zero inference.
 *
 * Nothing in this directory imports Electron. The OS-facing side is a provider
 * the desktop host injects through {@link ActiveWindowProvider}; on this build
 * the only honest providers are one that sees Freya's own focused window
 * (read-only, already available) and the stated-unsupported system seam.
 */

/* ------------------------------------------------------------------ facts */

/**
 * How far a provider's reach honestly extends.
 *
 * `own-app` means the provider can only see *Freya's* windows — that is all
 * plain Electron offers without a native helper, and pretending otherwise
 * would be a claim the build cannot keep. `system` is reserved for a future
 * host that has a real, read-only OS foreground source; nothing in this lane
 * can make a `system` provider appear.
 */
export const WINDOW_OBSERVATION_REACHES = ['own-app', 'system'] as const
export type WindowObservationReach = (typeof WINDOW_OBSERVATION_REACHES)[number]

/** What one honest reading of the frontmost app/window can state. */
export interface ActiveWindowInfo {
  /** Who reported this — a bounded name that becomes part of the provenance. */
  readonly providerId: string
  /** Stable id for this reading; the origin a context item must be able to name. */
  readonly observationId: string
  /** ISO instant of the reading. Normalisation pins future claims to now. */
  readonly observedAt: string
  /** How far the reporting provider's sight honestly reaches. */
  readonly reach: WindowObservationReach
  /** The application's display name — the one field an observation needs. */
  readonly appName: string
  /** A bundle id or executable name when the host can name it safely, else null. */
  readonly appIdentifier: string | null
  /** The window title, bounded and scrubbed — a title bar's words, nothing more. */
  readonly windowTitle: string | null
  /** Whether the window is fullscreen. A fact about a frame, not its contents. */
  readonly isFullscreen: boolean
}

/** Whether the host could honestly report the active window right now. */
export const ACTIVE_WINDOW_AVAILABILITIES = ['ready', 'unavailable', 'unsupported'] as const
export type ActiveWindowAvailability = (typeof ACTIVE_WINDOW_AVAILABILITIES)[number]

/**
 * The provider's answer to one read.
 *
 * `ready` must carry a window; the source drops a `ready` reading that does
 * not, rather than inventing one. `unavailable` means the provider *could*
 * observe but has nothing to report at this instant (no window is focused).
 * `unsupported` means this build or platform has no read-only way to know —
 * stated as a fact, with words, and never a fabricated observation and never
 * an error.
 */
export interface ActiveWindowReading {
  readonly availability: ActiveWindowAvailability
  readonly window: ActiveWindowInfo | null
  /** Why not, in words, when anything other than `ready`. Null when ready. */
  readonly reason: string | null
}

/**
 * The capability seam a desktop host fills.
 *
 * Synchronous and clock-pinned: `read` is called only when a started source's
 * cadence has elapsed, with the caller's instant, and it must return, not
 * promise — a lane that cannot await cannot call a model, and that is the
 * zero-inference property stated as a type. `subscribe` is the optional push
 * half: a provider that can notice focus changes itself needs no polling at
 * all, and the source prefers it when cadence is not explicitly requested.
 * Providers must be read-only and must not capture pixels, scrape
 * accessibility data, or hook input.
 */
export interface ActiveWindowProvider {
  readonly providerId: string
  readonly reach: WindowObservationReach
  availability(): ActiveWindowAvailability
  read(now: Date): ActiveWindowReading
  subscribe?(listener: (reading: ActiveWindowReading) => void): () => void
}

/* ----------------------------------------------------------------- state */

/**
 * What the source can truthfully say about itself at an instant.
 *
 *  - `disabled` — never started, or stopped: inert, holding nothing;
 *  - `unsupported` — the provider says this build cannot observe at all;
 *  - `unavailable` — the provider could observe but cannot right now;
 *  - `stale` — started and provider healthy, but no held observation is
 *    current (none yet, or the last one outlived its TTL);
 *  - `observed` — a live observation is held.
 */
export type WindowSourceStatus =
  | 'disabled'
  | 'unsupported'
  | 'unavailable'
  | 'stale'
  | 'observed'

/** The source's state as data: safe to log, safe to show, controls nothing. */
export interface WindowSourceSnapshot {
  readonly started: boolean
  readonly status: WindowSourceStatus
  readonly providerId: string
  /** The bounded cadence a host timer should poll at; 0 means events only. */
  readonly cadenceMs: number
  readonly ttlMs: number
  /** When the held observation was taken, or null. An instant, not a word. */
  readonly lastObservedAt: string | null
}

/**
 * Scheduling is injected, never ambient.
 *
 * The source does not read a timer device by itself: `start()` only schedules
 * when a host hands in a timer, and tests pass `null` and drive `pump()`
 * directly. `createIntervalTimer` exists for the wired host, behind the
 * explicit opt-in.
 */
export interface WindowTimer {
  schedule(run: () => void, everyMs: number): () => void
}

export function createIntervalTimer(): WindowTimer {
  return {
    schedule(run, everyMs) {
      const handle = setInterval(run, everyMs)
      return () => clearInterval(handle)
    },
  }
}

/* ---------------------------------------------------------------- limits */

export const WINDOW_OBSERVATION_LIMITS = Object.freeze({
  minCadenceMs: 1_000,
  maxCadenceMs: 10 * 60_000,
  /** When no cadence is stated: events if the provider has them, else 5s. */
  defaultCadenceMs: 5_000,
  /** Observations are moments: the default freshness window is short. */
  defaultTtlMs: 2 * 60_000,
  /** Never longer than the domain's own ceiling on a context item's life. */
  maxTtlMs: CONTEXT_LIMITS.maxTtlMs,
  maxProviderIdChars: 48,
  maxObservationIdChars: 64,
  maxAppNameChars: 80,
  maxTitleChars: 120,
  maxReasonChars: 160,
})

/** Every override is a *ceiling request*: `windowObservationLimits` only lowers. */
export interface WindowObservationOverrides {
  readonly cadenceMs?: number | null
  readonly ttlMs?: number | null
  readonly maxAppNameChars?: number | null
  readonly maxTitleChars?: number | null
}

export interface WindowObservationLimits {
  readonly cadenceMs: number
  readonly ttlMs: number
  readonly maxAppNameChars: number
  readonly maxTitleChars: number
}

function bounded(
  requested: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return fallback
  return Math.max(min, Math.min(Math.floor(requested), max))
}

/**
 * Resolve overrides into the lane's limits.
 *
 * Cadence may be lowered to the floor or raised to the ceiling but never
 * outside them, and `0` means "events only" for a caller that asked for it;
 * TTL clamps into `[1, CONTEXT_LIMITS.maxTtlMs]`. A caller can make this lane
 * observe less often, less long and less wide — never more.
 */
export function windowObservationLimits(
  overrides: WindowObservationOverrides = {},
  providerHasEvents = false,
): WindowObservationLimits {
  const defaultCadence = providerHasEvents ? 0 : WINDOW_OBSERVATION_LIMITS.defaultCadenceMs
  let cadenceMs = defaultCadence
  if (typeof overrides.cadenceMs === 'number' && Number.isFinite(overrides.cadenceMs)) {
    cadenceMs =
      overrides.cadenceMs <= 0
        ? 0
        : bounded(
            overrides.cadenceMs,
            defaultCadence,
            WINDOW_OBSERVATION_LIMITS.minCadenceMs,
            WINDOW_OBSERVATION_LIMITS.maxCadenceMs,
          )
  }
  return {
    cadenceMs,
    ttlMs: bounded(
      overrides.ttlMs,
      WINDOW_OBSERVATION_LIMITS.defaultTtlMs,
      1,
      WINDOW_OBSERVATION_LIMITS.maxTtlMs,
    ),
    maxAppNameChars: bounded(
      overrides.maxAppNameChars,
      WINDOW_OBSERVATION_LIMITS.maxAppNameChars,
      1,
      WINDOW_OBSERVATION_LIMITS.maxAppNameChars,
    ),
    maxTitleChars: bounded(
      overrides.maxTitleChars,
      WINDOW_OBSERVATION_LIMITS.maxTitleChars,
      1,
      WINDOW_OBSERVATION_LIMITS.maxTitleChars,
    ),
  }
}
