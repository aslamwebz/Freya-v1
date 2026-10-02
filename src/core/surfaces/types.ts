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
  'research',
  'work',
  'mission',
  'vault',
  'harness',
  'foundry',
  'relay',
  'team',
  'context',
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
  /** Whether this type is functional in Phase 2 or a declared placeholder. */
  status: 'working' | 'real' | 'placeholder'
  /**
   * How many windows of this type may be open at once.
   *
   * Declared here rather than special-cased in the manager, because "can this
   * open twice?" is a property of the surface type and not of the code that
   * happens to open it. A future type that wants one window per mission says
   * `keyedBy: 'missionId'` and the manager does the rest; nothing in the manager
   * needs editing, and there is no switch statement to remember to update.
   *
   * `singleton` means opening again focuses and restores the existing window.
   * Duplicating a Security window would give the user two ways to stop Freya and
   * no way to tell which is authoritative.
   */
  instance: SurfaceInstancePolicy
}

/**
 * `'singleton'`, or the name of the context field that distinguishes instances.
 *
 * A `keyedBy` surface opened without that field in its context behaves as a
 * singleton until one is supplied, which is the conservative reading: two
 * unkeyed windows of a keyed type would be indistinguishable to the user.
 */
export type SurfaceInstancePolicy = 'singleton' | { keyedBy: string }

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
    instance: 'singleton',
    status: 'working',
  },
  search: {
    type: 'search',
    title: 'Search',
    // Rewritten in Phase 5 from a window that returned nothing into a real web
    // search and source reader. Local file, vault and full-text scopes are still
    // absent, and the surface says so rather than listing capabilities it lacks.
    summary:
      'Web search through the configured provider, and reading a public source into bounded plain text. Nothing is indexed locally.',
    width: 600,
    height: 560,
    minWidth: 380,
    minHeight: 320,
    instance: 'singleton',
    status: 'working',
  },
  research: {
    type: 'research',
    title: 'Research',
    // A separate window from Search because the two answer different questions and
    // have different costs: Search is one query and no model, Research is a bounded
    // multi-stage run that spends model calls. Merging them would make a free action
    // look like an expensive one.
    summary:
      'Bounded, cited research over public web pages, with the code-owned limits and the sources behind every finding shown.',
    width: 680,
    height: 600,
    minWidth: 420,
    minHeight: 340,
    instance: 'singleton',
    status: 'working',
  },
  work: {
    type: 'work',
    title: 'Work',
    summary:
      'Runs, tasks and approvals: what Freya is executing, what is waiting on you, and what verified. Phase 6 registers only inert capabilities — nothing here starts a process.',
    width: 660,
    height: 520,
    minWidth: 420,
    minHeight: 320,
    instance: 'singleton',
    status: 'working',
  },
  mission: {
    type: 'mission',
    title: 'Mission',
    // No longer a placeholder. The engine, its verifier, its encrypted store and this
    // board all exist, so a placeholder here would understate the build rather than
    // describe it. What this window does *not* show is the Mission's text — that is in
    // the encrypted store, and a standing feed of it would defeat the encryption.
    summary:
      'Persistent outcomes: what you asked Freya to accomplish, what is happening underneath it, and whether anything was verified.',
    width: 640,
    height: 540,
    minWidth: 400,
    minHeight: 320,
    instance: { keyedBy: 'missionId' },
    status: 'working',
  },
  vault: {
    type: 'vault',
    title: 'Vault',
    // The summary is the placeholder copy and is still accurate as a summary: the
    // Brain is durable knowledge, encrypted and chained, but it is not an
    // Obsidian-compatible library and pretending otherwise would be a lie about
    // interoperability that does not exist.
    summary:
      'What Freya remembers, where each memory came from, and who she believes she is. Obsidian-compatible import is not implemented.',
    width: 620,
    height: 540,
    minWidth: 400,
    minHeight: 320,
    instance: 'singleton',
    status: 'working',
  },
  harness: {
    type: 'harness',
    title: 'Harness',
    summary: 'Terminals, browsers and agent sessions. No process is started in Phase 0.',
    width: 700,
    height: 460,
    minWidth: 460,
    minHeight: 280,
    instance: { keyedBy: 'sessionId' },
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
    instance: 'singleton',
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
    instance: 'singleton',
    status: 'placeholder',
  },
  team: {
    type: 'team',
    // No longer a placeholder. The window renders the Workforce projection Core
    // actually reports — which today is the honest sentence that no Workforce
    // domain exists, and which becomes worker and team rows the moment Core has
    // some. A placeholder here would understate the build; a simulated roster
    // would be worse than either.
    title: 'Workforce',
    summary:
      'The workers and teams Core actually has: who exists, what each is assigned, and what each merely claims. Nothing on this surface is simulated.',
    width: 640,
    height: 540,
    minWidth: 400,
    minHeight: 320,
    instance: 'singleton',
    status: 'working',
  },
  context: {
    type: 'context',
    // The Phase 9 read-only surface. The window is real and renders exactly
    // what Core reports — which today is the honest sentence that no Context
    // domain is reporting, because issue #15's domain does not exist yet in
    // Core. A placeholder here would understate the transport; a populated
    // frame would be worse than either, because nothing here may be simulated.
    title: 'Context',
    summary:
      'What Core says is around the current question: each item with the provenance, scope and expiry Core assigned it, shown as Core reported it — current, expired, revoked, or left open as a reference it did not resolve. Nothing is captured by this window and nothing is simulated.',
    width: 640,
    height: 540,
    minWidth: 400,
    minHeight: 320,
    instance: 'singleton',
    status: 'working',
  },
  office: {
    type: 'office',
    title: 'Office',
    summary: 'A spatial view of live state. Not implemented yet.',
    width: 820,
    height: 580,
    minWidth: 480,
    minHeight: 360,
    instance: 'singleton',
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
    instance: 'singleton',
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
    instance: 'singleton',
    status: 'placeholder',
  },
}

export function isSurfaceType(value: unknown): value is SurfaceType {
  return typeof value === 'string' && value in surfaceTypes
}
