import type { Capability } from '../../shared/contracts/capabilities'
import type { Confidence, EpistemicStatus, SourceTrust } from '../brain/types'
import type { WorldEntityNode, WorldState } from './state'
import type { WorldClaimKind, WorldFreshness, WorldLimits } from './types'
import { orderedWorldEdges } from './state'

/**
 * THE SELF MODEL.
 *
 * Seven compartments, and the whole point of this module is that they do not mix.
 *
 * | Compartment | Source | Durable here? |
 * | --- | --- | --- |
 * | identity | the Brain's `IdentityRoot` | yes, in the Brain |
 * | role | `IdentityRoot.role` | a descriptor, not an authorisation |
 * | capabilities | a live `Guard` evaluation | **never** |
 * | skills | the Skills projection | never |
 * | model identity | the provider set | never |
 * | worker claims | the Workforce claim ledger | never |
 * | beliefs | Phase 22 evidence | yes, as capped claims |
 *
 * ## Why five of the seven are read fresh every time
 *
 * A persisted copy of "what Freya can do" would be a second, stale copy of the
 * most security-relevant fact in the system — and Brain's own `SelfDefinition`
 * header says exactly this about the live half of the self model. So the durable
 * compartments are identity and beliefs, and everything that touches authority,
 * procedures or provider state is asked fresh and never written down.
 *
 * ## The separations, and what enforces each one
 *
 * - **A capability name is not a capability.** `assignedCapabilities` is whatever
 *   `Guard` answered just now, for the principal Core handed in. A claim in the
 *   world graph naming `security.stop` appears under `beliefs` at `low`
 *   confidence and nowhere else. There is no `has_capability` relation, and
 *   `normaliseWorldName` refuses a capability name as an entity.
 * - **Model identity is not authority.** `modelIdentity` reports who *would*
 *   answer. `cognition.allowed` names no provider precisely because authorisation
 *   happens before one is chosen, and nothing here reverses that.
 * - **Worker claims are data.** Every claim carries the Workforce's own decision
 *   beside it. Today's decision table is `['refused']`, so in practice every claim
 *   is reported refused — and the shape is built so a future value cannot be
 *   misread as authority.
 * - **Beliefs can never be verified.** Every channel's epistemic ceiling is below
 *   `verified`, so nothing under `beliefs` can reach it by any route.
 */

/* ------------------------------------------------------------ descriptors */

/** The Brain's identity root, as the self model is allowed to see it. */
export interface WorldIdentityDescriptor {
  readonly name: string
  readonly role: string
  readonly purpose: string
  readonly stableTraits: readonly string[]
  readonly communicationPrinciples: readonly string[]
  readonly continuityPrinciples: readonly string[]
  readonly claims: readonly { readonly claimId: string; readonly statement: string }[]
}

/** One limitation from the Brain's `SelfDefinition`. */
export interface WorldLimitationDescriptor {
  readonly limitationId: string
  readonly statement: string
}

/** What Guard just said about one capability. Computed by the caller, never stored. */
export interface WorldCapabilityDescriptor {
  readonly capability: Capability
  readonly held: boolean
}

/** What the Skills domain knows. A procedure is not a permission. */
export interface WorldSkillDescriptor {
  readonly skillId: string
  readonly name: string
  readonly status: string
  readonly version: number
  readonly verification: string
}

/** Which provider would answer. Never who may ask. */
export interface WorldModelDescriptor {
  readonly providerId: string
  readonly kind: string
  readonly live: boolean
}

/** One thing a worker claims about itself. Data, always with its decision. */
export interface WorldWorkerClaimDescriptor {
  readonly workerId: string
  readonly principalId: string
  readonly claimKind: string
  readonly decision: string
}

/**
 * The narrow read surface the self model needs.
 *
 * Every member is a function returning already-bounded data. There is no setter,
 * no `record()` and no way to add a compartment, which is what keeps "the self
 * model cannot be written" true of the type rather than of the code that uses it.
 */
export interface WorldSelfSource {
  identity(): WorldIdentityDescriptor | null
  limitations(): readonly WorldLimitationDescriptor[]
  /** A live Guard evaluation. The caller asks Guard; this module never can. */
  capabilities(): readonly WorldCapabilityDescriptor[]
  skills(): readonly WorldSkillDescriptor[]
  models(): readonly WorldModelDescriptor[]
  workerClaims(): readonly WorldWorkerClaimDescriptor[]
}

/** A self source that reports nothing, for a Core with no Brain, Skills or Workforce. */
export function emptyWorldSelfSource(): WorldSelfSource {
  return {
    identity: () => null,
    limitations: () => [],
    capabilities: () => [],
    skills: () => [],
    models: () => [],
    workerClaims: () => [],
  }
}

/* ----------------------------------------------------------- the model */

/** One compartment's contents, with the source named so a UI can say where it came from. */
export interface WorldSelfCompartment<T> {
  readonly source: string
  readonly items: readonly T[]
  /** How many exist in total, and how many are therefore not listed. */
  readonly total: number
  readonly listed: number
}

export interface WorldBelief {
  readonly evidenceId: string | null
  readonly edgeId: string
  readonly relationType: string
  readonly fromEntityId: string
  readonly toEntityId: string | null
  readonly claimKind: WorldClaimKind
  readonly source: SourceTrust
  readonly epistemic: EpistemicStatus
  readonly confidence: Confidence
  readonly freshness: WorldFreshness
}

export interface WorldUncertainty {
  readonly entityId: string
  readonly kind: string
  readonly reason: 'unknown' | 'conflicted' | 'stale' | 'dangling' | 'withheld'
  readonly edgeIds: readonly string[]
}

/**
 * What a surface may know about Freya from Core.
 *
 * Nothing here is an input to any authority path, and the `separation` block
 * states the rules in machine-readable form so a UI can render them rather than
 * infer them.
 */
export interface WorldSelfModel {
  readonly schemaVersion: number
  readonly sequence: number
  readonly identity: {
    readonly source: string
    readonly name: string
    readonly role: string
    readonly purpose: string
    readonly stableTraits: readonly string[]
    readonly communicationPrinciples: readonly string[]
    readonly continuityPrinciples: readonly string[]
    readonly claims: readonly { readonly claimId: string; readonly statement: string }[]
  } | null
  readonly role: {
    readonly descriptor: string | null
    readonly source: string
    /** Where stop state, grants and journal integrity actually live. */
    readonly securityStateOwner: string
    readonly securityStateAvailableHere: false
  }
  readonly assignedCapabilities: WorldSelfCompartment<{
    readonly capability: string
    readonly held: boolean
    readonly decidedBy: string
  }>
  readonly knownSkills: WorldSelfCompartment<{
    readonly skillId: string
    readonly name: string
    readonly status: string
    readonly version: number
    readonly verification: string
  }>
  readonly modelIdentity: WorldSelfCompartment<{
    readonly providerId: string
    readonly kind: string
    readonly live: boolean
  }>
  readonly workerClaims: WorldSelfCompartment<{
    readonly workerId: string
    readonly principalId: string
    readonly claimKind: string
    readonly decision: string
    readonly isAuthority: false
  }>
  readonly beliefs: WorldSelfCompartment<WorldBelief>
  readonly limitations: WorldSelfCompartment<{ readonly limitationId: string; readonly statement: string }>
  readonly uncertainties: {
    readonly listed: number
    readonly total: number
    readonly items: readonly WorldUncertainty[]
  }
  /** The rules, stated rather than assumed. */
  readonly separation: {
    readonly capabilitiesDecidedBy: string
    readonly capabilitiesPersisted: false
    readonly skillIsCapability: false
    readonly modelProviderIsAuthority: false
    readonly workerClaimIsAuthority: false
    readonly beliefCanBeVerified: false
    readonly selfModelGrants: false
  }
}

/** Which claim kinds count as beliefs: everything that is not the owner or Core. */
const BELIEF_CLAIM_KINDS: readonly WorldClaimKind[] = Object.freeze([
  'third_party_claim',
  'model_hypothesis',
  'unknown',
])

/**
 * Build the self model.
 *
 * Pure. `state` supplies beliefs and uncertainties; every other compartment comes
 * from `source`, read fresh. Nothing is written, and nothing here can reach Guard.
 */
export function buildWorldSelfModel(
  state: WorldState,
  source: WorldSelfSource,
  limits: WorldLimits,
  sequence: number,
): WorldSelfModel {
  const identity = source.identity()
  const capabilities = source.capabilities()
  const skills = source.skills()
  const models = source.models()
  const claims = source.workerClaims()
  const limitations = source.limitations()

  const beliefs = beliefEdges(state)
  const uncertainties = uncertaintyItems(state)

  return {
    schemaVersion: 1,
    sequence,
    identity:
      identity === null
        ? null
        : {
            source: 'brain_identity',
            name: identity.name,
            role: identity.role,
            purpose: identity.purpose,
            stableTraits: [...identity.stableTraits],
            communicationPrinciples: [...identity.communicationPrinciples],
            continuityPrinciples: [...identity.continuityPrinciples],
            claims: identity.claims.map((claim) => ({ claimId: claim.claimId, statement: claim.statement })),
          },
    role: {
      descriptor: identity === null ? null : identity.role,
      source: 'brain_identity',
      // The pointer, not the value. Duplicating STOP ALL or a grant count here
      // would create a second copy of the most security-relevant state in the
      // system, and a stale one is worse than none.
      securityStateOwner: 'guard_and_governor',
      securityStateAvailableHere: false,
    },
    assignedCapabilities: {
      source: 'guard_evaluation',
      items: capabilities.map((fact) => ({
        capability: fact.capability,
        held: fact.held,
        decidedBy: 'guard',
      })),
      total: capabilities.length,
      listed: capabilities.length,
    },
    knownSkills: {
      source: 'skills_domain',
      items: skills.map((skill) => ({
        skillId: skill.skillId,
        name: skill.name,
        status: skill.status,
        version: skill.version,
        verification: skill.verification,
      })),
      total: skills.length,
      listed: skills.length,
    },
    modelIdentity: {
      source: 'provider_set',
      items: models.map((model) => ({
        providerId: model.providerId,
        kind: model.kind,
        live: model.live,
      })),
      total: models.length,
      listed: models.length,
    },
    workerClaims: {
      source: 'workforce_claim_ledger',
      items: claims.map((claim) => ({
        workerId: claim.workerId,
        principalId: claim.principalId,
        claimKind: claim.claimKind,
        decision: claim.decision,
        isAuthority: false as const,
      })),
      total: claims.length,
      listed: claims.length,
    },
    beliefs: {
      source: 'world_evidence',
      items: beliefs.slice(0, limits.maxBeliefsListed),
      total: beliefs.length,
      listed: Math.min(beliefs.length, limits.maxBeliefsListed),
    },
    limitations: {
      source: 'brain_self_definition',
      items: limitations.map((limitation) => ({
        limitationId: limitation.limitationId,
        statement: limitation.statement,
      })),
      total: limitations.length,
      listed: limitations.length,
    },
    uncertainties: {
      listed: Math.min(uncertainties.length, limits.maxUncertaintiesListed),
      total: uncertainties.length,
      items: uncertainties.slice(0, limits.maxUncertaintiesListed),
    },
    separation: {
      capabilitiesDecidedBy: 'guard',
      capabilitiesPersisted: false,
      skillIsCapability: false,
      modelProviderIsAuthority: false,
      workerClaimIsAuthority: false,
      beliefCanBeVerified: false,
      selfModelGrants: false,
    },
  }
}

/**
 * Everything in the world that is somebody else's claim rather than the owner's
 * word or Core's own record.
 *
 * Ids and closed labels only — no names, no text — because a belief is also the
 * most attractive place for injected content to end up, and this list is the one
 * place untrusted assertions are gathered together.
 */
function beliefEdges(state: WorldState): readonly WorldBelief[] {
  return orderedWorldEdges(state.edges.values())
    .filter((edge) => BELIEF_CLAIM_KINDS.includes(edge.claimKind))
    .filter((edge) => edge.freshness !== 'withdrawn' && !edge.withheld)
    .map((edge) => ({
      evidenceId: edge.evidenceId,
      edgeId: edge.edgeId,
      relationType: edge.relationType,
      fromEntityId: edge.fromEntityId,
      toEntityId: edge.toEntityId,
      claimKind: edge.claimKind,
      source: edge.source,
      epistemic: edge.epistemic,
      confidence: edge.confidence,
      freshness: edge.freshness,
    }))
}

/**
 * What Freya does not know, said plainly.
 *
 * An uncertainty list is the reason a world model is honest rather than
 * confident-looking: "nobody knows whether these two are the same person" and
 * "two sources disagree about this" are both facts about the world, and a
 * projection that cannot express them will express certainty instead.
 */
function uncertaintyItems(state: WorldState): readonly WorldUncertainty[] {
  const items: WorldUncertainty[] = []
  const nodes: readonly WorldEntityNode[] = [...state.nodes.values()].sort((a, b) =>
    a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0,
  )

  for (const node of nodes) {
    if (node.withdrawn) continue
    if (node.contested) {
      items.push({ entityId: node.entityId, kind: node.kind, reason: 'conflicted', edgeIds: node.edgeIds })
      continue
    }
    if (node.confidence === 'unknown' || node.epistemic === 'unknown') {
      items.push({ entityId: node.entityId, kind: node.kind, reason: 'unknown', edgeIds: node.edgeIds })
      continue
    }
    if (node.freshness === 'stale' || node.freshness === 'historical' || node.freshness === 'aging') {
      items.push({ entityId: node.entityId, kind: node.kind, reason: 'stale', edgeIds: node.edgeIds })
    }
  }

  for (const edge of orderedWorldEdges(state.edges.values())) {
    if (edge.withheld || edge.freshness === 'withdrawn') continue
    if (!edge.dangling) continue
    items.push({ entityId: edge.fromEntityId, kind: edge.relationType, reason: 'dangling', edgeIds: [edge.edgeId] })
  }

  return items
}