import type { ReactNode } from 'react'
import type { UiSnapshot } from '../../ui-v2/state/contract'
import { Clock } from '../../ui-v2/primitives/Clock'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { ready } from '../state/view'
import './home-widgets.css'

function Widget({ name, title, icon, badge, children }: { name: string; title: string; icon: string; badge?: string; children: ReactNode }) {
  return <section className={`hw-widget hw-${name}`} aria-labelledby={`hw-${name}-title`}>
    <header><Glyph name={icon} size={15} /><h2 id={`hw-${name}-title`}>{title}</h2>{badge && <span className="hw-badge">{badge}</span>}</header>
    {children}
  </section>
}

function WeatherSymbol() {
  return <svg className="hw-weather-symbol" viewBox="0 0 80 64" aria-hidden="true">
    <g className="hw-sun"><circle cx="49" cy="23" r="12" /><path d="M49 3V0M49 46V43M29 23H25M73 23H69M34 8 31 5M64 38 67 41M34 38 31 41M64 8 67 5" /></g>
    <path className="hw-cloud" d="M18 53h38a11 11 0 0 0 0-22h-2a17 17 0 0 0-32-3 13 13 0 0 0-4 25Z" />
  </svg>
}

/** Original Home-only information panels. No reference application code or assets. */
export function HomeWidgets({ snapshot, onNavigate }: { snapshot: UiSnapshot; onNavigate: (screen: string) => void }) {
  const home = ready(snapshot.home)
  const workforce = ready(snapshot.workforce)
  const missions = ready(snapshot.mission)
  const core = ready(snapshot.core)
  const activity = ready(snapshot.activity)
  const preview = snapshot.home.status === 'ready' && snapshot.home.source === 'preview'
  const workforcePreview = snapshot.workforce.status === 'ready' && snapshot.workforce.source === 'preview'
  const pending = missions?.rows.filter(row => row.needsAttention) ?? []
  const results = (activity ?? []).filter(row => row.tone === 'good').slice(0, 3)
  const progress = home?.focus?.progress
  return <>
    <aside className="hw-column hw-left" aria-label="Your day widgets">
      <Widget name="time" title="Your time" icon="life">
        <Clock />
        <div className="hw-time-foot"><span>LOCAL TIME</span><span>{Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')}</span></div>
      </Widget>
      <Widget name="weather" title="Weather" icon="world" badge="Sample">
        <div className="hw-weather-main"><div><span className="hw-location">London · preview</span><div className="hw-temperature">16<span>°</span></div></div><WeatherSymbol /></div>
        <div className="hw-weather-caption"><b>Partly cloudy</b><span>H 18° / L 11°</span></div>
        <div className="hw-weather-hours">{[['Now','16°'],['18:00','15°'],['19:00','14°'],['20:00','13°']].map(([hour,temp]) => <span key={hour}><small>{hour}</small><i /><b>{temp}</b></span>)}</div>
        <p className="hw-note">Weather preview · location not connected</p>
      </Widget>
      <Widget name="today" title="Today" icon="focus" badge={preview ? 'Sample' : undefined}>
        <div className="hw-today-line"><span className="hw-time-label">NOW</span><div><b>{home?.focus?.title ?? 'Choose your focus'}</b><p>{home?.focus?.detail ?? 'Your next priority will appear here.'}</p></div></div>
        <div className="hw-today-next"><span className="hw-tiny-dot" /><span>Calendar not connected</span></div>
      </Widget>
      <Widget name="mission" title="Current mission" icon="mission" badge={preview ? 'Sample' : undefined}>
        <p className="hw-mission-title">{home?.mission ?? 'No current mission'}</p>
        {progress != null && <div className="hw-progress-wrap"><div className="hw-progress" role="progressbar" aria-label="Current focus progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{width: `${Math.max(0, Math.min(100, progress))}%`}} /></div><b>{progress}%</b></div>}
        <button className="hw-link" onClick={() => onNavigate('focus')}>View mission <span>↗</span></button>
      </Widget>
    </aside>
    <aside className="hw-column hw-right" aria-label="Freya work widgets">
      <Widget name="agents" title="Agents" icon="workforce" badge={workforcePreview ? 'Sample' : undefined}>
        <div className="hw-agent-summary"><span><b>{workforce?.working ?? '—'}</b> working</span><span>{workforce?.total ?? '—'} in your team</span></div>
        <div className="hw-agent-list">{(workforce?.rows ?? []).slice(0, 4).map((worker, index) => <button key={worker.id} className="hw-agent" onClick={() => onNavigate('workforce')}>
          <span className="hw-avatar" data-variant={index % 4}><Glyph name={['search','mission','forge','activity'][index % 4]!} size={18} /><i /></span>
          <span className="hw-agent-words"><b>{worker.specialization ?? worker.id}</b><small>{worker.state}</small></span><span className="hw-agent-arrow">›</span>
        </button>)}</div>
        {!workforce?.rows.length && <p className="hw-empty">No agents reported yet.</p>}
        <button className="hw-link" onClick={() => onNavigate('workforce')}>View your team <span>↗</span></button>
      </Widget>
      <Widget name="attention" title="Needs your attention" icon="activity" badge={preview ? 'Sample' : undefined}>
        {pending.length || core?.faultCount ? <>
          {pending.length > 0 && <button className="hw-attention-item" onClick={() => onNavigate('focus')}><span className="hw-attention-marker">!</span><span><b>{pending.length} mission{pending.length === 1 ? '' : 's'} needs review</b><small>Open to see the next decision</small></span><span>›</span></button>}
          {!!core?.faultCount && <p className="hw-note">{core.faultCount} recorded system issue{core.faultCount === 1 ? '' : 's'}.</p>}
        </> : <p className="hw-empty">Nothing reported that needs your attention.</p>}
      </Widget>
      <Widget name="results" title="Recent results" icon="memory" badge={snapshot.activity.status === 'ready' && snapshot.activity.source === 'preview' ? 'Sample' : undefined}>
        <div className="hw-result-list">{results.map(row => <button key={row.id} className="hw-result" onClick={() => onNavigate('memory')}><span className="hw-result-check">✓</span><span><b>{row.text}</b><small>{new Date(row.at).toLocaleDateString('en-GB',{day:'numeric',month:'short'})} · Ready to review</small></span></button>)}</div>
        {!results.length && <p className="hw-empty">Completed work will appear here.</p>}
        <button className="hw-link" onClick={() => onNavigate('memory')}>View activity <span>↗</span></button>
      </Widget>
    </aside>
  </>
}
