import { useEffect, useState, useSyncExternalStore } from 'react'
import { type UiAdapter } from '../ui-v2/state/contract'
import { useUiState } from '../ui-v2/state/useUiState'
import { THEMES, type PreferencesStore } from '../ui-v2/theme/preferences'
import { Button, Field } from '../ui-v2/primitives/Controls'
import { Clock } from '../ui-v2/primitives/Clock'
import { Glyph } from '../ui-v2/primitives/Glyph'
import { conversationMirror, ensureConversationAttached } from '../platform/conversationClient'
import { hostBridge } from '../platform/host'
import { sendMessage } from '../ui-v2/chat/sendMessage'
import { Brain } from './presence/Brain'
import { brainState } from './presence/state'
import type { ScreenSlots } from './screens/Home'
import { HomeDashboard } from './screens/HomeDashboard'
import { Mind } from './screens/Mind'
import { World } from './screens/World'
import { Life } from './screens/Life'
import { Workforce } from './screens/Workforce'
import { Foundry } from './screens/Foundry'
import { Relay } from './screens/Relay'
import { Focus } from './screens/Focus'
import { People } from './screens/People'
import { Memory } from './screens/Memory'
import { Settings } from './screens/Settings'
import { placeholder } from './screens/Placeholder'
import { DressingTable } from './dressing/DressingTable'
import type { DressingStore } from './dressing/store'
import { ChatPanel } from './chat/ChatPanel'
import portrait from '../ui-v2/assets/freya-portrait.webp'

/**
 * Freya App Mode — the shell.
 *
 * One continuous shell around one continuous centre. The rail switches which
 * cards surround the centre; it never replaces the centre. The command bar is
 * global: every screen sends to the same conversation.
 *
 * The centre (the Brain) is deliberately its own component in its own layer, so
 * a layout change — folding the rail, opening a panel — can never move it.
 */

interface RailItem {
  readonly id: string
  readonly label: string
  readonly symbol: string
}

/** The rail, from the v2 renders: one list, the current domain highlighted. */
const RAIL: readonly RailItem[] = [
  { id: 'home', label: 'Home', symbol: 'home' },
  { id: 'mind', label: 'Mind', symbol: 'mind' },
  { id: 'focus', label: 'Focus', symbol: 'focus' },
  { id: 'people', label: 'People', symbol: 'people' },
  { id: 'workforce', label: 'Workforce', symbol: 'workforce' },
  { id: 'world', label: 'World', symbol: 'world' },
  { id: 'memory', label: 'Memory', symbol: 'memory' },
  { id: 'life', label: 'Life', symbol: 'life' },
  { id: 'create', label: 'Foundry', symbol: 'forge' },
  { id: 'relay', label: 'Relay', symbol: 'relay' },
]

/** The arc labels around the centre differ per screen, as the renders show. */
const ARC_LABELS: Record<string, readonly [string, string, string, string, string]> = {
  home: ['UNDERSTAND', 'PLAN', 'CREATE', 'REMEMBER', 'ACT'],
  mind: ['LISTEN', 'UNDERSTAND', 'SYNTHESIZE', 'REMEMBER', 'GUIDE'],
}
const DEFAULT_ARC = ['UNDERSTAND', 'PLAN', 'CREATE', 'REMEMBER', 'ACT'] as const

export function App({ preferences, dressing, adapter }: { preferences: PreferencesStore; dressing: DressingStore; adapter: UiAdapter }) {
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot)
  const design = useSyncExternalStore(dressing.subscribe, dressing.getSnapshot, dressing.getSnapshot)
  const snapshot = useUiState(adapter)

  const [screen, setScreen] = useState('home')
  const [collapsed, setCollapsed] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [dressingOpen, setDressingOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [intent, setIntent] = useState('Think')
  const [notice, setNotice] = useState('')

  const mirror = conversationMirror()
  const conversation = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const generating = conversation?.activeTurn != null

  useEffect(() => {
    void ensureConversationAttached()
  }, [])

  const current = screen === 'settings' ? { id: 'settings', label: 'Settings', symbol: 'settings' } : RAIL.find((item) => item.id === screen) ?? RAIL[0]!
  const arc = ARC_LABELS[current.id] ?? DEFAULT_ARC
  const core = snapshot.core.status === 'ready' || snapshot.core.status === 'stale' ? snapshot.core.data : null
  const workforce = snapshot.workforce.status === 'ready' || snapshot.workforce.status === 'stale' ? snapshot.workforce.data : null
  const cognition = brainState({
    activeRequests: core?.activeRequests ?? 0,
    working: workforce?.working ?? 0,
    faultCount: core?.faultCount ?? 0,
    lifecycle: core?.lifecycle ?? 'booting',
  })
  const themeIndex = THEMES.indexOf(settings.theme)
  const slots: ScreenSlots = current.id === 'home'
    ? { left: null, right: null, bottom: null }
    : current.id === 'mind'
      ? Mind()
      : current.id === 'world'
        ? World()
        : current.id === 'life'
          ? Life()
          : current.id === 'workforce'
            ? Workforce()
            : current.id === 'create'
              ? Foundry()
              : current.id === 'relay'
                ? Relay()
                : current.id === 'focus'
                  ? Focus()
                  : current.id === 'people'
                    ? People()
                    : current.id === 'memory'
                      ? Memory()
                      : current.id === 'settings'
                        ? Settings()
                        : placeholder(current.label, current.symbol, 'This screen is next in the build.')
  const cycleTheme = () => preferences.update({ theme: THEMES[(themeIndex + 1) % THEMES.length]! })

  const send = () => {
    const text = draft
    if (!text.trim()) return
    if (!hostBridge()) {
      setNotice('This window cannot reach Freya Core.')
      return
    }
    setDraft('')
    setNotice('')
    setChatOpen(true)
    void sendMessage(mirror, conversation?.activeConversationId ?? null, text).then((result) => {
      setNotice(result.ok ? '' : result.notice)
    })
  }


  return <>
    {screen === 'home' ? (
      <HomeDashboard snapshot={snapshot} draft={draft} generating={generating} notice={notice}
        dressing={dressing} onOpenDressing={() => setDressingOpen(true)}
        onDraft={setDraft} onSend={send} onNavigate={setScreen} onChat={() => setChatOpen(true)} />
    ) : (
    <div className="freya-v2 freya-app" data-theme={settings.theme} data-background={design.background} data-rail={collapsed ? 'collapsed' : 'expanded'} data-screen={current.id}>
      <div className="a-bg" aria-hidden="true" />
      <div className="a-atmos" aria-hidden="true"><span className="a-stars" /></div>

      <aside className="a-rail">
        <Button className="a-rail-toggle" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed} onClick={() => setCollapsed((value) => !value)}>
          <Glyph name="arrow" size={16} style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }} />
        </Button>
        <nav aria-label="Freya">
          {RAIL.map((item) => (
            <Button key={item.id} className="a-rail-item" aria-label={item.label} aria-current={current.id === item.id ? 'page' : undefined} onClick={() => setScreen(item.id)}>
              <Glyph name={item.symbol} /><span>{item.label}</span>
            </Button>
          ))}
        </nav>
        <div className="a-rail-foot">
          <div className="a-online"><span className="a-dot" /><b>Freya Online</b><small>Phase 19 · Build 19.0.1</small></div>
          <Button className="a-user" aria-label="Open Settings" onClick={() => setScreen('settings')}>
            <span className="a-user-avatar">A</span><span className="a-user-name">Aslam</span><Glyph name="settings" size={17} />
          </Button>
        </div>
      </aside>

      <header className="a-head">
        <div className="a-head-left">
          <a className="a-mark" href="#a-main" aria-label="Freya Home" onClick={() => setScreen('home')}><span className="a-orbit" aria-hidden="true" /></a>
          <div className="a-brand"><b>FREYA</b><span>PHASE 19</span></div>
          <button className="a-look" type="button" aria-label="Dressing table" aria-haspopup="dialog" onClick={() => setDressingOpen(true)}><Glyph name="dress" size={16} /></button>
        </div>
        <div className="a-head-right">
          <Clock />
          <Button className="a-theme" aria-label="Change theme" onClick={cycleTheme}><Glyph name="settings" /></Button>
          <Button className="a-theme" aria-label="Chat" onClick={() => setChatOpen(true)}><Glyph name="chat" /></Button>
          <div className="a-win" role="group" aria-label="Window">
            <Button className="a-win-btn" aria-label="Minimize" onClick={() => void hostBridge()?.windowMinimize()}><Glyph name="win-min" size={16} /></Button>
            <Button className="a-win-btn" aria-label="Maximize" onClick={() => void hostBridge()?.windowMaximize()}><Glyph name="win-max" size={16} /></Button>
            <Button className="a-win-btn a-win-close" aria-label="Close" onClick={() => void hostBridge()?.windowClose()}><Glyph name="win-close" size={16} /></Button>
          </div>
        </div>
      </header>

      <main id="a-main" tabIndex={-1} className={current.id === 'home' ? 'a-body a-home-body' : 'a-body'} data-layout={slots.layout === 'wide' ? 'wide' : 'standard'}>

          <>
            {slots.layout === 'wide' ? null : <section className="a-col a-col-left" aria-label="Left panels">{slots.left}</section>}
            <section className="a-centre" aria-label="Freya centre">
              {slots.centre ?? (
                <div className="a-centre-stage" data-screen={current.id}>
                  <Brain state={cognition} motif={design.centre} variant={design.style} rings={design.rings === 'on'} />
                  <div className="a-centre-labels" aria-hidden="true">
                    <span className="a-cl a-cl-top">{arc[0]}</span>
                    <span className="a-cl a-cl-left">{arc[1]}</span>
                    <span className="a-cl a-cl-right">{arc[2]}</span>
                    <span className="a-cl a-cl-bl">{arc[3]}</span>
                    <span className="a-cl a-cl-br">{arc[4]}</span>
                  </div>
                </div>
              )}
            </section>
            {slots.layout === 'wide' ? null : <section className="a-col a-col-right" aria-label="Right panels">{slots.right}</section>}
            {slots.bottom ? <section className="a-bottom" aria-label="Lower panels">{slots.bottom}</section> : null}
          </>
      </main>

      <div className="a-screen-title" aria-hidden="true"><Glyph name={current.symbol} /><b>{current.label}</b></div>

      <footer className="a-cmd">
        <form aria-label="Freya composer" onSubmit={(event) => { event.preventDefault(); send() }}>
          <span className="a-composer-brain" aria-hidden="true"><Glyph name="mind" size={22} /></span>
          <Field label="Ask Freya" placeholder={generating ? 'Freya is answering…' : 'Ask Freya…'} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="a-composer-tools">
            <Button className="a-attach" aria-label="Attach"><Glyph name="plus" size={18} /></Button>
            <select className="a-model-select" aria-label="Model" defaultValue="auto">
              <option value="auto">Auto</option>
              <option value="favorite">Favorite</option>
            </select>
            <select className="a-think-select" aria-label="Thinking level" value={intent} onChange={(event) => setIntent(event.target.value)}>
              <option value="Think">Think</option>
              <option value="Deep">Deep</option>
              <option value="Fast">Fast</option>
            </select>
          </div>
          <Button type="submit" className="a-send" variant="primary" disabled={!draft.trim() || generating} aria-label="Send message">
            {generating ? <span className="a-send-loader" aria-hidden="true" /> : <Glyph name="arrow" />}
          </Button>
        </form>
        {generating && <p role="status" className="a-cmd-status">Freya is thinking…</p>}
        {notice && <p role="status" className="a-cmd-status">{notice}</p>}
      </footer>
      {current.id !== 'home' && design.form !== 'brain' ? (
        <div className="a-side-presence" aria-label={`Freya ${design.form} presence`}>
          <img src={portrait} alt={`Freya ${design.form} — placeholder`} />
          <span>{design.form}</span>
        </div>
      ) : null}
    </div>
    )}
    <div className="freya-v2" data-theme={settings.theme}>
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      <DressingTable store={dressing} open={dressingOpen} onOpenChange={setDressingOpen} />
    </div>
  </>
}
