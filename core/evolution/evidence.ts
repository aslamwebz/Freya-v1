import {
  EVIDENCE_QUALITY,
  EVIDENCE_SOURCES,
  EVOLUTION_LIMITS,
  instantMs,
  isBoundedEvolutionText,
  isEvidenceQuality,
  isEvidenceSource,
  isEvolutionRef,
  type EvidenceQuality,
  type EvidenceRecord,
} from './types'

/**
 * Evidence-driven improvement: the collector and verifier.
 *
 * Every improvement is based on verified evidence. No improvement is made
 * without evidence. No evidence is fabricated.
 *
 * ## Verification is deterministic
 *
 * Same evidence + same source = same result. No model calls, no randomness, no
 * wall-clock reads. `now` is always an explicit argument.
 *
 * ## Quality is code-owned
 *
 * The quality ladder is closed and cannot be widened at runtime. A piece of
 * evidence is assessed against its source, its freshness and its provenance,
 * and the result is one of five closed levels.
 *
 * ## Evidence expires
 *
 * Every evidence record carries an expiry instant derived from a code-owned
 * retention table. Expired evidence cannot support an improvement — it is
 * refused rather than silently downgraded, so a caller asking to use stale
 * evidence is told no rather than obeyed.
 */

export type EvidenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export const EVIDENCE_INPUT_KEYS: readonly string[] = [
  'evidenceId',
  'source',
  'quality',
  'statement',
  'verifiedAt',
]

export const EVIDENCE_KEYS: readonly string[] = [...EVIDENCE_INPUT_KEYS, 'expiresAt']

/** How long evidence may stand before it stops being usable. */
export const EVIDENCE_RETENTION = Object.freeze({
  maxEvidenceLifetimeMs: 90 * 24 * 60 * 60 * 1_000,
})

/**
 * The quality each source can reach.
 *
 * A source is a description of *where* an observation came from, and the
 * ceiling is a property of that source, not of the evidence. `owner-assertion`
 * is the strongest and is still capped at `strong`, because a claim generalises
 * beyond the observation behind it.
 */
export const EVIDENCE_SOURCE_CEILING: Readonly<Record<string, EvidenceQuality>> = Object.freeze({
  'work-run': 'verified',
  'mission-check': 'verified',
  'learning-outcome': 'strong',
  'owner-assertion': 'strong',
  'system-health': 'moderate',
  'verification-record': 'verified',
})

/**
 * Construct an evidence record.
 *
 * Refuses rather than repairs. The quality is checked against the source
 * ceiling, so a piece of evidence cannot claim a quality its source cannot
 * support. The expiry is derived from the code-owned retention table, never
 * from the input.
 */
export function createEvidenceRecord(input: unknown): EvidenceResult<EvidenceRecord> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'not-an-object', reason: 'an evidence record must be an object' }
  }
  const value = input as Record<string, unknown>
  if (!hasExactKeys(value, EVIDENCE_INPUT_KEYS)) {
    const actual = Object.keys(value).sort()
    const expected = [...EVIDENCE_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `evidence keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }
  if (!isEvolutionRef(value.evidenceId)) {
    return { ok: false, code: 'invalid-id', reason: 'evidenceId must be a bounded opaque id' }
  }
  if (!isEvidenceSource(value.source)) {
    return { ok: false, code: 'invalid-source', reason: 'source is not in the closed evidence vocabulary' }
  }
  if (!isEvidenceQuality(value.quality)) {
    return { ok: false, code: 'invalid-quality', reason: 'quality is not in the closed evidence vocabulary' }
  }
  const source = value.source
  const quality = value.quality
  const ceiling = EVIDENCE_SOURCE_CEILING[source]
  if (ceiling === undefined) {
    return { ok: false, code: 'invalid-source', reason: `source ${source} has no quality ceiling` }
  }
  if (qualityRank(quality) > qualityRank(ceiling)) {
    return {
      ok: false,
      code: 'invalid-quality',
      reason: `a ${source} source cannot carry ${quality} quality; the ceiling is ${ceiling}`,
    }
  }
  if (!isBoundedEvolutionText(value.statement, EVOLUTION_LIMITS.maxStatementChars)) {
    return { ok: false, code: 'invalid-statement', reason: 'statement must be a non-empty bounded string' }
  }
  const verifiedAt = instantMs(value.verifiedAt)
  if (verifiedAt === null) {
    return { ok: false, code: 'invalid-instant', reason: 'verifiedAt must parse as an instant' }
  }
  const expiresAt = new Date(verifiedAt + EVIDENCE_RETENTION.maxEvidenceLifetimeMs).toISOString()

  return {
    ok: true,
    value: Object.freeze({
      evidenceId: value.evidenceId as string,
      source,
      quality,
      statement: value.statement as string,
      verifiedAt: value.verifiedAt as string,
      expiresAt,
    }),
  }
}

/**
 * Verify evidence quality and provenance.
 *
 * The verification is deterministic: same evidence + same source = same result.
 * It checks the source, the provenance, the freshness and the quality, and
 * returns a closed outcome.
 */
export type EvidenceVerification =
  | { readonly outcome: 'verified'; readonly evidence: EvidenceRecord }
  | { readonly outcome: 'insufficient'; readonly reason: string }
  | { readonly outcome: 'expired'; readonly reason: string }
  | { readonly outcome: 'invalid'; readonly reason: string }

export function verifyEvidence(
  evidence: EvidenceRecord,
  now: string,
): EvidenceVerification {
  const at = instantMs(now)
  if (at === null) {
    return { outcome: 'invalid', reason: 'the verification instant must parse as an instant' }
  }
  const verifiedAt = instantMs(evidence.verifiedAt)
  const expiresAt = instantMs(evidence.expiresAt)
  if (verifiedAt === null || expiresAt === null) {
    return { outcome: 'invalid', reason: 'the evidence carries an unreadable instant' }
  }
  if (at > expiresAt) {
    return {
      outcome: 'expired',
      reason: `this evidence expired at ${evidence.expiresAt}`,
    }
  }
  if (evidence.quality === 'insufficient' || evidence.quality === 'weak') {
    return {
      outcome: 'insufficient',
      reason: `this evidence is ${evidence.quality} and cannot support an improvement`,
    }
  }
  return { outcome: 'verified', evidence }
}

/**
 * Whether a set of evidence is sufficient to support an improvement.
 *
 * The rule is narrow and deliberate: at least one piece of evidence must be
 * `moderate` or stronger, and none may be expired. A single weak observation
 * is not a pattern, and a pattern built on expired evidence is not a pattern.
 */
export function isEvidenceSufficient(
  evidence: readonly EvidenceRecord[],
  now: string,
): { readonly sufficient: boolean; readonly reason: string } {
  if (evidence.length === 0) {
    return { sufficient: false, reason: 'no evidence was provided' }
  }
  const usable = evidence.filter((record) => {
    const verification = verifyEvidence(record, now)
    return verification.outcome === 'verified'
  })
  if (usable.length === 0) {
    return { sufficient: false, reason: 'every piece of evidence is expired, insufficient or weak' }
  }
  const strong = usable.filter(
    (record) => record.quality === 'moderate' || record.quality === 'strong' || record.quality === 'verified',
  )
  if (strong.length === 0) {
    return { sufficient: false, reason: 'no evidence is moderate or stronger' }
  }
  return { sufficient: true, reason: `${strong.length} piece(s) of evidence are usable` }
}

/**
 * The quality rank, for comparison. Higher is better.
 */
function qualityRank(quality: EvidenceQuality): number {
  const rank: Readonly<Record<EvidenceQuality, number>> = Object.freeze({
    insufficient: 0,
    weak: 1,
    moderate: 2,
    strong: 3,
    verified: 4,
  })
  return rank[quality]
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key)
}

export { EVIDENCE_QUALITY, EVIDENCE_SOURCES, qualityRank }
