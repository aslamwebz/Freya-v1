import {
  BROWSER_BRIDGE_COMMAND_ACTION,
  BROWSER_BRIDGE_OBSERVATION_CAPABILITIES,
  createBrowserBridge,
  truncateUtf8,
  utf8Bytes,
  type BrowserBridge,
  type BrowserBridgeAuditEntry,
  type BrowserBridgeCapability,
  type BridgeDispatchRequest,
  type BridgeDispatchResult,
  type BridgeUrlOptions,
} from '../../core/browserext'
import {
  createDeviceHandsRuntime,
  type DeviceHandsActionKey,
  type DeviceHandsApprovalAnswer,
  type DeviceHandsApprovalAsk,
  type DeviceHandsEventType,
  type DeviceHandsPayload,
  type DeviceHandsPorts,
  type DeviceHandsRuntime,
  type GrantFact,
} from '../../core/devicehands'
import { nodeBridgeCrypto } from './crypto'
import { createBridgeServer, type BridgeServer } from './bridgeServer'
import { createBrowserAdapter, type BrowserAdapter, type BrowserTransport } from './browserAdapter'

/**
 * The Phase 43 host assembly.
 *
 * This is the seam where the bridge, the browser adapter and the existing Device Hands
 * runtime meet. It deliberately reuses the Phase 35 runtime rather than building a
 * second browser-control stack: the extension is a *port*, and the gates are unchanged.
 *
 * ## The activation seam
 *
 * Device Hands is only reachable when `activation === 'active'` **and** the owner has
 * switched it on. Phase 42 ("Device Hands Activation") is the phase that owns turning
 * it on for real — the canonical host adapter, the durable journal, the owner switch,
 * and the grant source. That work is not present on this branch, so the seam here
 * defaults to `'pending-phase42'`, `enabled()` returns false, and every consequential
 * action is refused at the `enabled` gate. The bridge, the pairing and the read-only
 * observations still work; the *acts* do not. This is the honest fail-closed state, not
 * a stub that pretends.
 */

export type BrowserExtensionActivation = 'active' | 'pending-phase42' | 'disabled'

export interface BrowserExtensionHostOptions {
  readonly activation: BrowserExtensionActivation
  readonly port?: number
  readonly host?: string
  readonly now?: () => number
  readonly policy?: unknown
  readonly urlOptions?: BridgeUrlOptions
  /** Local development: no grant/approval/control friction. */
  readonly localUnrestricted?: boolean
  readonly tokenStore?: BridgeTokenStore
  /** Core's grant source. Absent means "no grant", which refuses every action. */
  readonly activeGrant?: (principalId: string, scope: string) => GrantFact | null
  /** Route an approval to the owner. Absent means the owner did not decide. */
  readonly requestOwnerApproval?: (ask: DeviceHandsApprovalAsk) => Promise<DeviceHandsApprovalAnswer>
  /** Ask the owner to enable agent-driven control. Absent means denied. */
  readonly requestControl?: (sessionId: string, extensionId: string) => Promise<boolean>
  readonly audit?: (entry: BrowserBridgeAuditEntry) => void
  readonly onLog?: (line: string) => void
  readonly vaultRoot?: string
  readonly keyringRoot?: string
}

export interface BrowserExtensionHost {
  start(): Promise<{ readonly port: number }>
  stop(): Promise<void>
  /**
   * Continue a handed-off URL in the tab the owner has already shared.
   *
   * Added in Phase 51 so the dual-browser handoff has a real destination. It is **not** a
   * new door: the request goes through this host's existing `dispatch`, which walks the
   * same Device Hands gates and the same session capability, session tab scope and shared
   * origin check that an inbound `page.navigate` does.
   *
   * The honest limit, which is a protocol property rather than an implementation gap:
   * this host can only navigate a tab the owner has explicitly shared. There is no
   * "create a tab" command in the Phase 43 protocol, and adding one would mean the host
   * could put a page in front of the person without them having shared anything. So a
   * handoff with no shared tab is refused `target-unavailable` rather than half-served.
   */
  continueInSharedTab(request: {
    readonly url: string
    readonly deadlineAt: number
  }): Promise<{
    readonly ok: boolean
    readonly code: string | null
    readonly reason: string
    readonly tabId: number | null
  }>
  readonly bridge: BrowserBridge
  readonly runtime: DeviceHandsRuntime
  readonly server: BridgeServer
  readonly adapter: BrowserAdapter
  readonly activation: BrowserExtensionActivation
  status(): {
    readonly activation: BrowserExtensionActivation
    readonly connected: boolean
    readonly paired: boolean
    readonly pairingOpen: boolean
    readonly enabled: boolean
    readonly stopped: boolean
  }
}

/* --------------------------------------------------------------- token store */

export interface BridgeTokenRecord {
  readonly hash: string
  readonly extensionId: string
  readonly issuedAt: number
  readonly revokedAt: number | null
}

export interface BridgeTokenStore {
  get(hash: string): BridgeTokenRecord | null
  put(record: BridgeTokenRecord): void
  revoke(hash: string, at: number): boolean
  all(): readonly BridgeTokenRecord[]
}

export function createInMemoryTokenStore(): BridgeTokenStore {
  const tokens = new Map<string, BridgeTokenRecord>()
  return {
    get: (hash) => tokens.get(hash) ?? null,
    put: (record) => {
      tokens.set(record.hash, record)
    },
    revoke: (hash, at) => {
      const existing = tokens.get(hash)
      if (existing === undefined) return false
      tokens.set(hash, { ...existing, revokedAt: at })
      return true
    },
    all: () => [...tokens.values()],
  }
}

/* --------------------------------------------------------------- the host */

const DEFAULT_PRINCIPAL_PREFIX = 'extension:'

export function createBrowserExtensionHost(
  options: BrowserExtensionHostOptions,
): BrowserExtensionHost {
  const now = options.now ?? (() => Date.now())
  const tokenStore = options.tokenStore ?? createInMemoryTokenStore()
  const vaultRoot = options.vaultRoot ?? '/freya/vault'
  const keyringRoot = options.keyringRoot ?? '/freya/keyring'
  const principalFor = (extensionId: string): string => `${DEFAULT_PRINCIPAL_PREFIX}${extensionId}`

  // A minimal, locked-down policy. Phase 42 is expected to supply the real one.
  const policy =
    options.policy ?? (options.localUnrestricted === true
      ? {
          localUnrestricted: true,
          allowedRoots: [],
          deniedRoots: [],
          allowedHosts: [],
          allowedCommands: [],
          allowedEnvNames: [],
        }
      : {
          allowedRoots: ['/freya-none'],
          deniedRoots: [vaultRoot, keyringRoot],
          allowedHosts: ['localhost'],
          allowedCommands: ['echo'],
          allowedEnvNames: ['LANG'],
        })

  let stopped = false
  const enabled = options.activation === 'active'
  const journal: { type: string; recordedAt: string; payload: Record<string, unknown> }[] = []

  // The adapter needs a transport that only exists once the server has started. The
  // indirection keeps the wiring acyclic: server → bridge → dispatch → adapter → server.
  let transport: BrowserTransport | null = null
  const adapter = createBrowserAdapter({
    now,
    transport: {
      send(connectionId, request) {
        if (transport === null) {
          return Promise.resolve({
            kind: 'response',
            requestId: request.requestId,
            ok: false,
            code: 'host-unavailable',
            reason: 'The bridge server has not started.',
            result: null,
          })
        }
        return transport.send(connectionId, request)
      },
    },
  })

  const ports: DeviceHandsPorts = {
    now: () => new Date(now()).toISOString(),
    newId: () => `dh-${Math.random().toString(36).slice(2)}${String(now())}`,
    append: async (type: DeviceHandsEventType, payload: DeviceHandsPayload) => {
      journal.push({ type, recordedAt: new Date(now()).toISOString(), payload: { ...payload } })
    },
    replay: async () => journal,
    stopAllActive: () => stopped,
    journalTrustworthy: () => true,
    enabled: () => enabled,
    activeGrant: (principalId, scope) => options.activeGrant?.(principalId, scope) ?? null,
    requestOwnerApproval: async (ask) =>
      options.requestOwnerApproval?.(ask) ?? {
        approvalId: ask.approvalId,
        granted: false,
        decidedBy: 'unknown',
        decidedAt: new Date(now()).toISOString(),
      },
    approvalStillValid: () => false,
    probeSurface: async () => ({ available: server.isConnected(), code: server.isConnected() ? 'available' : 'unavailable' }),
    performBrowser: (request) => adapter.performBrowser(request),
    runTerminal: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated', exitCode: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }),
    readClipboard: async () => ({ text: '' }),
    writeClipboard: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated' }),
    clearClipboard: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated' }),
    fetchDownload: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated', bytes: 0, mediaType: null }),
    sendUpload: async () => ({ holds: false, evidence: 'observed', code: 'surface-not-activated', bytes: 0, mediaType: null }),
    onChange: () => undefined,
  }

  const runtime = createDeviceHandsRuntime({
    ports,
    localUnrestricted: options.localUnrestricted === true,
  })

  async function dispatch(request: BridgeDispatchRequest): Promise<BridgeDispatchResult> {
    if (request.command === 'control.request') {
      // Control is an owner decision, routed to the owner and only the owner. Absent a
      // decision the answer is no.
      const granted =
        options.localUnrestricted === true
          ? true
          : options.requestControl === undefined
            ? false
            : await options.requestControl(request.sessionId, request.extensionId)
      return granted
        ? { ok: true, code: null, reason: 'The owner enabled agent-driven control for this session.' }
        : {
            ok: false,
            code: 'authority-refused',
            reason: 'The owner did not enable control, so the extension can still observe but not act.',
          }
    }
    if (request.actionKey === null) {
      return adapter.observe(request)
    }
    const actionKey = request.actionKey as DeviceHandsActionKey
    adapter.begin(request.actionId, {
      connectionId: request.connectionId,
      command: request.command,
      tabId: request.tabId,
      url: request.url,
      deadlineAt: request.deadlineAt,
    })
    try {
      const outcome = await runtime.perform({
        actionId: request.actionId,
        principalId: principalFor(request.extensionId),
        scope: request.sessionId,
        actionKey,
        claimsAction: null,
        input: inputFor(actionKey, request),
        deadlineAt: new Date(request.deadlineAt).toISOString(),
        at: new Date(request.at).toISOString(),
      })
      if (!outcome.performed || outcome.verdict !== 'passed') {
        return {
          ok: false,
          code: outcome.code ?? 'authority-refused',
          reason: outcome.reason,
        }
      }
      const observed = adapter.takeObserved(request.actionId)
      return { ok: true, code: null, reason: outcome.reason, result: shapeResult(request.command, observed, request) }
    } finally {
      adapter.abandon(request.actionId)
    }
  }

  const bridge = createBrowserBridge({
    crypto: nodeBridgeCrypto,
    now,
    urlOptions: options.urlOptions ?? {},
    ports: {
      tokenStatus(hash) {
        const record = tokenStore.get(hash)
        if (record === null) return 'unknown'
        return record.revokedAt === null ? 'active' : 'revoked'
      },
      saveToken(hash, extensionId, issuedAt) {
        tokenStore.put({ hash, extensionId, issuedAt, revokedAt: null })
      },
      revokeToken(hash) {
        tokenStore.revoke(hash, now())
      },
      capabilitiesFor(): readonly BrowserBridgeCapability[] {
        return BROWSER_BRIDGE_OBSERVATION_CAPABILITIES
      },
      stopAllActive: () => stopped,
      dispatch,
      requestStop() {
        stopped = true
      },
      onAudit(entry) {
        options.audit?.(entry)
      },
    },
    pairedExtensionId: () => {
      const first = tokenStore.all()[0]
      return first?.extensionId ?? null
    },
  })

  const server = createBridgeServer({
    bridge,
    port: options.port ?? 0,
    host: options.host ?? '127.0.0.1',
    now,
    onLog: options.onLog,
  })
  transport = server.transport

  /**
   * Route one `page.navigate` into the tab the owner shared.
   *
   * The four refusals are ordered from "there is no session" to "this session cannot
   * navigate", and each one is a fact about the extension's own state rather than about
   * Freya's authority. The Device Hands gate is the fifth and last thing that can refuse,
   * which is the correct order: an answer about the protocol comes before an answer about
   * authority.
   */
  async function continueInSharedTab(request: {
    readonly url: string
    readonly deadlineAt: number
  }): Promise<{ readonly ok: boolean; readonly code: string | null; readonly reason: string; readonly tabId: number | null }> {
    const refuse = (
      code: string,
      reason: string,
    ): { readonly ok: false; readonly code: string; readonly reason: string; readonly tabId: null } => ({
      ok: false,
      code,
      reason,
      tabId: null,
    })

    if (!tokenStore.all().some((record) => record.revokedAt === null)) {
      return refuse('target-unavailable', 'No extension has ever paired with this Freya, so there is no authenticated context to continue in.')
    }
    const live = bridge.sessions().filter((session) => !session.revoked && session.expiresAt > now())
    const candidate = live.find((session) => session.sharedTabId !== null && session.sharedUrl !== null)
    if (candidate === undefined || candidate.sharedTabId === null) {
      return refuse(
        'target-unavailable',
        'The extension is connected but the owner has not shared a tab, and this build will not open one on their behalf. Share the tab you want the work continued in.',
      )
    }
    if (!candidate.capabilities.includes('page.navigate')) {
      return refuse('authority-refused', 'This session does not hold the navigate capability, so the extension is not permitted to move its tab.')
    }
    const origin = candidate.sharedOrigin
    const result = await dispatch({
      sessionId: candidate.sessionId,
      connectionId: candidate.connectionId,
      extensionId: candidate.extensionId,
      command: 'page.navigate',
      actionKey: BROWSER_BRIDGE_COMMAND_ACTION['page.navigate'],
      args: { url: request.url },
      tabId: candidate.sharedTabId,
      frameId: 0,
      url: request.url,
      origin,
      at: now(),
      deadlineAt: request.deadlineAt,
      actionId: `handoff-${candidate.sessionId}-${String(now())}`,
    })
    if (!result.ok) {
      return refuse(result.code ?? 'adapter-failed', result.reason)
    }
    return { ok: true, code: null, reason: result.reason, tabId: candidate.sharedTabId }
  }

  return {
    start: async () => {
      const result = await server.start()
      await runtime.open()
      const loaded = await runtime.loadPolicy(policy)
      if (!loaded.ok) {
        options.onLog?.(`browser extension host: policy refused: ${loaded.reason}`)
      }
      return result
    },
    stop: async () => {
      await server.stop()
    },
    continueInSharedTab,
    bridge,
    runtime,
    server,
    adapter,
    get activation() {
      return options.activation
    },
    status() {
      return {
        activation: options.activation,
        connected: server.isConnected(),
        paired: tokenStore.all().length > 0,
        pairingOpen: bridge.pairingOpen(),
        enabled,
        stopped,
      }
    },
  }
}

function inputFor(
  actionKey: DeviceHandsActionKey,
  request: BridgeDispatchRequest,
): Readonly<Record<string, unknown>> {
  const selector = request.args.selector
  const text = request.args.text
  switch (actionKey) {
    case 'browser.navigate':
      return { url: request.url }
    case 'browser.read-text':
      return selector === undefined ? { url: request.url } : { url: request.url, selector }
    case 'browser.click':
      return { url: request.url, selector }
    case 'browser.type-text':
      return { url: request.url, selector, text }
    default:
      // Only the browser surface reaches this adapter. A non-browser key here is a
      // programming error, and an empty input will be refused by the policy gate.
      return {}
  }
}

function shapeResult(
  command: string,
  observed: unknown,
  request: BridgeDispatchRequest,
): unknown {
  switch (command) {
    case 'page.read-text': {
      const text = textOf(observed)
      const bounded = truncateUtf8(text, 4 * 1024)
      return { text: bounded, bytes: utf8Bytes(bounded) }
    }
    case 'element.inspect':
      return { descriptor: observed ?? null }
    case 'element.click':
      return { clicked: true }
    case 'element.type-text':
      return { typed: true }
    case 'page.navigate':
      return { url: request.url }
    default:
      return observed ?? null
  }
}

function textOf(observed: unknown): string {
  if (typeof observed === 'string') return observed
  if (typeof observed === 'object' && observed !== null) {
    const text = (observed as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}
