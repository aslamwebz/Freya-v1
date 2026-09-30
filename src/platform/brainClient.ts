import type { BrainCommandOutcome } from '../../core/protocol/core-protocol'
import type { BrainProjection } from '../../core/brain/brain'
import { hostBridge } from './host'

/**
 * The renderer's view of the Brain.
 *
 * A mirror, in the same sense `conversationClient` is one: every field arrived
 * over IPC from Core and the renderer cannot write one. There is no renderer-side
 * copy of what Freya remembers — a local list built from local edits would be a
 * second source of truth about somebody's memory, and the one everybody would trust
 * more than the encrypted original.
 *
 * ## What the renderer may and may not ask for
 *
 * `write` takes content, subject and kind. It does **not** take a source class, a
 * confidence ceiling or a verification status, and that omission is the design
 * rather than an oversight. A window that could name its own provenance could
 * launder a web page's contents in as something the owner asserted, which is the
 * whole memory-poisoning problem in one field. The owner pressing the button is
 * the origin, and Core says so itself.
 */

export interface BrainMirror {
  readonly projection: BrainProjection | null
  subscribe(listener: (projection: BrainProjection | null) => void): () => void
  attach(): Promise<() => void>

  /**
   * Ask Freya to remember something.
   *
   * Refusals are returned, not thrown. A rejected memory is a policy decision that
   * a person is entitled to read about, and it arrives in the same shape as a
   * success so the UI has one path rather than two.
   */
  write(input: {
    content: string
    subject?: string
    kind?: string
  }): Promise<BrainCommandOutcome>

  /** Withdraw a memory. Archived, never deleted. */
  archive(memoryId: string, reason?: string): Promise<BrainCommandOutcome>

  /**
   * Recall on demand.
   *
   * Bounded twice: the bridge refuses an oversized payload before it is cloned
   * across, and `clampBudget` caps it again inside Core. A window cannot ask for
   * an unbounded pack.
   */
  recall(query: string, limit?: number): Promise<BrainCommandOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/**
 * Shown before Core has ever reported.
 *
 * `health: 'unavailable'` with a stated reason, matching the conversation mirror's
 * `core-absent`. A panel must be able to say "I don't know" distinctly from "she
 * has learned nothing" — in a memory surface those look identical otherwise, and
 * they are very different states.
 */
const ABSENT_PROJECTION: BrainProjection = {
  health: 'unavailable',
  reason: 'Core has not reported yet',
  persistence: 'unavailable',
  durable: false,
  identity: null,
  self: null,
  counts: {
    entities: 0,
    relations: 0,
    observations: 0,
    memories: 0,
    admitted: 0,
    conflicted: 0,
    rejected: 0,
    experiences: 0,
  },
  recentAdmissions: [],
  conflicts: [],
  sequence: 0,
}

let shared: BrainMirror | null = null
let attachPromise: Promise<BrainMirror> | null = null

export function brainMirror(): BrainMirror {
  shared ??= createBrainMirror()
  return shared
}

export function ensureBrainAttached(): Promise<BrainMirror> {
  attachPromise ??= brainMirror().attach().then(() => brainMirror())
  return attachPromise
}

export function resetBrainMirror(): void {
  shared = null
  attachPromise = null
}

export function createBrainMirror(): BrainMirror {
  const listeners = new Set<(projection: BrainProjection | null) => void>()
  let current: BrainProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: BrainProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Submit one Brain command and return Core's own outcome.
   *
   * A Core that cannot be reached resolves with a refusal rather than rejecting,
   * because a window reloading mid-call should produce a sentence on screen and not
   * an unhandled rejection in somebody's console.
   */
  const submit = async (
    command: 'brain.memory.write' | 'brain.memory.archive' | 'brain.recall',
    payload?: unknown,
  ): Promise<BrainCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge) {
      return { operation: 'memory-refused', reason: 'the Core bridge is not available in this window' }
    }
    let result
    try {
      result = await bridge.coreSubmit(command, payload)
    } catch (error) {
      return {
        operation: 'memory-refused',
        reason: `Freya Core could not be reached — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    }
    return (result.brain as BrainCommandOutcome | undefined) ?? {
      operation: 'memory-refused',
      reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no Brain result',
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

    write: (input) => submit('brain.memory.write', input),

    archive: (memoryId, reason) =>
      submit('brain.memory.archive', reason === undefined ? { memoryId } : { memoryId, reason }),

    recall: (query, limit) =>
      submit('brain.recall', limit === undefined ? { query } : { query, limit }),

    async attach(): Promise<() => void> {
      disposeBridge?.()
      const bridge = hostBridge()
      if (!bridge) {
        publish(ABSENT_PROJECTION)
        return () => {}
      }
      disposeBridge = bridge.onCoreBrain((projection) => publish(projection))
      // Backstop for a push that raced the subscription, same as for status and
      // conversation.
      try {
        publish((await bridge.coreBrain()) ?? ABSENT_PROJECTION)
      } catch {
        publish(ABSENT_PROJECTION)
      }
      return disposeBridge
    },

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}

/**
 * Whether Freya will remember this across a restart.
 *
 * Deliberately narrow: it asks about durability, not health. A degraded Brain can
 * still be durable — one unreadable record does not make the log ephemeral — and a
 * healthy Brain can be ephemeral. Collapsing the two would produce a panel that
 * says "memory is fine" on a machine that forgets everything.
 */
export function isDurable(projection: BrainProjection | null): boolean {
  return projection?.durable === true
}