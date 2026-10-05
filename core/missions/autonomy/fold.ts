import type { AnyCoreEvent } from '../../events/envelope'
import type { WorkRisk } from '../../work/types'
import {
  canTransitionMissionStep,
  DEFAULT_MISSION_BUDGET,
  
  MISSION_BLOCKER_CODES,
  MISSION_CORRECTION_KINDS,
  MISSION_DECISIONS,
  MISSION_EVIDENCE_KINDS,
  MISSION_INTENT_FIELDS,
  MISSION_STEP_STATUSES,
  MISSION_WAKE_KINDS,
  MISSION_WAKE_SOURCES,
  MISSION_APPROVAL_SOURCES,
  type MissionApprovalSource,
  type MissionBlockerCode,
  type MissionBlockerRecord,
  type MissionBudget,
  type MissionCorrectionAmbiguity,
  type MissionCorrectionKind,
  type MissionCorrectionRecord,
  type MissionDecision,
  type MissionEvidenceKind,
  type MissionEvidenceOrigin,
  type MissionEvidenceRecord,
  type MissionIntentField,
  type MissionPlanRecord,
  type MissionPriority,
  type MissionStepRecord,
  type MissionStepStatus,
  type MissionWakeKind,
  type MissionWakeRecord,
  type MissionWakeSource,
} from './types'
import type { MissionReason, MissionRecord, MissionState } from '../types'
import { MISSION_REASONS } from '../types'

/**
 * THE AUTONOMY FOLD.
 *
 * The Phase 47 half of the Mission reducer. Same contract as `state.ts`, and the
 * contract is the point: **this runs on replay**, so a hand-edited or truncated
 * journal must be refused rather than folded into a state the live engine would
 * never produce.
 *
 * ## What "refused" means here, concretely
 *
 * Every handler below returns `state` unchanged when anything fails to read. That is
 * not defensive padding — it is the load-bearing part. There are five specific lies
 * this fold exists to prevent, and each has a refusal:
 *
 * 1. **A step that claims to be verified without ever running.** `blocked → verified`
 *    and `pending → verified` are refused by `canTransitionMissionStep`, and a step
 *    reaching `verified` additionally requires a `verified` transition *from*
 *    `running`.
 * 2. **Evidence that inflates progress.** Only an `observed` `result` counts toward
 *    `resultCount`; a `reported` result is stored and displayed and counted nowhere.
 * 3. **A wake with no end.** `mission.wake.scheduled` refuses a payload with no
 *    `dueAt`, because a wait that cannot expire is the open-ended wait this subsystem
 *    must not be able to record.
 * 4. **An expired approval treated as consent.** `mission.approval.expired` moves a
 *    gate to `expired` and nothing else, and `mission.approval.decided` refuses a
 *    gate that is not `pending`. There is no line that turns `expired` into `approved`.
 * 5. **A correction that widened authority.** `mission.intent.corrected` records
 *    *field names*, never values, and cannot change a Mission's budget, limits,
 *    priority or status — so a correction cannot buy itself more authority, and
 *    cannot mint an approval.
 *
 * ## The journal reads no words
 *
 * Every reader in this file accepts ids, instants, non-negative integers, closed
 * enums, booleans and lists of those. A payload with a `title`, an `intent` or a
 * `summary` string is refused by `events/validate.ts` before it gets here — and the
 * second line of defence is that none of these readers has a parameter that could
 * accept one.
 */

/**
 * The event types this module owns.
 *
 * `mission.transitioned` is deliberately **absent**, even though Phase 47 added it and
 * even though it carries the same payload as the six named lifecycle events.
 *
 * It is a *lifecycle transition*, so `state.ts` folds it through the same `transition()`
 * that handles `mission.activated` and the rest — one path, one transition table, one set
 * of refusals, and the `completed`-needs-a-passed-verification check applies to it for
 * free. Listing it here as well would have given the two handlers overlapping ownership,
 * and the `default` branch of `foldScalarAutonomy` would have swallowed every lifecycle
 * move: the event would validate, be accepted by the journal, and change nothing.
 */
const AUTONOMY_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'mission.plan.committed',
  'mission.step.transitioned',
  'mission.evidence.recorded',
  'mission.blocker.changed',
  // A pointer to a Work gate. One type, and the two that are absent
  // (`mission.approval.decided`, `mission.approval.expired`) are absent from the envelope
  // too: a Mission does not decide or expire an approval, so there is nothing for this fold
  // to handle and nothing for the journal to be able to say.
  'mission.approval.requested',
  'mission.wake.scheduled',
  'mission.wake.fired',
  'mission.continuation.decided',
  'mission.budget.spent',
  'mission.budget.exceeded',
  'mission.intent.corrected',
  'mission.correction.ambiguous',
  'mission.step.interrupted',
])

/**
 * Fold one Phase 47 event, or return null if this file does not own its type.
 *
 * Returning null rather than `state` is what lets `state.ts` keep being the single
 * place that decides which family a type belongs to.
 */
export function reduceAutonomyEvent(
  state: MissionState,
  event: AnyCoreEvent,
  missionId: string,
): MissionState | null {
  if (!AUTONOMY_EVENT_TYPES.has(event.type)) return null
  const payload = event.payload as unknown as Record<string, unknown>
  const current = state.missions.get(missionId)
  if (current === undefined) return { ...state, sequence: event.sequence }

  switch (event.type) {
    case 'mission.plan.committed':
      return foldCommittedPlan(state, event, current, payload)
    case 'mission.step.transitioned':
      return foldStep(state, event, current, payload)
    case 'mission.step.interrupted':
      return foldInterrupted(state, event, current, payload)
    case 'mission.evidence.recorded':
      return foldEvidence(state, event, current, payload)
    case 'mission.blocker.changed':
      return foldBlocker(state, event, current, payload)
    case 'mission.approval.requested':
      return foldApprovalRequested(state, event, current, payload)
    case 'mission.wake.scheduled':
      return foldWakeScheduled(state, event, current, payload)
    case 'mission.wake.fired':
      return foldWakeFired(state, event, current, payload)
    default:
      // The remaining types are folded against the `MissionRecord`'s own scalar
      // fields, which live here so the record stays readable in `types.ts`.
      return foldScalarAutonomy(state, event, current, payload, missionId)
  }
}

/* -------------------------------------------------------------------- steps */

/**
 * A step changed status.
 *
 * Three refusals, each closing a way a step could lie:
 *
 * - the transition must be legal in `MISSION_STEP_TRANSITIONS`;
 * - `from` must be the status the fold believes, so history has to agree with itself;
 * - a step reaching `verified` must come **from `running`**, which is the only status
 *   that means an action was performed. There is no `pending → verified` line a
 *   hand-edited journal could take.
 */
function foldStep(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const stepId = readId(payload, 'stepId')
  const to = readStepStatus(payload.to)
  if (stepId === null || to === null) return { ...state, sequence: event.sequence }

  const at = event.occurredAt
  const reason = readReason(payload.reason)
  // `mission.step.transitioned` moves a step in the active plan.
  const active = mission.activePlan
  if (active !== null && active.planId === payload.planId) {
    const index = active.steps.findIndex((step) => step.stepId === stepId)
    const step = index >= 0 ? active.steps[index] : undefined
    if (step === undefined) return { ...state, sequence: event.sequence }
    const from = readStepStatus(payload.from)
    if (from === null || from !== step.status) return { ...state, sequence: event.sequence }
    if (!canTransitionMissionStep(from, to)) return { ...state, sequence: event.sequence }

    const attempts = readCount(payload, 'attempts')
    const workerId = readNullableId(payload.workerId)
    const runId = readNullableId(payload.runId)

    const next: MissionStepRecord = {
      ...step,
      status: to,
      attempts: attempts >= 0 ? attempts : step.attempts,
      reason: to === 'verified' ? MISSION_REASONS.step_verified : reason ?? step.reason,
      ...(workerId === null ? {} : { workerId }),
      ...(runId === null ? {} : { runId }),
      startedAt: step.startedAt ?? (to === 'delegated' || to === 'running' ? at : null),
      settledAt: isTerminalStep(to) ? at : null,
    }
    const steps = active.steps.map((candidate, position) => (position === index ? next : candidate))

    const plan = active
    const missions = new Map(state.missions)
    missions.set(mission.missionId, {
      ...mission,
      activePlan: { ...plan, steps },
      lastUpdatedAt: at,
    })
    return { missions, sequence: event.sequence }
  } else {
    // A step transition naming a `planId` that is not the plan in force. The Mission has
    // been replanned since the caller read it, so this transition belongs to a plan that
    // no longer exists.
    //
    // Refused rather than applied to the current plan's step. That refusal is what makes
    // a replan safe: a worker still holding the old plan cannot move a step in the new
    // one, because the ids do not line up.
    return { ...state, sequence: event.sequence }
  }
}

/**
 * A step's action was in flight when the process stopped.
 *
 * This is the honest record of an unknown effect. A `consequential` step interrupted
 * mid-action may or may not have happened, and the only true statements are "we do
 * not know" and "we will not do it again blind". So the step becomes `blocked` with
 * `interrupted`, its run is forgotten rather than reattached, and nothing in this
 * subsystem will retry it on the strength of a guess.
 */
function foldInterrupted(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const stepId = readId(payload, 'stepId')
  const active = mission.activePlan
  if (stepId === null || active === null) return { ...state, sequence: event.sequence }
  const step = active.steps.find((candidate) => candidate.stepId === stepId)
  if (step === undefined) return { ...state, sequence: event.sequence }
  // Idempotent: a second reconciliation of the same interruption is not a new fact.
  if (step.status === 'blocked' && step.reason === MISSION_REASONS.interrupted) {
    return { ...state, sequence: event.sequence }
  }
  if (isTerminalStep(step.status)) return { ...state, sequence: event.sequence }

  const at = event.occurredAt
  const next: MissionStepRecord = {
    ...step,
    status: 'blocked',
    reason: MISSION_REASONS.interrupted,
    // The run is deliberately forgotten. A Run that may still be running somewhere is
    // not something a restart may attach to again, and leaving the id here would make
    // a duplicate execution look like a resumption.
    runId: null,
    settledAt: null,
  }
  const missions = new Map(state.missions)
  missions.set(mission.missionId, {
    ...mission,
    activePlan: {
      ...active,
      steps: active.steps.map((candidate) => (candidate.stepId === stepId ? next : candidate)),
    },
    blockers: addBlocker(mission.blockers, 'step_failed', stepId, at),
    lastUpdatedAt: at,
  })
  return { missions, sequence: event.sequence }
}

/* ------------------------------------------------------------------- plans */

/**
 * A plan was committed.
 *
 * The whole plan arrives in one event, and it is read step by step: a step whose
 * capability, verifier, status, index or dependency list does not read cleanly
 * refuses **the entire commit**, rather than being written as a half-formed step. A
 * partially committed plan is the state in which a Mission could run a step nobody
 * ever described.
 *
 * `revision` is checked against the Mission's own count, so a journal cannot skip
 * from revision 1 to revision 9 and thereby bypass the replan ceiling.
 */
function foldCommittedPlan(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const planId = readId(payload, 'planId')
  const rawSteps = payload.steps
  if (planId === null || !Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ...state, sequence: event.sequence }
  }
  const revision = readCount(payload, 'revision')
  if (revision !== mission.planRevisions + 1) return { ...state, sequence: event.sequence }

  const steps: MissionStepRecord[] = []
  const seen = new Set<string>()
  for (const raw of rawSteps) {
    if (typeof raw !== 'object' || raw === null) return { ...state, sequence: event.sequence }
    const step = readStep(raw as Record<string, unknown>)
    if (step === null) return { ...state, sequence: event.sequence }
    if (seen.has(step.stepId)) return { ...state, sequence: event.sequence }
    // A dependency on a step that is not in this plan is a plan that can never run.
    for (const dependency of step.dependsOn) {
      if (!seen.has(dependency)) return { ...state, sequence: event.sequence }
    }
    seen.add(step.stepId)
    steps.push(step)
  }

  const plan: MissionPlanRecord = {
    planId,
    revision,
    createdAt: event.occurredAt,
    steps,
    supersedes: readNullableId(payload.supersedes),
    reason: revision === 1 ? null : readReason(payload.reason),
  }
  const missions = new Map(state.missions)
  missions.set(mission.missionId, {
    ...mission,
    activePlan: plan,
    planRevisions: revision,
    lastUpdatedAt: event.occurredAt,
  })
  return { missions, sequence: event.sequence }
}

function readStep(raw: Record<string, unknown>): MissionStepRecord | null {
  const stepId = readId(raw, 'stepId')
  const capability = readName(raw, 'capability')
  const verifier = readName(raw, 'verifier')
  const status = readStepStatus(raw.status)
  if (stepId === null || capability === null || verifier === null || status === null) return null
  // The remaining fields are validated by the *same* readers the scalar handlers use,
  // so a step cannot be committed with a capability that reads differently from how a
  // later `mission.step.transitioned` would read it.
  const index = readCount(raw, 'index')
  const attempts = readCount(raw, 'attempts')
  const risk = readRisk(raw.risk)
  if (index < 0 || attempts < 0 || risk === null) return null
  const dependsOn = readIdList(raw, 'dependsOn')
  if (dependsOn === null) return null
  const requiresApproval = readBoolean(raw.requiresApproval)
  if (requiresApproval === null) return null
  return {
    stepId,
    index,
    capability,
    verifier,
    dependsOn,
    status,
    workerId: readNullableId(raw.workerId),
    runId: readNullableId(raw.runId),
    attempts,
    risk,
    requiresApproval,
    approvalId: readNullableId(raw.approvalId),
    reason: readReason(raw.reason),
    startedAt: readInstantField(raw, 'startedAt'),
    settledAt: readInstantField(raw, 'settledAt'),
  }
}

/* ---------------------------------------------------------------- evidence */

/**
 * Evidence was recorded.
 *
 * `resultCount` moves for **observed results only**, and only within this fold. A
 * reported result is stored and displayed and counted nowhere, which is what keeps
 * "a capability said it found twelve" from becoming "twelve found".
 *
 * `expiresAt` is stored rather than acted on. Nothing polls it: expiry is computed
 * whenever progress is derived, so stale evidence is *discovered* at the moment it
 * matters instead of by a timer that might not be running.
 */
function foldEvidence(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const evidenceId = readId(payload, 'evidenceId')
  const kind = readEvidenceKind(payload.kind)
  const origin = readEvidenceOrigin(payload.origin)
  if (evidenceId === null || kind === null || origin === null) return { ...state, sequence: event.sequence }
  // Idempotent. Evidence is append-only, and a redelivered event must not be counted
  // twice — a doubled `resultCount` would let a Mission claim a quantity it never
  // reached.
  if (mission.evidence.some((item) => item.evidenceId === evidenceId)) {
    return { ...state, sequence: event.sequence }
  }
  const expiresAt = readInstantField(payload, 'expiresAt')
  const summaryLength = readCount(payload, 'summaryLength')
  if (summaryLength < 0) return { ...state, sequence: event.sequence }

  const evidence: MissionEvidenceRecord = {
    evidenceId,
    stepId: readNullableId(payload.stepId),
    kind,
    origin,
    summaryLength,
    recordedAt: event.occurredAt,
    expiresAt,
  }
  const missions = new Map(state.missions)
  missions.set(mission.missionId, {
    ...mission,
    evidence: [...mission.evidence, evidence],
    // The one place `resultCount` ever moves.
    resultCount: kind === 'result' && origin === 'observed' ? mission.resultCount + 1 : mission.resultCount,
    lastUpdatedAt: event.occurredAt,
  })
  return { missions, sequence: event.sequence }
}

/* ---------------------------------------------------------------- blockers */

/**
 * A blocker was raised or cleared.
 *
 * `raised` is boolean rather than two event types so that the pair is one fact with
 * two outcomes — and so a journal cannot contain a `cleared` for a blocker that was
 * never raised, which would be a Mission reporting a resolution it never had.
 */
function foldBlocker(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const code = readBlockerCode(payload.code)
  const raised = readBoolean(payload.raised)
  if (code === null || raised === null) return { ...state, sequence: event.sequence }
  const stepId = readNullableId(payload.stepId)
  const at = event.occurredAt
  const exists = mission.blockers.some(
    (blocker) => blocker.code === code && blocker.stepId === stepId && blocker.clearedAt === null,
  )

  let blockers: readonly MissionBlockerRecord[]
  if (raised) {
    // Idempotent, and never re-raised with a fresh timestamp. A blocker that keeps
    // renewing itself would make a Mission that has been stuck for a week look like
    // it just hit a problem.
    if (exists) return { ...state, sequence: event.sequence }
    blockers = [...mission.blockers, { code, stepId, raisedAt: at, clearedAt: null }]
  } else {
    if (!exists) return { ...state, sequence: event.sequence }
    blockers = mission.blockers
      .map((blocker) =>
        blocker.code === code && blocker.stepId === stepId && blocker.clearedAt === null
          ? { ...blocker, clearedAt: at }
          : blocker,
      )
      // Cleared blockers are dropped, not kept with a flag: `blockers` is what is
      // *currently* in the way, and a board must not render last month's problem.
      .filter((blocker) => blocker.clearedAt === null)
  }

  // **The approval reference is settled here**, and this is the only place that happens.
  //
  // A gate's outcome and the blocker it raises are the same fact, recorded once. There is no
  // `mission.approval.decided` to fold, so if the reference were not updated alongside the
  // blocker the board would go on showing a Mission as `pendingApproval` after a person had
  // already said no — the reference and the blocker list disagreeing about the same event.
  //
  // `denied` and `expired` are distinguished here and the Mission deliberately does not
  // distinguish them anywhere else. Which of the three a gate ended as is Work's record to
  // keep; what this subsystem needs is the single fact that the step is not going to run
  // without a person.
  const outcome: 'denied' | 'expired' | null =
    code === 'approval_denied' ? 'denied' : code === 'approval_expired' ? 'expired' : null
  const approval =
    raised && outcome !== null && mission.approval !== null && mission.approval.outcome === null
      ? { ...mission.approval, outcome }
      : mission.approval

  const missions = new Map(state.missions)
  missions.set(mission.missionId, { ...mission, blockers, approval, lastUpdatedAt: at })
  return { missions, sequence: event.sequence }
}

/* --------------------------------------------------------------- approvals */

/**
 * A step asked Work for a gate, and Work opened one.
 *
 * The whole handler, and what it deliberately does **not** do is the design.
 *
 * It records a *pointer*: Work's approval id, which step asked, and whether the plan
 * anticipated the gate or Work's Guard demanded it. `outcome` starts `null`, which means
 * "open", and there is no event in this phase that can set it — the Mission never writes
 * down how a gate was resolved. It reads that back from Work.
 *
 * So a replay of this journal produces a Mission that knows *which* gate it is waiting on
 * and nothing about whether the gate was answered. That is the honest reconstruction: the
 * answer lives in `work.approval.decided`, and a Mission that guessed at it would be a
 * Mission whose state could disagree with the approval that actually happened.
 *
 * One gate at a time, and the replacement is deliberate. A Mission has one current step,
 * so a second gate means the first is no longer the thing being waited on, and keeping
 * both would leave a record claiming the Mission is still waiting on an old one.
 */
function foldApprovalRequested(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const approvalId = readId(payload, 'approvalId')
  const stepId = readId(payload, 'stepId')
  const source = readApprovalSource(payload.source)
  const requestedAt = readInstantField(payload, 'requestedAt') ?? event.occurredAt
  if (approvalId === null || stepId === null || source === null) {
    return { ...state, sequence: event.sequence }
  }
  // A repeat of the gate already on the record changes nothing. This is what makes the
  // fold safe to replay a journal that recorded the same gate twice — which Work's
  // re-entry can produce, since a Run parked at `awaiting_approval` reports it again.
  if (mission.approval !== null && mission.approval.approvalId === approvalId) {
    return { ...state, sequence: event.sequence }
  }
  const missions = new Map(state.missions)
  missions.set(mission.missionId, {
    ...mission,
    approval: { approvalId, stepId, source, runId: readNullableId(payload.runId), requestedAt, outcome: null },
    lastUpdatedAt: event.occurredAt,
  })
  return { missions, sequence: event.sequence }
}
/* ------------------------------------------------------------------- wakes */

/**
 * A next wake was scheduled.
 *
 * `dueAt` is mandatory. A wake without one is refused, which is how "wait until
 * something happens, whenever that is" is made unrecordable rather than merely
 * discouraged.
 *
 * Only one wake is held at a time and it replaces the previous one. A Mission that
 * re-armed without consuming its old wake could accumulate an unbounded number of
 * pending moments, and the count of those moments is exactly the number of things
 * that will later fire.
 */
function foldWakeScheduled(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const wakeId = readId(payload, 'wakeId')
  const kind = readWakeKind(payload.kind)
  const source = readWakeSource(payload.source)
  const dueAt = readInstantField(payload, 'dueAt')
  if (wakeId === null || kind === null || source === null || dueAt === null) {
    return { ...state, sequence: event.sequence }
  }
  const wake: MissionWakeRecord = {
    wakeId,
    kind,
    source,
    dueAt,
    // Only an event wake may name an event. A `time` wake carrying an event type
    // would be a wake that could be satisfied by either, and a Mission waiting on
    // both is a Mission nobody can reason about.
    eventType: kind === 'event' ? readName(payload, 'eventType') : null,
    scheduledAt: event.occurredAt,
    firedAt: null,
    consumedBy: null,
  }
  if (kind === 'event' && wake.eventType === null) return { ...state, sequence: event.sequence }
  const missions = new Map(state.missions)
  missions.set(mission.missionId, { ...mission, wake, lastUpdatedAt: event.occurredAt })
  return { missions, sequence: event.sequence }
}

/**
 * A wake fired.
 *
 * The record is kept, marked fired, rather than deleted — so a board can answer "when
 * did this Mission last wake" from the journal instead of from memory.
 *
 * Nothing here consumes anything. Firing is a *fact about time or an event*, and the
 * continuation decision that acts on it is a separate event with its own reason. That
 * separation is why a wake can never be read as having granted anything.
 */
function foldWakeFired(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
): MissionState {
  const wakeId = readId(payload, 'wakeId')
  const wake = mission.wake
  if (wakeId === null || wake === null || wake.wakeId !== wakeId) {
    return { ...state, sequence: event.sequence }
  }
  if (wake.firedAt !== null) return { ...state, sequence: event.sequence }
  const missions = new Map(state.missions)
  missions.set(mission.missionId, {
    ...mission,
    wake: { ...wake, firedAt: event.occurredAt },
    lastUpdatedAt: event.occurredAt,
  })
  return { missions, sequence: event.sequence }
}

/* ------------------------------------------------- budgets and corrections */

/**
 * The scalar families: budget, continuation, corrections.
 *
 * Kept together because each is a single write to one field or two, and splitting
 * them across five more files would be a map with no content in it.
 */
function foldScalarAutonomy(
  state: MissionState,
  event: AnyCoreEvent,
  mission: MissionRecord,
  payload: Record<string, unknown>,
  missionId: string,
): MissionState {
  const at = event.occurredAt

  switch (event.type) {
    case 'mission.budget.spent': {
      // Spend is a count that only ever goes up, and only by the amount the action
      // itself caused. There is no event that sets spend to a caller's number, so a
      // budget cannot be refilled by a payload — including at replay.
      const modelCalls = readCount(payload, 'modelCalls')
      const actions = readCount(payload, 'actions')
      const externalRequests = readCount(payload, 'externalRequests')
      const retries = readCount(payload, 'retries')
      const delegations = readCount(payload, 'delegations')
      if ([modelCalls, actions, externalRequests, retries, delegations].some((n) => n < 0)) {
        return { ...state, sequence: event.sequence }
      }
      const missions = new Map(state.missions)
      missions.set(missionId, {
        ...mission,
        spend: {
          modelCalls: mission.spend.modelCalls + modelCalls,
          actions: mission.spend.actions + actions,
          externalRequests: mission.spend.externalRequests + externalRequests,
          retries: mission.spend.retries + retries,
          delegations: mission.spend.delegations + delegations,
        },
        lastUpdatedAt: at,
      })
      return { missions, sequence: event.sequence }
    }

    case 'mission.budget.exceeded': {
      // A ceiling was hit. Recorded rather than inferred, so a restart cannot hide
      // that a Mission stopped progressing for a budget reason.
      const budget = readBudgetName(payload.budget)
      if (budget === null) return { ...state, sequence: event.sequence }
      const missions = new Map(state.missions)
      missions.set(missionId, {
        ...mission,
        limitsHit: mission.limitsHit.includes(budget) ? mission.limitsHit : [...mission.limitsHit, budget],
        lastUpdatedAt: at,
      })
      return { missions, sequence: event.sequence }
    }

    case 'mission.continuation.decided': {
      const decision = readDecision(payload.decision)
      const reason = readReason(payload.reason)
      if (decision === null || reason === null) return { ...state, sequence: event.sequence }
      const nextWakeAt = readInstantField(payload, 'nextWakeAt')
      // The invariant `assertWakeBounded` enforces at runtime, enforced again here.
      // A journal claiming "wait, and re-decide whenever" is refused rather than
      // folded, so replay cannot manufacture an open-ended wait.
      if (decision === 'wait' && nextWakeAt === null) return { ...state, sequence: event.sequence }
      if (decision !== 'wait' && nextWakeAt !== null) return { ...state, sequence: event.sequence }
      const missions = new Map(state.missions)
      missions.set(missionId, {
        ...mission,
        lastDecision: { decision, reason, stepId: readNullableId(payload.stepId), nextWakeAt },
        // Asking the owner is not the same as being blocked: `awaitingOwner` is what
        // a board renders as "waiting for you to explain", and only an owner's
        // correction clears it.
        awaitingOwner: decision === 'ask_owner' ? true : mission.awaitingOwner,
        lastUpdatedAt: at,
      })
      return { missions, sequence: event.sequence }
    }

    case 'mission.intent.corrected': {
      const correctionId = readId(payload, 'correctionId')
      const kind = readCorrectionKind(payload.kind)
      const changedFields = readIntentFieldList(payload.changedFields)
      const settledSteps = readCount(payload, 'settledSteps')
      const preservedEvidence = readCount(payload, 'preservedEvidence')
      if (
        correctionId === null ||
        kind === null ||
        changedFields === null ||
        settledSteps < 0 ||
        preservedEvidence < 0
      ) {
        return { ...state, sequence: event.sequence }
      }
      const corrections = mission.corrections.map(
        (correction) => (correction.correctionId === correctionId ? correction : correction),
      )
      if (corrections.some((correction) => correction.correctionId === correctionId)) {
        return { ...state, sequence: event.sequence }
      }
      const record: MissionCorrectionRecord = {
        correctionId,
        kind,
        changedFields,
        settledSteps,
        preservedEvidence,
        replannedFrom: readNullableId(payload.replannedFrom),
        ambiguity: null,
        at,
      }
      const missions = new Map(state.missions)
      // `requestedQuantity` is applied **here**, from the event, rather than being poked
      // into the record by whoever wrote it. That is the whole reason it is on the
      // payload: a fold that only recorded the field *name* would leave the corrected
      // number living in one process's memory, so the Mission would quietly go back to
      // asking for the old quantity the first time it was restarted. Nothing here is
      // private — it is a count, and `mission.created` already carries the same one.
      const correctedQuantity = readRequestedQuantity(payload.requestedQuantity)
      missions.set(missionId, {
        ...mission,
        ...(correctedQuantity === undefined ? {} : { requestedQuantity: correctedQuantity }),
        corrections: [...mission.corrections, record],
        // A correction is the only thing that can clear `awaitingOwner`, and it clears
        // it by being applied. This is what makes "asked a question, got an answer,
        // carried on" work without a second mechanism.
        awaitingOwner: false,
        lastUpdatedAt: at,
      })
      return { missions, sequence: event.sequence }
    }

    case 'mission.correction.ambiguous': {
      const correctionId = readId(payload, 'correctionId')
      const ambiguity = readAmbiguity(payload.ambiguity)
      if (correctionId === null || ambiguity === null) return { ...state, sequence: event.sequence }
      const missions = new Map(state.missions)
      missions.set(missionId, {
        ...mission,
        corrections: [
          ...mission.corrections,
          {
            correctionId,
            kind: 'ambiguous',
            changedFields: [],
            settledSteps: 0,
            preservedEvidence: 0,
            replannedFrom: null,
            ambiguity,
            at,
          },
        ],
        // **Nothing else changes.** No constraint moved, no step was settled, no
        // evidence was discarded. An ambiguous correction leaves the Mission exactly
        // as it was and asks the owner; the refusal to guess is the whole feature.
        awaitingOwner: true,
        blockers: addBlocker(mission.blockers, 'intent_ambiguous', null, at),
        lastUpdatedAt: at,
      })
      return { missions, sequence: event.sequence }
    }

    default:
      return { ...state, sequence: event.sequence }
  }
}

/* ----------------------------------------------------------------- helpers */

function addBlocker(
  blockers: readonly MissionBlockerRecord[],
  code: MissionBlockerCode,
  stepId: string | null,
  at: string,
): readonly MissionBlockerRecord[] {
  if (blockers.some((blocker) => blocker.code === code && blocker.stepId === stepId)) return blockers
  return [...blockers, { code, stepId, raisedAt: at, clearedAt: null }]
}

function isTerminalStep(status: MissionStepStatus): boolean {
  return status === 'verified' || status === 'failed' || status === 'cancelled' || status === 'skipped'
}

/**
 * A budget ceiling name from the journal.
 *
 * Checked against the *budget* table, so a `mission.budget.exceeded` cannot claim a
 * Phase 7 child-Run limit was hit and a `mission.limit.exceeded` cannot claim a
 * budget was. The two families stay distinguishable in a restored projection, which
 * matters because they mean different things to whoever reads the board afterwards.
 */
function readBudgetName(value: unknown): keyof MissionBudget | null {
  return typeof value === 'string' && Object.hasOwn(DEFAULT_MISSION_BUDGET, value)
    ? (value as keyof MissionBudget)
    : null
}

function readId(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function readNullableId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

/**
 * A capability or verifier name.
 *
 * Bounded and free of whitespace and control bytes, so a name cannot smuggle a
 * sentence into the journal or a newline into a log line. It is *not* checked
 * against the registry here — a journal may name a capability this build no longer
 * has, and the planner treats an unresolvable name as blocked rather than as an
 * error. Refusing the event would instead lose the record that it happened.
 */
function readName(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return null
  }
  return value
}

/**
 * A non-negative whole number, or **-1**.
 *
 * The sentinel is -1 rather than 0 because 0 is a legitimate count. A caller that
 * wants to refuse a payload cannot tell `readCount` returning 0 from a real zero,
 * so the failure value has to be one no valid count can be.
 */
function readCount(raw: Record<string, unknown>, key: string): number {
  const value = raw[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : -1
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * A corrected requested quantity, or `undefined` when the event did not carry one.
 *
 * `undefined` and `null` mean different things and both are legal: `undefined` is "this
 * correction did not change the quantity", and `null` is "the quantity was removed". A
 * fold that collapsed them would either resurrect a number the owner took away or make
 * a correction that changed something else look like it cleared the goal.
 */
function readRequestedQuantity(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function readInstantField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function readReason(value: unknown): MissionReason | null {
  return typeof value === 'string' && Object.hasOwn(MISSION_REASONS, value)
    ? (value as MissionReason)
    : null
}

function readStepStatus(value: unknown): MissionStepStatus | null {
  return typeof value === 'string' && (MISSION_STEP_STATUSES as readonly string[]).includes(value)
    ? (value as MissionStepStatus)
    : null
}

function readEvidenceKind(value: unknown): MissionEvidenceKind | null {
  return typeof value === 'string' && (MISSION_EVIDENCE_KINDS as readonly string[]).includes(value)
    ? (value as MissionEvidenceKind)
    : null
}

function readEvidenceOrigin(value: unknown): MissionEvidenceOrigin | null {
  return typeof value === 'string' && (value === 'observed' || value === 'reported')
    ? (value as MissionEvidenceOrigin)
    : null
}

function readBlockerCode(value: unknown): MissionBlockerCode | null {
  return typeof value === 'string' && (MISSION_BLOCKER_CODES as readonly string[]).includes(value)
    ? (value as MissionBlockerCode)
    : null
}

/**
 * Where a gate came from: the plan asked for it, or Work's Guard demanded it.
 *
 * Two values, and the distinction is worth keeping. A gate the plan anticipated is a fact
 * about the goal; a gate Guard demanded is a fact about the capability, and a person
 * reading the feed is entitled to know the difference between "this is how this kind of
 * step works" and "this surprised the planner".
 */
function readApprovalSource(value: unknown): MissionApprovalSource | null {
  return typeof value === 'string' && (MISSION_APPROVAL_SOURCES as readonly string[]).includes(value)
    ? (value as MissionApprovalSource)
    : null
}

function readWakeKind(value: unknown): MissionWakeKind | null {
  return typeof value === 'string' && (MISSION_WAKE_KINDS as readonly string[]).includes(value)
    ? (value as MissionWakeKind)
    : null
}

function readWakeSource(value: unknown): MissionWakeSource | null {
  return typeof value === 'string' && (MISSION_WAKE_SOURCES as readonly string[]).includes(value)
    ? (value as MissionWakeSource)
    : null
}

function readDecision(value: unknown): MissionDecision | null {
  return typeof value === 'string' && (MISSION_DECISIONS as readonly string[]).includes(value)
    ? (value as MissionDecision)
    : null
}

function readCorrectionKind(value: unknown): MissionCorrectionKind | null {
  return typeof value === 'string' && (MISSION_CORRECTION_KINDS as readonly string[]).includes(value)
    ? (value as MissionCorrectionKind)
    : null
}

function readAmbiguity(value: unknown): MissionCorrectionAmbiguity | null {
  const codes: readonly MissionCorrectionAmbiguity[] = [
    'unknown_subject',
    'conflicting_quantity',
    'unknown_scope',
    'multiple_subjects',
    'no_active_mission',
    'already_settled',
  ]
  return typeof value === 'string' && (codes as readonly string[]).includes(value)
    ? (value as MissionCorrectionAmbiguity)
    : null
}

function readRisk(value: unknown): WorkRisk | null {
  return typeof value === 'string' && (value === 'none' || value === 'routine' || value === 'consequential')
    ? (value as WorkRisk)
    : null
}

/**
 * An id list, or null if any entry is not an id.
 *
 * Returning null rather than filtering is deliberate. A dependency list with a bad
 * entry is a plan that does not describe itself, and quietly dropping the bad entry
 * would leave a step waiting on nothing.
 */
function readIdList(raw: Record<string, unknown>, key: string): readonly string[] | null {
  const value = raw[key]
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 256) return null
    out.push(item)
  }
  return out
}

function readIntentFieldList(value: unknown): readonly MissionIntentField[] | null {
  if (!Array.isArray(value)) return null
  const out: MissionIntentField[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(MISSION_INTENT_FIELDS as readonly string[]).includes(item)) {
      return null
    }
    if (!out.includes(item as MissionIntentField)) out.push(item as MissionIntentField)
  }
  return out
}

/* ---------------------------------------------------------------- the tables */

/**
 * Re-exported for tests that assert the closure of each table these readers guard.
 *
 * Deliberately *not* re-exporting `state.ts`'s readers: `state.ts` imports this
 * module, so re-exporting the other direction would be a runtime cycle between two
 * files that both load at import time.
 */
export { MISSION_DECISIONS, MISSION_STEP_STATUSES }

/** The record shapes this module produces, named in one place for a reader to find. */
export type { MissionPlanRecord, MissionPriority }