import {
  CONTEXT_ADMISSION_REASONS,
  CONTEXT_KIND_SOURCES,
  contextLimits,
  isContextKind,
  isContextScopeKind,
  isContextSource,
  isDeferredContextKind,
  isSameContextScope,
  type ContextAdmission,
  type ContextAdmissionCode,
  type ContextAdmissionResult,
  type ContextAuditRecord,
  type ContextItem,
  type ContextLimits,
  type ContextReference,
  type ContextResolution,
  type ContextScope,
  type ContextTombstone,
} from './types'
import {
  contextItemState,
  isContextItemLive,
  isValidContextInstant,
  orderedContextItems,
  retireContextItem,
} from './item'
import { contextItemsInScope, resolveContextReference } from './reference'
import { contextAuditRecords } from './audit'

/**
 * THE CONTEXT STORE.
 *
 * Process-lifetime, bounded, and synchronous. It holds what has been shared
 * into it and answers two questions: *may this be held at all* (admission,
 * against the closed tables and the code-owned limits) and *what does this
 * reference point at* (resolution, in `reference.ts`). Neither question has a
 * model in its answer.
 *
 * ## The properties, and where each one lives
 *
 * - **Bounded retention.** `CONTEXT_LIMITS` caps total records, live items per
 *   scope, content size and TTL. Admission evicts to stay inside them and
 *   reports what it dropped; `purge` forgets retired metadata on request. The
 *   invariant `records.size <= maxItems` holds after every admission.
 * - **Expiry destroys content.** Any observation of the store first retires
 *   expired items: content, label and URI emptied, lengths kept. Expiry is not
 *   a filter applied at read time — the words stop existing.
 * - **Revocation destroys content and says why.** `revoke` empties the private
 *   part and leaves a tombstone (`revokedAt`, `revocationReason`) so a later
 *   reference can answer `revoked` instead of pretending nothing was ever
 *   there. `revokeScope` takes back a whole share in one act.
 * - **Scope is held here, not asserted by callers.** The active scope is
 *   Core's state (`setActiveScope`); a reference never carries one, so a
 *   caller cannot point "here" at somebody else's conversation.
 * - **No authority, no journal, no capture, no inference.** The store imports
 *   nothing from events, model, cognition or the filesystem, and every method
 *   is synchronous: there is no path from this object to a provider, a
 *   permission or a disk.
 *
 * ## Ephemeral by statement, not by accident
 *
 * This store itself is synchronous and process-local. Core assembly supplies
 * validated recovery records and a private snapshot callback to its encrypted
 * persistence lifecycle; no key or filesystem operation enters this module.
 */
export interface ContextStoreOptions {
  /** Validated, retired recovery records, supplied only by Core assembly. */
  readonly initialRecords?: readonly ContextItem[]
  /** Private snapshot sink. Receives independent copies after a record changes. */
  readonly onChange?: (records: readonly ContextItem[]) => void
  /** Injected id factory for tests and deterministic replay. */
  readonly newId?: () => string
  /** Ceilings may be lowered here and never raised above `CONTEXT_LIMITS`. */
  readonly limits?: Partial<ContextLimits>
}

function admissionRefusal(code: ContextAdmissionCode): ContextAdmissionResult {
  return { ok: false, code, reason: CONTEXT_ADMISSION_REASONS[code] }
}

export class ContextStore {
  /** What durability this store provides. Never a guess. */
  readonly mode = 'ephemeral' as const
  /** Nothing here survives a restart, and it says so rather than looking healthy. */
  readonly durable = false as const

  private readonly records = new Map<string, ContextItem>()
  private readonly limits: ContextLimits
  private readonly customId: (() => string) | null
  private counter = 0
  private active: ContextScope | null = null
  private readonly onChange: (records: readonly ContextItem[]) => void

  constructor(options: ContextStoreOptions = {}) {
    this.limits = contextLimits(options.limits ?? {})
    this.customId = options.newId ?? null
    this.onChange = options.onChange ?? (() => {})
    for (const item of options.initialRecords ?? []) {
      this.records.set(item.contextId, this.copy(item))
      const numericId = /^ctx-(\d+)$/.exec(item.contextId)
      if (numericId) this.counter = Math.max(this.counter, Number(numericId[1]))
    }
  }

  /** The scope "here" currently means, or null when nothing is current. */
  get activeScope(): ContextScope | null {
    return this.active
  }

  /** Records retained right now: live items and tombstones together. */
  get retained(): number {
    return this.records.size
  }

  /**
   * Set — or clear — the current scope. Returns false and changes nothing if
   * the scope is malformed: a bad scope must not become the place "here"
   * points at.
   */
  setActiveScope(scope: ContextScope | null): boolean {
    if (scope === null) {
      this.active = null
      return true
    }
    if (!this.scopeIsValid(scope)) return false
    this.active = { scopeKind: scope.scopeKind, scopeId: scope.scopeId }
    return true
  }

  /**
   * Hold something, or refuse in words.
   *
   * Admission is where every rule is enforced: the kind/source table, the
   * origin requirement, the size and TTL ceilings, and the retention bounds.
   * Eviction happens *before* insertion, so the bound is never exceeded even
   * for an instant, and the ids it dropped come back in `evicted` — bounded
   * forgetting that reports itself rather than happening quietly.
   */
  admit(spec: ContextAdmission, now: Date): ContextAdmissionResult {
    if (!isValidContextInstant(now)) return admissionRefusal('invalid_instant')

    const kind = spec.kind
    if (isDeferredContextKind(kind)) return admissionRefusal('kind_deferred')
    if (!isContextKind(kind)) return admissionRefusal('kind_unknown')
    if (!isContextSource(spec.source)) return admissionRefusal('source_not_permitted')
    if (!CONTEXT_KIND_SOURCES[kind].includes(spec.source)) {
      return admissionRefusal('source_not_permitted')
    }

    // Content that did not come from the owner's own hand must point at the
    // record it came from, so "the host said so" is never a bare assertion.
    const origin = spec.originId ?? null
    const originId = origin === '' ? null : origin
    if (originId !== null && (typeof originId !== 'string' || originId.length > this.limits.maxOriginIdChars)) {
      return admissionRefusal('invalid_origin')
    }
    const ownerHeld =
      spec.source === 'owner_selection' ||
      spec.source === 'owner_share' ||
      spec.source === 'owner_authorization'
    if (originId === null && !ownerHeld) return admissionRefusal('origin_required')

    if (!this.scopeIsValid(spec.scope)) return admissionRefusal('invalid_scope')

    if (typeof spec.content !== 'string' || spec.content.trim().length === 0) {
      return admissionRefusal('content_empty')
    }
    if (spec.content.length > this.limits.maxContentChars) return admissionRefusal('content_too_large')

    const label = spec.label ?? ''
    if (typeof label !== 'string' || label.length > this.limits.maxLabelChars) {
      return admissionRefusal('label_too_large')
    }

    const uriRaw = spec.uri ?? null
    let uri: string | null = null
    if (uriRaw !== null && uriRaw !== '') {
      if (typeof uriRaw !== 'string' || uriRaw.length > this.limits.maxUriChars) {
        return admissionRefusal('uri_too_large')
      }
      uri = uriRaw
    }

    const requestedTtl = spec.ttlMs ?? null
    let ttlMs = this.limits.defaultTtlMs
    if (requestedTtl !== null) {
      if (typeof requestedTtl !== 'number' || !Number.isFinite(requestedTtl) || requestedTtl <= 0) {
        return admissionRefusal('invalid_ttl')
      }
      // Clamped, never raised: a caller may ask to remember something for
      // less than the ceiling, never for longer than it.
      ttlMs = Math.min(requestedTtl, this.limits.maxTtlMs)
    }

    const admittedAt = now.toISOString()
    let capturedAt = admittedAt
    if (spec.capturedAt !== null && spec.capturedAt !== undefined) {
      const parsed = Date.parse(spec.capturedAt)
      if (!Number.isFinite(parsed)) return admissionRefusal('invalid_instant')
      // Nothing was captured in the future; a future capture instant would be
      // provenance that has not happened yet.
      if (parsed > now.getTime()) return admissionRefusal('invalid_instant')
      capturedAt = spec.capturedAt
    }

    const evicted: string[] = []
    this.retireExpired(now)
    this.enforceCapacity(spec.scope, now, evicted)

    const item: ContextItem = {
      contextId: this.mintId(),
      kind,
      provenance: { source: spec.source, capturedAt, originId },
      scope: { scopeKind: spec.scope.scopeKind, scopeId: spec.scope.scopeId },
      label,
      content: spec.content,
      uri,
      admittedAt,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      contentLength: spec.content.length,
      labelLength: label.length,
      revokedAt: null,
      revocationReason: null,
    }
    this.records.set(item.contextId, item)
    this.changed()
    return { ok: true, item, evicted }
  }

  /**
   * What this reference points at — or an honest refusal.
   *
   * The store supplies the active scope (callers cannot) and retires expired
   * content first, then hands the rest to the pure resolver.
   */
  resolve(reference: ContextReference, now: Date): ContextResolution {
    if (!isValidContextInstant(now)) {
      return { ok: false, reason: 'invalid_clock', candidateIds: [] }
    }
    this.retireExpired(now)
    return resolveContextReference(reference, [...this.records.values()], this.active, now)
  }

  /**
   * Live items in the current scope, most recent first.
   *
   * Ordering is presentation, never a tie-break: resolution refuses rather
   * than choosing, so nothing downstream can read "first" as "meant". With no
   * active scope this returns nothing at all — fail closed, not empty-but-
   * ambient.
   */
  list(now: Date): readonly ContextItem[] {
    if (!isValidContextInstant(now)) return []
    this.retireExpired(now)
    return contextItemsInScope([...this.records.values()], this.active)
      .filter((item) => isContextItemLive(item, now))
      .reverse()
  }

  /**
   * Take one item back.
   *
   * Revocation is destruction plus a stated reason: the content, label and URI
   * are emptied, and the tombstone keeps the id, the measured lengths and the
   * reason so a later reference can say `revoked` truthfully. The reason is
   * free text, so it lives on the tombstone and never reaches the audit shape.
   * Returns false when nothing changed — unknown id, already revoked, an
   * unusable instant, or a reason that is empty or longer than the ceiling (a
   * tombstone with no intelligible "why" is not worth creating).
   */
  revoke(contextId: string, reason: string, now: Date): boolean {
    if (!isValidContextInstant(now)) return false
    if (!this.reasonIsValid(reason)) return false
    const item = this.records.get(contextId)
    if (item === undefined || item.revokedAt !== null) return false
    this.records.set(contextId, {
      ...retireContextItem(item),
      revokedAt: now.toISOString(),
      revocationReason: reason,
    })
    this.changed()
    return true
  }

  /**
   * Take back everything shared into one scope — "stop sharing this tab".
   *
   * Exact scope equality: revoking a conversation does not reach session-
   * ambient items (shared for the whole session on their own account), and
   * revoking a session is an explicit act naming the session.
   */
  revokeScope(scope: ContextScope, reason: string, now: Date): number {
    if (!isValidContextInstant(now)) return 0
    if (!this.reasonIsValid(reason)) return 0
    if (!this.scopeIsValid(scope)) return 0
    const targets = [...this.records.values()].filter(
      (item) => isSameContextScope(item.scope, scope) && item.revokedAt === null,
    )
    if (targets.length === 0) return 0
    const at = now.toISOString()
    for (const item of targets) {
      this.records.set(item.contextId, { ...retireContextItem(item), revokedAt: at, revocationReason: reason })
    }
    this.changed()
    return targets.length
  }

  /**
   * Forget every retired record — its content was already destroyed when it
   * was revoked or when it expired; this drops the tombstone too, so a refusal
   * degrades from `revoked`/`expired` to `no_candidates`. Live records are
   * never purged, and an unusable instant purges nothing.
   */
  purge(now: Date): readonly string[] {
    if (!isValidContextInstant(now)) return []
    this.retireExpired(now)
    const removed: string[] = []
    for (const [id, item] of this.records) {
      if (contextItemState(item, now) !== 'live') {
        this.records.delete(id)
        removed.push(id)
      }
    }
    if (removed.length > 0) this.changed()
    return removed
  }

  /**
   * Retired records, with their stated why.
   *
   * The inspectable half of revocation: what was taken back, when, and the
   * reason — alongside what merely expired. Content is gone from all of these
   * (retirement emptied it), and the free-text reason lives here rather than
   * in `audit()` for the same reason it lives nowhere else shared: it is
   * somebody's words.
   */
  tombstones(now: Date): readonly ContextTombstone[] {
    if (!isValidContextInstant(now)) return []
    this.retireExpired(now)
    const rows: ContextTombstone[] = []
    for (const item of orderedContextItems(this.records.values())) {
      const state = contextItemState(item, now)
      if (state === 'live') continue
      rows.push({
        contextId: item.contextId,
        kind: item.kind,
        scope: item.scope,
        admittedAt: item.admittedAt,
        expiresAt: item.expiresAt,
        revokedAt: item.revokedAt,
        state,
        reason: item.revocationReason,
      })
    }
    return rows
  }

  /**
   * Everything retained, as audit metadata, oldest first.
   *
   * Ids, closed labels, instants and measured lengths. There is no field in
   * these records a sentence could hide in — see `audit.ts` for why the shape
   * is built by subtraction rather than filtered at the call site.
   */
  audit(now: Date): readonly ContextAuditRecord[] {
    if (!isValidContextInstant(now)) return []
    this.retireExpired(now)
    return contextAuditRecords(orderedContextItems(this.records.values()), now)
  }

  /** Core-private retained snapshot, including tombstones; never a projection. */
  snapshot(now: Date): readonly ContextItem[] {
    this.retireExpired(now)
    return orderedContextItems(this.records.values()).map((item) => this.copy(item))
  }

  private copy(item: ContextItem): ContextItem {
    return { ...item, scope: { ...item.scope }, provenance: { ...item.provenance } }
  }

  private changed(): void {
    this.onChange(orderedContextItems(this.records.values()).map((item) => this.copy(item)))
  }

  /* -------------------------------------------------------------- private */

  /**
   * Destroy the content of everything past its TTL.
   *
   * Called by every observation, so expiry is not a promise that a later read
   * will filter: the words stop existing the first time anybody looks after
   * the deadline, and they stay gone.
   */
  private retireExpired(now: Date): void {
    if (!isValidContextInstant(now)) return
    const at = now.getTime()
    let changed = false
    for (const [id, item] of this.records) {
      if (item.revokedAt === null && Date.parse(item.expiresAt) <= at) {
        const retired = retireContextItem(item)
        if (retired !== item) {
          this.records.set(id, retired)
          changed = true
        }
      }
    }
    if (changed) this.changed()
  }

  /** Hold both retention bounds, before the new record is inserted. */
  private enforceCapacity(targetScope: ContextScope, now: Date, evicted: string[]): void {
    // Live items per scope: tombstones do not count against a scope's ability
    // to receive new context — what is already gone should not block the
    // present.
    for (;;) {
      const liveInScope = orderedContextItems(
        [...this.records.values()].filter(
          (item) => isSameContextScope(item.scope, targetScope) && isContextItemLive(item, now),
        ),
      )
      if (liveInScope.length < this.limits.maxLivePerScope) break
      const oldest = liveInScope[0]
      if (oldest === undefined) break
      this.records.delete(oldest.contextId)
      evicted.push(oldest.contextId)
    }

    // Total records: tombstones are forgotten first (their content is already
    // destroyed, so dropping them costs no context), then the oldest record.
    while (this.records.size >= this.limits.maxItems) {
      const ordered = orderedContextItems(this.records.values())
      const dead = ordered.find((item) => !isContextItemLive(item, now))
      const victim = dead ?? ordered[0]
      if (victim === undefined) break
      this.records.delete(victim.contextId)
      evicted.push(victim.contextId)
    }
  }

  private mintId(): string {
    if (this.customId !== null) {
      const id = this.customId()
      if (typeof id !== 'string' || id.length === 0 || this.records.has(id)) {
        throw new Error('the injected context id factory returned a duplicate or unusable id')
      }
      return id
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      this.counter += 1
      const id = `ctx-${String(this.counter).padStart(6, '0')}`
      if (!this.records.has(id)) return id
    }
    throw new Error('the context id space is exhausted')
  }

  private scopeIsValid(scope: ContextScope | null): boolean {
    if (scope === null || typeof scope !== 'object') return false
    if (!isContextScopeKind(scope.scopeKind)) return false
    if (typeof scope.scopeId !== 'string') return false
    return scope.scopeId.length > 0 && scope.scopeId.length <= this.limits.maxScopeIdChars
  }

  private reasonIsValid(reason: string): boolean {
    if (typeof reason !== 'string') return false
    if (reason.trim().length === 0) return false
    return reason.length <= this.limits.maxReasonChars
  }
}
