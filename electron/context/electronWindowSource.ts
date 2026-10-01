import { app, BrowserWindow } from 'electron'
import type { OwnWindowSource } from './windowProviders'

/**
 * THE ONE FILE IN THIS LANE THAT IMPORTS ELECTRON.
 *
 * Deliberately tiny and deliberately boring: it reads exactly two facts that
 * Electron's main process already exposes read-only about **Freya's own**
 * windows — the application's display name and the focused window's title
 * (plus its fullscreen frame flag) — and hands them to the pure provider in
 * `windowProviders.ts`. There is no IPC here, no preload surface, no
 * `webContents`, no `screen` device, no input anything: `getFocusedWindow()`
 * answers a question about this application's own windows and cannot be made
 * to answer a question about anybody else's.
 *
 * Main constructs this source only for the explicit own-app opt-in. The host
 * couples it to Core's narrow window lane; it never becomes a renderer API.
 */
export function createElectronOwnWindowSource(): OwnWindowSource {
  return {
    displayName: () => app.getName(),
    focusedWindowTitle: () => {
      const focused = BrowserWindow.getFocusedWindow()
      return focused === null ? null : focused.getTitle()
    },
    isFullscreen: () => {
      const focused = BrowserWindow.getFocusedWindow()
      return focused !== null && focused.isFullScreen()
    },
  }
}
