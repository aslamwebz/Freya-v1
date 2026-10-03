import {
  ABSENT_LIFE_PROJECTION,
  type LifeCommandOutcome,
  type LifeEntryDetailView,
  type LifeProjection,
  type LifeTimelineView,
} from '../../core/protocol/life'
import type { LifeEntryKind } from '../../core/life/types'
import { hostBridge } from './host'

/**
 * The renderer's view of Freya's life history.
 *
 * A mirror, in the same sense as `skillsMirror`: every field arrived from Core
 * over a channel the window cannot write into, and the renderer cannot write one
 * either. There is no renderer-side life state — no local entry, no local status,
 * no local confidence — because a local copy would be a second source of truth
 * about what Freya remembers, and the one a person would trust more than Core's.
 *
 * ## What a window may do
 *
 * Three reads, each a `coreSubmit` with a narrow payload contract:
 *
 * - **status**, a payloadless read of the projection,
 * - **timeline**, a bounded, filtered chronological read, and
 * - **entry**, the explicit single-id read of one entry's own text.
 *
 * What it may not do, because there is no method here and no bridge function that
 * could: record an entry, consolidate one, revise one, withdraw one, raise a
 * confidence, set a derivation class, choose a source class or assert a status.
 * Those are Core-internal acts; a window has no name for any of them.
 */

export interface LifeTimelineInput {
  limit?: number
  kinds?: readonly LifeEntryKind[]
  includeWithdrawn?: boolean
}

export interface LifeMirror {
  readonly projection: LifeProjection | null
  subscribe(listener: (projection: LifeProjection | null) => void): () => void
  attach(): Promise<() => void>

  /** Pull Core's current projection. Argument-free by construction. */
  read(): Promise<LifeProjection | null>

  /** A bounded chronological read. Core bounds it; the renderer does not. */
  timeline(input?: LifeTimelineInput): Promise<LifeTimelineView | null>

  /** Read one entry's own text back, explicitly. Never a standing feed. */
  readEntry(entryId: string): Promise<LifeEntryDetailView | null>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, matching the other mirrors' absent state. */
const ABSENT: LifeProjection = ABSENT_LIFE_PROJECTION

let shared: LifeMirror | null = null
let attachPromise: Promise<LifeMirror> | null = null

export function lifeMirror(): LifeMirror {
  shared ??= createLifeMirror()
  return shared
}

export function ensureLifeAttached(): Promise<LifeMirror> {
  attachPromise ??= lifeMirror().attach().then(() => lifeMirror())
  return attachPromise
}

export function resetLifeMirror(): void {
  shared = null
  attachPromise = null
}

export function createLifeMirror(): LifeMirror {
  const listeners = new Set<(projection: LifeProjection | null) => void>()
  const subscriptions = new Set<() => void>()
  let current: LifeProjection | null = null

  const publish = (projection: LifeProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  const read = async (): Promise<LifeProjection | null> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreLife !== 'function') return null
    try {
      const projection = await bridge.coreLife()
      if (current === null) publish(projection ?? ABSENT)
      return projection
    } catch {
      return null
    }
  }

  /** Submit and read Core's answer from the Life slot, never from the envelope. */
  const submit = async (command: string, payload: unknown): Promise<LifeCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreSubmit !== 'function') {
      return { operation: 'refused', ok: false, reason: 'the Core bridge is not available in this window' }
    }
    try {
      const result = await bridge.coreSubmit(command as never, payload)
      if (result.life) return result.life
      return {
        operation: 'refused',
        ok: false,
        reason: result.refusal?.reason ?? result.error?.message ?? 'Core did not answer the Life command',
      }
    } catch (error) {
      return {
        operation: 'refused',
        ok: false,
        reason: `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
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
      if (!bridge || typeof bridge.onCoreLife !== 'function') return () => {}
      const own = bridge.onCoreLife((projection) => publish(projection))
      subscriptions.add(own)
      try {
        publish((await bridge.coreLife()) ?? ABSENT)
      } catch {
        if (current === null) publish(null)
      }
      return () => {
        subscriptions.delete(own)
        own()
      }
    },

    read,

    async timeline(input) {
      const answer = await submit('life.timeline.read', {
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
        ...(input?.kinds === undefined ? {} : { kinds: [...input.kinds] }),
        ...(input?.includeWithdrawn === undefined ? {} : { includeWithdrawn: input.includeWithdrawn }),
      })
      return answer.ok ? (answer.timeline ?? null) : null
    },

    async readEntry(entryId) {
      const answer = await submit('life.entry.read', { entryId })
      return answer.ok ? (answer.entry ?? null) : null
    },

    reset() {
      for (const dispose of [...subscriptions]) dispose()
      subscriptions.clear()
      publish(null)
    },
  }
}
