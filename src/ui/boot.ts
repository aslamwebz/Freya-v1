import { SurfaceManager } from '../core/surfaces/manager'
import { WORKSPACE_SCHEMA } from '../core/workspace'
import { shellStore } from './store'
import { createWorkspaceStore, readRuntimeInfo } from '../platform/workspaceStore'

const SAVE_DEBOUNCE = 400
const MIN_WIDTH = 1024
const MIN_HEIGHT = 680

/**
 * The Surface Manager exists before React does.
 *
 * It is client-side state with no dependency on the desktop host, so creating
 * it lazily inside an async boot would leave the first render subscribed to
 * nothing. Modules import this instance directly; there is no lookup and no
 * nullable "not bound yet" state.
 */
export const manager = new SurfaceManager({ frame: workspaceFrame() })

/**
 * The region surfaces are allowed to occupy: everything except the header and
 * the navigation rail. Measured rather than hard-coded, so it stays correct
 * across the responsive breakpoints.
 */
export function workspaceFrame() {
  const header = document.querySelector<HTMLElement>('.header')
  const nav = document.querySelector<HTMLElement>('.nav')
  // `||` not `??`: a measured zero is not an absent element.
  const top = header?.offsetHeight || 88
  const left = nav?.offsetWidth || 186
  return {
    x: left,
    y: top,
    width: Math.max(320, window.innerWidth - left),
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
  // Surface events reach the rest of the shell through the same bus as
  // everything else. This is the only wiring point.
  shellStore.onSurfaceEvent((event) => {
    if (event.type === 'surface.closed') {
      shellStore.dispatch({ type: 'work.updated', note: `closed ${event.id}` })
    }
  })

  shellStore.hydrate({ runtime: await readRuntimeInfo() })

  const snapshot = await store.load()
  if (snapshot) {
    manager.restore(snapshot.surfaces)
    shellStore.dispatch({
      type: 'workspace.restored',
      nav: snapshot.nav,
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

  manager.subscribe(schedule)
  shellStore.subscribe(schedule)
  window.addEventListener('beforeunload', persist)
  window.addEventListener('resize', onResize)

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

export { MIN_WIDTH, MIN_HEIGHT }
