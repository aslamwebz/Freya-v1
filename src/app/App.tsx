import { useEffect, useState, useSyncExternalStore } from 'react'
import { type UiAdapter, uiMode } from '../ui-v2/state/contract'
import { useUiState } from '../ui-v2/state/useUiState'
import { type PreferencesStore } from '../ui-v2/theme/preferences'
import { conversationMirror, ensureConversationAttached } from '../platform/conversationClient'
import { hostBridge } from '../platform/host'
import { sendMessage } from '../ui-v2/chat/sendMessage'
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
import { Settings, type SettingsCategory } from './screens/Settings'
import { placeholder } from './screens/Placeholder'
import { DressingTable } from './dressing/DressingTable'
import type { DressingStore } from './dressing/store'
import { ChatPanel } from './chat/ChatPanel'

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

export function App({ preferences, dressing, adapter }: { preferences: PreferencesStore; dressing: DressingStore; adapter: UiAdapter }) {
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot)
  const snapshot = useUiState(adapter)

  const [screen, setScreen] = useState('home')
  const [chatOpen, setChatOpen] = useState(false)
  const [dressingOpen, setDressingOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')

  const mirror = conversationMirror()
  const conversation = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const generating = conversation?.activeTurn != null

  useEffect(() => {
    void ensureConversationAttached()
  }, [])

  const current = screen === 'settings' ? { id: 'settings', label: 'Settings', symbol: 'settings' } : RAIL.find((item) => item.id === screen) ?? RAIL[0]!
  /**
   * The selected Settings category lives here rather than in the screen.
   *
   * `App.tsx` calls every screen as a plain function, so a `useState` inside one
   * would run outside a component render and React would reject it. Lifting the one
   * piece of shared state to the component that owns the board keeps the screen a
   * pure function of its props — and keeps the rail's active row and the rendered
   * cards reading the same value rather than two that drift.
   */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('appearance')

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
                        ? Settings({ snapshot, preferences, category: settingsCategory, onCategory: setSettingsCategory })
                        : placeholder(current.label, current.symbol, 'This screen is next in the build.')

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
    {/* One persistent board for every tab: the rail, header and composer mount
        once and never unmount. Only the main region swaps — Home's panels, or the
        active screen's slots — so switching tabs is fluid and the chrome is still. */}
    <HomeDashboard screen={current.id} slots={slots} snapshot={snapshot} draft={draft} generating={generating} notice={notice}
      dressing={dressing} onOpenDressing={() => setDressingOpen(true)}
      onDraft={setDraft} onSend={send} onNavigate={setScreen} />
    {/*
      `data-app-shell` and `data-ui-mode` are read by the desktop E2E suite, and they
      are worth having for the same reason the shell labels itself honestly in the UI:
      a window must be able to be told apart from a design preview by something other
      than somebody's recollection.

      `uiMode` is the contract's own provenance read — it is `preview` only when
      *every* resource is a preview fixture, and the moment any resource is a live
      projection it reads `live`. So this attribute cannot claim `preview` while real
      data is on screen, and cannot claim `live` while fixtures are. Deriving it from
      the snapshot rather than setting it by hand is the whole point; a hardcoded
      `data-ui-mode="live"` would be exactly the kind of assertion this codebase
      refuses to make.
    */}
    <div className="freya-v2" data-theme={settings.theme} data-app-shell="app" data-ui-mode={uiMode(snapshot)}>
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
      <DressingTable store={dressing} open={dressingOpen} onOpenChange={setDressingOpen} />
    </div>
  </>
}
