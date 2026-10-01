/**
 * The Context protocol: everything a window may know about what Freya can see
 * around a question.
 *
 * Types, one frozen absent projection, and the read-only seam Core's Context
 * domain will fill (issue #15). Nothing here is writable, and the vocabulary is
 * deliberately smaller than Workforce's: it does not even contain a command.
 * A window may *receive* context and may *pull* the projection Core last built,
 * and it may not name an item, assert a provenance, declare a scope, set a TTL,
 * revoke anything, or resolve a reference by asking. Provenance, trust, scope,
 * expiry and authority over context belong to Core (issue #15); Electron owns
 * none of them, and this file is the contract for a window that could not take
 * them even by accident.
 *
 * ## What is deliberately *not* here
 *
 * The Context domain itself — the item model, the reference resolver, the
 * revocation and retention rules — belongs to Core (issue #15), and Core's
 * assembly belongs to issue #16. This lane has no claim on either. What it
 * declares is only the *view across the seam*: fields the domain does not
 * report are `null` or absent rather than guessed, `kind` and `state` are
 * reported as Core's own words rather than unions invented here, and
 * `ContextSource` is the port the domain plugs into when it exists.
 *
 * Until something does plug in, `ABSENT_CONTEXT_PROJECTION` is the whole truth,
 * the surface renders it as such, and there is no code path in this repository
 * that synthesises a context item. There is also no active app or window
 * capture, and no Phase 10 hands: this vocabulary can *describe* an
 * app-metadata item when Core one day reports one, and nothing in this file
 * goes and looks.
 */

/* ------------------------------------------------------------- read-back */

/**
 * Whether a Context pull got an answer, in this vocabulary.
 *
 * Two operations because there are two facts: Core answered, or the answer
 * could not be had. A pull is not a command — there is no `context.status.read`
 * in `CoreCommandName` yet, and adding one is #15/#16's decision made in
 * `core/index.ts` and `core-protocol.ts`, not this lane's — so this outcome
 * describes the IPC read itself.
 */
export type ContextOperation = 'status' | 'refused'

export interface ContextReadOutcome {
  readonly operation: ContextOperation
  readonly ok: boolean
  /** Why the answer could not be had, in words. Never evidence, never a stack. */
  readonly reason?: string
}

/* ----------------------------------------------------------------- views */

/**
 * Where an item came from, as Core says.
 *
 * A window can *show* this and can never *file* it: there is no verb anywhere
 * in this lane that takes a provenance as input, because a caller that could
 * name its own source class could launder anything into `owner` provenance —
 * the Brain and Workforce each made the same ruling for the same reason.
 */
export interface ContextProvenanceView {
  /** The class of origin, in Core's words. Rendered, never interpreted. */
  readonly sourceClass: string
  /** Where exactly it came from, in Core's words. Null when Core does not say. */
  readonly detail: string | null
  /** When Core admitted the item, or null when it does not say. */
  readonly admittedAt: string | null
}

/**
 * How far an item reaches, as Core scopes it.
 *
 * Reported, never settable: a window cannot widen a scope, and the surface
 * cannot draw one wider than the words Core used.
 */
export interface ContextScopeView {
  /** The scope, in Core's words — a session, a Mission, a project. */
  readonly label: string
  /** Which Mission, file or session it is, when Core names one. */
  readonly detail: string | null
}

/**
 * One thing Core knows is around the current question.
 *
 * Note what a `ContextItemView` carries and what it pointedly does not: it
 * carries Core's *report* of the item — kind, provenance, scope, expiry, and
 * Core's word for whether it is still live — and it does not carry the item's
 * content. A selection's text, a file's bytes and a window's title live behind
 * the id, resolved by Core for the pathways Core admits, and a standing feed of
 * contents through this projection would put private context wherever a window
 * caches. `label` is a display handle Core chose, never a payload.
 */
export interface ContextItemView {
  /** Core's identifier for this item. Never minted by a window. */
  readonly itemId: string
  /**
   * What kind of context it is, in Core's words — `explicit-selection`,
   * `current-mission`, `project-file`, `tab-media` …
   *
   * A `string` rather than a union on purpose: the taxonomy is the Context
   * domain's to define (issue #15), and a closed vocabulary written here would
   * be this lane guessing at internals it does not own. A surface prints the
   * word it is given.
   */
  readonly kind: string
  /** A short human label, chosen by Core. Display only; never content. */
  readonly label: string | null
  /**
   * Whether the item is live, in Core's words — `current`, `expired`,
   * `revoked` … Same rule as `kind`: the availability vocabulary belongs to
   * the domain that enforces it, and an expired or revoked item is *shown*
   * as one rather than quietly omitted or redrawn as current.
   */
  readonly state: string
  /** Provenance as Core assigned it. Null when Core does not say. */
  readonly provenance: ContextProvenanceView | null
  /** Scope as Core drew it. Null when Core does not say. */
  readonly scope: ContextScopeView | null
  /** When Core says the item stops being valid. Null when it grants no expiry. */
  readonly expiresAt: string | null
  /** The lifetime Core granted, in seconds. Null when Core does not say. */
  readonly ttlSeconds: number | null
}

/**
 * What Core made of a reference like "this" or "here".
 *
 * The honesty rule lives in the shape: an unresolved or ambiguous reference
 * carries its *candidates*, all of them, and no field that picks one. A surface
 * that could resolve a reference could guess, and guessing that "this" means
 * the biggest blob on screen is the failure issue #15 exists to prevent.
 */
export interface ContextReferenceView {
  /** The token the reference was made with, as Core recorded it. */
  readonly reference: string
  /** How Core resolved it, in Core's words — `resolved`, `ambiguous`, … */
  readonly status: string
  /**
   * What it resolved to. More than one entry means Core left it open, and the
   * surface shows every candidate rather than choosing.
   */
  readonly itemIds: readonly string[]
  /** Core's own words on why it did not resolve. Null when it did. */
  readonly reason: string | null
}

/**
 * Counts derived by the domain that owns the items, not by whoever renders.
 *
 * Zeroes under `health: 'unavailable'` mean "nobody counted", which is a
 * different fact from "there is nothing", and that is why `health` is read
 * first everywhere these are shown.
 */
export interface ContextCounts {
  readonly items: number
  readonly current: number
  readonly expired: number
  readonly revoked: number
  readonly references: number
  readonly unresolvedReferences: number
}

/**
 * Everything a window may know about context, in one read-only object.
 *
 * A mirror, in the same sense as Workforce's: Core builds it, a window holds
 * what Core last sent, and nothing a window can do writes a field of it.
 * `sequence` exists so a window can prove which Core state it is looking at.
 * `health` is the first thing to read, for the reason every other subsystem
 * gives: `'unavailable'` is not `'ready'` with zero items.
 */
export interface ContextProjection {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly items: readonly ContextItemView[]
  readonly references: readonly ContextReferenceView[]
  readonly counts: ContextCounts
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/* ------------------------------------------------------------------ seam */

/**
 * The integration seam Core's Context domain (issue #15) fills.
 *
 * This is the whole of what this lane assumes about that issue: something, at
 * some point, will be able to hand Core a current `ContextProjection` and
 * optionally tell Core when it changes. A source can be *read*, and that is the
 * entire interface — no mutable state, no resolver handle, no authority object,
 * and no method that takes an instruction. It deliberately mirrors
 * `WorkforceSource` so the two domains plug into Core the same way.
 *
 * **Deferred hookup, stated plainly because the seam is not yet connected:**
 * nothing in this repository passes a `ContextSource` anywhere. Core has no
 * `contextSource` option, no `context()` mirror and no `onContext()` channel
 * yet, and filling that in means editing `core/index.ts`, which belongs to
 * issues #15 and #16. The host lane binds to those mirror methods *structurally*
 * when a Core grows them (see `ContextReportingCore` in `electron/coreHost.ts`)
 * and mirrors nothing at all until one does. Guessing Core's internal shape
 * here would be the one way this lane could make #15's job harder.
 */
export interface ContextSource {
  /** The current view. Called by Core; never by a renderer. */
  projection(): ContextProjection
  /** Follow changes. Returns a disposer. Absent means "read again later". */
  subscribe?(listener: (projection: ContextProjection) => void): () => void
}

/* ---------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has not reported one.
 *
 * `unavailable`, never `ready` with empty lists: "there is no context" and
 * "there is no Context domain" are different facts, and a surface that rendered
 * the second as the first would be showing a person a quiet, empty awareness
 * that does not exist.
 */
export const ABSENT_CONTEXT_PROJECTION: ContextProjection = Object.freeze({
  health: 'unavailable',
  reason: 'Core has not reported a Context yet',
  items: Object.freeze([]) as readonly ContextItemView[],
  references: Object.freeze([]) as readonly ContextReferenceView[],
  counts: Object.freeze({
    items: 0,
    current: 0,
    expired: 0,
    revoked: 0,
    references: 0,
    unresolvedReferences: 0,
  }),
  sequence: 0,
})

/**
 * The sentence Core reports when nothing has plugged the seam.
 *
 * Exported so the surface quotes the same words instead of paraphrasing them
 * into a claim about a domain this build does not have.
 */
export const NO_CONTEXT_DOMAIN_REASON =
  'this Core has no Context domain: no context item exists, and none is simulated'
