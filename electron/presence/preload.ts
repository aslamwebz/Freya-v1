import { contextBridge, ipcRenderer } from 'electron'
import {
  validatePresenceFrame,
  type PresenceFrame,
} from '../../core/presence/protocol'

/**
 * The presence preload bridge.
 *
 * The entire privileged surface of the presence window. Three functions and
 * one flag: `onPresenceFrame`, `toggleInteraction`, and `isPresence`. No
 * ipcRenderer passthrough, no remote module, no eval, and no way to name an
 * IPC channel from the renderer.
 *
 * The presence window is a presentation layer only. It receives frames and
 * draws them. It cannot submit commands, read Core state, or reach a model.
 * A renderer compromise gets an attacker exactly what the presence window
 * shows: a state, an animation, and a bounded cue.
 */

const api = {
  isPresence: true as const,

  /**
   * Subscribe to presence frames.
   *
   * The host pushes a frame whenever Core state changes. The renderer draws
   * it and nothing else. Frames are validated against the protocol before
   * they cross the bridge, so a compromised renderer cannot be talked into
   * rendering a field Core never sent.
   */
  onPresenceFrame: (handler: (frame: PresenceFrame) => void): (() => void) => {
    const listener = (_event: unknown, frame: unknown): void => {
      const validated = validatePresenceFrame(frame)
      if (typeof validated === 'string') {
        console.error('[freya.presence] refused a malformed presence frame:', validated)
        return
      }
      handler(validated)
    }
    ipcRenderer.on('freya:presence:frame', listener)
    return () => {
      ipcRenderer.removeListener('freya:presence:frame', listener)
    }
  },

  /**
   * Toggle click-through mode.
   *
   * When click-through is on, mouse events pass through the window. When it
   * is off, the window accepts mouse events for dragging and interaction.
   * The window returns to click-through after a bounded period.
   */
  toggleInteraction: (): void => {
    ipcRenderer.send('freya:presence:toggleInteraction')
  },

  /**
   * Force click-through mode.
   *
   * Called when the window loses focus or when the user presses Escape.
   */
  forceClickThrough: (): void => {
    ipcRenderer.send('freya:presence:forceClickThrough')
  },
}

contextBridge.exposeInMainWorld('freyaPresence', api)

export type FreyaPresence = typeof api
