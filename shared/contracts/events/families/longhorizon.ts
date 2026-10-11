export const LONGHORIZON_EVENT_TYPES = [
// Long-Horizon Goals (Phase 31) — metadata only, and the strictest family in
  // the journal after Mission.
  //
  // A goal holds the most private text Freya will ever store: what a person is
  // trying to achieve. So there is **no slot** for a title, a description or a
  // completion criterion, and the validators reject an unexpected field rather
  // than ignoring it. A payload with the right fields plus a `title` would pass
  // every field check and quietly keep the title.
  //
  // Every payload is an id, a status, a count, an instant, a closed reason code, a
  // verifier id, or a list of ids.
  'longhorizon.goal.created',
'longhorizon.goal.content.updated',
'longhorizon.goal.deleted',
'longhorizon.goal.state-changed',
'longhorizon.goal.completed',
'longhorizon.goal.failed',
'longhorizon.goal.cancelled',
'longhorizon.goal.roadmap-updated',
'longhorizon.goal.milestone-settled',
'longhorizon.checkpoint.started',
'longhorizon.checkpoint.verified',
'longhorizon.checkpoint.failed',
'longhorizon.continuation.decided',
'longhorizon.schedule.fired',
'longhorizon.schedule.expired',
'longhorizon.wake.received',
'longhorizon.wake.denied',
] as const
/** Ceilings as they appear in a goal event. Re-validated against code on read. */
export interface GoalLimitsPayload {
  maxRetainedGoals: number
  maxTitleChars: number
  maxDescriptionChars: number
  maxCompletionCriteria: number
  maxCriterionChars: number
  maxDependencies: number
  maxCheckpointsPerGoal: number
  lifetimeMs: number
  verificationDeadlineMs: number
  maxRetryCeiling: number
  maxBackoffMs: number
  baseBackoffMs: number
}

export interface LonghorizonEventPayloads {
/* --------------------------------------------------------- long-horizon */

  /**
   * A goal exists.
   *
   * `deadlineAt` rather than a lifetime in milliseconds: the wall-clock bound is
   * resolved once, at creation, so every later reader agrees about when the goal
   * expires without re-deriving it and without a timer watching it.
   */
  'longhorizon.goal.content.updated': { goalId: string }

'longhorizon.goal.deleted': { goalId: string }

'longhorizon.goal.created': {
    goalId: string
    state: 'draft'
    createdAt: string
    deadlineAt: string
    dependencies: string[]
    limits: GoalLimitsPayload
  }

/**
   * A lifecycle transition.
   *
   * `from` is in the payload as well as implied by the previous event, so the
   * reducer can refuse a transition whose history does not agree with itself. A
   * hand-edited line claiming `draft → completed` is refused rather than folded,
   * which is what stops a replayed journal manufacturing a completed goal with
   * no verification behind it.
   */
  'longhorizon.goal.state-changed': {
    goalId: string
    from: string
    to: string
    /** Closed code. Never a message, never content. */
    reason: string | null
  }

'longhorizon.goal.completed': {
    goalId: string
    verifierId: string
  }

'longhorizon.goal.failed': {
    goalId: string
    reason: string | null
  }

'longhorizon.goal.cancelled': {
    goalId: string
    reason: string | null
  }

'longhorizon.goal.roadmap-updated': {
    goalId: string
    revision: number
    milestoneCount: number
  }

'longhorizon.goal.milestone-settled': {
    goalId: string
    milestoneId: string
    outcome: string
    revision: number
  }

/**
   * A checkpoint was started.
   *
   * `kind` is a closed code from the goal's own vocabulary. No description, no
   * evidence, no verifier internals.
   */
  'longhorizon.checkpoint.started': {
    goalId: string
    checkpointId: string
    order: number
    kind: string
  }

/**
   * A checkpoint was verified.
   *
   * `outcome` and `reason` are both closed codes. A verifier's message and its
   * evidence are both deliberately absent: a verifier is the component most likely
   * to hold something private, and this is the boundary it cannot cross.
   */
  'longhorizon.checkpoint.verified': {
    goalId: string
    checkpointId: string
    outcome: 'passed' | 'not_established' | 'timeout' | 'cancelled'
    reason: string | null
  }

'longhorizon.checkpoint.failed': {
    goalId: string
    checkpointId: string
    reason: string | null
    attempts: number
  }

/**
   * A continuation decision was made.
   *
   * `decision` is a closed code. The decision is recorded for audit, but the
   * goal's state machine is the only thing that changes a goal's state.
   */
  'longhorizon.continuation.decided': {
    goalId: string
    decision: 'continue' | 'pause' | 'complete' | 'fail' | 'wait'
    reason: string
  }

/** A schedule fired. One event, one fact. */
  'longhorizon.schedule.fired': {
    scheduleId: string
    goalId: string
    wakeId: string
  }

'longhorizon.schedule.expired': {
    scheduleId: string
    goalId: string
    reason: string
  }

/**
   * A wake was received.
   *
   * `source` is a closed code from the wake-source vocabulary. No payload, no
   * content, no authority claim.
   */
  'longhorizon.wake.received': {
    wakeId: string
    source: string
    goalId: string | null
  }

/**
   * A wake was denied.
   *
   * `reason` is a closed refusal code. Recorded rather than dropped, because an
   * unaudited refusal hides a probing pattern.
   */
  'longhorizon.wake.denied': {
    wakeId: string
    source: string
    goalId: string | null
    reason: string
  }
}