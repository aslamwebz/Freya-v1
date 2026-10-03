import { deriveAcquisition } from './derive'
import {
  decideActivation,
  recordGateVerdict,
  recordOwnerApproval,
  unsatisfiedGates,
} from './gates'
import { applyRecord, emptyAcquisitionState, type AcquisitionRecord } from './fold'
import {
  activateAcquisitionRequest,
  advanceAcquisitionRequest,
  chargeAcquisitionCost,
  closeCapabilityGap,
  createAcquisitionRequestForGap,
  createCapabilityGap,
  endAcquisitionRequest,
  expireStaleAcquisitionRequest,
  expireStaleActivation,
  isStaleAcquisitionRequest,
  isStaleActivation,
} from './request'
import { projectAcquisition, projectAcquisitionRequest, projectAcquisitionRequests } from './projection'
import { AcquisitionStoreError, type AcquisitionPersistenceMode, type AcquisitionStore } from './store'
import {
  ACQUISITION_COST_UNITS,
  ACQUISITION_LIMITS,
  ACQUISITION_RETENTION,
  type AcquisitionDerivation,
  type AcquisitionPrecedence,
  type AcquisitionRequest,
  type AcquisitionState,
  type ActivationDecision,
  type CapabilityGap,
  type EvidenceGateKind,
  type GapClosureReason,
  type GateReason,
  type GateVerdictRecord,
  type RequestLifecycleReason,
} from './types'
import type {
  AcquisitionPersistenceView,
  AcquisitionProjection,
  AcquisitionRequestReadOutcome,
  AcquisitionRequestsOutcome,
  AcquisitionWriteOutcome,
} from '../protocol/acquisition'
import type { Capability, PrincipalId } from '../protocol/core-protocol'

/**
 * THE ACQUISITION ENGINE — every way a generated capability may come to exist, and the only way
 * one may ever run.
 *
 * The pipeline it owns:
 *
 * ```
 *   detectGap → proposeRequest → chargeBuildStep → markBuilt → beginVerification
 *        → recordVerification → completeVerification → requestActivation → evaluateActivation
 *        → owner approves  →  active (for ACQUISITION_RETENTION.maxActiveLifetimeMs)
 * ```
 *
 * Every arrow is a method here, and there is no other arrow. Nothing in this file can register a
 * capability, admit a skill, place a step into Work, call a provider or touch a file — it owns
 * a ledger and a conjunction, and the ledger says what Freya is trying to acquire and the
 * conjunction says whether it may run.
 *
 * ## The precedence ladder, checked in this order
 *
 * ```
 *   journal-not-trustworthy → stop-all-active → guard-denied → governor-denied
 *          → budget-exhausted → domain-rule
 * ```
 *
 * The order *is* the argument, so it lives in `ACQUISITION_PRECEDENCE` and this engine returns
 * **which rung refused** rather than merely refusing. A reader who saw only "refused" would have
 * to guess whether a stop was latched or a gate failed, and the two demand different responses:
 * one is Freya being held still, the other is a build being refused.
 *
 * The first rung is the least obvious and the most important. A journal that failed validation
 * has a hole in it, and the discarded segment may have held the very stop or refusal that would
 * otherwise apply here — so an untrustworthy journal outranks everything, **including a valid
 * owner approval**. It is the same rule, and the same reason, as the Cognition Governor's.
 *
 * The last rung is reported for the same reason the others are: a precedence of `domain-rule`
 * tells a reader that every security check passed and a *domain* rule refused, which is the
 * difference between "Freya is stopped" and "this proposal is not allowed to exist".
 *
 * ## No self-grant
 *
 * `ownerScope(principal)` issues the owner's methods to `'owner'` and returns `null` for every
 * other principal. There is no capability string that reaches an approval, no method that
 * approves without a principal, and `recordGateVerdict` refuses the `owner-approval` kind from
 * every authority but the owner. A worker may propose a build; it cannot clear one gate, and it
 * cannot pretend the seventh was passed.
 *
 * ## No authority widening
 *
 * `activateAcquisitionRequest` takes a request and an instant. No capability parameter, no scope,
 * no registry, no port, no gateway import. "Activated" means *the owner approved this specific
 * request* and nothing more; what an approved capability may actually do is decided by whatever
 * runtime holds it, under its own authority, and this domain has no path to any runtime.
 *
 * ## No hidden loops
 *
 * No scheduler, no timer, no retry, no background flag. Cost is charged in code-owned units that
 * mean nothing to any provider, refused **at** the ceiling rather than allowed to overshoot, and
 * a terminal request cannot be charged at all. Expiry is a fact a caller evaluates
 * (`applyRetention(now)`), never a thing that happens while Freya is doing something else.
 */

export interface AcquisitionGuardVerdict {
  readonly allowed: boolean
  readonly reason: string
}

/**
 * Everything the engine folds, and everything it must ask about.
 *
 * All four questions are injected and all four are re-read at each decision, because a decision
 * taken against a cached latch is a decision taken against a stop that has since been cleared.
 */
export interface AcquisitionEngineOptions {
  readonly store: AcquisitionStore
  /** Injected so every instant is a test's choice rather than the host's wall clock. */
  readonly now?: () => Date
  /** Whether the event journal can be believed. Outranks everything else. */
  readonly journalTrustworthy?: () => boolean
  /** The owner's global latch. Read fresh; a latch is not an approval. */
  readonly stopAllActive?: () => boolean
  /**
   * The Guard, as one question.
   *
   * Passed in rather than imported so this module holds no authority object and cannot mint one:
   * it asks "would this principal be allowed `capability`?" and believes the answer.
   */
  readonly guard?: (capability: Capability, principal: PrincipalId) => AcquisitionGuardVerdict
  /**
   * The Cognition Governor, as one question: may background building happen at all?
   *
   * Building is model work and it spends, which is exactly the class of thing the Governor
   * exists to refuse. The engine holds no opinion about allowances; it asks and obeys.
   */
  readonly governor?: () => AcquisitionGuardVerdict
  readonly onChange?: () => void
}

/** The owner's acts. Issued to the owner principal and to nothing else. */
export interface AcquisitionOwnerScope {
  readonly principalId: 'owner'
  /** Approve or decline this activation. The only route to `active`. */
  decide(requestId: string, approved: boolean, reason: string): Promise<AcquisitionWriteOutcome>
  /** Reject a request that has not reached activation. */
  reject(requestId: string, reason: string): Promise<AcquisitionWriteOutcome>
  /** Withdraw a request at any live stage before activation. */
  withdraw(requestId: string, reason: string): Promise<AcquisitionWriteOutcome>
  /** Revoke a standing activation. Terminal: re-activating needs a new request. */
  revoke(requestId: string, reason: string): Promise<AcquisitionWriteOutcome>
  /** Close a gap the owner no longer believes in. */
  closeGap(gapId: string, reason: string): Promise<AcquisitionWriteOutcome>
}

export class AcquisitionEngine {
  private readonly store: AcquisitionStore
  private readonly now: () => Date
  private readonly journalTrustworthy: () => boolean
  private readonly stopAllActive: () => boolean
  private readonly guard: (capability: Capability, principal: PrincipalId) => AcquisitionGuardVerdict
  private readonly governor: () => AcquisitionGuardVerdict
  private readonly onChange: () => void

  constructor(options: AcquisitionEngineOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.journalTrustworthy = options.journalTrustworthy ?? (() => true)
    this.stopAllActive = options.stopAllActive ?? (() => false)
    // Deny by default, both of them. An engine wired without a Guard or a Governor may read,
    // propose nothing and build nothing, which is the correct reading of a missing security
    // module — a default of "allow" here would be the one line in this phase that undoes it.
    this.guard =
      options.guard ?? (() => ({ allowed: false, reason: 'no guard is wired, so nothing is permitted' }))
    this.governor =
      options.governor ?? (() => ({ allowed: false, reason: 'no governor is wired, so nothing may build' }))
    this.onChange = options.onChange ?? (() => {})
  }

  /* ------------------------------------------------------------------ gaps */

  /**
   * Record a detected capability gap.
   *
   * A gap is a **need**: a bounded slug for the shape of what is missing, a symptom, and at least
   * one piece of evidence it was observed from. It carries no authority and no permission, and
   * there is deliberately no `missing-authority` kind — a lack of authority is a correct state
   * rather than a gap to be closed, and naming it here would make "ask for more permission" look
   * like the same kind of problem as "there is no tool that reads this file".
   */
  async detectGap(input: unknown): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.propose', 'owner', true)
    if (gate !== null) return refuse(gate, 'the gap was not recorded')
    const created = createCapabilityGap(input)
    if (!created.ok) return refuse('domain-rule', created.reason, created.code)
    await this.persist({ version: 1, kind: 'gap', gap: created.value })
    this.onChange()
    return {
      ok: true,
      operation: 'gap-detected',
      requestId: null,
      reason: 'the gap was recorded as a need, with the evidence it was observed from',
      spent: 0,
    }
  }

  /**
   * Propose a build against a stored gap.
   *
   * The store supplies the gap the record must name; the caller supplies the words. A request
   * may not cite a gap that was never detected, one that is closed, or one detected *after* the
   * request — without that, "detect gap → propose" would be two independent claims rather than a
   * chain, and a request could answer a need that never existed.
   *
   * The request comes out **untrusted and inactive**, because those two are constants assigned
   * inside the constructor rather than parameters.
   */
  async proposeRequest(input: unknown): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.propose', 'owner', true)
    if (gate !== null) return refuse(gate, 'the request was not proposed')
    const state = this.store.state()
    const created = createAcquisitionRequestForGap(input, (gapId) => state.gaps.get(gapId))
    if (!created.ok) return refuse('domain-rule', created.reason, created.code)
    const live = [...state.requests.values()].filter(
      (request) => request.status !== 'rejected' && request.status !== 'expired',
    ).length
    if (live >= ACQUISITION_LIMITS.maxLiveRequests) {
      return refuse(
        'domain-rule',
        `there are already ${live} live requests, which is the bound; apply retention before proposing another`,
        'request-bound-reached',
      )
    }
    await this.persist({ version: 1, kind: 'request', request: created.value })
    this.onChange()
    return {
      ok: true,
      operation: 'requested',
      requestId: created.value.requestId,
      reason: 'the request was proposed, untrusted and inactive, against a detected gap',
      spent: created.value.costSpent,
    }
  }

  /* -------------------------------------------------------------- building */

  /**
   * Charge one build step.
   *
   * The charge and the transition happen together, because either alone misleads: units charged
   * to a request that never entered `building` look like work that happened, and a request in
   * `building` that has charged nothing looks like an unlimited one. Refused **at** the ceiling
   * rather than allowed to overshoot, so a loop that keeps going simply stops.
   */
  async chargeBuildStep(requestId: string, steps = 1): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.propose', 'owner', true)
    if (gate !== null) return refuse(gate, 'no build step was charged')
    const request = this.store.state().requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    if (request.status !== 'proposed' && request.status !== 'building') {
      return refuse(
        'domain-rule',
        `a ${request.status} request is not building, so nothing may be charged to it`,
        'illegal-transition',
      )
    }
    if (!Number.isInteger(steps) || steps < 1 || steps > ACQUISITION_LIMITS.maxSteps) {
      return refuse('domain-rule', 'a build step count must be a positive whole number within the bound', 'invalid-id')
    }
    const units = steps * ACQUISITION_COST_UNITS.perBuildStep
    const budget = this.spendPrecedence(request, units)
    if (budget !== null) {
      return refuse(budget, `the request has ${request.costCeiling - request.costSpent} unit(s) left and this needs ${units}`)
    }
    const charged = chargeAcquisitionCost(request, units)
    if (!charged.ok) return refuse('budget-exhausted', charged.reason, charged.code)
    // The first charge is what moves a request into `building`. Charging is not a transition
    // anyone can perform separately, so there is no "building" with nothing spent behind it.
    const advanced =
      charged.value.status === 'proposed'
        ? advanceAcquisitionRequest(charged.value, { now: this.nowIso(), to: 'building' })
        : { ok: true as const, value: charged.value }
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeRequest(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'built',
      requestId,
      reason: `${steps} build step(s) charged; the request is building and untrusted`,
      spent: advanced.value.costSpent,
    }
  }

  /**
   * Declare the build finished.
   *
   * Refused until every planned step has been charged, so `built` means "the described plan was
   * paid for" rather than "something was produced". Nothing here inspects an artifact: this
   * domain does not hold one, and a build's existence is Foundry's and the verifier's business.
   */
  async markBuilt(requestId: string): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.propose', 'owner', true)
    if (gate !== null) return refuse(gate, 'the build was not marked finished')
    const request = this.store.state().requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    const outstanding = request.steps.length - request.costSpent
    if (request.status === 'building' && outstanding > 0) {
      return refuse(
        'domain-rule',
        `${outstanding} planned step(s) have not been charged; a build cannot be declared before its plan is paid for`,
        'budget-exhausted',
      )
    }
    const advanced = advanceAcquisitionRequest(request, { now: this.nowIso(), to: 'built' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeRequest(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'built',
      requestId,
      reason: 'every planned step was charged; the build is finished and still untrusted and inactive',
      spent: advanced.value.costSpent,
    }
  }

  /**
   * Begin verification: the request moves to `verifying` and a check becomes owed.
   *
   * This verifies nothing. It says "from here, a verdict with a name is owed", and it is
   * deliberately a separate act from recording the result, so a request cannot arrive at
   * `verified` by skipping the state in which verification was supposed to happen.
   */
  async beginVerification(requestId: string): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.verification.record', 'owner', true)
    if (gate !== null) return refuse(gate, 'verification was not begun')
    const request = this.store.state().requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    const advanced = advanceAcquisitionRequest(request, { now: this.nowIso(), to: 'verifying' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeRequest(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'verified',
      requestId,
      reason: 'verification is now owed; no gate has passed and nothing may be activated',
      spent: advanced.value.costSpent,
    }
  }

  /**
   * Record what a named verifier found.
   *
   * The verifier name is mandatory in every sense: a verdict without one is refused rather than
   * stored and defaulted, and at least one evidence reference is required, because "verified"
   * with nothing behind it is an assertion with a gate's clothes on.
   *
   * The three evidence gates are the only ones reachable here. `no-protected-target`,
   * `no-capability-widening` and `budget-within-limit` are computed from the request at decision
   * time, and `owner-approval` is refused from every authority but the owner — so this method,
   * however it is called, cannot produce an approval.
   */
  async recordVerification(input: {
    requestId: string
    kind: EvidenceGateKind
    passed: boolean
    verifier: string
    evidenceRefs: readonly string[]
    notApplicable?: boolean
  }): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.verification.record', 'owner', true)
    if (gate !== null) return refuse(gate, 'no verdict was recorded')
    const state = this.store.state()
    const request = state.requests.get(input.requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    if (request.status !== 'verifying') {
      return refuse(
        'domain-rule',
        `a ${request.status} request is not being verified; begin verification first`,
        'not-verifiable',
      )
    }
    const units = ACQUISITION_COST_UNITS.perVerification
    const budget = this.spendPrecedence(request, units)
    if (budget !== null) {
      return refuse(budget, `the request has ${request.costCeiling - request.costSpent} unit(s) left and a verdict costs ${units}`)
    }
    const charged = chargeAcquisitionCost(request, units)
    if (!charged.ok) return refuse('budget-exhausted', charged.reason, charged.code)
    const notApplicable = input.notApplicable === true
    const verdict = recordGateVerdict(
      {
        kind: input.kind,
        verdict: notApplicable ? 'not-applicable' : input.passed ? 'passed' : 'failed',
        reason: gateReasonFor(input.kind, input.passed, notApplicable),
        verifier: input.verifier,
        evidenceRefs: [...input.evidenceRefs],
      },
      'verifier',
      this.nowIso(),
    )
    if (!verdict.ok) return refuse('domain-rule', verdict.reason, verdict.code)
    await this.writeRequest(charged.value)
    await this.appendGate(request.requestId, verdict.verdict)
    this.onChange()
    return {
      ok: true,
      operation: input.passed ? 'verified' : 'verification-failed',
      requestId: request.requestId,
      reason: `${input.kind} was reported ${verdict.verdict.verdict} by ${verdict.verdict.verifier}`,
      spent: charged.value.costSpent,
    }
  }

  /**
   * Close verification.
   *
   * Passes only when the **newest** `verification-passed` verdict reads `passed`. Newest wins,
   * including newest failing: a request that passed verification and later failed it is refused
   * here, because the failure is the more recent fact about the artifact.
   *
   * A failure is **terminal**, not a step back to `building`. That is the whole anti-retouch
   * rule: a failure is a new request's evidence, and a failed request can never be edited back
   * into a pass. Its gap is closed as `work-changed-so-the-gap-closed` only when the failure is
   * the verifier's word that the need no longer holds; otherwise the gap stays open, because a
   * failed *approach* is not a closed *need*.
   */
  async completeVerification(requestId: string, gapStillOpen = true): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.verification.record', 'owner', false)
    if (gate !== null) return refuse(gate, 'verification was not closed')
    const state = this.store.state()
    const request = state.requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    const ledger = state.gates.get(requestId) ?? []
    const latest = [...ledger].reverse().find((verdict) => verdict.kind === 'verification-passed')
    if (latest === undefined) {
      return refuse(
        'domain-rule',
        'no verification has been recorded, so verification cannot complete',
        'not-verifiable',
      )
    }
    if (latest.verdict !== 'passed') {
      const ended = endAcquisitionRequest(request, { now: this.nowIso(), to: 'rejected', reason: 'verification-failed' })
      if (!ended.ok) return refuse('domain-rule', ended.reason, ended.code)
      await this.writeRequest(ended.value)
      if (!gapStillOpen) await this.closeGapOf(request, 'work-changed-so-the-gap-closed')
      this.onChange()
      return {
        ok: true,
        operation: 'verification-failed',
        requestId,
        reason: 'verification did not pass; this request is terminal and a new one starts untrusted',
        spent: ended.value.costSpent,
      }
    }
    const advanced = advanceAcquisitionRequest(request, { now: this.nowIso(), to: 'verified' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeRequest(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'verified',
      requestId,
      reason: 'verification passed and named; what remains is tests, the red team and the owner',
      spent: advanced.value.costSpent,
    }
  }

  /* ----------------------------------------------------------- activation */

  /**
   * Ask for an activation.
   *
   * Reachable only from `verified`, and only while the request is fresh. A request past its
   * deadline cannot even ask: the evidence behind it is no longer current, and approving stale
   * evidence is how a two-month-old proposal becomes a running capability.
   */
  async requestActivation(requestId: string): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.activation.manage', 'owner', true)
    if (gate !== null) return refuse(gate, 'no activation was requested')
    const request = this.store.state().requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    const advanced = advanceAcquisitionRequest(request, { now: this.nowIso(), to: 'activation-requested' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeRequest(advanced.value)
    await this.recordDecision(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'activation-requested',
      requestId,
      reason: 'the activation was requested; nothing is active until the owner approves it',
      spent: advanced.value.costSpent,
    }
  }

  /**
   * Evaluate the gates and store the decision. **Never activates anything.**
   *
   * Two reasons that is the shape. The owner's approval is a gate rather than the absence of a
   * refusal, so evaluating a ledger before anyone has decided cannot produce an activation. And
   * the stored decision carries `unsatisfied`, so the caller learns *which* gate is owed instead
   * of being told merely "no".
   *
   * A read, so it is not refused while the Governor is refusing building: the owner must be able
   * to see why an activation cannot proceed while builds are paused.
   */
  async evaluateActivation(requestId: string): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.status.read', 'owner', false)
    if (gate !== null) return refuse(gate, 'the gates were not evaluated')
    const state = this.store.state()
    const request = state.requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    const decision = decideActivation(request, state.gates.get(requestId) ?? [], this.nowIso(), null)
    await this.persist({ version: 1, kind: 'decision', decision })
    this.onChange()
    return {
      ok: true,
      operation: 'evaluated',
      requestId,
      reason: decision.approved
        ? 'every gate is satisfied; only the owner decision stands between this and active'
        : `the activation is blocked on [${decision.unsatisfied.join(', ')}]`,
      spent: request.costSpent,
    }
  }

  /* ----------------------------------------------------------- owner acts */

  /**
   * The owner's scope. Issued to the owner principal and to **nothing else**.
   *
   * `null` for any other principal rather than a scope with reduced rights, because a partially
   * privileged owner scope is a thing a caller would keep a reference to and try again with.
   * Holding this object *is* the authority; there is no capability string that acquires it.
   */
  ownerScope(principal: PrincipalId): AcquisitionOwnerScope | null {
    if (principal !== 'owner') return null
    return {
      principalId: 'owner',
      decide: (requestId, approved, reason) => this.ownerDecide(requestId, approved, reason),
      reject: (requestId, reason) => this.ownerEnd(requestId, 'owner-rejected-this-request', reason),
      withdraw: (requestId, reason) => this.ownerEnd(requestId, 'owner-withdrew-this-request', reason),
      revoke: (requestId, reason) => this.ownerEnd(requestId, 'owner-revoked-this-activation', reason),
      closeGap: (gapId, reason) => this.ownerCloseGap(gapId, reason),
    }
  }

  /**
   * The owner's decision on an activation: approve, or decline.
   *
   * The only route to `active`, and it is four refusals long before it gets there:
   *
   * 1. the precedence ladder, including `stop-all-active` — **a stop outranks an owner
   *    approval**, because a latch is not an approval, and "the owner stopped Freya" must beat
   *    "the owner clicked approve twenty minutes ago";
   * 2. the request's own bound, charged as `perActivationAttempt` before anything else, so an
   *    approval is metered work rather than a free action;
   * 3. the gates — an approval arriving while any other gate is unsatisfied is **refused, not
   *    honoured**, so an owner cannot approve around a failed verification even in principle. The
   *    refusal is charged and journalled, because an approval that was tried and stopped is a
   *    fact worth keeping;
   * 4. `activateAcquisitionRequest`, which assigns `active` and an activation deadline derived
   *    from the code-owned retention table — never from the request's own words.
   *
   * A decline is terminal for the same reason a verification failure is: the owner said no to
   * *this* request, and the way to ask again is a new one, which starts untrusted.
   */
  private async ownerDecide(requestId: string, approved: boolean, reason: string): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.activation.manage', 'owner', true)
    if (gate !== null) return refuse(gate, 'no activation was decided')
    if (!isBoundedReason(reason)) {
      return refuse('domain-rule', 'an owner decision must carry a bounded non-empty reason', 'invalid-text')
    }
    const state = this.store.state()
    const request = state.requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    const now = this.nowIso()
    const units = ACQUISITION_COST_UNITS.perActivationAttempt
    const budget = this.spendPrecedence(request, units)
    if (budget !== null) {
      return refuse(budget, `the request has ${request.costCeiling - request.costSpent} unit(s) left and an activation attempt costs ${units}`)
    }
    const charged = chargeAcquisitionCost(request, units)
    if (!charged.ok) return refuse('budget-exhausted', charged.reason, charged.code)

    if (!approved) {
      const declined = recordOwnerApproval(false, now)
      if (!declined.ok) return refuse('domain-rule', declined.reason, declined.code)
      await this.writeRequest(charged.value)
      await this.appendGate(requestId, declined.verdict)
      const ended = endAcquisitionRequest(charged.value, {
        now,
        to: 'rejected',
        reason: 'owner-declined-activation',
      })
      if (!ended.ok) return refuse('domain-rule', ended.reason, ended.code)
      await this.writeRequest(ended.value)
      await this.recordDecision(ended.value)
      this.onChange()
      return {
        ok: true,
        operation: 'declined',
        requestId,
        reason,
        spent: ended.value.costSpent,
      }
    }

    const ledger = state.gates.get(requestId) ?? []
    const outstanding = unsatisfiedGates(charged.value, ledger, now).filter((kind) => kind !== 'owner-approval')
    if (outstanding.length > 0) {
      const chargedWithDecision = charged.value
      await this.writeRequest(chargedWithDecision)
      await this.persist({
        version: 1,
        kind: 'decision',
        decision: decideActivation(chargedWithDecision, ledger, now, 'domain-rule'),
      })
      return refuse(
        'domain-rule',
        `the owner approval cannot stand while [${outstanding.join(', ')}] is unsatisfied: ${reason}`,
        'gate-not-satisfied',
        chargedWithDecision.costSpent,
      )
    }
    const approval = recordOwnerApproval(true, now)
    if (!approval.ok) return refuse('domain-rule', approval.reason, approval.code)
    const activationCount = [...state.requests.values()].filter((entry) => entry.status === 'active').length
    if (activationCount >= ACQUISITION_LIMITS.maxActiveRequests) {
      return refuse(
        'domain-rule',
        `${activationCount} generated capabilities are already active, which is the bound; revoke one before approving another`,
        'activation-bound-reached',
        charged.value.costSpent,
      )
    }
    await this.writeRequest(charged.value)
    await this.appendGate(requestId, approval.verdict)
    const decision = decideActivation(charged.value, [...ledger, approval.verdict], now, null)
    if (!decision.approved) {
      return refuse(
        'domain-rule',
        `the gates still read unsatisfied on [${decision.unsatisfied.join(', ')}]`,
        'gate-not-satisfied',
        charged.value.costSpent,
      )
    }
    await this.persist({ version: 1, kind: 'decision', decision })
    const activated = activateAcquisitionRequest(charged.value, { now })
    if (!activated.ok) return refuse('domain-rule', activated.reason, activated.code)
    await this.writeRequest(activated.value)
    await this.closeGapOf(activated.value, 'capability-acquired-and-activated')
    this.onChange()
    return {
      ok: true,
      operation: 'activated',
      requestId,
      reason: `every gate passed and the owner approved this activation: ${reason}`,
      spent: activated.value.costSpent,
    }
  }

  /**
   * End a request as the owner, with a reason that matches what was done.
   *
   * A revocation lands the activation state on `revoked`, which is the only way an activation
   * ever leaves `active`. There is deliberately no `active → activation-requested` edge, so a
   * revoked activation can never be switched back on: a new request is the only route, and it
   * starts untrusted again.
   */
  private async ownerEnd(
    requestId: string,
    reason: RequestLifecycleReason,
    note: string,
  ): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.activation.manage', 'owner', false)
    if (gate !== null) return refuse(gate, 'nothing was ended')
    if (!isBoundedReason(note)) {
      return refuse('domain-rule', 'an owner decision must carry a bounded non-empty reason', 'invalid-text')
    }
    const request = this.store.state().requests.get(requestId)
    if (request === undefined) {
      return refuse('domain-rule', 'that acquisition request does not exist', 'no-such-request')
    }
    const ended = endAcquisitionRequest(request, { now: this.nowIso(), to: 'rejected', reason })
    if (!ended.ok) return refuse('domain-rule', ended.reason, ended.code)
    await this.writeRequest(ended.value)
    // The gap is deliberately left open. The owner rejected *this proposal*, not the need: a
    // second approach may still answer it, and closing the gap here would make a refusal read
    // as "Freya no longer needs this", which is not what was decided.
    this.onChange()
    return {
      ok: true,
      operation: operationForEnd(reason),
      requestId,
      reason: note,
      spent: ended.value.costSpent,
    }
  }

  private async ownerCloseGap(gapId: string, note: string): Promise<AcquisitionWriteOutcome> {
    const gate = this.precedence('acquisition.propose', 'owner', false)
    if (gate !== null) return refuse(gate, 'the gap was not closed')
    if (!isBoundedReason(note)) {
      return refuse('domain-rule', 'an owner decision must carry a bounded non-empty reason', 'invalid-text')
    }
    const gap = this.store.state().gaps.get(gapId)
    if (gap === undefined) return refuse('domain-rule', 'that capability gap does not exist', 'no-such-gap')
    const closed = closeCapabilityGap(gap, { now: this.nowIso(), reason: 'owner-decided-it-is-not-a-gap' })
    if (!closed.ok) return refuse('domain-rule', closed.reason, closed.code)
    await this.persist({ version: 1, kind: 'gap', gap: closed.value })
    this.onChange()
    return { ok: true, operation: 'rejected', requestId: null, reason: note, spent: 0 }
  }

  /* ------------------------------------------------------------ retention */

  /**
   * Apply every retention bound, and return what it retired.
   *
   * Called explicitly, never on a timer. Nothing in this domain watches a clock, so an expiry is
   * a fact a caller evaluates rather than a thing that happens to Freya while she is doing
   * something else.
   *
   * Three deadlines with three lifecycle reasons, because they are three different facts:
   *
   * - an **activation** past `maxActiveLifetimeMs` expires with `retention-bound-reached` — the
   *   approval aged, even when the proposal is still fresh;
   * - a **request** past `maxRequestLifetimeMs` expires with `stale-request-expired`;
   * - a **gap** past `maxGapLifetimeMs` is retired with `aged-out-past-retention`.
   *
   * The count bounds are enforced differently, and deliberately: an activation inside its own
   * retention is not expired, so `maxActiveRequests` is enforced by **refusing a new activation**
   * (see `ownerDecide`) rather than by revoking a standing one. A live request over
   * `maxLiveRequests` is expired oldest-first, and expiring is a status with a reason rather than
   * a deletion, so the ledger keeps the fact that the build was attempted.
   */
  async applyRetention(now?: string): Promise<readonly string[]> {
    const at = now ?? this.nowIso()
    const retired: string[] = []
    for (const request of this.store.state().requests.values()) {
      if (request.status === 'active') {
        if (isStaleActivation(request, at)) {
          const expired = expireStaleActivation(request, { now: at })
          if (expired.ok) {
            await this.writeRequest(expired.value)
            retired.push(request.requestId)
          }
        }
        continue
      }
      if (request.status === 'rejected' || request.status === 'expired') continue
      if (isStaleAcquisitionRequest(request, at)) {
        const expired = expireStaleAcquisitionRequest(request, { now: at })
        if (expired.ok) {
          await this.writeRequest(expired.value)
          retired.push(request.requestId)
        }
      }
    }
    for (const gap of this.store.state().gaps.values()) {
      if (gap.status !== 'open') continue
      const deadline = Date.parse(gap.expiresAt)
      if (!Number.isFinite(deadline) || Date.parse(at) < deadline) continue
      const aged = closeCapabilityGap(gap, { now: at, reason: 'aged-out-past-retention' })
      if (aged.ok) {
        await this.persist({ version: 1, kind: 'gap', gap: aged.value })
        retired.push(gap.gapId)
      }
    }
    retired.push(...(await this.applyLiveRequestBound(at)))
    if (retired.length > 0) this.onChange()
    return Object.freeze([...new Set(retired)].sort())
  }

  /** `maxLiveRequests`, oldest-created first, so the choice is a function of the record set. */
  private async applyLiveRequestBound(at: string): Promise<readonly string[]> {
    const live = [...this.store.state().requests.values()]
      .filter((request) => request.status !== 'rejected' && request.status !== 'expired')
      .sort((a, b) => {
        const byCreated = a.createdAt.localeCompare(b.createdAt)
        return byCreated !== 0 ? byCreated : a.requestId.localeCompare(b.requestId)
      })
    const surplus = live.slice(0, Math.max(0, live.length - ACQUISITION_LIMITS.maxLiveRequests))
    const retired: string[] = []
    for (const request of surplus) {
      // Only a request already past its own deadline may be expired by the count bound. A fresh
      // one over the count is refused at proposal time instead, so nothing that is still
      // buildable is quietly retired for being crowded out.
      if (!isStaleAcquisitionRequest(request, at)) continue
      const expired = expireStaleAcquisitionRequest(request, { now: at })
      if (!expired.ok) continue
      await this.writeRequest(expired.value)
      retired.push(request.requestId)
    }
    return retired
  }

  /* ---------------------------------------------------------------- reads */

  /** The broad projection. Carries no symptom or intent text, by construction. */
  project(now?: string): AcquisitionProjection {
    return projectAcquisition({
      state: this.store.state(),
      persistence: this.persistence(),
      now: now ?? this.nowIso(),
    })
  }

  /** The derivation itself, for a Core that wants the numbers rather than the view. */
  derive(now?: string): AcquisitionDerivation {
    return deriveAcquisition(this.store.state(), now ?? this.nowIso())
  }

  /** A broad read of the ledger: gaps and requests as metadata. */
  listRequests(options: { limit?: number } = {}): AcquisitionRequestsOutcome {
    return projectAcquisitionRequests(this.store.state(), options)
  }

  /** One request in full, for the owner reviewing an activation. */
  readRequest(requestId: string, now?: string): AcquisitionRequestReadOutcome {
    return projectAcquisitionRequest(this.store.state(), requestId, now ?? this.nowIso())
  }

  /** Whether this engine is currently refusing writes, and the store's own health. */
  persistence(): AcquisitionPersistenceView {
    const health = this.store.health()
    return Object.freeze({
      mode: this.store.mode as AcquisitionPersistenceMode,
      durable: this.store.mode === 'encrypted',
      degraded: health.health === 'degraded',
      reason: health.reason ?? this.store.faultReason,
    })
  }

  /* ------------------------------------------------------------ internals */

  /**
   * The precedence ladder. Returns the first rung that refuses, or `null` to proceed.
   *
   * One function, rungs in the order of `ACQUISITION_PRECEDENCE`, so the ladder can be read top
   * to bottom and checked against the table that documents it. `spend` says whether this
   * operation builds, which is what decides whether the Governor is consulted: a read is not
   * model work and must stay available while building is refused, or an owner could not inspect
   * why an activation is stuck.
   */
  private precedence(
    capability: Capability,
    principal: PrincipalId,
    spend: boolean,
  ): AcquisitionPrecedence | null {
    if (!this.journalTrustworthy()) return 'journal-not-trustworthy'
    if (this.stopAllActive()) return 'stop-all-active'
    if (!this.guard(capability, principal).allowed) return 'guard-denied'
    if (spend && !this.governor().allowed) return 'governor-denied'
    return null
  }

  /** The request's own bound, checked *before* a charge rather than after it. */
  private spendPrecedence(request: AcquisitionRequest, units: number): AcquisitionPrecedence | null {
    if (request.costSpent + units > request.costCeiling) return 'budget-exhausted'
    return null
  }

  private async writeRequest(request: AcquisitionRequest): Promise<void> {
    await this.persist({ version: 1, kind: 'request', request })
  }

  /** Append to a request's ledger. The bound is a refusal, not a truncation. */
  private async appendGate(requestId: string, verdict: GateVerdictRecord): Promise<void> {
    const ledger = this.store.state().gates.get(requestId) ?? []
    if (ledger.length >= ACQUISITION_LIMITS.maxGateVerdicts) {
      throw new AcquisitionStoreError('too-large', 'the gate ledger for this request is full')
    }
    await this.persist({ version: 1, kind: 'ledger', requestId, verdicts: [...ledger, verdict] })
  }

  private async recordDecision(request: AcquisitionRequest): Promise<void> {
    const ledger = this.store.state().gates.get(request.requestId) ?? []
    await this.persist({
      version: 1,
      kind: 'decision',
      decision: decideActivation(request, ledger, this.nowIso(), null),
    })
  }

  private async closeGapOf(request: AcquisitionRequest, reason: GapClosureReason): Promise<void> {
    const gap = this.store.state().gaps.get(request.gapId)
    if (gap === undefined || gap.status !== 'open') return
    const closed = closeCapabilityGap(gap, { now: this.nowIso(), reason })
    if (closed.ok) await this.persist({ version: 1, kind: 'gap', gap: closed.value })
  }

  private async persist(record: AcquisitionRecord): Promise<void> {
    try {
      await this.store.write(unwrapped(record))
    } catch (error) {
      if (error instanceof AcquisitionStoreError) throw error
      throw new AcquisitionStoreError('write-failed', describe(error))
    }
    applyRecord(this.store.state(), record)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

/** Why each evidence gate reports the way it does, named here rather than assembled by a caller. */
function gateReasonFor(kind: EvidenceGateKind, passed: boolean, notApplicable: boolean): GateReason {
  if (notApplicable) return 'marked-not-applicable-by-verifier'
  if (kind === 'verification-passed') return passed ? 'verified-by-a-named-verifier' : 'verification-did-not-pass'
  if (kind === 'tests-passed') return passed ? 'tests-reported-passing' : 'tests-failed'
  return passed ? 'red-team-reported-clean' : 'red-team-found-something'
}

type AcquisitionOperation = Extract<AcquisitionWriteOutcome, { readonly ok: true }>['operation']

function operationForEnd(reason: RequestLifecycleReason): AcquisitionOperation {
  if (reason === 'owner-revoked-this-activation') return 'revoked'
  if (reason === 'owner-withdrew-this-request') return 'withdrawn'
  return 'rejected'
}

function isBoundedReason(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= ACQUISITION_LIMITS.maxReasonChars
}

/** The bare payload a store is handed; the wrapped one the fold wants. */
function unwrapped(record: AcquisitionRecord): AcquisitionWrite {
  if (record.kind === 'gap') return record.gap
  if (record.kind === 'request') return record.request
  if (record.kind === 'ledger') return { requestId: record.requestId, verdicts: record.verdicts }
  return record.decision
}

/**
 * A fresh, empty state, for tests and for nothing else.
 *
 * Exported as a static rather than a module function so the fold's own `emptyAcquisitionState`
 * stays the single producer and a caller cannot end up with two shapes of "nothing yet".
 */
export function emptyAcquisitionLedger(): AcquisitionState {
  return emptyAcquisitionState()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function refuse(
  precedence: AcquisitionPrecedence,
  reason: string,
  code?: string,
  spent = 0,
): AcquisitionWriteOutcome {
  return { ok: false, operation: 'refused', requestId: null, reason, code: code ?? precedence, spent }
}

type LedgerWrite = { readonly requestId: string; readonly verdicts: readonly GateVerdictRecord[] }
type AcquisitionWrite = CapabilityGap | AcquisitionRequest | LedgerWrite | ActivationDecision

/** Re-exported so a caller holding an engine needs one import for the phase's vocabulary. */
export { ACQUISITION_RETENTION }
