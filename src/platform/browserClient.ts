import type { BrowserRequest, BrowserResult } from '../../core/browser'
import type { BrowserBridgeState } from '../../electron/browser/rendererRequest'
import { hostBridge } from './host'

export const ABSENT_BROWSER_STATE: BrowserBridgeState = Object.freeze({
  available: false,
  active: false,
  reason: 'This window cannot reach the Freya browser runtime.',
  publicAvailable: false,
  extensionPaired: false,
  extensionLive: false,
  journalTrustworthy: false,
  summary: 'browser runtime unreachable',
  sessions: [],
  handoffs: [],
  described: 0,
  staleRefs: 0,
  mediaObserved: 0,
  refusals: 0,
})

export async function readBrowserState(): Promise<BrowserBridgeState> {
  const host = hostBridge()
  if (!host) return ABSENT_BROWSER_STATE
  try {
    return await host.browserState()
  } catch (error) {
    return {
      ...ABSENT_BROWSER_STATE,
      reason: error instanceof Error ? error.message : 'The browser runtime could not be read.',
    }
  }
}

export async function executeBrowser(request: BrowserRequest): Promise<BrowserResult> {
  const host = hostBridge()
  if (!host) {
    return {
      ok: false,
      command: request.command,
      target: null,
      code: 'subsystem-disabled',
      reason: ABSENT_BROWSER_STATE.reason ?? 'The browser runtime is unavailable.',
      escalation: null,
    }
  }
  try {
    return await host.browserExecute(request)
  } catch (error) {
    return {
      ok: false,
      command: request.command,
      target: null,
      code: 'request-malformed',
      reason: error instanceof Error ? error.message : 'The browser request was refused at the desktop boundary.',
      escalation: null,
    }
  }
}
