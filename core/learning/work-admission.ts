import type { LearningEngine } from './engine'
import type { StepRecord, VerificationRecord } from '../work/types'
import type { MissionContent } from '../missions/types'
import type { LearningScope, LearningScopeLimit, VerifiedOutcome } from './types'

export interface WorkAdmissionCandidate {
  readonly step: StepRecord
  readonly verification?: VerificationRecord | null
  readonly missionContent?: MissionContent | null
  readonly nowIso: string
}

export interface WorkAdmissionResult {
  readonly admitted: boolean
  readonly reason: string
  readonly outcomeId?: string
  readonly experienceId?: string
  readonly knowledgeId?: string
}

/**
 * Deterministic selective admission policy for Work & Mission outcomes.
 * Enforces PLAN 3A.3, 3A.4, 3A.5:
 * - Checks authoritative verifier verdict.
 * - Distinguishes success, failure, cancellation and unknown outcome.
 * - Filters trivial repetitive records.
 * - Deduplicates identical checks.
 * - Enforces anti-overgeneralisation bounds.
 * - Zero paid LLM calls.
 */
export async function admitWorkStepOutcome(
  learning: LearningEngine,
  candidate: WorkAdmissionCandidate,
): Promise<WorkAdmissionResult> {
  const { step, verification, missionContent, nowIso } = candidate

  // 1. Only terminal verified or failed steps are eligible.
  if (step.status !== 'verified' && step.status !== 'failed') {
    return { admitted: false, reason: `step status ${step.status} is not eligible for learning admission` }
  }

  // 2. Resolve capability input if available from private execution plan.
  const privateStep = missionContent?.executionPlan?.steps.find(
    (s) => s.stepId === step.stepId || s.stepId === step.key,
  )
  const input = privateStep?.input ?? {}

  // 3. Deduplication check against folded learning store.
  const cleanStepId = step.stepId.replace(/[^A-Za-z0-9._:-]/g, '_')
  const subjectRef = `work-step:${cleanStepId}`
  const existingOutcomes = learning.records().outcomes
  if (existingOutcomes.some((o: VerifiedOutcome) => o.subjectRef === subjectRef)) {
    return { admitted: false, reason: 'outcome for this step has already been admitted' }
  }

  // 4. Selective admission policy (Rule 3A.4): avoid unbounded trivial accumulation.
  if (step.capability === 'filesystem.inspect') {
    const rawPath = typeof input.path === 'string' ? input.path : ''
    // If it succeeded and we already recorded an inspection for this path, skip as trivial repeat.
    if (step.status === 'verified') {
      const alreadyInspected = existingOutcomes.some(
        (o: VerifiedOutcome) => o.verifierId === 'filesystem.inspect.verified' && o.checked.includes(rawPath.slice(-40)),
      )
      if (alreadyInspected) {
        return { admitted: false, reason: 'inspection of this path was already retained' }
      }
    }
  }

  const isSuccess = step.status === 'verified' && verification?.status !== 'failed'
  const result = isSuccess ? ('succeeded' as const) : ('failed' as const)

  const outcomeId = `out-${cleanStepId}`
  const verificationId = verification?.verificationId
    ? verification.verificationId.replace(/[^A-Za-z0-9._:-]/g, '_')
    : `ver-${cleanStepId}`
  const verifierId = step.verifier.replace(/[^A-Za-z0-9._:-]/g, '_')

  // 5. Construct truthful bounded checked description.
  let checked: string
  let lesson: string
  let claim: string
  const expKind: 'tool-lesson' | 'failure-lesson' = isSuccess ? 'tool-lesson' : 'failure-lesson'
  const knowKind: 'tool-behaviour' | 'failure-cause' = isSuccess ? 'tool-behaviour' : 'failure-cause'

  if (step.capability === 'research.search') {
    const query = typeof input.query === 'string' && input.query.trim() ? input.query.trim().slice(0, 80) : 'query'
    if (isSuccess) {
      checked = `Independent source rereads verified excerpt retrieval for research query "${query}"`
      lesson = `research.search retrieved verified source excerpts for query "${query}".`
      claim = `Observed that research.search retrieved verifiable excerpts for queries regarding "${query.slice(0, 60)}" in this setup.`
    } else {
      const failReason = verification?.reason ? verification.reason.slice(0, 100) : 'source verification failed'
      checked = `Independent source verification could not establish matching excerpts for query "${query}"`
      lesson = `research.search failed to establish verified evidence for "${query}": ${failReason}.`
      claim = `Observed that research.search can fail to find matching excerpts for queries regarding "${query.slice(0, 60)}".`
    }
  } else if (step.capability === 'filesystem.inspect') {
    const pathStr = typeof input.path === 'string' ? input.path.slice(-100) : 'file'
    if (isSuccess) {
      checked = `Verified file existence and metadata for path "${pathStr}"`
      lesson = `filesystem.inspect successfully verified file metadata for "${pathStr}".`
      claim = `Observed that filesystem.inspect verified file metadata for "${pathStr}" in this setup.`
    } else {
      checked = `Verification of file metadata failed for path "${pathStr}"`
      lesson = `filesystem.inspect could not verify file metadata for "${pathStr}": target path was missing or unreadable.`
      claim = `Observed that filesystem.inspect can fail to inspect file metadata for "${pathStr}".`
    }
  } else {
    // Generic capability fallback
    if (isSuccess) {
      checked = `Verified successful execution of capability ${step.capability}`
      lesson = `Capability ${step.capability} completed and satisfied verifier ${step.verifier}.`
      claim = `Observed that capability ${step.capability} passed verification in this setup.`
    } else {
      checked = `Verification failed for capability ${step.capability}`
      lesson = `Capability ${step.capability} failed verification: ${verification?.reason ?? 'verification failed'}.`
      claim = `Observed that capability ${step.capability} failed verification in this setup.`
    }
  }

  // 6. Stage One: Record Verified Outcome.
  const outcomeOutcome = await learning.recordVerifiedOutcome({
    outcomeId,
    sourceDomain: 'work',
    verificationId,
    verifierId,
    checked,
    subjectRef,
    result,
    establishedAt: nowIso,
    proposedConfidence: 'medium',
    actor: 'core',
  })

  if (!outcomeOutcome.ok) {
    return { admitted: false, reason: `failed to record verified outcome: ${outcomeOutcome.reason}` }
  }

  // 7. Stage Two: Distil Learning Experience.
  const experienceId = `exp-${cleanStepId}`
  const scopeLimits: readonly LearningScopeLimit[] = isSuccess
    ? (['observed-once', 'no-future-guarantee', 'outcome-verified-process-unverified'] as const)
    : (['observed-once', 'conditions-may-change', 'no-future-guarantee'] as const)

  const expOutcome = await learning.distilExperience(outcomeId, {
    experienceId,
    kind: expKind,
    lesson,
    scope: 'one-instance' as LearningScope,
    scopeLimits,
    tags: [step.capability.replace(/[^a-zA-Z0-9]/g, '_'), isSuccess ? 'verified_success' : 'verified_failure'],
    observedAt: nowIso,
  })

  if (!expOutcome.ok) {
    return { admitted: true, outcomeId, reason: `outcome recorded, but experience refused: ${expOutcome.reason}` }
  }

  // 8. Stage Three: Derive Bounded Knowledge Claim.
  const knowledgeId = `know-${cleanStepId}`
  const knowScopeLimits: readonly LearningScopeLimit[] = isSuccess
    ? (['observed-in-one-environment', 'no-future-guarantee'] as const)
    : (['observed-in-one-environment', 'conditions-may-change', 'no-future-guarantee'] as const)

  const knowOutcome = await learning.deriveKnowledge(
    {
      knowledgeId,
      kind: knowKind,
      claim,
      scope: 'one-environment' as LearningScope,
      scopeLimits: knowScopeLimits,
      supports: [experienceId],
      tags: [step.capability.replace(/[^a-zA-Z0-9]/g, '_')],
      observedAt: nowIso,
    },
    'core',
  )

  return {
    admitted: true,
    outcomeId,
    experienceId,
    knowledgeId: knowOutcome.ok ? knowledgeId : undefined,
    reason: 'outcome and experience successfully admitted into learning engine',
  }
}
