/**
 * THE RELATIONSHIP ENGINE — the trusted pathways, and nothing else.
 *
 * Every way a relationship record can come into existence is a named method on this
 * class, and **each one hard-codes its own source class**. That is the whole design:
 * a caller picks *what* to record by choosing a method, and cannot pick *whose* word it
 * is, because there is no method that takes a `SourceTrust` argument.
 *
 * ```
 *  recordOwnerStatement()      → source 'owner-assertion'      the person said it
 *  recordSystemObservation()   → source 'system-observation'   Core observed it
 *  recordModelObservation()    → source 'model-inference'      a model thinks so
 *  recordExternalObservation() → source 'external-untrusted'   a page or document said it
 * ```
 *
 * The last two are the interesting ones. They exist at all because a model noticing a
 * pattern and a document being *about* the owner are both real sources, and pretending
 * otherwise would just push the problem somewhere less visible. What they cannot do is
 * reach an owner-only kind, exceed `low` confidence, or record without evidence — all
 * three are refused inside `createRelationshipLedgerEntry`, and two of them are refused
 * again by the fact that the *method* is the only way in and it fixes the source.
 *
 * ## The owner's four acts
 *
 * `correct`, `withdraw`, `forget` and `export`, reachable only through `ownerScope()`,
 * which is issued by Core rather than acquired by naming a capability:
 *
 * - **correct** — a replacement record plus a `correction` record naming what was
 *   corrected, and the superseded original. Never an in-place edit: an edit would
 *   destroy the fact that a correction happened, which is the thing the owner asked for.
 * - **withdraw** — `retractRelationshipEntry`: the text is destroyed and the fact that
 *   it existed and was taken back survives a restart.
 * - **forget** — the row goes entirely. It refuses a live record and asks for a
 *   withdrawal first, so total destruction is always a separate, deliberate act and
 *   never a side effect of something else.
 * - **export** — the only read that carries text at breadth, bounded, owner-only.
 *
 * ## What this engine will not do
 *
 * It has no method that composes a sentence about the relationship, none that reads a
 * clock except through its injected `now` for lifecycle instants, none that reaches a
 * model, and none that raises a confidence above the source's ceiling. Retention is the
 * only thing here that removes records without the owner asking, and it is bounded,
 * labelled, and reported.
 */

import {
  admitRelationshipEntry,
  createRelationshipLedgerEntry,
  expireRelationshipEntry,
  rejectRelationshipEntry,
  retractRelationshipEntry,
  supersedeRelationshipEntry,
} from './ledger'
import { deriveRelationship } from './familiarity'
import {
  projectEntry,
  projectRelationship,
  projectRelationshipEntries,
  projectRelationshipEntryDetail,
} from './projection'
import { RelationshipStoreError, type RelationshipStore } from './store'
import {
  RELATIONSHIP_LIMITS,
  instantMs,
  isRelationshipLedgerKind,
  isRelationshipSlug,
  type ClaimCeilingReason,
  type ContactRhythm,
  type FamiliarityStage,
  type RelationalClaimRank,
  type RelationshipDerivation,
  type RelationshipLedgerEntry,
  type RelationshipLedgerKind,
  type RelationshipLedgerStatus,
  type RelationshipLifecycleReason,
} from './types'
import {
  RELATIONSHIP_SCHEMA_VERSION,
  type RelationshipEntryDetailView,
  type RelationshipEntriesOutcome,
  type RelationshipExportOutcome,
  type RelationshipExportView,
  type RelationshipPersistenceView,
  type RelationshipProjection,
  type RelationshipWriteOutcome,
} from '../protocol/relationship'

/**
 * What a caller may state about a record.
 *
 * Note what is not here: `source`, `status`, `confidence`, `admittedAt`, `lifecycleAt`.
 * A caller cannot assert where a record came from, that it was admitted, or how certain
 * it is — those come from the method it called and from `RELATIONSHIP_CEILING`.
 */
export interface RelationshipStatementInput {
  readonly kind: RelationshipLedgerKind
  readonly key: string
  readonly text: string
  readonly tags?: readonly string[]
  /** Ids only. Required for every non-owner pathway; the owner is their own evidence. */
  readonly evidenceRefs?: readonly string[]
  readonly observedAt: string
  /** Supplied only where a record must name the ids of the records it relates to. */
  readonly entryId?: string
}

export interface RelationshipEngineOptions {
  readonly store: RelationshipStore
  /** Injected so every instant is a test's choice rather than the host's wall clock. */
  readonly now?: () => Date
  readonly newId?: () => string
  /** Read fresh at each decision. Stops every write; reads stay available. */
  readonly stopped?: () => boolean
  readonly onChange?: () => void
}

export class RelationshipEngine {
  private readonly store: RelationshipStore
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly stopped: () => boolean
  private readonly onChange: () => void
  private idCounter = 0

  constructor(options: RelationshipEngineOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => `rel-${this.idCounter++}`)
    this.stopped = options.stopped ?? (() => false)
    this.onChange = options.onChange ?? (() => {})
  }

  /* --------------------------------------------------------- pathways */

  /**
   * The person said it. The strongest class this domain has, and still capped at `high`
   * with an `asserted` epistemic status — an assertion about a person's own preferences
   * is not a verified fact about them, and this domain never pretends otherwise.
   */
  recordOwnerStatement(input: RelationshipStatementInput): Promise<RelationshipWriteOutcome> {
    return this.writeVia(input, 'owner-assertion', 'the owner stated this')
  }

  /**
   * Core observed it directly — a session start, a recorded turn, a measured rhythm.
   *
   * `system-observation` may record any kind, including the owner-only ones, because a
   * turn in which the owner said something *is* an observation of the owner saying it.
   * What it may not do is record a boundary nobody stated.
   */
  recordSystemObservation(input: RelationshipStatementInput): Promise<RelationshipWriteOutcome> {
    return this.writeVia(input, 'system-observation', 'observed by a Core pathway')
  }

  /**
   * A model thinks so. Low confidence, capped, evidenced, and barred from every kind
   * that says something about the person rather than about a pattern of interaction.
   */
  recordModelObservation(input: RelationshipStatementInput): Promise<RelationshipWriteOutcome> {
    return this.writeVia(input, 'model-inference', 'inferred by a model')
  }

  /**
   * A page, a document or a connector said so. The weakest class, same bar as a model,
   * and — the point of having it at all — a *labelled* source rather than one laundered
   * into `owner-assertion` by a payload that got to choose.
   */
  recordExternalObservation(input: RelationshipStatementInput): Promise<RelationshipWriteOutcome> {
    return this.writeVia(input, 'external-untrusted', 'reported by untrusted external content')
  }

  /* ------------------------------------------------------------- owner */

  /**
   * Correct a record. A replacement, not an edit.
   *
   * Three writes, in this order, and the order matters: the replacement must exist before
   * the original is superseded, so a crash between them leaves *both* live — which the
   * derivation discloses as a conflict — rather than leaving nothing. Losing a record is
   * worse than showing two.
   */
  async correct(
    entryId: string,
    replacement: { text: string; reason: string; observedAt: string },
  ): Promise<RelationshipWriteOutcome> {
    if (this.stopped()) return refuse('stopped', 'the relationship engine is stopped')
    const original = this.store.state().entries.get(entryId)
    if (original === undefined) return refuse('no-such-entry', 'that relationship record does not exist')
    if (original.status !== 'admitted') {
      return refuse('not-admitted', `only a live record can be corrected, not ${original.status}`)
    }
    if (typeof replacement.reason !== 'string' || replacement.reason.length === 0) {
      return refuse('invalid-record', 'a correction must carry a stated reason')
    }
    if (replacement.reason.length > RELATIONSHIP_LIMITS.maxReasonChars) {
      return refuse('invalid-record', 'the correction reason exceeds the reason bound')
    }

    const newId = this.newId()
    // The replacement names the record it replaces as its evidence, so the chain
    // correction -> original survives a restart and is visible on the owner's read.
    const written = await this.writeVia(
      {
        entryId: newId,
        kind: original.kind,
        key: original.key,
        text: replacement.text,
        tags: original.tags,
        evidenceRefs: [entryId],
        observedAt: replacement.observedAt,
      },
      'owner-assertion',
      `corrected ${entryId}`,
    )
    if (!written.ok || written.entry === null) return written

    // The correction itself is a first-class record: "the owner corrected me, about this"
    // is exactly what the `correction` kind exists to hold.
    const correction = await this.writeVia(
      {
        kind: 'correction',
        key: original.key,
        text: replacement.reason,
        tags: ['correction'],
        evidenceRefs: [entryId, newId],
        observedAt: replacement.observedAt,
      },
      'owner-assertion',
      `correction of ${entryId}`,
    )
    if (!correction.ok) return correction

    const superseded = supersedeRelationshipEntry(original, { now: this.nowIso(), supersedes: newId })
    if (!superseded.ok) return refuse(superseded.code, superseded.reason)
    await this.persist(superseded.entry)
    this.onChange()
    return {
      ok: true,
      outcome: 'corrected',
      entry: written.entry,
      reason: written.reason,
      superseded: entryId,
      correction: correction.entry,
    }
  }

  /**
   * Withdraw a record. The owner takes it back; the text is destroyed and the fact that
   * it was withdrawn is kept.
   */
  async withdraw(entryId: string): Promise<RelationshipWriteOutcome> {
    if (this.stopped()) return refuse('stopped', 'the relationship engine is stopped')
    const entry = this.store.state().entries.get(entryId)
    if (entry === undefined) return refuse('no-such-entry', 'that relationship record does not exist')
    const result = retractRelationshipEntry(entry, { now: this.nowIso() })
    if (!result.ok) return refuse(result.code, result.reason)
    await this.persist(result.entry)
    this.onChange()
    return {
      ok: true,
      outcome: 'withdrawn',
      entry: projectEntry(result.entry),
      reason: 'the record was withdrawn by the owner and its text destroyed',
      superseded: null,
      correction: null,
    }
  }

  /**
   * Forget a record entirely: the row, the metadata, the withdrawal note.
   *
   * Refuses a live record. "Take this back" and "erase any trace that this ever existed"
   * are different requests, and collapsing them means a routine withdrawal silently
   * destroys the owner's own ability to see what Freya once held. To forget, withdraw
   * first — two deliberate acts, in that order.
   */
  async forget(entryId: string): Promise<RelationshipWriteOutcome> {
    if (this.stopped()) return refuse('stopped', 'the relationship engine is stopped')
    const entry = this.store.state().entries.get(entryId)
    if (entry === undefined) return refuse('no-such-entry', 'that relationship record does not exist')
    if (entry.status === 'admitted' || entry.status === 'candidate') {
      return refuse(
        'not-admitted',
        'withdraw the record before forgetting it; withdrawal keeps the fact that it was taken back',
      )
    }
    try {
      await this.store.forget(entryId)
    } catch (error) {
      return refuse('store-unavailable', describe(error))
    }
    this.onChange()
    return {
      ok: true,
      outcome: 'forgotten',
      entry: null,
      reason: 'the record and its metadata were removed from the relationship ledger',
      superseded: null,
      correction: null,
    }
  }

  /**
   * Reject a candidate outright. The record is never admitted, its text is kept so the
   * owner can see what was declined, and it never reaches a derivation.
   */
  async reject(entryId: string, reason: string): Promise<RelationshipWriteOutcome> {
    if (this.stopped()) return refuse('stopped', 'the relationship engine is stopped')
    const entry = this.store.state().entries.get(entryId)
    if (entry === undefined) return refuse('no-such-entry', 'that relationship record does not exist')
    if (reason.length === 0 || reason.length > RELATIONSHIP_LIMITS.maxReasonChars) {
      return refuse('invalid-record', 'a rejection must carry a bounded non-empty reason')
    }
    const result = rejectRelationshipEntry(entry, { now: this.nowIso(), reason })
    if (!result.ok) return refuse(result.code, result.reason)
    await this.persist(result.entry)
    this.onChange()
    return {
      ok: true,
      outcome: 'rejected',
      entry: projectEntry(result.entry),
      reason,
      superseded: null,
      correction: null,
    }
  }

  /* -------------------------------------------------------------- reads */

  /** The broad projection. Carries no entry text, by construction. */
  project(observedAt: string): RelationshipProjection {
    return projectRelationship({
      state: this.store.state(),
      persistence: this.persistence(),
      observedAt,
    })
  }

  /** The derivation itself, for a Core that wants the numbers rather than the view. */
  derive(observedAt: string): RelationshipDerivation {
    return deriveRelationship(this.store.state(), observedAt)
  }

  /** A broad read of the ledger: metadata only. */
  listEntries(options: { limit?: number; statuses?: readonly string[] } = {}): RelationshipEntriesOutcome {
    return projectRelationshipEntries(this.store.state(), options)
  }

  /** One record's own words. Owner-only by construction: the engine is Core's own. */
  readEntry(entryId: string): ReturnType<typeof projectRelationshipEntryDetail> {
    return projectRelationshipEntryDetail(this.store.state(), entryId)
  }

  /**
   * The owner's export.
   *
   * The one read that carries text at breadth, which is why it is here rather than on a
   * general read surface: it is bounded by `maxOwnerExportEntries`, it is reachable only
   * through the engine, and it reports `withheld` when there are more records than the
   * bound allows so a partial export cannot be mistaken for a complete one.
   */
  export(): RelationshipExportOutcome {
    const state = this.store.state()
    const all = [...state.entries.values()].sort((a, b) =>
      a.provenance.observedAt === b.provenance.observedAt
        ? a.entryId.localeCompare(b.entryId)
        : a.provenance.observedAt.localeCompare(b.provenance.observedAt),
    )
    const shown = all.slice(0, RELATIONSHIP_LIMITS.maxOwnerExportEntries)
    const view: RelationshipExportView = {
      schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
      items: shown.map(toExportItem),
      total: all.length,
      withheld: all.length - shown.length,
      persistence: this.persistence(),
    }
    return { ok: true, export: Object.freeze(view), reason: null }
  }

  /** Core's own retention bound. Bounded, deterministic, and always labelled. */
  async applyRetentionBound(): Promise<readonly string[]> {
    if (this.stopped()) return []
    const state = this.store.state()
    const live = [...state.entries.values()].filter((entry) => entry.status === 'admitted')
    if (live.length <= RELATIONSHIP_LIMITS.maxLiveEntries) return []
    // Oldest observed first, then id, so the choice is a function of the record set and
    // not of insertion order.
    const ordered = live.sort((a, b) => {
      const byObserved = a.provenance.observedAt.localeCompare(b.provenance.observedAt)
      return byObserved !== 0 ? byObserved : a.entryId.localeCompare(b.entryId)
    })
    const surplus = ordered.slice(0, live.length - RELATIONSHIP_LIMITS.maxLiveEntries)
    const retired: string[] = []
    for (const entry of surplus) {
      const result = expireRelationshipEntry(entry, { now: this.nowIso(), reason: 'retention-bound-reached' })
      if (!result.ok) continue
      await this.persist(result.entry)
      retired.push(entry.entryId)
    }
    if (retired.length > 0) this.onChange()
    return retired
  }

  /** Whether this engine is currently refusing writes, and the store's own health. */
  persistence(): RelationshipPersistenceView {
    const health = this.store.health()
    return Object.freeze({
      mode: this.store.mode,
      durable: this.store.mode === 'encrypted',
      degraded: health.health === 'degraded',
      reason: health.reason ?? this.store.faultReason,
    })
  }

  /* ----------------------------------------------------------- internals */

  private async writeVia(
    input: RelationshipStatementInput,
    source: Parameters<typeof createRelationshipLedgerEntry>[1],
    admissionReason: string,
    entryId: string = input.entryId ?? this.newId(),
  ): Promise<RelationshipWriteOutcome> {
    if (this.stopped()) return refuse('stopped', 'the relationship engine is stopped')
    if (!isRelationshipLedgerKind(input.kind)) {
      return refuse('invalid-kind', 'kind is not in the closed relationship ledger vocabulary')
    }
    if (!isRelationshipSlug(input.key)) {
      return refuse('invalid-key', 'key must be a bounded code-owned slug')
    }
    if (instantMs(input.observedAt) === null) {
      return refuse('invalid-instant', 'observedAt must parse as an instant')
    }

    const created = createRelationshipLedgerEntry(
      {
        entryId,
        kind: input.kind,
        key: input.key,
        text: input.text,
        tags: input.tags ?? [],
        evidenceRefs: input.evidenceRefs ?? [],
        observedAt: input.observedAt,
        recordedAt: this.nowIso(),
        proposedConfidence: defaultConfidenceFor(source),
        actor: defaultActorFor(source),
      },
      source,
    )
    if (!created.ok) return refuse(created.code, created.reason)

    const admitted = admitRelationshipEntry(created.entry, { now: this.nowIso(), reason: admissionReason })
    if (!admitted.ok) return refuse(admitted.code, admitted.reason)

    await this.persist(admitted.entry)
    // The bound runs *after* the write, so the stored live set is never left one record
    // over the limit. A record whose `observedAt` is older than everything else may be
    // retired the moment it lands, and that is the honest outcome: retention follows when
    // something was observed, not when Core happened to be told about it.
    await this.applyRetentionBound()
    this.onChange()
    return {
      ok: true,
      outcome: 'recorded',
      entry: projectEntry(admitted.entry),
      reason: admissionReason,
      superseded: null,
      correction: null,
    }
  }

  private async persist(entry: RelationshipLedgerEntry): Promise<void> {
    try {
      await this.store.write(entry)
    } catch (error) {
      if (error instanceof RelationshipStoreError) throw error
      throw new RelationshipStoreError('write-failed', describe(error))
    }
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

/** The strongest confidence a pathway may propose, before its own ceiling is applied. */
function defaultConfidenceFor(source: string): 'low' | 'medium' | 'high' {
  if (source === 'owner-assertion' || source === 'system-observation') return 'high'
  return 'low'
}

function defaultActorFor(source: string): string {
  switch (source) {
    case 'owner-assertion':
      return 'owner'
    case 'system-observation':
      return 'core'
    case 'model-inference':
      return 'model'
    default:
      return 'external'
  }
}

function toExportItem(entry: RelationshipLedgerEntry) {
  return Object.freeze({
    entryId: entry.entryId,
    kind: entry.kind,
    key: entry.key,
    text: entry.text,
    status: entry.status,
    sourceType: entry.provenance.sourceType,
    confidence: entry.confidence,
    verificationStatus: entry.provenance.verificationStatus,
    observedAt: entry.provenance.observedAt,
    recordedAt: entry.provenance.recordedAt,
    admittedAt: entry.admittedAt,
    lifecycleAt: entry.lifecycleAt,
    lifecycleReason: entry.lifecycleReason,
    tags: Object.freeze([...entry.tags]),
    evidenceRefs: Object.freeze([...entry.evidenceRefs]),
  })
}

function refuse(code: string, reason: string): RelationshipWriteOutcome {
  return {
    ok: false,
    outcome: 'refused',
    entry: null,
    reason,
    code,
    superseded: null,
    correction: null,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/**
 * Re-exported so a caller holding an engine needs one import for the phase's vocabulary.
 * Pure re-exports, so this costs nothing at runtime.
 */
export type {
  ClaimCeilingReason,
  ContactRhythm,
  FamiliarityStage,
  RelationalClaimRank,
  RelationshipEntryDetailView,
  RelationshipLedgerStatus,
  RelationshipLifecycleReason,
}