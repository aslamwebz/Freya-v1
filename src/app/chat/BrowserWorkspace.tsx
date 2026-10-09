import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { dockBrowserView, onBrowserState, readBrowserState, runBrowserCommand, type RuntimeStatus } from '../../platform/browserClient'
import { addressAsQuery, normalizeOpenInputUrl, sharedDockedBrowserStore, tabOriginLabel, type DockedBrowserStore, type DockedTab, type DockedTabOrigin, type DockedTabStatus } from './dockedBrowserStore'
import type { SemanticBrowserResult, SemanticSnapshot } from '../../../core/browser/service'

export { sharedDockedBrowserStore, createDockedBrowserStore, normalizeOpenInputUrl, tabOriginLabel } from './dockedBrowserStore'
export type { DockedBrowserSnapshot, DockedBrowserStore, DockedTab, DockedTabOrigin } from './dockedBrowserStore'

/**
 * Open a URL in the workspace.
 *
 * This now sends an intent rather than building a tab. The tab is created by the Browser
 * Service, in the same process as the `WebContentsView` it will be shown in, which is the
 * only way a tab can have a view at all — and the only way its lifecycle can be the service's
 * rather than a guess made from a URL string in the renderer.
 */
export async function openUrlInDockedBrowser(
  store: DockedBrowserStore,
  url: string,
  options?: { readonly origin?: DockedTabOrigin; readonly activate?: boolean },
): Promise<void> {
  void store
  const result = await runBrowserCommand({
    op: 'open',
    url,
    origin: options?.origin ?? { kind: 'link', from: 'chat', ownerText: 'owner' },
    createdBy: 'user',
    ...(options?.activate === false ? { activate: false } : {}),
  })
  if (!result.ok) return
  void store
}

/**
 * The Browser Workspace: a tab strip, a toolbar, and a hole for the real page.
 *
 * ## What renders where
 *
 * The page content is a native `WebContentsView`, not this component's output. `.chats-browser-native`
 * is a transparent measuring box; the main process attaches the front tab's view exactly over
 * it and removes every other view. So this component's job is only:
 *
 *   - draw chrome (strip, address bar, back/forward/reload, new tab, close);
 *   - keep the view the right size and in the right place, through a `ResizeObserver` and a
 *     bounds message that the main process clamps to the window;
 *   - decide, from the service's own lifecycle state, which of five panels fills the hole
 *     when there is no page to show.
 *
 * ## The five states, and why they are five
 *
 * `creating` (a tab exists, no address yet), `navigating` (an address was accepted, a load is
 * in flight), `ready` (a page is on screen — the view shows through), `failed` (something was
 * attempted and did not happen) and "no browser at all". Those are five different facts and the
 * previous build rendered four of them as one indistinguishable empty box, which is the bug
 * this component exists not to reintroduce.
 *
 * ## No polling
 *
 * State arrives by push, from `onBrowserState`. The previous version re-read the whole
 * projection every 800 ms whether or not anything had changed, and the cost of that grows with
 * the tab count. One read on mount, then a subscription.
 */
export function DockedBrowser({ requestedUrl, requestedOrigin, onRequestedUrlHandled, onClose }: {
  requestedUrl: string | null
  requestedOrigin?: DockedTabOrigin
  onRequestedUrlHandled(): void
  onClose(): void
}) {
  const store = sharedDockedBrowserStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const tab = snapshot.tabs.find((item) => item.id === snapshot.activeId) ?? null
  const [address, setAddress] = useState('')
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState<RuntimeStatus>('starting')
  const [reason, setReason] = useState<string | null>(null)
  const [journalTrustworthy, setJournalTrustworthy] = useState(false)
  const [snapshotView, setSnapshotView] = useState<SemanticSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const dockedSession = useRef<string | null>(null)
  /** Whether the last thing this workspace said about placement was "nothing is attached". */
  const hidden = useRef(false)

  /* ------------------------------------------------------------- state in */

  const lastRect = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    /**
     * One state object, consumed once.
     *
     * The strip mirrors `tabs` — the service's own tab list, each row carrying its lifecycle
     * state — and reads `runtimeStatus` and `reason` for the panels. It never infers a status
     * from how many tabs there are, and it never builds a tab from a session summary: a
     * diagnostic row is not a tab, and treating one as a tab is precisely how the previous
     * build produced a browser panel with nothing in it.
     */
    const apply = (state: Awaited<ReturnType<typeof readBrowserState>>): void => {
      if (cancelled) return
      setStatus(state.runtimeStatus)
      setJournalTrustworthy(state.journalTrustworthy)
      setReason(state.reason)
      store.sync(state.tabs, state.activeTabId)
    }
    void readBrowserState().then(apply)
    const off = onBrowserState(apply)
    return () => {
      cancelled = true
      off()
    }
  }, [store])

  useEffect(() => { if (requestedUrl !== null) onRequestedUrlHandled() }, [requestedUrl, onRequestedUrlHandled])

  useEffect(() => {
    if (requestedUrl === null) return
    void openUrlInDockedBrowser(store, requestedUrl, requestedOrigin ? { origin: requestedOrigin } : {})
  }, [requestedUrl, requestedOrigin, store])

  useEffect(() => { setAddress(tab?.liveUrl ?? tab?.url ?? '') }, [tab?.id, tab?.liveUrl, tab?.url])

  /* --------------------------------------------------------------- intents */

  const act = useCallback(async (command: Parameters<typeof runBrowserCommand>[0]): Promise<SemanticBrowserResult> => {
    setBusy(true)
    setNotice('')
    try {
      const result = await runBrowserCommand(command)
      if (!result.ok) setNotice(result.reason)
      return result
    } finally {
      setBusy(false)
    }
  }, [])

  const openNewTab = useCallback(async () => {
    // A new tab is a tab with **no address**. That is a real state — `creating` — and it is
    // what makes "new tab" different from "open the last page again": the owner gets somewhere
    // to type, and the panel above the view says so in words.
    const result = await act({ op: 'open', url: null, origin: { kind: 'manual' }, createdBy: 'user' })
    return result
  }, [act])

  const goBack = useCallback(async () => { await act({ op: 'back', tabId: tab?.id ?? null }) }, [act, tab?.id])
  const goForward = useCallback(async () => { await act({ op: 'forward', tabId: tab?.id ?? null }) }, [act, tab?.id])
  const reload = useCallback(async () => { await act({ op: 'reload', tabId: tab?.id ?? null }) }, [act, tab?.id])
  const closeTab = useCallback(async (target: DockedTab) => { await act({ op: 'close', tabId: target.id }) }, [act])
  const activateTab = useCallback(async (target: DockedTab) => { await act({ op: 'activate', tabId: target.id }) }, [act])

  const submitAddress = useCallback(async () => {
    const raw = address.trim()
    if (raw === '') return
    const direct = normalizeOpenInputUrl(raw)
    const target = direct ?? addressAsQuery(raw)
    if (tab === null) {
      await act({ op: 'open', url: target, origin: { kind: 'link', from: 'address', ownerText: 'owner' }, createdBy: 'user' })
      return
    }
    await act({ op: 'navigate', tabId: tab.id, url: target })
  }, [act, address, tab])

  const inspect = useCallback(async () => {
    const result = await act({ op: 'snapshot', tabId: tab?.id ?? null })
    if (result.ok) {
      const snapshotValue = result.data.snapshot as SemanticSnapshot | undefined
      setSnapshotView(snapshotValue ?? null)
    }
  }, [act, tab?.id])

  /* --------------------------------------------------------------- the view */

  /**
   * Place the front tab's view.
   *
   * `ResizeObserver` rather than a layout effect, because a resize is not the only reason a
   * native view moves: the split divider, a sidebar opening, a scrollbar appearing — none of
   * which re-render this component. The observer is the one thing that sees all of them.
   *
   * The message carries no authority: the main process clamps the rect to the window's own
   * content bounds, so a compromised renderer cannot park a native view over the application
   * chrome. And the *front* tab is what is docked, always, so a background tab's view is
   * detached from the view tree entirely rather than left underneath the page in front.
   */
  useEffect(() => {
    const box = viewport.current
    if (box === null) return
    let queued = 0
    const send = (): void => {
      // Visibility is decided by the measured box, not by `offsetParent`. `offsetParent` is
      // null for a fixed-position element as well as for a detached one, and the browser
      // workspace's viewport is exactly the kind of box whose ancestry is not the point — so
      // consulting it would hide a live view whenever the layout happened to position it
      // outside the normal flow.
      const rect = box.getBoundingClientRect()
      const sessionId = tab?.status === 'ready' ? (tab?.sessionId ?? null) : null
      if (sessionId === null || rect.width <= 0 || rect.height <= 0) {
        // Nothing to place, or nowhere to place it. The message has to be the *hide* form —
        // `{sessionId: null, bounds: null}` — because a null session id paired with real
        // bounds is not a request to place anything, it is a malformed one the host refuses.
        // Refusing is right, but it would leave the last tab's view attached over the chat.
        //
        // Only a **ready** tab is ever placed: docking a view over a pending or failed tab is
        // how a native view ends up floating on top of an empty panel, which is the exact
        // symptom this whole change set exists to remove.
        // Once, and only once, per "nothing is attached" stretch. Sending it on mount matters:
        // a workspace that opens with nothing in it must still say so, or a view left attached
        // by an earlier session would keep painting over the chat with no tab to own it.
        if (dockedSession.current !== null || lastRect.current !== null || hidden.current === false) {
          dockedSession.current = null
          lastRect.current = null
          hidden.current = true
          void dockBrowserView({ sessionId: null, bounds: null })
        }
        return
      }
      const sameSession = sessionId === dockedSession.current
      // A bounds message for the tab already attached is redundant: the view is already
      // exactly there, and sending one anyway would re-place it on every scroll frame.
      if (sameSession && Math.abs((lastRect.current?.x ?? -1) - rect.x) < 1 && Math.abs((lastRect.current?.y ?? -1) - rect.y) < 1 && Math.abs((lastRect.current?.width ?? -1) - rect.width) < 1 && Math.abs((lastRect.current?.height ?? -1) - rect.height) < 1) return
      dockedSession.current = sessionId
      hidden.current = false
      lastRect.current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      void dockBrowserView({ sessionId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
    }
    const observer = new ResizeObserver(() => {
      if (queued !== 0) return
      queued = window.requestAnimationFrame(() => {
        queued = 0
        send()
      })
    })
    observer.observe(box)
    window.addEventListener('resize', send)
    window.addEventListener('scroll', send, true)
    document.addEventListener('visibilitychange', send)
    send()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', send)
      window.removeEventListener('scroll', send, true)
      document.removeEventListener('visibilitychange', send)
      if (queued !== 0) window.cancelAnimationFrame(queued)
    }
  }, [tab?.sessionId, tab?.status, status])

  /**
   * Closing the workspace must remove the native view.
   *
   * The placement effect above owns where the view sits while the workspace is
   * open, and it hides the view when the front tab goes away. Nothing detached it
   * when the workspace *closes*: the component unmounts, the `ResizeObserver`
   * disconnects, and the front tab's `WebContentsView` stays attached at whatever
   * bounds it last had — painting a blank browser-shaped rectangle over the chat
   * with no panel and no tab to own it. This is the unmount-only half of
   * placement, so it is its own effect with an empty dependency list rather than
   * part of the re-runnable one above (a hide sent on every re-run would make the
   * view flicker as the tab changes).
   */
  useEffect(() => () => {
    void dockBrowserView({ sessionId: null, bounds: null })
  }, [])

  /* ------------------------------------------------------------- the panels */

  const empty = useMemo(() => panelFor({ status, reason, tab, journalTrustworthy, busy }), [status, reason, tab, journalTrustworthy, busy])

  const statusLabel: Record<RuntimeStatus, string> = {
    active: 'isolated',
    disabled: 'paused',
    journalUntrusted: 'journal suspended',
    surfaceUnavailable: 'unavailable',
    starting: 'starting',
  }

  return <aside className="chats-browser" aria-label="Browsed tabs workspace">
    <header className="chats-browser-head">
      <b>Browser</b>
      <div>
        <small data-runtime={status}>{statusLabel[status]}</small>
        <button type="button" aria-label="Open a new tab" onClick={() => void openNewTab()}>+</button>
        <button type="button" aria-label="Close browser workspace" onClick={onClose}>×</button>
      </div>
    </header>
    <div className="chats-browser-tabs" role="tablist">
      {snapshot.tabs.map((item) => <div key={item.id} className={`chats-browser-tab${item.id === tab?.id ? ' on' : ''}`} data-origin={item.origin.kind} data-status={item.status} data-created-by={item.createdBy}>
        <button role="tab" aria-selected={item.id === tab?.id} onClick={() => void activateTab(item)} title={item.liveUrl ?? item.url ?? item.title}>
          <span>{item.title}</span>
          <small>{tabOriginLabel(item.origin)}</small>
        </button>
        <button aria-label={`Close ${item.title}`} disabled={busy} onClick={() => void closeTab(item)}>×</button>
      </div>)}
    </div>
    <form className="chats-browser-bar" onSubmit={(event) => { event.preventDefault(); void submitAddress() }}>
      <button type="button" aria-label="Back" disabled={busy || !tab?.canGoBack} onClick={() => void goBack()}>←</button>
      <button type="button" aria-label="Forward" disabled={busy || !tab?.canGoForward} onClick={() => void goForward()}>→</button>
      <button type="button" aria-label="Reload" disabled={busy || tab?.status !== 'ready'} onClick={() => void reload()}>↻</button>
      <input aria-label="Browser address or search" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Address or search" />
      <button type="submit" disabled={status !== 'active' || busy}>Go</button>
    </form>
    <div className="chats-browser-actions">
      <button type="button" onClick={() => void inspect()} disabled={status !== 'active' || tab?.status !== 'ready'}>Read page</button>
      {tab?.origin.kind === 'link' ? <small title={tab.origin.ownerText}>{tabOriginLabel(tab.origin)} · {tab.origin.ownerText}</small> : null}
      {snapshot.tabs.length > 0 ? <small>{snapshot.tabs.length} tab{snapshot.tabs.length === 1 ? '' : 's'}</small> : null}
    </div>
    <div className="chats-browser-native" ref={viewport} data-session-id={tab?.liveUrl ?? ''} data-status={tab?.status ?? 'none'} aria-label="Browser page">
      {empty}
      {snapshotView === null ? null : <pre className="chats-browser-snapshot" aria-label="Page snapshot">{snapshotView.rendered}</pre>}
    </div>
    {notice ? <p className="chats-browser-notice" role="status">{notice}</p> : null}
  </aside>
}

/**
 * Which panel fills the hole, or `null` to let the page show through.
 *
 * Six mutually exclusive outcomes, each a different fact:
 *
 *   - **journal untrustworthy** — the record does not chain, so nothing opened;
 *   - **runtime not active** — with the reason the host gave, by status;
 *   - **no tab at all** — an empty workspace, which is a normal thing to be;
 *   - **creating** — a tab with no address yet, which is what "new tab" means;
 *   - **navigating** — an address accepted, a load in flight;
 *   - **failed** — an attempt that did not land, with the code the service reported.
 *
 * `ready` returns `null`, and only `ready`. A page is on screen exactly when the service says
 * one is, which is the invariant the whole state machine exists to hold.
 */
function panelFor(input: {
  readonly status: RuntimeStatus
  readonly reason: string | null
  readonly tab: DockedTab | null
  readonly journalTrustworthy: boolean
  readonly busy: boolean
}): React.ReactElement | null {
  if (!input.journalTrustworthy) {
    return <div className="chats-browser-empty" data-state="journal-untrusted">
      <b>The browser is suspended</b>
      <p>Freya's journal does not chain, so it did not open a browser. A record nobody has read is not a record to act on. Run recovery to reconcile it, then reopen the browser.</p>
    </div>
  }
  if (input.status !== 'active') {
    const explanations: Record<RuntimeStatus, string> = {
      active: '',
      disabled: 'The browser runtime is switched off, so Freya has not opened a browser window.',
      journalUntrusted: 'The runtime is paused because the journal is not trustworthy.',
      surfaceUnavailable: 'No embedded page could be created, so there is nothing to show here.',
      starting: 'The browser stack is still being composed.',
    }
    return <div className="chats-browser-empty" data-state="runtime-unavailable">
      <b>The browser is unavailable</b>
      <p>{explanations[input.status] || input.reason || 'Freya cannot open a browser window right now.'}</p>
    </div>
  }
  if (input.tab === null) {
    return <div className="chats-browser-empty" data-state="no-tab">
      <b>No browser tab open</b>
      <p>Use the + button to open a new tab, or follow a link from a citation, a finding or a media card.</p>
    </div>
  }
  switch (input.tab.status as DockedTabStatus) {
    case 'creating':
      return <div className="chats-browser-empty" data-state="tab-creating">
        <b>New tab</b>
        <p>This tab exists and has not been given an address. Type one above to start.</p>
      </div>
    case 'navigating':
      return <div className="chats-browser-empty" data-state="tab-navigating">
        <b>Opening {input.tab.url ?? 'page'}</b>
        <p>The page is loading. Its controls will be described once it settles.</p>
      </div>
    case 'failed':
      return <div className="chats-browser-empty" data-state="tab-failed">
        <b>That page did not load</b>
        <p>Freya tried {input.tab.url ?? 'that address'} and the page did not load ({input.tab.error ?? 'no address reported'}). Nothing is being shown because there is no page.</p>
      </div>
    default:
      return null
  }
}

