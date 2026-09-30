import type { Presence, PresenceState } from './presence'
import { PRESENCE_DETAIL, canTransition } from './presence'
import type { CoreStatus } from '../../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../../core/protocol/activity'
import { projectDesktop, type DesktopProjection } from './desktopProjection'
import type { SurfaceEvent, SurfaceSummary } from './surfaces/manager'

/**
 * The shell's event log.
 *
 * One union, one reducer. Components dispatch events and read state; they never
 * call each other. Phase 1+ systems join by adding event families here, not by
 * wiring props through the tree.
 */
export type ShellEvent =
  | { type: 'presence.activity'; value: number }
  | { type: 'nav.select'; section: string }
  /**
   * Ask the Core client to submit. Carries no acknowledgement: the reply comes
   * back as `command.acknowledged`, from Core, not from this dispatch.
   */
  | { type: 'command.submit'; text: string }
  /**
   * Core's own projection arrived. The mirror publishes this; nothing in the UI
   * fabricates one, and the renderer cannot write one back.
   */
  | { type: 'core.status'; status: CoreStatus | null }
  /**
   * Durable events, already reduced to display rows by Core.
   *
   * These rows carry no payload field, so command text cannot reach the feed even
   * by accident. They are a view of the journal, not a second journal.
   */
  | { type: 'core.activity'; activity: CoreActivityEvent[] }
  /** What Core replied. `ok` is Core's verdict, not an optimistic guess. */
  | { type: 'command.acknowledged'; ok: boolean; detail: string; durableSequence?: number }
  /** Fold the systems rail to icons. */
  | { type: 'nav.collapse'; collapsed: boolean }
  /**
   * A Development Lab presence override.
   *
   * The only event that may set presence without Core having caused it, and it
   * carries its own marker so the store can refuse it outside development. That
   * is the whole reason simulated presence cannot be mistaken for real presence:
   * the attempt fails, loudly, in a shipped build.
   */
  | { type: 'presence.simulate'; state: PresenceState; detail?: string }
  /**
   * Which conversation Core says is open.
   *
   * Dispatched by the conversation subscription, not written by a panel: a panel
   * that chose its own active conversation would be keeping a second copy of state
   * Core owns. It is presentation, and it is what the workspace file persists.
   */
  | { type: 'conversation.selected'; conversationId: string | null }
  /** Append to the chat bar's transcript. */
  | { type: 'chat.line'; role: 'you' | 'freya'; text: string; refused?: boolean }
  | { type: 'voice.toggle'; listening: boolean }
  | { type: 'attention.requested'; count: number }
  | {
      type: 'workspace.restored'
      nav: string
      navCollapsed: boolean
      presence: PresenceState
      /** Which conversation to re-open. Presentation, and re-read by Core. */
      conversationId?: string | null
    }
  | { type: 'work.updated'; note: string }
  | SurfaceEvent

export interface ShellState {
  presence: Presence
  nav: string
  /**
   * The systems rail folds to icons only. Presentation state, persisted because
   * someone who collapses it once generally wants it collapsed next time.
   */
  navCollapsed: boolean
  /**
   * Which conversation the person had open.
   *
   * Presentation, and persisted for the same reason the rail is. It is an id and
   * nothing more: Core re-reads the transcript from its own store, so a value that
   * has gone stale, or was hand-edited into the file, resolves to nothing rather
   * than to invented content.
   */
  conversationId: string | null
  listening: boolean
  commandDraft: string
  lastCommand: string | null
  /**
   * The chat bar's own transcript.
   *
   * Presentation only, and deliberately *not* the record of what happened: each
   * entry here is a line the person typed plus the acknowledgement Core sent
   * back. It is a view of the command path, not a second copy of it, so it can
   * be dropped without losing anything.
   */
  chat: ChatLine[]
  /**
   * A projection of the Surface Manager's list, carried on every surface event.
   * The manager owns surfaces; the shell reads a summary of them, never a copy.
   */
  surfaces: SurfaceSummary
  /**
   * Core's last status, verbatim.
   *
   * Kept as received rather than interpreted. Every derived fact the shell shows
   * lives in `desktop`, produced by one pure function from this and the
   * activity feed, so there is exactly one interpretation in the system.
   */
  core: CoreStatus | null
  /** Core's activity feed, in the order Core sent it. */
  activity: CoreActivityEvent[]
  /** The projection the whole shell reads. Never written by hand. */
  desktop: DesktopProjection
  runtime: { version: string; platform: string; userData: string; workspaceFile: string; dev: boolean }
  attention: { requested: number; lastNote: string | null }
  notices: Notice[]
}

export interface ChatLine {
  id: number
  role: 'you' | 'freya'
  text: string
  /** True when Core refused, so a line is never styled as a success. */
  refused?: boolean
  at: number
}

export interface Notice {
  id: number
  text: string
  tone: 'neutral' | 'urgent'
  at: number
}

export function initialState(): ShellState {
  return {
    presence: { state: 'idle', since: Date.now(), activity: 0, detail: null },
    nav: 'home',
    navCollapsed: false,
    conversationId: null,
    listening: false,
    commandDraft: '',
    lastCommand: null,
    chat: [],
    surfaces: { open: 0, minimized: 0, focused: null },
    core: null,
    activity: [],
    desktop: projectDesktop({
      core: null,
      activity: [],
      listening: false,
      now: Date.now(),
    }),
    // `dev` starts false and is only ever set true by the host, which knows how
    // it was launched. Defaulting it the other way would mean a window whose
    // hydration failed came up with the presence simulator enabled.
    runtime: { version: '0.1.0', platform: 'browser', userData: '', workspaceFile: '', dev: false },
    attention: { requested: 0, lastNote: null },
    notices: [],
  }
}

const MAX_NOTICES = 4
let noticeSeq = 0

/** The chat bar shows recent turns, not a scrollback nobody will read. */
const MAX_CHAT_LINES = 40
let chatSeq = 0

function notice(state: ShellState, text: string, tone: Notice['tone']): Notice[] {
  noticeSeq += 1
  return [{ id: noticeSeq, text, tone, at: Date.now() }, ...state.notices].slice(0, MAX_NOTICES)
}

/**
 * The only way presence is allowed to change.
 *
 * Every event that wants a new presence goes through here, so the transition
 * table is enforced in exactly one place. A voice toggle, a submitted command
 * and a restored workspace can all request 'working', and none of them can
 * talk their way out of 'locked' or 'error'.
 */
function withPresence(
  state: ShellState,
  next: PresenceState,
  detail?: string | null,
): ShellState {
  if (!canTransition(state.presence.state, next)) return state
  if (state.presence.state === next) return state
  return {
    ...state,
    presence: {
      state: next,
      since: Date.now(),
      activity: state.presence.activity,
      detail: detail ?? PRESENCE_DETAIL[next],
    },
  }
}

/**
 * Recompute everything derived, from `core` and `activity` only.
 *
 * One place, so the panels cannot drift apart, and cheap enough to run on every
 * Core push: it is a pure function over two small inputs.
 *
 * The activity feed is a view of history, and history is not used to decide
 * whether anything is running now. `activeProviderCalls` is read from Core's own
 * status, which Core reads from the Model Gateway's live request registry — so
 * `working` is a fact about this process rather than an inference about a log.
 */
function project(state: ShellState): ShellState {
  const desktop = projectDesktop({
    core: state.core,
    activity: state.activity,
    listening: state.listening,
    now: Date.now(),
  })

  // Core's projection is a fact, not a requested UI transition. The old Phase 0
  // transition table is still useful for local simulation and microphone
  // controls, but it must never be able to veto a security state reported by
  // Core. In particular: listening -> locked and locked -> error must both be
  // representable immediately.
  const sameState = state.presence.state === desktop.presence
  const sameDetail = state.presence.detail === desktop.presenceDetail
  const projected =
    sameState && sameDetail
      ? state
      : {
          ...state,
          presence: {
            state: desktop.presence,
            since: sameState ? state.presence.since : Date.now(),
            activity: state.presence.activity,
            detail: desktop.presenceDetail,
          },
        }

  return { ...projected, desktop }
}

export function reduce(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case 'core.status':
      return project(state.core === event.status ? state : { ...state, core: event.status })

    case 'core.activity':
      return project(state.activity === event.activity ? state : { ...state, activity: event.activity })

    /**
     * A Development Lab override.
     *
     * Refused outside development. The Design Lab is allowed to drive presence
     * while someone is designing how it looks; it is not allowed to do so in a
     * window where the state would be read as a statement about Core.
     */
    case 'presence.simulate':
      return state.runtime.dev
        ? withPresence(state, event.state, event.detail ?? null)
        : state

    case 'presence.activity':
      return { ...state, presence: { ...state.presence, activity: clamp01(event.value) } }

    case 'nav.select':
      return state.nav === event.section ? state : { ...state, nav: event.section }

    case 'conversation.selected':
      return state.conversationId === event.conversationId
        ? state
        : { ...state, conversationId: event.conversationId }

    case 'nav.collapse':
      return state.navCollapsed === event.collapsed ? state : { ...state, navCollapsed: event.collapsed }

    case 'chat.line': {
      chatSeq += 1
      const line: ChatLine = {
        id: chatSeq,
        role: event.role,
        text: event.text,
        refused: event.refused === true,
        at: Date.now(),
      }
      return { ...state, chat: [...state.chat, line].slice(-MAX_CHAT_LINES) }
    }

    case 'voice.toggle': {
      if (event.listening) {
        // A refused transition refuses the whole toggle. A live microphone
        // beside a locked Freya is a contradiction the shell must not be able
        // to represent, let alone show.
        const next = withPresence(state, 'listening')
        if (next === state) return state
        return { ...next, listening: true }
      }
      // Turning the microphone off is always allowed: it is how you stop.
      return { ...withPresence(state, 'idle'), listening: false }
    }

    /**
     * The result of submitting a command to Core.
     *
     * The shell store records what Core *said*, and nothing else. There is no
     * path here that sets an acknowledgement before Core has replied, so a
     * command cannot look accepted while Core is still deciding — or refused
     * it.
     */
    case 'command.acknowledged': {
      return {
        ...state,
        commandDraft: '',
        notices: notice(
          state,
          event.detail,
          event.ok ? 'neutral' : 'urgent',
        ),
      }
    }

    case 'attention.requested':
      return {
        ...state,
        attention: { requested: Math.max(0, event.count), lastNote: 'Local demo event' },
      }

    case 'work.updated':
      return { ...state, attention: { ...state.attention, lastNote: event.note } }

    /**
     * Restoring a workspace.
     *
     * Presence is *not* restored from the file, and that is the point. A saved
     * `thinking` from last week's crash is not a fact about now: Core decides
     * presence, and Core has already said so by the time this arrives. The
     * layout comes back; the intelligence's state does not.
     */
    case 'workspace.restored': {
      // Layout comes back; intelligence does not. `conversationId` is which pane
      // was open, not what was said in it — Core re-reads the transcript itself.
      return project({
        ...state,
        nav: event.nav,
        navCollapsed: event.navCollapsed,
        conversationId: event.conversationId ?? null,
      })
    }

    // The manager owns surfaces and ships a summary; the store keeps it.
    case 'surface.restored':
    case 'surface.opened':
    case 'surface.closed':
    case 'surface.focused':
    case 'surface.moved':
    case 'surface.resized':
    case 'surface.state.changed':
      return sameSummary(state.surfaces, event.summary)
        ? state
        : { ...state, surfaces: event.summary }

    default:
      return state
  }
}

function sameSummary(a: SurfaceSummary, b: SurfaceSummary): boolean {
  return a.open === b.open && a.minimized === b.minimized && a.focused === b.focused
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
