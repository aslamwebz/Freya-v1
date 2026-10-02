import {
  ABSENT_RELAY_PROJECTION,
  type RelayCommandOutcome,
  type RelayProjection,
  type RelayReadResult,
} from '../../core/protocol/relay'
import { hostBridge } from './host'

/**
 * The renderer's view of Relay.
 *
 * A mirror, in the same sense as every other subsystem's: every field arrived
 * from Core over a channel the window cannot write into, and the renderer
 * cannot write one either. There is no renderer-side Relay state — no local
 * availability, no local approval, no local budget — because a local copy
 * would be a second source of truth about what is connected, and the one a
 * person would trust more than Core's.
 *
 * ## What a window may do
 *
 * It may **read** the projection, **request** a read on a connector, and
 * **request** a write — which creates a pending approval and executes only
 * after the owner decides. It may **decide** a pending approval. Every one of
 * those is a `coreSubmit` with a narrow payload contract, and none of them can
 * carry a capability, a credential, a budget or a connector registration —
 * those are Core's. It may not register a connector, fault one or set an
 * allowlist: there is deliberately no method here that could.
 */
export interface RelayMirror {
  readonly projection: RelayProjection | null
  subscribe(listener: (projection: RelayProjection | null) => void): () => void
  attach(): Promise<() => void>

  /** Pull Core's current projection. Argument-free by construction. */
  read(): Promise<RelayProjection | null>

  /** Request a read on a connector. Core validates and executes directly. */
  requestRead(input: RelayReadInput): Promise<RelayCommandOutcome>

  /**
   * Request a write. Core validates and creates a pending approval; the
   * action executes only after the owner decides.
   */
  requestWrite(input: RelayWriteInput): Promise<RelayCommandOutcome>

  /** Decide a pending approval. Single-use: a decided approval is final. */
  decide(approvalId: string, decision: 'approved' | 'denied'): Promise<RelayCommandOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** What a read request may carry. A query, a limit and a cursor — nothing else. */
export type RelayReadInput =
  | { command: 'relay.email.read'; query?: string; limit?: number; cursor?: string }
  | { command: 'relay.calendar.read'; query?: string; limit?: number; cursor?: string }
  | { command: 'relay.github.read'; repo: string; limit?: number; cursor?: string }

/** What a write request may carry. The fields the action owns — nothing else. */
export type RelayWriteInput =
  | {
      command: 'relay.email.draft.create'
      to: string
      cc?: string
      subject: string
      body: string
      attachments?: { filename: string; contentType: string; sizeBytes: number }[]
    }
  | {
      command: 'relay.email.send'
      to: string
      cc?: string
      subject: string
      body: string
      attachments?: { filename: string; contentType: string; sizeBytes: number }[]
      idempotencyKey: string
    }
  | {
      command: 'relay.calendar.create'
      title: string
      startsAt: string
      endsAt: string
      location?: string
      attendees?: string
      idempotencyKey: string
    }
  | {
      command: 'relay.calendar.update'
      eventId: string
      title?: string
      startsAt?: string
      endsAt?: string
      location?: string | null
      attendees?: string
      idempotencyKey: string
    }
  | { command: 'relay.calendar.cancel'; eventId: string; idempotencyKey: string }
  | {
      command: 'relay.github.issue.create'
      repo: string
      title: string
      body: string
      idempotencyKey: string
    }
  | {
      command: 'relay.github.pr.create'
      repo: string
      head: string
      base: string
      title: string
      body: string
      idempotencyKey: string
    }
  | {
      command: 'relay.external.invoke'
      connector: string
      operation: string
      params?: (string | number | boolean)[]
      idempotencyKey: string
    }

/** Shown before Core has ever reported, matching the other mirrors' absent state. */
const ABSENT: RelayProjection = ABSENT_RELAY_PROJECTION

let shared: RelayMirror | null = null
let attachPromise: Promise<RelayMirror> | null = null

export function relayMirror(): RelayMirror {
  shared ??= createRelayMirror()
  return shared
}

export function ensureRelayAttached(): Promise<RelayMirror> {
  attachPromise ??= relayMirror().attach().then(() => relayMirror())
  return attachPromise
}

export function resetRelayMirror(): void {
  shared = null
  attachPromise = null
}

export function createRelayMirror(): RelayMirror {
  const listeners = new Set<(projection: RelayProjection | null) => void>()
  const subscriptions = new Set<() => void>()
  let current: RelayProjection | null = null

  const publish = (projection: RelayProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Pull the projection. The call is made with **no arguments**, so this is a
   * pull of what Core reports, never a push of what the window believes.
   */
  const read = async (): Promise<RelayProjection | null> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreRelay !== 'function') return null
    try {
      const projection = await bridge.coreRelay()
      if (current === null) publish(projection ?? ABSENT)
      return projection
    } catch {
      return null
    }
  }

  /** Submit and, on success, let Core's push be the only thing that updates state. */
  const submit = async (command: string, payload: unknown): Promise<RelayCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreSubmit !== 'function') {
      return { operation: 'refused', ok: false, reason: 'the Core bridge is not available in this window' }
    }
    try {
      const result = await bridge.coreSubmit(command as never, payload)
      if (result.relay) return result.relay
      return {
        operation: 'refused',
        ok: false,
        reason: result.refusal?.reason ?? result.error?.message ?? 'Core did not answer the Relay command',
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
     * deliberate, for the same reason every other client gives: a change that
     * lands between the pull resolving and the subscription registering would
     * be lost.
     */
    async attach() {
      const bridge = hostBridge()
      // A bridge that predates this lane (or a test double that does not model it)
      // is tolerated rather than crashing a window: the mirror simply stays absent,
      // which is the honest reading of "no Relay channel here".
      if (!bridge || typeof bridge.onCoreRelay !== 'function') return () => {}
      const own = bridge.onCoreRelay((projection) => publish(projection))
      subscriptions.add(own)
      try {
        publish((await bridge.coreRelay()) ?? ABSENT)
      } catch {
        if (current === null) publish(null)
      }
      return () => {
        subscriptions.delete(own)
        own()
      }
    },

    read,

    async requestRead(input) {
      return submit(input.command, input)
    },

    async requestWrite(input) {
      return submit(input.command, input)
    },

    async decide(approvalId, decision) {
      return submit('relay.approval.decide', { approvalId, decision })
    },

    reset() {
      for (const dispose of [...subscriptions]) dispose()
      subscriptions.clear()
      publish(null)
    },
  }
}

/** The read result of one read request, for surfaces that render content. */
export function readResultOf(outcome: RelayCommandOutcome): RelayReadResult | null {
  if (outcome.ok && outcome.result && 'kind' in outcome.result) {
    const result = outcome.result
    if (
      result.kind === 'email.messages' ||
      result.kind === 'calendar.events' ||
      result.kind === 'github.issues' ||
      result.kind === 'external.result'
    ) {
      return result
    }
  }
  return null
}
