/**
 * THE WORLD ADAPTER — Phase 22's producer for the `world` port.
 *
 * Phase 22 (Self & World Model) landed, so `world` is no longer answered by the
 * Brain: the world domain's own summary is the authority, and this adapter is
 * the one place that knows how a `WorldSummaryView` becomes a
 * `ConsciousWorldReading`. The projection does not change — it reads the port.
 *
 * ## Counts are mapped by shared meaning, and the rest are `null`
 *
 * The port was written against the Brain's vocabulary, which had `observations`,
 * `memories`, `admitted`, `rejected` and `experiences` counts. The world domain
 * does not have those measurements — its vocabulary is entities, edges,
 * evidence records, withdrawals, supersessions, dangling edges, withheld
 * evidence, conflicts and beliefs. So:
 *
 * - `entities`, `relations` (the world's edges), `conflicted` and `withdrawn`
 *   map directly: same measurement, same meaning.
 * - `observations`, `memories`, `admitted`, `rejected` and `experiences` are
 *   `null`. Mapping the world's `evidenceRecords` onto `admitted` would invent
 *   a semantic equivalence the two domains do not share — an evidence record is
 *   not an admitted memory — and a `null` is the honest "this producer does
 *   not take this measurement".
 *
 * ## The conflict shape, translated rather than reshaped
 *
 * The port's conflict reading is `{ memoryId, conflictsWith, detail }`; the
 * world's conflict is `{ subjectEntityId, edgeIds, reason, ... }`. The world's
 * conflict *is* the port's conflict — a recorded contradiction, disclosed
 * because it is real — so the adapter translates the vocabulary: the subject
 * entity is what the conflict is about, the disagreeing edge ids are what it
 * conflicts with, and the world's closed `reason` code is the detail. A closed
 * code, never prose.
 */

import type { WorldSummaryView } from '../../protocol/world'
import type { ConsciousWorldReading } from '../ports'

/**
 * The world domain's summary, as a `world` port reading.
 *
 * `null` when there is no summary at all. An unavailable world returns a
 * reading whose `health` is `'unavailable'` and whose fields are empty, because
 * "there is no world model" and "the world model could not be read" are
 * different facts.
 */
export function worldFromWorld(summary: WorldSummaryView | null): ConsciousWorldReading | null {
  if (summary === null) return null

  const trust = {
    sequence: summary.sequence,
    durable: summary.persistence.durable,
  } as const

  if (summary.health !== 'ready') {
    return {
      ...trust,
      health: 'unavailable',
      reason: summary.reason ?? 'the world model could not be read',
      authority: 'world',
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
    }
  }

  return {
    ...trust,
    health: 'ready',
    reason: null,
    authority: 'world',
    entities: summary.counts.entities,
    relations: summary.counts.edges,
    observations: null,
    memories: null,
    admitted: null,
    conflicted: summary.counts.conflicts,
    rejected: null,
    withdrawn: summary.counts.withdrawnRecords,
    experiences: null,
    conflicts: summary.conflicts.items.map((conflict) => ({
      memoryId: conflict.subjectEntityId,
      conflictsWith: [...conflict.edgeIds],
      detail: conflict.reason,
    })),
  }
}
