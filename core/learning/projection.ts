import {
  LEARNING_SCHEMA_VERSION,
  type LearningClaimDetailView,
  type LearningClaimReadOutcome,
  type LearningCountsView,
  type LearningExportItemView,
  type LearningExportOutcome,
  type LearningPersistenceView,
  type LearningProjection,
  type LearningProposalView,
  type LearningRecordView,
  type LearningRecordsOutcome,
} from '../protocol/learning'
import { deriveLearning } from './derive'
import {
  LEARNING_LIMITS,
  type KnowledgeRecord,
  type LearningExperience,
  type LearningProposalSummary,
  type LearningState,
} from './types'

export {
  ABSENT_LEARNING_PROJECTION,
  LEARNING_SCHEMA_VERSION,
  NO_LEARNING_DOMAIN_REASON,
} from '../protocol/learning'

/**
 * THE LEARNING PROJECTION — Core's only route from learning facts to a window.
 *
 * A pure function over the folded state, the store's health and one explicit `now`. It
 * exists so the vocabulary a renderer receives is *derived* rather than assembled: the
 * domain supplies values and this file decides, in one testable place, which fields may
 * cross and which may not.
 *
 * ## The two rules it enforces
 *
 * 1. **No text in a broad read.** `projectLearningRecords` emits `textLength`, never the
 *    lesson or the claim. The single-record read is the only route to a claim's own words,
 *    it is owner-only by construction, and it is separately bounded.
 * 2. **Nothing is invented and nothing is resolved.** A conflicted support is disclosed as
 *    conflicted. A below-threshold proposal is reported with its reason rather than
 *    dropped. A retracted record appears as `retracted` with `textLength: 0`, which is the
 *    honest answer to "what does Freya still hold here" — not as absent, because absent
 *    would answer "she never learned it".
 */

export interface LearningProjectionInput {
  readonly state: LearningState
  readonly persistence: LearningPersistenceView
  readonly now: string
}

/** Turn the derivation plus persistence health into the projection a window holds. */
export function projectLearning(input: LearningProjectionInput): LearningProjection {
  const derivation = deriveLearning(input.state, input.now)
  return Object.freeze({
    schemaVersion: LEARNING_SCHEMA_VERSION,
    mode: 'available' as const,
    counts: freezeCounts(derivation.counts),
    conflictedClaims: [...derivation.conflictedClaims].slice(0, LEARNING_LIMITS.maxProjectionRecords),
    strongestScope: derivation.strongestScope,
    proposals: derivation.proposals.map(projectProposal),
    // Constants. Rendered so the guarantee can be shown rather than merely respected.
    authority: derivation.authority,
    confidenceCeiling: derivation.confidenceCeiling,
    persistence: Object.freeze({ ...input.persistence }),
  })
}

function freezeCounts(counts: {
  outcomes: number
  experiences: number
  knowledge: number
  candidates: number
  retracted: number
  superseded: number
  expired: number
  rejected: number
  evidenced: number
  byExperienceKind: Readonly<Record<string, number>>
  byKnowledgeKind: Readonly<Record<string, number>>
}): LearningCountsView {
  return Object.freeze({
    outcomes: counts.outcomes,
    experiences: counts.experiences,
    knowledge: counts.knowledge,
    candidates: counts.candidates,
    retracted: counts.retracted,
    superseded: counts.superseded,
    expired: counts.expired,
    rejected: counts.rejected,
    evidenced: counts.evidenced,
    byExperienceKind: Object.freeze({ ...counts.byExperienceKind }) as LearningCountsView['byExperienceKind'],
    byKnowledgeKind: Object.freeze({ ...counts.byKnowledgeKind }) as LearningCountsView['byKnowledgeKind'],
  })
}

function projectProposal(proposal: LearningProposalSummary): LearningProposalView {
  return Object.freeze({
    proposalId: proposal.proposalId,
    name: proposal.name,
    // The step *summaries* are claims, so only their count crosses.
    stepCount: proposal.stepCount,
    knowledgeIds: proposal.knowledgeIds,
    experienceIds: proposal.experienceIds,
    distinctVerifications: proposal.distinctVerifications,
    failedOutcomes: proposal.failedOutcomes,
    scope: proposal.scope,
    scopeLimits: proposal.scopeLimits,
    confidence: proposal.confidence,
    support: proposal.support,
    grantsCapability: proposal.grantsCapability,
    executable: proposal.executable,
    authority: proposal.authority,
  })
}

/**
 * A broad read of the pipeline. Metadata only.
 *
 * Outcomes first, then experiences, then claims; newest-observed first within each, then
 * id, so two windows cannot disagree about which record is "current" because of insertion
 * accidents.
 */
export function projectLearningRecords(
  state: LearningState,
  options: { limit?: number; stage?: 'experience' | 'knowledge' } = {},
): LearningRecordsOutcome {
  const records: LearningRecordView[] = [
    ...[...state.experiences.values()].map((entry) => projectExperience(entry)),
    ...[...state.knowledge.values()].map((entry) => projectKnowledge(entry)),
  ]
  const filtered = options.stage === undefined ? records : records.filter((item) => item.stage === options.stage)
  const ordered = filtered.sort(observedThenId)
  const requested = options.limit ?? LEARNING_LIMITS.maxProjectionRecords
  // A caller may lower the bound and never raise it above the domain limit.
  const limit = Math.max(0, Math.min(requested, LEARNING_LIMITS.maxProjectionRecords))
  const shown = ordered.slice(0, limit)
  const outcomes = [...state.outcomes.values()]
    .sort((a, b) => b.establishedAt.localeCompare(a.establishedAt) || a.outcomeId.localeCompare(b.outcomeId))
    .slice(0, limit)
    .map((outcome) =>
      Object.freeze({
        outcomeId: outcome.outcomeId,
        sourceDomain: outcome.sourceDomain,
        verificationId: outcome.verificationId,
        verifierId: outcome.verifierId,
        subjectRef: outcome.subjectRef,
        result: outcome.result,
        establishedAt: outcome.establishedAt,
        checkedLength: outcome.checked.length,
      }),
    )
  return {
    ok: true,
    records: Object.freeze({
      outcomes: Object.freeze(outcomes),
      items: Object.freeze(shown),
      truncated: shown.length < ordered.length || outcomes.length < state.outcomes.size,
      total: ordered.length + state.outcomes.size,
      schemaVersion: LEARNING_SCHEMA_VERSION,
    }),
    reason: null,
  }
}

function projectExperience(entry: LearningExperience): LearningRecordView {
  return Object.freeze({
    recordId: entry.experienceId,
    stage: 'experience' as const,
    kind: entry.kind,
    status: entry.status,
    sourceDomain: entry.sourceDomain,
    sourceType: entry.provenance.sourceType,
    actor: entry.provenance.actor,
    confidence: entry.provenance.confidence,
    verificationStatus: entry.provenance.verificationStatus,
    scope: entry.scope,
    scopeLimits: entry.scopeLimits,
    tags: entry.tags,
    supportCount: 1,
    verificationCount: entry.evidenceRefs.length,
    observedAt: entry.provenance.observedAt,
    recordedAt: entry.provenance.recordedAt,
    admittedAt: entry.admittedAt,
    lifecycleAt: entry.lifecycleAt,
    lifecycleReason: entry.lifecycleReason,
    textLength: entry.lesson.length,
  })
}

function projectKnowledge(record: KnowledgeRecord): LearningRecordView {
  return Object.freeze({
    recordId: record.knowledgeId,
    stage: 'knowledge' as const,
    kind: record.kind,
    status: record.status,
    sourceDomain: 'system' as const,
    sourceType: record.provenance.sourceType,
    actor: record.provenance.actor,
    confidence: record.confidence,
    verificationStatus: record.provenance.verificationStatus,
    scope: record.scope,
    scopeLimits: record.scopeLimits,
    tags: record.tags,
    supportCount: record.supports.length,
    verificationCount: record.verificationIds.length,
    observedAt: record.provenance.observedAt,
    recordedAt: record.provenance.recordedAt,
    admittedAt: record.admittedAt,
    lifecycleAt: record.lifecycleAt,
    lifecycleReason: record.lifecycleReason,
    textLength: record.claim.length,
  })
}

function observedThenId(a: LearningRecordView, b: LearningRecordView): number {
  const byObserved = b.observedAt.localeCompare(a.observedAt)
  if (byObserved !== 0) return byObserved
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0
}

/**
 * The one read that carries a claim's own words.
 *
 * Owner-only by construction: the only route here is a Core method the owner principal
 * holds, and a renderer cannot invoke one. Bounded by `recordId` and by the record limit,
 * so it cannot become a bulk export through repetition.
 */
export function projectLearningClaim(
  state: LearningState,
  recordId: unknown,
): LearningClaimReadOutcome {
  if (typeof recordId !== 'string' || recordId.length === 0 || recordId.length > LEARNING_LIMITS.maxIdChars) {
    return { ok: false, code: 'invalid-id', reason: 'recordId must be a non-empty bounded string' }
  }
  const record = state.knowledge.get(recordId)
  if (record === undefined) {
    return { ok: false, code: 'no-such-record', reason: 'that knowledge record does not exist' }
  }
  const detail: LearningClaimDetailView = {
    recordId: record.knowledgeId,
    stage: 'knowledge',
    kind: record.kind,
    claim: record.claim,
    scope: record.scope,
    scopeLimits: record.scopeLimits,
    supports: [...record.supports],
    verificationIds: [...record.verificationIds],
    status: record.status,
    sourceType: record.provenance.sourceType,
    confidence: record.confidence,
    observedAt: record.provenance.observedAt,
    admittedAt: record.admittedAt,
    lifecycleAt: record.lifecycleAt,
    lifecycleReason: record.lifecycleReason,
    tags: [...record.tags],
    // A destroyed claim reads as destroyed rather than as empty, because "she claimed this
    // and then withdrew it" and "she never claimed it" are different answers.
    textDestroyed: record.claim.length === 0 && record.status !== 'rejected',
  }
  return { ok: true, claim: Object.freeze(detail), reason: null }
}

/** The owner's export: bounded, text-carrying, and honest about what the bound excluded. */
export function exportLearning(
  state: LearningState,
  persistence: LearningPersistenceView,
): LearningExportOutcome {
  const all: LearningExportItemView[] = [
    ...[...state.experiences.values()]
      .sort((a, b) => a.provenance.observedAt.localeCompare(b.provenance.observedAt) || a.experienceId.localeCompare(b.experienceId))
      .map((entry) => ({
        recordId: entry.experienceId,
        stage: 'experience' as const,
        kind: entry.kind,
        text: entry.lesson,
        status: entry.status,
        scope: entry.scope,
        scopeLimits: entry.scopeLimits,
        supports: [entry.outcomeId],
        verificationIds: [...entry.evidenceRefs],
        sourceType: entry.provenance.sourceType,
        confidence: entry.provenance.confidence,
        observedAt: entry.provenance.observedAt,
        recordedAt: entry.provenance.recordedAt,
        admittedAt: entry.admittedAt,
        lifecycleAt: entry.lifecycleAt,
        lifecycleReason: entry.lifecycleReason,
        tags: [...entry.tags],
      })),
    ...[...state.knowledge.values()]
      .sort((a, b) => a.provenance.observedAt.localeCompare(b.provenance.observedAt) || a.knowledgeId.localeCompare(b.knowledgeId))
      .map((record) => ({
        recordId: record.knowledgeId,
        stage: 'knowledge' as const,
        kind: record.kind,
        text: record.claim,
        status: record.status,
        scope: record.scope,
        scopeLimits: record.scopeLimits,
        supports: [...record.supports],
        verificationIds: [...record.verificationIds],
        sourceType: record.provenance.sourceType,
        confidence: record.confidence,
        observedAt: record.provenance.observedAt,
        recordedAt: record.provenance.recordedAt,
        admittedAt: record.admittedAt,
        lifecycleAt: record.lifecycleAt,
        lifecycleReason: record.lifecycleReason,
        tags: [...record.tags],
      })),
  ]
  const shown = all.slice(0, LEARNING_LIMITS.maxProjectionRecords * 2)
  return {
    ok: true,
    export: Object.freeze({
      schemaVersion: LEARNING_SCHEMA_VERSION,
      items: Object.freeze(shown),
      total: all.length,
      withheld: all.length - shown.length,
      persistence: Object.freeze({ ...persistence }),
    }),
    reason: null,
  }
}