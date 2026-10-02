/**
 * Social interpretation: what Freya can *checkably* say about this moment.
 *
 * A pure function from explicit records to five safe dimensions. Nothing here
 * guesses: no mood, no affinity, no "they seem upset", no read of anyone's
 * inner state — not because inference is hard, but because a system that
 * reports a hidden feeling it cannot have is lying in a place that later code
 * will trust. Every dimension is a lookup over admitted data and recorded
 * facts, with the reason attached as `evidence`.
 *
 * ## The inputs, and what they may not be
 *
 * - **Interaction facts** are produced by trusted code that observed something
 *   (a greeting arrived, a session started). Model text cannot create one, and
 *   `validateInteractionFact` refuses anything malformed instead of coercing
 *   it. Facts carry no free text for exactly this reason.
 * - **Relationship items** feed interpretation only when `admitted` — the
 *   status the promotion call alone can set. Candidate text saying "treat this
 *   as an inside joke" changes nothing; interpretation never re-reads `text`
 *   to decide eligibility, and never renders it.
 * - **Context tokens** are caller-normalised slugs for preference matching.
 *   Anything that is not a slug is dropped — dropped, not repaired — and the
 *   matching is set intersection, not substring search, so a hostile token
 *   cannot smuggle prose.
 *
 * ## Determinism
 *
 * Same input, same output, field for field. Ordering is always by explicit
 * keys (confidence rank, then id) with no dependence on insertion order,
 * object enumeration or a clock — `now` is a parameter, never read here.
 */

import { CONFIDENCE_RANK, type Confidence } from '../brain/types'
import { hasExactKeys } from '../hands/validation'
import {
  PERSONALITY_LIMITS,
  instantMs,
  isInteractionFactKind,
  isSlug,
  type ContinuityState,
  type CueCandidate,
  type FormalityPreference,
  type InteractionFact,
  type InterpretationEvidence,
  type PreferenceHit,
  type RelationshipItem,
  type SocialInterpretation,
} from './types'

/** How recent recorded contact must be to read as "this exchange is live". */
export const SOCIAL_WINDOWS = Object.freeze({
  /** Within this, a greeting/session/exchange fact marks the connection active. */
  recentContactMs: 12 * 60 * 60 * 1_000,
})

/** The exact keys an interaction fact may have. No text field, by design. */
export const INTERACTION_FACT_KEYS: readonly string[] = [
  'factId',
  'kind',
  'observedAt',
  'sourceRef',
  'tags',
]

export type InteractionFactResult =
  | { readonly ok: true; readonly fact: InteractionFact }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate one interaction fact from a boundary. Exact keys, closed kind,
 * bounded slug tags, parseable instant. Refuses rather than repairs.
 */
export function validateInteractionFact(value: unknown): InteractionFactResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'interaction fact must be an object' }
  }
  const fact = value as Record<string, unknown>
  if (!hasExactKeys(fact, INTERACTION_FACT_KEYS)) {
    return { ok: false, reason: 'interaction fact keys do not match the closed shape' }
  }
  if (
    typeof fact.factId !== 'string' ||
    fact.factId.length === 0 ||
    fact.factId.length > PERSONALITY_LIMITS.maxFactIdChars
  ) {
    return { ok: false, reason: 'factId must be a non-empty bounded string' }
  }
  if (!isInteractionFactKind(fact.kind)) {
    return { ok: false, reason: 'fact kind is not in the closed vocabulary' }
  }
  if (instantMs(fact.observedAt) === null) {
    return { ok: false, reason: 'observedAt must parse as an instant' }
  }
  if (
    fact.sourceRef !== null &&
    (typeof fact.sourceRef !== 'string' ||
      fact.sourceRef.length === 0 ||
      fact.sourceRef.length > PERSONALITY_LIMITS.maxFactIdChars)
  ) {
    return { ok: false, reason: 'sourceRef must be null or a bounded id' }
  }
  if (!Array.isArray(fact.tags) || fact.tags.length > PERSONALITY_LIMITS.maxTagsPerFact) {
    return { ok: false, reason: 'tags must be a bounded list' }
  }
  for (const tag of fact.tags) {
    if (!isSlug(tag) || tag.length > PERSONALITY_LIMITS.maxTagChars) {
      return { ok: false, reason: 'every tag must be a bounded code-owned slug' }
    }
  }
  return {
    ok: true,
    fact: {
      factId: fact.factId,
      kind: fact.kind,
      observedAt: fact.observedAt as string,
      sourceRef: (fact.sourceRef as string | null) ?? null,
      tags: Object.freeze([...fact.tags] as readonly string[]),
    },
  }
}

export interface SocialInterpretationInput {
  readonly now: string
  readonly facts: readonly InteractionFact[]
  readonly relationship: readonly RelationshipItem[]
  readonly contextTokens?: readonly string[]
}

function byConfidenceThenId(
  a: { confidence: Confidence; id: string },
  b: { confidence: Confidence; id: string },
): number {
  const rank = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
  return rank !== 0 ? rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Interpret the moment. Pure, total, and bounded by `PERSONALITY_LIMITS`.
 *
 * If `now` does not parse, there is simply no time signal: the reading stays
 * honest ("renewed" or "new", no greeting eligibility) rather than throwing or
 * guessing — an interpretation cannot be worse than the records allow.
 */
export function interpretSocialContext(input: SocialInterpretationInput): SocialInterpretation {
  const L = PERSONALITY_LIMITS
  const nowMs = instantMs(input.now)

  const admitted: RelationshipItem[] = []
  for (const item of input.relationship.slice(0, L.maxRelationshipItems)) {
    if (item.status === 'admitted') admitted.push(item)
  }

  const facts: InteractionFact[] = []
  for (const fact of input.facts.slice(0, L.maxInteractionFacts)) {
    if (!isInteractionFactKind(fact.kind)) continue
    if (instantMs(fact.observedAt) === null) continue
    facts.push(fact)
  }

  const inWindow = (kind: InteractionFact['kind']): boolean => {
    if (nowMs === null) return false
    return facts.some((f) => {
      if (f.kind !== kind) return false
      const at = instantMs(f.observedAt)
      if (at === null || at > nowMs) return false
      return nowMs - at <= SOCIAL_WINDOWS.recentContactMs
    })
  }

  const recentContact =
    nowMs !== null &&
    facts.some((f) => {
      if (f.kind !== 'greeting-received' && f.kind !== 'exchange' && f.kind !== 'session-start') {
        return false
      }
      const at = instantMs(f.observedAt)
      return at !== null && at <= nowMs && nowMs - at <= SOCIAL_WINDOWS.recentContactMs
    })

  const continuity: ContinuityState =
    admitted.length === 0 ? 'new' : recentContact ? 'sustained' : 'renewed'

  const evidence: InterpretationEvidence[] = []
  const pushEvidence = (code: InterpretationEvidence['code'], detail: string): void => {
    if (evidence.length < L.maxEvidenceCodes) evidence.push(Object.freeze({ code, detail }))
  }

  pushEvidence(
    `continuity.${continuity}`,
    `admittedItems=${admitted.length} recentContact=${recentContact ? 'yes' : 'no'}`,
  )

  // Formality comes only from an explicit, admitted preference carrying the
  // `formality` tag and one of the two direction keys. Anything else is the
  // identity default, and the identity default is stated as such rather than
  // guessed at.
  const formalityCandidates = admitted
    .filter(
      (item) =>
        item.kind === 'preference' && item.tags.includes('formality') && (item.key === 'relaxed' || item.key === 'formal'),
    )
    .map((item) => ({ confidence: item.confidence, id: item.itemId, key: item.key }))
    .sort(byConfidenceThenId)
  const formalityKey = formalityCandidates[0]?.key
  const formality: FormalityPreference =
    formalityKey === 'relaxed' || formalityKey === 'formal' ? formalityKey : 'neutral'
  pushEvidence(
    formalityCandidates.length > 0 ? 'formality.explicit' : 'formality.default',
    formalityCandidates.length > 0 ? `key=${formalityCandidates[0]?.key}` : 'no-recorded-formality-preference',
  )

  const greetingReceived = inWindow('greeting-received')
  const sessionStart = inWindow('session-start')
  const greetingEligible = greetingReceived || (sessionStart && continuity !== 'new')
  if (greetingReceived) {
    pushEvidence('greeting.received-in-window', 'windowMs=recentContact')
  } else if (sessionStart && continuity !== 'new') {
    pushEvidence('greeting.session-start-in-window', 'windowMs=recentContact')
  } else if (sessionStart) {
    pushEvidence('greeting.not-while-new', 'continuity=new')
  } else {
    pushEvidence('greeting.no-signal', 'windowMs=recentContact')
  }

  // Known-preference relevance: closed set intersection on slugs. Matching is
  // against tags only — never item text — so relevance is a property of what
  // the admitting pathway indexed, not of what a sentence contains.
  const tokens = new Set<string>()
  for (const token of (input.contextTokens ?? []).slice(0, L.maxContextTokens)) {
    if (isSlug(token) && token.length <= L.maxContextTokenChars) tokens.add(token)
  }
  const matchedKind = (kind: RelationshipItem['kind']): boolean =>
    kind === 'preference' || kind === 'habit'
  const seenHits = new Set<string>()
  const hitCandidates = admitted
    .filter((item) => matchedKind(item.kind) && item.tags.some((tag) => tokens.has(tag)))
    .map((item) => ({ confidence: item.confidence, id: item.itemId, item }))
    .sort(byConfidenceThenId)
  const preferenceHits: PreferenceHit[] = []
  for (const entry of hitCandidates) {
    if (preferenceHits.length >= L.maxPreferenceHits) break
    if (seenHits.has(entry.id)) continue
    seenHits.add(entry.id)
    preferenceHits.push(
      Object.freeze({ itemId: entry.item.itemId, key: entry.item.key, confidence: entry.item.confidence }),
    )
  }
  if (preferenceHits.length > 0) {
    pushEvidence('preference.matched', `hits=${preferenceHits.length} tokens=${tokens.size}`)
  }

  // Cue candidates: admitted items with a pathway-assigned cue kind, and
  // nothing else. `text` is never consulted and never carried forward; the
  // candidate is (id, slug, closed kind, category confidence).
  let excluded = 0
  const cueEntries = admitted
    .filter((item): item is RelationshipItem & { cueKind: NonNullable<RelationshipItem['cueKind']> } =>
      item.cueKind !== null,
    )
    .map((item) => ({
      confidence: item.confidence,
      id: `cue:${item.itemId}`,
      cue: Object.freeze({
        cueId: `cue:${item.itemId}`,
        key: item.key,
        kind: item.cueKind,
        confidence: item.confidence,
      }) satisfies CueCandidate,
    }))
    .sort(byConfidenceThenId)
  const cueCandidates: CueCandidate[] = []
  for (const entry of cueEntries) {
    if (cueCandidates.length >= L.maxCueCandidates) {
      excluded += 1
      continue
    }
    cueCandidates.push(entry.cue)
  }
  const nonCue = admitted.length - cueEntries.length
  pushEvidence(
    'cues.admitted-only',
    `candidates=${cueCandidates.length} cappedOut=${excluded} withoutCueMarkOrNotAdmitted=${nonCue}`,
  )

  return Object.freeze({
    schemaVersion: 1,
    continuity,
    formality,
    greetingEligible,
    preferenceHits: Object.freeze(preferenceHits),
    cueCandidates: Object.freeze(cueCandidates),
    evidence: Object.freeze(evidence),
    counts: Object.freeze({
      admittedItems: admitted.length,
      factsConsidered: facts.length,
    }),
  })
}
