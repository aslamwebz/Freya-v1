export const MISSION_EVENT_TYPES = [
/**
   * A Phase 47 autonomy transition, for any edge the six named lifecycle events do
   * not name.
   *
   * A separate type rather than overloading `mission.activated` and friends, because
   * those six name *specific historical facts* — activated, resumed, paused — and a
   * journal that cannot tell a first activation from a resume cannot answer "was this
   * ever stopped?". `from` and `to` are carried explicitly so the reducer can refuse a
   * transition whose history does not agree with itself.
   */
  'mission.transitioned',
/**
   * A plan was committed.
   *
   * The whole plan arrives in one event, and every step in it is validated before the
   * commit is accepted: a plan with one unreadable step is refused whole rather than
   * half-committed. `revision` is checked against the Mission's own count, so a journal
   * cannot jump revisions to slip past the replan ceiling.
   */
  'mission.plan.committed',
/** One step changed status. */
  'mission.step.transitioned',
/**
   * A step's action was in flight when the process stopped.
   *
   * The honest record of an unknown effect. Its presence is what stops a restart from
   * re-running something that may already have happened.
   */
  'mission.step.interrupted',
/**
   * Evidence was recorded.
   *
   * `origin` is the load-bearing field: `observed` counts toward an outcome and
   * `reported` does not. A capability saying it found twelve things is `reported`.
   */
  'mission.evidence.recorded',
/** A blocker was raised or cleared. */
  'mission.blocker.changed',
/**
   * A step asked Work for a gate and Work opened one. A pointer, not a decision.
   *
   * There is deliberately **no** `mission.approval.decided` and **no**
   * `mission.approval.expired` in this closed list. A person's decision is recorded once,
   * by `work.approval.decided`; an unanswered gate is recorded once, by
   * `work.approval.expired`. A Mission event carrying either would be a second record of
   * the same fact that Core cannot enforce the truth of — and two records of one decision
   * is one more than a journal needs in order to disagree with itself.
   */
  'mission.approval.requested',
/** A durable, bounded next wake. `dueAt` is required on every one. */
  'mission.wake.scheduled',
/** That wake fired. A fact, and never an authorisation. */
  'mission.wake.fired',
/** What Freya decided to do next, and why. */
  'mission.continuation.decided',
/** A budget dimension was consumed. Counts only, never a total a caller supplies. */
  'mission.budget.spent',
/** A budget ceiling was reached. Recorded so a restart cannot hide one. */
  'mission.budget.exceeded',
/**
   * An owner correction was applied to this Mission.
   *
   * `changedFields` is a list of *field names*. The most this event can say is "the
   * context changed" — the new context itself is private and lives in the encrypted
   * intent store, exactly as the original did.
   */
  'mission.intent.corrected',
/**
   * An owner correction could not be resolved to one reading.
   *
   * Nothing changed. No constraint moved, no step was settled, no evidence discarded.
   * The Mission asked the owner instead of guessing, and that refusal is the record.
   */
  'mission.correction.ambiguous',
// Mission (Phase 7) — metadata only, and the strictest family in the journal.
  //
  // A Mission holds the most private text Freya will ever store: what a person is
  // trying to achieve. So there is **no slot** for a title, an intent, a success
  // criterion or a note, and the validators reject an unexpected field rather than
  // ignoring it. A payload with the right fields plus an `intent` would pass every
  // field check and quietly keep the intent.
  //
  // Every payload is an id, a status, a count, an instant, a closed reason code, a
  // verifier id, or a list of ids.
  'mission.created',
'mission.content.updated',
'mission.deleted',
'mission.activated',
'mission.paused',
'mission.resumed',
'mission.cancelled',
'mission.failed',
'mission.completed',
'mission.run.attached',
'mission.verification.requested',
'mission.verification.completed',
'mission.limit.exceeded',
] as const
/**
 * One step, as the journal carries it.
 *
 * A separate interface from `MissionStepPayload` even though the shapes match, and the
 * reason is provenance: `envelope.ts` must not import the Mission domain's record types,
 * because the envelope is the layer *below* the domain. Describing the same shape twice
 * in the two layers is the cost of that ordering, and it is cheaper than an import cycle
 * between the journal and the thing it journals.
 */
export interface MissionStepPayload {
  stepId: string
  index: number
  capability: string
  verifier: string
  dependsOn: readonly string[]
  status: string
  workerId: string | null
  runId: string | null
  attempts: number
  risk: 'none' | 'routine' | 'consequential'
  requiresApproval: boolean
  approvalId: string | null
  reason: string | null
  startedAt: string | null
  settledAt: string | null
}

/** Ceilings as they appear in a durable event. Re-validated against code on read. */
export interface MissionLimitsPayload {
  maxChildRuns: number
  maxConcurrentChildRuns: number
  lifetimeMs: number
  verificationDeadlineMs: number
  maxRetainedMissions: number
  maxTitleChars: number
  maxIntentChars: number
  maxSuccessCriteria: number
  maxCriterionChars: number
}

/**
 * Phase 47 autonomy ceilings, as they appear in `mission.created`.
 *
 * Separate from `MissionLimitsPayload` because the two bound different things:
 * `limits` bounds child Runs, `budget` bounds what the Mission does itself. Fusing
 * them would make "raise the retry ceiling" a way to raise the child-Run ceiling.
 *
 * There is deliberately no `maxMoney` field anywhere in this shape. Freya has no way
 * to represent spending money, so no code path can be written that does it.
 */
export interface MissionBudgetPayload {
  maxModelCalls: number
  maxActions: number
  maxExternalRequests: number
  maxDurationMs: number
  maxRetries: number
  maxDelegations: number
  maxConcurrentDelegations: number
  maxPlanRevisions: number
  maxStepsPerPlan: number
}

/**
 * One step, as it appears inside a `mission.plan.committed` payload.
 *
 * No `label`. A step's description is exactly the kind of sentence that would make a
 * Mission journal readable to somebody it was never meant to be readable by, and a
 * planner that wanted one would have to smuggle it through a capability name.
 */
export interface MissionStepPayload {
  stepId: string
  index: number
  capability: string
  verifier: string
  dependsOn: readonly string[]
  status: string
  workerId: string | null
  runId: string | null
  attempts: number
  risk: 'none' | 'routine' | 'consequential'
  requiresApproval: boolean
  approvalId: string | null
  reason: string | null
  startedAt: string | null
  settledAt: string | null
}

/**
 * A Mission lifecycle transition, for all nine transition events.
 *
 * `from` is in the payload as well as implied by the previous event, so the reducer can
 * refuse a transition whose history does not agree with itself. A hand-edited line
 * claiming `draft → completed` is refused rather than folded, which is what stops a
 * replayed journal manufacturing a completed Mission with no verification behind it.
 */
export interface MissionTransitionPayload {
  missionId: string
  from: string
  to: string
  reason: string | null
  /** Present on completion only: which verifier established it. An id. */
  verifierId: string | null
}

export interface MissionEventPayloads {
/* --------------------------------------------------------------- mission */

  /**
   * A Mission exists.
   *
   * `deadlineAt` rather than a lifetime in milliseconds: the wall-clock bound is
   * resolved once, at creation, so every later reader agrees about when the Mission
   * expires without re-deriving it and without a timer watching it.
   */
  'mission.content.updated': { missionId: string }

'mission.deleted': { missionId: string }

'mission.created': {
    missionId: string
    status: 'draft'
    createdAt: string
    deadlineAt: string
    limits: MissionLimitsPayload
    /**
     * Phase 47. Optional on the wire so a journal written by an earlier build still
     * validates; absent means the code-owned ceiling, which is the *same* bound a new
     * Mission would be allowed — so reading an old journal cannot grant more than
     * creating a new one.
     */
    budget?: MissionBudgetPayload
    priority?: string
    /**
     * The two numbers about the goal. Both are counts, which is why they may be here:
     * progress has to be computable, and refusing to store them would force the
     * projection to invent a percentage instead.
     */
    requestedQuantity?: number | null
  }

/**
   * A lifecycle transition.
   *
   * `from` is in the payload as well as implied by the previous event, so the
   * reducer can refuse a transition whose history does not agree with itself. A
   * hand-edited line claiming `draft → completed` is refused rather than folded,
   * which is what stops a replayed journal manufacturing a completed Mission with
   * no verification behind it.
   */
  'mission.activated': MissionTransitionPayload

'mission.paused': MissionTransitionPayload

'mission.resumed': MissionTransitionPayload

'mission.cancelled': MissionTransitionPayload

'mission.failed': MissionTransitionPayload

'mission.completed': MissionTransitionPayload

/** A child Run was attached. Ids only. */
  'mission.run.attached': {
    missionId: string
    runId: string
    taskId: string | null
  }

/**
   * Completion verification was requested.
   *
   * `runIds` names what this request required. No evidence, no expectation text,
   * no verifier internals.
   */
  'mission.verification.requested': {
    missionId: string
    verifierId: string
    runIds: string[]
  }

/**
   * Verification answered.
   *
   * `outcome` and `reason` are both closed codes. A verifier's message and its
   * evidence are both deliberately absent: a verifier is the component most likely
   * to hold something private, and this is the boundary it cannot cross.
   */
  'mission.verification.completed': {
    missionId: string
    verifierId: string
    outcome: 'passed' | 'not_established' | 'timeout' | 'cancelled'
    reason: string | null
  }

/** A code-owned ceiling stopped a child Run. Durable, so a restart cannot hide it. */
  'mission.limit.exceeded': {
    missionId: string
    limit: 'maxChildRuns' | 'maxConcurrentChildRuns' | 'lifetimeMs'
  }

/* ------------------------------------------ mission autonomy (Phase 47) */

  /** Any lifecycle edge the six named events do not name. */
  'mission.transitioned': MissionTransitionPayload

/** A bounded plan, committed whole or not at all. */
  'mission.plan.committed': {
    missionId: string
    planId: string
    revision: number
    supersedes: string | null
    reason: string | null
    steps: readonly MissionStepPayload[]
  }

/** One step changed status. `from` is carried so the fold can refuse a liar. */
  'mission.step.transitioned': {
    missionId: string
    planId: string
    stepId: string
    from: string
    to: string
    workerId: string | null
    runId: string | null
    attempts: number
    reason: string | null
  }

/**
   * An action was in flight when the process stopped.
   *
   * `consequential` is recorded so a restart knows the external effect is unknown
   * rather than merely unfinished — the difference between "retry" and "ask".
   */
  'mission.step.interrupted': {
    missionId: string
    planId: string
    stepId: string
    consequential: boolean
  }

/**
   * Evidence.
   *
   * `summaryLength` is a measurement, the same argument as `work.task.created`'s
   * `titleLength`. There is no `summary` field, so no spelling of this payload
   * carries content.
   */
  'mission.evidence.recorded': {
    missionId: string
    evidenceId: string
    stepId: string | null
    kind: 'result' | 'observation' | 'report' | 'refusal'
    origin: 'observed' | 'reported'
    summaryLength: number
    expiresAt: string | null
  }

'mission.blocker.changed': {
    missionId: string
    code: string
    stepId: string | null
    raised: boolean
  }

/**
   * A Mission step asked Work for a gate, and Work opened one.
   *
   * There is no `mission.approval.decided` or `mission.approval.expired`, and their
   * absence is the design. A person answers an approval exactly once, on Work's surface,
   * through `work.approval.decide`, which evaluates `work.approval.decide` on the owner
   * and is the only path in the codebase where an approval becomes `approved`. A Mission
   * event that could record a decision would be a second door, and it would be one
   * nothing enforces.
   *
   * So this event says only **"this Mission is now waiting on that Work approval"**, and
   * `approvalId` is Work's own id — the same one `work.approval.requested` carries. The
   * Mission holds a pointer to a gate it does not own; the gate's outcome is read back
   * from Work, never written here.
   *
   * `source` is `requested` when the Mission's plan asked for the gate up front and
   * `observed` when Work's Guard demanded one the plan did not anticipate. That
   * distinction matters to a person reading the feed: a gate nobody predicted is a fact
   * about the capability, not about the goal.
   */
  'mission.approval.requested': {
    missionId: string
    stepId: string
    approvalId: string
    source: 'requested' | 'observed'
    /** Work's own open instant, copied from `work.approval.requested`. Not a new clock. */
    requestedAt: string
  }

/**
   * The next wake.
   *
   * `dueAt` is required for every kind, including an event wake. A wake with no end is
   * the open-ended wait this subsystem must not be able to record.
   */
  'mission.wake.scheduled': {
    missionId: string
    wakeId: string
    kind: 'event' | 'time' | 'manual'
    source: 'fabric' | 'time' | 'owner'
    dueAt: string
    eventType: string | null
  }

'mission.wake.fired': {
    missionId: string
    wakeId: string
  }

/**
   * What to do next.
   *
   * `nextWakeAt` is required exactly when `decision` is `wait` and forbidden
   * otherwise, and both halves are checked in the validator and again in the fold.
   */
  'mission.continuation.decided': {
    missionId: string
    decision: string
    reason: string
    stepId: string | null
    nextWakeAt: string | null
  }

/** Consumption. Five counts, all non-negative, never a total a caller may supply. */
  'mission.budget.spent': {
    missionId: string
    modelCalls: number
    actions: number
    externalRequests: number
    retries: number
    delegations: number
  }

'mission.budget.exceeded': {
    missionId: string
    budget: string
  }

/**
   * An applied correction.
   *
   * Field *names*, counts, and ids. The most this can say is "the location changed",
   * and the new location is private and lives in the encrypted intent store.
   *
   * `requestedQuantity` is the single exception, and it exists because it is the one
   * intent field the journal has always been allowed to hold — `mission.created`
   * carries it too — so leaving it out here would make a corrected quantity survive in
   * memory and revert on the next restart. It is bound to `changedFields` containing
   * `'quantity'` by the validator, so it cannot ride along on a correction that did not
   * change the quantity, and it is a count: it says how many, never of what.
   */
  'mission.intent.corrected': {
    missionId: string
    correctionId: string
    kind: 'patch'
    changedFields: readonly string[]
    settledSteps: number
    preservedEvidence: number
    replannedFrom: string | null
    requestedQuantity?: number | null
  }

/**
   * An ambiguous correction.
   *
   * There is no `kind` here, and that asymmetry is the design: a recorded ambiguity
   * has exactly one meaning, so it cannot also mean "applied".
   */
  'mission.correction.ambiguous': {
    missionId: string
    correctionId: string
    ambiguity: string
  }
}