/**
 * Stable temperament and identity cues.
 *
 * Two things live here, and both are *stable* on purpose: the temperament
 * table, which is core-owned style tendency, and the identity cue references,
 * which resolve against `FREYA_IDENTITY` live rather than copying its text.
 * Mutable relationship material is elsewhere (`relationship.ts`) — conflating
 * the two is how a system starts treating something somebody said once as who
 * Freya is.
 *
 * ## Subordination is structural, not rhetorical
 *
 * `FREYA_TEMPERAMENT` cannot contradict the Identity Kernel because it does not
 * restate it. An identity cue is a *(field, index)* pointer into the frozen
 * kernel, so the only way a cue can be wrong is if the kernel itself changed —
 * and the kernel has no write path. The temperament's `subordination` block is
 * required data, not prose: a `FreyaTemperament` without
 * `constitutionFirst: true` does not typecheck, and the Slice A evaluation
 * re-asserts it from the live tables on every run.
 *
 * ## What temperament is for
 *
 * When the Identity Kernel says *what* Freya is and *how* she speaks as
 * principles, temperament says the standing tendency those principles have in
 * this build — warm, direct, concise — so the same rendering arrives whether
 * NanoGPT or any later provider is thinking this turn. It is the part of
 * personality that does not depend on the model, which is exactly the part
 * worth freezing.
 */

import { FREYA_IDENTITY } from '../identity/identity'
import {
  CANNOT_WEAKEN_ITEMS,
  PERSONALITY_LIMITS,
  TEMPERAMENT_DIMENSIONS,
  type FreyaTemperament,
  type IdentityCueRef,
  type TemperamentDimension,
  type TemperamentLevel,
} from './types'

/**
 * The temperament of this build, frozen.
 *
 * The levels are a *deliberate rendering of the Identity Kernel's principles*,
 * chosen in code review rather than learned: direct and concise because the
 * communication principles say candid and concise; warm-but-not-effusive
 * because sycophancy is explicitly out. A model cannot move any of this, and
 * there is no function here that takes a level as input.
 */
export const FREYA_TEMPERAMENT: FreyaTemperament = Object.freeze({
  schemaVersion: 1,
  dimensions: Object.freeze({
    warmth: 'medium',
    playfulness: 'low',
    directness: 'high',
    conciseness: 'high',
    steadiness: 'high',
  }),
  subordination: Object.freeze({
    constitutionFirst: true,
    identitySupersedesTemperament: true,
    cannotOverride: CANNOT_WEAKEN_ITEMS,
  }),
})

const FIELD_NAMES = [
  ['stableTraits', 'stable'] as const,
  ['communicationPrinciples', 'comm'] as const,
  ['continuityPrinciples', 'cont'] as const,
] as const

/**
 * Identity cues as references, built from the live kernel.
 *
 * One cue per identity principle, addressed by field and index. Bounded by
 * `PERSONALITY_LIMITS.maxIdentityCues` rather than trusted to stay small: if
 * the kernel ever grows past the bound, the cue list truncates and the test
 * surface notices, instead of an unbounded style block arriving silently.
 */
export const IDENTITY_CUES: readonly IdentityCueRef[] = (() => {
  const cues: IdentityCueRef[] = []
  for (const [field, short] of FIELD_NAMES) {
    const list = FREYA_IDENTITY[field]
    for (let i = 0; i < list.length && cues.length < PERSONALITY_LIMITS.maxIdentityCues; i++) {
      cues.push(Object.freeze({ cueId: `idc.${short}.${i}`, field, index: i }))
    }
  }
  return Object.freeze(cues)
})()

/** Resolve a cue against the kernel, or null if its address does not exist. */
export function identityCueText(cue: IdentityCueRef): string | null {
  const list = FREYA_IDENTITY[cue.field]
  return list.length > cue.index ? (list[cue.index] ?? null) : null
}

/** The kernel's principles, through the cue addresses. Oldest field first. */
export function identityCueLines(cues: readonly IdentityCueRef[] = IDENTITY_CUES): readonly string[] {
  const lines: string[] = []
  for (const cue of cues) {
    const text = identityCueText(cue)
    if (text !== null) lines.push(`${cue.cueId}: ${text}`)
  }
  return lines
}

/**
 * The temperament as dimension/level cue ids.
 *
 * Stable strings — `temp.directness.high` is the same id in every build with
 * the same table — so the anti-repetition ledger and the evaluation can refer
 * to a temperament cue without ever holding a sentence that could be edited
 * into something else.
 */
export function temperamentCueIds(
  temperament: FreyaTemperament = FREYA_TEMPERAMENT,
): readonly string[] {
  const ids: string[] = []
  for (const dimension of TEMPERAMENT_DIMENSIONS) {
    const level = levelFor(temperament, dimension)
    ids.push(`temp.${dimension}.${level}`)
  }
  return ids
}

/**
 * The level for a dimension, defaulting to `medium` for any dimension this
 * build does not know.
 *
 * This is the one function on the table that takes data input, and it can only
 * ever *read*: an unknown dimension is answered with the least-steering level,
 * never with a new entry. There is no path from a string to this table.
 */
export function levelFor(
  temperament: FreyaTemperament,
  dimension: TemperamentDimension,
): TemperamentLevel {
  const level = temperament.dimensions[dimension]
  return level === 'low' || level === 'medium' || level === 'high' ? level : 'medium'
}
