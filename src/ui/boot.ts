import { SurfaceManager } from '../core/surfaces/manager'
import { WORKSPACE_SCHEMA } from '../core/workspace'
import { bindSurfaceManager, surfaceManager } from './surfaceActions'
import { shellStore } from './store'
import { createWorkspaceStore, readRuntimeInfo } from '../platform/workspaceStore'

const SAVE_DEBOUNCE = 400
const MIN_WIDTH = 1024
const MIN_HEIGHT = 680

let started = false

/**
 * Wires the shell together exactly once.
 *
 * Everything the renderer needs from outside itself arrives here: the workspace
 * frame, the persisted layout, and the runtime identity. Nothing below this
 * function knows that Electron exists.
 */
export async function startShell(): Promise<{ manager: SurfaceManager; host: 'desktop' | 'browser' }> {
  if (started) throw new Error('startShell called twice')
  started = true

  const store = createWorkspaceStore()
  const manager = new SurfaceManager({
    frame: { width: window.innerWidth, height: window.innerHeight },
  })
  bindSurfaceManager(manager)

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
    manager.setFrame({ width: window.innerWidth, height: window.innerHeight })
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
    const manager = surfaceManager()
    if (!manager) return

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
