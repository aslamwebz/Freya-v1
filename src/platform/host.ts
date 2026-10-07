import type {
  CoreCommandName,
  CoreCommandResult,
  CoreStatus,
} from '../../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../../core/protocol/activity'
import type { BrowserRequest, BrowserResult } from '../../core/browser'
import type { BrowserBridgeState } from '../../electron/browser/rendererRequest'
import type { ConversationProjection, VoiceProjection } from '../../core/protocol/conversation'
import type { VoiceTranscriptFragment } from '../../core/voice/types'
import type { VoiceOutputInstruction } from '../../electron/voiceHost'
import type { VoiceSettings } from '../../core/voice/settings'
import type { BrainProjection } from '../../core/brain/brain'
import type { WorkProjection } from '../../core/work/projection'
import type { MissionProjection } from '../../core/missions/types'
import type { WorkforceProjection } from '../../core/protocol/workforce'
import type { ContextProjection } from '../../core/protocol/context'
import type { PersonalityProjection } from '../../core/protocol/personality'
import type { AttentionProjection } from '../../core/protocol/attention'
import type { RelayProjection } from '../../core/protocol/relay'
import type { FoundryProjection } from '../../core/protocol/foundry'
import type { OfficeProjection } from '../../core/office/projection'
import type { SkillProjection } from '../../core/protocol/skills'
import type { LifeProjection } from '../../core/protocol/life'
import type { ConsciousContextProjection } from '../../core/protocol/consciousness'
import type { LifeLoopProjection } from '../../core/protocol/lifeloop'
import type { WorldSummaryView } from '../../core/protocol/world'

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

/**
 * The masked provider view a window may read.
 *
 * Structurally the same shape `electron/providerConfig.ts` returns: the non-secret
 * companions plus `hasKey`. The key itself is not named here, because the renderer
 * has no field for it and this declaration is the whole of what the bridge admits.
 */
export interface ProviderConfigView {
  baseUrl: string
  model: string
  liveEnabled: boolean
  hasKey: boolean
  /**
   * Which of four credential situations this is.
   *
   * `hasKey` alone could not carry the difference between "never set a key", "this
   * machine cannot protect a key" and "a key is stored but will not unwrap", and each
   * of those needs a different thing from the person reading it. The bridge reports
   * which one it is rather than making a surface infer it.
   */
  credentialState: 'none' | 'stored' | 'storage-unavailable' | 'unreadable'
  /** A fixed sentence explaining the state, or null. Never carries a value. */
  credentialReason: string | null
}

/** The provider fields a window may set. `apiKey` is write-only and optional. */
export interface ProviderConfigPatch {
  baseUrl?: string
  model?: string
  liveEnabled?: boolean
  apiKey?: string
}

/** Renderer-safe description of one bounded file attachment. */
export interface AttachmentResult {
  readonly name: string
  readonly path: string
  readonly kind: 'text' | 'image' | 'unsupported'
  readonly contentType: string
  readonly sizeBytes: number
  readonly text: string | null
  readonly truncated: boolean
  readonly detail: string | null
}

export interface FreyaHostBridge {
  voiceWakeStatus?(): Promise<{ ready: boolean; frames: number; detections: number; peak: number }>
  voiceWakeAudio?(audio: Uint8Array): void
  voiceSettingsRead?(): Promise<VoiceSettings>
  voiceSettingsWrite?(patch: Partial<VoiceSettings>): Promise<VoiceSettings>
  isDesktop: true

  getRuntimeInfo(): Promise<HostRuntimeInfo>
  loadWorkspace(): Promise<unknown>
  saveWorkspace(payload: unknown): Promise<boolean>
  /** The host asks for the current layout as the window is closing. */
  onCollect(handler: () => unknown): void

  /**
   * Ask the host to open a file picker and read what it chose.
   *
   * No path crosses in either direction. The host parents the dialog to the
   * calling window, does a bounded read, and returns a typed outcome; there is no
   * companion function that takes a path from the renderer, because that would be
   * an arbitrary filesystem read.
   */
  attachmentPick(): Promise<unknown>

  /**
   * Fetch a picture to draw, on the window's behalf.
   *
   * The window never fetches media itself: the address came out of a search result,
   * and a window that could fetch an arbitrary address would be a way to reach the
   * owner's own network. The main process answers with a `data:` URL or a refusal.
   */
  mediaThumbnail(url: string): Promise<unknown>

  /** A document's bytes, as base64. Never a path, so the window gets no file handle. */
  mediaDocument(url: string): Promise<unknown>

  /** A direct video's validated bytes as a data URL, only for an opened preview. */
  mediaVideo(url: string): Promise<unknown>

  /**
   * Attach the hosted player at the given box, and detach it.
   *
   * The main process re-checks the player allowlist, so the renderer names the
   * address it wants but never decides whether it may be framed.
   */
  mediaEmbedAttach?(request: { url: string; x: number; y: number; width: number; height: number }): Promise<unknown>
  mediaEmbedDetach?(): Promise<unknown>

  /** Frameless-window controls. Each acts on the window that calls. */
  windowMinimize(): Promise<void>
  windowMaximize(): Promise<void>
  windowClose(): Promise<void>

  /**
   * The renderer-safe dual-browser surface.
   *
   * No Electron window, adapter, journal or browser authority crosses this seam.
   * A request submitted here is re-bounded by preload/main and then routed through
   * the existing dual-browser runtime, which remains behind Device Hands.
   */
  browserState(): Promise<BrowserBridgeState>
  browserExecute(request: BrowserRequest): Promise<BrowserResult>

  /**
   * The provider settings, and the one place a credential crosses this bridge — in
   * one direction only.
   *
   * `providerConfig` returns the masked view: base URL, model, the live flag and
   * whether a key is stored. It never returns the key, because the key never leaves
   * the main process and there is no field on the response for it.
   *
   * `saveProviderConfig` accepts the four named fields. The key goes in and a masked
   * view comes back, so a window can set a credential and confirm it was stored
   * without ever being able to read it back. The main process saves first and then
   * rebuilds Core's environment, so a saved setting takes effect without a relaunch.
   */
  providerConfig(): Promise<ProviderConfigView>
  saveProviderConfig(input: ProviderConfigPatch): Promise<ProviderConfigView>

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
  onCoreVoice(handler: (projection: VoiceProjection) => void): () => void

  /**
   * Transcript fragments, interim and final.
   *
   * Their own channel from the projection because the two have opposite trust. An
   * interim fragment is a guess an engine is still revising, and there is no
   * command on this bridge that would submit one — the conversation path takes
   * text a person confirmed.
   */
  onCoreVoiceTranscript(handler: (fragment: VoiceTranscriptFragment) => void): () => void

  /**
   * Playback instructions, and the capability report that goes the other way.
   *
   * `onVoiceOutput` is how the host's speech adapter reaches the window: Core
   * decided which stored answer may be spoken, the host read the words out of
   * Core's own answer, and the window plays them. There is deliberately no
   * function here that sends *text* to be spoken — a window cannot put a sentence
   * in Freya's mouth.
   *
   * `reportVoiceCapabilities` is the only other direction, and it is a report of
   * what the platform's speech engine turned out to be. "I have none" is as
   * welcome as "I do"; both produce an honest projection.
   */
  onVoiceOutput(handler: (instruction: VoiceOutputInstruction) => void): () => void
  reportVoiceCapabilities(report: {
    available: boolean
    voices: readonly { voiceId: string; label: string; language: string | null; isDefault: boolean | null }[]
    detail: string
  }): void

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
  coreRelay(): Promise<RelayProjection | null>
  onCoreRelay(handler: (projection: RelayProjection) => void): () => void


  /**
   * The Skills projection and its subscription. A read and a follow, and nothing else:
   * the bridge has no method that writes a skill body, sets a status, submits a
   * verification record or moves a promotion threshold.
   */
  coreSkills(): Promise<SkillProjection | null>
  onCoreSkills(handler: (projection: SkillProjection) => void): () => void

  /**
   * The Life History projection, read-only.
   *
   * A mirror, in the same sense as every other channel here: every field arrived
   * from Core over a channel the window cannot write into, and the renderer
   * cannot write one either. An entry's own summary and body do not cross here;
   * the one route to them is the explicit `life.entry.read` for a single entry.
   */
  coreLife(): Promise<LifeProjection | null>
  onCoreLife(handler: (projection: LifeProjection) => void): () => void

  /**
   * The unified conscious context and its subscription. A read and a follow.
   *
   * Declared and not yet mirrored on purpose: there is no consumer for it in this
   * repository, so a `consciousnessClient` today would be a cache with no reader -
   * and a cache with no reader is the thing this codebase has consistently refused
   * to add. When a surface needs it, it gets the mirror then, and the mirror's
   * surface-pinning test is written alongside the surface rather than before it.
   *
   * There is no method here that rebuilds, corrects, refreshes or otherwise
   * influences the snapshot.
   */
  coreConsciousness(): Promise<ConsciousContextProjection | null>
  onCoreConsciousness(handler: (projection: ConsciousContextProjection) => void): () => void

  /**
   * The Continuous Life Loop and its subscription. A read and a follow.
   *
   * Declared and not mirrored on the same reasoning as the conscious context above:
   * no surface consumes it in this repository, so a `lifeLoopClient` today would be
   * a cache with no reader.
   *
   * There is no method here that wakes the loop, ticks it, spends on it, lifts a
   * stop or shortens a deadline — and that is the point of declaring the lane
   * rather than leaving it out. "No renderer may drive the loop" is only checkable
   * if the interface it would be driven *through* is written down and visibly has
   * no such method on it.
   */
  coreLifeLoop(): Promise<LifeLoopProjection | null>
  onCoreLifeLoop(handler: (projection: LifeLoopProjection) => void): () => void

  /**
   * The World & self summary.
   *
   * The narrowest lane in this file, and it is declared rather than left out for
   * the same reason the Life Loop lane is. Only the *summary* crosses here: the
   * entity graph, the relation walk, the inspector and the self status are all
   * reached through `coreSubmit` with a read command, which Core Guard-evaluates.
   *
   * There is deliberately no method here that submits a claim. The two owner-facing
   * world commands exist in Core and are owner-only through Guard, and they are
   * absent from the preload command allowlist — so a renderer cannot create an
   * entity, a relation, a trust level or a confidence even holding this bridge. A
   * summary with no verb attached to it is what makes that checkable by reading the
   * interface rather than by auditing a channel list.
   */
  coreWorld(): Promise<WorldSummaryView | null>
  onCoreWorld(handler: (projection: WorldSummaryView) => void): () => void


  coreFoundry(): Promise<FoundryProjection | null>
  onCoreFoundry(handler: (projection: FoundryProjection) => void): () => void

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
