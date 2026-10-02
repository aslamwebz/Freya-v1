import { ipcMain, screen } from 'electron'
import { PresenceWindow } from './window'
import { buildPresenceFrame, derivePresenceState, type PresenceInput } from '../../core/presence/stateMachine'
import type { PresenceProtocolState } from '../../core/presence/protocol'
import type { CoreStatus } from '../../core/protocol/core-protocol'
import type { AttentionProjection } from '../../core/protocol/attention'
import type { WorkProjection } from '../../core/work/projection'
import type { PersonalityProjection } from '../../core/protocol/personality'
import type { VoiceProjection } from '../../core/protocol/conversation'

/**
 * The presence host.
 *
 * Owns the presence window and pushes presence frames to it. It is the only
 * thing that can create a presence window, and it creates exactly one.
 *
 * ## What it does
 *
 * - Creates the presence window on the same display as the main window.
 * - Pushes presence frames whenever Core state changes.
 * - Follows the main window when it moves to another monitor.
 * - Re-evaluates placement when the display configuration changes.
 * - Handles click-through toggles from the renderer.
 *
 * ## What it does not do
 *
 * - It does not decide presence state. The state machine does that.
 * - It does not make model calls.
 * - It does not hold Core state. It reads projections and forwards them.
 * - It does not allow the renderer to submit commands or read Core state.
 */

export interface PresenceHostOptions {
  /** The display number to place the window on, or null for the primary. */
  readonly displayNumber: number | null
  /** Whether the app is in development mode. */
  readonly dev: boolean
  /** Injected clock for deterministic state-entry timestamps in tests. */
  readonly now?: () => number
}

export class PresenceHost {
  private window: PresenceWindow | null = null
  private core: CoreStatus | null = null
  private attention: AttentionProjection | null = null
  private work: WorkProjection | null = null
  private personality: PersonalityProjection | null = null
  private voice: VoiceProjection | null = null
  private synthesisActive = false
  private sequence = 0
  private lastFrameJson: string | null = null
  private lastState: PresenceProtocolState | null = null
  private stateSince = 0
  private mainWindow: Electron.BrowserWindow | null = null

  private readonly handleMainMoved = () => {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.window?.followMainWindow(this.mainWindow.getBounds())
  }
  private readonly handleMainClosed = () => this.stop()
  private readonly handleDisplayChange = () => this.window?.handleDisplayChange()
  private readonly handleToggleInteraction = (event: Electron.IpcMainEvent) => {
    if (!this.window?.ownsWebContents(event.sender)) return
    this.window.toggleInteraction()
  }
  private readonly handleForceClickThrough = (event: Electron.IpcMainEvent) => {
    if (!this.window?.ownsWebContents(event.sender)) return
    this.window.forceClickThrough()
  }

  constructor(private readonly options: PresenceHostOptions) {}

  /**
   * Create the presence window and start pushing frames.
   *
   * Called once, after the main window is created. The presence window is
   * placed on the same display as the main window.
   */
  start(mainWindow: Electron.BrowserWindow): void {
    if (this.window) return

    this.window = new PresenceWindow({
      displayNumber: this.options.displayNumber,
      dev: this.options.dev,
    }).create()
    this.mainWindow = mainWindow

    // Presence follows the dashboard lifecycle as well as its display. It may
    // never be the hidden window that keeps the application alive by itself.
    mainWindow.on('moved', this.handleMainMoved)
    mainWindow.once('closed', this.handleMainClosed)

    screen.on('display-added', this.handleDisplayChange)
    screen.on('display-removed', this.handleDisplayChange)
    screen.on('display-metrics-changed', this.handleDisplayChange)

    // Only the actual Presence renderer may change Presence window interaction.
    ipcMain.on('freya:presence:toggleInteraction', this.handleToggleInteraction)
    ipcMain.on('freya:presence:forceClickThrough', this.handleForceClickThrough)

    // Push the current frame immediately.
    this.pushFrame()
  }

  /**
   * Update Core status and push a new frame.
   */
  updateCore(status: CoreStatus): void {
    this.core = status
    this.sequence = status.eventSequence
    this.pushFrame()
  }

  /**
   * Update the attention projection and push a new frame.
   */
  updateAttention(projection: AttentionProjection | null): void {
    this.attention = projection
    this.pushFrame()
  }

  /**
   * Update the work projection and push a new frame.
   */
  updateWork(projection: WorkProjection | null): void {
    this.work = projection
    this.pushFrame()
  }

  /**
   * Update the personality projection and push a new frame.
   */
  updatePersonality(projection: PersonalityProjection | null): void {
    this.personality = projection
    this.pushFrame()
  }

  /**
   * Update the voice projection and push a new frame.
   */
  updateVoice(projection: VoiceProjection | null): void {
    this.voice = projection
    this.pushFrame()
  }

  /**
   * Update synthesis status and push a new frame.
   */
  updateSynthesis(active: boolean): void {
    this.synthesisActive = active
    this.pushFrame()
  }

  /**
   * Stop the presence host and close the window.
   */
  stop(): void {
    this.mainWindow?.removeListener('moved', this.handleMainMoved)
    this.mainWindow?.removeListener('closed', this.handleMainClosed)
    this.mainWindow = null
    screen.removeListener('display-added', this.handleDisplayChange)
    screen.removeListener('display-removed', this.handleDisplayChange)
    screen.removeListener('display-metrics-changed', this.handleDisplayChange)
    ipcMain.removeListener('freya:presence:toggleInteraction', this.handleToggleInteraction)
    ipcMain.removeListener('freya:presence:forceClickThrough', this.handleForceClickThrough)

    if (this.window) {
      this.window.dispose()
      this.window = null
    }
    this.core = null
    this.attention = null
    this.work = null
    this.personality = null
    this.voice = null
    this.synthesisActive = false
    this.sequence = 0
    this.lastFrameJson = null
    this.lastState = null
    this.stateSince = 0
  }

  private pushFrame(): void {
    if (!this.window || !this.window.isCreated) return

    const input: PresenceInput = {
      core: this.core,
      attention: this.attention,
      work: this.work,
      personality: this.personality,
      voice: this.voice,
      synthesisActive: this.synthesisActive,
      sequence: this.sequence,
    }

    const state = derivePresenceState(input)
    if (state !== this.lastState) {
      this.lastState = state
      this.stateSince = this.options.now?.() ?? Date.now()
    }

    const frame = buildPresenceFrame(input, this.stateSince)
    const json = JSON.stringify(frame)

    // Only push when the frame actually changed. A busy Core should not
    // force the presence window to re-render on every event.
    if (json === this.lastFrameJson) return
    this.lastFrameJson = json

    this.window.sendFrame(frame)
  }
}
