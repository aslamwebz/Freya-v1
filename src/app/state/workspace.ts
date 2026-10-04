import { WORKSPACE_SCHEMA, type WorkspaceSnapshot } from '../../core/workspace'
import type { PersistedSurface } from '../../core/surfaces/manager'
import type { PresenceState } from '../../core/presence'
import { collectFrom, createWorkspaceStore } from '../../platform/workspaceStore'

/**
 * App Mode's layout persistence, through the one workspace mechanism the host
 * already owns.
 *
 * The host cannot read a layout out of a closing window, so it asks — and the
 * legacy shell answered through `collectFrom`, while App Mode never registered a
 * handler at all. Every close therefore waited out the full host timeout for an
 * answer that could not come. This is the missing answer: App Mode publishes the
 * small piece of layout it actually has (which screen, whether the rail is
 * folded, which conversation is open) so the host's request resolves immediately
 * instead of timing out.
 *
 * There is no second persistence mechanism here. It is the same `onCollect` /
 * `saveWorkspace` / `loadWorkspace` contract the legacy shell uses, reading and
 * writing the same file.
 */
export interface AppLayout {
  readonly nav: string
  readonly navCollapsed: boolean
  readonly conversationId: string | null
}

let layout: AppLayout = { nav: 'home', navCollapsed: false, conversationId: null }
let armed = false
/**
 * The parts of the workspace file App Mode does not own.
 *
 * The legacy shell and App Mode share one file. App Mode has no floating
 * surfaces, so a collect that wrote `surfaces: []` unconditionally would erase
 * the layout of a person who had used the legacy shell and then switched. These
 * are read at launch and written back unchanged, so App Mode only ever updates
 * the three fields it actually has.
 */
let preserved: { surfaces: PersistedSurface[]; presence: PresenceState } = { surfaces: [], presence: 'idle' }

/** Update what the host will be told when it asks for the current layout. */
export function setAppLayout(next: AppLayout): void {
  layout = next
}

export function currentAppLayout(): AppLayout {
  return layout
}

/**
 * Register the closing-time collector once. A second call is a no-op rather than
 * a second IPC listener, so a remount cannot answer the host twice.
 */
export function armAppWorkspace(): void {
  if (armed) return
  armed = true
  collectFrom((): WorkspaceSnapshot => ({
    schema: WORKSPACE_SCHEMA,
    // App Mode is a single composition, not a surface manager. It preserves any
    // surfaces the legacy shell left rather than erasing a layout it does not own.
    surfaces: preserved.surfaces,
    presence: preserved.presence,
    nav: layout.nav,
    navCollapsed: layout.navCollapsed,
    conversationId: layout.conversationId,
    savedAt: Date.now(),
  }))
}

/** Read the persisted layout, if any, so a relaunch opens where it left off. */
export async function loadAppLayout(): Promise<AppLayout | null> {
  const snapshot = await createWorkspaceStore().load()
  if (!snapshot) return null
  preserved = { surfaces: snapshot.surfaces, presence: snapshot.presence }
  return {
    nav: snapshot.nav,
    navCollapsed: snapshot.navCollapsed,
    conversationId: snapshot.conversationId,
  }
}

/** For tests: forget the armed state. */
export function resetAppWorkspace(): void {
  armed = false
  layout = { nav: 'home', navCollapsed: false, conversationId: null }
  preserved = { surfaces: [], presence: 'idle' }
}
