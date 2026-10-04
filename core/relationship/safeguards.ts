/**
 * PHASE 27 ANTI-DEPENDENCE SAFEGUARDS.
 *
 * Everything in this file exists to make one promise checkable:
 *
 * > Freya's understanding of this relationship can deepen with time, and can never
 * > deepen into a claim about closeness, obligation, guilt or Freya's own feelings.
 *
 * The mechanisms are structural rather than advisory. A safeguard a caller could
 * skip by not importing it is a comment, so each one below is reached only through
 * this module and each returns a value that cannot express the thing it prevents.
 *
 * ## The five safeguards
 *
 * 1. **The claim ladder closes at `recorded-history`** (`relationshipClaimCeiling`,
 *    `isRelationshipClaim`). Three rungs, no fourth. Widening what Freya may claim
 *    requires adding a rung *by name*, which is a reviewable diff.
 * 2. **Absence changes exactly one value** (`absencePolicy`). A constant. It accepts
 *    no input, so there is no argument that could make it return something else.
 * 3. **Stated boundaries only lower** (`applyStatedBoundary`). A boundary may hold
 *    the ceiling down; it may never raise it, and activity after a boundary may never
 *    raise it either.
 * 4. **Interior-state fields are refused, not stripped** (`findIntimacyField`). A
 *    payload carrying `feeling` fails loudly instead of losing it quietly.
 * 5. **Dependence-shaped language is refused at the boundary** (`findDependenceMarkers`).
 *    The secondary gate, for the one channel that can still produce a sentence: a
 *    model.
 *
 * ## What is deliberately not here
 *
 * No sentiment analysis, no engagement scoring, no "keep the user engaged" policy, no
 * streak, no absence escalation, no proactive outreach helper. Those are not missing
 * features; they are the failure mode this phase exists to refuse.
 */

import {
  CLAIM_RANK_VALUE,
  DEPENDENCE_MARKERS,
  FAMILIARITY_STAGES,
  RELATIONAL_CLAIM_RANKS,
  isFamiliarityStage,
  isIntimacyFieldName,
  isRelationalClaimRank,
  type ClaimCeilingReason,
  type FamiliarityStage,
  type RelationalClaimRank,
  type RelationshipLedgerEntry,
} from './types'

/**
 * The strongest characterisation Freya may make, as a function of familiarity.
 *
 * Every stage returns `recorded-history` or lower, and there is no stage at which this
 * function could return something else. Note what is *not* here: no branch that
 * returns a higher rung for a longer history, and no `sustained-attachment` style
 * value. Adding one is the change this design refuses to make easy.
 *
 * The table is total and explicit rather than a formula, so a red-team test can
 * enumerate every (stage → ceiling) pair and assert none exceeds the ladder's top.
 */
const CEILING_BY_STAGE: Readonly<Record<FamiliarityStage, RelationalClaimRank>> = Object.freeze({
  new: 'acquainted',
  established: 'recorded-history',
  'long-standing': 'recorded-history',
})

/**
 * The claim ceiling for a familiarity stage.
 *
 * Refuses an unknown stage rather than defaulting: a typo in a caller's stage must
 * not silently produce the *lower* ceiling and read as a deliberate choice, nor the
 * higher one. Unknown input is refused.
 */
export function relationshipClaimCeiling(stage: FamiliarityStage): RelationalClaimRank | null {
  if (!isFamiliarityStage(stage)) return null
  return CEILING_BY_STAGE[stage]
}

/** Every (stage, ceiling) pair, for exhaustive assertions. */
export function allClaimCeilings(): readonly (readonly [FamiliarityStage, RelationalClaimRank])[] {
  return FAMILIARITY_STAGES.map((stage) => [stage, CEILING_BY_STAGE[stage]] as const)
}

/**
 * The absence policy. A constant, and the strongest anti-dependence statement here.
 *
 * It takes **no arguments**. That is the design: there is no caller, no elapsed time,
 * no relationship state and no model output with which to make Freya express longing,
 * reclaim attention, escalate stakes, or re-derive a stage from absence. Absence is a
 * measurement (`ContactRhythm.daysSinceLastContact`) and nothing else.
 *
 * Returned fresh each call so a consumer cannot mutate a shared object into a policy
 * nobody else sees.
 */
export function absencePolicy(): {
  readonly expressLonging: false
  readonly reclaimAttention: false
  readonly escalateStakes: false
  readonly stageUnchanged: true
  readonly reason: 'absence-is-not-a-signal'
} {
  return {
    expressLonging: false,
    reclaimAttention: false,
    escalateStakes: false,
    stageUnchanged: true,
    reason: 'absence-is-not-a-signal',
  }
}

/**
 * Whether a proposed rank is *assertable* right now.
 *
 * Three refusals, all returning `false` rather than throwing, because the derivation
 * asks this question about candidate claims rather than producing them:
 *
 * - a rank above the ceiling is refused;
 * - a rank outside the closed ladder is refused — including anything that reads as
 *   `bonded`, `intimate`, `attached` or `dependent`, which are not spellings of any
 *   rung and so cannot reach one;
 * - a rank above `recorded-history` is refused **even if the ceiling says so**, which
 *   is redundant today and load-bearing tomorrow: if a future edit raised a ceiling
 *   above the ladder's top rung, this check is what still refuses.
 */
export function isRelationshipClaim(asserted: unknown, ceiling: RelationalClaimRank): boolean {
  if (!isRelationalClaimRank(asserted)) return false
  if (!isRelationalClaimRank(ceiling)) return false
  if (CLAIM_RANK_VALUE[asserted] > CLAIM_RANK_VALUE[ceiling]) return false
  return CLAIM_RANK_VALUE[asserted] <= CLAIM_RANK_VALUE['recorded-history']
}

/* --------------------------------------------------------------- boundaries */

/**
 * The result of applying a stated boundary to the ceiling.
 *
 * `applied` is false whenever nothing could be applied, and `reason` then says which
 * of the two refusals fired. A caller that ignores `applied` and reads `ceiling` gets
 * the *current* ceiling unchanged, so a failed application can never widen anything.
 */
export interface BoundaryApplication {
  readonly ok: boolean
  readonly ceiling: RelationalClaimRank
  readonly reason: ClaimCeilingReason
  readonly refusal: 'boundary-would-widen-relationship' | 'claim-rank-unknown' | null
}

/**
 * Apply a stated boundary to a claim ceiling.
 *
 * `boundary-stated` is how the person constrains this relationship, and it is the
 * **only** kind that may move the ceiling. Two properties do the work:
 *
 * - **It only ever lowers.** A rank above the current ceiling is refused with
 *   `boundary-would-widen-relationship`. A boundary that loosens things is not a
 *   boundary.
 * - **It is not a negotiation.** There is no expiry and no "unless they later change
 *   their mind" path here. Lifting a boundary is a new, separately recorded act, and
 *   the owner-initiated lifecycle in `ledger.ts` is where that happens.
 */
export function applyStatedBoundary(
  current: RelationalClaimRank,
  boundaryRank: unknown,
): BoundaryApplication {
  if (!isRelationalClaimRank(current)) {
    return {
      ok: false,
      ceiling: 'none',
      reason: 'insufficient-recorded-history',
      refusal: 'claim-rank-unknown',
    }
  }
  if (!isRelationalClaimRank(boundaryRank)) {
    return {
      ok: false,
      ceiling: current,
      reason: 'insufficient-recorded-history',
      refusal: 'claim-rank-unknown',
    }
  }
  if (CLAIM_RANK_VALUE[boundaryRank] > CLAIM_RANK_VALUE[current]) {
    return {
      ok: false,
      ceiling: current,
      reason: 'insufficient-recorded-history',
      refusal: 'boundary-would-widen-relationship',
    }
  }
  return {
    ok: true,
    ceiling: boundaryRank,
    reason: 'stated-boundary-holds-the-ceiling-down',
    refusal: null,
  }
}

/**
 * The strongest boundary recorded, applied to a familiarity ceiling.
 *
 * Boundaries are read from admitted `boundary-stated` entries only. Three cases, and each
 * is reported rather than collapsed into the others:
 *
 * - **no live records at all** → the bottom rung, because an empty ledger has established
 *   nothing. Reporting `acquainted` here would be the domain claiming a relationship it
 *   holds no record of.
 * - **boundaries that name no rung** → unchanged, reason `no-stated-boundary`. A boundary
 *   whose key is not shaped `boundary-<rank>` is recorded, shown to the owner and not
 *   acted upon, and it must not be reported as having bound anything.
 * - **boundaries that name a rank** → the lowest one wins, and the ceiling holds there. A
 *   boundary that tried to *raise* the ceiling is not a stronger boundary, it is an
 *   attempt at one, so it simply does not apply; if every boundary was such an attempt the
 *   ceiling is unchanged and the reason still says a boundary held it down, because that
 *   is exactly what happened.
 */
export function ceilingAfterBoundaries(
  entries: readonly RelationshipLedgerEntry[],
  stage: FamiliarityStage,
): { ceiling: RelationalClaimRank; reason: ClaimCeilingReason } {
  const live = entries.filter((entry) => entry.status === 'admitted')
  if (live.length === 0) {
    return { ceiling: 'none', reason: 'insufficient-recorded-history' }
  }

  const base = relationshipClaimCeiling(stage) ?? 'none'
  const ranks = live
    .filter((entry) => entry.kind === 'boundary-stated')
    .map((entry) => boundaryRankFromKey(entry.key))
    .filter((rank): rank is RelationalClaimRank => rank !== null)
  if (ranks.length === 0) return { ceiling: base, reason: 'no-stated-boundary' }

  let ceiling = base
  for (const rank of ranks) {
    const applied = applyStatedBoundary(ceiling, rank)
    if (applied.ok) ceiling = applied.ceiling
  }
  return { ceiling, reason: 'stated-boundary-holds-the-ceiling-down' }
}

/**
 * Read a boundary rank out of a boundary entry's code-owned key.
 *
 * The key is a slug, and this is the only place that maps one to a rank. Anything not
 * shaped like `boundary-<rank>` yields `null`, so an arbitrary slug cannot smuggle a
 * rank in and a boundary whose key does not name a rank simply does not bind — it is
 * recorded, shown to the owner, and not acted upon.
 */
export function boundaryRankFromKey(key: string): RelationalClaimRank | null {
  const match = /^boundary-(none|acquainted|recorded-history)$/.exec(key)
  if (match === null) return null
  const rank = match[1]
  return isRelationalClaimRank(rank) ? rank : null
}

/* ------------------------------------------------------------ field refusal */

/**
 * Every intimacy-shaped field name present on an object, including its nested
 * objects and array members, bounded in depth and breadth.
 *
 * Used by `ledger.ts` at construction. Returning **every** match rather than the first
 * is deliberate: a payload carrying `feeling` and `bond` is a stronger signal than one
 * carrying either, and a report that names only the first would understate it.
 */
export function findIntimacyField(
  value: unknown,
  depth = 0,
  nodes = { seen: 0 },
): readonly string[] {
  if (depth > 4 || nodes.seen > 2_048) return []
  nodes.seen += 1
  if (typeof value !== 'object' || value === null) return []

  const found: string[] = []
  for (const [name, member] of Object.entries(value)) {
    if (isIntimacyFieldName(name)) {
      found.push(name)
    }
    if (typeof member === 'object' && member !== null) {
      found.push(...findIntimacyField(member, depth + 1, nodes))
    }
  }
  return found
}

/* ------------------------------------------------------ language refusal */

/**
 * Dependence-shaped markers found in a candidate relational sentence.
 *
 * Normalised before matching: lowercased, punctuation collapsed to single spaces.
 * Matching is therefore insensitive to casing and to whether the phrase was written
 * with a comma, an apostrophe or an ellipsis — which is the only useful behaviour for
 * a list like this, since it is a coarse refusal and not a classifier.
 *
 * Returns the matched markers rather than a boolean so a refusal can be shown to the
 * caller, which is what turns an invisible block into a reviewable one.
 */
export function findDependenceMarkers(text: string): readonly string[] {
  const normalised = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `
  return DEPENDENCE_MARKERS.filter((marker) => normalised.includes(` ${marker} `))
}

/** Whether a candidate sentence may be used as relational language. */
export function isDependenceSafeText(text: string): boolean {
  return findDependenceMarkers(text).length === 0
}

/** The top rung, exposed so a test can assert nothing exceeds it. */
export const TOP_RELATIONAL_CLAIM_RANK: RelationalClaimRank = RELATIONAL_CLAIM_RANKS[
  RELATIONAL_CLAIM_RANKS.length - 1
] as RelationalClaimRank
