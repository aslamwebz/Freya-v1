import { randomUUID } from 'node:crypto'
import type { Confidence } from '../brain/types'
import type { AnyCoreEvent } from '../events/envelope'
import type { EventFabric } from '../events/fabric'
import {
  admitLifeEntry,
  capConfidence,
  checkLifeDraft,
  contentHashOf,
  findConflicts,
  selectForRetention,
  type LifeEntryDraft,
} from './admission'
import { deriveLifeDraft } from './derive'
import { effectiveStatus } from './fold'
import { lifeEntryDetail, projectLife, projectTimeline, type LifeTimelineQuery } from './projection'
import { LifeStoreError, type LifeState, type LifeStore } from './store'
import { LIFE_LIMITS, type LifeEntry, type LifeEntryKind, type LifeReference, type LifeSalience, type LifeSourceDomain } from './types'
import type {
  LifeEntryDetailView,
  LifePersistenceView,
  LifeProjection,
  LifeTimelineView,
} from '../protocol/life'

/**
 * THE LIFE HISTORY ENGINE.
 *
 * Core owns this and nothing else can reach it. It holds the store, the
 * journal port and the clock, and it has no gateway, no provider and no model.
 * Its only way to produce an entry is `admitLifeEntry`, which caps confidence,
 * refuses secret-shaped text and refuses a derived entry with no evidence.
 *
 * The engine records entries in two ways:
 *
 * 1. **Derivation** from a closed table of authoritative events (`derive.ts`),
 *    deterministic and idempotent, so a restart cannot duplicate or fork history.
 * 2. **The owner scope**, an internal object issued only from inside Core (and
 *    from `core/testing.ts`). There is deliberately no renderer command that can
 *    record, revise, consolidate or withdraw.
 */

export interface LifeRecordInput {
  readonly kind: LifeEntryKind
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly salience: LifeSalience
  readonly derivation: LifeEntryDraft['derivation']
  readonly confidence: Confidence
  readonly sourceDomain: LifeSourceDomain
  readonly sourceId: string | null
  readonly actor: string
  readonly references: readonly LifeReference[]
  readonly occurredAt: string | null
  readonly tags: readonly string[]
}

export interface LifeConsolidateInput {
  readonly kind: LifeEntryKind
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly salience: LifeSalience
  readonly confidence: Confidence
  readonly references: readonly LifeReference[]
  readonly occurredAt: string | null
  readonly tags: readonly string[]
}

export interface LifeReviseInput {
  readonly title?: string
  readonly summary?: string
  readonly body?: string
  readonly salience?: LifeSalience
  readonly derivation?: LifeEntryDraft['derivation']
  readonly confidence?: Confidence
  readonly references?: readonly LifeReference[]
  readonly occurredAt?: string | null
  readonly tags?: readonly string[]
}

export interface LifeRecordOutcome {
  readonly outcome: 'recorded' | 'revised' | 'withdrawn' | 'rejected'
  readonly entry: LifeEntry | null
  readonly reason: string
  readonly conflicts: readonly string[]
}

/**
 * The owner's face of Life History.
 *
 * Holding it is the authority to record, consolidate, revise and withdraw, and it
 * is issued by Core rather than acquired by naming a capability. It cannot change
 * a confidence above its class ceiling, cannot write a secret-shaped entry,
 * cannot delete history and cannot reach a model: the engine has no such method.
 */
export interface LifeOwnerScope {
  record(input: LifeRecordInput): Promise<LifeRecordOutcome>
  consolidate(input: LifeConsolidateInput): Promise<LifeRecordOutcome>
  revise(entryId: string, input: LifeReviseInput, reason: string): Promise<LifeRecordOutcome>
  withdraw(entryId: string, reason: string): Promise<LifeRecordOutcome>
}

export interface LifeEngineOptions {
  readonly fabric: EventFabric
  readonly store: LifeStore
  readonly now?: () => Date
  readonly newId?: () => string
  readonly onChange?: () => void
  /** Read fresh at each decision. True means no enrichment, not "no reads". */
  readonly stopped?: () => boolean
}

export class LifeEngine implements LifeOwnerScope {
  private readonly fabric: EventFabric
  private readonly store: LifeStore
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly onChange: () => void
  private readonly stopped: () => boolean

  constructor(options: LifeEngineOptions) {
    this.fabric = options.fabric
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    this.onChange = options.onChange ?? (() => {})
    this.stopped = options.stopped ?? (() => false)
  }

  ownerScope(): LifeOwnerScope {
    return this
  }

  async open(): Promise<void> {
  }

  /**
   * Backfill derived entries from the durable journal.
   *
   * Idempotent: an entry already in the store is not recorded again, so a restart
   * cannot duplicate history. STOP ALL is read fresh and stops enrichment; the
   * store already holds what was derived before the stop.
   */
  async deriveFromJournal(): Promise<number> {
    if (this.stopped()) return 0
    const events = await this.fabric.readAll()
    let derived = 0
    for (const event of events) {
      if (this.stopped()) break
      const draft = deriveLifeDraft(event)
      if (draft === null) continue
      if (draft.entryId !== undefined && this.store.state().entries.has(draft.entryId)) continue
      const outcome = await this.commitDraft(draft)
      if (outcome.outcome === 'recorded') derived += 1
    }
    return derived
  }

  /** Derive from one live event. Idempotent, and silent while stopped. */
  async observe(event: AnyCoreEvent): Promise<void> {
    if (this.stopped()) return
    const draft = deriveLifeDraft(event)
    if (draft === null) return
    if (draft.entryId !== undefined && this.store.state().entries.has(draft.entryId)) return
    await this.commitDraft(draft)
  }

  /* ------------------------------------------------------------- owner acts */

  async record(input: LifeRecordInput): Promise<LifeRecordOutcome> {
    const now = this.nowIso()
    const draft: LifeEntryDraft = {
      entryId: this.newId(),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      body: input.body,
      salience: input.salience,
      derivation: input.derivation,
      confidence: input.confidence,
      provenance: {
        sourceDomain: input.sourceDomain,
        sourceId: input.sourceId,
        observedAt: now,
        recordedAt: now,
        actor: input.actor,
      },
      references: input.references,
      occurredAt: input.occurredAt,
      tags: input.tags,
      admissionReason: `recorded as ${input.derivation} from ${input.sourceDomain}`,
    }
    return this.commitDraft(draft)
  }

  async consolidate(input: LifeConsolidateInput): Promise<LifeRecordOutcome> {
    const now = this.nowIso()
    const draft: LifeEntryDraft = {
      entryId: this.newId(),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      body: input.body,
      salience: input.salience,
      derivation: 'derived',
      confidence: input.confidence,
      provenance: {
        sourceDomain: 'life',
        sourceId: null,
        observedAt: now,
        recordedAt: now,
        actor: 'system',
      },
      references: input.references,
      occurredAt: input.occurredAt,
      tags: input.tags,
      admissionReason: `consolidated from ${input.references.length} evidence record(s)`,
    }
    return this.commitDraft(draft)
  }

  async revise(entryId: string, input: LifeReviseInput, reason: string): Promise<LifeRecordOutcome> {
    const base = this.store.state().entries.get(entryId)
    if (base === undefined) {
      return { outcome: 'rejected', entry: null, reason: 'no such Life entry', conflicts: [] }
    }
    if (base.status === 'withdrawn') {
      return { outcome: 'rejected', entry: null, reason: 'a withdrawn entry cannot be revised', conflicts: [] }
    }
    const now = this.nowIso()
    const next = {
      title: input.title ?? base.title,
      summary: input.summary ?? base.summary,
      body: input.body ?? base.body,
      salience: input.salience ?? base.salience,
      derivation: input.derivation ?? base.derivation,
      references: input.references ?? base.references,
      occurredAt: input.occurredAt !== undefined ? input.occurredAt : base.occurredAt,
      tags: input.tags ?? base.tags,
    }
    const draft: LifeEntryDraft = {
      entryId,
      kind: base.kind,
      ...next,
      confidence: input.confidence ?? base.confidence,
      provenance: {
        sourceDomain: base.provenance.sourceDomain,
        sourceId: base.provenance.sourceId,
        observedAt: base.provenance.observedAt,
        recordedAt: base.recordedAt,
        actor: base.provenance.actor,
      },
      admissionReason: `revised: ${reason}`,
    }
    const rejection = checkLifeDraft(draft)
    if (rejection !== null) return { outcome: 'rejected', entry: null, reason: rejection, conflicts: [] }

    const confidence = capConfidence(next.derivation, draft.confidence)
    const revised = this.revisionOf(
      base,
      {
        ...next,
        derivation: next.derivation,
        confidence,
        provenance: { ...base.provenance, derivation: next.derivation, confidence },
      },
      now,
      `revised: ${reason}`,
    )
    return this.commitRevision(revised, now)
  }

  async withdraw(entryId: string, reason: string): Promise<LifeRecordOutcome> {
    const now = this.nowIso()
    return this.withdrawInternal(entryId, reason, now)
  }

  /* ------------------------------------------------------------- internals */

  private async commitDraft(draft: LifeEntryDraft): Promise<LifeRecordOutcome> {
    const now = this.nowIso()
    try {
      for (const id of selectForRetention(this.store.state())) {
        await this.withdrawInternal(id, 'retention-bound', now)
      }
      const outcome = admitLifeEntry(draft, this.store.state(), now)
      if (outcome.decision === 'rejected') {
        return { outcome: 'rejected', entry: null, reason: outcome.reason, conflicts: [] }
      }
      await this.store.write({ kind: 'life-entry', entry: outcome.entry })
      const conflicts = await this.recordConflicts(outcome.entry, outcome.conflicts, now)
      await this.announce(outcome.entry, conflicts.length)
      this.onChange()
      return { outcome: 'recorded', entry: outcome.entry, reason: outcome.entry.admissionReason, conflicts }
    } catch (error) {
      return { outcome: 'rejected', entry: null, reason: this.describe(error), conflicts: [] }
    }
  }

  private async commitRevision(entry: LifeEntry, now: string): Promise<LifeRecordOutcome> {
    try {
      await this.store.write({ kind: 'life-entry', entry })
      const conflictIds = findConflicts(entry, this.store.state())
      const conflicts = await this.recordConflicts(entry, conflictIds, now)
      await this.announce(entry, conflicts.length)
      this.onChange()
      return { outcome: 'revised', entry, reason: entry.admissionReason, conflicts }
    } catch (error) {
      return { outcome: 'rejected', entry: null, reason: this.describe(error), conflicts: [] }
    }
  }

  private async withdrawInternal(entryId: string, reason: string, now: string): Promise<LifeRecordOutcome> {
    const base = this.store.state().entries.get(entryId)
    if (base === undefined) {
      return { outcome: 'rejected', entry: null, reason: 'no such Life entry', conflicts: [] }
    }
    if (base.status === 'withdrawn') {
      return { outcome: 'rejected', entry: null, reason: 'the Life entry is already withdrawn', conflicts: [] }
    }
    const withdrawn = this.revisionOf(base, { status: 'withdrawn' }, now, `withdrawn: ${reason}`)
    try {
      await this.store.write({ kind: 'life-entry', entry: withdrawn })
      await this.emit('life.entry.withdrawn', {
        entryId: withdrawn.entryId,
        revision: withdrawn.revision,
        reason: withdrawn.admissionReason,
      })
      this.onChange()
      return { outcome: 'withdrawn', entry: withdrawn, reason: withdrawn.admissionReason, conflicts: [] }
    } catch (error) {
      return { outcome: 'rejected', entry: null, reason: this.describe(error), conflicts: [] }
    }
  }

  /**
   * Build the next revision of an entry.
   *
   * The superseded revision is recorded in `lineage` with its content hash, so a
   * re-consolidation is traceable rather than an invisible overwrite. `recordedAt`
   * is preserved: it is when the thing was first written down.
   */
  private revisionOf(
    base: LifeEntry,
    changes: Partial<LifeEntry>,
    now: string,
    reason: string,
  ): LifeEntry {
    const lineage = [
      ...base.lineage,
      {
        revision: base.revision,
        at: now,
        reason,
        supersededContentHash: contentHashOf(base),
      },
    ].slice(-LIFE_LIMITS.maxLineagePerEntry)
    const admissionReason = `${base.admissionReason}; ${reason} at ${now}`.slice(0, LIFE_LIMITS.maxReasonChars)
    return {
      ...base,
      ...changes,
      revision: base.revision + 1,
      updatedAt: now,
      lineage,
      admissionReason,
    }
  }

  private async recordConflicts(
    entry: LifeEntry,
    conflictIds: readonly string[],
    now: string,
  ): Promise<string[]> {
    const conflicts: string[] = []
    for (const otherId of conflictIds) {
      const conflictId = deterministicConflictId(entry.entryId, otherId)
      conflicts.push(otherId)
      if (this.store.state().conflicts.has(conflictId)) continue
      try {
        await this.store.write({
          kind: 'life-conflict',
          conflict: {
            conflictId,
            entryA: entry.entryId,
            entryB: otherId,
            reason: 'two entries of the same kind share evidence and disagree',
            detectedAt: now,
          },
        })
        await this.emit('life.conflict.detected', {
          conflictId,
          entryA: entry.entryId,
          entryB: otherId,
        })
      } catch (error) {
        console.error('[freya.core] a Life conflict could not be recorded', this.describe(error))
      }
    }
    return conflicts
  }

  private async announce(entry: LifeEntry, conflictCount: number): Promise<void> {
    await this.emit('life.entry.recorded', {
      entryId: entry.entryId,
      kind: entry.kind,
      derivation: entry.derivation,
      confidence: entry.confidence,
      salience: entry.salience,
      status: entry.status,
      revision: entry.revision,
      sourceDomain: entry.provenance.sourceDomain,
      sourceId: entry.provenance.sourceId,
      occurredAtKnown: entry.occurredAt !== null,
      titleLength: entry.title.length,
      summaryLength: entry.summary.length,
      bodyLength: entry.body.length,
      referenceCount: entry.references.length,
      conflictCount,
    })
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.fabric.append(type as never, payload as never, { actor: 'system' })
    } catch (error) {
      console.error('[freya.core] a Life event could not be recorded', this.describe(error))
    }
  }

  /* --------------------------------------------------------------- reads */

  projection(): LifeProjection {
    return projectLife({ state: this.store.state(), persistence: this.persistenceView() })
  }

  timeline(query: LifeTimelineQuery = {}): LifeTimelineView {
    return projectTimeline(this.store.state(), query)
  }

  entry(entryId: string): LifeEntryDetailView | null {
    const entry = this.store.state().entries.get(entryId)
    return entry === undefined ? null : lifeEntryDetail(entry, this.store.state())
  }

  state(): LifeState {
    return this.store.state()
  }

  health(): { health: 'healthy' | 'degraded' | 'unavailable'; reason: string | null } {
    return this.store.health()
  }

  persistenceView(): LifePersistenceView {
    const health = this.store.health()
    const reason = health.reason ?? this.store.faultReason
    return {
      mode: this.store.mode,
      durable: this.store.mode === 'encrypted' && reason === null,
      reason,
    }
  }

  /** True when an entry is currently conflicted, for callers that need the edge. */
  isConflicted(entryId: string): boolean {
    const entry = this.store.state().entries.get(entryId)
    if (entry === undefined) return false
    return effectiveStatus(entry, this.store.state().conflicts.values()) === 'conflicted'
  }

  async close(): Promise<void> {
    await this.store.close()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private describe(error: unknown): string {
    if (error instanceof LifeStoreError) return `${error.code}: ${error.message}`
    return error instanceof Error ? error.message : String(error)
  }
}

/** A deterministic conflict id, so the same pair never produces two edges. */
function deterministicConflictId(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a]
  const digest = contentHashOf({ title: first, summary: second, body: '' }).slice(0, 32)
  return `life:conflict:${digest}`
}
