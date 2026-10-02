import { createHash } from 'node:crypto'

import type { AnyCoreEvent } from '../events/envelope'
import type { Capability, PrincipalId } from '../protocol/core-protocol'
import type { FoundryProjection } from '../protocol/foundry'
import { isCapability } from '../security/guard'
import {
  FOUNDRY_LIMITS,
  FOUNDRY_REASONS,
  canTransitionApp,
  canTransitionArtifact,
  canTransitionModule,
  canTransitionTool,
  type ActivationRecord,
  type AppRecord,
  type AppStatus,
  type ArtifactKind,
  type ArtifactRecord,
  type ModuleRecord,
  type ModuleStatus,
  type PromotionRecord,
  type ToolRecord,
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
  /** Promotion has exactly one legal target. */
  readonly toStatus: 'promoted'
  /** The principal authorizing the promotion. Must be the owner. */
  readonly promotedBy: PrincipalId
  /** Why, in words a person can read. */
  readonly reason: string
}

/** What a caller may say about an activation request. */
export interface ActivateArtifactRequest {
  /** The artifact to activate. */
  readonly artifactHash: string
  /** Activation has exactly one legal target. */
  readonly toStatus: 'active'
  /** The principal authorizing the activation. Must be the owner. */
  readonly activatedBy: PrincipalId
  /** Why, in words a person can read. */
  readonly reason: string
  /** Optional expiry metadata. Phase 15 does not schedule a timer from it. */
  readonly expiresAt?: string | null
}

export interface DeactivateArtifactRequest {
  readonly artifactHash: string
  readonly deactivatedBy: PrincipalId
  readonly reason: string
}

export interface TransitionToolRequest {
  readonly hash: string
  readonly toStatus: ToolStatus
  readonly changedBy: PrincipalId
}

export interface TransitionModuleRequest {
  readonly hash: string
  readonly toStatus: ModuleStatus
  readonly changedBy: PrincipalId
}

export interface TransitionAppRequest {
  readonly hash: string
  readonly toStatus: AppStatus
  readonly changedBy: PrincipalId
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
  private readonly append: (event: AnyCoreEvent) => AnyCoreEvent | void | Promise<AnyCoreEvent | void>
  private readonly now: () => Date

  constructor(
    append: (event: AnyCoreEvent) => AnyCoreEvent | void | Promise<AnyCoreEvent | void>,
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

  /** Persist an event first, then replay the exact durable event into state. */
  private async commit(event: AnyCoreEvent): Promise<void> {
    const persisted = await this.append(event)
    this.replay(persisted ?? event)
  }

  /** The current state, for Core-owned composition and tests. */
  getState(): FoundryState {
    return this.state
  }

  /** A read-only, content-free projection safe to cross the renderer seam. */
  projection(): FoundryProjection {
    const artifacts = [...this.state.artifacts.values()].map(({ artifactId: _artifactId, ...record }) => record)
    const tools = [...this.state.tools.values()].map((record) => ({ ...record }))
    const modules = [...this.state.modules.values()].map((record) => ({ ...record }))
    const apps = [...this.state.apps.values()].map((record) => ({ ...record, moduleHashes: [...record.moduleHashes] }))
    const verifications = [...this.state.verifications.values()].flat().map((record) => ({ ...record }))
    const promotions = [...this.state.promotions.values()].flat().map((record) => ({ ...record }))
    const activations = [...this.state.activations.values()].flat().map((record) => ({ ...record }))

    return {
      health: 'ready',
      reason: null,
      artifacts,
      tools,
      modules,
      apps,
      verifications,
      promotions,
      activations,
      counts: {
        artifacts: artifacts.length,
        artifactsVerified: artifacts.filter((item) => item.status === 'verified').length,
        artifactsPromoted: artifacts.filter((item) => item.status === 'promoted').length,
        artifactsActive: artifacts.filter((item) => item.status === 'active').length,
        tools: tools.length,
        toolsActive: tools.filter((item) => item.status === 'active').length,
        modules: modules.length,
        modulesActive: modules.filter((item) => item.status === 'active').length,
        apps: apps.length,
        appsActive: apps.filter((item) => item.status === 'active').length,
      },
      sequence: this.state.sequence,
    }
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
  async createArtifact(request: CreateArtifactRequest): Promise<FoundryResult> {
    const { runId, stepId, createdBy, kind, content, parentHash, specHash } = request

    if (createdBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }

    const sanitised = sanitiseContent(content)
    if (!sanitised.ok) {
      return { ok: false, reason: sanitised.reason }
    }

    if (parentHash && !findArtifactByHash(this.state, parentHash)) {
      return { ok: false, reason: FOUNDRY_REASONS.parentNotFound }
    }
    if (specHash && !findArtifactByHash(this.state, specHash)) {
      return { ok: false, reason: FOUNDRY_REASONS.specNotFound }
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

    await this.commit({
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
  async verifyArtifact(request: VerifyArtifactRequest): Promise<FoundryResult> {
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

    await this.commit({
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
        evidenceHash: createHash('sha256').update(evidence, 'utf8').digest('hex'),
        evidenceLength: evidence.length,
        verifiedAt: at,
        requestedBy,
      },
    })

    if (verdict === 'passed') {
      await this.commit({
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
  async promoteArtifact(request: PromoteArtifactRequest): Promise<FoundryResult> {
    const { artifactHash, toStatus, promotedBy, reason } = request

    if (promotedBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }
    if (toStatus !== 'promoted') {
      return { ok: false, reason: FOUNDRY_REASONS.invalidTransition }
    }
    if (!isBoundedReason(reason)) {
      return { ok: false, reason: FOUNDRY_REASONS.invalidReason }
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

    const latestVerification = this.state.verifications.get(artifactHash)?.at(-1)
    if (!latestVerification) {
      return { ok: false, reason: FOUNDRY_REASONS.verificationRequired }
    }
    if (latestVerification.verdict !== 'passed') {
      return { ok: false, reason: FOUNDRY_REASONS.notVerified }
    }
    const verificationId = latestVerification.verificationId

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

    await this.commit({
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

    await this.commit({
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
  async activateArtifact(request: ActivateArtifactRequest): Promise<FoundryResult> {
    const { artifactHash, toStatus, activatedBy, reason, expiresAt } = request

    if (activatedBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }
    if (toStatus !== 'active') {
      return { ok: false, reason: FOUNDRY_REASONS.invalidTransition }
    }
    if (!isBoundedReason(reason)) {
      return { ok: false, reason: FOUNDRY_REASONS.invalidReason }
    }
    if (expiresAt !== undefined && expiresAt !== null) {
      const parsedExpiry = Date.parse(expiresAt)
      if (!Number.isFinite(parsedExpiry) || parsedExpiry <= this.now().getTime()) {
        return { ok: false, reason: FOUNDRY_REASONS.invalidExpiry }
      }
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

    await this.commit({
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

    await this.commit({
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

  /** Explicitly deactivate an artifact, returning it to promoted/reusable state. */
  async deactivateArtifact(request: DeactivateArtifactRequest): Promise<FoundryResult> {
    const { artifactHash, deactivatedBy, reason } = request
    if (deactivatedBy !== 'owner') return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    if (!isBoundedReason(reason)) return { ok: false, reason: FOUNDRY_REASONS.invalidReason }

    const artifact = findArtifactByHash(this.state, artifactHash)
    if (!artifact) return { ok: false, reason: FOUNDRY_REASONS.artifactNotFound }
    if (!canTransitionArtifact(artifact.status, 'promoted')) {
      return { ok: false, reason: FOUNDRY_REASONS.invalidTransition }
    }

    const at = this.now().toISOString()
    await this.commit({
      eventId: `evt_deact_${artifactHash.slice(0, 12)}_${this.state.sequence + 1}`,
      sequence: 0,
      type: 'foundry.artifact.transitioned',
      schemaVersion: 1,
      occurredAt: at,
      source: 'core',
      actor: deactivatedBy,
      correlationId: artifact.runId,
      causationId: null,
      payload: { artifactId: artifact.artifactId, toStatus: 'promoted' },
    })
    return { ok: true, hash: artifactHash }
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
  async registerTool(request: RegisterToolRequest): Promise<FoundryResult> {
    const { hash, name, capability, createdBy, artifactHash } = request

    if (createdBy !== 'owner') {
      return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    }
    if (!isCapability(capability)) {
      return { ok: false, reason: FOUNDRY_REASONS.invalidCapability }
    }

    const toolCount = this.state.tools.size
    if (toolCount >= FOUNDRY_LIMITS.maxTools) {
      return { ok: false, reason: FOUNDRY_REASONS.limitTools }
    }

    const toolId = `tool_${hash.slice(0, 12)}`
    const at = this.now().toISOString()

    await this.commit({
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

  /** Move a registered Tool only along the closed lifecycle graph. */
  async transitionTool(request: TransitionToolRequest): Promise<FoundryResult> {
    const { hash, toStatus, changedBy } = request
    if (changedBy !== 'owner') return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    const tool = findToolByHash(this.state, hash)
    if (!tool) return { ok: false, reason: FOUNDRY_REASONS.toolNotFound }
    if (!canTransitionTool(tool.status, toStatus)) {
      return { ok: false, reason: FOUNDRY_REASONS.invalidTransition }
    }
    if (!entityTransitionBackedByArtifact(this.state, tool.artifactHash, toStatus)) {
      return { ok: false, reason: FOUNDRY_REASONS.verificationRequired }
    }

    await this.commit(foundryTransitionEvent('foundry.tool.transitioned', tool.toolId, 'toolId', toStatus, changedBy, this.state.sequence, this.now()))
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
  async registerModule(request: RegisterModuleRequest): Promise<FoundryResult> {
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

    await this.commit({
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

  /** Move a Module only along the closed lifecycle graph and backing artifact state. */
  async transitionModule(request: TransitionModuleRequest): Promise<FoundryResult> {
    const { hash, toStatus, changedBy } = request
    if (changedBy !== 'owner') return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    const module = findModuleByHash(this.state, hash)
    if (!module) return { ok: false, reason: FOUNDRY_REASONS.moduleNotFound }
    if (!canTransitionModule(module.status, toStatus)) {
      return { ok: false, reason: FOUNDRY_REASONS.invalidTransition }
    }
    if (!entityTransitionBackedByArtifact(this.state, module.artifactHash, toStatus)) {
      return { ok: false, reason: FOUNDRY_REASONS.verificationRequired }
    }

    await this.commit(foundryTransitionEvent('foundry.module.transitioned', module.moduleId, 'moduleId', toStatus, changedBy, this.state.sequence, this.now()))
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
  async registerApp(request: RegisterAppRequest): Promise<FoundryResult> {
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

    await this.commit({
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

  /** Move an App only along the closed lifecycle graph; activation needs active modules. */
  async transitionApp(request: TransitionAppRequest): Promise<FoundryResult> {
    const { hash, toStatus, changedBy } = request
    if (changedBy !== 'owner') return { ok: false, reason: FOUNDRY_REASONS.notAuthorized }
    const app = findAppByHash(this.state, hash)
    if (!app) return { ok: false, reason: FOUNDRY_REASONS.appNotFound }
    if (!canTransitionApp(app.status, toStatus)) {
      return { ok: false, reason: FOUNDRY_REASONS.invalidTransition }
    }
    if (!entityTransitionBackedByArtifact(this.state, app.artifactHash, toStatus)) {
      return { ok: false, reason: FOUNDRY_REASONS.verificationRequired }
    }
    if ((toStatus === 'installed' || toStatus === 'active') && !appModulesAreActive(this.state, app)) {
      return { ok: false, reason: FOUNDRY_REASONS.moduleNotActive }
    }

    await this.commit(foundryTransitionEvent('foundry.app.transitioned', app.appId, 'appId', toStatus, changedBy, this.state.sequence, this.now()))
    return { ok: true, hash }
  }
}

/* -------------------------------------------------------------- requests */

export interface RegisterToolRequest {
  readonly hash: string
  readonly name: string
  readonly capability: Capability
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

function findToolByHash(state: FoundryState, hash: string): ToolRecord | undefined {
  for (const tool of state.tools.values()) {
    if (tool.hash === hash) return tool
  }
  return undefined
}

function findModuleByHash(state: FoundryState, hash: string): ModuleRecord | undefined {
  for (const module of state.modules.values()) {
    if (module.hash === hash) return module
  }
  return undefined
}

function findAppByHash(state: FoundryState, hash: string): AppRecord | undefined {
  for (const app of state.apps.values()) {
    if (app.hash === hash) return app
  }
  return undefined
}

function entityTransitionBackedByArtifact(
  state: FoundryState,
  artifactHash: string,
  toStatus: ToolStatus | ModuleStatus | AppStatus,
): boolean {
  if (toStatus === 'registered' || toStatus === 'deprecated' || toStatus === 'revoked') return true
  const artifact = findArtifactByHash(state, artifactHash)
  if (!artifact) return false
  if (toStatus === 'verified') return ['verified', 'promoted', 'active'].includes(artifact.status)
  if (toStatus === 'promoted' || toStatus === 'installed') return ['promoted', 'active'].includes(artifact.status)
  if (toStatus === 'active') return artifact.status === 'active'
  return false
}

function appModulesAreActive(state: FoundryState, app: AppRecord): boolean {
  return app.moduleHashes.every((hash) => findModuleByHash(state, hash)?.status === 'active')
}

function foundryTransitionEvent(
  type: 'foundry.tool.transitioned' | 'foundry.module.transitioned' | 'foundry.app.transitioned',
  entityId: string,
  idKey: 'toolId' | 'moduleId' | 'appId',
  toStatus: ToolStatus | ModuleStatus | AppStatus,
  actor: PrincipalId,
  sequence: number,
  now: Date,
): AnyCoreEvent {
  return {
    eventId: `evt_${entityId}_${toStatus}_${sequence + 1}`,
    sequence: 0,
    type,
    schemaVersion: 1,
    occurredAt: now.toISOString(),
    source: 'core',
    actor,
    correlationId: entityId,
    causationId: null,
    payload: { [idKey]: entityId, toStatus },
  } as AnyCoreEvent
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
  // Canonicalise the flat data object before hashing so insertion order cannot
  // create a second identity for the same artifact content.
  const canonicalContent = Object.fromEntries(
    Object.entries(content).sort(([left], [right]) => left.localeCompare(right)),
  )
  const input = JSON.stringify({ content: canonicalContent, parentHash, specHash })
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function isBoundedReason(reason: string): boolean {
  return reason.trim().length > 0 && reason.length <= FOUNDRY_LIMITS.maxReasonChars
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
