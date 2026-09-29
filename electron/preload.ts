import { contextBridge, ipcRenderer } from 'electron'

export interface RuntimeInfo {
  version: string
  electron: string
  platform: string
  arch: string
  userData: string
  workspaceFile: string
  dev: boolean
}

/**
 * The entire privileged surface of the Freya desktop host.
 *
 * Four functions. No ipcRenderer passthrough, no remote module, no eval.
 * A renderer compromise gets an attacker exactly what this file exposes.
 */
const api = {
  isDesktop: true as const,
  getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke('freya:runtime'),
  loadWorkspace: (): Promise<unknown> => ipcRenderer.invoke('freya:workspace:load'),
  saveWorkspace: (payload: unknown): Promise<boolean> =>
    ipcRenderer.invoke('freya:workspace:save', payload),
}

contextBridge.exposeInMainWorld('freyaHost', api)

export type FreyaHost = typeof api
