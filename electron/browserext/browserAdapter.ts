import type {
  BridgeDispatchRequest,
  BridgeDispatchResult,
  BrowserBridgeCommand,
} from '../../core/browserext'
import { truncateUtf8, utf8Bytes } from '../../core/browserext'
import type { BrowserPortOutcome } from '../../core/devicehands'
import type { ExtensionRequest, ExtensionResponse } from './protocol'

/**
 * The browser adapter: the Device Hands browser port, filled by a paired extension.
 *
 * This is the only place in Phase 43 where a page operation is actually requested of a
 * device, and it is downstream of every gate: the bridge has authenticated the session,
 * the Device Hands runtime has walked all ten gates, and this adapter sees only an
 * already-authorised `BrowserPortRequest`.
 *
 * Two honesty rules from Phase 35 are honoured here:
 *
 *   - A port that answered is `evidence: 'observed'`, because the extension performed
 *     the operation in the page and reported what it saw. A port that failed is
 *     `holds: false` and the runtime records `unverified` or `failed`, never `passed`.
 *   - The page text is **not** returned to the runtime. It is stashed in a bounded,
 *     short-lived buffer keyed by action id, so the runtime keeps its contract of
 *     returning only a byte count, and the host can read the content back after the
 *     action has been verified.
 */

export interface BrowserTransport {
  /** Send one request to a connection and await its response. Must reject on close. */
  send(connectionId: string, request: ExtensionRequest): Promise<ExtensionResponse>
}

export interface ActionContext {
  readonly connectionId: string
  readonly command: BrowserBridgeCommand
  readonly tabId: number | null
  readonly url: string | null
  readonly deadlineAt: number
}

export interface BrowserAdapter {
  begin(actionId: string, context: ActionContext): void
  abandon(actionId: string): void
  performBrowser(request: {
    readonly actionId: string
    readonly url: string
    readonly selector: string | null
    readonly text: string | null
    readonly deadlineAt: string
  }): Promise<BrowserPortOutcome>
  observe(request: BridgeDispatchRequest): Promise<BridgeDispatchResult>
  takeObserved(actionId: string): unknown
}

export interface BrowserAdapterOptions {
  readonly transport: BrowserTransport
  readonly now: () => number
  /** How long to wait for the extension before failing closed. */
  readonly timeoutMs?: number
}

interface Stashed {
  readonly value: unknown
  readonly expiresAt: number
}

const DEFAULT_TIMEOUT = 15_000

export function createBrowserAdapter(options: BrowserAdapterOptions): BrowserAdapter {
  const contexts = new Map<string, ActionContext>()
  const observed = new Map<string, Stashed>()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT

  function stash(actionId: string, value: unknown): void {
    observed.set(actionId, { value, expiresAt: options.now() + 60_000 })
    while (observed.size > 32) {
      const oldest = observed.keys().next().value
      if (oldest === undefined) break
      observed.delete(oldest)
    }
  }

  async function request(
    connectionId: string,
    actionId: string,
    command: BrowserBridgeCommand,
    args: Readonly<Record<string, unknown>>,
    tabId: number | null,
    url: string | null,
    deadlineAt: number,
  ): Promise<ExtensionResponse | { readonly ok: false; readonly code: string; readonly reason: string }> {
    const payload: ExtensionRequest = {
      kind: 'request',
      requestId: actionId,
      command,
      args,
      tabId,
      frameId: 0,
      url,
      deadlineAt,
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        options.transport.send(connectionId, payload),
        new Promise<{ ok: false; code: string; reason: string }>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              ok: false,
              code: 'extension-timeout',
              reason: 'The extension did not answer before the deadline, so the action failed closed.',
            })
          }, timeoutMs)
        }),
      ])
    } catch (error) {
      return {
        ok: false,
        code: 'extension-unavailable',
        reason: `The extension connection ended before it answered: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  function bytesOf(value: unknown): number {
    if (typeof value === 'string') return utf8Bytes(value)
    if (typeof value === 'object' && value !== null) {
      const text = (value as { text?: unknown }).text
      if (typeof text === 'string') return utf8Bytes(text)
    }
    return 0
  }

  return {
    begin(actionId, context) {
      contexts.set(actionId, context)
    },

    abandon(actionId) {
      contexts.delete(actionId)
    },

    async performBrowser(portRequest) {
      const context = contexts.get(portRequest.actionId)
      if (context === undefined) {
        // No context means this action did not come through an authenticated command.
        // It is refused rather than guessed at.
        return {
          holds: false,
          evidence: 'observed',
          code: 'no-command-context',
          finalUrl: null,
          textBytes: 0,
        }
      }
      const response = await request(
        context.connectionId,
        portRequest.actionId,
        context.command,
        {
          ...(portRequest.selector === null ? {} : { selector: portRequest.selector }),
          ...(portRequest.text === null ? {} : { text: portRequest.text }),
        },
        context.tabId,
        portRequest.url,
        Date.parse(portRequest.deadlineAt),
      )
      if (!response.ok) {
        return {
          holds: false,
          evidence: 'observed',
          code: response.code,
          finalUrl: null,
          textBytes: 0,
        }
      }
      const value = (response as ExtensionResponse).result
      stash(portRequest.actionId, value)
      return {
        holds: true,
        evidence: 'observed',
        code: 'ok',
        finalUrl: portRequest.url,
        textBytes: bytesOf(value),
      }
    },

    async observe(dispatchRequest) {
      const response = await request(
        dispatchRequest.connectionId,
        dispatchRequest.actionId,
        dispatchRequest.command,
        dispatchRequest.args,
        dispatchRequest.tabId,
        dispatchRequest.url,
        dispatchRequest.deadlineAt,
      )
      if (!response.ok) {
        return { ok: false, code: response.code, reason: response.reason }
      }
      const value = (response as ExtensionResponse).result
      if (dispatchRequest.command === 'selection.read') {
        const text = typeof value === 'object' && value !== null ? (value as { text?: unknown }).text : undefined
        if (typeof text !== 'string') {
          return { ok: false, code: 'payload-invalid', reason: 'The extension did not return selected text.' }
        }
        const bounded = truncateUtf8(text, 4 * 1024)
        return { ok: true, code: 'read', reason: 'selection read', result: { text: bounded, bytes: utf8Bytes(bounded) } }
      }
      return { ok: true, code: 'observed', reason: 'observed', result: value ?? null }
    },

    takeObserved(actionId) {
      const entry = observed.get(actionId)
      observed.delete(actionId)
      if (entry === undefined) return null
      if (entry.expiresAt < options.now()) return null
      return entry.value
    },
  }
}
