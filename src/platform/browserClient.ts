import type { BrowserRequest, BrowserResult } from '../../core/browser'
import type { BrowserBridgeState } from '../../electron/browser/rendererRequest'
import type { SemanticBrowserRequest, SemanticBrowserResult } from '../../core/browser/service'
import { hostBridge } from './host'

/**
 * The browser's lifecycle, in renderer vocabulary.
 *
 * The renderer no longer infers runtime health from `sessions.length`. The state machine says
 * which of five states it is in and why, and the workspace draws the panel that matches.
 */
export type RuntimeStatus = BrowserBridgeState['runtimeStatus']

/**
 * What the renderer knows when the browser host is unreachable at all.
 *
 * `surfaceUnavailable` rather than a hopeful "active with no sessions": a window that cannot
 * reach the host has no browser, and saying otherwise is how an empty panel came to mean
 * "loading" for months.
 */
export const ABSENT_BROWSER_STATE: BrowserBridgeState = Object.freeze({
  available: false,
  active: false,
  reason: 'This window cannot reach the Freya browser runtime.',
  publicAvailable: false,
  journalTrustworthy: false,
  runtimeStatus: 'surfaceUnavailable',
  activeTabId: null,
  tabs: [],
  tabCount: 0,
  recovery: null,
  extensionPaired: false,
  extensionLive: false,
  summary: 'browser runtime unreachable',
  sessions: [],
  phase51: [],
  described: 0,
  staleRefs: 0,
  mediaObserved: 0,
  refusals: 0,
})

/** Read the browser state once. Used on mount, and never on a timer. */
export async function readBrowserState(): Promise<BrowserBridgeState> {
  const host = hostBridge()
  if (host === undefined) return ABSENT_BROWSER_STATE
  try {
    return await host.browserState()
  } catch {
    return ABSENT_BROWSER_STATE
  }
}

/**
 * Subscribe to browser state.
 *
 * This is what replaces polling. Returns an unsubscribe function, and returns a no-op
 * unsubscribe when the host has no push channel — so a caller never has to branch on whether
 * the feature exists before it can clean up.
 */
export function onBrowserState(handler: (state: BrowserBridgeState) => void): () => void {
  const host = hostBridge()
  if (host === undefined || typeof host.onBrowserEvent !== 'function') return () => undefined
  try {
    return host.onBrowserEvent(handler)
  } catch {
    return () => undefined
  }
}

/** One Semantic Browser Protocol operation. */
export async function runBrowserCommand(request: SemanticBrowserRequest): Promise<SemanticBrowserResult> {
  const host = hostBridge()
  if (host === undefined || typeof host.browserCommand !== 'function') {
    return {
      ok: false,
      op: request.op,
      code: 'subsystem-disabled',
      reason: 'This window cannot reach the Freya browser runtime, so nothing was opened or changed.',
      data: {},
    }
  }
  try {
    return await host.browserCommand(request)
  } catch (error) {
    return {
      ok: false,
      op: request.op,
      code: 'adapter-failed',
      reason: error instanceof Error ? error.message : 'The browser did not answer.',
      data: {},
    }
  }
}

/**
 * The routed Phase 51 vocabulary.
 *
 * Still here because other parts of the renderer reach the runtime through it — the eye
 * handoff and the citation opener both build a `page.navigate` request. It is not the path a
 * browser tab takes any more: tabs are created and driven through {@link runBrowserCommand},
 * which is the only path that can hold a tab identity from open to close.
 */
export async function executeBrowser(request: BrowserRequest): Promise<BrowserResult> {
  const host = hostBridge()
  if (host === undefined) {
    return {
      ok: false,
      command: request.command,
      target: null,
      code: 'subsystem-disabled',
      reason: 'This window cannot reach the Freya browser runtime.',
      escalation: null,
    }
  }
  try {
    return await host.browserExecute(request)
  } catch {
    return {
      ok: false,
      command: request.command,
      target: null,
      code: 'request-malformed',
      reason: 'The browser refused that request as malformed.',
      escalation: null,
    }
  }
}

/** Place the native view for the front tab. Bounds are clamped in the main process. */
export async function dockBrowserView(input: { sessionId: string | null; bounds: { x: number; y: number; width: number; height: number } | null }): Promise<boolean> {
  const host = hostBridge()
  if (host === undefined || typeof host.browserDock !== 'function') return false
  try {
    return await host.browserDock(input)
  } catch {
    return false
  }
}

export type { BrowserBridgeState, SemanticBrowserResult }