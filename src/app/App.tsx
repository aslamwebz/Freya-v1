import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { type UiAdapter, uiMode } from '../ui-v2/state/contract'
import { useUiState } from '../ui-v2/state/useUiState'
import { type PreferencesStore } from '../ui-v2/theme/preferences'
import { conversationMirror, ensureConversationAttached } from '../platform/conversationClient'
import { hostBridge } from '../platform/host'
import { sendMessage } from '../ui-v2/chat/sendMessage'
import { researchMirror } from '../platform/researchClient'
import { routeEyePrompt, type ComposerMode, type WorkspaceResearchView } from './chat/modes'
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
import type { SettingsCategory } from './screens/Settings'
import { setAppLayout, type AppLayout } from './state/workspace'
import { placeholder } from './screens/Placeholder'
import { DressingTable } from './dressing/DressingTable'
import type { DressingStore } from './dressing/store'
import { useVoiceDock } from './voice/useVoiceDock'
import { VoiceSettings } from './voice/VoiceSettings'
import { BootScreen } from './boot/BootScreen'

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
  const [researchBusy, setResearchBusy] = useState(false)
  const [activeResearchMode, setActiveResearchMode] = useState<Exclude<ComposerMode, 'chat'> | null>(null)
  const [activeEyeSessionId, setActiveEyeSessionId] = useState<string | null>(null)
  const [researchView, setResearchView] = useState<WorkspaceResearchView | null>(null)
  const [voiceTranscriptDraft, setVoiceTranscriptDraft] = useState<{ id: number; text: string } | null>(null)
  const [booted, setBooted] = useState(false)

  const mirror = conversationMirror()
  const research = researchMirror()
  const conversation = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const conversationGenerating = conversation?.activeTurn != null
  const generating = conversationGenerating || researchBusy
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
                      /* Settings is rendered by HomeDashboard as a full overlay,
                         not through the three-column slots. */
                      : placeholder(current.label, current.symbol, 'This screen is next in the build.')

  const send = async (text: string, mode: ComposerMode): Promise<boolean> => {
    if (!text.trim()) return false
    if (!hostBridge()) {
      setNotice('This window cannot reach Freya Core.')
      return false
    }

    setNotice('')
    setScreen('chat')

    if (mode === 'chat') {
      setResearchView(null)
      const result = await sendMessage(mirror, conversation?.activeConversationId ?? null, text)
      setNotice(result.ok ? '' : result.notice)
      return result.ok
    }

    setResearchBusy(true)
    setActiveResearchMode(mode)
    try {
      if (mode === 'deep-research') {
        const outcome = await research.research(text)
        setResearchView({ mode, outcome })
        if (outcome.operation === 'refused') {
          setNotice(outcome.reason ?? 'Deep Research was refused.')
          return false
        }
        return true
      }

      const route = routeEyePrompt(activeEyeSessionId, text)
      let outcome = route.kind === 'create'
        ? await research.createSession(route.text)
        : await research.followUpSession(route.sessionId, route.text)

      if (outcome.operation === 'refused' || !outcome.session) {
        setResearchView({ mode: 'eye', outcome })
        setNotice(outcome.reason ?? "Freya's Eye could not start that search.")
        return false
      }

      setActiveEyeSessionId(outcome.session.sessionId)
      setResearchView({ mode: 'eye', outcome })

      if (outcome.ambiguous) {
        setNotice("Freya's Eye needs a little more context before changing this search.")
        return true
      }

      outcome = await research.collectSession(outcome.session.sessionId)
      setResearchView({ mode: 'eye', outcome })
      if (outcome.operation === 'refused') {
        setNotice(outcome.reason ?? "Freya's Eye could not continue that search.")
        return false
      }
      return true
    } finally {
      setResearchBusy(false)
      setActiveResearchMode(null)
    }
  }

  const stopResponse = () => {
    if (activeTurnId) {
      void mirror.cancelTurn(activeTurnId)
      return
    }
    if (!researchBusy) return
    if (activeResearchMode === 'eye' && activeEyeSessionId) {
      void research.cancelSession(activeEyeSessionId)
      return
    }
    if (activeResearchMode === 'deep-research') {
      void research.statusRead().then((status) => {
        if (status.status?.operationId) void research.cancel(status.status.operationId)
      })
    }
  }
  /**
   * A confirmed transcript goes into the composer, not into a turn.
   *
   * `turnId` is the branch that matters: it is set only when the owner had turned
   * auto-submit on *before* speaking and Core therefore entered the canonical
   * conversation path itself. In that case the words are already in the transcript
   * and putting them in the composer would send them twice — so the composer is
   * left alone and the current Chats workspace is selected instead.
   */
  const onVoiceTranscript = useCallback(
    (text: string, turnId: string | null) => {
      if (turnId !== null) {
        setScreen('chat')
        setNotice('')
        return
      }
      setVoiceTranscriptDraft((current) => ({
        id: (current?.id ?? 0) + 1,
        text,
      }))
    },
    [],
  )

  const voice = useVoiceDock(onVoiceTranscript)

  return <>
    {booted ? null : <BootScreen core={snapshot.core} attached={true} onDone={() => setBooted(true)} />}
    <HomeDashboard
      screen={current.id}
      slots={slots}
      snapshot={snapshot}
      generating={generating}
      notice={notice}
      dressing={dressing}
      preferences={preferences}
      voice={voice.view}
      voiceTranscript={voiceTranscriptDraft}
      settingsCategory={settingsCategory}
      onSettingsCategory={setSettingsCategory}
      onOpenDressing={() => setDressingOpen(true)}
      onSend={send}
      onStopResponse={stopResponse}
      researchView={researchView}
      onNavigate={setScreen}
      onVoicePress={voice.press}
      onVoiceRelease={voice.release}
    />
    <div className="freya-v2" data-theme={settings.theme} data-app-shell="app" data-ui-mode={uiMode(snapshot)}>
      <DressingTable store={dressing} open={dressingOpen} onOpenChange={setDressingOpen} />
      <VoiceSettings voice={voice} />
    </div>
  </>
}
