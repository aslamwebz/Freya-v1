import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const HERE = __dirname
const ROOT = join(HERE, '..')
const DEV_SERVER = process.env.FREYA_DEV_SERVER
const WORKSPACE_FILE = 'workspace.json'
const MAX_WORKSPACE_BYTES = 512 * 1024

let mainWindow: BrowserWindow | null = null
let writeTimer: NodeJS.Timeout | null = null
let pendingWrite: unknown = null

/* ------------------------------------------------------------------ *
 * Workspace file — the only durable state the shell owns in Phase 0.
 * Written atomically (temp + rename) so a crash mid-write cannot leave
 * a truncated file that would block the next launch.
 * ------------------------------------------------------------------ */

function workspacePath(): string {
  return join(app.getPath('userData'), WORKSPACE_FILE)
}

async function loadWorkspace(): Promise<unknown> {
  try {
    const raw = await readFile(workspacePath(), 'utf8')
    if (raw.length > MAX_WORKSPACE_BYTES) return null
    return JSON.parse(raw)
  } catch {
    // Missing or unreadable workspace is normal on first launch. Never fatal.
    return null
  }
}

async function persistNow(payload: unknown): Promise<void> {
  const target = workspacePath()
  const temp = `${target}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temp, JSON.stringify(payload), 'utf8')
    await rename(temp, target)
  } catch (error) {
    console.error('[freya] workspace save failed', error)
  }
}

function scheduleSave(payload: unknown): void {
  pendingWrite = payload
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void persistNow(pendingWrite)
  }, 400)
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#050608',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? { color: '#050608', symbolColor: '#b9b2a7' } : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 24 } : undefined,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  if (DEV_SERVER) {
    void window.loadURL(DEV_SERVER)
  } else {
    void window.loadFile(join(ROOT, 'dist', 'index.html'))
  }

  // Nothing in Freya should navigate away or spawn a window. Anything the
  // user clicks that wants to leave the app goes to the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}

/* ------------------------------------------------------------------ *
 * IPC — a deliberately small, named surface
 * ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle('freya:runtime', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    workspaceFile: workspacePath(),
    dev: Boolean(DEV_SERVER),
  }))

  ipcMain.handle('freya:workspace:load', () => loadWorkspace())
  ipcMain.handle('freya:workspace:save', (_event, payload: unknown) => {
    scheduleSave(payload)
    return true
  })
}

app.whenReady().then(() => {
  registerIpc()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
    if (pendingWrite !== null) void persistNow(pendingWrite)
  }
})

// Refuse any renderer request for a capability Freya has not granted.
// Microphone permission is intentionally NOT granted in Phase 0: the voice
// control is a UI state transition, not a recording.
app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
})
