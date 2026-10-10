import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { UiSnapshot } from '../../ui-v2/state/contract'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { Clock } from '../../ui-v2/primitives/Clock'
import { ready, reason } from '../state/view'
import type { ScreenSlots } from './Home'
import { StargateHub } from '../presence/StargateHub'
import { HomeWidgets } from './HomeWidgets'
import { Chats } from '../chat/Chats'
import type { ComposerMode, WorkspaceResearchView } from '../chat/modes'
import type { VoiceDock, VoiceView } from '../voice/useVoiceDock'
import { brainState } from '../presence/state'
import { ChatHistory } from '../chat/ChatHistory'
import { ChatSidebarResize } from '../chat/ChatSidebarResize'
import { SettingsOverlay, type SettingsCategory } from './Settings'
import { GlobalComposer } from './GlobalComposer'
import { CoreHealth } from './CoreHealth'
import { hostBridge } from '../../platform/host'
import { conversationMirror } from '../../platform/conversationClient'
import type { DressingStore } from '../dressing/store'
import { PersistentWorkspaceLayers } from './PersistentWorkspaceLayers'
import chibiPlaceholder from '../assets/chibi-placeholder.svg'
import type { PreferencesStore } from '../../ui-v2/theme/preferences'
import type { DockedTabOrigin } from '../chat/BrowserWorkspace'
import { PRIMARY_DESTINATIONS, resolveRoute } from '../state/routes'
import { UnifiedWorkspace } from './UnifiedWorkspaces'
import { PrimaryNavigation } from '../navigation/PrimaryNavigation'
import './home-dashboard.css'

interface Props {
  screen: string
  slotsByScreen: Readonly<Record<string, ScreenSlots>>
  snapshot: UiSnapshot
  generating: boolean
  notice: string
  dressing: DressingStore
  preferences: PreferencesStore
  voice: VoiceView
  voiceControls?: VoiceDock
  voiceTranscript: { id: number; text: string } | null
  settingsCategory: SettingsCategory
  onSettingsCategory: (category: SettingsCategory) => void
  onOpenDressing: () => void
  onSend: (
    text: string,
    mode: ComposerMode,
    intents?: { readonly webSearch?: boolean; readonly browserUse?: boolean },
    conversationId?: string | null,
  ) => Promise<boolean>
  onStopResponse: () => void
  researchView: WorkspaceResearchView | null
  onResearchViewChange: (view: WorkspaceResearchView) => void
  onNavigate: (screen: string) => void
  onVoicePress: () => void
  onVoiceRelease: (cancelled?: boolean) => void
  maxMessageCharacters: number | null
  browserOpen: boolean
  browserPercent: number
  onBrowserPercentChange: (percent: number) => void
  browserRequestedUrl: string | null
  onBrowserOpenUrl: (url: string, origin?: DockedTabOrigin) => void
  onBrowserRequestedUrlHandled: () => void
  onBrowserClose: () => void
}

const WORKSPACE_IDS: readonly string[] = PRIMARY_DESTINATIONS.map(([id]) => id)

// Existing reference artwork supplies decorative face thumbnails, never UI text.
const FACES = [[290, 219], [378, 236], [291, 310], [470, 199]] as const
function Faces({ small = false, more = 3 }: { small?: boolean; more?: number }) {
  return <div className={`hd-faces${small ? ' hd-faces-small' : ''}`} aria-label={`${4 + more} people`}>
    {FACES.map(([x, y], i) => <span key={i} className="hd-face" aria-hidden="true" style={{ backgroundPosition: `${20 - x * .6}px ${20 - y * .6}px` }} />)}
    <span className="hd-face-count">{small ? more : `+${more}`}</span>
  </div>
}

function Panel({ name, title, icon, children, onOpen, meta }: {
  name: string; title: string; icon: string; children: ReactNode; onOpen: () => void; meta?: ReactNode
}) {
  // Silhouettes traced 1:1 from the reference render, so each card matches the
  // exact curved glass outline rather than an approximate rectangle.
  const contours: Record<string, { width: number; height: number; path: string }> = {
    focus: { width: 455, height: 202, path: 'M0 5 0 192 4 198 11 201 405 200 411 196 414 190 414 163 417 137 424 108 431 89 431 80 438 65 440 63 443 63 454 41 454 11 452 6 445 1 11 0 3 2Z' },
    mission: { width: 489, height: 222, path: 'M6 10 7 135 7 137 6 211 7 214 14 220 430 220 436 218 442 213 449 203 450 197 460 189 465 184 476 181 480 179 487 170 488 165 486 159 473 145 453 115 444 98 436 78 427 48 423 28 422 13 420 8 414 3 101 3 17 2 11 0 6 10Z' },
    attention: { width: 539, height: 176, path: 'M0 10 1 40 14 74 22 108 26 148 25 164 27 169 31 173 36 175 530 175 535 172 538 166 538 9 536 5 529 0 9 0 2 5Z' },
    people: { width: 555, height: 151, path: 'M0 132 0 139 2 144 10 150 547 150 552 146 554 142 554 9 552 5 545 0 49 0 46 1 40 8 38 30 33 56 21 93 12 109 9 118Z' },
  }
  const contour = contours[name]
  return <section className={`hd-panel hd-${name}${contour ? ' hd-contoured' : ''}`} aria-labelledby={`hd-title-${name}`}>
    {contour && <svg className="hd-panel-contour" viewBox={`0 0 ${contour.width} ${contour.height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id={`hd-glass-${name}`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#28445a" stopOpacity=".8" /><stop offset=".28" stopColor="#0b1722" stopOpacity=".87" /><stop offset=".7" stopColor="#07131e" stopOpacity=".75" /><stop offset="1" stopColor="#38536b" stopOpacity=".76" /></linearGradient>
        <linearGradient id={`hd-edge-${name}`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#d8f1ff" /><stop offset=".5" stopColor="#83a9c1" stopOpacity=".7" /><stop offset="1" stopColor="#c0e1f7" /></linearGradient></defs>
      <path d={contour.path} fill={`url(#hd-glass-${name})`} stroke={`url(#hd-edge-${name})`} strokeWidth="1.2" />
    </svg>}
    <header className="hd-panel-head"><Glyph name={icon} size={31} /><h2 id={`hd-title-${name}`}>{title}</h2>
      {meta}<button className="hd-more" aria-label={`Open ${title}`} onClick={onOpen}>•••</button></header>
    <div className="hd-panel-body">{children}</div>
  </section>
}

/**
 * The main region for every non-Home tab.
 *
 * Same board, same chrome — only this swaps. A screen may supply left/right/
 * bottom cards or replace the centre entirely (a graph, a timeline); otherwise
 * the shared Freya centre is drawn. `layout: 'wide'` drops the side columns.
 */
/** Home owns a reference-sized composition; no shared app/card selectors leak into it. */
export function HomeDashboard({ screen: requestedScreen, snapshot, generating, notice, dressing, preferences, voice, voiceControls, voiceTranscript, onSettingsCategory, onOpenDressing, onSend, onStopResponse, researchView, onResearchViewChange, onNavigate, onVoicePress, onVoiceRelease, maxMessageCharacters, browserOpen, browserPercent, onBrowserPercentChange, browserRequestedUrl, onBrowserOpenUrl, onBrowserRequestedUrlHandled, onBrowserClose }: Props) {
  const route = resolveRoute(requestedScreen)
  const screen = route.destination
  const paths = useRef<Record<string, string>>({})
  useEffect(() => { paths.current[screen] = route.path }, [screen, route.path])
  const navigate = (path: string) => onNavigate(resolveRoute(path).path)
  const viewport = useRef<HTMLDivElement>(null)
  const [desktopView, setDesktopView] = useState<'dashboard' | 'mini-chat'>('dashboard')
  useEffect(() => {
    const bridge = hostBridge()
    let active = true
    let received = false
    const off = bridge?.onDesktopView?.((view) => { received = true; if (active) setDesktopView(view) })
    void bridge?.getDesktopView?.().then(view => { if (active && !received) setDesktopView(view) }).catch(() => {})
    return () => { active = false; off?.() }
  }, [])
  useEffect(() => {
    if (desktopView !== 'mini-chat') return
    viewport.current?.querySelector<HTMLTextAreaElement>('.hd-input textarea')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) void hostBridge()?.windowClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [desktopView])
  const design = useSyncExternalStore(dressing.subscribe, dressing.getSnapshot, dressing.getSnapshot)
  /*
   * Narrow viewports start collapsed. This used to live in a CSS media query that
   * outranked `[data-collapsed]`, which meant the toggle could not widen the rail
   * back out — it only flipped `aria-pressed`. The default is chosen here instead,
   * so after first paint the attribute is the single source of truth.
   */
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1100,
  )
  const [chatSidebarWidth, setChatSidebarWidth] = useState(216)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const resize = () => { setWindowWidth(window.innerWidth) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const sidebarMax = Math.max(192, Math.min(360, Math.floor(windowWidth * .4)))
  const sidebarWidth = Math.min(chatSidebarWidth, sidebarMax)
  const home = ready(snapshot.home)
  const focus = home?.focus
  const attention = home?.attention.profiles[0]
  const preview = snapshot.home.status === 'ready' && snapshot.home.source === 'preview'
  const core = ready(snapshot.core)
  const online = core?.operational === true
  // The top-bar pill labels a Core that is up but not pristine. A degraded
  // Core that is still operational is labelled with the cause rather than
  // hidden behind a "WORKING" pill that would imply everything is fine.
  const degradedReason: string | null = (() => {
    if (!core) return null
    if (core.operational === true && core.lifecycle === 'ready') return null
    if (core.persistenceDurable === false) return 'EPHEMERAL'
    if (core.lifecycle === 'degraded') return 'DEGRADED'
    return core.lifecycle === 'booting' ? null : core.lifecycle.toUpperCase()
  })()
  const workers = ready(snapshot.workforce)
  const activity = ready(snapshot.activity)
  const provider = ready(snapshot.provider)
  const cognition = brainState({
    activeRequests: core?.activeRequests ?? 0,
    working: workers?.working ?? 0,
    faultCount: core?.faultCount ?? 0,
    lifecycle: core?.lifecycle ?? 'booting',
    operational: core?.operational,
  })
  const open = (screen: string) => () => navigate(screen)

  /*
   * The chrome, after the reference shell's frame: one bar across the top that
   * answers "what is happening", and a left rail that answers "where can I go".
   * The bar holds the state pill (only when it is not the obvious one), the
   * working count, the two panels — the team and what is running — the clock
   * and the window controls. The rail holds the places, the conversations
   * under Chats, and the account at the foot.
   *
   * Both panels and the account menu close the way the reference's do: any
   * pointerdown outside them, or Escape.
   */
  const [pop, setPop] = useState<'agents' | 'activity' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (pop === null && !menuOpen) return
    const onDown = (event: PointerEvent): void => {
      const insidePop = popRef.current?.contains(event.target as Node) ?? false
      const insideMenu = menuRef.current?.contains(event.target as Node) ?? false
      if (!insidePop) setPop(null)
      if (!insideMenu) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setPop(null); setMenuOpen(false) }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [pop, menuOpen])

  const workingCount = workers?.working ?? 0
  // A fault is recorded trouble, so the activity panel wears the warn badge
  // while Core reports any; it is the one "needs you" sign this screen can
  // read without inventing one.
  const warnCount = core?.faultCount ?? 0
  const pill = (() => {
    // A Core that is up but not pristine is labelled with the cause. A
    // healthy Core only wears the cognition pill.
    if (degradedReason !== null) return { kind: 'needs', word: degradedReason }
    if (cognition === 'uncertainty') return { kind: 'needs', word: 'NEEDS YOU' }
    if (cognition === 'calm') return null
    return { kind: 'working', word: 'WORKING' }
  })()
  const agoLabel = (at: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (seconds < 60) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
  }

  /*
   * What the composer and the shell used to print over the chat bar, which the
   * chat now says instead: the shell's own sentence, the microphone's bounded
   * notice, and anything local the composer hit (a file the host would not read).
   */
  const [composerIssue, setComposerIssue] = useState('')
  useEffect(() => { if (notice) setComposerIssue('') }, [notice])
  const issue = [notice, voice.notice, composerIssue].filter(Boolean).join(' ')

  return <div className="freya-v2 hd-viewport" data-theme="abyss" data-desktop-view={desktopView} ref={viewport}>
    {/*
      The conversation is the whole window on its screen: no top bar, no rail, no
      board gutter. The one number both the workspace columns and the composer
      read is published here, so the composer can sit over the conversation column
      instead of over the divider.
    */}
    <div className="hd-frame"><div className="hd-dashboard" data-screen={screen} data-background={design.background} data-browser={browserOpen || undefined} style={{ '--chats-thread': String(100 - browserPercent), '--chat-sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <header className="hd-top">
        <div className="hd-brand"><b>FREYA</b></div>
        {core && (core.lifecycle === 'degraded' || core.persistenceDurable === false || core.faultCount > 0 || core.diagnosticsWriteFailures > 0)
          ? <CoreHealth core={core} />
          : pill ? <div className={`hd-pill ${pill.kind}`}>{pill.word}</div> : null}
        <span className="hd-gap" />
        <div className="hd-counts">
          {workingCount > 0 ? <span className="hd-count on">{workingCount} working</span> : null}
        </div>
        <button
          type="button" className={`hd-toolbtn${pop === 'agents' ? ' on' : ''}`}
          aria-label="Agents — the team, and what each is doing"
          aria-expanded={pop === 'agents'}
          title="Agents — the team, and what each is doing"
          onClick={() => setPop((value) => (value === 'agents' ? null : 'agents'))}
        >
          <Glyph name="workforce" size={18} />
          {workingCount > 0 ? <span className="hd-badge live">{workingCount}</span> : null}
        </button>
        <button
          type="button" className={`hd-toolbtn${pop === 'activity' ? ' on' : ''}${warnCount > 0 ? ' warn' : ''}`}
          aria-label="Activity — what is running, and what has been happening"
          aria-expanded={pop === 'activity'}
          title="Activity — what is running, and what has been happening"
          onClick={() => setPop((value) => (value === 'activity' ? null : 'activity'))}
        >
          <Glyph name="activity" size={18} />
          {warnCount > 0 ? <span className="hd-badge warn">{warnCount}</span> : null}
        </button>
        <div className="hd-clock"><Clock /></div>
        <div className="hd-win" role="group" aria-label="Window">
          <button aria-label="Minimize" onClick={() => void hostBridge()?.windowMinimize()}><Glyph name="win-min" size={16} /></button>
          <button aria-label="Maximize" onClick={() => void hostBridge()?.windowMaximize()}><Glyph name="win-max" size={16} /></button>
          <button className="hd-win-close" aria-label="Close" onClick={() => void hostBridge()?.windowClose()}><Glyph name="win-close" size={16} /></button>
        </div>
        {pop ? (
          <div className="hd-pop" ref={popRef} role="dialog" aria-label={pop === 'agents' ? 'Agents' : 'Activity'}>
            {pop === 'agents' ? (
              <>
                <header className="hd-pop-head">Agents <span className="hd-pop-count">{workingCount > 0 ? `${workingCount} working` : 'idle'}</span></header>
                {(workers?.rows ?? []).length === 0
                  ? <p className="hd-pop-empty">{preview ? 'The sample team is off in this preview.' : 'No agents are on the team yet.'}</p>
                  : (workers?.rows ?? []).slice(0, 8).map((worker) => (
                    <button key={worker.id} type="button" className="hd-pop-row" onClick={open('workforce')}>
                      <span className="hd-pop-dot" data-state={worker.state} />
                      <span className="hd-pop-words"><b>{worker.specialization ?? worker.id}</b><small>{worker.state}</small></span>
                    </button>
                  ))}
              </>
            ) : (
              <>
                <header className="hd-pop-head">Activity</header>
                {(activity ?? []).length === 0
                  ? <p className="hd-pop-empty">{preview ? 'Sample activity is off in this preview.' : 'Nothing has been recorded yet.'}</p>
                  : (activity ?? []).slice(0, 9).map((row) => (
                    <button key={row.id} type="button" className="hd-pop-row" onClick={open('activity')}>
                      <span className="hd-pop-words"><b>{row.text}</b><small>{agoLabel(row.at)}</small></span>
                    </button>
                  ))}
              </>
            )}
          </div>
        ) : null}
      </header>
      <aside className="hd-rail" data-collapsed={collapsed || undefined}>
        <div className="hd-railhead">
          <span className="hd-rail-label">Workspace</span>
          <button className="hd-rail-toggle" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed} onClick={() => setCollapsed(value => !value)}><Glyph name="panel" size={16} /></button>
        </div>
        <div className="hd-rail-body">
          <PrimaryNavigation active={screen} onSelect={id => navigate(paths.current[id] ?? id)} />
          <section className="hd-context-list" aria-label="Saved conversations" hidden={screen !== 'chat' || collapsed}>
            <ChatHistory onOpen={open('chat')} current contextual />
          </section>
        </div>
        <div className="hd-rail-foot">
          {screen === 'home' ? <img className="hd-chibi" src={chibiPlaceholder} alt="Chibi Freya — temporary placeholder" draggable={false} /> : null}
          <div className="hd-online" data-online={online} title={preview ? 'Design preview · Sample data' : !core ? reason(snapshot.core) : core.lifecycle}><span className="hd-status-dot" /><span>{online ? 'Freya Online' : 'Freya Offline'}</span></div>
          <div className="hd-profile" ref={menuRef}>
            <button className="hd-user" aria-label="Open your account menu" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((value) => !value)}>
              <span className="hd-user-avatar">A</span><span className="hd-user-name">Aslam</span><Glyph name="chevron" size={14} />
            </button>
            {menuOpen ? (
              <div className="hd-menu-pop" role="menu" aria-label="Account">
                <button role="menuitem" onClick={() => { setMenuOpen(false); onSettingsCategory('appearance'); open('settings')() }}>Settings</button>
                <button role="menuitem" onClick={() => { setMenuOpen(false); onSettingsCategory('about'); open('settings/about')() }}>About Freya</button>
              </div>
            ) : null}
          </div>
        </div>
        {screen === 'chat' && !collapsed ? <ChatSidebarResize width={sidebarWidth} max={sidebarMax} onChange={setChatSidebarWidth} /> : null}
      </aside>
      <main className="hd-main" aria-label={preview ? 'Freya dashboard · Sample data' : 'Freya dashboard'}>
        <PersistentWorkspaceLayers
          active={screen}
          workspaceIds={WORKSPACE_IDS}
          renderWorkspace={(workspaceId) => workspaceId === 'home' ? (<>
        <HomeWidgets snapshot={snapshot} onNavigate={navigate} />
        <Panel name="focus" title="Current focus" icon="focus" onOpen={open('focus')}>
          <h3>{focus?.title ?? 'No focus reported'}</h3>
          <p className="hd-description">{preview ? 'Finalizing system architecture, workspace designs, and go-to-market plan.' : focus?.detail}</p>
          <div className="hd-progress-line"><span className="hd-progress" role="progressbar" aria-label="Current focus progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={focus?.progress ?? undefined}><i style={{ width: `${focus?.progress ?? 0}%` }} /></span><small>{focus?.progress == null ? '—' : `${focus.progress}%`}</small></div>
          <div className="hd-tags">{['Strategy', 'Product', 'Launch'].map(tag => <button key={tag} onClick={open('focus')}>{tag}</button>)}<button aria-label="Add focus" onClick={open('focus')}>+</button></div>
        </Panel>
        <Panel name="mission" title="Mission" icon="mission" onOpen={open('missions')}>
          <h3>{home?.mission ?? 'No mission reported'}</h3>
          <ul className="hd-goals">{home?.goals?.map((goal, i) => <li key={goal.id}><span className={preview && i === 0 ? 'hd-check hd-checked' : 'hd-check'} aria-hidden="true">{preview && i === 0 ? '✓' : ''}</span>{goal.text}</li>)}</ul>
        </Panel>
        <div className="hd-presence" role="region" aria-label="Freya containment dashboard">
          <StargateHub state={cognition} energy={generating ? 1 : Math.min(1, workingCount * .16)} onNavigate={navigate} />
          <button className="hd-dress" aria-label="Dressing table" aria-haspopup="dialog" onClick={onOpenDressing}><Glyph name="dress" size={15} /></button>
        </div>
        <Panel name="attention" title="Attention" icon="life" onOpen={open('focus')}>
          <div className="hd-attention-content"><div className="hd-attention-ring" role="meter" aria-label="Attention" aria-valuemin={0} aria-valuemax={100} aria-valuenow={attention?.focused}><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="43" className="hd-ring-track" /><circle cx="50" cy="50" r="43" className="hd-ring-fill" pathLength="100" strokeDasharray={`${attention?.focused ?? 0} 100`} /></svg><b>{attention ? `${attention.focused}%` : '—'}</b></div>
            <div className="hd-attention-caption"><b>{attention?.label ?? 'Unavailable'}</b><small>{home?.attention.caption}</small></div>
            <div className="hd-distribution">{home?.attention.categories.map((category, i) => <div key={category}><span>{category}</span><i><b style={{ width: `${attention?.distribution[i] ?? 0}%` }} /></i><small>{attention?.distribution[i] ?? 0}%</small></div>)}</div>
          </div>
        </Panel>
        <Panel name="people" title="People" icon="workforce" onOpen={open('people')}>
          <div className="hd-people-content"><div><p>Key People</p><>{preview ? <Faces more={home?.morePeople ?? 0} /> : <p>{home?.people?.map(person => person.name).join(' · ') || 'People not connected'}</p>}</></div><div className="hd-people-stats">{preview ? <><span><Glyph name="search" size={13} />{home?.messages ?? 0} new messages</span><span><i />{home?.followUps ?? 0} follow up today</span><span><i />{home?.meetingPrep ?? 0} meeting prep items</span></> : <span>Updates not available</span>}</div></div>
        </Panel>
        <Panel name="workforce" title="Office" icon="workforce" onOpen={open('office')} meta={<span className="hd-meta"><i />{workers ? `${workers.total} reported` : 'Not connected'}</span>}>
          <div className="hd-workers">{(preview ? [
            { id: 'content', specialization: 'Content Studio', state: 'Creating campaign assets...' },
            { id: 'research', specialization: 'Research Agent', state: 'Monitoring AI & market updates...' },
            { id: 'operations', specialization: 'Operations Agent', state: 'Handling emails and scheduling...' },
            { id: 'strategy', specialization: 'Strategy Agent', state: 'Analyzing opportunities...' },
          ] : workers?.rows ?? []).slice(0, 4).map((worker, i) => <button key={worker.id} className="hd-worker" onClick={open('workforce')}><span className={`hd-worker-ring hd-worker-ring-${i}`} /><span className="hd-worker-text"><b>{worker.specialization ?? worker.id}</b><small>{worker.state}</small></span>{preview && <Faces small more={[4, 3, 2, 2][i]} />}<span className="hd-chevron">›</span></button>)}</div>
        </Panel>
        <Panel name="world" title="World" icon="world" onOpen={open('world')}>
          <div className="hd-world-globe" aria-hidden="true"><svg viewBox="0 0 320 230"><g fill="none" stroke="#7cdfff" strokeWidth=".8" opacity=".6"><path d="M20 140Q100-70 280 100M15 180Q120 30 290 160M50 60Q190 140 225 210M20 140 130 115 225 210 280 100 50 60 130 115" /><ellipse cx="152" cy="148" rx="134" ry="105" transform="rotate(-20 152 148)" /></g>{[[20,140],[130,115],[225,210],[280,100],[50,60]].map(([x,y]) => <circle key={x} cx={x} cy={y} r="3" fill="#9af2ff" />)}</svg></div>
          <div className="hd-world-items">{(preview ? [
            ['Global Tech', 'AI regulation framework advances in EU and US.', 'core', '2h ago'],
            ['Markets', 'Clean energy stocks up 2.4%.', 'life', '3h ago'],
            ['Innovation', 'Breakthrough in battery density announced.', 'create', '5h ago'],
            ['Opportunities', '3 new potential partnerships today.', 'world', 'Today'],
          ] : home?.world?.map(item => [item.title, item.detail, item.icon, '']) ?? []).map(([title, detail, icon, time]) => <button key={title} onClick={open('world')}><Glyph name={icon!} size={19} /><span><b>{title}</b><small>{detail}</small></span><span className="hd-world-time">{time}</span></button>)}</div>
        </Panel>
        <Panel name="memory" title={preview ? 'Recent memory' : 'Recent activity'} icon="activity" onOpen={open('activity')}>
          <div className="hd-memories">{(preview ? [
            ['Product strategy review completed', '2h ago'], ['Drafted Phase 19 launch plan', '4h ago'], ['Spoke with Alex about partnership idea', '6h ago'], ['Researched EU AI regulatory updates', '12h ago'], ['Created visual concepts for new workspace', '1d ago'],
          ] : activity?.slice(0, 5).map(item => [item.text, new Date(item.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })]) ?? []).map(([text, time], i) => <button key={text} onClick={open('activity')}><span className={`hd-memory-icon hd-memory-icon-${i}`}><Glyph name={['mind', 'mission', 'relay', 'people', 'create'][i]!} size={17} /></span><span>{text}</span><small>{time}</small></button>)}</div>
          {!preview && (!activity || activity.length === 0) ? <p className="hd-description">{activity ? 'No recent activity reported.' : reason(snapshot.activity)}</p> : null}
          {snapshot.activity.status === 'stale' ? <p className="hd-description">Last known activity · {snapshot.activity.reason}</p> : null}
        </Panel>
        </>) : workspaceId === 'chat' ? (
          <Chats
            researchView={researchView}
            onResearchViewChange={onResearchViewChange}
            busy={generating}
            issue={issue}
            browserOpen={browserOpen}
            browserPercent={browserPercent}
            onBrowserPercentChange={onBrowserPercentChange}
            browserRequestedUrl={browserRequestedUrl}
            onBrowserOpenUrl={onBrowserOpenUrl}
            onBrowserRequestedUrlHandled={onBrowserRequestedUrlHandled}
            onBrowserClose={onBrowserClose}
            voiceCanSpeak={voice.projection?.synthesis.available === true}
            voiceSpeaking={voice.speaking}
            onSpeakTurn={voiceControls?.speak}
            onStopSpeaking={voiceControls?.stopSpeaking}
            onStopResponse={onStopResponse}
            onRetryTurn={(text) => { void onSend(text, 'chat') }}
          />
        ) : workspaceId === 'settings' ? (
          <SettingsOverlay
            snapshot={snapshot}
            preferences={preferences}
            voiceControls={voiceControls}
            category={resolveRoute(screen === 'settings' ? route.path : paths.current.settings ?? 'settings').section.replace('advanced/', '') as SettingsCategory}
            onCategory={category => { onSettingsCategory(category); navigate(`settings/${['foundry', 'relay', 'harness', 'context', 'diagnostics'].includes(category) ? 'advanced/' : ''}${category}`) }}
            onDone={open('home')}
          />
        ) : <UnifiedWorkspace path={workspaceId === screen ? route.path : paths.current[workspaceId] ?? workspaceId} snapshot={snapshot} onNavigate={navigate} />}
        />
      </main>
      <GlobalComposer
        miniChat={desktopView === 'mini-chat'}
        generating={generating}
        defaultModel={provider?.model ?? null}
        voice={voice}
        voiceTranscript={voiceTranscript}
        onSend={desktopView === 'mini-chat'
          ? (text, mode, intents) => onSend(text, mode, intents, conversationMirror().projection?.activeConversationId ?? null)
          : onSend}
        onStopResponse={onStopResponse}
        onVoicePress={onVoicePress}
        onVoiceRelease={onVoiceRelease}
maxMessageCharacters={maxMessageCharacters}
        onNotice={setComposerIssue}
      />
    </div></div>

  </div>
}
