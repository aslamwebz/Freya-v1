/**
 * The Context protocol: everything a window may know, say or be refused.
 *
 * This file is a **view**, not a channel. It declares what context looks like
 * from outside Core, and it deliberately contains no shape that could hold
 * something a person shared: the row below is the audit record, which is an
 * id, a closed label, two instants and two *measured lengths*, and there is no
 * field on it a sentence could hide in. The words a person selected live in the
 * Context Store, in this process, and this file cannot be used to ask for them.
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
 * 2. **A caller may not name its own scope.** The scope view below is an opaque
 *    id and a closed kind, and Core holds the set of scopes that exist. Naming
 *    one Core has not declared is refused, and the `session` scope — the only
 *    one visible from every conversation and surface — is never declarable from
 *    a payload at all.
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
 * Core, by the code that is about to use the answer — a prompt being compiled,
 * a target being named — and the answer stops there. A command that returned a
 * resolved item would put somebody's selected text into a request/response a
 * window can log, and the store is not built to make that recoverable.
 *
 * The generic activity feed has no context event family either, for the same
 * reason, and `tests/core/context/context-privacy.test.ts` is where that stays
 * asserted. What a window *can* read is the projection below: metadata, states,
 * counts and instants.
 */

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
export interface ContextScopeView {
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
export interface ContextItemView {
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
    readonly mode: 'ephemeral'
    /** False, and said so: no encrypted context store exists yet. */
    readonly durable: false
    readonly reason: string | null
  }
  /** What "here" currently means, or null when nothing is current. */
  readonly activeScope: ContextScopeView | null
  /** Every scope Core holds, oldest declaration first. Bounded. */
  readonly declaredScopes: readonly ContextScopeView[]
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
  readonly items: readonly ContextItemView[]
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
export type ContextOperation =
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
  readonly operation: ContextOperation
  readonly ok: boolean
  /** In Core's words. Never content, never a label, never a URI. */
  readonly reason?: string
  /** Present when the *boundary* refused, and named. */
  readonly refusal?: ContextBoundaryRefusal
  /** The admitted item's id. Never the item. */
  readonly contextId?: string
  readonly scope?: ContextScopeView
  /** Records bounded retention dropped to make room, reported rather than hidden. */
  readonly evictedIds?: readonly string[]
  readonly revokedCount?: number
  /** Ids only, on the ambiguous and unresolved operations. */
  readonly candidateIds?: readonly string[]
}

/* ---------------------------------------------------------------- absent */

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
export const SESSION_CONTEXT_SCOPE: ContextScopeView = Object.freeze({
  scopeKind: 'session' as const,
  scopeId: 'session',
})