import { SENSITIVITY_RANK, type Sensitivity } from '../brain/types'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  ABSENT_WORLD_ENTITY_DETAIL,
  ABSENT_WORLD_ENTITY_LIST,
  ABSENT_WORLD_GRAPH,
  ABSENT_WORLD_SUMMARY,
  type WorldEntityDetailView,
  type WorldEntityListView,
  type WorldRelationGraphView,
  type WorldSummaryView,
  type WorldViewHeader,
} from '../protocol/world'
import { buildEvidenceRecord, rejectForbiddenWorldKeys, worldRefusal } from './evidence'
import { foldWorld, type WorldFoldResult } from './fold'
import type { WorldConflict } from './relations'
import { evidenceIdCounter } from './identity'
import { emptyWorldSelfSource, type WorldSelfSource } from './self'
import {
  emptyWorldState,
  orderedWorldRecords,
  type WorldReferenceRecord,
  type WorldState,
} from './state'
import {
  worldLimits,
  type WorldAdmissionChannel,
  type WorldEntityKind,
  type WorldEvidenceRecord,
  type WorldEvidenceRequest,
  type WorldLimits,
  type WorldRefusalCode,
} from './types'
import type { WorldGraphOptions } from './projection'
import {
  projectWorldEntityDetail,
  projectWorldEntityList,
  projectWorldGraph,
  projectWorldSelf,
  projectWorldSummary,
} from './projection'
import type { WorldPersistencePort } from './persistence/port'
import { WORLD_SNAPSHOT_VERSION, type WorldPersistenceHealth, type WorldSnapshot } from './persistence/port'
import { encodeWorldSnapshot } from './persistence/snapshot'
import { isWorldPersistenceError } from './persistence/errors'

/**
 * THE WORLD ENGINE.
 *
 * The one impure piece of this domain: it admits, persists, folds and projects. It
 * holds no gateway, no provider, no authority object and no `Principal`, so there is
 * nothing here that could spend a model call, mint a capability or clear STOP ALL —
 * asserted structurally by a red-team test that counts provider calls around a full
 * projection, not by this comment.
 *
 * ## What "no idle model calls" means here in practice
 *
 * Every method on this class is synchronous apart from `open`, `commit` and
 * `close`, and none of them awaits anything that could decide to spend money. A
 * projection is a fold over records that are already in memory. There is no timer,
 * no retry, no background refresh and no "improve the world while nobody is
 * looking", because an enrichment pass that runs on a schedule is exactly how a
 * system starts spending without being asked.
 *
 * ## The admission surface is narrow, and Core-internal
 *
 * `admit` takes an already-built request and a `WorldAdmissionContext` whose
 * `channel` and `actor` the *caller* chose — which means the channel has to come
 * from trusted code, and the only trusted callers are Core's own owner scope and its
 * own observation seams. There is no method here a renderer can reach, and the two
 * owner-facing commands in `core/index.ts` are Guard-evaluated before they get this
 * far.
 */

export interface WorldEngineOptions {
  readonly persistence: WorldPersistencePort
  readonly now?: () => Date
  /** Narrow read ports into the authoritative domains. */
  readonly references?: () => readonly WorldReferenceRecord[]
  /** The narrow read surface the self model needs. */
  readonly self?: WorldSelfSource
  /** Ceilings may be lowered here and never raised above `WORLD_LIMITS`. */
  readonly limits?: Partial<WorldLimits>
  /**
   * Whether STOP ALL is active.
   *
   * Reads are never gated on it — asking what Freya believes costs nothing and cannot
   * act on the answer — but **admission is**. Nothing new may come to be believed
   * while Freya cannot act on what she believes: a stopped Core that kept ingesting
   * claims would accumulate a world it is not allowed to speak, and would then be one
   * resume away from being confidently wrong about all of it.
   */
  readonly stopAll?: () => boolean
  readonly onChange?: () => void
}

export type WorldAdmissionOutcome =
  | { readonly ok: true; readonly evidenceId: string; readonly sequence: number }
  | { readonly ok: false; readonly code: WorldRefusalCode; readonly reason: string }

/** What the caller of `admit` must state, and what it therefore cannot choose. */
export interface WorldAdmissionRequest {
  readonly request: WorldEvidenceRequest
  readonly channel: WorldAdmissionChannel
  /** The principal that assembled this. Assigned by the pathway, never by content. */
  readonly actor: PrincipalId
  /** How private this is. Assigned by the pathway that knew where the bytes came from. */
  readonly sensitivity: Sensitivity
}

export interface WorldOpenOutcome {
  readonly ok: boolean
  readonly recovered: number
  /** Set when the durable history could not be believed. The world is then empty. */
  readonly degradedReason: string | null
}

export class WorldEngine {
  /** What durability this engine actually provides. Never a guess. */
  get mode(): 'encrypted' | 'ephemeral' {
    return this.persistence.mode
  }

  private readonly persistence: WorldPersistencePort
  private readonly nowFn: () => Date
  private readonly referencesFn: () => readonly WorldReferenceRecord[]
  private selfSource: WorldSelfSource
  private readonly limits: WorldLimits
  private readonly stopAll: () => boolean
  private readonly onChange: (() => void) | undefined

  private records: WorldEvidenceRecord[] = []
  private evidenceCounter = 0
  private closed = false
  /** Written once, after a change, and never read back synchronously. */
  private writeTail: Promise<unknown> = Promise.resolve()

  constructor(options: WorldEngineOptions) {
    this.persistence = options.persistence
    this.nowFn = options.now ?? ((): Date => new Date())
    this.referencesFn = options.references ?? ((): readonly WorldReferenceRecord[] => [])
    this.selfSource = options.self ?? emptyWorldSelfSource()
    this.limits = worldLimits(options.limits ?? {})
    this.stopAll = options.stopAll ?? ((): boolean => false)
    this.onChange = options.onChange
  }

  /**
   * Replace the self-model read surface.
   *
   * Core wires this after the Brain, Skills, Workforce and gateway exist, because
   * the self model reads all four and must not hold them at construction. It is the
   * only setter on this class, and it cannot widen anything — every compartment it
   * supplies is read-only data.
   */
  setSelfSource(source: WorldSelfSource): void {
    this.selfSource = source
  }

  /**
   * Recover the retained evidence.
   *
   * A snapshot that cannot be believed leaves the world **empty and saying so**,
   * rather than partially populated. A world rebuilt from half a history would be a
   * world whose shape depends on what was damaged, which is the same failure a
   * damaged store must not have.
   */
  async open(): Promise<WorldOpenOutcome> {
    const loaded = await this.persistence.load()
    if (!loaded.ok) {
      this.records = []
      this.evidenceCounter = 0
      return { ok: false, recovered: 0, degradedReason: loaded.reason }
    }
    let validated
    try {
      validated = encodeWorldSnapshot(loaded.snapshot, this.limits)
    } catch (error) {
      this.records = []
      this.evidenceCounter = 0
      return {
        ok: false,
        recovered: 0,
        degradedReason: error instanceof Error ? error.message : 'the world snapshot could not be read',
      }
    }
    this.records = [...validated.records]
    // Re-seeded from the durable state, exactly as `ContextStore` re-seeds its own, so
    // a restart cannot mint an id that already exists. Two sources, and both matter:
    // the highest id among the retained rows covers the ordinary case, and the
    // persisted high-water mark covers the case the retention bound created — where
    // eviction has dropped the oldest rows and reading only the survivors would hand
    // back an id that was already issued and then retired.
    this.evidenceCounter = Math.max(
      validated.sequence,
      this.records.reduce(
        (highest, record) => Math.max(highest, evidenceIdCounter(record.evidenceId)),
        0,
      ),
    )
    return { ok: true, recovered: this.records.length, degradedReason: null }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.writeTail
    await this.persistence.close()
  }

  /* ---------------------------------------------------------- admission */

  /**
   * Admit one claim, or refuse in words.
   *
   * The order is fixed: forbidden claim fields first, then the channel's profile,
   * then every bound in the domain's own table. A payload carrying `authority` or
   * `confidence` in it is refused whole rather than stripped, because an attempt
   * that arrives quietly ignored is an attempt nobody can see.
   */
  admit(admission: WorldAdmissionRequest): WorldAdmissionOutcome {
    if (this.closed) return worldRefusal('store_closed')
    if (this.persistence.faultReason !== null) return worldRefusal('store_degraded')
    // STOP ALL outranks world-model enrichment, exactly as it outranks everything else.
    if (this.stopAll()) return worldRefusal('stop_all_active')

    const forbidden = rejectForbiddenWorldKeys(admission.request as unknown)
    if (forbidden !== null) return { ok: false, code: forbidden.code, reason: forbidden.reason }

    const now = this.nowFn()
    if (this.records.length >= this.limits.maxEvidenceRecords) {
      // Evict rather than refuse: the world is bounded, and a claim that cannot be
      // held is one a person was told was held. Eviction is reported in the summary's
      // counts, so it is visible rather than silent.
      this.evictOldest()
    }

    this.evidenceCounter += 1
    const evidenceId = `wev-${String(this.evidenceCounter).padStart(6, '0')}`
    const built = buildEvidenceRecord(
      admission.request,
      {
        channel: admission.channel,
        actor: admission.actor,
        sensitivity: admission.sensitivity,
        now,
        limits: this.limits,
        known: new Set(this.records.map((record) => record.evidenceId)),
      },
      evidenceId,
      this.evidenceCounter,
    )

    if (!built.ok) {
      // The id was consumed by a refused admission, which leaves a gap in the
      // sequence. Gaps are harmless — ordering is by sequence and identity is by id —
      // and reusing an id would not be.
      this.evidenceCounter -= 1
      return { ok: false, code: built.code, reason: built.reason }
    }

    this.records = [...this.records, built.record]
    this.persist()
    return { ok: true, evidenceId: built.record.evidenceId, sequence: built.record.sequence }
  }

  /** Withdraw a claim. The owner's and Core's own path; see `admit`. */
  withdraw(targetEvidenceId: string, reason: string, admission: Omit<WorldAdmissionRequest, 'request'>): WorldAdmissionOutcome {
    return this.admit({ ...admission, request: { kind: 'withdrawal', targetEvidenceId, reason } })
  }

  /** Drop the oldest records until there is room, oldest evidence first. */
  private evictOldest(): void {
    const ordered = orderedWorldRecords(this.records)
    const overflow = this.records.length - this.limits.maxEvidenceRecords + 1
    const dropped = new Set(ordered.slice(0, Math.max(0, overflow)).map((record) => record.evidenceId))
    if (dropped.size === 0) return
    this.records = this.records.filter((record) => !dropped.has(record.evidenceId))
  }

  private persist(): void {
    const snapshot: WorldSnapshot = {
      v: WORLD_SNAPSHOT_VERSION,
      records: orderedWorldRecords(this.records),
      sequence: this.evidenceCounter,
    }
    const task = async (): Promise<void> => {
      try {
        await this.persistence.commit(snapshot)
      } catch (error) {
        // A storage fault is a state, not a crash. The engine keeps folding what it
        // holds in memory and reports the fault through the projection's persistence
        // block, because a world model that throws on a full disk is a world model
        // that takes conversation down with it.
        if (!isWorldPersistenceError(error)) throw error
      }
    }
    const result = this.writeTail.then(task, task)
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    )
    void result
    this.onChange?.()
  }

  /** Await the pending commit. Used by tests and by shutdown; never by a read. */
  async settled(): Promise<void> {
    await this.writeTail
  }

  /* ---------------------------------------------------------- projection */

  /** The folded world, recomputed from the retained records every time. */
  private fold(): { fold: WorldFoldResult; now: Date; sequence: number } {
    const now = this.nowFn()
    const fold = foldWorld(this.records, this.referencesFn(), now, this.limits)
    return { fold, now, sequence: fold.state.sequence }
  }

  private headerPersistence(): WorldViewHeader['persistence'] {
    return {
      mode: this.persistence.mode,
      durable: this.persistence.durable,
      reason: this.persistence.durabilityReason,
      faultReason: this.persistence.faultReason,
    }
  }

  /**
   * Summary-lengths and presence flags, keyed by edge.
   *
   * Built from the retained records rather than stored on the edge, so a projection
   * cannot accidentally surface a summary: the value is a number and a boolean, and
   * the sentence itself never leaves the store.
   */
  private edgeSummaries(
    fold: WorldFoldResult,
  ): ReadonlyMap<string, { length: number; present: boolean }> {
    const summaries = new Map<string, { length: number; present: boolean }>()
    for (const record of fold.state.records) {
      if (record.kind === 'withdrawal') continue
      if (record.evidenceSummary === null) continue
      for (const edge of fold.state.edges.values()) {
        if (edge.evidenceId !== record.evidenceId) continue
        summaries.set(edge.edgeId, { length: record.evidenceSummary.length, present: true })
      }
    }
    return summaries
  }

  private unavailable<T>(absent: T): T {
    return { ...(absent as object), ...this.headerPersistence() } as T
  }

  summary(): WorldSummaryView {
    if (this.closed) return this.unavailable(ABSENT_WORLD_SUMMARY)
    const { fold, sequence } = this.fold()
    const self = projectWorldSelf(fold.state, this.selfSource, this.limits, sequence)
    const health = this.persistence.faultReason === null ? 'ready' : 'unavailable'
    return projectWorldSummary(
      fold.state,
      fold.conflicts,
      fold.withheldEvidenceIds.length,
      fold.danglingEdgeIds,
      { listed: self.uncertainties.listed, total: self.uncertainties.total, items: self.uncertainties.items },
      self.beliefs.total,
      this.headerPersistence(),
      this.limits,
      sequence,
      health,
      this.persistence.faultReason,
    )
  }

  entities(options: { kind?: unknown; includeWithdrawn?: boolean } = {}): WorldEntityListView {
    if (this.closed) return this.unavailable(ABSENT_WORLD_ENTITY_LIST)
    const { fold, sequence } = this.fold()
    const kind = isEntityKind(options.kind) ? options.kind : null
    return projectWorldEntityList(
      fold.state,
      { kind, includeWithdrawn: options.includeWithdrawn === true },
      this.headerPersistence(),
      this.limits,
      sequence,
    )
  }

  entity(
    entityId: unknown,
    conflictsFor: (fold: WorldFoldResult) => readonly WorldConflict[],
  ): WorldEntityDetailView {
    if (this.closed) return this.unavailable(ABSENT_WORLD_ENTITY_DETAIL)
    if (typeof entityId !== 'string' || entityId.length === 0 || entityId.length > 128) {
      return { ...ABSENT_WORLD_ENTITY_DETAIL, entity: null, entityId: '' }
    }
    const { fold, sequence } = this.fold()
    return projectWorldEntityDetail(
      fold.state,
      entityId,
      conflictsFor(fold),
      this.edgeSummaries(fold),
      this.headerPersistence(),
      this.limits,
      sequence,
    )
  }

  relations(options: WorldGraphOptions): WorldRelationGraphView {
    if (this.closed) return this.unavailable(ABSENT_WORLD_GRAPH)
    const { fold, sequence } = this.fold()
    return projectWorldGraph(
      fold.state,
      options,
      this.edgeSummaries(fold),
      this.headerPersistence(),
      this.limits,
      sequence,
    )
  }

  self(): WorldSelfSource extends never ? never : ReturnType<typeof projectWorldSelf> {
    const { fold, sequence } = this.fold()
    return projectWorldSelf(fold.state, this.selfSource, this.limits, sequence)
  }

  /** Durability, in words. The reason is never null when durability is false. */
  persistenceHealth(): WorldPersistenceHealth {
    return {
      mode: this.persistence.mode,
      durable: this.persistence.durable,
      reason: this.persistence.durabilityReason,
      faultReason: this.persistence.faultReason,
      retained: this.records.length,
    }
  }

  /** Retained evidence records, for a caller that needs the ids and nothing else. */
  evidenceIds(): readonly string[] {
    return this.records.map((record) => record.evidenceId).sort()
  }

  /** The folded state, for a Core that needs to reason over it internally. */
  state(): WorldState {
    return this.fold().fold.state
  }

  /** The number of evidence records this Core asserts a sensitivity for. */
  withheldCount(): number {
    return this.fold().fold.withheldEvidenceIds.length
  }

  /** Sensitivity of a record, used by Core to decide what may leave the process. */
  sensitivityOf(evidenceId: string): Sensitivity | null {
    const record = this.records.find((entry) => entry.evidenceId === evidenceId)
    if (record === undefined) return null
    return record.sensitivity
  }

  /** Whether this record is too sensitive to appear in any projection. */
  isWithheld(evidenceId: string): boolean {
    const record = this.records.find((entry) => entry.evidenceId === evidenceId)
    if (record === undefined) return false
    return SENSITIVITY_RANK[record.sensitivity] >= SENSITIVITY_RANK['sensitive']
  }

  /** The limits in force, for a surface that wants to show them. */
  limitsView(): WorldLimits {
    return this.limits
  }

  /** An empty world, for a Core that has no world model at all. */
  static absent(reason: string): WorldEngine {
    const engine = new WorldEngine({
      persistence: {
        mode: 'ephemeral',
        durable: false,
        durabilityReason: reason,
        faultReason: null,
        load: async () => ({ ok: true, snapshot: { v: WORLD_SNAPSHOT_VERSION, records: [], sequence: 0 } }),
        commit: async (): Promise<void> => undefined,
        close: async (): Promise<void> => undefined,
      },
    })
    engine.closed = true
    return engine
  }
}

function isEntityKind(value: unknown): value is WorldEntityKind {
  return (
    value === 'person' ||
    value === 'project' ||
    value === 'organisation' ||
    value === 'place' ||
    value === 'mission' ||
    value === 'run' ||
    value === 'task' ||
    value === 'worker' ||
    value === 'team' ||
    value === 'skill' ||
    value === 'artifact' ||
    value === 'self'
  )
}

/** Re-exported so a caller constructing an absent world needs one import. */
export { emptyWorldState }