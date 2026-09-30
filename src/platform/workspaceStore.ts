import { WORKSPACE_STORAGE_KEY, parseWorkspace, type WorkspaceSnapshot } from '../core/workspace'
import { hostBridge, type RuntimeInfo } from './host'

export type { RuntimeInfo }

export interface WorkspaceStore {
  readonly kind: 'desktop' | 'browser'
  load(): Promise<WorkspaceSnapshot | null>
  save(snapshot: WorkspaceSnapshot): Promise<void>
}



/**
 * Answer the host's closing-time request for the current layout.
 *
 * The renderer cannot push this at the right moment: an IPC sent during
 * teardown is dropped, which is precisely why the host has to ask before the
 * window goes away. Returns a disposer so a reload can detach cleanly.
 */
export function collectFrom(snapshot: () => unknown): () => void {
  const host = hostBridge()
  if (!host) return () => {}
  host.onCollect(snapshot)
  return () => {}
}

export function createWorkspaceStore(): WorkspaceStore {
  const host = hostBridge()
  if (host) {
    return {
      kind: 'desktop',
      async load() {
        return parseWorkspace(await host.loadWorkspace())
      },
      async save(snapshot) {
        await host.saveWorkspace(snapshot)
      },
    }
  }

  // Browser development path only. Keeps the UI runnable in a plain tab
  // without weakening the desktop boundary in any way.
  return {
    kind: 'browser',
    async load() {
      try {
        const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
        return raw ? parseWorkspace(JSON.parse(raw)) : null
      } catch {
        return null
      }
    },
    async save(snapshot) {
      try {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot))
      } catch {
        /* storage disabled — layout simply will not persist */
      }
    },
  }
}

export async function readRuntimeInfo(): Promise<RuntimeInfo> {
  const host = hostBridge()
  if (!host) {
    return { version: '0.1.0', platform: 'browser', userData: '', workspaceFile: '', dev: true }
  }
  const info = await host.getRuntimeInfo()
  return {
    version: info.version,
    platform: `${info.platform}/${info.arch}`,
    userData: info.userData,
    workspaceFile: info.workspaceFile,
    dev: info.dev,
  }
}
