import { useState } from 'react'
import { readModelCatalog, selectModel } from '../../platform/modelClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'

/**
 * The model picker, self-contained.
 *
 * Everything transient about the picker — whether it is open, the catalogue,
 * the search query, the selection, favourites and Core's own note — lives here,
 * so a keystroke in the search re-renders this component and nothing else. The
 * board, the panels and the centre are untouched while the person types.
 *
 * The catalogue is still a live Core read (never hard-coded, never cached), and
 * a selection is still confirmed by Core: the chip updates at once, then follows
 * Core's own `selected` — or reverts, in Core's words, if Core refuses it.
 */

type ModelEntry = { readonly id: string; readonly ownedBy: string | null }

const FAVORITES_KEY = 'freya.favoriteModels'

/** The model's own name: the id without any provider prefix ("openai/gpt-4o" → "gpt-4o"). */
export function modelName(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash === -1 ? id : id.slice(slash + 1)
}

/** Favourites live only on this machine; nothing about a model crosses the bridge. */
function readFavorites(): readonly string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function ModelSelector({ defaultModel }: { defaultModel: string | null }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<readonly ModelEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [favorites, setFavorites] = useState<readonly string[]>(readFavorites)
  const [note, setNote] = useState('')

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (!next) return
    setNote('')
    setQuery('')
    void readModelCatalog().then(outcome => {
      if (outcome.operation === 'catalog' && outcome.models) setModels(outcome.models)
      else { setModels([]); setNote(outcome.reason ?? 'The model catalogue is unavailable.') }
    })
  }

  const choose = (id: string) => {
    const previous = selected
    setSelected(id)
    setOpen(false)
    void selectModel(id).then(outcome => {
      if (outcome.operation === 'selected') setSelected(outcome.selected ?? id)
      else { setSelected(previous); setNote(outcome.reason ?? 'Core refused that model.'); setOpen(true) }
    })
  }

  const toggleFavorite = (id: string) => {
    setFavorites(current => {
      const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id]
      try { window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)) } catch { /* storage is optional */ }
      return next
    })
  }

  const selectedId = selected ?? defaultModel ?? null
  const activeModel = selectedId ? modelName(selectedId) : 'provider default'
  const search = query.trim().toLowerCase()
  const matches = models.filter(entry => search.length === 0
    || modelName(entry.id).toLowerCase().includes(search)
    || entry.id.toLowerCase().includes(search))
  const shown = [...matches.filter(entry => favorites.includes(entry.id)), ...matches.filter(entry => !favorites.includes(entry.id))]

  return (
    <div className="hd-select">
      <button type="button" className="hd-tool hd-tool-model" aria-label="Choose model" aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
        <Glyph name="chip" size={17} /><span>{activeModel}</span><Glyph name="chevron" size={13} />
      </button>
      {open && <div className="hd-menu hd-menu-model" aria-label="Models">
        <label className="hd-search"><Glyph name="search" size={14} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" spellCheck={false} /></label>
        {note ? <p className="hd-menu-note">{note}</p> : null}
        {!note && shown.length === 0 ? <p className="hd-menu-note">{models.length === 0 ? 'No models reported.' : 'No models match.'}</p> : null}
        {shown.map(entry => (
          <div key={entry.id} className="hd-model-row">
            <button type="button" className="hd-fav" aria-pressed={favorites.includes(entry.id)} aria-label={favorites.includes(entry.id) ? `Remove ${modelName(entry.id)} from favorites` : `Add ${modelName(entry.id)} to favorites`} onClick={() => toggleFavorite(entry.id)}>
              <Glyph name="star" size={15} style={favorites.includes(entry.id) ? { fill: 'currentColor' } : undefined} />
            </button>
            <button type="button" className="hd-model-pick" aria-pressed={entry.id === selectedId} onClick={() => choose(entry.id)}>{modelName(entry.id)}</button>
          </div>
        ))}
      </div>}
    </div>
  )
}
