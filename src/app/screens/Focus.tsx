import { Card, Chip, Meter, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'

/**
 * Focus — no dedicated render; built in the same language as Home/Mind.
 *
 * What Freya is concentrating on now: the current focus, the ordered priority
 * stack, attention and the boundaries that protect deep work. Sample data.
 */

const PRIORITIES = [
  { n: 1, title: 'Product Roadmap — Phase 19', detail: 'System architecture and go-to-market', value: 72 },
  { n: 2, title: 'Research Agent', detail: 'Monitoring AI & market updates', value: 48 },
  { n: 3, title: 'Creator Tools', detail: 'Human-centered creation tools', value: 36 },
  { n: 4, title: 'Community Growth', detail: 'Expand reach and early adopters', value: 24 },
] as const

const ATTENTION = [['Creative', 42], ['Strategic', 28], ['Communication', 18], ['Operations', 8], ['Misc', 4]] as const
const SESSIONS = [['Deep work', '3h 20m'], ['Meetings', '1h 10m'], ['Reflection', '25m'], ['Breaks', '40m']] as const
const NOW = [['Finalize architecture', 'Workspace design and go-to-market'], ['Researching model options', 'Comparing reasoning engines'], ['Drafting launch brief', 'Positioning and differentiators']] as const
const NEXT = [['Review design concepts', 'Today · 16:00'], ['Partner sync', 'Tomorrow · 10:00'], ['Community update', 'This week']] as const
const GUARD = [['Distractions muted', 'Notifications held during deep work'], ['Boundaries set', '2 windows kept out of focus'], ['Focus streak', '4 days of sustained work']] as const
const WEEK = [['Mon', 80], ['Tue', 65], ['Wed', 90], ['Thu', 72], ['Fri', 84], ['Sat', 30], ['Sun', 20]] as const

export function Focus(): ScreenSlots {
  return {
    left: (
      <>
        <Card title="Current focus" icon="focus" subtitle="72%">
          <h3 className="c-lead">Product Roadmap — Phase 19</h3>
          <p className="c-sub">Finalize system architecture, workspace design, and go-to-market plan.</p>
          <div className="c-focus-line"><Meter value={72} /><span>72%</span></div>
          <div className="c-chips"><Chip>Strategy</Chip><Chip>Product</Chip><Chip tone="accent">Launch</Chip></div>
        </Card>
        <Card title="Priority stack" icon="mission" subtitle="In order">
          <div className="c-rows">{PRIORITIES.map((priority) => (
            <div key={priority.n} className="c-focus-row">
              <span className="c-num">{priority.n}</span>
              <span className="c-row-text"><b>{priority.title}</b><small>{priority.detail}</small></span>
              <span className="c-focus-meter"><Meter value={priority.value} /><small>{priority.value}%</small></span>
            </div>
          ))}</div>
        </Card>
      </>
    ),
    right: (
      <>
        <Card title="Attention" icon="life" subtitle="Focused and aligned">
          <div className="c-attention"><div className="c-ring"><b>88<span>%</span></b></div>
            <div className="c-attention-info"><b>Deep Work</b><small>Focused and aligned</small></div></div>
          <div className="c-bars">{ATTENTION.map(([label, value]) => <div key={label} className="c-bar"><span>{label}</span><Meter value={value} /><small>{value}%</small></div>)}</div>
        </Card>
        <Card title="Focus sessions" icon="focus" subtitle="Today">
          <div className="c-rows">{SESSIONS.map(([label, value]) => <Row key={label} title={label} end={value} />)}</div>
        </Card>
      </>
    ),
    bottom: (
      <>
        <Card title="Now" icon="create" subtitle="What's happening" className="c-bottom-card">
          <div className="c-rows">{NOW.map(([title, detail]) => <Row key={title} icon="create" title={title} detail={detail} />)}</div>
        </Card>
        <Card title="Next up" icon="arrow" subtitle="What's coming" className="c-bottom-card">
          <div className="c-rows">{NEXT.map(([title, detail]) => <Row key={title} icon="mission" title={title} detail={detail} />)}</div>
        </Card>
        <Card title="Guarding focus" icon="settings" subtitle="Boundaries" className="c-bottom-card">
          <div className="c-rows">{GUARD.map(([title, detail]) => <div key={title} className="c-mini-row" data-tone="positive"><span className="c-mini-dot" /><span className="c-row-text"><b>{title}</b><small>{detail}</small></span></div>)}</div>
        </Card>
        <Card title="Rhythm" icon="life" subtitle="This week" className="c-bottom-card">
          <div className="c-bars">{WEEK.map(([label, value]) => <div key={label} className="c-bar"><span>{label}</span><Meter value={value} /><small>{value}%</small></div>)}</div>
        </Card>
      </>
    ),
  }
}
