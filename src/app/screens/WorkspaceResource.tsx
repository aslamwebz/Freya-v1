import type { ReactNode } from 'react'
import type { Resource } from '../../ui-v2/state/contract'

export function NotConnected({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="uw-empty"><h2>{title}</h2><p>{title} not connected.</p><p>{children ?? 'This view cannot read those records yet.'}</p></div>
}

export function ResourceGate<T>({ resource, title, children }: { resource: Resource<T>; title: string; children: (data: T) => ReactNode }) {
  const data = (resource.status === 'ready' || resource.status === 'stale') && resource.source === 'live' ? resource.data : null
  if (data === null) return <NotConnected title={title}>{resource.status === 'loading' ? 'Waiting for Freya to report.' : 'reason' in resource ? resource.reason : 'Live records are not available in this window.'}</NotConnected>
  return <><p className="uw-source" role="status">{resource.status === 'stale' ? `Last known records · ${resource.reason}` : 'Live records'}</p>{children(data)}</>
}
