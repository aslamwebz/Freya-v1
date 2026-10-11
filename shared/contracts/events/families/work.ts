import type { PrincipalId } from '../../identity'
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
export interface WorkEventPayloads {
/* ----------------------------------------------------------------- work */

  /**
   * A Run was planned.
   *
   * `steps` names each step's id, key and the two registered things it depends on.
   * A capability *name* is safe here the way a Brain entity's *type* is safe: it is
   * a closed vocabulary this Core already holds. What the step was asked to do is
   * not, and never will be.
   */
  'work.run.created': {
    runId: string
    kind: string
    taskId: string | null
    /**
     * An opaque parent reference.
     *
     * Deliberately untyped: Phase 7 owns what a Mission is, and Work must not
     * grow a Mission-shaped field by accident. Two bounded tokens and nothing
     * more, so a later phase can attach without this schema changing shape.
     */
    parentKind: string | null
    parentId: string | null
    /** The ceilings this Run actually runs under, after clamping. */
    limits: {
      maxSteps: number
      maxActions: number
      maxDurationMs: number
      maxAttemptsPerStep: number
    }
    steps: readonly {
      stepId: string
      key: string
      capability: string
      verifier: string
    }[]
  }

'work.run.started': { runId: string }

'work.run.resumed': { runId: string; reason: string | null }

'work.run.paused': { runId: string; reason: string }

'work.run.waiting': { runId: string; reason: string }

'work.run.awaiting_approval': { runId: string; reason: string }

'work.run.completed': { runId: string; stepCount: number; verifiedCount: number }

'work.run.failed': {
    runId: string
    reason: string
    stepCount: number
    verifiedCount: number
  }

'work.run.cancelled': { runId: string; reason: string }

'work.run.recovered': { runId: string; previousStatus: string; reason: string }

'work.step.ready': { runId: string; stepId: string; stepKey: string }

'work.step.started': {
    runId: string
    stepId: string
    stepKey: string
    index: number
    capability: string
    attempt: number
  }

'work.step.verified': { runId: string; stepId: string; attempt: number }

'work.step.failed': { runId: string; stepId: string; reason: string }

'work.step.cancelled': { runId: string; stepId: string; reason: string }

'work.step.skipped': { runId: string; stepId: string; reason: string }

/**
   * A capability was actually attempted.
   *
   * The distinction the architecture insists on is right here: `work.step.started`
   * says work was *intended* and this says something was *tried*. `principal` is a
   * claim about who executed, assigned by Core and never taken from a payload.
   */
  'work.action.started': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    capability: string
    principal: PrincipalId
  }

'work.action.completed': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    durationMs: number
  }

/**
   * A failed action. Not a failed Step, and emphatically not a failed Run: the
   * step still holds its remaining attempts and each one gets its own events, so a
   * flapping capability's history stays visible rather than collapsing into one
   * error.
   */
  'work.action.failed': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    reason: string
    durationMs: number
  }

'work.action.cancelled': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    reason: string
  }

/**
   * Evidence was recorded.
   *
   * Both lengths, never the text. This is the whole reason a Work journal is safe
   * to keep in a backup: what a capability said stays in the process holding it.
   */
  'work.observation.recorded': {
    runId: string
    stepId: string
    actionId: string | null
    observationId: string
    kind: string
    summaryLength: number
    detailLength: number
  }

/** Verification is requested on every attempt, including the ones that fail. */
  'work.verification.requested': {
    runId: string
    stepId: string
    verificationId: string
    verifier: string
  }

'work.verification.completed': {
    runId: string
    stepId: string
    verificationId: string
    verdict: 'passed' | 'failed'
    reason: string
  }

/**
   * Approval was requested, and the Run stopped.
   *
   * Enough to decide it and nothing that could be acted on: the capability that
   * asked, the Guard capability it needs, its risk class, why approval was
   * required, and one bounded sentence describing the effect. The step's *input*
   * is deliberately absent — describing the effect is the capability's job, and a
   * plan cannot rewrite what it is about to do by writing a flattering `proposal`.
   */
  'work.approval.requested': {
    approvalId: string
    runId: string
    stepId: string
    capability: string
    requiredCapability: string
    risk: 'none' | 'routine' | 'consequential'
    principal: PrincipalId
    justification: string
    proposal: string
  }

'work.approval.approved': {
    approvalId: string
    runId: string
    stepId: string
    decidedBy: PrincipalId
    decisionSource: string
  }

'work.approval.denied': {
    approvalId: string
    runId: string
    stepId: string
    decidedBy: PrincipalId
    decisionSource: string
    reason: string
  }

'work.approval.cancelled': { approvalId: string; runId: string; stepId: string; reason: string }

'work.approval.expired': { approvalId: string; runId: string; stepId: string; reason: string }

/** The title is a measurement. As with an entity name, and for the same reason. */
  'work.task.created': { taskId: string; titleLength: number }

'work.task.updated': { taskId: string; status: string }

'work.task.attached': { taskId: string; runId: string }

'work.task.completed': { taskId: string; status: string }

'work.limits.exceeded': { runId: string; limit: string; reason: string; observed: number }
}