/**
 * FREYA PROACTIVE INTELLIGENCE — Domain Types & Contracts (Phase 6)
 *
 * Defines the core vocabulary for event awareness, observation ingestion,
 * source subscriptions, trust classification, and deduplication.
 *
 * Architectural Invariant:
 * An event can justify reconsidering work. It cannot grant permission to perform it.
 */

export const TRUST_CLASSIFICATIONS = [
  'owner_direct',
  'verified_internal',
  'authorized_external',
  'untrusted',
] as const

export type TrustClassification = (typeof TRUST_CLASSIFICATIONS)[number]

export const VERIFICATION_STATUSES = [
  'unverified',
  'pending',
  'verified',
  'rejected',
] as const

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export const SENSITIVITY_CLASSIFICATIONS = [
  'public',
  'internal',
  'confidential',
] as const

export type SensitivityClassification = (typeof SENSITIVITY_CLASSIFICATIONS)[number]

export const OBSERVATION_DROP_REASONS = [
  'duplicate',
  'expired',
  'unauthorized-source',
  'scope-mismatch',
  'rate-limit-exceeded',
  'malformed-payload',
  'stop-all-active',
] as const

export type ObservationDropReason = (typeof OBSERVATION_DROP_REASONS)[number]

/**
 * What an observation claims occurred.
 * Claims are UNTRUSTED text until proven by an independent verifier.
 */
export interface ObservationClaim {
  readonly subject: string
  readonly predicate: string
  readonly object?: string
  readonly rawSummary: string
  readonly details?: Record<string, unknown>
}

/**
 * Normalized observation representation.
 * Explicitly separates what Freya observed from what the source claims and what is verified.
 */
export interface NormalizedObservation {
  readonly observationId: string
  readonly sourceType: 'internal' | 'connector' | 'resource_monitor' | 'manual'
  readonly sourceId: string
  readonly sourceRef: string
  readonly observedAt: string
  readonly occurredAt: string | null
  readonly receivedAt: string
  readonly trust: TrustClassification
  readonly correlationId: string
  readonly dedupeKey: string
  readonly goalId: string | null
  readonly milestoneId: string | null
  readonly missionId: string | null
  readonly evidenceRef: string | null
  readonly claim: ObservationClaim
  readonly verificationStatus: VerificationStatus
  readonly sensitivity: SensitivityClassification
  readonly expiresAt: string | null
}

/**
 * Raw input provided to the ingestion engine before normalization.
 */
export interface RawObservationInput {
  readonly sourceId: string
  readonly sourceType: 'internal' | 'connector' | 'resource_monitor' | 'manual'
  readonly sourceRef: string
  readonly occurredAt?: string | null
  readonly goalId?: string | null
  readonly milestoneId?: string | null
  readonly missionId?: string | null
  readonly rawSummary: string
  readonly subject?: string
  readonly predicate?: string
  readonly object?: string
  readonly details?: Record<string, unknown>
  readonly correlationId?: string
  readonly expiresAt?: string | null
  readonly sensitivity?: SensitivityClassification
}

/**
 * Subscription authorizing external observation sources.
 */
export interface ObservationSubscription {
  readonly subscriptionId: string
  readonly sourceId: string
  readonly sourceType: string
  readonly scope: string
  readonly allowedTypes: readonly string[]
  readonly active: boolean
  readonly expiresAt: string | null
  readonly maxObservationsPerHour: number
  readonly consentGranted: boolean
  readonly registeredAt: string
}

export interface ObservationSubscriptionInput {
  readonly subscriptionId?: string
  readonly sourceId: string
  readonly sourceType: string
  readonly scope: string
  readonly allowedTypes: readonly string[]
  readonly active?: boolean
  readonly expiresAt?: string | null
  readonly maxObservationsPerHour?: number
  readonly consentGranted?: boolean
}

export const OPPORTUNITY_TYPES = [
  'goal_progress_opportunity',
  'threat_to_goal',
  'resource_unblocked',
  'stalled_work',
  'information_update',
  'scheduled_obligation',
  'unauthorized_initiative_request',
  'unclassified_noise',
] as const

export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number]

export const PROACTIVE_CANDIDATE_ACTIONS = [
  'ignore',
  'record',
  'defer',
  'notify',
  'request_approval',
  'investigate',
  'continue_existing_mission',
] as const

export type ProactiveCandidateAction = (typeof PROACTIVE_CANDIDATE_ACTIONS)[number]

export interface RelevanceAssessment {
  readonly isRelevant: boolean
  readonly opportunityType: OpportunityType
  readonly confidence: number
  readonly goalId: string | null
  readonly milestoneId: string | null
  readonly reason: string
  readonly warrantsReasoning: boolean
  readonly tokensCost: number
}

export interface ProactiveAdvisoryProposal {
  readonly significanceAssessment: string
  readonly candidateAction: ProactiveCandidateAction
  readonly justification: string
  readonly verificationCriteria: string
  readonly modelTokensUsed: number
  readonly rawModelResponse?: string
  readonly wasOverridden: boolean
  readonly overrideReason?: string
}

export interface ObservationIngestResult {
  readonly ok: boolean
  readonly observation?: NormalizedObservation
  readonly assessment?: RelevanceAssessment
  readonly proposal?: ProactiveAdvisoryProposal
  readonly reason?: string
  readonly dropCode?: ObservationDropReason
}

export const PROACTIVE_LIMITS = {
  maxDedupeHistory: 10_000,
  maxSubscriptions: 100,
  maxRecentObservations: 200,
  maxObservationTextLength: 1024,
  maxEvidenceBytes: 256 * 1024,
  defaultRateLimitPerHour: 60,
} as const
