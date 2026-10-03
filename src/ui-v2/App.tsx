import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { uiMode, type UiAdapter } from './state/contract'
import { useUiState } from './state/useUiState'
import { type PreferencesStore, THEMES, type Preferences } from './theme/preferences'
import type { WindowsStore } from './windows/model'
import { WindowLayer } from './windows/WindowLayer'
import { WORKSPACES, workspaceLabel, type WorkspaceId } from './workspaces/catalog'
import { Workspace } from './workspaces/Workspace'
import { createViews, type ViewState } from './workspaces/viewState'
import { Button, Field } from './primitives/Controls'
import { Clock } from './primitives/Clock'
import { Glyph } from './primitives/Glyph'

export function App({ preferences, windows, adapter }: { preferences: PreferencesStore; windows: WindowsStore; adapter: UiAdapter }) {
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot)
  const windowState = useSyncExternalStore(windows.subscribe, windows.getSnapshot, windows.getSnapshot)
  const snapshot = useUiState(adapter)
  /**
   * What this window is actually showing, read off the snapshot rather than assumed.
   *
   * The label used to be hardcoded, which meant a live window would have announced
   * itself as sample data — the one claim a person cannot afford to misread. Provenance
   * is read off every resource through `uiMode`, so a live window never announces
   * itself as a design preview.
   *
   * The live label is deliberately *not* "projected from Freya Core" for the whole
   * shell: several workspaces are not wired to a live Core yet, and each of those
   * declares its own pending state. The shell only claims the mode it is in.
   */
  const preview = uiMode(snapshot) === 'preview'
  const [selected, select] = useState<WorkspaceId>('home')
  const current = settings.mode === 'immersive' ? windowState.active ?? selected : selected
  const [views, setViews] = useState(createViews)
  const [customizing, customize] = useState(false)
  const customizePanel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!customizing) return
    const previous = document.activeElement as HTMLElement | null
    customizePanel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus()
  }, [customizing])
  const [draft, setDraft] = useState('')
  const [intent, setIntent] = useState('Think')
  const [notice, setNotice] = useState('')
  const updateView = (id: WorkspaceId, patch: Partial<ViewState>) => setViews((current) => ({ ...current, [id]: { ...current[id], ...patch } }))
  const open = (id: WorkspaceId) => { select(id); if (settings.mode === 'immersive') windows.open(id) }
  const openWidget = (id: WorkspaceId) => { select(id); preferences.update({ mode: 'immersive' }); windows.open(id) }
  const mode = (value: Preferences['mode']) => { if (value === 'app') select(current); preferences.update({ mode: value }); if (value === 'immersive') windows.open(current) }
  const render = (id: WorkspaceId) => <Workspace id={id} snapshot={snapshot} view={views[id]} update={(patch) => updateView(id, patch)} open={openWidget} panels={settings.homePanels} />
  const meta = WORKSPACES.find((space) => space.id === current)!
  return <div className="freya-v2" data-theme={settings.theme} data-density={settings.density}
    data-text-scale={settings.textScale} data-workspace={current} data-mode={settings.mode} data-backdrop={settings.backdrop} data-effects={settings.reducedEffects ? 'reduced' : 'full'}
    style={{ fontSize: `${14 * settings.textScale}px` }} onKeyDown={(event) => { if (event.key === 'Escape') customize(false) }}>
    <a className="f-skip" href="#freya-main">Skip to workspace</a>
    <div className="f-atmosphere" aria-hidden="true"><span className="f-horizon" /><span className="f-stars" /></div>
    <aside className="f-sidebar">
      <a className="f-logo" href="#freya-main" aria-label="Freya Home" onClick={() => open('home')}><span className="f-orbit-mark" aria-hidden="true" /></a>
      <nav aria-label="Freya workspaces">{WORKSPACES.map((space) => <Button key={space.id} className="f-nav-item"
        aria-label={space.label} title={space.label} aria-current={current === space.id ? 'page' : undefined} onClick={() => open(space.id)}>
        <Glyph name={space.symbol} /><span>{space.label}</span></Button>)}</nav>
      <Button className="f-customize-button" aria-label="Customize" onClick={() => customize(!customizing)} aria-expanded={customizing}><Glyph name="settings" /><span>Customize</span></Button>
      <div className="f-sidebar-foot"><span className="f-preview-dot" /><b>{preview ? 'Design preview' : 'Live'}</b><small>{preview ? 'Phase 19 · UI foundation' : 'Phase 19.1 · Live desktop'}</small></div>
    </aside>
    <div className="f-main">
      <header className="f-top">
        <div className="f-wordmark"><b>FREYA</b><span>Phase 19</span><small>A persistent intelligence for a brighter tomorrow</small>
          <span className="f-preview-label">{preview ? 'Design preview · Sample data' : 'Live'}</span></div>
        <div className="f-mode-controls" aria-label="Workspace mode"><Button aria-label="App mode" aria-pressed={settings.mode === 'app'} onClick={() => mode('app')}>App</Button>
          <Button aria-label="Immersive mode" aria-pressed={settings.mode === 'immersive'} onClick={() => mode('immersive')}>Immersive</Button></div>
        <div className="f-top-right"><div className="f-manifesto"><blockquote>“More clarity.<br />A kinder, smarter tomorrow.”</blockquote><small>PERSISTENT · EVOLVING · ALIGNED</small></div>
          <Clock /></div>
      </header>
      <div className="f-section-heading"><div><p className="f-eyebrow">Same mind. A brighter tomorrow.</p><h1>{workspaceLabel(current)}</h1><p>{meta.description}</p></div>
        </div>
      <main id="freya-main" tabIndex={-1} className="f-content">{settings.mode === 'app' ? <div className="f-app-workspace">{render(current)}</div> : <WindowLayer store={windows} render={render} />}</main>
      {settings.mode === 'immersive' && <div className="f-window-switcher" aria-label="Open windows">{windowState.windows.map((window) => <Button key={window.id}
        aria-label={`Restore ${workspaceLabel(window.id)} window`} aria-pressed={windowState.active === window.id && !window.minimized}
        onClick={() => { windows.focus(window.id); select(window.id) }}>{window.pinned && <span aria-hidden="true">⌖</span>}{workspaceLabel(window.id)}{window.minimized && <small>Minimized</small>}</Button>)}</div>}
      <footer className="f-dock"><form aria-label="Freya composer" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) setNotice(preview ? 'Preview only. Your message has not been sent.' : 'The composer is not connected yet. Nothing has been sent.') }}>
        <Button className="f-voice" disabled aria-label="Voice unavailable in design preview" title="No microphone is accessed"><Glyph name="mic" size={24} /></Button>
        <Field label="Ask Freya" placeholder={intent === 'Create' ? 'An idea worth exploring…' : 'Ask Freya…'} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div className="f-intents">{['Think', 'Plan', 'Create', 'Search'].map((value) => <Button key={value} aria-pressed={intent === value} onClick={() => setIntent(value)}>{value}</Button>)}</div>
        <Button type="submit" variant="primary" disabled={!draft.trim()} aria-label="Try composer preview"><Glyph name="arrow" /></Button>
      </form>{notice && <p role="status" className="f-composer-status">{notice}</p>}</footer>
    </div>
    {customizing && <aside ref={customizePanel} className="f-customization" role="dialog" aria-label="Customize workspace">
      <header><div><p className="f-eyebrow">Make it yours</p><h2>Customize</h2></div><Button aria-label="Close customization" onClick={() => customize(false)}>×</Button></header>
      <label>Theme<select aria-label="Theme" className="f-select" value={settings.theme} onChange={(event) => preferences.update({ theme: event.target.value as Preferences['theme'] })}>
        {THEMES.map((theme) => <option value={theme} key={theme}>{theme[0]?.toUpperCase()}{theme.slice(1)}</option>)}</select></label>
      <label>Density<select aria-label="Density" className="f-select" value={settings.density} onChange={(event) => preferences.update({ density: event.target.value as Preferences['density'] })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
      <label>Text size<select aria-label="Text size" className="f-select" value={settings.textScale} onChange={(event) => preferences.update({ textScale: Number(event.target.value) as Preferences['textScale'] })}><option value={1}>100%</option><option value={1.125}>112.5%</option><option value={1.25}>125%</option></select></label>
      <label>Background<select aria-label="Background" className="f-select" value={settings.backdrop} onChange={(event) => preferences.update({ backdrop: event.target.value as Preferences['backdrop'] })}><option value="cosmos">Cosmos</option><option value="quiet">Quiet glow</option><option value="solid">Solid</option></select></label>
      <label className="f-check"><input type="checkbox" checked={settings.reducedEffects} onChange={(event) => preferences.update({ reducedEffects: event.target.checked })} />Reduce visual effects</label>
      <fieldset><legend>Home panels</legend>{['focus', 'mission', 'attention', 'people', 'world', 'memory', 'workforce'].map((panel) => <label key={panel} className="f-check"><input type="checkbox" checked={views.home.panelOrder.includes(panel)}
        onChange={(event) => updateView('home', { panelOrder: event.target.checked ? [...views.home.panelOrder, panel] : views.home.panelOrder.filter((id) => id !== panel) })} />{panel[0]?.toUpperCase()}{panel.slice(1)}</label>)}</fieldset>
      <Button onClick={() => { preferences.reset(); updateView('home', { panelOrder: ['focus', 'mission', 'attention', 'people', 'world', 'memory', 'workforce'] }) }}>Reset appearance</Button><Button onClick={() => windows.reset()}>Reset window layout</Button>
      <p className="f-muted">Appearance and window positions are saved locally. Preview conversation drafts stay in memory.</p>
    </aside>}
  </div>
}
