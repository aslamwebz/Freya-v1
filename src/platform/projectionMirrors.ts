import type { FoundryProjection } from '../../core/protocol/foundry'
import { ABSENT_FOUNDRY_PROJECTION } from '../../core/protocol/foundry'
import type { ConsciousContextProjection } from '../../core/protocol/consciousness'
import { ABSENT_CONSCIOUS_CONTEXT_PROJECTION } from '../../core/protocol/consciousness'
import type { LifeLoopProjection } from '../../core/protocol/lifeloop'
import { ABSENT_LIFE_LOOP_PROJECTION } from '../../core/protocol/lifeloop'
import type { WorldSummaryView } from '../../core/protocol/world'
import { ABSENT_WORLD_SUMMARY } from '../../core/protocol/world'
import { hostBridge, type FreyaHostBridge } from './host'

/**
 * The four read-only projection mirrors that had a host lane but no client.
 *
 * World, Consciousness, Life Loop and Foundry each expose exactly one payloadless
 * read and one push channel on the bridge. They carry no command surface at all —
 * there is deliberately no write method on this file, because a window may watch
 * these subsystems and may not drive them.
 *
 * The shape is the same mirror every other lane uses: follow pushes first, then
 * pull once as a backstop for a change that raced the subscription. An absent
 * bridge (a browser, a test) publishes the frozen absent projection, which is the
 * honest reading of "no such lane here" rather than a `null` a surface could
 * mistake for "nothing is happening".
 */
export interface ProjectionMirror<T> {
  readonly projection: T | null
  subscribe(listener: (projection: T | null) => void): () => void
  /** Idempotent-ish: a second attach replaces the first subscription. */
  attach(): Promise<() => void>
  read(): Promise<T | null>
  reset(): void
}

interface LaneSpec<T> {
  read: (bridge: FreyaHostBridge) => Promise<T | null>
  on: (bridge: FreyaHostBridge, handler: (projection: T) => void) => () => void
  absent: T
}

function createProjectionMirror<T>(spec: LaneSpec<T>): ProjectionMirror<T> {
  const listeners = new Set<(projection: T | null) => void>()
  let current: T | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: T | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  return {
    get projection() {
      return current
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    async attach() {
      const bridge = hostBridge()
      if (!bridge) {
        publish(spec.absent)
        return () => {}
      }
      disposeBridge?.()
      disposeBridge = spec.on(bridge, (projection) => publish(projection))
      try {
        publish((await spec.read(bridge)) ?? spec.absent)
      } catch {
        if (current === null) publish(spec.absent)
      }
      return () => {
        disposeBridge?.()
        disposeBridge = null
      }
    },

    async read() {
      const bridge = hostBridge()
      if (!bridge) return null
      try {
        return await spec.read(bridge)
      } catch {
        return null
      }
    },

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}

let worldShared: ProjectionMirror<WorldSummaryView> | null = null
let consciousnessShared: ProjectionMirror<ConsciousContextProjection> | null = null
let lifeLoopShared: ProjectionMirror<LifeLoopProjection> | null = null
let foundryShared: ProjectionMirror<FoundryProjection> | null = null

export function worldMirror(): ProjectionMirror<WorldSummaryView> {
  return (worldShared ??= createProjectionMirror<WorldSummaryView>({
    read: (bridge) => bridge.coreWorld(),
    on: (bridge, handler) => bridge.onCoreWorld(handler),
    absent: ABSENT_WORLD_SUMMARY,
  }))
}

export function consciousnessMirror(): ProjectionMirror<ConsciousContextProjection> {
  return (consciousnessShared ??= createProjectionMirror<ConsciousContextProjection>({
    read: (bridge) => bridge.coreConsciousness(),
    on: (bridge, handler) => bridge.onCoreConsciousness(handler),
    absent: ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
  }))
}

export function lifeLoopMirror(): ProjectionMirror<LifeLoopProjection> {
  return (lifeLoopShared ??= createProjectionMirror<LifeLoopProjection>({
    read: (bridge) => bridge.coreLifeLoop(),
    on: (bridge, handler) => bridge.onCoreLifeLoop(handler),
    absent: ABSENT_LIFE_LOOP_PROJECTION,
  }))
}

export function foundryMirror(): ProjectionMirror<FoundryProjection> {
  return (foundryShared ??= createProjectionMirror<FoundryProjection>({
    read: (bridge) => bridge.coreFoundry(),
    on: (bridge, handler) => bridge.onCoreFoundry(handler),
    absent: ABSENT_FOUNDRY_PROJECTION,
  }))
}

export function resetProjectionMirrors(): void {
  worldShared = null
  consciousnessShared = null
  lifeLoopShared = null
  foundryShared = null
}
