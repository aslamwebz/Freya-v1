import type { AnyCoreEvent } from './events/envelope'
import { emptyGrantUsage, type CognitionGrant, type CognitionGrantUsage } from './cognition/grants'
import { accumulateAttempt, accumulateReported, accumulateUsage, emptyUsage, withdrawAttempt } from './model/usage'
import type { ModelUsage, PrincipalId } from './protocol/core-protocol'
import { initialAttentionState, reduceAttention, type AttentionState } from './attention/state'
import { initialOfficeState, reduceOfficeState, type OfficeState } from './office/state'
import { initialRelayState, reduceRelay, type RelayState } from './relay/state'
import { initialConnectorState, reduceConnector, type ConnectorFold } from './connectors/state'
import { initialSkillState, reduceSkillState, type SkillState } from './skills/state'
import { initialForgeState, reduceForgeState, type ForgeState } from './forge/state'

/**
 * Everything Core knows, derived from durable events.
 *
 * One pure reducer serves both replay and live operation: replay folds history,
 * and the fabric publishes each newly appended event to the same reducer. There
 * is no second code path that could drift from the log.
 *
 * Nothing here is authoritative on its own. Delete the log and this state is
 * gone — which is the point: there is no in-memory truth that outlives the
 * durable record of it.
 */

export interface StopAllState {
  active: boolean
  activatedAt: string | null
  activatedBy: PrincipalId | null
}

export interface CoreState {
  stopAll: StopAllState
  grants: CognitionGrant[]
  /** Totals recovered from the log, independent of the live gateway. */
  durableUsage: ModelUsage
  /** User commands Core has received. */
  commandCount: number
  /** Metadata about the last command. Never its content: that is not here. */
  lastCommand: { commandId: string; contentLength: number; at: string } | null
  faults: string[]
  /**
   * The most recent integrity fault recorded in the journal itself.
   *
   * Persisted rather than reported once and forgotten, because the alternative
   * is the failure this exists to prevent: recovery truncates the damaged
   * segment, so the *next* start reads a clean prefix that no longer contains
   * any evidence of the damage. A fault held in memory would vanish with the
   * process and the second restart would come up healthy.
   */
  integrityFault: IntegrityFaultRecord | null
  /**
   * Requests the journal says reached a provider and have not finished.
   *
   * This is how "was a provider contacted?" is answered during replay, and it
   * is answered from the events rather than from anything about the provider.
   *
   * `model.request.failed` is recorded both when a provider was reached and
   * failed *and* when no provider could be reached at all. The two have opposite
   * usage consequences — the first may well have been paid for, the second
   * certainly was not — and the difference between them is exactly whether a
   * `model.request.started` was written first. Inferring it any other way would
   * be a guess.
   *
   * `model.request.cancelled` does not have to guess: it carries
   * `providerContacted` explicitly, because the gateway is the only thing that
   * knows. It is still used here, to withdraw a start that was written in the
   * instant before a stop arrived.
   */
  pendingRequests: string[]
  /**
   * Attention's folded state: dedupe keys, recent decisions, ingest instants and
   * schedules. Derived from `attention.*` events like everything else, so budgets,
   * cooldowns and dedupe survive a restart without a second store.
   */
  attention: AttentionState
  /**
   * The Office's folded state: the bounded set of pending presence requests.
   *
   * The Office owns almost nothing — its stations, history and layout are pure
   * functions of the Work, Workforce and status projections. The one thing it
   * owns is the set of requests the owner made for an agent to join the desktop
   * Presence, journalled as `office.presence.requested` and replayed here.
   */
  office: OfficeState
  /**
   * Relay's folded state: action records, approvals, idempotency keys and budget
   * instants. Derived from `relay.*` events, so replay protection and rate
   * limits survive a restart without a second store.
   */
  relay: RelayState
  /**
   * Connectors' folded state: connection records, authorization requests, event
   * metadata and dedupe keys. Derived from `connector.*` events, so revocation
   * and replay protection survive a restart without a second store.
   */
  connectors: ConnectorFold
  /**
   * Skills' folded state: records, lifecycle status, verification, version history,
   * evaluation records and open improvement proposals. Derived from `skill.*` events
   * like everything else, so promotions, contradictions and retirement survive a
   * restart without a second store.
   */
  skills: SkillState
  /**
   * Forge's folded state: packages, their versions, lifecycle status, validation
   * verdicts, approval states, quarantine reasons and run outcomes. Derived from
   *  orge.* events, so enabled state and run history survive a restart without
   * a second store.
   */
  forge: ForgeState
}

/** A `core.integrity_fault` as recovered from the journal. */
export interface IntegrityFaultRecord {
  reason: string
  line: number
  quarantinePath: string
  trustedPrefixEvents: number
  trustedPrefixBytes: number
  damagedBytes: number
}

export function initialCoreState(): CoreState {
  return {
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    grants: [],
    durableUsage: emptyUsage(),
    commandCount: 0,
    lastCommand: null,
    faults: [],
    integrityFault: null,
    pendingRequests: [],
    attention: initialAttentionState(),
    office: initialOfficeState(),
    relay: initialRelayState(),
    connectors: initialConnectorState(),
    skills: initialSkillState(),
    forge: initialForgeState(),
  }
}

function withoutOne(ids: readonly string[], id: string): string[] {
  const index = ids.indexOf(id)
  if (index < 0) return ids as string[]
  return [...ids.slice(0, index), ...ids.slice(index + 1)]
}

/** True when the journal itself records that it was found corrupt. */
export function journalRecordsCorruption(state: CoreState): boolean {
  return state.integrityFault !== null
}

export function isStopAllActive(state: CoreState): boolean {
  return state.stopAll.active
}

export function activeGrants(state: CoreState, now: Date): CognitionGrant[] {
  return state.grants.filter(
    (grant) => grant.revokedAt === null && new Date(grant.expiresAt).getTime() > now.getTime(),
  )
}

export function findGrant(state: CoreState, id: string): CognitionGrant | undefined {
  return state.grants.find((grant) => grant.id === id)
}

export function reduceCoreState(state: CoreState, event: AnyCoreEvent): CoreState {
  switch (event.type) {
    case 'security.stop_all.activated':
      return {
        ...state,
        stopAll: {
          active: true,
          activatedAt: event.occurredAt,
          activatedBy: event.payload.by,
        },
      }

    case 'security.stop_all.cleared':
      return {
        ...state,
        stopAll: { active: false, activatedAt: null, activatedBy: null },
      }

    case 'command.received':
      return {
        ...state,
        commandCount: state.commandCount + 1,
        lastCommand: {
          commandId: event.payload.commandId,
          contentLength: event.payload.contentLength,
          at: event.occurredAt,
        },
      }

    case 'cognition.grant.created':
      return { ...state, grants: [...state.grants, grantFromEvent(event)] }

    case 'cognition.grant.revoked':
      return {
        ...state,
        grants: state.grants.map((grant) =>
          grant.id === event.payload.grantId
            ? { ...grant, revokedAt: event.occurredAt, revokedBy: event.payload.revokedBy }
            : grant,
        ),
      }

    // Authorisation: one call spent, and this call's share of the allowance
    // taken off the budget. Both accumulate, and neither is ever refunded.
    case 'cognition.grant.reserved':
      return {
        ...state,
        grants: state.grants.map((grant) =>
          grant.id === event.payload.grantId
            ? {
                ...grant,
                usage: {
                  ...grant.usage,
                  calls: grant.usage.calls + 1,
                  outputTokenBudgetReserved:
                    grant.usage.outputTokenBudgetReserved + event.payload.outputTokenBudgetReserved,
                },
              }
            : grant,
        ),
      }

    // Reporting: what one provider said it used, added to the running total. An
    // unreported call adds nothing and is counted as unknown, so the figures
    // below are a lower bound rather than a total that quietly assumed zero.
    case 'cognition.grant.usage_reported':
      return {
        ...state,
        grants: state.grants.map((grant) =>
          grant.id === event.payload.grantId
            ? {
                ...grant,
                usage: accumulateReported(grant.usage, {
                  inputTokens: event.payload.inputTokens,
                  outputTokens: event.payload.outputTokens,
                }),
              }
            : grant,
        ),
      }

    // An attempt is counted when it is made: `model.request.started` is the only
    // record that a provider was being reached, so it is the honest place for the
    // call count. It contributes no token figures and records no gap in
    // reporting, because the matching `completed` event carries both.
    //
    // It is written immediately before the provider is asked rather than before
    // anything else, so the only thing that can follow it without a provider
    // having been reached is a cancellation that withdraws it below.
    case 'model.request.started':
      return {
        ...state,
        durableUsage: accumulateAttempt(state.durableUsage),
        // Reached. Whatever happens next, this call has to be accounted for.
        // A request id is correlation metadata, not a uniqueness constraint.
        // Preserve multiplicity so two concurrent attempts carrying the same id
        // cannot cause one terminal event to settle both.
        pendingRequests: [...state.pendingRequests, event.payload.requestId],
      }

    // Reported usage is added to the running total. A call that reported nothing
    // increments `unknownUsageCalls` instead of contributing a zero, so the
    // totals are a declared lower bound rather than a false exact figure.
    case 'model.request.completed':
      return {
        ...state,
        durableUsage: accumulateUsage(state.durableUsage, {
          inputTokens: event.payload.inputTokens,
          outputTokens: event.payload.outputTokens,
        }),
        pendingRequests: withoutOne(state.pendingRequests, event.payload.requestId),
      }

    case 'model.request.failed':
      // Only a call that actually reached a provider has unknown usage.
      //
      // The gateway also records a failure when no provider could be selected at
      // all, and nothing was spent then. Whether this failure is one of those is
      // decided by the absence of the matching `model.request.started`, not by
      // the provider's name or kind.
      if (!state.pendingRequests.includes(event.payload.requestId)) {
        // Never contacted, so it was never a call and never cost anything.
        return state
      }
      return {
        ...state,
        // Reaching a provider and then failing is not free: a timeout is billed,
        // and a stream that dies mid-answer was billed. The only truthful record
        // of that is an explicit gap, not an absence.
        durableUsage: accumulateReported(state.durableUsage, {
          inputTokens: null,
          outputTokens: null,
        }),
        pendingRequests: withoutOne(state.pendingRequests, event.payload.requestId),
      }

    // Cancellation, which is not failure and has opposite accounting from it.
    //
    // The gateway knows whether the provider had the request, and says so in the
    // event rather than leaving it to be inferred — because the inference would
    // be wrong precisely in the case that matters most. A stop that arrives in
    // the instant between the `started` being written and the provider being
    // asked leaves a start with no call behind it, and only the event can say
    // which of the two happened.
    case 'model.request.cancelled': {
      const hadStarted = state.pendingRequests.includes(event.payload.requestId)
      const pendingRequests = withoutOne(state.pendingRequests, event.payload.requestId)

      if (!event.payload.providerContacted) {
        // Refused at the door, so no provider was ever asked. If a start had
        // already been written it is withdrawn, so the durable total nets back
        // to a call that never happened. If there was no start, nothing moves.
        return {
          ...state,
          durableUsage: hadStarted ? withdrawAttempt(state.durableUsage) : state.durableUsage,
          pendingRequests,
        }
      }

      // Aborted with the provider already working. The work it had done was
      // still billed, and the amount is unknown, so this is an explicit gap
      // rather than a zero that would make the totals look complete.
      return {
        ...state,
        durableUsage: accumulateReported(state.durableUsage, {
          inputTokens: null,
          outputTokens: null,
        }),
        pendingRequests,
      }
    }

    case 'core.degraded':
      return { ...state, faults: [...state.faults, event.payload.reason] }
    case 'core.integrity_fault': {
      const p = event.payload
      const record: IntegrityFaultRecord = {
        reason: p.reason,
        line: p.line,
        quarantinePath: p.quarantinePath,
        trustedPrefixEvents: p.trustedPrefixEvents,
        trustedPrefixBytes: p.trustedPrefixBytes,
        damagedBytes: p.damagedBytes,
      }
      // Deliberately *not* added to `faults`. That list is advisory — it records
      // what happened — and a fault that reads the same as a transient warning
      // would be easier to miss than a dedicated field nobody can confuse with
      // it. The gate lives in `integrityFault`, and `CoreStatus.integrity`
      // carries it to callers.
      return { ...state, integrityFault: record }
    }
    case 'core.integrity_repaired':
      // The repair event is written only after the store has reconstructed and
      // revalidated the full journal. Clearing the latch here makes replay and
      // the live process agree on the repaired trust state.
      return { ...state, integrityFault: null,
        // The historical warning remains in the journal. It is no longer an
        // active health fault once its recognized integrity gap is repaired.
        faults: state.faults.filter(reason => reason !== 'the event journal was found corrupt; see the preceding integrity fault'),
      }

    default:
      // Attention owns its own slice and its own reducer. Delegating here keeps
      // `reduceCoreState` from growing a case per attention event while leaving a
      // single fold that replay and live operation both run.
      if (event.type.startsWith('attention.')) {
        const attention = reduceAttention(state.attention, event)
        return attention === state.attention ? state : { ...state, attention }
      }
      // The Office owns its slice for the same reason: one fold, one reducer per
      // subsystem, and no case per office event here.
      if (event.type.startsWith('office.')) {
        const office = reduceOfficeState(state.office, event)
        return office === state.office ? state : { ...state, office }
      }
      if (event.type.startsWith('relay.')) {
        const relay = reduceRelay(state.relay, event)
        return relay === state.relay ? state : { ...state, relay }
      }
      if (event.type.startsWith('connector.')) {
        const connectors = reduceConnector(state.connectors, event)
        return connectors === state.connectors ? state : { ...state, connectors }
      }
      // Skills own their own slice and their own reducer, for the same reason: the
      // lifecycle table, the version arithmetic and the evidence window are three
      // invariants that belong together and should not be spread across this switch.
      if (event.type.startsWith('skill.')) {
        const skills = reduceSkillState(state.skills, event)
        return skills === state.skills ? state : { ...state, skills }
      }
      // Forge owns its slice for the same reason, and with the same discipline:
      // the version table, the install/enable separation and the refusal log are
      // invariants that belong together.
      if (event.type.startsWith('forge.')) {
        const forge = reduceForgeState(state.forge, event)
        return forge === state.forge ? state : { ...state, forge }
      }
      return state
  }
}

function grantFromEvent(
  event: Extract<AnyCoreEvent, { type: 'cognition.grant.created' }>,
): CognitionGrant {
  return {
    id: event.payload.grantId,
    createdBy: event.payload.createdBy,
    createdAt: event.occurredAt,
    expiresAt: event.payload.expiresAt,
    allowedOrigins: event.payload.allowedOrigins,
    allowedCauses: event.payload.allowedCauses,
    goalId: event.payload.goalId,
    runId: event.payload.runId,
    actor: event.payload.actor,
    backgroundAllowed: event.payload.backgroundAllowed,
    maxCalls: event.payload.maxCalls,
    maxOutputTokens: event.payload.maxOutputTokens,
    usage: emptyGrantUsage(),
    revokedAt: null,
    revokedBy: null,
    parentGrantId: null,
  }
}


export type { CognitionGrantUsage }
