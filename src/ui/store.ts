import { useSyncExternalStore } from 'react'
import { initialState, reduce, type ShellEvent, type ShellState } from '../core/events'

/**
 * The shell store: one reducer, one snapshot, one subscription list.
 *
 * It is the event bus as well as the state container. Surface events arrive
 * here from the Surface Manager and are reduced into a summary the shell can
 * read — the manager keeps the surfaces themselves, the store keeps the facts
 * about them. That single path is what the rest of the shell subscribes to.
 */
export class ShellStore {
  private state: ShellState = initialState()
  private listeners = new Set<() => void>()

  getState = (): ShellState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispatch = (event: ShellEvent): void => {
    const next = reduce(this.state, event)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /**
   * Boot-time fact injection, applied before the first render.
   *
   * Deliberately narrow: only the runtime identity. Anything else arrives as an
   * event, so there is exactly one path into the state and one place where the
   * rules are enforced.
   */
  hydrateRuntime(runtime: ShellState['runtime']): void {
    this.state = { ...this.state, runtime }
    for (const listener of this.listeners) listener()
  }
}

export const shellStore = new ShellStore()

export function useShell<T>(select: (state: ShellState) => T): T {
  return useSyncExternalStore(
    shellStore.subscribe,
    () => select(shellStore.getState()),
    () => select(shellStore.getState()),
  )
}
