import type { Presence, PresenceState } from './presence'
import { PRESENCE_DETAIL, canTransition } from './presence'
import { demoDashboard, type Dashboard } from '../demo/fixtures'
import type { SurfaceEvent } from './surfaces/manager'

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

export function reduce(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case 'presence.set': {
      if (!canTransition(state.presence.state, event.state)) return state
      if (state.presence.state === event.state) return state
      return {
        ...state,
        presence: {
          state: event.state,
          since: Date.now(),
          activity: state.presence.activity,
          detail: event.detail ?? PRESENCE_DETAIL[event.state],
        },
      }
    }

    case 'presence.activity':
      return { ...state, presence: { ...state.presence, activity: clamp01(event.value) } }

    case 'nav.select':
      return state.nav === event.section ? state : { ...state, nav: event.section }

    case 'voice.toggle':
      return {
        ...state,
        listening: event.listening,
        presence: event.listening
          ? { ...state.presence, state: 'listening', since: Date.now(), detail: 'Listening.' }
          : { ...state.presence, state: 'idle', since: Date.now(), detail: PRESENCE_DETAIL.idle },
      }

    case 'command.submit': {
      const text = event.text.trim()
      if (!text) return state
      return {
        ...state,
        commandDraft: '',
        lastCommand: text,
        presence: { ...state.presence, state: 'working', since: Date.now(), detail: 'Working.' },
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
      const presence: Presence = {
        state: event.presence,
        since: Date.now(),
        activity: 0,
        detail: PRESENCE_DETAIL[event.presence],
      }
      return { ...state, nav: event.nav, presence }
    }

    // Surface events are projected by the store owner, not reduced here —
    // the SurfaceManager is the single source of truth for surface state.
    case 'surface.opened':
    case 'surface.closed':
    case 'surface.focused':
    case 'surface.moved':
    case 'surface.resized':
    case 'surface.state.changed':
      return state

    default:
      return state
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
