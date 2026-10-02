import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'node:path'

/**
 * The presence window: a transparent, frameless, always-on-top window that
 * shows Freya's presence as a small character/avatar.
 *
 * ## What it is
 *
 * A presentation layer only. It holds no Core state, makes no model calls,
 * and decides nothing. It receives presence frames from the host and draws
 * them. A renderer compromise gets an attacker exactly what the presence
 * window shows: a state, an animation, and a bounded cue.
 *
 * ## Click-through and interaction mode
 *
 * The window is click-through by default: mouse events pass through it to
 * whatever is beneath. When the user presses the interaction toggle (or
 * drags the window), the window becomes interactive for a bounded period,
 * then returns to click-through. A window that was always interactive would
 * block the desktop; a window that was never interactive could not be moved.
 *
 * ## Monitor-aware placement
 *
 * The window is placed on the same display as the main dashboard window, in
 * the bottom-right corner. When the dashboard moves to another monitor, the
 * presence window follows. When the display configuration changes, the
 * presence window re-evaluates its placement.
 */

const PRESENCE_WIDTH = 240
const PRESENCE_HEIGHT = 240
/** How long the window stays interactive after a toggle, in ms. */
const INTERACTION_TIMEOUT_MS = 8_000
/** Margin from the display edge, in px. */
const EDGE_MARGIN = 16

export interface PresenceWindowOptions {
  /** The display number to place the window on, or null for the primary. */
  readonly displayNumber: number | null
  /** Whether to show a dev tools button (development only). */
  readonly dev: boolean
}

export class PresenceWindow {
  private window: BrowserWindow | null = null
  private interactionTimer: ReturnType<typeof setTimeout> | null = null
  private clickThrough = true

  constructor(private readonly options: PresenceWindowOptions) {}

  /**
   * Create the presence window.
   *
   * Transparent, frameless, always-on-top, skip-taskbar. The window is
   * click-through by default and becomes interactive only when the user
   * explicitly toggles it or drags it.
   */
  create(): PresenceWindow {
    if (this.window) return this

    const bounds = this.computeBounds()
    const window = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, 'presencePreload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })

    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true)
    this.applyClickThrough()

    window.on('closed', () => {
      this.window = null
    })

    // When the window moves, check if it crossed a display boundary.
    window.on('moved', () => {
      this.constrainToDisplay()
    })

    this.window = window

    const devServer = process.env.FREYA_DEV_SERVER
    if (devServer) {
      void window.loadURL(devServer)
    } else {
      void window.loadFile(join(__dirname, '..', 'dist', 'presence.html'))
    }

    // The presence window is a presentation layer only. It has no dev tools,
    // no menu, and no way to inspect the Core.
    window.webContents.on('devtools-opened', () => {
      window.webContents.closeDevTools()
    })

    return this
  }

  /**
   * Toggle click-through mode.
   *
   * When click-through is on, mouse events pass through the window. When it
   * is off, the window accepts mouse events (for dragging and interaction).
   * The window returns to click-through after a bounded period.
   */
  toggleInteraction(): void {
    if (!this.window) return
    this.clickThrough = !this.clickThrough
    this.applyClickThrough()

    if (this.interactionTimer !== null) {
      clearTimeout(this.interactionTimer)
    }
    if (!this.clickThrough) {
      this.interactionTimer = setTimeout(() => {
        this.clickThrough = true
        this.applyClickThrough()
        this.interactionTimer = null
      }, INTERACTION_TIMEOUT_MS)
    }
  }

  /**
   * Force click-through mode.
   *
   * Called when the window loses focus or when the user presses Escape.
   */
  forceClickThrough(): void {
    if (!this.window) return
    this.clickThrough = true
    this.applyClickThrough()
    if (this.interactionTimer !== null) {
      clearTimeout(this.interactionTimer)
      this.interactionTimer = null
    }
  }

  /**
   * Move the presence window to the display the main window is on.
   *
   * Called when the main window moves or when the display configuration
   * changes. The presence window follows the dashboard, not the other way
   * around.
   */
  followMainWindow(mainWindowBounds: Rectangle): void {
    if (!this.window) return
    const display = this.displayForBounds(mainWindowBounds)
    const currentDisplay = screen.getDisplayMatching(this.window.getBounds())

    if (display.id !== currentDisplay.id) {
      this.positionOnDisplay(display)
    }
  }

  /**
   * Re-evaluate placement after a display change.
   *
   * If the window's display was removed, move it to the primary display.
   * If the window is now partially off-screen, constrain it.
   */
  handleDisplayChange(): void {
    if (!this.window) return
    const bounds = this.window.getBounds()
    const display = screen.getDisplayMatching(bounds)

    // If the window is entirely outside its display, move it to the primary.
    const area = display.workArea
    if (
      bounds.x > area.x + area.width ||
      bounds.x + bounds.width < area.x ||
      bounds.y > area.y + area.height ||
      bounds.y + bounds.height < area.y
    ) {
      const primary = screen.getPrimaryDisplay()
      this.positionOnDisplay(primary)
      return
    }

    this.constrainToDisplay()
  }

  /**
   * Send a presence frame to the renderer.
   *
   * Called by the presence host whenever Core state changes. The frame is
   * already validated by the protocol; this method only transports it.
   */
  sendFrame(frame: unknown): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('freya:presence:frame', frame)
  }

  /**
   * Close the window and release resources.
   */
  dispose(): void {
    if (this.interactionTimer !== null) {
      clearTimeout(this.interactionTimer)
      this.interactionTimer = null
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
  }

  get isCreated(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  get bounds(): Rectangle | null {
    if (!this.window || this.window.isDestroyed()) return null
    return this.window.getBounds()
  }

  private applyClickThrough(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.setIgnoreMouseEvents(this.clickThrough, { forward: true })
  }

  private computeBounds(): Rectangle {
    const display = this.options.displayNumber !== null
      ? this.displayForNumber(this.options.displayNumber)
      : screen.getPrimaryDisplay()
    return this.boundsForDisplay(display)
  }

  private displayForNumber(number: number): Electron.Display {
    const primary = screen.getPrimaryDisplay()
    const secondary = screen
      .getAllDisplays()
      .filter((display) => display.id !== primary.id)
      .sort((a, b) => {
        const horizontal = a.bounds.x - b.bounds.x
        return horizontal !== 0 ? horizontal : a.bounds.y - b.bounds.y
      })
    const displays = [primary, ...secondary]
    return displays[number - 1] ?? primary
  }

  private displayForBounds(bounds: Rectangle): Electron.Display {
    return screen.getDisplayMatching(bounds)
  }

  private boundsForDisplay(display: Electron.Display): Rectangle {
    const area = display.workArea
    return {
      x: Math.round(area.x + area.width - PRESENCE_WIDTH - EDGE_MARGIN),
      y: Math.round(area.y + area.height - PRESENCE_HEIGHT - EDGE_MARGIN),
      width: PRESENCE_WIDTH,
      height: PRESENCE_HEIGHT,
    }
  }

  private positionOnDisplay(display: Electron.Display): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.setBounds(this.boundsForDisplay(display))
  }

  private constrainToDisplay(): void {
    if (!this.window || this.window.isDestroyed()) return
    const bounds = this.window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const area = display.workArea

    let { x, y } = bounds
    const { width, height } = bounds

    // Constrain to the display's work area.
    if (x < area.x) x = area.x
    if (y < area.y) y = area.y
    if (x + width > area.x + area.width) x = area.x + area.width - width
    if (y + height > area.y + area.height) y = area.y + area.height - height

    if (x !== bounds.x || y !== bounds.y) {
      this.window.setPosition(Math.round(x), Math.round(y))
    }
  }
}
