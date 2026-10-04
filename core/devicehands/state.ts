import {
  DEVICE_HANDS_LIMITS,
  DEVICE_HANDS_EVENT_TYPES,
  DEVICE_HANDS_EVENT_TYPE_SET,
  DEVICE_HANDS_PAYLOAD_KEYS,
  FORBIDDEN_DEVICE_HANDS_PAYLOAD_KEYS,
  isDeviceHandsActionKey,
  isDeviceHandsSurface,
  isDeviceHandsVerdict,
  type DeviceHandsActionKey,
  type DeviceHandsActionState,
  type DeviceHandsApprovalRecord,
  type DeviceHandsApprovalState,
  type DeviceHandsEventType,
  type DeviceHandsGrantRecord,
  type DeviceHandsRefusalCode,
  type DeviceHandsSettleOutcome,
  type DeviceHandsSurface,
} from './types'
import { mayTransitionApproval } from './approvals'

/**
 * The fold: every fact this phase holds, derived from the journal and nothing else.
 *
 * There is no second copy, no cache and no in-memory record a restart would lose —
 * which is what makes "replay the journal and the state comes back" a property rather
 * than a hope.
 *
 * The fold is untrusting of its own input. For every entry it:
 *
 *   - checks the type is one this phase writes, recording `unknown-event-type`
 *     otherwise rather than ignoring it;
 *   - rejects any key outside the published per-event table, and any key shaped like
 *     authority or like a capture, in *either* direction, naming which and why;
 *   - enforces the text ceiling on every string *value*, so the journal cannot quietly
 *     become a transcript of a clipboard or a page;
 *   - checks every state change against a table, recording `illegal-transition` for an
 *     edge that does not exist and `terminal-state-re-entered` for a finished record
 *     being written to again;
 *   - bounds every collection it grows.
 *
 * What it never does is repair. A tampered journal produces a *visible* wrong answer
 * with the wrongness named in `anomalies`, never a quietly plausible one — because the
 * one thing an action journal must not be is a source of confident fiction about what
 * this machine has already done.
 */

/* --------------------------------------------------------------- anomalies */

export type FoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'terminal-state-re-entered'
  | 'unknown-record'
  | 'duplicate-record'
  | 'completion-without-verification'

export interface FoldAnomaly {
  readonly code: FoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

export interface FoldResult {
  readonly state: DeviceHandsState
  readonly anomalies: readonly FoldAnomaly[]
}

/* ------------------------------------------------------------------ records */

export interface DeviceHandsActionRecord {
  readonly actionId: string
  readonly actionKey: DeviceHandsActionKey
  readonly state: DeviceHandsActionState
  readonly outcome: DeviceHandsSettleOutcome | null
  readonly verificationId: string | null
  readonly principalId: string
  readonly grantId: string
  readonly deadlineAt: string
  readonly startedAt: string
  readonly settledAt: string | null
  /** Bytes this action moved. Zero for anything that is not a transfer. */
  readonly bytes: number
}

export interface DeviceHandsProbeRecord {
  readonly probeId: string
  readonly surface: DeviceHandsSurface
  /** Whether the surface answered. Never an authorisation — see `./ports`. */
  readonly available: boolean
  readonly code: string
  readonly probedAt: string
}

export interface DeviceHandsRefusalEntry {
  readonly actionId: string
  readonly actionKey: string
  readonly gate: string
  readonly code: string
  readonly reason: string
  readonly at: string
}

export interface DeviceHandsState {
  readonly openedAt: string | null
  /** The digest the journal recorded. Compared against the loaded policy at open. */
  readonly policyDigest: string | null
  readonly grants: Readonly<Record<string, DeviceHandsGrantRecord>>
  readonly approvals: Readonly<Record<string, DeviceHandsApprovalRecord>>
  readonly actions: Readonly<Record<string, DeviceHandsActionRecord>>
  readonly probes: readonly DeviceHandsProbeRecord[]
  readonly refusals: readonly DeviceHandsRefusalEntry[]
  readonly actionCountThisSession: number
  readonly transferCountThisSession: number
  readonly bytesThisSession: number
  readonly stopped: boolean
}

export function initialDeviceHandsState(): DeviceHandsState {
  return Object.freeze({
    openedAt: null,
    policyDigest: null,
    grants: Object.freeze({}),
    approvals: Object.freeze({}),
    actions: Object.freeze({}),
    probes: Object.freeze([]),
    refusals: Object.freeze([]),
    actionCountThisSession: 0,
    transferCountThisSession: 0,
    bytesThisSession: 0,
    stopped: false,
  })
}

/* ----------------------------------------------------------------- reading */

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

function readId(payload: Record<string, unknown>, key: string): string {
  return readString(payload, key) ?? ''
}

function readInteger(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key]
  return typeof value === 'boolean' ? value : null
}

function readText(payload: Record<string, unknown>, key: string): string | null {
  const value = readString(payload, key)
  if (value === null) return null
  return value.length <= DEVICE_HANDS_LIMITS.maxPayloadTextLength ? value : null
}

/** A bounded, non-empty list of short tokens, as an allowlist is journalled. */
function readTokenList(payload: Record<string, unknown>, key: string, ceiling: number): string[] | null {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length > DEVICE_HANDS_LIMITS.maxPayloadTextLength) return null
  const parts = value.split(',').map((part) => part.trim())
  if (parts.length === 0 || parts.length > ceiling) return null
  if (parts.some((part) => part.length === 0 || part.length > 128)) return null
  return parts
}

/* -------------------------------------------------------------- inspection */

/**
 * Reject anything authority-shaped, capture-shaped or unbounded before anything else
 * looks at the entry.
 *
 * Checked against a fixed deny list rather than only the event's own key table, so it
 * also catches a key that is *both* allowed and dangerous — which a per-event
 * allowlist cannot express. This is the last place in the system where a payload
 * carrying `approved: true` or `screenshot` should be able to appear, so it is
 * enumerated rather than pattern-matched.
 */
export function inspectDeviceHandsPayload(
  type: DeviceHandsEventType,
  payload: Record<string, unknown>,
): FoldAnomaly[] {
  const anomalies: FoldAnomaly[] = []
  const allowed = DEVICE_HANDS_PAYLOAD_KEYS[type]

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_DEVICE_HANDS_PAYLOAD_KEYS.has(key)) {
      anomalies.push({
        code: 'forbidden-payload-key',
        eventType: type,
        detail: `"${key}" names authority, a capture or raw content. Nothing this phase writes carries one, and the journal is the last place one should be able to appear.`,
      })
    } else if (!allowed.includes(key)) {
      anomalies.push({
        code: 'unknown-payload-key',
        eventType: type,
        detail: `"${key}" is not a field of ${type}. A field nothing reads is a field something can hide in.`,
      })
    }
  }
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.length > DEVICE_HANDS_LIMITS.maxPayloadTextLength) {
      anomalies.push({
        code: 'oversized-payload-text',
        eventType: type,
        detail: `A payload string exceeded ${String(DEVICE_HANDS_LIMITS.maxPayloadTextLength)} characters. The journal is the least protected file in the system.`,
      })
    }
  }
  return anomalies
}

/** Per-event value narrowing. Unrecognised yields null, which the caller records. */
function inspectValues(
  type: DeviceHandsEventType,
  payload: Record<string, unknown>,
): FoldAnomaly[] {
  const problems: FoldAnomaly[] = []
  const malformed = (detail: string): void => {
    problems.push({ code: 'malformed-payload', eventType: type, detail })
  }
  if ('actionKey' in payload && !isDeviceHandsActionKey(payload.actionKey)) {
    malformed('"actionKey" is not a surface.action pair this build routes.')
  }
  if ('surface' in payload && !isDeviceHandsSurface(payload.surface)) {
    malformed('"surface" is not one of browser, terminal, clipboard, transfer.')
  }
  if ('verdict' in payload) {
    malformed('"verdict" is refused by name. A journal entry may not carry its own conclusion; `hands.verified` records the verifier`s answer as `result`.')
  }
  if ('result' in payload && !isDeviceHandsVerdict(payload.result)) {
    malformed('"result" is not passed, failed or unverified.')
  }
  if ('available' in payload && readBoolean(payload, 'available') === null) {
    malformed('"available" must be a boolean.')
  }
  if ('exitCode' in payload) {
    const exit = payload.exitCode
    if (exit !== null && (typeof exit !== 'number' || !Number.isInteger(exit))) {
      malformed('"exitCode" must be a whole number or null.')
    }
  }
  if ('bytes' in payload && readInteger(payload, 'bytes') === null) {
    malformed('"bytes" must be a non-negative whole number.')
  }
  return problems
}

/* ------------------------------------------------------------------ helpers */

function appendBounded<T>(list: readonly T[], item: T, max: number): readonly T[] {
  const next = [...list, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/* ------------------------------------------------------------------- apply */

type Anomalies = FoldAnomaly[]

function applyEntry(
  state: DeviceHandsState,
  entry: { readonly type: string; readonly recordedAt?: string; readonly payload?: unknown },
  anomalies: Anomalies,
): DeviceHandsState {
  if (!DEVICE_HANDS_EVENT_TYPE_SET.has(entry.type)) {
    anomalies.push({
      code: 'unknown-event-type',
      eventType: entry.type,
      detail: 'Not an event this phase writes. It is recorded, not acted on.',
    })
    return state
  }
  const typed = entry.type as DeviceHandsEventType
  const payload =
    typeof entry.payload === 'object' && entry.payload !== null && !Array.isArray(entry.payload)
      ? (entry.payload as Record<string, unknown>)
      : null
  if (payload === null) {
    anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'Payload was not an object.' })
    return state
  }
  const found = [...inspectDeviceHandsPayload(typed, payload), ...inspectValues(typed, payload)]
  if (found.length > 0) {
    anomalies.push(...found)
    return state
  }
  const at = readText(payload, 'at') ?? entry.recordedAt ?? ''

  switch (typed) {
    case 'hands.runtime.opened': {
      const recovered = readInteger(payload, 'recoveredActions')
      if (recovered === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'An open could not be read.' })
        return state
      }
      return { ...state, openedAt: at }
    }

    case 'hands.policy.set': {
      const policyDigest = readText(payload, 'policyDigest')
      if (policyDigest === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A policy record had no digest.' })
        return state
      }
      if (state.policyDigest !== null && state.policyDigest !== policyDigest) {
        // A second, different digest in the same journal means two policies were in
        // force. The action that changed it is not something this phase writes, so it
        // is recorded as an anomaly and *not* applied: the first policy is the one the
        // actions on the record were judged against.
        anomalies.push({
          code: 'illegal-transition',
          eventType: typed,
          detail:
            'A second surface policy digest appears in this journal. The policy is only ever set once; the second is refused rather than applied.',
        })
        return state
      }
      return { ...state, policyDigest }
    }

    /* ------------------------------------------------------------ grants */
    case 'hands.grant.registered': {
      const grantId = readString(payload, 'grantId')
      const principalId = readString(payload, 'principalId')
      const scope = readString(payload, 'scope')
      const surfaces = readTokenList(payload, 'surfaces', DEVICE_HANDS_LIMITS.maxAllowedRoots)
      const actions = readTokenList(payload, 'actions', DEVICE_HANDS_LIMITS.maxAllowedCommands)
      const issuedAt = readText(payload, 'issuedAt')
      const expiresAt = readText(payload, 'expiresAt')
      if (
        grantId === null ||
        principalId === null ||
        scope === null ||
        surfaces === null ||
        actions === null ||
        issuedAt === null ||
        expiresAt === null
      ) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A grant could not be read.' })
        return state
      }
      if (state.grants[grantId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Grant ${grantId} already exists.` })
        return state
      }
      const typedSurfaces: DeviceHandsSurface[] = []
      for (const surface of surfaces) {
        if (!isDeviceHandsSurface(surface)) {
          anomalies.push({ code: 'malformed-payload', eventType: typed, detail: `"${surface}" is not a surface.` })
          return state
        }
        typedSurfaces.push(surface)
      }
      const typedActions: DeviceHandsActionKey[] = []
      for (const action of actions) {
        if (!isDeviceHandsActionKey(action)) {
          anomalies.push({
            code: 'malformed-payload',
            eventType: typed,
            detail: `"${action}" is not an action this build routes, so it cannot be granted.`,
          })
          return state
        }
        typedActions.push(action)
      }
      if (Object.keys(state.grants).length >= DEVICE_HANDS_LIMITS.maxAllowedRoots * 4) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'The grant ceiling is already reached.' })
        return state
      }
      return {
        ...state,
        grants: {
          ...state.grants,
          [grantId]: Object.freeze({
            grantId,
            principalId,
            scope,
            surfaces: Object.freeze(typedSurfaces),
            actions: Object.freeze(typedActions),
            issuedAt,
            expiresAt,
            revokedAt: null,
          }),
        },
      }
    }

    case 'hands.grant.revoked': {
      const grantId = readId(payload, 'grantId')
      const current = state.grants[grantId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such grant.' })
        return state
      }
      if (current.revokedAt !== null) {
        anomalies.push({
          code: 'terminal-state-re-entered',
          eventType: typed,
          detail: 'That grant was already revoked. Revocation has to mean something.',
        })
        return state
      }
      return {
        ...state,
        grants: { ...state.grants, [grantId]: { ...current, revokedAt: at } },
      }
    }

    /* --------------------------------------------------------- approvals */
    case 'hands.approval.requested': {
      const approvalId = readString(payload, 'approvalId')
      const actionKey = payload.actionKey
      const subjectRef = readText(payload, 'subjectRef')
      const digest = readText(payload, 'digest')
      const expiresAt = readText(payload, 'expiresAt')
      if (
        approvalId === null ||
        !isDeviceHandsActionKey(actionKey) ||
        subjectRef === null ||
        digest === null ||
        expiresAt === null
      ) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'An approval request could not be read.' })
        return state
      }
      if (state.approvals[approvalId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Approval ${approvalId} already exists.` })
        return state
      }
      const pending = Object.values(state.approvals).filter((a) => a.state === 'pending').length
      if (pending >= DEVICE_HANDS_LIMITS.maxPendingApprovals) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'The pending-approval ceiling is reached.' })
        return state
      }
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [approvalId]: Object.freeze({
            approvalId,
            subject: Object.freeze({ actionKey, subjectRef, digest }),
            state: 'pending' as DeviceHandsApprovalState,
            requestedAt: at,
            decidedAt: null,
            expiresAt,
          }),
        },
      }
    }

    case 'hands.approval.granted':
    case 'hands.approval.denied':
    case 'hands.approval.revoked': {
      const approvalId = readId(payload, 'approvalId')
      const current = state.approvals[approvalId]
      const to: DeviceHandsApprovalState =
        typed === 'hands.approval.granted'
          ? 'granted'
          : typed === 'hands.approval.denied'
            ? 'denied'
            : 'revoked'
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such approval.' })
        return state
      }
      const transition = mayTransitionApproval(current.state, to)
      if (!transition.allowed) {
        anomalies.push({
          code: 'terminal-state-re-entered',
          eventType: typed,
          detail: transition.reason,
        })
        return state
      }
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [approvalId]: { ...current, state: to, decidedAt: at },
        },
      }
    }

    /* ----------------------------------------------------------- probes */
    case 'hands.probe.performed': {
      const probeId = readString(payload, 'probeId')
      const surface = payload.surface
      const available = readBoolean(payload, 'available')
      const code = readText(payload, 'code')
      if (probeId === null || !isDeviceHandsSurface(surface) || available === null || code === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A probe could not be read.' })
        return state
      }
      return {
        ...state,
        probes: appendBounded(
          state.probes,
          Object.freeze({ probeId, surface, available, code, probedAt: at }),
          DEVICE_HANDS_LIMITS.maxRetainedProbes,
        ),
      }
    }

    case 'hands.probe.refused': {
      const surface = payload.surface
      const code = readText(payload, 'code')
      const reason = readText(payload, 'reason')
      if (!isDeviceHandsSurface(surface) || code === null || reason === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A refused probe could not be read.' })
        return state
      }
      // Recorded as a refusal, not as a probe. A probe that never happened must not
      // leave a record that reads like it did.
      return {
        ...state,
        refusals: appendBounded(
          state.refusals,
          Object.freeze({ actionId: `probe:${surface}`, actionKey: `${surface}.probe`, gate: 'surface', code, reason, at }),
          DEVICE_HANDS_LIMITS.maxRetainedRefusals,
        ),
      }
    }

    /* ---------------------------------------------------------- actions */
    case 'hands.action.started': {
      const actionId = readString(payload, 'actionId')
      const actionKey = payload.actionKey
      const principalId = readText(payload, 'principalId')
      const grantId = readText(payload, 'grantId')
      const deadlineAt = readText(payload, 'deadlineAt')
      if (
        actionId === null ||
        !isDeviceHandsActionKey(actionKey) ||
        principalId === null ||
        grantId === null ||
        deadlineAt === null
      ) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'An action could not be read.' })
        return state
      }
      // An id that was already used is refused here rather than overwriting the earlier
      // record. This is the invariant that makes replay impossible at the *record*
      // level, not only at the gate: a journal that contains two starts for one id is
      // a journal someone edited, and the edit is visible.
      if (state.actions[actionId] !== undefined) {
        anomalies.push({
          code: 'duplicate-record',
          eventType: typed,
          detail: `Action ${actionId} was started twice. An id identifies one action; a retry is a new id.`,
        })
        return state
      }
      if (Object.keys(state.actions).length >= DEVICE_HANDS_LIMITS.maxActionsPerSession) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'The action ceiling is already reached.' })
        return state
      }
      if (state.grants[grantId] === undefined) {
        anomalies.push({
          code: 'unknown-record',
          eventType: typed,
          detail: 'That action names a grant this journal has never seen.',
        })
        return state
      }
      return {
        ...state,
        actions: {
          ...state.actions,
          [actionId]: Object.freeze({
            actionId,
            actionKey,
            state: 'running' as DeviceHandsActionState,
            outcome: null,
            verificationId: null,
            principalId,
            grantId,
            deadlineAt,
            startedAt: at,
            settledAt: null,
            bytes: 0,
          }),
        },
        actionCountThisSession: state.actionCountThisSession + 1,
      }
    }

    case 'hands.action.refused': {
      const actionId = readString(payload, 'actionId')
      const actionKey = payload.actionKey
      const gate = readText(payload, 'gate')
      const code = readText(payload, 'code')
      const reason = readText(payload, 'reason')
      if (actionId === null || !isDeviceHandsActionKey(actionKey) || gate === null || code === null || reason === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A refusal could not be read.' })
        return state
      }
      // A refused id is *consumed*. Recording it is what stops the same refused request
      // being replayed under the same id and looking like a fresh attempt.
      if (state.actions[actionId] === undefined) {
        return {
          ...state,
          actions: {
            ...state.actions,
            [actionId]: Object.freeze({
              actionId,
              actionKey,
              state: 'settled' as DeviceHandsActionState,
              outcome: 'refused' as DeviceHandsSettleOutcome,
              verificationId: null,
              principalId: '',
              grantId: '',
              deadlineAt: at,
              startedAt: at,
              settledAt: at,
              bytes: 0,
            }),
          },
          actionCountThisSession: state.actionCountThisSession + 1,
          refusals: appendBounded(
            state.refusals,
            Object.freeze({ actionId, actionKey, gate, code, reason, at }),
            DEVICE_HANDS_LIMITS.maxRetainedRefusals,
          ),
        }
      }
      return {
        ...state,
        refusals: appendBounded(
          state.refusals,
          Object.freeze({ actionId, actionKey, gate, code, reason, at }),
          DEVICE_HANDS_LIMITS.maxRetainedRefusals,
        ),
      }
    }

    case 'hands.action.cancelled':
    case 'hands.action.timed-out':
    case 'hands.action.interrupted': {
      const actionId = readId(payload, 'actionId')
      const current = state.actions[actionId]
      const to: DeviceHandsSettleOutcome =
        typed === 'hands.action.cancelled'
          ? 'cancelled'
          : typed === 'hands.action.timed-out'
            ? 'timed-out'
            : 'interrupted'
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such action.' })
        return state
      }
      if (current.state === 'settled') {
        anomalies.push({
          code: 'terminal-state-re-entered',
          eventType: typed,
          detail: `Action ${actionId} is already ${current.outcome ?? 'settled'}, so it cannot also become ${to}.`,
        })
        return state
      }
      return {
        ...state,
        actions: { ...state.actions, [actionId]: { ...current, state: 'settled', outcome: to, settledAt: at } },
      }
    }

    /* ---------------------------------------------------------- effects */
    case 'hands.browser.performed':
    case 'hands.terminal.performed':
    case 'hands.clipboard.read':
    case 'hands.clipboard.written':
    case 'hands.clipboard.cleared':
    case 'hands.budget.checked': {
      // Recorded, and nothing more. These entries are the audit trail; the state they
      // change is decided by `hands.verified`, which is the only thing that settles an
      // action. A terminal that reported `exitCode: 0` has not thereby completed.
      return state
    }

    case 'hands.clipboard.credential-detected': {
      const actionId = readString(payload, 'actionId')
      const direction = readText(payload, 'direction')
      const bytes = readInteger(payload, 'bytes')
      if (actionId === null || direction === null || bytes === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A credential detection could not be read.' })
        return state
      }
      // Deliberately *not* a refusal entry with a reason attached: the reason would
      // name the shape, and the shape is derived from content this phase must not keep.
      // Direction and byte count are the whole record, and that is enough to answer
      // "did the clipboard get read this session, and how much was in it".
      return state
    }

    case 'hands.transfer.completed': {
      const actionId = readString(payload, 'actionId')
      const direction = readText(payload, 'direction')
      const mediaType = readText(payload, 'mediaType')
      const bytes = readInteger(payload, 'bytes')
      const destinationRef = readText(payload, 'destinationRef')
      const verificationId = readText(payload, 'verificationId')
      if (
        actionId === null ||
        direction === null ||
        mediaType === null ||
        bytes === null ||
        destinationRef === null ||
        verificationId === null
      ) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A transfer could not be read.' })
        return state
      }
      if (bytes > DEVICE_HANDS_LIMITS.maxTransferBytesPerAction) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: typed,
          detail: `A journalled transfer moved ${String(bytes)} bytes, past the per-action ceiling.`,
        })
        return state
      }
      return {
        ...state,
        transferCountThisSession: state.transferCountThisSession + 1,
        bytesThisSession: state.bytesThisSession + bytes,
      }
    }

    case 'hands.transfer.failed':
      return state

    /* ------------------------------------------------------ verification */
    case 'hands.verified': {
      const verificationId = readString(payload, 'verificationId')
      const actionId = readId(payload, 'actionId')
      const result = payload.result
      const reason = readText(payload, 'reason')
      if (verificationId === null || reason === null || !isDeviceHandsVerdict(result)) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A verification could not be read.' })
        return state
      }
      const current = state.actions[actionId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such action to verify.' })
        return state
      }
      if (current.state === 'settled') {
        anomalies.push({
          code: 'terminal-state-re-entered',
          eventType: typed,
          detail: `Action ${actionId} is already ${current.outcome ?? 'settled'}. A terminal action is not rewritten.`,
        })
        return state
      }
      // `passed` completes; `failed` fails; `unverified` is its own terminal outcome
      // rather than a flavour of failure, because "we do not know" and "we know it did
      // not work" are different facts and an audit trail that merged them would make
      // an unverified action look like a broken one.
      const outcome: DeviceHandsSettleOutcome =
        result === 'passed' ? 'completed' : result === 'failed' ? 'failed' : 'unverified'
      return {
        ...state,
        actions: {
          ...state.actions,
          [actionId]: {
            ...current,
            state: 'settled',
            outcome,
            verificationId,
            settledAt: at,
          },
        },
      }
    }

    case 'hands.reconciled': {
      const actionId = readId(payload, 'actionId')
      const current = state.actions[actionId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such action to reconcile.' })
        return state
      }
      if (current.state === 'settled') {
        anomalies.push({
          code: 'terminal-state-re-entered',
          eventType: typed,
          detail: `Action ${actionId} is already settled, so there is nothing to reconcile.`,
        })
        return state
      }
      return {
        ...state,
        actions: {
          ...state.actions,
          [actionId]: { ...current, state: 'settled', outcome: 'interrupted', settledAt: at },
        },
      }
    }

    case 'hands.stopped': {
      const code = readText(payload, 'code')
      if (code === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A stop record had no code.' })
        return state
      }
      return { ...state, stopped: true }
    }
  }
}

/* ---------------------------------------------------------------- the fold */

export function reduceDeviceHandsEntry(
  state: DeviceHandsState,
  entry: { readonly type: string; readonly recordedAt?: string; readonly payload?: unknown },
): FoldResult {
  const anomalies: FoldAnomaly[] = []
  const next = applyEntry(state, entry, anomalies)
  return { state: next, anomalies }
}

export function reduceDeviceHandsState(
  entries: readonly { readonly type: string; readonly recordedAt?: string; readonly payload?: unknown }[],
): FoldResult {
  let state = initialDeviceHandsState()
  const anomalies: FoldAnomaly[] = []
  for (const entry of entries) {
    const result = reduceDeviceHandsEntry(state, entry)
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

/**
 * Actions that were running when the journal ended.
 *
 * This is restart truthfulness, derived rather than stored: an action with a `started`
 * and no terminal entry *might* have run to completion, and this phase cannot know, so
 * it says so. `./recovery.ts` journals `hands.action.interrupted` for each of them,
 * which is what turns "unknown" into a durable fact rather than a comment.
 */
export function unresolvedActions(state: DeviceHandsState): readonly DeviceHandsActionRecord[] {
  return Object.values(state.actions).filter((action) => action.state !== 'settled')
}

/** Every action id this journal has consumed, including refused ones. */
export function consumedActionIds(state: DeviceHandsState): ReadonlySet<string> {
  return new Set(Object.keys(state.actions))
}

/** Whether an action may be described as complete, from the record alone. */
export function actionIsComplete(state: DeviceHandsState, actionId: string): boolean {
  const action = state.actions[actionId]
  if (action === undefined) return false
  if (action.state !== 'settled') return false
  return action.outcome === 'completed'
}

/** Every event type this phase may write. Exposed so a test cannot enumerate a subset. */
export function deviceHandsEventTypes(): readonly string[] {
  return DEVICE_HANDS_EVENT_TYPES
}

/** A refusal code, for the projection and a type-level assertion. */
export type { DeviceHandsRefusalCode }
