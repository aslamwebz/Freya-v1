import { createDeviceHandsRuntime } from '../../core/devicehands'
import type {
  DeviceHandsApprovalAsk,
  DeviceHandsApprovalAnswer,
  DeviceHandsEventType,
  DeviceHandsPayload,
  DeviceHandsPorts,
  DeviceHandsProjection,
  DeviceHandsRuntime,
  GrantFact,
} from '../../core/devicehands'
import type { RecoveryReport } from '../../core/devicehands'
import type { DeviceHandsEffects } from './effects'
import type { DeviceHandsJournal } from './journal'

/**
 * Explicit activation for Phase 35 Device Hands.
 *
 * The runtime is fail-closed by construction: it refuses every action until a policy
 * and a grant are on its record and its owner switch is on. This module is the thing
 * that *turns it on*, and it does so only when a host hands it all four of:
 *
 *   1. **Effect adapters** — the real browser, terminal, clipboard and transfer
 *      primitives. Nothing here fabricates one.
 *   2. **A durable journal** — where every derived fact comes from.
 *   3. **An authority** — STOP ALL, the owner switch, the grants Core policy already
 *      authorized, and the owner's approvals. Nothing here mints one.
 *   4. **A surface policy** — with the Vault and keyring roots among its denied roots.
 *
 * `activate()` is the only path to a live surface, and `deactivate()` flips the owner
 * switch off, which refuses the *next* action at the `enabled` gate before any effect
 * is reached. There is no path in this file that widens a ceiling, mints a grant or
 * bypasses a gate.
 *
 * ## The surfaces this phase cannot safely activate
 *
 * Two actions are refused with a stated code rather than implemented, because a safe
 * host implementation does not exist in this architecture:
 *
 *   - `browser.click` and `browser.type-text` need a live, scriptable browsing
 *     context. The browser this host owns is deliberately a script-free, read-only
 *     document; making it scriptable so a click could land would hand a background
 *     runtime the ability to run a page's code, which is authority Phase 35 does not
 *     grant. They are refused, truthfully, and listed below.
 *
 * This file does not weaken the Phase 35 contract to make them "work". It keeps them
 * blocked and says exactly why.
 */

export interface DeviceHandsAuthority {
  /** The STOP ALL latch, read fresh by the runtime at the gate and before the effect. */
  stopAllActive(): boolean
  /** The owner-controlled switch. Off refuses everything, probes included. */
  enabled(): boolean
  /** The grant Core policy already authorized, or null. This module never mints one. */
  activeGrant(principalId: string, scope: string): GrantFact | null
  /** Ask the owner. Returns the owner's decision; this module never decides one. */
  requestOwnerApproval(ask: DeviceHandsApprovalAsk): Promise<DeviceHandsApprovalAnswer>
  /** Whether an approval is still unspent and unrevoked, per Core's own record. */
  approvalStillValid(approvalId: string): boolean
}

export interface DeviceHandsActivationOptions {
  readonly effects: DeviceHandsEffects
  readonly authority: DeviceHandsAuthority
  readonly journal: DeviceHandsJournal
  readonly now: () => string
  readonly newId: () => string
  /** Development profile: no grant/approval/allowlist friction. */
  readonly localUnrestricted?: boolean
  /** Default true. A false journal refuses to open rather than acting on a record. */
  readonly requireTrustworthyJournal?: boolean
}

export interface DeviceHandsActivationRequest {
  /** The surface policy. Must name the Vault and keyring roots among its denied roots. */
  readonly policy: unknown
  /** Grants Core policy has already authorized. Registered, never minted, here. */
  readonly grants?: readonly unknown[]
}

export interface DeviceHandsActivationResult {
  readonly ok: boolean
  readonly code: string | null
  readonly reason: string
}

export interface DeviceHandsBlockedAction {
  readonly actionKey: string
  readonly reason: string
}

/**
 * Actions this host refuses even though Phase 35 routes them, with the exact reason.
 *
 * A blocked action is not a hidden one: it is still named in the vocabulary, still
 * gate-checked, and its refusal is journalled by the runtime like any other. What it
 * does not do is reach an effect, because there is no safe effect to reach.
 */
export const DEVICE_HANDS_BLOCKED_ACTIONS: readonly DeviceHandsBlockedAction[] = Object.freeze([
  {
    actionKey: 'browser.click',
    reason:
      'a click needs a live, scriptable page, and this host only owns a script-free read-only document; making it scriptable would grant a background runtime the ability to run page code',
  },
  {
    actionKey: 'browser.type-text',
    reason:
      'typing needs a live, scriptable page, and this host only owns a script-free read-only document; making it scriptable would grant a background runtime the ability to run page code',
  },
])

export interface DeviceHandsActivationStatus {
  readonly opened: boolean
  readonly active: boolean
  readonly enabled: boolean
  readonly stopped: boolean
  readonly journalTrustworthy: boolean
  readonly policyDigest: string | null
  readonly grants: number
  readonly actions: number
  readonly refusals: number
  readonly blocked: readonly DeviceHandsBlockedAction[]
}

export interface DeviceHandsActivation {
  /** Replay the journal and reconcile. Idempotent. Does not enable anything. */
  open(): Promise<void>
  /** Load the policy, register the grants, and switch the phase on. */
  activate(request: DeviceHandsActivationRequest): Promise<DeviceHandsActivationResult>
  /** Switch the phase off. The next action is refused at the `enabled` gate. */
  deactivate(reason: string): Promise<{ readonly ok: boolean; readonly reason: string }>
  /** Whether this activation has been switched on. */
  active(): boolean
  /** The runtime, for the owner's own reads and for tests. */
  readonly runtime: DeviceHandsRuntime
  /** The explainable projection, with no next-action field. */
  projection(): DeviceHandsProjection
  /** What a restart can honestly claim. */
  recovery(): RecoveryReport
  status(): DeviceHandsActivationStatus
  /** Deactivate and release. Safe to call more than once. */
  dispose(): Promise<void>
}

export function createDeviceHandsActivation(
  options: DeviceHandsActivationOptions,
): DeviceHandsActivation {
  const { effects, authority, journal } = options
  let activated = false

  const ports: DeviceHandsPorts = {
    now: options.now,
    newId: options.newId,
    append: (type: DeviceHandsEventType, payload: DeviceHandsPayload) => journal.append(type, payload),
    replay: () => journal.replay(),
    stopAllActive: () => authority.stopAllActive(),
    // The journal's own integrity is the only honest source for this. A record that
    // does not chain refuses to open, which refuses every new action.
    journalTrustworthy: () => journal.trustworthy(),
    // Both must be true: the owner switched the phase on *and* this module was
    // explicitly activated. Neither alone is enough.
    enabled: () => activated && authority.enabled(),
    activeGrant: (principalId, scope) => authority.activeGrant(principalId, scope),
    requestOwnerApproval: (ask) => authority.requestOwnerApproval(ask),
    approvalStillValid: (approvalId) => authority.approvalStillValid(approvalId),
    probeSurface: (request) => effects.probeSurface(request),
    performBrowser: (request) => effects.performBrowser(request),
    runTerminal: (request) => effects.runTerminal(request),
    readClipboard: (request) => effects.readClipboard(request),
    writeClipboard: (request) => effects.writeClipboard(request),
    clearClipboard: (request) => effects.clearClipboard(request),
    fetchDownload: (request) => effects.fetchDownload(request),
    sendUpload: (request) => effects.sendUpload(request),
    onChange: () => effects.onChange(),
  }

  const runtime = createDeviceHandsRuntime({
    ports,
    localUnrestricted: options.localUnrestricted === true,
    ...(options.requireTrustworthyJournal === undefined
      ? {}
      : { requireTrustworthyJournal: options.requireTrustworthyJournal }),
  })

  async function open(): Promise<void> {
    await runtime.open()
  }

  async function activate(request: DeviceHandsActivationRequest): Promise<DeviceHandsActivationResult> {
    if (activated) {
      return { ok: true, code: null, reason: 'Device Hands is already active.' }
    }
    await runtime.open()
    const loaded = await runtime.loadPolicy(request.policy)
    if (!loaded.ok) {
      return { ok: false, code: loaded.code, reason: loaded.reason }
    }
    for (const grant of request.grants ?? []) {
      const registered = await runtime.registerGrant(grant)
      if (!registered.ok) {
        // A grant Core policy did not authorize is a refusal, not a partial
        // activation. Nothing is left switched on for a caller to retry against.
        return { ok: false, code: registered.code, reason: registered.reason }
      }
    }
    activated = true
    return {
      ok: true,
      code: null,
      reason: `Device Hands is active with ${String((request.grants ?? []).length)} grant(s) on the record.`,
    }
  }

  async function deactivate(reason: string): Promise<{ readonly ok: boolean; readonly reason: string }> {
    if (!activated) {
      return { ok: false, reason: 'Device Hands is not active.' }
    }
    // The owner switch is the halt. It is read at the `enabled` gate of every action,
    // so the next attempt is refused before any port is reached. This phase does not
    // pretend to preempt an effect already in flight — see `runtime.cancel`.
    activated = false
    return { ok: true, reason: `Device Hands was deactivated: ${reason}` }
  }

  return {
    open,
    activate,
    deactivate,
    active: () => activated,
    runtime,
    projection: () => runtime.projection(),
    recovery: () => runtime.recovery(),
    status: () => {
      const state = runtime.snapshot()
      return {
        opened: true,
        active: activated,
        enabled: activated && authority.enabled(),
        stopped: authority.stopAllActive(),
        journalTrustworthy: journal.trustworthy(),
        policyDigest: state.policyDigest,
        grants: Object.keys(state.grants).length,
        actions: Object.keys(state.actions).length,
        refusals: state.refusals.length,
        blocked: DEVICE_HANDS_BLOCKED_ACTIONS,
      }
    },
    async dispose(): Promise<void> {
      activated = false
    },
  }
}

/**
 * A fail-closed authority: no grant, no approval, no owner switch.
 *
 * This is what a production host that has not yet been given an owner-authorized grant
 * gets. Every action is refused at the grant gate or the enabled gate, which is the
 * honest default rather than a permissive one.
 */
export function denyAllAuthority(
  overrides: Partial<DeviceHandsAuthority> = {},
): DeviceHandsAuthority {
  return {
    stopAllActive: () => false,
    enabled: () => false,
    activeGrant: () => null,
    requestOwnerApproval: async (ask: DeviceHandsApprovalAsk): Promise<DeviceHandsApprovalAnswer> => ({
      approvalId: ask.approvalId,
      granted: false,
      decidedBy: 'unknown',
      decidedAt: new Date().toISOString(),
    }),
    approvalStillValid: () => false,
    ...overrides,
  }
}
