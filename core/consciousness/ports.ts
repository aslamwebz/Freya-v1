/**
 * THE INPUT PORTS — the narrow, Core-private contracts Phase 20 reads through.
 *
 * ## Why ports rather than domain types
 *
 * `PLAN.md` §6 requires this projection to consume authoritative projections from
 * **Phase 21 (Life)** and **Phase 22 (Self/World)**. Neither exists on this
 * baseline: there is no `core/life/`, no `core/self/` and no `core/world/`.
 *
 * The two tempting wrong answers are both bad:
 *
 * - **Import the domain type anyway.** There is nothing to import, so this means
 *   writing a plausible-looking `Phase21LifeProjection` here. That is an invented
 *   domain shape, and Phase 21 would then have to conform to a contract written
 *   before it existed — which is how incompatible models get frozen in.
 * - **Skip the domains until they land.** Then the projection compiles, looks
 *   finished, and silently omits a domain `PLAN.md` names as required. A snapshot
 *   that is quietly incomplete is the precise failure this phase exists to
 *   prevent.
 *
 * A port is the third answer. It is a *consumer-side* contract: the smallest set
 * of readings this projection is able to use, declared by the consumer, with no
 * claim about how the producer stores or models them. Phase 21 and Phase 22 write
 * an adapter that produces one; the derivation rules here do not move.
 *
 * ## What a port is not allowed to be
 *
 * A port is not a place to launder private content. Every port below carries the
 * same discipline as the projection itself: ids, closed codes, instants and
 * measurements. Not one of them has a `text`, `summary`, `body`, `detail` or
 * `reason`-about-the-owner field, and if a future port grows one, the leakage
 * sweep in `tests/red-team/consciousness-leakage.test.ts` is what should catch
 * it — which is only true because the ports feed the same serialised snapshot.
 *
 * ## The trust envelope every port shares
 *
 * `health`, `sequence`, `durable` and `reason` are how a port says how far it can
 * be trusted, and they are the *only* way. A port cannot be silently absent: it is
 * either present with a reading, or `null`, and `null` becomes a stated absence
 * with the producer named.
 */

/**
 * Which subsystem is answering a port.
 *
 * Recorded on every reading rather than inferred at the point of use, so the
 * snapshot can say *who* told it something instead of a consumer guessing from the
 * shape. `'brain'` is what answers `self`, `world` and `continuity` on this
 * baseline; `'self'`, `'world'` and `'life'` are what will answer them once Phase
 * 21 and Phase 22 land.
 */
export const CONSCIOUS_PORT_AUTHORITIES = Object.freeze([
  'brain',
  'self',
  'world',
  'life',
] as const)

export type ConsciousPortAuthority = (typeof CONSCIOUS_PORT_AUTHORITIES)[number]

/**
 * How far a single port's reading can be trusted.
 *
 * Deliberately not the four-valued `ConsciousFreshness`: a port is a narrower
 * thing than a source row. `'ready'` is a reading; `'unavailable'` is a stated
 * inability to read, and the projection decides whether that becomes `'absent'`
 * (not in this build) or `'unknown'` (present but unreadable) *in the context of
 * the section being built* — a distinction the port itself cannot make.
 */
export interface ConsciousPortTrust {
  readonly health: 'ready' | 'unavailable'
  /** Highest durable sequence folded into this reading, or `null`. */
  readonly sequence: number | null
  /** Whether a restart keeps what this port reports. */
  readonly durable: boolean | null
  /**
   * Why it could not be read, when it could not.
   *
   * Must be a statement about the *subsystem*, never about the owner's situation.
   * This string crosses to every renderer inside a section's `note`.
   */
  readonly reason: string | null
}

/* ------------------------------------------------------------------ self */

/**
 * The closed set of self-capability readings this projection will carry.
 *
 * A Phase-20-owned closed union rather than an import from Brain, because the
 * Brain's own projection widens `SelfCapabilityState` to a bare `string`. Narrowing
 * it here at the port is what stops a widened producer from widening the type a
 * renderer is typed against; an unrecognised value becomes `'unknown'`, which is
 * the member that means exactly "Core cannot say".
 */
export type ConsciousSelfCapabilityState = 'available' | 'unavailable' | 'disabled' | 'unknown'

const SELF_CAPABILITY_STATES: readonly string[] = [
  'available',
  'unavailable',
  'disabled',
  'unknown',
]

/** Narrow a producer's widened capability state, defaulting to `'unknown'`. */
export function narrowSelfCapabilityState(value: string): ConsciousSelfCapabilityState {
  return SELF_CAPABILITY_STATES.includes(value)
    ? (value as ConsciousSelfCapabilityState)
    : 'unknown'
}

/** One capability, as a code plus its fixed prohibitions. */
export interface ConsciousSelfCapabilityReading {
  readonly capability: string
  readonly state: ConsciousSelfCapabilityState
  /** Fixed strings from the seeded self-definition. Never the owner's wording. */
  readonly cannot: readonly string[]
}

/**
 * What Freya says she is.
 *
 * The three free-text fields (`name`, `role`, `purpose`) and the `cannot` /
 * `statement` strings are the only prose this projection carries, and they are
 * allowed here for the reason the protocol gives: they are Freya's own immutable
 * account of herself, authored by Core, not a record of anything the owner said.
 * That is a property of the *producer*, which is why the port asserts it in a
 * comment rather than in a type — a producer that starts accepting owner prose
 * here would break an invariant no type can express, and the leakage sweep is the
 * backstop.
 */
export interface ConsciousSelfReading extends ConsciousPortTrust {
  readonly authority: ConsciousPortAuthority
  readonly name: string | null
  readonly role: string | null
  readonly purpose: string | null
  /** How many root claims are held. A count, not the claims. */
  readonly claimCount: number
  readonly capabilities: readonly ConsciousSelfCapabilityReading[]
  readonly limitations: readonly { readonly limitationId: string; readonly statement: string }[]
  /** False when Core has not finished building its own account of itself. */
  readonly complete: boolean
}

/* ----------------------------------------------------------------- world */

/** One recorded contradiction, disclosed because it is real. */
export interface ConsciousWorldConflictReading {
  readonly memoryId: string
  readonly conflictsWith: readonly string[]
  readonly detail: string
}

/**
 * The world as Core holds it.
 *
 * Counts, not names. The producer projects entity *counts* and no names, and this
 * port does not widen that: a surface that needs a name goes and recalls it
 * deliberately, through the owning domain, on the owner's authority.
 */
export interface ConsciousWorldReading extends ConsciousPortTrust {
  readonly authority: ConsciousPortAuthority
  readonly entities: number | null
  readonly relations: number | null
  readonly observations: number | null
  readonly memories: number | null
  readonly admitted: number | null
  readonly conflicted: number | null
  readonly rejected: number | null
  readonly withdrawn: number | null
  readonly experiences: number | null
  readonly conflicts: readonly ConsciousWorldConflictReading[]
}

/* ------------------------------------------------------------ continuity */

/**
 * One recently admitted memory, as metadata.
 *
 * The four code fields carry the Brain's own closed unions rather than a
 * Phase-20-owned `string`. That is a deliberate choice against the "widen it to
 * `string` and narrow later" instinct, and the reason is that there is nothing to
 * narrow *to*: the crossing view in `protocol/consciousness.ts` already declares
 * these exact unions, and inventing a parallel copy here would create two
 * vocabularies for one fact with no `'unknown'` member in either to catch a
 * mismatch.
 *
 * The consequence is stated rather than hidden: if a producer other than the Brain
 * ever takes this port over and its codes differ, then the *view* type has to
 * change with it. That is a Phase 22 decision to make with Phase 22 in the room —
 * not something to guess at now by quietly widening a union.
 */

import type { Confidence, MemoryKind, MemoryStatus, SourceTrust } from '../brain/types'

export interface ConsciousContinuityItemReading {
  readonly memoryId: string
  readonly kind: MemoryKind
  readonly source: SourceTrust
  readonly confidence: Confidence
  readonly status: MemoryStatus
  /**
   * A measurement, exactly like `textLength` and `contentLength` elsewhere.
   *
   * The subject itself is not merely private, it is the field a person would most
   * want to read — which is exactly why a standing snapshot is the wrong place for
   * it. Recalling it stays a deliberate act through the owning domain.
   */
  readonly subjectLength: number
  readonly admittedAt: string
}

/** Recent continuity, bounded. Not a narrative and not autobiographical. */
export interface ConsciousContinuityReading extends ConsciousPortTrust {
  readonly authority: ConsciousPortAuthority
  readonly items: readonly ConsciousContinuityItemReading[]
  /** How many admissions exist in total, so `omitted` can be honest. */
  readonly admittedTotal: number | null
}

/* ------------------------------------------------------------------ life */

/**
 * One entry of Freya's life history, as metadata.
 *
 * No `text`, no `summary`, no `narrative` — and the absence is the design. A life
 * history is the most owner-shaped record Freya will ever hold, so this port can
 * only ever carry an id, a code, an instant and a length.
 *
 * `kind` is a plain `string` because Phase 21 owns that vocabulary and it does not
 * exist yet. Declaring a closed set for it here would be inventing a domain shape
 * Phase 21 would have to conform to; Phase 20 sorts by it and shows it without
 * interpreting it.
 */
export interface ConsciousLifeEntryReading {
  readonly entryId: string
  readonly kind: string
  readonly at: string
  readonly textLength: number
  readonly confidence: number | null
}

/**
 * What happened in Freya's life.
 *
 * **Nothing produces this on the current baseline.** There is no Phase 21 Life
 * projection to adapt, so `ConsciousInput.life` is `null` and the section reports
 * a stated absence naming Phase 21 — never zeros, never a plausible-looking
 * history.
 *
 * ### Integration point (Phase 21)
 *
 * Phase 21 satisfies this by adding `core/consciousness/adapters/life.ts` exporting
 * a `lifeFrom<Projection>(projection): ConsciousLifeReading | null`, and by passing
 * its result as `life` in `FreyaCore.consciousness()`. Nothing in `projection.ts`
 * changes, because it already reads only this port. The adapter is also where
 * Phase 21's own privacy boundary is enforced: if its standing projection carries
 * narrative text, the adapter must reduce it to `textLength` here rather than
 * pass it through, and the leakage sweep will prove it did.
 */
export interface ConsciousLifeReading extends ConsciousPortTrust {
  readonly authority: 'life'
  readonly entries: number | null
  readonly admitted: number | null
  readonly recalled: number | null
  readonly recent: readonly ConsciousLifeEntryReading[]
}

/* ------------------------------------------------------------- aggregate */

/**
 * The three or four readings this projection takes through ports.
 *
 * Grouped so `ConsciousInput` cannot grow a fifth port field by accident: adding a
 * domain to this projection is a decision about the closed set in
 * `CONSCIOUS_SOURCES`, not a convenience.
 */
export interface ConsciousPortReadings {
  readonly self: ConsciousSelfReading | null
  readonly world: ConsciousWorldReading | null
  readonly continuity: ConsciousContinuityReading | null
  readonly life: ConsciousLifeReading | null
}
