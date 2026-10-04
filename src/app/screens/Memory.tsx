import { Card, Meter, Row } from '../cards/Card'
import type { ScreenSlots } from './Home'

/**
 * Memory — no dedicated render; built in the same language as Life.
 *
 * A record of what Freya has formed: recent memories, the shape of the store,
 * recall health and the entries that need a second look. Sample data.
 */

const CATEGORIES = [['Conversations', 1248], ['Decisions', 342], ['People', 186], ['Projects', 92], ['Insights', 57]] as const

const MEMORIES = [
  { icon: 'memory', title: 'Product strategy review completed', when: '2h ago', tone: 'positive' },
  { icon: 'create', title: 'Drafted the Phase 19 launch plan', when: '4h ago', tone: 'cognition' },
  { icon: 'relay', title: 'Spoke with Alex about a partnership idea', when: '6h ago', tone: '' },
  { icon: 'world', title: 'Researched EU AI regulatory updates', when: '12h ago', tone: '' },
  { icon: 'focus', title: 'Created visual concepts for the new workspace', when: '1d ago', tone: '' },
  { icon: 'mission', title: 'Committed to a sustainable revenue model', when: '2d ago', tone: 'cognition' },
] as const

const HEALTH = [['Recall', 94], ['Connections', 88], ['Recency', 82], ['Precision', 90]] as const
const INSIGHTS = ['Growth comes from steady, visible progress.', 'You prefer depth over breadth in work.', 'Partnerships matter more than reach.'] as const
const REVIEW = [['Duplicate memory detected', 'Merge two similar decisions'], ['Stale person record', 'Alex Morgan · role changed?'], ['Unverified fact', 'A market figure with no source']] as const

export function Memory(): ScreenSlots {
  return {
    sample: 'Memory composition — the Brain has not reported any memories.',
    left: (
      <Card title="Memory" icon="memory" subtitle="Stored and recallable">
        <div className="l-glance">
          <div className="l-glance-ring"><b>1,925</b><span>Entries</span></div>
          <div className="c-rows">{CATEGORIES.map(([label, value]) => <div key={label} className="c-mini-row"><span className="c-mini-dot" /><span className="c-row-text"><b>{label}</b></span><span className="c-row-end">{value.toLocaleString()}</span></div>)}</div>
        </div>
      </Card>
    ),
    right: (
      <>
        <Card title="Memory health" icon="life" subtitle="Recallable">
          <div className="c-bars">{HEALTH.map(([label, value]) => <div key={label} className="c-bar"><span>{label}</span><Meter value={value} /><small>{value}%</small></div>)}</div>
        </Card>
        <Card title="Recall" icon="search" subtitle="Ask memory">
          <div className="fd-ask"><input aria-label="Search memory" placeholder="Search memories…" /></div>
          <div className="c-rows">{INSIGHTS.map((insight) => <Row key={insight} icon="focus" title={insight} />)}</div>
        </Card>
      </>
    ),
    bottom: (
      <>
        <Card title="Recent memory" icon="memory" subtitle="Latest" className="c-bottom-card">
          <div className="c-rows">{MEMORIES.slice(0, 4).map((memory) => <Row key={memory.title} icon={memory.icon} title={memory.title} end={memory.when} />)}</div>
        </Card>
        <Card title="Key insights" icon="create" subtitle="What recurs" className="c-bottom-card">
          <div className="c-rows">{MEMORIES.slice(2).map((memory) => <div key={memory.title} className="c-mini-row" data-tone={memory.tone || undefined}><span className="c-mini-dot" /><span className="c-row-text"><b>{memory.title}</b><small>{memory.when}</small></span></div>)}</div>
        </Card>
        <Card title="Needs review" icon="attention" subtitle="Open questions" className="c-bottom-card">
          <div className="c-rows">{REVIEW.map(([title, detail]) => <div key={title} className="c-mini-row" data-tone="attention"><span className="c-mini-dot" /><span className="c-row-text"><b>{title}</b><small>{detail}</small></span></div>)}</div>
        </Card>
      </>
    ),
  }
}
