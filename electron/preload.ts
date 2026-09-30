import { contextBridge, ipcRenderer } from 'electron'
import type {
  CoreCommandEnvelope,
  CoreCommandName,
  CoreCommandResult,
  CoreStatus,
} from '../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../core/protocol/activity'
import type { ConversationProjection, VoiceProjection } from '../core/protocol/conversation'

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
 * Four functions and one flag for the workspace, five for the Core, and one
 * flag: `getRuntimeInfo`, `loadWorkspace`, `saveWorkspace`, `onCollect`,
 * `coreSubmit`, `coreStatus`, `onCoreStatus`, `coreActivity`, `onCoreActivity`,
 * and `isDesktop`. No ipcRenderer passthrough, no remote module, no eval, and no
 * way to name an IPC channel from the renderer. A renderer compromise gets an
 * attacker exactly what this file exposes.
 *
 * The Core functions are named individually rather than exposing a channel
 * string, so the renderer cannot invent a command name at the bridge. The
 * command list is checked here as well as in Core: the renderer is the owner's
 * UI, not the authority, and an unrecognised name is refused before it can be
 * serialised into an IPC message.
 */
const api = {
  isDesktop: true as const,
  getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke('freya:runtime'),
  loadWorkspace: (): Promise<unknown> => ipcRenderer.invoke('freya:workspace:load'),
  saveWorkspace: (payload: unknown): Promise<boolean> =>
    ipcRenderer.invoke('freya:workspace:save', payload),

  /**
   * A dumb relay. The host asks once, as the window is closing, and the
   * renderer answers by saving through the function above — the host has no way
   * to build a layout and the renderer has no way to be asked in time.
   */
  onCollect: (handler: () => unknown): void => {
    ipcRenderer.on('freya:workspace:collect', () => {
      void api.saveWorkspace(handler())
    })
  },

  /**
   * Send one Core command.
   *
   * `requestId` is generated here rather than supplied, so the renderer cannot
   * collide two requests or replay an id it once saw.
   */
  coreSubmit: (command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult> => {
    if (!CORE_COMMANDS.has(command)) {
      return Promise.resolve({
        requestId: 'rejected',
        ok: false,
        refusal: { reason: `unknown command: ${String(command)}` },
      })
    }
    const envelope: CoreCommandEnvelope = { command, requestId: newRequestId(), payload }
    return ipcRenderer.invoke('freya:core:submit', envelope)
  },

  coreStatus: (): Promise<CoreStatus> => ipcRenderer.invoke('freya:core:status'),

  /**
   * The activity feed: display-ready rows derived from durable events.
   *
   * Narrow on purpose. There is no generic "read events" call here, and no
   * channel the renderer can name itself — a window cannot ask for a payload, an
   * event id, or the journal. Command text is not in these rows and never will
   * be, which is the same property the journal itself has.
   */
  coreActivity: (): Promise<CoreActivityEvent[]> => ipcRenderer.invoke('freya:core:activity'),

  onCoreActivity: (handler: (activity: CoreActivityEvent[]) => void): (() => void) => {
    const listener = (_event: unknown, activity: CoreActivityEvent[]): void => handler(activity)
    ipcRenderer.on('freya:core:activity', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:activity', listener)
    }
  },

  /**
   * The conversation projection: the transcript, the conversation list, and
   * whether Freya can currently think.
   *
   * Content crosses here, because a transcript has to be rendered somewhere. What
   * does *not* cross is the store, the key, the filesystem path, or any way to ask
   * for a conversation that is not the one on screen. A window can read a
   * conversation; it cannot decrypt one itself, and it holds no key to do so with.
   */
  coreConversation: (): Promise<ConversationProjection | null> =>
    ipcRenderer.invoke('freya:core:conversation'),

  onCoreConversation: (handler: (projection: ConversationProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: ConversationProjection): void => handler(projection)
    ipcRenderer.on('freya:core:conversation', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:conversation', listener)
    }
  },

  /**
   * Voice status: whether a local speech engine exists, and the capture bounds.
   *
   * A read, never a configuration surface. There is no function here that points
   * Freya at a speech service, because there is no speech service to point it at:
   * voice is local-only, and this exists so the UI can say so rather than showing
   * a microphone button that quietly does nothing.
   */
  coreVoice: (): Promise<VoiceProjection | null> => ipcRenderer.invoke('freya:core:voice'),

  /**
   * Watch Core status. Returns a disposer, which `onCollect` conspicuously
   * lacks: a subscription you cannot cancel is a leak you have to design around,
   * and React effects need one to run cleanup.
   */
  onCoreStatus: (handler: (status: CoreStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: CoreStatus): void => handler(status)
    ipcRenderer.on('freya:core:status', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:status', listener)
    }
  },
}

/**
 * The commands a renderer may name.
 *
 * Deliberately a *subset* of `CoreCommandName`. Core can create and revoke
 * grants, but a window cannot: the bridge refuses those names, so a compromised
 * renderer has no path to grant governance even though the command exists in
 * Core. Adding a name here is a decision to hand a window a capability, and it
 * should read like one.
 *
 * The conversation names are here because chat is the product. Note what is *not*
 * reachable through them: a window may submit text and ask for a conversation, and
 * that is all. It cannot name a grant, choose a model, raise a token ceiling,
 * pick a turn id, or select a provider — and it cannot name `cognition.request`
 * directly, so the only route from a window to a model is a conversation turn,
 * which the Mind shapes and the Governor checks.
 */
const CORE_COMMANDS: ReadonlySet<string> = new Set<CoreCommandName>([
  'core.status.read',
  'core.command.submit',
  'cognition.status.read',
  'security.status.read',
  'security.stopAll',
  'security.resume',
  'conversation.create',
  'conversation.list',
  'conversation.read',
  'conversation.turn.submit',
  'conversation.turn.cancel',
  'voice.status.read',
  'voice.capture.start',
  'voice.capture.end',
  'voice.capture.cancel',
])

/** A request id the renderer cannot choose, so it cannot collide or replay. */
function newRequestId(): string {
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

contextBridge.exposeInMainWorld('freyaHost', api)

export type FreyaHost = typeof api
