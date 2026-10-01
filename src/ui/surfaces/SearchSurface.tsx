import { useEffect, useState } from 'react'
import type { ResearchCommandOutcome } from '../../../core/protocol/core-protocol'
import { researchMirror } from '../../platform/researchClient'

/**
 * Search — web search and read-a-source, through Core.
 *
 * Phase 0's version returned zero results and said so, which was the right thing to
 * do with nothing behind it. There is a Searcher now, so this window does the real
 * thing: query the configured provider, and fetch and extract any source you ask it
 * to read.
 *
 * ## What it refuses to do
 *
 * It cannot search anything local, and it does not pretend to. The old list of
 * "scopes the Searcher will cover" would now be a lie in one direction and a stub in
 * the other, so it is gone: web search is real, and nothing else exists.
 *
 * A provider that is absent or disabled produces a stated reason and **zero request
 * calls**. Nothing is retried and no fallback provider is tried, because a silent
 * fallback would mean a page read going somewhere the owner did not choose.
 *
 * ## Remote text
 *
 * Everything from a page renders as React children. A page is arbitrary HTML written
 * by an attacker, so `dangerouslySetInnerHTML` here would be remote code execution
 * with a search box in front of it.
 */

type SearchPhase =
  | { kind: 'idle' }
  | { kind: 'searching'; query: string }
  | { kind: 'results'; query: string; results: NonNullable<ResearchCommandOutcome['results']> }
  | { kind: 'failed'; reason: string }

type ReadPhase =
  | { kind: 'idle' }
  | { kind: 'reading'; url: string }
  | { kind: 'read'; document: NonNullable<ResearchCommandOutcome['document']> }
  | { kind: 'failed'; reason: string }

export function SearchSurface() {
  const mirror = researchMirror()
  const [query, setQuery] = useState('')
  const [url, setUrl] = useState('')
  const [search, setSearch] = useState<SearchPhase>({ kind: 'idle' })
  const [read, setRead] = useState<ReadPhase>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void mirror.refresh()
    return () => {}
  }, [mirror])

  const runSearch = async () => {
    const value = query.trim()
    if (value.length === 0) return
    setBusy(true)
    setSearch({ kind: 'searching', query: value })
    try {
      const outcome = await mirror.searchWeb(value)
      if (outcome.results) setSearch({ kind: 'results', query: value, results: outcome.results })
      else setSearch({ kind: 'failed', reason: outcome.reason ?? 'The search did not return anything.' })
    } finally {
      setBusy(false)
    }
  }

  const readSource = async () => {
    const value = url.trim()
    if (value.length === 0) return
    setBusy(true)
    setRead({ kind: 'reading', url: value })
    try {
      const outcome = await mirror.readWebPage(value)
      if (outcome.document) setRead({ kind: 'read', document: outcome.document })
      else setRead({ kind: 'failed', reason: outcome.reason ?? 'That page could not be read.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="search">
      <section className="search-section">
        <h3>Search the web</h3>
        <p className="search-boundary">
          Queries go to the configured provider. Nothing is searched locally, because nothing is
          indexed locally, and an empty result set is never presented as a real one.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void runSearch()
          }}
        >
          <label className="search-field">
            <span className="search-field-label">Web query</span>
            <input
              type="search"
              value={query}
              maxLength={512}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the web"
              aria-label="Web query"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="search-go" disabled={busy || query.trim().length === 0}>
            Search
          </button>
        </form>

        {search.kind === 'searching' ? <p className="search-status">Searching…</p> : null}
        {search.kind === 'failed' ? (
          <p className="search-status" role="alert">
            {search.reason}
          </p>
        ) : null}

        {search.kind === 'results' ? (
          <div className="search-results" role="status">
            <p className="search-count">
              <b>{search.results.length}</b> result{search.results.length === 1 ? '' : 's'} for{' '}
              {search.query}
            </p>
            {search.results.length === 0 ? (
              <p className="search-boundary">The provider returned nothing for that query.</p>
            ) : (
              <ul className="search-result-list">
                {search.results.map((row) => (
                  <li key={row.url}>
                    <a href={row.url} target="_blank" rel="noreferrer noopener">
                      {row.title || row.url}
                    </a>
                    <span className="search-result-domain">{row.sourceDomain}</span>
                    <p>{row.snippet}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      <section className="search-section">
        <h3>Read a source</h3>
        <p className="search-boundary">
          Freya fetches the page itself, strips scripts and navigation, and shows you the readable
          text. She does not run anything on the page, and she cannot see anything the page hides
          behind a login.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void readSource()
          }}
        >
          <label className="search-field">
            <span className="search-field-label">URL to read</span>
            <input
              type="text"
              value={url}
              maxLength={2048}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/article"
              aria-label="URL to read"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="search-go" disabled={busy || url.trim().length === 0}>
            Read source
          </button>
        </form>

        {read.kind === 'reading' ? <p className="search-status">Reading…</p> : null}
        {read.kind === 'failed' ? (
          <p className="search-status" role="alert">
            {read.reason}
          </p>
        ) : null}

        {read.kind === 'read' ? (
          <article className="search-document">
            <h4>{read.document.title || read.document.url}</h4>
            <p className="search-document-meta">
              <a href={read.document.url} target="_blank" rel="noreferrer noopener">
                {read.document.url}
              </a>
              <span> · {read.document.sourceDomain} · read {read.document.retrievedAt}</span>
            </p>
            {read.document.truncated ? (
              <p className="search-document-truncated">
                This page was longer than Freya reads. What follows is the beginning.
              </p>
            ) : null}
            {read.document.headings.length > 0 ? (
              <ul className="search-document-headings">
                {read.document.headings.map((heading) => (
                  <li key={heading}>{heading}</li>
                ))}
              </ul>
            ) : null}
            {/* Rendered as text. Everything here came off an arbitrary web page. */}
            <pre className="search-document-text">{read.document.text}</pre>
          </article>
        ) : null}
      </section>
    </div>
  )
}