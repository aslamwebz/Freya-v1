import type { PrincipalId } from '../../../shared/contracts/identity'
import type { MissionReason } from '../types'
import type { MissionBudget, MissionPriority, MissionStepRecord } from './types'

/**
 * THE AUTONOMY AUTHORITY GATE.
 *
 * One function decides whether Freya may *act* on a Mission's behalf. One function
 * decides whether she may *ask a person*. They are separate because conflating them is
 * how a system ends up treating a permission as consent.
 *
 * ## What this file is allowed to do
 *
 * Evaluate. Refuse. Ask a person. Charge a budget. That is the complete list, and there
 * is no method here that grants, widens, or mints.
 *
 * ## What it deliberately cannot do
 *
 * - **No grant creation.** There is no `grantCapability`, and `MissionAuthorityPort`
 *   has no method that returns one. A planner or a Mission that could widen its own
 *   authority would make every other ceiling in this subsystem decorative.
 * - **No money.** There is no spend decision to make. `NO_REAL_MONEY` below is a string
 *   rather than a check because the honest enforcement is that there is no money-shaped
 *   field anywhere in the Mission model for a check to read.
 * - **No approval minting, and no approval of its own.** There is no `requestApproval` on
 *   this port, and that is not an omission to be filled in later. A Mission step that
 *   needs a signature gets one from **Work**: the Run is created, Work's Guard opens the
 *   gate inside `drive()`, and a person answers on Work's surface through
 *   `work.approval.decide`. This subsystem holds a pointer to that gate and reads its
 *   outcome back; it has no gate of its own to open, decide, expire, or get approved.
 *
 *   The reason is structural rather than stylistic. Work's `ApprovalRecord` requires a
 *   `runId`, and gates are opened when a Run executes — so a Mission-level gate opened
 *   before the Run exists could never *be* a Work gate. It would be a parallel approval
 *   system inside Core, asking the same person the same question twice and answering
 *   neither one.
 * - **No STOP ALL override.** `stopAll` is read from a live port at the moment of the
 *   decision, and there is no parameter anywhere that could suppress it.
 *
 * ## The order of the checks, and why it is this order
 *
 * ```
 * STOP ALL → sealed gate → budget → risk → approval
 * ```
 *
 * Each is cheaper than the one after it, and each is a strictly stronger refusal. A
 * stopped Freya does not need to know her budget was also exhausted; answering "you are
 * stopped" is the more useful answer, and it is the one the owner pressing the button
 * needs. The order is also monotone: nothing later can overturn an earlier refusal, so
 * adding a check at the end cannot weaken one at the front.
 */

/**
 * The one sentence that says what this subsystem will never do on its own.
 *
 * Exported so it can be asserted in a test and quoted in a review. A promise in a
 * comment is worth less than a string a test can fail on if someone deletes it.
 */
export const NO_REAL_MONEY =
  'Mission autonomy never spends money, transfers value, or commits Freya to a financial obligation.'

/** What the authority gate needs to know about the world, and nothing more. */
export interface MissionAuthorityPort {
  /** STOP ALL, read live at the moment of the decision. Never cached. */
  stopAll(): boolean
  /**
   * Whether Freya's own principal may use a named Work capability.
   *
   * A *read* of policy, not a way to obtain authority: the gate asks "may I?" and gets
   * an answer, and it never supplies a capability string that widens anything.
   *
   * The parameter is a **Work capability name** — `record`, `searcher.execute`, a name
   * from Core's registry — rather than a `Capability` from the Guard vocabulary. Those are
   * two namespaces and they are deliberately not conflated: a Work capability declares
   * which `Capability` it needs, and Guard evaluates *that*, inside Work's engine, at the
   * moment the action runs.
   *
   * Asking about the Work name here is therefore a Mission-level policy question ("may
   * this Mission reach for that tool at all?") and not a substitute for Guard. Nothing is
   * skipped by it; the authoritative evaluation simply lives one layer down, where it
   * already did.
   */
  mayUse(capability: string): boolean
  /**
   * Whether spending is permitted at all.
   *
   * Always false in this phase and there is no configuration that makes it true. It
   * exists as an explicit, testable refusal rather than as an absence: "zero spend unless
   * separately approved" is easier to verify when there is a function that always
   * returns false.
   */
  maySpend(kind: 'model-call' | 'external-request'): boolean
  /**
   * Ask Work what a step's gate is doing.
   *
   * A **read**, and the only approval-shaped thing on this port. It answers "is the Run for
   * this step waiting on a person, and has that person answered", and it answers from
   * Work's own `ApprovalRecord`.
   *
   * There is deliberately no method here that *opens* a gate or *decides* one. Asking is
   * how a Mission learns it must wait; it is not how a Mission gets permission. The
   * capability to grant lives in `work.approval.decide`, behind a Guard evaluation of the
   * owner, and there is no parameter, payload or method on this port that reaches it.
   */
  approvalState(input: {
    missionId: string
    stepId: string
    /**
     * The Run that executed this step, when there is one.
     *
     * Passed rather than looked up, because the runtime is the only party that saw the
     * executor's answer and the step record does not carry the id yet: writing it needs a
     * step transition, and a `running` step cannot transition to `running`.
     *
     * `null` means no Run exists for this step, so Work was never asked and there is
     * nothing pending. Resolving the gate from a *name* instead of a Run id would be the
     * mistake here: two Runs of one Mission could then be confused for each other.
     */
    runId: string | null
  }): Promise<
    | { readonly ok: true; readonly state: MissionApprovalReadback }
    | { readonly ok: false; readonly reason: string }
  >
}

/**
 * What Work says about the gate on a Mission step's Run.
 *
 * `open` is the honest answer for a step whose Run has not reached a gate yet — either
 * because nothing required one, or because it has not run. Only `outcome` values that
 * Work itself recorded can appear here, which is what makes this a read rather than a
 * claim.
 */
export type MissionApprovalReadback =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly approvalId: string; readonly requestedAt: string }
  | {
      readonly kind: 'settled'
      readonly approvalId: string
      readonly outcome: 'approved' | 'denied' | 'expired' | 'cancelled'
      readonly decidedAt: string | null
      /**
       * When Work opened the gate.
       *
       * Carried on the settled answer too, and not merely for convenience: it is the only
       * instant in the record for when the *question* was asked, and an outcome that
       * arrived without it would leave the Mission unable to say how long it had been
       * waiting. It is Work's own `requestedAt`, copied — not a new clock.
       */
      readonly requestedAt: string
    }

export type AuthorityOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly code: MissionReason }

/**
 * Whether Freya may begin a step.
 *
 * Four refusals, each for a different reason a person would give:
 *
 * - `stopped` — the panic button. Asked first, because it is the one the person who
 *   pressed it is waiting to hear about.
 * - `sealed` — STOP ALL is latched and this Mission has not been resumed by its owner.
 *   Distinct from `stopped` because the Mission's *own* state is what says this, so a
 *   reader can tell "the whole system is stopped" from "this Mission is parked".
 * - `capability_unavailable` — the principal may not use the capability, or it is not
 *   in the vocabulary. **Never** "let me try it and see".
 * - `budget_exhausted` — a ceiling has been reached.
 *
 * `pendingApproval` is deliberately *not* a refusal here. A step that needs approval is
 * not forbidden; it is waiting, and the caller asks for one. Treating "needs a signature"
 * as "denied" would mean Freya could never ask.
 */
export function mayBeginStep(
  step: MissionStepRecord,
  missionStatus: 'ready' | 'planning' | 'active' | 'waiting' | 'blocked' | 'approval-required' | 'stopped',
  budget: MissionBudget,
  remaining: { actions: number; retries: number; delegations: number },
  authority: MissionAuthorityPort,
): AuthorityOutcome {
  if (authority.stopAll()) {
    return { ok: false, reason: 'STOP ALL is active', code: 'stopped' }
  }
  if (missionStatus === 'stopped') {
    return { ok: false, reason: 'this Mission is stopped until its owner resumes it', code: 'stopped' }
  }
  if (missionStatus === 'blocked') {
    return { ok: false, reason: 'this Mission is blocked', code: 'step_failed' }
  }
  if (missionStatus === 'approval-required') {
    return { ok: false, reason: 'this Mission is waiting on an approval decision', code: 'approval_pending' }
  }

  // Is this step's capability still usable?
  //
  // `mayUse` is asked about the **plan's capability name**, not a `Capability` from the
  // Guard vocabulary, and the distinction is load-bearing. A Work capability name
  // (`find.video`) and a Guard vocabulary capability (`work.execute`) are different
  // namespaces: Guard evaluates the latter, and it does so inside Work's engine when the
  // Run executes. Checking a Work name against the Guard vocabulary here would be a type
  // error at best and, at worst, a check that always fails for every real capability.
  //
  // So this asks the authority port one question — "may Freya's Mission run *this
  // capability*?" — and the deeper Guard evaluation happens where it has always happened,
  // at the moment the action runs. Nothing is skipped by asking here instead; the
  // authoritative check is simply not in this file.
  if (!authority.mayUse(step.capability)) {
    return { ok: false, reason: `Freya may not use ${step.capability}`, code: 'capability_unavailable' }
  }

  // Budget before risk, because a Mission out of budget cannot act at all and being told
  // it also needed an approval would be a second, less useful answer.
  if (remaining.actions <= 0) {
    return { ok: false, reason: 'this Mission has used its whole action budget', code: 'budget_exhausted' }
  }
  if (step.status === 'failed' && remaining.retries <= 0) {
    return { ok: false, reason: 'this Mission has used its whole retry budget', code: 'retry_ceiling' }
  }
  if (remaining.delegations <= 0) {
    return { ok: false, reason: 'this Mission has used its whole delegation budget', code: 'budget_exhausted' }
  }
  void budget
  return { ok: true }
}

/**
 * Whether a Mission step should *ask* Work for a gate.
 *
 * This is a **request, not a decision**. It becomes `requiresApproval` on the Run's single
 * step, and Work's engine opens the gate inside `drive()` — so Work's Guard, its TTL and
 * its `work.approval.decide` remain the only things that can approve anything. This
 * function has no way to skip a gate the capability itself demands, because it does not
 * get a say: `step.risk === 'consequential'` is Work's own word for that capability, and
 * it flows through to `requiresApproval` rather than being checked here.
 *
 * `||` and not `&&`, and the direction of the OR is the whole point: a plan may make a
 * step *more* gated than its capability would otherwise be, and can never make it less.
 * A `&&` would let a planner talk Guard out of a gate the capability requires.
 */
export function asksForGate(step: MissionStepRecord): boolean {
  return step.requiresApproval || step.risk === 'consequential'
}

/**
 * Charge a budget dimension.
 *
 * Returns the new totals or a refusal, and refuses to go **negative**. A budget that can
 * be overdrawn by an event is not a budget; refusing the charge is what makes "exhausted"
 * a state rather than a region the counters drift past.
 *
 * Pure: it computes what the totals would be and says so. Persisting them is the
 * runtime's job, through a `mission.budget.spent` event, which is the only path by which
 * `MissionSpend` ever moves.
 */
export function chargeBudget(
  spend: { actions: number; retries: number; externalRequests: number; modelCalls: number; delegations: number },
  budget: MissionBudget,
  charge: Partial<{ actions: number; retries: number; externalRequests: number; modelCalls: number; delegations: number }>,
):
  | { readonly ok: true; readonly next: { actions: number; retries: number; externalRequests: number; modelCalls: number; delegations: number } }
  | { readonly ok: false; readonly reason: string; readonly dimension: keyof MissionBudget } {
  const next = { ...spend }
  const ceilings: ReadonlyArray<[keyof typeof charge, number]> = [
    ['actions', budget.maxActions],
    ['retries', budget.maxRetries],
    ['externalRequests', budget.maxExternalRequests],
    ['modelCalls', budget.maxModelCalls],
    ['delegations', budget.maxDelegations],
  ]
  for (const [dimension, ceiling] of ceilings) {
    const amount = charge[dimension]
    if (amount === undefined) continue
    if (amount < 0 || !Number.isInteger(amount)) {
      return { ok: false, reason: `a budget charge for ${dimension} must be a non-negative whole number`, dimension: dimensionName(dimension) }
    }
    if (next[dimension] + amount > ceiling) {
      return { ok: false, reason: `this Mission has reached its ${dimension} ceiling`, dimension: dimensionName(dimension) }
    }
    next[dimension] += amount
  }
  return { ok: true, next }
}

function dimensionName(key: string): keyof MissionBudget {
  return `max${key.charAt(0).toUpperCase()}${key.slice(1)}` as keyof MissionBudget
}

/**
 * Whether an external request may be made.
 *
 * Two refusals: the capability must be permitted, and **no spend is ever authorised**.
 * The second is unconditional, and it is written as a call rather than as a comment
 * because `maySpend` is a port method — which means a test can assert it is consulted,
 * and a future grant cannot make it return true without somebody editing this line.
 */
export function mayMakeExternalRequest(capability: string, authority: MissionAuthorityPort): AuthorityOutcome {
  if (authority.stopAll()) return { ok: false, reason: 'STOP ALL is active', code: 'stopped' }
  // Same reasoning as `mayBeginStep`: a Work capability name, not a Guard vocabulary
  // entry. An unresolvable name never reaches here — the planner blocked the step — and
  // `mayUse` is the policy question in any case.
  if (!authority.mayUse(capability)) {
    return { ok: false, reason: `Freya may not use ${capability}`, code: 'capability_unavailable' }
  }
  if (!authority.maySpend('external-request')) {
    return { ok: false, reason: NO_REAL_MONEY, code: 'budget_exhausted' }
  }
  return { ok: true }
}

/**
 * Read what Work says about a step's gate.
 *
 * Thin on purpose. It refuses on STOP ALL, because a stopped Freya does not go asking
 * questions of a person's board, and then asks the port. It returns Work's answer
 * unchanged: there is no branch here that could turn `none` into `open`, or `open` into a
 * decision, because the only thing this function does is carry a fact from Work to the
 * runtime.
 */
export async function readApprovalState(
  step: MissionStepRecord,
  missionId: string,
  runId: string | null,
  authority: MissionAuthorityPort,
): Promise<{ ok: true; state: MissionApprovalReadback } | { ok: false; reason: string }> {
  if (authority.stopAll()) return { ok: false, reason: 'STOP ALL is active' }
  return authority.approvalState({ missionId, stepId: step.stepId, runId })
}

/* ------------------------------------------------------------------ ordering */

/**
 * How two live Missions compare for the owner's attention.
 *
 * Priority first, then the **closest deadline**. Not "most progress" and not "most
 * evidence": a board that reorders under a person mid-decision is a board they cannot
 * read. This order is stable for a given set of facts, which is the only property worth
 * having here.
 *
 * Priority grants nothing. It is an ordering and nothing else — see `MISSION_PRIORITIES`.
 */
export function compareMissions(
  a: { priority: MissionPriority; deadlineAt: string; createdAt: string; missionId: string },
  b: { priority: MissionPriority; deadlineAt: string; createdAt: string; missionId: string },
): number {
  const rank: Readonly<Record<MissionPriority, number>> = { routine: 0, important: 1, urgent: 2 }
  const byPriority = rank[b.priority] - rank[a.priority]
  if (byPriority !== 0) return byPriority
  const byDeadline = a.deadlineAt.localeCompare(b.deadlineAt)
  if (byDeadline !== 0) return byDeadline
  const byAge = a.createdAt.localeCompare(b.createdAt)
  if (byAge !== 0) return byAge
  // Ids last, so the comparison is a total order. Two Missions created in the same
  // millisecond must still have a defined order, or "which first" is a coin toss.
  return a.missionId.localeCompare(b.missionId)
}

/** Re-exported so a caller writing an executor port has the principal type in view. */
export type { PrincipalId }