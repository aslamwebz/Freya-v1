/**
 * THE LIFE ADAPTER — Phase 21's producer for the `life` port.
 *
 * Phase 21 (Life History) landed, so `life` is no longer a stated absence: this
 * adapter is the one place that knows how a `LifeProjection` becomes a
 * `ConsciousLifeReading`. The projection does not change — it reads the port, and
 * the derivation rules in `projection.ts` are untouched.
 *
 * ## The privacy boundary, enforced here
 *
 * The port carries an id, a code, an instant and a measurement — never prose.
 * `LifeTimelineItemView` carries `title`, `summaryLength` and `bodyLength`; this
 * adapter returns the two lengths summed and neither the title nor any text. A
 * text field will not compile against `ConsciousLifeEntryReading`, and the
 * leakage sweep in `tests/red-team/consciousness-leakage.test.ts` proves the
 * reduction happened on the serialised snapshot.
 *
 * ## The two mappings that are decisions, not mechanics
 *
 * - **`confidence` is a rank, not a float.** Life publishes `Confidence`, a
 *   closed category, on purpose: a number invites comparison and averaging. The
 *   port's field is `number | null`, so this adapter publishes the domain's own
 *   ordering (`CONFIDENCE_RANK`) — the number the category already has — rather
 *   than inventing a precision the domain refused to assert.
 * - **`at` is the instant the entry is about, or the instant it was recorded.**
 *   `occurredAt` is null when the evidence does not say when something happened;
 *   the protocol's own comment for this field names the fallback, and a listing
 *   ordered by a fabricated date would be worse than one ordered by a recorded
 *   one.
 */

import { CONFIDENCE_RANK, type Confidence } from '../../brain/types'
import type { LifeProjection } from '../../protocol/life'
import type { ConsciousLifeReading } from '../ports'

/** The domain's published rank for a confidence category, as the port's number. */
function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_RANK[confidence]
}

/**
 * Phase 21's Life History projection, as a `life` port reading.
 *
 * `null` when there is no Life projection at all — which is what makes the
 * stated absence in the projection possible. An unhealthy Life returns a
 * reading whose `health` is `'unavailable'` and whose fields are empty, because
 * "there is no Life" and "Life could not be read" are different facts.
 */
export function lifeFrom(projection: LifeProjection | null): ConsciousLifeReading | null {
  if (projection === null) return null

  const trust = {
    sequence: projection.sequence,
    durable: projection.persistence.durable,
  } as const

  if (projection.health !== 'ready') {
    return {
      ...trust,
      health: 'unavailable',
      reason: projection.reason ?? 'the Life History could not be read',
      authority: 'life',
      entries: null,
      admitted: null,
      recalled: null,
      recent: [],
    }
  }

  return {
    ...trust,
    health: 'ready',
    reason: null,
    authority: 'life',
    // Every entry in the Life store was admitted through the admission pathway —
    // nothing enters the projection any other way — so the admitted count is the
    // total rather than a second, smaller number.
    entries: projection.counts.total,
    admitted: projection.counts.total,
    // The standing projection carries no recall count, and inventing one would be
    // a claim about Life rather than a reading of it.
    recalled: null,
    recent: projection.recent.map((entry) => ({
      entryId: entry.entryId,
      kind: entry.kind,
      at: entry.occurredAt ?? entry.recordedAt,
      textLength: entry.summaryLength + entry.bodyLength,
      confidence: confidenceRank(entry.confidence),
    })),
  }
}
