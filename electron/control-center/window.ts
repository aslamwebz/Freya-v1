import { BrowserWindow, ipcMain, dialog, screen } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { connectRpc } from '../../shared/runtime/rpc'
import type { ControlCenterSnapshot, ProcessObservation } from '../../shared/contracts/control-center'
import type { ComponentName } from '../../shared/contracts/runtime'
import type { ExplorerSnapshot } from '../../shared/contracts/explorer'

export class ControlCenterWindow {
  private window: BrowserWindow | null = null
  constructor(private readonly root: string, private readonly profile: string, private readonly open: (route: string) => void, private readonly stopAll: () => Promise<unknown>, private readonly inventory: () => Promise<ExplorerSnapshot | undefined>) {}
  register(): void {
    const assertSender = (event: Electron.IpcMainInvokeEvent) => { if (event.sender !== this.window?.webContents) throw new Error('Control Center owner window required') }
    ipcMain.handle('freya:center:read', async event => {
      assertSender(event)
      try {
        const observations = await this.supervisor<ProcessObservation[]>('status')
        const core = observations.find(row => row.component === 'core')
        const inventory = core?.health ? await this.inventory().catch(() => undefined) : undefined
        return { profile: this.profile, observations, inventory } satisfies ControlCenterSnapshot
      }
      catch { return { profile: this.profile, observations: (['core', 'freya', 'superapp'] as ComponentName[]).map(component => ({ component, pid: null, state: 'disconnected', source: 'supervisor: runtime.health', checkedAt: new Date().toISOString(), lastSuccessAt: null, health: null, detail: 'Supervisor unavailable. Start Freya from its CMD launcher.' })) } satisfies ControlCenterSnapshot }
    })
    ipcMain.handle('freya:center:open', (event, route: unknown) => {
      assertSender(event)
      if (typeof route !== 'string' || !['home', 'mind/system', 'vault', 'settings', 'chat'].includes(route)) throw new Error('Unknown destination')
      this.open(route)
    })
    ipcMain.handle('freya:center:restart', async (event, component: unknown) => {
      assertSender(event)
      if (!['core', 'freya', 'superapp'].includes(component as string)) throw new Error('Unknown component')
      const choice = await dialog.showMessageBox(this.window!, { type: 'warning', title: 'Restart Freya component', message: `Restart ${component}?`, detail: 'Current work may be interrupted. Other processes remain running.', buttons: ['Cancel', 'Restart'], defaultId: 0, cancelId: 0 })
      return choice.response === 1 ? this.supervisor<string>('restart', component as ComponentName) : 'Restart cancelled'
    })
    ipcMain.handle('freya:center:stop-all', event => { assertSender(event); return this.stopAll() })
  }
  private async supervisor<T>(operation: string, component?: ComponentName): Promise<T> {
    // Descriptor and tokens stay exclusively in the host. Only named supervisor operations cross.
    const descriptor = JSON.parse(await readFile(join(this.profile, '.runtime', 'debug-stack.json'), 'utf8'))
    const peer = await connectRpc(descriptor.addresses.supervisor, descriptor.supervisorToken)
    try { return await peer.call<T>(`supervisor.${operation}`, { component }, 15_000) } finally { peer.close() }
  }
  async show(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) { this.window.restore(); this.window.show(); this.window.focus(); return }
    let bounds: Electron.Rectangle | { width: number; height: number } = { width: 1040, height: 760 }
    try {
      const saved = JSON.parse(await readFile(join(this.profile, 'control-center-window.json'), 'utf8'))
      if ([saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && screen.getAllDisplays().some(display => saved.x < display.workArea.x + display.workArea.width && saved.x + saved.width > display.workArea.x && saved.y < display.workArea.y + display.workArea.height && saved.y + saved.height > display.workArea.y)) bounds = { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.max(780, Math.min(1800, Math.round(saved.width))), height: Math.max(560, Math.min(1400, Math.round(saved.height))) }
    } catch { /* First launch uses native placement. */ }
    const window = new BrowserWindow({ ...bounds, minWidth: 780, minHeight: 560, title: 'Freya Control Center', show: false, backgroundColor: '#03080e', webPreferences: { preload: join(this.root, 'dist-electron', 'control-center-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    this.window = window
    window.setMenu(null)
    window.on('minimize', () => { window.hide() })
    window.on('close', event => { event.preventDefault(); window.hide() })
    const save = () => { void writeFile(join(this.profile, 'control-center-window.json'), JSON.stringify(window.getNormalBounds())).catch(() => {}) }
    window.on('move', save); window.on('resize', save)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.once('ready-to-show', () => process.argv.includes('--freya-no-focus') ? window.showInactive() : window.show())
    if (process.env.FREYA_DEV_SERVER) await window.loadURL(new URL('control-center.html', process.env.FREYA_DEV_SERVER).toString())
    else await window.loadFile(join(this.root, 'dist', 'control-center.html'))
  }
  destroy(): void { this.window?.destroy(); this.window = null }
}
