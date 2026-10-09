/**
 * The external control protocol.
 *
 * Versioned, narrow, and deliberately the only shape that crosses the named pipe
 * (or, on POSIX, the Unix socket). A renderer sees nothing here, and an unknown
 * method on the wire is a safe error rather than a way to learn what the host
 * happens to expose.
 *
 * Three groups of methods:
 *
 *   - read: `protocol.version`, `freya.status`, `freya.health`, `conversation.list`,
 *     `conversation.get`, `browser.status`, `browser.tabs`, `mission.list`,
 *     `mission.get`, `agent.list`, `system.stopStatus`.
 *   - action: `conversation.create`, `conversation.send`, `browser.open`,
 *     `browser.activate`, `notification.send`. Each one routes through the same
 *     Core / Browser / Voice authority the renderer would, with the same
 *     STOP-ALL gate and the same approval rules.
 *   - wait / event: `event.subscribe`, `event.unsubscribe`, `wait`.
 *
 * No method accepts a Core command string. A caller that knows the Core protocol
 * vocabulary is not the audience for this surface; the methods here are the whole
 * vocabulary, and adding more is a code change rather than a wire change.
 */

export const PROTOCOL_VERSION = '1' as const

export type ControlErrorCode =
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'TOKEN_MISMATCH'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'STOP_ALL_ACTIVE'
  | 'APPROVAL_REQUIRED'
  | 'BROWSE_DENIED'
  | 'INTERNAL'
  | 'BUSY'
  | 'TIMEOUT'

export interface ControlError {
  readonly code: ControlErrorCode
  readonly message: string
  /** Optional stable detail code, e.g. a BrowserServiceCode. */
  readonly detail?: string
}

export type ControlId = string

export type ControlRequest = {
  readonly jsonrpc: '2.0'
  readonly id: ControlId
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
}

export type ControlResponse =
  | { readonly jsonrpc: '2.0'; readonly id: ControlId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: ControlId; readonly error: ControlError }

export type ControlEvent = {
  readonly jsonrpc: '2.0'
  readonly method: 'event'
  readonly params: {
    readonly topic: string
    readonly payload: unknown
    readonly at: string
  }
}

/** Identity the caller supplies for attribution. Audit metadata, not authority. */
export interface CallerIdentity {
  readonly kind: 'cli' | 'mcp' | 'script' | 'unspecified'
  readonly client?: string
  readonly sessionId?: string
}

export const READ_METHODS = new Set<string>([
  'protocol.version',
  'freya.status',
  'freya.health',
  'freya.focus',
  'conversation.list',
  'conversation.get',
  'browser.status',
  'browser.tabs',
  'browser.screenshot',
  'mission.list',
  'mission.get',
  'agent.list',
  'system.stopStatus',
])

export const ACTION_METHODS = new Set<string>([
  'conversation.create',
  'conversation.send',
  'browser.open',
  'browser.activate',
  'notification.send',
])

export const WAIT_METHODS = new Set<string>([
  'event.subscribe',
  'event.unsubscribe',
  'wait',
])

export const ALL_METHODS = new Set<string>([
  ...READ_METHODS,
  ...ACTION_METHODS,
  ...WAIT_METHODS,
])

/**
 * The largest single JSON payload the control plane will accept.
 *
 * Sized to be larger than any sensible CLI request and smaller than anything that
 * could be used to flood the pipe. 256 KiB is enough for a long chat message and
 * not enough to be a memory-pressure vector on the host.
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024
