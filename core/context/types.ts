/**
 * THE CONTEXT DOMAIN — Phase 9 foundation.
 *
 * When a person says "this" or "here", Freya has to point at something real.
 * This file is the vocabulary for what she may point at, and it is types and
 * closed tables only — no logic, no I/O, no clock — so the resolver, the store
 * and any future compiler can depend on the shapes without depending on each
 * other.
 *
 * ## What a context item is
 *
 * A `ContextItem` is a *photograph, not a key*. It is a bounded record that
 * something was shared, selected or reported, carrying:
 *
 *  - **provenance** — which closed source produced it and where the content
 *    came from (`ContextProvenance`), so a claim from the host and a share by
 *    the owner can never look like the same thing;
 *  - **scope** — which conversation, surface or session it was shared into, so
 *    it cannot wander out of the place it was given;
 *  - **TTL** — `expiresAt`, an absolute instant after which it does not
 *    resolve;
 *  - **revocation** — an explicit human act that destroys the content and
 *    leaves a tombstone saying why.
 *
 * ## What is deliberately absent
 *
 * - **No authority, in any field.** Nothing here is a permission, a capability,
 *   a grant or a trust decision, and `uri` is a *name* rather than a permit.
 *   Guard never reads this module: holding an item says nothing about what may
 *   be done with it (Constitution C3 — knowledge never implies permission).
 * - **No journal and no activity row.** Private context content crosses no
 *   trust boundary on its own; the only shape allowed near audit surface is the
 *   metadata-only {@link ContextAuditRecord}. There are no `context.*` journal
 *   events in this lane at all.
 * - **No capture.** Nothing in this domain reaches for a screen, a window, an
 *   app or a device. Content arrives only by being handed in by a caller that
 *   already has it.
 * - **No inference.** Every operation here is synchronous and deterministic —
 *   a module that cannot await cannot call a model, so idle context
 *   maintenance costs zero inference.
 *
 * ## Deferred kinds
 *
 * `active_window` (app/window capture) and `agent_work` (Workforce state, which
 * waits for issue #10) are *declared* so that a caller asking for them is
 * refused truthfully — `kind_deferred` in a word — instead of silently
 * receiving nothing, or worse, receiving something invented. Declaring a kind is
 * not sourcing it: admission refuses both until the capture lane and #10 land.
 */

/* ------------------------------------------------------------------ kinds */

/**
 * The context kinds this build can honestly source.
 *
 * Each one names a *human act or Core record*, not a sensing capability:
 * somebody selected this, somebody shared this, or Core already knows this.
 */
export const CONTEXT_KINDS = [
  /** The owner explicitly selected this text/segment. */
  'explicit_selection',
  /** The Mission Core is currently on, summarised as bounded content. */
  'current_mission',
  /** A project the owner authorised. */
  'project',
  /** A file the owner authorised or selected. */
  'file',
  /** A tab the owner shared. */
  'shared_tab',
  /** Media (image/audio/video/document) the owner shared. */
  'shared_media',
] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

/**
 * Declared, not sourced.
 *
 * These exist so a request for them fails with an honest reason rather than a
 * quiet absence. `active_window` is Phase 9's later capture lane (not built
 * here: "no active app/window capture yet"); `agent_work` waits for issue #10.
 */
export const DEFERRED_CONTEXT_KINDS = ['active_window', 'agent_work'] as const
export type DeferredContextKind = (typeof DEFERRED_CONTEXT_KINDS)[number]

export type AnyContextKind = ContextKind | DeferredContextKind

export function isContextKind(value: unknown): value is ContextKind {
  return typeof value === 'string' && (CONTEXT_KINDS as readonly string[]).includes(value)
}

export function isDeferredContextKind(value: unknown): value is DeferredContextKind {
  return typeof value === 'string' && (DEFERRED_CONTEXT_KINDS as readonly string[]).includes(value)
}

export function isAnyContextKind(value: unknown): value is AnyContextKind {
  return isContextKind(value) || isDeferredContextKind(value)
}

/* ---------------------------------------------------------------- sources */

/**
 * Where a context item's content came from — a closed set, because provenance
 * that a caller can invent is decoration.
 *
 * `owner_*` sources are the owner's own hand (selection, share, authorisation).
 * `core_record` is Core's own state. `host_report` is the desktop host telling
 * Core about something that was *already* authorised — it never authenticates
 * anything on its own, which is why it must name the record it came from.
 */
export const CONTEXT_SOURCES = [
  'owner_selection',
  'owner_share',
  'owner_authorization',
  'core_record',
  'host_report',
] as const
export type ContextSource = (typeof CONTEXT_SOURCES)[number]

export function isContextSource(value: unknown): value is ContextSource {
  return typeof value === 'string' && (CONTEXT_SOURCES as readonly string[]).includes(value)
}

/**
 * Which sources each kind may come from.
 *
 * This table is the load-bearing part of provenance: an admission naming a
 * pairing that is not here is refused (`source_not_permitted`), so
 * "a `current_mission` the host reported" or "a `shared_tab` Core invented"
 * cannot enter the store no matter who asks.
 */
export const CONTEXT_KIND_SOURCES: Readonly<Record<ContextKind, readonly ContextSource[]>> =
  Object.freeze({
    explicit_selection: ['owner_selection'],
    current_mission: ['core_record'],
    project: ['owner_authorization', 'owner_selection'],
    file: ['owner_authorization', 'owner_selection', 'host_report'],
    shared_tab: ['owner_share', 'host_report'],
    shared_media: ['owner_share', 'host_report'],
  })

/* ----------------------------------------------------------------- scopes */

/**
 * The sharing boundary an item was given into.
 *
 * Scope is what keeps one conversation's context out of another's. It is
 * checked *before* candidacy in the resolver, so an item from a different
 * scope is not "a candidate we decline" — it does not exist as far as the
 * query is concerned, and a refusal never lists it.
 */
export const CONTEXT_SCOPES = ['session', 'conversation', 'surface'] as const
export type ContextScopeKind = (typeof CONTEXT_SCOPES)[number]

export interface ContextScope {
  readonly scopeKind: ContextScopeKind
  /** Opaque id: a conversation id, a shared-surface id, or `'session'`. */
  readonly scopeId: string
}

export function isContextScopeKind(value: unknown): value is ContextScopeKind {
  return typeof value === 'string' && (CONTEXT_SCOPES as readonly string[]).includes(value)
}

/** Structural equality: same boundary, not merely the same kind. */
export function isSameContextScope(a: ContextScope, b: ContextScope): boolean {
  return a.scopeKind === b.scopeKind && a.scopeId === b.scopeId
}

/* ------------------------------------------------------------------ terms */

/**
 * The natural references this phase resolves.
 *
 * Both are resolved by the same deterministic primitive: find the live,
 * in-scope matches, and answer only when there is exactly one. The difference
 * between "this" and "here" is expression, never computation — neither term is
 * allowed to break a tie.
 */
export const CONTEXT_TERMS = ['this', 'here'] as const
export type ContextTerm = (typeof CONTEXT_TERMS)[number]

export function isContextTerm(value: unknown): value is ContextTerm {
  return typeof value === 'string' && (CONTEXT_TERMS as readonly string[]).includes(value)
}

/* ----------------------------------------------------------------- limits */

/**
 * Code-owned ceilings.
 *
 * As with Work: a caller may *lower* any of these through
 * {@link contextLimits} and may never raise one, so retention, size and TTL
 * bounds are facts about this build rather than values a caller supplies. TTL
 * clamping only ever shortens retention — nothing can ask to be remembered
 * longer than the ceiling.
 */
export const CONTEXT_LIMITS = Object.freeze({
  /** Everything retained, live records and tombstones together. */
  maxItems: 64,
  /** Live items a single scope may hold; the rest evicts oldest-first. */
  maxLivePerScope: 16,
  maxContentChars: 4_000,
  maxLabelChars: 160,
  maxUriChars: 2_048,
  /** Characters in a stated revocation reason. */
  maxReasonChars: 200,
  maxScopeIdChars: 128,
  maxOriginIdChars: 128,
  /** The longest a context item may ever live. */
  maxTtlMs: 30 * 60_000,
  /** Used when a caller states no TTL. */
  defaultTtlMs: 10 * 60_000,
})

export interface ContextLimits {
  readonly maxItems: number
  readonly maxLivePerScope: number
  readonly maxContentChars: number
  readonly maxLabelChars: number
  readonly maxUriChars: number
  readonly maxReasonChars: number
  readonly maxScopeIdChars: number
  readonly maxOriginIdChars: number
  readonly maxTtlMs: number
  readonly defaultTtlMs: number
}

/**
 * Resolve a partial limit set against the ceiling.
 *
 * Every override is clamped into `[1, CONTEXT_LIMITS[key]]`, and the live
 * per-scope bound is additionally clamped to the total bound — a store that
 * could hold more live items per scope than items overall would be a ceiling
 * that disagrees with itself.
 */
export function contextLimits(overrides: Partial<ContextLimits> = {}): ContextLimits {
  const clamped = (key: keyof ContextLimits): number => {
    const requested = overrides[key]
    if (requested === undefined) return CONTEXT_LIMITS[key]
    if (typeof requested !== 'number' || !Number.isFinite(requested)) return CONTEXT_LIMITS[key]
    return Math.max(1, Math.min(Math.floor(requested), CONTEXT_LIMITS[key]))
  }
  const limits: ContextLimits = {
    maxItems: clamped('maxItems'),
    maxLivePerScope: clamped('maxLivePerScope'),
    maxContentChars: clamped('maxContentChars'),
    maxLabelChars: clamped('maxLabelChars'),
    maxUriChars: clamped('maxUriChars'),
    maxReasonChars: clamped('maxReasonChars'),
    maxScopeIdChars: clamped('maxScopeIdChars'),
    maxOriginIdChars: clamped('maxOriginIdChars'),
    maxTtlMs: clamped('maxTtlMs'),
    defaultTtlMs: clamped('defaultTtlMs'),
  }
  return limits.maxLivePerScope > limits.maxItems
    ? { ...limits, maxLivePerScope: limits.maxItems }
    : limits
}

/* ------------------------------------------------------------------ item */

/**
 * Where an item's content came from, stated explicitly.
 *
 * `originId` names the record behind the content — the share, the
 * authorisation, the Mission. Content that did not come from the owner's own
 * hand (`host_report`, `core_record`) must supply it, so "the host said so"
 * always points at something the host was given.
 */
export interface ContextProvenance {
  readonly source: ContextSource
  /** When the content was captured — provenance, never a clock the store reads. */
  readonly capturedAt: string
  readonly originId: string | null
}

/** Whether an item is still usable, derived from its own fields plus the clock. */
export type ContextItemState = 'live' | 'revoked' | 'expired'

/**
 * One piece of shared context.
 *
 * Every field is either an id, an instant, a closed label or a measured
 * length — plus `content`, `label` and `uri`, which are the private part and
 * are destroyed by revocation and by expiry (see `retireContextItem`).
 *
 * There is no `authority`, `capability`, `permission` or `grant` field, and
 * adding one would not grant anything: authority is Guard's vocabulary and
 * Guard does not read this module.
 */
export interface ContextItem {
  readonly contextId: string
  readonly kind: ContextKind
  readonly provenance: ContextProvenance
  readonly scope: ContextScope
  /** Short human label (a file name, a tab title). Private, like content. */
  readonly label: string
  /** The private text that was shared. Never journalled, never activity. */
  readonly content: string
  /** A name for the thing (path/URL). A name, not a permit. */
  readonly uri: string | null
  readonly admittedAt: string
  /** The TTL: the first instant at which this item no longer resolves. */
  readonly expiresAt: string
  /** Measured at admission, so the size survives content destruction. */
  readonly contentLength: number
  readonly labelLength: number
  readonly revokedAt: string | null
  readonly revocationReason: string | null
}

/* ------------------------------------------------------------- admission */

/**
 * A request to hold something.
 *
 * This is a *request*: every field is validated against the closed tables and
 * the code-owned limits above, and a refusal states its code in words.
 */
export interface ContextAdmission {
  /** May name a deferred kind — the refusal is the honest answer it gets. */
  readonly kind: AnyContextKind
  readonly source: ContextSource
  readonly scope: ContextScope
  readonly content: string
  readonly label?: string | null
  readonly uri?: string | null
  /** Required unless the source is the owner's own hand. */
  readonly originId?: string | null
  readonly capturedAt?: string | null
  /** Milliseconds from admission. Clamped to `maxTtlMs`; never extended. */
  readonly ttlMs?: number | null
}

export const CONTEXT_ADMISSION_CODES = [
  'kind_unknown',
  'kind_deferred',
  'source_not_permitted',
  'origin_required',
  'invalid_origin',
  'content_empty',
  'content_too_large',
  'label_too_large',
  'uri_too_large',
  'invalid_ttl',
  'invalid_scope',
  'invalid_instant',
] as const
export type ContextAdmissionCode = (typeof CONTEXT_ADMISSION_CODES)[number]

/** Why a code is a refusal, in words a person can act on. */
export const CONTEXT_ADMISSION_REASONS: Readonly<Record<ContextAdmissionCode, string>> =
  Object.freeze({
    kind_unknown: 'that is not a context kind this Core knows',
    kind_deferred: 'this Core build does not source that context kind yet',
    source_not_permitted: 'that context kind does not come from that source',
    origin_required:
      'content that did not come from the owner directly must name the record it came from',
    invalid_origin: 'the origin id is not a usable id',
    content_empty: 'there is no content in this context item',
    content_too_large: 'the content is larger than a context item may be',
    label_too_large: 'the label is longer than a context label may be',
    uri_too_large: 'the reference is longer than a context reference may be',
    invalid_ttl: 'a time to live must be a positive number of milliseconds',
    invalid_scope: 'the scope is not a usable scope',
    invalid_instant: 'the instant is not a valid time',
  })

export type ContextAdmissionResult =
  | {
      readonly ok: true
      readonly item: ContextItem
      /** Oldest records dropped to hold the retention bounds, content destroyed. */
      readonly evicted: readonly string[]
    }
  | { readonly ok: false; readonly code: ContextAdmissionCode; readonly reason: string }

/* ------------------------------------------------------------- resolution */

/**
 * A natural reference, as a caller may state it.
 *
 * `kind` narrows ("this file"); it never widens. Naming a deferred kind is
 * answered with `kind_deferred` rather than "no match", because the two mean
 * very different things to the person asking.
 */
export interface ContextReference {
  readonly term: ContextTerm
  readonly kind?: AnyContextKind | null
}

export const CONTEXT_REFUSAL_REASONS = [
  /** No current scope, so "here" has no meaning. Fails closed. */
  'no_active_scope',
  /** Nothing structurally matched inside the current scope. */
  'no_candidates',
  /** More than one live match. Never broken by recency, order or luck. */
  'ambiguous',
  /** Matches existed and outlived their TTL. */
  'expired',
  /** Matches existed and were revoked. Outranks `expired` when both apply. */
  'revoked',
  /** The reference named a kind this build does not source yet. */
  'kind_deferred',
  /** Not a reference this resolver understands. */
  'invalid_reference',
  /** The supplied instant is not a time, so nothing can be judged live. */
  'invalid_clock',
] as const
export type ContextRefusalReason = (typeof CONTEXT_REFUSAL_REASONS)[number]

/** Why a reference refused, in words. */
export const CONTEXT_REFUSAL_TEXT: Readonly<Record<ContextRefusalReason, string>> = Object.freeze({
  no_active_scope: 'no scope is current, so there is nothing "here" can point at',
  no_candidates: 'no live context item in this scope matches that reference',
  ambiguous: 'more than one live context item matches, so naming one would be a guess',
  expired: 'the matching context item outlived its time to live',
  revoked: 'the matching context item was revoked',
  kind_deferred: 'this Core build does not source that context kind yet',
  invalid_reference: 'that is not a reference this resolver understands',
  invalid_clock: 'the supplied instant is not a valid time, so nothing can be judged live',
})

export type ContextResolution =
  | { readonly ok: true; readonly item: ContextItem }
  | {
      readonly ok: false
      readonly reason: ContextRefusalReason
      /** Ids only — a refusal never carries content, labels, URIs or scopes. */
      readonly candidateIds: readonly string[]
    }

/* ----------------------------------------------------------------- audit */

/**
 * A retired record, as a tombstone.
 *
 * In-memory and Core-internal, like `list` — deliberately **not** part of
 * {@link ContextAuditRecord}, because `reason` is free text a person typed and
 * free text does not reach audit surface. It exists so a revocation is
 * inspectable (Constitution C12): which item, what kind, which scope, when it
 * was taken back, and the stated why — with none of the content that was
 * destroyed. An expired record is here too, with `revokedAt: null`, because
 * "it expired" and "you took it back" are different facts.
 */
export interface ContextTombstone {
  readonly contextId: string
  readonly kind: ContextKind
  readonly scope: ContextScope
  readonly admittedAt: string
  readonly expiresAt: string
  /** Null when the TTL did it rather than a person. */
  readonly revokedAt: string | null
  readonly state: 'revoked' | 'expired'
  readonly reason: string | null
}

/**
 * The only shape this domain produces for audit surface.
 *
 * Ids, closed labels, instants and measured lengths — no content, no label, no
 * URI, no scope of another conversation's words. It exists so that a future
 * journal or activity row has a metadata-only record to take *without* having
 * to filter a `ContextItem` at the call site, where the filter is one refactor
 * away from being forgotten.
 */
export interface ContextAuditRecord {
  readonly contextId: string
  readonly kind: ContextKind
  readonly source: ContextSource
  readonly scopeKind: ContextScopeKind
  readonly scopeId: string
  readonly originId: string | null
  readonly capturedAt: string
  readonly admittedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly state: ContextItemState
  readonly contentLength: number
  readonly labelLength: number
}
