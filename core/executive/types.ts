/**
 * THE EXECUTIVE INTELLIGENCE DOMAIN — Phase 24's vocabulary.
 *
 * This file is types and closed tables only: no I/O, no clock read, no model, no
 * randomness. It is the shape everything else in `core/executive/` is built from.
 *
 * ## The core invariant
 *
 * > **Planning is not authority. Coordination is not sovereignty. Confidence is not permission.**
 *
 * Every type here is designed so that no field can become authority. There is no
 * `grant`, no `capability`, no `budget`, no `approval` and no `bypass` anywhere in
 * this vocabulary. A priority assessment cannot mint a capability. A plan cannot
 * widen a budget. A coordination decision cannot skip an approval. Authority
 * lives in Guard, Governor, STOP ALL, approvals and budgets — and Phase 24 never
 * touches any of them.
 *
 * ## What is deliberately absent
 *
 * - **No authority field.** No `capability`, `grant`, `allowed`, `override`,
 *   `bypassGuard` or `spend`. An executive decision cannot mint authority.
 * - **No free-form urgency from an untrusted source.** Urgency is computed from
 *   deadline proximity using an injected clock. It is never taken from a payload.
 * - **No mental-state claim.** Confidence is a closed ladder derived from evidence
 *   state. There is no "stress", "uncertainty score" or "attention" field.
 * - **No model output.** Every decision is deterministic: same inputs + same clock
 *   = same output.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count, both
 * stated in `EXECUTIVE_LIMITS`. Unbounded "executive state" is how a prioritizer
 * quietly becomes a log of everything that ever happened.
 */

/* ------------------------------------------------------------- priorities */

/**
 * The closed set of priority signals.
 *
 * Priority is derived from explicit signals, never from model output.
 * A model cannot raise its own priority; it can only provide evidence
 * that the deterministic prioritizer reads.
 */
export const PRIORITY_SIGNALS = [
  'owner-explicit',
  'deadline-imminent',
  'dependency-blocked',
  'dependency-ready',
  'verification-pending',
  'approval-pending',
  'budget-exhausted',
  'stale-evidence',
  'conflicted-evidence',
] as const

export type PrioritySignal = (typeof PRIORITY_SIGNALS)[number]

export function isPrioritySignal(value: unknown): value is PrioritySignal {
  return typeof value === 'string' && (PRIORITY_SIGNALS as readonly string[]).includes(value)
}

/**
 * The closed set of priority tiers.
 *
 * Tiers are ordered. The order is load-bearing: the prioritizer sorts
 * work items by tier, and within a tier by a deterministic tiebreaker.
 */
export const PRIORITY_TIERS = ['critical', 'high', 'normal', 'low', 'deferred'] as const
export type PriorityTier = (typeof PRIORITY_TIERS)[number]

export function isPriorityTier(value: unknown): value is PriorityTier {
  return typeof value === 'string' && (PRIORITY_TIERS as readonly string[]).includes(value)
}

export function priorityTierRank(tier: PriorityTier): number {
  return PRIORITY_TIERS.indexOf(tier)
}

/**
 * A priority assessment for a single work item.
 *
 * Deterministic: same inputs + same clock = same output.
 * The `signals` field records which signals contributed, for auditability.
 * The `reason` field is a closed code, never free text.
 */
export interface PriorityAssessment {
  readonly itemId: string
  readonly tier: PriorityTier
  readonly signals: readonly PrioritySignal[]
  readonly reason: PriorityReason
  readonly assessedAt: string
}

/**
 * Closed priority reasons.
 *
 * A reason is a code, never a sentence, so a decision can be counted,
 * compared and asserted on.
 */
export const PRIORITY_REASONS = Object.freeze({
  owner_override: 'owner_override',
  deadline_within_urgent_window: 'deadline_within_urgent_window',
  deadline_within_elevated_window: 'deadline_within_elevated_window',
  hard_dependency_unmet: 'hard_dependency_unmet',
  hard_dependency_met: 'hard_dependency_met',
  verification_overdue: 'verification_overdue',
  approval_expired: 'approval_expired',
  budget_depleted: 'budget_depleted',
  evidence_stale: 'evidence_stale',
  evidence_conflicted: 'evidence_conflicted',
  no_signals: 'no_signals',
} as const)

export type PriorityReason = (typeof PRIORITY_REASONS)[keyof typeof PRIORITY_REASONS]

export function isPriorityReason(value: unknown): value is PriorityReason {
  return typeof value === 'string' && Object.hasOwn(PRIORITY_REASONS, value)
}

/* --------------------------------------------------------- uncertainty */

/**
 * The closed set of confidence levels.
 *
 * Confidence is a category, not a number. A numeric confidence invites
 * arithmetic nobody can audit; a closed ladder is reviewable and testable.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

export function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
}

/**
 * The closed set of evidence states.
 *
 * Evidence is never silently overwritten. Stale and conflicted evidence
 * remains represented alongside fresh evidence, and the planner decides
 * how to proceed.
 */
export const EVIDENCE_STATES = ['fresh', 'stale', 'conflicted', 'missing'] as const
export type EvidenceState = (typeof EVIDENCE_STATES)[number]

export function isEvidenceState(value: unknown): value is EvidenceState {
  return typeof value === 'string' && (EVIDENCE_STATES as readonly string[]).includes(value)
}

/**
 * A single piece of evidence with provenance and freshness.
 *
 * `source` is an authorized source id, never free text.
 * `observedAt` is the instant the evidence was observed.
 * `state` is the freshness/conflict state of the evidence.
 */
export interface Evidence {
  readonly evidenceId: string
  readonly source: string
  readonly observedAt: string
  readonly state: EvidenceState
  /** Present only when state is 'conflicted'. Never content. */
  readonly conflictsWith?: readonly string[]
}

/**
 * An assumption the planner has made.
 *
 * Assumptions are explicit, bounded and reversible. An assumption that
 * proves wrong is recorded as such; it is never silently discarded.
 */
export interface Assumption {
  readonly assumptionId: string
  readonly statement: string
  readonly basis: string
  readonly confidence: ConfidenceLevel
  readonly expiresAt: string
  readonly status: 'active' | 'confirmed' | 'refuted' | 'expired'
}

/* ------------------------------------------------------------- planning */

/**
 * A planned next step.
 *
 * A plan is a request, not an authority. It names a capability that must
 * exist, a verifier that must exist, and ceilings that may only be lowered.
 */
export interface PlannedStep {
  readonly stepId: string
  readonly label: string
  readonly capability: string
  readonly verifier: string
  readonly input?: Record<string, unknown>
  readonly requiresApproval?: boolean
  readonly reversible: boolean
  readonly maxAttempts: number
  readonly maxDurationMs: number
}

/**
 * A plan for a work item.
 *
 * A plan is bounded: it has a maximum number of steps, a deadline, and
 * an explicit reversibility marker. A plan that cannot be executed
 * honestly is reported as such, not padded.
 */
export interface WorkPlan {
  readonly planId: string
  readonly itemId: string
  readonly steps: readonly PlannedStep[]
  readonly assumptions: readonly Assumption[]
  readonly confidence: ConfidenceLevel
  readonly deadlineAt: string
  readonly reversible: boolean
  readonly createdAt: string
}

/* --------------------------------------------------------- coordination */

/**
 * The closed set of coordination decisions.
 *
 * A coordination decision is one of these. There is no "proceed anyway"
 * branch: a coordination failure is a refusal, not a warning.
 */
export const COORDINATION_DECISIONS = [
  'proceed',
  'wait',
  'delegate',
  'escalate',
  'stop',
] as const
export type CoordinationDecision = (typeof COORDINATION_DECISIONS)[number]

export function isCoordinationDecision(value: unknown): value is CoordinationDecision {
  return typeof value === 'string' && (COORDINATION_DECISIONS as readonly string[]).includes(value)
}

/**
 * A bounded delegation to a worker.
 *
 * A delegation carries a scope, a budget and a deadline. It cannot be
 * widened at runtime; a wider delegation requires a new one.
 */
export interface Delegation {
  readonly delegationId: string
  readonly workerId: string
  readonly capabilities: readonly string[]
  readonly contextRefs: readonly string[]
  readonly maxActions: number
  readonly maxDurationMs: number
  readonly deadlineAt: string
  readonly missionId: string | null
}

/* ---------------------------------------------------------- explainability */

/**
 * The explainable executive state.
 *
 * This is the answer to: what matters, why, what is blocked, what is
 * uncertain, next bounded action. It is a projection, not a live handle.
 */
export interface ExecutiveState {
  readonly whatMatters: readonly RankedItem[]
  readonly why: readonly string[]
  readonly whatIsBlocked: readonly string[]
  readonly whatIsUncertain: readonly string[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * A ranked work item with explicit reasoning.
 */
export interface RankedItem {
  readonly itemId: string
  readonly rank: number
  readonly priority: PriorityTier
  readonly urgency: UrgencyLevel
  readonly importance: ImportanceLevel
  readonly reasoning: readonly string[]
  readonly blockedReason: string | null
  readonly uncertainty: readonly string[]
}

/**
 * A bounded next action.
 */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'execute' | 'delegate' | 'verify' | 'wait' | 'escalate' | 'stop'
  readonly target: string
  readonly maxDurationMs: number
  readonly maxAttempts: number
  readonly deadlineAt: string
}

/**
 * Urgency level.
 */
export const URGENCY_LEVELS = ['immediate', 'soon', 'normal', 'later', 'whenever'] as const
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number]

export function isUrgencyLevel(value: unknown): value is UrgencyLevel {
  return typeof value === 'string' && (URGENCY_LEVELS as readonly string[]).includes(value)
}

/**
 * Importance level.
 */
export const IMPORTANCE_LEVELS = ['critical', 'high', 'normal', 'low', 'trivial'] as const
export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number]

export function isImportanceLevel(value: unknown): value is ImportanceLevel {
  return typeof value === 'string' && (IMPORTANCE_LEVELS as readonly string[]).includes(value)
}

/* --------------------------------------------------------- ranking result */

/**
 * The result of prioritizing a set of work items.
 */
export interface PrioritizationResult {
  readonly ranked: readonly RankedWorkItem[]
  readonly blocked: readonly BlockedWorkItem[]
  readonly deferred: readonly DeferredWorkItem[]
  readonly assumptions: readonly PlanningAssumption[]
  readonly generatedAt: string
}

/**
 * A work item with its computed priority.
 */
export interface RankedWorkItem {
  readonly itemId: string
  readonly kind: 'mission' | 'run' | 'task' | 'step'
  readonly priority: PriorityTier
  readonly urgency: UrgencyLevel
  readonly importance: ImportanceLevel
  readonly score: number
  readonly reasoning: readonly string[]
  readonly nextBoundedAction: BoundedAction
}

/**
 * A work item that cannot proceed due to a hard blocker.
 */
export interface BlockedWorkItem {
  readonly itemId: string
  readonly kind: 'mission' | 'run' | 'task' | 'step'
  readonly blocker: Blocker
  readonly reasoning: readonly string[]
}

/**
 * A work item that is intentionally deferred.
 */
export interface DeferredWorkItem {
  readonly itemId: string
  readonly kind: 'mission' | 'run' | 'task' | 'step'
  readonly reason: string
  readonly deferUntil: string | null
}

/**
 * A hard blocker that prevents work from proceeding.
 */
export type Blocker =
  | { readonly type: 'dependency-unmet'; readonly dependsOn: readonly string[] }
  | { readonly type: 'approval-pending'; readonly approvalId: string }
  | { readonly type: 'budget-exhausted'; readonly grantId: string }
  | { readonly type: 'capability-missing'; readonly capability: string }
  | { readonly type: 'stop-all' }
  | { readonly type: 'conflicted-evidence' }
  | { readonly type: 'deadline-expired'; readonly deadlineAt: string }
  | { readonly type: 'worker-unavailable'; readonly workerId: string }

/**
 * A bounded action that can be taken next.
 */
export interface PrioritizedAction {
  readonly actionId: string
  readonly kind: 'execute' | 'delegate' | 'verify' | 'wait' | 'escalate'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* ------------------------------------------------------------- planning */

/**
 * A planning assumption with confidence and expiration.
 */
export interface PlanningAssumption {
  readonly assumptionId: string
  readonly statement: string
  readonly confidence: ConfidenceLevel
  readonly source: string
  readonly evidence: readonly string[]
  readonly expiresAt: string
  readonly reversible: boolean
}

/**
 * A plan produced by the planner.
 */
export interface Plan {
  readonly planId: string
  readonly goalRef: string
  readonly steps: readonly PlannedStep[]
  readonly assumptions: readonly PlanningAssumption[]
  readonly confidence: ConfidenceLevel
  readonly reversible: boolean
  readonly createdAt: string
  readonly deadlineAt: string
}

/* --------------------------------------------------------- coordination */

/**
 * The state of workforce coordination.
 */
export interface CoordinationState {
  readonly activeDelegations: readonly Delegation[]
  readonly availableWorkers: readonly string[]
  readonly busyWorkers: readonly string[]
  readonly stoppedWorkers: readonly string[]
  readonly pendingApprovals: readonly string[]
  readonly budgetRemaining: number
  readonly stopAllActive: boolean
}

/**
 * A delegation of work to a worker.
 */
export interface DelegationRecord {
  readonly delegationId: string
  readonly workerId: string
  readonly missionId: string | null
  readonly runId: string | null
  readonly status: 'active' | 'completed' | 'failed' | 'cancelled'
  readonly assignedAt: string
  readonly deadlineAt: string
  readonly capabilities: readonly string[]
  readonly contextRefs: readonly string[]
}

/* ---------------------------------------------------------- explainability */

/**
 * An item in the executive state.
 */
export interface ExecutiveItem {
  readonly itemId: string
  readonly kind: 'mission' | 'run' | 'task' | 'step'
  readonly summary: string
  readonly reasoning: readonly string[]
  readonly evidence: readonly string[]
  readonly confidence: ConfidenceLevel
}

/* ------------------------------------------------------------------ limits */

/**
 * The code-owned ceilings. Frozen, and the source of every bound in Phase 24.
 *
 * These are not defaults. There is no code path that raises them.
 */
export const EXECUTIVE_LIMITS = Object.freeze({
  /** The longest item id. */
  maxItemIdChars: 128,
  /** The longest reasoning string. */
  maxReasoningChars: 256,
  /** The longest summary string. */
  maxSummaryChars: 256,
  /** How many items in the executive state's whatMatters list. */
  maxWhatMattersItems: 32,
  /** How many items in the executive state's whatIsBlocked list. */
  maxWhatIsBlockedItems: 32,
  /** How many items in the executive state's whatIsUncertain list. */
  maxWhatIsUncertainItems: 32,
  /** How many items in a prioritization result. */
  maxPrioritizationItems: 64,
  /** How many steps in a plan. */
  maxPlanSteps: 16,
  /** How many assumptions in a plan. */
  maxPlanAssumptions: 16,
  /** How many delegations active at once. */
  maxActiveDelegations: 8,
  /** How many reasoning strings per item. */
  maxReasoningPerItem: 8,
  /** How many uncertainty strings per item. */
  maxUncertaintyPerItem: 8,
  /** How many evidence strings per item. */
  maxEvidencePerItem: 8,
  /** A deadline within this window is urgent. */
  urgentWindowMs: 60 * 60 * 1_000,
  /** A deadline within this window is elevated. */
  elevatedWindowMs: 24 * 60 * 60 * 1_000,
  /** A deadline within this window is at least normal. */
  normalWindowMs: 72 * 60 * 60 * 1_000,
  /** Evidence older than this is stale. */
  staleEvidenceMs: 24 * 60 * 60 * 1_000,
  /** Maximum wait time before escalation. */
  maxWaitMs: 30 * 24 * 60 * 60 * 1_000,
  /** Maximum retry attempts per step. */
  maxRetryAttempts: 3,
  /** Maximum backoff for retries. */
  maxBackoffMs: 5 * 60_000,
  /** Base backoff for retries. */
  baseBackoffMs: 1_000,
  /** Jitter window for retries. */
  jitterMs: 1_000,
})

/* --------------------------------------------------------------- utilities */

/** Whether a string is a bounded opaque reference id. */
export function isExecId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= EXECUTIVE_LIMITS.maxItemIdChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/** Whether a string parses as an instant. No clock read, no repair. */
export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}
