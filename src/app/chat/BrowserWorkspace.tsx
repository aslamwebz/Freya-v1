import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BrowserResult } from '../../../core/browser'
import type { BrowserBridgeState } from '../../../electron/browser/rendererRequest'
import { executeBrowser, readBrowserState } from '../../platform/browserClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'

interface BrowserElementView {
  readonly ref: string
  readonly kind: 'link' | 'button' | 'field' | 'heading' | 'text'
  readonly label: string
  readonly protected: boolean
  readonly disabled: boolean
}

function dataString(result: BrowserResult, key: string): string | null {
  if (!result.ok) return null
  const value = result.data[key]
  return typeof value === 'string' ? value : null
}

function describedElements(result: BrowserResult): BrowserElementView[] {
  if (!result.ok || !Array.isArray(result.data.elements)) return []
  return result.data.elements.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return []
    const row = candidate as Record<string, unknown>
    if (
      typeof row.ref !== 'string' ||
      typeof row.kind !== 'string' ||
      !['link', 'button', 'field', 'heading', 'text'].includes(row.kind) ||
      typeof row.label !== 'string'
    ) return []
    return [{
      ref: row.ref,
      kind: row.kind as BrowserElementView['kind'],
      label: row.label,
      protected: row.protected === true,
      disabled: row.disabled === true,
    }]
  })
}

function outcomeNotice(result: BrowserResult): string {
  if (!result.ok) return result.reason
  if (result.escalation) {
    return result.command + ' completed. This page may need the authenticated browser: ' + result.escalation.detail
  }
  return result.command + ' completed in the ' + result.target + ' browser.'
}

export function BrowserWorkspace({
  requestedUrl,
  onRequestedUrlHandled,
  onClose,
}: {
  requestedUrl: string | null
  onRequestedUrlHandled: () => void
  onClose: () => void
}) {
  const [state, setState] = useState<BrowserBridgeState | null>(null)
  const [address, setAddress] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [elements, setElements] = useState<BrowserElementView[]>([])
  const [pageTitle, setPageTitle] = useState('')
  const [pendingHandoff, setPendingHandoff] = useState<string | null>(null)
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    const next = await readBrowserState()
    setState(next)
    const current = next.sessions.find((session) => session.target === 'public' && session.session === 'open')
    if (current?.url) setAddress(current.url)
    return next
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const current = useMemo(
    () => state?.sessions.find((session) => session.target === 'public' && session.session === 'open') ?? null,
    [state],
  )

  const ensureSession = useCallback(async (): Promise<string | null> => {
    const before = await readBrowserState()
    setState(before)
    const existing = before.sessions.find((session) => session.target === 'public' && session.session === 'open')
    if (existing) return existing.sessionId
    if (!before.available || !before.publicAvailable) {
      setNotice(before.reason ?? 'The isolated Freya Browser is unavailable in this build.')
      return null
    }

    const opened = await executeBrowser({ command: 'session.open', target: 'public' })
    setNotice(outcomeNotice(opened))
    if (!opened.ok) return null
    const sessionId = dataString(opened, 'sessionId')
    await refresh()
    return sessionId
  }, [refresh])

  const navigate = useCallback(async (url: string) => {
    const value = url.trim()
    if (!value) return

    setBusy(true)
    setElements([])
    setPendingHandoff(null)
    try {
      const sessionId = await ensureSession()
      if (!sessionId) return
      const result = await executeBrowser({
        command: 'page.navigate',
        target: 'public',
        sessionId,
        url: value,
      })
      setNotice(outcomeNotice(result))
      if (result.ok) {
        setAddress(dataString(result, 'url') ?? value)
        setPageTitle(dataString(result, 'title') ?? '')
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [ensureSession, refresh])

  useEffect(() => {
    if (requestedUrl === null) return
    onRequestedUrlHandled()
    void navigate(requestedUrl)
  }, [navigate, onRequestedUrlHandled, requestedUrl])

  const inspect = async () => {
    if (!current || busy) return
    setBusy(true)
    try {
      const result = await executeBrowser({
        command: 'page.describe',
        target: 'public',
        sessionId: current.sessionId,
      })
      setNotice(outcomeNotice(result))
      setElements(describedElements(result))
      if (result.ok) setPageTitle(dataString(result, 'title') ?? pageTitle)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const click = async (ref: string) => {
    if (!current || busy) return
    setBusy(true)
    try {
      const result = await executeBrowser({
        command: 'page.click',
        target: 'public',
        sessionId: current.sessionId,
        ref,
      })
      setNotice(outcomeNotice(result))
      setElements([])
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const typeInto = async (ref: string) => {
    if (!current || busy) return
    const text = fieldDrafts[ref]?.trim() ?? ''
    if (!text) return
    setBusy(true)
    try {
      const result = await executeBrowser({
        command: 'page.type',
        target: 'public',
        sessionId: current.sessionId,
        ref,
        text,
      })
      setNotice(outcomeNotice(result))
      if (result.ok) setFieldDrafts((drafts) => ({ ...drafts, [ref]: '' }))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const offerHandoff = async () => {
    if (!current || busy) return
    setBusy(true)
    try {
      const result = await executeBrowser({
        command: 'handoff.offer',
        target: 'public',
        sessionId: current.sessionId,
        reason: 'The owner chose to continue this page in their authenticated browser.',
      })
      setNotice(outcomeNotice(result))
      setPendingHandoff(result.ok ? dataString(result, 'handoffId') : null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const acceptHandoff = async () => {
    if (!pendingHandoff || busy) return
    setBusy(true)
    try {
      const result = await executeBrowser({
        command: 'handoff.accept',
        target: 'authenticated',
        handoffId: pendingHandoff,
      })
      setNotice(outcomeNotice(result))
      if (result.ok) setPendingHandoff(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const closeSession = async () => {
    if (!current || busy) return
    setBusy(true)
    try {
      const result = await executeBrowser({
        command: 'session.close',
        target: 'public',
        sessionId: current.sessionId,
      })
      setNotice(outcomeNotice(result))
      setElements([])
      setPageTitle('')
      setAddress('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const available = state?.available === true && state.publicAvailable
  const extensionReady = state?.extensionPaired === true && state.extensionLive === true

  return (
    <aside className="chats-browser" aria-label="Browser workspace">
      <header className="chats-browser-head">
        <span><Glyph name="world" size={16} /><b>Browser</b></span>
        <div>
          <small data-ready={available || undefined}>{available ? 'isolated' : 'unavailable'}</small>
          <button type="button" aria-label="Close browser workspace" onClick={onClose}>×</button>
        </div>
      </header>

      <form className="chats-browser-address" onSubmit={(event) => {
        event.preventDefault()
        void navigate(address)
      }}>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="https://example.com"
          aria-label="Browser address"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !address.trim()}>Go</button>
      </form>

      <div className="chats-browser-state">
        <span><i data-on={current?.page === 'ready' || undefined} />{current?.page ?? 'no session'}</span>
        <span>{current ? 'rev ' + current.revision : 'no page revision'}</span>
        <span>{state?.journalTrustworthy ? 'journal verified' : 'journal unavailable'}</span>
      </div>

      {pageTitle ? <h3 className="chats-browser-title">{pageTitle}</h3> : null}

      {!available ? (
        <div className="chats-browser-empty">
          <Glyph name="world" size={28} />
          <b>Browser runtime is off</b>
          <p>{state?.reason ?? 'This build has not exposed the isolated browser runtime.'}</p>
        </div>
      ) : current === null ? (
        <div className="chats-browser-empty">
          <Glyph name="world" size={28} />
          <b>No public session</b>
          <p>Enter a public URL. Freya will create an isolated credential-free browser session first.</p>
        </div>
      ) : (
        <>
          <div className="chats-browser-actions">
            <button type="button" disabled={busy || current.page !== 'ready'} onClick={() => void inspect()}>
              Inspect page
            </button>
            <button type="button" disabled={busy || current.page !== 'ready'} onClick={() => void offerHandoff()}>
              Continue signed-in
            </button>
            <button type="button" disabled={busy} onClick={() => void closeSession()}>
              Close session
            </button>
          </div>

          {pendingHandoff ? (
            <section className="chats-browser-handoff">
              <b>Authenticated handoff ready</b>
              <p>Only the URL and bounded reason cross contexts. No cookies, tokens, form values, or browser storage are copied.</p>
              <button type="button" disabled={busy || !extensionReady} onClick={() => void acceptHandoff()}>
                {extensionReady ? 'Open in paired Chrome' : 'Paired Chrome is not connected'}
              </button>
            </section>
          ) : null}

          <div className="chats-browser-elements">
            {elements.length === 0 ? (
              <p>Inspect the current page to mint revision-bound references for visible controls.</p>
            ) : elements.map((element) => (
              <section key={element.ref} className="chats-browser-element" data-kind={element.kind}>
                <header>
                  <span>{element.kind}</span>
                  <code>{element.ref}</code>
                </header>
                <b>{element.label || 'Unlabelled control'}</b>
                {element.protected ? <small>Protected field — Freya will not type here.</small> : null}
                {element.disabled ? <small>Disabled on the page.</small> : null}
                {element.kind === 'field' ? (
                  <div className="chats-browser-field">
                    <input
                      value={fieldDrafts[element.ref] ?? ''}
                      onChange={(event) => setFieldDrafts((drafts) => ({ ...drafts, [element.ref]: event.target.value }))}
                      placeholder={element.protected ? 'Protected field' : 'Text to type'}
                      disabled={busy || element.protected || element.disabled}
                    />
                    <button
                      type="button"
                      disabled={busy || element.protected || element.disabled || !(fieldDrafts[element.ref]?.trim())}
                      onClick={() => void typeInto(element.ref)}
                    >
                      Type
                    </button>
                  </div>
                ) : element.kind === 'button' || element.kind === 'link' ? (
                  <button
                    type="button"
                    disabled={busy || element.disabled}
                    onClick={() => void click(element.ref)}
                  >
                    Activate
                  </button>
                ) : null}
              </section>
            ))}
          </div>
        </>
      )}

      {notice ? <p className="chats-browser-notice" role="status">{notice}</p> : null}
    </aside>
  )
}
