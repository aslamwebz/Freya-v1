import type { Presence, PresenceState } from './presence'
import { PRESENCE_DETAIL, canTransition } from './presence'
import { demoDashboard, type Dashboard } from '../demo/fixtures'
import type { SurfaceEvent, SurfaceSummary } from './surfaces/manager'

/**
 * The shell's event log.
 *
 * One union, one reducer. Components dispatch events and read state; they never
 * call each other. Phase 1+ systems join by adding event families here, not by
 * wiring props through the tree.
 */
export type ShellEvent =
  | { type: 'presence.set'; state: PresenceState; detail?: string }
  | { type: 'presence.activity'; value: number }
  | { type: 'nav.select'; section: string }
  | { type: 'command.submit'; text: string }
  | { type: 'voice.toggle'; listening: boolean }
  | { type: 'attention.requested'; count: number }
  | { type: 'workspace.restored'; nav: string; presence: PresenceState }
  | { type: 'work.updated'; note: string }
  | SurfaceEvent

export interface ShellState {
  presence: Presence
  nav: string
  listening: boolean
  commandDraft: string
  lastCommand: string | null
  /**
   * A projection of the Surface Manager's list, carried on every surface event.
   * The manager owns surfaces; the shell reads a summary of them, never a copy.
   */
  surfaces: SurfaceSummary
  dashboard: Dashboard
  runtime: { version: string; platform: string; userData: string; workspaceFile: string; dev: boolean }
  attention: { requested: number; lastNote: string | null }
  notices: Notice[]
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
    listening: false,
    commandDraft: '',
    lastCommand: null,
    surfaces: { open: 0, minimized: 0, focused: null },
    dashboard: demoDashboard(),
    runtime: { version: '0.1.0', platform: 'browser', userData: '', workspaceFile: '', dev: true },
    attention: { requested: 0, lastNote: null },
    notices: [],
  }
}

const MAX_NOTICES = 4
let noticeSeq = 0

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

export function reduce(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case 'presence.set':
      return withPresence(state, event.state, event.detail ?? null)

    case 'presence.activity':
      return { ...state, presence: { ...state.presence, activity: clamp01(event.value) } }

    case 'nav.select':
      return state.nav === event.section ? state : { ...state, nav: event.section }

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

    case 'command.submit': {
      const text = event.text.trim()
      if (!text) return state
      // Submitting work must not unlock a locked Freya.
      const next = withPresence(state, 'working')
      return {
        ...next,
        commandDraft: '',
        lastCommand: text,
        notices: notice(state, `Queued locally: “${text.slice(0, 48)}” — no model is attached in Phase 0.`, 'neutral'),
      }
    }

    case 'attention.requested':
      return {
        ...state,
        attention: { requested: Math.max(0, event.count), lastNote: 'Local demo event' },
      }

    case 'work.updated':
      return { ...state, attention: { ...state.attention, lastNote: event.note } }

    case 'workspace.restored': {
      const withNav = state.nav === event.nav ? state : { ...state, nav: event.nav }
      return withPresence(withNav, event.presence)
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
