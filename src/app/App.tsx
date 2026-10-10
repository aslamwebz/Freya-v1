import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { type UiAdapter, uiMode } from '../ui-v2/state/contract'
import { useUiState } from '../ui-v2/state/useUiState'
import { type PreferencesStore } from '../ui-v2/theme/preferences'
import { conversationMirror, ensureConversationAttached } from '../platform/conversationClient'
import { hostBridge } from '../platform/host'
import { sendMessage } from '../ui-v2/chat/sendMessage'
import { researchMirror } from '../platform/researchClient'
import { routeEyePrompt, type ComposerMode, type WorkspaceResearchView } from './chat/modes'
import { routeChatIntent, routePromptIntent } from './chat/intent'
import {
  attachmentTray,
  collectModelAttachments,
  composeWithAttachments,
} from './chat/attachments'
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
import { setAppLayout, startupAppLayout, type AppLayout } from './state/workspace'
import { DressingTable } from './dressing/DressingTable'
import type { DressingStore } from './dressing/store'
import { useVoiceDock } from './voice/useVoiceDock'
import { openUrlInDockedBrowser, sharedDockedBrowserStore, type DockedTabOrigin } from './chat/BrowserWorkspace'

import { BootScreen } from './boot/BootScreen'

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

  // Every cold start lands on the Dashboard. Workspace persistence still keeps
  // conversation/window state for when the owner deliberately opens those surfaces,
  // but it must not turn yesterday's Chat route into today's launch screen.
  const [screen, setScreen] = useState(() => startupAppLayout(initialLayout).nav)
  const [dressingOpen, setDressingOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeConversationId, setNoticeConversationId] = useState<string | null>(null)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('appearance')
  const [researchBusy, setResearchBusy] = useState(false)
  const [activeResearchMode, setActiveResearchMode] = useState<Exclude<ComposerMode, 'chat'> | null>(null)
  const [activeEyeSessionId, setActiveEyeSessionId] = useState<string | null>(null)
  const [researchView, setResearchView] = useState<WorkspaceResearchView | null>(null)
  const [voiceTranscriptDraft, setVoiceTranscriptDraft] = useState<{ id: number; text: string } | null>(null)
  const [booted, setBooted] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserRequestedUrl, setBrowserRequestedUrl] = useState<string | null>(null)
  /*
   * The chat/browser split lives here rather than inside the chat workspace
   * because two things have to agree on it: the workspace's own columns and the
   * global composer, which sits over the conversation column so the input never
   * straddles the divider. One number, one source.
   */
  // Give the browser room for real tabs without ever replacing the conversation.
  const [browserPercent, setBrowserPercent] = useState(62)
  useEffect(() => {
    const store = sharedDockedBrowserStore()
    let count = store.getSnapshot().tabs.length
    return store.subscribe((next) => {
      if (next.tabs.length > count) { setScreen('chat'); setBrowserOpen(true) }
      count = next.tabs.length
    })
  }, [])

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

  const slotsByScreen: Readonly<Record<string, ScreenSlots>> = {
    mind: Mind({ snapshot }),
    world: World(),
    life: Life(),
    workforce: Workforce(),
    create: Foundry(),
    relay: Relay(),
    focus: Focus(),
    people: People(),
    memory: Memory(),
  }

  const send = async (
    text: string,
    mode: ComposerMode,
    hints?: { readonly webSearch?: boolean; readonly browserUse?: boolean },
    selectedConversationId?: string | null,
  ): Promise<boolean> => {
    setNoticeConversationId(null)
    if (!text.trim()) return false
    if (!hostBridge()) {
      setNotice('This window cannot reach Freya Core.')
      return false
    }
    // The renderer's hint fields travel as structured metadata only. The text
    // we received is the text the owner typed — never mutated, never prefixed.
    // A button that changed the text would be the contamination class this whole
    // seam exists to prevent, and a bug report is the friendliest of the
    // responses it gets if it tries.
    const intents = {
      ...(hints?.webSearch === true ? { webSearch: true } : {}),
      ...(hints?.browserUse === true ? { browserUse: true } : {}),
    }

    // File bytes travel as bounded attachment parts through the canonical turn.
    // Plain text files are included as untrusted reference text; PDF/image bytes
    // never become pasted contents or base64 in the message.
    const drafts = attachmentTray.getSnapshot()
    const composed = composeWithAttachments(text, drafts)
    const payload = collectModelAttachments(drafts)

    if (drafts.some(file => (file.kind === 'pdf' || file.kind === 'image') && !file.modelAttachment)
      || (payload.notice && payload.attachments.length === 0)) {
      setNotice(composed.notice || payload.notice || 'Freya could not prepare the file bytes. Please attach the file again.')
      return false
    }

    setNotice('')
    setScreen('chat')

    // The owner should not have to choose a tool for a request Freya already
    // understands. Explicit composer modes always win. In ordinary Chat, only
    // high-confidence discovery/deep-research shapes are promoted automatically;
    // everything else stays a normal conversation instead of spawning questions.
    /**
     * Routing deliberately ignores the tray.
     *
     * `routePromptIntent` will promote "an image is attached" into an Eye
     * media-discovery session — which is right when an attachment is only a
     * filename and the question is really "find me more like it", and wrong now
     * that the picture itself is on the turn. Sending it down the search lane
     * would take the attachment away from the only path that can carry it and
     * answer about the web instead of about the file. So an attachment keeps the
     * turn in Chat unless the owner explicitly asked for a search.
     */
    const inferred = mode === 'chat' && drafts.length === 0
      ? routePromptIntent(text, { activeEyeSession: activeEyeSessionId !== null })
      : null
    const effectiveMode: ComposerMode =
      inferred?.kind === 'deep-research'
        ? 'deep-research'
        : inferred?.kind === 'eye-new' || inferred?.kind === 'eye-follow-up'
          ? 'eye'
          : mode
    const autoNewEye = mode === 'chat' && inferred?.kind === 'eye-new'

    if (intents.browserUse || routeChatIntent(text, { activeEyeSession: false }).kind === 'native_browser_task') setBrowserOpen(true)

    if (effectiveMode === 'chat') {
      setResearchView(null)
      const result = await sendMessage(
        mirror,
        selectedConversationId !== undefined
          ? selectedConversationId
          : screen === 'chat' ? (conversation?.activeConversationId ?? null) : null,
        composed.text,
        Object.keys(intents).length > 0 ? intents : undefined,
        payload.attachments,
      )
      // The payload and the tray are cleared only once Core has accepted the turn,
      // so a refusal leaves the owner's files where they can be retried.
      if (result.ok) {
        attachmentTray.clear()
      }
      setNoticeConversationId(result.conversationId)
      setNotice([result.notice, payload.notice, composed.notice].filter(Boolean).join(' '))
      return result.ok
    }

    /**
     * A search lane cannot carry a file, and pretending otherwise would be worse
     * than saying so. `search.web` and Deep Research take a question; the
     * attachment text and payload stay in the tray, and the owner is told they did
     * not go — rather than a search being run against a document that silently
     * never arrived.
     */
    if (drafts.length > 0) {
      setNotice(`${drafts.length === 1 ? 'The attached file was' : 'The attached files were'} not sent with this search. Switch to Chat to send ${drafts.length === 1 ? 'it' : 'them'} to Freya.`)
    }

    setResearchBusy(true)
    setActiveResearchMode(effectiveMode)
    try {
      if (effectiveMode === 'deep-research') {
        const outcome = await research.research(text)
        setResearchView({ mode: 'deep-research', ownerText: text, outcome })
        if (outcome.operation === 'refused') {
          setNotice(outcome.reason ?? 'Deep Research was refused.')
          return false
        }
        return true
      }

      // A clear standalone discovery request starts a new Eye session even when
      // another search exists. Short refinements ("only YouTube", "make it 50")
      // deliberately stay on the active session.
      const route = autoNewEye
        ? { kind: 'create' as const, text: text }
        : routeEyePrompt(activeEyeSessionId, text)
      let outcome = route.kind === 'create'
        ? await research.createSession(route.text)
        : await research.followUpSession(route.sessionId, route.text)

      if (outcome.operation === 'refused' || !outcome.session) {
        setResearchView({ mode: 'eye', ownerText: text, outcome })
        setNotice(outcome.reason ?? "Freya's Eye could not start that search.")
        return false
      }

      setActiveEyeSessionId(outcome.session.sessionId)
      setResearchView({ mode: 'eye', ownerText: text, outcome })

      if (outcome.ambiguous) {
        setNotice("Freya's Eye needs one missing detail before changing this existing search.")
        return true
      }

      outcome = await research.collectSession(outcome.session.sessionId)
      setResearchView({ mode: 'eye', ownerText: text, outcome })
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

  const openBrowserUrl = useCallback((url: string, origin: DockedTabOrigin = { kind: 'link', from: 'chat', ownerText: 'owner' }) => {
    setScreen('chat')
    setBrowserOpen(true)
    openUrlInDockedBrowser(sharedDockedBrowserStore(), url, { origin })
    setBrowserRequestedUrl(url)
  }, [])


  useEffect(() => hostBridge()?.onBrowserOpenUrl?.((url) => openBrowserUrl(url, { kind: 'link', from: 'chat', ownerText: 'Opened from a browser page' })), [openBrowserUrl])

  const handleBrowserRequestedUrlHandled = useCallback(() => {
    setBrowserRequestedUrl(null)
  }, [])

  return <>
    {booted ? null : <BootScreen core={snapshot.core} attached={true} onDone={() => setBooted(true)} />}
    <HomeDashboard
      screen={screen}
      slotsByScreen={slotsByScreen}
      snapshot={snapshot}
      generating={generating}
      notice={noticeConversationId === null || noticeConversationId === conversation?.activeConversationId ? notice : ''}
      dressing={dressing}
      preferences={preferences}
      voice={voice.view}
      voiceControls={voice}
      voiceTranscript={voiceTranscriptDraft}
      settingsCategory={settingsCategory}
      onSettingsCategory={setSettingsCategory}
      onOpenDressing={() => setDressingOpen(true)}
      onSend={send}
      onStopResponse={stopResponse}
      researchView={researchView}
      onResearchViewChange={(view) => { setResearchView(view); setActiveEyeSessionId(view.outcome.session?.sessionId ?? null) }}
      onNavigate={setScreen}
      onVoicePress={voice.press}
      onVoiceRelease={voice.release}
      maxMessageCharacters={conversation?.maxMessageCharacters ?? null}
      browserOpen={browserOpen}
      browserPercent={browserPercent}
      onBrowserPercentChange={setBrowserPercent}
      browserRequestedUrl={browserRequestedUrl}
      onBrowserOpenUrl={openBrowserUrl}
      onBrowserRequestedUrlHandled={handleBrowserRequestedUrlHandled}
      onBrowserClose={() => setBrowserOpen(false)}
    />
    <div className="freya-v2" data-theme={settings.theme} data-app-shell="app" data-ui-mode={uiMode(snapshot)}>
      <DressingTable store={dressing} open={dressingOpen} onOpenChange={setDressingOpen} />

    </div>
  </>
}
