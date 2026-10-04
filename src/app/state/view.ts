import type { Resource } from '../../ui-v2/state/contract'

/** The data of a resource when it is usable, else null. */
export function ready<T>(resource: Resource<T>): T | null {
  return resource.status === 'ready' || resource.status === 'stale' ? resource.data : null
}

/** The words for a resource that is not usable right now. */
export function reason(resource: Resource<unknown>): string {
  return resource.status === 'unavailable' || resource.status === 'error'
    ? resource.reason
    : 'Waiting for Freya Core.'
}
