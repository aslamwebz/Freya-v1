import {
  SKILL_SCHEMA_VERSION,
  type SkillCountsView,
  type SkillDetailView,
  type SkillEvaluationView,
  type SkillProjection,
  type SkillProposalView,
  type SkillSelectionReport,
  type SkillVersionView,
  type SkillView,
} from '../protocol/skills'
import { SKILL_LIMITS, type SkillRecord } from './types'
import { summariseSkillCounts, type SkillFoldRecord, type SkillState } from './state'
import { SKILL_PROMOTION_THRESHOLDS } from './promotion'

export { ABSENT_SKILL_PROJECTION, NO_SKILL_DOMAIN_REASON } from '../protocol/skills'

/**
 * THE SKILL PROJECTION — Core's only route from skill facts to a window.
 *
 * A pure function over the folded state and the engine's persistence health. It exists
 * so the vocabulary a renderer receives is *derived* rather than assembled: the engine
 * supplies domain values, and this function decides — in one place, testable without a
 * Core — which fields may cross and which may not.
 *
 * ## The four things that never cross
 *
 * 1. **A summary's text.** `summaryLength` is a measurement, exactly like a
 *    conversation turn's `contentLength`: enough for an operator to see that a
 *    procedure is substantial, and not one character of it.
 * 2. **A contract entry's description.** The projection carries the *count* of
 *    inputs, outputs, preconditions and postconditions. Not one description.
 * 3. **The required-capability list.** Only `requiredCapabilityCount`. The list is the
 *    capability map of a procedure; showing it to a window would put a complete answer
 *    to "what could this do" on screen, and a window that could *read* a capability map
 *    is a window a reader can point at when they ask how to get those capabilities.
 * 4. **Model commentary.** `commentaryChars` only, and it is reported *next to* the
 *    verdict precisely so a reader can see that four thousand characters of opinion
 *    moved nothing.
 *
 * ## Nothing is invented
 *
 * `health` is `'ready'` because a caller that reached this function *has* a Skill
 * domain; the `'unavailable'` half is `ABSENT_SKILL_PROJECTION`. A `null`
 * `lastSelection` means no selection has been asked for, which is not the same as
 * "nothing was applicable".
 */

function evaluationView(evaluation: SkillFoldRecord['evaluations'][number]): SkillEvaluationView {
  return {
    evaluationId: evaluation.evaluationId,
    version: evaluation.version,
    subjectKind: evaluation.subjectKind,
    subjectRef: evaluation.subjectRef,
    author: evaluation.author,
    evaluatedAt: evaluation.evaluatedAt,
    verdict: evaluation.decision.verdict,
    reason: evaluation.decision.reason,
    deterministicCount: evaluation.decision.deterministicCount,
    positiveCount: evaluation.decision.positiveCount,
    negativeCount: evaluation.decision.negativeCount,
    commentaryChars: evaluation.decision.commentaryChars,
  }
}

function versionView(version: SkillFoldRecord['versions'][number]): SkillVersionView {
  return {
    version: version.version,
    contentHash: version.contentHash,
    createdAt: version.createdAt,
    source: version.source,
    trustClass: version.trustClass,
    stepCount: version.stepCount,
    requiredCapabilityCount: version.requiredCapabilityCount,
    applicabilityCount: version.applicabilityCount,
    inputCount: version.inputCount,
    outputCount: version.outputCount,
    preconditionCount: version.preconditionCount,
    postconditionCount: version.postconditionCount,
    summaryLength: version.summaryLength,
    revisions: version.revisions,
  }
}

function skillView(record: SkillFoldRecord): SkillView {
  const current = record.versions.find((version) => version.version === record.version)
  const evaluations = record.evaluations.filter((evaluation) => evaluation.version === record.version)
  const last = evaluations.length === 0 ? null : evaluations[evaluations.length - 1]
  return {
    skillId: record.skillId,
    name: record.name,
    kind: record.kind,
    status: record.status,
    version: record.version,
    verification: record.verification,
    source: record.source,
    trustClass: record.trustClass,
    admittedBy: record.admittedBy,
    admittedAt: record.admittedAt,
    updatedAt: record.updatedAt,
    promotedAt: record.promotedAt,
    retiredAt: record.retiredAt,
    retirementReason: record.retirementReason,
    applicability: record.applicability,
    stepCount: current?.stepCount ?? 0,
    requiredCapabilityCount: current?.requiredCapabilityCount ?? 0,
    inputCount: current?.inputCount ?? 0,
    outputCount: current?.outputCount ?? 0,
    preconditionCount: current?.preconditionCount ?? 0,
    postconditionCount: current?.postconditionCount ?? 0,
    summaryLength: current?.summaryLength ?? 0,
    executionsPlanned: record.executionsPlanned,
    establishedCount: evaluations.filter((evaluation) => evaluation.decision.verdict === 'established').length,
    contradictedCount: evaluations.filter((evaluation) => evaluation.decision.verdict === 'contradicted').length,
    inconclusiveCount: evaluations.filter((evaluation) => evaluation.decision.verdict === 'inconclusive').length,
    evaluationCount: evaluations.length,
    lastEvaluation: last === undefined || last === null ? null : evaluationView(last),
    versions: record.versions.map(versionView),
  }
}

function proposalView(proposal: SkillState['proposals'][number]): SkillProposalView {
  return {
    proposalId: proposal.proposalId,
    target: proposal.target,
    targetRef: proposal.targetRef,
    skillId: proposal.skillId,
    baseVersion: proposal.baseVersion,
    summaryLength: proposal.summaryLength,
    basisCount: proposal.basisEvaluationIds.length,
    proposedBy: proposal.proposedBy,
    createdAt: proposal.createdAt,
    status: proposal.status,
    settledReason: proposal.settledReason,
  }
}

export interface SkillProjectionInput {
  readonly sequence?: number
  readonly state: SkillState
  readonly persistence: { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null }
  readonly lastSelection?: SkillSelectionReport | null
}

/**
 * Build the projection a window may hold.
 *
 * Pure: same input, same output, no clock read and no randomness.
 */
export function projectSkills(input: SkillProjectionInput): SkillProjection {
  const counts = summariseSkillCounts(input.state)
  const view: SkillCountsView = {
    admitted: counts.admitted,
    revised: counts.revised,
    evaluations: counts.evaluations,
    established: counts.established,
    contradicted: counts.contradicted,
    inconclusive: counts.inconclusive,
    executionsPlanned: counts.executionsPlanned,
    promotions: counts.promotions,
    retirements: counts.retirements,
    proposals: counts.proposals,
    proposalsRefused: counts.proposalsRefused,
    rejectedAdmissions: counts.rejectedAdmissions,
    runtimePromotionsRefused: counts.runtimePromotionsRefused,
    retained: input.state.records.length,
    promoted: counts.promoted,
    executable: counts.executable,
  }
  return {
    health: 'ready',
    reason: null,
    schemaVersion: SKILL_SCHEMA_VERSION,
    sequence: input.sequence ?? 0,
    counts: view,
    thresholds: { ...SKILL_PROMOTION_THRESHOLDS },
    // Sorted by id rather than by insertion, so two windows cannot disagree about
    // the order of the list and a renderer diff does not churn on a replay.
    skills: [...input.state.records].sort(bySkillId).map(skillView),
    proposals: input.state.proposals.filter((proposal) => proposal.status === 'open').map(proposalView),
    rejectedAdmissions: input.state.rejectedAdmissions.map((entry) => ({
      code: entry.code,
      targetRef: entry.targetRef,
    })),
    runtimePromotionRefusals: input.state.runtimePromotionRefusals.map((entry) => ({
      artifactId: entry.artifactId,
      reason: entry.reason,
    })),
    lastSelection: input.lastSelection ?? null,
    persistence: { ...input.persistence },
    limits: {
      maxRetainedSkills: SKILL_LIMITS.maxRetainedSkills,
      maxSteps: SKILL_LIMITS.maxSteps,
      maxRequiredCapabilities: SKILL_LIMITS.maxRequiredCapabilities,
      maxOpenProposals: SKILL_LIMITS.maxOpenProposals,
      maxSelection: SKILL_LIMITS.maxSelection,
    },
  }
}

function bySkillId(left: SkillFoldRecord, right: SkillFoldRecord): number {
  return left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0
}

/**
 * Build the owner's explicit detail read for one skill.
 *
 * The one place a body crosses the bridge, and it takes a *body* rather than a fold
 * record precisely so it cannot be assembled from metadata: there is nothing to return
 * unless Core decrypted a real record at this version.
 */
export function skillDetailView(record: SkillRecord): SkillDetailView {
  return {
    skillId: record.skillId,
    name: record.name,
    kind: record.kind,
    status: record.status,
    version: record.version,
    verification: record.verification,
    contentHash: record.contentHash,
    summary: record.summary,
    steps: record.steps.map((step) => ({ key: step.key, capability: step.capability, verifier: step.verifier })),
    requiredCapabilities: record.requiredCapabilities,
    applicability: record.applicability,
    contract: {
      inputs: record.contract.inputs,
      outputs: record.contract.outputs,
      preconditions: record.contract.preconditions,
      postconditions: record.contract.postconditions,
    },
    provenance: {
      source: record.provenance.source,
      trustClass: record.provenance.trustClass,
      admittedBy: record.provenance.admittedBy,
      admittedAt: record.provenance.admittedAt,
      parentSkillId: record.provenance.parentSkillId,
      parentVersion: record.provenance.parentVersion,
    },
  }
}

/** Map a selection report into its protocol shape. Already the same type. */
export function selectionReport(report: SkillSelectionReport): SkillSelectionReport {
  return report
}