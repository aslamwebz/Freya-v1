/**
 * Phase 35 — Device Hands: the whole runtime, as one barrel.
 *
 * **Not wired into a composition root.** There is no import of this folder from
 * `core/index.ts`, no host adapter, and no renderer surface. The runtime is implemented
 * and proved; it is *not* switched on, and nothing in it can switch itself on. See
 * `./README.md` for what Core integration would still have to supply.
 *
 * The structure follows the Autonomous Enterprise slice, because its shape is the right
 * one for a phase whose whole claim is that it cannot do more than it says:
 *
 *   - `./types` — closed vocabularies, frozen ceilings, the absolute deny list. Data.
 *   - `./ports` — the entire integration surface. The omissions are the design: no
 *     authority port, no capture port, no credential port, no physical-world port, no
 *     timer and no cognition port.
 *   - `./digest`, `./paths`, `./commands`, `./clipboard`, `./transfer` — the pure
 *     policy modules. No clock, no journal, no network, no port access, no `node:fs`.
 *     `./assertions` scans their source to keep it that way.
 *   - `./approvals`, `./verification`, `./gates` — the decision. Pure.
 *   - `./state` — the fold. Every derived fact comes from the journal.
 *   - `./recovery` — what a restart is willing to claim.
 *   - `./probe` — the rule that a measurement is not a permission.
 *   - `./runtime` — the only file that touches a port. Schedules nothing.
 *   - `./assertions` — structural audits. Not used by production code.
 */

export {
  DEVICE_HANDS_SURFACES,
  DEVICE_HANDS_SURFACE_ACTIONS,
  DEVICE_HANDS_BANNED_ACTION_WORDS,
  DEVICE_HANDS_CONSEQUENCE_CLASSES,
  DEVICE_HANDS_CONSEQUENCE,
  DEVICE_HANDS_ACTIONS_WITHOUT_APPROVAL,
  DEVICE_HANDS_GATES,
  DEVICE_HANDS_PROBE_GATES,
  DEVICE_HANDS_REFUSAL_CODES,
  DEVICE_HANDS_REFUSAL_REASONS,
  DEVICE_HANDS_ACTION_STATES,
  DEVICE_HANDS_SETTLE_OUTCOMES,
  DEVICE_HANDS_VERDICTS,
  DEVICE_HANDS_APPROVAL_STATES,
  TERMINAL_DEVICE_HANDS_APPROVAL_STATES,
  FORBIDDEN_DEVICE_HANDS_ACTIONS,
  CREDENTIAL_ACTIONS,
  CAPTURE_ACTIONS,
  PHYSICAL_WORLD_ACTIONS,
  AUTHORITY_ACTIONS,
  DEVICE_HANDS_LIMITS,
  DEVICE_HANDS_EVENT_TYPES,
  DEVICE_HANDS_EVENT_TYPE_SET,
  DEVICE_HANDS_PAYLOAD_KEYS,
  FORBIDDEN_DEVICE_HANDS_PAYLOAD_KEYS,
  isDeviceHandsSurface,
  isDeviceHandsGate,
  isDeviceHandsProbeGate,
  isDeviceHandsActionKey,
  isDeviceHandsActionState,
  isDeviceHandsSettleOutcome,
  isDeviceHandsVerdict,
  isDeviceHandsApprovalState,
  isDeviceHandsRefusalCode,
  isForbiddenDeviceHandsAction,
  deviceHandsActionKey,
  deviceHandsApprovalRequired,
  type DeviceHandsSurface,
  type DeviceHandsActionKey,
  type DeviceHandsActionState,
  type DeviceHandsSettleOutcome,
  type DeviceHandsGate,
  type DeviceHandsProbeGate,
  type DeviceHandsConsequenceClass,
  type DeviceHandsVerdict,
  type DeviceHandsApprovalState,
  type DeviceHandsRefusalCode,
  type ForbiddenDeviceHandsAction,
  type DeviceHandsLimits,
  type DeviceHandsLimitRequest,
  type DeviceHandsEventType,
  type DeviceHandsPayload,
  type DeviceHandsJournalEntry,
  type DeviceHandsGrantRecord,
  type DeviceHandsApprovalRecord,
  type DeviceHandsApprovalSubject,
  type DeviceHandsVerificationRecord,
  type DeviceHandsProbeOutcome,
} from './types'

export { canonicalDigest, listDigest, EMPTY_DIGEST } from './digest'

export {
  DENIED_PATH_SEGMENTS,
  DENIED_PATH_SEGMENT_PATTERNS,
  DENIED_ENV_NAME_WORDS,
  DEVICE_HANDS_ALLOWED_URL_SCHEMES,
  normalisePath,
  normaliseSurfacePolicy,
  pathDenialReason,
  isPathAllowed,
  checkPath,
  checkUrl,
  policyMatchesDigest,
  type SurfacePolicy,
  type PolicyInput,
  type PolicyReading,
  type UrlReading,
} from './paths'

export {
  SHELL_METACHARACTERS,
  FORBIDDEN_VALUE_CODES,
  hasControlCharacter,
  readTerminalCommand,
  commandCanonicalForm,
  type TerminalCommand,
  type CommandReading,
} from './commands'

export {
  CLIPBOARD_DIRECTIONS,
  CLIPBOARD_CREDENTIAL_SHAPES,
  classifyClipboardText,
  clipboardByteLength,
  clipboardCanonicalForm,
  clipboardDigest,
  checkClipboardText,
  type ClipboardDirection,
  type ClipboardReading,
} from './clipboard'

export {
  DEVICE_HANDS_ALLOWED_MEDIA_TYPES,
  DEVICE_HANDS_EXTENSION_MEDIA_TYPES,
  TRANSFER_DENIED_EXTENSIONS,
  TRANSFER_DIRECTIONS,
  readTransferRequest,
  sessionTransferCeiling,
  transferCanonicalForm,
  type TransferDirection,
  type TransferTarget,
  type TransferReading,
} from './transfer'

export {
  readApprovalRequest,
  approvalCovers,
  approvalDecisionIsOwners,
  countPendingApprovals,
  mayRequestApproval,
  mayTransitionApproval,
  isExpired,
  type ApprovalRequestReading,
} from './approvals'

export {
  EVIDENCE_KINDS,
  evidenceKinds,
  verifyDeviceAction,
  mayBeConsideredComplete,
  type DeviceOutcome,
  type EvidenceKind,
  type VerificationInput,
  type VerificationDecision,
} from './verification'

export {
  authoriseDeviceAction,
  authoriseDeviceProbe,
  normaliseDeviceAction,
  buildSubject,
  forbiddenClaimCode,
  subjectDigest,
  forbiddenActions,
  // Exported so a policy module *before* the gate can decline to offer a locator the gate
  // would refuse, rather than describing one and having it turned away later. Phase 51's
  // page-description module is the first caller.
  FORBIDDEN_SELECTOR_TOKENS,
  type DeviceHandsActionRequest,
  type DeviceHandsGateContext,
  type GateDecision,
  type PreparedAction,
  type ProbeDecision,
  type NormalisationReading,
} from './gates'

export {
  DEVICE_HANDS_ACTION_TRANSITIONS,
  DEVICE_HANDS_APPROVAL_TRANSITIONS,
  actionTransition,
  canTransitionAction,
  canTransitionApprovalMachine,
  settleOutcomeFor,
  auditTransitionTables,
  type Transition,
  type TransitionDecision,
  type TransitionRefusal,
} from './machine'

export {
  initialDeviceHandsState,
  reduceDeviceHandsEntry,
  reduceDeviceHandsState,
  inspectDeviceHandsPayload,
  unresolvedActions,
  consumedActionIds,
  actionIsComplete,
  deviceHandsEventTypes,
  type DeviceHandsState,
  type DeviceHandsActionRecord,
  type DeviceHandsProbeRecord,
  type DeviceHandsRefusalEntry,
  type FoldAnomaly,
  type FoldAnomalyCode,
  type FoldResult,
} from './state'

export { recoveryReport, mayOpenJournal, type RecoveryReport } from './recovery'

export { projectDeviceHandsState, type DeviceHandsProjection, type SurfaceSummary } from './projection'

export {
  DEVICE_HANDS_PROBE_CODES,
  DEVICE_HANDS_PROBE_OUTCOME_KEYS,
  AUTHORITY_SHAPED_KEYS,
  isDeviceHandsProbeCode,
  findAuthorityShapedKeys,
  probeSummary,
  type DeviceHandsProbeCode,
} from './probe'

export {
  createDeviceHandsRuntime,
  deviceHandsDigest,
  type DeviceHandsRuntime,
  type DeviceHandsRuntimeOptions,
  type DeviceHandsOutcome,
  type RefusalRecordView,
} from './runtime'

export type {
  DeviceHandsPorts,
  DeviceHandsApprovalAsk,
  DeviceHandsApprovalAnswer,
  BrowserPortRequest,
  BrowserPortOutcome,
  TerminalPortOutcome,
  TransferPortOutcome,
  GrantFact,
  DeviceHandsRefusalRecord,
  DeviceHandsActionRecord as DeviceHandsActionAuditRecord,
} from './ports'

export {
  stripComments,
  findTimerUsageInSource,
  findUnboundedLoopInSource,
  findImpurityInSource,
  findForbiddenVocabularyInSource,
  auditEventVocabulary,
  auditRefusalVocabulary,
  auditAuthorityTables,
  auditGateTables,
  auditProbeOutcome,
  auditPolicyNormalisation,
  auditDeviceHandsTables,
  analyseJournal,
  FORBIDDEN_SOURCE_IDENTIFIERS,
  type JournalViolation,
  type JournalViolationCode,
  type JournalEntryLike,
} from './assertions'

/** Aliases kept so an audit suite can read as "audit X" rather than "find X". */
export {
  findTimerUsageInSource as auditTimerUsageInSource,
  findImpurityInSource as auditImpurityInSource,
  findForbiddenVocabularyInSource as auditForbiddenVocabularyInSource,
  findUnboundedLoopInSource as auditUnboundedLoopInSource,
} from './assertions'