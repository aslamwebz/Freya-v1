/**
 * The Foundry protocol: everything a window may know about artifacts, tools,
 * modules, and apps.
 *
 * Types, one frozen absent projection, and the read-only seam Core's Foundry
 * domain fills. Nothing here is writable, and there is deliberately no command
 * in this vocabulary that *asserts* anything: a window may read the foundry,
 * and it may not name an owner, a principal, an authority, a provenance, a
 * capability or a claim. Those are Core's to assign and its workers' to hold.
 *
 * ## What is deliberately *not* here
 *
 * The Foundry domain's mutable internals — its state machine, its concurrency
 * ceilings, its verification logic, and every rule that decides who may do
 * what — belong to Core, not to this lane. This file is the view across the
 * seam: fields the domain does not report are `null` or absent rather than
 * guessed, and `FoundrySource` is the port that domain plugs in when it
 * exists.
 */

/* --------------------------------------------------------------- outcomes */

/**
 * What a Foundry command produced, in the vocabulary this protocol declares.
 *
 * Two operations, because there are two facts: Core answered the read, or Core
 * refused it. A caller that had to parse a reason string to tell those apart
 * would be a caller that gets it wrong.
 */
export type FoundryOperation = 'status' | 'refused'

export interface FoundryCommandOutcome {
  readonly operation: FoundryOperation
  readonly ok: boolean
  /** Why a refusal happened, in Core's words. Never evidence, never a stack. */
  readonly reason?: string
}

/* ----------------------------------------------------------------- views */

/**
 * One artifact, as the renderer may see it.
 *
 * Note what a `FoundryArtifactView` carries and what it pointedly does not: it
 * carries what the artifact *is* (its identity, its kind, its status, its
 * provenance) and what happened to it (verification, promotion, activation).
 * It does not carry the artifact's content, its spec, or its evidence — those
 * are process-local and never cross this boundary.
 */
export interface FoundryArtifactView {
  /** The artifact's deterministic identity. */
  readonly hash: string
  /** What kind of artifact this is. */
  readonly kind: string
  /** Its current lifecycle status. */
  readonly status: string
  /** When it was created. */
  readonly createdAt: string
  /** When it was last updated. */
  readonly updatedAt: string
  /** The Run that produced it. */
  readonly runId: string
  /** The Step that created it. */
  readonly stepId: string
  /** The principal that authorized creation. */
  readonly createdBy: string
  /** The parent artifact's identity, if derived. */
  readonly parentHash: string | null
  /** The spec it was built against, if any. */
  readonly specHash: string | null
  /** Measured length of its content. Never the content. */
  readonly contentLength: number
  /** How many times it has been promoted. */
  readonly promotionCount: number
}

/**
 * One tool, as the renderer may see it.
 */
export interface FoundryToolView {
  readonly toolId: string
  readonly hash: string
  readonly status: string
  readonly name: string
  /** The Guard capability this tool requires. */
  readonly capability: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy: string
  readonly artifactHash: string
  readonly promotionCount: number
}

/**
 * One module, as the renderer may see it.
 */
export interface FoundryModuleView {
  readonly moduleId: string
  readonly hash: string
  readonly status: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy: string
  readonly artifactHash: string
  readonly promotionCount: number
}

/**
 * One app, as the renderer may see it.
 */
export interface FoundryAppView {
  readonly appId: string
  readonly hash: string
  readonly status: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly createdBy: string
  readonly artifactHash: string
  /** Hashes of the modules this app is composed of. */
  readonly moduleHashes: readonly string[]
  readonly promotionCount: number
}

/**
 * One verification record, as the renderer may see it.
 *
 * The evidence itself is private. The renderer may see only its digest and
 * measured length, which are enough to correlate a verification without
 * copying learned content across the bridge.
 */
export interface FoundryVerificationView {
  readonly verificationId: string
  readonly artifactHash: string
  readonly verifierName: string
  readonly verdict: string
  readonly evidenceHash: string
  readonly evidenceLength: number
  readonly verifiedAt: string
  readonly requestedBy: string
}

/**
 * One promotion record, as the renderer may see it.
 */
export interface FoundryPromotionView {
  readonly promotionId: string
  readonly artifactHash: string
  readonly fromStatus: string
  readonly toStatus: string
  readonly promotedBy: string
  readonly promotedAt: string
  readonly reason: string
  readonly verificationId: string
}

/**
 * One activation record, as the renderer may see it.
 */
export interface FoundryActivationView {
  readonly activationId: string
  readonly artifactHash: string
  readonly fromStatus: string
  readonly toStatus: string
  readonly activatedBy: string
  readonly activatedAt: string
  readonly reason: string
  /** When this activation expires, if bounded. */
  readonly expiresAt: string | null
}

/**
 * Everything a window may know about the foundry, in one read-only object.
 *
 * A mirror, in the same sense as Work and Missions: Core builds it, a window
 * holds what Core last sent, and no command in this protocol writes a field of
 * it. `sequence` exists so a window can prove which Core state it is looking
 * at rather than trusting that the push it received was the newest.
 *
 * `health` is the first thing to read. `'unavailable'` is not `'ready'` with
 * zero artifacts — it means no Foundry domain is reporting at all, and the
 * two must never look the same on screen.
 */
export interface FoundryProjection {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly artifacts: readonly FoundryArtifactView[]
  readonly tools: readonly FoundryToolView[]
  readonly modules: readonly FoundryModuleView[]
  readonly apps: readonly FoundryAppView[]
  readonly verifications: readonly FoundryVerificationView[]
  readonly promotions: readonly FoundryPromotionView[]
  readonly activations: readonly FoundryActivationView[]
  /**
   * Counts derived by the domain that owns the states, not by whoever renders.
   *
   * Zeroes under `health: 'unavailable'` mean "nobody counted anything", which
   * is different from "there are none" — and that difference is why `health`
   * must be read first.
   */
  readonly counts: {
    readonly artifacts: number
    readonly artifactsVerified: number
    readonly artifactsPromoted: number
    readonly artifactsActive: number
    readonly tools: number
    readonly toolsActive: number
    readonly modules: number
    readonly modulesActive: number
    readonly apps: number
    readonly appsActive: number
  }
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/* ------------------------------------------------------------------ seam */

/**
 * The integration seam Core's Foundry domain fills.
 *
 * This is the whole of what this lane assumes about the Foundry: something, at
 * some point, will be able to hand Core a current `FoundryProjection` and
 * optionally tell Core when it changes. No mutable state, no engine handle, no
 * authority object, and no method that takes an instruction — a source can be
 * *read*, and that is the entire interface.
 *
 * `subscribe` is optional because a source that only ever changes when Core
 * itself changes needs no channel of its own; Core simply reads it again.
 *
 * Nothing outside Core can reach a source. The renderer has no function that
 * names one, and the host merely forwards a source *into* Core at construction
 * the same way it forwards a provider set — authority is not something a
 * construction argument can carry.
 */
export interface FoundrySource {
  /** The current view. Called by Core; never by a renderer. */
  projection(): FoundryProjection
  /** Follow changes. Returns a disposer. Absent means "read again later". */
  subscribe?(listener: (projection: FoundryProjection) => void): () => void
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has not reported one.
 *
 * `unavailable`, never `ready` with empty lists: "there is no Foundry" and
 * "there is no Foundry *domain*" are different facts, and a surface that
 * rendered the second as the first would be showing a person a foundry that
 * does not exist.
 */
export const ABSENT_FOUNDRY_PROJECTION: FoundryProjection = Object.freeze({
  health: 'unavailable',
  reason: 'Core has not reported a Foundry yet',
  artifacts: [] as readonly FoundryArtifactView[],
  tools: [] as readonly FoundryToolView[],
  modules: [] as readonly FoundryModuleView[],
  apps: [] as readonly FoundryAppView[],
  verifications: [] as readonly FoundryVerificationView[],
  promotions: [] as readonly FoundryPromotionView[],
  activations: [] as readonly FoundryActivationView[],
  counts: Object.freeze({
    artifacts: 0,
    artifactsVerified: 0,
    artifactsPromoted: 0,
    artifactsActive: 0,
    tools: 0,
    toolsActive: 0,
    modules: 0,
    modulesActive: 0,
    apps: 0,
    appsActive: 0,
  }),
  sequence: 0,
})

/**
 * The sentence Core reports when nothing has plugged the seam.
 *
 * Exported so the host, the client and the tests quote the same words instead
 * of paraphrasing them into four slightly different lies.
 */
export const NO_FOUNDRY_DOMAIN_REASON =
  'this Core has no Foundry domain: no artifact, tool, module or app exists, and none is simulated'

/**
 * The one refusal a Foundry read can produce, and why it is a refusal
 * rather than a silent drop.
 *
 * A read carries no fields at all. A window that appends one anyway is told,
 * rather than having it quietly discarded — the same reasoning that refuses a
 * Run naming its own parent: code still sending the old shape deserves to learn
 * that it stopped working. Shared between the preload bridge and Core so the
 * two can never disagree about the rule or the words.
 */
export const FOUNDRY_NO_PAYLOAD = 'a Foundry read carries no payload'
