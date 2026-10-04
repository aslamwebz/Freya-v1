import { Card, Meter, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'

/**
 * Life — render #4, 1:1.
 *
 * A continuous timeline with a glance, recent entries, themes and metrics.
 */

const TABS = ['Life / Timeline', 'Reflections', 'Milestones', 'Patterns', 'Growth']
const RANGES = ['Minute', 'Day', 'Week', 'Month', 'Year']

interface Event { readonly when: string; readonly date: string; readonly icon: string; readonly title: string; readonly detail: string }

/**
 * The two future entries that used to be here are gone, and that was the point.
 *
 * This list is Freya's own autobiography — the Life History domain, which records
 * what actually happened to her. It contained `{ when: 'Tomorrow', detail: 'Reached
 * 5,000 active users.' }` and a `'Further ahead'` entry dated ahead of the others.
 * An autobiography containing an event that has not happened is not sample data, it
 * is a false claim about the future, and it was rendered in the same visual language
 * as the real entries around it. Nothing else on this screen is as bad.
 *
 * The remaining rows are still sample content and are labelled as such below; a real
 * `LifeProjection` and a working `lifeClient` are already on the bridge, and wiring
 * them is what replaces these.
 *
 * The dates are also put in order now. The list read `Earlier · Mar 12` then
 * `Earlier · Apr 3`, followed by `Yesterday · Jan 26` — so "earlier" entries were
 * dated after the "yesterday" ones.
 */
const SAMPLE_PREFIX = 'Sample'
const EVENTS: readonly Event[] = [
  { when: 'Earlier', date: 'Jan 26', icon: 'relay', title: 'Conversation', detail: 'Deep talk with Alex about creativity.' },
  { when: 'Earlier', date: 'Jan 27', icon: 'world', title: 'Agent work', detail: 'Market analysis agent update.' },
  { when: 'Earlier', date: 'Mar 12', icon: 'memory', title: 'Memory formed', detail: 'Early conversation about purpose.' },
  { when: 'Earlier', date: 'Apr 3', icon: 'mission', title: 'Mission', detail: 'Global beta research phase.' },
  { when: 'Today', date: '08:14', icon: 'positive', title: 'Approval', detail: 'Workspace design plan approved.' },
  { when: 'Today', date: '11:42', icon: 'mission', title: 'Mission', detail: 'Built sustainable revenue model draft.' },
  { when: 'Today', date: '15:23', icon: 'memory', title: 'Memory formed', detail: 'Noted insight about team collaboration.' },
]

const GLANCE = [['Missions', 2], ['Conversations', 3], ['Agent Work', 2], ['Memories', 2], ['Approvals', 1], ['Important', 2]] as const
const THEMES = [['Growth', 92], ['Connection', 88], ['Impact', 76], ['Learning', 69], ['Creativity', 64]] as const
const METRICS = [['Conversations', '1,248'], ['Missions completed', '342'], ['Memories formed', '186'], ['Approvals', '92'], ['Major milestones', '17']] as const

export function Life(): ScreenSlots {
  return {
    sample: 'Life timeline — Freya’s own history is not connected yet.',
    left: null,
    right: null,
    layout: 'wide',
    presence: 'none',
    centre: (
      <div className="l-view">
        <div className="l-toolbar">
          <div className="w-filters">{TABS.map((tab, index) => <button key={tab} type="button" className="w-filter" aria-pressed={index === 0}>{tab}</button>)}</div>
          <div className="w-filters">{RANGES.map((range) => <button key={range} type="button" className="w-filter" aria-pressed={range === 'Day'}>{range}</button>)}<button type="button" className="w-filter">Jump to…</button></div>
        </div>
        <div className="l-title"><h1>My Life</h1><p className="c-sub">A continuous timeline of experiences, work, relationships, memories, and growth. Every moment shapes a brighter tomorrow.</p></div>
        <div className="l-timeline" data-sample={SAMPLE_PREFIX}>
          {/*
            Declared, not implied. This timeline is invented content until the Life
            projection is bound, and a person scrolling it has no other way to tell.
            `data-sample` is also what the truthfulness gate asserts, so removing this
            line without wiring a real projection fails a test.
          */}
          <div className="l-timeline-head">
            <p className="c-sample-note">Sample timeline — Freya's own history is not connected yet.</p>
            <span className="l-today">TODAY · Living and creating together</span>
          </div>
          <div className="l-events">
            <span className="l-line" aria-hidden="true" />
            {EVENTS.map((event, index) => (
              <article key={`${event.date}-${index}`} className="l-event" data-today={event.when === 'Today' || undefined}>
                <small>{event.when}</small>
                <span className="l-event-dot" aria-hidden="true" />
                <div className="l-card">
                  <span className="l-date">{event.date}</span>
                  <h4>{event.title}</h4>
                  <p>{event.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    ),
    bottom: (
      <>
        <Card title="Today at a glance" icon="life" className="c-bottom-card">
          <div className="l-glance"><div className="l-glance-ring"><b>12</b><span>Entries</span></div>
            <div className="c-rows">{GLANCE.map(([label, value]) => <div key={label} className="c-mini-row"><span className="c-mini-dot" /><span className="c-row-text"><b>{label}</b></span><span className="c-row-end">{value}</span></div>)}</div>
          </div>
        </Card>
        <Card title="Recent timeline entries" icon="memory" className="c-bottom-card">
          <div className="c-rows">
            <Row icon="memory" title="Memory formed" detail="Noted insight about team collaboration." end="15:23" />
            <Row icon="mission" title="Mission" detail="Built sustainable revenue model draft." end="11:42" />
            <Row icon="positive" title="Approval" detail="Workspace design plan approved." end="08:14" />
          </div>
        </Card>
        <Card title="A day of momentum" icon="core" className="c-bottom-card">
          <p className="c-sub">Progress on the roadmap, meaningful conversations, and a growing community. Steady steps toward a brighter tomorrow.</p>
        </Card>
        <Card title="Key themes today" icon="create" className="c-bottom-card">
          <div className="c-bars">{THEMES.map(([label, value]) => <div key={label} className="c-bar"><span>{label}</span><Meter value={value} /><small>{value}%</small></div>)}</div>
        </Card>
        <Card title="Life metrics" icon="world" className="c-bottom-card">
          <div className="c-rows">{METRICS.map(([label, value]) => <div key={label} className="c-mini-row"><span className="c-mini-dot" /><span className="c-row-text"><b>{value}</b><small>{label}</small></span></div>)}</div>
        </Card>
      </>
    ),
  }
}
