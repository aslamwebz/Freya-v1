/**
 * Closed reasons.
 *
 * Anything that reaches a durable Mission event is one of these. A free-text reason
 * in the journal would be a place for private content to leak, and a place for a
 * thrown exception's message to end up on disk.
 *
 * The Phase 47 codes are grouped by the thing they explain — planning, delegation,
 * execution, verification, budget, wake, correction — because the grouping is what
 * makes a board row readable. They add names, never free text: the vocabulary is
 * still closed, and `events/validate.ts` derives its accepted set from this object so
 * a code cannot exist in one place and be refused in the other.
 */
export const MISSION_REASONS = Object.freeze({
  owner: 'owner',
  verification_passed: 'verification_passed',
  verification_not_established: 'verification_not_established',
  verification_timeout: 'verification_timeout',
  no_child_runs: 'no_child_runs',
  child_run_failed: 'child_run_failed',
  child_run_cancelled: 'child_run_cancelled',
  child_run_unverified: 'child_run_unverified',
  deadline_expired: 'deadline_expired',
  child_run_limit: 'child_run_limit',
  concurrent_run_limit: 'concurrent_run_limit',
  retention_limit: 'retention_limit',
  lifetime_limit: 'lifetime_limit',
  recovery: 'recovery',
  shutdown: 'shutdown',

  // --- planning ---
  /** The goal was understood and a Mission may begin. `draft → ready`. */
  goal_understood: 'goal_understood',
  /** A bounded plan is being built. */
  /** The goal has no plan yet and one is being built. The GOAL → PLAN edge. */
  goal_needs_a_plan: 'goal_needs_a_plan',
  plan_started: 'plan_started',
  /** A plan exists and execution may begin. */
  plan_committed: 'plan_committed',
  /** Every step is verified. A *request* for completion, never a completion. */
  steps_executed: 'steps_executed',
  /** A step named a capability that is not registered, so the Mission cannot proceed. */
  unknown_capability: 'unknown_capability',
  /** A step needs a capability the Mission is not permitted to use. */
  capability_unavailable: 'capability_unavailable',
  /** A step's dependency has not been verified, so it may not start. */
  dependency_unverified: 'dependency_unverified',
  /** A replan would exceed the plan-revision ceiling. No further replanning happens. */
  replan_ceiling: 'replan_ceiling',
  /** A plan was revised. Bounded, and journalled every time. */
  plan_revised: 'plan_revised',

  // --- delegation ---
  /** No registered worker holds the capability a step needs. */
  no_capable_worker: 'no_capable_worker',
  /** A named worker does not hold the capability, so it was not given the step. */
  worker_mismatch: 'worker_mismatch',
  /** The Mission is already delegating as much as it may. */
  concurrency_ceiling: 'concurrency_ceiling',
  /** A worker took the step. */
  delegated: 'delegated',

  // --- execution ---
  /** A step ran and was observed. The only reason that may lead to `verified`. */
  step_verified: 'step_verified',
  /** A step failed. */
  step_failed: 'step_failed',
  /** A step's action was in flight when the process stopped, so its effect is unknown. */
  interrupted: 'interrupted',
  /** A step was skipped because its dependency was satisfied by other evidence. */
  step_skipped: 'step_skipped',
  /** A retry was made, and the ceiling was not reached. */
  retrying: 'retrying',

  // --- verification ---
  /** Verification was requested at the Mission level. */
  verification_requested: 'verification_requested',
  /** Evidence backing the outcome has expired, so it no longer establishes anything. */
  verification_expired: 'verification_expired',
  /** A step reported success; that is a report, not an observation. */
  reported_not_observed: 'reported_not_observed',
  /** The requested quantity has not been reached by observed evidence. */
  quantity_not_reached: 'quantity_not_reached',
  /** No evidence at all was recorded against the Mission. */
  no_evidence: 'no_evidence',

  // --- budgets ---
  /** A named ceiling is exhausted. The Mission waits or fails truthfully; it never exceeds. */
  budget_exhausted: 'budget_exhausted',
  /** The retry ceiling is reached, so this step gets no further attempt. */
  retry_ceiling: 'retry_ceiling',
  /** The Mission's wall-clock bound has passed. */
  duration_ceiling: 'duration_ceiling',

  // --- waiting and wakes ---
  /** Parked until an event arrives. */
  waiting_event: 'waiting_event',
  /** Parked until a named instant. */
  waiting_time: 'waiting_time',
  /** Parked until a person resumes it. */
  waiting_manual: 'waiting_manual',
  /** A wake's instant passed without the thing it waited for. Recorded, never silently re-armed. */
  wake_missed: 'wake_missed',
  /** A wake arrived that did not match what the Mission was waiting for. */
  wake_unmatched: 'wake_unmatched',
  /** Something happened, so the Mission is awake and deciding again. */
  woken: 'woken',

  // --- approvals ---
  /** A person must decide before anything further happens. */
  approval_pending: 'approval_pending',
  /** A person said no. The Mission blocks; it does not route around it. */
  approval_denied: 'approval_denied',
  /** Nobody answered in time. Expiry is never consent. */
  approval_expired: 'approval_expired',
  /** A person said yes. Recorded with the principal that decided. */
  approval_granted: 'approval_granted',
  /** The gate was withdrawn because the step it guarded is gone. */
  approval_cancelled: 'approval_cancelled',

  // --- corrections ---
  /** An owner corrected the intent and the Mission continued under it. */
  intent_corrected: 'intent_corrected',
  /** A correction could not be resolved to one reading, so the owner was asked. */
  intent_ambiguous: 'intent_ambiguous',
  /** The owner asked for the Mission to stop without ending it. */
  intent_paused: 'intent_paused',

  // --- STOP ALL ---
  /** The panic button is latched. Nothing autonomous runs. */
  stopped: 'stopped',
  /** Only the owner reopened the gate. Never a timer, never a capability. */
  resumed: 'resumed',
} as const)



export type MissionReason = (typeof MISSION_REASONS)[keyof typeof MISSION_REASONS]