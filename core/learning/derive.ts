/**
 * THE LEARNING DERIVATION — what Freya has learned, how well supported it is, and what
 * could responsibly become a reusable procedure.
 *
 * One pure function from a folded `LearningState` to a `LearningDerivation`. No clock
 * read, no randomness, no model, no I/O: `now` is an explicit argument, which is what makes
 * "these proposals are above threshold today" a testable claim rather than a feeling.
 *
 * ## The only interesting thing here is the support arithmetic
 *
 * A proposal is not "Freya learned something"; it is "several **distinct** checks
 * established something, none of them failed, and none of them is too old to rely on".
 * Three consequences follow directly from the code, and each is a red-team target:
 *
 * - **Repeats do not count.** Support is counted in distinct `verificationId`s and distinct
 *   `experienceId`s, so running the same thing forty times yields one piece of evidence.
 * - **A failure poisons the group.** `maxFailedOutcomes` is `0`. A procedure proposed from
 *   two successes and one failure is reported below threshold with the reason, rather than
 *   quietly proposed from the successes.
 * - **Age matters.** An outcome older than `maxEvidenceAgeDays` is counted as stale and a
 *   proposal resting only on stale evidence is below threshold, because a procedure that
 *   worked against an old version of a tool is not a procedure.
 */

import { outcomeIsCurrent } from './experience'
import { isAdmissibleProposalName } from './safeguards'
import {
  LEARNING_EXPERIENCE_KINDS,
  LEARNING_KNOWLEDGE_KINDS,
  LEARNING_LIMITS,
  LEARNING_MAX_CONFIDENCE,
  LEARNING_PROPOSAL_THRESHOLDS,
  LEARNING_SCOPES,
  instantMs,
  type Confidence,
  type KnowledgeRecord,
  type LearningDerivation,
  type LearningExperience,
  type LearningExperienceKind,
  type LearningKnowledgeKind,
  type LearningProposalSummary,
  type LearningScope,
  type LearningState,
  type ProcedureProposal,
} from './types'

/** The schema version carried on every derivation, so a stale projection is visible. */
export const LEARNING_DERIVATION_SCHEMA_VERSION = 1

/**
 * Strip a proposal's steps.
 *
 * The one place a proposal's claim text stops travelling: a derivation reports what was
 * learned and how well supported it is, and the step summaries — which are claims verbatim
 * — are for the Skills hand-off alone. `LearningProposalSummary` is the derivation's view
 * of a proposal and is what the projection carries.
 */
export function proposalSummary(proposal: ProcedureProposal): LearningProposalSummary {
  const { steps, ...rest } = proposal
  return Object.freeze({ ...rest, stepCount: steps.length })
}

function emptyExperienceCounts(): Record<LearningExperienceKind, number> {
  const counts = {} as Record<LearningExperienceKind, number>
  for (const kind of LEARNING_EXPERIENCE_KINDS) counts[kind] = 0
  return counts
}

function emptyKnowledgeCounts(): Record<LearningKnowledgeKind, number> {
  const counts = {} as Record<LearningKnowledgeKind, number>
  for (const kind of LEARNING_KNOWLEDGE_KINDS) counts[kind] = 0
  return counts
}

/**
 * Empty derivation for a Core that has learned nothing.
 *
 * `confidenceCeiling` is `medium` and `authority` is `none` even here, because those are
 * properties of the domain rather than of its contents. A surface can render "learning
 * grants nothing" before any learning exists, which is the moment it is most worth saying.
 */
export function emptyLearningDerivation(): LearningDerivation {
  return Object.freeze({
    schemaVersion: LEARNING_DERIVATION_SCHEMA_VERSION,
    counts: Object.freeze({
      outcomes: 0,
      experiences: 0,
      knowledge: 0,
      candidates: 0,
      retracted: 0,
      superseded: 0,
      expired: 0,
      rejected: 0,
      byExperienceKind: Object.freeze(emptyExperienceCounts()),
      byKnowledgeKind: Object.freeze(emptyKnowledgeCounts()),
      evidenced: 0,
    }),
    conflictedClaims: Object.freeze([]),
    strongestScope: 'one-instance' as const,
    proposals: Object.freeze([]),
    authority: 'none' as const,
    confidenceCeiling: LEARNING_MAX_CONFIDENCE,
  })
}

/** The admitted experiences only, sorted by id so two readers agree on the order. */
export function admittedExperiences(state: LearningState): readonly LearningExperience[] {
  return [...state.experiences.values()]
    .filter((entry) => entry.status === 'admitted')
    .sort((a, b) => (a.experienceId < b.experienceId ? -1 : a.experienceId > b.experienceId ? 1 : 0))
}

/** The admitted claims only. */
export function admittedKnowledge(state: LearningState): readonly KnowledgeRecord[] {
  return [...state.knowledge.values()]
    .filter((entry) => entry.status === 'admitted')
    .sort((a, b) => (a.knowledgeId < b.knowledgeId ? -1 : a.knowledgeId > b.knowledgeId ? 1 : 0))
}

/**
 * Claims whose *id* is cited by another admitted claim with a different text.
 *
 * Conflict is **disclosed, never resolved**. Choosing a winner here would be a fabricated
 * resolution; superseding is an explicit recorded act in `experience.ts`. This matches
 * PLAN.md §12: *"Conflicts remain represented rather than rewritten into certainty."*
 *
 * Two claims with the same text are **not** a conflict — that is one claim recorded twice,
 * and calling it a conflict would train an owner to distrust a projection that is merely
 * repetitive.
 */
export function conflictedClaims(state: LearningState): readonly string[] {
  const bySupport = new Map<string, Set<string>>()
  for (const record of admittedKnowledge(state)) {
    for (const support of record.supports) {
      const texts = bySupport.get(support) ?? new Set<string>()
      texts.add(record.claim)
      bySupport.set(support, texts)
    }
  }
  const conflicts: string[] = []
  for (const [support, texts] of [...bySupport.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (texts.size > 1) conflicts.push(support)
  }
  return conflicts
}

/**
 * The strongest scope any admitted claim reaches.
 *
 * A fact about the records, reported so a surface can show that nothing is general. It is
 * `LEARNING_SCOPES`-ordered and can never be a member outside that closed list.
 */
export function strongestScope(state: LearningState): (typeof LEARNING_SCOPES)[number] {
  const rank = (scope: string): number => {
    const index = (LEARNING_SCOPES as readonly string[]).indexOf(scope)
    return index < 0 ? 0 : index
  }
  let best: LearningScope = LEARNING_SCOPES[0]
  for (const record of admittedKnowledge(state)) {
    if (rank(record.scope) > rank(best)) best = record.scope
  }
  return best
}

/** The evidence behind one claim, counted the way the thresholds care about. */
interface Support {
  readonly distinctVerifications: number
  readonly distinctExperiences: number
  readonly failedOutcomes: number
  readonly staleVerifications: number
  readonly experiences: readonly LearningExperience[]
  readonly verificationIds: readonly string[]
}

function supportFor(record: KnowledgeRecord, state: LearningState, nowMs: number): Support {
  const experiences = record.supports
    .map((id) => state.experiences.get(id))
    .filter((entry): entry is LearningExperience => entry !== undefined && entry.status === 'admitted')

  const verificationIds = new Set<string>()
  let failed = 0
  let stale = 0
  for (const experience of experiences) {
    const outcome = state.outcomes.get(experience.outcomeId)
    if (outcome === undefined) continue
    verificationIds.add(outcome.verificationId)
    if (outcome.result === 'failed') failed += 1
    const establishedMs = instantMs(outcome.establishedAt)
    if (establishedMs === null || !outcomeIsCurrent(establishedMs, nowMs)) stale += 1
  }
  return {
    distinctVerifications: verificationIds.size,
    distinctExperiences: new Set(experiences.map((entry) => entry.experienceId)).size,
    failedOutcomes: failed,
    staleVerifications: stale,
    experiences,
    verificationIds: [...verificationIds].sort(),
  }
}

/**
 * Procedure proposals, above or below threshold.
 *
 * Both are returned, always with `aboveThreshold` stated, because the below-threshold ones
 * are the honest account of "here is what Freya noticed but has not established". A surface
 * that only ever saw the successful ones would be showing a flattering account of what she
 * knows.
 *
 * Grouped by `outcome-pattern` claim family: a proposal is one per distinct first tagged
 * label of the claims that support it, so two claims about the same tool produce one
 * proposal with two steps rather than two competing proposals for the same work.
 */
export function deriveProposals(state: LearningState, now: string): readonly ProcedureProposal[] {
  const nowMs = instantMs(now)
  if (nowMs === null) return []
  const proposals: ProcedureProposal[] = []
  const byFamily = new Map<string, KnowledgeRecord[]>()

  for (const record of admittedKnowledge(state)) {
    const family = record.tags[0] ?? record.kind
    const bucket = byFamily.get(family) ?? []
    bucket.push(record)
    byFamily.set(family, bucket)
  }

  for (const [family, records] of [...byFamily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const support = mergeSupport(records, state, nowMs)
    const scope = widestScope(records)
    const scopeLimits = unionScopeLimits(records)
    const steps = records.slice(0, LEARNING_LIMITS.maxProposalSteps).map((record, index) => ({
      key: `step-${index + 1}`,
      summary: record.claim,
    }))
    const support0 = decideSupport(support)
    // The proposal's name is **code-owned**, built from the claim family rather than copied
    // from a claim. A proposal name crosses in the broad projection, and a projection that
    // carried a claim's own words would be the one place Phase 28 promised it would not.
    // The claim text stays available on the owner's single-claim read and in the export,
    // which is where a reviewer reads it anyway.
    const name = `procedure for ${family}`
    if (steps.length === 0 || !isAdmissibleProposalName(name)) continue
    proposals.push(
      Object.freeze({
        proposalId: `prop-${family}`,
        name,
        steps: Object.freeze(steps),
        knowledgeIds: Object.freeze(records.map((record) => record.knowledgeId).sort()),
        experienceIds: Object.freeze(support.experiences.map((entry) => entry.experienceId).sort()),
        distinctVerifications: support.distinctVerifications,
        failedOutcomes: support.failedOutcomes,
        scope,
        scopeLimits,
        confidence: lowestConfidence(records),
        grantsCapability: false as const,
        executable: false as const,
        authority: 'none' as const,
        support: support0,
      }),
    )
    if (proposals.length >= LEARNING_LIMITS.maxProposals) break
  }
  return proposals
}

function mergeSupport(records: readonly KnowledgeRecord[], state: LearningState, nowMs: number): Support {
  const experiences: LearningExperience[] = []
  const verifications = new Set<string>()
  let failed = 0
  let stale = 0
  for (const record of records) {
    const part = supportFor(record, state, nowMs)
    for (const experience of part.experiences) experiences.push(experience)
    for (const id of part.verificationIds) verifications.add(id)
    failed += part.failedOutcomes
    stale += part.staleVerifications
  }
  return {
    distinctVerifications: verifications.size,
    distinctExperiences: new Set(experiences.map((entry) => entry.experienceId)).size,
    failedOutcomes: failed,
    staleVerifications: stale,
    experiences,
    verificationIds: [...verifications].sort(),
  }
}

/**
 * Whether the support clears the thresholds, and why.
 *
 * The order of the checks is the order of the reasons, so the reported reason is always the
 * most fundamental problem rather than whichever test happened to run last.
 */
export function decideSupport(support: Support): ProcedureProposal['support'] {
  const t = LEARNING_PROPOSAL_THRESHOLDS
  if (support.failedOutcomes > t.maxFailedOutcomes) {
    return {
      aboveThreshold: false,
      distinctVerifications: support.distinctVerifications,
      distinctExperiences: support.distinctExperiences,
      failedOutcomes: support.failedOutcomes,
      staleVerifications: support.staleVerifications,
      reason: 'failed-outcomes-present',
    }
  }
  if (support.distinctExperiences < t.minDistinctExperiences) {
    return {
      aboveThreshold: false,
      distinctVerifications: support.distinctVerifications,
      distinctExperiences: support.distinctExperiences,
      failedOutcomes: support.failedOutcomes,
      staleVerifications: support.staleVerifications,
      reason: 'too-few-experiences',
    }
  }
  if (support.distinctVerifications < t.minDistinctVerifications) {
    return {
      aboveThreshold: false,
      distinctVerifications: support.distinctVerifications,
      distinctExperiences: support.distinctExperiences,
      failedOutcomes: support.failedOutcomes,
      staleVerifications: support.staleVerifications,
      reason: 'too-few-verifications',
    }
  }
  if (support.distinctVerifications - support.staleVerifications < t.minDistinctVerifications) {
    return {
      aboveThreshold: false,
      distinctVerifications: support.distinctVerifications,
      distinctExperiences: support.distinctExperiences,
      failedOutcomes: support.failedOutcomes,
      staleVerifications: support.staleVerifications,
      reason: 'evidence-stale',
    }
  }
  return {
    aboveThreshold: true,
    distinctVerifications: support.distinctVerifications,
    distinctExperiences: support.distinctExperiences,
    failedOutcomes: support.failedOutcomes,
    staleVerifications: support.staleVerifications,
    reason: 'above-threshold',
  }
}

function widestScope(records: readonly KnowledgeRecord[]): (typeof LEARNING_SCOPES)[number] {
  const rank = (scope: string): number => {
    const index = (LEARNING_SCOPES as readonly string[]).indexOf(scope)
    return index < 0 ? 0 : index
  }
  let best: LearningScope = LEARNING_SCOPES[0]
  for (const record of records) {
    if (rank(record.scope) > rank(best)) best = record.scope
  }
  return best
}

function unionScopeLimits(records: readonly KnowledgeRecord[]): ProcedureProposal['scopeLimits'] {
  const limits = new Set<string>()
  for (const record of records) for (const limit of record.scopeLimits) limits.add(limit)
  // A proposal that merged several claims must carry the strictest limit any of them had.
  // Carrying the union is deliberate: a limit only ever survives if *some* contributing
  // claim needed it, and dropping one would widen the proposal without evidence.
  return Object.freeze([...limits].sort()) as ProcedureProposal['scopeLimits']
}

/**
 * The lowest confidence among the claims a proposal rests on.
 *
 * A proposal is never more certain than its least certain part. Taking the maximum instead
 * would let one strongly-attested claim speak for several weakly-attested ones, which is
 * the arithmetic form of the mistake this phase exists to prevent.
 */
export function lowestConfidence(records: readonly KnowledgeRecord[]): Confidence {
  const rank = (value: Confidence): number =>
    value === 'high' ? 3 : value === 'medium' ? 2 : value === 'low' ? 1 : 0
  let lowest: Confidence = 'medium'
  for (const record of records) {
    if (rank(record.confidence) < rank(lowest)) lowest = record.confidence
  }
  return lowest
}

/** The whole derivation. */
export function deriveLearning(state: LearningState, now: string): LearningDerivation {
  const byExperienceKind = emptyExperienceCounts()
  const byKnowledgeKind = emptyKnowledgeCounts()
  let evidenced = 0
  for (const experience of admittedExperiences(state)) {
    byExperienceKind[experience.kind] += 1
  }
  for (const record of admittedKnowledge(state)) {
    byKnowledgeKind[record.kind] += 1
    if (record.verificationIds.length > 0) evidenced += 1
  }

  let candidates = 0
  let retracted = 0
  let superseded = 0
  let expired = 0
  let rejected = 0
  for (const entry of [...state.experiences.values(), ...state.knowledge.values()]) {
    if (entry.status === 'candidate') candidates += 1
    else if (entry.status === 'retracted') retracted += 1
    else if (entry.status === 'superseded') superseded += 1
    else if (entry.status === 'expired') expired += 1
    else if (entry.status === 'rejected') rejected += 1
  }

  return Object.freeze({
    schemaVersion: LEARNING_DERIVATION_SCHEMA_VERSION,
    counts: Object.freeze({
      outcomes: state.outcomes.size,
      experiences: admittedExperiences(state).length,
      knowledge: admittedKnowledge(state).length,
      candidates,
      retracted,
      superseded,
      expired,
      rejected,
      byExperienceKind: Object.freeze({ ...byExperienceKind }),
      byKnowledgeKind: Object.freeze({ ...byKnowledgeKind }),
      evidenced,
    }),
    conflictedClaims: Object.freeze(conflictedClaims(state)),
    strongestScope: strongestScope(state),
    proposals: Object.freeze(deriveProposals(state, now).map(proposalSummary)),
    // Constants, not values. Learning grants nothing however much has been learned.
    authority: 'none' as const,
    confidenceCeiling: LEARNING_MAX_CONFIDENCE,
  })
}