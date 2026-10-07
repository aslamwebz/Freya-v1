import { useEffect, useState } from 'react'
import { readModelCatalog, selectModel } from '../../platform/modelClient'
import { coreMirror, ensureCoreAttached } from '../../platform/coreClient'
import { hostBridge } from '../../platform/host'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import { describeProvider, isProviderId } from '../../../core/capabilities'
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

type ModelEntry = { readonly id: string; readonly ownedBy: string | null; readonly providerId?: string; readonly unavailable?: boolean }
const entryKey = (entry: ModelEntry) => entry.providerId ? `${entry.providerId}:${entry.id}` : entry.id
const providerLabel = (entry: ModelEntry) => isProviderId(entry.providerId) ? describeProvider(entry.providerId) : entry.providerId ?? entry.ownedBy ?? ''

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

/**
 * The provider's configured default, remembered across mounts.
 *
 * The catalogue is a network read and is not fetched while Freya sits idle, so the
 * one fact the chip needs between openings is kept here. It is Core's answer from
 * the last successful read, never a hard-coded name.
 */
let catalogDefault: string | null = null
function setCatalogDefault(id: string | null): void {
  catalogDefault = id
}

export function ModelSelector({ defaultModel }: { defaultModel: string | null }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<readonly ModelEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reportedDefault, setReportedDefault] = useState(catalogDefault)
  const [query, setQuery] = useState('')
  const [favorites, setFavorites] = useState<readonly string[]>(readFavorites)
  const [note, setNote] = useState('')

  /**
   * Status names the current selection without fetching catalogues at startup.
   */
  useEffect(() => {
    let live = true
    const mirror = coreMirror()
    const apply = (status: CoreStatus | null) => {
      // A degraded Core is still operational; a Core that has not started
      // is not. Use the explicit operational flag rather than the
      // aggregate lifecycle so a healthy model selection is still picked
      // up when the journal had to be quarantined.
      if (!live || !status?.operational) return
      if (status.modelSelection) {
        setSelected(status.modelSelection.model)
        setSelectedProvider(status.modelSelection.providerId)
        setReportedDefault(status.modelSelection.defaultModel)
      } else setReportedDefault(status.providers.find(provider => provider.status === 'configured')?.model ?? null)
    }
    const detach = mirror.subscribe(apply)
    void ensureCoreAttached().then(attached => apply(attached.status)).catch(() => {})
    void hostBridge()?.coreStatus().then(apply).catch(() => {})
    return () => { live = false; detach() }
  }, [])
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (!next) return
    setNote('')
    setQuery('')
    setLoading(true)
    void readModelCatalog().then(outcome => {
      if (outcome.operation === 'catalog') {
        if (outcome.models) setModels(outcome.models)
        setSelected(outcome.selected ?? null)
        setSelectedProvider(outcome.selectedProviderId ?? null)
        setNote(outcome.reason ?? '')
        setCatalogDefault(outcome.defaultModel ?? null)
        setReportedDefault(outcome.defaultModel ?? null)
      } else {
        setModels([])
        setNote(outcome.reason ?? 'The model catalogue is unavailable.')
      }
    }).catch(() => setNote('The model catalogue could not be read.')).finally(() => setLoading(false))
  }

  const choose = (entry: ModelEntry) => {
    const previous = selected
    const previousProvider = selectedProvider
    setSelected(entry.id)
    setSelectedProvider(entry.providerId ?? null)
    setOpen(false)
    void selectModel(entry.id, entry.providerId).then(outcome => {
      if (outcome.operation === 'selected') { setSelected(outcome.selected ?? entry.id); setSelectedProvider(outcome.selectedProviderId ?? entry.providerId ?? null) }
      else { setSelected(previous); setSelectedProvider(previousProvider); setNote(outcome.reason ?? 'Core refused that model.'); setOpen(true) }
    }).catch(() => { setSelected(previous); setSelectedProvider(previousProvider); setNote('The model selection could not be saved.'); setOpen(true) })
  }

  const isFavorite = (entry: ModelEntry) => favorites.includes(entryKey(entry)) || favorites.includes(entry.id)
  const toggleFavorite = (entry: ModelEntry) => {
    const id = entryKey(entry)
    setFavorites(current => {
      const next = isFavorite(entry) ? current.filter(value => value !== id && value !== entry.id) : [...current, id]
      try { window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)) } catch { /* storage is optional */ }
      return next
    })
  }

  // What a turn would actually run right now: the owner's selection if there is
  // one, otherwise the provider's own default. Only when Core has told us neither
  // is there genuinely nothing to name.
  const selectedId = selected ?? reportedDefault ?? defaultModel
  const activeModel = selectedId ? modelName(selectedId) : 'no model reported'
  const search = query.trim().toLowerCase()
  const matches = models.filter(entry => search.length === 0
    || modelName(entry.id).toLowerCase().includes(search)
    || entry.id.toLowerCase().includes(search)
    || providerLabel(entry).toLowerCase().includes(search)
    || (entry.ownedBy ?? '').toLowerCase().includes(search))
  // Favorites remain available even when a different provider is being searched.
  const missingFavorites: ModelEntry[] = favorites.filter(key => !models.some(entry => entryKey(entry) === key || entry.id === key)).map(key => {
    const colon = key.indexOf(':')
    const providerId = key.slice(0, colon)
    return colon > 0 && isProviderId(providerId) ? { id: key.slice(colon + 1), providerId, ownedBy: null, unavailable: true } : { id: key, ownedBy: null, unavailable: true }
  })
  const pinned = [...models.filter(isFavorite), ...missingFavorites]
  const shown = [...pinned, ...matches.filter(entry => !isFavorite(entry))]

  return (
    <div className="hd-select">
      <button type="button" className="hd-tool hd-tool-model" aria-label="Choose model" aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
        <Glyph name="chip" size={17} /><span>{activeModel}</span><Glyph name="chevron" size={13} />
      </button>
      {open && <div className="hd-menu hd-menu-model" aria-label="Models">
        <label className="hd-search"><Glyph name="search" size={14} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models or providers" aria-label="Search models" spellCheck={false} /></label>
        {note ? <p className="hd-menu-note">{note}</p> : null}
        {loading && <p className="hd-menu-note" role="status">Loading configured providers…</p>}
        {!note && !loading && shown.length === 0 ? <p className="hd-menu-note">{models.length === 0 ? 'No models reported.' : 'No models match.'}</p> : null}
        {shown.map(entry => (
          <div key={entryKey(entry)} className="hd-model-row">
            <button type="button" className="hd-fav" aria-pressed={isFavorite(entry)} aria-label={isFavorite(entry) ? `Remove ${modelName(entry.id)} (${providerLabel(entry)}) from favorites` : `Add ${modelName(entry.id)} (${providerLabel(entry)}) to favorites`} onClick={() => toggleFavorite(entry)}>
              <Glyph name="star" size={15} style={isFavorite(entry) ? { fill: 'currentColor' } : undefined} />
            </button>
            <button type="button" className="hd-model-pick" disabled={entry.unavailable} title={entry.unavailable ? 'This saved favorite is unavailable in the current provider catalogue.' : undefined} aria-pressed={entry.id === selectedId && (!selectedProvider || entry.providerId === selectedProvider)} onClick={() => choose(entry)}>{modelName(entry.id)} <small>{providerLabel(entry)}{entry.unavailable ? ' · unavailable' : ''}</small></button>
          </div>
        ))}
      </div>}
    </div>
  )
}
