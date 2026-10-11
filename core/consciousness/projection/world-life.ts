import type { ConsciousContinuityItemView, ConsciousContinuityView, ConsciousLifeEntryView, ConsciousLifeView, ConsciousWorldView } from '../../protocol/consciousness'
import type { ConsciousContinuityReading, ConsciousLifeReading, ConsciousWorldReading } from '../ports'
import { CONSCIOUS_CONTEXT_LIMITS, newestFirstByInstant } from '../types'
import { absentMeta, degradedMeta } from './metadata'

export const LIFE_ABSENT = 'Phase 21 Life is not present in this Core, so what happened in her life is not known here'

/* ----------------------------------------------------------------- world */

/**
 * The world as Core holds it: counts, not names.
 *
 * Read through the `world` port. The Brain is today's authority behind it, and
 * Phase 22's World projection becomes the authority when it lands — in both cases
 * the producer publishes counts and no names, and this section does not widen that.
 */
export function buildWorld(world: ConsciousWorldReading | null): ConsciousWorldView {
  if (world === null) {
    return {
      ...absentMeta(null),
      entities: null,
      relations: null,
      observations: null,
      memories: null,
      admitted: null,
      conflicted: null,
      rejected: null,
      withdrawn: null,
      experiences: null,
      conflicts: [],
      durable: null,
    }
  }
  if (world.health !== 'ready') {
    return {
      ...degradedMeta(world.reason ?? 'the world model could not be read'),
      entities: null,
      relations: null,
      observations: null,
      memories: null,
      admitted: null,
      conflicted: null,
      rejected: null,
      withdrawn: null,
      experiences: null,
      conflicts: [],
      durable: world.durable,
    }
  }
  return {
    state: 'available',
    note: null,
    entities: world.entities,
    relations: world.relations,
    observations: world.observations,
    memories: world.memories,
    admitted: world.admitted,
    conflicted: world.conflicted,
    rejected: world.rejected,
    withdrawn: world.withdrawn,
    experiences: world.experiences,
    conflicts: world.conflicts
      .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxConflictItems)
      .map((conflict) => ({
        memoryId: conflict.memoryId,
        conflictsWith: [...conflict.conflictsWith],
        detail: conflict.detail,
      })),
    durable: world.durable,
  }
}

/* ------------------------------------------------------------------ life */

/**
 * What happened in Freya's life.
 *
 * ## Why this section exists while being empty
 *
 * `PLAN.md` §6 makes Phase 21 Life a required contributor to this projection, and
 * Phase 21 has not landed. The section is here in the shape Phase 21 will fill, and
 * it says `absent` with a note naming Phase 21.
 *
 * The alternative — leaving the section out until the producer exists — was
 * rejected because it produces a snapshot that is *silently* incomplete. A missing
 * section reads as a domain with nothing in it; a stated absence reads as a domain
 * that was never built, and only one of those is true.
 *
 * Nothing here is defaulted. There is no `entries: 0` fallback dressed as a
 * reading: a fabricated life history is the single worst thing this projection
 * could emit, because it would be indistinguishable from a real one to every
 * consumer downstream.
 *
 * ### Integration point (Phase 21)
 *
 * Phase 21 writes `core/consciousness/adapters/life.ts` and passes its reading as
 * `life`. This function, the `life` provenance row above and the protocol shape
 * are already correct for that, so the integration is additive — and the moment it
 * lands, `life` stops being the reason this build reports `health: 'degraded'`.
 */
export function buildLife(life: ConsciousLifeReading | null): ConsciousLifeView {
  if (life === null) {
    return {
      ...absentMeta(LIFE_ABSENT),
      entries: null,
      admitted: null,
      recalled: null,
      durable: null,
      recent: [],
      listed: 0,
      omitted: 0,
    }
  }
  if (life.health !== 'ready') {
    return {
      ...degradedMeta(life.reason ?? 'the life history could not be read'),
      entries: null,
      admitted: null,
      recalled: null,
      durable: life.durable,
      recent: [],
      listed: 0,
      omitted: 0,
    }
  }

  // Newest first, with an unknown instant last, capped *after* ordering so what
  // survives is the most recent rather than whichever slice happened to land in the
  // window. The comparator lives in `types.ts` rather than inline here, because
  // "newest first" is a rule that has to be auditable in one place and it is
  // exactly the rule that is easy to get subtly wrong - see the note there on why
  // neither negating `byInstant` nor sorting-then-reversing is correct.
  const listed = [...life.recent]
    .sort((a, b) => newestFirstByInstant({ at: a.at, id: a.entryId }, { at: b.at, id: b.entryId }))
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxLifeEntries)

  return {
    state: 'available',
    note: null,
    entries: life.entries,
    admitted: life.admitted,
    recalled: life.recalled,
    durable: life.durable,
    recent: listed.map((entry): ConsciousLifeEntryView => ({
      entryId: entry.entryId,
      kind: entry.kind,
      at: entry.at,
      textLength: entry.textLength,
      confidence: entry.confidence,
    })),
    listed: listed.length,
    omitted: Math.max(0, life.recent.length - listed.length),
  }
}

/* ------------------------------------------------------------ continuity */

/**
 * Recently admitted memories.
 *
 * `subjectLength` in place of `subject`, computed by the adapter that reads the
 * producer and not here. `subject` is not merely private — it is the field a
 * person would most want to read, which is exactly why a snapshot is the wrong
 * place for it. Recalling it is a deliberate act through the owning domain, on the
 * owner's authority, and that asymmetry is preserved.
 */
export function buildContinuity(continuity: ConsciousContinuityReading | null): ConsciousContinuityView {
  if (continuity === null) {
    return {
      ...absentMeta(null),
      items: [],
      listed: 0,
      omitted: 0,
      durable: null,
    }
  }
  if (continuity.health !== 'ready') {
    return {
      ...degradedMeta(continuity.reason ?? 'the continuity record could not be read'),
      items: [],
      listed: 0,
      omitted: 0,
      durable: continuity.durable,
    }
  }

  const items: ConsciousContinuityItemView[] = continuity.items
    .slice(0, CONSCIOUS_CONTEXT_LIMITS.maxContinuityItems)
    .map((entry) => ({
      memoryId: entry.memoryId,
      kind: entry.kind,
      source: entry.source,
      confidence: entry.confidence,
      status: entry.status,
      subjectLength: entry.subjectLength,
      admittedAt: entry.admittedAt,
    }))

  return {
    state: 'available',
    note: null,
    items,
    listed: items.length,
    omitted: Math.max(0, (continuity.admittedTotal ?? items.length) - items.length),
    durable: continuity.durable,
  }
}
