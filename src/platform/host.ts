import type {
  CoreCommandName,
  CoreCommandResult,
  CoreStatus,
} from '../../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../../core/protocol/activity'

/**
 * The shape of the desktop bridge, declared once.
 *
 * `electron/preload.ts` is the only place these functions are implemented, and
 * this file is the only place the renderer describes them. Having two
 * declarations of `window.freyaHost` would let the two drift — one would
 * describe a bridge the other does not have — so the interface lives here and
 * both the workspace store and the Core client import it.
 *
 * The list is the whole privileged surface. Anything not named here does not
 * exist as far as the renderer is concerned.
 */

/** What the host reports verbatim. */
export interface HostRuntimeInfo {
  version: string
  electron: string
  platform: string
  arch: string
  userData: string
  workspaceFile: string
  dev: boolean
}

/** What the shell uses: platform and arch folded into one label. */
export interface RuntimeInfo {
  version: string
  platform: string
  userData: string
  workspaceFile: string
  dev: boolean
}

export interface FreyaHostBridge {
  isDesktop: true

  getRuntimeInfo(): Promise<HostRuntimeInfo>
  loadWorkspace(): Promise<unknown>
  saveWorkspace(payload: unknown): Promise<boolean>
  /** The host asks for the current layout as the window is closing. */
  onCollect(handler: () => unknown): void

  coreSubmit(command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult>
  coreStatus(): Promise<CoreStatus>
  /** Returns a disposer, so a React effect can clean up. */
  onCoreStatus(handler: (status: CoreStatus) => void): () => void

  /**
   * Display-ready activity, derived from durable events.
   *
   * The absence of a generic event reader here is the security property, not an
   * oversight. A window can have rows; it cannot have the journal.
   */
  coreActivity(): Promise<CoreActivityEvent[]>
  onCoreActivity(handler: (activity: CoreActivityEvent[]) => void): () => void
}

declare global {
  interface Window {
    freyaHost?: FreyaHostBridge
  }
}

export function hostBridge(): FreyaHostBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.freyaHost
}
