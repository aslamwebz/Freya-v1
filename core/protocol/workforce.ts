/**
 * The Workforce protocol: everything a window may know about workers and teams.
 *
 * Types, one frozen absent projection, and the read-only seam Core's Workforce
 * domain fills. Nothing here is writable, and there is deliberately no command
 * in this vocabulary that *asserts* anything: a window may read the workforce,
 * and it may not name an owner, a principal, an authority, a trust level, a
 * provenance, a capability or a claim. Those are Core's to assign and its
 * workers' to hold. A window that could submit one would be able to mint
 * authority by asking — which is the exact sentence the rest of this file exists
 * to make impossible.
 *
 * ## What is deliberately *not* here
 *
 * The Workforce domain's mutable internals — its state machine, its concurrency
 * ceilings, its budgets, and every rule that decides who may do what — belong to
 * Core (issue #10), not to this lane. This file is the view across the seam:
 * fields the domain does not report are `null` or absent rather than guessed,
 * `state` is reported as Core's own words rather than a union invented here, and
 * `WorkforceSource` is the port that domain plugs in when it exists.
 *
 * Until something does plug in, `ABSENT_WORKFORCE_PROJECTION` plus Core's own
 * "no Workforce domain" sentence is the whole truth, and the surface renders it
 * as such. There is no code path in this repository that synthesises a worker.
 */

/* ------------------------------------------------------------- outcomes */

/**
 * What a Workforce command produced, in the vocabulary this protocol declares.
 *
 * Two operations, because there are two facts: Core answered the read, or Core
 * refused it. A caller that had to parse a reason string to tell those apart
 * would be a caller that gets it wrong.
 */
export type WorkforceOperation = 'status' | 'refused'

export interface WorkforceCommandOutcome {
  readonly operation: WorkforceOperation
  readonly ok: boolean
  /** Why a refusal happened, in Core's words. Never evidence, never a stack. */
  readonly reason?: string
}

/* --------------------------------------------------------------- views */

/**
 * One thing a worker says about itself.
 *
 * The type exists so a claim can be *shown* — labelled as a claim — rather than
 * so it can be believed. Nothing in Core promotes a value here into authority:
 * a worker claiming `capability: work.execute` is data on a row, and Guard
 * still knows nothing about it.
 */
export interface WorkforceClaimView {
  /** What kind of claim this is, in Core's words — `capability`, `role`, … */
  readonly kind: string
  /** What the worker claimed. Rendered as a claim, never as a fact. */
  readonly value: string
  /** When Core recorded the claim, or null when it does not say. */
  readonly assertedAt: string | null
}

/**
 * A worker's budget, as Core accounts it.
 *
 * Reported, never settable: there is no command that raises a limit, and a
 * window cannot reach this object except by receiving it. `limit` is Core's
 * ceiling and `used` is Core's count; a surface may draw them and may not
 * recompute either.
 */
export interface WorkforceBudgetView {
  /** What the budget counts, in words — `tokens this hour`, `runs`, … */
  readonly label: string
  readonly used: number
  readonly limit: number
}

/**
 * What a worker is currently assigned to.
 *
 * Assigned *by Core*. A worker does not get to declare its own assignment and
 * neither does a window; this is what Core says is true, which is the only
 * version a surface is allowed to draw.
 */
export interface WorkforceAssignmentView {
  /** What kind of thing it is — `run`, `mission`, `task` … in Core's words. */
  readonly kind: string
  readonly id: string
  /** A short human label. Display only; never used as an identifier. */
  readonly label: string
}

/**
 * One worker, as the renderer may see it.
 *
 * Note what a `WorkforceWorkerView` carries and what it pointedly does not: it
 * carries what the worker *holds* (capabilities assigned by Core) and what it
 * *claims* (separately, so the two can never be read as the same list). It does
 * not carry an identity Core has not issued, a credential, a key, a prompt, or
 * any text the worker produced.
 */
export interface WorkforceWorkerView {
  /** Core's identifier for this worker. Never minted by the worker itself. */
  readonly workerId: string
  /** The name Core gave it — Alpha, Beta. Display only. */
  readonly name: string
  /** The team Core placed it in, or null when it is not in one. */
  readonly teamId: string | null
  /** A specialization or role label. Core's words; not a grant of anything. */
  readonly specialization: string | null
  /**
   * What Core says the worker is doing, in Core's words.
   *
   * A `string` rather than a union on purpose: the state machine is the Workforce
   * domain's to define, and a closed vocabulary written here would be this lane
   * guessing at internals it does not own. A surface prints the word it is given
   * and never rewrites it into a friendlier one.
   */
  readonly state: string
  readonly assignment: WorkforceAssignmentView | null
  /**
   * Capability **names** assigned by Core.
   *
   * Holding a name in this list is not holding the capability: the list is what
   * Core assigned, and Guard is what decides. It is here so a person can see the
   * assignment, not so a renderer can act on it — no command in this protocol
   * reads it back.
   */
  readonly capabilities: readonly string[]
  /** What the worker claims about itself. Data, never authority. */
  readonly claims: readonly WorkforceClaimView[]
  readonly budget: WorkforceBudgetView | null
  /**
   * Live work against Core's ceiling: what is running now, and what may run.
   *
   * Reported by the domain that enforces it. There is no command that changes
   * either number.
   */
  readonly concurrency: { readonly active: number; readonly limit: number } | null
  /** When the worker last did something, or null when Core does not say. */
  readonly lastActiveAt: string | null
}

/** One team, as the renderer may see it. */
export interface WorkforceTeamView {
  /** Core's identifier for the team. */
  readonly teamId: string
  /** The name Core gave it. Display only. */
  readonly name: string
  /** Why the team exists, in Core's words. Null when Core does not say. */
  readonly purpose: string | null
  /** Membership decided by Core. A window cannot add itself to one. */
  readonly memberIds: readonly string[]
  /** What Core says the team is doing, in Core's words. Same rule as a worker. */
  readonly state: string
}

/**
 * Everything a window may know about the workforce, in one read-only object.
 *
 * A mirror, in the same sense as Work and Missions: Core builds it, a window
 * holds what Core last sent, and no command in this protocol writes a field of
 * it. `sequence` exists so a window can prove which Core state it is looking
 * at rather than trusting that the push it received was the newest.
 *
 * `health` is the first thing to read. `'unavailable'` is not `'ready'` with
 * zero workers — it means no Workforce domain is reporting at all, and the two
 * must never look the same on screen.
 */
export interface WorkforceProjection {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly workers: readonly WorkforceWorkerView[]
  readonly teams: readonly WorkforceTeamView[]
  /**
   * Counts derived by the domain that owns the states, not by whoever renders.
   *
   * Zeroes under `health: 'unavailable'` mean "nobody counted anything", which
   * is different from "there are none" — and that difference is why `health`
   * must be read first.
   */
  readonly counts: {
    readonly workers: number
    readonly working: number
    readonly idle: number
    readonly waiting: number
    readonly teams: number
  }
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/* ----------------------------------------------------------------- seam */

/**
 * The integration seam Core's Workforce domain fills.
 *
 * This is the whole of what this lane assumes about issue #10: something, at
 * some point, will be able to hand Core a current `WorkforceProjection` and
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
 * construction argument can carry, and the host is not where workforce rules
 * would live if they existed.
 */
export interface WorkforceSource {
  /** The current view. Called by Core; never by a renderer. */
  projection(): WorkforceProjection
  /** Follow changes. Returns a disposer. Absent means "read again later". */
  subscribe?(listener: (projection: WorkforceProjection) => void): () => void
}

/* -------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has not reported one.
 *
 * `unavailable`, never `ready` with empty lists: "there is no Workforce" and
 * "there is no Workforce *domain*" are different facts, and a surface that
 * rendered the second as the first would be showing a person a workforce that
 * does not exist.
 */
export const ABSENT_WORKFORCE_PROJECTION: WorkforceProjection = Object.freeze({
  health: 'unavailable',
  reason: 'Core has not reported a Workforce yet',
  workers: [] as readonly WorkforceWorkerView[],
  teams: [] as readonly WorkforceTeamView[],
  counts: Object.freeze({ workers: 0, working: 0, idle: 0, waiting: 0, teams: 0 }),
  sequence: 0,
})

/**
 * The sentence Core reports when nothing has plugged the seam.
 *
 * Exported so the host, the client and the tests quote the same words instead
 * of paraphrasing them into four slightly different lies.
 */
export const NO_WORKFORCE_DOMAIN_REASON =
  'this Core has no Workforce domain: no worker or team exists, and none is simulated'

/**
 * The one refusal a Workforce read can produce, and why it is a refusal
 * rather than a silent drop.
 *
 * A read carries no fields at all. A window that appends one anyway is told,
 * rather than having it quietly discarded — the same reasoning that refuses a
 * Run naming its own parent: code still sending the old shape deserves to learn
 * that it stopped working. Shared between the preload bridge and Core so the
 * two can never disagree about the rule or the words.
 */
export const WORKFORCE_NO_PAYLOAD = 'a Workforce read carries no payload'
