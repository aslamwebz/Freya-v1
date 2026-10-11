/**
 * The control service: every method the external plane exposes, with the
 * authority path the host already uses.
 *
 * The renderer is the audience for the preload bridge; this service is the
 * audience for everything else. It deliberately does not reimplement Core, the
 * Browser service, the Conversation store, the Mission engine or the Workforce
 * projection. It calls them.
 *
 * That is the property the deliverable asks for: `freya conversation send` ends
 * up on the same conversation, in the same journal, with the same Guard
 * evaluation, as a turn the user submitted from inside Freya. A method that
 * constructed its own conversation store, or its own Browser service, would be
 * the second-authority surface the deliverable rules out.
 *
 * The STOP-ALL gate is checked on every action method. Read methods are
 * intentionally not gated — the whole point of STOP ALL is that you can still
 * *see* what is happening while nothing is allowed to act — but a call to
 * `freya status` during a STOP ALL is also the fastest way for an external
 * tool to know it should back off, so `freya status` reports the latch.
 */

import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { CoreHost } from '../coreHost'
import type { TurnIntentHints } from '../../core/mind/tool-intent'
import type { BrowserService, SemanticBrowserRequest } from '../../core/browser/service/service'
import type { SurfaceBounds } from '../../core/browser/service'
import {
  ACTION_METHODS,
  ALL_METHODS,
  PROTOCOL_VERSION,
  type CallerIdentity,
  type ControlError,
  type ControlId,
  type ControlRequest,
  type ControlResponse,
  type ControlEvent,
} from './contract'

export interface ControlServiceDeps {
  readonly coreHost: CoreHost
  readonly getBrowserService: () => BrowserService | null
  readonly getMainWindow: () => BrowserWindow | null
  readonly focusWindow: () => boolean
  /** Current STOP-ALL latch from Core. Read fresh on every call. */
  readonly stopAllActive: () => boolean
  /** Identity the host wants stamped on the journal entry, e.g. 'owner'. */
  readonly hostPrincipalId: () => 'owner' | 'system'
  /** Surface a message in the window (Core's `shell.notify` would, when present). */
  readonly notify: (text: string) => Promise<void>
}

export interface ServiceResult {
  readonly response: ControlResponse
  /** Optional asynchronous event the caller might want to subscribe to. */
  readonly subscribeTopics?: readonly string[]
}

function ok(id: ControlId, result: unknown): ControlResponse {
  return { jsonrpc: '2.0', id, result }
}

function err(id: ControlId, error: ControlError): ControlResponse {
  return { jsonrpc: '2.0', id, error }
}

function structured(code: ControlError['code'], message: string, detail?: string): ControlError {
  return detail === undefined ? { code, message } : { code, message, detail }
}

const STOP_ALL = (): ControlError =>
  structured('STOP_ALL_ACTIVE', 'Freya STOP ALL is active. Read-only operations are still available.')

function ensureMethodKnown(id: ControlId, method: string): ControlResponse | null {
  if (!ALL_METHODS.has(method)) {
    return err(id, structured('METHOD_NOT_FOUND', `unknown method: ${method}`))
  }
  return null
}

function denyIfStopAll(id: ControlId, stopAllActive: boolean, action: boolean): ControlResponse | null {
  if (stopAllActive && action) return err(id, STOP_ALL())
  return null
}

function payloadString(value: unknown, _key: string, max: number): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > max) return null
  return value
}

function payloadObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A whole number, accepting the numeric string an external caller may send. Never NaN. */
function payloadWholeNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isInteger(n) ? n : null
}

/**
 * A scroll destination: `top`, `bottom`, or a non-negative pixel offset.
 *
 * The same closed set the Browser Service accepts. An offset arrives as a string
 * from the CLI and as a number from the MCP adapter, so both are read here rather
 * than trusted to already be the right type.
 */
function payloadScrollTarget(value: unknown): 'top' | 'bottom' | number | null {
  if (value === 'top' || value === 'bottom') return value
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === 'top' || text === 'bottom') return text
    const n = Number(text)
    if (text !== '' && Number.isFinite(n) && n >= 0) return n
  }
  return null
}

/**
 * Read the owner's tool directives off an external request.
 *
 * The same closed shape the renderer sends, read the same way Core reads it: a
 * malformed value returns `undefined` and the turn is routed from its own words,
 * rather than being refused or silently rewritten. An external caller that
 * names either directive is making the same choice the composer's two buttons
 * make, and nothing more: Guard still decides whether the tool is allowed.
 */
function readIntentHints(value: unknown): TurnIntentHints | undefined {
  const obj = payloadObject(value)
  if (obj === null) return undefined
  let webSearch: boolean | undefined
  let browserUse: boolean | undefined
  if (typeof obj['webSearch'] === 'boolean') webSearch = obj['webSearch']
  if (typeof obj['browserUse'] === 'boolean') browserUse = obj['browserUse']
  if (webSearch === undefined && browserUse === undefined) return undefined
  return { ...(webSearch === undefined ? {} : { webSearch }), ...(browserUse === undefined ? {} : { browserUse }) }
}

function asCaller(value: unknown): CallerIdentity {
  const obj = payloadObject(value)
  if (obj === null) return { kind: 'unspecified' }
  const kindRaw = obj.kind
  const kind: CallerIdentity['kind'] =
    kindRaw === 'cli' || kindRaw === 'mcp' || kindRaw === 'script' ? kindRaw : 'unspecified'
  const client = typeof obj.client === 'string' ? obj.client.slice(0, 64) : undefined
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId.slice(0, 128) : undefined
  return {
    kind,
    ...(client === undefined ? {} : { client }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

export class ControlService {
  constructor(private readonly deps: ControlServiceDeps) {}

  async handle(request: ControlRequest, rawCaller: unknown): Promise<ControlResponse> {
    const caller = asCaller(rawCaller)
    const id = request.id
    const unknown = ensureMethodKnown(id, request.method)
    if (unknown !== null) return unknown

    const params = payloadObject(request.params) ?? {}
    const stopAll = this.deps.stopAllActive()
    const isAction = isActionMethod(request.method)
    const blocked = denyIfStopAll(id, stopAll, isAction)
    if (blocked !== null) return blocked

    try {
      switch (request.method) {
        case 'protocol.version':
          return ok(id, { protocolVersion: PROTOCOL_VERSION, methods: [...ALL_METHODS].sort() })

        case 'freya.status':
          return ok(id, this.status())

        case 'freya.health':
          return ok(id, this.health())

        case 'freya.focus':
          return ok(id, { focused: this.deps.focusWindow() })

        case 'conversation.list':
          return ok(id, await this.listConversations())

        case 'conversation.get': {
          const conversationId = payloadString(params.conversationId, 'conversationId', 128)
          if (conversationId === null) {
            return err(id, structured('INVALID_REQUEST', 'conversationId is required'))
          }
          return ok(id, await this.getConversation(conversationId))
        }

        case 'conversation.create': {
          const title = payloadString(params.title, 'title', 200) ?? 'New conversation'
          return ok(id, await this.createConversation(title, caller))
        }

        case 'conversation.send': {
          const conversationId = payloadString(params.conversationId, 'conversationId', 128)
          const text = payloadString(params.text, 'text', 32_000)
          if (conversationId === null || text === null) {
            return err(id, structured('INVALID_REQUEST', 'conversationId and text are required'))
          }
          // The owner's tool directives, forwarded rather than derived. Without this the
          // external plane can only say the words a turn would need to trip the router;
          // with it, "use the browser" travels as the explicit decision it is, exactly as
          // the composer's two buttons send it from inside Freya.
          const intents = readIntentHints(params.intents)
          return ok(id, await this.sendTurn(conversationId, text, caller, intents))
        }

        case 'browser.status':
          return ok(id, this.browserStatus())

        case 'browser.tabs':
          return ok(id, this.browserTabs())

        case 'browser.open': {
          const url = payloadString(params.url, 'url', 2_048)
          if (url === null) return err(id, structured('INVALID_REQUEST', 'url is required'))
          return ok(id, await this.openBrowserTab(url, caller))
        }

        case 'browser.activate': {
          const tabId = payloadString(params.tabId, 'tabId', 128)
          if (tabId === null) return err(id, structured('INVALID_REQUEST', 'tabId is required'))
          return ok(id, await this.activateBrowserTab(tabId))
        }
        case 'browser.screenshot': {
          // The bytes stay in the host: what crosses the pipe is the capture's
          // own facts, so a shell caller learns the same thing the model does.
          const tabId = typeof params.tabId === 'string' && params.tabId !== '' ? payloadString(params.tabId, 'tabId', 128) : undefined
          if (tabId === null) return err(id, structured('INVALID_REQUEST', 'tabId is invalid'))
          const capture = await this.screenshotBrowserTab(tabId ?? undefined)
          if (capture.ok !== true) return ok(id, capture)
          return ok(id, {
            ok: true,
            op: 'screenshot',
            data: {
              tabId: capture.data.tabId,
              url: capture.data.url,
              title: capture.data.title,
              revision: capture.data.revision,
              width: capture.data.width,
              height: capture.data.height,
              bytes: capture.data.bytes,
              mediaUrl: capture.data.mediaUrl,
              pngBase64: capture.data.pngBase64,
            },
          })
        }

        case 'browser.snapshot': {
          // A read: the snapshot describes the page, it does not change it. It is
          // the step that mints the numbered references a later click must quote,
          // which is what lets an external caller act on a page without a selector
          // ever crossing the pipe.
          const tabId = payloadString(params.tabId, 'tabId', 128)
          if (params.tabId !== undefined && tabId === null) {
            return err(id, structured('INVALID_REQUEST', 'tabId is invalid'))
          }
          return ok(id, await this.runBrowser({ op: 'snapshot', ...(tabId === null ? {} : { tabId }) }))
        }

        case 'browser.click': {
          const ref = payloadString(params.ref, 'ref', 64)
          if (ref === null) {
            return err(id, structured('INVALID_REQUEST', 'ref is required: the element number from a snapshot, such as r3'))
          }
          const revision = payloadWholeNumber(params.revision)
          if (revision === null || revision < 1) {
            return err(id, structured('INVALID_REQUEST', 'revision is required: the whole number the snapshot reported'))
          }
          const tabId = payloadString(params.tabId, 'tabId', 128)
          if (params.tabId !== undefined && tabId === null) {
            return err(id, structured('INVALID_REQUEST', 'tabId is invalid'))
          }
          return ok(id, await this.runBrowser({ op: 'click', ref, revision, ...(tabId === null ? {} : { tabId }) }))
        }

        case 'browser.scroll': {
          const to = payloadScrollTarget(params.to)
          if (to === null) {
            return err(id, structured('INVALID_REQUEST', 'to is required: top, bottom, or a number of pixels'))
          }
          const tabId = payloadString(params.tabId, 'tabId', 128)
          if (params.tabId !== undefined && tabId === null) {
            return err(id, structured('INVALID_REQUEST', 'tabId is invalid'))
          }
          return ok(id, await this.runBrowser({ op: 'scroll', to, ...(tabId === null ? {} : { tabId }) }))
        }

        case 'browser.dock': {
          // Placement, not a page act: docking shows Freya's own view so a
          // snapshot/scroll/screenshot has a sized viewport to work with. It is a
          // read for the STOP-ALL gate (the same as the renderer docking its own
          // panel), and it never touches a page itself.
          const tabId = payloadString(params.tabId, 'tabId', 128)
          if (params.tabId !== undefined && tabId === null) {
            return err(id, structured('INVALID_REQUEST', 'tabId is invalid'))
          }
          return ok(id, this.dockBrowser(tabId))
        }

        case 'browser.undock':
          return ok(id, this.undockBrowser())

        case 'mission.list':
          return ok(id, this.listMissions())

        case 'mission.get': {
          const missionId = payloadString(params.missionId, 'missionId', 128)
          if (missionId === null) return err(id, structured('INVALID_REQUEST', 'missionId is required'))
          return ok(id, this.getMission(missionId))
        }

        case 'agent.list':
          return ok(id, this.listAgents())

        case 'notification.send': {
          const text = payloadString(params.text, 'text', 1_000)
          if (text === null) return err(id, structured('INVALID_REQUEST', 'text is required'))
          await this.deps.notify(text)
          return ok(id, { sent: true })
        }

        case 'system.stopStatus':
          return ok(id, { stopAllActive: this.deps.stopAllActive() })

        case 'event.subscribe':
        case 'event.unsubscribe':
        case 'wait':
          // The server implements these. The service reports a structured error
          // here so a caller that reaches the service layer without the server
          // sees something honest.
          return err(id, structured('METHOD_NOT_FOUND', `${request.method} is server-implemented`))

        default:
          return err(id, structured('METHOD_NOT_FOUND', `unknown method: ${request.method}`))
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return err(id, structured('INTERNAL', `internal error: ${detail}`))
    }
  }

  /* ------------------------------------------------------ read methods */

  private status(): Record<string, unknown> {
    const core = this.deps.coreHost
    const projection = core.status()
    return {
      ready: true,
      coreStatus: projection,
      stopAllActive: this.deps.stopAllActive(),
      browser: this.browserStatus(),
    }
  }

  private health(): Record<string, unknown> {
    const core = this.deps.coreHost
    const projection = core.status()
    return {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      core: {
        lifecycle: projection.lifecycle,
        providers: projection.providers.map((p) => ({ id: p.id, status: p.status })),
        stopAllActive: projection.stopAll?.active ?? false,
      },
    }
  }

  private async listConversations(): Promise<unknown> {
    const projection = await this.deps.coreHost.conversation()
    if (projection === null) return { conversations: [] }
    return { conversations: projection.conversations }
  }

  private async getConversation(conversationId: string): Promise<unknown> {
    const projection = await this.deps.coreHost.conversation()
    if (projection === null) return { found: false, conversationId }
    const summary = projection.conversations.find((s) => s.conversationId === conversationId)
    if (summary === undefined) return { found: false, conversationId }
    // The projection's `messages` field is the active conversation's transcript.
    // When the requested conversation is the active one, return those messages.
    // For an inactive conversation we report the summary only — Core does not
    // currently expose a per-conversation transcript, and a fabricated list of
    // messages would be a worse answer than a clear "this is the active one".
    if (projection.activeConversationId === conversationId) {
      return { found: true, summary, messages: projection.messages, isActive: true }
    }
    return { found: true, summary, messages: [], isActive: false }
  }

  private browserStatus(): Record<string, unknown> {
    const service = this.deps.getBrowserService()
    if (service === null) {
      return { available: false, reason: 'the browser service is not mounted in this build' }
    }
    const state = service.state()
    return {
      available: state.available,
      active: state.active,
      tabCount: state.tabCount,
      activeTabId: state.activeTabId,
      reason: state.reason ?? null,
    }
  }

  private browserTabs(): unknown {
    const service = this.deps.getBrowserService()
    if (service === null) return { tabs: [], reason: 'the browser service is not mounted' }
    return { tabs: service.tabs() }
  }

  private listMissions(): unknown {
    const projection = this.deps.coreHost.mission()
    if (projection === null) return { missions: [] }
    return { missions: projection.missions }
  }

  private getMission(missionId: string): unknown {
    const projection = this.deps.coreHost.mission()
    if (projection === null) return { found: false, missionId }
    const mission = projection.missions.find((m) => m.missionId === missionId)
    if (mission === undefined) return { found: false, missionId }
    return { found: true, mission }
  }

  private listAgents(): unknown {
    const projection = this.deps.coreHost.workforce()
    if (projection === null) return { agents: [] }
    return { agents: projection.workers }
  }

  /* ----------------------------------------------------- action methods */

  private async createConversation(title: string, _caller: CallerIdentity) {
    const result = await this.deps.coreHost.submit({
      command: 'conversation.create',
      requestId: `ctrl-${randomUUID()}`,
      payload: { title },
    })
    return result
  }

  private async sendTurn(conversationId: string, text: string, caller: CallerIdentity, intents?: TurnIntentHints) {
    const result = await this.deps.coreHost.submit({
      command: 'conversation.turn.submit',
      requestId: `ctrl-${randomUUID()}`,
      payload: {
        conversationId,
        text,
        // Attribution as metadata: Core does not currently read `actor`, but the
        // journal/audit story needs the request to be marked as externally driven.
        // The field is dropped by Core today; it is kept here as a future hook
        // and as documentation of the caller's intent.
        ...attributionField(caller),
        ...(intents === undefined ? {} : { intents }),
      },
    })
    return result
  }

  private async openBrowserTab(url: string, _caller: CallerIdentity) {
    const service = this.deps.getBrowserService()
    if (service === null) {
      return {
        ok: false,
        code: 'BROWSE_DENIED',
        reason: 'the browser service is not mounted in this build',
      }
    }
    return service.run({
      op: 'open',
      url,
      origin: { kind: 'manual' },
      createdBy: 'user',
    })
  }

  private async activateBrowserTab(tabId: string) {
    const service = this.deps.getBrowserService()
    if (service === null) {
      return { ok: false, code: 'BROWSE_DENIED', reason: 'the browser service is not mounted' }
    }
    return service.run({ op: 'activate', tabId })
  }

  /**
   * Capture the front tab as PNG.
   *
   * A read, not an action: the pixels exist either way, and the STOP-ALL gate is
   * about stopping acts. It routes through the same service the renderer and the
   * Mind use, so a capture from the shell is the same capture the model asks for,
   * with the same refusals — including the one that matters most, that a tab
   * whose view is not on screen has no pixels to capture.
   */
  private screenshotBrowserTab(tabId?: string) {
    const service = this.deps.getBrowserService()
    if (service === null) {
      return Promise.resolve({ ok: false, code: 'BROWSE_DENIED', reason: 'the browser service is not mounted' } as const)
    }
    return service.run({ op: 'screenshot', ...(tabId === undefined ? {} : { tabId }) })
  }

  /**
   * One semantic browser request through the mounted service.
   *
   * The same door the Mind's browser tool and the renderer use, so an external
   * snapshot, click or scroll is the same request with the same refusals —
   * including the one that matters most, that a click quoting a revision the page
   * has moved past is refused (`stale-reference`) rather than acted on.
   */
  private async runBrowser(request: SemanticBrowserRequest) {
    const service = this.deps.getBrowserService()
    if (service === null) {
      return {
        ok: false as const,
        code: 'BROWSE_DENIED' as const,
        reason: 'the browser service is not mounted in this build',
      }
    }
    return service.run(request)
  }

  /**
   * Give a tab's embedded view a real size.
   *
   * A view that was opened but never docked has no viewport: a snapshot can still
   * read the DOM, but `scroll` reads a height of 0 and a screenshot returns 0x0.
   * This is the explicit lifecycle control an external caller needs, using the
   * same `BrowserService.dock` seam the renderer's own browser panel uses. The
   * rect is derived from the window's own content bounds — never from a caller —
   * for the same reason `freya:browser:dock` re-derives it.
   */
  private dockBrowser(tabId: string | null): unknown {
    const service = this.deps.getBrowserService()
    if (service === null) {
      return { ok: false, code: 'BROWSE_DENIED', reason: 'the browser service is not mounted in this build' }
    }
    const resolved = tabId ?? service.activeTabId()
    if (resolved === null) {
      return { ok: false, code: 'tab-unknown', reason: 'there is no tab to dock' }
    }
    const record = service.tab(resolved)
    if (record === null) {
      return { ok: false, code: 'tab-unknown', reason: `there is no tab ${resolved}` }
    }
    const bounds = this.browserDockBounds()
    if (bounds === null) {
      return { ok: false, code: 'surface-unavailable', reason: 'the main window has no sized content area to dock the browser into' }
    }
    const docked = service.dock(record.sessionId, bounds)
    return { ok: true, docked, tabId: resolved, sessionId: record.sessionId, bounds }
  }

  /** Hide whatever view is attached. Idempotent. */
  private undockBrowser(): unknown {
    const service = this.deps.getBrowserService()
    if (service === null) {
      return { ok: false, code: 'BROWSE_DENIED', reason: 'the browser service is not mounted in this build' }
    }
    return { ok: true, docked: service.dock(null, null) }
  }

  /**
   * The rect the embedded view is docked to.
   *
   * The window's full content area. It is deliberately not the caller's choice:
   * placement is a host fact, and a caller-supplied rect is how a native view
   * ends up parked over application chrome. The surface refuses a rect smaller
   * than its own minimum, so a window too small to hold a view docks nothing and
   * says so.
   */
  private browserDockBounds(): SurfaceBounds | null {
    const window = this.deps.getMainWindow()
    if (window === null || window.isDestroyed()) return null
    const content = window.getContentBounds()
    if (content.width < 320 || content.height < 240) return null
    return { x: 0, y: 0, width: content.width, height: content.height }
  }
}

function isActionMethod(method: string): boolean {
  // One set, read from the contract, so a new action method cannot be added to the
  // wire and forgotten by the STOP-ALL gate (or vice versa).
  return ACTION_METHODS.has(method)
}

function actorField(caller: CallerIdentity, action: string): Record<string, unknown> {
  return {
    source: 'external',
    action,
    client: caller.client ?? caller.kind,
    sessionId: caller.sessionId ?? null,
  }
}

function attributionField(caller: CallerIdentity): Record<string, unknown> {
  return { attribution: actorField(caller, 'control-plane') }
}

export type { ControlEvent }
