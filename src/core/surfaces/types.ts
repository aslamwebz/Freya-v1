/**
 * Surface types are *data*, not components.
 *
 * Adding a window to Freya is one entry in `surfaceTypes` plus a component
 * registered in the surface registry. The windowing behaviour — geometry,
 * focus, z-order, minimise, maximise, clamping, persistence — is written once
 * in `SurfaceManager` and `SurfaceWindow`, and is not re-implemented per type.
 */

export const SURFACE_TYPES = [
  'chat',
  'search',
  'work',
  'mission',
  'vault',
  'harness',
  'foundry',
  'relay',
  'team',
  'office',
  'security',
  'settings',
] as const

export type SurfaceType = (typeof SURFACE_TYPES)[number]

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SurfaceLayout extends Bounds {
  minimized: boolean
  maximized: boolean
  pinned: boolean
  z: number
  /** Geometry to return to when leaving the maximised state. */
  restoreBounds: Bounds | null
}

export type SurfaceState = 'open' | 'minimized' | 'closed'

export interface Surface {
  /** Durable identity. Survives reload, and will key long-running work. */
  id: string
  type: SurfaceType
  title: string
  /** Free-form routing context, e.g. a mission id. Opaque to the shell. */
  context: Record<string, string>
  state: SurfaceState
  layout: SurfaceLayout
  createdAt: number
}

export interface SurfaceTypeDescriptor {
  type: SurfaceType
  title: string
  /** One line shown on the placeholder surface. Honest about the state. */
  summary: string
  width: number
  height: number
  minWidth: number
  minHeight: number
  /** Whether this type is functional in Phase 0 or a declared placeholder. */
  status: 'working' | 'real' | 'placeholder'
}

export const surfaceTypes: Record<SurfaceType, SurfaceTypeDescriptor> = {
  chat: {
    type: 'chat',
    title: 'Chat',
    summary:
      'Conversation with Freya. Commands reach Core and are recorded; model replies are not connected yet.',
    width: 520,
    height: 560,
    minWidth: 360,
    minHeight: 320,
    status: 'working',
  },
  search: {
    type: 'search',
    title: 'Search',
    summary: 'Search across files, vault and knowledge. Retrieval is not implemented in Phase 0.',
    width: 600,
    height: 500,
    minWidth: 380,
    minHeight: 300,
    status: 'working',
  },
  work: {
    type: 'work',
    title: 'Work',
    summary: 'Runs, tasks and approvals. The Work system is not implemented in Phase 0.',
    width: 660,
    height: 520,
    minWidth: 420,
    minHeight: 320,
    status: 'placeholder',
  },
  mission: {
    type: 'mission',
    title: 'Mission',
    summary: 'A persistent outcome. The Missions engine is not implemented in Phase 0.',
    width: 640,
    height: 540,
    minWidth: 400,
    minHeight: 320,
    status: 'placeholder',
  },
  vault: {
    type: 'vault',
    title: 'Vault',
    summary: 'Durable knowledge, Obsidian-compatible. Not implemented yet.',
    width: 620,
    height: 540,
    minWidth: 400,
    minHeight: 320,
    status: 'placeholder',
  },
  harness: {
    type: 'harness',
    title: 'Harness',
    summary: 'Terminals, browsers and agent sessions. No process is started in Phase 0.',
    width: 700,
    height: 460,
    minWidth: 460,
    minHeight: 280,
    status: 'working',
  },
  foundry: {
    type: 'foundry',
    title: 'Foundry',
    summary: 'Tools and modules built by Freya. Foundry is not implemented in Phase 0.',
    width: 680,
    height: 520,
    minWidth: 420,
    minHeight: 320,
    status: 'placeholder',
  },
  relay: {
    type: 'relay',
    title: 'Relay',
    summary: 'Messaging and external connectors. Relay is not implemented in Phase 0.',
    width: 560,
    height: 480,
    minWidth: 380,
    minHeight: 300,
    status: 'placeholder',
  },
  team: {
    type: 'team',
    title: 'Team',
    summary: 'Agents, teams and swarms. No agent exists in Phase 0 and none is simulated.',
    width: 620,
    height: 500,
    minWidth: 400,
    minHeight: 300,
    status: 'placeholder',
  },
  office: {
    type: 'office',
    title: 'Office',
    summary: 'A spatial view of live state. Not implemented yet.',
    width: 820,
    height: 580,
    minWidth: 480,
    minHeight: 360,
    status: 'placeholder',
  },
  security: {
    type: 'security',
    title: 'Security',
    summary:
      'Live Core posture: the Guard default, STOP ALL, the Governor, providers and the audit log. Deny by default.',
    width: 620,
    height: 520,
    minWidth: 400,
    minHeight: 320,
    status: 'real',
  },
  settings: {
    type: 'settings',
    title: 'Settings',
    summary: 'Preferences for voice, appearance and storage. Not implemented yet.',
    width: 560,
    height: 480,
    minWidth: 380,
    minHeight: 300,
    status: 'placeholder',
  },
}

export function isSurfaceType(value: unknown): value is SurfaceType {
  return typeof value === 'string' && value in surfaceTypes
}
