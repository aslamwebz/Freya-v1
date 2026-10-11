import { contextBridge, ipcRenderer } from 'electron'
import type { ControlCenterSnapshot } from '../../shared/contracts/control-center'
contextBridge.exposeInMainWorld('freyaCenter', {
  read: (): Promise<ControlCenterSnapshot> => ipcRenderer.invoke('freya:center:read'),
  open: (destination: string): Promise<void> => ipcRenderer.invoke('freya:center:open', destination),
  restart: (component: string): Promise<string> => ipcRenderer.invoke('freya:center:restart', component),
  stopAll: (): Promise<unknown> => ipcRenderer.invoke('freya:center:stop-all'),
})
