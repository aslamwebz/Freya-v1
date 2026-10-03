import { useEffect, useState, useSyncExternalStore } from 'react'
import { uiMode, type UiAdapter } from '../ui-v2/state/contract'
import { useUiState } from '../ui-v2/state/useUiState'
import { THEMES, type PreferencesStore } from '../ui-v2/theme/preferences'
import { Button, Field } from '../ui-v2/primitives/Controls'
import { Clock } from '../ui-v2/primitives/Clock'
import { Glyph } from '../ui-v2/primitives/Glyph'
import { conversationMirror, ensureConversationAttached } from '../platform/conversationClient'
import { sendMessage } from '../ui-v2/chat/sendMessage'
import { Brain } from './presence/Brain'
import { brainState } from './presence/state'
import { Home, type ScreenSlots } from './screens/Home'
import { placeholder } from './screens/Placeholder'

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
  { id: 'create', label: 'Create', symbol: 'create' },
  { id: 'relay', label: 'Relay', symbol: 'relay' },
  { id: 'settings', label: 'Settings', symbol: 'settings' },
]

/** The rotating line in the header, as the renders show. */
const QUOTES = [
  ['More clarity.', 'A kinder, smarter tomorrow.'],
  ['Clarity today,', 'a kinder tomorrow.'],
  ['A more connected world', 'creates a kinder tomorrow.'],
  ['A record not just of what I do,', 'but who I\u2019m becoming.'],
  ['From possibility', 'to capability.'],
] as const

export function App({ preferences, adapter }: { preferences: PreferencesStore; adapter: UiAdapter }) {
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot)
  const snapshot = useUiState(adapter)
  const preview = uiMode(snapshot) === 'preview'

  const [screen, setScreen] = useState('home')
  const [quote, setQuote] = useState(0)
  const [draft, setDraft] = useState('')
  const [intent, setIntent] = useState('Think')
  const [notice, setNotice] = useState('')

  const mirror = conversationMirror()
  const conversation = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const generating = conversation?.activeTurn != null

  useEffect(() => {
    if (!preview) void ensureConversationAttached()
  }, [preview])

  useEffect(() => {
    const timer = window.setInterval(() => setQuote((value) => (value + 1) % QUOTES.length), 9000)
    return () => window.clearInterval(timer)
  }, [])

  const current = RAIL.find((item) => item.id === screen) ?? RAIL[0]!
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
    ? Home({ snapshot })
    : placeholder(current.label, current.symbol, 'This screen is next in the build.')
  const cycleTheme = () => preferences.update({ theme: THEMES[(themeIndex + 1) % THEMES.length]! })

  const send = () => {
    const text = draft
    if (!text.trim()) return
    if (preview) {
      setNotice('Preview only. Your message has not been sent.')
      return
    }
    setDraft('')
    setNotice('')
    void sendMessage(mirror, conversation?.activeConversationId ?? null, text).then((result) => {
      setNotice(result.ok ? '' : result.notice)
    })
  }

  return (
    <div className="freya-v2 freya-app" data-theme={settings.theme} data-screen={current.id}>
      <div className="a-bg" aria-hidden="true" />
      <div className="a-atmos" aria-hidden="true"><span className="a-stars" /></div>

      <aside className="a-rail">
        <a className="a-mark" href="#a-main" aria-label="Freya Home" onClick={() => setScreen('home')}>
          <span className="a-orbit" aria-hidden="true" />
        </a>
        <nav aria-label="Freya">
          {RAIL.map((item) => (
            <Button key={item.id} className="a-rail-item" aria-label={item.label} aria-current={current.id === item.id ? 'page' : undefined} onClick={() => setScreen(item.id)}>
              <Glyph name={item.symbol} /><span>{item.label}</span>
            </Button>
          ))}
        </nav>
        <div className="a-online"><span className="a-dot" /><b>Freya Online</b><small>Phase 19 · Build 19.0.1</small></div>
      </aside>

      <header className="a-head">
        <div className="a-brand"><b>FREYA</b><i>|</i><span>PHASE 19</span>
          <small>A persistent intelligence for a brighter tomorrow</small></div>
        <div className="a-head-right">
          <blockquote><span>{QUOTES[quote]![0]}</span><em>{QUOTES[quote]![1]}</em></blockquote>
          <Clock />
          <Button className="a-theme" aria-label="Change theme" onClick={cycleTheme}><Glyph name="settings" /></Button>
        </div>
      </header>

      <div className="a-ticker" aria-hidden="true"><span>PERSISTENT</span><span>·</span><span>EVOLVING</span><span>·</span><span>ALIGNED</span><span>·</span><span>FOR A BRIGHTER TOMORROW</span></div>

      <main id="a-main" tabIndex={-1} className="a-body">
        <section className="a-col a-col-left" aria-label="Left panels">{slots.left}</section>
        <section className="a-centre" aria-label="Freya centre">
          {/* The Brain: the one constant of every screen. */}
          <div className="a-centre-stage" data-screen={current.id}>
            <Brain state={cognition} />
          </div>
          <div className="a-centre-caption"><b>FREYA</b><span>PHASE 19</span><small>SAME MIND. A BRIGHTER TOMORROW.</small></div>
        </section>
        <section className="a-col a-col-right" aria-label="Right panels">{slots.right}</section>
        {slots.bottom ? <section className="a-bottom" aria-label="Lower panels">{slots.bottom}</section> : null}
      </main>

      <div className="a-screen-title" aria-hidden="true"><Glyph name={current.symbol} /><b>{current.label}</b></div>

      <footer className="a-cmd">
        <form aria-label="Freya composer" onSubmit={(event) => { event.preventDefault(); send() }}>
          <Button className="a-voice" disabled aria-label="Voice unavailable" title="No microphone is accessed"><Glyph name="mic" size={24} /></Button>
          <Field label="Ask Freya" placeholder={generating ? 'Freya is answering…' : intent === 'Create' ? 'Ask Freya to build something…' : 'Ask Freya…'} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="a-intents">{['Think', 'Plan', 'Create', 'Search'].map((value) => <Button key={value} aria-pressed={intent === value} onClick={() => setIntent(value)}>{value}</Button>)}</div>
          <Button type="submit" variant="primary" disabled={!draft.trim() || generating} aria-label="Send message"><Glyph name="arrow" /></Button>
        </form>
        {generating && <p role="status" className="a-cmd-status">Freya is thinking…</p>}
        {notice && <p role="status" className="a-cmd-status">{notice}</p>}
      </footer>
    </div>
  )
}
