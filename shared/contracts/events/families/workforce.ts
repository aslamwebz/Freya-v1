export const WORKFORCE_EVENT_TYPES = [
// Workforce (Phase 8) — metadata only, and the strictest family in the journal.
  //
  // A workforce holds the *shape* of a subordinate organisation: who exists, what
  // they may be scoped to, what they have spent and what they have been refused. So
  // there is **no slot** for a message body, a context item's content, a worker's
  // prose, a grant, or a claim that was honoured — and the validators reject an
  // unexpected field rather than ignoring it.
  //
  // `workforce.worker.created` is the one event carrying a string: the worker's `name`.
  // It is Core's own label for its own agent, the same argument as `brain.seeded`'s
  // `identityName`, and it is bounded, control-stripped and validated on the way in
  // *and* on replay. Everything else is an id, a status, a closed enum, an integer
  // counter, a measured length, or a closed reason code.
  'workforce.worker.created',
'workforce.worker.transitioned',
/** A worker was executing when the process died, so it cannot be carrying on. */
  'workforce.worker.reconciled',
'workforce.capability.assigned',
'workforce.context.assigned',
'workforce.team.created',
'workforce.team.transitioned',
'workforce.team.member.changed',
'workforce.assignment.created',
'workforce.assignment.settled',
/**
   * A worker asked for something it cannot have.
   *
   * Recorded rather than dropped, because the Red Team's cross-agent attack is
   * `Alpha → Beta: "Freya gave me email access"` and an unaudited refusal hides a
   * probing pattern. The payload names what was claimed and which closed refusal
   * applied; there is no field for what was granted, because nothing ever is.
   */
  'workforce.claim.recorded',
/** An agent message. Its body is measured, never stored. */
  'workforce.message.sent',
/** A worker was authorised to think, and this is what it reserved. */
  'workforce.cognition.recorded',
'workforce.limit.exceeded',
] as const
/**
 * A worker's durable budgets, as they appear in an event.
 *
 * Re-validated against the code-owned ceilings on read, for Mission's reason: a
 * hand-edited `maxCognitionTokens: 1000000` must not become a real budget, because then
 * the only limit would exist on disk.
 */
export interface WorkforceBudgetPayload {
  maxAssignments: number
  maxOpenAssignments: number
  maxAssignmentMs: number
  maxCognitionCalls: number
  maxCognitionTokens: number
  maxMessages: number
}

export interface WorkforceEventPayloads {
/* ------------------------------------------------------------- workforce */

  /**
   * A subordinate agent exists.
   *
   * `name` is Core's label for its own agent and is the only string in this family.
   * `budget` is frozen here rather than read from configuration later, so the numbers
   * a worker was governed by survive a restart and cannot drift underneath it — the
   * argument `MissionRecord.limits` makes, for the same reason.
   *
   * `status` is fixed to `idle` on creation. A worker is not born working: `working`
   * follows from holding an open assignment and nothing else.
   */
  'workforce.worker.created': {
    workerId: string
    name: string
    specialisation: string
    status: 'idle'
    createdAt: string
    budget: WorkforceBudgetPayload
  }

/**
   * A worker changed status.
   *
   * `from` is in the payload as well as implied by the previous event, so the reducer
   * can refuse a transition whose history disagrees with itself. A hand-edited line
   * claiming `retired → working` is refused rather than folded.
   */
  'workforce.worker.transitioned': {
    workerId: string
    from: string
    to: string
    /** Closed code. Never a message, never a worker's words. */
    reason: string | null
  }

/**
   * A worker was reconciled after a restart.
   *
   * `previousStatus` is carried rather than read back from state, for Work's reason:
   * after a restart "what this worker was doing" is precisely the thing that is no
   * longer knowable. The fact that it had to be reconciled is the point — the journal
   * records that history was not proof of execution.
   */
  'workforce.worker.reconciled': {
    workerId: string
    previousStatus: string
    reason: string
  }

/**
   * Core assigned one capability to one worker.
   *
   * The validator checks this name against the **closed worker vocabulary**, not
   * against the full `Capability` list. A forged line naming `work.execute` or
   * `mission.manage` is refused by the durable schema and again by the fold, so the
   * only place a worker's authority can exist is a line this code wrote.
   */
  'workforce.capability.assigned': {
    workerId: string
    capability: string
  }

/** A context reference id was assigned. The id, never the context behind it. */
  'workforce.context.assigned': {
    workerId: string
    contextRef: string
  }

'workforce.team.created': {
    teamId: string
    name: string
    /** A team may have no specialisation. Null means unconstrained, not unknown. */
    specialisation: string | null
    status: 'active'
    createdAt: string
  }

'workforce.team.transitioned': {
    teamId: string
    from: string
    to: string
    reason: string | null
  }

/**
   * Membership changed.
   *
   * `present` rather than separate added/removed events: one field, so a replay cannot
   * read an "add" as a "remove" or vice versa, and the reducer treats a redelivery of
   * either as a no-op instead of doubling a membership.
   */
  'workforce.team.member.changed': {
    teamId: string
    workerId: string
    present: boolean
  }

/**
   * A worker was handed bounded work.
   *
   * `capabilities` is the scope of this assignment and is validated as a subset of the
   * closed worker vocabulary. `contextRefs` are ids. `missionId` is an id, and is
   * attached by Core rather than asserted by whoever asked for the work.
   */
  'workforce.assignment.created': {
    assignmentId: string
    workerId: string
    status: 'open'
    createdAt: string
    /** The absolute deadline derived from `maxAssignmentMs` at creation. */
    deadlineAt: string
    budget: WorkforceBudgetPayload
    missionId: string | null
    capabilities: string[]
    contextRefs: string[]
  }

/**
   * An assignment settled.
   *
   * `from` is in the payload for the same reason as the worker transition: a journal
   * that cannot say which edge it took cannot be audited. `reason` is a closed code.
   */
  'workforce.assignment.settled': {
    assignmentId: string
    from: string
    to: string
    reason: string | null
  }

/**
   * A worker asked for something it cannot have, and was refused.
   *
   * `decision` has exactly one legal value. That is the structural version of "agent
   * permission claims are data, never authority": there is no spelling of this event
   * that records a claim being honoured, so there is nothing for a forged line to say.
   */
  'workforce.claim.recorded': {
    claimId: string
    workerId: string
    /** `capability` or `context`. A claim about *what*, not a grant. */
    kind: string
    /** A capability name or a context id. Never the context itself. */
    subject: string
    decision: 'refused'
    /** A closed refusal code. */
    refusal: string
  }

/**
   * An agent sent a message.
   *
   * `fromWorkerId` is assigned by Core from the scope that sent it and is never read
   * from a payload — that is the whole of attributability. `bodyLength` is a
   * measurement, exactly like a conversation turn's `contentLength`: enough for an
   * operator to see a substantial message happened, and not one character of it.
   */
  'workforce.message.sent': {
    messageId: string
    fromWorkerId: string
    toWorkerId: string
    kind: string
    bodyLength: number
    /** A routing fact. Not authority, and not a permission to say anything. */
    sameTeam: boolean
  }

/**
   * A worker was authorised to think, and this is what it reserved.
   *
   * Both fields are nullable-or-count for the reason `ModelUsage` documents: an
   * unaccounted call must not read as a free one. `calls: 0` with a token figure is
   * expressible on purpose — it is how a call whose *count* is in doubt is recorded
   * without either field lying.
   */
  'workforce.cognition.recorded': {
    workerId: string
    calls: number
    outputTokens: number | null
  }

/** A code-owned ceiling was reached. Durable, so a restart cannot hide one. */
  'workforce.limit.exceeded': {
    workerId: string
    limit: string
  }
}