/**
 * Phase 43 — Browser Extension: the closed vocabularies.
 *
 * The browser extension is a *device*, not an authority. Everything in this folder
 * describes the wire protocol between a paired extension and the Freya host, and the
 * one rule that shapes all of it is:
 *
 * > The extension grants nothing. A paired extension with no capability grant can do
 * > nothing consequential. Every page-touching command still passes Guard, the
 * > Governor, STOP ALL and the Device Hands gate before a browser is reached.
 *
 * This module is pure data and pure predicates. It never imports `electron`, `react`,
 * the renderer `src/`, or a Node module, and `scripts/release-policy.mjs` enforces the
 * Core boundary on it like every other file under `core/`.
 *
 * The vocabulary is closed in three places on purpose:
 *
 *   - {@link BROWSER_BRIDGE_COMMANDS} — a command a client can invent is a command a
 *     host would have to handle. There is no free-form command.
 *   - {@link BROWSER_BRIDGE_REFUSAL_CODES} — a refusal code a caller can invent is
 *     decoration. Every refusal has exactly one owner and a sentence a person can act on.
 *   - {@link BROWSER_BRIDGE_LIMITS} — frozen ceilings, narrowed by the host and never
 *     widened by a message.
 */

/* ------------------------------------------------------------------ protocol */

/** The one protocol version this build speaks. A mismatch is refused, never negotiated down. */
export const BROWSER_BRIDGE_PROTOCOL = 1

/* ---------------------------------------------------------------- commands */

/**
 * The commands an authenticated extension session may send.
 *
 * Each names an *observation* or an *action*, never a capability. `page.share` and
 * `control.stop` are owner intents relayed by the extension; the host decides what they
 * mean and the extension can neither widen nor forge them.
 *
 * There is no `execute-script`, no `eval`, no `get-cookies`, no `get-storage`, no
 * `get-history`, no `screenshot`, no `download`, and no command that names a credential.
 * The absence is the guarantee, and `tests/red-team/browserext` asserts it.
 */
export const BROWSER_BRIDGE_COMMANDS = [
  'session.status',
  'tab.metadata',
  'page.share',
  'page.unshare',
  'selection.read',
  'page.read-text',
  'element.inspect',
  'element.click',
  'element.type-text',
  'page.navigate',
  'control.request',
  'control.revoke',
  'control.stop',
] as const
export type BrowserBridgeCommand = (typeof BROWSER_BRIDGE_COMMANDS)[number]

export function isBrowserBridgeCommand(value: unknown): value is BrowserBridgeCommand {
  return typeof value === 'string' && (BROWSER_BRIDGE_COMMANDS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------ capabilities */

/**
 * The bridge-level capabilities a session may hold.
 *
 * Deliberately separate from a Device Hands grant, and deliberately *narrower in
 * effect*: holding a bridge capability only means "the host will consider relaying this
 * command". The Device Hands grant gate still runs on the other side, so a session with
 * `element.click` and no grant is refused by Core, not by the bridge. Two independent
 * answers, and the stricter one wins.
 */
export const BROWSER_BRIDGE_CAPABILITIES = [
  'page.metadata',
  'page.share',
  'selection.read',
  'page.read-text',
  'element.inspect',
  'element.click',
  'element.type-text',
  'page.navigate',
  'control.request',
  'control.stop',
] as const
export type BrowserBridgeCapability = (typeof BROWSER_BRIDGE_CAPABILITIES)[number]

export function isBrowserBridgeCapability(value: unknown): value is BrowserBridgeCapability {
  return (
    typeof value === 'string' && (BROWSER_BRIDGE_CAPABILITIES as readonly string[]).includes(value)
  )
}

/** The capability a command requires. Total, so a new command cannot be added unclassified. */
export const BROWSER_BRIDGE_COMMAND_CAPABILITY: Readonly<
  Record<BrowserBridgeCommand, BrowserBridgeCapability>
> = Object.freeze({
  'session.status': 'page.metadata',
  'tab.metadata': 'page.metadata',
  'page.share': 'page.share',
  'page.unshare': 'page.share',
  'selection.read': 'selection.read',
  'page.read-text': 'page.read-text',
  'element.inspect': 'element.inspect',
  'element.click': 'element.click',
  'element.type-text': 'element.type-text',
  'page.navigate': 'page.navigate',
  'control.request': 'control.request',
  'control.revoke': 'control.request',
  'control.stop': 'control.stop',
})

/**
 * The observation-only capability set a freshly paired session starts with.
 *
 * Read-only, and the host may narrow it further. It is *not* "read anything": the
 * shared-tab check, the sensitive-URL check and the Device Hands grant still apply.
 */
export const BROWSER_BRIDGE_OBSERVATION_CAPABILITIES: readonly BrowserBridgeCapability[] =
  Object.freeze([
    'page.metadata',
    'page.share',
    'selection.read',
    'page.read-text',
    'element.inspect',
    'control.request',
    'control.stop',
  ])

/** The capabilities that let a session *act* on a page. Only the owner may enable these. */
export const BROWSER_BRIDGE_CONTROL_CAPABILITIES: readonly BrowserBridgeCapability[] = Object.freeze([
  'element.click',
  'element.type-text',
  'page.navigate',
])

/**
 * Which Device Hands browser action a bridge command maps to, when it maps to one.
 *
 * `null` means the command is an observation the host serves directly, and it is still
 * gated by the session capability, the shared tab, STOP ALL and the sensitive-URL policy.
 * Every non-null entry is the action the Device Hands gate will see, so the extension
 * cannot relabel a click as a read.
 */
export const BROWSER_BRIDGE_COMMAND_ACTION: Readonly<
  Record<BrowserBridgeCommand, string | null>
> = Object.freeze({
  'session.status': null,
  'tab.metadata': null,
  'page.share': null,
  'page.unshare': null,
  'selection.read': null,
  'page.read-text': 'browser.read-text',
  'element.inspect': 'browser.read-text',
  'element.click': 'browser.click',
  'element.type-text': 'browser.type-text',
  'page.navigate': 'browser.navigate',
  'control.request': null,
  'control.revoke': null,
  'control.stop': null,
})

/* ---------------------------------------------------------------- messages */

export interface BridgeHelloMessage {
  readonly kind: 'hello'
  readonly protocol: number
  readonly extensionId: string
  readonly extensionVersion: string
}

export interface BridgePairRequestMessage {
  readonly kind: 'pair.request'
  readonly pairingCode: string
  readonly extensionId: string
  readonly extensionVersion: string
}

export interface BridgeAuthRequestMessage {
  readonly kind: 'auth.request'
  readonly token: string
  readonly extensionId: string
  readonly clientNonce: string
}

export interface BridgeCommandMessage {
  readonly kind: 'command'
  readonly sessionId: string
  readonly seq: number
  readonly nonce: string
  readonly idempotencyKey: string
  readonly command: string
  readonly args: unknown
}

export interface BridgeEventMessage {
  readonly kind: 'event'
  readonly sessionId: string
  readonly seq: number
  readonly nonce: string
  readonly event: string
  readonly payload: unknown
}

export interface BridgeByeMessage {
  readonly kind: 'bye'
  readonly sessionId: string
}

export type BridgeInbound =
  | BridgeHelloMessage
  | BridgePairRequestMessage
  | BridgeAuthRequestMessage
  | BridgeCommandMessage
  | BridgeEventMessage
  | BridgeByeMessage

export interface BridgeServerHello {
  readonly kind: 'server.hello'
  readonly protocol: number
  readonly serverNonce: string
  readonly pairingOpen: boolean
}

export interface BridgePairOk {
  readonly kind: 'pair.ok'
  /** Shown once. The host stores only its hash and can never read it back. */
  readonly token: string
  readonly sessionId: string
  readonly expiresAt: number
  readonly capabilities: readonly BrowserBridgeCapability[]
  readonly protocol: number
}

export interface BridgeAuthOk {
  readonly kind: 'auth.ok'
  readonly sessionId: string
  readonly expiresAt: number
  readonly capabilities: readonly BrowserBridgeCapability[]
  readonly protocol: number
}

export interface BridgeCommandResult {
  readonly kind: 'command.result'
  readonly sessionId: string
  readonly idempotencyKey: string
  readonly ok: boolean
  readonly code: string | null
  readonly reason: string
  readonly result: unknown
}

export interface BridgeRefusal {
  readonly kind: 'refused'
  readonly code: BrowserBridgeRefusalCode
  readonly reason: string
  /** Present when the refusal is bound to a session (so a client can clear state). */
  readonly sessionId?: string
}

export type BridgeOutbound =
  | BridgeServerHello
  | BridgePairOk
  | BridgeAuthOk
  | BridgeCommandResult
  | BridgeRefusal

/* ------------------------------------------------------------ refusal codes */

export const BROWSER_BRIDGE_REFUSAL_CODES = [
  // transport / shape
  'protocol-mismatch',
  'malformed-message',
  'message-too-large',
  'internal-error',
  // pairing and identity
  'not-paired',
  'pairing-closed',
  'pairing-code-invalid',
  'pairing-expired',
  'pairing-attempts-exceeded',
  'token-invalid',
  'token-revoked',
  // session
  'session-missing',
  'session-expired',
  'session-revoked',
  'nonce-replayed',
  'sequence-out-of-order',
  'idempotency-conflict',
  // authority
  'capability-missing',
  'command-unknown',
  'payload-too-large',
  'payload-invalid',
  'authority-refused',
  'stopped',
  // page boundaries
  'origin-mismatch',
  'tab-mismatch',
  'tab-not-shared',
  'frame-refused',
  'not-top-frame',
  'cross-origin-frame',
  'sensitive-url',
  'protected-field',
  // host / extension availability
  'extension-not-connected',
  'host-unavailable',
] as const
export type BrowserBridgeRefusalCode = (typeof BROWSER_BRIDGE_REFUSAL_CODES)[number]

export function isBrowserBridgeRefusalCode(value: unknown): value is BrowserBridgeRefusalCode {
  return (
    typeof value === 'string' && (BROWSER_BRIDGE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

/** Why a code is a refusal, in words a person can act on. */
export const BROWSER_BRIDGE_REFUSAL_REASONS: Readonly<Record<BrowserBridgeRefusalCode, string>> =
  Object.freeze({
    'protocol-mismatch': 'the extension speaks a different bridge protocol than this host',
    'malformed-message': 'the message is not one this bridge can read, and it was not repaired',
    'message-too-large': 'the message is larger than the bridge accepts',
    'internal-error': 'the bridge failed in a way that is not a decision, so nothing was done',
    'not-paired': 'this extension is not paired with Freya, so nothing is relayed',
    'pairing-closed': 'Freya is not offering a pairing code right now',
    'pairing-code-invalid': 'that pairing code does not match the one Freya is showing',
    'pairing-expired': 'that pairing code has expired, so it is refused rather than extended',
    'pairing-attempts-exceeded': 'too many pairing attempts, so pairing is closed',
    'token-invalid': 'that pairing token is not one this host issued',
    'token-revoked': 'that pairing token was revoked, and a revoked token is never revived',
    'session-missing': 'there is no such session, so the command is refused',
    'session-expired': 'this session has expired, so it is refused rather than renewed',
    'session-revoked': 'this session was revoked, so it is refused',
    'nonce-replayed': 'that nonce has already been used, so the message is a replay',
    'sequence-out-of-order': 'that message arrived out of order, so it is refused',
    'idempotency-conflict': 'that idempotency key was already used for a different command',
    'capability-missing': 'this session does not hold the capability that command needs',
    'command-unknown': 'that command is not one this bridge routes',
    'payload-too-large': 'the command payload is larger than the bridge accepts',
    'payload-invalid': 'the command payload is not the shape that command needs',
    'authority-refused': 'Core refused the action behind this command; the bridge cannot override it',
    'stopped': 'STOP ALL is latched, so nothing runs',
    'origin-mismatch': 'the connection origin is not the paired extension',
    'tab-mismatch': 'that tab is not the one this session is bound to',
    'tab-not-shared': 'the owner has not shared that tab with this session',
    'frame-refused': 'that frame is not one this bridge will act in',
    'not-top-frame': 'only the top frame is acted on, because a subframe is not what the owner sees',
    'cross-origin-frame': 'a cross-origin frame is refused, because its content is a different origin',
    'sensitive-url': 'that page is a browser-internal, local or otherwise unsupported page',
    'protected-field': 'that field is a password, payment or authentication field, and is never touched',
    'extension-not-connected': 'the extension is not connected, so no page can be reached',
    'host-unavailable': 'the Freya host is not available to serve this command',
  })

/* ---------------------------------------------------------------- limits */

const MINUTE = 60_000

/** Frozen ceilings. A message may narrow these and never widen one. */
export const BROWSER_BRIDGE_LIMITS = Object.freeze({
  /** Bytes in one bridge message, measured after UTF-8 encoding. */
  maxMessageBytes: 64 * 1024,
  /** Bytes in one command's serialised arguments. */
  maxCommandArgsBytes: 8 * 1024,
  /** Bytes of page text one read may return. */
  maxPageTextBytes: 4 * 1024,
  /** Bytes of selected text one read may return. */
  maxSelectionBytes: 4 * 1024,
  /** Bytes a caller may type into one field. Matches the Device Hands ceiling. */
  maxTypedTextBytes: 512,
  /** Characters in a selector. */
  maxSelectorChars: 256,
  /** Characters in any id (session, command, idempotency key, nonce). */
  maxIdChars: 128,
  /** Distinct nonces remembered per session, so a replay window is bounded. */
  maxNonceWindow: 256,
  /** Idempotent command results remembered per session. */
  maxIdempotencyEntries: 64,
  /** Bytes retained in one audit detail line. */
  maxAuditDetailChars: 200,
  /** Pairing codes are short-lived on purpose. */
  pairingCodeTtlMs: 2 * MINUTE,
  /** Pairing attempts before the offer is closed. */
  pairingMaxAttempts: 5,
  /** How long a session may live. */
  sessionTtlMs: 30 * MINUTE,
  /** How long an auth nonce is remembered. */
  authNonceTtlMs: 5 * MINUTE,
})

/* ------------------------------------------------------------------- audit */

export const BROWSER_BRIDGE_AUDIT_EVENTS = [
  'bridge.opened',
  'bridge.closed',
  'pairing.opened',
  'pairing.succeeded',
  'pairing.refused',
  'auth.succeeded',
  'auth.refused',
  'session.opened',
  'session.closed',
  'session.revoked',
  'control.granted',
  'control.revoked',
  'command.received',
  'command.dispatched',
  'command.refused',
  'stop.requested',
  'message.rejected',
  'token.revoked',
] as const
export type BrowserBridgeAuditEvent = (typeof BROWSER_BRIDGE_AUDIT_EVENTS)[number]

/**
 * One audit line.
 *
 * Never carries page text, selection, a token, a pairing code or a field value. It
 * carries the *shape* of the decision: which command, which code, which session. An
 * audit trail that could carry a secret is a second place a secret lives.
 */
export interface BrowserBridgeAuditEntry {
  readonly at: number
  readonly event: BrowserBridgeAuditEvent
  readonly sessionId: string | null
  readonly extensionId: string | null
  readonly command: string | null
  readonly code: string | null
  readonly detail: string
}

/* ------------------------------------------------------------------ fields */

/**
 * The kinds of field the extension must never read from or write to.
 *
 * Enforced in the content script *and* re-checked by the bridge against the field
 * descriptor the extension reports, so a compromised content script cannot widen it by
 * lying about what it did.
 */
export const BROWSER_PROTECTED_FIELD_KINDS = [
  'password',
  'payment-card',
  'payment-cvc',
  'payment-expiry',
  'authentication',
  'hidden',
  'credential',
  'one-time-code',
] as const
export type BrowserProtectedFieldKind = (typeof BROWSER_PROTECTED_FIELD_KINDS)[number]

export function isBrowserProtectedFieldKind(value: unknown): value is BrowserProtectedFieldKind {
  return (
    typeof value === 'string' &&
    (BROWSER_PROTECTED_FIELD_KINDS as readonly string[]).includes(value)
  )
}
