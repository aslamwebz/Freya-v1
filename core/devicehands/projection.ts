import {
  DEVICE_HANDS_LIMITS,
  deviceHandsApprovalRequired,
  type DeviceHandsActionKey,
  type DeviceHandsSurface,
} from './types'
import type { DeviceHandsState } from './state'

/**
 * The explainable view, for the owner.
 *
 * Deliberately **not** a UI and deliberately not a projection onto somebody else's
 * shape: it is the sentence a person reads when they want to know what this machine
 * did on their behalf and what it refused. Its job is to make three things impossible
 * to hide:
 *
 *   - the last refusal, with the gate that produced it, so "it did nothing" is always
 *     answerable with *why*;
 *   - the counts, so a session that transferred 40 MiB cannot present as an idle one;
 *   - the absence of a next action. There is no `nextBoundedAction` field, because this
 *     phase schedules nothing. The absence is the property: there is no field here a
 *     renderer could poll to make Freya look busy.
 */

export interface SurfaceSummary {
  readonly surface: DeviceHandsSurface
  /** How many settled actions ran on this surface. */
  readonly actions: number
  readonly completed: number
  readonly failed: number
  readonly unverified: number
  readonly refused: number
  /** Whether every action on this surface that needs an approval had one. */
  readonly approvalsHeld: boolean
}

export interface DeviceHandsProjection {
  readonly openedAt: string | null
  readonly policyDigest: string | null
  readonly stopped: boolean
  readonly surfaces: readonly SurfaceSummary[]
  readonly actionsThisSession: number
  readonly transfersThisSession: number
  readonly bytesThisSession: number
  readonly bytesRemaining: number
  readonly refusals: number
  readonly lastRefusal: {
    readonly actionId: string
    readonly actionKey: string
    readonly gate: string
    readonly code: string
    readonly reason: string
  } | null
  readonly lastProbe: {
    readonly surface: DeviceHandsSurface
    readonly available: boolean
    readonly code: string
  } | null
  /** Actions the journal cannot account for. Never zero-and-forgotten. */
  readonly unresolved: readonly string[]
  /** A sentence describing what happened, for a person. Never model prose. */
  readonly summary: string
}

const SURFACES: readonly DeviceHandsSurface[] = ['browser', 'terminal', 'clipboard', 'transfer']

export function projectDeviceHandsState(input: {
  readonly state: DeviceHandsState
  readonly at: string
}): DeviceHandsProjection {
  const { state } = input
  const actions = Object.values(state.actions)

  const surfaces: SurfaceSummary[] = SURFACES.map((surface) => {
    const mine = actions.filter((action) => action.actionKey.startsWith(`${surface}.`))
    return {
      surface,
      actions: mine.length,
      completed: mine.filter((a) => a.outcome === 'completed').length,
      failed: mine.filter((a) => a.outcome === 'failed').length,
      unverified: mine.filter((a) => a.outcome === 'unverified' || a.state !== 'settled').length,
      refused: mine.filter((a) => a.outcome === 'refused').length,
      // Derived rather than stored: an action that needs no approval trivially had one.
      approvalsHeld: mine
        .filter((a) => deviceHandsApprovalRequired(a.actionKey as DeviceHandsActionKey))
        .every((a) => a.outcome !== 'refused' || a.actionKey === 'terminal.run'),
    }
  })

  const lastRefusal = state.refusals.length > 0 ? state.refusals[state.refusals.length - 1] : null
  const lastProbe =
    state.probes.length > 0 ? state.probes[state.probes.length - 1] : null
  const unresolved = actions.filter((a) => a.state !== 'settled').map((a) => a.actionId)

  const summary =
    state.openedAt === null
      ? 'Device Hands has not opened yet, so nothing has happened.'
      : state.stopped
        ? 'STOP ALL was latched. No further action is admitted.'
        : `${String(state.actionCountThisSession)} action(s) recorded, ${String(state.refusals.length)} refused, ${String(state.transferCountThisSession)} transfer(s) totalling ${String(state.bytesThisSession)} byte(s).` +
          (unresolved.length > 0
            ? ` ${String(unresolved.length)} action(s) are unresolved and are treated as not done.`
            : '')

  return {
    openedAt: state.openedAt,
    policyDigest: state.policyDigest,
    stopped: state.stopped,
    surfaces,
    actionsThisSession: state.actionCountThisSession,
    transfersThisSession: state.transferCountThisSession,
    bytesThisSession: state.bytesThisSession,
    bytesRemaining: Math.max(0, DEVICE_HANDS_LIMITS.maxTransferBytesPerSession - state.bytesThisSession),
    refusals: state.refusals.length,
    lastRefusal:
      lastRefusal === null || lastRefusal === undefined
        ? null
        : {
            actionId: lastRefusal.actionId,
            actionKey: lastRefusal.actionKey,
            gate: lastRefusal.gate,
            code: lastRefusal.code,
            reason: lastRefusal.reason,
          },
    lastProbe:
      lastProbe === null || lastProbe === undefined
        ? null
        : { surface: lastProbe.surface, available: lastProbe.available, code: lastProbe.code },
    unresolved,
    summary,
  }
}