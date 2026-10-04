/**
 * REBUILDING A LEARNING RECORD FROM STORAGE.
 *
 * Read-rebuild, never read-trust. A row that arrived from the Vault is reconstructed from
 * its own recorded fields and every construction rule is re-applied: the confidence is
 * re-capped against the source class it names, the evidence rule is re-checked, the scope
 * limits are re-validated against the scope, and a destroyed-text record must actually have
 * lost its text.
 *
 * This is what makes a hand-edited row unable to become a stronger claim than the one that
 * was written. The alternative — trusting the stored shape — would mean a row edited to
 * `confidence: 'verified'`, or to drop its `supports`, or to gain a `capability` field, is
 * believed on the next start.
 *
 * Each rebuild **re-derives** the epistemic label from the source class rather than reading
 * it from the row, so a record whose source was edited is brought back to an internally
 * consistent pair instead of being believed.
 */

import type { Confidence, Provenance, SourceTrust } from '../brain/types'
import {
  EXPERIENCE_KEYS,
  KNOWLEDGE_KEYS,
  checkScopeLimits,
  type LearningResult,
} from './experience'
import {
  LEARNING_CEILING,
  LEARNING_LIMITS,
  capLearningConfidence,
  instantMs,
  isForbiddenLearningFieldName,
  isLearningExperienceKind,
  isLearningKnowledgeKind,
  isLearningLifecycleReason,
  isLearningRef,
  isLearningScope,
  isLearningStatus,
  isLearningLifecycleConsistent,
  type KnowledgeRecord,
  type LearningExperience,
  type LearningExperienceKind,
  type LearningKnowledgeKind,
  type LearningLifecycleReason,
  type LearningScope,
  type LearningScopeLimit,
  type LearningStatus,
} from './types'
import { hasExactKeys } from '../hands/validation'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isValidTags(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > LEARNING_LIMITS.maxTags) return false
  return value.every((tag) => isLearningRef(tag) && tag.length <= LEARNING_LIMITS.maxTagChars)
}

function isValidRefs(value: unknown, max: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length > max) return false
  return value.every((ref) => isLearningRef(ref))
}

/** The trust class a stored record names, or a refusal when it names an unknown one. */
function sourceOf(provenance: unknown): SourceTrust | null {
  if (!isPlainObject(provenance)) return null
  const source = provenance.sourceType
  if (typeof source !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(LEARNING_CEILING, source)) return null
  return source as SourceTrust
}

/** Rebuild the provenance rather than believing the stored one. */
function rebuiltProvenance(provenance: Record<string, unknown>, source: SourceTrust): Provenance | null {
  if (instantMs(provenance.observedAt) === null) return null
  if (instantMs(provenance.recordedAt) === null) return null
  if (!isBoundedText(provenance.actor, LEARNING_LIMITS.maxActorChars)) return null
  if (!isLearningRef(provenance.sourceRef)) return null
  if (provenance.evidenceSummary !== null && typeof provenance.evidenceSummary !== 'string') return null
  const ceiling = LEARNING_CEILING[source]
  return Object.freeze({
    sourceType: source,
    sourceRef: provenance.sourceRef,
    observedAt: provenance.observedAt as string,
    recordedAt: provenance.recordedAt as string,
    actor: provenance.actor as string,
    // Re-derived. A row cannot claim `verified` by writing it down.
    verificationStatus: ceiling.epistemic,
    confidence: 'unknown' as Confidence,
    evidenceSummary: (provenance.evidenceSummary as string | null) ?? null,
  })
}

/** Lifecycle fields carried across a rebuild, validated against the closed table. */
function lifecycleOf(
  stored: Record<string, unknown>,
  status: LearningStatus,
): { ok: true; value: { at: string | null; reason: LearningLifecycleReason | null } } | { ok: false; reason: string } {
  const at = stored.lifecycleAt
  const reason = stored.lifecycleReason
  if (at !== null && instantMs(at) === null) {
    return { ok: false, reason: 'a stored lifecycle instant does not parse' }
  }
  if (reason !== null && !isLearningLifecycleReason(reason)) {
    return { ok: false, reason: 'a stored lifecycle reason is outside the closed vocabulary' }
  }
  if (!isLearningLifecycleConsistent(status, at as string | null, reason as LearningLifecycleReason | null)) {
    return { ok: false, reason: `a stored ${status} record has an inconsistent lifecycle reason` }
  }
  return { ok: true, value: { at: (at as string | null) ?? null, reason: (reason as LearningLifecycleReason | null) ?? null } }
}

function admissionOf(
  stored: Record<string, unknown>,
  status: LearningStatus,
): { ok: true; value: { at: string | null; reason: string | null } } | { ok: false; reason: string } {
  const at = stored.admittedAt
  const reason = stored.admissionReason
  if (status === 'candidate' && (at !== null || reason !== null)) {
    return { ok: false, reason: 'a stored candidate must not carry an admission' }
  }
  if (status !== 'candidate' && (at === null || reason === null)) {
    return { ok: false, reason: `a stored ${status} record must carry its admission instant and reason` }
  }
  if (at !== null && instantMs(at) === null) {
    return { ok: false, reason: 'a stored admission instant does not parse' }
  }
  if (reason !== null && !isBoundedText(reason, LEARNING_LIMITS.maxReasonChars)) {
    return { ok: false, reason: 'a stored admission reason is outside the bound' }
  }
  return { ok: true, value: { at: (at as string | null) ?? null, reason: (reason as string | null) ?? null } }
}

/** Rebuild a distilled experience. Used by the fold on read, and by nothing else. */
export function rebuildLearningExperience(stored: unknown): LearningResult<LearningExperience> {
  if (!isPlainObject(stored)) {
    return { ok: false, code: 'not-an-object', reason: 'a stored experience is not an object' }
  }
  for (const name of Object.keys(stored)) {
    if (isForbiddenLearningFieldName(name)) {
      return {
        ok: false,
        code: 'forbidden-field-refused',
        reason: `a stored experience carries a field learning may not hold: ${name}`,
      }
    }
  }
  if (!hasExactKeys(stored, EXPERIENCE_KEYS)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored experience does not have the exact recorded shape' }
  }
  if (!isLearningStatus(stored.status)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored experience named an unknown status' }
  }
  const status = stored.status
  const destroyed = status === 'retracted' || status === 'expired'
  // A destroyed record must actually be destroyed. Accepting a stored `retracted` row that
  // still carries its lesson would be a way to keep withdrawn text in the Vault.
  if (destroyed && stored.lesson !== '') {
    return { ok: false, code: 'invalid-record', reason: `a ${status} experience must not retain its lesson` }
  }
  if (!destroyed && !isBoundedText(stored.lesson, LEARNING_LIMITS.maxLessonChars)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored experience has a malformed lesson' }
  }
  if (!isBoundedText(stored.experienceId, LEARNING_LIMITS.maxIdChars) || !isLearningRef(stored.outcomeId)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored experience has malformed ids' }
  }
  if (!isLearningExperienceKind(stored.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'a stored experience has an unknown kind' }
  }
  if (!isLearningScope(stored.scope)) {
    return { ok: false, code: 'invalid-scope', reason: 'a stored experience has an unknown scope' }
  }
  const scopeCheck = checkScopeLimits(stored.scopeLimits, stored.scope)
  if (!scopeCheck.ok) return scopeCheck
  if (!isValidTags(stored.tags) || !isValidRefs(stored.evidenceRefs, LEARNING_LIMITS.maxEvidenceRefs)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored experience has malformed tags or evidence' }
  }
  if (!isLearningRef(stored.outcomeId) || !stored.evidenceRefs.includes(stored.outcomeId)) {
    return {
      ok: false,
      code: 'no-verification-evidence',
      reason: 'a stored experience must carry its outcomeId among its evidence references',
    }
  }

  const source = sourceOf(stored.provenance)
  if (source === null) {
    return { ok: false, code: 'invalid-source', reason: 'a stored experience has an unknown trust class' }
  }
  const raw = stored.provenance as Record<string, unknown>
  const provenance = rebuiltProvenance(raw, source)
  if (provenance === null) {
    return { ok: false, code: 'invalid-record', reason: 'a stored experience has malformed provenance' }
  }
  const confidence = capLearningConfidence(raw.confidence as Confidence, LEARNING_CEILING[source].confidence)
  if (confidence !== raw.confidence) {
    return {
      ok: false,
      code: 'confidence-ceiling',
      reason: `a stored ${source} experience may not carry confidence '${String(raw.confidence)}'`,
    }
  }

  const admission = admissionOf(stored, status)
  if (!admission.ok) return { ok: false, code: 'invalid-record', reason: admission.reason }
  const lifecycle = lifecycleOf(stored, status)
  if (!lifecycle.ok) return { ok: false, code: 'invalid-record', reason: lifecycle.reason }

  return {
    ok: true,
    value: Object.freeze({
      experienceId: stored.experienceId as string,
      outcomeId: stored.outcomeId as string,
      kind: stored.kind as LearningExperienceKind,
      sourceDomain: stored.sourceDomain as LearningExperience['sourceDomain'],
      lesson: stored.lesson as string,
      scope: stored.scope as LearningScope,
      scopeLimits: Object.freeze([...(stored.scopeLimits as readonly LearningScopeLimit[])]),
      tags: Object.freeze([...(stored.tags as readonly string[])]),
      provenance: Object.freeze({ ...provenance, confidence }),
      evidenceRefs: Object.freeze([...(stored.evidenceRefs as readonly string[])]),
      status,
      admittedAt: admission.value.at,
      admissionReason: admission.value.reason,
      lifecycleAt: lifecycle.value.at,
      lifecycleReason: lifecycle.value.reason,
    }),
  }
}

/** Rebuild a knowledge record. Used by the fold on read, and by nothing else. */
export function rebuildKnowledgeRecord(stored: unknown): LearningResult<KnowledgeRecord> {
  if (!isPlainObject(stored)) {
    return { ok: false, code: 'not-an-object', reason: 'a stored knowledge record is not an object' }
  }
  for (const name of Object.keys(stored)) {
    if (isForbiddenLearningFieldName(name)) {
      return {
        ok: false,
        code: 'forbidden-field-refused',
        reason: `a stored knowledge record carries a field learning may not hold: ${name}`,
      }
    }
  }
  if (!hasExactKeys(stored, KNOWLEDGE_KEYS)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored knowledge record does not have the exact recorded shape' }
  }
  if (!isLearningStatus(stored.status)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored knowledge record named an unknown status' }
  }
  const status = stored.status
  const destroyed = status === 'retracted' || status === 'expired'
  if (destroyed && stored.claim !== '') {
    return { ok: false, code: 'invalid-record', reason: `a ${status} claim must not retain its text` }
  }
  if (!destroyed && !isBoundedText(stored.claim, LEARNING_LIMITS.maxClaimChars)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored knowledge record has a malformed claim' }
  }
  if (!isBoundedText(stored.knowledgeId, LEARNING_LIMITS.maxIdChars)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored knowledge record has a malformed id' }
  }
  if (!isLearningKnowledgeKind(stored.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'a stored knowledge record has an unknown kind' }
  }
  if (!isLearningScope(stored.scope)) {
    return { ok: false, code: 'invalid-scope', reason: 'a stored knowledge record has an unknown scope' }
  }
  const scopeCheck = checkScopeLimits(stored.scopeLimits, stored.scope)
  if (!scopeCheck.ok) return scopeCheck
  // The evidence rule, re-applied on read: a claim with no support or no verification is
  // refused even if it was written that way.
  if (!isValidRefs(stored.supports, LEARNING_LIMITS.maxSupports) || stored.supports.length === 0) {
    return {
      ok: false,
      code: 'no-supporting-experience',
      reason: 'a stored knowledge record must name at least one supporting experience',
    }
  }
  if (!isValidRefs(stored.verificationIds, LEARNING_LIMITS.maxEvidenceRefs) || stored.verificationIds.length === 0) {
    return {
      ok: false,
      code: 'no-verification-evidence',
      reason: 'a stored knowledge record must name at least one verification id',
    }
  }
  if (!isValidTags(stored.tags)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored knowledge record has malformed tags' }
  }

  const source = sourceOf(stored.provenance)
  if (source === null) {
    return { ok: false, code: 'invalid-source', reason: 'a stored knowledge record has an unknown trust class' }
  }
  const raw = stored.provenance as Record<string, unknown>
  const provenance = rebuiltProvenance(raw, source)
  if (provenance === null) {
    return { ok: false, code: 'invalid-record', reason: 'a stored knowledge record has malformed provenance' }
  }
  const ceiling = LEARNING_CEILING[source]
  const confidence = capLearningConfidence(raw.confidence as Confidence, ceiling.confidence)
  if (confidence !== raw.confidence) {
    return {
      ok: false,
      code: 'confidence-ceiling',
      reason: `a stored ${source} claim may not carry confidence '${String(raw.confidence)}'`,
    }
  }
  if (confidence === 'verified' || raw.verificationStatus === 'verified') {
    return {
      ok: false,
      code: 'confidence-ceiling',
      reason: 'a learning claim is never verified: a claim generalises beyond the checks behind it',
    }
  }

  const admission = admissionOf(stored, status)
  if (!admission.ok) return { ok: false, code: 'invalid-record', reason: admission.reason }
  const lifecycle = lifecycleOf(stored, status)
  if (!lifecycle.ok) return { ok: false, code: 'invalid-record', reason: lifecycle.reason }

  return {
    ok: true,
    value: Object.freeze({
      knowledgeId: stored.knowledgeId as string,
      kind: stored.kind as LearningKnowledgeKind,
      claim: stored.claim as string,
      scope: stored.scope as LearningScope,
      scopeLimits: Object.freeze([...(stored.scopeLimits as readonly LearningScopeLimit[])]),
      supports: Object.freeze([...(stored.supports as readonly string[])]),
      verificationIds: Object.freeze([...(stored.verificationIds as readonly string[])]),
      tags: Object.freeze([...(stored.tags as readonly string[])]),
      provenance: Object.freeze({ ...provenance, confidence }),
      confidence,
      status,
      admittedAt: admission.value.at,
      admissionReason: admission.value.reason,
      lifecycleAt: lifecycle.value.at,
      lifecycleReason: lifecycle.value.reason,
    }),
  }
}