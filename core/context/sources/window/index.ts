export {
  ACTIVE_WINDOW_AVAILABILITIES,
  WINDOW_OBSERVATION_LIMITS,
  WINDOW_OBSERVATION_REACHES,
  createIntervalTimer,
  windowObservationLimits,
} from './types'
export type {
  ActiveWindowAvailability,
  ActiveWindowInfo,
  ActiveWindowProvider,
  ActiveWindowReading,
  WindowObservationLimits,
  WindowObservationOverrides,
  WindowObservationReach,
  WindowSourceSnapshot,
  WindowSourceStatus,
  WindowTimer,
} from './types'

export { normalizeWindowInfo, windowSpanKey } from './normalize'
export {
  WindowObservationService,
  type WindowObservationServiceOptions,
  type WindowObservationStats,
} from './service'
export { activeWindowCandidate, type ActiveWindowCandidateOptions } from './candidate'
export {
  ACTIVE_WINDOW_SUPERSESSION_REASON,
  createActiveWindowAdmitter,
  type ActiveWindowAdmitterOptions,
  type WindowAdmissionSink,
} from './admit'
export {
  createUnavailableProvider,
  createUnsupportedProvider,
  type HonestProviderOptions,
} from './providers'
