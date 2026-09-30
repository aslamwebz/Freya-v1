import type { EventFabric } from '../events/fabric'
import { isGrantActive, type CognitionGrant } from './grants'
import { evaluateCognition, type CognitionRequest } from './governor'
import type { ModelGateway, GatewayPermit, GatewayRecorder } from '../model/gateway'
import type { CoreState, CognitionGrantUsage } from '../state'
import { findGrant, reduceCoreState } from '../state'
import type {
  CognitionCause,
  CognitionOrigin,
  ModelUsage,
  PrincipalId,
} from '../protocol/core-protocol'

/**
 * The Cognition Service: the only door from the rest of Freya to a provider.
 *
 * It owns the Governor and the Gateway and exposes neither. A caller supplies
 * a request and receives an outcome; it cannot obtain a gateway, obtain a
 * provider, or construct a permit.
 *
 * The sequence is fixed and has no branches that skip a step:
 *
 *   append `cognition.requested`        (durable, before anything else)
 *   ask the Governor
 *     deny  -> append `cognition.denied` and return. The provider is untouched.
 *     allow -> append `cognition.allowed`, consume the grant, then call once.
 *
 * There is no retry. A failure is one call, recorded once.
 */

export type CognitionOutcome =
  | { status: 'allowed'; requestId: string; text: string; providerId: string; model: string }
  | { status: 'denied'; requestId: string; reason: string }
  | { status: 'failed'; requestId: string; reason: string }

/**
 * What a caller may say. Notably absent: `authorization`. A caller cannot name
 * a grant it believes it holds, and cannot assert that a human is waiting. The
 * service nominates a grant and derives those facts; the Governor validates.
 * Every way a caller could influence the outcome errs towards denial.
 */
export interface CognitionCall {
  cognitionRequestId: string
  correlationId: string
  origin: CognitionOrigin
  cause: CognitionCause
  actor: PrincipalId
  maxOutputTokens: number
  requestedModel?: string | null
  parentRunId?: string | null
  goalId?: string | null
  /**
   * A caller may declare its work background. It may never declare the
   * opposite: a request is background unless it is plainly a user turn.
   */
  background?: boolean
  /** The text to send. Held in memory only; never written to an audit event. */
  prompt: string
}

export interface CreateGrantInput {
  grantId: string
  createdBy: PrincipalId
  expiresAt: string
  allowedOrigins: CognitionOrigin[]
  allowedCauses: CognitionCause[]
  goalId?: string | null
  runId?: string | null
  actor?: PrincipalId | null
  backgroundAllowed: boolean
  maxCalls: number
  maxOutputTokens: number
  parentGrantId?: string | null
}

export interface CognitionServiceOptions {
  fabric: EventFabric
  gateway: ModelGateway
  now?: () => Date
}

export class CognitionService {
  private readonly fabric: EventFabric
  private readonly gateway: ModelGateway
  private readonly now: () => Date
  private readonly disposeFabric: () => void

  /** Kept current by the fabric subscription, so replay and live agree. */
  private state: CoreState

  constructor(options: CognitionServiceOptions, state: CoreState) {
    this.fabric = options.fabric
    this.gateway = options.gateway
    this.now = options.now ?? (() => new Date())
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

  grants(): readonly CognitionGrant[] {
    return this.state.grants
  }

  async createGrant(input: CreateGrantInput): Promise<CognitionGrant> {
    // A grant is a division of a finite allowance. Zero or negative ceilings
    // are refused rather than stored as a grant that can never be used.
    if (!Number.isInteger(input.maxCalls) || input.maxCalls <= 0) {
      throw new Error('a grant must allow at least one call')
    }
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
      throw new Error('a grant must allow at least one output token')
    }
    if (new Date(input.expiresAt).getTime() <= this.now().getTime()) {
      throw new Error('a grant must expire in the future')
    }

    await this.fabric.append(
      'cognition.grant.created',
      {
        grantId: input.grantId,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
        allowedOrigins: input.allowedOrigins,
        allowedCauses: input.allowedCauses,
        goalId: input.goalId ?? null,
        runId: input.runId ?? null,
        actor: input.actor ?? null,
        backgroundAllowed: input.backgroundAllowed,
        maxCalls: input.maxCalls,
        maxOutputTokens: input.maxOutputTokens,
      },
      { actor: input.createdBy, correlationId: input.grantId },
    )

    const grant = findGrant(this.state, input.grantId)
    if (!grant) throw new Error('grant was not persisted')
    return grant
  }

  async revokeGrant(grantId: string, by: PrincipalId, reason: string): Promise<boolean> {
    const grant = findGrant(this.state, grantId)
    if (!grant || grant.revokedAt !== null) return false
    await this.fabric.append(
      'cognition.grant.revoked',
      { grantId, revokedBy: by, reason },
      { actor: by, correlationId: grantId },
    )
    return true
  }

  /**
   * Request cognition. The single entry point to a model provider.
   */
  async request(call: CognitionCall): Promise<CognitionOutcome> {
    const requestId = call.cognitionRequestId

    await this.fabric.append(
      'cognition.requested',
      {
        requestId,
        origin: call.origin,
        cause: call.cause,
        maxOutputTokens: call.maxOutputTokens,
        requestedModel: call.requestedModel ?? null,
        parentRunId: call.parentRunId ?? null,
        goalId: call.goalId ?? null,
      },
      { actor: call.actor, correlationId: call.correlationId, source: 'core' },
    )

    // A request is user-initiated only when a human is genuinely waiting.
    //
    // `origin` alone is not enough: it is a label the caller supplies, so an
    // agent can put 'user' in it. `actor` is the part the caller cannot choose,
    // because the bridge assigns identity — so it is the part that decides. A
    // request that is not plainly a human turn is background, which costs it the
    // grantless path and requires a grant that permits background work.
    const background =
      call.background === true || call.origin !== 'user' || call.actor !== HUMAN_PRINCIPAL
    const nominated = this.nominateGrant(call, background)

    const governorRequest: CognitionRequest = {
      cognitionRequestId: requestId,
      correlationId: call.correlationId,
      origin: call.origin,
      cause: call.cause,
      actor: call.actor,
      parentRunId: call.parentRunId ?? null,
      goalId: call.goalId ?? null,
      requestedModel: call.requestedModel ?? null,
      maxOutputTokens: call.maxOutputTokens,
      background,
      authorization: { grantId: nominated, userInitiated: !background },
    }

    const decision = evaluateCognition(governorRequest, {
      grants: this.state.grants,
      stopAllActive: this.state.stopAll.active,
      now: this.now(),
    })

    if (decision.outcome !== 'allow') {
      await this.fabric.append(
        'cognition.denied',
        { requestId, reason: decision.reason, grantId: decision.grantId },
        { actor: call.actor, correlationId: call.correlationId, causationId: null },
      )
      // The provider is never touched on this path. Not even constructed.
      return { status: 'denied', requestId, reason: decision.reason }
    }

    await this.fabric.append(
      'cognition.allowed',
      { requestId, grantId: decision.grantId },
      { actor: call.actor, correlationId: call.correlationId },
    )

    // Reserve before spending. Both the call and the output allowance are
    // taken durably here, so a crash mid-flight cannot hand either back.
    if (decision.grantId !== null) {
      await this.reserveGrant(decision.grantId, requestId, call.maxOutputTokens)
    }

    const permit: GatewayPermit = {
      requestId,
      correlationId: call.correlationId,
      grantId: decision.grantId,
      providerId: 'auto',
      maxOutputTokens: call.maxOutputTokens,
      model: call.requestedModel ?? null,
    }

    try {
      const result = await this.gateway.execute(permit, call.prompt)
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
      }
    } catch (error) {
      return {
        status: 'failed',
        requestId,
        reason: error instanceof Error ? error.message : 'unknown provider failure',
      }
    }
  }

  /**
   * Nominate the grant this request should be judged against.
   *
   * This is a suggestion, not a decision: the Governor re-checks the full
   * context. Nominating nothing yields a refusal rather than a fallback, so a
   * mismatch fails closed.
   */
  private nominateGrant(call: CognitionCall, background: boolean): string | null {
    const now = this.now()
    for (const grant of this.state.grants) {
      if (!isGrantActive(grant, now)) continue
      if (!grant.allowedOrigins.includes(call.origin)) continue
      if (!grant.allowedCauses.includes(call.cause)) continue
      if (background && !grant.backgroundAllowed) continue
      if (grant.actor !== null && grant.actor !== call.actor) continue
      return grant.id
    }
    return null
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
    const usage: CognitionGrantUsage = {
      calls: grant.usage.calls + 1,
      outputTokenBudgetReserved: grant.usage.outputTokenBudgetReserved + maxOutputTokens,
      inputTokens: grant.usage.inputTokens,
      outputTokens: grant.usage.outputTokens,
    }
    await this.fabric.append(
      'cognition.grant.consumed',
      {
        grantId,
        requestId,
        callsUsed: usage.calls,
        outputTokenBudgetReserved: usage.outputTokenBudgetReserved,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
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
    if (inputTokens === null && outputTokens === null) return
    const grant = findGrant(this.state, grantId)
    if (!grant) return
    await this.fabric.append(
      'cognition.grant.consumed',
      {
        grantId,
        requestId,
        callsUsed: grant.usage.calls,
        outputTokenBudgetReserved: grant.usage.outputTokenBudgetReserved,
        inputTokens: inputTokens ?? grant.usage.inputTokens,
        outputTokens: outputTokens ?? grant.usage.outputTokens,
      },
      { correlationId: requestId },
    )
  }
}

/** The only principal that can stand in for a waiting human. */
const HUMAN_PRINCIPAL = 'owner'

export type { GatewayRecorder }
