import {
  DEVICE_HANDS_LIMITS,
  DEVICE_HANDS_GATES,
  DEVICE_HANDS_PROBE_GATES,
  type DeviceHandsProbeGate,
  isDeviceHandsActionKey,
  isDeviceHandsSurface,
  isForbiddenDeviceHandsAction,
  CAPTURE_ACTIONS,
  CREDENTIAL_ACTIONS,
  PHYSICAL_WORLD_ACTIONS,
  AUTHORITY_ACTIONS,
  FORBIDDEN_DEVICE_HANDS_ACTIONS,
  type DeviceHandsActionKey,
  type DeviceHandsApprovalRecord,
  type DeviceHandsApprovalSubject,
  type DeviceHandsGate,
  type DeviceHandsGrantRecord,
  type DeviceHandsRefusalCode,
} from './types'
import type { SurfacePolicy } from './paths'
import { policyMatchesDigest } from './paths'
import { readTerminalCommand, commandCanonicalForm, type TerminalCommand } from './commands'
import { checkClipboardText, clipboardCanonicalForm, clipboardDigest, type ClipboardDirection } from './clipboard'
import {
  readTransferRequest,
  transferCanonicalForm,
  type TransferDirection,
  type TransferTarget,
} from './transfer'
import { checkUrl } from './paths'
import { approvalCovers, isExpired } from './approvals'
import { canonicalDigest } from './digest'
import { deviceHandsApprovalRequired } from './types'

/**
 * The gate pipeline: the wall every action passes before a port is called.
 *
 * The loop is the point. {@link DEVICE_HANDS_GATES} is walked with a `for`, so "no
 * gate is ever skipped" is a property of the iteration rather than of how carefully
 * ten `if`s were written down. Adding a gate means adding a name to the tuple and a
 * `case` here; there is no third place to update and no way to add one that is not
 * walked.
 *
 * The decision reports `evaluated` and `remaining`, which makes the ordering
 * *testable* rather than merely claimed: an action that passes everything evaluates
 * all ten gates; one that fails gate *k* evaluates exactly 1..k and names *k*.
 *
 * Pure. No clock, no journal, no port, no authority, no `node:fs`. The instant
 * arrives on the request.
 */

/* ------------------------------------------------------------------ requests */

/** A selector, bounded and printable. No metacharacters, no newlines, no length games. */
const SELECTOR_PATTERN = /^[\p{L}\p{N}#._\-[\]="':, ]{1,256}$/u

/**
 * Tokens a selector may not contain, whatever the charset allows.
 *
 * The charset rule above is about *shape*: printable, bounded, no newlines. This is about
 * *content*, and the two are not the same. `a[href="javascript:1"]` is printable and
 * well-formed and is still a selector naming a script URL; `a[onclick=alert(1)]` names
 * an inline handler. Neither is needed to find an element on a page, so both are refused
 * — a locator that cannot express a script is a locator that cannot ask for one.
 */
export const FORBIDDEN_SELECTOR_TOKENS: readonly string[] = Object.freeze([
  'javascript:',
  'data:',
  'vbscript:',
  'expression(',
  'onerror=',
  'onload=',
  'onclick=',
  'onmouseover=',
  'onfocus=',
  '<script',
  '{{',
])

/** The untrusted input for each surface, read from the envelope. */
export interface DeviceHandsActionRequest {
  readonly actionId: string
  readonly principalId: string
  readonly scope: string
  readonly actionKey: DeviceHandsActionKey
  /**
   * An untrusted claim about which forbidden action this is.
   *
   * Never trusted in either direction: a claim of something forbidden is refused with
   * that specific code, and a claim of something harmless does not buy a shortcut past
   * any other gate. It exists so the *reason* is legible, not so the gate can be
   * skipped by a caller who asserts the action is fine.
   */
  readonly claimsAction: string | null
  readonly input: Readonly<Record<string, unknown>>
  readonly deadlineAt: string
  readonly at: string
}

/** What a policy-checked action looks like, once the gates have agreed. */
export type PreparedAction =
  | {
      readonly kind: 'browser'
      readonly key: 'browser.navigate' | 'browser.read-text' | 'browser.click' | 'browser.type-text'
      readonly url: string
      readonly selector: string | null
      readonly text: string | null
    }
  | { readonly kind: 'terminal'; readonly key: 'terminal.run'; readonly command: TerminalCommand }
  | {
      readonly kind: 'clipboard'
      readonly key: 'clipboard.read' | 'clipboard.write' | 'clipboard.clear'
      readonly direction: ClipboardDirection
      readonly text: string | null
    }
  | {
      readonly kind: 'transfer'
      readonly key: 'transfer.download' | 'transfer.upload'
      readonly target: TransferTarget
    }

export interface DeviceHandsGateContext {
  /** Local development: bypass grant/approval/allowlist/budget friction. */
  readonly localUnrestricted?: boolean
  readonly enabled: boolean
  readonly journalTrustworthy: boolean
  readonly stopped: boolean
  /** The loaded policy, or null when none is loaded — which is a refusal. */
  readonly policy: SurfacePolicy | null
  /** The digest the journal recorded, or null on a session that has written none. */
  readonly policyDigest: string | null
  /** Action ids already used. Kept across restarts by the fold. */
  readonly seenActionIds: ReadonlySet<string>
  readonly grant: DeviceHandsGrantRecord | null
  readonly approvals: readonly DeviceHandsApprovalRecord[]
  readonly actionCountThisSession: number
  readonly transferCountThisSession: number
  readonly bytesThisSession: number
  readonly inFlightActions: number
}

export interface GateDecision {
  readonly allowed: boolean
  readonly refusedAt: DeviceHandsGate | null
  readonly code: DeviceHandsRefusalCode | null
  readonly reason: string
  readonly evaluated: readonly DeviceHandsGate[]
  readonly remaining: readonly DeviceHandsGate[]
  /** The normalised, policy-checked action. Null whenever `allowed` is false. */
  readonly prepared: PreparedAction | null
  /** The approval subject, when this action needs an approval. */
  readonly subject: DeviceHandsApprovalSubject | null
  readonly approvalRequired: boolean
  /** How many bytes this action would move, for the budget gate to have consulted. */
  readonly projectedBytes: number
}

/* --------------------------------------------------------------- probe gates */

export interface ProbeDecision {
  readonly allowed: boolean
  readonly refusedAt: DeviceHandsProbeGate | null
  readonly code: DeviceHandsRefusalCode | null
  readonly reason: string
  readonly evaluated: readonly DeviceHandsProbeGate[]
  /** Every gate not reached because an earlier one refused. */
  readonly remaining: readonly DeviceHandsProbeGate[]
}

/**
 * May this surface be probed right now?
 *
 * Deliberately *not* `authoriseDeviceAction` with the grant set to null: probing must
 * be possible for a caller who holds no capability, because the question "does this
 * machine have a clipboard at all?" is exactly the question somebody asks *before*
 * they have any authority. What a probe may never do is grow.
 */
export function authoriseDeviceProbe(input: {
  readonly enabled: boolean
  readonly journalTrustworthy: boolean
  readonly stopped: boolean
  readonly surface: string
}): ProbeDecision {
  const evaluated: DeviceHandsProbeGate[] = []
  const refuse = (
    gate: DeviceHandsProbeGate,
    code: DeviceHandsRefusalCode,
    reason: string,
  ): ProbeDecision => ({
    allowed: false,
    refusedAt: gate,
    code,
    reason,
    evaluated,
    remaining: DEVICE_HANDS_PROBE_GATES.slice(
      DEVICE_HANDS_PROBE_GATES.indexOf(gate) + 1,
    ),
  })

  for (const gate of DEVICE_HANDS_PROBE_GATES) {
    evaluated.push(gate)
    switch (gate) {
      case 'journal-trustworthy':
        if (!input.journalTrustworthy) {
          return refuse(
            gate,
            'journal-untrustworthy',
            'The action journal cannot be believed, so nothing is even inspected.',
          )
        }
        continue
      case 'stop-all':
        if (input.stopped) {
          return refuse(gate, 'stop-all-latched', 'STOP ALL is latched, so not even a probe runs.')
        }
        continue
      case 'enabled':
        if (!input.enabled) {
          return refuse(gate, 'subsystem-disabled', 'Device Hands is switched off, so nothing is inspected.')
        }
        continue
      case 'surface':
        if (!isDeviceHandsSurface(input.surface)) {
          return refuse(
            gate,
            'surface-unknown',
            `"${input.surface}" is not a surface this build routes.`,
          )
        }
        continue
    }
  }

  return {
    allowed: true,
    refusedAt: null,
    code: null,
    reason: 'A probe may inspect a surface. It may not use one, and it grants nothing.',
    evaluated,
    remaining: [],
  }
}

/* -------------------------------------------------------------- claim checks */

/**
 * The specific code for an untrusted claim of a forbidden action.
 *
 * Grouped rather than one code for everything, because "that action is forbidden
 * outright" is not an explanation a person can act on when what was refused was a
 * request to read the Vault. The Vault, the credential stores, capture, the physical
 * world and authority-widening are five different mistakes and get five different
 * sentences.
 */
export function forbiddenClaimCode(claim: string): DeviceHandsRefusalCode | null {
  if (!isForbiddenDeviceHandsAction(claim)) return null
  if ((CREDENTIAL_ACTIONS as readonly string[]).includes(claim)) return 'vault-path-denied'
  if ((CAPTURE_ACTIONS as readonly string[]).includes(claim)) return 'capture-denied'
  if ((PHYSICAL_WORLD_ACTIONS as readonly string[]).includes(claim)) return 'physical-world-denied'
  if ((AUTHORITY_ACTIONS as readonly string[]).includes(claim)) return 'authority-widening-refused'
  return 'forbidden-action'
}

function forbiddenClaimReason(claim: string, code: DeviceHandsRefusalCode): string {
  switch (code) {
    case 'vault-path-denied':
      return `"${claim}" names Freya protected state or an operating-system credential store. There is no grant, setting, approval or sequence of requests that reaches it from here.`
    case 'credential-store-denied':
      return `"${claim}" names a credential store. Device Hands reads and writes none.`
    case 'capture-denied':
      return `"${claim}" names a capture. Phase 35 has no screen, window, display or image capture capability and will not grow one.`
    case 'physical-world-denied':
      return `"${claim}" names a physical-world device. Phase 35 adds no camera, sensor or physical-world capability of any kind.`
    case 'authority-widening-refused':
      return `"${claim}" would widen, mint or clear an authority. Nothing in this phase can grant, widen or clear anything; that is the Guard's and the Governor's alone.`
    default:
      return `"${claim}" is forbidden outright. No setting, grant or approval in this build can permit it.`
  }
}

/* ------------------------------------------------------------------ the loop */

interface GateRefusal {
  readonly code: DeviceHandsRefusalCode
  readonly reason: string
  readonly prepared?: PreparedAction | null
  readonly projectedBytes?: number
}

/**
 * Walk every gate in order and refuse on the first that does not hold.
 *
 * Pure and total: every path returns a decision, and a decision either names the gate
 * that refused or says every gate held and carries the normalised action.
 */
export function authoriseDeviceAction(
  context: DeviceHandsGateContext,
  request: DeviceHandsActionRequest,
): GateDecision {
  const evaluated: DeviceHandsGate[] = []
  let prepared: PreparedAction | null = null
  let projectedBytes = 0

  const done = (): GateDecision => {
    const subject = buildSubject(request.actionKey, prepared, request.actionId)
    return {
      allowed: true,
      refusedAt: null,
      code: null,
      reason: 'Every gate held: journal, STOP ALL, enabled, replay, surface, grant, deadline, budget, policy and approval.',
      evaluated,
      remaining: [],
      prepared,
      subject,
      approvalRequired: context.localUnrestricted ? false : deviceHandsApprovalRequired(request.actionKey),
      projectedBytes,
    }
  }

  const refuse = (gate: DeviceHandsGate, refusal: GateRefusal): GateDecision => ({
    allowed: false,
    refusedAt: gate,
    code: refusal.code,
    reason: refusal.reason,
    evaluated,
    remaining: DEVICE_HANDS_GATES.slice(DEVICE_HANDS_GATES.indexOf(gate) + 1),
    prepared: null,
    // The subject is returned even on refusal so the caller can *ask the owner about
    // this exact action*. It is the digest of a normalised action, so it cannot be
    // used to smuggle a different body past the approval gate later.
    subject: prepared === null ? null : buildSubject(request.actionKey, prepared, request.actionId),
    approvalRequired: context.localUnrestricted ? false : deviceHandsApprovalRequired(request.actionKey),
    projectedBytes,
  })

  for (const gate of DEVICE_HANDS_GATES) {
    evaluated.push(gate)
    const refusal = evaluateGate(
      gate,
      context,
      request,
      (value) => {
        prepared = value
      },
      () => prepared,
      (bytes) => {
        projectedBytes = bytes
      },
      () => projectedBytes,
    )
    if (refusal !== null) return refuse(gate, refusal)
  }

  return done()
}

type SetPrepared = (value: PreparedAction) => void
type GetPrepared = () => PreparedAction | null
type SetBytes = (value: number) => void
type GetBytes = () => number

function evaluateGate(
  gate: DeviceHandsGate,
  context: DeviceHandsGateContext,
  request: DeviceHandsActionRequest,
  setPrepared: SetPrepared,
  getPrepared: GetPrepared,
  setBytes: SetBytes,
  getBytes: GetBytes,
): GateRefusal | null {
  switch (gate) {
    /* ------------------------------------------------ 1. the record is readable */
    case 'journal-trustworthy':
      if (!context.journalTrustworthy) {
        return {
          code: 'journal-untrustworthy',
          reason:
            'The action journal cannot be believed, so nothing new is acted on. An unreadable record is not a foundation to build on.',
        }
      }
      return null

    /* ------------------------------------------------------------ 2. the latch */
    case 'stop-all':
      if (context.stopped) {
        return {
          code: 'stop-all-latched',
          reason:
            'STOP ALL is latched. Nothing runs — including the checks that would have said this action was allowed.',
        }
      }
      return null

    /* ------------------------------------------------------------- 3. the switch */
    case 'enabled':
      if (!context.enabled) {
        return {
          code: 'subsystem-disabled',
          reason: 'Device Hands is switched off, so every action is refused.',
        }
      }
      return null

    /* ------------------------------------------------------------- 4. idempotence */
    case 'replay': {
      if (context.seenActionIds.has(request.actionId)) {
        return {
          code: 'replay-detected',
          reason: `Action "${request.actionId}" has already been used. A retry is a new id with a new approval, not a second run of the old one.`,
        }
      }
      if (!context.localUnrestricted && context.inFlightActions >= DEVICE_HANDS_LIMITS.maxInFlightActions) {
        return {
          code: 'budget-exceeded',
          reason: `${String(context.inFlightActions)} actions are already in flight, which is the ceiling.`,
        }
      }
      return null
    }

    /* ---------------------------------------------------- 5. is this a thing */
    case 'surface': {
      if (!isDeviceHandsActionKey(request.actionKey)) {
        return { code: 'action-unknown', reason: `"${request.actionKey}" is not an action this build routes.` }
      }
      if (typeof request.actionId !== 'string' || request.actionId.length === 0 || request.actionId.length > 128) {
        return { code: 'request-malformed', reason: 'An action needs an id of at most 128 characters.' }
      }
      if (!context.localUnrestricted && request.claimsAction !== null) {
        const code = forbiddenClaimCode(request.claimsAction)
        if (code !== null) {
          return { code, reason: forbiddenClaimReason(request.claimsAction, code) }
        }
      }
      return null
    }

    /* ------------------------------------------------------------- 6. the grant */
    case 'grant': {
      if (context.localUnrestricted) return null
      const grant = context.grant
      if (grant === null) {
        return { code: 'grant-missing', reason: 'No grant covers this action. Possession of nothing is not a permission.' }
      }
      if (grant.revokedAt !== null) {
        return { code: 'grant-revoked', reason: 'The grant covering this action was revoked.' }
      }
      if (isExpired(grant.expiresAt, request.at)) {
        return { code: 'grant-expired', reason: `The grant covering this action expired at ${grant.expiresAt}.` }
      }
      if (grant.principalId !== request.principalId || grant.scope !== request.scope) {
        return {
          code: 'grant-missing',
          reason:
            'The grant was issued to a different principal or a different scope, so it covers nothing this request asks for.',
        }
      }
      const surface = request.actionKey.slice(0, request.actionKey.indexOf('.'))
      if (!(grant.surfaces as readonly string[]).includes(surface)) {
        return {
          code: 'grant-surface-mismatch',
          reason: `The grant does not cover the "${surface}" surface.`,
        }
      }
      if (!grant.actions.includes(request.actionKey)) {
        return {
          code: 'grant-action-mismatch',
          reason: `The grant does not cover ${request.actionKey}. A grant is a list of action keys, and this is not one of them.`,
        }
      }
      return null
    }

    /* ---------------------------------------------------------- 7. the time bound */
    case 'deadline': {
      const deadline = Date.parse(request.deadlineAt)
      const at = Date.parse(request.at)
      if (!Number.isFinite(deadline) || !Number.isFinite(at)) {
        return {
          code: 'request-malformed',
          reason: 'An action needs an absolute deadline and an absolute instant, and both must be readable.',
        }
      }
      if (at >= deadline) {
        return { code: 'deadline-expired', reason: `The deadline for this action was ${request.deadlineAt}.` }
      }
      // A deadline *beyond* the ceiling is refused rather than clamped: a caller asking
      // for an hour has asked for something this build does not do, and silently
      // shortening it would leave the owner believing they approved a longer window.
      if (!context.localUnrestricted && deadline - at > DEVICE_HANDS_LIMITS.maxActionTimeoutMs) {
        return {
          code: 'deadline-expired',
          reason: `A single action may occupy at most ${String(DEVICE_HANDS_LIMITS.maxActionTimeoutMs / 1000)} seconds, and this one was given ${String(deadline - at)} milliseconds.`,
        }
      }
      return null
    }

    /* ---------------------------------------------------------- 8. the ceilings */
    case 'budget': {
      if (context.localUnrestricted) return null
      if (context.actionCountThisSession >= DEVICE_HANDS_LIMITS.maxActionsPerSession) {
        return {
          code: 'action-count-exceeded',
          reason: `This session has already recorded ${String(context.actionCountThisSession)} actions, which is the ceiling.`,
        }
      }
      return null
    }

    /* ------------------------------------------------------------ 9. the policy */
    case 'policy': {
      const policy = context.policy
      if (policy === null) {
        return {
          code: 'policy-missing',
          reason:
            'No surface policy is loaded, so no path, command or URL can be judged. A session with no policy refuses every action.',
        }
      }
      if (!context.localUnrestricted && context.policyDigest !== null && !policyMatchesDigest(policy, context.policyDigest)) {
        return {
          code: 'policy-mismatch',
          reason:
            'The loaded surface policy is not the one this journal recorded. A restart cannot come back with a wider policy than the one on the record.',
        }
      }
      const refusal = applyPolicy(policy, request, setPrepared, setBytes)
      if (refusal !== null) return refusal
      // The transfer ceilings are session-cumulative, so they are checked here rather
      // than in `readTransferRequest`, which only knows about one transfer.
      if (!context.localUnrestricted && request.actionKey.startsWith('transfer.')) {
        if (context.transferCountThisSession >= DEVICE_HANDS_LIMITS.maxTransfersPerSession) {
          return {
            code: 'transfer-count-exceeded',
            reason: `This session has already performed ${String(context.transferCountThisSession)} transfers, which is the ceiling.`,
          }
        }
        const projected = context.bytesThisSession + getBytes()
        if (projected > DEVICE_HANDS_LIMITS.maxTransferBytesPerSession) {
          return {
            code: 'transfer-byte-ceiling',
            reason: `This transfer would bring the session to ${String(projected)} bytes, past the session ceiling of ${String(DEVICE_HANDS_LIMITS.maxTransferBytesPerSession)}.`,
          }
        }
      }
      return null
    }

    /* ----------------------------------------------------------- 10. the person */
    case 'approval': {
      const approved = getPrepared()
      if (approved === null) {
        // Unreachable: the policy gate always sets the prepared action or refuses.
        // Stated rather than assumed, because a gate that ran with nothing prepared would
        // be approving an action nobody has described.
        return {
          code: 'request-malformed',
          reason: 'The approval gate was reached with no normalised action to approve.',
        }
      }
      if (context.localUnrestricted || !deviceHandsApprovalRequired(request.actionKey)) return null
      const subject = buildSubject(request.actionKey, approved, request.actionId)
      const verdict = approvalCovers(context.approvals, subject, request.at)
      if (!verdict.satisfied) {
        return { code: verdict.code ?? 'approval-missing', reason: verdict.reason }
      }
      return null
    }
  }

  // Unreachable: `DEVICE_HANDS_GATES` is exhaustive over `DeviceHandsGate`, and the
  // switch above covers every member. Present so a future gate added to the tuple
  // without a case fails to type-check rather than silently allowing the action.
  return { code: 'request-malformed', reason: 'This gate is not implemented, so the action is refused.' }
}

/* ------------------------------------------------------------- policy per surface */

export type NormalisationReading =
  | { readonly ok: true; readonly prepared: PreparedAction; readonly projectedBytes: number }
  | { readonly ok: false; readonly code: DeviceHandsRefusalCode; readonly reason: string }

/**
 * Run one surface's own rules, producing the normalised action.
 *
 * Exported, not private, for one concrete reason: an approval has to be bound to the
 * digest of the *normalised* body, and the only honest way to get that digest before the
 * action runs is to normalise it with the same function the gate will use. A second
 * implementation of "what would this action do" is a second answer to that question, and
 * two answers is how an approval ends up bound to something that never runs.
 *
 * Returns the byte count too, so a caller cannot compute the transfer ceiling from a
 * different number than the gate refused on.
 */
export function normaliseDeviceAction(
  policy: SurfacePolicy,
  actionKey: DeviceHandsActionKey,
  input: Readonly<Record<string, unknown>>,
): NormalisationReading {
  const request = { actionKey, input } as unknown as DeviceHandsActionRequest
  let prepared: PreparedAction | null = null
  let projectedBytes = 0
  const refusal = applyPolicy(
    policy,
    request,
    (value) => {
      prepared = value
    },
    (bytes) => {
      projectedBytes = bytes
    },
  )
  if (refusal !== null) return { ok: false, code: refusal.code, reason: refusal.reason }
  /* istanbul ignore next -- applyPolicy always sets `prepared` or returns a refusal. */
  if (prepared === null) {
    return { ok: false, code: 'action-unknown', reason: 'That action has no policy, so it is refused.' }
  }
  return { ok: true, prepared, projectedBytes }
}

/**
 * Apply the surface policy to the request in hand.
 *
 * Internal to {@link normaliseDeviceAction}; the callback pair is how the action and its
 * byte count escape, and a callback rather than a return value so the two cannot drift
 * out of step.
 */
function applyPolicy(
  policy: SurfacePolicy,
  request: DeviceHandsActionRequest,
  setPrepared: SetPrepared,
  setBytes: SetBytes,
): GateRefusal | null {
  const key = request.actionKey
  const input = request.input

  switch (key) {
    case 'browser.navigate':
    case 'browser.read-text':
    case 'browser.click':
    case 'browser.type-text': {
      const url = checkUrl(input.url, policy)
      if (!url.ok) return { code: url.code, reason: url.reason }
      let selector: string | null = null
      let text: string | null = null
      if (key === 'browser.click' || key === 'browser.type-text') {
        if (typeof input.selector !== 'string' || !SELECTOR_PATTERN.test(input.selector)) {
          return {
            code: 'request-malformed',
            reason:
              'That action needs a selector of at most 256 printable characters. A selector is a locator, not a script.',
          }
        }
        const lowered = input.selector.toLowerCase()
        const token = FORBIDDEN_SELECTOR_TOKENS.find((candidate) => lowered.includes(candidate))
        if (token !== undefined) {
          return {
            code: 'request-malformed',
            reason: `That selector contains "${token}". A locator may not name a script URL or an inline handler; nothing on a page needs one to be found.`,
          }
        }
        selector = input.selector
      }
      if (key === 'browser.type-text') {
        if (typeof input.text !== 'string' || input.text.length === 0) {
          return { code: 'request-malformed', reason: 'Typing needs text to type.' }
        }
        const bytes = new TextEncoder().encode(input.text).length
        if (bytes > DEVICE_HANDS_LIMITS.maxTypedTextBytes) {
          return {
            code: 'request-malformed',
            reason: `Typed text is capped at ${String(DEVICE_HANDS_LIMITS.maxTypedTextBytes)} bytes.`,
          }
        }
        for (let index = 0; index < input.text.length; index += 1) {
          const code = input.text.charCodeAt(index)
          if (code < 32 || code === 127) {
            return {
              code: 'request-malformed',
              reason: 'Typed text may not contain a control character. A string with an invisible byte in it cannot be verified by the person reading the audit.',
            }
          }
        }
        text = input.text
      }
      setPrepared({ kind: 'browser', key, url: url.url, selector, text })
      return null
    }

    case 'terminal.run': {
      const reading = readTerminalCommand(
        { command: input.command, args: input.args, workingDirectory: input.workingDirectory, env: input.env },
        policy,
      )
      if (!reading.ok) return { code: reading.code, reason: reading.reason }
      setPrepared({ kind: 'terminal', key, command: reading.command })
      return null
    }

    case 'clipboard.read':
    case 'clipboard.write': {
      const direction: ClipboardDirection = key === 'clipboard.read' ? 'in' : 'out'
      if (key === 'clipboard.read') {
        // Nothing to validate yet: the content arrives from the port and is judged by
        // `checkClipboardText` afterwards. What is checked here is that the caller did
        // not *supply* content for a read, which would mean the audit is about
        // something other than what is actually on the clipboard.
        if (input.text !== undefined) {
          return {
            code: 'request-malformed',
            reason: 'A clipboard read takes no text. It reads the clipboard and the audit records what was there, not what was asked for.',
          }
        }
        setPrepared({ kind: 'clipboard', key, direction, text: null })
        return null
      }
      const reading = checkClipboardText(input.text, direction)
      if (!reading.ok) return { code: reading.code, reason: reading.reason }
      setPrepared({ kind: 'clipboard', key, direction, text: reading.text })
      return null
    }

    case 'clipboard.clear': {
      setPrepared({ kind: 'clipboard', key, direction: 'out', text: null })
      return null
    }

    case 'transfer.download':
    case 'transfer.upload': {
      const direction: TransferDirection =
        key === 'transfer.download' ? 'download' : 'upload'
      const reading = readTransferRequest(input, direction, policy)
      if (!reading.ok) return { code: reading.code, reason: reading.reason }
      setBytes(reading.target.bytes)
      setPrepared({ kind: 'transfer', key, target: reading.target })
      return null
    }
  }

  // Unreachable while `DeviceHandsActionKey` and this switch agree. Present so a new
  // action that is added to the vocabulary without a policy fails to type-check here
  // rather than being silently permitted with no normalisation at all.
  return { code: 'action-unknown', reason: 'That action has no policy, so it is refused.' }
}

/* ------------------------------------------------------------------- subjects */

/**
 * The exact body an approval is bound to.
 *
 * Every field that would change what the action does is in the digest. Two requests
 * that differ anywhere that matters produce different digests, and an approval covers
 * exactly one of them. The `actionId` is in there too, so an approval cannot be
 * replayed under a second id even for an identical body — a replay is a new
 * authorisation question, and that is what "a retry is a new id" means in practice.
 */
export function buildSubject(
  actionKey: DeviceHandsActionKey,
  prepared: PreparedAction | null,
  actionId: string,
): DeviceHandsApprovalSubject {
  return {
    actionKey,
    subjectRef: actionId,
    digest: canonicalDigest([actionId, actionKey, ...canonicalParts(prepared)]),
  }
}

function canonicalParts(prepared: PreparedAction | null): string[] {
  if (prepared === null) return ['unprepared']
  switch (prepared.kind) {
    case 'browser':
      return [
        prepared.url,
        prepared.selector ?? '',
        prepared.text === null ? '' : `${String(prepared.text.length)}:${String(prepared.text)}`,
      ]
    case 'terminal':
      return commandCanonicalForm(prepared.command)
    case 'clipboard':
      // The content, not its length: an approval for pasting one address is not
      // permission to paste a different one. The runtime hashes this and journals
      // only the digest, so the journal never becomes a place the text is stored.
      return prepared.text === null ? ['clear'] : clipboardCanonicalForm(prepared.text)
    case 'transfer':
      return transferCanonicalForm(prepared.target)
  }
}

/** The digest an approval request must carry for this action. Exposed for the runtime. */
export function subjectDigest(subject: DeviceHandsApprovalSubject): string {
  return subject.digest
}

/** Re-exported so the runtime can hash clipboard content for the journal. */
export { clipboardDigest }

/** Every forbidden action, for an exhaustive audit and a suite to iterate. */
export function forbiddenActions(): readonly string[] {
  return FORBIDDEN_DEVICE_HANDS_ACTIONS
}