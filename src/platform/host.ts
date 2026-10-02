import type {
  CoreCommandName,
  CoreCommandResult,
  CoreStatus,
} from '../../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../../core/protocol/activity'
import type { ConversationProjection, VoiceProjection } from '../../core/protocol/conversation'
import type { BrainProjection } from '../../core/brain/brain'
import type { WorkProjection } from '../../core/work/projection'
import type { MissionProjection } from '../../core/missions/types'
import type { WorkforceProjection } from '../../core/protocol/workforce'
import type { ContextProjection } from '../../core/protocol/context'
import type { PersonalityProjection } from '../../core/protocol/personality'
import type { AttentionProjection } from '../../core/protocol/attention'
import type { OfficeProjection } from '../../core/office/projection'

/**
 * The shape of the desktop bridge, declared once.
 *
 * `electron/preload.ts` is the only place these functions are implemented, and
 * this file is the only place the renderer describes them. Having two
 * declarations of `window.freyaHost` would let the two drift — one would
 * describe a bridge the other does not have — so the interface lives here and
 * both the workspace store and the Core client import it.
 *
 * The list is the whole privileged surface. Anything not named here does not
 * exist as far as the renderer is concerned.
 */

/** What the host reports verbatim. */
export interface HostRuntimeInfo {
  version: string
  electron: string
  platform: string
  arch: string
  userData: string
  workspaceFile: string
  dev: boolean
}

/** What the shell uses: platform and arch folded into one label. */
export interface RuntimeInfo {
  version: string
  platform: string
  userData: string
  workspaceFile: string
  dev: boolean
}

export interface FreyaHostBridge {
  isDesktop: true

  getRuntimeInfo(): Promise<HostRuntimeInfo>
  loadWorkspace(): Promise<unknown>
  saveWorkspace(payload: unknown): Promise<boolean>
  /** The host asks for the current layout as the window is closing. */
  onCollect(handler: () => unknown): void

  coreSubmit(command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult>
  coreStatus(): Promise<CoreStatus>
  /** Returns a disposer, so a React effect can clean up. */
  onCoreStatus(handler: (status: CoreStatus) => void): () => void

  /**
   * Display-ready activity, derived from durable events.
   *
   * The absence of a generic event reader here is the security property, not an
   * oversight. A window can have rows; it cannot have the journal.
   */
  coreActivity(): Promise<CoreActivityEvent[]>
  onCoreActivity(handler: (activity: CoreActivityEvent[]) => void): () => void

  /**
   * The conversation projection, and the voice status.
   *
   * Content crosses here because a transcript has to be rendered. Nothing that
   * *protects* it crosses: no key, no store, no path, no way to name a provider.
   * There is also no function here that configures a speech service, because voice
   * is local-only and there is no service to configure.
   */
  coreConversation(): Promise<ConversationProjection | null>
  onCoreConversation(handler: (projection: ConversationProjection) => void): () => void
  coreVoice(): Promise<VoiceProjection | null>

  /**
   * The Brain projection.
   *
   * Its own channel, and note what does **not** cross: no memory content, no key,
   * no store, no path. The projection carries identity, the self-model, counts,
   * subjects and source classes. Content arrives only through an explicit
   * `brain.recall` — a question with a query, not a standing feed — so an open
   * window cannot hold a copy of everything Freya knows.
   */
  coreBrain(): Promise<BrainProjection | null>
  onCoreBrain(handler: (projection: BrainProjection) => void): () => void

  /**
   * The Work projection: tasks, runs, steps, approvals and progress.
   *
   * Its own channel, and the note that matters is about what does **not** cross: no
   * step input, no observation contents, no plan, no capability or verifier
   * instance. A window can see that work is running, waiting on a person, or
   * finished, and whether each step verified — which is everything a board needs —
   * without being able to read what any capability was given or returned, or to
   * reach the code that would let it describe its own approval.
   *
   * Nothing here is writable. A window submits commands; Core owns the state and
   * overwrites the mirror whenever it moves.
   */
  coreWork(): Promise<WorkProjection | null>
  onCoreWork(handler: (projection: WorkProjection) => void): () => void

  /**
   * The Mission projection, and the Mission surface's own channel.
   *
   * Same bargain as every other subsystem here: the projection is what a window needs
   * to render, and the substance does not cross. No title, no intent, no success
   * criteria arrive on this channel — those are in the encrypted store and come back
   * only from an explicit `coreMissionDetail` read. So a window sitting open does not
   * hold a copy of what the owner asked Freya to do, and `persistence` crosses
   * precisely so it can say `FORGETS ON QUIT` when that is the truth.
   */
  coreMission(): Promise<MissionProjection | null>
  onCoreMission(handler: (projection: MissionProjection) => void): () => void

  /**
   * The Workforce projection: which workers and teams exist, and what Core says
   * each is doing.
   *
   * Same bargain as every other channel, and here the note that matters is what
   * has no function at all: there is nothing on this bridge that names a
   * worker, places one on a team, assigns a capability, records a claim or
   * reaches the source Core read. The list above *is* the privileged surface —
   * a window can look at the workforce, and cannot touch it in any direction.
   */
  coreWorkforce(): Promise<WorkforceProjection | null>
  onCoreWorkforce(handler: (projection: WorkforceProjection) => void): () => void

  /**
   * The Context projection, exactly as Core last reported it — or `null` when
   * no Core is reporting context at all, which is the truth about every build
   * in this repository until issue #15's domain lands in Core.
   *
   * The note that matters is the same shape as every other channel's, and here
   * it is even simpler: these are the *only* two Context functions on the
   * bridge. There is nothing that names an item, files a provenance, requests
   * a scope, sets an expiry, revokes anything or resolves a reference, because
   * Context authority belongs to Core and no part of it is a construction this
   * window is allowed to supply. The absence is structural: no channel carries
   * a payload *in* this direction at all.
   */
  coreContext(): Promise<ContextProjection | null>
  onCoreContext(handler: (projection: ContextProjection) => void): () => void

  /**
   * The Personality projection, exactly as Core last reported it — or `null`
   * when no Core is reporting, which is the truth about every build in this
   * repository, because the relationship domain has no persistence yet.
   *
   * These two functions are the *whole* of the window's Personality privilege,
   * and the absence of a third is the security property rather than an
   * oversight: nothing on this bridge records a preference, marks a habit,
   * files an inside joke, asserts a confidence, names a provenance or chooses a
   * cue. What arrives is Core's report — metadata, closed labels, counts — and
   * there is no payload-carrying direction in which a window could add to it.
   */
  corePersonality(): Promise<PersonalityProjection | null>
  onCorePersonality(handler: (projection: PersonalityProjection) => void): () => void

  /**
   * The Attention projection, exactly as Core last reported it — or `null` when no
   * Core is reporting.
   *
   * Two functions, same as Context and Personality. What crosses is Core's report:
   * counts, the focus reading, closed labels and at most one cue. The event's
   * **text** does not cross — only its measured length — and there is no function
   * here that names a source, sets an importance, decides an outcome, spends a
   * budget or bypasses a cooldown. Ingestion is a command with a narrow payload
   * contract, and this read lends no authority in either direction.
   */
  coreAttention(): Promise<AttentionProjection | null>
  onCoreAttention(handler: (projection: AttentionProjection) => void): () => void

  /**
   * The Office projection: Freya's station, live run stations, worker stations,
   * approval stations and the history timeline.
   *
   * Same bargain as every other channel. What crosses is Core's report —
   * stations, counts, history and pending presence requests — and there is no
   * function here that invents a station, inflates a count or fabricates a
   * percentage. The Office is a pure function of real Work/Workforce/Core
   * state, and this bridge is a forwarding box on the way to it.
   */
  coreOffice(): Promise<OfficeProjection | null>
  onCoreOffice(handler: (projection: OfficeProjection) => void): () => void
}

declare global {
  interface Window {
    freyaHost?: FreyaHostBridge
  }
}

export function hostBridge(): FreyaHostBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.freyaHost
}
