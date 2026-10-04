import {
  CONFIDENCE_RANK,
  isEvidenceSourceKind,
  type ConfidenceLevel,
  type EconomicLimits,
  type EconomicRefusalCode,
  type EconomicUncertaintyCode,
  type EvidenceState,
  type ResearchEvidence,
} from './types'

/**
 * Evidence: what is known, how fresh it is, and where it disagrees with itself.
 *
 * Four jobs, all pure, all deterministic, and all of them about honesty rather than
 * about gathering:
 *
 * 1. **Admission.** An observation becomes evidence only if it has an authorized
 *    source, a bounded citation, and room left. Anything else is a closed refusal
 *    code, not a discarded value.
 * 2. **Freshness.** Evidence goes stale when it is old enough. Not because a timer said
 *    so — because `now` is far enough past `observedAt`, checked every time the fold
 *    runs. There is no refresh job, because a refresh job is a loop.
 * 3. **Conflict.** Two sources disagreeing about the same claim is a *fact*, not an
 *    error. Both readings are kept, the claim is marked `conflicted`, and the
 *    experiment's confidence collapses to `unknown` for that claim.
 * 4. **Confidence.** Derived, never supplied. The single rule is that the experiment's
 *    confidence is the **worst** confidence of any claim it rests on, which is the
 *    conservative reading and the only one that can be defended to a person whose money
 *    — even simulated money — is the thing being reasoned about.
 */

/** An observation, before it has been admitted as evidence. */
export interface EvidenceObservation {
  readonly evidenceId: string
  readonly source: ResearchEvidence['source']
  /** A stable identity for the source instance. Two readings from one source are one voice. */
  readonly sourceRef: string
  readonly citation: string
  /** What the evidence is about. Conflicts are detected on this and nothing else. */
  readonly claim: string
  readonly observedAt: string
}

export type EvidenceAdmission =
  | { readonly admitted: true; readonly evidence: ResearchEvidence }
  | { readonly admitted: false; readonly code: EconomicRefusalCode; readonly reason: string }

/**
 * The closed reasons an observation may be refused, each with its one sentence.
 *
 * Declared as a const object and indexed by its own key union, so the refusal type and
 * its vocabulary cannot drift: adding a key here makes it a legal
 * `EvidenceAdmission` code, and forgetting one is a compile error rather than an
 * `undefined` in an owner-visible refusal.
 */
const ADMISSION_REFUSALS = Object.freeze({
  'unauthorized-evidence-source': 'That is not an authorized source of evidence.',
  'missing-citation': 'Evidence without a citation is not evidence.',
  'invalid-citation': 'That citation was not readable as a citation.',
  'citation-over-long': 'That citation was longer than a citation is allowed to be.',
  'invalid-observed-at': 'That observation had no readable moment in time.',
  'missing-source-ref': 'Evidence must say which reading of the source it came from.',
  'missing-claim': 'Evidence must say what it is about, or a conflict cannot be found.',
  'duplicate-evidence': 'That evidence has already been recorded.',
  'experiment-cap-reached': 'That experiment has as many pieces of evidence as it is allowed.',
} as const)

type AdmissionRefusalCode = keyof typeof ADMISSION_REFUSALS

/**
 * Every admission refusal is also a subsystem refusal code, and this table proves it.
 *
 * Exported rather than kept private because it is a *check*: if somebody adds an admission
 * refusal whose code is not one the subsystem journals, the journal would receive a code the fold
 * refuses, and this table is where that mistake would otherwise be invisible.
 */
export const ADMISSION_REFUSAL_CODES: Readonly<Record<AdmissionRefusalCode, EconomicRefusalCode>> =
  Object.freeze({
    'unauthorized-evidence-source': 'unauthorized-evidence-source',
    'missing-citation': 'missing-citation',
    'invalid-citation': 'invalid-citation',
    'citation-over-long': 'citation-over-long',
    'invalid-observed-at': 'invalid-observed-at',
    'missing-source-ref': 'missing-source-ref',
    'missing-claim': 'missing-claim',
    'duplicate-evidence': 'duplicate-evidence',
    'experiment-cap-reached': 'experiment-cap-reached',
  })

export function evidenceAdmissionReason(code: AdmissionRefusalCode): string {
  return ADMISSION_REFUSALS[code]
}

/**
 * Admit one observation as evidence.
 *
 * Refuses rather than throwing, because the caller is a journal writer and needs
 * something it can record. Every refusal is a closed code, so a hostile caller cannot
 * put its own text into a refusal that reaches the journal.
 */
export function admitEvidence(
  observation: EvidenceObservation,
  experimentId: string,
  existing: readonly ResearchEvidence[],
  limits: EconomicLimits,
): EvidenceAdmission {
  const refuse = (code: AdmissionRefusalCode): EvidenceAdmission => ({
    admitted: false,
    code,
    reason: ADMISSION_REFUSALS[code],
  })

  if (existing.length >= limits.maxEvidencePerExperiment) return refuse('experiment-cap-reached')
  // Checked at runtime as well as by the type, because the type is a promise about
  // *this* file's callers and an observation arriving from Core was built somewhere
  // else. An unknown source kind is refused rather than passed through, so the closed
  // vocabulary is enforced at the boundary instead of at the annotation.
  if (!isEvidenceSourceKind(observation.source)) return refuse('unauthorized-evidence-source')
  if (typeof observation.citation !== 'string' || observation.citation.trim().length === 0) {
    return refuse('missing-citation')
  }
  if (observation.citation.length > limits.maxCitationLength) return refuse('citation-over-long')
  if (typeof observation.sourceRef !== 'string' || observation.sourceRef.length === 0) {
    return refuse('missing-source-ref')
  }
  if (typeof observation.claim !== 'string' || observation.claim.trim().length === 0) {
    return refuse('missing-claim')
  }
  if (!Number.isFinite(Date.parse(observation.observedAt))) return refuse('invalid-observed-at')
  if (existing.some((entry) => entry.evidenceId === observation.evidenceId)) {
    return refuse('duplicate-evidence')
  }

  return {
    admitted: true,
    evidence: {
      evidenceId: observation.evidenceId,
      experimentId,
      source: observation.source,
      sourceRef: observation.sourceRef,
      citation: observation.citation,
      observedAt: new Date(Date.parse(observation.observedAt)).toISOString(),
      // `fresh` on admission is a *claim made at the moment of writing* and is
      // re-derived by `refreshEvidence` on every read. The two cannot disagree for
      // long, and deriving it here rather than importing `now` is what keeps this
      // function free of a clock.
      state: 'fresh',
      confidence: 'unknown',
      claim: observation.claim,
    },
  }
}

/**
 * Has this observation aged out?
 *
 * A malformed instant is **stale**, which is the direction that fails closed: evidence
 * nobody can date cannot be treated as current.
 */
export function isEvidenceStale(observedAt: string, now: string, limits: EconomicLimits): boolean {
  const observed = Date.parse(observedAt)
  const current = Date.parse(now)
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return true
  return current - observed > limits.evidenceStaleAfterMs
}

/**
 * Re-derive freshness and conflict for every piece of evidence about one claim.
 *
 * Conflict detection is on `claim` plus `sourceRef`, and the asymmetry is deliberate:
 * two readings from the *same* source are one voice repeating itself, not a
 * disagreement, so they do not produce `conflicted`. Two different sources disagreeing
 * does. Getting this backwards in either direction is a real error — the first
 * manufactures false certainty, the second manufactures false panic.
 */
export function refreshClaimEvidence(
  claim: string,
  existing: readonly ResearchEvidence[],
  now: string,
  limits: EconomicLimits,
): readonly ResearchEvidence[] {
  const forClaim = existing.filter((entry) => entry.claim === claim)
  if (forClaim.length === 0) return existing

  const sources = new Set(forClaim.map((entry) => entry.sourceRef))
  const conflicted = sources.size > 1
  const confidence = conflicted ? 'unknown' : claimConfidence(forClaim, now, limits)

  let changed = false
  const refreshed = existing.map((entry) => {
    if (entry.claim !== claim) return entry
    const stale = isEvidenceStale(entry.observedAt, now, limits)
    const state: EvidenceState = conflicted ? 'conflicted' : stale ? 'stale' : 'fresh'
    if (entry.state === state && entry.confidence === confidence) return entry
    changed = true
    return { ...entry, state, confidence }
  })
  return changed ? refreshed : existing
}

/** Refresh every claim at once. Deterministic, and idempotent. */
export function refreshEvidence(
  existing: readonly ResearchEvidence[],
  now: string,
  limits: EconomicLimits,
): readonly ResearchEvidence[] {
  let current = existing
  for (const claim of new Set(existing.map((entry) => entry.claim))) {
    current = refreshClaimEvidence(claim, current, now, limits)
  }
  return current
}

/**
 * The confidence of one claim, derived and never fabricated.
 *
 * The ladder, and each rung says what it knows:
 *
 *   - no evidence at all → `unknown`, not `low`. "Nothing" and "one shaky source" are
 *     different facts and the projection must be able to tell them apart.
 *   - any reading stale, or any recorded gap → `unknown`. A month-old filing about a
 *     market that has since moved is not weak evidence, it is no evidence.
 *   - three or more independent sources agreeing, none stale → `high`.
 *   - two → `medium`.
 *   - one, from a source kind Core treats as reliable → `medium`.
 *   - one, owner-supplied → `low`, because the owner is a person and not a publication.
 *
 * The count is of **distinct `sourceRef`s**, never of evidence ids. Five readings from
 * one publisher are one voice, and a fold that counted them as five would manufacture
 * `high` confidence out of a single filer's opinion.
 */
export function claimConfidence(
  forClaim: readonly ResearchEvidence[],
  now: string,
  limits: EconomicLimits,
): ConfidenceLevel {
  if (forClaim.length === 0) return 'unknown'
  if (forClaim.some((entry) => entry.state === 'missing')) return 'unknown'
  if (forClaim.some((entry) => isEvidenceStale(entry.observedAt, now, limits))) return 'unknown'

  const sources = new Set(forClaim.map((entry) => entry.sourceRef))
  if (sources.size === 0) return 'unknown'
  if (sources.size >= 3) return 'high'
  if (sources.size === 2) return 'medium'
  return forClaim[0]?.source === 'owner-supplied' ? 'low' : 'medium'
}

/**
 * The confidence of a whole experiment.
 *
 * The **worst** of its claims, and that choice is the module's most important line.
 * An experiment that rests on one well-sourced claim and one contested one is not
 * well-sourced; reporting the best of the two would let the projection show a green
 * number over an argument that is still happening, and a reader would reasonably take
 * that as an answer.
 */
export function experimentConfidence(
  evidence: readonly ResearchEvidence[],
  now: string,
  limits: EconomicLimits,
): ConfidenceLevel {
  const claims = new Set(evidence.map((entry) => entry.claim))
  if (claims.size === 0) return 'unknown'

  let worst: ConfidenceLevel = 'high'
  for (const claim of claims) {
    const forClaim = evidence.filter((entry) => entry.claim === claim)
    const confidence = forClaim.some((entry) => entry.state === 'missing')
      ? 'unknown'
      : forClaim.some((entry) => isEvidenceStale(entry.observedAt, now, limits))
        ? 'unknown'
        : forClaim.length > 1 && new Set(forClaim.map((entry) => entry.sourceRef)).size > 1
          ? 'unknown'
          : claimConfidence(forClaim, now, limits)
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[worst]) worst = confidence
  }
  return worst
}

/**
 * Record a gap: something this experiment needs and does not have.
 *
 * A gap is *evidence*, marked `missing`, and it is admitted through the same table as
 * everything else so it counts against the same ceiling. Writing "we don't know this"
 * down costs the same as writing down what we do know, which is the correct accounting
 * and rather the point of having a cap at all.
 */
export function recordGap(
  claim: string,
  evidenceId: string,
  experimentId: string,
  observedAt: string,
  existing: readonly ResearchEvidence[],
  limits: EconomicLimits,
): EvidenceAdmission {
  const base = admitEvidence(
    {
      evidenceId,
      source: 'owner-supplied',
      sourceRef: `gap:${evidenceId}`,
      citation: `no reading available for "${claim}"`,
      claim,
      observedAt,
    },
    experimentId,
    existing,
    limits,
  )
  if (!base.admitted) return base
  return { admitted: true, evidence: { ...base.evidence, state: 'missing', confidence: 'unknown' } }
}

/**
 * What is uncertain about an experiment, as closed codes.
 *
 * Everything the projection shows under "uncertainty" comes from here, so the surface
 * cannot show a reason this domain did not decide on — and the codes are closed, which
 * means a research answer's wording can never become a field a window renders.
 */
export function uncertaintiesFor(
  evidence: readonly ResearchEvidence[],
  assumptionCount: number,
  seriesLength: number,
  closedTrades: number,
): readonly EconomicUncertaintyCode[] {
  const codes = new Set<EconomicUncertaintyCode>()

  if (evidence.length === 0) codes.add('no-evidence')
  const sources = new Set(evidence.map((entry) => entry.sourceRef))
  if (sources.size === 1) codes.add('single-source')

  const claims = new Set(evidence.map((entry) => entry.claim))
  for (const claim of claims) {
    const forClaim = evidence.filter((entry) => entry.claim === claim)
    if (forClaim.some((entry) => entry.state === 'stale')) codes.add('stale-evidence')
    if (new Set(forClaim.map((entry) => entry.sourceRef)).size > 1) codes.add('conflicting-evidence')
  }
  if (evidence.some((entry) => entry.state === 'missing')) codes.add('stale-evidence')

  if (assumptionCount > 0) codes.add('declared-assumptions')
  if (seriesLength > 0 && seriesLength < 2) codes.add('insufficient-series')
  if (closedTrades === 0) codes.add('no-closed-trades')

  // Sorted so the list is a function of its *contents* rather than of insertion order,
  // which is what lets a test compare two projections with `toEqual`.
  return [...codes].sort()
}