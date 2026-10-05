import type { Brain } from '../brain/brain'
import { brainConflicts } from '../brain/retrieval'
import { RECALLABLE_STATUSES } from '../brain/types'
import { compilePromptBlock, runOwnerRequest, view } from './ownership'
import { overallReadiness, readinessOf } from './readiness'
import {
  exportMemoryBundle,
  importMemoryBundle,
  type MemoryExportResult,
  type MemoryImportResult,
} from './portability'
import {
  MEMORY_IDENTITY_LIMITS,
  MEMORY_IDENTITY_SCHEMA_VERSION,
  OWNER_CHANNEL,
  refuse,
  type MemoryIdentityMemoryView,
  type MemoryIdentityProjection,
  type MemoryIdentityDomainPorts,
  type OwnerMemoryRequest,
  type OwnerMemoryResult,
  type PromptInjection,
  type PromptInjectionRequest,
} from './types'

/**
 * THE UNIFIED MEMORY / IDENTITY SUBSYSTEM.
 *
 * One façade over the Brain and the seven other durable domains, with a promise per
 * method and a refusal code for every way that promise cannot be kept.
 *
 * ## What it is not
 *
 * It is **not** a second Brain. There is one store, one fold, one chain and one
 * admission policy, and they are the existing ones in `core/brain/`. This class holds
 * a reference to that `Brain` and adds no storage of its own — every byte it reports
 * on was written by the Brain's own pathways, and every byte it writes goes through
 * them. A subsystem that kept its own copy would produce two answers to "what does
 * Freya believe", and the wrong one would be the one that had been optimised.
 *
 * It is also **not** an authority surface. There is no method here that grants,
 * widens, checks or clears anything. `stopAll`, budgets, approvals, grants and
 * capability states are read live from Guard and the Governor and appear nowhere in
 * this directory — not in the projection, not in a prompt block, not in an exported
 * bundle. That is the reason memory and authority can be unified without one
 * contaminating the other: the boundary is drawn by *absence*, not by a check
 * somebody could forget to write.
 *
 * ## The method list is the contract
 *
 * `inspect`, `correct`, `withdraw`, `pin`, `unpin`, `recallFor`, `exportBundle`,
 * `importBundle`, `readiness`, `projection`. Anything the owner might reasonably ask
 * for that is not on that list is not supported, and adding it would mean adding a
 * capability somewhere else — not a branch here.
 */
export interface MemoryIdentityOptions {
  readonly brain: Brain
  /** The other domains' durability seams. Every one optional, none assumed. */
  readonly domains?: MemoryIdentityDomainPorts
  readonly now?: () => Date
  /**
   * The key used for portable bundles, or null when this machine has none.
   *
   * Null is a real state and it means **no export and no import** — reported as
   * `key_unavailable`. There is no plaintext bundle, no unencrypted fallback and no
   * "generate a key beside the data" path: a weaker format silently standing in for
   * an encrypted one is the failure a person cannot detect.
   */
  readonly bundleKey?: Uint8Array | null
}

export class MemoryIdentity {
  private readonly brain: Brain
  private readonly domains: MemoryIdentityDomainPorts
  private readonly now: () => Date
  private readonly bundleKey: Uint8Array | null

  constructor(options: MemoryIdentityOptions) {
    this.brain = options.brain
    this.domains = options.domains ?? {}
    this.now = options.now ?? (() => new Date())
    this.bundleKey = options.bundleKey ?? null
  }

  /* --------------------------------------------------------- owner control */

  /**
   * Inspect, correct, withdraw, pin or unpin one memory.
   *
   * Owner-only, and the check is on the request rather than on the caller, because a
   * boolean on a call site is something the call site controls.
   */
  async ownerRequest(request: OwnerMemoryRequest): Promise<OwnerMemoryResult> {
    return runOwnerRequest(this.brain, request)
  }

  /**
   * List what the owner is looking at, newest first.
   *
   * Bounded, and it says what it left out — a window that shows the first hundred
   * memories without saying there are four thousand would let somebody conclude they
   * had seen everything Freya holds.
   */
  listMemories(options: { limit?: number } = {}): {
    memories: readonly MemoryIdentityMemoryView[]
    total: number
    omitted: number
  } {
    const asked = options.limit ?? MEMORY_IDENTITY_LIMITS.maxInspectionItems
    const limit = Number.isFinite(asked)
      ? Math.max(0, Math.min(Math.floor(asked), MEMORY_IDENTITY_LIMITS.maxInspectionItems))
      : MEMORY_IDENTITY_LIMITS.maxInspectionItems
    const all = [...this.brain.state().memories.values()].sort((a, b) =>
      b.admittedAt === a.admittedAt ? a.memoryId.localeCompare(b.memoryId) : b.admittedAt.localeCompare(a.admittedAt),
    )
    return {
      memories: all.slice(0, limit).map((memory) => view(this.brain, memory)),
      total: all.length,
      omitted: Math.max(0, all.length - limit),
    }
  }

  /* ------------------------------------------------------------- recall */

  /**
   * The bounded block a model is allowed to see.
   *
   * Free, offline, synchronous and deterministic. No model call, no embedding, no
   * ranking model — see `core/brain/retrieval.ts` for why that is a correctness
   * requirement and not a limitation.
   */
  recallFor(request: PromptInjectionRequest): PromptInjection {
    return compilePromptBlock(this.brain, request)
  }

  /* ---------------------------------------------------------- portability */

  /**
   * Everything Freya believes, sealed so the owner can take it away.
   *
   * Carries memories and pinning decisions. Carries no identity, no authority, and
   * says so in the manifest — see `portability.ts`.
   */
  async exportBundle(passphrase?: string): Promise<MemoryExportResult> {
    return exportMemoryBundle(this.brain, {
      key: this.bundleKey,
      passphrase,
      now: this.now,
    })
  }

  /**
   * Bring a sealed bundle in, as untrusted evidence.
   *
   * Every record is re-admitted through the Brain's own policy at the lowest source
   * class, so an import cannot make a claim look stronger than it is, cannot claim
   * verification, and cannot carry a permission.
   */
  async importBundle(
    envelope: unknown,
    options: { channel: typeof OWNER_CHANNEL; passphrase?: string } ,
  ): Promise<MemoryImportResult> {
    if (options.channel !== OWNER_CHANNEL) {
      return { ok: false, refusal: refuse('not_an_owner_request'), report: null }
    }
    return importMemoryBundle(this.brain, envelope, {
      key: this.bundleKey,
      passphrase: options.passphrase,
      channel: OWNER_CHANNEL,
    })
  }

  /* ------------------------------------------------------------ reporting */

  /** What is durable, what is healthy, and what is simply not wired. */
  readiness() {
    return readinessOf(this.brain, this.domains)
  }

  /** The single status word, plus whether a restart would keep what was learned. */
  status(): { health: 'healthy' | 'degraded' | 'unavailable'; reason: string | null; durable: boolean } {
    return overallReadiness(this.brain, this.domains)
  }

  /**
   * Everything a renderer may know about Freya's memory and identity.
   *
   * A projection, not a handle: counts, health, durability, ownership decisions and
   * contradictions. No capability, budget, approval, grant or stop state, because
   * those are Guard's and the Governor's live truth and a stale copy of them would be
   * believed.
   */
  projection(): MemoryIdentityProjection {
    const status = this.status()
    const state = this.brain.state()
    const memories = [...state.memories.values()]
    const pinned = this.brain
      .pinnedMemoryIds()
      .map((memoryId) => {
        const memory = state.memories.get(memoryId)
        const decision = state.ownership.get(memoryId)
        return {
          memoryId,
          subject: memory?.subject ?? '',
          reason: decision?.reason ?? '',
        }
      })
      .filter((entry) => entry.subject.length > 0)

    return {
      schemaVersion: MEMORY_IDENTITY_SCHEMA_VERSION,
      health: status.health,
      reason: status.reason,
      persistence: this.brain.health().persistence,
      durable: status.durable,
      identity:
        state.identity === null
          ? null
          : {
              name: state.identity.name,
              role: state.identity.role,
              purpose: state.identity.purpose,
              claims: state.identity.claims.map((claim) => ({
                claimId: claim.claimId,
                statement: claim.statement,
              })),
            },
      self:
        state.self === null
          ? null
          : {
              complete: state.self.complete,
              capabilities: state.self.capabilities.map((capability) => ({
                capability: capability.capability,
                state: capability.state,
                cannot: capability.cannot,
              })),
              limitations: state.self.limitations.map((limitation) => ({
                limitationId: limitation.limitationId,
                statement: limitation.statement,
              })),
            },
      counts: {
        memories: memories.length,
        admitted: memories.filter((memory) => memory.status === 'admitted').length,
        conflicted: memories.filter((memory) => memory.status === 'conflicted').length,
        // From the reviews, because a refused candidate never becomes a memory —
        // counting memories would report zero refusals on a Brain that refused many.
        rejected: [...state.reviews.values()].filter((review) => review.decision === 'rejected').length,
        withdrawn: memories.filter((memory) => memory.status === 'archived').length,
        pinned: this.brain.pinnedMemoryIds().length,
        entities: state.entities.size,
        experiences: state.experiences.size,
      },
      domains: this.readiness(),
      conflicts: brainConflicts(state),
      pinned,
      sequence: state.sequence,
    }
  }

  /** The memories Freya currently holds as belief, for callers that want the ids. */
  recallableMemoryIds(): string[] {
    return [...this.brain.state().memories.values()]
      .filter((memory) => RECALLABLE_STATUSES.includes(memory.status))
      .map((memory) => memory.memoryId)
      .sort()
  }

  async close(): Promise<void> {
    await this.brain.close()
  }
}
