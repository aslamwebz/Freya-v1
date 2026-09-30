import type { SurfaceType } from '../../core/surfaces/types'
import { surfaceTypes } from '../../core/surfaces/types'
import { ChatSurface } from './ChatSurface'
import { SearchSurface } from './SearchSurface'
import { HarnessSurface } from './HarnessSurface'
import { SecuritySurface } from './SecuritySurface'

/**
 * Surface registry: type → body.
 *
 * The windowing behaviour is in `SurfaceWindow`; only the body is chosen here.
 * A new surface type adds one entry here and one descriptor in `surfaceTypes`.
 */
const BODIES: Partial<Record<SurfaceType, () => React.ReactNode>> = {
  chat: () => <ChatSurface />,
  search: () => <SearchSurface />,
  harness: () => <HarnessSurface />,
  security: () => <SecuritySurface />,
}

/**
 * One honest placeholder for every system that is not built yet. It states the
 * boundary in the system's own terms instead of faking content.
 */
export function PlaceholderSurface({ type }: { type: SurfaceType }) {
  const descriptor = surfaceTypes[type]
  return (
    <div className="placeholder">
      <p className="placeholder-status">Not implemented yet</p>
      <p className="placeholder-summary">{descriptor.summary}</p>
      <p className="placeholder-note">
        The window you are looking at is the real thing. Move it, resize it, pin it, minimise it,
        and it will be in the same place next time Freya launches.
      </p>
    </div>
  )
}

export function SurfaceBody({ type }: { type: SurfaceType }) {
  const Body = BODIES[type]
  return Body ? Body() : <PlaceholderSurface type={type} />
}
