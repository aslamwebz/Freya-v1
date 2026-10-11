import type { WorkRegistry } from './capability'
import {
  WORK_LIMITS,
  WORK_REASONS,
  type RunLimits,
  type WorkRunPlan,
} from './types'

/** Clamp requested ceilings down to the absolute ones. Never up. */
export function resolveWorkLimits(requested?: Partial<RunLimits>): RunLimits {
  const pick = (value: number | undefined, ceiling: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(Math.floor(value), ceiling)
      : ceiling
  return {
    maxSteps: pick(requested?.maxSteps, WORK_LIMITS.maxRunSteps),
    maxActions: pick(requested?.maxActions, WORK_LIMITS.maxRunActions),
    maxDurationMs: pick(requested?.maxDurationMs, WORK_LIMITS.maxRunDurationMs),
    maxAttemptsPerStep: pick(requested?.maxAttemptsPerStep, WORK_LIMITS.maxAttemptsPerStep),
  }
}

/** Everything wrong with a plan, or `null` when there is nothing wrong. */
export function validateWorkPlan(
  plan: WorkRunPlan,
  taskIds: ReadonlyMap<string, unknown>,
  registry: WorkRegistry,
): string | null {
  if (plan.taskId !== undefined && plan.taskId !== null && !taskIds.has(plan.taskId)) {
    return 'no such task'
  }
  if (plan.parent !== undefined && plan.parent !== null) {
    // A parent reference is opaque on purpose — Phase 7 owns what a Mission is —
    // but it still has to be a well-formed reference rather than free text.
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(plan.parent.kind)) {
      return 'the parent reference kind is malformed'
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(plan.parent.id)) {
      return 'the parent reference id is malformed'
    }
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return WORK_REASONS.noSteps

  const limits = resolveWorkLimits(plan.limits)
  if (plan.steps.length > limits.maxSteps) {
    return `a plan may hold at most ${limits.maxSteps} steps; this one has ${plan.steps.length}`
  }

  const keys = new Set<string>()
  for (const step of plan.steps) {
    if (typeof step.key !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(step.key)) {
      return 'every step needs a key that looks like an id'
    }
    if (keys.has(step.key)) return `two steps share the key "${step.key}"`
    keys.add(step.key)
    if (!registry.has(step.capability)) {
      return `${WORK_REASONS.capabilityMissing}: "${String(step.capability)}"`
    }
    if (!registry.verifier(step.verifier)) {
      return `${WORK_REASONS.verifierMissing}: "${String(step.verifier)}"`
    }
    if (typeof step.label !== 'string') {
      return `step "${step.key}" needs a label`
    }
  }
  return null
}
