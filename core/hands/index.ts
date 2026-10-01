/**
 * THE HANDS DOMAIN — Phase 10 foundation.
 *
 * Barrel export for the Hands domain. This is the only file that should be
 * imported by code outside `core/hands/`.
 */

export type {
  HandsCapabilityId,
  HandsScopedCapabilityRef,
  HandsActionRequest,
  HandsActionRefusal,
  HandsActionResult,
  HandsObservationRecord,
  HandsVerificationRequest,
  HandsVerificationResult,
} from './contract'

export {
  HANDS_CAPABILITY_KINDS,
  DEFERRED_HANDS_CAPABILITY_KINDS,
  HANDS_ACTION_STATUSES,
  HANDS_ACTION_TERMINAL_STATUSES,
  HANDS_OBSERVATION_KINDS,
  HANDS_VERIFICATION_STATUSES,
  HANDS_VERIFICATION_TERMINAL_STATUSES,
  HANDS_REFUSAL_CODES,
  HANDS_REFUSAL_REASONS,
  HANDS_LIMITS,
  type HandsCapabilityKind,
  type DeferredHandsCapabilityKind,
  type AnyHandsCapabilityKind,
  type HandsActionStatus,
  type HandsActionTerminalStatus,
  type HandsObservationKind,
  type HandsVerificationStatus,
  type HandsVerificationTerminalStatus,
  type HandsRefusalCode,
  type HandsLimits,
  isHandsCapabilityKind,
  isDeferredHandsCapabilityKind,
  isAnyHandsCapabilityKind,
  isTerminalHandsActionStatus,
  isTerminalHandsVerificationStatus,
  handsLimits,
  canTransitionHandsAction,
  canTransitionHandsVerification,
} from './types'

export {
  handsLifecycleState,
  canRecordObservation,
  canRequestVerification,
  isValidActionTransition,
  isValidVerificationTransition,
  isActionTerminal,
  isVerificationTerminal,
  handsTerminalOutcome,
  type HandsLifecycleState,
  type HandsTerminalOutcome,
} from './lifecycle'

export {
  hasExactKeys,
  validateActionEnvelope,
  isSupportedCapabilityKind,
  type HandsValidationResult,
} from './validation'

export {
  initialHandsState,
  recordActionResult,
  recordObservation,
  recordVerificationResult,
  recordRefusal,
  isActionVerified,
  observationsForAction,
  verificationsForAction,
  projectHands,
  ABSENT_HANDS_PROJECTION,
  type HandsState,
  type HandsActionRefusalEntry,
  type HandsProjection,
} from './state'

export {
  createHandsRefusal,
  refuseUnsupportedCapability,
  refuseDeferredCapability,
  refuseUnauthorizedCapability,
  refuseInvalidEnvelope,
  refuseInvalidRequest,
  refuseBudgetExceeded,
  refuseTimeoutExceeded,
} from './refusal'
