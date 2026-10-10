import {
  DEFAULT_DECOMPOSITION_LIMITS,
  type DecompositionLimits,
  type GoalMilestone,
  type GoalMilestoneInput,
  type GoalRoadmap,
  type GoalRoadmapInput,
} from './types'
import { validateMilestoneGraph } from './dag'

const CONTROL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
]

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const stripped = CONTROL_RANGES.some(([low, high]) => code >= low && code <= high)
    if (!stripped) out += character
  }
  const trimmed = out.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

export type RoadmapValidationResult =
  | { readonly ok: true; readonly value: GoalRoadmap }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate and normalize a proposed goal roadmap against code-owned limits and graph rules.
 */
export function validateRoadmap(
  input: GoalRoadmapInput,
  existingRevision = 0,
  limits: DecompositionLimits = DEFAULT_DECOMPOSITION_LIMITS,
  nowIso = new Date().toISOString(),
): RoadmapValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'roadmap input is malformed' }
  }

  if (typeof input.goalId !== 'string' || input.goalId.length === 0) {
    return { ok: false, reason: 'roadmap must specify a goalId' }
  }

  if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
    return { ok: false, reason: 'roadmap must contain at least one milestone' }
  }

  if (input.milestones.length > limits.maxMilestonesPerGoal) {
    return {
      ok: false,
      reason: `roadmap exceeds maximum of ${limits.maxMilestonesPerGoal} milestones`,
    }
  }

  const milestones: GoalMilestone[] = []
  const assignedIds = new Set<string>()

  for (let i = 0; i < input.milestones.length; i++) {
    const raw = input.milestones[i] as GoalMilestoneInput
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: `milestone at index ${i} is malformed` }
    }

    const milestoneId = raw.milestoneId && raw.milestoneId.trim().length > 0
      ? raw.milestoneId.trim()
      : `m-${i + 1}`

    if (assignedIds.has(milestoneId)) {
      return { ok: false, reason: `duplicate milestone id: ${milestoneId}` }
    }
    assignedIds.add(milestoneId)

    const title = clean(raw.title, limits.maxTitleChars)
    if (!title) {
      return { ok: false, reason: `milestone ${milestoneId} has invalid title (1-${limits.maxTitleChars} chars)` }
    }

    const intent = clean(raw.intent, limits.maxIntentChars)
    if (!intent) {
      return { ok: false, reason: `milestone ${milestoneId} has invalid intent (1-${limits.maxIntentChars} chars)` }
    }

    const expectedOutcome = clean(raw.expectedOutcome, limits.maxExpectedOutcomeChars)
    if (!expectedOutcome) {
      return { ok: false, reason: `milestone ${milestoneId} has invalid expected outcome (1-${limits.maxExpectedOutcomeChars} chars)` }
    }

    if (!Array.isArray(raw.acceptanceCriteria) || raw.acceptanceCriteria.length === 0) {
      return { ok: false, reason: `milestone ${milestoneId} must have at least one acceptance criterion` }
    }
    if (raw.acceptanceCriteria.length > limits.maxCriteriaPerMilestone) {
      return { ok: false, reason: `milestone ${milestoneId} exceeds criterion limit of ${limits.maxCriteriaPerMilestone}` }
    }

    const criteria: string[] = []
    for (const c of raw.acceptanceCriteria) {
      const cleaned = clean(c, 500)
      if (!cleaned) {
        return { ok: false, reason: `milestone ${milestoneId} contains an empty or overlong criterion` }
      }
      criteria.push(cleaned)
    }

    const dependencies = Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map((d) => d.trim())
      : []

    if (dependencies.length > limits.maxDependenciesPerMilestone) {
      return {
        ok: false,
        reason: `milestone ${milestoneId} exceeds maximum of ${limits.maxDependenciesPerMilestone} dependencies`,
      }
    }

    const requiredCapabilities = Array.isArray(raw.requiredCapabilities)
      ? raw.requiredCapabilities.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : []

    const potentialBlockers = Array.isArray(raw.potentialBlockers)
      ? raw.potentialBlockers.filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
      : []

    const resourcesNeeded = Array.isArray(raw.resourcesNeeded)
      ? raw.resourcesNeeded.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : []

    const minHours = Math.max(0.1, Number(raw.estimatedEffort?.minHours ?? 1))
    const maxHours = Math.min(limits.maxEffortHours, Math.max(minHours, Number(raw.estimatedEffort?.maxHours ?? minHours * 2)))
    const confidence = raw.estimatedEffort?.confidence === 'high' || raw.estimatedEffort?.confidence === 'medium'
      ? raw.estimatedEffort.confidence
      : 'low'
    const effortDesc = typeof raw.estimatedEffort?.description === 'string'
      ? clean(raw.estimatedEffort.description, 200) ?? `${minHours}-${maxHours}h (uncertain estimate)`
      : `${minHours}-${maxHours}h (uncertain estimate)`

    const advisoryLessonsApplied = Array.isArray(raw.advisoryLessonsApplied)
      ? raw.advisoryLessonsApplied.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      : []

    milestones.push({
      milestoneId,
      goalId: input.goalId,
      title,
      intent,
      expectedOutcome,
      acceptanceCriteria: criteria,
      requiredCapabilities,
      dependencies,
      estimatedEffort: {
        minHours,
        maxHours,
        confidence,
        description: effortDesc,
      },
      potentialBlockers,
      resourcesNeeded,
      approvalRequired: Boolean(raw.approvalRequired),
      status: 'pending',
      checkpointId: null,
      boundMissionIds: [],
      verifiedAt: null,
      failureReason: null,
      advisoryLessonsApplied,
    })
  }

  // Validate the DAG
  const graphResult = validateMilestoneGraph(milestones)
  if (!graphResult.valid) {
    return { ok: false, reason: graphResult.error }
  }

  const nextRevision = existingRevision + 1
  if (nextRevision > limits.maxPlanRevisions) {
    return { ok: false, reason: `roadmap has reached maximum plan revision ceiling (${limits.maxPlanRevisions})` }
  }

  const advisoryNotes = Array.isArray(input.advisoryNotes)
    ? input.advisoryNotes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : []

  return {
    ok: true,
    value: {
      goalId: input.goalId,
      revision: nextRevision,
      milestones,
      createdAt: nowIso,
      updatedAt: nowIso,
      advisoryNotes,
    },
  }
}
