import type { SurfaceTypeDescriptor } from '../../core/surfaces/types'

/**
 * A surface as the shell sees it: its metadata, plus the component that draws
 * its body.
 *
 * `render` is absent for a type whose system does not exist yet. That absence is
 * the honest signal — the window is real, its contents are not — and it is
 * derived from the registry rather than asserted by a panel.
 */
export interface SurfaceDefinition extends SurfaceTypeDescriptor {
  render?: () => React.ReactNode
}
