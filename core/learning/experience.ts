/**
 * STAGES TWO AND THREE — A DISTILLED EXPERIENCE, AND A KNOWLEDGE RECORD.
 *
 * Two files' worth of construction in one place, because the rules that connect them are
 * the rules that matter and splitting them would let one drift from the other.
 *
 * ## The ladder narrows as it climbs
 *
 * ```
 *   VerifiedOutcome       the check passed
 *   LearningExperience    what the check established, and where it stops
 *   KnowledgeRecord       what that suggests, with its evidence and its scope bound
 * ```
 *
 * Each step generalises a little further and therefore gets **less** certain, not more:
 *
 * - an experience may carry `observed` at `medium` — it is what a check established;
 * - a knowledge record may carry `observed` at `medium` or `inferred` at `low`, and
 *   **never** above `medium`, because a claim about a class of situations is an inference
 *   however solid its evidence.
 *
 * There is no code path in either file that produces `high` or `verified`.
 *
 * ## The evidence rule
 *
 * A knowledge record must name at least one **admitted** experience and at least one
 * verification id behind it. An experience must name the outcome it came from. So there is
 * no such thing as an unsupported lesson in this store: the strongest thing a caller can
 * do is invent a verification id, and a test covers exactly that.
 *
 * ## Scope limits are required
 *
 * Both record kinds carry `scopeLimits`, and it must be non-empty. There is no way to
 * record what Freya learned without recording where the learning stops — which is the
 * difference between a lesson and a rule, and a rule learned from one run is how a system
 * starts acting on a coincidence.
 */

import { findSecretShape } from '../brain/admission'
import type { Confidence, Provenance, SourceTrust } from '../brain/types'
import { hasExactKeys } from '../hands/validation'
import {
  LEARNING_CEILING,
  LEARNING_DISTILLED_SOURCES,
  LEARNING_LIMITS,
  LEARNING_PROPOSAL_THRESHOLDS,
  capLearningConfidence,
  findOverclaimMarkers,
  instantMs,
  isBoundedLearningText,
  isForbiddenLearningFieldName,
  isLearningExperienceKind,
  isLearningKnowledgeKind,
  isLearningRef,
  isLearningScope,
  isLearningScopeLimit,
  type KnowledgeRecord,
  type LearningExperience,
  type LearningExperienceKind,
  type LearningKnowledgeKind,
  type LearningLifecycleReason,
  type LearningScope,
  type LearningScopeLimit,
  type LearningStatus,
} from './types'

export type LearningResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/* ------------------------------------------------------------ experience */

export const EXPERIENCE_INPUT_KEYS: readonly string[] = [
  'experienceId',
  'kind',
  'lesson',
  'scope',
  'scopeLimits',
  'tags',
  'evidenceRefs',
  'observedAt',
  'proposedConfidence',
  'actor',
]

export const EXPERIENCE_KEYS: readonly string[] = [
  'experienceId',
  'outcomeId',
  'kind',
  'sourceDomain',
  'lesson',
  'scope',
  'scopeLimits',
  'tags',
  'provenance',
  'evidenceRefs',
  'status',
  'admittedAt',
  'admissionReason',
  'lifecycleAt',
  'lifecycleReason',
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidTags(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > LEARNING_LIMITS.maxTags) return false
  return value.every((tag) => isLearningRef(tag) && tag.length <= LEARNING_LIMITS.maxTagChars)
}

function isValidRefs(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > LEARNING_LIMITS.maxEvidenceRefs) return false
  return value.every((ref) => isLearningRef(ref))
}

/**
 * Refuse-not-ignore, for the fields that would turn a lesson into an instruction.
 *
 * Runs **before** the exact-key check, for the same reason Phase 27 does: an extra field
 * named `alwaysWorks` fails both rules, and the specific refusal is the one worth having.
 */
function forbiddenFieldNames(input: unknown, depth = 0, nodes = { seen: 0 }): readonly string[] {
  if (depth > 3 || nodes.seen > 1_024) return []
  nodes.seen += 1
  if (typeof input !== 'object' || input === null) return []
  const found: string[] = []
  for (const [name, member] of Object.entries(input as Record<string, unknown>)) {
    if (isForbiddenLearningFieldName(name)) found.push(name)
    if (typeof member === 'object' && member !== null) {
      found.push(...forbiddenFieldNames(member, depth + 1, nodes))
    }
  }
  return found
}

/**
 * Construct a distilled experience from one verified outcome.
 *
 * `source` is the trust class of the pathway that observed the outcome, and it is an
 * argument rather than a field. A distilled experience may only be drawn from a
 * **successful or partial** outcome; a failed check is not a lesson about how to do the
 * thing, it is a lesson about why it did not work, and that is a different kind with a
 * different kind of evidence.
 */
export function createLearningExperience(
  input: unknown,
  source: SourceTrust,
  context: {
    readonly outcomeId: string
    readonly outcomeSourceDomain: LearningExperience['sourceDomain']
    readonly outcomeResult: LearningExperience['status'] extends never ? never : string
  },
): LearningResult<LearningExperience> {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'not-an-object', reason: 'a learning experience input must be an object' }
  }

  const forbidden = forbiddenFieldNames(input)
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden-field-refused',
      reason: `the experience carries field(s) a lesson may not hold: [${forbidden.join(', ')}]`,
    }
  }

  if (!hasExactKeys(input, EXPERIENCE_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...EXPERIENCE_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `learning experience keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }

  if (!isBoundedLearningText(input.experienceId, LEARNING_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'experienceId must be a non-empty bounded string' }
  }
  if (!isLearningExperienceKind(input.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'kind is not in the closed learning vocabulary' }
  }
  if (!isBoundedLearningText(input.lesson, LEARNING_LIMITS.maxLessonChars)) {
    return { ok: false, code: 'invalid-claim', reason: 'lesson must be a non-empty bounded string' }
  }
  const secretShape = findSecretShape(input.lesson)
  if (secretShape !== null) {
    return {
      ok: false,
      code: 'invalid-claim',
      reason: `the lesson is secret-shaped (${secretShape}) and was refused whole rather than redacted`,
    }
  }
  const overclaims = findOverclaimMarkers(input.lesson)
  if (overclaims.length > 0) {
    return {
      ok: false,
      code: 'too-generic',
      reason: `the lesson overclaims beyond what a checked outcome can establish: [${overclaims.join(', ')}]. Say what was observed and let scopeLimits carry the rest.`,
    }
  }
  if (!isLearningScope(input.scope)) {
    return { ok: false, code: 'invalid-scope', reason: 'scope is not in the closed learning vocabulary' }
  }
  const scopeCheck = checkScopeLimits(input.scopeLimits, input.scope)
  if (!scopeCheck.ok) return scopeCheck
  if (!isValidTags(input.tags)) {
    return { ok: false, code: 'invalid-tags', reason: 'tags must be bounded opaque labels' }
  }
  if (!isValidRefs(input.evidenceRefs)) {
    return { ok: false, code: 'invalid-evidence-refs', reason: 'evidenceRefs must be bounded opaque ids' }
  }
  if (instantMs(input.observedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'observedAt must parse as an instant' }
  }
  if (!isBoundedLearningText(input.actor, LEARNING_LIMITS.maxActorChars)) {
    return { ok: false, code: 'invalid-actor', reason: 'actor must be a non-empty bounded string' }
  }
  if (!Object.prototype.hasOwnProperty.call(LEARNING_CEILING, source)) {
    return { ok: false, code: 'invalid-source', reason: 'source must be a known trust class assigned by the pathway' }
  }
  const proposed = input.proposedConfidence
  if (typeof proposed !== 'string') {
    return { ok: false, code: 'invalid-confidence', reason: 'proposedConfidence must be a confidence category' }
  }

  // The evidence rule: a lesson must name the check it came from.
  if (!isLearningRef(context.outcomeId)) {
    return { ok: false, code: 'no-outcome', reason: 'an experience must name the verified outcome it was distilled from' }
  }
  if (!input.evidenceRefs.includes(context.outcomeId)) {
    return {
      ok: false,
      code: 'no-verification-evidence',
      reason: 'an experience must carry its outcomeId among its evidence references',
    }
  }
  if (context.outcomeResult === 'failed') {
    return {
      ok: false,
      code: 'no-verification-evidence',
      reason: 'a failed check is not a lesson about how to do the thing; record it as a failure-lesson instead',
    }
  }

  const ceiling = LEARNING_CEILING[source]
  const confidence = capLearningConfidence(proposed as Confidence, ceiling.confidence)
  if (confidence !== proposed) {
    return {
      ok: false,
      code: 'confidence-ceiling',
      reason: `a ${source} experience may not carry confidence '${proposed}'; this domain caps it at '${ceiling.confidence}'`,
    }
  }

  const provenance: Provenance = Object.freeze({
    sourceType: source,
    sourceRef: context.outcomeId,
    observedAt: input.observedAt as string,
    recordedAt: input.observedAt as string,
    actor: input.actor as string,
    verificationStatus: ceiling.epistemic,
    confidence,
    evidenceSummary: null,
  })

  return {
    ok: true,
    value: Object.freeze({
      experienceId: input.experienceId as string,
      outcomeId: context.outcomeId,
      kind: input.kind as LearningExperienceKind,
      sourceDomain: context.outcomeSourceDomain,
      lesson: input.lesson as string,
      scope: input.scope,
      scopeLimits: Object.freeze([...(input.scopeLimits as readonly LearningScopeLimit[])]),
      tags: Object.freeze([...(input.tags as readonly string[])]),
      provenance,
      evidenceRefs: Object.freeze([...(input.evidenceRefs as readonly string[])]),
      status: 'candidate' as LearningStatus,
      admittedAt: null,
      admissionReason: null,
      lifecycleAt: null,
      lifecycleReason: null,
    }),
  }
}

/* -------------------------------------------------------------- lifecycle */

/** Admit an experience. The only path to `admitted`. */
export function admitLearningExperience(
  candidate: LearningExperience,
  decision: { now: string; reason: string },
): LearningResult<LearningExperience> {
  if (candidate.status !== 'candidate') {
    return { ok: false, code: 'not-candidate', reason: `only candidates can be admitted, not ${candidate.status}` }
  }
  const instant = checkDecision(decision)
  if (!instant.ok) return instant
  return {
    ok: true,
    value: Object.freeze({
      ...candidate,
      status: 'admitted' as LearningStatus,
      admittedAt: decision.now,
      admissionReason: decision.reason,
    }),
  }
}


/**
 * Reject a candidate experience. Kept as data with its reason, never deleted here.
 *
 * The text is **kept** on a rejected candidate rather than destroyed, because a candidate
 * was never part of the record set, so no derivation ever read it, and keeping it lets the
 * owner read back what was declined.
 */
export function rejectLearningExperience(
  candidate: LearningExperience,
  decision: { now: string; reason: string },
): LearningResult<LearningExperience> {
  if (candidate.status !== 'candidate') {
    return { ok: false, code: 'not-candidate', reason: `only candidates can be rejected, not ${candidate.status}` }
  }
  const instant = checkDecision(decision)
  if (!instant.ok) return instant
  return {
    ok: true,
    value: Object.freeze({
      ...candidate,
      status: 'rejected' as LearningStatus,
      admissionReason: decision.reason,
      lifecycleAt: decision.now,
      lifecycleReason: 'owner-rejected-this-record' as LearningLifecycleReason,
    }),
  }
}

export function supersedeLearningExperience(
  record: LearningExperience,
  decision: { now: string; supersedes: string },
): LearningResult<LearningExperience> {
  if (record.status !== 'admitted') {
    return { ok: false, code: 'not-admitted', reason: `only admitted records can be superseded, not ${record.status}` }
  }
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  if (!isBoundedLearningText(decision.supersedes, LEARNING_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'the superseding id must be a bounded non-empty string' }
  }
  if (decision.supersedes === record.experienceId) {
    return { ok: false, code: 'self-supersession', reason: 'a record cannot supersede itself' }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...record,
      status: 'superseded' as LearningStatus,
      lifecycleAt: decision.now,
      lifecycleReason: 'superseded-by-a-newer-record' as LearningLifecycleReason,
    }),
  }
}

/** Retract an experience. Destruction, not a flag: the lesson itself goes. */
export function retractLearningExperience(
  record: LearningExperience,
  decision: { now: string },
): LearningResult<LearningExperience> {
  return terminateExperience(record, decision.now, 'owner-withdrew-this-record', 'retracted')
}

export function expireLearningExperience(
  record: LearningExperience,
  decision: {
    now: string
    reason: Extract<LearningLifecycleReason, 'retention-bound-reached' | 'stale-record-expired'>
  },
): LearningResult<LearningExperience> {
  if (decision.reason !== 'retention-bound-reached' && decision.reason !== 'stale-record-expired') {
    return {
      ok: false,
      code: 'illegal-lifecycle-reason',
      reason: 'the expiry reason must be one of the two expiry labels',
    }
  }
  return terminateExperience(record, decision.now, decision.reason, 'expired')
}

function terminateExperience(
  record: LearningExperience,
  now: string,
  reason: LearningLifecycleReason,
  status: 'retracted' | 'expired',
): LearningResult<LearningExperience> {
  if (record.status !== 'admitted') {
    return { ok: false, code: 'not-admitted', reason: `only admitted records can end, not ${record.status}` }
  }
  if (instantMs(now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...record,
      // The lesson text is destroyed, not flagged. Everything else is kept, because
      // "this was learned and then withdrawn" is an answer this domain owes after a
      // restart, and a record that vanished would answer "nothing was ever learned".
      lesson: '',
      status: status as LearningStatus,
      lifecycleAt: now,
      lifecycleReason: reason,
    }),
  }
}

/* -------------------------------------------------------------- knowledge */

export const KNOWLEDGE_INPUT_KEYS: readonly string[] = [
  'knowledgeId',
  'kind',
  'claim',
  'scope',
  'scopeLimits',
  'tags',
  'supports',
  'verificationIds',
  'observedAt',
  'proposedConfidence',
  'actor',
]

export const KNOWLEDGE_KEYS: readonly string[] = [
  'knowledgeId',
  'kind',
  'claim',
  'scope',
  'scopeLimits',
  'supports',
  'verificationIds',
  'tags',
  'provenance',
  'confidence',
  'status',
  'admittedAt',
  'admissionReason',
  'lifecycleAt',
  'lifecycleReason',
]

/**
 * Construct a knowledge record from one or more distilled experiences.
 *
 * The three refusals that carry the phase:
 *
 * - `distilled-source-forbidden` — a model, a page or a document cannot become learning.
 *   They may be *recorded* as an experience the owner can read; they cannot be distilled
 *   into a claim that later phases will act on.
 * - `no-supporting-experience` / `no-verification-evidence` — a claim with no admitted
 *   experience behind it, or with no verification id behind that, is refused whole. It is
 *   not stored at lower confidence, because a fabricated lesson stored politely is still a
 *   fabricated lesson.
 * - `too-generic` — a claim whose words promise more than its scope permits.
 */
export function createKnowledgeRecord(input: unknown, source: SourceTrust): LearningResult<KnowledgeRecord> {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'not-an-object', reason: 'a knowledge record input must be an object' }
  }

  const forbidden = forbiddenFieldNames(input)
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden-field-refused',
      reason: `the claim carries field(s) learning may not hold: [${forbidden.join(', ')}]`,
    }
  }

  if (!hasExactKeys(input, KNOWLEDGE_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...KNOWLEDGE_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `knowledge record keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }

  if (!isBoundedLearningText(input.knowledgeId, LEARNING_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'knowledgeId must be a non-empty bounded string' }
  }
  if (!isLearningKnowledgeKind(input.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'kind is not in the closed knowledge vocabulary' }
  }
  if (!isBoundedLearningText(input.claim, LEARNING_LIMITS.maxClaimChars)) {
    return { ok: false, code: 'invalid-claim', reason: 'claim must be a non-empty bounded string' }
  }
  const secretShape = findSecretShape(input.claim)
  if (secretShape !== null) {
    return {
      ok: false,
      code: 'invalid-claim',
      reason: `the claim is secret-shaped (${secretShape}) and was refused whole rather than redacted`,
    }
  }
  const overclaims = findOverclaimMarkers(input.claim)
  if (overclaims.length > 0) {
    return {
      ok: false,
      code: 'too-generic',
      reason: `the claim overclaims: [${overclaims.join(', ')}]. A claim generalises from checked evidence; it does not promise.`,
    }
  }
  if (!isLearningScope(input.scope)) {
    return { ok: false, code: 'invalid-scope', reason: 'scope is not in the closed learning vocabulary' }
  }
  const scopeCheck = checkScopeLimits(input.scopeLimits, input.scope)
  if (!scopeCheck.ok) return scopeCheck
  if (!isValidTags(input.tags)) {
    return { ok: false, code: 'invalid-tags', reason: 'tags must be bounded opaque labels' }
  }
  if (!Array.isArray(input.supports) || input.supports.length === 0) {
    return {
      ok: false,
      code: 'no-supporting-experience',
      reason: 'a knowledge record must name at least one distilled experience',
    }
  }
  if (input.supports.length > LEARNING_LIMITS.maxSupports) {
    return { ok: false, code: 'invalid-evidence-refs', reason: 'too many supporting experiences' }
  }
  if (!input.supports.every((support) => isLearningRef(support))) {
    return { ok: false, code: 'invalid-evidence-refs', reason: 'supports must be bounded opaque ids' }
  }
  if (!Array.isArray(input.verificationIds) || input.verificationIds.length === 0) {
    return {
      ok: false,
      code: 'no-verification-evidence',
      reason: 'a knowledge record must name at least one verification id behind its experiences',
    }
  }
  if (input.verificationIds.length > LEARNING_LIMITS.maxEvidenceRefs) {
    return { ok: false, code: 'invalid-evidence-refs', reason: 'too many verification ids' }
  }
  if (!input.verificationIds.every((id) => isLearningRef(id))) {
    return { ok: false, code: 'invalid-evidence-refs', reason: 'verificationIds must be bounded opaque ids' }
  }
  if (instantMs(input.observedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'observedAt must parse as an instant' }
  }
  if (!isBoundedLearningText(input.actor, LEARNING_LIMITS.maxActorChars)) {
    return { ok: false, code: 'invalid-actor', reason: 'actor must be a non-empty bounded string' }
  }
  if (!Object.prototype.hasOwnProperty.call(LEARNING_CEILING, source)) {
    return { ok: false, code: 'invalid-source', reason: 'source must be a known trust class assigned by the pathway' }
  }
  if (!(LEARNING_DISTILLED_SOURCES as readonly string[]).includes(source)) {
    return {
      ok: false,
      code: 'distilled-source-forbidden',
      reason: `a ${source} claim may not be distilled into learning; only a checked outcome, an observation or the owner may`,
    }
  }

  const proposed = input.proposedConfidence
  if (typeof proposed !== 'string') {
    return { ok: false, code: 'invalid-confidence', reason: 'proposedConfidence must be a confidence category' }
  }
  const ceiling = LEARNING_CEILING[source]
  const confidence = capLearningConfidence(proposed as Confidence, ceiling.confidence)
  if (confidence !== proposed) {
    return {
      ok: false,
      code: 'confidence-ceiling',
      reason: `a ${source} claim may not carry confidence '${proposed}'; a learning claim is capped at '${ceiling.confidence}'`,
    }
  }

  const provenance: Provenance = Object.freeze({
    sourceType: source,
    sourceRef: input.supports[0] as string,
    observedAt: input.observedAt as string,
    recordedAt: input.observedAt as string,
    actor: input.actor as string,
    verificationStatus: ceiling.epistemic,
    confidence,
    evidenceSummary: null,
  })

  return {
    ok: true,
    value: Object.freeze({
      knowledgeId: input.knowledgeId as string,
      kind: input.kind as LearningKnowledgeKind,
      claim: input.claim as string,
      scope: input.scope,
      scopeLimits: Object.freeze([...(input.scopeLimits as readonly LearningScopeLimit[])]),
      supports: Object.freeze([...(input.supports as readonly string[])]),
      verificationIds: Object.freeze([...(input.verificationIds as readonly string[])]),
      tags: Object.freeze([...(input.tags as readonly string[])]),
      provenance,
      confidence,
      status: 'candidate' as LearningStatus,
      admittedAt: null,
      admissionReason: null,
      lifecycleAt: null,
      lifecycleReason: null,
    }),
  }
}

export function admitKnowledgeRecord(
  candidate: KnowledgeRecord,
  decision: { now: string; reason: string },
): LearningResult<KnowledgeRecord> {
  if (candidate.status !== 'candidate') {
    return { ok: false, code: 'not-candidate', reason: `only candidates can be admitted, not ${candidate.status}` }
  }
  const instant = checkDecision(decision)
  if (!instant.ok) return instant
  return {
    ok: true,
    value: Object.freeze({
      ...candidate,
      status: 'admitted' as LearningStatus,
      admittedAt: decision.now,
      admissionReason: decision.reason,
    }),
  }
}

export function rejectKnowledgeRecord(
  candidate: KnowledgeRecord,
  decision: { now: string; reason: string },
): LearningResult<KnowledgeRecord> {
  if (candidate.status !== 'candidate') {
    return { ok: false, code: 'not-candidate', reason: `only candidates can be rejected, not ${candidate.status}` }
  }
  const instant = checkDecision(decision)
  if (!instant.ok) return instant
  return {
    ok: true,
    value: Object.freeze({
      ...candidate,
      status: 'rejected' as LearningStatus,
      admissionReason: decision.reason,
      lifecycleAt: decision.now,
      lifecycleReason: 'owner-rejected-this-record' as LearningLifecycleReason,
    }),
  }
}

export function supersedeKnowledgeRecord(
  record: KnowledgeRecord,
  decision: { now: string; supersedes: string },
): LearningResult<KnowledgeRecord> {
  if (record.status !== 'admitted') {
    return { ok: false, code: 'not-admitted', reason: `only admitted records can be superseded, not ${record.status}` }
  }
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  if (!isBoundedLearningText(decision.supersedes, LEARNING_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'the superseding id must be a bounded non-empty string' }
  }
  if (decision.supersedes === record.knowledgeId) {
    return { ok: false, code: 'self-supersession', reason: 'a record cannot supersede itself' }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...record,
      status: 'superseded' as LearningStatus,
      lifecycleAt: decision.now,
      lifecycleReason: 'superseded-by-a-newer-record' as LearningLifecycleReason,
    }),
  }
}

/** Retract a claim. The claim text is destroyed; the record of it survives. */
export function retractKnowledgeRecord(
  record: KnowledgeRecord,
  decision: { now: string },
): LearningResult<KnowledgeRecord> {
  return terminateKnowledge(record, decision.now, 'owner-withdrew-this-record', 'retracted')
}

export function expireKnowledgeRecord(
  record: KnowledgeRecord,
  decision: {
    now: string
    reason: Extract<LearningLifecycleReason, 'retention-bound-reached' | 'stale-record-expired'>
  },
): LearningResult<KnowledgeRecord> {
  if (decision.reason !== 'retention-bound-reached' && decision.reason !== 'stale-record-expired') {
    return {
      ok: false,
      code: 'illegal-lifecycle-reason',
      reason: 'the expiry reason must be one of the two expiry labels',
    }
  }
  return terminateKnowledge(record, decision.now, decision.reason, 'expired')
}

function terminateKnowledge(
  record: KnowledgeRecord,
  now: string,
  reason: LearningLifecycleReason,
  status: 'retracted' | 'expired',
): LearningResult<KnowledgeRecord> {
  if (record.status !== 'admitted') {
    return { ok: false, code: 'not-admitted', reason: `only admitted records can end, not ${record.status}` }
  }
  if (instantMs(now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...record,
      claim: '',
      status: status as LearningStatus,
      lifecycleAt: now,
      lifecycleReason: reason,
    }),
  }
}

/* ------------------------------------------------------------- internals */

/**
 * Scope and scope limits must agree, and no claim may omit that it promises nothing.
 *
 * Two rules, both mechanical:
 *
 * - **`no-future-guarantee` is required on every record.** A learning claim describes what
 *   was observed, so it says nothing about what will happen. Making that mandatory means
 *   there is no way to record a lesson without also recording that it does not predict,
 *   and no downstream reader can read the claim without reading that too.
 * - **the scope's own limit must be present, and must not be contradicted.** A record
 *   scoped `one-instance` that omits `observed-once`, or one scoped
 *   `repeated-observations` that still carries `observed-once`, is refused. Either way the
 *   record is claiming something about its own evidence that the rest of it denies, and a
 *   claim that disagrees with its own limits is worse than no claim.
 */
export function checkScopeLimits(
  value: unknown,
  scope?: LearningScope,
): { ok: true } | { ok: false; code: string; reason: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      code: 'missing-scope-limits',
      reason: 'a learning record must say where it stops: scopeLimits is required and may not be empty',
    }
  }
  if (!value.every((limit) => isLearningScopeLimit(limit))) {
    return {
      ok: false,
      code: 'invalid-scope-limits',
      reason: 'every scopeLimit must be one of the closed labels',
    }
  }
  const limits = new Set(value as readonly LearningScopeLimit[])
  if (!limits.has('no-future-guarantee')) {
    return {
      ok: false,
      code: 'missing-scope-limits',
      reason: "every learning record must carry 'no-future-guarantee': a claim describes what was observed, not what will happen",
    }
  }
  if (scope === undefined) return { ok: true }
  if (!isLearningScope(scope)) {
    return {
      ok: false,
      code: 'invalid-scope',
      reason: 'scope is not in the closed learning vocabulary, so its limits cannot be checked against it',
    }
  }
  if (scope === 'one-instance' && !limits.has('observed-once')) {
    return {
      ok: false,
      code: 'invalid-scope-limits',
      reason: "a record scoped 'one-instance' must carry 'observed-once'",
    }
  }
  if (scope === 'one-environment' && !limits.has('observed-in-one-environment')) {
    return {
      ok: false,
      code: 'invalid-scope-limits',
      reason: "a record scoped 'one-environment' must carry 'observed-in-one-environment'",
    }
  }
  if (scope === 'repeated-observations' && limits.has('observed-once')) {
    return {
      ok: false,
      code: 'invalid-scope-limits',
      reason: "a record scoped 'repeated-observations' cannot also carry 'observed-once'",
    }
  }
  return { ok: true }
}

function checkDecision(
  decision: { now: string; reason: string },
): { ok: true } | { ok: false; code: string; reason: string } {
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  if (!isBoundedLearningText(decision.reason, LEARNING_LIMITS.maxReasonChars)) {
    return {
      ok: false,
      code: 'invalid-claim',
      reason: 'the decision reason must be a non-empty bounded string',
    }
  }
  return { ok: true }
}

/** Whole days between two instants, floored, never negative. */
export function wholeDays(fromMs: number, toMs: number): number {
  const ms = toMs - fromMs
  if (ms <= 0) return 0
  return Math.floor(ms / 86_400_000)
}

/** Whether an outcome is recent enough to support a proposal today. */
export function outcomeIsCurrent(establishedAtMs: number, nowMs: number): boolean {
  return wholeDays(establishedAtMs, nowMs) <= LEARNING_PROPOSAL_THRESHOLDS.maxEvidenceAgeDays
}

/** Re-exported for the fold, which needs the two shape lists and nothing else. */
export type { LearningScope }
