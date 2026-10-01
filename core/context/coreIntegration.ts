import {
  CONTEXT_AUTHORITY_FIELDS,
  CONTEXT_BOUNDARY_REFUSAL_TEXT,
  NO_ACTIVE_AGENT_CONTEXT_REASON,
  SESSION_CONTEXT_SCOPE,
  isContextAdmissionChannel,
  type ContextAdmissionChannel,
  type ContextBoundaryRefusal,
  type ContextCommandOutcome,
  type ContextItemView,
  type ContextOperation,
  type ContextProjectionView,
  type ContextScopeView,
} from '../protocol/context'
import { isValidContextInstant } from './item'
import {
  CONTEXT_MISSION_REVOKED_REASON,
  isReportableMissionStatus,
  missionContextAdmission,
  missionContextContent,
  type ContextMissionReport,
} from './mission-adapter'
import { ContextStore, type ContextStoreOptions } from './store'
import {
  CONTEXT_ADMISSION_REASONS,
  CONTEXT_REFUSAL_TEXT,
  contextLimits,
  isContextScopeKind,
  type ContextAdmission,
  type ContextItem,
  type ContextLimits,
  type ContextReference,
  type ContextRefusalReason,
} from './types'

/**
 * THE CONTEXT INTEGRATION.
 *
 * The Core-owned seam between the context store (#15) and everything that might
 * want to put something in it or ask what "here" points at. The store answers
 * *"may this be held, and what does this reference point at"*. This file answers
 * the two questions that sit in front of it: *"may this caller make this claim"*,
 * and *"what is the honest way to say what just happened"*.
 *
 * ## Why the store is private
 *
 * `store` is not a public field, and that is the first security property here
 * rather than an oversight. `ContextStore.admit` takes a `source` at face value
 * against the closed kind/source table — that table stops an *incoherent* forgery
 * ("Core says so" about a shared tab) and cannot stop a *coherent* one, because
 * `owner_selection` plus `explicit_selection` is always a legal pair. Exposing the
 * store would therefore hand every caller a path around this file entirely. Every
 * path in is through `admit`, `admitHostReport` or `admitCoreRecord`, and each one
 * fixes the provenance itself.
 *
 * ## The four things that happen here and nowhere else
 *
 * 1. **A caller never names its own provenance.** `admit` accepts `unknown`,
 *    checks the request against a closed field allowlist, and derives the source
 *    from an owner-side channel. A request carrying `source`, `principal`,
 *    `authority`, `capability`, `grant`, `onBehalfOf` or a relative is refused
 *    **whole** rather than stripped — the reasoning behind `WORKFORCE_NO_PAYLOAD`:
 *    a field silently dropped is a caller left believing its assertion landed.
 * 2. **A caller never names its own scope.** Scopes live in a bounded registry that
 *    Core fills, and content may only go into a scope already in it. The `session`
 *    scope — the only one visible from every conversation and surface — is never a
 *    wire target at all: Core places a Mission there, and nothing a caller sends
 *    can aim at it.
 * 3. **Refusals are named, and the ambiguous cases are told apart.** `ambiguous`,
 *    `expired`, `revoked`, `no_candidates` and `no_active_scope` are five facts
 *    about somebody's session, so they are five operations rather than one
 *    boolean. `revoke` additionally refuses an already-expired item, because the
 *    store would otherwise stamp it `revoked` and turn a truthful `expired` answer
 *    into a less truthful one.
 * 4. **Nothing content-bearing leaves this file except `resolve`.** `read()` returns
 *    the audit shape, scope-filtered — ids, closed labels, instants and measured
 *    lengths — and every outcome carries ids and reasons. `resolve` is the single
 *    exception, it returns an item's content, and it is the reason there is no
 *    resolve command in the Core vocabulary: the answer to "here" is consumed by
 *    the code that was about to use it, inside Core, and stops there.
 *
 * ## No journal, no model, no capture
 *
 * There is no `context.*` event type and this class appends nothing, because the
 * Event Fabric is audit surface and context content has no home there. Every
 * operation is synchronous and this module imports no provider, no gateway, no
 * Cognition and no filesystem, so idle context maintenance costs zero inference —
 * there is no code path from an admitted selection to a request that costs money,
 * and a module with no `async` and no `Promise` cannot invent one.
 *
 * Active-window capture is absent by construction: `active_window` is a deferred
 * kind in the foundation, so it is refused by name on every path, including any
 * Core-internal one.
 */

/** How many scopes Core will hold at once. A ceiling, like every other here. */
export const CONTEXT_MAX_SCOPES = 16

/** A short ttl for the current Mission: an hour is long past its usefulness. */
const MISSION_CONTEXT_TTL_MS = 60 * 60_000

/**
 * Fields an admission request may carry, and the entire list.
 *
 * Anything else is refused. An allowlist rather than a denylist on purpose: the
 * denylist in `CONTEXT_AUTHORITY_FIELDS` is what makes a forgery *legible*, and
 * this is what makes one impossible.
 */
const ADMISSION_FIELDS = [
  'kind',
  'channel',
  'scope',
  'content',
  'label',
  'uri',
  'originId',
  'capturedAt',
  'ttlMs',
] as const

/** The three owner doors, mapped to the source each one asserts. */
const CHANNEL_SOURCE: Readonly<Record<ContextAdmissionChannel, ContextAdmission['source']>> = Object.freeze({
  owner_selection: 'owner_selection',
  owner_share: 'owner_share',
  owner_authorization: 'owner_authorization',
})

/**
 * Sources a caller may never claim, even though they are real ones.
 *
 * `core_record` and `host_report` are how Core and the host say "we know this".
 * They are absent from `CONTEXT_ADMISSION_CHANNELS` because a request naming one
 * would be asking Core to attest to itself, and the answer is always no. Listed
 * separately from `channel_unknown` so the refusal says *why* — the difference
 * between "that is not a door" and "that door is not yours" is the difference
 * between a typo and an attempt.
 */
const NON_REQUESTABLE_CHANNELS = ['core_record', 'host_report', 'system', 'owner', 'owner_internal'] as const

/**
 * Every refusal the resolver can report, mapped to the operation that names it.
 *
 * A total map rather than a lookup that might miss, because a resolver that fell
 * through to a default here would report "something went wrong" for a perfectly
 * ordinary answer like "nothing matched" — and the whole point of this layer is
 * that each of those is reported as itself.
 */
const RESOLUTION_OPERATION: Readonly<Record<ContextRefusalReason, ContextOperation>> = Object.freeze({
  no_active_scope: 'unresolved-no-active-scope',
  no_candidates: 'unresolved-no-candidates',
  ambiguous: 'unresolved-ambiguous',
  expired: 'unresolved-expired',
  revoked: 'unresolved-revoked',
  kind_deferred: 'unresolved-kind-deferred',
  invalid_reference: 'unresolved-invalid',
  invalid_clock: 'unresolved-invalid',
})

/* ------------------------------------------------------------------ specs */

/**
 * A host-reported admission, assembled by Core from the host's own report.
 *
 * There is no `source` field and no `channel` field, and that is the point: this
 * type *cannot express* a claim about where the content came from. `host_report`
 * is fixed by the entry point this spec reaches, so a host report cannot be
 * relabelled as the owner's own selection on the way in.
 */
export interface ContextHostReport {
  readonly kind: string
  readonly scope: ContextScopeView
  readonly content: string
  readonly originId: string
  readonly label?: string | null
  readonly uri?: string | null
  readonly capturedAt?: string | null
  readonly ttlMs?: number | null
}

/**
 * An admission Core makes from its own records.
 *
 * The narrowest of the three lanes and the only one allowed to place content in
 * the `session` scope. A Mission's context reaches the Context domain through here
 * and nowhere else, which is what keeps "Core says so" a thing Core says rather
 * than a thing anybody can ask for.
 */
export interface ContextCoreRecord {
  readonly kind: string
  readonly scope: ContextScopeView
  readonly content: string
  readonly originId: string
  readonly label?: string | null
  readonly uri?: string | null
  readonly capturedAt?: string | null
  readonly ttlMs?: number | null
}

export interface ContextIntegrationOptions extends ContextStoreOptions {
  /** The instant, from Core. Never read from inside this file. */
  readonly now?: () => Date
  /** Scopes Core already knows, in declaration order. Bounded. */
  readonly initialScopes?: readonly ContextScopeView[]
  /** Lowerable, never raisable above `CONTEXT_MAX_SCOPES`. */
  readonly maxScopes?: number
  /**
   * The active-agent seam, unfilled. See `ContextAgentSource`.
   *
   * Accepted so the wiring has somewhere to land when #16 lands, and never read —
   * see that interface's own doc for why that is not an oversight.
   */
  readonly agentSource?: ContextAgentSource
}

/* ------------------------------------------------------------------ seams */

/**
 * What an active-agent context provider will hand Core when #16 lands.
 *
 * Declared now so the integration has a shape to grow into rather than a design to
 * invent under pressure, and it is the whole of what this lane assumes about #16:
 * something, at some point, will be able to report which agent work is in flight.
 * No mutable state, no engine handle, no method that takes an instruction — a
 * source can be *read*, and that is the entire interface. That is the shape
 * `WorkforceSource` already uses, deliberately.
 *
 * ## Why nothing calls this
 *
 * `agent_work` is a **deferred kind** in the foundation: `ContextStore` refuses it
 * by name, on admission, for every source. So even a filled seam could not admit
 * an agent item through this class today — there is no path from a report to an
 * item, because the kind is refused as soon as it is looked at.
 *
 * That is the honest reason for declaring the seam unfilled rather than wiring it
 * half-way. A half-wired agent context would be an unsourced channel that *looked*
 * sourced, which is the one failure this whole lane is arranged to prevent. When
 * #16 lands the change is: admit `agent_work` in the foundation, add the one call,
 * and delete this paragraph.
 *
 * The interface is a proposal, not a commitment — #16's actual shape is #16's to
 * decide, and the first thing that lands may well revise this.
 */
export interface ContextAgentSource {
  /** The agent work in flight, as ids and closed codes. Never a prompt or an output. */
  agentWork(): ContextAgentWorkReport
}

/**
 * Active agent work, in the shape the seam proposes.
 *
 * Ids and a status. No task text, no step input, no observation, no model output —
 * because this lane has no way to keep those private once they are admitted, and
 * "we will be careful with it later" is how a leak ships.
 */
export interface ContextAgentWorkReport {
  readonly agentId: string | null
  readonly runId: string | null
  readonly taskId: string | null
  readonly status: string
}

/* --------------------------------------------------------------- outcomes */

/**
 * A resolution, for the code inside Core that is about to use the answer.
 *
 * The one shape in this file that can carry content, and the reason there is no
 * resolve command. A prompt being compiled reads this and hands the text onward
 * under a grant that already exists; nothing else in the process can name the
 * method that produces it.
 */
export type ContextResolutionOutcome =
  | { readonly ok: true; readonly operation: 'resolved'; readonly item: ContextItem }
  | {
      readonly ok: false
      readonly operation: ContextOperation
      readonly reason: string
      /** Ids only. A refusal names what it could have pointed at and carries none of it. */
      readonly candidateIds: readonly string[]
    }

/* ------------------------------------------------------------ the facade */

function scopeKey(scope: ContextScopeView): string {
  return `${scope.scopeKind}:${scope.scopeId}`
}

function scopeView(scope: ContextScopeView): ContextScopeView {
  return { scopeKind: scope.scopeKind, scopeId: scope.scopeId }
}

function listed(names: readonly string[]): string {
  return names.join(', ')
}

/**
 * A named boundary refusal, for Core's own dispatch to answer with.
 *
 * Exported because the boundary's refusal vocabulary is the boundary's: a command
 * arm that had to invent its own `{ operation: 'refused', ok: false }` would produce
 * an outcome with no `refusal` code, and the envelope's `ok` is computed from that
 * code — so an invented shape would report a declined request as a success. One
 * constructor, one place the words and the codes agree.
 */
export function contextRefusal(
  refusal: ContextBoundaryRefusal,
  reason?: string,
): ContextCommandOutcome {
  return {
    operation: 'refused',
    ok: false,
    refusal,
    reason: reason ?? CONTEXT_BOUNDARY_REFUSAL_TEXT[refusal],
  }
}

export class ContextIntegration {
  /**
   * The store, in an ECMAScript private field rather than a TypeScript one.
   *
   * The one `#` field in this file, and the reason is the whole boundary. A
   * TypeScript `private` is erased at compile time and the property is still there
   * at runtime, so `integration['store']` would return a store whose `admit` takes
   * a `source` at face value — which would make every rule in this file optional.
   * `#store` is not erased, so there is no expression that reaches it from outside
   * this class at all, and "the store is unreachable" stops being a matter of
   * everyone remembering.
   */
  readonly #store: ContextStore
  private readonly limits: ContextLimits
  private readonly readNow: () => Date
  private readonly maxScopes: number
  private readonly agentSource: ContextAgentSource | null

  /** Declaration order, because a surface should see them in the order they began. */
  private readonly declared = new Map<string, ContextScopeView>()
  /** The live `current_mission` item's id, so "here" can be re-pointed rather than doubled. */
  private missionContextId: string | null = null
  /** Highest folded operation. Monotonic; bumped by every mutation. */
  private sequence = 0

  constructor(options: ContextIntegrationOptions = {}) {
    this.#store = new ContextStore({
      ...(options.newId === undefined ? {} : { newId: options.newId }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    })
    this.limits = contextLimits(options.limits ?? {})
    this.readNow = options.now ?? (() => new Date())
    // Lowerable in tests, never raisable: an unbounded scope registry would let a
    // caller mint a scope per admission and make "which scope is this" open.
    this.maxScopes = clamp(options.maxScopes ?? CONTEXT_MAX_SCOPES, 1, CONTEXT_MAX_SCOPES)
    this.agentSource = options.agentSource ?? null

    // The session scope is declared by Core and cannot be undeclared, because it is
    // the one scope every conversation and surface resolves against.
    this.declared.set(scopeKey(SESSION_CONTEXT_SCOPE), SESSION_CONTEXT_SCOPE)
    for (const scope of options.initialScopes ?? []) {
      if (this.scopeIsUsable(scope) && scope.scopeKind !== 'session') this.addScope(scope)
    }
  }

  /* ---------------------------------------------------------------- scope */

  /**
   * Make a scope current, declaring it first if it is new.
   *
   * Declaring on activation is deliberate: a caller activates the scope it is
   * actually in, and a registry of scopes nobody is in is a registry of scopes
   * content could be aimed at from outside. The bound is `maxScopes`, and a full
   * registry refuses rather than evicting — a forgotten conversation's scope losing
   * its place to a new one would silently change what resolves.
   *
   * Clearing with `null` is allowed and is not a failure: "nothing is current" is a
   * true state, and it is exactly what makes `here` refuse with
   * `unresolved-no-active-scope` instead of guessing at a default scope.
   */
  activateScope(scope: ContextScopeView | null): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome
    if (scope === null) {
      this.#store.setActiveScope(null)
      this.sequence += 1
      return { operation: 'scope-activated', ok: true }
    }
    if (!this.scopeIsUsable(scope)) return this.refuse('scope_unknown')

    const key = scopeKey(scope)
    if (!this.declared.has(key) && this.addScope(scope) !== true) {
      return this.refuse('scope_registry_full')
    }
    if (!this.#store.setActiveScope(scopeView(scope))) return this.refuse('scope_unknown')
    this.sequence += 1
    return { operation: 'scope-activated', ok: true, scope: scopeView(scope) }
  }

  /**
   * Drop a scope, taking back everything that was shared into it.
   *
   * Revoking rather than merely forgetting is the point. A finished conversation's
   * items could never be resolved again anyway — they are behind a scope wall —
   * but they would sit in memory with their content intact until the TTL ran out,
   * and "the conversation ended" is the moment a person most expects it to be gone.
   *
   * The `session` scope cannot be forgotten: it is the ambient one, and removing it
   * would leave `here` pointing nowhere. To take back everything shared in the
   * session, revoke it — that is an explicit act naming the session, and it is a
   * different, available one.
   */
  forgetScope(scope: ContextScopeView, reason: string): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome
    if (!this.scopeIsUsable(scope)) return this.refuse('scope_unknown')
    if (scope.scopeKind === 'session') return this.refuse('scope_not_requestable')
    if (!this.declared.has(scopeKey(scope))) return this.refuse('scope_not_declared')
    if (!this.reasonIsUsable(reason)) return this.refuse('invalid_reason')

    const revoked = this.revokeLiveIn(scope, reason, now.at)
    this.declared.delete(scopeKey(scope))
    // A forgotten scope that was current leaves nothing current behind it, so `here`
    // refuses rather than resolving against a scope Core no longer holds.
    const active = this.#store.activeScope
    if (active !== null && active.scopeKind === scope.scopeKind && active.scopeId === scope.scopeId) {
      this.#store.setActiveScope(null)
    }
    this.sequence += 1
    return { operation: 'scope-forgotten', ok: true, scope: scopeView(scope), revokedCount: revoked }
  }

  /* ------------------------------------------------------------ admission */

  /**
   * The caller-facing door, and the only one a payload can reach.
   *
   * Takes `unknown` on purpose. This is the Core boundary, so it parses, checks the
   * field allowlist, decides the provenance, and refuses everything it does not
   * understand — in that order, and before the store is asked anything. The store's
   * own rules (kinds, sizes, TTLs, origins, the kind/source table) stay where they
   * are: this file does not restate them, because two copies of one rule is one rule
   * too many the day one of them is edited.
   *
   * The spec handed to the store is built **field by field** rather than cast, so a
   * field the allowlist somehow missed still cannot reach it. Two layers, because the
   * allowlist is the legible one and this is the one that holds.
   */
  admit(payload: unknown): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return this.refuse('malformed_request')
    }
    const fields = payload as Record<string, unknown>
    const keys = Object.keys(fields)

    // Laundered authority first, and named. A caller that sent `source` learns it
    // was noticed; a caller that sent `nickname` learns the shape is closed. Both are
    // refused whole, because a request half-honoured is a request whose rejected half
    // might as well have been accepted.
    const laundered = CONTEXT_AUTHORITY_FIELDS.filter((name) => keys.includes(name))
    if (laundered.length > 0) {
      return {
        ...this.refuse('authority_field_present'),
        reason: `${CONTEXT_BOUNDARY_REFUSAL_TEXT.authority_field_present} (refused: ${listed(laundered)})`,
      }
    }
    const unknownFields = keys.filter((key) => !(ADMISSION_FIELDS as readonly string[]).includes(key))
    if (unknownFields.length > 0) {
      return {
        ...this.refuse('request_field_unknown'),
        reason: `${CONTEXT_BOUNDARY_REFUSAL_TEXT.request_field_unknown} (refused: ${listed(unknownFields)})`,
      }
    }

    const channel = fields.channel
    if (typeof channel !== 'string') return this.refuse('channel_unknown')
    if (!isContextAdmissionChannel(channel)) {
      return this.refuse(
        (NON_REQUESTABLE_CHANNELS as readonly string[]).includes(channel)
          ? 'channel_not_requestable'
          : 'channel_unknown',
      )
    }

    const raw = fields.scope
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return this.refuse('scope_unknown')
    }
    const scope = this.readScope(raw as Record<string, unknown>)
    if (scope === null) return this.refuse('scope_unknown')
    // Session is Core's alone. It is the only scope every conversation and every
    // surface resolves against, so it is the only one worth forging — and the only
    // one a payload is refused on before the registry is even consulted.
    if (scope.scopeKind === 'session') return this.refuse('scope_not_requestable')
    if (!this.declared.has(scopeKey(scope))) return this.refuse('scope_not_declared')

    return this.commit(
      this.storeSpec(fields, CHANNEL_SOURCE[channel], scope),
      scope,
      now.at,
    )
  }

  /**
   * The host's lane: content the host reported, into a scope Core declared.
   *
   * No `source` field, so no caller can relabel a host report as the owner's own
   * selection. And **no session scope**: a host placing content where every
   * conversation and every surface can see it is how "one shared tab" becomes "a
   * feed of everything you have ever looked at", which is the omniscient global
   * screen privilege the roadmap refuses.
   */
  admitHostReport(report: ContextHostReport): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome
    if (typeof report !== 'object' || report === null) return this.refuse('malformed_request')

    const scope = this.readScope(report.scope as unknown as Record<string, unknown>)
    if (scope === null) return this.refuse('scope_unknown')
    if (scope.scopeKind === 'session') return this.refuse('scope_not_requestable')
    if (!this.declared.has(scopeKey(scope))) return this.refuse('scope_not_declared')

    return this.commit(this.storeSpec(report as unknown as Record<string, unknown>, 'host_report', scope), scope, now.at)
  }

  /**
   * Core's own records, and the only lane that may place content in the session.
   *
   * Reached by Core code that already holds the record — today, exactly one caller:
   * the Mission adapter. Nothing a payload can express gets here, because `admit` has
   * already refused every source a caller might have claimed.
   */
  admitCoreRecord(record: ContextCoreRecord): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome
    if (typeof record !== 'object' || record === null) return this.refuse('malformed_request')

    const scope = this.readScope(record.scope as unknown as Record<string, unknown>)
    if (scope === null) return this.refuse('scope_unknown')
    if (scope.scopeKind !== 'session' && !this.declared.has(scopeKey(scope))) {
      return this.refuse('scope_not_declared')
    }

    return this.commit(this.storeSpec(record as unknown as Record<string, unknown>, 'core_record', scope), scope, now.at)
  }

  /* -------------------------------------------------------------- removal */

  /**
   * Take one item back, and say which of the three things happened.
   *
   * The store's boolean is not enough at this boundary, because three different
   * situations produce `false` and a caller that cannot tell them apart will report a
   * revoked item as a missing one. So the store's audit rows are read first and the
   * outcome is named: `revoked`, `revoke-not-found`, or `revoke-already-settled`.
   *
   * **An already-expired item is refused rather than stamped.** The store's state rule
   * puts revocation ahead of the clock, so revoking an expired item would convert a
   * truthful `expired` answer into a `revoked` one and erase the fact that the words
   * had simply run out of time. That is a loss of accuracy bought with no gain — the
   * content is already destroyed — so this refuses and says so.
   */
  revoke(contextId: string, reason: string): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome
    if (typeof contextId !== 'string' || contextId.length === 0) return this.refuse('malformed_request')
    if (!this.reasonIsUsable(reason)) return this.refuse('invalid_reason')

    const row = this.#store.audit(now.at).find((candidate) => candidate.contextId === contextId)
    if (row === undefined) {
      return { operation: 'revoke-not-found', ok: false, reason: 'no context item with that id is held' }
    }
    if (row.state === 'revoked') {
      return { operation: 'revoke-already-settled', ok: false, reason: 'that context item was already revoked' }
    }
    if (row.state === 'expired') {
      return {
        operation: 'revoke-already-settled',
        ok: false,
        reason: 'that context item had already expired, so there was nothing left to take back',
      }
    }
    if (!this.#store.revoke(contextId, reason, now.at)) {
      return { operation: 'revoke-not-found', ok: false, reason: 'that context item could not be taken back' }
    }
    if (this.missionContextId === contextId) this.missionContextId = null
    this.sequence += 1
    return { operation: 'revoked', ok: true, contextId }
  }

/**
   * Take back a whole scope at once — "stop sharing this tab", "end this
   * conversation".
   *
   * Revoked **one item at a time**, and only the live ones, which is the reason this
   * does not delegate to `store.revokeScope`. The store's version counts and stamps
   * everything not yet revoked, which includes items that had already expired — and
   * because its state rule puts revocation ahead of the clock, that silently converts
   * a truthful `expired` answer into a `revoked` one. Reporting those as revoked would
   * also put a number in front of a person saying work was done on content that had
   * already been destroyed.
   *
   * So an expiry-only scope reports `scope-revoke-empty` and says that is what it was,
   * and the expired items stay expired, which is the fact about them.
   *
   * The session scope is revocable on purpose. It is an explicit act naming the
   * session, not something a payload can trigger, and it is the correct response to
   * "stop sharing anything in this session".
   */
  revokeScope(scope: ContextScopeView, reason: string): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome
    if (!this.scopeIsUsable(scope)) return this.refuse('scope_unknown')
    if (!this.reasonIsUsable(reason)) return this.refuse('invalid_reason')

    const live = this.liveRowsIn(scope, now.at)
    if (live.length === 0) {
      return {
        operation: 'scope-revoke-empty',
        ok: false,
        reason: 'nothing live is shared into that scope',
      }
    }
    const revoked = this.takeBack(live, reason, now.at)
    this.sequence += 1
return { operation: 'scope-revoked', ok: true, scope: scopeView(scope), revokedCount: revoked }
  }

  /* ----------------------------------------------------------- resolution */

  /**
   * Resolve a reference, content and all — for Core's own use.
   *
   * The only method here that returns what somebody shared, and the reason the Core
   * command vocabulary has no resolve command: the answer to "here" is consumed by the
   * code that was about to act on it, and must not become a value a window can hold,
   * log or replay. The caller supplies the term and the kind; it cannot supply a
   * scope, because the scope is Core's state.
   *
   * Each refusal keeps its own name. `ambiguous` and `revoked` in particular are
   * reported as themselves, because a resolver that said `revoked` when the truth was
   * "two things match" would be teaching a person the wrong thing about their own
   * session — and one that said `ambiguous` when the truth was `revoked` would be
   * inviting them to choose between two things that are not there.
   */
  resolve(reference: ContextReference): ContextResolutionOutcome {
    const now = this.clock()
    if (!now.ok) {
      return {
        ok: false,
        operation: 'unresolved-invalid',
        reason: CONTEXT_BOUNDARY_REFUSAL_TEXT.invalid_clock,
        candidateIds: [],
      }
    }
    const resolved = this.#store.resolve(reference, now.at)
    if (resolved.ok) return { ok: true, operation: 'resolved', item: resolved.item }

    return {
      ok: false,
      operation: RESOLUTION_OPERATION[resolved.reason] ?? 'unresolved-invalid',
      reason: CONTEXT_REFUSAL_TEXT[resolved.reason],
      candidateIds: resolved.candidateIds,
    }
  }

  /**
   * Resolve a reference without the content, for anything a window may read.
   *
   * The same five outcomes, in the same words, with ids instead of items. It adds no
   * capability over `read()` — which already lists the live items in the current
   * scope — but it answers the question a person actually asks, which is whether
   * "this" resolves, rather than leaving them to count rows themselves.
   */
  resolveMetadata(reference: ContextReference): ContextCommandOutcome {
    const resolved = this.resolve(reference)
    if (resolved.ok) return { operation: 'resolved', ok: true, contextId: resolved.item.contextId }

    return {
      operation: resolved.operation,
      ok: false,
      reason: resolved.reason,
      candidateIds: resolved.candidateIds,
    }
  }

  /* ------------------------------------------------------------------ read */

  /**
   * Everything a window may know about context, as metadata.
   *
   * The audit shape only — no content, no label, no URI, and not the free-text reason
   * for a revocation, which lives on a memory-only tombstone precisely so that it has
   * nowhere shared to travel.
   *
   * **Filtered to the active scope, and that includes the counts.** A projection that
   * listed every retained record would tell one conversation which ids, kinds and
   * sources exist in another, which is a smaller disclosure than content and a real
   * one all the same. So `retained` counts the rows this projection can account for,
   * *not* the store's global total: a Core that said "12 records" over here and "2
   * visible" would have handed out a fact about somebody else's conversation, and a
   * bare count is enough to confirm that a conversation exists at all.
   *
   * With no active scope this reports nothing, because there is no ambient reading —
   * an empty-but-ready projection reads as "there is no context" and is false.
   */
  read(): ContextProjectionView {
    const now = this.clock()
    const active = this.#store.activeScope
    const rows = now.ok && active !== null ? this.visibleRows(active, now.at) : []
    const items: ContextItemView[] = rows.map((row) => ({ ...row }))

    const counts = {
      live: 0,
      revoked: 0,
      expired: 0,
      retained: items.length,
      declaredScopes: this.declared.size,
    }
    for (const row of items) counts[row.state] += 1

    return {
      persistence: {
        mode: 'ephemeral',
        durable: false,
        reason:
          'context is held in this process only: nothing here is written to disk, because no encrypted context store exists yet',
      },
      activeScope: active === null ? null : scopeView(active),
      declaredScopes: [...this.declared.values()].map(scopeView),
      agentContext: this.agentContext(),
      items,
      counts,
      limits: {
        maxItems: this.limits.maxItems,
        maxLivePerScope: this.limits.maxLivePerScope,
        maxScopes: this.maxScopes,
      },
      sequence: this.sequence,
    }
  }

  /* --------------------------------------------------------------- mission */

  /**
   * Point "here" at the current Mission, or at nothing.
   *
   * The narrow adapter's entry point, and the only place `current_mission` is ever
   * admitted. Idempotent for an unchanged report — a Mission board that re-renders, or
   * a change event that fires twice, must not churn context ids and fill the audit
   * with revocations of something that never changed, so a report that resolves to the
   * sentence already held answers `unchanged` and admits nothing.
   *
   * A *changed* report — a different Mission, or the same one at a new status — revokes
   * the previous item before admitting the new one. Two live items of one kind would
   * make every "here" ambiguous, and ambiguous is a refusal; there is no instant in
   * which two Missions are both "here".
   *
   * Passing `null` means there is no current Mission and takes back whatever was held.
   * The reported outcome is the removal's own, so a caller can tell "pointed somewhere
   * new" from "pointed at nothing" without reading a string.
   */
  syncMissionContext(report: ContextMissionReport | null): ContextCommandOutcome {
    const now = this.clock()
    if (!now.ok) return now.outcome

    if (report === null) {
      if (this.missionContextId === null) {
        return { operation: 'revoke-not-found', ok: false, reason: 'no current Mission context is held' }
      }
      const previous = this.missionContextId
      const taken = this.revoke(previous, CONTEXT_MISSION_REVOKED_REASON)
      return taken.ok
        ? taken
        : {
            operation: 'revoke-already-settled',
            ok: false,
            reason: 'the current Mission context had already settled',
          }
    }

    // Checked, not assumed. The report type says `MissionStatus`, but the value
    // arrives from a Mission projection fold, and a type assertion is not evidence —
    // an unrecognised status would be admitted as an item label, which is the one part
    // of a Mission somebody might recognise.
    if (
      typeof report !== 'object' ||
      report === null ||
      typeof report.missionId !== 'string' ||
      report.missionId.trim().length === 0 ||
      report.missionId.length > this.limits.maxOriginIdChars ||
      !isReportableMissionStatus(report.status)
    ) {
      return this.refuse('malformed_request')
    }

    // Compared against what is actually live rather than against a cached sentence:
    // after a `revokeScope` the item is gone, and a stale cache would answer
    // `unchanged` for content that no longer exists.
    const held = this.heldMissionContent(now.at)
    const wanted = missionContextContent(report)
    if (held !== null && held.content === wanted) {
      return {
        operation: 'unchanged',
        // `ok: false` because nothing was admitted, and an operation that admits
        // nothing did not admit. This is not a refusal: the envelope's own `ok` is
        // what separates "Core did not understand you" from "Core understood you and
        // there was nothing to do", and a re-sent Mission report deserves the second.
        ok: false,
        contextId: held.contextId,
        scope: scopeView(SESSION_CONTEXT_SCOPE),
      }
    }

    const previous = held?.contextId ?? null
    const admitted = this.admitCoreRecord({
      ...missionContextAdmission(report),
      ttlMs: MISSION_CONTEXT_TTL_MS,
    })
    if (!admitted.ok) return admitted
    // After admitting, not before: admitting first means there is never an instant
    // with no Mission context at all, so a resolve landing between the two finds the
    // new Mission rather than nothing.
    if (previous !== null) this.revoke(previous, CONTEXT_MISSION_REVOKED_REASON)
    this.missionContextId = admitted.contextId ?? null

    return {
      ...admitted,
      scope: scopeView(SESSION_CONTEXT_SCOPE),
      ...(previous === null ? {} : { revokedCount: 1 }),
    }
  }

  /**
   * What the active-agent seam currently reports, for a caller that wants to say so in
   * words rather than infer it.
   *
   * Reports `wired` and *never* `available`, and reads nothing from the source —
   * `agent_work` is a deferred kind, so there is no agent context to report no matter
   * what is plugged in. If you find yourself wanting this to return something, the
   * foundation's `DEFERRED_CONTEXT_KINDS` is the thing to change, and #16 is the reason
   * to change it.
   */
  agentContext(): ContextProjectionView['agentContext'] {
    return {
      wired: this.agentSource !== null,
      available: false,
      reason: NO_ACTIVE_AGENT_CONTEXT_REASON,
    }
  }

  /* --------------------------------------------------------------- private */

  /**
   * A store spec, built one field at a time.
   *
   * Never a cast of the caller's object. Whatever the allowlist in `admit` misses, the
   * spec that reaches the store has exactly these keys — so the provenance this class
   * derived is the provenance the store checks, rather than the one a caller hoped for.
   */
  private storeSpec(
    fields: Record<string, unknown>,
    source: ContextAdmission['source'],
    scope: ContextScopeView,
  ): ContextAdmission {
    return {
      kind: fields.kind as ContextAdmission['kind'],
      source,
      scope,
      content: fields.content as string,
      label: (fields.label ?? null) as string | null,
      uri: (fields.uri ?? null) as string | null,
      originId: (fields.originId ?? null) as string | null,
      capturedAt: (fields.capturedAt ?? null) as string | null,
      ttlMs: (fields.ttlMs ?? null) as number | null,
    }
  }

  /** The store's answer, in this class's vocabulary. */
  private commit(spec: ContextAdmission, scope: ContextScopeView, at: Date): ContextCommandOutcome {
    const result = this.#store.admit(spec, at)
    if (!result.ok) {
      // The store's own code stays inside Core: a window gets the sentence and not the
      // rule, so the wording can change without a protocol change and without exposing
      // the closed tables the rule is built from.
      return { operation: 'refused', ok: false, reason: CONTEXT_ADMISSION_REASONS[result.code] }
    }
    this.sequence += 1
    return {
      operation: 'admitted',
      ok: true,
      contextId: result.item.contextId,
      scope,
      evictedIds: result.evicted,
    }
  }

  /**
   * The clock, or a refusal.
   *
   * Every operation starts here. Nothing in this file reads a clock for itself, and an
   * unusable instant changes nothing rather than being treated as "now" — a context
   * item judged live because the clock was broken is exactly the failure the
   * foundation's refusal codes exist to prevent.
   */
  private clock(): { ok: true; at: Date } | { ok: false; outcome: ContextCommandOutcome } {
    const at = this.readNow()
    if (isValidContextInstant(at)) return { ok: true, at }
    return { ok: false, outcome: this.refuse('invalid_clock') }
  }

  private refuse(refusal: ContextBoundaryRefusal): ContextCommandOutcome {
    return contextRefusal(refusal)
  }

  /** The rows a caller in `active` is allowed to hear about: theirs, plus the session's. */
  private visibleRows(active: ContextScopeView, at: Date): readonly ContextItemView[] {
    return this.#store.audit(at).filter(
      (row) =>
        row.scopeKind === 'session' ||
        (row.scopeKind === active.scopeKind && row.scopeId === active.scopeId),
    )
  }

  private liveRowsIn(scope: ContextScopeView, at: Date): readonly ContextItemView[] {
    return this.#store.audit(at).filter(
      (row) => row.state === 'live' && row.scopeKind === scope.scopeKind && row.scopeId === scope.scopeId,
    )
  }

  private revokeLiveIn(scope: ContextScopeView, reason: string, at: Date): number {
    return this.takeBack(this.liveRowsIn(scope, at), reason, at)
  }

  /**
   * Revoke a set of live rows, one at a time, and forget the Mission pointer if it was
   * among them.
   *
   * Item-by-item because that is the only route through the store's public API that
   * cannot reach an already-expired record, and the count returned is what actually
   * changed rather than what was asked for.
   */
  private takeBack(rows: readonly ContextItemView[], reason: string, at: Date): number {
    let revoked = 0
    for (const row of rows) {
      if (!this.#store.revoke(row.contextId, reason, at)) continue
      revoked += 1
      if (this.missionContextId === row.contextId) this.missionContextId = null
    }
    return revoked
  }

  /**
   * The live `current_mission` item, read back through the resolver.
   *
   * Resolved rather than looked up in the audit rows because the audit shape has no
   * content, and "has this Mission's context changed" is a question about the content.
   * Going through `resolve` also means the answer cannot disagree with what `here`
   * would resolve to, which is the property the idempotency check depends on.
   */
  private heldMissionContent(at: Date): ContextItem | null {
    const resolved = this.#store.resolve({ term: 'this', kind: 'current_mission' }, at)
    return resolved.ok ? resolved.item : null
  }

  private addScope(scope: ContextScopeView): boolean {
    const key = scopeKey(scope)
    if (this.declared.has(key)) return true
    // Refuse rather than evict. A scope losing its place to a newer one would change
    // what resolves for whatever was still pointed at it.
    if (this.declared.size >= this.maxScopes) return false
    this.declared.set(key, scopeView(scope))
    return true
  }

  private scopeIsUsable(scope: ContextScopeView): boolean {
    if (typeof scope !== 'object' || scope === null) return false
    if (!isContextScopeKind(scope.scopeKind)) return false
    if (typeof scope.scopeId !== 'string') return false
    const id = scope.scopeId.trim()
    return id.length > 0 && id.length <= this.limits.maxScopeIdChars
  }

  /** A scope off the wire, read defensively — an object is not yet a scope. */
  private readScope(value: Record<string, unknown>): ContextScopeView | null {
    const scopeKind = value.scopeKind
    const scopeId = value.scopeId
    if (!isContextScopeKind(scopeKind)) return null
    if (typeof scopeId !== 'string') return null
    const scope: ContextScopeView = { scopeKind, scopeId: scopeId.trim() }
    return this.scopeIsUsable(scope) ? scope : null
  }

  /**
   * A reason has to be a sentence.
   *
   * A tombstone with no intelligible "why" is not worth creating, and a reason longer
   * than the ceiling is somebody's essay rather than their reason — which is also why
   * it never reaches a shared surface.
   */
  private reasonIsUsable(reason: string): boolean {
    if (typeof reason !== 'string') return false
    if (reason.trim().length === 0) return false
    return reason.length <= this.limits.maxReasonChars
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(Math.max(Math.trunc(value), low), high)
}