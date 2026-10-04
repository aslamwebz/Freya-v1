import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createBrowserBridge,
  type BrowserBridge,
  type BrowserBridgeCapability,
  type BrowserBridgePorts,
  type BridgeCrypto,
  type BridgeDispatchRequest,
  type BridgeDispatchResult,
  type BridgeOutbound,
} from '../../../core/browserext'

/**
 * A Core-free harness for the browser bridge.
 *
 * It reaches no socket, no browser and no page: the `dispatch` port counts its calls
 * and returns a scripted answer, so a refusal is proved by a counter that did not move.
 * The crypto is real (Node's) so the pairing and token hashes are the ones production
 * uses, but the clock is a mutable literal so "after the TTL" means exactly that.
 */

export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
export const ORIGIN = `chrome-extension://${EXT_ID}`
export const CONNECTION = 'conn-1'
export const T0 = 1_800_000_000_000

export function makeCrypto(): BridgeCrypto {
  return {
    randomBytes: (bytes) => new Uint8Array(randomBytes(bytes)),
    sha256Hex: (input) => createHash('sha256').update(input, 'utf8').digest('hex'),
    timingSafeEqualHex: (a, b) => {
      if (a.length !== b.length || a.length === 0) return false
      const left = Buffer.from(a, 'hex')
      const right = Buffer.from(b, 'hex')
      return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
    },
  }
}

export interface TokenRecord {
  readonly hash: string
  readonly extensionId: string
  readonly issuedAt: number
  revokedAt: number | null
}

export interface HarnessOptions {
  readonly capabilities?: readonly BrowserBridgeCapability[]
  readonly stopAll?: boolean
  readonly allowPrivateHosts?: boolean
  readonly allowedHosts?: readonly string[]
  readonly pairedExtensionId?: string | null
  readonly dispatch?: (request: BridgeDispatchRequest) => Promise<BridgeDispatchResult>
}

export interface Harness {
  readonly bridge: BrowserBridge
  readonly crypto: BridgeCrypto
  readonly tokens: Map<string, TokenRecord>
  readonly dispatches: BridgeDispatchRequest[]
  setClock(instant: number): void
  setStopAll(active: boolean): void
  setCapabilities(capabilities: readonly BrowserBridgeCapability[]): void
  stopRequests: string[]
  pair(code?: string): Promise<BridgeOutbound>
  auth(token: string, overrides?: { connectionId?: string; extensionId?: string }): Promise<BridgeOutbound>
  command(
    sessionId: string,
    command: string,
    args?: Record<string, unknown>,
    overrides?: { seq?: number; nonce?: string; idempotencyKey?: string; connectionId?: string; origin?: string },
  ): Promise<BridgeOutbound>
  event(
    sessionId: string,
    event: string,
    payload?: Record<string, unknown>,
    overrides?: { connectionId?: string; origin?: string },
  ): Promise<BridgeOutbound>
  codeOf(outbound: BridgeOutbound): string | null
  okOf(outbound: BridgeOutbound): boolean
  sessionIdOf(outbound: BridgeOutbound): string | null
  resultOf(outbound: BridgeOutbound): unknown
}

export function harness(options: HarnessOptions = {}): Harness {
  const crypto = makeCrypto()
  let clock = T0
  let stopAll = options.stopAll ?? false
  let capabilities: readonly BrowserBridgeCapability[] =
    options.capabilities ?? [
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
    ]
  const tokens = new Map<string, TokenRecord>()
  const dispatches: BridgeDispatchRequest[] = []
  const stopRequests: string[] = []

  const ports: BrowserBridgePorts = {
    tokenStatus(hash) {
      const record = tokens.get(hash)
      if (record === undefined) return 'unknown'
      return record.revokedAt === null ? 'active' : 'revoked'
    },
    saveToken(hash, extensionId, issuedAt) {
      tokens.set(hash, { hash, extensionId, issuedAt, revokedAt: null })
    },
    revokeToken(hash) {
      const record = tokens.get(hash)
      if (record !== undefined) tokens.set(hash, { ...record, revokedAt: clock })
    },
    capabilitiesFor: () => capabilities,
    stopAllActive: () => stopAll,
    dispatch: async (request) => {
      dispatches.push(request)
      if (options.dispatch !== undefined) return options.dispatch(request)
      return { ok: true, code: null, reason: 'scripted ok', result: { scripted: true } }
    },
    requestStop(reason) {
      stopRequests.push(reason)
      stopAll = true
    },
    onAudit: () => undefined,
  }

  const bridge = createBrowserBridge({
    crypto,
    ports,
    now: () => clock,
    urlOptions: {
      allowPrivateHosts: options.allowPrivateHosts ?? false,
      allowedHosts: options.allowedHosts ?? ['example.com'],
    },
    pairedExtensionId:
      options.pairedExtensionId === undefined ? () => EXT_ID : () => options.pairedExtensionId ?? null,
  })

  const seqs = new Map<string, number>()
  function nextSeq(sessionId: string): number {
    const next = (seqs.get(sessionId) ?? 0) + 1
    seqs.set(sessionId, next)
    return next
  }
  let nonces = 0
  function nextNonce(): string {
    nonces += 1
    return `nonce-${String(nonces)}`
  }

  return {
    bridge,
    crypto,
    tokens,
    dispatches,
    stopRequests,
    setClock: (instant) => {
      clock = instant
    },
    setStopAll: (active) => {
      stopAll = active
    },
    setCapabilities: (next) => {
      capabilities = next
    },
    async pair(code) {
      const opened = bridge.openPairing()
      return bridge.handle(CONNECTION, ORIGIN, {
        kind: 'pair.request',
        pairingCode: code ?? opened.code,
        extensionId: EXT_ID,
        extensionVersion: '0.1.0',
      })
    },
    async auth(token, overrides = {}) {
      return bridge.handle(overrides.connectionId ?? CONNECTION, ORIGIN, {
        kind: 'auth.request',
        token,
        extensionId: overrides.extensionId ?? EXT_ID,
        clientNonce: nextNonce(),
      })
    },
    async command(sessionId, command, args = {}, overrides = {}) {
      return bridge.handle(overrides.connectionId ?? CONNECTION, overrides.origin ?? ORIGIN, {
        kind: 'command',
        sessionId,
        seq: overrides.seq ?? nextSeq(sessionId),
        nonce: overrides.nonce ?? nextNonce(),
        idempotencyKey: overrides.idempotencyKey ?? `idem-${String(Math.random()).slice(2)}`,
        command,
        args,
      })
    },
    async event(sessionId, event, payload = {}, overrides = {}) {
      return bridge.handle(overrides.connectionId ?? CONNECTION, overrides.origin ?? ORIGIN, {
        kind: 'event',
        sessionId,
        seq: nextSeq(sessionId),
        nonce: nextNonce(),
        event,
        payload,
      })
    },
    codeOf: (outbound) => (outbound.kind === 'refused' ? outbound.code : null),
    okOf: (outbound) => (outbound.kind === 'command.result' ? outbound.ok : false),
    sessionIdOf: (outbound) =>
      'sessionId' in outbound && typeof outbound.sessionId === 'string' ? outbound.sessionId : null,
    resultOf: (outbound) => (outbound.kind === 'command.result' ? outbound.result : null),
  }
}
