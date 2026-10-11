import type { Capability } from '../../shared/contracts/capabilities'
import type { PrincipalId } from '../../shared/contracts/identity'

/**
 * THE FOUNDRY DOMAIN.
 *
 * This file is the vocabulary of Freya's artifact foundry: Artifacts, Tools,
 * Modules, and Apps. It is types and closed tables only — no logic, no I/O,
 * no clock — so both the engine and the renderer can depend on the shapes
 * without either depending on the other.
 *
 * ## What the Foundry is for
 *
 * The Foundry is where Freya's work produces *reusable things*: a tool that
 * can be invoked again, a module that can be composed into a larger whole, an
 * app that can be installed and activated. Every one of these has a closed
 * lifecycle with explicit gates, and every one carries deterministic
 * provenance so that "what this is" and "where it came from" are facts rather
 * than claims.
 *
 * ## The lifecycle
 *
 * ```
 *   draft → building → built → verifying → verified → promoted → active
 * ```
 *
 * Every arrow is a gated transition. Nothing moves without an explicit
 * authorized action, and no model claim can substitute for verification
 * evidence. A thing that was never verified cannot be promoted; a thing that
 * was never promoted cannot be activated.
 *
 * ## What is deliberately *not* here
 *
 * - No auto-install or auto-execute. Activation is always explicit and
 *   reversible.
 * - No authority widening. The Foundry does not grant capabilities; it
 *   produces artifacts that *reference* capabilities the owner already holds.
 * - No silent promotion. A thing that was verified is not thereby promoted;
 *   promotion is a separate, explicit, owner-authorized decision.
 */

/* ----------------------------------------------------------- artifact kinds */

/**
 * What kind of artifact this is.
 *
 * The distinction the whole file exists to protect is between **source** (the
 * human-authored input), **spec** (the machine-readable description of what
 * should be built), **build_output** (what the build actually produced),
 * **verification_evidence** (the evidence that the output satisfies the spec),
 * and **promotion_state** (the record of whether it was promoted and by whom).
 *
 * Collapsing any two of them produces the failure this architecture calls out
 * by name: a build output that is not checked against its spec is a claim, not
 * a fact.
 */
export const ARTIFACT_KINDS = [
  'source',
  'spec',
  'build_output',
  'verification_evidence',
  'promotion_state',
] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/* --------------------------------------------------------- artifact states */

/**
 * An artifact's lifecycle.
 *
 * `draft` → `building` → `built` → `verifying` → `verified` is the success
 * path. `failed` is reachable from any non-terminal state and is not itself
 * terminal: a failed artifact can be rebuilt. `promoted` and `active` are
 * reachable only from `verified`, and only through explicit owner-authorized
 * transitions. `archived` is terminal.
 */
export const ARTIFACT_STATUSES = [
  'draft',
  'building',
  'built',
  'verifying',
  'verified',
  'failed',
  'promoted',
  'active',
  'archived',
] as const
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number]

export const ARTIFACT_TERMINAL_STATUSES = ['archived'] as const
export type ArtifactTerminalStatus = (typeof ARTIFACT_TERMINAL_STATUSES)[number]

export function isTerminalArtifactStatus(status: ArtifactStatus): status is ArtifactTerminalStatus {
  return ARTIFACT_TERMINAL_STATUSES.includes(status as ArtifactTerminalStatus)
}

/** Which artifact statuses may move to which. Terminal statuses are terminal. */
export const ARTIFACT_TRANSITIONS: Readonly<Record<ArtifactStatus, readonly ArtifactStatus[]>> = Object.freeze({
  draft: ['building', 'verified', 'archived'],
  building: ['built', 'failed', 'archived'],
  built: ['verifying', 'failed', 'archived'],
  verifying: ['verified', 'failed', 'archived'],
  verified: ['promoted', 'archived'],
  failed: ['building', 'archived'],
  promoted: ['active', 'archived'],
  // Explicit deactivation returns an active artifact to its promoted, reusable state.
  active: ['promoted', 'archived'],
  archived: [],
})

export function canTransitionArtifact(from: ArtifactStatus, to: ArtifactStatus): boolean {
  return ARTIFACT_TRANSITIONS[from].includes(to)
}

/* -------------------------------------------------------------- tool states */

/**
 * A Tool's lifecycle.
 *
 * A Tool is a reusable executable capability. It is created through the Work
 * engine (a Run produces it), verified against its spec, promoted by explicit
 * owner decision, and then activated — which means it becomes available for
 * invocation. Deactivation is explicit and reversible.
 */
export const TOOL_STATUSES = [
  'draft',
  'registered',
  'verified',
  'promoted',
  'active',
  'deprecated',
  'revoked',
] as const
export type ToolStatus = (typeof TOOL_STATUSES)[number]

export const TOOL_TERMINAL_STATUSES = ['revoked'] as const
export type ToolTerminalStatus = (typeof TOOL_TERMINAL_STATUSES)[number]

export function isTerminalToolStatus(status: ToolStatus): status is ToolTerminalStatus {
  return TOOL_TERMINAL_STATUSES.includes(status as ToolTerminalStatus)
}

export const TOOL_TRANSITIONS: Readonly<Record<ToolStatus, readonly ToolStatus[]>> = Object.freeze({
  draft: ['registered', 'revoked'],
  registered: ['verified', 'deprecated', 'revoked'],
  verified: ['promoted', 'deprecated', 'revoked'],
  promoted: ['active', 'deprecated', 'revoked'],
  active: ['deprecated', 'revoked'],
  deprecated: ['active', 'revoked'],
  revoked: [],
})

export function canTransitionTool(from: ToolStatus, to: ToolStatus): boolean {
  return TOOL_TRANSITIONS[from].includes(to)
}

/* ------------------------------------------------------------ module states */

/**
 * A Module's lifecycle.
 *
 * A Module is a composable unit of functionality. It is created through the
 * Work engine, verified against its spec, promoted, and then activated —
 * which means it can be composed into an App. Deactivation is explicit and
 * reversible.
 */
export const MODULE_STATUSES = [
  'draft',
  'registered',
  'verified',
  'promoted',
  'active',
  'deprecated',
  'revoked',
] as const
export type ModuleStatus = (typeof MODULE_STATUSES)[number]

export const MODULE_TERMINAL_STATUSES = ['revoked'] as const
export type ModuleTerminalStatus = (typeof MODULE_TERMINAL_STATUSES)[number]

export function isTerminalModuleStatus(status: ModuleStatus): status is ModuleTerminalStatus {
  return MODULE_TERMINAL_STATUSES.includes(status as ModuleTerminalStatus)
}

export const MODULE_TRANSITIONS: Readonly<Record<ModuleStatus, readonly ModuleStatus[]>> = Object.freeze({
  draft: ['registered', 'revoked'],
  registered: ['verified', 'deprecated', 'revoked'],
  verified: ['promoted', 'deprecated', 'revoked'],
  promoted: ['active', 'deprecated', 'revoked'],
  active: ['deprecated', 'revoked'],
  deprecated: ['active', 'revoked'],
  revoked: [],
})

export function canTransitionModule(from: ModuleStatus, to: ModuleStatus): boolean {
  return MODULE_TRANSITIONS[from].includes(to)
}

/* --------------------------------------------------------------- app states */

/**
 * An App's lifecycle.
 *
 * An App is a deployable/runnable application composed of modules. It is
 * created through the Work engine, verified against its spec, promoted,
 * installed, and then activated. Deactivation is explicit and reversible.
 * There is no silent auto-install or auto-execute.
 */
export const APP_STATUSES = [
  'draft',
  'registered',
  'verified',
  'promoted',
  'installed',
  'active',
  'deprecated',
  'revoked',
] as const
export type AppStatus = (typeof APP_STATUSES)[number]

export const APP_TERMINAL_STATUSES = ['revoked'] as const
export type AppTerminalStatus = (typeof APP_TERMINAL_STATUSES)[number]

export function isTerminalAppStatus(status: AppStatus): status is AppTerminalStatus {
  return APP_TERMINAL_STATUSES.includes(status as AppTerminalStatus)
}

export const APP_TRANSITIONS: Readonly<Record<AppStatus, readonly AppStatus[]>> = Object.freeze({
  draft: ['registered', 'revoked'],
  registered: ['verified', 'deprecated', 'revoked'],
  verified: ['promoted', 'deprecated', 'revoked'],
  promoted: ['installed', 'deprecated', 'revoked'],
  installed: ['active', 'deprecated', 'revoked'],
  active: ['deprecated', 'revoked'],
  deprecated: ['installed', 'revoked'],
  revoked: [],
})

export function canTransitionApp(from: AppStatus, to: AppStatus): boolean {
  return APP_TRANSITIONS[from].includes(to)
}

/* -------------------------------------------------------------- provenance */

/**
 * Deterministic identity for a Foundry artifact.
 *
 * The identity is a hash of the artifact's content and its inputs, so that
 * "what this is" is a fact derived from its content rather than a label
 * somebody attached. Two artifacts with the same content and inputs have the
 * same identity; two with different content or inputs have different
 * identities.
 *
 * The hash is computed by the Foundry engine at creation time and is never
 * mutable. It is the answer to "is this the same thing as that?" without
 * relying on a name that could be reused.
 */
export interface ArtifactIdentity {
  /** SHA-256 hash of content + inputs, hex-encoded. */
  readonly hash: string
  /** The algorithm used, so a future change is visible. */
  readonly algorithm: 'sha256'
}

/**
 * Where an artifact came from.
 *
 * Provenance is the chain of authorized actions that produced this artifact.
 * It is recorded at creation and is never mutable. Every artifact carries the
 * identity of the Run that produced it, the Step that created it, and the
 * principal that authorized it — so that "who made this and under what
 * authority" is always answerable.
 */
export interface ArtifactProvenance {
  /** The Run that produced this artifact. */
  readonly runId: string
  /** The Step within that Run that created it. */
  readonly stepId: string
  /** The principal that authorized the creation. */
  readonly createdBy: PrincipalId
  /** When the artifact was created. */
  readonly createdAt: string
  /** The parent artifact's identity, if this was derived from another. */
  readonly parentHash: string | null
  /** The spec this artifact was built against, if any. */
  readonly specHash: string | null
}

/**
 * A version, in the Foundry's own words.
 *
 * Versions are deterministic: they are derived from the artifact's identity
 * and its position in the promotion chain, not from a counter that could be
 * reset or a label that could be reused. A version is a fact about where in
 * the lifecycle this artifact sits, not a marketing decision.
 */
export interface ArtifactVersion {
  /** The artifact's identity hash. */
  readonly hash: string
  /** How many times this artifact has been promoted. */
  readonly promotionCount: number
  /** A human-readable version string derived from the above. */
  readonly label: string
}

/* -------------------------------------------------------------- verification */

/**
 * What a verification attempt produced.
 *
 * Verification is the mechanism behind "a model claim can never mark work
 * verified": a verifier is a separately registered piece of code that checks
 * an artifact against its spec and produces evidence. The evidence is
 * recorded; the verdict is derived from the evidence, not from the model's
 * claim.
 */
export const VERDICTS = ['passed', 'failed', 'inconclusive'] as const
export type Verdict = (typeof VERDICTS)[number]

/**
 * One verification attempt.
 *
 * The evidence is the verifier's output — a bounded, structured result that
 * can be inspected. The verdict is derived from the evidence by the Foundry
 * engine, not by the verifier itself, so that a verifier cannot mark its own
 * work as passed.
 */
export interface VerificationRecord {
  readonly verificationId: string
  readonly artifactHash: string
  readonly verifierName: string
  readonly verdict: Verdict
  /** Bounded evidence produced by the verifier. Never the full output. */
  readonly evidence: string
  readonly verifiedAt: string
  /** The principal that requested the verification. */
  readonly requestedBy: PrincipalId
}

/* --------------------------------------------------------------- promotion */

/**
 * A promotion decision.
 *
 * Promotion is the explicit, owner-authorized gate between "verified" and
 * "reusable". A thing that was verified is not thereby promoted; promotion is
 * a separate decision that requires the owner's explicit authorization.
 */
export interface PromotionRecord {
  readonly promotionId: string
  readonly artifactHash: string
  readonly fromStatus: string
  readonly toStatus: string
  readonly promotedBy: PrincipalId
  readonly promotedAt: string
  /** Why, in words a person can read. */
  readonly reason: string
  /** The verification record that justified this promotion. */
  readonly verificationId: string
}

/* -------------------------------------------------------------- activation */

/**
 * An activation record.
 *
 * Activation is the explicit, owner-authorized gate between "promoted" and
 * "active". A thing that was promoted is not thereby active; activation is a
 * separate decision that requires the owner's explicit authorization.
 *
 * Activation is bounded and reversible: an active thing can be deactivated,
 * and deactivation is explicit and recorded.
 */
export interface ActivationRecord {
  readonly activationId: string
  readonly artifactHash: string
  readonly fromStatus: string
  readonly toStatus: string
  readonly activatedBy: PrincipalId
  readonly activatedAt: string
  /** Why, in words a person can read. */
  readonly reason: string
  /** When this activation expires, if it is bounded. */
  readonly expiresAt: string | null
}

/* ------------------------------------------------------------------ limits */

/**
 * The ceiling on the Foundry.
 *
 * Every bound below is checked by the engine **before** the thing it bounds,
 * not after, and exceeding one is a recorded, visible outcome rather than a
 * silent stop.
 */
export const FOUNDRY_LIMITS = Object.freeze({
  /** Artifacts a single Run may produce. */
  maxArtifactsPerRun: 32,
  /** Tools the Foundry may hold. */
  maxTools: 64,
  /** Modules the Foundry may hold. */
  maxModules: 64,
  /** Apps the Foundry may hold. */
  maxApps: 32,
  /** Verification attempts per artifact. */
  maxVerificationsPerArtifact: 8,
  /** Promotions per artifact. */
  maxPromotionsPerArtifact: 4,
  /** Activations per artifact. */
  maxActivationsPerArtifact: 4,
  /** Characters in a human-readable label. */
  maxLabelChars: 200,
  /** Characters in a human-readable summary. */
  maxSummaryChars: 400,
  /** Characters in a reason. */
  maxReasonChars: 400,
  /** Bytes of serialised artifact content. */
  maxContentBytes: 65_536,
  /** Depth and breadth of a sanitised content value. */
  maxContentDepth: 4,
  /** Fields in one sanitised content value. */
  maxContentFields: 32,
})

/* --------------------------------------------------------- artifact records */

/**
 * What the journal knows about one Artifact.
 *
 * Durable. Every field is either an id, a hash, a count, a status, an
 * instant, or a measured length. No content, no spec, no evidence — the
 * journal is the least protected place anything in Core could go, and this
 * shape is the reason it never becomes one.
 */
export interface ArtifactRecord {
  readonly artifactId: string
  readonly hash: string
  readonly kind: ArtifactKind
  readonly status: ArtifactStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly runId: string
  readonly stepId: string
  readonly createdBy: PrincipalId
  readonly parentHash: string | null
  readonly specHash: string | null
  readonly contentLength: number
  readonly promotionCount: number
}

/**
 * What the journal knows about one Tool.
 */
export interface ToolRecord {
  readonly toolId: string
  readonly hash: string
  readonly status: ToolStatus
  readonly name: string
  readonly capability: Capability
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy: PrincipalId
  readonly artifactHash: string
  readonly promotionCount: number
}

/**
 * What the journal knows about one Module.
 */
export interface ModuleRecord {
  readonly moduleId: string
  readonly hash: string
  readonly status: ModuleStatus
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy: PrincipalId
  readonly artifactHash: string
  readonly promotionCount: number
}

/**
 * What the journal knows about one App.
 */
export interface AppRecord {
  readonly appId: string
  readonly hash: string
  readonly status: AppStatus
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy: PrincipalId
  readonly artifactHash: string
  readonly moduleHashes: readonly string[]
  readonly promotionCount: number
}

/* -------------------------------------------------------------- projections */

/**
 * Structural progress for the Foundry.
 *
 * Counts, never a fabricated percentage.
 */
export interface FoundryProgress {
  readonly artifactsTotal: number
  readonly artifactsVerified: number
  readonly artifactsPromoted: number
  readonly artifactsActive: number
  readonly toolsTotal: number
  readonly toolsActive: number
  readonly modulesTotal: number
  readonly modulesActive: number
  readonly appsTotal: number
  readonly appsActive: number
  /** One line a board can render without interpreting the counts. */
  readonly summary: string
}

/**
 * Why a Foundry operation could not continue, in the engine's own words.
 */
export const FOUNDRY_REASONS = Object.freeze({
  notAuthorized: 'the caller is not authorized to perform this operation',
  artifactNotFound: 'the artifact does not exist',
  toolNotFound: 'the tool does not exist',
  moduleNotFound: 'the module does not exist',
  appNotFound: 'the app does not exist',
  invalidTransition: 'the requested lifecycle transition is not permitted',
  invalidCapability: 'the requested capability is not in the closed capability vocabulary',
  invalidReason: 'the reason must be non-empty and within the Foundry reason limit',
  invalidExpiry: 'the activation expiry must be a valid future instant',
  notVerified: 'the artifact has not been verified and cannot be promoted',
  notPromoted: 'the artifact has not been promoted and cannot be activated',
  alreadyActive: 'the artifact is already active',
  alreadyDeprecated: 'the artifact is already deprecated',
  verificationRequired: 'verification evidence is required before this operation',
  promotionRequired: 'promotion is required before this operation',
  activationRequired: 'activation is required before this operation',
  limitArtifactsPerRun: 'the run reached its artifact ceiling',
  limitTools: 'the Foundry reached its tool ceiling',
  limitModules: 'the Foundry reached its module ceiling',
  limitApps: 'the Foundry reached its app ceiling',
  limitVerifications: 'the artifact reached its verification ceiling',
  limitPromotions: 'the artifact reached its promotion ceiling',
  limitActivations: 'the artifact reached its activation ceiling',
  contentTooLarge: 'the artifact content is too large',
  contentNotData: 'the artifact content is not valid data',
  parentNotFound: 'the parent artifact does not exist',
  specNotFound: 'the spec artifact does not exist',
  moduleNotActive: 'a required module is not active',
  alreadyExists: 'an artifact with this identity already exists',
} as const)
