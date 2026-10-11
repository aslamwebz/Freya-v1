import type { EventFabric } from '../events/fabric'
import { randomUUID } from 'node:crypto'
import { isGrantActive, type CognitionGrant, type CognitionGrantSpec } from './grants'
import { evaluateCognition, type CognitionRequest } from './governor'
import { wasProviderContacted } from '../model/gateway'
import type { ModelGateway, GatewayPermit, GatewayRecorder } from '../model/gateway'
import { isModelRequestCancelled } from '../model/provider'
import type { CognitionOutcome } from './outcome'
export { cognitionOutcomeTruncated } from './outcome'
export type { CognitionOutcome } from './outcome'
import type { CoreState } from '../state'
import { findGrant, reduceCoreState } from '../state'
import type { ModelUsage } from '../../shared/contracts/model'
import type { PrincipalId } from '../../shared/contracts/identity'
import {
  INTENT_SHAPES,
  type CognitionIntent,
  type OwnerAuthority,
  type WorkerAuthority,
  type WorkerIntent,
} from '../authority'
import type { Guard, Principal } from '../security/guard'
import { ALL_CAPABILITIES, type Capability } from '../../shared/contracts/capabilities'
import type { CognitionOrigin, CognitionCause } from '../../shared/contracts/security'

/**
 * What a caller may say. `CognitionCall` does not exist any more: it had
 * `actor`, `origin`, `cause` and `background` fields, and every one of them
 * was a value the caller chose. They are derived now, from a closed
 * vocabulary, by the authority the call arrived on.
 */
export interface CognitionServiceOptions {
  fabric: EventFabric
  gateway: ModelGateway
  guard: Guard
  now?: () => Date
  newId?: () => string
  /**
   * Whether the event log can be believed. A function, not a boolean, because
   * the answer is settled at start-up and read on every request — and because a
   * boolean captured here would be a claim rather than a question.
   */
  journalTrustworthy?: () => boolean
}

export class CognitionService {
  private readonly fabric: EventFabric
  private readonly gateway: ModelGateway
  private readonly guard: Guard
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly journalTrustworthy: () => boolean
  private readonly disposeFabric: () => void

  /**
   * One lock per grant, held only while a request is authorised and its
   * reservation is made durable.
   *
   * Without this the budget has a hole in it. "How much is left?" and "take
   * that much" are two steps, and ten concurrent callers all read the same
   * remaining figure before any of them had reserved — so a 1000-token grant
   * cheerfully authorised ten 300-token requests and finished 3000 tokens over.
   *
   * The lock is per grant, so unrelated grants still proceed in parallel, and
   * it is held for the entire authoriseAndRun — including the provider call —
   * so a concurrent request cannot read a stale remaining figure while another
   * request's provider call is still in flight.
   */
  private readonly grantLocks = new Map<string, Promise<unknown>>()

  /** Kept current by the fabric subscription, so replay and live agree. */
  private state: CoreState

  constructor(options: CognitionServiceOptions, state: CoreState) {
    this.fabric = options.fabric
    this.gateway = options.gateway
    this.guard = options.guard
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => `cog-${randomUUID()}`)
    this.journalTrustworthy = options.journalTrustworthy ?? (() => true)
    this.state = state
    // The only way state changes: a durable event, applied after it persisted.
    this.disposeFabric = options.fabric.subscribe((event) => {
      this.state = reduceCoreState(this.state, event)
    })
  }

  dispose(): void {
    this.disposeFabric()
  }

  /** Durable usage totals, for the projection. */
  durableUsage(): ModelUsage {
    return this.state.durableUsage
  }

  /**
   * Create a grant, as a named principal.
   *
   * Guard decides. `createdBy` is the principal, never a value from the spec,
   * so a caller cannot author a durable record claiming someone else authorised
   * it. A refusal is durable too: the attempt is in the log either way.
   */
  async createGrantFor(principal: Principal, spec: CognitionGrantSpec): Promise<CognitionGrant> {
    const verdict = this.guard.evaluate(principal, 'cognition.grant.manage')
    if (!verdict.allowed) {
      await this.recordGuardDenial(verdict, principal, 'cognition.grant.manage', spec.grantId)
      throw new Error(`grant refused: ${verdict.reason}`)
    }

    // A grant is a division of a finite allowance. Zero or negative ceilings
    // are refused rather than stored as a grant that can never be used.
    if (!Number.isInteger(spec.maxCalls) || spec.maxCalls <= 0) {
      throw new Error('a grant must allow at least one call')
    }
    if (!Number.isInteger(spec.maxOutputTokens) || spec.maxOutputTokens <= 0) {
      throw new Error('a grant must allow at least one output token')
    }
    if (new Date(spec.expiresAt).getTime() <= this.now().getTime()) {
      throw new Error('a grant must expire in the future')
    }

    await this.fabric.append(
      'cognition.grant.created',
      {
        grantId: spec.grantId,
        createdBy: principal.id,
        expiresAt: spec.expiresAt,
        allowedOrigins: [...spec.allowedOrigins],
        allowedCauses: [...spec.allowedCauses],
        goalId: spec.goalId ?? null,
        runId: spec.runId ?? null,
        actor: spec.actor ?? null,
        backgroundAllowed: spec.backgroundAllowed,
        maxCalls: spec.maxCalls,
        maxOutputTokens: spec.maxOutputTokens,
      },
      { actor: principal.id, correlationId: spec.grantId },
    )

    const grant = findGrant(this.state, spec.grantId)
    if (!grant) throw new Error('grant was not persisted')
    return grant
  }

  /**
   * Revoke a grant, as a named principal. Guard decides, as above.
   */
  async revokeGrantFor(
    principal: Principal,
    grantId: string,
    reason: string,
  ): Promise<boolean> {
    const verdict = this.guard.evaluate(principal, 'cognition.grant.manage')
    if (!verdict.allowed) {
      await this.recordGuardDenial(verdict, principal, 'cognition.grant.manage', grantId)
      return false
    }
    const grant = findGrant(this.state, grantId)
    if (!grant || grant.revokedAt !== null) return false
    await this.fabric.append(
      'cognition.grant.revoked',
      { grantId, revokedBy: principal.id, reason },
      { actor: principal.id, correlationId: grantId },
    )
    return true
  }

  /**
   * The owner's surface. Grant governance is on this interface and on no
   * other, so there is nothing for a worker to reach.
   */
  ownerAuthority(): OwnerAuthority {
    const owner = this.ownerPrincipalFor()
    return {
      principalId: 'owner',
      request: (intent) => this.requestFor(owner, intent),
      createGrant: (spec) => this.createGrantFor(owner, spec),
      revokeGrant: (grantId, reason) => this.revokeGrantFor(owner, grantId, reason),
      grants: () => this.state.grants,
    }
  }

  /**
   * A worker's surface. No grant methods, and `user_turn` is not in its type.
   */
  workerAuthority(principalId: PrincipalId): WorkerAuthority {
    const worker = this.workerPrincipal(principalId)
    return {
      principalId,
      request: (intent: WorkerIntent) => this.requestFor(worker, intent),
    }
  }

  /**
   * The one place a trusted principal is built.
   *
   * Core needs an owner to evaluate command capabilities against, and it needs
   * one for grant governance. Both come from here rather than from an exported
   * factory in the security module, so there is a single construction site for
   * authority in the whole of Core.
   */
  ownerPrincipalFor(): Principal {
    return { id: 'owner', capabilities: new Set(ALL_CAPABILITIES), trusted: true }
  }

  private workerPrincipal(principalId: PrincipalId): Principal {
    // A worker is never trusted, whatever capability list it is handed. Guard
    // refuses on `trusted` before it looks at capabilities at all.
    return { id: principalId, capabilities: new Set<Capability>(), trusted: false }
  }

  /**
   * Request cognition, as a named principal.
   *
   * The single entry point to a provider, and the only place an intent becomes
   * a Governor request. Origin, cause, background and user-initiated are all
   * derived from the intent's *kind*; the principal is not a parameter the
   * caller can choose, because it arrives on the authority object.
   */
  async requestFor(principal: Principal, intent: CognitionIntent): Promise<CognitionOutcome> {
    const shape = INTENT_SHAPES[intent.kind]
    const requestId = intent.cognitionRequestId ?? this.newId()

    // A worker asking for the grantless user path is refused before it is
    // recorded as one. The worker's type does not permit `user_turn`; this says
    // so again for a caller not using the types.
    if (shape.userInitiated && principal.id !== 'owner') {
      return {
        status: 'denied',
        requestId,
        reason: 'only the owner may present a user turn',
      }
    }

    const correlationId = intent.correlationId ?? requestId
    const { origin, cause, background } = shape
    const maxOutputTokens = intent.maxOutputTokens

    await this.fabric.append(
      'cognition.requested',
      {
        requestId,
        origin,
        cause,
        maxOutputTokens,
        requestedModel: intent.requestedModel ?? null,
        parentRunId: null,
        goalId: intent.goalId ?? null,
      },
      { actor: principal.id, correlationId, source: 'core' },
    )

    // An explicitly named grant is used as-is; otherwise nominate by scanning.
    // Naming one is not a bypass — the Governor below still checks that grant
    // against this request's derived shape and its own ceilings — it only removes
    // the ambiguity of "whichever matching grant happens to be first".
    const nominated =
      intent.grantId ??
      this.nominateGrant(origin, cause, principal.id, background)

    // Authorisation and reservation are one indivisible step per grant. The
    // grantless user path has no shared budget, so it needs no lock.
    return nominated === null
      ? this.authoriseAndRun(principal, intent, shape, null, requestId, correlationId)
      : this.withGrantLock(nominated, () =>
          this.authoriseAndRun(principal, intent, shape, nominated, requestId, correlationId),
        )
  }

  /** Hold the lock for a grant, and release it whatever happens. */
  private withGrantLock<T>(grantId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.grantLocks.get(grantId) ?? Promise.resolve()
    const run = prior.then(task, task)
    this.grantLocks.set(
      grantId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /**
   * Decide, reserve, and only then call. Every caller arrives here holding the
   * grant's lock, so the budget it read is still the budget.
   */
  private async authoriseAndRun(
    principal: Principal,
    intent: CognitionIntent,
    shape: (typeof INTENT_SHAPES)[keyof typeof INTENT_SHAPES],
    nominated: string | null,
    requestId: string,
    correlationId: string,
  ): Promise<CognitionOutcome> {
    const { origin, cause, background } = shape
    const maxOutputTokens = intent.maxOutputTokens

    const governorRequest: CognitionRequest = {
      cognitionRequestId: requestId,
      correlationId,
      origin,
      cause,
      actor: principal.id,
      parentRunId: null,
      goalId: intent.goalId ?? null,
      requestedModel: intent.requestedModel ?? null,
      maxOutputTokens,
      background,
      authorization: { grantId: nominated, userInitiated: shape.userInitiated },
    }

    const decision = evaluateCognition(governorRequest, {
      grants: this.state.grants,
      // A durable STOP latch is not the only way cognition can be
      // fail-closed. If persisting STOP ALL itself fails, the gateway stays
      // closed and the Governor must refuse new work until the owner explicitly
      // resumes. This keeps "deny_all" true in behaviour, not only in status.
      stopAllActive: this.state.stopAll.active || !this.gateway.gateStatus().open,
      now: this.now(),
      journalTrustworthy: this.journalTrustworthy(),
    })

    if (decision.outcome !== 'allow') {
      await this.fabric.append(
        'cognition.denied',
        { requestId, reason: decision.reason, grantId: decision.grantId },
        { actor: principal.id, correlationId, causationId: null },
      )
      // The provider is never touched on this path. Not even constructed.
      return { status: 'denied', requestId, reason: decision.reason }
    }

    await this.fabric.append(
      'cognition.allowed',
      { requestId, grantId: decision.grantId },
      { actor: principal.id, correlationId },
    )

    // Reserve before spending. Both the call and the output allowance are
    // taken durably here, so a crash mid-flight cannot hand either back.
    if (decision.grantId !== null) {
      await this.reserveGrant(decision.grantId, requestId, maxOutputTokens)
    }

    const permit: GatewayPermit = {
      requestId,
      correlationId,
      grantId: decision.grantId,
      providerId: 'auto',
      maxOutputTokens,
      model: intent.requestedModel ?? null,
      requestedProviderId: intent.requestedProviderId,
      reasoningEffort: intent.reasoningEffort,
      modelCapability: intent.modelCapability,
      // Present only when a Mind compiled a packet. Absent, the request keeps
      // the single-prompt shape it has always had.
      ...(intent.messages === undefined ? {} : { messages: intent.messages }),
    }

    try {
      const result = await this.gateway.execute(permit, intent.prompt, intent.signal)
      if (decision.grantId !== null) {
        await this.reportProviderUsage(
          decision.grantId,
          requestId,
          result.inputTokens,
          result.outputTokens,
        )
      }
      return {
        status: 'allowed',
        requestId,
        text: result.text,
        providerId: result.providerId,
        model: result.model,
        // Carried, not interpreted. The gateway has already settled both fields,
        // so a caller above reads one fact rather than a spelling it has to know.
        finishReason: result.finishReason ?? null,
        truncated: result.truncated === true,
      }
    } catch (error) {
      // Only a grant that was actually put at risk needs its usage marked.
      //
      // The gateway fails in two quite different ways. A request that never
      // found a provider cannot have been billed, and recording `unknown` for it
      // would declare a gap that does not exist — as though something had been
      // spent. A request that reached a provider and then failed almost certainly
      // was billed, so it does get an explicit gap. A request that was cancelled
      // after contact is in exactly that second position: the work the provider
      // had already done was still paid for, and cancelling does not make it
      // free.
      //
      // Which one this was comes from the gateway's own `providerContacted`
      // marker, not from the provider's name or kind.
      //
      // The reservation is unaffected either way: authorisation is not refunded
      // because the provider misbehaved, nor because none was available, nor
      // because the owner stopped it.
      const contacted = wasProviderContacted(error)
      if (decision.grantId !== null && contacted) {
        await this.reportProviderUsage(decision.grantId, requestId, null, null)
      }
      const reason = error instanceof Error ? error.message : 'unknown provider failure'
      if (isModelRequestCancelled(error)) {
        return { status: 'cancelled', requestId, reason, providerContacted: contacted }
      }
      return { status: 'failed', requestId, reason, providerContacted: contacted }
    }
  }

  /**
   * Nominate the grant this request should be judged against.
   *
   * This is a suggestion, not a decision: the Governor re-checks the full
   * context. Nominating nothing yields a refusal rather than a fallback, so a
   * mismatch fails closed.
   */
  private nominateGrant(
    origin: string,
    cause: string,
    principalId: string,
    background: boolean,
  ): string | null {
    const now = this.now()
    for (const grant of this.state.grants) {
      if (!isGrantActive(grant, now)) continue
      if (!grant.allowedOrigins.includes(origin as CognitionOrigin)) continue
      if (!grant.allowedCauses.includes(cause as CognitionCause)) continue
      if (background && !grant.backgroundAllowed) continue
      if (grant.actor !== null && grant.actor !== principalId) continue
      return grant.id
    }
    return null
  }

  /** Record a Guard refusal. The attempt is durable whether or not it worked. */
  private async recordGuardDenial(
    verdict: { reason: string; outcome: 'deny' | 'approval_required' },
    principal: Principal,
    capability: string,
    correlationId: string,
  ): Promise<void> {
    await this.fabric.append(
      'guard.decision',
      { outcome: verdict.outcome, reason: verdict.reason, capability, principal: principal.id },
      { actor: principal.id, correlationId },
    )
  }

  /**
   * Durably reserve this call's share of the grant's output allowance.
   *
   * Called *before* the provider is asked for anything, and never refunded. That
   * ordering is the whole point: a grant with 1000 tokens and a 300-token
   * request has 700 left the moment the reservation is durable, whether the
   * provider answers, answers with a usage report, fails, or the process dies
   * mid-flight. The budget therefore cannot be inflated by a provider that
   * reports nothing, and cannot be reset by a crash.
   *
   * Reported usage is recorded separately afterwards, and only when the
   * provider actually reported it.
   */
  private async reserveGrant(
    grantId: string,
    requestId: string,
    maxOutputTokens: number,
  ): Promise<void> {
    const grant = findGrant(this.state, grantId)
    if (!grant) return
    // The delta, not a running total. The reducer adds it, so replaying these
    // events rebuilds the same budget the live path spent — and two callers
    // cannot overwrite each other's reservation.
    await this.fabric.append(
      'cognition.grant.reserved',
      { grantId, requestId, outputTokenBudgetReserved: maxOutputTokens },
      { correlationId: requestId },
    )
  }

  /**
   * Record what the provider said it used, if it said anything.
   *
   * This is a report, not a budget movement. It never changes what the grant
   * has left, and a provider that reports nothing leaves the grant untouched
   * rather than having zero assumed on its behalf.
   */
  private async reportProviderUsage(
    grantId: string,
    requestId: string,
    inputTokens: number | null,
    outputTokens: number | null,
  ): Promise<void> {
    // Recorded even when it is null: "this call reported nothing" is a fact the
    // budget accounting needs, and dropping the event would make an unreported
    // call indistinguishable from one that never happened.
    await this.fabric.append(
      'cognition.grant.usage_reported',
      { grantId, requestId, inputTokens, outputTokens },
      { correlationId: requestId },
    )
  }
}

export type { GatewayRecorder }
