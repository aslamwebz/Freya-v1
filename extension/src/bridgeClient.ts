import {
  BRIDGE_PROTOCOL,
  isHostRequest,
  isServerMessage,
  type BridgeCommand,
  type BridgeEvent,
  type CommandResult,
  type HostRequest,
  type HostResponse,
} from './protocol'
import {
  clickElement,
  collectSelection,
  collectText,
  inspectElement,
  typeIntoElement,
} from './content'

/**
 * The extension side of the bridge.
 *
 * It holds a WebSocket to the Freya host on loopback, pairs once, authenticates each
 * session with a stored token, and relays host requests into the shared tab. It never
 * decides authority: a request that arrives is one the host has already allowed, and
 * the only thing this client can do is refuse to perform it.
 */

const DEFAULT_PORT = 47821
const STORAGE_TOKEN = 'freya.bridge.token'
const STORAGE_PORT = 'freya.bridge.port'
const COMMAND_TIMEOUT_MS = 20_000

export type BridgeStatus =
  | 'disconnected'
  | 'connecting'
  | 'awaiting-pairing'
  | 'paired'
  | 'stopped'

export interface BridgeState {
  readonly status: BridgeStatus
  readonly sessionId: string | null
  readonly expiresAt: number | null
  readonly capabilities: readonly string[]
  readonly sharedTabId: number | null
  readonly sharedOrigin: string | null
  readonly control: boolean
  readonly lastAction: string
  readonly lastCode: string | null
  readonly port: number
}

interface Pending {
  resolve: (result: CommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class BridgeClient {
  private socket: WebSocket | null = null
  private token: string | null = null
  private port = DEFAULT_PORT
  private sessionId: string | null = null
  private expiresAt: number | null = null
  private capabilities: string[] = []
  private sharedTabId: number | null = null
  private sharedOrigin: string | null = null
  private control = false
  private stopped = false
  private seq = 0
  private lastAction = 'idle'
  private lastCode: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly pairWaiters: Array<(ok: boolean) => void> = []
  private listeners: Array<(state: BridgeState) => void> = []

  async load(): Promise<void> {
    const stored = await chrome.storage.local.get([STORAGE_TOKEN, STORAGE_PORT])
    const token = stored[STORAGE_TOKEN]
    const port = stored[STORAGE_PORT]
    this.token = typeof token === 'string' ? token : null
    this.port = typeof port === 'number' ? port : DEFAULT_PORT
  }

  state(): BridgeState {
    return {
      status: this.status(),
      sessionId: this.sessionId,
      expiresAt: this.expiresAt,
      capabilities: [...this.capabilities],
      sharedTabId: this.sharedTabId,
      sharedOrigin: this.sharedOrigin,
      control: this.control,
      lastAction: this.lastAction,
      lastCode: this.lastCode,
      port: this.port,
    }
  }

  private status(): BridgeStatus {
    if (this.stopped) return 'stopped'
    if (this.sessionId !== null) return 'paired'
    if (this.socket === null) return 'disconnected'
    if (this.socket.readyState === WebSocket.CONNECTING) return 'connecting'
    return 'awaiting-pairing'
  }

  subscribe(listener: (state: BridgeState) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    }
  }

  private notify(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }

  async connect(): Promise<void> {
    if (this.socket !== null && this.socket.readyState <= WebSocket.OPEN) return
    this.stopped = false
    const socket = new WebSocket(`ws://127.0.0.1:${String(this.port)}/freya-browser-bridge`)
    this.socket = socket
    this.notify()
    socket.onmessage = (event) => {
      void this.onMessage(typeof event.data === 'string' ? event.data : '')
    }
    socket.onclose = () => {
      this.socket = null
      this.sessionId = null
      this.capabilities = []
      this.notify()
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      // The close handler is the one that acts; an error is not a decision.
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5))
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private send(message: unknown): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private async onMessage(text: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (isHostRequest(parsed)) {
      const response = await this.perform(parsed)
      this.send(response)
      return
    }
    if (!isServerMessage(parsed)) return
    switch (parsed.kind) {
      case 'server.hello':
        if (parsed.protocol !== BRIDGE_PROTOCOL) {
          this.lastCode = 'protocol-mismatch'
          this.notify()
          return
        }
        if (this.token !== null) {
          this.send({
            kind: 'auth.request',
            token: this.token,
            extensionId: chrome.runtime.id,
            clientNonce: crypto.randomUUID(),
          })
        }
        return
      case 'auth.ok':
        this.sessionId = parsed.sessionId
        this.expiresAt = parsed.expiresAt
        this.capabilities = [...parsed.capabilities]
        this.reconnectAttempts = 0
        this.lastAction = 'authenticated'
        this.lastCode = null
        this.notify()
        return
      case 'pair.ok':
        this.token = parsed.token
        await chrome.storage.local.set({ [STORAGE_TOKEN]: parsed.token })
        this.sessionId = parsed.sessionId
        this.expiresAt = parsed.expiresAt
        this.capabilities = [...parsed.capabilities]
        this.reconnectAttempts = 0
        this.lastAction = 'paired'
        this.lastCode = null
        for (const waiter of this.pairWaiters.splice(0)) waiter(true)
        this.notify()
        return
      case 'command.result': {
        const pending = this.pending.get(parsed.idempotencyKey)
        if (pending !== undefined) {
          clearTimeout(pending.timer)
          this.pending.delete(parsed.idempotencyKey)
          pending.resolve(parsed)
        }
        if (parsed.ok) {
          this.lastAction = `command ${parsed.code ?? 'ok'}`
          this.lastCode = null
        } else {
          this.lastAction = 'command refused'
          this.lastCode = parsed.code
        }
        this.notify()
        return
      }
      case 'refused':
        if (parsed.code === 'pairing-code-invalid' || parsed.code === 'pairing-expired' || parsed.code === 'pairing-closed' || parsed.code === 'pairing-attempts-exceeded') {
          for (const waiter of this.pairWaiters.splice(0)) waiter(false)
        }
        if (parsed.code === 'token-invalid' || parsed.code === 'token-revoked') {
          this.token = null
          await chrome.storage.local.remove(STORAGE_TOKEN)
        }
        this.lastAction = 'refused'
        this.lastCode = parsed.code
        this.notify()
        return
    }
  }

  async pair(code: string): Promise<{ ok: boolean; code: string | null }> {
    await this.connect()
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, code: 'not-connected' }
    }
    const wait = new Promise<boolean>((resolve) => {
      this.pairWaiters.push(resolve)
      setTimeout(() => resolve(false), 15_000)
    })
    this.send({
      kind: 'pair.request',
      pairingCode: code,
      extensionId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
    })
    const ok = await wait
    return { ok, code: ok ? null : this.lastCode }
  }

  async command(command: BridgeCommand, args: Record<string, unknown>): Promise<CommandResult> {
    if (this.sessionId === null) {
      return {
        kind: 'command.result',
        sessionId: '',
        idempotencyKey: '',
        ok: false,
        code: 'not-paired',
        reason: 'This extension is not paired with Freya.',
        result: null,
      }
    }
    if (command === 'page.unshare') {
      this.sharedTabId = null
      this.sharedOrigin = null
    }
    this.seq += 1
    const idempotencyKey = crypto.randomUUID()
    const message = {
      kind: 'command',
      sessionId: this.sessionId,
      seq: this.seq,
      nonce: crypto.randomUUID(),
      idempotencyKey,
      command,
      args,
    }
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(idempotencyKey)
        resolve({
          kind: 'command.result',
          sessionId: this.sessionId ?? '',
          idempotencyKey,
          ok: false,
          code: 'timeout',
          reason: 'The host did not answer in time.',
          result: null,
        })
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(idempotencyKey, { resolve, timer })
      this.send(message)
    })
  }

  sendEvent(event: BridgeEvent, payload: Record<string, unknown>): void {
    if (this.sessionId === null) return
    this.seq += 1
    this.send({
      kind: 'event',
      sessionId: this.sessionId,
      seq: this.seq,
      nonce: crypto.randomUUID(),
      event,
      payload,
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.command('control.stop', {})
    this.sessionId = null
    this.capabilities = []
    this.sharedTabId = null
    this.sharedOrigin = null
    this.control = false
    this.notify()
  }

  /** Handle one host request. The host has already authorised it. */
  private async perform(request: HostRequest): Promise<HostResponse> {
    const fail = (code: string, reason: string): HostResponse => ({
      kind: 'response',
      requestId: request.requestId,
      ok: false,
      code,
      reason,
      result: null,
    })
    const ok = (result: unknown, code = 'ok', reason = 'done'): HostResponse => ({
      kind: 'response',
      requestId: request.requestId,
      ok: true,
      code,
      reason,
      result,
    })
    try {
      switch (request.command) {
        case 'tab.metadata': {
          const tab = await this.resolveTab(request.tabId)
          if (tab === null || tab.id === undefined) return fail('tab-not-found', 'No tab matched.')
          return ok({
            tabId: tab.id,
            windowId: tab.windowId ?? null,
            url: tab.url ?? null,
            title: tab.title ?? null,
            active: tab.active === true,
          })
        }
        case 'selection.read': {
          const tab = await this.resolveTab(request.tabId)
          if (tab === null || tab.id === undefined) return fail('tab-not-found', 'No tab matched.')
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: collectSelection,
          })
          return ok(injection?.result ?? { text: '' })
        }
        case 'page.read-text': {
          const tab = await this.resolveTab(request.tabId)
          if (tab === null || tab.id === undefined) return fail('tab-not-found', 'No tab matched.')
          const selector = typeof request.args.selector === 'string' ? request.args.selector : null
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: collectText,
            args: [selector],
          })
          return ok(injection?.result ?? { text: '' })
        }
        case 'element.inspect': {
          const tab = await this.resolveTab(request.tabId)
          if (tab === null || tab.id === undefined) return fail('tab-not-found', 'No tab matched.')
          const selector = typeof request.args.selector === 'string' ? request.args.selector : ''
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: inspectElement,
            args: [selector],
          })
          const result = injection?.result
          if (result === undefined || result.kind === 'missing') return fail('element-missing', 'No element matched.')
          if (result.kind === 'protected') return fail('protected-field', `That is a ${result.field} field.`)
          return ok(result.descriptor)
        }
        case 'element.click': {
          const tab = await this.resolveTab(request.tabId)
          if (tab === null || tab.id === undefined) return fail('tab-not-found', 'No tab matched.')
          const selector = typeof request.args.selector === 'string' ? request.args.selector : ''
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: clickElement,
            args: [selector],
          })
          const result = injection?.result
          if (result === undefined || !result.clicked) {
            return fail('element-not-clickable', result?.reason ?? 'The element could not be clicked.')
          }
          return ok({ clicked: true })
        }
        case 'element.type-text': {
          const tab = await this.resolveTab(request.tabId)
          if (tab === null || tab.id === undefined) return fail('tab-not-found', 'No tab matched.')
          const selector = typeof request.args.selector === 'string' ? request.args.selector : ''
          const text = typeof request.args.text === 'string' ? request.args.text : ''
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: typeIntoElement,
            args: [selector, text],
          })
          const result = injection?.result
          if (result === undefined || !result.typed) {
            if (result?.reason === 'protected') return fail('protected-field', 'That is a protected field.')
            return fail('element-not-editable', result?.reason ?? 'The element could not be typed into.')
          }
          return ok({ typed: true })
        }
        case 'page.navigate': {
          const tab = await this.resolveTab(request.tabId)
          if (tab === null || tab.id === undefined) return fail('tab-not-found', 'No tab matched.')
          const url = typeof request.args.url === 'string' ? request.args.url : (request.url ?? '')
          const updated = await chrome.tabs.update(tab.id, { url })
          return ok({ url: updated.url ?? url })
        }
        default:
          return fail('command-unknown', 'That command is not one this extension performs.')
      }
    } catch (error) {
      return fail('extension-error', error instanceof Error ? error.message : String(error))
    }
  }

  private async resolveTab(tabId: number | null): Promise<chrome.tabs.Tab | null> {
    if (tabId !== null) {
      try {
        return await chrome.tabs.get(tabId)
      } catch {
        return null
      }
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return tabs[0] ?? null
  }

  /** Apply a status the host reported for this session. */
  applyControl(control: boolean, sharedTabId: number | null, sharedOrigin: string | null): void {
    this.control = control
    this.sharedTabId = sharedTabId
    this.sharedOrigin = sharedOrigin
    this.notify()
  }
}
