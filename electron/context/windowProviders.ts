import { createUnsupportedProvider } from '../../core/context/sources/window'
import type {
  ActiveWindowProvider,
  ActiveWindowReading,
} from '../../core/context/sources/window'

/**
 * THE DESKTOP-HOST PROVIDERS for the active-window Context lane.
 *
 * Both halves of this file exist so the host can wire the lane *without
 * inventing a sensor*:
 *
 *  - `createOwnWindowProvider` reports only what plain Electron main-process
 *    API already offers read-only: whether one of **Freya's own** windows is
 *    focused, and that window's title. It never sees another application, and
 *    its reach says `own-app` so nobody downstream can mistake it for an
 *    OS-wide claim. No window focused → an honest null, no stale echo.
 *  - the system half states the boundary instead of crossing it: OS-wide
 *    active-app/window identity needs a native helper that this build does
 *    not have and will not smuggle in as a dependency. The seam stays, the
 *    provider truthfully says `unsupported`, and the source stops touching
 *    it. A future host fills the seam on its own evidence, not this file's.
 *
 * No capture of any kind lives here: no pixels, no text scraping, no input
 * observation, no hooks. And nothing in this directory adds an IPC channel —
 * the renderer gets *no* handle to this lane at all (see the lane's bounds
 * test), because observation authority stays where all authority stays: in
 * the Core-owned host, under an explicit opt-in.
 */

/** The read-only facts a provider needs about Freya's own windows. */
export interface OwnWindowSource {
  displayName(): string
  focusedWindowTitle(): string | null
  isFullscreen?(): boolean
}

export interface OwnWindowProviderOptions {
  readonly providerId?: string
  /** Injected id source so hosts (and tests) control observation ids. */
  readonly newObservationId?: () => string
}

export const OWN_WINDOW_PROVIDER_ID = 'freya-own-window'

/** The system-wide reporting gap, stated once in its exact words. */
export const SYSTEM_WINDOW_OBSERVATION_GAP =
  'OS-wide active app/window identity needs a native capability this build does not have; ' +
  'the seam stays open and nothing is invented to close it'

export function createOwnWindowProvider(
  source: OwnWindowSource,
  options: OwnWindowProviderOptions = {},
): ActiveWindowProvider {
  const providerId = options.providerId ?? OWN_WINDOW_PROVIDER_ID
  let counter = 0
  const nextId =
    options.newObservationId ??
    (() => {
      counter += 1
      return `own-${String(counter).padStart(6, '0')}`
    })

  return {
    providerId,
    reach: 'own-app',
    availability: () => 'ready',
    read(now: Date): ActiveWindowReading {
      const title = source.focusedWindowTitle()
      if (title === null) {
        return {
          availability: 'unavailable',
          window: null,
          reason: 'no Freya window is focused',
        }
      }
      return {
        availability: 'ready',
        window: {
          providerId,
          observationId: nextId(),
          observedAt: now.toISOString(),
          reach: 'own-app',
          appName: source.displayName(),
          appIdentifier: null,
          windowTitle: title,
          isFullscreen: source.isFullscreen?.() === true,
        },
        reason: null,
      }
    },
  }
}

/**
 * The honest system-foreground provider: a defined seam that says it cannot.
 *
 * The service treats `unsupported` as terminal, so wiring this provider is
 * exactly equivalent to the lane being open-circuited — which is the truthful
 * state of a Windows/macOS/Linux build with no native foreground source, and
 * the acceptance that this lane ships a seam rather than a sensor.
 */
export function createSystemWindowProvider(
  providerId = 'os-foreground',
): ActiveWindowProvider {
  return createUnsupportedProvider({
    providerId,
    reach: 'system',
    reason: SYSTEM_WINDOW_OBSERVATION_GAP,
  })
}
