import type { CoreCommandName } from '../../core/protocol/core-protocol'
import { ABSENT_MISSION_PROJECTION } from '../../core/missions/projection'
import type { MissionProjection } from '../../core/missions/types'
import { hostBridge } from './host'

/**
 * The renderer's view of Missions.
 *
 * A mirror, in the same sense `workClient` is: every field arrived over IPC from
 * Core and the renderer cannot write one. There is no renderer-side list of Missions,
 * because a local copy built from local edits would be a second source of truth about
 * an outcome — and the one everybody would trust more than the journal.
 *
 * ## What a window may and may not ask for
 *
 * `create` takes a title, an intent and success criteria, which are the three pieces
 * of text a Mission is made of. It does **not** take a limit, a status, a deadline, a
 * verifier or a principal. A ceiling is Core's, an outcome is a verifier's, and a
 * window that could name either would own the whole claim that a Mission is honest.
 *
 * The lifecycle methods take a `missionId` and nothing else — in particular
 * `requestCompletion` takes no verifier, because a window that could choose the
 * verifier could choose the answer.
 *
 * ## Why the text is not here
 *
 * The projection carries statuses, counts, limits and `persistence`. It carries no
 * title, no intent and no criteria: those live in the encrypted Mission store, and
 * reaching them means asking Core for one Mission rather than holding a standing feed
 * of all of them. A window that is merely open does not keep a copy of everything the
 * owner asked Freya to do.
 */

export interface MissionMirror {
  readonly projection: MissionProjection | null
  subscribe(listener: (projection: MissionProjection | null) => void): () => void
  attach(): Promise<() => void>

  create(input: {
    title: string
    intent: string
    successCriteria?: readonly string[]
  }): Promise<MissionCommandOutcome>
  activate(missionId: string): Promise<MissionCommandOutcome>
  pause(missionId: string): Promise<MissionCommandOutcome>
  resume(missionId: string): Promise<MissionCommandOutcome>
  cancel(missionId: string): Promise<MissionCommandOutcome>
  fail(missionId: string): Promise<MissionCommandOutcome>
  /**
   * Phase 47's two owner actions that need a surface of their own.
   *
   * Declared absent rather than stubbed. `correct` needs a correction composer and
   * `decideApproval` needs an approval prompt, and inventing either here would be the UI
   * redesign this phase does not authorise. The Mission surface filters these out rather
   * than rendering a button that cannot work.
   */
  readonly correct?: (missionId: string) => Promise<MissionCommandOutcome>
  readonly decideApproval?: (
    missionId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
  ) => Promise<MissionCommandOutcome>
  /** Asks a verifier whether the outcome was established. Never sets a status. */
  requestCompletion(missionId: string): Promise<MissionCommandOutcome>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** What a Mission command produced, as the window sees it. */
export interface MissionCommandOutcome {
  operation: string
  ok: boolean
  missionId?: string
  status?: string
  reason?: string
}

/** Shown before Core has ever reported, matching the Work mirror's absent state. */
const ABSENT: MissionProjection = ABSENT_MISSION_PROJECTION

let shared: MissionMirror | null = null
let attachPromise: Promise<MissionMirror> | null = null

export function missionMirror(): MissionMirror {
  shared ??= createMissionMirror()
  return shared
}

export function ensureMissionAttached(): Promise<MissionMirror> {
  attachPromise ??= missionMirror().attach().then(() => missionMirror())
  return attachPromise
}

export function resetMissionMirror(): void {
  shared = null
  attachPromise = null
}

export function createMissionMirror(): MissionMirror {
  const listeners = new Set<(projection: MissionProjection | null) => void>()
  let current: MissionProjection | null = null
  let disposeBridge: (() => void) | null = null

  const publish = (projection: MissionProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Submit one Mission command and return Core's own outcome.
   *
   * A Core that cannot be reached resolves with a refusal rather than rejecting,
   * because a window reloading mid-call should produce a sentence on screen and not an
   * unhandled rejection in somebody's console. `ok: false` travels with it, so a
   * refusal can never be mistaken for success by a caller that reads the flag.
   */
  const submit = async (command: CoreCommandName, payload?: unknown): Promise<MissionCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge) {
      return { operation: 'unavailable', ok: false, reason: 'the Core bridge is not available in this window' }
    }
    let result
    try {
      result = await bridge.coreSubmit(command, payload)
    } catch (error) {
      return {
        operation: 'unreachable',
        ok: false,
        reason: `Freya Core could not be reached — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      }
    }
    return (result.mission as MissionCommandOutcome | undefined) ?? {
      operation: 'unknown',
      ok: false,
      reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no Mission result',
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
     * Pull the current projection once, then follow pushes.
     *
     * Both halves, because a window opening on day seven must agree with one that
     * never left — and because a projection that only arrives on the next change would
     * show an empty board until something happened to it.
     */
    async attach() {
      const bridge = hostBridge()
      if (!bridge) return () => {}
      try {
        publish((await bridge.coreMission()) ?? ABSENT)
      } catch {
        // A Core that cannot be reached leaves the mirror absent rather than throwing
        // during a window's mount.
        publish(null)
      }
      disposeBridge = bridge.onCoreMission((projection) => publish(projection))
      return () => {
        disposeBridge?.()
        disposeBridge = null
      }
    },

    create: (input) =>
      submit('mission.create', {
        title: input.title,
        intent: input.intent,
        ...(input.successCriteria === undefined ? {} : { successCriteria: input.successCriteria }),
      }),

    activate: (missionId) => submit('mission.activate', { missionId }),
    pause: (missionId) => submit('mission.pause', { missionId }),
    resume: (missionId) => submit('mission.resume', { missionId }),
    cancel: (missionId) => submit('mission.cancel', { missionId }),
    fail: (missionId) => submit('mission.fail', { missionId }),
    requestCompletion: (missionId) => submit('mission.requestCompletion', { missionId }),

    reset() {
      disposeBridge?.()
      disposeBridge = null
      publish(null)
    },
  }
}