/**
 * The extension's mirror of the bridge protocol.
 *
 * The extension build is separate from the Core build, so this is a deliberate copy of
 * the closed vocabularies rather than an import. The host re-validates everything, so a
 * drift here cannot widen what is allowed — it can only make the extension ask for
 * something the host refuses.
 */

export const BRIDGE_PROTOCOL = 1

export const BRIDGE_COMMANDS = [
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
export type BridgeCommand = (typeof BRIDGE_COMMANDS)[number]

export const BRIDGE_EVENTS = [
  'session.heartbeat',
  'tab.updated',
  'tab.removed',
  'page.navigated',
  'page.reloaded',
] as const
export type BridgeEvent = (typeof BRIDGE_EVENTS)[number]

export interface ServerHello {
  readonly kind: 'server.hello'
  readonly protocol: number
  readonly serverNonce: string
  readonly pairingOpen: boolean
}

export interface PairOk {
  readonly kind: 'pair.ok'
  readonly token: string
  readonly sessionId: string
  readonly expiresAt: number
  readonly capabilities: readonly string[]
  readonly protocol: number
}

export interface AuthOk {
  readonly kind: 'auth.ok'
  readonly sessionId: string
  readonly expiresAt: number
  readonly capabilities: readonly string[]
  readonly protocol: number
}

export interface CommandResult {
  readonly kind: 'command.result'
  readonly sessionId: string
  readonly idempotencyKey: string
  readonly ok: boolean
  readonly code: string | null
  readonly reason: string
  readonly result: unknown
}

export interface Refusal {
  readonly kind: 'refused'
  readonly code: string
  readonly reason: string
  readonly sessionId?: string
}

export type ServerMessage = ServerHello | PairOk | AuthOk | CommandResult | Refusal

export interface HostRequest {
  readonly kind: 'request'
  readonly requestId: string
  readonly command: BridgeCommand
  readonly args: Readonly<Record<string, unknown>>
  readonly tabId: number | null
  readonly frameId: number
  readonly url: string | null
  readonly deadlineAt: number
}

export interface HostResponse {
  readonly kind: 'response'
  readonly requestId: string
  readonly ok: boolean
  readonly code: string
  readonly reason: string
  readonly result: unknown
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const kind = (value as { kind?: unknown }).kind
  return (
    kind === 'server.hello' ||
    kind === 'pair.ok' ||
    kind === 'auth.ok' ||
    kind === 'command.result' ||
    kind === 'refused'
  )
}

export function isHostRequest(value: unknown): value is HostRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return raw.kind === 'request' && typeof raw.requestId === 'string'
}
