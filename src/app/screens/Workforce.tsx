import { Card, Chip, Meter, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'
import office from '../../ui-v2/assets/office.webp'
import portrait from '../../ui-v2/assets/freya-portrait.webp'

/**
 * Workforce — render #5, 1:1 (the 3D office is a placeholder image for now).
 */

const TABS = ['Overview', 'Agents', 'Projects', 'Resources', 'Performance']

interface Agent { readonly name: string; readonly status: string; readonly detail: string; readonly tone: string }
const AGENTS: readonly Agent[] = [
  { name: 'Research Agent', status: 'Researching', detail: 'Market analysis · AI adoption trends for 2025', tone: 'intelligence' },
  { name: 'Strategy Agent', status: 'Planning', detail: 'Building Q2 growth strategy scenarios', tone: 'cognition' },
  { name: 'Content Studio', status: 'Creating', detail: 'Drafting partnership announcement', tone: 'positive' },
  { name: 'Coding Agent', status: 'Coding', detail: 'Implementing workspace memory layer', tone: 'intelligence' },
  { name: 'Operations Agent', status: 'Reviewing', detail: 'Checking system health and workflows', tone: 'attention' },
  { name: 'Audit Agent', status: 'Auditing', detail: 'Reviewing compliance and data integrity', tone: 'cognition' },
  { name: 'Communications Agent', status: 'Waiting', detail: 'Standing by for next task', tone: 'attention' },
]

const SUMMARY = [['Working', 8, '67%'], ['Reviewing', 2, '17%'], ['Waiting', 1, '8%'], ['Offline', 1, '8%']] as const
const MISSIONS = [['Phase 19 Product Roadmap', 4], ['Expand Global Reach', 3], ['Workspace Intelligence', 4], ['Strategic Partnerships', 2], ['Operational Excellence', 2], ['Positive Impact Initiatives', 3]] as const

const POS: readonly (readonly [number, number])[] = [[6, 10], [60, 6], [4, 38], [62, 34], [8, 66], [58, 62], [34, 82]]

export function Workforce(): ScreenSlots {
  return {
    left: null,
    right: null,
    layout: 'wide',
    centre: (
      <div className="wf-view">
        <div className="w-filters wf-tabs">{TABS.map((tab, index) => <button key={tab} type="button" className="w-filter" aria-pressed={index === 0}>{tab}</button>)}</div>
        <div className="wf-grid">
          <div className="wf-left"><h1>A kinder<br />smarter<br />tomorrow</h1></div>
          <div className="wf-office">
            <img className="wf-office-bg" src={office} alt="" aria-hidden="true" />
            <img className="wf-freya" src={portrait} alt="Freya" />
            {AGENTS.map((agent, index) => (
              <div key={agent.name} className="wf-agent" data-tone={agent.tone} style={{ left: `${POS[index]![0]}%`, top: `${POS[index]![1]}%` }}>
                <span className="wf-agent-dot" />
                <b>{agent.name}</b>
                <small>{agent.status}</small>
                <p>{agent.detail}</p>
              </div>
            ))}
          </div>
          <div className="wf-right">
            <Card title="Workforce summary" icon="workforce" subtitle="12 Active Agents">
              <div className="wf-summary">
                <div className="wf-ring"><span className="wf-ring-core"><b>12</b><span>Agents</span></span></div>
                <div className="c-bars">{SUMMARY.map(([label, value, pct]) => <div key={label} className="c-bar"><span>{label}</span><Meter value={Number(pct.replace('%', ''))} /><small>{value} · {pct}</small></div>)}</div>
              </div>
              <div className="wf-stats"><span><b>24</b> Tasks active</span><span><b>6</b> Missions linked</span><span><b>98%</b> Uptime</span></div>
            </Card>
            <Card title="Active agents" icon="people" subtitle="12 active">
              <div className="c-rows">{AGENTS.slice(0, 6).map((agent) => <Row key={agent.name} icon="workforce" title={agent.name} detail={agent.detail} end={<span className="c-state wf-status" data-tone={agent.tone}>{agent.status}</span>} />)}</div>
            </Card>
            <Card title="Mission linkage" icon="mission" subtitle="6 linked">
              <div className="c-rows">{MISSIONS.map(([title, count]) => <Row key={title} icon="mission" title={title} end={<Chip>{count} agents</Chip>} />)}</div>
            </Card>
          </div>
        </div>
      </div>
    ),
    bottom: null,
  }
}
