import type { Capability } from '../../../shared/contracts/capabilities'
import type { WorkRisk } from '../../work/types'
import type { MissionReason } from '../reasons'

/**
 * THE MISSION AUTONOMY VOCABULARY.
 *
 * Phase 7 gave a Mission an outcome and a lifecycle. It did not give it a *plan*,
 * a *step*, a *worker*, an *evidence*, a *blocker*, an *approval gate*, a *wake* or
 * a *budget*, and it had no decision that said "continue" as distinct from "run".
 * This file is those missing nouns, in one place and in the same register as
 * `missions/types.ts`: closed enums, ids, counts, instants and bounds.
 *
 * ## The one rule every record here obeys
 *
 * > **The journal holds ids, statuses, counts, instants, closed codes and measured
 * > lengths. Never a word of the Mission's content.**
 *
 * So a step has a `capability` and a `verifier` but no `label`. Evidence has a
 * `summaryLength` and never a `summary`. A blocker has a code and never a sentence.
 * An approval gate has a `justificationLength` and never a justification.
 *
 * That rule is not tidiness. It is the property that lets a Mission journal be
 * backed up, copied to another machine and read while debugging without being
 * anybody's business — and it is enforced a second time in `events/validate.ts`,
 * which refuses an unexpected key rather than ignoring it.
 *
 * ## Nothing here is an authority
 *
 * A budget is a ceiling, not a permission. A wake is a moment, not a grant. An
 * approval gate is a *waiting place*, and the only thing that opens it is a person
 * deciding through the existing Work approval workflow. There is no method on any
 * type in this file that mints authority, and the autonomy runtime reaches Guard,
 * the Governor and the owner through ports it does not own.
 */

/* -------------------------------------------------------------- priorities */

/**
 * How much a Mission competes for the owner's attention.
 *
 * A closed enum rather than a number, for the same reason `WORK_RISKS` is: a
 * priority that could be 4.7 would be an ordering the board would have to explain,
 * and "urgent" is the only level a person can act on without arithmetic.
 *
 * Priority never grants anything. It orders two live Missions against each other
 * and nothing else — in particular it cannot make a capability available.
 */
export const MISSION_PRIORITIES = Object.freeze(['routine', 'important', 'urgent'] as const)

export type MissionPriority = (typeof MISSION_PRIORITIES)[number]

export function isMissionPriority(value: unknown): value is MissionPriority {
  return typeof value === 'string' && (MISSION_PRIORITIES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------- steps */

/**
 * What one step of a plan is doing.
 *
 * `pending` is planned and not started. `blocked` cannot start and says why in
 * `reason`. `delegated` has a worker. `running` has a Run. `verified` is the only
 * terminal status that means the outcome was *observed*; `failed`, `cancelled` and
 * `skipped` are all terminal and none of them is evidence of anything.
 *
 * The distinction between `verified` and `failed` is the entire reason Steps have
 * a status vocabulary rather than a boolean, and it is the same distinction Phase 6
 * draws between a capability returning success and a verifier establishing it.
 */
export const MISSION_STEP_STATUSES = Object.freeze([
  'pending',
  'blocked',
  'delegated',
  'running',
  'verified',
  'failed',
  'cancelled',
  'skipped',
] as const)

export type MissionStepStatus = (typeof MISSION_STEP_STATUSES)[number]

export const MISSION_STEP_TERMINAL_STATUSES = Object.freeze([
  'verified',
  'failed',
  'cancelled',
  'skipped',
] as const)

export type MissionStepTerminalStatus = (typeof MISSION_STEP_TERMINAL_STATUSES)[number]

export function isTerminalMissionStepStatus(status: MissionStepStatus): status is MissionStepTerminalStatus {
  return MISSION_STEP_TERMINAL_STATUSES.includes(status as MissionStepTerminalStatus)
}

/**
 * The step state machine.
 *
 * Two properties are load-bearing and are enforced by the fold as well as here:
 *
 * - **`blocked → running` is not permitted.** A step that was blocked has to be
 *   delegated again, so a cleared blocker can never be skipped past.
 * - **`delegated → verified` is not permitted.** Verification is reached through
 *   `running`, which is the only status that means an Action was actually
 *   performed and observed. A step cannot claim observation without having run.
 */
export const MISSION_STEP_TRANSITIONS: Readonly<Record<MissionStepStatus, readonly MissionStepStatus[]>> =
  Object.freeze({
    pending: Object.freeze(['blocked', 'delegated', 'cancelled', 'skipped'] as const),
    blocked: Object.freeze(['pending', 'cancelled', 'skipped'] as const),
    delegated: Object.freeze(['running', 'blocked', 'failed', 'cancelled'] as const),
    running: Object.freeze(['verified', 'failed', 'cancelled'] as const),
    verified: Object.freeze([] as const),
    failed: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
    skipped: Object.freeze([] as const),
  })

export function canTransitionMissionStep(from: MissionStepStatus, to: MissionStepStatus): boolean {
  return MISSION_STEP_TRANSITIONS[from].includes(to)
}

/**
 * A step in a plan.
 *
 * Everything here is an id, an enum, a count or an instant. `capability` and
 * `verifier` are *names the planner resolved against the registered capability
 * table*, not requests: an unknown name never reaches this record, because the
 * planner blocks the step rather than writing it.
 */
export interface MissionStepRecord {
  readonly stepId: string
  /** Position in the plan. Stable across a retry, which is what makes it visibly the same step. */
  readonly index: number
  /** A registered capability name. Never free text, never a URL, never a path. */
  readonly capability: string
  /** A registered verifier name. A step with no way to be checked cannot reach `verified`. */
  readonly verifier: string
  /** Step ids that must be verified first. Empty for a root step. */
  readonly dependsOn: readonly string[]
  readonly status: MissionStepStatus
  /** The registered worker this step was delegated to, or null. */
  readonly workerId: string | null
  /** The Work Run executing this step, or null. */
  readonly runId: string | null
  /** Attempts made so far. Bounded by `budget.maxRetries`. */
  readonly attempts: number
  /** What Guard evaluates before this step's action runs. */
  readonly risk: WorkRisk
  /** Whether this step additionally demands an owner decision before it may run. */
  readonly requiresApproval: boolean
  readonly approvalId: string | null
  /** A closed code. Never a capability's error message. */
  readonly reason: MissionReason | null
  readonly startedAt: string | null
  readonly settledAt: string | null
}

/* ------------------------------------------------------------------- plans */

/**
 * A bounded, explicit plan.
 *
 * `revision` is a counter that only ever goes up, and it is journalled: a plan
 * revision is an event, not a recomputation. That matters because "the plan
 * changed" is exactly the fact a person needs after the fact — if a Mission
 * quietly re-planned its way to a success, the only evidence would be the
 * absence of the plan it originally announced.
 *
 * `supersedes` is the plan this one replaced, which makes the chain readable
 * without keeping every plan's steps forever.
 */
export interface MissionPlanRecord {
  readonly planId: string
  readonly revision: number
  readonly createdAt: string
  readonly steps: readonly MissionStepRecord[]
  /** The plan this revision replaced, or null for the first. */
  readonly supersedes: string | null
  /** A closed code for why a revision was made. Null on the first plan. */
  readonly reason: MissionReason | null
}

/* ---------------------------------------------------------------- evidence */

/**
 * Whether an item of evidence was *observed* or merely *reported*.
 *
 * This is the most important distinction in the file. A capability returning
 * "found 12 videos" is a **report**: the capability said so. Twelve independent
 * observations are **observations**. Only the second can complete a Mission, and
 * only the second counts toward a requested quantity — so `reported` evidence is
 * journalled, displayed, and excluded from progress.
 */
export const MISSION_EVIDENCE_ORIGINS = Object.freeze(['observed', 'reported'] as const)

export type MissionEvidenceOrigin = (typeof MISSION_EVIDENCE_ORIGINS)[number]

export function isMissionEvidenceOrigin(value: unknown): value is MissionEvidenceOrigin {
  return typeof value === 'string' && (MISSION_EVIDENCE_ORIGINS as readonly string[]).includes(value)
}

/**
 * What kind of thing was recorded.
 *
 * `result` is the only kind that counts toward a requested quantity, and only when
 * its origin is `observed`. `refusal` is recorded so that "the tool said it could
 * not" is durable rather than a gap, and it never counts as a result.
 */
export const MISSION_EVIDENCE_KINDS = Object.freeze(['result', 'observation', 'report', 'refusal'] as const)

export type MissionEvidenceKind = (typeof MISSION_EVIDENCE_KINDS)[number]

export function isMissionEvidenceKind(value: unknown): value is MissionEvidenceKind {
  return typeof value === 'string' && (MISSION_EVIDENCE_KINDS as readonly string[]).includes(value)
}

/**
 * One durable observation or report.
 *
 * `expiresAt` is how verification freshness is expressed without a timer: an
 * evidence item past its expiry is still in the journal, still displayed, and no
 * longer counts. Nothing polls it — expiry is computed whenever progress is
 * derived or a completion is requested, so an expired claim is *discovered*
 * rather than watched.
 */
export interface MissionEvidenceRecord {
  readonly evidenceId: string
  /** The step that produced it, or null for evidence the owner supplied directly. */
  readonly stepId: string | null
  readonly kind: MissionEvidenceKind
  readonly origin: MissionEvidenceOrigin
  /** A measured length. The evidence itself is in the encrypted store or nowhere. */
  readonly summaryLength: number
  readonly recordedAt: string
  /** When this stops counting, or null when it does not expire. */
  readonly expiresAt: string | null
}

/* ---------------------------------------------------------------- blockers */

/**
 * Why a Mission cannot move.
 *
 * Closed codes, because a blocker's whole job is to be *actionable*: `no_capable_worker`
 * and `unknown_capability` are things a person can fix, and a sentence would not be.
 */
export const MISSION_BLOCKER_CODES = Object.freeze([
  'unknown_capability',
  'no_capable_worker',
  'worker_mismatch',
  'concurrency_ceiling',
  'budget_exhausted',
  'retry_ceiling',
  'approval_denied',
  'approval_expired',
  'capability_unavailable',
  'dependency_unverified',
  'intent_ambiguous',
  'step_failed',
] as const)

export type MissionBlockerCode = (typeof MISSION_BLOCKER_CODES)[number]

export function isMissionBlockerCode(value: unknown): value is MissionBlockerCode {
  return typeof value === 'string' && (MISSION_BLOCKER_CODES as readonly string[]).includes(value)
}

export interface MissionBlockerRecord {
  readonly code: MissionBlockerCode
  /** The step that cannot proceed, or null for a Mission-wide block. */
  readonly stepId: string | null
  readonly raisedAt: string
  /** When it stopped applying, or null while it does. */
  readonly clearedAt: string | null
}

/* --------------------------------------------------------------- approvals */

/**
 * Where an approval stands.
 *
 * Mirrors `APPROVAL_STATUSES` in `work/types.ts` deliberately rather than inventing
 * a second vocabulary: the Mission gate and the Work approval are the same decision
 * seen from two sides, and a second set of codes would let them drift.
 *
 * `expired` is a **terminal status and never a decision**. A gate that timed out
 * did not approve anything, and the fold refuses to treat an expired gate as an
 * approval — which is the single most important line in this section.
 */
/**
 * Why a Mission step asked for a gate before it ran.
 *
 * The step does not decide *whether* a gate is needed — Work's Guard does, when the Run
 * executes — so the Mission only ever carries the question it asked and the answer it
 * read back. `requested` is what the Mission recorded when it handed the Run to Work;
 * `observed` is what Work's canonical `work.approval.requested` turned out to be.
 */
export const MISSION_APPROVAL_SOURCES = Object.freeze(['requested', 'observed'] as const)

export type MissionApprovalSource = (typeof MISSION_APPROVAL_SOURCES)[number]

/**
 * What a Mission knows about a gate it is parked on.
 *
 * A **pointer and an outcome**, never a lifecycle. This shape has no `pending` state
 * worth managing and no field a caller could write a decision into, because the decision
 * lives in Work's `ApprovalRecord` and is made by a person through
 * `work.approval.decide`.
 *
 * `outcome` is what Work last said, read back. `null` means Work has not reported a
 * terminal outcome yet — the gate is open. It is deliberately `null` rather than
 * `'pending'`: the Mission does not get to have an opinion about a gate it does not own.
 */
export interface MissionApprovalReference {
  /** Work's own approval id, from `work.approval.requested`. The only real one. */
  readonly approvalId: string
  /** Which step asked. */
  readonly stepId: string
  /**
   * The Work Run the gate belongs to.
   *
   * Present so a parked Mission can **poll** its gate on a later decision without
   * re-running the step. That is the whole reason it is here: Work holds the Run, the
   * step record cannot yet carry the id (a `running` step cannot transition to `running`),
   * and a Mission that had to execute again to learn what happened to the gate would
   * create a *second* Run for one step — two Runs, one action, one approval.
   *
   * It is also the binding that keeps the two honest: a gate is looked up through the Run
   * that opened it, so two Runs of one Mission can never be mistaken for each other.
   */
  readonly runId: string | null
  readonly source: MissionApprovalSource
  /** The instant Work opened the gate. */
  readonly requestedAt: string
  /**
   * What Work reported, or `null` while the gate is open.
   *
   * **Derived, never written directly.** The fold sets it from a `mission.blocker.changed`
   * carrying `approval_denied` or `approval_expired` — which is the durable record of the
   * outcome, and which Core could only have written by reading Work. There is no
   * `mission.approval.decided` event to write, so there is no event in which a Mission
   * could assert an outcome it was not told.
   *
   * `approved` is deliberately not represented. When a gate is approved, Work's engine
   * resumes the Run and the step settles, and the fold then **clears** the reference — a
   * settled step is not waiting on anything. Recording "approved" would be Core claiming a
   * step it did not run.
   */
  readonly outcome: 'denied' | 'expired' | 'cancelled' | null
}

/* ------------------------------------------------------------------- wakes */

/**
 * What may wake a Mission.
 *
 * `event` and `time` are the two the system can grant itself. `manual` is a person
 * pressing resume. There is no fourth kind, and in particular there is no
 * `continuous` or `poll`: the absence of one of those is what makes "no hidden
 * model loops" a property of the type rather than a promise in a comment.
 */
export const MISSION_WAKE_KINDS = Object.freeze(['event', 'time', 'manual'] as const)

export type MissionWakeKind = (typeof MISSION_WAKE_KINDS)[number]

/**
 * Who is allowed to say a wake fired.
 *
 * `fabric` is the durable event stream, which is authenticated by construction.
 * `time` is the clock. `owner` is a person. Anything else — a model, a capability,
 * a page, a worker — is not in this list, and a wake claiming such a source is
 * refused rather than honoured.
 */
export const MISSION_WAKE_SOURCES = Object.freeze(['fabric', 'time', 'owner'] as const)

export type MissionWakeSource = (typeof MISSION_WAKE_SOURCES)[number]

export function isMissionWakeSource(value: unknown): value is MissionWakeSource {
  return typeof value === 'string' && (MISSION_WAKE_SOURCES as readonly string[]).includes(value)
}

/**
 * A durable, bounded next wake.
 *
 * `dueAt` is required on every record including an event wake. That is not
 * decoration: an event that never arrives is a Mission that waits forever, and a
 * wait with no end is the open-ended wait this subsystem must not be able to
 * record. Bounding it at the Mission's own deadline means a missed wake becomes
 * *evidence* — a recorded fact that the event did not come — rather than silence.
 */
export interface MissionWakeRecord {
  readonly wakeId: string
  readonly kind: MissionWakeKind
  readonly source: MissionWakeSource
  /** Always present. The instant after which this wake is re-decided. */
  readonly dueAt: string
  /** For an event wake, the event type that satisfies it. Null otherwise. */
  readonly eventType: string | null
  readonly scheduledAt: string
  readonly firedAt: string | null
  /** The continuation decision that consumed it. Null until one does. */
  readonly consumedBy: string | null
}

/* ----------------------------------------------------------------- budgets */

/**
 * What one Mission may consume, over its whole life.
 *
 * Every field is a **ceiling, frozen at creation**, and a caller may lower one and
 * never raise one — the same `missionBudget` contract `workerBudget` and
 * `missionLimits` already use. A budget read from live configuration is a budget
 * that can be raised underneath a Mission that is mid-flight.
 *
 * The five *spend* dimensions answer exactly the questions the brief asks:
 * model-call, action, duration and external-request ceilings, plus retries. There is
 * no `maxMoney` field, and that omission is the enforcement: Freya has no way to
 * represent spending money, so no code path can be written that does it.
 */
export interface MissionBudget {
  /** Cognition requests this Mission may ever make. */
  readonly maxModelCalls: number
  /** Actions any step of this Mission may ever perform. */
  readonly maxActions: number
  /** External requests any step may make. Contacts the outside world. */
  readonly maxExternalRequests: number
  /** Wall-clock from activation. A bound, not a poll. */
  readonly maxDurationMs: number
  /** Retries across every step of this Mission. */
  readonly maxRetries: number
  /** Delegations this Mission may ever make. */
  readonly maxDelegations: number
  /** Delegations allowed to be open at once. This is the anti-swarm ceiling. */
  readonly maxConcurrentDelegations: number
  /** Plan revisions this Mission may ever produce. This is the anti-replan-loop ceiling. */
  readonly maxPlanRevisions: number
  /** Steps one plan may contain. */
  readonly maxStepsPerPlan: number
}

export const DEFAULT_MISSION_BUDGET: Readonly<MissionBudget> = Object.freeze({
  maxModelCalls: 32,
  maxActions: 128,
  maxExternalRequests: 32,
  maxDurationMs: 30 * 24 * 60 * 60_000,
  maxRetries: 8,
  maxDelegations: 64,
  maxConcurrentDelegations: 4,
  maxPlanRevisions: 8,
  maxStepsPerPlan: 24,
})

const MISSION_BUDGET_NAMES: readonly (keyof MissionBudget)[] = [
  'maxModelCalls',
  'maxActions',
  'maxExternalRequests',
  'maxDurationMs',
  'maxRetries',
  'maxDelegations',
  'maxConcurrentDelegations',
  'maxPlanRevisions',
  'maxStepsPerPlan',
]

/**
 * Apply narrowed ceilings.
 *
 * An unknown key, a non-integer, a non-positive value and a value above the
 * code-owned ceiling are all **refused**, never clamped — the same four refusals
 * `missionLimits` makes, and for the same reason: a clamp would silently accept a
 * caller trying to raise a limit.
 */
export function missionBudget(overrides: Partial<MissionBudget> = {}): Readonly<MissionBudget> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('mission budget is malformed')
  }
  const merged: Record<string, number> = { ...DEFAULT_MISSION_BUDGET }
  for (const [key, value] of Object.entries(overrides)) {
    if (!MISSION_BUDGET_NAMES.includes(key as keyof MissionBudget)) {
      throw new Error(`unknown mission budget: ${key}`)
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`mission budget ${key} is not a positive integer`)
    }
    if (value > DEFAULT_MISSION_BUDGET[key as keyof MissionBudget]) {
      throw new Error(`mission budget ${key} may not exceed its code-owned ceiling`)
    }
    merged[key] = value
  }
  return Object.freeze(merged as unknown as MissionBudget)
}

/**
 * What a Mission has actually consumed, derived by folding events.
 *
 * There is no `setSpend` and no event that increments a counter without the action
 * that caused it, so the only way to move a number here is to have performed the
 * work. A restart cannot refill a budget, which is what makes a budget a budget.
 */
export interface MissionSpend {
  readonly modelCalls: number
  readonly actions: number
  readonly externalRequests: number
  readonly retries: number
  readonly delegations: number
}

export const EMPTY_MISSION_SPEND: Readonly<MissionSpend> = Object.freeze({
  modelCalls: 0,
  actions: 0,
  externalRequests: 0,
  retries: 0,
  delegations: 0,
})

/* ----------------------------------------------------------- continuation */

/**
 * The eight things Freya may decide to do next.
 *
 * These are **decisions**, not permissions, and the distinction is enforced by the
 * split between this file and `authority.ts`: a decision says *what*, and
 * `authority.ts` says *whether it may happen*. There is no decision here that
 * implies a grant, and `MISSION_DECISIONS` is the complete list of ways this
 * subsystem can choose to move.
 *
 * - `plan` — build a bounded plan for the goal. The GOAL → PLAN edge, and the only
 *   decision that creates something rather than reacting to what exists. Distinct from
 *   `replan`, which *replaces* an existing plan.
 * - `continue` — the next step can proceed now.
 * - `retry` — it failed, attempts remain. Bounded by `budget.maxRetries`.
 * - `wait` — stop and be woken. `nextWakeAt` is **required**.
 * - `request_approval` — a person must decide before anything further happens.
 * - `ask_owner` — the goal itself is unclear. Nothing proceeds.
 * - `replan` — the plan is wrong. Bounded by `budget.maxPlanRevisions`.
 * - `complete` — request mission-level verification. **Never completes directly.**
 * - `fail` — conclude as unable to continue.
 */
/**
 * What the first plan tries: one registered capability, and the check that judges it.
 *
 * Both are Core's own registry facts and neither is a guess about the goal.
 *
 * **`capability`** is the lowest-risk registered capability, because nothing is known about
 * which capability suits a goal and starting with the least consequential thing is the
 * conservative default.
 *
 * **`verifier`** is the one the capability's registration declares. That declaration is the
 * point: Work separates a capability from the check that judges it *precisely* so the two
 * cannot be the same piece of code, and a planner that picked a verifier alphabetically would
 * routinely land on `test.always-fails` — a verifier registered to demonstrate that
 * verification can fail. A Mission would then retry to its ceiling and block, which is
 * indistinguishable from work that genuinely kept failing.
 */
export interface MissionPlanChoice {
  readonly capability: string
  readonly verifier: string
  /** Copied from the capability's own registration. The planner cannot choose this. */
  readonly risk: WorkRisk
}

export const MISSION_DECISIONS = Object.freeze([
  'plan',
  'continue',
  'retry',
  'wait',
  'request_approval',
  'ask_owner',
  'replan',
  'complete',
  'fail',
] as const)

export type MissionDecision = (typeof MISSION_DECISIONS)[number]

export function isMissionDecision(value: unknown): value is MissionDecision {
  return typeof value === 'string' && (MISSION_DECISIONS as readonly string[]).includes(value)
}

/**
 * One continuation decision.
 *
 * `nextWakeAt` is required exactly when `decision === 'wait'`, which the type
 * cannot express and {@link assertWakeBounded} therefore checks at runtime. A wait
 * that does not say when it expires is the open-ended wait this subsystem must not
 * be able to record: there is no timer here that would ever end it, and nothing
 * else in Core has one on this Mission's behalf.
 */
export interface MissionContinuationDecision {
  readonly decision: MissionDecision
  /** A closed-code explanation. The board renders this; a person reads this. */
  readonly reason: MissionReason
  readonly stepId: string | null
  /** Required on `wait`, forbidden elsewhere. */
  readonly nextWakeAt: string | null
}

/**
 * Every wait is bounded, or it is not a decision.
 *
 * The one invariant in this file that a type could not express, checked at the one
 * place a decision is constructed. `wait` without a future instant, or any other
 * decision carrying one, is refused — so the projection can never display a Mission
 * whose next action is "wait" and whose next wake is "whenever".
 */
export function assertWakeBounded(decision: MissionContinuationDecision): MissionContinuationDecision {
  const at = decision.nextWakeAt
  if (decision.decision === 'wait') {
    if (at === null || !Number.isFinite(Date.parse(at))) {
      throw new Error('a wait decision must name an instant at which it expires')
    }
  } else if (at !== null) {
    throw new Error('only a wait decision may name a next wake')
  }
  return decision
}

/* -------------------------------------------------------------- correction */

/**
 * Which parts of a Mission's intent an owner correction can address.
 *
 * These are *field names*, never values. A correction journalling "the context
 * changed" is the most a correction may say in the journal, and the actual new
 * context lives in the encrypted intent store like the original.
 */
export const MISSION_INTENT_FIELDS = Object.freeze([
  'subject',
  'quantity',
  'media',
  'context',
  'exclusions',
] as const)

export type MissionIntentField = (typeof MISSION_INTENT_FIELDS)[number]

export function isMissionIntentField(value: unknown): value is MissionIntentField {
  return typeof value === 'string' && (MISSION_INTENT_FIELDS as readonly string[]).includes(value)
}

/**
 * What happened when an owner corrected a running Mission.
 *
 * - `patch` — unambiguous, applied to the **same** Mission.
 * - `ambiguous` — could not be resolved to one reading, so the owner was asked and
 *   **nothing changed**. There is no `assumed` here, and that absence is the point.
 * - `rejected` — refused: no active Mission, or already terminal.
 */
export const MISSION_CORRECTION_KINDS = Object.freeze(['patch', 'ambiguous', 'rejected'] as const)

export type MissionCorrectionKind = (typeof MISSION_CORRECTION_KINDS)[number]

/**
 * Why a correction could not be resolved to exactly one reading.
 *
 * A closed code rather than a question string, for the same reason as everything
 * else in the journal: an owner's ambiguous half-sentence is content, and content
 * does not go in the journal. The *question asked* lives in the encrypted store.
 */
export const MISSION_CORRECTION_AMBIGUITIES = Object.freeze([
  'unknown_subject',
  'conflicting_quantity',
  'unknown_scope',
  'multiple_subjects',
  'no_active_mission',
  'already_settled',
] as const)

export type MissionCorrectionAmbiguity = (typeof MISSION_CORRECTION_AMBIGUITIES)[number]

export function isMissionCorrectionAmbiguity(value: unknown): value is MissionCorrectionAmbiguity {
  return typeof value === 'string' && (MISSION_CORRECTION_AMBIGUITIES as readonly string[]).includes(value)
}

/**
 * A journalled correction.
 *
 * `settledSteps` and `preservedEvidence` are counts, and they are in the journal on
 * purpose. "I told it to look in the barn and it threw away everything it had found"
 * and "…and it kept what it had already found" are the two facts a person needs
 * after correcting a running Mission, and neither is recoverable from the resulting
 * state alone.
 */
export interface MissionCorrectionRecord {
  readonly correctionId: string
  readonly kind: MissionCorrectionKind
  /** Field *names* that changed. Empty on `ambiguous` and `rejected`. */
  readonly changedFields: readonly MissionIntentField[]
  /** Steps settled as incompatible with the new intent. */
  readonly settledSteps: number
  /** Evidence kept because it remains valid under the new intent. */
  readonly preservedEvidence: number
  /** The plan revision the Mission resumed from, or null when the correction also replanned. */
  readonly replannedFrom: string | null
  readonly ambiguity: MissionCorrectionAmbiguity | null
  readonly at: string
}

/**
 * The structured, patchable shape of a Mission's intent.
 *
 * This is what makes "find 100 cat videos" then "in the barn" a *patch to the same
 * mission* rather than a new one: the correction has somewhere precise to put
 * "in the barn", and everything else — the subject, the quantity, the media
 * constraint — is a named field it did not mention and therefore did not change.
 *
 * It lives in the encrypted content store beside the free-text intent, never in the
 * journal. The journal holds only `requestedQuantity` and `resultCount`, both
 * integers, because progress is "37 of 100" and that is a fact about counting
 * rather than a fact about what the owner wants.
 */
export interface MissionIntentShape {
  /** What is being sought. Bounded, control-stripped, private. */
  readonly subject: string
  /** How many. Null when the owner did not say a number. */
  readonly requestedQuantity: number | null
  /** "video", "audio", "images" — the media/type constraint. */
  readonly mediaConstraints: readonly string[]
  /** "in the barn", "from this week" — where or under what conditions. */
  readonly contextConstraints: readonly string[]
  /** Things the owner does not want. */
  readonly exclusions: readonly string[]
  /** Whether the owner has asked for this to stop, without ending it. */
  readonly paused: boolean
}

/** A correction as an owner states it. Values are private and normalised on the way in. */
export interface MissionCorrectionInput {
  readonly subject?: string
  readonly quantity?: number
  readonly media?: readonly string[]
  readonly context?: readonly string[]
  readonly exclusions?: readonly string[]
  readonly pause?: boolean
  readonly cancel?: boolean
}

/* ----------------------------------------------------------- board projection */

/**
 * Step counts by status.
 *
 * Nine integers, and no percentage. This is the shape progress has to take when a
 * plan can be revised, decomposed again and retried: "4 of 6 steps verified" is a
 * fact about a plan, and "67%" would be arithmetic about a denominator Freya chose.
 */
export interface MissionStepCounts {
  readonly total: number
  readonly pending: number
  readonly blocked: number
  readonly delegated: number
  readonly running: number
  readonly verified: number
  readonly failed: number
  readonly cancelled: number
  readonly skipped: number
}

/** Progress as counts. Never a fraction of a Mission. */
export interface MissionProgressView {
  readonly steps: MissionStepCounts
  readonly planSteps: number
  /** Fresh observed results. Expired ones are in `evidence.expired` and count for nothing. */
  readonly observed: number
  /** What capabilities *said* they found. Displayed, never counted as progress. */
  readonly reported: number
  readonly requestedQuantity: number | null
  /** Null unless the owner named a quantity. Never a guess. */
  readonly quantitySatisfied: boolean | null
}

/**
 * Evidence, split three ways.
 *
 * The three-way split is the requirement, not decoration: collapsing `observed`
 * into `reported` is the single easiest way for a board to claim a Mission is
 * further along than it is, and collapsing `expired` into `observed` is the single
 * easiest way for it to claim progress that no longer holds.
 */
export interface MissionEvidenceCounts {
  readonly total: number
  readonly observed: number
  readonly reported: number
  readonly expired: number
  /** Observations whose external effect is unknown, from an interrupted step. */
  readonly uncertain: number
}

/** One step as a board may show it. Ids and statuses; never a label. */
export interface MissionStepView {
  readonly stepId: string
  readonly index: number
  readonly status: MissionStepStatus
  readonly capability: string
  readonly attempts: number
  readonly workerId: string | null
  readonly runId: string | null
  readonly reason: MissionReason | null
  readonly dependsOn: readonly string[]
}

/**
 * What is left of each ceiling.
 *
 * Reported rather than hidden, so a Mission about to run out says so *before* it
 * does. These are integers the projection subtracts; nothing reads them to widen a
 * budget, and a Mission that hits one waits or fails truthfully.
 */
export interface MissionBudgetRemaining {
  readonly modelCalls: number
  readonly actions: number
  readonly externalRequests: number
  readonly retries: number
  readonly delegations: number
  readonly planRevisions: number
  readonly concurrentDelegations: number
}

/* -------------------------------------------------------- capability binding */

/**
 * A capability the planner has checked exists, and how it may be used.
 *
 * Produced only by {@link resolveCapabilityBinding} against the *registered* Work
 * capability table. A planner cannot name one of these from a payload, so
 * "a step whose capability does not exist" is not a thing the code can express
 * past the resolver — it is a `blocked` outcome.
 */
export interface MissionCapabilityBinding {
  readonly capability: string
  readonly verifier: string
  readonly risk: WorkRisk
  readonly requiresApproval: boolean
}

/** What the planner needs to know about capabilities, and nothing more. */
export interface MissionCapabilityPort {
  /**
   * The registered capability, if it exists.
   *
   * A planner may only bind what this returns. There is no `register` on this interface,
   * which is the property that matters: a planner handed this table can resolve a
   * capability and can never add one, so "the plan asked for something Freya does not
   * have" is a blocked step rather than a new capability.
   */
    /**
   * The registered capability, if it exists.
   *
   * A planner may only bind what this returns. There is no `register` on this interface,
   * which is the property that matters: a planner handed this table can resolve a
   * capability and can never add one, so "the plan asked for something Freya does not
   * have" is a blocked step rather than a new capability.
   *
   * `verifier` is the capability's own declared pairing, or `null`. It is null rather than
   * omitted-to-mean-default because a planner with no honest pairing available must leave
   * the capability alone; a missing field read as "any verifier will do" is how a Mission
   * ends up checked by `test.always-fails`.
   */
  lookup(capability: string): { risk: WorkRisk; requiresApproval: boolean; verifier: string | null } | null
  /**
   * Every registered verifier name.
   *
   * Separate from `lookup` because a verifier is chosen by the *plan*, not implied by the
   * capability: `record.execute` and `record.fail` are the same capability with different
   * checks. So the planner resolves both independently, and an unknown verifier is as
   * fatal as an unknown capability — a Step with no way to be checked cannot reach
   * `verified`, and letting one be planned would produce a step that can only ever fail.
   */
  verifiers(): readonly string[]
  /** Every registered capability name. Bounded by the registry, never by a payload. */
  known(): readonly string[]
}

/* ------------------------------------------------------------------- misc */

export type { Capability, WorkRisk }