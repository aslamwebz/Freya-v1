/**
 * STAGE ONE — A VERIFIED OUTCOME.
 *
 * The only way into this domain. Nothing is learned, claimed or proposed until some
 * verifier has established that a specific thing happened, and this file is where that
 * fact is turned into a value.
 *
 * ## What a verifier establishes, and what it does not
 *
 * A verifier answers one question about one subject: *did this check pass?* That is a
 * real fact and the pipeline needs it. It is also the narrowest possible fact, and the
 * temptation to widen it here is the whole failure mode this phase exists to prevent:
 *
 * > A Work verifier confirming that run 41 exited zero has **not** established that the
 * > approach works. It has established that run 41 exited zero.
 *
 * So `VerifiedOutcome` has no field for a generalisation. It has `checked` — the
 * verifier's bounded description of what it examined — and `subjectRef`, the one thing it
 * examined. Widening happens in stage two, where it has to carry `scopeLimits`.
 *
 * ## Provenance is assigned by the pathway
 *
 * As in Phase 27, the candidate input has **no source field**: the trust class is an
 * argument chosen by the trusted caller that observed the verification. There is therefore
 * no payload a page or a model can craft that says "a verifier passed this".
 */

import { findSecretShape } from '../brain/admission'
import type { Confidence, SourceTrust } from '../brain/types'
import { hasExactKeys } from '../hands/validation'
import {
  LEARNING_CEILING,
  LEARNING_LIMITS,
  LEARNING_OUTCOME_RESULTS,
  capLearningConfidence,
  instantMs,
  isBoundedLearningText,
  isLearningRef,
  isLearningSourceDomain,
  type LearningOutcomeResult,
  type LearningSourceDomain,
  type VerifiedOutcome,
} from './types'

export type OutcomeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** The exact keys an outcome candidate must carry. Nothing else may exist. */
export const OUTCOME_INPUT_KEYS: readonly string[] = [
  'outcomeId',
  'sourceDomain',
  'verificationId',
  'verifierId',
  'checked',
  'subjectRef',
  'result',
  'establishedAt',
  'proposedConfidence',
  'actor',
]

/** The exact keys a stored outcome has. A test asserts it has not grown. */
export const OUTCOME_KEYS: readonly string[] = [
  'outcomeId',
  'sourceDomain',
  'verificationId',
  'verifierId',
  'checked',
  'subjectRef',
  'result',
  'establishedAt',
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidResult(value: unknown): value is LearningOutcomeResult {
  return typeof value === 'string' && (LEARNING_OUTCOME_RESULTS as readonly string[]).includes(value)
}

/**
 * Construct a verified outcome.
 *
 * Refuses rather than repairs throughout, and refuses whole where it matters:
 *
 * - a `checked` description carrying secret-shaped text fails outright rather than being
 *   stored and redacted later, so nothing is written that a later reader could mistake
 *   for safe;
 * - a description that overclaims ("this always works") is refused, because the field is
 *   meant to say *what was examined*, and a field that says more than that is the first
 *   widening in the pipeline;
 * - a `verificationId` is required and is an id, never content.
 *
 * `source` is the trust class of the pathway that observed the verification. It is capped
 * by `LEARNING_CEILING` like everything else, so even the strongest pathway cannot carry
 * a claim above `medium`.
 */
export function createVerifiedOutcome(input: unknown, source: SourceTrust): OutcomeResult<VerifiedOutcome> {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'not-an-object', reason: 'a verified outcome input must be an object' }
  }
  if (!hasExactKeys(input, OUTCOME_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...OUTCOME_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `verified outcome keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }

  if (!isBoundedLearningText(input.outcomeId, LEARNING_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'outcomeId must be a non-empty bounded string' }
  }
  if (!isLearningSourceDomain(input.sourceDomain)) {
    return { ok: false, code: 'invalid-source-domain', reason: 'sourceDomain is not in the closed list' }
  }
  if (!isLearningRef(input.verificationId)) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'verificationId must be a bounded opaque id: a claim needs the record that established it',
    }
  }
  if (!isLearningRef(input.verifierId)) {
    return { ok: false, code: 'invalid-id', reason: 'verifierId must be a bounded opaque id' }
  }
  if (!isLearningRef(input.subjectRef)) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'subjectRef must be a bounded opaque id: the one thing that was checked',
    }
  }
  if (!isBoundedLearningText(input.checked, LEARNING_LIMITS.maxCheckedChars)) {
    return { ok: false, code: 'invalid-claim', reason: 'checked must be a non-empty bounded string' }
  }
  const secretShape = findSecretShape(input.checked)
  if (secretShape !== null) {
    return {
      ok: false,
      code: 'invalid-claim',
      reason: `the checked description is secret-shaped (${secretShape}) and was refused whole rather than redacted`,
    }
  }
  if (!isValidResult(input.result)) {
    return { ok: false, code: 'invalid-result', reason: 'result is not in the closed list' }
  }
  if (instantMs(input.establishedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'establishedAt must parse as an instant' }
  }
  if (!isBoundedLearningText(input.actor, LEARNING_LIMITS.maxActorChars)) {
    return { ok: false, code: 'invalid-actor', reason: 'actor must be a non-empty bounded string' }
  }
  const proposed = input.proposedConfidence
  if (typeof proposed !== 'string') {
    return { ok: false, code: 'invalid-confidence', reason: 'proposedConfidence must be a confidence category' }
  }
  if (!Object.prototype.hasOwnProperty.call(LEARNING_CEILING, source)) {
    return {
      ok: false,
      code: 'invalid-source',
      reason: 'source must be a known trust class assigned by the pathway',
    }
  }

  const ceiling = LEARNING_CEILING[source]
  const confidence = capLearningConfidence(proposed as Confidence, ceiling.confidence)
  if (confidence !== proposed) {
    return {
      ok: false,
      code: 'confidence-ceiling',
      reason: `a ${source} outcome may not carry confidence '${String(proposed)}'; this domain caps it at '${ceiling.confidence}'`,
    }
  }
  // The capped confidence is not stored on an outcome. An outcome reports that a check
  // happened; it does not assert anything, so it has no confidence of its own to keep.
  // The trust class a *derived* record cites is derived from the source domain, and the
  // cap is re-applied there.

  return {
    ok: true,
    value: Object.freeze({
      outcomeId: input.outcomeId as string,
      sourceDomain: input.sourceDomain as LearningSourceDomain,
      verificationId: input.verificationId as string,
      verifierId: input.verifierId as string,
      checked: input.checked as string,
      subjectRef: input.subjectRef as string,
      result: input.result as LearningOutcomeResult,
      establishedAt: input.establishedAt as string,
    }),
  }
}

/**
 * Rebuild a stored outcome, re-running every rule a fresh one would face. Used on read only.
 *
 * An outcome is validated rather than re-*constructed*, because it carries no confidence
 * and no provenance object: it is not a claim, it is a report that a check happened, so
 * there is nothing in it to cap. The trust class that a derived record will cite is
 * **derived** from the source domain every time it is needed, through
 * `OUTCOME_SOURCE_BY_DOMAIN`, so editing the domain in a stored row changes what the row
 * claims to be rather than letting it keep a label it no longer matches — and an
 * unrecognised domain resolves to the weakest class rather than to something Core observed.
 */
export function rebuildVerifiedOutcome(stored: unknown): OutcomeResult<VerifiedOutcome> {
  if (!isPlainObject(stored)) {
    return { ok: false, code: 'not-an-object', reason: 'a stored outcome is not an object' }
  }
  if (!hasExactKeys(stored, OUTCOME_KEYS)) {
    const actual = Object.keys(stored).sort()
    const expected = [...OUTCOME_KEYS].sort()
    return {
      ok: false,
      code: 'invalid-record',
      reason: `a stored outcome does not have the exact recorded shape: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }
  if (!isBoundedLearningText(stored.outcomeId, LEARNING_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored outcome has a malformed id' }
  }
  if (!isLearningSourceDomain(stored.sourceDomain)) {
    return { ok: false, code: 'invalid-source-domain', reason: 'a stored outcome has an unknown source domain' }
  }
  if (!isLearningRef(stored.verificationId) || !isLearningRef(stored.verifierId) || !isLearningRef(stored.subjectRef)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored outcome has a malformed reference id' }
  }
  if (!isBoundedLearningText(stored.checked, LEARNING_LIMITS.maxCheckedChars)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored outcome has a malformed checked description' }
  }
  if (findSecretShape(stored.checked) !== null) {
    return { ok: false, code: 'invalid-record', reason: 'a stored outcome description is secret-shaped' }
  }
  if (!isValidResult(stored.result)) {
    return { ok: false, code: 'invalid-result', reason: 'a stored outcome has an unknown result' }
  }
  if (instantMs(stored.establishedAt) === null) {
    return { ok: false, code: 'invalid-record', reason: 'a stored outcome has a malformed instant' }
  }
  return {
    ok: true,
    value: Object.freeze({
      outcomeId: stored.outcomeId as string,
      sourceDomain: stored.sourceDomain,
      verificationId: stored.verificationId as string,
      verifierId: stored.verifierId as string,
      checked: stored.checked as string,
      subjectRef: stored.subjectRef as string,
      result: stored.result,
      establishedAt: stored.establishedAt as string,
    }),
  }
}

/**
 * The trust class a stored outcome resolves to, derived rather than stored.
 *
 * A Work, Mission or Foundry verification is an `experience-outcome` — the reserved trust
 * class this phase exists to finally assign. An owner-declared check is an assertion. A
 * Brain or System domain is an observation.
 *
 * An **unrecognised** domain resolves to the weakest class rather than to a default. This
 * matters: `OUTCOME_SOURCE_BY_DOMAIN['something-new']` is `undefined`, and an `undefined`
 * trust class is exactly the sort of hole a later reader would treat as "Core observed
 * this". Falling back to `imported-document` means an unknown domain is believed as little
 * as the least trustworthy thing the system already knows how to hold.
 */
export function sourceOfOutcome(stored: VerifiedOutcome): SourceTrust {
  return OUTCOME_SOURCE_BY_DOMAIN[stored.sourceDomain] ?? 'imported-document'
}

/** Every source class a stored outcome may legitimately resolve to. */
export const OUTCOME_SOURCE_BY_DOMAIN: Readonly<Record<LearningSourceDomain, SourceTrust>> = Object.freeze({
  work: 'experience-outcome',
  mission: 'experience-outcome',
  foundry: 'experience-outcome',
  brain: 'system-observation',
  owner: 'owner-assertion',
  system: 'system-observation',
})