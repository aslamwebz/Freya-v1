import { useSyncExternalStore } from 'react'
import { initialState, reduce, type ShellEvent, type ShellState } from '../core/events'
import type { SurfaceEvent } from '../core/surfaces/manager'

/**
 * The shell store: one reducer, one snapshot, one subscription list.
 *
 * It is the event bus as well as the state container. Surface lifecycle events
 * are forwarded to the SurfaceManager (the owner of surface state) and are not
 * duplicated into the snapshot.
 */
export class ShellStore {
  private state: ShellState = initialState()
  private listeners = new Set<() => void>()
  private readonly surfaceHandlers = new Set<(event: SurfaceEvent) => void>()

  getState = (): ShellState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Surface events are routed out rather than reduced into the snapshot. */
  onSurfaceEvent(handler: (event: SurfaceEvent) => void): () => void {
    this.surfaceHandlers.add(handler)
    return () => {
      this.surfaceHandlers.delete(handler)
    }
  }

  dispatch = (event: ShellEvent): void => {
    if (isSurfaceEvent(event)) {
      for (const handler of this.surfaceHandlers) handler(event)
      return
    }
    const next = reduce(this.state, event)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /** Applied once at boot, before the first render of the surface layer. */
  hydrate(patch: Partial<ShellState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function isSurfaceEvent(event: ShellEvent): event is SurfaceEvent {
  return event.type.startsWith('surface.')
}

export const shellStore = new ShellStore()

export function useShell<T>(select: (state: ShellState) => T): T {
  return useSyncExternalStore(
    shellStore.subscribe,
    () => select(shellStore.getState()),
    () => select(shellStore.getState()),
  )
}
