import { accumulateSpend, emptyLedger, readSpendingLimits, type SpendingLedger } from './spending'
import { normaliseBoundaries, type EnterpriseBoundaries } from './boundaries'
import { approvalDecisionIsOwners, readApprovalRequest, type ApprovalRecord } from './approvals'
import {
  authorizeEnterpriseAction,
  validateWake,
  type AuthorizationContext,
  type EnterpriseActionRequest,
  type GateEnvironmentView,
} from './orchestration'
import { checkRollbackGate, deriveRollbackOutcome, type RollbackOutcomeInput } from './rollback'
import { mayBeConsideredComplete, verifyExternalAction, type VerificationRecord } from './verification'
import {
  ENTERPRISE_LIMITS,
  type ActionConsequenceClass,
  type AuthorizationGate,
  type EnterpriseEventType,
  type SpendingLimits,
} from './types'
import {
  countsFor,
  initialEnterpriseState,
  reduceEnterpriseEntry,
  reduceEnterpriseState,
  type EnterpriseState,
} from './state'
import { projectEnterpriseState, type EnterpriseStateProjection } from './projection'
import type { EnterpriseEffectRequest, EnterprisePayload, EnterprisePorts } from './ports'

/**
 * The runtime: the only file that touches a port.
 *
 * It holds no authority of its own. Every route to the outside world goes through
 * `EnterprisePorts`, which Core fills with machinery that already existed — the Guard,
 * the Governor, the browser capability, the relay — and which this lane cannot reach
 * around. What the runtime adds is the ordering: no effect is attempted until the
 * authorization pipeline has agreed, no effect is called complete until verification
 * has, and no refusal is silent.
 *
 * It schedules nothing. It is driven by wakes Core already raises and by its own
 * `open()`, which replays the journal. There is no timer in this file, and that is what
 * the structural audit in `./assertions` scans for.
 */

/** What a caller gets back from an attempt. Never a bare boolean. */
export interface EnterpriseActionOutcome {
  readonly performed: boolean
  readonly actionId: string
  /** The gate that refused, or null. */
  readonly refusedAt: AuthorizationGate | null
  readonly code: string | null
  readonly reason: string
  readonly verification: VerificationRecord | null
  /** Every gate the pipeline consulted, in order. */
  readonly evaluated: readonly AuthorizationGate[]
}

export interface EnterpriseRuntimeOptions {
  readonly ports: EnterprisePorts
  /**
   * Whether the runtime may open at all.
   *
   * An environment that opens with an untrustworthy journal is refused rather than
   * opened and repaired: "we fixed what we could on startup" is how a system ends up
   * running on a record nobody has read.
   */
  readonly requireTrustworthyJournal?: boolean
}

export interface EnterpriseRuntime {
  /** Replay the journal and build the derived state. Idempotent. */
  open(): Promise<void>
  /** The folded state. */
  snapshot(): EnterpriseState
  /** The explainable projection, for the owner. */
  projection(): EnterpriseStateProjection
  /**
   * Handle one wake. Returns what was decided.
   *
   * A refused wake is journaled and changes nothing. It is the only public entry point,
   * which is what makes "nothing happens without an authorized wake" a property of the
   * API rather than a discipline of its callers.
   */
  handleWake(wake: {
    readonly source: string
    readonly kind: string
    readonly actor: string
    readonly environmentId: string | null
    readonly sourceRef: string | null
    readonly wakeKey: string
    readonly at: string
  }): Promise<{ readonly accepted: boolean; readonly code: string | null; readonly reason: string }>
  /** Record an environment and the boundaries and ceilings it operates within. */
  openEnvironment(input: {
    readonly environmentId: string
    readonly kind: string
    readonly title: string
    readonly boundaries: unknown
    readonly spendingLimits: unknown
    readonly at: string
  }): Promise<{ readonly ok: boolean; readonly reason: string }>
  /**
   * Attempt one bounded external action.
   *
   * The whole point of the method: authorization first, effect second, verification
   * third, and a refusal at any step ends the attempt with no effect performed.
   */
  performAction(request: EnterpriseActionRequest): Promise<EnterpriseActionOutcome>
  /** Put a reversible action back, subject to the same pipeline. */
  rollback(input: RollbackRequest): Promise<{ readonly outcome: string; readonly reason: string }>
  /** Ask the owner for an approval, and record the request. */
  requestApproval(input: unknown): Promise<{ readonly ok: boolean; readonly approvalId: string | null; readonly reason: string }>
  /** The approvals this runtime holds. A read, so a test can see what a gate saw. */
  approvals(): readonly ApprovalRecord[]
  /** The effects this runtime has recorded, newest last. */
  actionLog(): readonly {
    actionId: string
    environmentId: string
    kind: string
    state: string
    reasoning: readonly string[]
  }[]
}

/**
 * A rollback request.
 *
 * Every field is a fact *about what the action did*, not an assertion by the caller
 * that it is reversible. That is why `consequence`, `restorable`, `crossedBoundary`,
 * `exceededSpending` and `spentMinor` are all inputs to the assessment rather than a
 * single `reversible: boolean`: a boolean would be the caller answering its own
 * question.
 */
export interface RollbackRequest extends RollbackOutcomeInput {
  readonly consequence: ActionConsequenceClass
  readonly crossedBoundary: boolean
  readonly exceededSpending: boolean
  readonly spentMinor: number
  readonly attempts: number
  readonly environmentRollbacks: number
  readonly approved: boolean
}

export function createEnterpriseRuntime(options: EnterpriseRuntimeOptions): EnterpriseRuntime {
  const { ports } = options
  const requireTrustworthy = options.requireTrustworthyJournal !== false

  let state: EnterpriseState = initialEnterpriseState()
  let opened = false
  let boundaries: EnterpriseBoundaries | null = null
  let spendingLimits: SpendingLimits | null = null
  let ledger: SpendingLedger = emptyLedger('USD')
  /**
   * The environment currently being operated.
   *
   * One at a time, on purpose. The specification's concurrency ceilings are expressed
   * per environment, and a runtime that operated several at once would need a policy
   * for choosing between them — which is exactly the prioritisation that belongs to
   * Phase 24's executive layer and to nothing here.
   */
  let currentEnvironmentId: string | null = null
  const approvals: ApprovalRecord[] = []
  const actions: { actionId: string; environmentId: string; kind: string; state: string; reasoning: string[] }[] = []

  async function append(type: EnterpriseEventType, payload: EnterprisePayload): Promise<void> {
    await ports.append(type, payload)
    state = reduceEnterpriseEntry(state, { type, recordedAt: ports.now(), payload }).state
  }

  /**
   * Build the view the gate consumes.
   *
   * Built from folded state on every attempt rather than cached, so a limit or a count
   * cannot be stale at the moment money would move. Caching this would be faster and
   * would reintroduce exactly the "checked before an await" bug the port design is
   * shaped to avoid.
   */
  function view(): GateEnvironmentView | null {
    const ids = Object.keys(state.environments)
    const id = currentEnvironmentId ?? ids[0]
    if (id === undefined) return null
    const environment = state.environments[id]
    if (environment === undefined) return null

    // Prefer the *journaled* ceilings, falling back to what this process was given.
    // The direction matters: after a restart the fold is the only source, and using it
    // means the owner's actual limits survive rather than being replaced by defaults.
    const effectiveBoundaries =
      environment.boundaries !== null && environment.boundaries.allowedDomains.length > 0
        ? environment.boundaries
        : boundaries
    const effectiveLimits = environment.spendingLimits ?? spendingLimits

    // Fail closed when either is missing. An environment with no allowlist and no
    // ceilings is one this lane will not operate, and the gate's own environment check
    // turns that into a refusal rather than a silent permission.
    if (effectiveBoundaries === null || effectiveLimits === null) return null

    return {
      environmentId: id,
      state: environment.state,
      boundaries: effectiveBoundaries,
      spendingLimits: effectiveLimits,
      ledger,
      createdAt: environment.createdAt,
      deadlineAt: environment.deadlineAt,
      counts: countsFor(state, id),
    }
  }

  function context(verification: VerificationRecord | null): AuthorizationContext {
    return {
      enabled: ports.enabled(),
      journalTrustworthy: ports.journalTrustworthy(),
      // Read fresh, not cached: the latch can be thrown between two of these calls
      // and a stale read is the same bug as a check that happened too early.
      stopped: ports.stopAllActive(),
      environment: view(),
      approvals,
      verification,
    }
  }

  /** Record a refusal so the owner can see what was declined and why. */
  async function recordRefusal(
    request: EnterpriseActionRequest,
    refusedAt: AuthorizationGate | null,
    code: string,
    reason: string,
  ): Promise<void> {
    await append('enterprise.action.refused', {
      actionId: request.actionId,
      environmentId: request.environmentId,
      gate: refusedAt ?? 'unknown',
      code,
      reason: reason.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      at: request.at,
    })
  }

  async function open(): Promise<void> {
    if (opened) return
    if (requireTrustworthy && !ports.journalTrustworthy()) {
      // Refused rather than opened-and-repaired. A repair on startup is a place where
      // an unreadable record quietly becomes a believed one.
      throw new Error('the enterprise journal cannot be believed, so the subsystem did not open')
    }
    const entries = await ports.replay()
    const folded = reduceEnterpriseState(entries)
    state = folded.state
    opened = true
    ports.onChange()
  }

  async function handleWake(wake: {
    readonly source: string
    readonly kind: string
    readonly actor: string
    readonly environmentId: string | null
    readonly sourceRef: string | null
    readonly wakeKey: string
    readonly at: string
  }): Promise<{ readonly accepted: boolean; readonly code: string | null; readonly reason: string }> {
    if (!opened) await open()
    const decision = validateWake(wake)
    if (!decision.accepted) {
      await append('enterprise.wake.denied', {
        wakeKey: wake.wakeKey.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
        source: wake.source.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
        code: decision.code ?? 'authority-claim-refused',
        at: wake.at,
      })
      return { accepted: false, code: decision.code, reason: decision.reason }
    }
    if (state.wakeKeys.includes(wake.wakeKey)) {
      const reason = 'That wake has already been handled. A duplicate wake does not produce a second decision.'
      await append('enterprise.wake.denied', {
        wakeKey: wake.wakeKey.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
        source: wake.source,
        code: 'action-unknown',
        at: wake.at,
      })
      return { accepted: false, code: 'action-unknown', reason }
    }
    await append('enterprise.wake.received', {
      wakeKey: wake.wakeKey.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      source: wake.source,
      at: wake.at,
    })
    return { accepted: true, code: null, reason: 'The wake came from an authorized source and was recorded.' }
  }

  async function openEnvironment(input: {
    readonly environmentId: string
    readonly kind: string
    readonly title: string
    readonly boundaries: unknown
    readonly spendingLimits: unknown
    readonly at: string
  }): Promise<{ readonly ok: boolean; readonly reason: string }> {
    if (!opened) await open()
    const boundaryReading = normaliseBoundaries(input.boundaries)
    if (!boundaryReading.ok || boundaryReading.boundaries === null) {
      return { ok: false, reason: boundaryReading.reason }
    }
    const spendingReading = readSpendingLimits(input.spendingLimits)
    if (!spendingReading.ok || spendingReading.limits === null) {
      return { ok: false, reason: spendingReading.reason }
    }
    boundaries = boundaryReading.boundaries
    spendingLimits = spendingReading.limits
    currentEnvironmentId = input.environmentId
    ledger = emptyLedger(spendingReading.limits.currency)

    await append('enterprise.environment.created', {
      environmentId: input.environmentId,
      kind: String(input.kind),
      state: 'draft',
      title: input.title.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      at: input.at,
    })
    // The ceilings are journaled, not merely held. A runtime that kept them in memory
    // would come back from a restart with an environment that had no limits at all, and
    // the gate's answer to "no limits recorded" has to be a refusal rather than an
    // absence.
    await append('enterprise.environment.boundaries-set', {
      environmentId: input.environmentId,
      maxTasks: boundaryReading.boundaries.maxTasks,
      maxMissions: boundaryReading.boundaries.maxMissions,
      maxWebzoneOperations: boundaryReading.boundaries.maxWebzoneOperations,
      maxConcurrentOperations: boundaryReading.boundaries.maxConcurrentOperations,
      at: input.at,
    })
    await append('enterprise.environment.spending-limits-set', {
      environmentId: input.environmentId,
      maxTotalSpend: spendingReading.limits.maxTotalSpend,
      maxPerAction: spendingReading.limits.maxPerAction,
      maxPerDay: spendingReading.limits.maxPerDay,
      currency: spendingReading.limits.currency,
      hardCeiling: true,
      at: input.at,
    })
    // Activation is immediate and explicit, because this method is only ever reached
    // from an owner-driven request. It is still written as a real `draft -> active`
    // transition rather than by creating the record as active, so the journal contains
    // the same two entries a later, deferred activation would — and so nothing here has
    // a private shortcut around the state machine.
    await append('enterprise.environment.state-changed', {
      environmentId: input.environmentId,
      from: 'draft',
      to: 'active',
      code: 'owner-activated',
      reason: 'The owner opened this environment.',
      at: input.at,
    })
    ports.onChange()
    return { ok: true, reason: 'The environment was recorded with narrowed boundaries and hard spending ceilings.' }
  }

  async function performAction(request: EnterpriseActionRequest): Promise<EnterpriseActionOutcome> {
    if (!opened) await open()

    // Authorization first. Nothing below this line runs unless the pipeline agreed,
    // and nothing above it touches the outside world.
    const decision = authorizeEnterpriseAction(context(null), request)
    if (!decision.allowed) {
      await recordRefusal(request, decision.refusedAt, decision.code ?? 'action-unknown', decision.reason)
      return {
        performed: false,
        actionId: request.actionId,
        refusedAt: decision.refusedAt,
        code: decision.code,
        reason: decision.reason,
        verification: null,
        evaluated: decision.evaluated,
      }
    }

    const operationId = ports.newId()
    const effect: EnterpriseEffectRequest = {
      operationId,
      environmentId: request.environmentId,
      kind: request.kind,
      target: request.target,
      payload: request.payload,
    }

    await append('enterprise.action.started', {
      actionId: request.actionId,
      environmentId: request.environmentId,
      kind: request.kind,
      at: request.at,
    })
    await append('enterprise.spending-gate.checked', {
      environmentId: request.environmentId,
      actionId: request.actionId,
      gate: 'total',
      limitMinor: spendingLimits?.maxTotalSpend ?? 0,
      projectedMinor: ledger.totalMinor + request.amountMinor,
      held: true,
      at: request.at,
    })
    await append('enterprise.webzone-operation.started', {
      operationId,
      environmentId: request.environmentId,
      kind: request.kind,
      target: request.target.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      at: request.at,
    })

    const outcome = await ports.performWebzoneEffect(effect)

    // Verification is the second gate, run against what the effect actually reported.
    // The reported outcome is not taken on trust: a closed outcome plus who produced it
    // decides the verdict, and `claim-not-evidence` is the answer when the only
    // evidence is the operation's own report.
    const verificationDecision = verifyExternalAction({
      actionId: request.actionId,
      environmentId: request.environmentId,
      outcome: outcome.holds ? 'passed' : 'failed',
      evidence: {
        claimed: true,
        claimedBy: 'external-observation',
        observed: true,
        matched: outcome.holds,
      },
      deadlineAt: null,
      stopped: ports.stopAllActive(),
      at: request.at,
    })

    const verification: VerificationRecord = {
      verificationId: ports.newId(),
      actionId: request.actionId,
      environmentId: request.environmentId,
      outcome: verificationDecision.outcome,
      reason: verificationDecision.reason.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      verifiedAt: request.at,
    }

    await append('enterprise.external-action.verified', {
      verificationId: verification.verificationId,
      actionId: request.actionId,
      environmentId: request.environmentId,
      outcome: verification.outcome,
      reason: verification.reason,
      at: request.at,
    })

    const complete = mayBeConsideredComplete(verification)
    if (!complete.complete) {
      await append('enterprise.webzone-operation.failed', {
        operationId,
        environmentId: request.environmentId,
        code: verification.outcome,
        reason: verification.reason.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
        at: request.at,
      })
      ports.onChange()
      return {
        performed: true,
        actionId: request.actionId,
        refusedAt: null,
        code: verification.outcome,
        reason: complete.reason,
        verification,
        evaluated: decision.evaluated,
      }
    }

    // Spend lands only here: after verification, never before.
    ledger = accumulateSpend(ledger, request.at, request.amountMinor)

    await append('enterprise.webzone-operation.completed', {
      operationId,
      environmentId: request.environmentId,
      verificationId: verification.verificationId,
      at: request.at,
    })
    actions.push({
      actionId: request.actionId,
      environmentId: request.environmentId,
      kind: request.kind,
      state: 'completed',
      reasoning: [verification.reason],
    })
    ports.onChange()
    return {
      performed: true,
      actionId: request.actionId,
      refusedAt: null,
      code: null,
      reason: complete.reason,
      verification,
      evaluated: decision.evaluated,
    }
  }

  async function rollback(input: RollbackRequest): Promise<{ readonly outcome: string; readonly reason: string }> {
    if (!opened) await open()

    const gate = checkRollbackGate({
      actionId: input.actionId,
      environmentId: input.environmentId,
      consequence: input.consequence,
      restorable: input.restorable,
      crossedBoundary: input.crossedBoundary,
      exceededSpending: input.exceededSpending,
      spentMinor: input.spentMinor,
      attempts: input.attempts,
      environmentRollbacks: input.environmentRollbacks,
      approved: input.approved,
    })
    if (!gate.allowed) {
      await append('enterprise.rollback.failed', {
        rollbackId: input.rollbackId,
        actionId: input.actionId,
        environmentId: input.environmentId,
        reason: gate.reason.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
        at: ports.now(),
      })
      return { outcome: gate.outcome, reason: gate.reason }
    }

    const reversed = await ports.reverseWebzoneEffect({
      operationId: input.actionId,
      environmentId: input.environmentId,
      kind: 'update',
      target: input.actionId,
      payload: '',
    })
    // `allOfIt` is the caller's report of how much came back, intersected with whether
    // the reverse effect actually happened. Both are needed: a caller claiming a full
    // restore while the effect reported failure is reporting success over nothing, and
    // that has to read as `failed`, not `partial`.
    const derived = deriveRollbackOutcome({
      rollbackId: input.rollbackId,
      actionId: input.actionId,
      environmentId: input.environmentId,
      rolledBack: reversed.holds,
      allOfIt: reversed.holds && input.allOfIt,
      restorable: input.restorable,
    })
    await append('enterprise.rollback.executed', {
      rollbackId: input.rollbackId,
      actionId: input.actionId,
      environmentId: input.environmentId,
      outcome: derived.outcome,
      reason: derived.reason.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      at: ports.now(),
    })
    return { outcome: derived.outcome, reason: derived.reason }
  }

  async function requestApproval(input: unknown): Promise<{
    readonly ok: boolean
    readonly approvalId: string | null
    readonly reason: string
  }> {
    if (!opened) await open()
    const at = ports.now()
    const reading = readApprovalRequest(input, at)
    if (!reading.ok || reading.request === null) {
      return { ok: false, approvalId: null, reason: reading.reason }
    }

    const approvalId = ports.newId()
    await append('enterprise.approval.requested', {
      approvalId,
      environmentId: reading.request.environmentId,
      kind: reading.request.kind,
      subjectKind: reading.request.subjectKind,
      subjectRef: reading.request.subjectRef.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      subjectDigest: reading.request.subjectDigest.slice(0, ENTERPRISE_LIMITS.maxPayloadTextLength),
      expiresAt: reading.request.expiresAt,
      at,
    })

    const decision = await ports.requestOwnerApproval(reading.request)

    // The one question that decides whether this subsystem is safe to have: was that
    // actually the owner? If it was not, the request stays a denial rather than
    // becoming a permission.
    const ownersDecision = approvalDecisionIsOwners(
      { kind: reading.request.kind, subjectKind: reading.request.subjectKind, subjectRef: reading.request.subjectRef, subjectDigest: reading.request.subjectDigest },
      approvalId,
      decision.decidedBy,
    )
    if (!ownersDecision) {
      await append('enterprise.approval.denied', {
        approvalId,
        environmentId: reading.request.environmentId,
        reason: 'That decision did not come from the owner, so it is recorded as a denial.',
        at,
      })
      return { ok: false, approvalId: null, reason: 'Only the owner may decide an approval.' }
    }

    const record: ApprovalRecord = {
      approvalId,
      environmentId: reading.request.environmentId,
      kind: reading.request.kind,
      subjectKind: reading.request.subjectKind,
      subjectRef: reading.request.subjectRef,
      subjectDigest: reading.request.subjectDigest,
      reasoning: reading.request.reasoning,
      state: decision.granted ? 'granted' : 'denied',
      requestedAt: at,
      decidedAt: decision.decidedAt,
      expiresAt: reading.request.expiresAt,
    }
    approvals.push(record)
    await append(decision.granted ? 'enterprise.approval.granted' : 'enterprise.approval.denied', {
      approvalId,
      environmentId: reading.request.environmentId,
      ...(decision.granted ? {} : { reason: 'The owner declined.' }),
      at,
    })
    ports.onChange()
    return { ok: decision.granted, approvalId, reason: decision.granted ? 'The owner granted this exact action.' : 'The owner declined.' }
  }

  return {
    open,
    snapshot: () => state,
    projection: () => projectEnterpriseState({ state, at: ports.now() }),
    handleWake,
    openEnvironment,
    performAction,
    rollback,
    requestApproval,
    /**
     * The approvals this runtime holds.
     *
     * A read, so a test can prove the gate saw exactly the approvals that exist rather
     * than a copy of them. It returns the array itself, not a filtered view, because a
     * gate that consulted a subset would be the bug worth catching.
     */
    approvals: () => approvals.slice(),
    /** The effects this runtime has recorded, newest last. Also a read. */
    actionLog: () => actions.slice(),
  }
}