/**
 * THE PERSONALITY PROJECTION — Core's only route from domain facts to a window.
 *
 * A pure function over Slice A's shapes. It exists so that the vocabulary a
 * renderer receives is *derived* rather than assembled: whoever builds a
 * projection supplies temperament, records, an interpretation, a plan and a
 * ledger, and this function decides — in one place, testable without a Core —
 * which of their fields may cross the seam and which may not.
 *
 * ## What it refuses, and refuses visibly
 *
 * A record that cannot be true under this domain's own rules is **dropped and
 * counted**, never coerced into something presentable: an impossible `status`,
 * a confidence of `verified` (which the ceiling table says nothing can reach),
 * an unknown kind, a key that is not a code-owned slug, or an id longer than
 * the domain allows. `counts.dropped` is that number. A projection that
 * quietly repaired a malformed record would be a projection whose counts could
 * not be reconciled with the store they came from — and one that hid the
 * malformed record would be worse, because the malformed record is the thing a
 * caller most needs to see.
 *
 * ## What never crosses at all
 *
 * `text`, `tags` and `admissionReason` are not fields of
 * `PersonalityRelationshipItemView`, so they are not read here: what was
 * recorded about the person stays in Core. The expression plan's `guidance`
 * is model-facing and is reduced to counts. The ledger contributes how many
 * entries it holds and what it may hold, never an entry itself. No key, no
 * path, no provider, no model — the inputs are domain values and the output is
 * the window's vocabulary, and there is no third thing in between.
 *
 * ## Nothing is invented
 *
 * `health` is `'ready'` because a caller that reached this function *has* a
 * Personality domain; the `'unavailable'` half is `ABSENT_PERSONALITY_PROJECTION`
 * and Core serves it when no source is filled. A `null` input section
 * (`temperament`, `interpretation`, `expression`, `repetition`) is reported as
 * `null`, not as an empty or default one: "Core has not interpreted this
 * moment" and "the interpretation says nothing" must not look the same.
 */

import {
  PERSONALITY_SCHEMA_VERSION,
  type PersonalityInterpretationView,
  type PersonalityProjection,
  type PersonalityRelationshipItemView,
  type PersonalityTemperamentView,
} from '../protocol/personality'
import {
  PERSONALITY_LIMITS,
  TEMPERAMENT_DIMENSIONS,
  isCueKind,
  isRelationshipItemKind,
  isSlug,
  instantMs,
  type CueUsageLedger,
  type ExpressionPlan,
  type FreyaTemperament,
  type RelationshipItem,
  type RelationshipStatus,
  type SocialInterpretation,
} from './types'
import type { PersonalityPersistenceHealth } from './persistence/port'
import { outboundRelationshipKey } from './directives'

export { ABSENT_PERSONALITY_PROJECTION, NO_PERSONALITY_DOMAIN_REASON } from '../protocol/personality'

/**
 * What a projection says when nobody told it how durable the records are.
 *
 * Deliberately the *pessimistic* answer rather than a cheerful `durable: true`.
 * A caller that forgot to pass a health report has not established that anything
 * survives a restart, and a projection that claimed otherwise would be the exact
 * lie this field exists to prevent.
 */
export const UNKNOWN_PERSISTENCE_REASON =
  'Core did not report how these records are stored, so this window will not claim they survive a restart'

/**
 * What a projection is built from.
 *
 * Every section is nullable, and `items` defaults to nothing: a source that
 * holds only a temperament still produces an honest projection with an empty
 * record rather than one padded with rows nobody wrote.
 */
export interface PersonalityProjectionInput {
  /** Highest sequence folded in. Absent reads as `0`, never as an estimate. */
  readonly sequence?: number
  readonly temperament: FreyaTemperament | null
  readonly items?: readonly RelationshipItem[]
  readonly interpretation: SocialInterpretation | null
  readonly expression: ExpressionPlan | null
  readonly ledger: CueUsageLedger | null
  /**
   * Actual durability of what this domain retains.
   *
   * Required, not optional, and that is the point: a projection that omitted it
   * would let a reader conclude that relationship records survive a restart
   * simply because it could see them. Absent is not honest here — the *host* has
   * a health report for exactly this, and the only difference between "durable"
   * and "held in this process only" is a fact the owner cannot otherwise see.
   */
  readonly persistence?: PersonalityPersistenceHealth
}

/**
 * Every status a record may be shown in.
 *
 * Including `retired`: a tombstone carries no text — that is the entire point of
 * destroying it — so showing one leaks nothing, and hiding one would be the
 * dishonest choice. A person is entitled to see that Freya once held a record
 * about them and that it was taken back.
 */
const RELATIONSHIP_STATUSES: readonly RelationshipStatus[] = [
  'candidate',
  'admitted',
  'rejected',
  'superseded',
  'retired',
]
/**
 * Whether one record may be shaped into a view at all.
 *
 * Exact and unforgiving on purpose. Every clause is a rule the domain already
 * enforces on the way in, so a record failing one here means a caller built
 * this input by hand — which is precisely the input worth refusing rather than
 * smoothing over.
 */
function projectable(item: RelationshipItem): boolean {
  if (typeof item.itemId !== 'string' || item.itemId.length === 0) return false
  if (item.itemId.length > PERSONALITY_LIMITS.maxItemIdChars) return false
  if (!isRelationshipItemKind(item.kind)) return false
  if (!isSlug(item.key)) return false
  if (!RELATIONSHIP_STATUSES.includes(item.status)) return false
  if (item.cueKind !== null && !isCueKind(item.cueKind)) return false
  // The ceiling table has no row that reaches `verified`; a record claiming one
  // is not a strong record, it is an impossible one.
  if (item.confidence === 'verified') return false
  if (item.admittedAt !== null && instantMs(item.admittedAt) === null) return false
  return true
}

function itemView(item: RelationshipItem): PersonalityRelationshipItemView {
  return {
    itemId: item.itemId,
    kind: item.kind,
    key: outboundRelationshipKey(item),
    status: item.status,
    cueKind: item.cueKind,
    sourceType: item.provenance.sourceType,
    confidence: item.confidence,
    admittedAt: item.admittedAt,
    lifecycleAt: item.lifecycleAt,
    lifecycleReason: item.lifecycleReason,
  }
}

function temperamentView(temperament: FreyaTemperament): PersonalityTemperamentView {
  return {
    schemaVersion: temperament.schemaVersion,
    // In table order, from the frozen table rather than object key order, so
    // the same temperament always renders in the same sequence on every machine.
    dimensions: TEMPERAMENT_DIMENSIONS.map((dimension) => ({
      dimension,
      level: temperament.dimensions[dimension],
    })),
    constitutionFirst: temperament.subordination.constitutionFirst,
    identitySupersedesTemperament: temperament.subordination.identitySupersedesTemperament,
    cannotWeaken: [...temperament.subordination.cannotOverride],
  }
}

function interpretationView(interpretation: SocialInterpretation): PersonalityInterpretationView {
  return {
    schemaVersion: interpretation.schemaVersion,
    continuity: interpretation.continuity,
    formality: interpretation.formality,
    greetingEligible: interpretation.greetingEligible,
    admittedItems: interpretation.counts.admittedItems,
    factsConsidered: interpretation.counts.factsConsidered,
    preferenceHits: interpretation.preferenceHits.length,
  }
}

/**
 * Build the projection a window may hold.
 *
 * Pure: same input, same output, no clock read and no randomness. `now` is
 * never consulted because nothing in this view is derived from the passage of
 * time — instants arrive on the records themselves, exactly as they do in the
 * Brain and Context projections.
 */
export function projectPersonality(input: PersonalityProjectionInput): PersonalityProjection {
  const raw = input.items ?? []
  // Bounded before anything else: an unbounded list is how a record store
  // silently outgrows the window that is merely holding it.
  const bounded = raw.length > PERSONALITY_LIMITS.maxRelationshipItems
    ? raw.slice(0, PERSONALITY_LIMITS.maxRelationshipItems)
    : raw

  const items: PersonalityRelationshipItemView[] = []
  const counts = {
    items: 0,
    admitted: 0,
    candidate: 0,
    rejected: 0,
    superseded: 0,
    retired: 0,
    cuesAdmitted: 0,
    dropped: Math.max(0, raw.length - bounded.length),
  }

  for (const item of bounded) {
    if (!projectable(item)) {
      counts.dropped += 1
      continue
    }
    items.push(itemView(item))
    counts.items += 1
    if (item.status === 'admitted') {
      counts.admitted += 1
      if (item.cueKind !== null) counts.cuesAdmitted += 1
    } else if (item.status === 'candidate') {
      counts.candidate += 1
    } else if (item.status === 'rejected') {
      counts.rejected += 1
    } else if (item.status === 'superseded') {
      counts.superseded += 1
    } else {
      counts.retired += 1
    }
  }

  const plan = input.expression
  const offered = plan?.cueReferences.filter((cue) => cue.mode === 'offer') ?? []
  const held = plan?.cueReferences.filter((cue) => cue.mode === 'hold') ?? []
  const firstOffered = offered[0]

  return {
    health: 'ready',
    reason: null,
    schemaVersion: PERSONALITY_SCHEMA_VERSION,
    sequence: input.sequence ?? 0,
    persistence: input.persistence ?? { mode: 'ephemeral', durable: false, reason: UNKNOWN_PERSISTENCE_REASON, faultReason: null, retained: 0 },
    temperament: input.temperament === null ? null : temperamentView(input.temperament),
    items,
    counts,
    interpretation:
      input.interpretation === null
        ? null
        : interpretationView(input.interpretation),
    expression:
      plan === null
        ? null
        : {
            cuesOffered: offered.length,
            cuesHeld: held.length,
            suppressedCueCount: plan.suppressedCueCount,
            estimatedTokens: plan.estimatedTokens,
            cannotWeaken: [...plan.cannotWeaken],
          },
    repetition:
      input.ledger === null
        ? null
        : { entries: input.ledger.entries.length, maxEntries: input.ledger.maxEntries },
    // One slot, first offered cue, otherwise nothing. A *held* cue is held
    // because the ledger says Freya used it too recently; drawing it anyway
    // would express the gesture the anti-repetition rule just suppressed.
    presenceCue:
      firstOffered === undefined
        ? null
        : { cueId: firstOffered.cueHash, kind: firstOffered.kind, mode: 'offer' },
    limits: {
      maxRelationshipItems: PERSONALITY_LIMITS.maxRelationshipItems,
      maxCueOffersPerTurn: PERSONALITY_LIMITS.maxCueOffersPerTurn,
      maxLedgerEntries: PERSONALITY_LIMITS.maxLedgerEntries,
    },
  }
}
