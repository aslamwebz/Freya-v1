import { SurfaceManager } from '../core/surfaces/manager'
import { WORKSPACE_SCHEMA } from '../core/workspace'
import { shellStore } from './store'
import { createWorkspaceStore, collectFrom, readRuntimeInfo } from '../platform/workspaceStore'
import { coreMirror, ensureActivityAttached, ensureCoreAttached } from '../platform/coreClient'

const SAVE_DEBOUNCE = 400

/**
 * The Surface Manager exists before React does.
 *
 * It is client-side state with no dependency on the desktop host, so creating
 * it lazily inside an async boot would leave the first render subscribed to
 * nothing. Modules import this instance directly; there is no lookup and no
 * nullable "not bound yet" state.
 */
export const manager = new SurfaceManager({
  frame: workspaceFrame(),
  // The one wiring point between the windowing system and the rest of the
  // shell. Every lifecycle change becomes an event on the same bus as
  // everything else, carrying a summary the reducer can store as-is.
  onEvent: (event) => shellStore.dispatch(event),
})

/**
 * The region surfaces are allowed to occupy: the whole window, below the header.
 *
 * The frame is deliberately *not* the centre column and deliberately *not* the
 * gap between the rail and the chat bar. Windows open at least a laptop screen
 * wide, and on a laptop-sized display there is no arrangement of the dashboard
 * columns that leaves room for one — bounding a window to the middle column caps
 * it at roughly a third of a laptop screen, and leaving the rail and the chat bar
 * out of the frame means a window sized honestly would sit permanently under
 * both, with its bottom-right handle unreachable.
 *
 * So a window may cover the dashboard, the rail and the chat bar. Two things are
 * still protected, and they are the two you cannot get back by dragging: the
 * header, so the command bar is never buried, and enough of a window on screen
 * to grab it, which `clampPosition` enforces.
 *
 * Measured rather than hard-coded, so this stays correct across breakpoints.
 */
export function workspaceFrame() {
  const header = document.querySelector<HTMLElement>('.header')
  // `||` not `??`: a measured zero is not an absent element.
  const top = header?.offsetHeight || 88
  return {
    x: 0,
    y: top,
    width: Math.max(320, window.innerWidth),
    height: Math.max(240, window.innerHeight - top),
  }
}

let started: Promise<{ manager: SurfaceManager; host: 'desktop' | 'browser' }> | null = null

/**
 * Wires the shell to its environment exactly once: workspace frame, persisted
 * layout, runtime identity, persistence and shell shortcuts.
 *
 * Nothing below this function knows that Electron exists.
 *
 * Idempotent by design: React's StrictMode mounts effects twice in
 * development, and a reload must never produce a second surface manager.
 */
export function startShell(): Promise<{ manager: SurfaceManager; host: 'desktop' | 'browser' }> {
  started ??= boot()
  return started
}

async function boot(): Promise<{ manager: SurfaceManager; host: 'desktop' | 'browser' }> {
  const store = createWorkspaceStore()
  manager.setFrame(workspaceFrame())

  shellStore.hydrateRuntime(await readRuntimeInfo())

  // Attach to Core's projection and its activity feed before anything reads
  // them, so the first render already has real facts.
  //
  // Attaching here rather than in a panel is what makes the whole shell agree:
  // one subscription, created once, outliving any component. And it is what
  // keeps the Phase 1 invariant intact — a renderer reload re-attaches to the
  // Core that is already running rather than starting one.
  const core = coreMirror()
  core.subscribe((status) => {
    shellStore.dispatch({ type: 'core.status', status })
  })
  core.subscribeActivity((activity) => {
    shellStore.dispatch({ type: 'core.activity', activity })
  })
  await Promise.all([ensureCoreAttached(), ensureActivityAttached()])

  const snapshot = await store.load()
  if (snapshot) {
    manager.restore(snapshot.surfaces)
    shellStore.dispatch({
      type: 'workspace.restored',
      nav: snapshot.nav,
      navCollapsed: snapshot.navCollapsed,
      presence: snapshot.presence,
    })
  }

  const persist = () => {
    const state = shellStore.getState()
    void store.save({
      schema: WORKSPACE_SCHEMA,
      surfaces: manager.serialize(),
      presence: state.presence.state,
      nav: state.nav,
      navCollapsed: state.navCollapsed,
      savedAt: Date.now(),
    })
  }

  let timer: number | undefined
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      persist()
    }, SAVE_DEBOUNCE)
  }

  // One subscription, not two. Surface changes now reach the store through the
  // event path, so the store alone tells us that anything worth saving moved.
  shellStore.subscribe(schedule)
  window.addEventListener('beforeunload', persist)
  window.addEventListener('resize', onResize)

  // Folding the rail changes the region windows may occupy, so the frame is
  // re-measured and the manager re-clamps what it is holding.
  shellStore.subscribe(() => {
    manager.setFrame(workspaceFrame())
  })

  // The host cannot reach us while the window is being torn down, so it asks.
  // This is the handler that answers that question with the current layout.
  collectFrom(() => ({
    schema: WORKSPACE_SCHEMA,
    surfaces: manager.serialize(),
    presence: shellStore.getState().presence.state,
    nav: shellStore.getState().nav,
    savedAt: Date.now(),
  }))

  function onResize(): void {
    manager.setFrame(workspaceFrame())
  }

  installShortcuts()

  return { manager, host: store.kind }
}

/**
 * Global shell shortcuts. These belong to the windowing system, not to any one
 * surface, so they live at the shell level.
 */
function installShortcuts(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const focused = manager.focused
      if (focused) {
        event.preventDefault()
        manager.minimize(focused.id)
      }
      return
    }

    if (event.key === '`' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      manager.cycle(event.shiftKey ? -1 : 1)
    }
  })
}
