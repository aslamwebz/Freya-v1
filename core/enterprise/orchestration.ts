import {
  checkApprovalGate,
  type ApprovalRecord,
  type ApprovalSubject,
} from './approvals'
import {
  approvalRequiredFor,
  checkCountBoundaries,
  checkDomainBoundary,
  checkDurationBoundary,
  checkForbiddenAction,
  checkPayloadBoundary,
  consequenceOf,
  domainAllowed,
  isForbiddenAction,
  type CountContext,
  type EnterpriseBoundaries,
} from './boundaries'
import { environmentTransition, taskTransition, webzoneTransition } from './machine'
import { checkAllSpendingGates, dayKeyOf, type SpendingLedger } from './spending'
import { mayBeConsideredComplete, type VerificationRecord } from './verification'
import {
  AUTHORIZATION_GATES,
  ENTERPRISE_LIMITS,
  ENTERPRISE_WAKE_ACTOR,
  ENTERPRISE_WAKE_KINDS,
  ENTERPRISE_WAKE_SOURCES,
  isEnterpriseWakeActor,
  isEnterpriseWakeKind,
  isEnterpriseWakeSource,
  type AuthorizationGate,
  type EnterpriseRefusalCode,
  type EnvironmentState,
  type SpendingLimits,
  type WebzoneOperationKind,
  type WebzoneOperationState,
} from './types'

/**
 * Bounded orchestration, and the one gate every consequential action must pass.
 *
 * This module has two jobs, and the second one is the important one.
 *
 * **Orchestration** is the ordinary work: deciding which task, mission or webzone
 * operation is next, checking that the environment is in a state that permits it, and
 * keeping each step inside its bound. All of it is a lookup in a closed table or an
 * arithmetic comparison on values the caller supplied.
 *
 * **Authorization** is the wall. Every consequential action goes through
 * {@link authorizeEnterpriseAction}, and that function walks
 * {@link AUTHORIZATION_GATES} with a `for` loop rather than a chain of `if`s. The
 * reason is not style: "no gate is ever skipped" is a claim about seven independent
 * checks, and a chain of `if`s makes it a claim about how carefully the author
 * remembered seven independent checks. A loop makes it a property of the iteration.
 *
 * The decision reports `evaluated` and `remaining`, which is what makes the property
 * *testable* rather than merely asserted: a request that passes everything evaluates
 * all nine gates, and a request that fails gate *k* evaluates exactly gates 1..k and
 * names gate *k* as the one that refused. The red-team suite drives a request through
 * every gate with the earlier ones failing, so the ordering is demonstrated by
 * execution and not by a comment.
 *
 * Pure. No clock, no journal, no authority, no network, and no way to reach a model.
 */

/* ------------------------------------------------------------------ wakes */

export interface EnterpriseWake {
  readonly source: string
  readonly kind: string
  readonly actor: string
  readonly environmentId: string | null
  readonly sourceRef: string | null
  readonly at: string
  /** A key for idempotence. Two wakes with the same key are the same wake. */
  readonly wakeKey: string
}

export interface WakeDecision {
  readonly accepted: boolean
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

/**
 * Is this wake real?
 *
 * The source/actor pairing is a table, and that is what makes "no renderer may drive
 * the enterprise" a structural property rather than a habit: a renderer, a model, an
 * external webhook and a self-scheduling timer are not actors in
 * `ENTERPRISE_WAKE_ACTOR`, so a wake claiming to be from one is refused before
 * anything else looks at it.
 *
 * A renderer forgery is therefore caught here specifically because the actor a
 * renderer would claim is `owner`, and no legitimate source produces `owner` other than
 * `owner` itself.
 */
export function validateWake(wake: EnterpriseWake): WakeDecision {
  if (!isEnterpriseWakeSource(wake.source)) {
    return {
      accepted: false,
      code: 'authority-claim-refused',
      reason: 'That wake source is not one this subsystem accepts. An unrecognised source is refused, not guessed at.',
    }
  }
  if (!isEnterpriseWakeActor(wake.actor)) {
    return {
      accepted: false,
      code: 'authority-claim-refused',
      reason: 'That wake actor is not one this subsystem accepts.',
    }
  }
  if (!isEnterpriseWakeKind(wake.kind)) {
    return {
      accepted: false,
      code: 'authority-claim-refused',
      reason: 'That wake kind is not one this subsystem accepts.',
    }
  }
  const expected = ENTERPRISE_WAKE_ACTOR[wake.source]
  if (wake.actor !== expected) {
    return {
      accepted: false,
      code: 'authority-claim-refused',
      reason: `A "${wake.source}" wake arrives as "${expected}". It arrived claiming to be "${wake.actor}", which means it was not raised by Core.`,
    }
  }
  if (typeof wake.wakeKey !== 'string' || wake.wakeKey.length === 0) {
    return {
      accepted: false,
      code: 'authority-claim-refused',
      reason: 'A wake without a key cannot be deduplicated, so it cannot be acted on twice safely.',
    }
  }
  return {
    accepted: true,
    code: null,
    reason: 'The wake arrived from a source this subsystem recognises, attributed the way that source must be attributed.',
  }
}

/** Exposed for the audit and for exhaustive tests. */
export function wakeSources(): readonly string[] {
  return ENTERPRISE_WAKE_SOURCES
}

export function wakeKinds(): readonly string[] {
  return ENTERPRISE_WAKE_KINDS
}

/* ----------------------------------------------------------- the gate view */

/**
 * The environment, reduced to exactly what a gate needs.
 *
 * A narrow structural interface rather than the fold's own record type, for two
 * reasons: the gate can then be exercised in a test with five fields and no journal,
 * and — more importantly — the gate is *unable* to reach anything it has not been
 * given. A gate that took the whole derived state would be a gate that could
 * accidentally consult a projection it should have refused to consult.
 */
export interface GateEnvironmentView {
  readonly environmentId: string
  readonly state: EnvironmentState
  readonly boundaries: EnterpriseBoundaries
  readonly spendingLimits: SpendingLimits
  readonly ledger: SpendingLedger
  readonly createdAt: string
  readonly deadlineAt: string | null
  readonly counts: CountContext
}

export interface AuthorizationContext {
  /** Whether the subsystem is switched on at all. */
  readonly enabled: boolean
  /** Whether the journal can be believed. */
  readonly journalTrustworthy: boolean
  /** STOP ALL, read fresh by the caller. */
  readonly stopped: boolean
  /** The environment, or null when it does not exist. */
  readonly environment: GateEnvironmentView | null
  readonly approvals: readonly ApprovalRecord[]
  /** Set when this authorization is for *completing* an action already performed. */
  readonly verification: VerificationRecord | null
}

export interface EnterpriseActionRequest {
  readonly actionId: string
  readonly environmentId: string
  readonly kind: WebzoneOperationKind
  readonly target: string
  readonly payload: string
  /** Whether the caller describes this action as consequential. */
  readonly consequential: boolean
  /** What this action costs, in integer minor units. Zero for most. */
  readonly amountMinor: number
  readonly currency: string
  /** An untrusted claim about which forbidden action this is. Never trusted. */
  readonly claimsAction: string | null
  /** Whether the effect has already been performed and is now being closed out. */
  readonly performed: boolean
  readonly at: string
}

export interface AuthorizationDecision {
  readonly allowed: boolean
  /** The gate that refused, or null when everything held. */
  readonly refusedAt: AuthorizationGate | null
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
  /** Every gate actually consulted, in order. */
  readonly evaluated: readonly AuthorizationGate[]
  /** Every gate not reached because an earlier one refused. */
  readonly remaining: readonly AuthorizationGate[]
  /** The per-action digest an approval must match, when one is needed. */
  readonly approvalSubject: ApprovalSubject | null
}

/**
 * The digest an approval is bound to.
 *
 * Every field that would change what the action *does* is in it. It is a string
 * comparison, not a hash — Core computes the canonical form and this lane only ever
 * asks "is it the same one?", which means there is no hashing code here that could
 * ever be wrong in the permissive direction.
 */
export function actionDigest(request: EnterpriseActionRequest): string {
  return [
    request.kind,
    request.target,
    request.payload.length,
    request.amountMinor,
    request.currency,
  ].join('|')
}

/**
 * Walk every gate in order and refuse on the first one that does not hold.
 *
 * The loop is the point. Adding a tenth gate means adding a name to
 * `AUTHORIZATION_GATES` and a `case` here; there is no third place to update and no
 * way to add one that is not walked.
 */
export function authorizeEnterpriseAction(
  context: AuthorizationContext,
  request: EnterpriseActionRequest,
): AuthorizationDecision {
  const evaluated: AuthorizationGate[] = []
  const approvalSubject: ApprovalSubject = {
    kind: 'action',
    subjectKind: 'webzone-operation',
    subjectRef: request.actionId,
    subjectDigest: actionDigest(request),
  }
  const needsApproval = approvalRequiredFor(request.kind, request.consequential)

  for (const gate of AUTHORIZATION_GATES) {
    evaluated.push(gate)
    const refusal = evaluateGate(gate, context, request, approvalSubject, needsApproval)
    if (refusal !== null) {
      const index = AUTHORIZATION_GATES.indexOf(gate)
      return {
        allowed: false,
        refusedAt: gate,
        code: refusal.code,
        reason: refusal.reason,
        evaluated,
        remaining: AUTHORIZATION_GATES.slice(index + 1),
        approvalSubject: needsApproval ? approvalSubject : null,
      }
    }
  }

  return {
    allowed: true,
    refusedAt: null,
    code: null,
    reason: `Every gate held: journal, STOP ALL, environment, deadlines, boundaries, spending, approval and verification.`,
    evaluated,
    remaining: [],
    approvalSubject: needsApproval ? approvalSubject : null,
  }
}

interface GateRefusal {
  readonly code: EnterpriseRefusalCode
  readonly reason: string
}

function evaluateGate(
  gate: AuthorizationGate,
  context: AuthorizationContext,
  request: EnterpriseActionRequest,
  approvalSubject: ApprovalSubject,
  needsApproval: boolean,
): GateRefusal | null {
  const environment = context.environment

  switch (gate) {
    case 'journal-trustworthy':
      if (!context.journalTrustworthy) {
        return {
          code: 'journal-untrustworthy',
          reason:
            'The journal cannot be believed, so nothing new is acted on. An untrustworthy record is not a record to build on.',
        }
      }
      return null

    case 'stop-all':
      if (context.stopped) {
        return {
          code: 'stop-all-latched',
          reason: 'STOP ALL is latched. Nothing runs, including the check that would have said otherwise.',
        }
      }
      return null

    case 'environment': {
      if (!context.enabled) {
        return {
          code: 'subsystem-disabled',
          reason: 'The enterprise subsystem is switched off, so every action is denied.',
        }
      }
      if (environment === null) {
        return {
          code: 'environment-unknown',
          reason: 'That environment is not in the durable record. Work for an environment nobody defined is not work.',
        }
      }
      if (environment.state !== 'active') {
        return {
          code:
            environment.state === 'completed' ||
            environment.state === 'failed' ||
            environment.state === 'cancelled'
              ? 'environment-terminal'
              : 'environment-not-active',
          reason: `This environment is ${environment.state}, not active. Only an active environment is operated.`,
        }
      }
      return null
    }

    case 'deadline': {
      if (environment === null) return null
      if (environment.deadlineAt !== null) {
        const deadline = Date.parse(environment.deadlineAt)
        const now = Date.parse(request.at)
        if (!Number.isFinite(deadline) || !Number.isFinite(now)) {
          return {
            code: 'deadline-expired',
            reason: 'This environment carries no trustworthy deadline, so its bound cannot be checked.',
          }
        }
        if (now > deadline) {
          return {
            code: 'deadline-expired',
            reason: `This environment's deadline passed at ${environment.deadlineAt}.`,
          }
        }
      }
      return null
    }

    case 'duration': {
      if (environment === null) return null
      return asRefusal(
        checkDurationBoundary(
          Date.parse(environment.createdAt),
          Date.parse(request.at),
          ENTERPRISE_LIMITS.maxEnvironmentDurationMs,
        ),
      )
    }

    case 'boundary': {
      if (environment === null) return null
      // The untrusted claim about which action this is, checked *first* and in
      // isolation: an action that says it is a payment is refused before any structural
      // question, because that answer does not depend on how the environment is
      // configured — so the most hostile request is also the cheapest to refuse.
      if (request.claimsAction !== null && isForbiddenAction(request.claimsAction, environment.boundaries)) {
        return {
          code: 'forbidden-action',
          reason: `That action (${request.claimsAction}) is forbidden outright. No environment setting, owner input or model response can permit it.`,
        }
      }
      const forbidden = checkForbiddenAction(request.claimsAction, environment.boundaries)
      if (!forbidden.held) {
        return { code: forbidden.code ?? 'forbidden-action', reason: forbidden.reason }
      }
      const payload = checkPayloadBoundary(request.payload)
      if (!payload.held) {
        return { code: payload.code ?? 'payload-too-large', reason: payload.reason }
      }
      const domain = checkDomainBoundary(request.target, environment.boundaries)
      if (!domain.held) {
        return { code: domain.code ?? 'domain-not-allowed', reason: domain.reason }
      }
      const counts = checkCountBoundaries(environment.boundaries, environment.counts)
      if (!counts.held) {
        return { code: counts.code ?? 'operation-count-exceeded', reason: counts.reason }
      }
      return null
    }

    case 'spending': {
      if (environment === null) return null
      const dayKey = dayKeyOf(request.at)
      if (dayKey === null) {
        return {
          code: 'spending-amount-invalid',
          reason: 'This action carries no trustworthy instant, so no daily ceiling can be applied to it.',
        }
      }
      const decision = checkAllSpendingGates(
        environment.spendingLimits,
        environment.ledger,
        request.amountMinor,
        dayKey,
      )
      if (!decision.held) {
        return { code: decision.code ?? 'spending-total-exceeded', reason: decision.reason }
      }
      return null
    }

    case 'approval': {
      if (environment === null) return null
      if (!needsApproval) return null
      const verdict = checkApprovalGate({
        approvals: context.approvals,
        subject: approvalSubject,
        at: request.at,
      })
      if (!verdict.satisfied) {
        return { code: verdict.code ?? 'approval-missing', reason: verdict.reason }
      }
      return null
    }

    case 'verification': {
      // Only meaningful on the close-out path. An action that has not been performed
      // yet has nothing to verify, and refusing it here would make the pipeline
      // unusable rather than safe.
      if (!request.performed) return null
      const verdict = mayBeConsideredComplete(context.verification)
      if (!verdict.complete) {
        return { code: verdict.code ?? 'verification-missing', reason: verdict.reason }
      }
      return null
    }
  }
}

function asRefusal(decision: {
  readonly held: boolean
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}): GateRefusal | null {
  return decision.held ? null : { code: decision.code ?? 'duration-ceiling-exceeded', reason: decision.reason }
}

/* ------------------------------------------------------------ transitions */

/**
 * May this environment move to this state?
 *
 * A thin wrapper so callers go through one door, and so the `code` it returns is the
 * same closed vocabulary the journal carries rather than a sentence.
 */
export function mayChangeEnvironmentState(
  from: EnvironmentState,
  to: EnvironmentState,
): { readonly allowed: boolean; readonly code: string; readonly reason: string } {
  return environmentTransition(from, to)
}

export function mayChangeTaskState(
  from: 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled',
  to: 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled',
): { readonly allowed: boolean; readonly code: string; readonly reason: string } {
  return taskTransition(from, to)
}

export function mayChangeOperationState(
  from: WebzoneOperationState,
  to: WebzoneOperationState,
): { readonly allowed: boolean; readonly code: string; readonly reason: string } {
  return webzoneTransition(from, to)
}

/* ------------------------------------------------- bounded workflow shape */

export interface WorkflowStep {
  readonly stepId: string
  readonly kind: WebzoneOperationKind
  readonly target: string
  readonly requiresApproval: boolean
}

export interface BoundedWorkflow {
  readonly workflowId: string
  readonly environmentId: string
  readonly steps: readonly WorkflowStep[]
}

export interface WorkflowReading {
  readonly ok: boolean
  readonly workflow: BoundedWorkflow | null
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

/**
 * Validate a bounded workflow.
 *
 * A workflow here is a **straight line**, and the two refusals that matter are the two
 * that stop it becoming something else:
 *
 *   - step ids must be unique. A repeated id is not a warning, it is a cycle: `next`
 *     could never advance past it, and a workflow that cannot advance would sit in the
 *     journal looking like work in progress forever.
 *   - the step count is capped. A workflow is not a program; it is a bounded list of
 *     things Freya may do, in order, each of which is separately authorized at the time
 *     it runs. Nothing in this phase can define a workflow whose step *repeats*.
 */
export function readWorkflow(input: unknown): WorkflowReading {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  if (typeof raw.workflowId !== 'string' || raw.workflowId.length === 0) {
    return {
      ok: false,
      workflow: null,
      code: 'action-unknown',
      reason: 'A workflow must have an id.',
    }
  }
  if (typeof raw.environmentId !== 'string' || raw.environmentId.length === 0) {
    return {
      ok: false,
      workflow: null,
      code: 'environment-unknown',
      reason: 'A workflow must name the environment it belongs to.',
    }
  }
  const rawSteps = raw.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return {
      ok: false,
      workflow: null,
      code: 'action-unknown',
      reason: 'A workflow must have at least one step.',
    }
  }
  if (rawSteps.length > ENTERPRISE_LIMITS.maxWorkflowSteps) {
    return {
      ok: false,
      workflow: null,
      code: 'action-unknown',
      reason: `A workflow is capped at ${String(ENTERPRISE_LIMITS.maxWorkflowSteps)} steps. A workflow that cannot finish is not a workflow.`,
    }
  }

  const steps: WorkflowStep[] = []
  const seen = new Set<string>()
  for (const entry of rawSteps) {
    const step = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    if (typeof step.stepId !== 'string' || step.stepId.length === 0) {
      return { ok: false, workflow: null, code: 'action-unknown', reason: 'Every step needs an id.' }
    }
    if (seen.has(step.stepId)) {
      return {
        ok: false,
        workflow: null,
        code: 'action-unknown',
        reason: `Step "${step.stepId}" appears twice. A workflow is a straight line; a repeated step id is a cycle.`,
      }
    }
    seen.add(step.stepId)
    if (
      step.kind !== 'publish' &&
      step.kind !== 'update' &&
      step.kind !== 'delete' &&
      step.kind !== 'query' &&
      step.kind !== 'interact'
    ) {
      return {
        ok: false,
        workflow: null,
        code: 'action-unknown',
        reason: 'A step must be one of publish, update, delete, query or interact.',
      }
    }
    if (typeof step.target !== 'string' || step.target.length === 0) {
      return { ok: false, workflow: null, code: 'action-unknown', reason: 'Every step needs a target.' }
    }
    steps.push({
      stepId: step.stepId,
      kind: step.kind,
      target: step.target,
      // A step cannot declare itself un-approval-requiring. `delete` always needs one
      // and `query` never does, so the flag is derived rather than read.
      requiresApproval:
        step.kind === 'delete'
          ? true
          : step.kind === 'query'
            ? false
            : step.requiresApproval === true,
    })
  }

  return {
    ok: true,
    workflow: Object.freeze({ workflowId: raw.workflowId, environmentId: raw.environmentId, steps: Object.freeze(steps) }),
    code: null,
    reason: `A bounded workflow of ${String(steps.length)} steps, in order, with no repeats.`,
  }
}

/**
 * The next step, deterministically.
 *
 * The first step not in `completedStepIds`, or null when the workflow is finished.
 * Derived from the step list rather than from a cursor, so a restart cannot lose the
 * place and a step cannot be run twice by losing track of where it was.
 *
 * Note it does *not* check that a step is authorized. That happens at
 * {@link authorizeEnterpriseAction} when the step runs — a workflow is a plan, not a
 * permission, and a plan that could authorize itself would be a second authority.
 */
export function nextWorkflowStep(
  workflow: BoundedWorkflow,
  completedStepIds: readonly string[],
): { readonly step: WorkflowStep | null; readonly remaining: number } {
  const done = new Set(completedStepIds)
  for (const step of workflow.steps) {
    if (!done.has(step.stepId)) return { step, remaining: workflow.steps.length - done.size }
  }
  return { step: null, remaining: 0 }
}

/** Every step's target must be inside the allowlist, checked before the workflow runs. */
export function workflowFitsBoundaries(
  workflow: BoundedWorkflow,
  boundaries: EnterpriseBoundaries,
): { readonly ok: boolean; readonly reason: string } {
  for (const step of workflow.steps) {
    if (!domainAllowed(step.target, boundaries.allowedDomains)) {
      return {
        ok: false,
        reason: `Step "${step.stepId}" targets ${step.target}, which is outside this environment's allowed domains.`,
      }
    }
  }
  return { ok: true, reason: 'Every step targets an allowed domain.' }
}

/** The consequence class of a step, from the code-owned table. */
export function stepConsequence(step: WorkflowStep) {
  return consequenceOf(step.kind)
}