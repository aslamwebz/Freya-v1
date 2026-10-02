import {
  ABSENT_ATTENTION_PROJECTION,
  type AttentionCommandOutcome,
  type AttentionEventDetail,
  type AttentionProjection,
} from '../../core/protocol/attention'
import { hostBridge } from './host'

/**
 * The renderer's view of events and attention.
 *
 * A mirror, in the same sense as `personalityMirror` and `contextMirror`: every
 * field arrived from Core over a channel the window cannot write into, and the
 * renderer cannot write one either. There is no renderer-side attention state — no
 * local budget, no cooldown, no importance, no queue — because a local copy would be
 * a second source of truth about what deserves attention, and the one a person
 * would trust more than Core's.
 *
 * ## What a window may do
 *
 * It may **submit** an authorized event, register and cancel a schedule, and read
 * one retained event back. Every one of those is a `coreSubmit` with a narrow
 * payload contract, and none of them can carry a source, an importance, an urgency,
 * an outcome, a budget or a cooldown — those are Core's. It may not tick the
 * scheduler: there is deliberately no method here that drives the clock, because a
 * renderer that could make a schedule fire could make Freya speak on demand.
 */

export interface AttentionMirror {
  readonly projection: AttentionProjection | null
  subscribe(listener: (projection: AttentionProjection | null) => void): () => void
  attach(): Promise<() => void>

  /** Pull Core's current projection. Argument-free by construction. */
  read(): Promise<AttentionProjection | null>

  /** Submit an event as the owner. Core assigns the source and decides. */
  ingest(input: {
    kind: string
    text: string
    goalRef?: string
    sourceRef?: string
    severityHint?: string
    dueAt?: string
  }): Promise<AttentionCommandOutcome>

  /** Register a bounded schedule. Core clamps the interval and the repeat count. */
  schedule(input: {
    kind: string
    text: string
    dueAt: string
    goalRef?: string
    severityHint?: string
    intervalMs?: number
    maxRepeats?: number
    condition?: string
  }): Promise<AttentionCommandOutcome>

  cancelSchedule(scheduleId: string): Promise<AttentionCommandOutcome>

  /** Read one retained event's text back, explicitly. Never a standing feed. */
  readEvent(eventId: string): Promise<AttentionEventDetail | null>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, matching the other mirrors' absent state. */
const ABSENT: AttentionProjection = ABSENT_ATTENTION_PROJECTION

let shared: AttentionMirror | null = null
let attachPromise: Promise<AttentionMirror> | null = null

export function attentionMirror(): AttentionMirror {
  shared ??= createAttentionMirror()
  return shared
}

export function ensureAttentionAttached(): Promise<AttentionMirror> {
  attachPromise ??= attentionMirror().attach().then(() => attentionMirror())
  return attachPromise
}

export function resetAttentionMirror(): void {
  shared = null
  attachPromise = null
}

export function createAttentionMirror(): AttentionMirror {
  const listeners = new Set<(projection: AttentionProjection | null) => void>()
  const subscriptions = new Set<() => void>()
  let current: AttentionProjection | null = null

  const publish = (projection: AttentionProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Pull the projection. The call is made with **no arguments**, so this is a pull
   * of what Core reports, never a push of what the window believes. The mirror is
   * only overwritten from an empty state: if pushes are already flowing, a pull that
   * resolves later than the newest push would otherwise write older Core truth over
   * newer.
   */
  const read = async (): Promise<AttentionProjection | null> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreAttention !== 'function') return null
    try {
      const projection = await bridge.coreAttention()
      if (current === null) publish(projection ?? ABSENT)
      return projection
    } catch {
      return null
    }
  }

  /** Submit and, on success, let Core's push be the only thing that updates state. */
  const submit = async (
    command: string,
    payload: unknown,
  ): Promise<AttentionCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreSubmit !== 'function') {
      return { operation: 'refused', ok: false, reason: 'the Core bridge is not available in this window' }
    }
    try {
      const result = await bridge.coreSubmit(command as never, payload)
      if (result.attention) return result.attention
      return {
        operation: 'refused',
        ok: false,
        reason: result.refusal?.reason ?? result.error?.message ?? 'Core did not answer the attention command',
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

    /**
     * Follow pushes, then pull once as a backstop. Subscribing *first* is
     * deliberate, for the same reason every other client gives: a change that lands
     * between the pull resolving and the subscription registering would be lost.
     */
    async attach() {
      const bridge = hostBridge()
      // A bridge that predates this lane (or a test double that does not model it)
      // is tolerated rather than crashing a window: the mirror simply stays absent,
      // which is the honest reading of "no Attention channel here".
      if (!bridge || typeof bridge.onCoreAttention !== 'function') return () => {}
      const own = bridge.onCoreAttention((projection) => publish(projection))
      subscriptions.add(own)
      try {
        publish((await bridge.coreAttention()) ?? ABSENT)
      } catch {
        if (current === null) publish(null)
      }
      return () => {
        subscriptions.delete(own)
        own()
      }
    },

    read,

    async ingest(input) {
      return submit('attention.event.ingest', input)
    },

    async schedule(input) {
      return submit('attention.schedule.register', input)
    },

    async cancelSchedule(scheduleId) {
      return submit('attention.schedule.cancel', { scheduleId })
    },

    async readEvent(eventId) {
      const bridge = hostBridge()
      if (!bridge || typeof bridge.coreSubmit !== 'function') return null
      try {
        const result = await bridge.coreSubmit('attention.inbox.read', { eventId })
        return result.attention?.detail ?? null
      } catch {
        return null
      }
    },

    reset() {
      for (const dispose of [...subscriptions]) dispose()
      subscriptions.clear()
      publish(null)
    },
  }
}
