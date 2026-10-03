import type { ReactNode } from 'react'
import type { Resource, UiSnapshot } from '../state/contract'
import { Badge, Button, EmptyState } from '../primitives/Controls'
import { Glyph } from '../primitives/Glyph'
export { Compass } from './Presence'
import type { ViewState } from './viewState'

export interface WorkspaceProps {
  snapshot: UiSnapshot; view: ViewState; update: (patch: Partial<ViewState>) => void
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
