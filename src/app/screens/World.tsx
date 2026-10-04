import { Card, Chip, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'

/**
 * World — render #3, 1:1.
 *
 * A knowledge graph around Freya with a selected-entity panel. Sample data for
 * the design phase; a live build would bind the clusters to real projections and
 * the panel to a real entity.
 */

const FILTERS = ['All', 'People', 'Projects', 'Organizations', 'Places', 'Devices', 'Conversations', 'Missions']

interface Cluster {
  readonly id: string
  readonly label: string
  readonly count: string
  readonly x: number
  readonly y: number
  readonly icon: string
  readonly items: readonly string[]
}

const CENTRE = { x: 500, y: 320 }
const CLUSTERS: readonly Cluster[] = [
  { id: 'people', label: 'People', count: '24 connections', x: 170, y: 150, icon: 'people', items: ['Sarah Chen', 'Alex Morgan', 'Elena Cruz'] },
  { id: 'projects', label: 'Projects', count: '12 active · 4 archived', x: 790, y: 150, icon: 'mission', items: ['Product Roadmap', 'Workspace OS', 'Global Impact'] },
  { id: 'organizations', label: 'Organizations', count: '6 connected', x: 840, y: 400, icon: 'world', items: ['Freya Labs', 'OpenMind Initiative', 'Cedar Capital'] },
  { id: 'conversations', label: 'Conversations', count: '1,243 total', x: 150, y: 400, icon: 'relay', items: ['Strategy sync', 'Partnership idea', 'Research discussion'] },
  { id: 'devices', label: 'Devices', count: '5 connected', x: 210, y: 570, icon: 'core', items: ['MacBook Pro', 'iPhone 15 Pro', 'Home Hub'] },
  { id: 'places', label: 'Places', count: '8 locations', x: 500, y: 590, icon: 'world', items: ['San Francisco', 'Lisbon'] },
  { id: 'missions', label: 'Missions', count: '4 active', x: 800, y: 570, icon: 'mission', items: ['Global beta expansion', 'Sustainable revenue engine', 'AI for social good'] },
]

function Graph() {
  return (
    <svg className="w-graph" viewBox="0 0 1000 680" role="img" aria-label="World graph">
      {CLUSTERS.map((cluster) => (
        <line key={cluster.id} className="w-edge" x1={CENTRE.x} y1={CENTRE.y} x2={cluster.x} y2={cluster.y} />
      ))}
      {CLUSTERS.map((cluster) => (
        <g key={cluster.id} className="w-cluster" data-id={cluster.id}>
          <circle className="w-node" cx={cluster.x} cy={cluster.y} r="26" />
          <text className="w-node-label" x={cluster.x} y={cluster.y - 42}>{cluster.label}</text>
          <text className="w-node-count" x={cluster.x} y={cluster.y + 46}>{cluster.count}</text>
          {cluster.items.map((item, index) => (
            <text key={item} className="w-node-item" x={cluster.x} y={cluster.y + 64 + index * 14}>{item}</text>
          ))}
        </g>
      ))}
    </svg>
  )
}

function PersonPanel() {
  return (
    <Card title="Person" icon="people" className="w-person" subtitle="Online">
      <div className="w-person-head">
        <span className="c-avatar w-person-avatar">S</span>
        <div><h3 className="c-lead">Sarah Chen</h3><p className="c-sub">Product Lead · Freya Labs</p></div>
      </div>
      <div className="c-chips"><Chip tone="accent">Key collaborator</Chip><Chip>High trust</Chip><Chip>Strategic</Chip></div>
      <div className="w-tabs"><span data-active="true">Overview</span><span>Connections</span><span>Activity</span><span>Insights</span></div>
      <blockquote className="c-quote">Thoughtful builder with a rare ability to see both the human and technical sides.</blockquote>
      <div className="c-rows">
        <Row title="Role" detail="Product Lead" />
        <Row title="Organization" detail="Freya Labs" />
        <Row title="Location" detail="San Francisco, CA" />
        <Row title="Timezone" detail="PST (UTC−8)" />
        <Row title="Relationship" detail="Collaborator · High trust" />
        <Row title="Shared context" detail="12 projects · 248 conversations" />
      </div>
      <div className="f-settings-actions"><Chip tone="accent">Open in People</Chip><Chip>Start Conversation</Chip></div>
      <div className="c-rows">
        <Row icon="mission" title="Product Roadmap" detail="Collaborates on · On track" />
        <Row icon="core" title="Workspace OS" detail="Co-lead · In development" />
        <Row icon="world" title="Global beta expansion" detail="Shared mission · On track" />
      </div>
    </Card>
  )
}

export function World(): ScreenSlots {
  return {
    left: null,
    right: null,
    layout: 'wide',
    centre: (
      <div className="w-view">
        <div className="w-toolbar">
          <div className="w-filters">{FILTERS.map((filter) => <button key={filter} type="button" className="w-filter" aria-pressed={filter === 'All'}>{filter}</button>)}</div>
          <div className="w-filters"><button type="button" className="w-filter">Filters (2)</button><button type="button" className="w-filter" aria-pressed>Graph</button><button type="button" className="w-filter">Map</button></div>
        </div>
        <div className="w-main">
          <Graph />
          <PersonPanel />
        </div>
      </div>
    ),
    bottom: (
      <Card title="World model" icon="world" className="w-stats">
        <div className="w-stats-row"><span><b>1,842</b> Nodes</span><span><b>6,391</b> Relationships</span><span className="c-state--working">Live Sync</span></div>
      </Card>
    ),
  }
}
