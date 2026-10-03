import { deriveImprovement } from './derive'
import { applyRecord, type ImprovementRecord } from './fold'
import {
  advanceImprovement,
  chargeImprovementCost,
  decideMerge,
  expireStaleImprovement,
  expireStaleMerge,
  isMergeStale,
  isStaleProposal,
  recordImprovementGate,
  recordOwnerMergeApproval,
  rollBackImprovement,
  unsatisfiedImprovementGates,
} from './gates'
import { closeImprovementProposal, createImprovementProposal } from './proposal'
import {
  projectImprovement,
  projectImprovementProposal,
  projectImprovementProposals,
} from './projection'
import {
  ImprovementStoreError,
  type ImprovementPersistenceMode,
  type ImprovementStore,
  type ImprovementWrite,
} from './store'
import {
  IMPROVEMENT_COST_UNITS,
  IMPROVEMENT_LIMITS,
  type ImprovementClosedReason,
  type ImprovementDerivation,
  type ImprovementGateKind,
  type ImprovementGateRecord,
  type ImprovementPrecedence,
  type ImprovementProposal,
  type ImprovementStatus,
  type MergeDecision,
} from './types'
import type {
  ImprovementDetailOutcome,
  ImprovementPersistenceView,
  ImprovementProjection,
  ImprovementProposalsOutcome,
  ImprovementWriteOutcome,
} from '../protocol/improvement'
import type { Capability, PrincipalId } from '../protocol/core-protocol'

/**
 * THE IMPROVEMENT ENGINE — every way a change to Freya's own architecture may come to exist, and
 * the only way one may ever land.
 *
 * The pipeline it owns:
 *
 * ```
 *   propose → stageChange → confirmStage → runTests → reviewChange → rehearseRollback
 *     → requestMerge → evaluateMerge → owner approves → merged (for maxMergedLifetimeMs)
 * ```
 *
 * Every arrow is a method here, and there is no other arrow. Nothing in this file runs a test,
 * reads a file, knows what a git branch is, spawns a process or executes a change. It owns a
 * ledger and a conjunction.
 *
 * ## The precedence ladder, checked in this order
 *
 * ```
 *   journal-not-trustworthy → stop-all-active → guard-denied → governor-denied
 *          → budget-exhausted → domain-rule
 * ```
 *
 * Identical in shape to Phase 29's ladder, and for the same three reasons. An untrustworthy
 * journal outranks everything **including a valid owner approval**, because a log with a hole in
 * it may have lost the very stop that would otherwise apply. STOP ALL outranks an approval, because
 * a latch is not a decision. And Guard outranks the domain rules, so an unauthorised caller never
 * learns whether *its particular* proposal would have merged.
 *
 * ## Nothing merges itself
 *
 * `ownerScope(principal)` issues the owner's methods to `'owner'` and returns `null` for every
 * other principal. `StageExecution.appliedBy` is hard-set to `'owner'` with no producer, so a
 * self-merge is not prevented here — it is *unrepresentable*. And an approval arriving while any
 * other gate is unsatisfied is **refused, not honoured**, so the owner cannot approve around a
 * failed test run, an unreviewed change or an unproven rollback even in principle.
 *
 * ## Rollback is a mechanism, not a promise
 *
 * `rehearseRollback` proves the undo works *while the change is still staged*, and
 * `rollback-verified` gates the merge on it. `rollBack` restores the revision recorded at staging
 * time and is reachable all the way through `merged`, because `merged → rolled-back` is the only
 * edge out of `merged`.
 *
 * ## No hidden loops
 *
 * No scheduler, no timer, no retry, no background flag. Cost is charged in code-owned units that
 * mean nothing to any provider, refused **at** the ceiling rather than allowed to overshoot, and a
 * terminal proposal cannot be charged at all. Expiry is a fact a caller evaluates
 * (`applyRetention(now)`).
 */

export interface ImprovementGuardVerdict {
  readonly allowed: boolean
  readonly reason: string
}

/**
 * Everything the engine folds, and everything it must ask about.
 *
 * All four questions are injected and all four are re-read at each decision, because a decision
 * taken against a cached latch is a decision taken against a stop that has since been cleared.
 */
export interface ImprovementEngineOptions {
  readonly store: ImprovementStore
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
  readonly guard?: (capability: Capability, principal: PrincipalId) => ImprovementGuardVerdict
  /**
   * The Cognition Governor, as one question: may unattended work happen at all?
   *
   * Staging, testing and review are model work and they spend, which is exactly the class of
   * thing the Governor exists to refuse. The engine holds no opinion about allowances.
   */
  readonly governor?: () => ImprovementGuardVerdict
  readonly onChange?: () => void
}

/** The owner's acts. Issued to the owner principal and to nothing else. */
export interface ImprovementOwnerScope {
  readonly principalId: 'owner'
  /** Approve or decline this merge. The only route to `merged`. */
  decideMerge(proposalId: string, approved: boolean, reason: string): Promise<ImprovementWriteOutcome>
  /** Reject a proposal at any live stage. */
  reject(proposalId: string, reason: string): Promise<ImprovementWriteOutcome>
  /** Withdraw a proposal at any stage before it merges. */
  withdraw(proposalId: string, reason: string): Promise<ImprovementWriteOutcome>
  /** Roll back a staged or merged change. The rollback mechanism itself. */
  rollback(proposalId: string, reason: string): Promise<ImprovementWriteOutcome>
}

export class ImprovementEngine {
  private readonly store: ImprovementStore
  private readonly now: () => Date
  private readonly journalTrustworthy: () => boolean
  private readonly stopAllActive: () => boolean
  private readonly guard: (capability: Capability, principal: PrincipalId) => ImprovementGuardVerdict
  private readonly governor: () => ImprovementGuardVerdict
  private readonly onChange: () => void

  constructor(options: ImprovementEngineOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.journalTrustworthy = options.journalTrustworthy ?? (() => true)
    this.stopAllActive = options.stopAllActive ?? (() => false)
    // Deny by default, both of them. An engine wired without a Guard or a Governor may read,
    // propose nothing and change nothing, which is the correct reading of a missing security
    // module — a default of "allow" here would be the one line in this phase that undoes it.
    this.guard =
      options.guard ?? (() => ({ allowed: false, reason: 'no guard is wired, so nothing is permitted' }))
    this.governor =
      options.governor ?? (() => ({ allowed: false, reason: 'no governor is wired, so nothing may build' }))
    this.onChange = options.onChange ?? (() => {})
  }

  /* -------------------------------------------------------------- proposals */

  /**
   * Record a proposed change to Freya's own architecture.
   *
   * A proposal is a **claim about a cost**: a bounded slug for the change, a symptom, and at least
   * one piece of evidence it was observed from. It carries no authority and no permission, and its
   * confidence is capped at `medium` for every source including the owner — a proposal generalises
   * beyond the observation behind it, so being sure of it is not a reason for it to read as more
   * certain than the evidence.
   *
   * It comes out **unstaged**: `status` is a constant assigned inside the constructor rather than a
   * parameter, so there is no call shape that produces a proposal arriving `staged` or `merged`.
   */
  async propose(input: unknown): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.propose', 'owner', true)
    if (gate !== null) return refuse(gate, 'the proposal was not recorded')
    const created = createImprovementProposal(input)
    if (!created.ok) return refuse('domain-rule', created.reason, created.code)
    const live = this.liveProposals().length
    if (live >= IMPROVEMENT_LIMITS.maxOpenProposals) {
      return refuse(
        'domain-rule',
        `there are already ${live} open proposals, which is the bound; apply retention before proposing another`,
        'proposal-bound-reached',
      )
    }
    await this.persist({ version: 1, kind: 'proposal', proposal: created.value })
    this.onChange()
    return {
      ok: true,
      operation: 'proposed',
      proposalId: created.value.proposalId,
      reason: 'the proposal was recorded as a claim about a cost, with the evidence it rests on',
      spent: 0,
    }
  }

  /* --------------------------------------------------------------- staging */

  /**
   * Stage the change.
   *
   * The revision the change would restore is recorded **here** and nowhere else. A rollback that
   * invented its own target revision at rollback time — "restore whatever was there" — is exactly
   * the rollback that cannot be relied on under pressure, so the target is fixed before the change
   * exists.
   *
   * The charge and the transition happen together, because either alone misleads: units charged to
   * a proposal that never staged look like work that happened, and a proposal in `staged` that
   * charged nothing looks like an unlimited one.
   */
  async stageChange(proposalId: string, restoresRevision: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.stage', 'owner', true)
    if (gate !== null) return refuse(gate, 'nothing was staged')
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const advancing = advanceImprovement(proposal, { now: this.nowIso(), to: 'staging' })
    if (!advancing.ok) return refuse('domain-rule', advancing.reason, advancing.code)
    const charged = chargeImprovementCost(advancing.value, IMPROVEMENT_COST_UNITS.perStage)
    if (!charged.ok) return refuse('budget-exhausted', charged.reason, charged.code)
    const staged = advanceImprovement(charged.value, {
      now: this.nowIso(),
      to: 'staged',
      restoresRevision,
    })
    if (!staged.ok) return refuse('domain-rule', staged.reason, staged.code)
    await this.writeProposal(staged.value)
    this.onChange()
    return {
      ok: true,
      operation: 'staged',
      proposalId,
      reason: `the change is staged and would restore ${staged.value.restoresRevision}`,
      spent: staged.value.costSpent,
    }
  }

  /* --------------------------------------------------------------- testing */

  /**
   * Begin testing: the proposal moves to `testing` and a result becomes owed.
   *
   * This runs nothing. It says "from here, a verdict with a name is owed", and it is deliberately
   * a separate act from recording the result, so a proposal cannot arrive at `tested` by skipping
   * the state in which testing was supposed to happen.
   */
  async runTests(proposalId: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.verify', 'owner', true)
    if (gate !== null) return refuse(gate, 'testing was not begun')
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const advanced = advanceImprovement(proposal, { now: this.nowIso(), to: 'testing' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeProposal(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'tests-run',
      proposalId,
      reason: 'testing is now owed; no gate has passed and nothing may merge',
      spent: advanced.value.costSpent,
    }
  }

  /**
   * Record what a named check found.
   *
   * Five ledger gates are reachable here — `staged-verified`, `tests-passed`, `red-team-clean`,
   * `review-recorded` and `rollback-verified` — and every one requires a named verifier and at
   * least one evidence reference. The two derived gates are computed from the proposal, and
   * `owner-merge-approved` is refused from every authority but the owner: this method, however it
   * is called, cannot produce a merge approval.
   */
  async recordCheck(input: {
    proposalId: string
    kind: Exclude<ImprovementGateKind, 'owner-merge-approved' | 'no-protected-surface' | 'no-authority-widening'>
    passed: boolean
    verifier: string
    evidenceRefs: readonly string[]
    notApplicable?: boolean
  }): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.verify', 'owner', true)
    if (gate !== null) return refuse(gate, 'no verdict was recorded')
    const proposal = this.store.state().proposals.get(input.proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    // Which status owes which check. Written as data rather than as scattered conditions, so the
    // gap between "may be recorded" and "may be owed" can never be wider than this one table — and
    // so `review-recorded` is owed while `reviewing`, not after the review has already closed.
    const owed: Record<string, readonly ImprovementStatus[]> = {
      'staged-verified': ['staged', 'testing'],
      'tests-passed': ['testing'],
      'red-team-clean': ['testing', 'tested'],
      'review-recorded': ['reviewing'],
      'rollback-verified': ['reviewed', 'merging'],
    }
    const allowed = owed[input.kind] ?? []
    if (!allowed.includes(proposal.status)) {
      return refuse(
        'domain-rule',
        `the ${input.kind} gate is owed while the proposal is [${allowed.join('|')}], and this one is ${proposal.status}`,
        'illegal-transition',
      )
    }
    const units =
      input.kind === 'review-recorded'
        ? IMPROVEMENT_COST_UNITS.perReview
        : input.kind === 'rollback-verified'
          ? IMPROVEMENT_COST_UNITS.perRollbackRehearsal
          : input.kind === 'red-team-clean'
            ? IMPROVEMENT_COST_UNITS.perRedTeamSweep
            : IMPROVEMENT_COST_UNITS.perTestRun
    const budget = this.spendPrecedence(proposal, units)
    if (budget !== null) {
      return refuse(budget, `the proposal has ${proposal.costCeiling - proposal.costSpent} unit(s) left and this check costs ${units}`)
    }
    const charged = chargeImprovementCost(proposal, units)
    if (!charged.ok) return refuse('budget-exhausted', charged.reason, charged.code)
    const notApplicable = input.notApplicable === true
    const recorded = recordImprovementGate(
      {
        kind: input.kind,
        verdict: notApplicable ? 'not-applicable' : input.passed ? 'passed' : 'failed',
        reason: checkReasonFor(input.kind, input.passed, notApplicable),
        verifier: input.verifier,
        evidenceRefs: [...input.evidenceRefs],
      },
      'verifier',
      this.nowIso(),
    )
    if (!recorded.ok) return refuse('domain-rule', recorded.reason, recorded.code)
    await this.writeProposal(charged.value)
    await this.appendGate(input.proposalId, recorded.record)
    this.onChange()
    return {
      ok: true,
      operation: operationForCheck(input.kind, input.passed),
      proposalId: input.proposalId,
      reason: `${input.kind} was reported ${recorded.record.verdict} by ${recorded.record.verifier}`,
      spent: charged.value.costSpent,
    }
  }

  /**
   * Close testing, moving to `tested`.
   *
   * Refused while the newest `tests-passed` record does not read `passed`. Newest wins, including
   * newest failing: a change that passed tests and later failed them is not a change whose tests
   * passed.
   *
   * A failure ends the proposal with `tests-failed`. It does **not** step back to `staged`. A
   * failure is a *new proposal's* evidence, and a failed proposal can never be edited back into a
   * pass.
   */
  async completeTests(proposalId: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.verify', 'owner', false)
    if (gate !== null) return refuse(gate, 'testing was not closed')
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const newest = this.newestOf(proposalId, 'tests-passed')
    if (newest === null) {
      return refuse('domain-rule', 'no test result has been recorded, so testing cannot complete', 'not-verifiable')
    }
    if (newest.verdict !== 'passed') {
      const rejected = closeImprovementProposal(proposal, {
        now: this.nowIso(),
        to: 'rejected',
        reason: 'tests-failed',
      })
      if (!rejected.ok) return refuse('domain-rule', rejected.reason, rejected.code)
      await this.writeProposal(rejected.value)
      this.onChange()
      return {
        ok: true,
        operation: 'tests-failed',
        proposalId,
        reason: 'the tests did not pass; this proposal is terminal and a new one starts unstaged',
        spent: rejected.value.costSpent,
      }
    }
    const advanced = advanceImprovement(proposal, { now: this.nowIso(), to: 'tested' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeProposal(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'tests-run',
      proposalId,
      reason: 'the tests passed and named; what remains is the red team, review, the rollback rehearsal and the owner',
      spent: advanced.value.costSpent,
    }
  }

  /* --------------------------------------------------------------- review */

  /** Begin review. A separate act, because review and testing are done by different parties. */
  async beginReview(proposalId: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.verify', 'owner', true)
    if (gate !== null) return refuse(gate, 'review was not begun')
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const advanced = advanceImprovement(proposal, { now: this.nowIso(), to: 'reviewing' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeProposal(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'reviewed',
      proposalId,
      reason: 'review is now owed by a named reviewer; the proposal may not merge before it reports',
      spent: advanced.value.costSpent,
    }
  }

  /** Close review, moving to `reviewed`. A recorded rejection ends the proposal. */
  async completeReview(proposalId: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.verify', 'owner', false)
    if (gate !== null) return refuse(gate, 'review was not closed')
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const newest = this.newestOf(proposalId, 'review-recorded')
    if (newest === null) {
      return refuse('domain-rule', 'no review has been recorded, so review cannot complete', 'not-verifiable')
    }
    if (newest.verdict !== 'passed') {
      const rejected = closeImprovementProposal(proposal, {
        now: this.nowIso(),
        to: 'rejected',
        reason: 'review-rejected-the-change',
      })
      if (!rejected.ok) return refuse('domain-rule', rejected.reason, rejected.code)
      await this.writeProposal(rejected.value)
      this.onChange()
      return {
        ok: true,
        operation: 'rejected',
        proposalId,
        reason: 'the reviewer rejected the change; this proposal is terminal',
        spent: rejected.value.costSpent,
      }
    }
    const advanced = advanceImprovement(proposal, { now: this.nowIso(), to: 'reviewed' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeProposal(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'reviewed',
      proposalId,
      reason: 'a named reviewer recorded the change as acceptable',
      spent: advanced.value.costSpent,
    }
  }

  /**
   * Rehearse the rollback.
   *
   * The gate that is this phase's own idea: a change that has never been rolled back on demand
   * cannot be merged, however many tests it passed. The rehearsal happens while the change is still
   * staged, and it is charged — because a rollback discovered to be impossible *during* an incident
   * is not a rollback, it is a post-mortem.
   */
  async rehearseRollback(proposalId: string, passed: boolean, verifier: string): Promise<ImprovementWriteOutcome> {
    return this.recordCheck({
      proposalId,
      kind: 'rollback-verified',
      passed,
      verifier,
      evidenceRefs: [`rehearsal:${proposalId}`],
    })
  }

  /* ------------------------------------------------------------ merge */

  /** Ask for a merge. Reachable only from `reviewed`, and only while the proposal is fresh. */
  async requestMerge(proposalId: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.merge.approve', 'owner', true)
    if (gate !== null) return refuse(gate, 'no merge was requested')
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const advanced = advanceImprovement(proposal, { now: this.nowIso(), to: 'merging' })
    if (!advanced.ok) return refuse('domain-rule', advanced.reason, advanced.code)
    await this.writeProposal(advanced.value)
    await this.recordDecision(advanced.value)
    this.onChange()
    return {
      ok: true,
      operation: 'merge-requested',
      proposalId,
      reason: 'the merge was requested; nothing lands until the owner approves it',
      spent: advanced.value.costSpent,
    }
  }

  /**
   * Evaluate the gates and store the decision. **Never merges anything.**
   *
   * The owner's approval is a gate rather than the absence of a refusal, so evaluating a ledger
   * before anyone has decided cannot produce a merge. And the stored decision carries
   * `unsatisfied`, so the caller learns *which* gate is owed rather than being told merely "no".
   *
   * A read, so it is not refused while the Governor is refusing work: the owner must be able to see
   * why a merge cannot proceed while everything else is paused.
   */
  async evaluateMerge(proposalId: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.status.read', 'owner', false)
    if (gate !== null) return refuse(gate, 'the gates were not evaluated')
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const decision = decideMerge(proposal, this.store.state().gates.get(proposalId) ?? [], this.nowIso(), null)
    await this.persist({ version: 1, kind: 'decision', decision })
    this.onChange()
    return {
      ok: true,
      operation: 'evaluated',
      proposalId,
      reason: decision.approved
        ? 'every gate is satisfied; only the owner decision stands between this and merged'
        : `the merge is blocked on [${decision.unsatisfied.join(', ')}]`,
      spent: proposal.costSpent,
    }
  }

  /* ---------------------------------------------------------- owner acts */

  /**
   * The owner's scope. Issued to the owner principal and to **nothing else**.
   *
   * `null` for any other principal rather than a scope with reduced rights, because a partially
   * privileged owner scope is a thing a caller would keep a reference to and try again with.
   * Holding this object *is* the authority; there is no capability string that acquires it.
   */
  ownerScope(principal: PrincipalId): ImprovementOwnerScope | null {
    if (principal !== 'owner') return null
    return {
      principalId: 'owner',
      decideMerge: (proposalId, approved, reason) => this.ownerDecideMerge(proposalId, approved, reason),
      reject: (proposalId, reason) => this.ownerEnd(proposalId, 'rejected', reason),
      withdraw: (proposalId, reason) => this.ownerEnd(proposalId, 'withdrawn', reason),
      rollback: (proposalId, reason) => this.ownerRollback(proposalId, reason),
    }
  }

  /**
   * The owner's decision on a merge: approve, or decline.
   *
   * The only route to `merged`, and it is four refusals long before it gets there:
   *
   * 1. the precedence ladder, including `stop-all-active` — **a stop outranks an owner
   *    approval**, because a latch is not an approval;
   * 2. the proposal's own bound, charged as `perMergeAttempt` before anything else, so a merge is
   *    metered work rather than a free action;
   * 3. the gates — an approval arriving while any other gate is unsatisfied is **refused, not
   *    honoured**. The owner cannot merge around a failed test run, an unreviewed change or an
   *    unproven rollback. The attempt is charged and recorded, because a merge that was tried and
   *    stopped is a fact worth keeping;
   * 4. `advanceImprovement`, which assigns `merged` and a merge deadline derived from the
   *    code-owned retention table — never from the proposal's own words.
   *
   * A decline is terminal for the same reason a failed test is: the owner said no to *this*
   * change, and the way to propose it again is a new proposal, which starts unstaged.
   */
  private async ownerDecideMerge(
    proposalId: string,
    approved: boolean,
    reason: string,
  ): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.merge.approve', 'owner', true)
    if (gate !== null) return refuse(gate, 'no merge was decided')
    if (!isBoundedReason(reason)) {
      return refuse('domain-rule', 'an owner decision must carry a bounded non-empty reason', 'invalid-text')
    }
    const state = this.store.state()
    const proposal = state.proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const now = this.nowIso()
    const units = IMPROVEMENT_COST_UNITS.perMergeAttempt
    const budget = this.spendPrecedence(proposal, units)
    if (budget !== null) {
      return refuse(budget, `the proposal has ${proposal.costCeiling - proposal.costSpent} unit(s) left and a merge attempt costs ${units}`)
    }
    const charged = chargeImprovementCost(proposal, units)
    if (!charged.ok) return refuse('budget-exhausted', charged.reason, charged.code)

    if (!approved) {
      const declined = recordOwnerMergeApproval(false, now)
      if (!declined.ok) return refuse('domain-rule', declined.reason, declined.code)
      await this.writeProposal(charged.value)
      await this.appendGate(proposalId, declined.record)
      const ended = closeImprovementProposal(charged.value, {
        now,
        to: 'rejected',
        reason: 'owner-rejected-this-proposal',
      })
      if (!ended.ok) return refuse('domain-rule', ended.reason, ended.code)
      await this.writeProposal(ended.value)
      await this.recordDecision(ended.value)
      this.onChange()
      return { ok: true, operation: 'declined', proposalId, reason, spent: ended.value.costSpent }
    }

    const ledger = state.gates.get(proposalId) ?? []
    const outstanding = unsatisfiedImprovementGates(charged.value, ledger, now).filter(
      (kind) => kind !== 'owner-merge-approved',
    )
    if (outstanding.length > 0) {
      await this.writeProposal(charged.value)
      await this.persist({
        version: 1,
        kind: 'decision',
        decision: decideMerge(charged.value, ledger, now, 'domain-rule'),
      })
      return refuse(
        'domain-rule',
        `the owner approval cannot stand while [${outstanding.join(', ')}] is unsatisfied: ${reason}`,
        'gate-not-satisfied',
        charged.value.costSpent,
      )
    }
    const approval = recordOwnerMergeApproval(true, now)
    if (!approval.ok) return refuse('domain-rule', approval.reason, approval.code)
    const activeMerges = this.mergedCount()
    if (activeMerges >= IMPROVEMENT_LIMITS.maxActiveMerges) {
      return refuse(
        'domain-rule',
        `${activeMerges} changes are already standing, which is the bound; roll one back before merging another`,
        'merge-bound-reached',
        charged.value.costSpent,
      )
    }
    await this.writeProposal(charged.value)
    await this.appendGate(proposalId, approval.record)
    const decision = decideMerge(charged.value, [...ledger, approval.record], now, null)
    if (!decision.approved) {
      return refuse(
        'domain-rule',
        `the gates still read unsatisfied on [${decision.unsatisfied.join(', ')}]`,
        'gate-not-satisfied',
        charged.value.costSpent,
      )
    }
    await this.persist({ version: 1, kind: 'decision', decision })
    const merged = advanceImprovement(charged.value, { now, to: 'merged' })
    if (!merged.ok) return refuse('domain-rule', merged.reason, merged.code)
    await this.writeProposal(merged.value)
    this.onChange()
    return {
      ok: true,
      operation: 'merged',
      proposalId,
      reason: `every gate passed and the owner approved this merge: ${reason}`,
      spent: merged.value.costSpent,
    }
  }

  /**
   * Reject or withdraw, with a reason that matches what was done.
   *
   * A proposal rejected before it merges has changed nothing, so there is nothing to roll back; the
   * two are separate acts for that reason and a caller cannot reach `merged → rolled-back` through
   * this method by accident.
   */
  private async ownerEnd(
    proposalId: string,
    kind: 'rejected' | 'withdrawn',
    reason: string,
  ): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.merge.approve', 'owner', false)
    if (gate !== null) return refuse(gate, 'nothing was ended')
    if (!isBoundedReason(reason)) {
      return refuse('domain-rule', 'an owner decision must carry a bounded non-empty reason', 'invalid-text')
    }
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const ended = closeImprovementProposal(proposal, {
      now: this.nowIso(),
      to: 'rejected',
      reason: kind === 'withdrawn' ? 'owner-withdrew-this-proposal' : 'owner-rejected-this-proposal',
    })
    if (!ended.ok) return refuse('domain-rule', ended.reason, ended.code)
    await this.writeProposal(ended.value)
    this.onChange()
    return {
      ok: true,
      operation: kind,
      proposalId,
      reason,
      spent: ended.value.costSpent,
    }
  }

  /**
   * Roll a change back.
   *
   * Reachable from `staging` all the way through `merged`, and refused when no revision was
   * recorded at staging — because a rollback with no recorded target restores nothing, and the
   * answer to "there is nothing recorded to restore" is a refusal rather than a best guess.
   *
   * Available to the owner scope only. A rollback is a change to Freya's own architecture, which is
   * exactly as privileged as merging one, and it is not reachable through `recordCheck` by anything
   * pretending to be a verifier.
   */
  private async ownerRollback(proposalId: string, reason: string): Promise<ImprovementWriteOutcome> {
    const gate = this.precedence('improvement.rollback', 'owner', false)
    if (gate !== null) return refuse(gate, 'nothing was rolled back')
    if (!isBoundedReason(reason)) {
      return refuse('domain-rule', 'a rollback must carry a bounded non-empty reason', 'invalid-text')
    }
    const proposal = this.store.state().proposals.get(proposalId)
    if (proposal === undefined) {
      return refuse('domain-rule', 'that improvement proposal does not exist', 'no-such-proposal')
    }
    const rolled = rollBackImprovement(proposal, { now: this.nowIso() })
    if (!rolled.ok) return refuse(rolled.code === 'nothing-to-roll-back' ? 'domain-rule' : 'domain-rule', rolled.reason, rolled.code)
    await this.writeProposal(rolled.value)
    this.onChange()
    return {
      ok: true,
      operation: 'rolled-back',
      proposalId,
      reason,
      spent: rolled.value.costSpent,
    }
  }

  /* ------------------------------------------------------------ retention */

  /**
   * Apply every retention bound, and return what it retired.
   *
   * Called explicitly, never on a timer. Nothing in this domain watches a clock, so an expiry is a
   * fact a caller evaluates rather than a thing that happens to Freya while she is doing something
   * else.
   *
   * Two deadlines with two different meanings, and the distinction is the phase:
   *
   * - a **proposal** past `maxProposalLifetimeMs` is expired — nobody ever decided it;
   * - a **merge** past `maxMergedLifetimeMs` is expired too, but the thing that expired is the
   *   *approval to keep this change standing*. The change may be perfectly good and simply needs a
   *   second, dated decision, so the proposal becomes terminal rather than silently continuing.
   *
   * The count bounds are enforced differently, and deliberately: a merge inside its own retention
   * is not expired, so `maxActiveMerges` is enforced by **refusing a new merge** rather than by
   * rolling back a standing one.
   */
  async applyRetention(now?: string): Promise<readonly string[]> {
    const at = now ?? this.nowIso()
    const retired: string[] = []
    for (const proposal of this.store.state().proposals.values()) {
      if (proposal.status === 'merged') {
        if (isMergeStale(proposal, at)) {
          const expired = expireStaleMerge(proposal, { now: at })
          if (expired.ok) {
            await this.writeProposal(expired.value)
            retired.push(proposal.proposalId)
          }
        }
        continue
      }
      if (proposal.status === 'rejected' || proposal.status === 'expired' || proposal.status === 'rolled-back') {
        continue
      }
      if (isStaleProposal(proposal, at)) {
        const expired = expireStaleImprovement(proposal, { now: at })
        if (expired.ok) {
          await this.writeProposal(expired.value)
          retired.push(proposal.proposalId)
        }
      }
    }
    if (retired.length > 0) this.onChange()
    return Object.freeze([...new Set(retired)].sort())
  }

  /* ---------------------------------------------------------------- reads */

  /** The broad projection. Carries no symptom, change or rollback text, by construction. */
  project(now?: string): ImprovementProjection {
    return projectImprovement({
      state: this.store.state(),
      persistence: this.persistence(),
      now: now ?? this.nowIso(),
    })
  }

  /** The derivation itself, for a Core that wants the numbers rather than the view. */
  derive(now?: string): ImprovementDerivation {
    return deriveImprovement(this.store.state(), now ?? this.nowIso())
  }

  /** A broad read of the ledger: proposals as metadata. */
  listProposals(options: { limit?: number } = {}): ImprovementProposalsOutcome {
    return projectImprovementProposals(this.store.state(), options)
  }

  /** One proposal in full, for the owner reviewing a merge. */
  readProposal(proposalId: string, now?: string): ImprovementDetailOutcome {
    return projectImprovementProposal(this.store.state(), proposalId, now ?? this.nowIso())
  }

  /** Whether this engine is currently refusing writes, and the store's own health. */
  persistence(): ImprovementPersistenceView {
    const health = this.store.health()
    return Object.freeze({
      mode: this.store.mode as ImprovementPersistenceMode,
      durable: this.store.mode === 'encrypted',
      degraded: health.health === 'degraded',
      reason: health.reason ?? this.store.faultReason,
    })
  }

  /* ------------------------------------------------------------ internals */

  /**
   * The precedence ladder. Returns the first rung that refuses, or `null` to proceed.
   *
   * One function, rungs in the order of `IMPROVEMENT_PRECEDENCE`, so the ladder can be read top to
   * bottom and checked against the table that documents it. `spend` says whether this operation
   * does model work, which is what decides whether the Governor is consulted: a read is not model
   * work and must stay available while everything else is paused, or an owner could not inspect why
   * a merge is stuck.
   */
  private precedence(
    capability: Capability,
    principal: PrincipalId,
    spend: boolean,
  ): ImprovementPrecedence | null {
    if (!this.journalTrustworthy()) return 'journal-not-trustworthy'
    if (this.stopAllActive()) return 'stop-all-active'
    if (!this.guard(capability, principal).allowed) return 'guard-denied'
    if (spend && !this.governor().allowed) return 'governor-denied'
    return null
  }

  /** The proposal's own bound, checked *before* a charge rather than after it. */
  private spendPrecedence(
    proposal: ImprovementProposal,
    units: number,
  ): ImprovementPrecedence | null {
    if (proposal.costSpent + units > proposal.costCeiling) return 'budget-exhausted'
    return null
  }

  private liveProposals(): readonly ImprovementProposal[] {
    return [...this.store.state().proposals.values()].filter(
      (proposal) =>
        proposal.status !== 'rejected' && proposal.status !== 'expired' && proposal.status !== 'rolled-back',
    )
  }

  private mergedCount(): number {
    return [...this.store.state().proposals.values()].filter((proposal) => proposal.status === 'merged')
      .length
  }

  /** The newest record for one ledger gate kind, or null when nothing has been recorded. */
  private newestOf(
    proposalId: string,
    kind: Exclude<ImprovementGateKind, 'owner-merge-approved' | 'no-protected-surface' | 'no-authority-widening'>,
  ): ImprovementGateRecord | null {
    const ledger = this.store.state().gates.get(proposalId) ?? []
    for (let index = ledger.length - 1; index >= 0; index -= 1) {
      const record = ledger[index]
      if (record !== undefined && record.kind === kind) return record
    }
    return null
  }

  private async writeProposal(proposal: ImprovementProposal): Promise<void> {
    await this.persist({ version: 1, kind: 'proposal', proposal })
  }

  /** Append to a proposal's ledger. The bound is a refusal, not a truncation. */
  private async appendGate(proposalId: string, record: ImprovementGateRecord): Promise<void> {
    const ledger = this.store.state().gates.get(proposalId) ?? []
    if (ledger.length >= IMPROVEMENT_LIMITS.maxGateVerdicts) {
      throw new ImprovementStoreError('too-large', 'the gate ledger for this proposal is full')
    }
    await this.persist({ version: 1, kind: 'ledger', proposalId, verdicts: [...ledger, record] })
  }

  private async recordDecision(proposal: ImprovementProposal): Promise<void> {
    const ledger = this.store.state().gates.get(proposal.proposalId) ?? []
    await this.persist({
      version: 1,
      kind: 'decision',
      decision: decideMerge(proposal, ledger, this.nowIso(), null),
    })
  }

  private async persist(record: ImprovementRecord): Promise<void> {
    try {
      await this.store.write(unwrapped(record))
    } catch (error) {
      if (error instanceof ImprovementStoreError) throw error
      throw new ImprovementStoreError('write-failed', describe(error))
    }
    applyRecord(this.store.state(), record)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

/** Why each check gate reports the way it does, named here rather than assembled by a caller. */
function checkReasonFor(
  kind: string,
  passed: boolean,
  notApplicable: boolean,
): import('./types').ImprovementGateReason {
  if (notApplicable) return 'marked-not-applicable-by-verifier'
  if (kind === 'staged-verified') {
    return passed ? 'stage-was-confirmed-by-a-named-check' : 'stage-was-not-confirmed'
  }
  if (kind === 'tests-passed') return passed ? 'tests-reported-passing' : 'tests-failed'
  if (kind === 'red-team-clean') return passed ? 'red-team-reported-clean' : 'red-team-found-something'
  if (kind === 'review-recorded') {
    return passed ? 'review-recorded-by-a-named-reviewer' : 'review-found-a-problem'
  }
  return passed ? 'rollback-rehearsed-successfully' : 'rollback-rehearsal-failed'
}

function operationForCheck(
  kind: string,
  passed: boolean,
):
  | 'stage-confirmed'
  | 'tests-run'
  | 'tests-failed'
  | 'red-team-run'
  | 'reviewed'
  | 'rejected'
  | 'rehearsed'
  | 'rehearsal-failed' {
  if (kind === 'staged-verified') return passed ? 'stage-confirmed' : 'tests-failed'
  if (kind === 'tests-passed') return passed ? 'tests-run' : 'tests-failed'
  if (kind === 'red-team-clean') return passed ? 'red-team-run' : 'tests-failed'
  if (kind === 'review-recorded') return passed ? 'reviewed' : 'rejected'
  return passed ? 'rehearsed' : 'rehearsal-failed'
}

function isBoundedReason(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= IMPROVEMENT_LIMITS.maxReasonChars
}

/** The bare payload a store is handed; the wrapped one the fold wants. */
function unwrapped(record: ImprovementRecord): ImprovementWrite {
  if (record.kind === 'proposal') return record.proposal
  if (record.kind === 'ledger') return { proposalId: record.proposalId, verdicts: record.verdicts }
  return record.decision
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function refuse(
  precedence: ImprovementPrecedence,
  reason: string,
  code?: string,
  spent = 0,
): ImprovementWriteOutcome {
  return { ok: false, operation: 'refused', proposalId: null, reason, code: code ?? precedence, spent }
}

export type { ImprovementClosedReason, MergeDecision }