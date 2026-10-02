import type { AnyCoreEvent } from '../events/envelope'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  FOUNDRY_LIMITS,
  FOUNDRY_REASONS,
  type ActivationRecord,
  type AppStatus,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactStatus,
  type ModuleRecord,
  type ModuleStatus,
  type PromotionRecord,
  type ToolStatus,
  type VerificationRecord,
  type Verdict,
} from './types'
import {
  initialFoundryState,
  reduceFoundryState,
  type FoundryState,
} from './state'

/**
 * THE FOUNDRY ENGINE.
 *
 * This is the only door from a Work Run to a reusable artifact. It is
 * generic on purpose: a tool, a module, an app and a plain artifact are all
 * just a `FoundryArtifact` here, and `core/foundry/` names none of them. A
 * future thing that can be expressed as "build this, verify it, promote it,
 * activate it" attaches by registering one of these — it does not get a new
 * engine.
 *
 * ## Three rules the shapes enforce
 *
 * **1. Creation is through Work, never raw.** An artifact is created by a
 * Step inside a Run, under the authority of the principal that owns the Run.
 * There is no path from a renderer or a model to `createArtifact` that does
 * not go through a Run.
 *
 * **2. Verification is separate from creation.** A verifier is a separately
 * registered piece of code that checks an artifact against its spec and
 * produces evidence. The verdict is derived from the evidence by this engine,
 * not by the verifier itself, so that a verifier cannot mark its own work as
 * passed.
 *
 * **3. Promotion and activation are explicit and owner-only.** A thing that
 * was verified is not thereby promoted; a thing that was promoted is not
 * thereby active. Each transition requires the owner's explicit
 * authorization, and each is recorded with the principal that authorized it.
 */

/** What a caller may say about an artifact creation request. */
export interface CreateArtifactRequest {
  /** The Run that is producing this artifact. */
  readonly runId: string
  /** The Step within that Run that is creating it. */
  readonly stepId: string
  /** The principal that owns the Run. */
  readonly createdBy: PrincipalId
  /** What kind of artifact this is. */
  readonly kind: ArtifactKind
  /** The artifact's content. Sanitised before arrival. */
  readonly content: Record<string, unknown>
  /** The parent artifact's identity, if derived. */
  readonly parentHash?: string | null
  /** The spec this artifact is built against, if any. */
  readonly specHash?: string | null
}

/** What a caller may say about a verification request. */
export interface VerifyArtifactRequest {
  /** The artifact to verify. */
  readonly artifactHash: string
  /** The verifier to use. */
  readonly verifierName: string
  /** The principal requesting verification. */
  readonly requestedBy: PrincipalId
}

/** What a caller may say about a promotion request. */
export interface PromoteArtifactRequest {
  /** The artifact to promote. */
  readonly artifactHash: string
  /** The target status. */
  readonly toStatus: ArtifactStatus | ToolStatus | ModuleStatus | AppStatus
  /** The principal authorizing the promotion. Must be the owner. */
  readonly promotedBy: PrincipalId
  /** Why, in words a person can read. */
  readonly reason: string
}

/** What a caller may say about an activation request. */
export interface ActivateArtifactRequest {
  /** The artifact to activate. */
  readonly artifactHash: string
  /** The target status. */
  readonly toStatus: ArtifactStatus | ToolStatus | ModuleStatus | AppStatus
  /** The principal authorizing the activation. Must be the owner. */
  readonly activatedBy: PrincipalId
  /** Why, in words a person can read. */
  readonly reason: string
  /** When this activation expires, if bounded. */
  readonly expiresAt?: string | null
}

/** The result of a Foundry operation. */
export interface FoundryResult {
  readonly ok: boolean
  /** The artifact's identity, when one was created or found. */
  readonly hash?: string
  /** The verification record, when one was produced. */
  readonly verification?: VerificationRecord
  /** The promotion record, when one was produced. */
  readonly promotion?: PromotionRecord
  /** The activation record, when one was produced. */
  readonly activation?: ActivationRecord
  /** Why a refusal happened, in the engine's own words. */
  readonly reason?: string
}

/**
 * The Foundry engine.
 *
 * One instance per Core. It holds the registry of verifiers, the state
 * reducer, and the journal append function. It is the only thing that can
 * write `foundry.*` events.
 */
export class FoundryEngine {
  private state: FoundryState
  private readonly verifiers = new Map<string, FoundryVerifier>()
  private readonly append: (event: AnyCoreEvent) => void
  private readonly now: () => Date

  constructor(
    append: (event: AnyCoreEvent) => void,
    now: () => Date = () => new Date(),
  ) {
    this.state = initialFoundryState()
    this.append = append
    this.now = now
  }

  /** Replay an event into state. Called by Core on journal replay. */
  replay(event: AnyCoreEvent): void {
    this.state = reduceFoundryState(this.state, event)
  }

  /** Append an event to the journal and replay it into state. */
  private commit(event: AnyCoreEvent): void {
    this.append(event)
    this.replay(event)
  }

  /** The current state, for projections. */
  getState(): FoundryState {
    return this.state
  }

  /* ------------------------------------------------------------ verifiers */

  /**
   * Register a verifier.
   *
   * A verifier is a separately registered piece of code that checks an
   * artifact against its spec and produces evidence. The verdict is derived
   * from the evidence by this engine, not by the verifier itself.
   */
  registerVerifier(verifier: FoundryVerifier): void {
    if (this.verifiers.has(verifier.name)) {
      throw new Error(`verifier already registered: ${verifier.name}`)
    }
    this.verifiers.set(verifier.name, verifier)
  }

  verifier(name: string): FoundryVerifier | undefined {
    return this.verifiers.get(name)
  }

  verifierNames(): readonly string[] {
    return [...this.verifiers.keys()].sort()
  }

  /* ------------------------------------------------------------- creation */

  /**
   * Create an artifact.
   *
   * The artifact is created by a Step inside a Run, under the authority of
   * the principal that owns the Run. There is no path from a renderer or a
   * model to this method that does not go through a Run.
   *
   * The content is sanitised before arrival, and the identity is computed
   * from the sanitised content and the inputs, so that "what this is" is a
   * fact derived from its content rather than a label somebody attached.
   */
  createArtifact(request: CreateArtifactRequest): FoundryResult {
    const { runId, stepId, createdBy, kind, content, parentHash, specHash } = request

    if (createdBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const sanitised = sanitiseContent(content)
    if (!sanitised.ok) {
      return { ok: false, reason: sanitised.reason }
    }

    const hash = computeHash(sanitised.value, parentHash ?? null, specHash ?? null)

    const existing = findArtifactByHash(this.state, hash)
    if (existing) {
      return { ok: false, reason: FOUNDRY_REASONS.alreadyExists, hash }
    }

    const artifactCount = countArtifactsForRun(this.state, runId)
    if (artifactCount >= FOUNDRY_LIMITS.maxArtifactsPerRun) {
      return { ok: false, reason: FOUNDRY_REASONS.limitArtifactsPerRun }
    }

    const artifactId = `art_${hash.slice(0, 16)}`
    const at = this.now().toISOString()

    this.commit({
      eventId: `evt_${artifactId}`,
      sequence: 0,
      type: 'foundry.artifact.created',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: createdBy,
      correlationId: runId,
      causationId: null,
      payload: {
        artifactId,
        hash,
        kind,
        runId,
        stepId,
        createdBy,
        parentHash: parentHash ?? null,
        specHash: specHash ?? null,
        contentLength: JSON.stringify(sanitised.value).length,
      },
    })

    return { ok: true, hash }
  }

  /* ----------------------------------------------------------- verification */

  /**
   * Verify an artifact against its spec.
   *
   * The verifier is a separately registered piece of code that checks the
   * artifact and produces evidence. The verdict is derived from the evidence
   * by this engine, not by the verifier itself, so that a verifier cannot
   * mark its own work as passed.
   */
  verifyArtifact(request: VerifyArtifactRequest): FoundryResult {
    const { artifactHash, verifierName, requestedBy } = request

    if (requestedBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const artifact = findArtifactByHash(this.state, artifactHash)
    if (!artifact) {
      return { ok: false, reason: FOUNDRY_REASONS.artifactNotFound }
    }

    const verifier = this.verifiers.get(verifierName)
    if (!verifier) {
      return { ok: false, reason: FOUNDRY_REASONS.verificationRequired }
    }

    const verificationCount = this.state.verifications.get(artifactHash)?.length ?? 0
    if (verificationCount >= FOUNDRY_LIMITS.maxVerificationsPerArtifact) {
      return { ok: false, reason: FOUNDRY_REASONS.limitVerifications }
    }

    const evidence = verifier.verify(artifactHash)
    const verdict = deriveVerdict(evidence)

    const verificationId = `ver_${artifactHash.slice(0, 12)}_${verificationCount}`
    const at = this.now().toISOString()

    const record: VerificationRecord = {
      verificationId,
      artifactHash,
      verifierName,
      verdict,
      evidence: evidence.slice(0, FOUNDRY_LIMITS.maxSummaryChars),
      verifiedAt: at,
      requestedBy,
    }

    this.commit({
      eventId: `evt_${verificationId}`,
      sequence: 0,
      type: 'foundry.verification.recorded',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: requestedBy,
      correlationId: artifact.runId,
      causationId: null,
      payload: {
        verificationId,
        artifactHash,
        verifierName,
        verdict,
        evidence: record.evidence,
        verifiedAt: at,
        requestedBy,
      },
    })

    if (verdict === 'passed') {
      this.commit({
        eventId: `evt_${verificationId}_transition`,
        sequence: 0,
        type: 'foundry.artifact.transitioned',
        schemaVersion: 1,
        occurredAt: at,
        source: 'core',
        actor: requestedBy,
        correlationId: artifact.runId,
        causationId: null,
        payload: {
          artifactId: artifact.artifactId,
          toStatus: 'verified',
        },
      })
    }

    return { ok: true, hash: artifactHash, verification: record }
  }

  /* ------------------------------------------------------------- promotion */

  /**
   * Promote an artifact.
   *
   * Promotion is the explicit, owner-authorized gate between "verified" and
   * "reusable". A thing that was verified is not thereby promoted; promotion
   * is a separate decision that requires the owner's explicit authorization.
   */
  promoteArtifact(request: PromoteArtifactRequest): FoundryResult {
    const { artifactHash, toStatus, promotedBy, reason } = request

    if (promotedBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const artifact = findArtifactByHash(this.state, artifactHash)
    if (!artifact) {
      return { ok: false, reason: FOUNDRY_REASONS.artifactNotFound }
    }

    if (artifact.status !== 'verified') {
      return { ok: false, reason: FOUNDRY_REASONS.notVerified }
    }

    const promotionCount = this.state.promotions.get(artifactHash)?.length ?? 0
    if (promotionCount >= FOUNDRY_LIMITS.maxPromotionsPerArtifact) {
      return { ok: false, reason: FOUNDRY_REASONS.limitPromotions }
    }

    const verificationId = this.state.verifications.get(artifactHash)?.at(-1)?.verificationId
    if (!verificationId) {
      return { ok: false, reason: FOUNDRY_REASONS.verificationRequired }
    }

    const promotionId = `pro_${artifactHash.slice(0, 12)}_${promotionCount}`
    const at = this.now().toISOString()

    const record: PromotionRecord = {
      promotionId,
      artifactHash,
      fromStatus: artifact.status,
      toStatus,
      promotedBy,
      promotedAt: at,
      reason,
      verificationId,
    }

    this.commit({
      eventId: `evt_${promotionId}`,
      sequence: 0,
      type: 'foundry.promotion.recorded',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: promotedBy,
      correlationId: artifact.runId,
      causationId: null,
      payload: {
        promotionId,
        artifactHash,
        fromStatus: artifact.status,
        toStatus,
        promotedBy,
        promotedAt: at,
        reason,
        verificationId,
      },
    })

    this.commit({
      eventId: `evt_${promotionId}_transition`,
      sequence: 0,
      type: 'foundry.artifact.transitioned',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: promotedBy,
      correlationId: artifact.runId,
      causationId: null,
      payload: {
        artifactId: artifact.artifactId,
        toStatus,
      },
    })

    return { ok: true, hash: artifactHash, promotion: record }
  }

  /* ------------------------------------------------------------ activation */

  /**
   * Activate an artifact.
   *
   * Activation is the explicit, owner-authorized gate between "promoted" and
   * "active". A thing that was promoted is not thereby active; activation is
   * a separate decision that requires the owner's explicit authorization.
   *
   * Activation is bounded and reversible: an active thing can be deactivated,
   * and deactivation is explicit and recorded.
   */
  activateArtifact(request: ActivateArtifactRequest): FoundryResult {
    const { artifactHash, toStatus, activatedBy, reason, expiresAt } = request

    if (activatedBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const artifact = findArtifactByHash(this.state, artifactHash)
    if (!artifact) {
      return { ok: false, reason: FOUNDRY_REASONS.artifactNotFound }
    }

    if (artifact.status !== 'promoted') {
      return { ok: false, reason: FOUNDRY_REASONS.notPromoted }
    }

    const activationCount = this.state.activations.get(artifactHash)?.length ?? 0
    if (activationCount >= FOUNDRY_LIMITS.maxActivationsPerArtifact) {
      return { ok: false, reason: FOUNDRY_REASONS.limitActivations }
    }

    const activationId = `act_${artifactHash.slice(0, 12)}_${activationCount}`
    const at = this.now().toISOString()

    const record: ActivationRecord = {
      activationId,
      artifactHash,
      fromStatus: artifact.status,
      toStatus,
      activatedBy,
      activatedAt: at,
      reason,
      expiresAt: expiresAt ?? null,
    }

    this.commit({
      eventId: `evt_${activationId}`,
      sequence: 0,
      type: 'foundry.activation.recorded',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: activatedBy,
      correlationId: artifact.runId,
      causationId: null,
      payload: {
        activationId,
        artifactHash,
        fromStatus: artifact.status,
        toStatus,
        activatedBy,
        activatedAt: at,
        reason,
        expiresAt: expiresAt ?? null,
      },
    })

    this.commit({
      eventId: `evt_${activationId}_transition`,
      sequence: 0,
      type: 'foundry.artifact.transitioned',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: activatedBy,
      correlationId: artifact.runId,
      causationId: null,
      payload: {
        artifactId: artifact.artifactId,
        toStatus,
      },
    })

    return { ok: true, hash: artifactHash, activation: record }
  }

  /* --------------------------------------------------------------- tools */

  /**
   * Register a tool.
   *
   * A tool is a reusable executable capability. It is created through the
   * Work engine (a Run produces it), verified against its spec, promoted by
   * explicit owner decision, and then activated — which means it becomes
   * available for invocation.
   */
  registerTool(request: RegisterToolRequest): FoundryResult {
    const { hash, name, capability, createdBy, artifactHash } = request

    if (createdBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const toolCount = this.state.tools.size
    if (toolCount >= FOUNDRY_LIMITS.maxTools) {
      return { ok: false, reason: FOUNDRY_REASONS.limitTools }
    }

    const toolId = `tool_${hash.slice(0, 12)}`
    const at = this.now().toISOString()

    this.commit({
      eventId: `evt_${toolId}`,
      sequence: 0,
      type: 'foundry.tool.registered',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: createdBy,
      correlationId: '',
      causationId: null,
      payload: {
        toolId,
        hash,
        name,
        capability,
        createdBy,
        artifactHash,
      },
    })

    return { ok: true, hash }
  }

  /* -------------------------------------------------------------- modules */

  /**
   * Register a module.
   *
   * A module is a composable unit of functionality. It is created through
   * the Work engine, verified against its spec, promoted, and then activated
   * — which means it can be composed into an app.
   */
  registerModule(request: RegisterModuleRequest): FoundryResult {
    const { hash, name, createdBy, artifactHash } = request

    if (createdBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const moduleCount = this.state.modules.size
    if (moduleCount >= FOUNDRY_LIMITS.maxModules) {
      return { ok: false, reason: FOUNDRY_REASONS.limitModules }
    }

    const moduleId = `mod_${hash.slice(0, 12)}`
    const at = this.now().toISOString()

    this.commit({
      eventId: `evt_${moduleId}`,
      sequence: 0,
      type: 'foundry.module.registered',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: createdBy,
      correlationId: '',
      causationId: null,
      payload: {
        moduleId,
        hash,
        name,
        createdBy,
        artifactHash,
      },
    })

    return { ok: true, hash }
  }

  /* ----------------------------------------------------------------- apps */

  /**
   * Register an app.
   *
   * An app is a deployable/runnable application composed of modules. It is
   * created through the Work engine, verified against its spec, promoted,
   * installed, and then activated. There is no silent auto-install or
   * auto-execute.
   */
  registerApp(request: RegisterAppRequest): FoundryResult {
    const { hash, name, createdBy, artifactHash, moduleHashes } = request

    if (createdBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const appCount = this.state.apps.size
    if (appCount >= FOUNDRY_LIMITS.maxApps) {
      return { ok: false, reason: FOUNDRY_REASONS.limitApps }
    }

    for (const moduleHash of moduleHashes) {
      const module = findModuleByHash(this.state, moduleHash)
      if (!module) {
        return { ok: false, reason: FOUNDRY_REASONS.moduleNotFound }
      }
      if (module.status !== 'active') {
        return { ok: false, reason: FOUNDRY_REASONS.moduleNotActive }
      }
    }

    const appId = `app_${hash.slice(0, 12)}`
    const at = this.now().toISOString()

    this.commit({
      eventId: `evt_${appId}`,
      sequence: 0,
      type: 'foundry.app.registered',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: createdBy,
      correlationId: '',
      causationId: null,
      payload: {
        appId,
        hash,
        name,
        createdBy,
        artifactHash,
        moduleHashes: [...moduleHashes],
      },
    })

    return { ok: true, hash }
  }
}

/* -------------------------------------------------------------- requests */

export interface RegisterToolRequest {
  readonly hash: string
  readonly name: string
  readonly capability: string
  readonly createdBy: PrincipalId
  readonly artifactHash: string
}

export interface RegisterModuleRequest {
  readonly hash: string
  readonly name: string
  readonly createdBy: PrincipalId
  readonly artifactHash: string
}

export interface RegisterAppRequest {
  readonly hash: string
  readonly name: string
  readonly createdBy: PrincipalId
  readonly artifactHash: string
  readonly moduleHashes: readonly string[]
}

/* -------------------------------------------------------------- verifiers */

/**
 * How an artifact is checked against its spec.
 *
 * Registered separately from the artifact and given only the artifact's
 * identity and spec. This is the mechanism behind "a model claim can never
 * mark work verified": a verifier is a separately registered piece of code
 * that checks an artifact and produces evidence, and the verdict is derived
 * from the evidence by the engine, not by the verifier itself.
 */
export interface FoundryVerifier {
  readonly name: string
  verify(artifactHash: string): string
}

/* -------------------------------------------------------------- helpers */

function findArtifactByHash(state: FoundryState, hash: string): ArtifactRecord | undefined {
  for (const artifact of state.artifacts.values()) {
    if (artifact.hash === hash) return artifact
  }
  return undefined
}

function findModuleByHash(state: FoundryState, hash: string): ModuleRecord | undefined {
  for (const module of state.modules.values()) {
    if (module.hash === hash) return module
  }
  return undefined
}

function countArtifactsForRun(state: FoundryState, runId: string): number {
  let count = 0
  for (const artifact of state.artifacts.values()) {
    if (artifact.runId === runId) count++
  }
  return count
}

function computeHash(
  content: Record<string, unknown>,
  parentHash: string | null,
  specHash: string | null,
): string {
  const input = JSON.stringify({ content, parentHash, specHash })
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return Math.abs(hash).toString(16).padStart(16, '0')
}

function deriveVerdict(evidence: string): Verdict {
  if (evidence.length === 0) return 'inconclusive'
  if (evidence.startsWith('PASS')) return 'passed'
  if (evidence.startsWith('FAIL')) return 'failed'
  return 'inconclusive'
}

const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function sanitiseContent(content: unknown): { ok: boolean; reason: string; value: Record<string, unknown> } {
  if (content === undefined || content === null) return { ok: true, reason: '', value: {} }
  if (typeof content !== 'object' || Array.isArray(content)) {
    return { ok: false, reason: FOUNDRY_REASONS.contentNotData, value: {} }
  }

  const out: Record<string, unknown> = {}
  const entries = Object.entries(content as Record<string, unknown>)
  if (entries.length > FOUNDRY_LIMITS.maxContentFields) {
    return { ok: false, reason: FOUNDRY_REASONS.contentTooLarge, value: {} }
  }

  for (const [key, raw] of entries) {
    if (RESERVED_FIELD_NAMES.has(key)) {
      return { ok: false, reason: FOUNDRY_REASONS.contentNotData, value: {} }
    }
    const clean = sanitiseValue(raw, 1)
    if (!clean.ok) return { ok: false, reason: clean.reason, value: {} }
    out[key] = clean.value
  }

  let serialised: string
  try {
    serialised = JSON.stringify(out)
  } catch {
    return { ok: false, reason: FOUNDRY_REASONS.contentNotData, value: {} }
  }
  if (serialised.length > FOUNDRY_LIMITS.maxContentBytes) {
    return { ok: false, reason: FOUNDRY_REASONS.contentTooLarge, value: {} }
  }
  return { ok: true, reason: '', value: out }
}

function sanitiseValue(value: unknown, depth: number): { ok: boolean; reason: string; value: unknown } {
  if (depth > FOUNDRY_LIMITS.maxContentDepth) {
    return { ok: false, reason: FOUNDRY_REASONS.contentTooLarge, value: null }
  }
  if (value === null) return { ok: true, reason: '', value: null }

  switch (typeof value) {
    case 'string':
      return value.length <= FOUNDRY_LIMITS.maxContentBytes
        ? { ok: true, reason: '', value }
        : { ok: false, reason: FOUNDRY_REASONS.contentTooLarge, value: null }
    case 'boolean':
      return { ok: true, reason: '', value }
    case 'number':
      return Number.isFinite(value)
        ? { ok: true, reason: '', value }
        : { ok: false, reason: FOUNDRY_REASONS.contentNotData, value: null }
    default:
      return { ok: false, reason: FOUNDRY_REASONS.contentNotData, value: null }
  }
}
