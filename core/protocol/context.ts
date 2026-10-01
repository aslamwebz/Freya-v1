/**
 * The Context protocol: everything a window may know, say or be refused.
 *
 * This file is a **view**, not a channel. It carries two vocabularies for one
 * Context domain, and the split is the whole of what this file is careful about:
 *
 *  - **Core's own** - the scopes, admissions, boundary refusals, audit rows and
 *    command outcomes that cross the line between a caller and the Context
 *    boundary. This is where "what may be claimed" is written down, and widening
 *    it is Core's decision, not a caller's and not a window's.
 *  - **the window's** - the read-only projection a renderer may hold and the
 *    read-only seam the host binds to. Nothing in that half is writable, and it
 *    contains no command: a window may *receive* context and may *pull* the
 *    projection Core last built, and it may not name an item, assert a
 *    provenance, declare a scope, set a TTL, revoke anything, or resolve a
 *    reference by asking.
 *
 * The two halves declare their own item and scope views rather than sharing one,
 * because they are not read by the same reader for the same purpose. Core's row
 * (`ContextAuditRowView`) is the *audit record*: an id, a closed label, two
 * instants and two *measured lengths*, with no field on it a sentence could hide
 * in. The window's item (`ContextItemView`) is a *report* of one such row - what
 * a surface may draw, and nothing more. What somebody shared stays in the
 * Context Store, in this process, and this file cannot be used to ask for it.
 *
 * ## The three rules this vocabulary exists to make impossible
 *
 * 1. **A caller may not name its own provenance.** `CONTEXT_ADMISSION_CHANNELS`
 *    below is the entire set of origins a request may claim, and it is the set
 *    of origins the *owner* has. `core_record` and `host_report` are absent on
 *    purpose: those are Core's and the host's to assert, so a payload that names
 *    one is refused by name rather than quietly accepted. Core decides where
 *    content came from; a caller states only which owner-side door it came in
 *    by.
 * 2. **A caller may not name its own scope.** The scope reference below is an
 *    opaque id and a closed kind, and Core holds the set of scopes that exist.
 *    Naming one Core has not declared is refused, and the `session` scope - the
 *    only one visible from every conversation and surface - is never declarable
 *    from a payload at all.
 * 3. **A refusal is a first-class result, and it says which one.** `ambiguous`,
 *    `expired`, `revoked`, `no_candidates` and `no_active_scope` are five
 *    different facts about the world, so they are five different operations
 *    rather than one `ok: false` a caller has to parse a string to
 *    distinguish. Guessing between them is the failure this prevents.
 *
 * ## What is deliberately *not* here
 *
 * There is no `context.resolve` in the Core command vocabulary, and no command
 * whose result carries context content. "This" and "here" are resolved *inside*
 * Core, by the code that is about to use the answer - a prompt being compiled,
 * a target being named - and the answer stops there. A command that returned a
 * resolved item would put somebody's selected text into a request/response a
 * window can log, and the store is not built to make that recoverable.
 *
 * The generic activity feed has no context event family either, for the same
 * reason, and `tests/core/context/context-privacy.test.ts` is where that stays
 * asserted. What a window *can* read is the projection below: metadata, states,
 * counts and instants.
 *
 * Provenance, trust, scope, expiry and authority over context belong to Core;
 * Electron owns none of them, and the window's half of this file is the contract
 * for a reader that could not take them even by accident.
 */

/* ====================== Core's Context vocabulary ========================== */

/* --------------------------------------------------------------- scopes */

/**
 * The scope vocabulary, closed.
 *
 * `session` is ambient — content in it is visible from every conversation and
 * every surface — and the other two are not: they are walls, not nestings.
 * A surface scope does not contain a conversation scope, because the narrower
 * scope is the more private one and containment only ever widens.
 */
export const CONTEXT_SCOPE_KINDS = ['session', 'conversation', 'surface'] as const

export type ContextScopeKind = (typeof CONTEXT_SCOPE_KINDS)[number]

/**
 * A scope as a caller may name one.
 *
 * Opaque id, closed kind, and nothing else: no owner, no principal, no
 * authority, no capability and no parent. A scope is a place, not a permission,
 * and a view that could say who may put content in one would be a second
 * authority system built inside the presentation layer.
 */
export interface ContextScopeRef {
  readonly scopeKind: ContextScopeKind
  readonly scopeId: string
}

/* ----------------------------------------------------------- admissions */

/**
 * The only origins a request may claim, and every one of them is the owner's.
 *
 * These are the doors a person opens themselves: something they selected,
 * something they shared, something they authorised. They are *not* the sources
 * Core and the host assert on their own account — `core_record` and
 * `host_report` are deliberately absent, and a request naming either is refused
 * with `channel_not_requestable` rather than honoured.
 *
 * That absence is the whole anti-forgery mechanism at this boundary. A caller
 * that could claim `core_record` would be able to say "Core already knows this"
 * about anything at all, which is a claim no window gets to make.
 */
export const CONTEXT_ADMISSION_CHANNELS = ['owner_selection', 'owner_share', 'owner_authorization'] as const

export type ContextAdmissionChannel = (typeof CONTEXT_ADMISSION_CHANNELS)[number]

export function isContextAdmissionChannel(value: unknown): value is ContextAdmissionChannel {
  return typeof value === 'string' && (CONTEXT_ADMISSION_CHANNELS as readonly string[]).includes(value)
}

/**
 * Field names that are laundered authority rather than context.
 *
 * A request carrying any of these is refused whole, with the offending names in
 * the reason, and is **not** silently stripped. The reasoning is the same one
 * that refuses a field on a Workforce read: code still sending the old shape
 * deserves to learn that it stopped working. A field quietly dropped is a
 * caller that goes on believing its assertion landed somewhere.
 */
export const CONTEXT_AUTHORITY_FIELDS = [
  'source',
  'principal',
  'principalId',
  'owner',
  'authority',
  'authorised',
  'authorized',
  'capability',
  'permission',
  'permissions',
  'grant',
  'grantId',
  'onBehalfOf',
  'approvedBy',
  'trusted',
  'scopeKindOverride',
  'forceAdmit',
] as const

/* ------------------------------------------------------------- refusals */

/**
 * What the Core boundary refuses, before the store is ever asked.
 *
 * These are *boundary* refusals, distinct from the store's own admission codes
 * and from a resolution refusal. The store answers "is this content
 * admissible"; this list answers "is this caller allowed to make the claim",
 * which is a question about who is speaking rather than about what they said.
 *
 * Split because the two must not be confused: a `scope_not_declared` refusal is
 * a caller reaching for a scope that does not exist, while a `source_not_permitted`
 * refusal from the store is a coherent request of the wrong kind. Only the
 * second one is a bug in the caller.
 */
export const CONTEXT_BOUNDARY_REFUSALS = [
  'malformed_request',
  'request_field_unknown',
  'authority_field_present',
  'channel_unknown',
  'channel_not_requestable',
  'scope_not_declared',
  'scope_not_requestable',
  'scope_registry_full',
  'scope_unknown',
  'invalid_clock',
  'invalid_reason',
] as const

export type ContextBoundaryRefusal = (typeof CONTEXT_BOUNDARY_REFUSALS)[number]

/**
 * The words, so Core, the host and the tests quote one thing.
 *
 * Each sentence says what happened rather than what was wrong with the caller.
 * A person reading a refusal should be able to act on it, and "malformed
 * request" would not let them.
 */
export const CONTEXT_BOUNDARY_REFUSAL_TEXT: Readonly<Record<ContextBoundaryRefusal, string>> =
  Object.freeze({
    malformed_request: 'that is not a context request Core can read',
    request_field_unknown:
      'that context request carries a field Core does not understand, so none of it was taken',
    authority_field_present:
      'a context request states which door it came in by, never where it came from: Core decides the source, and a request that names one is refused whole',
    channel_unknown: 'that is not a door the owner opens context through',
    channel_not_requestable:
      'only the owner can put context in; Core and the host decide their own sources rather than being asked to assert them',
    scope_not_declared:
      'context can only be put in a scope Core already knows about, and this one is not one of them',
    scope_not_requestable:
      'the whole session is Core\'s to place context in; a request cannot aim at it',
    scope_registry_full:
      'Core is already holding as many scopes as it will hold, so this one was not added',
    scope_unknown: 'that is not a scope Core can read',
    invalid_clock: 'the supplied instant is not a valid time, so nothing can be judged live',
    invalid_reason: 'a reason must be a short, non-empty sentence saying why',
  })

/* ----------------------------------------------------------------- views */

/**
 * One context item, as metadata.
 *
 * A structural copy of the store's audit record rather than a re-export, because
 * the protocol is what a window is typed against and Core's store types are not
 * part of that contract — and because a copy can be *narrowed* if the store's
 * shape ever grows. If a field were added here it would have to be argued, in
 * this file, rather than arriving by accident with a new field upstream.
 *
 * `contentLength` and `labelLength` are the honest middle: a viewer learns that
 * something substantial was shared without the projection becoming a transcript.
 * Note what is *not* recoverable from this row: not a word of the content, not
 * the label, not the URI, and not the free-text reason for a revocation.
 */
export interface ContextAuditRowView {
  readonly contextId: string
  /** Closed vocabulary upstream, `string` here so the protocol owns no domain type. */
  readonly kind: string
  readonly source: string
  readonly scopeKind: ContextScopeKind
  readonly scopeId: string
  readonly originId: string | null
  readonly capturedAt: string
  readonly admittedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly state: 'live' | 'revoked' | 'expired'
  readonly contentLength: number
  readonly labelLength: number
}

/**
 * Core's account of context, and the whole of it.
 *
 * `items` is the **audit shape** and nothing else, filtered to the active scope
 * so that one conversation's *metadata* — which ids exist, which kinds, from
 * which sources — does not travel to another. Content filtering is the obvious
 * half of that wall and id filtering is the half that is easy to forget.
 *
 * `counts` describes what is listed, and `retained` describes everything the
 * store still holds, including records in other scopes that this projection
 * cannot see. Reporting one number for both would either overstate what is on
 * screen or understate what exists; a Core that says `retained: 12` beside
 * `live: 2` has told the truth about both.
 */
export interface ContextProjectionView {
  readonly persistence: {
    readonly mode: 'encrypted' | 'ephemeral'
    /** Actual persistence health; false when the secure store is unavailable. */
    readonly durable: boolean
    readonly reason: string | null
  }
  /** What "here" currently means, or null when nothing is current. */
  readonly activeScope: ContextScopeRef | null
  /** Every scope Core holds, oldest declaration first. Bounded. */
  readonly declaredScopes: readonly ContextScopeRef[]
  readonly agentContext: {
    /**
     * Whether anything has been handed to the seam yet.
     *
     * True and `available: false` is a real, reachable state and is not a bug:
     * it is what a build looks like once #16 plugs a source in but `agent_work`
     * is still a deferred kind. A reader that cannot tell "nothing plugged the
     * seam" from "something plugged it and there is still nothing to admit" will
     * eventually report a gap in the wiring as a gap in the product.
     */
    readonly wired: boolean
    readonly available: false
    readonly reason: string
  }
  readonly items: readonly ContextAuditRowView[]
  readonly counts: {
    readonly live: number
    readonly revoked: number
    readonly expired: number
    /**
     * Records this projection can account for — which is `items.length`, and
     * deliberately **not** the store's global total. A Core that reported "12
     * records" while listing two would have handed out a fact about somebody
     * else's conversation, and a bare count is enough to confirm one exists.
     */
    readonly retained: number
    readonly declaredScopes: number
  }
  readonly limits: {
    readonly maxItems: number
    readonly maxLivePerScope: number
    readonly maxScopes: number
  }
  /** Highest operation folded in, so a window can prove it is current. */
  readonly sequence: number
}

/* -------------------------------------------------------------- outcomes */

/**
 * What a context operation produced.
 *
 * Explicit operations rather than a boolean, because "here did not resolve" has
 * five genuinely different meanings — no scope is current, nothing matched, too
 * much matched, the match expired, the match was revoked — and a caller that has
 * to parse a reason string to tell them apart is a caller that will get it
 * wrong. Which of the five applies is a fact about the owner's context, and
 * saying "ambiguous" when the truth is "revoked" teaches a person the wrong
 * thing about their own session.
 *
 * `candidateIds` is on the ambiguous and unresolved cases and is ids only: a
 * refusal names what it could have pointed at and never carries any of it.
 */
export type ContextCommandOperation =
  | 'admitted'
  | 'refused'
  /**
   * The call was understood and nothing changed.
   *
   * Its own operation rather than a success, because "I did nothing" and "I did
   * the thing" are different answers and a surface that renders a re-sent
   * Mission report as a fresh admission will fill a list with duplicates of one
   * Mission. `ok: false`, because an operation that admits nothing did not admit.
   */
  | 'unchanged'
  | 'revoked'
  | 'revoke-not-found'
  | 'revoke-already-settled'
  | 'scope-revoked'
  | 'scope-revoke-empty'
  | 'scope-forgotten'
  | 'scope-declared'
  | 'scope-activated'
  | 'resolved'
  | 'unresolved-no-active-scope'
  | 'unresolved-no-candidates'
  | 'unresolved-ambiguous'
  | 'unresolved-expired'
  | 'unresolved-revoked'
  | 'unresolved-kind-deferred'
  | 'unresolved-invalid'
  | 'status'

export interface ContextCommandOutcome {
  readonly operation: ContextCommandOperation
  readonly ok: boolean
  /** In Core's words. Never content, never a label, never a URI. */
  readonly reason?: string
  /** Present when the *boundary* refused, and named. */
  readonly refusal?: ContextBoundaryRefusal
  /** The admitted item's id. Never the item. */
  readonly contextId?: string
  readonly scope?: ContextScopeRef
  /** Records bounded retention dropped to make room, reported rather than hidden. */
  readonly evictedIds?: readonly string[]
  readonly revokedCount?: number
  /** Ids only, on the ambiguous and unresolved operations. */
  readonly candidateIds?: readonly string[]
}

/* ------------------------- Core's own absences ------------------------------ */

/**
 * The sentence Core reports about active-agent context.
 *
 * Exported so the facade, the host, the surface and the tests quote identical
 * words instead of paraphrasing the same absence into four slightly different
 * claims. It names both halves of the truth: this build does not source agent
 * work, *and* the seam exists for when it does.
 */
export const NO_ACTIVE_AGENT_CONTEXT_REASON =
  'this Core build does not source active-agent context yet; the seam is declared and unfilled'

/**
 * What the session scope is, for anyone who needs to name it.
 *
 * A single frozen object rather than a factory, so a caller cannot mint a second
 * session scope that does not match the one Core is using. `scopeId` is
 * `'session'` because it is the whole of it: there is no per-user or per-window
 * session scope in this vocabulary, and pretending otherwise would be the first
 * step toward a global screen feed.
 */
export const SESSION_CONTEXT_SCOPE: ContextScopeRef = Object.freeze({
  scopeKind: 'session' as const,
  scopeId: 'session',
})

/* ====================== the window's read-only view ======================== */

/**
 * What a window may know about what Freya can see around a question.
 *
 * Types, one frozen absent projection, and the read-only seam the host binds to.
 * Nothing here is writable, and the vocabulary is deliberately smaller than
 * Workforce's: it does not even contain a command. A window may *receive*
 * context and may *pull* the projection Core last built, and it may not name an
 * item, assert a provenance, declare a scope, set a TTL, revoke anything, or
 * resolve a reference by asking. Provenance, trust, scope, expiry and authority
 * over context belong to Core; Electron owns none of them, and this half of the
 * file is the contract for a window that could not take them even by accident.
 *
 * ## What is deliberately *not* here
 *
 * The Context domain itself — the item model, the reference resolver, the
 * revocation and retention rules — belongs to Core, and this lane has no claim
 * on either. What it declares is only the *view across the seam*: fields the
 * domain does not report are `null` or absent rather than guessed, `kind` and
 * `state` are reported as Core's own words rather than unions invented here,
 * and `ContextSource` is the port a reader plugs in when a projection comes
 * from somewhere other than Core itself.
 *
 * `ABSENT_CONTEXT_PROJECTION` is the whole truth of a build whose Core has not
 * reported one, the surface renders it as such, and there is no code path in
 * this repository that synthesises a context item. There is also no active app
 * or window capture: this vocabulary can *describe* an app-metadata item when
 * Core reports one, and nothing in this file goes and looks.
 *
 * Core reports in its own vocabulary — `context()` and `onContext()` answer a
 * `ContextProjectionView` — and the host translates that into the projection
 * below at the door (`toContextProjection` in `electron/coreHost.ts`), so what a
 * window holds is Core's own facts in the shape this half declares.
 */

/* ------------------------------------------------------------- read-back */

/**
 * Whether a Context pull got an answer, in this vocabulary.
 *
 * Two operations because there are two facts: Core answered, or the answer
 * could not be had. A pull is not a command: the door a window reaches is the
 * projection read on the bridge, which carries no argument and so cannot carry
 * a claim, and this outcome describes that IPC read itself. Core's own
 * `context.status.read` is a command in *Core's* vocabulary — this lane does
 * not hand it to a window, because the window's door names no `context.*`
 * command at all.
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
  /** Core's secure-store health, mirrored as metadata only. */
  readonly persistence?: ContextProjectionView['persistence']
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
 * A seam for reading a `ContextProjection` that does not come from Core itself.
 *
 * A source can be *read*, and that is the entire interface — no mutable state,
 * no resolver handle, no authority object, and no method that takes an
 * instruction. It deliberately mirrors `WorkforceSource` so both domains plug
 * into a reader the same way.
 *
 * **Stated plainly, because what fills this seam has changed shape:** nothing in
 * this repository passes a `ContextSource` anywhere, and Core deliberately did
 * not grow a `contextSource` option. Core built its own Context integration
 * instead — the store, the boundary and the projection all live inside Core —
 * and reports through `context()` and `onContext()` in *its* vocabulary. The
 * host binds to those two methods structurally (see `ContextReportingCore` in
 * `electron/coreHost.ts`) and translates the answer into this half's projection
 * on the way out, so a window reads Core's truth without this file gaining a
 * second source of it. The seam stays what it was: the smallest reader, for the
 * day a projection is produced somewhere Core does not own.
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
