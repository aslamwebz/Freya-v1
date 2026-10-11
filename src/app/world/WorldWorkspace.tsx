import { Glyph } from '../../ui-v2/primitives/Glyph'
import { DailyDigestGoal } from './DailyDigestGoal'
import { WORLD_SECTIONS } from '../state/routes'
import { ContextTabs, WorkspaceFrame } from '../screens/WorkspaceFrame'
import './world.css'

const pages = {
  digest: { label: 'Daily digest', empty: 'No daily digest yet.', detail: 'Your daily briefing will bring together world events, tech news and product research from your selected sources.' },
  events: { label: 'World events', empty: 'No world events gathered yet.', detail: 'Follow global developments and the stories that matter to you.' },
  tech: { label: 'Tech news', empty: 'No tech news gathered yet.', detail: 'Track technology, AI, software and new releases in one place.' },
  research: { label: 'Product research', empty: 'No product research yet.', detail: 'Keep product discoveries, comparisons and research with links to their sources.' },
  sources: { label: 'Sources & schedules', empty: '', detail: '' },
} as const

/** News collection has no connected pipeline yet; these pages never schedule work. */
export function WorldWorkspace({ section, onNavigate }: { section: string; onNavigate: (path: string) => void }) {
  const page = pages[section as keyof typeof pages] ?? pages.digest
  return <WorkspaceFrame title="World" description="News, daily digests and product research." icon="world">
    <ContextTabs label="World sections" tabs={WORLD_SECTIONS.map(id => ({ id, label: pages[id].label }))}
      selected={section} onSelect={id => onNavigate(`world/${id}`)}>
      <div className="wn-status" role="status"><span className="wn-status-dot" aria-hidden="true" /><b>Collection is off</b><span>No news sources or collection schedules are configured.</span></div>
      {section === 'sources' ? <DailyDigestGoal onNavigate={onNavigate} /> : <section className="wn-reading-empty" aria-label={page.label}>
        <Glyph name={section === 'research' ? 'search' : 'world'} size={36} />
        <h2>{page.empty}</h2><p>{page.detail}</p>
        <button type="button" onClick={() => onNavigate('world/sources')}>View sources & schedules<Glyph name="arrow" size={16} /></button>
      </section>}
    </ContextTabs>
  </WorkspaceFrame>
}
