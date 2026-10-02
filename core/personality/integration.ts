/**
 * THE PERSONALITY INTEGRATION — Core's own half of the Personality & Relationship
 * domain, and the only thing in the system allowed to change relationship state.
 *
 * Slice A built the vocabulary, the transitions and the pure pipeline. Slice B
 * built the encrypted store. What was missing was the piece that actually holds
 * the records, applies the lifecycle in production, and answers the read-only
 * surface — and without it every guarantee in this phase was a guarantee about a
 * shelf.
 *
 * ## What this owns
 *
 * - **Relationship records** across their whole life: candidate → admitted →
 *  superseded / rejected / retired, with a provenance assigned by the calling
 *  pathway and bounded retention enforced by Core rather than hoped for.
 * - **The cue ledger**, which is the anti-repetition memory. It is handed to the
 *   Mind as the narrow `ExpressionMemory` seam and is fail-closed: when
 *   persistence cannot be trusted, `readLedger()` answers `null` and the Mind
 *   emits no expression block at all.
 * - **Interaction facts**, observed by trusted code and never by a model.
 * - **The projection**, published whenever any of the above moves.
 *
 * ## What this cannot do
 *
 * It holds no authority, grants nothing and mints no capability. It has no
 * provider, no network, and no clock of its own — `now` is injected, like every
 * other Core subsystem. And it has no method a renderer can reach: the bridge
 * carries no `personality.*` name, so the only way anything enters the
 * relationship is the owner's own message, read by the closed directive table in
 * `./directives`.
 *
 * ## Fail-closed, not fail-open
 *
 * Every write is conditional on persistence being usable. A damaged store, a
 * machine with no secure key, a snapshot that could not be believed — all of them
 * leave the relationship empty and explicitly degraded rather than quietly
 * accumulating in a store whose contents will not survive. Anti-repetition
 * depends on remembering what was offered, so a memory that cannot be trusted is
 * not a memory that may be treated as empty; it is a memory that must not be
 * used.
 */

import {
  PERSONALITY_LIMITS,
  instantMs,
  isSlug,
  type CueKind,
  type CueUsageLedger,
  type FreyaTemperament,
  type InteractionFact,
  type InteractionFactKind,
  type RelationshipItem,
  type RelationshipLifecycleReason,
} from './types'
import {
  admitRelationshipItem,
  createRelationshipCandidate,
  rejectRelationshipItem,
  retireRelationshipItem,
  supersedeRelationshipItem,
  type RelationshipResult,
} from './relationship'
import { SOCIAL_WINDOWS, interpretSocialContext, validateInteractionFact } from './interpretation'
import { buildExpressionPlan } from './expression'
import { emptyCueLedger, recordCueUse, restoreCueLedger } from './repetition'
import { projectPersonality } from './projection'
import { readOwnerDirectives, STANDING_RELEVANCE_TAGS } from './directives'
import { FREYA_TEMPERAMENT } from './temperament'
import type { PersonalityPersistenceHealth } from './persistence/port'
import type { PersonalityProjection } from '../protocol/personality'
import type { ExpressionMemory } from '../mind/expression'

/**
 * The persistence seam, as the integration needs it.
 *
 * Two members and neither of them is a store handle: a snapshot in, a health
 * report out. The integration cannot reach a path, a key or a cipher, so the
 * only way it can persist something is to hand the whole retained set over and
 * let the port decide whether that is possible.
 */
export interface PersonalityPersistenceSeam {
  commit(items: readonly RelationshipItem[], ledger: CueUsageLedger): void
  health(): PersonalityPersistenceHealth
}

export interface PersonalityIntegrationOptions {
  /** The clock. Read at every transition, never cached. */
  readonly now: () => Date
  /** Core's id source. Used for record ids and fact ids, never for content. */
  readonly newId: () => string
  readonly persistence: PersonalityPersistenceSeam
  /** Recovered records, already decrypted and validated by the port. */
  readonly initialItems?: readonly RelationshipItem[]
  /** Recovered anti-repetition memory. Re-validated here, never trusted. */
  readonly initialLedger?: CueUsageLedger
  /** Frozen, core-owned. A test may supply a different table. */
  readonly temperament?: FreyaTemperament
  /** Bounded retention. Narrowed within `PERSONALITY_LIMITS`, never widened. */
  readonly maxItems?: number
  /** Called after any state change, so Core can republish. Never awaited. */
  readonly onChange?: () => void
  /** Called for each lifecycle transition, with metadata only. */
  readonly onLifecycle?: (event: PersonalityLifecycleEvent) => void
}

/**
 * A lifecycle transition, as anything outside this file may observe it.
 *
 * Metadata only, and structurally so: an id, closed kind labels, a code-owned
 * slug, the trust class Core assigned, and a closed lifecycle reason. There is no
 * field here that could carry the record's text, the owner's clause, or a
 * sentence — which is what lets Core journal this without having to think about
 * it twice, and what makes "no private relationship text in the journal" a
 * property of the *type* rather than of a reviewer's memory.
 */
export interface PersonalityLifecycleEvent {
  readonly operation: 'admitted' | 'rejected' | 'withdrawn' | 'retired' | 'superseded'
  readonly itemId: string
  readonly kind: RelationshipItem['kind']
  readonly key: string
  readonly sourceType: RelationshipItem['provenance']['sourceType']
  /**
   * The record's confidence, excluding `verified`.
   *
   * Narrowed here rather than widened at the journal, so "a relationship record
   * can never claim certainty" is carried by the type that crosses out of Core —
   * and the journal validator's narrower union cannot drift away from what the
   * domain can actually produce.
   */
  readonly confidence: Exclude<RelationshipItem['confidence'], 'verified'>
  readonly lifecycleReason: RelationshipLifecycleReason | null
  readonly admitted: number
  readonly retained: number
}

/** A bounded pass that dropped records, reported by id only. */
export interface PersonalityRetentionReport {
  readonly dropped: readonly string[]
  readonly retained: number
}

interface BoundedResult {
  readonly kept: readonly RelationshipItem[]
  readonly dropped: readonly RelationshipItem[]
}

/**
 * The retained store, and the only place relationship state is decided.
 *
 * Synchronous and entirely in-process. Nothing here awaits: the persistence seam
 * takes a snapshot and returns, which is what makes "the record is in Core before
 * the turn that produced it is answered" true by construction rather than by
 * hoping a queue drains.
 */
export class PersonalityIntegration implements ExpressionMemory {
  private items: readonly RelationshipItem[] = []
  private ledger: CueUsageLedger
  private facts: readonly InteractionFact[] = []
  private lastContactAtMs: number | null = null
  private pending: PersonalityLifecycleEvent[] = []
  private readonly maxItems: number
  private readonly temperament: FreyaTemperament
  private readonly persistence: PersonalityPersistenceSeam
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly onChange: () => void
  private readonly onLifecycle: ((event: PersonalityLifecycleEvent) => void) | null

  constructor(options: PersonalityIntegrationOptions) {
    this.now = options.now
    this.newId = options.newId
    this.persistence = options.persistence
    this.temperament = options.temperament ?? FREYA_TEMPERAMENT
    this.onChange = options.onChange ?? (() => {})
    this.onLifecycle = options.onLifecycle ?? null
    const requested = options.maxItems ?? PERSONALITY_LIMITS.maxRelationshipItems
    this.maxItems = Math.min(
      Math.max(
        1,
        Math.floor(Number.isFinite(requested) ? (requested as number) : PERSONALITY_LIMITS.maxRelationshipItems),
      ),
      PERSONALITY_LIMITS.maxRelationshipItems,
    )
    this.ledger = restoreCueLedger(options.initialLedger ?? emptyCueLedger())
    this.adopt(options.initialItems ?? [])
  }

  /* ------------------------------------------------------------- recovery */

  /**
   * Take the recovered snapshot, exactly as it was found.
   *
   * Records are re-validated rather than trusted. The port already decoded them,
   * but a record that could not have been produced by this domain — a `verified`
   * confidence, a status outside the closed set, a key that is not a code-owned
   * slug — is dropped rather than carried forward. A snapshot is data that
   * crossed a trust boundary once already; the moment it comes back it is
   * untrusted input again.
   *
   * Retired records are re-tombstoned here, not only at write time, so a store
   * written by a build that flagged rather than destroyed has its text destroyed
   * before any reader can see it.
   */
  private adopt(recovered: readonly RelationshipItem[]): void {
    const kept: RelationshipItem[] = []
    for (const item of recovered.slice(0, PERSONALITY_LIMITS.maxRelationshipItems)) {
      if (!adoptable(item)) continue
      kept.push(item.status === 'retired' ? { ...item, text: '' } : item)
    }
    const bounded = this.bound(kept)
    this.items = bounded.kept
    // A record the retention bound drops during recovery is still a record that
    // existed, and it is reported rather than silently shed — the same closed
    // reason, the same lifecycle event, whether the bound was reached at boot or
    // at the next admission.
    this.reportDrops(bounded.dropped)
    this.lastContactAtMs = newestInstant(kept)
    this.observe('session-start', this.now().toISOString(), null)
    this.persistence.commit(this.items, this.ledger)
  }

  /* ---------------------------------------------------------------- reads */

  /** Every retained record, oldest first. Metadata *and* content — Core only. */
  allItems(): readonly RelationshipItem[] {
    return this.items
  }

  /** The admitted records the interpreter and the Mind are allowed to read. */
  admittedItems(): readonly RelationshipItem[] {
    return this.items.filter((item) => item.status === 'admitted')
  }

  /** Facts observed by trusted code. Bounded, newest first. */
  interactionFacts(): readonly InteractionFact[] {
    return this.facts
  }

  health(): PersonalityPersistenceHealth {
    return { ...this.persistence.health(), retained: this.retained() }
  }

  /** Live records plus tombstones: what the store actually holds. */
  retained(): number {
    return this.items.length
  }

  /** How many records this build is willing to hold. */
  capacity(): number {
    return this.maxItems
  }

  /* ---------------------------------------------------------- observation */

  /**
   * Record that something of a kind happened.
   *
   * The only writer of interaction facts, called by Core with an instant Core
   * itself observed. There is no path here by which a string becomes a fact: the
   * kind is a closed label and the tags are code-owned slugs, so "a greeting was
   * received" is a statement about an event rather than a description of one.
   *
   * Deduplicated within the recent-contact window, because a person who says
   * hello twice in an afternoon is one contact, not two — and a fact list that
   * fills with repeats is a fact list that starts making claims Core cannot
   * support. Bounded to `maxInteractionFacts`, newest first.
   */
  observe(
    kind: InteractionFactKind,
    at: string,
    sourceRef: string | null,
    tags: readonly string[] = [],
  ): boolean {
    const observedMs = instantMs(at)
    if (observedMs === null) return false
    if (kind !== 'time-gap') this.lastContactAtMs = observedMs
    if (this.facts.some((fact) => withinWindow(fact, kind, observedMs))) return false
    const validated = validateInteractionFact({
      factId: `${kind}:${observedMs}`,
      kind,
      observedAt: at,
      sourceRef,
      tags: tags.filter((tag) => isSlug(tag)).slice(0, PERSONALITY_LIMITS.maxTagsPerFact),
    })
    if (!validated.ok) return false
    this.facts = Object.freeze([validated.fact, ...this.facts].slice(0, PERSONALITY_LIMITS.maxInteractionFacts))
    this.onChange()
    return true
  }

  /**
   * Whether the gap since the last recorded contact is long enough to be a gap.
   *
   * Computed from the store's own memory, once, at the moment Core asks. There is
   * no timer, no background task and no poll — which is why an idle Freya stays
   * provably idle and a restart costs zero provider calls.
   */
  contactIsStale(at: string): boolean {
    const nowMs = instantMs(at)
    if (nowMs === null) return false
    if (this.lastContactAtMs === null) return true
    return nowMs - this.lastContactAtMs > SOCIAL_WINDOWS.recentContactMs
  }

  /* -------------------------------------------------------------- writing */

  /**
   * Admit a record from a trusted pathway.
   *
   * The whole path in one call: validate the exact-key input, cap the confidence
   * to its source, admit it with a stated reason, supersede any older admitted
   * record carrying the same key, and enforce bounded retention. A caller cannot
   * skip a step and cannot reach a status other than `admitted` — the pure
   * transitions are the only writers and both are inside this method.
   *
   * `source` is the caller's, never the content's. Item text may claim anything
   * about its own provenance; the label stands.
   */
  admit(input: unknown, admission: { reason: string }): RelationshipResult {
    const candidate = createRelationshipCandidate(input)
    if (!candidate.ok) return candidate
    if (this.find(candidate.item.itemId) !== null) {
      return { ok: false, reason: 'a record with this id is already retained' }
    }
    const now = this.now().toISOString()
    const admitted = admitRelationshipItem(candidate.item, { now, reason: admission.reason })
    if (!admitted.ok) return admitted

    let items = [...this.items]
    for (const older of items) {
      if (older.status !== 'admitted' || older.key !== admitted.item.key) continue
      const superseded = supersedeRelationshipItem(older, { now, supersedes: admitted.item.itemId })
      if (superseded.ok) {
        items = items.map((entry) => (entry.itemId === older.itemId ? superseded.item : entry))
        this.emit({
          operation: 'superseded',
          item: superseded.item,
          lifecycleReason: superseded.item.lifecycleReason,
        })
      }
    }

    const bounded = this.bound([...items, admitted.item])
    this.items = bounded.kept
    this.emit({ operation: 'admitted', item: admitted.item, lifecycleReason: null })
    this.reportDrops(bounded.dropped)
    this.persist()
    return { ok: true, item: this.find(admitted.item.itemId) ?? admitted.item }
  }

  /**
   * Reject a candidate. Never deletes: the record stays, as a rejection with a
   * reason, because a system that quietly forgets what it declined to believe
   * will re-adjudicate it later without remembering having decided.
   */
  reject(itemId: string, decision: { reason: string }): RelationshipResult {
    const existing = this.find(itemId)
    if (existing === null) return { ok: false, reason: 'no such retained record' }
    const rejected = rejectRelationshipItem(existing, {
      now: this.now().toISOString(),
      reason: decision.reason,
    })
    if (!rejected.ok) return rejected
    this.items = this.items.map((item) => (item.itemId === itemId ? rejected.item : item))
    this.emit({ operation: 'rejected', item: rejected.item, lifecycleReason: rejected.item.lifecycleReason })
    this.persist()
    return rejected
  }

  /**
   * Take a record back: the owner reversing something Freya recorded.
   *
   * Destruction, not a flag. The text is destroyed at this instant and the
   * tombstone is what remains, so after a restart the domain can still answer
   * "this existed and was withdrawn" rather than "there is nothing here".
   */
  withdraw(itemId: string, reason: RelationshipLifecycleReason = 'owner-withdrew-this-record'): RelationshipResult {
    return this.endRecord(itemId, reason, 'withdrawn')
  }

  /**
   * Apply the retention bound now rather than at the next write.
   *
   * Exists because retention is a property of the store, not of the next thing
   * that happens to it: a Core that is asked to prove its own bound should be able
   * to, rather than only eventually arriving there.
   */
  retireOverflow(): PersonalityRetentionReport {
    const bounded = this.bound(this.items)
    this.items = bounded.kept
    this.reportDrops(bounded.dropped)
    if (bounded.dropped.length > 0) this.persist()
    return Object.freeze({
      dropped: Object.freeze(bounded.dropped.map((item) => item.itemId)),
      retained: this.retained(),
    })
  }

  private endRecord(
    itemId: string,
    reason: RelationshipLifecycleReason,
    operation: 'withdrawn' | 'retired',
  ): RelationshipResult {
    const existing = this.find(itemId)
    if (existing === null) return { ok: false, reason: 'no such retained record' }
    const ended = retireRelationshipItem(existing, { now: this.now().toISOString(), reason })
    if (!ended.ok) return ended
    this.items = this.items.map((item) => (item.itemId === itemId ? ended.item : item))
    this.emit({ operation, item: ended.item, lifecycleReason: ended.item.lifecycleReason })
    this.persist()
    return ended
  }

  /* ------------------------------------------------- the owner's own words */

  /**
   * Read the owner's message, and record or retract whatever it explicitly says.
   *
   * The production admission pathway, and the only one. It exists because a
   * relationship domain with no way to record anything is a domain whose
   * guarantees have never met a real record.
   *
   * Three properties hold whatever the message says:
   *
   *  - **Nothing is invented.** The closed directive table either recognises an
   *    explicit standing instruction or returns nothing. There is no inference,
   *    no model, and no partial credit.
   *  - **The owner can reverse it.** A withdrawal directive retires the addressed
   *    record with `owner-withdrew-this-record`, through the same table, in the
   *    same place.
   *  - **What is stored is bounded and minimal.** The matched clause rather than
   *    the message; provenance pointing at the turn; `source: 'owner-assertion'`.
   *    No cue kind, ever — a shared shorthand is not something one sentence of
   *    instruction establishes.
   */
  readOwnerMessage(text: unknown, context: { turnId: string | null }): readonly PersonalityLifecycleEvent[] {
    this.pending = []
    const outcomes = readOwnerDirectives(text)
    if (outcomes.length === 0) return Object.freeze([])
    const at = this.now().toISOString()

    for (const outcome of outcomes) {
      if (outcome.kind === 'withdrawal') {
        const target = outcome.key === null ? this.oldestAdmitted() : this.admittedForKey(outcome.key)
        if (target !== null) this.endRecord(target.itemId, 'owner-withdrew-this-record', 'withdrawn')
        continue
      }

      if (outcome.kind === 'standing') {
        this.admit(
          {
            itemId: `relationship:${this.newId()}`,
            kind: outcome.itemKind,
            key: outcome.key,
            text: outcome.clause,
            tags: outcome.tags,
            // Null on purpose: the cue lane is not the instruction lane. A register
            // preference is not a gesture that can be repeated too often.
            cueKind: null,
            // The owner's own words, in the owner's own conversation.
            source: 'owner-assertion',
            sourceRef: context.turnId,
            observedAt: at,
            recordedAt: at,
            proposedConfidence: outcome.explicitStanding ? 'high' : 'medium',
            actor: 'owner',
          },
          {
            reason: outcome.explicitStanding
              ? 'the owner gave an explicit standing instruction in conversation'
              : 'the owner asked for this in conversation; recorded as provisional',
          },
        )
        continue
      }

      // A named shorthand: the one directive that may produce a cue, and the one
      // whose slug came from the owner rather than from `./directives`.
      //
      // `key: null` means the phrase could not be a safe slug, and the record is
      // refused outright. There is no sanitised version: a nickname cleaned up into
      // something merely safe is a nickname Freya gets wrong in front of the person
      // who gave it to her, and refusing is the direction the naming validator
      // refuses in too.
      if (outcome.key === null) continue
      this.admit(
        {
          itemId: `relationship:${this.newId()}`,
          kind: outcome.itemKind,
          key: outcome.key,
          // The phrase as written, which is the data the owner reads back. The
          // guidance line names the slug; this never becomes guidance.
          text: outcome.phrase,
          tags: outcome.tags,
          cueKind: outcome.cueKind,
          source: 'owner-assertion',
          sourceRef: context.turnId,
          observedAt: at,
          recordedAt: at,
          proposedConfidence: 'high',
          actor: 'owner',
        },
        { reason: 'the owner named this shorthand in conversation' },
      )
    }

    const drained = Object.freeze(this.pending)
    this.pending = []
    return drained
  }

  /* ------------------------------------------------ expression memory seam */

  /**
   * The ledger, or `null` when it cannot be trusted.
   *
   * Fail-closed, and that is the whole contract. An empty ledger means "nothing
   * has been offered"; `null` means "I cannot tell what was offered", and only the
   * first of those may lead the Mind to offer a cue. Answering `null` whenever
   * persistence is degraded is what stops a broken store from silently resetting
   * anti-repetition and making Freya repeat herself for as long as the fault
   * lasts.
   */
  readLedger(): CueUsageLedger | null {
    if (!this.memoryIsUsable()) return null
    return this.ledger
  }

  /**
   * Record that a cue was actually offered.
   *
   * Never throws: a failed anti-repetition record must not lose a turn that
   * already has an answer. The persistence seam reports its own health on the next
   * read, so a write that did not land makes `readLedger()` answer `null` and the
   * expression lane go quiet rather than offering a cue the store does not know
   * was already used.
   */
  recordCueUse(cueId: string, kind: CueKind, at: string): void {
    if (!this.memoryIsUsable()) return
    if (typeof cueId !== 'string' || cueId.length === 0) return
    if (instantMs(at) === null) return
    this.ledger = recordCueUse(this.ledger, cueId, kind, at)
    this.persist()
  }

  /** Whether anti-repetition may be used at all. False means fail-closed. */
  private memoryIsUsable(): boolean {
    return this.persistence.health().durable
  }

  /* ---------------------------------------------------------- publication */

  /**
   * Build the projection a window may hold.
   *
   * Reads the clock, runs the interpreter and the planner, and reduces all of it
   * through `projectPersonality` — the one place that decides which fields may
   * cross. Called on every publish, so it has to be cheap; it is, because
   * interpretation and planning are bounded pure functions over records this
   * store already holds.
   */
  projection(): PersonalityProjection {
    const at = this.now().toISOString()
    const interpretation = interpretSocialContext({
      now: at,
      facts: this.facts,
      relationship: this.items,
      contextTokens: this.contextTokens(),
    })
    const expression = buildExpressionPlan({
      interpretation,
      at,
      ledger: this.ledger,
      temperament: this.temperament,
    })
    return projectPersonality({
      temperament: this.temperament,
      items: this.items,
      interpretation,
      expression,
      ledger: this.ledger,
      persistence: this.health(),
    })
  }

  /**
   * The tokens this build matches admitted preferences against.
   *
   * The standing-register vocabulary from `./directives`, and nothing derived from
   * the records or the turn. That is the point: relevance here is a code-owned
   * statement about what a *standing* instruction means, not a guess about which
   * preference applies to which sentence. A topic-scoped preference added later
   * carries a tag outside this list and therefore matches only when a lane
   * supplies that token.
   */
  private contextTokens(): readonly string[] {
    return STANDING_RELEVANCE_TAGS.slice(0, PERSONALITY_LIMITS.maxContextTokens)
  }

  /* ------------------------------------------------------------ retention */

  /**
   * Bounded retention, deterministically.
   *
   * Two rules, in this order, and both of them about what goes *first*:
   *
   *  1. **Tombstones before live records.** A retired record already has its text
   *     destroyed, so dropping one destroys nothing further and loses only an
   *     answer about the past. A live record is still what Freya believes about
   *     this person.
   *  2. **Candidates before admitted records**, then oldest first, with `itemId`
   *     as the tie-break so two runs over the same state drop the same record.
   *
   * A dropped record's text is never written anywhere on the way out, so the
   * honest account of the drop is the lifecycle event — an id and a closed reason
   * — rather than a tombstone that past the bound would itself be unbounded.
   */
  private bound(items: readonly RelationshipItem[]): BoundedResult {
    const overflow = items.length - this.maxItems
    if (overflow <= 0) return { kept: items, dropped: [] }
    const ordered = [...items].sort(evictionOrder)
    const dropped = new Set(ordered.slice(0, overflow).map((item) => item.itemId))
    return { kept: ordered.filter((item) => !dropped.has(item.itemId)), dropped: ordered.slice(0, overflow) }
  }

  private reportDrops(dropped: readonly RelationshipItem[]): void {
    for (const item of dropped) {
      this.emit({
        operation: 'retired',
        item: { ...item, status: 'retired', lifecycleReason: 'retention-bound-reached' },
        lifecycleReason: 'retention-bound-reached',
      })
    }
  }

  /* -------------------------------------------------------------- plumbing */

  private emit(event: {
    operation: PersonalityLifecycleEvent['operation']
    item: RelationshipItem
    lifecycleReason: RelationshipLifecycleReason | null
  }): void {
    // A `verified` confidence cannot occur — the source ceiling table has no row
    // that yields it — so the narrowing here is a checked claim rather than a cast,
    // and a record that somehow arrived claiming certainty is reported as unknown
    // instead of being written into a journal that would have to accept the word.
    const confidence = event.item.confidence === 'verified' ? 'unknown' : event.item.confidence
    const full: PersonalityLifecycleEvent = Object.freeze({
      operation: event.operation,
      itemId: event.item.itemId,
      kind: event.item.kind,
      key: event.item.key,
      sourceType: event.item.provenance.sourceType,
      confidence,
      lifecycleReason: event.lifecycleReason,
      admitted: this.items.filter((item) => item.status === 'admitted').length,
      retained: this.items.length,
    })
    this.pending.push(full)
    this.onLifecycle?.(full)
  }

  private persist(): void {
    this.persistence.commit(this.items, this.ledger)
    this.onChange()
  }

  private find(itemId: string): RelationshipItem | null {
    for (const item of this.items) if (item.itemId === itemId) return item
    return null
  }

  private admittedForKey(key: string): RelationshipItem | null {
    const matching = this.items.filter((item) => item.status === 'admitted' && item.key === key)
    return matching.length === 0 ? null : [...matching].sort(oldestFirst)[0] ?? null
  }

  private oldestAdmitted(): RelationshipItem | null {
    const matching = this.items.filter((item) => item.status === 'admitted')
    return matching.length === 0 ? null : [...matching].sort(oldestFirst)[0] ?? null
  }
}

/**
 * Oldest first, id as the tie-break.
 *
 * The determinism of withdrawal-without-a-named-key and of every read ordering
 * rests on this being the *only* comparator, so it is a function rather than an
 * inline sort three call sites might each write differently.
 */
function oldestFirst(a: RelationshipItem, b: RelationshipItem): number {
  const aTime = a.admittedAt ?? a.provenance.recordedAt
  const bTime = b.admittedAt ?? b.provenance.recordedAt
  if (aTime !== bTime) return aTime < bTime ? -1 : 1
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
}

/** Liveness rank for eviction: tombstones go first, then candidates, then admitted. */
function livenessRank(item: RelationshipItem): number {
  if (item.status === 'retired' || item.status === 'rejected') return 0
  if (item.status === 'superseded') return 1
  if (item.status === 'candidate') return 2
  return 3
}

function evictionOrder(a: RelationshipItem, b: RelationshipItem): number {
  const rank = livenessRank(a) - livenessRank(b)
  return rank !== 0 ? rank : oldestFirst(a, b)
}

/** Whether a fact of this kind was already recorded inside the contact window. */
function withinWindow(fact: InteractionFact, kind: InteractionFactKind, atMs: number): boolean {
  if (fact.kind !== kind) return false
  const then = instantMs(fact.observedAt)
  return then !== null && Math.abs(atMs - then) <= SOCIAL_WINDOWS.recentContactMs
}

/** The most recent instant any record carries, for the contact-gap comparison. */
function newestInstant(items: readonly RelationshipItem[]): number | null {
  let newest: number | null = null
  for (const item of items) {
    for (const candidate of [item.admittedAt, item.provenance.recordedAt, item.lifecycleAt]) {
      const ms = instantMs(candidate)
      if (ms !== null && (newest === null || ms > newest)) newest = ms
    }
  }
  return newest
}

/** The closed status vocabulary, for recovery-time validation. */
const RELATIONSHIP_STATUS_SET: ReadonlySet<string> = new Set([
  'candidate',
  'admitted',
  'rejected',
  'superseded',
  'retired',
])

/**
 * Whether a recovered record could have been produced by this domain at all.
 *
 * A record claiming `verified` confidence, carrying a status outside the closed
 * set, or holding a key that is not a code-owned slug did not come from this
 * domain's own writes — it came from somewhere trying to be believed. Dropped,
 * counted by the projection's `dropped`, and never repaired.
 */
function adoptable(item: RelationshipItem): boolean {
  if (typeof item?.itemId !== 'string' || item.itemId.length === 0) return false
  if (typeof item.key !== 'string' || !isSlug(item.key)) return false
  if (typeof item.text !== 'string') return false
  if (item.confidence === 'verified') return false
  if (!RELATIONSHIP_STATUS_SET.has(item.status)) return false
  if (item.admittedAt !== null && instantMs(item.admittedAt) === null) return false
  if (item.lifecycleAt !== null && instantMs(item.lifecycleAt) === null) return false
  if (item.lifecycleAt === null && item.status !== 'candidate' && item.status !== 'admitted') return false
  return true
}
