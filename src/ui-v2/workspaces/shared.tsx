import type { ReactNode } from 'react'
import { uiMode, type Resource, type UiSnapshot } from '../state/contract'
import { Badge, Button, EmptyState } from '../primitives/Controls'
import { Glyph } from '../primitives/Glyph'
import type { PreferencesStore } from '../theme/preferences'
export { Compass } from './Presence'
import type { ViewState } from './viewState'

export interface WorkspaceProps {
  readonly snapshot: UiSnapshot; readonly view: ViewState; readonly update: (patch: Partial<ViewState>) => void
  /** The appearance store, present in the live shell. Absent in a bare component test. */
  readonly preferences?: PreferencesStore
}

/**
 * The truthful rendering of a workspace whose domain is not yet wired to a live Core.
 *
 * Phase 19 shipped these surfaces as a finished *concept design* — sample entities,
 * conversations and history that exist only as art. In a browser that is correct and is
 * labelled as a design preview. In a live desktop window it would be a lie: the owner
 * would read sample people and sample conversations as Freya's real world. So a live
 * window replaces the concept art with this state and says plainly that the domain is
 * not wired yet, while a preview window keeps the finished design untouched.
 *
 * It carries no data and invents nothing. It is the visual-compatible "pending" the
 * integration plan requires, and it is the only thing a static workspace shows in live
 * mode.
 */
export function PendingView({ title, detail }: { title: string; detail: string }) {
  return <div className="f-pending"><EmptyState title={title} detail={detail} /></div>
}

/** Whether this window is a live desktop window rather than a design preview. */
export function isLiveMode(snapshot: UiSnapshot): boolean {
  return uiMode(snapshot) === 'live'
}
export function Filters({ options, selected, onSelect }: { options: readonly string[]; selected: string; onSelect: (value: string) => void }) {
  return <div className="f-filters" aria-label="View filters">{options.map((option) =>
    <Button key={option} aria-pressed={selected === option} onClick={() => onSelect(option)}>{option}</Button>)}</div>
}
export function DataView<T>({ resource, empty, children }: { resource: Resource<T>; empty: string; children: (data: T) => ReactNode }) {
  if (resource.status === 'loading') return <EmptyState title="Loading" detail="Waiting for this view." />
  if (resource.status === 'unavailable' || resource.status === 'error') return <EmptyState title={empty} detail={resource.reason} />
  return <>{resource.status === 'stale' && <Badge tone="attention">{resource.reason}</Badge>}{children(resource.data)}</>
}
export function ListRow({ icon, title, detail, end }: { icon: string; title: string; detail: string; end?: ReactNode }) {
  return <div className="f-list-row"><span className="f-icon-chip"><Glyph name={icon} /></span>
    <div><strong>{title}</strong><small>{detail}</small></div>{end}</div>
}
