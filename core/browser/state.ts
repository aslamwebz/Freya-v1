import type {
  BrowserEventType,
  BrowserHandoffState,
  BrowserPageState,
  BrowserSessionState,
  BrowserTarget,
} from './types'
import { BROWSER_LIMITS } from './types'
import { isNavigableBrowserUrl } from './isolation'

/**
 * Truthful session and page state.
 *
 * "Truthful" is the whole requirement, and it is a property a type cannot have by itself.
 * The rules this fold enforces:
 *
 *   - **Every word is earned.** A state exists because an observation produced it. There
 *     is no path that leaves a session `ready` after its window was destroyed, because the
 *     fold has a `session.closed` transition and nothing else can write one.
 *   - **A closed session reports closed.** Not `ready`, not `absent`, and *not* a stale
 *     URL somebody could re-navigate. `session.closed` clears the page fields, so a caller
 *     reading the state after a close gets `page: 'absent'`, `url: null` and a revision of
 *     zero — which is the truth and also the safe answer, because there is nothing to act on.
 *   - **A failed load is `failed`, not `absent`.** They are different facts: nothing was
 *     there, or something was there and refused. Collapsing them would make a blocked page
 *     look like a page Freya never opened.
 *   - **The revision only ever goes up.** It is the thing element references are bound to,
 *     so a revision that could go *down* would let an old reference become current again.
 *
 * The fold is pure and total: it takes the journal entries and returns the state, and it
 * does not know what time it is, what browser is running, or whether a window exists.
 */

/* -------------------------------------------------------------------- shapes */

export interface SessionState {
  readonly sessionId: string
  readonly target: BrowserTarget
  readonly createdBy: 'freya' | 'user'
  readonly partition: string
  readonly session: BrowserSessionState
  readonly page: BrowserPageState
  /** Increments on every navigation, reload, failure and close. Never decreases. */
  readonly revision: number
  readonly pageId: string
  readonly url: string | null
  readonly title: string | null
  readonly openedAt: string
  /** Null until something was actually observed. This is what "truthful" hangs on. */
  readonly lastObservedAt: string | null
  readonly closedAt: string | null
  /** Why the last page failed, when it did. A code, never a stack and never a page string. */
  readonly failureCode: string | null
}

export interface BrowserRuntimeState {
  readonly sessions: ReadonlyMap<string, SessionState>
  readonly handoffs: ReadonlyMap<string, BrowserHandoffState>
  readonly described: number
  readonly staleRefs: number
  readonly mediaObserved: number
  readonly refusals: number
  /** Routes decided, keyed by command. For the owner's view, not for behaviour. */
  readonly routed: ReadonlyMap<string, number>
}

export const EMPTY_BROWSER_STATE: BrowserRuntimeState = Object.freeze({
  sessions: new Map(),
  handoffs: new Map(),
  described: 0,
  staleRefs: 0,
  mediaObserved: 0,
  refusals: 0,
  routed: new Map(),
})

/** The page id an element reference is bound to. Deterministic, so a restart recognises it. */
export function pageIdFor(sessionId: string): string {
  return `page-${sessionId}`
}

function entryText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

function entryNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Is this one of the journal entry types this fold understands? */
export function isBrowserFoldEntry(value: unknown): value is { type: BrowserEventType; recordedAt?: string; payload: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string') return false
  const payload = (value as { payload?: unknown }).payload
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (type.startsWith('browser.dual.') || type.startsWith('hands.'))
  )
}

/**
 * Fold the journal into state.
 *
 * Entries this fold does not recognise are ignored, which is what lets the *same* journal
 * hold Device Hands' `hands.*` action records and this phase's page records without either
 * having to understand the other. An entry about an unknown session is ignored too: a
 * record of something that never opened is not a session.
 */
export function foldBrowserState(
  entries: readonly unknown[],
  previous: BrowserRuntimeState = EMPTY_BROWSER_STATE,
): BrowserRuntimeState {
  const sessions = new Map(previous.sessions)
  const handoffs = new Map(previous.handoffs)
  const routed = new Map(previous.routed)
  let described = previous.described
  let staleRefs = previous.staleRefs
  let mediaObserved = previous.mediaObserved
  let refusals = previous.refusals

  for (const entry of entries) {
    if (!isBrowserFoldEntry(entry)) continue
    const payload = entry.payload
    switch (entry.type) {
      case 'browser.dual.session.opened': {
        const sessionId = entryText(payload, 'sessionId')
        if (sessionId === '') continue
        const target = entryText(payload, 'target')
        if (target !== 'public' && target !== 'authenticated') continue
        // A session id that is already open is not re-opened. The runtime refuses the
        // second open; the fold refuses to be talked into one.
        const existing = sessions.get(sessionId)
        if (existing !== undefined && existing.session === 'open') continue
        const createdBy = entryText(payload, 'createdBy')
        sessions.set(sessionId, {
          sessionId,
          target,
          // Freya or the owner. Recorded at open so recovery can rebuild a tab list that knows
          // which pages belonged to the person and which were opened on Freya's own initiative.
          createdBy: createdBy === 'user' ? 'user' : 'freya',
          partition: entryText(payload, 'target') === 'public' ? `freya-public-${sessionId}` : '',
          session: 'open',
          page: 'absent',
          revision: 0,
          pageId: pageIdFor(sessionId),
          url: null,
          title: null,
          openedAt: entryText(payload, 'at'),
          lastObservedAt: null,
          closedAt: null,
          failureCode: null,
        })
        continue
      }
      case 'browser.dual.page.replaced': {
        const sessionId = entryText(payload, 'sessionId')
        const current = sessions.get(sessionId)
        if (current === undefined || current.session !== 'open') continue
        const revision = entryNumber(payload, 'revision')
        if (revision === null || revision <= current.revision) continue
        // An address is required, and this is the second place that says so — the first being
        // `adoptObservedRevision`, which refuses to *write* the entry. This fold refuses to
        // believe one, so a record that reached disk through any other path still cannot turn
        // a session into `ready` with nothing at it. `url` used to be `entryText(payload,
        // 'url')`, which meant the empty string: a `ready` session with no URL, adopted by a
        // renderer as a tab, drawn as an empty browser panel.
        const url = entryText(payload, 'url').trim()
        if (url === '' || !isNavigableBrowserUrl(url)) continue
        sessions.set(sessionId, {
          ...current,
          page: 'ready',
          revision,
          url,
          title: null,
          lastObservedAt: entryText(payload, 'at'),
          failureCode: null,
        })
        continue
      }
      case 'browser.dual.page.failed': {
        const sessionId = entryText(payload, 'sessionId')
        const current = sessions.get(sessionId)
        if (current === undefined || current.session !== 'open') continue
        const revision = entryNumber(payload, 'revision')
        const next = revision !== null && revision > current.revision ? revision : current.revision + 1
        sessions.set(sessionId, {
          ...current,
          page: 'failed',
          revision: next,
          url: null,
          title: null,
          lastObservedAt: entryText(payload, 'at'),
          failureCode: entryText(payload, 'code'),
        })
        continue
      }
      case 'browser.dual.session.closed': {
        const sessionId = entryText(payload, 'sessionId')
        const current = sessions.get(sessionId)
        if (current === undefined || current.session !== 'open') continue
        sessions.set(sessionId, {
          ...current,
          session: 'closed',
          // Not `ready`. A closed window has no page, and leaving the old URL in place is
          // how a projection ends up offering a page that no longer exists.
          page: 'closed',
          url: null,
          title: null,
          lastObservedAt: entryText(payload, 'at'),
          closedAt: entryText(payload, 'at'),
        })
        continue
      }
      case 'browser.dual.page.described':
        described += 1
        continue
      case 'browser.dual.page.scrolled':
      case 'browser.dual.page.selected':
      case 'browser.dual.session.focused':
        // Facts about what happened to a live page, not state transitions. Counted and
        // otherwise ignored: a scroll does not change which page is loaded, and a selection
        // does not change which revision its references belong to.
        continue
      case 'browser.dual.ref.stale':
        staleRefs += 1
        continue
      case 'browser.dual.media.observed':
        mediaObserved += 1
        continue
      case 'browser.dual.refused':
        refusals += 1
        continue
      case 'browser.dual.route.decided': {
        const command = entryText(payload, 'command')
        if (command === '') continue
        routed.set(command, (routed.get(command) ?? 0) + 1)
        continue
      }
      case 'browser.dual.handoff.offered': {
        const id = entryText(payload, 'handoffId')
        if (id === '') continue
        handoffs.set(id, 'open')
        continue
      }
      case 'browser.dual.handoff.consumed': {
        const id = entryText(payload, 'handoffId')
        if (id === '') continue
        handoffs.set(id, 'consumed')
        continue
      }
      case 'browser.dual.handoff.settled': {
        const id = entryText(payload, 'handoffId')
        const state = entryText(payload, 'state')
        if (id === '' || (state !== 'cancelled' && state !== 'expired')) continue
        handoffs.set(id, state)
        continue
      }
      case 'browser.dual.handoff.uncertain': {
        const id = entryText(payload, 'handoffId')
        if (id === '') continue
        handoffs.set(id, 'uncertain')
        continue
      }
      default:
        continue
    }
  }

  return Object.freeze({
    sessions: Object.freeze(sessions) as ReadonlyMap<string, SessionState>,
    handoffs: Object.freeze(handoffs) as ReadonlyMap<string, BrowserHandoffState>,
    described,
    staleRefs,
    mediaObserved,
    refusals,
    routed: Object.freeze(routed) as ReadonlyMap<string, number>,
  })
}

/* ---------------------------------------------------------------- projection */

/**
 * The owner's view, with no field that could be mistaken for a next action.
 *
 * `observed` is the important one: it is false when a session exists but nothing has been
 * observed yet, so a projection that says "ready" also says *how it knows*. A renderer
 * showing a page from a projection with `observed: false` is displaying a belief.
 */
export interface BrowserProjection {
  readonly sessions: readonly {
    readonly sessionId: string
    readonly target: BrowserTarget
    readonly session: BrowserSessionState
    readonly page: BrowserPageState
    readonly revision: number
    readonly url: string | null
    readonly observed: boolean
    readonly createdBy: 'freya' | 'user'
    readonly failureCode: string | null
  }[]
  readonly handoffs: ReadonlyMap<string, BrowserHandoffState>
  readonly described: number
  readonly staleRefs: number
  readonly mediaObserved: number
  readonly refusals: number
  readonly routed: ReadonlyMap<string, number>
}

export function browserProjection(state: BrowserRuntimeState): BrowserProjection {
  return Object.freeze({
    sessions: Object.freeze(
      [...state.sessions.values()]
        .filter((entry) => entry.session === 'open')
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((entry) =>
          Object.freeze({
            sessionId: entry.sessionId,
            target: entry.target,
            session: entry.session,
            page: entry.page,
            revision: entry.revision,
            url: entry.url,
            observed: entry.lastObservedAt !== null,
            createdBy: entry.createdBy,
            failureCode: entry.failureCode,
          }),
        ),
    ),
    handoffs: state.handoffs,
    described: state.described,
    staleRefs: state.staleRefs,
    mediaObserved: state.mediaObserved,
    refusals: state.refusals,
    routed: state.routed,
  })
}

/**
 * How many live sessions this state holds, for the budget check.
 *
 * Counted rather than tracked, so the ceiling cannot drift away from the thing it bounds.
 */
export function liveSessionCount(state: BrowserRuntimeState): number {
  let count = 0
  for (const entry of state.sessions.values()) {
    if (entry.session === 'open') count += 1
  }
  return count
}

/** How many handoffs are still `open`, for the budget check. */
export function openHandoffCount(state: BrowserRuntimeState): number {
  let count = 0
  for (const entry of state.handoffs.values()) {
    if (entry === 'open') count += 1
  }
  return count
}

/** The ceiling this build will hold, exported so the runtime and the audit cannot differ. */
export const MAX_LIVE_SESSIONS = BROWSER_LIMITS.maxSessions