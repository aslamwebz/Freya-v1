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
import { setAppLayout, type AppLayout } from './state/workspace'
import { placeholder } from './screens/Placeholder'
import { DressingTable } from './dressing/DressingTable'
import type { DressingStore } from './dressing/store'

interface RailItem {
  readonly id: string
  readonly label: string
  readonly symbol: string
}

const RAIL: readonly RailItem[] = [
  { id: 'home', label: 'Home', symbol: 'home' },
  { id: 'chat', label: 'Chats', symbol: 'chat' },
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

export function App({
  preferences,
  dressing,
  adapter,
  initialLayout,
}: {
  preferences: PreferencesStore
  dressing: DressingStore
  adapter: UiAdapter
  initialLayout?: AppLayout | null
}) {
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot)
  const snapshot = useUiState(adapter)

  // Restore the last workspace before first paint, but keep Home as the safe
  // default when the persisted route is missing or invalid.
  const restoredNav = initialLayout?.nav && (initialLayout.nav === 'settings' || RAIL.some((item) => item.id === initialLayout.nav))
    ? initialLayout.nav
    : 'home'
  const [screen, setScreen] = useState(restoredNav)
  const [dressingOpen, setDressingOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('appearance')

  const mirror = conversationMirror()
  const conversation = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const generating = conversation?.activeTurn != null
  const activeTurnId = conversation?.activeTurn?.turnId ?? null

  useEffect(() => {
    setAppLayout({
      nav: screen,
      navCollapsed: false,
      conversationId: conversation?.activeConversationId ?? null,
    })
  }, [screen, conversation?.activeConversationId])

  useEffect(() => {
    void ensureConversationAttached()
  }, [])

  const current = screen === 'settings'
    ? { id: 'settings', label: 'Settings', symbol: 'settings' }
    : RAIL.find((item) => item.id === screen) ?? RAIL[0]!

  const slots: ScreenSlots = current.id === 'home' || current.id === 'chat'
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
                        ? Settings({
                            snapshot,
                            preferences,
                            category: settingsCategory,
                            onCategory: setSettingsCategory,
                          })
                        : placeholder(current.label, current.symbol, 'This screen is next in the build.')

  const send = async (text: string): Promise<boolean> => {
    if (!text.trim()) return false
    if (!hostBridge()) {
      setNotice('This window cannot reach Freya Core.')
      return false
    }

    setNotice('')
    setScreen('chat')
    const result = await sendMessage(mirror, conversation?.activeConversationId ?? null, text)
    setNotice(result.ok ? '' : result.notice)
    return result.ok
  }

  const stopResponse = () => {
    if (activeTurnId) void mirror.cancelTurn(activeTurnId)
  }

  return <>
    <HomeDashboard
      screen={current.id}
      slots={slots}
      snapshot={snapshot}
      generating={generating}
      notice={notice}
      dressing={dressing}
      onOpenDressing={() => setDressingOpen(true)}
      onSend={send}
      onStopResponse={stopResponse}
      onNavigate={setScreen}
    />
    <div className="freya-v2" data-theme={settings.theme} data-app-shell="app" data-ui-mode={uiMode(snapshot)}>
      <DressingTable store={dressing} open={dressingOpen} onOpenChange={setDressingOpen} />
    </div>
  </>
}
