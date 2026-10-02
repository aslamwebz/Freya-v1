import type { AnyCoreEvent, CoreEventType } from '../events/envelope'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  canTransitionApp,
  canTransitionArtifact,
  canTransitionModule,
  canTransitionTool,
  type AppRecord,
  type AppStatus,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactStatus,
  type ModuleRecord,
  type ModuleStatus,
  type ToolRecord,
  type ToolStatus,
  type Verdict,
} from './types'

/**
 * FOUNDRY STATE: a pure fold over the durable journal.
 *
 * ## Why Foundry has no store of its own
 *
 * Like Work, the Foundry's durable record is the journal. `foundry.*` events
 * are fsynced, sequence-ordered, validated against a closed schema and
 * replayed on every start. They hold only ids, hashes, statuses, counts and
 * lengths, so there is nothing in them for a store to protect.
 *
 * The separation that matters is kept explicit:
 *
 * - **History is durable** — what was built, verified, promoted, activated,
 *   and by whom. Replayed from disk on every start.
 * - **Live state is a process fact** — an artifact's content, a tool's
 *   executable, a module's composed interface. None of it is journalled, and
 *   none of it survives a restart.
 *
 * The reducer is pure and returns new objects, so replay and live operation
 * share one code path and cannot drift.
 */

export interface FoundryState {
  readonly artifacts: ReadonlyMap<string, ArtifactRecord>
  readonly tools: ReadonlyMap<string, ToolRecord>
  readonly modules: ReadonlyMap<string, ModuleRecord>
  readonly apps: ReadonlyMap<string, AppRecord>
  /** artifact hash → verification records. */
  readonly verifications: ReadonlyMap<string, readonly FoundryVerificationRecord[]>
  /** artifact hash → promotion records. */
  readonly promotions: ReadonlyMap<string, readonly FoundryPromotionRecord[]>
  /** artifact hash → activation records. */
  readonly activations: ReadonlyMap<string, readonly FoundryActivationRecord[]>
  /** Last durable sequence folded in. */
  readonly sequence: number
}

/**
 * A verification record as the reducer stores it.
 *
 * The evidence is bounded and structured, never the full verifier output.
 */
export interface FoundryVerificationRecord {
  readonly verificationId: string
  readonly artifactHash: string
  readonly verifierName: string
  readonly verdict: Verdict
  readonly evidence: string
  readonly verifiedAt: string
  readonly requestedBy: PrincipalId
}

/**
 * A promotion record as the reducer stores it.
 */
export interface FoundryPromotionRecord {
  readonly promotionId: string
  readonly artifactHash: string
  readonly fromStatus: string
  readonly toStatus: string
  readonly promotedBy: PrincipalId
  readonly promotedAt: string
  readonly reason: string
  readonly verificationId: string
}

/**
 * An activation record as the reducer stores it.
 */
export interface FoundryActivationRecord {
  readonly activationId: string
  readonly artifactHash: string
  readonly fromStatus: string
  readonly toStatus: string
  readonly activatedBy: PrincipalId
  readonly activatedAt: string
  readonly reason: string
  readonly expiresAt: string | null
}

export function initialFoundryState(): FoundryState {
  return {
    artifacts: new Map(),
    tools: new Map(),
    modules: new Map(),
    apps: new Map(),
    verifications: new Map(),
    promotions: new Map(),
    activations: new Map(),
    sequence: 0,
  }
}

const FOUNDRY_EVENT_PREFIX = 'foundry.'

export function isFoundryEvent(type: CoreEventType): boolean {
  return type.startsWith(FOUNDRY_EVENT_PREFIX)
}

export function reduceFoundryState(state: FoundryState, event: AnyCoreEvent): FoundryState {
  if (!isFoundryEvent(event.type)) {
    return event.sequence > state.sequence ? { ...state, sequence: event.sequence } : state
  }

  const next = apply(state, event)
  return { ...next, sequence: Math.max(state.sequence, event.sequence) }
}

function apply(state: FoundryState, event: AnyCoreEvent): FoundryState {
  const p = event.payload as FoundryPayloads
  const at = event.occurredAt

  switch (event.type) {
    case 'foundry.artifact.created': {
      const artifacts = new Map(state.artifacts)
      artifacts.set(p.artifactId, {
        artifactId: p.artifactId,
        hash: p.hash,
        kind: p.kind as ArtifactKind,
        status: 'draft',
        createdAt: at,
        updatedAt: at,
        runId: p.runId,
        stepId: p.stepId,
        createdBy: p.createdBy as PrincipalId,
        parentHash: p.parentHash ?? null,
        specHash: p.specHash ?? null,
        contentLength: p.contentLength ?? 0,
        promotionCount: 0,
      })
      return { ...state, artifacts }
    }

    case 'foundry.artifact.transitioned': {
      const existing = state.artifacts.get(p.artifactId)
      if (!existing) return state
      const to = p.toStatus as ArtifactStatus
      if (!canTransitionArtifact(existing.status, to)) return state
      const artifacts = new Map(state.artifacts)
      artifacts.set(p.artifactId, {
        ...existing,
        status: to,
        updatedAt: at,
        promotionCount:
          to === 'promoted' ? existing.promotionCount + 1 : existing.promotionCount,
      })
      return { ...state, artifacts }
    }

    case 'foundry.verification.recorded': {
      const verifications = new Map(state.verifications)
      const existing = verifications.get(p.artifactHash) ?? []
      const record: FoundryVerificationRecord = {
        verificationId: p.verificationId,
        artifactHash: p.artifactHash,
        verifierName: p.verifierName,
        verdict: p.verdict as Verdict,
        evidence: p.evidence ?? '',
        verifiedAt: at,
        requestedBy: p.requestedBy as PrincipalId,
      }
      verifications.set(p.artifactHash, [...existing, record])
      return { ...state, verifications }
    }

    case 'foundry.promotion.recorded': {
      const promotions = new Map(state.promotions)
      const existing = promotions.get(p.artifactHash) ?? []
      const record: FoundryPromotionRecord = {
        promotionId: p.promotionId,
        artifactHash: p.artifactHash,
        fromStatus: p.fromStatus,
        toStatus: p.toStatus,
        promotedBy: p.promotedBy as PrincipalId,
        promotedAt: at,
        reason: p.reason ?? '',
        verificationId: p.verificationId,
      }
      promotions.set(p.artifactHash, [...existing, record])
      return { ...state, promotions }
    }

    case 'foundry.activation.recorded': {
      const activations = new Map(state.activations)
      const existing = activations.get(p.artifactHash) ?? []
      const record: FoundryActivationRecord = {
        activationId: p.activationId,
        artifactHash: p.artifactHash,
        fromStatus: p.fromStatus,
        toStatus: p.toStatus,
        activatedBy: p.activatedBy as PrincipalId,
        activatedAt: at,
        reason: p.reason ?? '',
        expiresAt: p.expiresAt ?? null,
      }
      activations.set(p.artifactHash, [...existing, record])
      return { ...state, activations }
    }

    case 'foundry.tool.registered': {
      const tools = new Map(state.tools)
      tools.set(p.toolId, {
        toolId: p.toolId,
        hash: p.hash,
        status: 'draft',
        name: p.name,
        capability: p.capability as ToolRecord['capability'],
        createdAt: at,
        updatedAt: at,
        createdBy: p.createdBy as PrincipalId,
        artifactHash: p.artifactHash,
        promotionCount: 0,
      })
      return { ...state, tools }
    }

    case 'foundry.tool.transitioned': {
      const existing = state.tools.get(p.toolId)
      if (!existing) return state
      const to = p.toStatus as ToolStatus
      if (!canTransitionTool(existing.status, to)) return state
      const tools = new Map(state.tools)
      tools.set(p.toolId, {
        ...existing,
        status: to,
        updatedAt: at,
        promotionCount: to === 'promoted' ? existing.promotionCount + 1 : existing.promotionCount,
      })
      return { ...state, tools }
    }

    case 'foundry.module.registered': {
      const modules = new Map(state.modules)
      modules.set(p.moduleId, {
        moduleId: p.moduleId,
        hash: p.hash,
        status: 'draft',
        name: p.name,
        createdAt: at,
        updatedAt: at,
        createdBy: p.createdBy as PrincipalId,
        artifactHash: p.artifactHash,
        promotionCount: 0,
      })
      return { ...state, modules }
    }

    case 'foundry.module.transitioned': {
      const existing = state.modules.get(p.moduleId)
      if (!existing) return state
      const to = p.toStatus as ModuleStatus
      if (!canTransitionModule(existing.status, to)) return state
      const modules = new Map(state.modules)
      modules.set(p.moduleId, {
        ...existing,
        status: to,
        updatedAt: at,
        promotionCount: to === 'promoted' ? existing.promotionCount + 1 : existing.promotionCount,
      })
      return { ...state, modules }
    }

    case 'foundry.app.registered': {
      const apps = new Map(state.apps)
      apps.set(p.appId, {
        appId: p.appId,
        hash: p.hash,
        status: 'draft',
        name: p.name,
        createdAt: at,
        updatedAt: at,
        createdBy: p.createdBy as PrincipalId,
        artifactHash: p.artifactHash,
        moduleHashes: p.moduleHashes ?? [],
        promotionCount: 0,
      })
      return { ...state, apps }
    }

    case 'foundry.app.transitioned': {
      const existing = state.apps.get(p.appId)
      if (!existing) return state
      const to = p.toStatus as AppStatus
      if (!canTransitionApp(existing.status, to)) return state
      const apps = new Map(state.apps)
      apps.set(p.appId, {
        ...existing,
        status: to,
        updatedAt: at,
        promotionCount: to === 'promoted' ? existing.promotionCount + 1 : existing.promotionCount,
      })
      return { ...state, apps }
    }

    case 'foundry.limit.exceeded': {
      return state
    }

    default:
      return state
  }
}

/**
 * The payload fields the reducer reads, as one shape.
 */
interface FoundryPayloads {
  artifactId: string
  toolId: string
  moduleId: string
  appId: string
  hash: string
  kind: string
  name: string
  capability: string
  runId: string
  stepId: string
  createdBy: string
  parentHash: string | null
  specHash: string | null
  contentLength: number
  toStatus: string
  verificationId: string
  artifactHash: string
  verifierName: string
  verdict: string
  evidence: string
  verifiedAt: string
  requestedBy: string
  promotionId: string
  fromStatus: string
  promoteToStatus: string
  promotedBy: string
  promotedAt: string
  reason: string
  activationId: string
  activatedBy: string
  activatedAt: string
  expiresAt: string | null
  moduleHashes: readonly string[]
}
