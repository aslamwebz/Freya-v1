import { ENTERPRISE_LIMITS } from './types'
import type { EnterpriseState } from './state'

/**
 * The explainable enterprise state.
 *
 * The specification asks for five things and this projection is organised as exactly
 * those five: what is being operated, why it matters, what is blocked, what is
 * uncertain, and what happens next. An owner looking at a business being run without
 * their attention should be able to answer all five from this one object, and should
 * never have to guess at the sixth.
 *
 * Two rules run through the whole file and both exist to stop this projection from
 * becoming the place where Freya invents something:
 *
 *   - **Progress is counted, never estimated.** `progress` is a ratio of records that
 *     have *reached a terminal state* to records that exist. An environment with no
 *     tasks reports `0`, not "some progress". There is no heuristic, no weight and no
 *     interpolation, because a percentage nobody can derive is a fabrication, and a
 *     fabricated number on a business dashboard is the specific thing PLAN.md's
 *     "missing, stale, conflicted and unknown remain explicit" forbids.
 *
 *   - **Uncertainty is a first-class output.** An environment with an unverified
 *     operation, a pending approval or an unreadable journal entry appears in
 *     `uncertainEnvironments` *as well as* `activeEnvironments`. It is not moved out of
 *     the active list to make the active list look clean.
 *
 * Pure. It reads folded state and a supplied instant; it calls nothing.
 */

export interface EnvironmentSummary {
  readonly environmentId: string
  readonly kind: string
  readonly state: string
  readonly title: string
  /** Terminal-state children over total children. Zero when there are no children. */
  readonly progress: number
  readonly reasoning: readonly string[]
  readonly blockedReason: string | null
  readonly uncertainty: readonly string[]
}

export interface ActionSummary {
  readonly actionId: string
  readonly kind: string
  readonly target: string
  readonly state: string
  readonly reasoning: readonly string[]
}

export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'execute' | 'delegate' | 'verify' | 'wait' | 'escalate' | 'stop' | 'rollback'
  readonly target: string
  /** ISO instant, or `null` when nothing bounds it. Never invented to fill the field. */
  readonly deadlineAt: string | null
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

export interface EnterpriseStateProjection {
  readonly activeEnvironments: readonly EnvironmentSummary[]
  readonly blockedEnvironments: readonly EnvironmentSummary[]
  readonly uncertainEnvironments: readonly EnvironmentSummary[]
  readonly recentActions: readonly ActionSummary[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/* ---------------------------------------------------------------- progress */

function ratio(terminal: number, total: number): number {
  if (total <= 0) return 0
  const value = terminal / total
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function isTerminal(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

/**
 * An environment's progress, as a count.
 *
 * Deliberately counting *any* terminal state, not just success. A task that failed is
 * finished; reporting it as unfinished work is how a business ends up appearing to be
 * 80% done when 40% of it failed.
 */
export function deriveProgress(state: EnterpriseState, environmentId: string): number {
  const tasks = Object.values(state.tasks).filter((task) => task.environmentId === environmentId)
  const missions = Object.values(state.missions).filter((mission) => mission.environmentId === environmentId)
  const items = Object.values(state.catalogItems).filter((item) => item.environmentId === environmentId)
  const operations = Object.values(state.operations).filter(
    (operation) => operation.environmentId === environmentId,
  )
  const all = [...tasks, ...missions, ...items, ...operations]
  return ratio(all.filter((record) => isTerminal(record.state)).length, all.length)
}

/* ------------------------------------------------------------ uncertainty */

/**
 * Everything about this environment that is not known.
 *
 * Each entry is a specific, checkable fact rather than a mood. "There is an operation
 * that has not been verified" is something the owner can act on; "some uncertainty"
 * is not.
 */
export function deriveUncertainty(state: EnterpriseState, environmentId: string): readonly string[] {
  const notes: string[] = []

  const operations = Object.values(state.operations).filter(
    (operation) => operation.environmentId === environmentId,
  )
  const unverified = operations.filter((operation) => operation.state === 'active')
  if (unverified.length > 0) {
    notes.push(
      `${String(unverified.length)} operation${unverified.length === 1 ? '' : 's'} started but ${unverified.length === 1 ? 'has' : 'have'} not been verified, so their outcomes are unknown.`,
    )
  }

  const approvals = Object.values(state.approvals).filter(
    (approval) => approval.environmentId === environmentId && approval.state === 'pending',
  )
  if (approvals.length > 0) {
    notes.push(
      `${String(approvals.length)} approval request${approvals.length === 1 ? '' : 's'} ${approvals.length === 1 ? 'is' : 'are'} waiting on the owner.`,
    )
  }

  const environment = state.environments[environmentId]
  if (environment !== undefined && environment.boundaries === null) {
    notes.push('No enterprise boundaries have been recorded for this environment yet.')
  }
  if (environment !== undefined && environment.spendingLimits === null) {
    notes.push('No spending limits have been recorded for this environment yet.')
  }

  const withdrawals = Object.values(state.customers).filter(
    (customer) => customer.environmentId === environmentId && customer.state === 'withdrawn',
  )
  if (withdrawals.length > 0) {
    notes.push(
      `${String(withdrawals.length)} customer record${withdrawals.length === 1 ? ' has' : 's have'} been withdrawn and ${withdrawals.length === 1 ? 'is' : 'are'} no longer writable.`,
    )
  }

  return notes
}

/* --------------------------------------------------------------- blocked */

export function deriveBlockedReason(
  state: EnterpriseState,
  environmentId: string,
): string | null {
  const environment = state.environments[environmentId]
  if (environment === undefined) return 'This environment is not in the durable record.'
  if (environment.state === 'completed') return 'This environment is complete.'
  if (environment.state === 'failed') return 'This environment has failed and is terminal.'
  if (environment.state === 'cancelled') return 'This environment was cancelled and is terminal.'
  if (environment.state === 'paused') {
    return environment.stopCode === null
      ? 'This environment is paused.'
      : `This environment is paused: ${environment.stopCode}.`
  }
  if (environment.state === 'draft') return 'This environment has never been activated.'

  // An *active* environment can still be blocked, and this is the case most worth
  // surfacing: the refusal that stopped it is in the journal and is the honest answer
  // to "why is nothing happening".
  const refusals = state.refusals.filter((refusal) => refusal.environmentId === environmentId)
  const last = refusals[refusals.length - 1]
  return last === undefined ? null : `The last action was refused: ${last.reason}`
}

/* ---------------------------------------------------------------- reasons */

function reasoningFor(state: EnterpriseState, environmentId: string): readonly string[] {
  const environment = state.environments[environmentId]
  if (environment === undefined) return ['No environment record exists for this id.']
  const tasks = Object.values(state.tasks).filter((task) => task.environmentId === environmentId)
  const missions = Object.values(state.missions).filter((mission) => mission.environmentId === environmentId)
  const items = Object.values(state.catalogItems).filter((item) => item.environmentId === environmentId)
  const operations = Object.values(state.operations).filter(
    (operation) => operation.environmentId === environmentId,
  )
  return [
    `This is a ${environment.kind} environment titled "${environment.title}".`,
    `It holds ${String(items.length)} catalog item${items.length === 1 ? '' : 's'}, ${String(tasks.length)} task${tasks.length === 1 ? '' : 's'}, ${String(missions.length)} mission${missions.length === 1 ? '' : 's'} and ${String(operations.length)} webzone operation${operations.length === 1 ? '' : 's'}.`,
    `Progress is ${String(Math.round(deriveProgress(state, environmentId) * 100))}%, counted as finished records over records that exist.`,
  ]
}

/* ---------------------------------------------------------- next bounded */

/**
 * The next thing that would happen, or null.
 *
 * Chosen deterministically — active environments in id order, then their first active
 * task, mission or operation — so the same journal always produces the same answer. It
 * is a *proposal*, not an authorization: nothing here runs. The pipeline in
 * `../orchestration` is what would have to agree before it did.
 */
export function deriveNextBoundedAction(state: EnterpriseState): BoundedAction | null {
  const environmentIds = Object.keys(state.environments).sort()
  for (const environmentId of environmentIds) {
    const environment = state.environments[environmentId]
    if (environment === undefined || environment.state !== 'active') continue

    const task = Object.values(state.tasks)
      .filter((candidate) => candidate.environmentId === environmentId && candidate.state === 'active')
      .sort((a, b) => a.taskId.localeCompare(b.taskId))[0]
    if (task !== undefined) {
      return {
        actionId: task.taskId,
        kind: 'execute',
        target: `task:${task.taskId}`,
        deadlineAt: environment.deadlineAt,
        maxAttempts: ENTERPRISE_LIMITS.maxRetryAttempts,
        reasoning: [
          `Task ${task.taskId} in ${environmentId} is active.`,
          'An active task is the nearest bounded unit of work, so it is proposed before any mission or operation.',
          'This is a proposal. It still has to pass every gate before it runs.',
        ],
      }
    }

    const mission = Object.values(state.missions)
      .filter((candidate) => candidate.environmentId === environmentId && candidate.state === 'active')
      .sort((a, b) => a.missionId.localeCompare(b.missionId))[0]
    if (mission !== undefined) {
      return {
        actionId: mission.missionId,
        kind: 'delegate',
        target: `mission:${mission.missionId}`,
        deadlineAt: environment.deadlineAt,
        maxAttempts: ENTERPRISE_LIMITS.maxRetryAttempts,
        reasoning: [
          `Mission ${mission.missionId} in ${environmentId} is active and has no active task of its own.`,
          'It is proposed for bounded delegation rather than direct execution.',
          'This is a proposal. It still has to pass every gate before it runs.',
        ],
      }
    }

    const operation = Object.values(state.operations)
      .filter((candidate) => candidate.environmentId === environmentId && candidate.state === 'active')
      .sort((a, b) => a.operationId.localeCompare(b.operationId))[0]
    if (operation !== undefined) {
      return {
        actionId: operation.operationId,
        kind: 'verify',
        target: operation.target,
        deadlineAt: environment.deadlineAt,
        maxAttempts: ENTERPRISE_LIMITS.maxRetryAttempts,
        reasoning: [
          `Operation ${operation.operationId} in ${environmentId} started but has no verification.`,
          'Verifying it is proposed before starting anything new, because an unverified action means the current state is unknown.',
          'This is a proposal. It still has to pass every gate before it runs.',
        ],
      }
    }
  }

  return null
}

/* ------------------------------------------------------------- projection */

export interface EnterpriseProjectionInput {
  readonly state: EnterpriseState
  readonly at: string
}

export function projectEnterpriseState(input: EnterpriseProjectionInput): EnterpriseStateProjection {
  const { state } = input
  const environmentIds = Object.keys(state.environments).sort()

  const summaries = environmentIds.map((environmentId): EnvironmentSummary => {
    const environment = state.environments[environmentId]
    return {
      environmentId,
      kind: environment?.kind ?? 'unknown',
      state: environment?.state ?? 'unknown',
      title: environment?.title ?? '(no title)',
      progress: deriveProgress(state, environmentId),
      reasoning: reasoningFor(state, environmentId),
      blockedReason: deriveBlockedReason(state, environmentId),
      uncertainty: deriveUncertainty(state, environmentId),
    }
  })

  const active = summaries.filter((summary) => summary.state === 'active')
  const blocked = summaries.filter((summary) => summary.state !== 'active')
  const uncertain = summaries.filter((summary) => summary.uncertainty.length > 0)

  const recentActions: ActionSummary[] = Object.values(state.operations)
    .slice(-ENTERPRISE_LIMITS.maxRetainedActions)
    .map((operation) => ({
      actionId: operation.operationId,
      kind: operation.kind,
      target: operation.target,
      state: operation.state,
      reasoning:
        operation.verificationId === null
          ? ['This operation has no verification, so its outcome is not established.']
          : [`Verified as ${operation.verificationId}.`],
    }))

  return {
    activeEnvironments: active,
    blockedEnvironments: blocked,
    uncertainEnvironments: uncertain,
    recentActions,
    nextBoundedAction: deriveNextBoundedAction(state),
    generatedAt: input.at,
  }
}