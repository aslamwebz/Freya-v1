/**
 * THE HANDS ADMISSION — the Guard-gated gate before any action exists.
 *
 * Barrel export for `core/hands/admission/`. Everything outside `core/hands/`
 * should reach admission through `core/hands/index.ts`.
 */

export {
  HANDS_ADMISSION_REFUSAL_CODES,
  HANDS_ADMISSION_REFUSAL_REASONS,
  HANDS_ADMISSION_LIMITS,
  isHandsAdmissionRefusalCode,
  handsAdmissionLimits,
  type HandsAdmissionRefusalCode,
  type HandsAdmissionRefusal,
  type HandsAdmissionBudget,
  type HandsAdmittedBudgetMetadata,
  type HandsAdmissionLimits,
  type HandsAdmissionCaller,
  type HandsAdmissionGrant,
  type HandsAdmittedAction,
  type HandsAdmissionDecision,
} from './types'

export {
  HANDS_CAPABILITY_CATALOG,
  resolveCapability,
  type HandsCapabilityDescriptor,
  type HandsCapabilityCatalog,
  type HandsCapabilityResolution,
} from './catalog'

export {
  defaultHandsGuard,
  defaultHandsGovernor,
  defaultHandsAdmissionSeam,
  isHandsAdmissionSeam,
  guardClaim,
  governorClaim,
  type HandsAdmissionSeam,
  type HandsGuardSeam,
  type HandsGuardClaim,
  type HandsGuardVerdict,
  type HandsGovernorSeam,
  type HandsGovernorClaim,
  type HandsGovernorVerdict,
  type HandsGovernorDenialCode,
} from './seam'

export {
  admitHandsAction,
  refuseHandsAdmission,
  type HandsAdmissionInput,
} from './controller'

export {
  HANDS_ADMISSION_REGISTRATION_STATUSES,
  initialHandsAdmissionLedger,
  registerAdmission,
  cancelRegistration,
  expireRegistrations,
  stopAllRegistrations,
  inFlightCount,
  handsAdmissionBudgetFrom,
  submitHandsAdmission,
  type HandsAdmissionRegistrationStatus,
  type HandsAdmissionRegistration,
  type HandsAdmissionLedger,
  type HandsAdmissionSubmitInput,
} from './registration'
