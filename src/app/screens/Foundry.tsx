import { Card, Chip } from '../cards/Card'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import type { ScreenSlots } from './Home'
import portrait from '../../ui-v2/assets/freya-portrait.webp'

/**
 * Foundry — render #6, 1:1.
 *
 * Ideas move along one pipeline: Idea → Specification → Prototype → Evaluation
 * → Capability. The bottom shelf lists what has already been made. Sample data
 * for the design phase; a live build would bind this to real Foundry records.
 */

const STATS = [['Ideas', 27], ['In Build', 12], ['Evaluating', 6], ['Deployed', 14]] as const

const ASSIST = ['Build a research agent', 'Create a data tool', 'Design a team skill', 'Automate a workflow', 'Make a knowledge app', 'Explore an idea'] as const

interface Stage { readonly n: number; readonly title: string; readonly detail: string; readonly items: readonly string[]; readonly icon: string }
const STAGES: readonly Stage[] = [
  { n: 1, title: 'Idea', detail: 'Capture and shape the opportunity.', icon: 'create', items: ['User need', 'Problem statement', 'Initial concept', 'Impact potential'] },
  { n: 2, title: 'Specification', detail: 'Define goals, scope and requirements.', icon: 'mission', items: ['Functionality & scope', 'Data & integrations', 'Success criteria', 'Design approach'] },
  { n: 3, title: 'Prototype', detail: 'Build and iterate with Freya.', icon: 'forge', items: ['Generate components', 'Configure & integrate', 'Iterate with feedback', 'Prepare for testing'] },
  { n: 4, title: 'Evaluation', detail: 'Test, validate and measure.', icon: 'focus', items: ['Performance & quality', 'Safety & alignment', 'User feedback', 'Refine and optimize'] },
  { n: 5, title: 'Capability', detail: 'Deploy and make it part of Freya.', icon: 'core', items: ["Add to Freya's ecosystem", 'Enable for teams', 'Monitor and improve', 'Drive real-world impact'] },
]

const CREATION_TABS = ['Tools', 'Skills', 'Apps', 'Agents', 'Workflows', 'Ideas']

interface Creation { readonly kind: string; readonly name: string; readonly detail: string; readonly status: string; readonly meta: string; readonly icon: string }
const CREATIONS: readonly Creation[] = [
  { kind: 'App', name: 'Market Intelligence Studio', detail: 'Research, analyze and generate executive briefings on market trends.', status: 'Deployed', meta: '+3', icon: 'world' },
  { kind: 'Agent', name: 'Research Agent', detail: 'Autonomous research and synthesis across trusted sources.', status: 'In Evaluation', meta: 'v0.9', icon: 'workforce' },
  { kind: 'Tool', name: 'Data Insight Builder', detail: 'Turn data into visual insights and narratives.', status: 'In Build', meta: 'v0.3', icon: 'forge' },
  { kind: 'Skill', name: 'Strategic Planning', detail: 'Long-range scenario analysis and opportunity mapping.', status: 'Deployed', meta: 'v1.0', icon: 'create' },
  { kind: 'Workflow', name: 'Content Studio', detail: 'Plan, create and publish multi-channel content.', status: 'In Build', meta: 'v0.4', icon: 'relay' },
]

const statusClass = (status: string) => (status === 'Deployed' ? 'c-state--working' : status === 'In Build' || status === 'In Evaluation' ? 'c-state--waiting' : 'c-state--idle')

export function Foundry(): ScreenSlots {
  return {
    left: null,
    right: null,
    layout: 'wide',
    centre: (
      <div className="fd-view">
        <div className="fd-hero">
          <Card title="Foundry" icon="forge" className="fd-intro">
            <h3 className="c-lead">Design. Build. Test. Deploy.</h3>
            <p className="c-sub">Turn ideas into real capabilities — tools, skills, and apps that expand what Freya and your teams can do.</p>
            <div className="fd-stats">{STATS.map(([label, value]) => <span key={label}><b>{value}</b> {label}</span>)}</div>
            <button type="button" className="fd-new"><Glyph name="plus" size={16} /> New Capability</button>
          </Card>
          <div className="fd-portrait" aria-hidden="true">
            <span className="fd-arc fd-arc-top">IMAGINE</span>
            <span className="fd-arc fd-arc-left">COMPOSE</span>
            <span className="fd-arc fd-arc-right">REFINE</span>
            <span className="fd-arc fd-arc-bl">TEST</span>
            <span className="fd-arc fd-arc-br">DEPLOY</span>
            <img src={portrait} alt="" />
            <div className="fd-portrait-caption"><b>FREYA</b><span>YOUR CREATION PARTNER</span><small>IDEAS → CAPABILITIES → IMPACT</small></div>
          </div>
          <Card title="Creation assistant" icon="create" className="fd-assist">
            <p className="c-lead">Describe what you want to build…</p>
            <p className="c-sub">I'll help you turn it into a working capability.</p>
            <form className="fd-ask" onSubmit={(event) => event.preventDefault()}>
              <input aria-label="Describe what you want to build" placeholder={'e.g. "A tool to analyze market trends and create briefings…"'} />
              <button type="submit" aria-label="Send to Foundry"><Glyph name="arrow" size={18} /></button>
            </form>
            <div className="c-chips">{ASSIST.map((chip) => <Chip key={chip}>{chip}</Chip>)}</div>
          </Card>
        </div>

        <div className="fd-stages">
          {STAGES.map((stage) => (
            <article key={stage.title} className="fd-stage">
              <header><span className="fd-stage-num">{stage.n}</span><span className="fd-stage-icon"><Glyph name={stage.icon} size={18} /></span></header>
              <h4>{stage.title}</h4>
              <p>{stage.detail}</p>
              <div className="fd-stage-visual" data-n={stage.n} aria-hidden="true" />
              <ul>{stage.items.map((item) => <li key={item}><span aria-hidden="true">✓</span>{item}</li>)}</ul>
            </article>
          ))}
        </div>

        <Card title="My creations" icon="core" className="fd-creations">
          <div className="fd-create-bar">
            <div className="w-filters">{CREATION_TABS.map((tab, index) => <button key={tab} type="button" className="w-filter" aria-pressed={index === 0}>{tab}</button>)}</div>
            <div className="fd-create-tools">
              <span className="fd-search">Search creations…</span>
              <Chip>Filter</Chip>
              <Chip>Sort: Recent</Chip>
            </div>
          </div>
          <div className="fd-cards">
            {CREATIONS.map((creation) => (
              <article key={creation.name} className="fd-card">
                <div className="fd-card-head"><Chip tone="accent">{creation.kind}</Chip><span className="c-more" aria-hidden="true">•••</span></div>
                <h4>{creation.name}</h4>
                <p>{creation.detail}</p>
                <div className="fd-card-foot"><span className={`c-state ${statusClass(creation.status)}`}>{creation.status}</span><span className="fd-card-meta">{creation.meta}</span></div>
              </article>
            ))}
          </div>
        </Card>
      </div>
    ),
    bottom: null,
  }
}
