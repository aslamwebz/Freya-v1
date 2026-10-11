export const WORK_EVENT_TYPES = [
// Work — the execution substrate. Metadata only, for the same reason as Brain
  // and with more force: a Step's input and an Observation's contents are the
  // content, and this file is the least protected place anything in Core could go.
  //
  // So a Work event carries ids, statuses, counts, risk classes and *measured
  // lengths*. `summaryLength` and `detailLength` are how a reader learns something
  // substantial happened without the journal becoming a transcript of what every
  // capability returned. Nothing here names a label, a task title, a step input,
  // a summary or a capability's data.
  //
  // `work.run.awaiting_approval` is recorded separately from `work.run.waiting`
  // even though one gates the other, because a board has to be able to tell "a
  // person is being asked" from "something external is pending".
  'work.run.created',
'work.run.started',
'work.run.resumed',
'work.run.paused',
'work.run.waiting',
'work.run.awaiting_approval',
'work.run.completed',
'work.run.failed',
'work.run.cancelled',
/**
   * A Run was reconciled after a restart.
   *
   * `previousStatus` is carried in the payload rather than read back out of state,
   * because after a restart "what this Run was doing" is precisely the thing that
   * is no longer knowable. The fact that a status had to be reconciled is the
   * point: the journal records that history was *not* proof of execution.
   */
  'work.run.recovered',
'work.step.ready',
'work.step.started',
'work.step.verified',
'work.step.failed',
'work.step.cancelled',
'work.step.skipped',
'work.action.started',
'work.action.completed',
'work.action.failed',
'work.action.cancelled',
/** Evidence, measured. The contents stay in the process that holds them. */
  'work.observation.recorded',
'work.verification.requested',
'work.verification.completed',
/**
   * Approval is first-class execution state, so it is an event family rather than
   * a boolean on an Action.
   *
   * `requested` is the transition: the Run and its Step stop and begin waiting on
   * a named decision. One event, one fact — which is also what makes "nothing ran
   * yet" checkable, because the record exists strictly before any Action does.
   */
  'work.approval.requested',
'work.approval.approved',
'work.approval.denied',
'work.approval.cancelled',
'work.approval.expired',
'work.task.created',
'work.task.updated',
'work.task.attached',
'work.task.completed',
/** A ceiling was reached. Recorded so a restart cannot hide one. */
  'work.limits.exceeded',
] as const
