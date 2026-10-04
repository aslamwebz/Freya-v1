import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { UiSnapshot } from '../../ui-v2/state/contract'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { Clock } from '../../ui-v2/primitives/Clock'
import { ready } from '../state/view'
import { readModelCatalog, selectModel } from '../../platform/modelClient'
import { hostBridge } from '../../platform/host'
import type { DressingStore } from '../dressing/store'
import portrait from '../../ui-v2/assets/freya-portrait.webp'
import './home-dashboard.css'

interface Props {
  snapshot: UiSnapshot
  draft: string
  generating: boolean
  notice: string
  dressing: DressingStore
  onOpenDressing: () => void
  onDraft: (value: string) => void
  onSend: () => void
  onNavigate: (screen: string) => void
  onChat: () => void

}

const NAV = [['home', 'Home', 'home'], ['mind', 'Mind', 'mind'], ['focus', 'Focus', 'focus'],
  ['people', 'People', 'people'], ['workforce', 'Workforce', 'workforce'], ['world', 'World', 'world'],
  ['memory', 'Memory', 'memory'], ['life', 'Life', 'life'], ['create', 'Foundry', 'forge'],
  ['relay', 'Relay', 'relay']] as const

// The thinking levels the composer offers. The model list is never hard-coded:
// it is read from the configured provider through Core's catalogue command.
const THINK = ['None', 'Think', 'Deep', 'Fast'] as const
type ModelEntry = { readonly id: string; readonly ownedBy: string | null }

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

function Orbits() {
  return <svg className="hd-orbits" viewBox="0 0 550 550" fill="none" aria-hidden="true">
    <defs><linearGradient id="hd-orbit-color" x1="0" y1="0" x2="550" y2="550" gradientUnits="userSpaceOnUse"><stop stopColor="#96d9fa" /><stop offset=".5" stopColor="#6593c1" stopOpacity=".24" /><stop offset="1" stopColor="#ac9bff" /></linearGradient>
      <filter id="hd-star-glow" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="3.2" /></filter></defs>
    {/* Two faint outer instrument rings, then a dotted guidance ring. */}
    <circle cx="275" cy="275" r="262" stroke="url(#hd-orbit-color)" strokeWidth=".8" opacity=".38" />
    <circle cx="275" cy="275" r="240" stroke="url(#hd-orbit-color)" strokeWidth=".9" opacity=".42" />
    <circle cx="275" cy="275" r="214" stroke="#82c7f0" strokeDasharray="1 14" opacity=".5" />
    {/* The single bright rim that frames Freya, brightest across the top. */}
    <circle cx="275" cy="275" r="190" stroke="#8fe9ff" strokeWidth="2.2" opacity=".92" />
    <path d="M85 275a190 190 0 0 1 380 0" stroke="#c9f8ff" strokeWidth="2.6" />
    <circle cx="275" cy="275" r="176" stroke="#7ca7cb" strokeWidth=".8" opacity=".3" />
    {/* Sparse beacons ride the outer orbit, not the bright rim. */}
    {[[494, 173], [358, 48], [173, 56], [48, 358], [56, 377], [192, 502], [377, 494], [502, 192]].map(([x, y], i) => <g key={i}>
      <circle cx={x} cy={y} r={i % 2 ? 7 : 5} fill={i % 2 ? '#b79cff' : '#8cedff'} filter="url(#hd-star-glow)" opacity=".95" />
      <circle cx={x} cy={y} r={i % 2 ? 3.2 : 2.4} fill={i % 2 ? '#e1ceff' : '#b6f7ff'} />
    </g>)}
  </svg>
}

/** Home owns a reference-sized composition; no shared app/card selectors leak into it. */
export function HomeDashboard({ snapshot, draft, generating, notice, dressing, onOpenDressing, onDraft, onSend, onNavigate, onChat }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const design = useSyncExternalStore(dressing.subscribe, dressing.getSnapshot, dressing.getSnapshot)
  const [scale, setScale] = useState(1)
  const [voiceNotice, setVoiceNotice] = useState('')
  const [menu, setMenu] = useState<string | null>(null)
  const [models, setModels] = useState<readonly ModelEntry[]>([])
  const [model, setModel] = useState<string | null>(null)
  const [catalogNote, setCatalogNote] = useState('')
  const [thinkLevel, setThinkLevel] = useState<typeof THINK[number]>('Think')
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const measure = () => setScale(Math.max(.65, Math.min(node.clientWidth / 1672, node.clientHeight / 941)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const home = ready(snapshot.home)
  const focus = home?.focus
  const attention = home?.attention.profiles[0]
  const preview = snapshot.home.status === 'ready' && snapshot.home.source === 'preview'
  const core = ready(snapshot.core)
  const online = core?.lifecycle === 'ready'
  const workers = ready(snapshot.workforce)
  const activity = ready(snapshot.activity)
  const provider = ready(snapshot.provider)
  const open = (screen: string) => () => onNavigate(screen)

  // The catalogue is a provider read, asked for only when the selector opens —
  // never cached, never invented. A refusal is shown in Core's own words.
  const toggleModelMenu = () => {
    const next = menu === 'model' ? null : 'model'
    setMenu(next)
    if (next !== 'model') return
    setCatalogNote('')
    void readModelCatalog().then(outcome => {
      if (outcome.operation === 'catalog' && outcome.models) setModels(outcome.models)
      else { setModels([]); setCatalogNote(outcome.reason ?? 'The model catalogue is unavailable.') }
    })
  }
  const chooseModel = (id: string) => {
    setModel(id)
    setMenu(null)
    void selectModel(id)
  }
  const activeModel = model ?? provider?.model ?? 'provider default'
  const style = { '--hd-scale': scale, width: 1672 * scale, height: 941 * scale } as CSSProperties

  return <div className="freya-v2 hd-viewport" data-theme="abyss" ref={viewport}>
    <div className="hd-frame" style={style}><div className="hd-dashboard" data-screen="home">
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
        <nav aria-label="Freya">{NAV.map(([id, label, icon]) => <button key={id} aria-label={label} aria-current={id === 'home' ? 'page' : undefined} onClick={open(id)}><Glyph name={icon} size={23} /><span>{label}</span></button>)}</nav>
        <div className="hd-rail-foot">
          <div className="hd-online" title={preview ? 'Design preview · Sample data' : undefined}><span className="hd-status-dot" /><span>{online ? 'Freya Online' : 'Freya Offline'}</span><small>Phase 19<br />Build 19.0.1</small></div>
          <button className="hd-user" aria-label="Open your profile" onClick={open('settings')}><span className="hd-user-avatar">A</span><span className="hd-user-name">Aslam</span><Glyph name="settings" size={15} /></button>
        </div>
      </aside>
      <main className="hd-main" aria-label={preview ? 'Freya dashboard · Sample data' : 'Freya dashboard'}>
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
          <Orbits />{design.image === 'portrait' && <img src={portrait} alt="" className="hd-portrait" />}
          <button className="hd-dress" aria-label="Dressing table" aria-haspopup="dialog" onClick={onOpenDressing}><Glyph name="dress" size={15} /></button>
          <span className="hd-orbit-label hd-understand">UNDERSTAND</span><span className="hd-orbit-label hd-plan">PLAN</span><span className="hd-orbit-label hd-create">CREATE</span><span className="hd-orbit-label hd-remember">REMEMBER</span><span className="hd-orbit-label hd-act">ACT</span>
          <div className="hd-presence-name"><b>FREYA</b><span>PHASE 19</span><small>SAME MIND. A BRIGHTER TOMORROW.</small></div>
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
      </main>
      <footer className="hd-dock"><form aria-label="Freya composer" onSubmit={event => { event.preventDefault(); onSend() }}>
        <button type="button" className="hd-mic" aria-label="Voice input unavailable" onClick={() => setVoiceNotice('Voice input is not connected yet. You can type to Freya.')}><Glyph name="mic" size={27} /></button>
        <label className="hd-input"><span className="hd-sr-only">Ask Freya</span><input value={draft} onChange={event => onDraft(event.target.value)} placeholder={generating ? 'Freya is answering…' : 'Ask Freya...'} /></label>
        <div className="hd-tools">
          <button type="button" className="hd-tool" aria-label="Attach a file" onClick={() => setVoiceNotice('Attachments are not connected yet.')}><Glyph name="attach" size={18} /></button>
          <div className="hd-select">
            <button type="button" className="hd-tool hd-tool-model" aria-label="Choose model" aria-haspopup="listbox" aria-expanded={menu === 'model'} onClick={toggleModelMenu}><Glyph name="chip" size={17} /><span>{activeModel}</span><Glyph name="chevron" size={13} /></button>
            {menu === 'model' && <ul className="hd-menu" role="listbox" aria-label="Provider models">
              {catalogNote && <li className="hd-menu-note">{catalogNote}</li>}
              {models.map(entry => <li key={entry.id}><button type="button" role="option" aria-selected={entry.id === activeModel} onClick={() => chooseModel(entry.id)}><b>{entry.id}</b>{entry.ownedBy && <small>{entry.ownedBy}</small>}</button></li>)}
            </ul>}
          </div>
          <div className="hd-select">
            <button type="button" className="hd-tool hd-tool-think" aria-label="Thinking level" aria-haspopup="listbox" aria-expanded={menu === 'think'} onClick={() => setMenu(menu === 'think' ? null : 'think')}><Glyph name="mind" size={18} /><span>{thinkLevel}</span><Glyph name="chevron" size={13} /></button>
            {menu === 'think' && <ul className="hd-menu" role="listbox" aria-label="Thinking level">
              {THINK.map(level => <li key={level}><button type="button" role="option" aria-selected={level === thinkLevel} onClick={() => { setThinkLevel(level); setMenu(null) }}>{level}</button></li>)}
            </ul>}
          </div>
        </div>
        <button className="hd-send" type="submit" aria-label={generating ? 'Freya is thinking' : 'Send message'} disabled={!draft.trim() || generating}>{generating ? <span className="hd-send-orb" aria-hidden="true" /> : <Glyph name="send" size={20} />}</button>
      </form>{(notice || voiceNotice || generating) && <p className="hd-notice" role="status">{notice || voiceNotice || 'Freya is thinking…'}</p>}</footer>
      <button className="hd-chat-shortcut" onClick={onChat} aria-label="Open chat">HIGHER<br />CAPABILITIES<br />KINDER OUTCOMES<br />A BRIGHTER TOMORROW</button>
    </div></div>

  </div>
}
