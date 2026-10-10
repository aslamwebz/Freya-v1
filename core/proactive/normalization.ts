import {
  PROACTIVE_LIMITS,
  type NormalizedObservation,
  type ObservationClaim,
  type RawObservationInput,
  type TrustClassification,
  type VerificationStatus,
} from './types'

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

function sanitizeText(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHARACTERS, '').trim().slice(0, maxLength)
}

export function normalizeObservation(
  input: RawObservationInput,
  observationId: string,
  dedupeKey: string,
  nowIso: string,
  evidenceRef: string | null = null,
): { ok: true; observation: NormalizedObservation } | { ok: false; reason: string } {
  if (!input.sourceId || input.sourceId.trim().length === 0) {
    return { ok: false, reason: 'missing source id' }
  }
  if (!input.sourceRef || input.sourceRef.trim().length === 0) {
    return { ok: false, reason: 'missing source ref' }
  }
  if (!input.rawSummary || input.rawSummary.trim().length === 0) {
    return { ok: false, reason: 'missing raw summary' }
  }

  const cleanSummary = sanitizeText(input.rawSummary, PROACTIVE_LIMITS.maxObservationTextLength)
  const cleanSubject = input.subject ? sanitizeText(input.subject, 256) : 'unknown'
  const cleanPredicate = input.predicate ? sanitizeText(input.predicate, 256) : 'observed'
  const cleanObject = input.object ? sanitizeText(input.object, 256) : undefined

  let trust: TrustClassification = 'untrusted'
  let verificationStatus: VerificationStatus = 'unverified'

  if (input.sourceType === 'internal') {
    trust = 'verified_internal'
    verificationStatus = 'verified'
  } else if (input.sourceType === 'manual') {
    trust = 'owner_direct'
    verificationStatus = 'verified'
  } else if (input.sourceType === 'connector' || input.sourceType === 'resource_monitor') {
    trust = 'authorized_external'
    verificationStatus = 'unverified' // External claims are NEVER pre-verified!
  }

  const claim: ObservationClaim = {
    subject: cleanSubject,
    predicate: cleanPredicate,
    object: cleanObject,
    rawSummary: cleanSummary,
    details: input.details,
  }

  const observation: NormalizedObservation = {
    observationId,
    sourceType: input.sourceType,
    sourceId: sanitizeText(input.sourceId, 128),
    sourceRef: sanitizeText(input.sourceRef, 256),
    observedAt: nowIso,
    occurredAt: input.occurredAt ?? null,
    receivedAt: nowIso,
    trust,
    correlationId: input.correlationId ?? observationId,
    dedupeKey,
    goalId: input.goalId ?? null,
    milestoneId: input.milestoneId ?? null,
    missionId: input.missionId ?? null,
    evidenceRef,
    claim,
    verificationStatus,
    sensitivity: input.sensitivity ?? 'internal',
    expiresAt: input.expiresAt ?? null,
  }

  return { ok: true, observation }
}
