import type { SurfaceType } from '../../core/surfaces/types'
import { surfaceTypes } from '../../core/surfaces/types'
import { ChatSurface } from './ChatSurface'
import { SearchSurface } from './SearchSurface'
import { HarnessSurface } from './HarnessSurface'
import { SecuritySurface } from './SecuritySurface'
import { VaultSurface } from './VaultSurface'
import type { SurfaceDefinition } from './types'

/**
 * The surface registry.
 *
 * One catalog: what a surface is called, whether it can be opened more than
 * once, how big it wants to be, and which component draws its body.
 *
 * The point is that a new surface is one entry in `surfaceTypes` and one entry
 * here, and nothing else in the shell needs to learn its name. The launcher, the
 * dock, restoration and the Surface Manager all read the same metadata, so there
 * is no second list somewhere that can fall out of step and leave a window the
 * launcher cannot open or a placeholder with no component.
 *
 * Anything with no entry here is a declared placeholder rather than a broken
 * surface, which is what lets a type exist in the vocabulary — `foundry`,
 * `relay`, `office` — before the system behind it does.
 */
const BODIES: Partial<Record<SurfaceType, () => React.ReactNode>> = {
  chat: () => <ChatSurface />,
  search: () => <SearchSurface />,
  harness: () => <HarnessSurface />,
  security: () => <SecuritySurface />,
  vault: () => <VaultSurface />,
}

/** The registry, resolved once from the two catalogs it is built from. */
export const SURFACES: readonly SurfaceDefinition[] = Object.values(surfaceTypes).map((descriptor) => ({
  ...descriptor,
  render: BODIES[descriptor.type],
}))

export function surfaceDefinition(type: SurfaceType): SurfaceDefinition {
  const found = SURFACES.find((definition) => definition.type === type)
  // Unreachable through typed callers; guarded because a typo here would
  // otherwise surface as an undefined component rather than as a clear error.
  if (!found) throw new Error(`unknown surface type: ${type}`)
  return found
}

/**
 * What the launcher offers.
 *
 * Derived from the catalog and filtered by status, not hand-listed. The previous
 * list was written out separately and had already drifted — it omitted Security,
 * which is the one surface with a button in it that stops Freya.
 *
 * Placeholders are excluded on purpose: a launcher full of windows that open
 * onto "not implemented yet" is advertising systems that do not exist. A
 * declared placeholder stays reachable through its own panel, which is where an
 * honest explanation of the boundary belongs.
 */
export function launcherSurfaces(): readonly SurfaceDefinition[] {
  return SURFACES.filter((definition) => definition.status !== 'placeholder')
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
  const definition = surfaceDefinition(type)
  return definition.render ? definition.render() : <PlaceholderSurface type={type} />
}
