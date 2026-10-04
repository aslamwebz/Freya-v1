import type { ReactNode } from 'react'
import type { UiSnapshot } from '../../ui-v2/state/contract'
import { Card, Chip, Empty, Meter, Row } from '../cards/Card'
import { ready, reason } from '../state/view'

export interface ScreenSlots {
  readonly left: ReactNode
  readonly right: ReactNode
  readonly bottom: ReactNode
  /** A screen may replace the centre (a graph, a timeline, an office). */
  readonly centre?: ReactNode
  /** 'wide' spans the centre across the side columns. */
  readonly layout?: 'standard' | 'wide'
}

/** A small attention ring. A null value renders as an em dash, never a 0%. */
function Ring({ value }: { value: number | null }) {
  const pct = value === null ? 0 : Math.min(100, Math.max(0, value))
  return (
    <div className="c-ring" role="meter" aria-label="Attention" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="c-ring-track" cx="50" cy="50" r="42" />
        <circle className="c-ring-value" cx="50" cy="50" r="42" pathLength="100" strokeDasharray={`${pct} 100`} />
      </svg>
      <b>{value === null ? '—' : value}<span>{value === null ? '' : '%'}</span></b>
    </div>
  )
}

function FocusCard({ snapshot }: { snapshot: UiSnapshot }) {
  const home = ready(snapshot.home)
  const focus = home?.focus ?? null
  const tags = home?.attention.profiles.map((profile) => profile.id) ?? []
  return (
    <Card title="Current focus" icon="focus">
      {focus ? (
        <>
          <h3 className="c-lead">{focus.title}</h3>
          <p className="c-sub">{focus.detail}</p>
          <div className="c-focus-line"><Meter value={focus.progress} />{focus.progress !== null && <span>{focus.progress}%</span>}</div>
          {tags.length > 0 ? <div className="c-chips">{tags.map((tag) => <Chip key={tag}>{tag}</Chip>)}<Chip tone="accent">+</Chip></div> : null}
        </>
      ) : (
        <Empty title="No focus reported" detail={home ? 'Core has not described what it is doing.' : reason(snapshot.home)} />
      )}
    </Card>
  )
}

function MissionCard({ snapshot }: { snapshot: UiSnapshot }) {
  const home = ready(snapshot.home)
  return (
    <Card title="Mission" icon="mission">
      {home?.mission ? <h3 className="c-lead">{home.mission}</h3> : <Empty title="No Missions yet" detail="A Mission records what Freya is trying to accomplish." />}
      {home?.goals && home.goals.length > 0 ? (
        <ul className="c-checks">{home.goals.map((goal) => <li key={goal.id}><span className="c-check" aria-hidden="true">✓</span>{goal.text}</li>)}</ul>
      ) : null}
    </Card>
  )
}

function AttentionCard({ snapshot }: { snapshot: UiSnapshot }) {
  const home = ready(snapshot.home)
  const attention = ready(snapshot.attention)
  const profiles = home?.attention.profiles ?? []
  return (
    <Card title="Attention" icon="life" subtitle={home?.attention.caption}>
      {profiles.length > 0 ? (
        <div className="c-attention">
          <Ring value={profiles[0]!.focused} />
          <div className="c-attention-info"><b>{profiles[0]!.label}</b><small>Focused and aligned</small></div>
          <div className="c-bars">
            {home!.attention.categories.map((label, index) => (
              <div key={label} className="c-bar"><span>{label}</span><Meter value={profiles[0]!.distribution[index] ?? 0} /><small>{profiles[0]!.distribution[index] ?? 0}%</small></div>
            ))}
          </div>
        </div>
      ) : attention ? (
        <div className="c-bars">
          {([['Ingested', attention.ingested], ['Decisions', attention.decisions], ['Cued', attention.cued], ['Spoke', attention.spoke], ['Interrupted', attention.interrupted], ['Budget exceeded', attention.budgetExceeded]] as const).map(([label, value]) => (
            <div key={label} className="c-bar"><span>{label}</span><Meter value={Math.min(100, value)} /><small>{value}</small></div>
          ))}
          <p className="c-sub">{attention.inboxCount} in the attention inbox.</p>
        </div>
      ) : (
        <Empty title="Attention not reporting" detail={reason(snapshot.attention)} />
      )}
    </Card>
  )
}

function PeopleCard({ snapshot }: { snapshot: UiSnapshot }) {
  const home = ready(snapshot.home)
  if (!home?.people || home.people.length === 0) {
    return <Card title="People" icon="people"><Empty title="Not connected" detail="No People projection exists yet." /></Card>
  }
  return (
    <Card title="People" icon="people" subtitle="Key people">
      <div className="c-avatars">{home.people.slice(0, 4).map((person) => <span key={person.id} className="c-avatar" aria-hidden="true">{person.name.slice(0, 1)}</span>)}{(home.morePeople ?? 0) > 0 ? <span className="c-avatar c-avatar-more">+{home.morePeople}</span> : null}</div>
      <div className="c-people-stats">
        <span>◧ {home.messages ?? 0} new messages</span>
        <span>◑ {home.followUps ?? 0} follow-up today</span>
        <span>◒ {home.meetingPrep ?? 0} meeting prep items</span>
      </div>
    </Card>
  )
}

function WorkforceCard({ snapshot }: { snapshot: UiSnapshot }) {
  const workforce = ready(snapshot.workforce)
  return (
    <Card title="Workforce" icon="workforce" subtitle={workforce ? `${workforce.total} reported` : undefined}>
      {workforce && workforce.rows.length > 0 ? (
        <div className="c-rows">{workforce.rows.map((row, index) => (
          <Row key={row.id} icon={['relay', 'world', 'mission', 'create'][index % 4]!} title={row.specialization ?? row.id} detail={row.state} end={<span className={`c-state c-state--${row.state.toLowerCase()}`}>{row.state}</span>} />
        ))}</div>
      ) : (
        <Empty title="No active team" detail={workforce ? 'Core reports no workers.' : reason(snapshot.workforce)} />
      )}
    </Card>
  )
}

function WorldCard({ snapshot }: { snapshot: UiSnapshot }) {
  const home = ready(snapshot.home)
  return (
    <Card title="World" icon="world">
      {home?.world && home.world.length > 0 ? (
        <div className="c-world">
          <div className="c-globe" aria-hidden="true"><span /></div>
          <div className="c-rows">{home.world.slice(0, 4).map((item) => <Row key={item.id} icon={item.icon} title={item.title} detail={item.detail} />)}</div>
        </div>
      ) : (
        <Empty title="World not connected" detail="No World projection exists yet." />
      )}
    </Card>
  )
}

function MemoryCard({ snapshot }: { snapshot: UiSnapshot }) {
  const events = ready(snapshot.activity)
  return (
    <Card title="Recent activity" icon="memory">
      {events && events.length > 0 ? (
        <div className="c-rows">{[...events].sort((a, b) => b.at - a.at).slice(0, 4).map((event, index) => (
          <Row key={event.id} icon={['memory', 'mission', 'relay', 'world'][index % 4]!} title={event.text} end={new Date(event.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} />
        ))}</div>
      ) : (
        <Empty title="No activity yet" detail={events ? 'Core activity will appear here.' : reason(snapshot.activity)} />
      )}
    </Card>
  )
}

export function Home({ snapshot }: { snapshot: UiSnapshot }): ScreenSlots {
  return {
    left: <><FocusCard snapshot={snapshot} /><MissionCard snapshot={snapshot} /></>,
    right: <><AttentionCard snapshot={snapshot} /><PeopleCard snapshot={snapshot} /><WorkforceCard snapshot={snapshot} /></>,
    bottom: [<WorldCard key="world" snapshot={snapshot} />, <MemoryCard key="activity" snapshot={snapshot} />],
  }
}
