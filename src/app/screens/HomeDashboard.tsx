import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { UiSnapshot } from '../../ui-v2/state/contract'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { Clock } from '../../ui-v2/primitives/Clock'
import { ready } from '../state/view'
import type { ScreenSlots } from './Home'
import { FreyaCentre } from '../presence/FreyaCentre'
import { Chats } from '../chat/Chats'
import { brainState, type BrainState } from '../presence/state'
import { GlobalComposer } from './GlobalComposer'
import { hostBridge } from '../../platform/host'
import type { DressingStore, DressingState } from '../dressing/store'
import './home-dashboard.css'

interface Props {
  screen: string
  slots?: ScreenSlots
  snapshot: UiSnapshot
  generating: boolean
  notice: string
  dressing: DressingStore
  onOpenDressing: () => void
  onSend: (text: string) => Promise<boolean>
  onStopResponse: () => void
  onNavigate: (screen: string) => void
}

const NAV = [['home', 'Home', 'home'], ['chat', 'Chats', 'chat'], ['mind', 'Mind', 'mind'], ['focus', 'Focus', 'focus'],
  ['people', 'People', 'people'], ['workforce', 'Workforce', 'workforce'], ['world', 'World', 'world'],
  ['memory', 'Memory', 'memory'], ['life', 'Life', 'life'], ['create', 'Foundry', 'forge'],
  ['relay', 'Relay', 'relay']] as const

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
function TabBody({ slots, design, cognition }: { slots?: ScreenSlots; design: DressingState; cognition: BrainState }) {
  if (!slots) return null
  const wide = slots.layout === 'wide'
  return (
    <div className="hd-tab-body" data-layout={wide ? 'wide' : 'standard'}>
      {wide ? null : <div className="hd-col hd-col-l">{slots.left}</div>}
      {/* Freya is always the centre and sits in front of the screen's geometry,
          as the references show — the World graph and Life timeline pass behind
          her. The overlay is absolute, so DOM order puts Freya on top. */}
      <div className="hd-tab-centre">
        {slots.centre ? <div className="hd-tab-overlay">{slots.centre}</div> : null}
        <FreyaCentre centre={design.centre} style={design.style} rings={design.rings === 'on'} state={cognition} />
      </div>
      {wide ? null : <div className="hd-col hd-col-r">{slots.right}</div>}
      {slots.bottom ? <div className="hd-col-b">{slots.bottom}</div> : null}
      {/*
        One visible statement, for every screen that declares it.
        */}
      {slots.sample ? <p className="hd-sample-note" role="status">{slots.sample}</p> : null}
    </div>
  )
}

/** Home owns a reference-sized composition; no shared app/card selectors leak into it. */
export function HomeDashboard({ screen, slots, snapshot, generating, notice, dressing, onOpenDressing, onSend, onStopResponse, onNavigate }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const design = useSyncExternalStore(dressing.subscribe, dressing.getSnapshot, dressing.getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const home = ready(snapshot.home)
  const focus = home?.focus
  const attention = home?.attention.profiles[0]
  const preview = snapshot.home.status === 'ready' && snapshot.home.source === 'preview'
  const core = ready(snapshot.core)
  const online = core?.lifecycle === 'ready'
  const workers = ready(snapshot.workforce)
  const activity = ready(snapshot.activity)
  const provider = ready(snapshot.provider)
  const cognition = brainState({
    activeRequests: core?.activeRequests ?? 0,
    working: workers?.working ?? 0,
    faultCount: core?.faultCount ?? 0,
    lifecycle: core?.lifecycle ?? 'booting',
  })
  const open = (screen: string) => () => onNavigate(screen)

  return <div className="freya-v2 hd-viewport" data-theme="abyss" ref={viewport}>
    <div className="hd-frame"><div className="hd-dashboard" data-screen={screen} data-background={design.background}>
      <header className="hd-header">
        <div className="hd-clock">
          <Clock />
          <button aria-label="Open appearance settings" onClick={open('settings')}><Glyph name="settings" size={26} /></button>
          <div className="hd-win" role="group" aria-label="Window">
            <button aria-label="Minimize" onClick={() => void hostBridge()?.windowMinimize()}><Glyph name="win-min" size={16} /></button>
            <button aria-label="Maximize" onClick={() => void hostBridge()?.windowMaximize()}><Glyph name="win-max" size={16} /></button>
            <button className="hd-win-close" aria-label="Close" onClick={() => void hostBridge()?.windowClose()}><Glyph name="win-close" size={16} /></button>
          </div>
        </div>
      </header>
      <aside className="hd-rail" data-collapsed={collapsed || undefined}>
        <div className="hd-rail-top">
          <div className="hd-brand"><b>FREYA</b></div>
          <button className="hd-rail-toggle" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed} onClick={() => setCollapsed(value => !value)}><Glyph name="arrow" size={16} /></button>
        </div>
        <nav aria-label="Freya">{NAV.map(([id, label, icon]) => <button key={id} aria-label={label} aria-current={id === screen ? 'page' : undefined} onClick={open(id)}><Glyph name={icon} size={23} /><span>{label}</span></button>)}</nav>
        <div className="hd-rail-foot">
          <div className="hd-online" title={preview ? 'Design preview · Sample data' : undefined}><span className="hd-status-dot" /><span>{online ? 'Freya Online' : 'Freya Offline'}</span><small>Phase 19<br />Build 19.0.1</small></div>
          <button className="hd-user" aria-label="Open your profile" onClick={open('settings')}><span className="hd-user-avatar">A</span><span className="hd-user-name">Aslam</span><Glyph name="settings" size={15} /></button>
        </div>
      </aside>
      <main className="hd-main" aria-label={preview ? 'Freya dashboard · Sample data' : 'Freya dashboard'}>
        {screen === 'home' ? (<>
        <Panel name="focus" title="Current focus" icon="focus" onOpen={open('focus')}>
          <h3>{focus?.title ?? 'No focus reported'}</h3>
          <p className="hd-description">{preview ? 'Finalizing system architecture, workspace designs, and go-to-market plan.' : focus?.detail}</p>
          <div className="hd-progress-line"><span className="hd-progress" role="progressbar" aria-label="Current focus progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={focus?.progress ?? undefined}><i style={{ width: `${focus?.progress ?? 0}%` }} /></span><small>{focus?.progress == null ? '—' : `${focus.progress}%`}</small></div>
          <div className="hd-tags">{['Strategy', 'Product', 'Launch'].map(tag => <button key={tag} onClick={open('focus')}>{tag}</button>)}<button aria-label="Add focus" onClick={open('focus')}>+</button></div>
        </Panel>
        <Panel name="mission" title="Mission" icon="mission" onOpen={open('focus')}>
          <h3>{home?.mission ?? 'No mission reported'}</h3>
          <ul className="hd-goals">{home?.goals?.map((goal, i) => <li key={goal.id}><span className={preview && i === 0 ? 'hd-check hd-checked' : 'hd-check'} aria-hidden="true">{preview && i === 0 ? '✓' : ''}</span>{goal.text}</li>)}</ul>
        </Panel>
        <div className="hd-presence" role="img" aria-label="Freya surrounded by luminous orbital rings">
          <FreyaCentre centre={design.centre} style={design.style} rings={design.rings === 'on'} state={cognition} />
          <button className="hd-dress" aria-label="Dressing table" aria-haspopup="dialog" onClick={onOpenDressing}><Glyph name="dress" size={15} /></button>
          <span className="hd-orbit-label hd-understand">UNDERSTAND</span><span className="hd-orbit-label hd-plan">PLAN</span><span className="hd-orbit-label hd-create">CREATE</span><span className="hd-orbit-label hd-remember">REMEMBER</span><span className="hd-orbit-label hd-act">ACT</span>
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
        <Panel name="workforce" title="Workforce" icon="workforce" onOpen={open('workforce')} meta={<span className="hd-meta"><i />{preview ? '12 active' : `${workers?.total ?? 0} reported`}</span>}>
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
        <Panel name="memory" title="Recent memory" icon="memory" onOpen={open('memory')}>
          <div className="hd-memories">{(preview ? [
            ['Product strategy review completed', '2h ago'], ['Drafted Phase 19 launch plan', '4h ago'], ['Spoke with Alex about partnership idea', '6h ago'], ['Researched EU AI regulatory updates', '12h ago'], ['Created visual concepts for new workspace', '1d ago'],
          ] : activity?.slice(0, 5).map(item => [item.text, new Date(item.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })]) ?? []).map(([text, time], i) => <button key={text} onClick={open('memory')}><span className={`hd-memory-icon hd-memory-icon-${i}`}><Glyph name={['mind', 'mission', 'relay', 'people', 'create'][i]!} size={17} /></span><span>{text}</span><small>{time}</small></button>)}</div>
        </Panel>
        </>) : screen === 'chat' ? <Chats /> : <TabBody slots={slots} design={design} cognition={cognition} />}
      </main>
      <GlobalComposer generating={generating} notice={notice} defaultModel={provider?.model ?? null} onSend={onSend} onStopResponse={onStopResponse} />
    </div></div>

  </div>
}
