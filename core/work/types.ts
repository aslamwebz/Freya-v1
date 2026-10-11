import type { Capability } from '../../shared/contracts/capabilities'
import type { PrincipalId } from '../../shared/contracts/identity'

/**
 * THE WORK DOMAIN.
 *
 * This file is the vocabulary of Freya's execution substrate: Run, Step, Action,
 * Observation, Verification, Approval, Task. It is types and closed tables only —
 * no logic, no I/O, no clock — so both the engine and the renderer can depend on
 * the shapes without either depending on the other.
 *
 * ## What these five words mean, and why they are not interchangeable
 *
 * ```
 *   Run          one execution attempt toward an outcome
 *    └ Step      a meaningful unit of intended work
 *       └ Action an operation that was actually attempted
 *          └ Observation   evidence about what happened
 *             └ Verification whether the intent was satisfied
 * ```
 *
 * The distinction the whole file exists to protect is between **what was intended**
 * (Step), **what was tried** (Action), **what came back** (Observation) and
 * **whether it worked** (Verification). Collapsing any two of them produces the
 * failure this architecture calls out by name:
 *
 * > Verification is not optional: an action is not evidence that it worked.
 *
 * So an Action that *completed* is not a success, an Observation is not a success,
 * and a capability that reports success is not evidence of one — only a
 * separately registered verifier can close a Step.
 */

/* ------------------------------------------------------------------ kinds */

/**
 * What a Run is for.
 *
 * Phase 6 ships exactly one kind, `deterministic`: a Run whose steps were planned
 * up front and are executed in the order they were planned. That is the only kind
 * this engine knows how to execute honestly, so it is the only kind it will
 * accept — a Run cannot name a strategy the engine does not have.
 *
 * Phase 5 (research) and Phase 7 (missions) add kinds here. Nothing else in Core
 * branches on the value, so adding one is a data change plus the planner that
 * fills it in.
 */
export const RUN_KINDS = ['deterministic'] as const
export type RunKind = (typeof RUN_KINDS)[number]

/* ------------------------------------------------------------ run statuses */

/**
 * A Run's lifecycle.
 *
 * `queued` → `running` → one of four resting points → one of three terminal
 * states. `RUN_TRANSITIONS` below is the only thing permitted to move a Run
 * between these, and terminal states have no outgoing edges at all: a completed,
 * failed or cancelled Run is never rewritten. A retry is a *new* Run.
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'awaiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** The statuses from which no transition is permitted. */
export const RUN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number]

export function isTerminalRunStatus(status: RunStatus): status is RunTerminalStatus {
  return RUN_TERMINAL_STATUSES.includes(status as RunTerminalStatus)
}

/* ----------------------------------------------------------- step statuses */

/**
 * A Step's lifecycle.
 *
 * `pending → ready → running → verified` is the success path, and every other
 * status is an honest account of a path that did not take it. `failed` is
 * deliberately **not** terminal: a bounded retry returns it to `ready` and
 * increments its attempt count, so each attempt is a separate set of events and
 * none of them disappear. Retrying a Run is not permitted — only a Step retries,
 * and only inside its own ceiling.
 */
export const STEP_STATUSES = [
  'pending',
  'ready',
  'running',
  'waiting',
  'awaiting_approval',
  'verified',
  'failed',
  'cancelled',
  'skipped',
] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

/** Step statuses from which nothing further happens. */
export const STEP_TERMINAL_STATUSES = ['verified', 'cancelled', 'skipped'] as const
export type StepTerminalStatus = (typeof STEP_TERMINAL_STATUSES)[number]

export function isTerminalStepStatus(status: StepStatus): status is StepTerminalStatus {
  return STEP_TERMINAL_STATUSES.includes(status as StepTerminalStatus)
}

/* ---------------------------------------------------------- task statuses */

/**
 * A Task is a user-visible piece of work, and it is **not** a Step.
 *
 * One Task may contain or produce several Runs; one Run belongs to at most one
 * Task. Turning every internal Step into a Task would put the engine's own
 * mechanics on the user's board, which is why the two are separate aggregates
 * rather than one with a visibility flag.
 */
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_TERMINAL_STATUSES = ['done', 'cancelled'] as const
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status as (typeof TASK_TERMINAL_STATUSES)[number])
}

/** Which Task statuses may move to which. Terminal statuses are terminal. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  open: ['in_progress', 'blocked', 'done', 'cancelled'],
  in_progress: ['blocked', 'done', 'cancelled'],
  blocked: ['in_progress', 'done', 'cancelled'],
  done: [],
  cancelled: [],
})

/* ------------------------------------------------------- approval statuses */

/**
 * Approval is execution state, not a boolean on an Action.
 *
 * `pending` is a real state with a real consequence: the Run is stopped in
 * `awaiting_approval` and no capability has been called. An approval cannot be
 * "granted after the fact", which is what makes this a list of statuses with a
 * terminal `approved` rather than a flag on the record of an action that already
 * ran.
 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'cancelled', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const APPROVAL_TERMINAL_STATUSES = ['approved', 'denied', 'cancelled', 'expired'] as const
export type ApprovalTerminalStatus = (typeof APPROVAL_TERMINAL_STATUSES)[number]

export function isTerminalApprovalStatus(status: ApprovalStatus): status is ApprovalTerminalStatus {
  return APPROVAL_TERMINAL_STATUSES.includes(status as ApprovalTerminalStatus)
}

/** Only the owner may decide. Kept as a table so it is a compile error to add another. */
export const APPROVAL_DECISIONS = ['approved', 'denied'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

/* ------------------------------------------------- capability risk taxonomy */

/**
 * How consequential a capability is.
 *
 * Risk is declared by the **capability**, in code, and never by the Step plan. A
 * plan that wanted to declare itself safe could omit a gate; a capability
 * cannot lower its own risk because it is not the thing that reads the field. The
 * rule is one line: `consequential` always requires an approval before the
 * capability is called.
 *
 * `routine` capabilities may additionally be gated by their plan, which is
 * additive — a plan can ask for an approval it does not need, never remove one it
 * does.
 */
export const WORK_RISKS = ['none', 'routine', 'consequential'] as const
export type WorkRisk = (typeof WORK_RISKS)[number]

/* ----------------------------------------------------- observation taxonomy */

/**
 * What kind of evidence an Observation is.
 *
 * `result` is deliberately *not* called `success`. A capability that returned
 * data has produced an observation, and whether the data satisfies the Step's
 * intent is a separate question answered by a verifier. Naming the kind
 * `success` in the vocabulary would put the conclusion in the type.
 */
export const OBSERVATION_KINDS = ['result', 'exit', 'change', 'failure', 'input'] as const
export type ObservationKind = (typeof OBSERVATION_KINDS)[number]

/* ----------------------------------------------------------------- limits */

/**
 * The ceiling on a single Run.
 *
 * The invariant this file exists to make structural:
 *
 * > A Run cannot grow forever because a model keeps requesting more work.
 *
 * Every bound below is checked by the engine **before** the thing it bounds, not
 * after, and exceeding one is a recorded, visible outcome (`work.limits.exceeded`)
 * rather than a silent stop. A caller may lower a ceiling and may never raise it
 * above `WORK_LIMITS`.
 */
export const WORK_LIMITS = Object.freeze({
  /** Steps a single Run may plan. */
  maxRunSteps: 64,
  /** Capability calls a single Run may make, across all Steps and retries. */
  maxRunActions: 128,
  /** Wall-clock milliseconds a single Run may occupy before it is stopped. */
  maxRunDurationMs: 15 * 60_000,
  /** Attempts a single Step may make, first attempt included. */
  maxAttemptsPerStep: 3,
  /** How long an unanswered approval request stays `pending`. */
  approvalTtlMs: 24 * 60 * 60_000,
  /** Open approval requests across the whole engine. */
  maxPendingApprovals: 32,
  /** Plans retained for the board. */
  maxRetainedRuns: 200,
  /** Characters in a human-readable label the engine keeps in memory only. */
  maxLabelChars: 200,
  /** Characters in a human-readable summary the engine keeps in memory only. */
  maxSummaryChars: 400,
  /** Characters in a reason a person is shown for a refusal. */
  maxReasonChars: 400,
  /** Bytes of serialised step input the engine will accept from any caller. */
  maxInputBytes: 8_192,
  /** Depth and breadth of a sanitised input value. */
  maxInputDepth: 4,
  /** Fields in one sanitised input value. */
  maxInputFields: 32,
})

/** The resolved bounds for one Run. Narrowed from `WORK_LIMITS`, never widened. */
export interface RunLimits {
  readonly maxSteps: number
  readonly maxActions: number
  readonly maxDurationMs: number
  readonly maxAttemptsPerStep: number
}

/** The absolute ceiling, used when a caller does not narrow them. */
export const DEFAULT_RUN_LIMITS: RunLimits = Object.freeze({
  maxSteps: WORK_LIMITS.maxRunSteps,
  maxActions: WORK_LIMITS.maxRunActions,
  maxDurationMs: WORK_LIMITS.maxRunDurationMs,
  maxAttemptsPerStep: WORK_LIMITS.maxAttemptsPerStep,
})

/** Which ceiling was hit. Recorded rather than inferred from a generic failure. */
export const LIMIT_NAMES = ['steps', 'actions', 'duration', 'attempts'] as const
export type LimitName = (typeof LIMIT_NAMES)[number]

/* ------------------------------------------------------ state machine table */

/**
 * Every Run transition that exists.
 *
 * Declared centrally so that nothing can move a Run by writing to it. The engine
 * refuses any edge that is not in this table, and the reducer refuses to apply
 * one — which is also what closes the cancellation/completion race: a completion
 * that arrives after a cancellation is not a timing problem to be tuned away, it
 * is an edge that does not exist.
 *
 * `queued → failed` and `running → failed` from recovery exist so that an
 * interrupted Run can be reconciled honestly. They are the *only* reason a Run
 * ever reaches `failed` without having tried to finish.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  queued: ['running', 'paused', 'failed', 'cancelled'],
  running: ['waiting', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'paused', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'waiting', 'failed', 'cancelled'],
  paused: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
})

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

/**
 * Every Step transition that exists.
 *
 * `failed → ready` is the retry edge and is the only backward edge in the table.
 * It exists on Step and not on Run on purpose: a Step retrying is an attempt
 * within one Run, and each attempt writes its own Action, Observation and
 * Verification events, so the history of a flapping Step stays visible. A Run
 * does not retry; a new Run is created and the old one stays `failed` forever.
 */
export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = Object.freeze({
  pending: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'awaiting_approval', 'failed', 'skipped', 'cancelled'],
  running: ['waiting', 'awaiting_approval', 'verified', 'failed', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled'],
  /**
   * Two ways out, and both are real.
   *
   * `ready` is the gate reopening after a grant: the engine re-selects the step
   * through the same ordered selection everything else goes through, so an approved
   * step is not privileged by being able to skip the queue.
   *
   * `running` is a Step that was executing when the request arrived and is allowed
   * to carry straight on — the shape Phase 5's browser and terminal steps will
   * need, where a page can be waiting on a person mid-execution.
   */
  awaiting_approval: ['ready', 'running', 'failed', 'cancelled'],
  // The one backward edge: a bounded retry, and only ever back to `ready`.
  failed: ['ready'],
  verified: [],
  cancelled: [],
  skipped: [],
})

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to)
}

/* ------------------------------------------------------------- step plans */

/**
 * One planned Step, as a caller may propose it.
 *
 * This is a *request*. Nothing in it is authority:
 *
 * - `capability` names a registered capability; the engine refuses a name it does
 *   not have, and the capability's own `capability` field — not this one — is
 *   what Guard evaluates.
 * - `verifier` names a separately registered verifier. It is required, not
 *   optional, because a Step with no way to be checked is a Step that completes
 *   on the strength of an Action and nothing else.
 * - `requiresApproval` can only *add* a gate. It can never remove the one a
 *   `consequential` capability carries on its own.
 * - `input` is untrusted and is sanitised by the engine before any capability
 *   sees it.
 */
export interface WorkStepPlan {
  /** Stable within its Run, so a retry is visibly the same step. */
  readonly key: string
  /** Human-readable. Kept in memory for this process; never journalled. */
  readonly label: string
  readonly capability: string
  readonly verifier: string
  readonly input?: Record<string, unknown>
  readonly requiresApproval?: boolean
}

/** A planned Run, as a caller may propose it. Also a request, for the same reasons. */
export interface WorkRunPlan {
  readonly kind?: RunKind
  /** Optional parent reference. Phase 7 Missions attach here. */
  readonly parent?: { readonly kind: string; readonly id: string } | null
  readonly taskId?: string | null
  readonly steps: readonly WorkStepPlan[]
  /** Narrowed ceilings. Each is clamped to `WORK_LIMITS` and can never exceed it. */
  readonly limits?: Partial<RunLimits>
}

/* ------------------------------------------------------------- projections */

/**
 * What the journal knows about one Run.
 *
 * Durable. Every field is either an id, a count, a status, an instant, or a
 * measured length. No label, no input, no observation content — the journal is
 * the least protected place anything in Core could go, and this shape is the
 * reason it never becomes one.
 */
export interface RunRecord {
  readonly runId: string
  readonly kind: RunKind
  readonly status: RunStatus
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly cancelledAt: string | null
  readonly failure: string | null
  /** Where this Run was waiting when it stopped, in words. */
  readonly waitingOn: string | null
  readonly parentKind: string | null
  readonly parentId: string | null
  readonly taskId: string | null
  readonly limits: RunLimits
}

/** What the journal knows about one Step. Durable, metadata only. */
export interface StepRecord {
  readonly stepId: string
  readonly runId: string
  readonly key: string
  readonly index: number
  readonly status: StepStatus
  /** Attempts made so far. Bounded by `limits.maxAttemptsPerStep`. */
  readonly attempts: number
  readonly capability: string
  readonly verifier: string
  readonly approvalId: string | null
  readonly startedAt: string | null
  readonly settledAt: string | null
  readonly reason: string | null
}

/** What the journal knows about one Action. Durable, metadata only. */
export interface ActionRecord {
  readonly actionId: string
  readonly runId: string
  readonly stepId: string
  readonly attempt: number
  readonly capability: string
  readonly principal: PrincipalId
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly startedAt: string
  readonly settledAt: string | null
  readonly durationMs: number | null
  readonly reason: string | null
}

/** What the journal knows about one Observation. Durable, metadata only. */
export interface ObservationRecord {
  readonly observationId: string
  readonly runId: string
  readonly stepId: string
  readonly actionId: string | null
  readonly kind: ObservationKind
  readonly summaryLength: number
  readonly detailLength: number
}

/** What the journal knows about one Verification. Durable, metadata only. */
export interface VerificationRecord {
  readonly verificationId: string
  readonly runId: string
  readonly stepId: string
  readonly verifier: string
  readonly status: 'requested' | 'passed' | 'failed'
  readonly verdictAt: string | null
  readonly reason: string | null
}

/** What the journal knows about one Approval request. Durable, metadata only. */
export interface ApprovalRecord {
  readonly approvalId: string
  readonly runId: string
  readonly stepId: string
  readonly capability: string
  readonly requiredCapability: Capability
  readonly risk: WorkRisk
  readonly principal: PrincipalId
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly decidedBy: PrincipalId | null
  readonly decisionSource: string | null
  readonly status: ApprovalStatus
  readonly reason: string | null
  /** Why an approval was required. Stated once, so the decision has a subject. */
  readonly justification: string
  /** What would happen if it were approved. Bounded, and never the input itself. */
  readonly proposal: string
}

/** What the journal knows about one Task. Durable; the title is a measurement. */
export interface TaskRecord {
  readonly taskId: string
  readonly status: TaskStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly titleLength: number
  readonly runIds: readonly string[]
}

/**
 * Structural progress.
 *
 * Counts, never a fabricated percentage. `percent` is `null` unless every step is
 * terminal, because a percentage computed from steps that have not been decided
 * yet is a number that will change and a person who saw it would remember the
 * first value.
 */
export interface RunProgress {
  readonly stepsTotal: number
  readonly verified: number
  readonly failed: number
  readonly cancelled: number
  readonly skipped: number
  readonly remaining: number
  readonly actions: number
  readonly attempts: number
  /** Null unless every step is terminal. Derived, never estimated. */
  readonly percent: number | null
  /** One line a board can render without interpreting the counts. */
  readonly summary: string
}

/** Why a Run could not continue, in the engine's own words. */
export const WORK_REASONS = Object.freeze({
  queued: 'the run is planned and waiting to be started',
  running: 'a step is executing',
  waiting: 'waiting for an external condition',
  awaitingApproval: 'waiting for your approval',
  paused: 'paused before the next step',
  restartInterrupted:
    'Freya restarted while this run was in progress, so its plan is gone and it cannot continue',
  approvalExpired:
    'Freya restarted before this request was decided, so the run it was blocking cannot continue',
  limitSteps: 'the run reached its step ceiling',
  limitActions: 'the run reached its action ceiling',
  limitDuration: 'the run reached its time ceiling',
  limitAttempts: 'the step reached its attempt ceiling',
  capabilityMissing: 'the plan named a capability this Core does not have',
  verifierMissing: 'the plan named no way to check the result, so nothing can close the step',
  capabilityFailed: 'the capability failed before it produced evidence',
  verifierFailed: 'the verifier could not run',
  verificationPassed: 'verification established the intended result',
  verificationFailed: 'verification did not establish the intended result',
  approvalDenied: 'the request was denied, so the step was not attempted',
  approvalTimedOut: 'the approval request expired before it was decided',
  cancelled: 'cancelled',
  noSteps: 'the plan contained no steps',
} as const)