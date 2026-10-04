import {
  BROWSER_BRIDGE_COMMAND_ACTION,
  BROWSER_BRIDGE_COMMAND_CAPABILITY,
  BROWSER_BRIDGE_CONTROL_CAPABILITIES,
  BROWSER_BRIDGE_LIMITS,
  BROWSER_BRIDGE_OBSERVATION_CAPABILITIES,
  BROWSER_BRIDGE_PROTOCOL,
  BROWSER_BRIDGE_REFUSAL_REASONS,
  isBrowserBridgeCapability,
  isBrowserBridgeCommand,
  type BrowserBridgeAuditEntry,
  type BrowserBridgeAuditEvent,
  type BrowserBridgeCapability,
  type BrowserBridgeCommand,
  type BrowserBridgeRefusalCode,
  type BridgeInbound,
  type BridgeOutbound,
  type BridgeServerHello,
} from './types'
import { generatePairingCode, generateToken, pairingCodeHash, tokenHash } from './pairing'
import { checkBridgePageUrl, type BridgeUrlOptions } from './safety'
import type { BridgeCrypto } from './crypto'
import { createSessionRegistry, type BridgeSession, type SessionRegistry } from './session'

/**
 * The authenticated bridge, as a pure state machine.
 *
 * This file is the whole host side of the wire, and it holds no sockets. A server hands
 * it a `connectionId`, the *transport-derived* origin, and a parsed message; it hands
 * back the frames to send. That split is what makes the security properties testable:
 * a test can forge an origin, replay a nonce or lift a session id without a browser.
 *
 * The invariant, stated once: **this bridge never mints authority.** Pairing creates an
 * identity. A session carries a capability set the *host* decided. Every command that
 * reaches a page is dispatched through `ports.dispatch`, which is wired to the Device
 * Hands runtime and therefore to Guard, the Governor, STOP ALL and the grant gate. The
 * bridge can refuse more than Core would; it can never allow more.
 */

/* ------------------------------------------------------------------- ports */

export interface BridgeDispatchRequest {
  readonly sessionId: string
  readonly connectionId: string
  readonly extensionId: string
  readonly command: BrowserBridgeCommand
  /** The Device Hands browser action this maps to, or null for an observation. */
  readonly actionKey: string | null
  readonly args: Readonly<Record<string, unknown>>
  readonly tabId: number | null
  readonly frameId: number
  readonly url: string | null
  readonly origin: string | null
  readonly at: number
  readonly deadlineAt: number
  readonly actionId: string
}

export interface BridgeDispatchResult {
  readonly ok: boolean
  /** Null when the command succeeded. A refusal always carries a code. */
  readonly code: string | null
  readonly reason: string
  readonly result?: unknown
}

export interface BrowserBridgePorts {
  /** Whether a token hash names an active, revoked or unknown pairing. */
  tokenStatus(hash: string): 'active' | 'revoked' | 'unknown'
  /** Persist a token hash. The plaintext is never given to this port. */
  saveToken(hash: string, extensionId: string, issuedAt: number): void
  /** Revoke a token hash. */
  revokeToken(hash: string): void
  /** The host-decided capability ceiling for an extension. Never from a client. */
  capabilitiesFor(extensionId: string): readonly BrowserBridgeCapability[]
  /** The STOP ALL latch, read fresh. */
  stopAllActive(): boolean
  /** Relay an authenticated command. Must not mint authority. */
  dispatch(request: BridgeDispatchRequest): Promise<BridgeDispatchResult>
  /** Ask the host to latch STOP ALL and tear control down. */
  requestStop(reason: string): void
  /** Audit sink. Never receives page content or a secret. */
  onAudit(entry: BrowserBridgeAuditEntry): void
}

/* ----------------------------------------------------------------- options */

export interface BrowserBridgeOptions {
  readonly crypto: BridgeCrypto
  readonly ports: BrowserBridgePorts
  /** Epoch milliseconds. */
  readonly now: () => number
  /** URL policy for shared pages and navigations. */
  readonly urlOptions?: BridgeUrlOptions
  /** The extension id this host is paired with, once known. */
  readonly pairedExtensionId?: () => string | null
}

/* ------------------------------------------------------------------- events */

export const BROWSER_BRIDGE_EVENTS = [
  'session.heartbeat',
  'tab.updated',
  'tab.removed',
  'page.navigated',
  'page.reloaded',
] as const
export type BrowserBridgeEvent = (typeof BROWSER_BRIDGE_EVENTS)[number]

export function isBrowserBridgeEvent(value: unknown): value is BrowserBridgeEvent {
  return typeof value === 'string' && (BROWSER_BRIDGE_EVENTS as readonly string[]).includes(value)
}

/* --------------------------------------------------------------- interface */

export interface BrowserBridge {
  onConnection(connectionId: string): BridgeServerHello
  onDisconnect(connectionId: string): void
  handle(connectionId: string, origin: string, raw: unknown): Promise<BridgeOutbound>
  openPairing(): { readonly code: string; readonly expiresAt: number }
  closePairing(): void
  pairingOpen(): boolean
  /** Host-only: enable or disable the acting capabilities for a session. */
  setControl(sessionId: string, enabled: boolean): boolean
  /** Host-only: bind the tab the owner shared. */
  shareTab(sessionId: string, tabId: number, url: string, origin: string): boolean
  unshareTab(sessionId: string): boolean
  revokeSession(sessionId: string): boolean
  revokeAll(): void
  /** Latch STOP ALL through the host and tear every session down. */
  stopAll(reason: string): void
  sessions(): readonly BridgeSession[]
  session(sessionId: string): BridgeSession | null
  audit(): readonly BrowserBridgeAuditEntry[]
  /** Whether the paired extension currently has a live session. */
  hasLiveSession(): boolean
}

const MAX_AUDIT = 256

/* ------------------------------------------------------------------ parse */

export type InboundParse =
  | { readonly ok: true; readonly message: BridgeInbound }
  | { readonly ok: false; readonly code: BrowserBridgeRefusalCode; readonly reason: string }

/**
 * Parse one wire frame, enforcing the size ceiling *before* JSON.parse.
 *
 * The ceiling is checked on the UTF-8 byte length of the raw text, so a message cannot
 * be made to allocate more than the bridge accepts. A malformed message is refused, not
 * repaired.
 */
export function parseInbound(raw: string): InboundParse {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'malformed-message', reason: 'A bridge frame must be text.' }
  }
  if (raw.length > BROWSER_BRIDGE_LIMITS.maxMessageBytes) {
    return {
      ok: false,
      code: 'message-too-large',
      reason: `A bridge frame may be at most ${String(BROWSER_BRIDGE_LIMITS.maxMessageBytes)} bytes.`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'malformed-message', reason: 'That frame is not JSON, and it was not repaired.' }
  }
  return { ok: true, message: parsed as BridgeInbound }
}

/* --------------------------------------------------------------- creation */

export function createBrowserBridge(options: BrowserBridgeOptions): BrowserBridge {
  const { crypto, ports } = options
  const sessions: SessionRegistry = createSessionRegistry(crypto)
  const audit: BrowserBridgeAuditEntry[] = []
  let pairing: { codeHash: string; expiresAt: number; attempts: number } | null = null

  function at(): number {
    return options.now()
  }

  function record(
    event: BrowserBridgeAuditEvent,
    session: BridgeSession | null,
    command: string | null,
    code: string | null,
    detail: string,
  ): void {
    const entry: BrowserBridgeAuditEntry = {
      at: at(),
      event,
      sessionId: session?.sessionId ?? null,
      extensionId: session?.extensionId ?? null,
      command,
      code,
      detail: detail.slice(0, BROWSER_BRIDGE_LIMITS.maxAuditDetailChars),
    }
    audit.push(entry)
    while (audit.length > MAX_AUDIT) audit.shift()
    ports.onAudit(entry)
  }

  function refuse(code: BrowserBridgeRefusalCode, reason?: string, sessionId?: string): BridgeOutbound {
    return {
      kind: 'refused',
      code,
      reason: reason ?? BROWSER_BRIDGE_REFUSAL_REASONS[code],
      ...(sessionId === undefined ? {} : { sessionId }),
    }
  }

  function newSession(connectionId: string, extensionId: string, hash: string): BridgeSession {
    const capabilities = sanitizeCapabilities(ports.capabilitiesFor(extensionId))
    const session = sessions.create({
      connectionId,
      extensionId,
      tokenHash: hash,
      capabilities,
      now: at(),
    })
    record('session.opened', session, null, null, `session opened for ${extensionId}`)
    return session
  }

  function sanitizeCapabilities(input: readonly BrowserBridgeCapability[]): readonly BrowserBridgeCapability[] {
    const seen = new Set<BrowserBridgeCapability>()
    for (const capability of input) if (isBrowserBridgeCapability(capability)) seen.add(capability)
    return Object.freeze([...seen])
  }

  function hasCapability(session: BridgeSession, capability: BrowserBridgeCapability): boolean {
    return session.capabilities.includes(capability)
  }

  function openPairing(): { readonly code: string; readonly expiresAt: number } {
    const code = generatePairingCode(crypto)
    pairing = {
      codeHash: pairingCodeHash(crypto, code),
      expiresAt: at() + BROWSER_BRIDGE_LIMITS.pairingCodeTtlMs,
      attempts: 0,
    }
    record('pairing.opened', null, null, null, 'a pairing code is being shown')
    return { code, expiresAt: pairing.expiresAt }
  }

  function closePairing(): void {
    pairing = null
  }

  /* --------------------------------------------------------------- command */

  async function handleCommand(
    connectionId: string,
    origin: string,
    message: Extract<BridgeInbound, { kind: 'command' }>,
  ): Promise<BridgeOutbound> {
    if (typeof message.command !== 'string' || !isBrowserBridgeCommand(message.command)) {
      record('command.refused', null, typeof message.command === 'string' ? message.command : null, 'command-unknown', 'an unknown command arrived')
      return refuse('command-unknown')
    }
    const command = message.command
    const authorization = sessions.authorize({
      sessionId: message.sessionId,
      connectionId,
      seq: message.seq,
      nonce: message.nonce,
      idempotencyKey: message.idempotencyKey,
      command,
      now: at(),
    })
    if (!authorization.ok) {
      const session = authorization.refusal.session
      record('command.refused', session, command, authorization.refusal.code, authorization.refusal.reason)
      return refuse(authorization.refusal.code, authorization.refusal.reason, session?.sessionId)
    }
    const session = authorization.session

    // A web page cannot impersonate the extension: the origin is transport-derived and
    // must be the paired extension's chrome-extension origin.
    if (!originMatches(origin, session.extensionId)) {
      record('command.refused', session, command, 'origin-mismatch', `origin ${origin} is not the paired extension`)
      return refuse('origin-mismatch', undefined, session.sessionId)
    }

    if (authorization.replayed) {
      // The cached result is returned without touching a page again.
      const cached = session.idempotency.get(message.idempotencyKey)
      return {
        kind: 'command.result',
        sessionId: session.sessionId,
        idempotencyKey: message.idempotencyKey,
        ok: true,
        code: null,
        reason: 'This command was already performed, so its recorded result is returned.',
        result: cached?.result ?? null,
      }
    }

    const capability = BROWSER_BRIDGE_COMMAND_CAPABILITY[command]
    if (!hasCapability(session, capability)) {
      record('command.refused', session, command, 'capability-missing', `session lacks ${capability}`)
      return refuse('capability-missing', undefined, session.sessionId)
    }

    if (ports.stopAllActive() && command !== 'control.stop' && command !== 'session.status') {
      record('command.refused', session, command, 'stopped', 'STOP ALL is latched')
      return refuse('stopped', undefined, session.sessionId)
    }

    const validated = validateArgs(session, command, message.args, options.urlOptions ?? {})
    if (!validated.ok) {
      record('command.refused', session, command, validated.code, validated.reason)
      return refuse(validated.code, validated.reason, session.sessionId)
    }

    // Control-plane commands are handled here. They can only bind for read, narrow, or
    // stop; none of them mints a capability or a grant.
    if (command === 'control.stop') {
      record('stop.requested', session, command, null, 'the extension asked to stop')
      sessions.revoke(session.sessionId, at())
      ports.requestStop('the extension requested STOP ALL')
      return result(session, message.idempotencyKey, true, 'stopped', { stopped: true })
    }
    if (command === 'session.status') {
      return result(session, message.idempotencyKey, true, 'status', statusOf(session))
    }
    if (command === 'page.share') {
      const url = validated.url
      const tabId = validated.tabId
      const origin2 = validated.origin
      if (url === null || tabId === null || origin2 === null) {
        return refuse('payload-invalid', undefined, session.sessionId)
      }
      sessions.bindTab(session.sessionId, tabId, url, origin2)
      sessions.rememberResult(session.sessionId, message.idempotencyKey, command, { shared: true, tabId, origin: origin2 })
      record('command.dispatched', session, command, null, `tab ${String(tabId)} shared`)
      return result(session, message.idempotencyKey, true, 'shared', { shared: true, tabId, origin: origin2 })
    }
    if (command === 'page.unshare') {
      sessions.unbindTab(session.sessionId)
      record('command.dispatched', session, command, null, 'tab unshared')
      return result(session, message.idempotencyKey, true, 'unshared', { shared: false })
    }

    // Control is enabled only through the host, on an owner decision. The bridge asks
    // and then applies; it never decides. Revoking narrows, so it needs no approval.
    if (command === 'control.request' || command === 'control.revoke') {
      const dispatched =
        command === 'control.revoke'
          ? { ok: true, code: null, reason: 'control revoked' }
          : await ports.dispatch({
              sessionId: session.sessionId,
              connectionId,
              extensionId: session.extensionId,
              command,
              actionKey: null,
              args: {},
              tabId: null,
              frameId: 0,
              url: session.sharedUrl,
              origin: session.sharedOrigin,
              at: at(),
              deadlineAt: Math.min(session.expiresAt, at() + 30_000),
              actionId: actionIdFor(crypto, message.idempotencyKey),
            })
      if (!dispatched.ok) {
        record('command.refused', session, command, dispatched.code, dispatched.reason)
        return result(session, message.idempotencyKey, false, dispatched.code, { control: false }, dispatched.reason)
      }
      if (command === 'control.revoke') {
        sessions.setCapabilities(session.sessionId, [...BROWSER_BRIDGE_OBSERVATION_CAPABILITIES])
        record('control.revoked', session, command, null, 'control revoked')
        return result(session, message.idempotencyKey, true, 'control-revoked', { control: false })
      }
      sessions.setCapabilities(session.sessionId, [
        ...BROWSER_BRIDGE_OBSERVATION_CAPABILITIES,
        ...BROWSER_BRIDGE_CONTROL_CAPABILITIES,
      ])
      record('control.granted', session, command, null, 'the owner enabled control')
      return result(session, message.idempotencyKey, true, 'control-granted', { control: true })
    }

    // Shared-tab binding for every page-touching observation and action.
    if (command !== 'page.navigate') {
      if (session.sharedTabId === null) {
        record('command.refused', session, command, 'tab-not-shared', 'no tab is shared with this session')
        return refuse('tab-not-shared', undefined, session.sessionId)
      }
      const namedTab = validated.tabId
      if (namedTab !== null && namedTab !== session.sharedTabId) {
        record('command.refused', session, command, 'tab-mismatch', 'the command names a different tab')
        return refuse('tab-mismatch', undefined, session.sessionId)
      }
    }

    const actionId = actionIdFor(crypto, message.idempotencyKey)
    const deadlineAt = Math.min(session.expiresAt, at() + 30_000)
    const dispatched = await ports.dispatch({
      sessionId: session.sessionId,
      connectionId,
      extensionId: session.extensionId,
      command,
      actionKey: BROWSER_BRIDGE_COMMAND_ACTION[command] ?? null,
      args: validated.args,
      tabId: command === 'page.navigate' ? null : session.sharedTabId,
      frameId: 0,
      url: command === 'page.navigate' ? (validated.args.url as string) : session.sharedUrl,
      origin: session.sharedOrigin,
      at: at(),
      deadlineAt,
      actionId,
    })

    record(
      dispatched.ok ? 'command.dispatched' : 'command.refused',
      session,
      command,
      dispatched.ok ? null : dispatched.code,
      dispatched.reason,
    )
    const outbound = result(
      session,
      message.idempotencyKey,
      dispatched.ok,
      dispatched.code,
      dispatched.result ?? null,
      dispatched.reason,
    )
    sessions.rememberResult(session.sessionId, message.idempotencyKey, command, dispatched.result ?? null)
    return outbound
  }

  function statusOf(session: BridgeSession): unknown {
    const control = BROWSER_BRIDGE_CONTROL_CAPABILITIES.every((capability) =>
      session.capabilities.includes(capability),
    )
    return {
      sessionId: session.sessionId,
      capabilities: session.capabilities,
      sharedTabId: session.sharedTabId,
      sharedOrigin: session.sharedOrigin,
      control,
      stopped: ports.stopAllActive(),
      expiresAt: session.expiresAt,
    }
  }

  function result(
    session: BridgeSession,
    idempotencyKey: string,
    ok: boolean,
    code: string | null,
    value: unknown,
    reason?: string,
  ): BridgeOutbound {
    return {
      kind: 'command.result',
      sessionId: session.sessionId,
      idempotencyKey,
      ok,
      code,
      reason: reason ?? (ok ? 'done' : BROWSER_BRIDGE_REFUSAL_REASONS['authority-refused']),
      result: value,
    }
  }

  function handleEvent(
    connectionId: string,
    origin: string,
    message: Extract<BridgeInbound, { kind: 'event' }>,
  ): BridgeOutbound {
    if (typeof message.event !== 'string' || !isBrowserBridgeEvent(message.event)) {
      return refuse('malformed-message', 'That is not an event this bridge routes.')
    }
    const authorization = sessions.authorize({
      sessionId: message.sessionId,
      connectionId,
      seq: message.seq,
      nonce: message.nonce,
      idempotencyKey: `evt-${message.nonce}`,
      command: 'session.status',
      now: at(),
    })
    if (!authorization.ok) {
      return refuse(authorization.refusal.code, authorization.refusal.reason)
    }
    const session = authorization.session
    if (!originMatches(origin, session.extensionId)) {
      return refuse('origin-mismatch', undefined, session.sessionId)
    }
    // A tab or origin change revokes what was bound to it. This is the "revoke on change"
    // rule, and it fails closed: the share ends and a new one is required.
    if (message.event === 'tab.removed' || message.event === 'page.navigated') {
      const payload = asRecord(message.payload)
      const tabId = readTabId(payload?.tabId)
      if (session.sharedTabId !== null && (tabId === null || tabId === session.sharedTabId)) {
        sessions.unbindTab(session.sessionId)
        record('session.closed', session, message.event, null, 'the shared tab changed, so the share ended')
      }
    }
    return {
      kind: 'command.result',
      sessionId: session.sessionId,
      idempotencyKey: `evt-${message.nonce}`,
      ok: true,
      code: null,
      reason: 'event recorded',
      result: { accepted: true },
    }
  }

  /* ------------------------------------------------------------- dispatch */

  async function handle(connectionId: string, origin: string, raw: unknown): Promise<BridgeOutbound> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return refuse('malformed-message')
    }
    const message = raw as BridgeInbound
    switch (message.kind) {
      case 'hello': {
        if (message.protocol !== BROWSER_BRIDGE_PROTOCOL) {
          record('message.rejected', null, null, 'protocol-mismatch', 'a client spoke another protocol')
          return refuse('protocol-mismatch')
        }
        return {
          kind: 'server.hello',
          protocol: BROWSER_BRIDGE_PROTOCOL,
          serverNonce: crypto.randomBytes(16).join(','),
          pairingOpen: pairing !== null,
        }
      }

      case 'pair.request': {
        if (pairing === null) {
          record('pairing.refused', null, null, 'pairing-closed', 'pairing was not open')
          return refuse('pairing-closed')
        }
        if (at() > pairing.expiresAt) {
          pairing = null
          record('pairing.refused', null, null, 'pairing-expired', 'the pairing code expired')
          return refuse('pairing-expired')
        }
        if (pairing.attempts >= BROWSER_BRIDGE_LIMITS.pairingMaxAttempts) {
          pairing = null
          record('pairing.refused', null, null, 'pairing-attempts-exceeded', 'too many attempts')
          return refuse('pairing-attempts-exceeded')
        }
        pairing.attempts += 1
        const presented = typeof message.pairingCode === 'string' ? message.pairingCode.trim().toUpperCase() : ''
        const presentedHash = pairingCodeHash(crypto, presented)
        if (!crypto.timingSafeEqualHex(presentedHash, pairing.codeHash)) {
          record('pairing.refused', null, null, 'pairing-code-invalid', 'a pairing code did not match')
          return refuse('pairing-code-invalid')
        }
        if (typeof message.extensionId !== 'string' || message.extensionId.length === 0 || message.extensionId.length > BROWSER_BRIDGE_LIMITS.maxIdChars) {
          return refuse('malformed-message', 'Pairing needs the extension id.')
        }
        const token = generateToken(crypto)
        const hash = tokenHash(crypto, token)
        ports.saveToken(hash, message.extensionId, at())
        pairing = null
        const session = newSession(connectionId, message.extensionId, hash)
        record('pairing.succeeded', session, null, null, `extension ${message.extensionId} paired`)
        return {
          kind: 'pair.ok',
          token,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          capabilities: session.capabilities,
          protocol: BROWSER_BRIDGE_PROTOCOL,
        }
      }

      case 'auth.request': {
        if (typeof message.token !== 'string' || message.token.length === 0 || message.token.length > 256) {
          return refuse('token-invalid')
        }
        if (typeof message.extensionId !== 'string' || message.extensionId.length === 0) {
          return refuse('malformed-message', 'Authentication needs the extension id.')
        }
        const paired = options.pairedExtensionId?.()
        if (paired !== null && paired !== undefined && paired !== message.extensionId) {
          record('auth.refused', null, null, 'token-invalid', 'a different extension id tried to authenticate')
          return refuse('token-invalid')
        }
        const hash = tokenHash(crypto, message.token)
        const status = ports.tokenStatus(hash)
        if (status === 'unknown') {
          record('auth.refused', null, null, 'token-invalid', 'an unknown token tried to authenticate')
          return refuse('token-invalid')
        }
        if (status === 'revoked') {
          record('auth.refused', null, null, 'token-revoked', 'a revoked token tried to authenticate')
          return refuse('token-revoked')
        }
        const session = newSession(connectionId, message.extensionId, hash)
        record('auth.succeeded', session, null, null, `extension ${message.extensionId} authenticated`)
        return {
          kind: 'auth.ok',
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          capabilities: session.capabilities,
          protocol: BROWSER_BRIDGE_PROTOCOL,
        }
      }

      case 'command':
        return handleCommand(connectionId, origin, message)

      case 'event':
        return handleEvent(connectionId, origin, message)

      case 'bye': {
        const session = sessions.get(message.sessionId)
        if (session !== null && session.connectionId === connectionId) {
          sessions.close(session.sessionId)
          record('session.closed', session, null, null, 'the client said goodbye')
        }
        return { kind: 'command.result', sessionId: message.sessionId, idempotencyKey: 'bye', ok: true, code: null, reason: 'closed', result: { closed: true } }
      }

      default:
        return refuse('malformed-message')
    }
  }

  return {
    onConnection(connectionId) {
      record('bridge.opened', null, null, null, `connection ${connectionId.slice(0, 32)} opened`)
      return {
        kind: 'server.hello',
        protocol: BROWSER_BRIDGE_PROTOCOL,
        serverNonce: crypto.randomBytes(16).join(','),
        pairingOpen: pairing !== null,
      }
    },
    onDisconnect(connectionId) {
      const revoked = sessions.revokeConnection(connectionId, at())
      record('bridge.closed', null, null, null, `connection closed; ${String(revoked)} session(s) revoked`)
    },
    handle,
    openPairing,
    closePairing,
    pairingOpen: () => pairing !== null,
    setControl(sessionId, enabled) {
      const session = sessions.get(sessionId)
      if (session === null) return false
      const base = [...BROWSER_BRIDGE_OBSERVATION_CAPABILITIES]
      if (enabled) base.push(...BROWSER_BRIDGE_CONTROL_CAPABILITIES)
      sessions.setCapabilities(sessionId, base)
      record(enabled ? 'control.granted' : 'control.revoked', session, null, null, enabled ? 'control enabled' : 'control disabled')
      return true
    },
    shareTab(sessionId, tabId, url, origin) {
      const session = sessions.get(sessionId)
      if (session === null) return false
      sessions.bindTab(sessionId, tabId, url, origin)
      return true
    },
    unshareTab(sessionId) {
      const session = sessions.get(sessionId)
      if (session === null) return false
      sessions.unbindTab(sessionId)
      return true
    },
    revokeSession(sessionId) {
      const session = sessions.get(sessionId)
      if (session === null) return false
      sessions.revoke(sessionId, at())
      record('session.revoked', session, null, null, 'session revoked by the host')
      return true
    },
    revokeAll() {
      for (const session of sessions.all()) {
        sessions.revoke(session.sessionId, at())
      }
      record('session.revoked', null, null, null, 'every session revoked')
    },
    stopAll(reason) {
      for (const session of sessions.all()) sessions.revoke(session.sessionId, at())
      ports.requestStop(reason)
      record('stop.requested', null, null, null, reason)
    },
    sessions: () => sessions.all(),
    session: (sessionId) => sessions.get(sessionId),
    audit: () => [...audit],
    hasLiveSession: () =>
      sessions.all().some((session) => !session.revoked && at() <= session.expiresAt),
  }
}

/* --------------------------------------------------------------- internals */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readTabId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

/** Whether a transport-derived origin is the paired extension's origin. */
export function originMatches(origin: string, extensionId: string): boolean {
  return origin === `chrome-extension://${extensionId}`
}

export function actionIdFor(crypto: BridgeCrypto, idempotencyKey: string): string {
  return `bx-${crypto.sha256Hex(`freya-browser-bridge:action:${idempotencyKey}`).slice(0, 40)}`
}

interface ValidatedArgs {
  readonly ok: true
  readonly args: Readonly<Record<string, unknown>>
  readonly url: string | null
  readonly origin: string | null
  /** The tab the command names, when it names one. */
  readonly tabId: number | null
}

interface InvalidArgs {
  readonly ok: false
  readonly code: BrowserBridgeRefusalCode
  readonly reason: string
}

const SELECTOR_PATTERN = /^[\p{L}\p{N}#._\-[\]="':, >+~*()]{1,256}$/u
const FORBIDDEN_SELECTOR_TOKENS = ['javascript:', 'data:', 'vbscript:', 'expression(', 'onerror=', 'onload=', 'onclick=', 'onmouseover=', 'onfocus=', '<script', '{{']

function validateArgs(
  session: BridgeSession,
  command: BrowserBridgeCommand,
  raw: unknown,
  urlOptions: BridgeUrlOptions,
): ValidatedArgs | InvalidArgs {
  const args = asRecord(raw) ?? {}
  const namedTab = readTabId(args.tabId)
  const bound = (extra: Readonly<Record<string, unknown>> = {}): ValidatedArgs => ({
    ok: true,
    args: { ...extra, ...(namedTab === null ? {} : { tabId: namedTab }) },
    url: session.sharedUrl,
    origin: session.sharedOrigin,
    tabId: namedTab,
  })
  switch (command) {
    case 'session.status':
    case 'page.unshare':
    case 'control.request':
    case 'control.revoke':
    case 'control.stop':
    case 'selection.read':
    case 'tab.metadata':
      return bound()
    case 'page.share': {
      const reading = checkBridgePageUrl(args.url, urlOptions)
      if (!reading.ok) return { ok: false, code: reading.code, reason: reading.reason }
      if (namedTab === null) {
        return { ok: false, code: 'payload-invalid', reason: 'Sharing needs the tab id the page is in.' }
      }
      return {
        ok: true,
        args: { url: reading.url, tabId: namedTab },
        url: reading.url,
        origin: reading.origin,
        tabId: namedTab,
      }
    }
    case 'page.navigate': {
      const reading = checkBridgePageUrl(args.url, urlOptions)
      if (!reading.ok) return { ok: false, code: reading.code, reason: reading.reason }
      return { ok: true, args: { url: reading.url }, url: reading.url, origin: reading.origin, tabId: null }
    }
    case 'page.read-text': {
      const selector = args.selector
      if (selector !== undefined && selector !== null) {
        const checked = checkSelector(selector)
        if (!checked.ok) return checked
        return bound({ selector: checked.selector })
      }
      return bound()
    }
    case 'element.inspect':
    case 'element.click': {
      const checked = checkSelector(args.selector)
      if (!checked.ok) return checked
      return bound({ selector: checked.selector })
    }
    case 'element.type-text': {
      const checked = checkSelector(args.selector)
      if (!checked.ok) return checked
      const text = args.text
      if (typeof text !== 'string' || text.length === 0) {
        return { ok: false, code: 'payload-invalid', reason: 'Typing needs text to type.' }
      }
      const bytes = utf8Length(text)
      if (bytes > BROWSER_BRIDGE_LIMITS.maxTypedTextBytes) {
        return {
          ok: false,
          code: 'payload-too-large',
          reason: `Typed text is capped at ${String(BROWSER_BRIDGE_LIMITS.maxTypedTextBytes)} bytes.`,
        }
      }
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index)
        if (code < 32 || code === 127) {
          return {
            ok: false,
            code: 'payload-invalid',
            reason: 'Typed text may not contain a control character.',
          }
        }
      }
      return bound({ selector: checked.selector, text })
    }
  }
}

function checkSelector(
  value: unknown,
): { ok: true; selector: string } | { ok: false; code: BrowserBridgeRefusalCode; reason: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > BROWSER_BRIDGE_LIMITS.maxSelectorChars) {
    return {
      ok: false,
      code: 'payload-invalid',
      reason: `A selector must be 1 to ${String(BROWSER_BRIDGE_LIMITS.maxSelectorChars)} characters.`,
    }
  }
  if (!SELECTOR_PATTERN.test(value)) {
    return { ok: false, code: 'payload-invalid', reason: 'That selector is not a locator this bridge accepts.' }
  }
  const lowered = value.toLowerCase()
  const token = FORBIDDEN_SELECTOR_TOKENS.find((candidate) => lowered.includes(candidate))
  if (token !== undefined) {
    return {
      ok: false,
      code: 'payload-invalid',
      reason: `That selector contains "${token}". A locator may not name a script URL or an inline handler.`,
    }
  }
  return { ok: true, selector: value }
}

function utf8Length(value: string): number {
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}
