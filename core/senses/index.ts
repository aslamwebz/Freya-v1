/**
 * THE SENSES DOMAIN — Phase 25 (Digital Senses & Hands II).
 *
 * The only file outside `core/senses/` should import. Everything here is pure:
 * closed vocabularies, a capability registry, a deterministic admission
 * pipeline and a deterministic capability testing framework. No I/O, no clock
 * reads except through an injected `now`, no randomness, no model, no
 * execution, no authority.
 *
 * The core invariant:
 *
 * > **Hands are bounded tools, not unrestricted computer control. Capability
 * > expansion does not widen authority.**
 */

export {
  PHASE25_CAPABILITY_KINDS,
  BROWSER_ACTIONS,
  TERMINAL_ACTIONS,
  CLIPBOARD_ACTIONS,
  DOWNLOAD_ACTIONS,
  UPLOAD_ACTIONS,
  PHASE25_LIMITS,
  isPhase25CapabilityKind,
  isSensesId,
  instantMs,
  type Phase25CapabilityKind,
  type BrowserAction,
  type TerminalAction,
  type ClipboardAction,
  type DownloadAction,
  type UploadAction,
  type SensesRisk,
  type CapabilityActionRegistration,
  type CapabilityRegistration,
  type CapabilityActionRequest,
  type CapabilityActionResult,
  type CapabilityObservationRecord,
  type CapabilityVerificationResult,
  type CapabilityActionRefusal,
  type CapabilityTestCase,
  type CapabilityTestResult,
} from './types'

export {
  CAPABILITY_REGISTRY,
  REGISTERED_CAPABILITY_KINDS,
  capabilityRegistration,
  actionRegistration,
  validateAction,
  validateInput,
  getRisk,
  requiresApproval,
  actionTimeoutMs,
  inputDepth,
  isCapabilityRegistry,
  unregisteredActions,
  type InputValidation,
} from './registry'

export {
  SENSES_REFUSAL_CODES,
  SENSES_REFUSAL_REASONS,
  isSensesRefusalCode,
  refuseCapabilityAction,
  type SensesRefusalCode,
} from './refusal'

export {
  defaultSensesGuard,
  defaultSensesGovernor,
  defaultSensesAuthoritySeam,
  isSensesAuthoritySeam,
  admitCapabilityAction,
  type SensesCaller,
  type SensesGuardClaim,
  type SensesGuardVerdict,
  type SensesGuardSeam,
  type SensesGovernorClaim,
  type SensesGovernorVerdict,
  type SensesGovernorSeam,
  type SensesAuthoritySeam,
  type SensesAdmissionInput,
  type SensesAdmittedAction,
  type SensesAdmissionDecision,
} from './admission'

export {
  SENSES_TEST_NOW,
  testCaller,
  createTestActionRequest,
  runCapabilityTest,
  runCapabilityTests,
  capabilityMatrix,
  createActionResult,
  createObservation,
  createVerification,
  type SensesTestOptions,
  type CapabilityMatrixRow,
} from './testing'
