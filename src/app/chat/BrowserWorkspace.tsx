import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DockedDocument } from './DockedDocument'
import { executeBrowser, readBrowserState } from '../../platform/browserClient'
import { hostBridge } from '../../platform/host'
import { backUrl, canGoBack, canGoForward, createDockedBrowserStore, forwardUrl, normalizeOpenInputUrl, tabOriginLabel, type DockedBrowserStore, type DockedTab, type DockedTabOrigin } from './dockedBrowserStore'

let sharedStore: DockedBrowserStore | null = null
export function sharedDockedBrowserStore(): DockedBrowserStore {
  sharedStore ??= createDockedBrowserStore()
  return sharedStore
}
export function openUrlInDockedBrowser(store: DockedBrowserStore, url: string, options?: { readonly origin?: DockedTabOrigin; readonly tabId?: string; readonly title?: string }): DockedTab {
  const existing = options?.tabId ? store.findTab(options.tabId) : null
  if (existing) { store.activateTab(existing.id); return existing }
  return store.openTab({ url, title: options?.title, origin: options?.origin, activate: true })
}
export type { DockedBrowserSnapshot, DockedBrowserStore, DockedTab, DockedTabOrigin, OpenTabInput } from './dockedBrowserStore'
export { backUrl, canGoBack, canGoForward, currentHistoryUrl, createDockedBrowserStore, forwardUrl, tabOriginLabel } from './dockedBrowserStore'

/** Each native page has its own isolated session and survives switching or hiding the dock. */
export function DockedBrowser({ requestedUrl, onRequestedUrlHandled, onClose }: {
  requestedUrl: string | null
  requestedOrigin?: DockedTabOrigin
  onRequestedUrlHandled: () => void
  onClose: () => void
  onPopOut?: () => void
}) {
  const store = sharedDockedBrowserStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const tab = snapshot.tabs.find((candidate) => candidate.id === snapshot.activeId) ?? null
  const documentUrl = tab?.url && (/\.pdf(?:$|[?#])/i.test(tab.url) || tab.origin.kind === 'link' && (tab.origin.mediaKind === 'pdf' || tab.origin.mediaKind === 'document')) ? tab.url : null
  const [address, setAddress] = useState('')
  const [notice, setNotice] = useState('')
  const [available, setAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const opening = useRef(new Map<string, Promise<string | null>>())
  const navigating = useRef(new Set<string>())
  const mounted = useRef(true)

  const ensureSession = useCallback((target: DockedTab): Promise<string | null> => {
    if (target.sessionId) return Promise.resolve(target.sessionId)
    const pending = opening.current.get(target.id)
    if (pending) return pending
    const promise = executeBrowser({ command: 'session.open', target: 'public' }).then(async (result) => {
      if (!result.ok) { setNotice(result.reason); return null }
      const sessionId = typeof result.data.sessionId === 'string' ? result.data.sessionId : null
      if (sessionId && !store.bindSession(target.id, sessionId)) await executeBrowser({ command: 'session.close', target: 'public', sessionId })
      return sessionId
    }).finally(() => opening.current.delete(target.id))
    opening.current.set(target.id, promise)
    return promise
  }, [store])

  const navigate = useCallback(async (target: DockedTab, url: string, cursor?: number): Promise<boolean> => {
    if (/\.pdf(?:$|[?#])/i.test(url) || target.origin.kind === 'link' && (target.origin.mediaKind === 'pdf' || target.origin.mediaKind === 'document')) {
      if (cursor !== undefined) { store.recordHistoryMove(target.id, { cursor }); store.recordNavigation(target.id, { url, revision: target.revision + 1 }) }
      else store.recordPageReplaced(target.id, { url, revision: target.revision + 1 })
      return true
    }
    if (navigating.current.has(target.id)) return false
    navigating.current.add(target.id)
    setBusy(true)
    try {
      const sessionId = await ensureSession(target)
      if (!sessionId) return false
      const result = await executeBrowser({ command: 'page.navigate', target: 'public', sessionId, url })
      if (!result.ok) {
        store.recordFailure(target.id, { revision: target.revision, reason: result.reason })
        setNotice(result.reason)
        return false
      }
      const finalUrl = typeof result.data.url === 'string' ? result.data.url : url
      const revision = Number(result.data.revision ?? target.revision + 1)
      const title = typeof result.data.title === 'string' ? result.data.title : undefined
      if (cursor !== undefined) {
        store.recordHistoryMove(target.id, { cursor })
        store.recordNavigation(target.id, { url: finalUrl, title, revision })
      } else store.recordPageReplaced(target.id, { url: finalUrl, title, revision })
      if (store.activeTab()?.id === target.id) setAddress(finalUrl)
      setNotice('')
      return true
    } finally {
      navigating.current.delete(target.id)
      if (mounted.current) setBusy(false)
    }
  }, [ensureSession, store])

  useEffect(() => { if (requestedUrl !== null) onRequestedUrlHandled() }, [requestedUrl, onRequestedUrlHandled])
  useEffect(() => { setAddress(tab?.url ?? '') }, [tab?.id, tab?.url])
  useEffect(() => {
    if ((available || documentUrl) && tab?.url && !tab.liveUrl && tab.page !== 'failed') void navigate(tab, tab.url)
  }, [available, tab, navigate, documentUrl])

  useEffect(() => {
    mounted.current = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const state = await readBrowserState()
        if (!mounted.current) return
        setAvailable(state.available && state.publicAvailable)
        if (!state.available) setNotice(state.reason ?? 'Browser unavailable')
        for (const session of state.sessions) {
          if (session.target !== 'public' || session.session !== 'open') continue
          let target = store.getSnapshot().tabs.find((candidate) => candidate.sessionId === session.sessionId)
          if (!target && !opening.current.size) {
            target = store.openTab({ url: session.url, origin: { kind: 'handoff', fromSession: session.sessionId } })
            store.bindSession(target.id, session.sessionId)
          }
          if (target && session.url && !navigating.current.has(target.id) && (target.liveUrl !== session.url || target.revision !== session.revision)) {
            store.recordPageReplaced(target.id, { url: session.url, revision: session.revision })
          }
        }
      } finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 800)
    return () => { mounted.current = false; window.clearInterval(timer); void hostBridge()?.browserDock?.({ sessionId: null, bounds: null }) }
  }, [store])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const dock = () => {
      const rect = element.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0 && !document.hidden && !historyOpen && !documentUrl
      void hostBridge()?.browserDock?.({ sessionId: visible ? tab?.sessionId ?? null : null, bounds: visible && tab?.sessionId ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null })
    }
    dock()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(dock)
    observer?.observe(element)
    window.addEventListener('resize', dock)
    window.addEventListener('scroll', dock, true)
    document.addEventListener('visibilitychange', dock)
    return () => { observer?.disconnect(); window.removeEventListener('resize', dock); window.removeEventListener('scroll', dock, true); document.removeEventListener('visibilitychange', dock) }
  }, [tab?.sessionId, historyOpen, documentUrl])

  const submitAddress = async () => {
    const target = tab ?? store.openTab()
    const url = normalizeOpenInputUrl(address)
    if (url) await navigate(target, url)
    else if (address.trim()) await navigate(target, `https://www.google.com/search?q=${encodeURIComponent(address)}`)
  }
  const closeTab = async (target: DockedTab) => {
    if (target.sessionId) {
      const result = await executeBrowser({ command: 'session.close', target: 'public', sessionId: target.sessionId })
      if (!result.ok) { setNotice(result.reason); return }
    }
    store.closeTab(target.id)
  }

  return <aside className="chats-browser" aria-label="Browsed tabs workspace">
    <header className="chats-browser-head"><b>Browser</b><div><small>{available ? 'isolated' : 'unavailable'}</small><button type="button" aria-label="Open a new tab" onClick={() => store.openTab()}>+</button><button type="button" aria-label="Close browser workspace" onClick={onClose}>×</button></div></header>
    <div className="chats-browser-tabs" role="tablist">
      {snapshot.tabs.map((item) => <div key={item.id} className={`chats-browser-tab${item.id === tab?.id ? ' on' : ''}`} data-origin={item.origin.kind}>
        <button role="tab" aria-selected={item.id === tab?.id} onClick={() => store.activateTab(item.id)} title={item.url ?? item.title}><span>{item.title}</span><small>{tabOriginLabel(item.origin)}</small></button>
        <button aria-label={`Close ${item.title}`} disabled={busy} onClick={() => void closeTab(item)}>×</button>
      </div>)}
    </div>
    <form className="chats-browser-address" onSubmit={(event) => { event.preventDefault(); void submitAddress() }}>
      <button type="button" aria-label="Back" disabled={busy || !tab || !canGoBack(tab)} onClick={() => { if (tab) void navigate(tab, backUrl(tab)!, tab.cursor - 1) }}>←</button>
      <button type="button" aria-label="Forward" disabled={busy || !tab || !canGoForward(tab)} onClick={() => { if (tab) void navigate(tab, forwardUrl(tab)!, tab.cursor + 1) }}>→</button>
      <button type="button" aria-label="Reload" disabled={busy || !tab?.url} onClick={() => { if (tab?.url) void navigate(tab, tab.url, tab.cursor) }}>↻</button>
      <input aria-label="Browser address or search" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Address or search" />
      <button type="submit" disabled={!available || busy}>Go</button>
    </form>
    <div className="chats-browser-actions"><button type="button" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>History</button>{tab?.origin.kind === 'link' ? <small title={tab.origin.ownerText}>{tabOriginLabel(tab.origin)} · {tab.origin.ownerText}</small> : null}</div>
    <div className="chats-browser-native" ref={viewport} data-session-id={tab?.sessionId} aria-label="Browser page">
      {historyOpen ? <ol className="chats-browser-history">{tab?.history.map((url, index) => <li key={`${url}-${index}`}><button disabled={busy || index === tab.cursor} onClick={() => { setHistoryOpen(false); if (tab) void navigate(tab, url, index) }}>{url}</button></li>)}</ol> : documentUrl ? <DockedDocument url={documentUrl} /> : !tab?.liveUrl ? <div className="chats-browser-empty"><b>{busy ? 'Opening page…' : 'Browse alongside your conversation'}</b><p>{tab?.page === 'failed' ? notice : 'Enter an address or open a finding, source or media card.'}</p></div> : null}
    </div>
    {notice ? <p className="chats-browser-notice" role="status">{notice}</p> : null}
  </aside>
}
