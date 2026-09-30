import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { WorkspaceFile, DEFAULT_MAX_BYTES } from './workspaceFile'
import { ElectronCoreHost } from './coreHost'
import type { CoreCommandEnvelope } from '../core/protocol/core-protocol'

const HERE = __dirname
const ROOT = join(HERE, '..')
const DEV_SERVER = process.env.FREYA_DEV_SERVER
const WORKSPACE_FILE = 'workspace.json'
const CORE_LOG_FILE = 'core-events.jsonl'

let mainWindow: BrowserWindow | null = null
/** Null until the app is ready; every handler that needs it is registered after. */
let workspace: WorkspaceFile | null = null
/** One Core per process. Survives renderer reloads; dies only with the app. */
let coreHost: ElectronCoreHost | null = null
/** Resolves when the renderer has answered the closing-time request. */
let pendingCollect: (() => void) | null = null
let quitting = false

/** Long enough for a round trip, short enough that a wedged renderer still quits. */
const COLLECT_TIMEOUT_MS = 750

function requireWorkspace(): WorkspaceFile {
  if (!workspace) throw new Error('workspace file used before the app was ready')
  return workspace
}

function requireCore(): ElectronCoreHost {
  if (!coreHost) throw new Error('core used before the app was ready')
  return coreHost
}

/**
 * A closing window cannot be trusted to have pushed its last layout.
 *
 * An IPC sent during teardown is dropped, so the renderer has to be asked while
 * it is still alive and the answer written synchronously. Both the window's
 * close event and `app.quit()` route through here, because a quit does not
 * necessarily close a window first.
 *
 * The timeout exists so a wedged renderer can never make the app unquittable.
 */
function collectAndThen(finish: () => void): void {
  const answered = new Promise<void>((resolve) => {
    pendingCollect = resolve
  })
  const timer = setTimeout(() => {
    pendingCollect?.()
    pendingCollect = null
  }, COLLECT_TIMEOUT_MS)

  const target = mainWindow
  if (target && !target.isDestroyed()) {
    target.webContents.send('freya:workspace:collect')
  } else {
    pendingCollect?.()
    pendingCollect = null
  }

  void answered
    .finally(() => {
      clearTimeout(timer)
      pendingCollect = null
      workspace?.flushSync()
    })
    .then(async () => {
      // Core closes before the process does, so its last event is durable.
      // A failure here must not stop the app quitting.
      await coreHost?.stop('app quitting').catch((error: unknown) => {
        console.error('[freya] core failed to stop cleanly', error)
      })
      quitting = true
      finish()
    })
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

  // The host pushes the current status on attach, so a freshly loaded or
  // reloaded renderer knows the Core state without polling for it.
  const detachCore = coreHost?.attach((status) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:status', status)
  })
  window.on('closed', () => {
    detachCore?.()
  })

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

  /**
   * The user closed the window. Hold it open just long enough to collect the
   * layout, then let it go.
   */
  window.on('close', (event) => {
    if (quitting || !workspace) return
    event.preventDefault()
    collectAndThen(() => window.destroy())
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
    workspaceFile: requireWorkspace().path,
    dev: Boolean(DEV_SERVER),
  }))

  ipcMain.handle('freya:workspace:load', () => requireWorkspace().load())
  ipcMain.handle('freya:core:submit', (_event, envelope: CoreCommandEnvelope) =>
    requireCore().submit(envelope),
  )
  ipcMain.handle('freya:core:status', () => requireCore().status())

  ipcMain.handle('freya:workspace:save', (_event, payload: unknown) => {
    const accepted = requireWorkspace().schedule(payload)
    if (!accepted) {
      console.warn(
        `[freya] workspace rejected: not serialisable, or larger than ${DEFAULT_MAX_BYTES} bytes`,
      )
    }
    // The renderer has answered the closing-time request, if there was one.
    pendingCollect?.()
    pendingCollect = null
    return accepted
  })
}

app.whenReady().then(() => {
  workspace = new WorkspaceFile({
    path: join(app.getPath('userData'), WORKSPACE_FILE),
  })
  coreHost = new ElectronCoreHost(join(app.getPath('userData'), CORE_LOG_FILE), {
    NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
    NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
    NANOGPT_MODEL: process.env.NANOGPT_MODEL,
    FREYA_ALLOW_LIVE_MODEL: process.env.FREYA_ALLOW_LIVE_MODEL,
  })
  registerIpc()
  mainWindow = createWindow()

  // Deliberately not awaited before the window opens: a slow or unwritable log
  // should degrade Core, not hold the app off the screen. A window created
  // before Core is ready attaches and simply receives the status when it lands.
  void coreHost.start().catch((error: unknown) => {
    console.error('[freya] core failed to start', error)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || !workspace) return
  // A quit can arrive without the window's close event ever firing, so this
  // hook has to do the collect itself and then re-enter the quit.
  event.preventDefault()
  collectAndThen(() => app.quit())
})

// Refuse any renderer request for a capability Freya has not granted.
// Microphone permission is intentionally NOT granted in Phase 0: the voice
// control is a UI state transition, not a recording.
app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
})
