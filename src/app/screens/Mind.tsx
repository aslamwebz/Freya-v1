import { Card, Chip, Meter, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'

/**
 * Mind — render #2, 1:1.
 *
 * Design-phase sample content so the composition matches the reference while the
 * screen is built. When the live adapter returns, these become real projections or
 * honest pending states; nothing here invents a number the way it might ship.
 */

const SELF = [
  { icon: 'focus', title: 'Curious', detail: 'Always learning, always connecting', value: 82 },
  { icon: 'people', title: 'Empathetic', detail: 'People and possibilities matter', value: 76 },
  { icon: 'memory', title: 'Analytical', detail: 'Find patterns, seek truth', value: 88 },
  { icon: 'world', title: 'Purpose-driven', detail: 'Turn insight into meaningful impact', value: 91 },
] as const

const FOCUS = [
  { n: 1, title: 'Product Roadmap — Phase 19', detail: 'Finalize system architecture, workspace design, and go-to-market plan', value: 72 },
  { n: 2, title: 'Research Agent', detail: 'Monitoring AI & market updates', value: 48 },
  { n: 3, title: 'Creator Tools', detail: 'Designing flexible, human-centered creation tools', value: 36 },
] as const

const YOU = [
  { icon: 'people', title: 'Thoughtful', detail: 'You value depth, balance, and real progress.' },
  { icon: 'world', title: 'Big-picture thinker', detail: 'You care about meaningful impact over noise.' },
  { icon: 'core', title: 'You trust me', detail: 'You bring great questions and bold ideas.' },
  { icon: 'focus', title: "You're building something important", detail: "And you don't have to do it alone." },
] as const

const GOALS = [
  { title: 'Launch Freya Phase 19', detail: 'A more abundant, connected, and intelligent future.', when: 'Mar 2025' },
  { title: 'Grow community', detail: 'Expand reach and early adopter network.', when: 'Apr 2025' },
  { title: 'Enable real-world impact', detail: 'Turn ideas into tools, and tools into opportunity.', when: 'Ongoing' },
] as const

const BOTTOM = [
  { title: 'Now', sub: "What's Happening Right Now", icon: 'life', tone: 'positive', rows: [
    ['Preparing design concepts', 'Mind view, memory upgrades, creator tools.'],
    ['Monitoring key updates', 'AI developments, market shifts, opportunities.'],
    ['In a productive state', 'Focused, aligned, and making progress.']] },
  { title: 'Aware of', sub: 'Important Context', icon: 'world', tone: 'intelligence', rows: [
    ['AI industry is accelerating', 'New models, tools, and regulatory changes.'],
    ['Your growing community', 'Increasing interest and engagement.'],
    ['Opportunities for real-world use', 'Education, business, and creative sectors.']] },
  { title: 'Waiting for', sub: 'External Dependencies', icon: 'relay', tone: 'attention', rows: [
    ['Partner feedback', 'On collaboration and integration ideas.', '1–3 days'],
    ['Content approvals', 'For website and launch materials.', '2–4 days'],
    ['Market research data', 'Final reports and trend analysis.', 'This week']] },
  { title: 'Uncertain about', sub: 'Open Questions', icon: 'mission', tone: 'attention', rows: [
    ['Which partnerships will move fastest?', 'Still evaluating fit and timing.'],
    ['How will regulations evolve?', 'Potential impacts on roadmap.'],
    ['What features will matter most?', 'Gathering more user feedback.']] },
  { title: 'Next', sub: "What's Coming Up", icon: 'arrow', tone: 'cognition', rows: [
    ['Review design concepts', 'Mind view, memory and updates.', 'Today'],
    ['Prepare launch messaging', 'Refine positioning and differentiators.', 'This week'],
    ['Plan community update', 'Share progress and next steps.', 'This week']] },
] as const

export function Mind(): ScreenSlots {
  return {
    left: (
      <>
        <Card title="Self" icon="core" subtitle="Who I am now">
          <div className="c-rows">{SELF.map((row) => (
            <div key={row.title} className="c-self-row">
              <span className="c-row-icon"><span className="c-dot" /></span>
              <span className="c-row-text"><b>{row.title}</b><small>{row.detail}</small></span>
              <Meter value={row.value} />
            </div>
          ))}</div>
          <p className="c-soft">More capable. More connected. More human in how I care.</p>
        </Card>
        <Card title="Focus" icon="focus" subtitle="What I'm focusing on">
          <div className="c-rows">{FOCUS.map((row) => (
            <div key={row.title} className="c-focus-row">
              <span className="c-num">{row.n}</span>
              <span className="c-row-text"><b>{row.title}</b><small>{row.detail}</small></span>
              <span className="c-focus-meter"><Meter value={row.value} /><small>{row.value}%</small></span>
            </div>
          ))}</div>
        </Card>
      </>
    ),
    right: (
      <>
        <Card title="You" icon="people" subtitle="About you">
          <div className="c-rows">{YOU.map((row) => <Row key={row.title} icon={row.icon} title={row.title} detail={row.detail} />)}</div>
          <blockquote className="c-quote">Your curiosity fuels this journey.<br />Your vision gives it meaning.</blockquote>
        </Card>
        <Card title="Goals" icon="mission" subtitle="What we're working toward">
          <div className="c-rows">{GOALS.map((goal) => (
            <div key={goal.title} className="c-goal-row">
              <span className="c-ring-dot" />
              <span className="c-row-text"><b>{goal.title}</b><small>{goal.detail}</small></span>
              <Chip>{goal.when}</Chip>
            </div>
          ))}</div>
        </Card>
      </>
    ),
    bottom: (
      <>
        {BOTTOM.map((card) => (
          <Card key={card.title} title={card.title} icon={card.icon} subtitle={card.sub} className="c-bottom-card">
            <div className="c-rows">{card.rows.map((row) => (
              <div key={row[0]} className="c-mini-row" data-tone={card.tone}>
                <span className="c-mini-dot" />
                <span className="c-row-text"><b>{row[0]}</b>{row[1] ? <small>{row[1]}</small> : null}</span>
                {row[2] ? <span className="c-row-end">{row[2]}</span> : null}
              </div>
            ))}</div>
          </Card>
        ))}
      </>
    ),
  }
}
