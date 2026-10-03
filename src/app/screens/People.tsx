import { Card, Chip, Meter, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'

/**
 * People — no dedicated render; built in the same language as World.
 *
 * Freya's relationships: a directory of people, the selected person's context
 * and relationship health, and the circles they belong to. Sample data.
 */

interface Person { readonly initial: string; readonly name: string; readonly role: string; readonly when: string }
const PEOPLE: readonly Person[] = [
  { initial: 'S', name: 'Sarah Chen', role: 'Product Lead · Freya Labs', when: '2h ago' },
  { initial: 'A', name: 'Alex Morgan', role: 'Creative Director · Studio North', when: 'Yesterday' },
  { initial: 'E', name: 'Elena Cruz', role: 'Partnerships · Cedar Capital', when: 'Yesterday' },
  { initial: 'M', name: 'Marcus Lee', role: 'Engineering · Aurora Labs', when: '2d ago' },
  { initial: 'J', name: 'Jordan Kim', role: 'Head of Product · Aurora Labs', when: '3d ago' },
]

const HEALTH = [['Trust', 92], ['Recency', 78], ['Shared work', 64], ['Reciprocity', 80]] as const
const CIRCLES = [['Core team', 6], ['Collaborators', 12], ['Advisors', 5], ['Community', 240]] as const
const INTERACTIONS = [['Sarah Chen', 'Reviewed the launch plan', '2h ago'], ['Alex Morgan', 'Shared brand direction', 'Yesterday'], ['Elena Cruz', 'Introduced a partner', 'Yesterday'], ['Marcus Lee', 'Discussed infrastructure', '2d ago']] as const

export function People(): ScreenSlots {
  return {
    left: (
      <Card title="People" icon="people" subtitle="18 connected">
        <div className="pp-list">{PEOPLE.map((person, index) => (
          <button key={person.name} type="button" className="pp-person" data-active={index === 0} aria-current={index === 0 ? 'true' : undefined}>
            <span className="c-avatar">{person.initial}</span>
            <span className="c-row-text"><b>{person.name}</b><small>{person.role}</small></span>
            <span className="c-row-end">{person.when}</span>
          </button>
        ))}</div>
      </Card>
    ),
    right: (
      <>
        <Card title="Person" icon="people" subtitle="Online">
          <div className="w-person-head"><span className="c-avatar w-person-avatar">S</span>
            <div><h3 className="c-lead">Sarah Chen</h3><p className="c-sub">Product Lead · Freya Labs</p></div></div>
          <div className="c-chips"><Chip tone="accent">Key collaborator</Chip><Chip>High trust</Chip><Chip>Strategic</Chip></div>
          <blockquote className="c-quote">Thoughtful builder with a rare ability to see both the human and technical sides.</blockquote>
          <div className="c-rows">
            <Row title="Location" detail="San Francisco, CA" />
            <Row title="Timezone" detail="PST (UTC−8)" />
            <Row title="Relationship" detail="Collaborator · High trust" />
            <Row title="Shared context" detail="12 projects · 248 conversations" />
          </div>
        </Card>
        <Card title="Relationship health" icon="life" subtitle="Strong">
          <div className="c-bars">{HEALTH.map(([label, value]) => <div key={label} className="c-bar"><span>{label}</span><Meter value={value} tone="positive" /><small>{value}%</small></div>)}</div>
        </Card>
      </>
    ),
    bottom: (
      <>
        <Card title="Recent interactions" icon="relay" subtitle="This week" className="c-bottom-card">
          <div className="c-rows">{INTERACTIONS.map(([name, detail, when]) => <Row key={name} icon="people" title={name} detail={detail} end={when} />)}</div>
        </Card>
        <Card title="Circles" icon="world" subtitle="Where they belong" className="c-bottom-card">
          <div className="c-rows">{CIRCLES.map(([label, count]) => <div key={label} className="c-mini-row"><span className="c-mini-dot" /><span className="c-row-text"><b>{label}</b></span><span className="c-row-end">{count}</span></div>)}</div>
        </Card>
        <Card title="Growing network" icon="create" subtitle="Momentum" className="c-bottom-card">
          <div className="c-bars"><div className="c-bar"><span>New connections</span><Meter value={72} /><small>6</small></div><div className="c-bar"><span>Follow-ups due</span><Meter value={40} tone="positive" /><small>3</small></div><div className="c-bar"><span>Introductions</span><Meter value={20} /><small>1</small></div></div>
        </Card>
      </>
    ),
  }
}
