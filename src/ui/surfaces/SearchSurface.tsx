import { useState } from 'react'

/**
 * Search — a working query surface with a deterministic, honest answer.
 *
 * There is no index in Phase 0, so it returns zero results and says why,
 * rather than rendering invented results that look real.
 */
const SCOPES = [
  { name: 'Local files', state: 'not indexed' },
  { name: 'Vault', state: 'no vault yet' },
  { name: 'Semantic retrieval', state: 'no embeddings yet' },
  { name: 'Full-text retrieval', state: 'no index yet' },
  { name: 'Web research', state: 'no network in Phase 0' },
  { name: 'Evidence', state: 'nothing to attribute' },
]

export function SearchSurface() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)

  return (
    <form
      className="search"
      onSubmit={(event) => {
        event.preventDefault()
        const value = query.trim()
        setSubmitted(value.length > 0 ? value : null)
      }}
    >
      <div className="search-field">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files, vault and knowledge"
          aria-label="Search query"
          spellCheck={false}
        />
        <button type="submit" className="search-go" disabled={!query.trim()}>
          Search
        </button>
      </div>

      {submitted ? (
        <div className="search-results" role="status">
          <p className="search-count">
            <b>0</b> results for “{submitted}”
          </p>
          <p className="search-boundary">
            Nothing was searched. The Searcher does not exist in Phase 0, and Freya will not
            pretend that an empty result set is a real one.
          </p>
        </div>
      ) : null}

      <div className="search-scopes">
        <span className="search-scopes-title">Scopes the Searcher will cover</span>
        <ul>
          {SCOPES.map((scope) => (
            <li key={scope.name}>
              <b>{scope.name}</b>
              <em>{scope.state}</em>
            </li>
          ))}
        </ul>
      </div>
    </form>
  )
}
