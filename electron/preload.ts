import { validateModelAttachments } from '../core/model/provider'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  CoreCommandEnvelope,
  CoreCommandName,
  CoreCommandResult,
  CoreStatus,
} from '../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../core/protocol/activity'
import type { BrowserRequest, BrowserResult } from '../core/browser'
import type { SemanticBrowserResult } from '../core/browser/service'
import type { ConversationProjection, VoiceProjection } from '../core/protocol/conversation'
import type { BrainProjection } from '../core/brain/brain'
import type { WorkProjection } from '../core/work/projection'
import { CONVERSATION_LIMITS } from '../core/conversation/types'
import { VOICE_CHANNEL_COUNTS, VOICE_CODECS, VOICE_LIMITS, VOICE_MIME_TYPES, VOICE_SAMPLE_RATES, type VoiceTranscriptFragment } from '../core/voice/types'
import type { VoiceOutputInstruction } from './voiceHost'
import { BRAIN_LIMITS } from '../core/brain/types'
import { WORK_LIMITS } from '../core/work/types'
import { DEFAULT_MISSION_LIMITS as MISSION_LIMITS } from '../core/missions/types'
import type { MissionProjection } from '../core/missions/types'
import { WORKFORCE_NO_PAYLOAD } from '../core/protocol/workforce'
import type { WorkforceProjection } from '../core/protocol/workforce'
import type { ContextProjection } from '../core/protocol/context'
import type { PersonalityProjection } from '../core/protocol/personality'
import type { AttentionProjection } from '../core/protocol/attention'
import { ATTENTION_NO_PAYLOAD } from '../core/protocol/attention'
import type { FoundryProjection } from '../core/protocol/foundry'
import type { ForgeProjection } from '../core/protocol/forge'
import { FOUNDRY_NO_PAYLOAD } from '../core/protocol/foundry'
import { ATTENTION_LIMITS } from '../core/attention/types'
import type { RelayProjection } from '../core/protocol/relay'
import { RELAY_NO_PAYLOAD } from '../core/protocol/relay'
import type { ConnectorProjection } from '../core/protocol/connectors'
import { CONNECTOR_NO_PAYLOAD } from '../core/protocol/connectors'
import { RELAY_LIMITS } from '../core/relay/types'
import type { OfficeProjection } from '../core/office/projection'
import type { SkillProjection } from '../core/protocol/skills'
import type { WorldSummaryView } from '../core/protocol/world'
import type { ConsciousContextProjection } from '../core/protocol/consciousness'
import type { LifeLoopProjection } from '../core/protocol/lifeloop'
import { SKILL_NO_PAYLOAD } from '../core/protocol/skills'
import { SKILL_LIMITS } from '../core/skills/types'
import type { ProviderConfig, ProviderConfigInput } from './providerConfig'
import { voiceSettingsPatch } from '../core/voice/settings'
import { checkProviderBaseUrl } from '../core/model/provider-endpoint'
import { LIFE_NO_PAYLOAD, type LifeProjection } from '../core/protocol/life'
import { normaliseRendererBrowserRequest, type BrowserBridgeState } from './browser/rendererRequest'
import { normaliseSemanticBrowserRequest } from './browser/semanticRequest'
import type { VoiceConfig, VoiceConfigPatch } from './voiceConfig'

export interface RuntimeInfo {
  version: string
  electron: string
  platform: string
  arch: string
  userData: string
  workspaceFile: string
  dev: boolean
}

/**
 * The entire privileged surface of the Freya desktop host.
 *
 * Four functions and one flag for the workspace, five for the Core, and one
 * flag: `getRuntimeInfo`, `loadWorkspace`, `saveWorkspace`, `onCollect`,
 * `coreSubmit`, `coreStatus`, `onCoreStatus`, `coreActivity`, `onCoreActivity`,
 * and `isDesktop`. No ipcRenderer passthrough, no remote module, no eval, and no
 * way to name an IPC channel from the renderer. A renderer compromise gets an
 * attacker exactly what this file exposes.
 *
 * The Core functions are named individually rather than exposing a channel
 * string, so the renderer cannot invent a command name at the bridge. The
 * command list is checked here as well as in Core: the renderer is the owner's
 * UI, not the authority, and an unrecognised name is refused before it can be
 * serialised into an IPC message.
 */
const api = {
  isDesktop: true as const,
  getDesktopView: (): Promise<'dashboard' | 'mini-chat'> => ipcRenderer.invoke('freya:desktop:view:get'),
  onDesktopView: (handler: (view: 'dashboard' | 'mini-chat') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, view: unknown): void => {
      if (view === 'dashboard' || view === 'mini-chat') handler(view)
    }
    ipcRenderer.on('freya:desktop:view', listener)
    return () => ipcRenderer.removeListener('freya:desktop:view', listener)
  },
  getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke('freya:runtime'),
  loadWorkspace: (): Promise<unknown> => ipcRenderer.invoke('freya:workspace:load'),
  saveWorkspace: (payload: unknown): Promise<boolean> =>
    ipcRenderer.invoke('freya:workspace:save', payload),

  /**
   * Ask the host to open a file picker and read what came back.
   *
   * The renderer names nothing. It sends no path and receives none — the host
   * opens the dialog on the asking window, performs a bounded read behind it, and
   * returns a typed outcome. That asymmetry is the point: a channel taking a path
   * from a renderer would be an arbitrary filesystem read, so there deliberately
   * is no companion function that does that.
   */
  attachmentPick: (): Promise<unknown> => ipcRenderer.invoke('freya:attachment:pick'),

  /**
   * Fetch a picture to draw, and hand back bytes rather than an address.
   *
   * The window names what it wants to see; the main process decides whether it may be
   * fetched and does the fetching. That asymmetry is the whole point — a window that
   * fetched its own pictures would be making requests to addresses that came out of a
   * search result, which is the shape of request that turns a search result into a way
   * to reach the owner's own network. What comes back is a `data:` URL, which cannot
   * phone anywhere.
   *
   * A refusal is an ordinary answer here, not an exception: a card that cannot be
   * drawn shows nothing, and a card that draws an error page is worse.
   */
  mediaThumbnail: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('freya:media:thumbnail', boundedMediaUrl(url)),

  /** A document's bytes, for the PDF renderer. Base64, never a path. */
  mediaDocument: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('freya:media:document', boundedMediaUrl(url)),

  /** A direct video preview, fetched and byte-validated by the main process. */
  mediaVideo: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('freya:media:video', boundedMediaUrl(url)),

  /**
   * Attach the hosted video player over the modal's player box.
   *
   * The window names the address and the box; the main process re-checks the
   * player allowlist, owns the view and draws it at those bounds. Nothing is
   * iframed from the transcript, and only one player exists per window.
   */
  mediaEmbedAttach: (request: { url: string; x: number; y: number; width: number; height: number }): Promise<unknown> =>
    ipcRenderer.invoke('freya:media:embed-attach', request),

  /** Detach this window's hosted player; stops playback and frees the view. */
  mediaEmbedDetach: (): Promise<unknown> =>
    ipcRenderer.invoke('freya:media:embed-detach'),

  // Frameless-window controls. Each acts on the window that asked.
  windowMinimize: (): Promise<void> => ipcRenderer.invoke('freya:window:minimize'),
  windowMaximize: (): Promise<void> => ipcRenderer.invoke('freya:window:maximize'),
  windowClose: (): Promise<void> => ipcRenderer.invoke('freya:window:close'),

  /**
   * The owner-facing dual-browser seam.
   *
   * This is deliberately not a Core command and not a generic IPC tunnel. The
   * existing Phase 51 runtime lives in main because it owns Electron browser
   * windows; this bridge only exposes its renderer-safe projection and one bounded
   * request shape. Every actual page action still goes through Device Hands inside
   * that runtime.
   */
  getCapabilitySettings: () => ipcRenderer.invoke('freya:capabilities:read'),
  setCapabilitySettings: (input: unknown) => ipcRenderer.invoke('freya:capabilities:write', input),
  browserDock: (input: unknown): Promise<boolean> => ipcRenderer.invoke('freya:browser:dock', input),
  onBrowserOpenUrl: (handler: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: unknown) => { if (typeof url === 'string' && url.length <= 4096 && /^https?:\/\//i.test(url)) handler(url) }
    ipcRenderer.on('freya:browser:open-url', listener)
    return () => ipcRenderer.removeListener('freya:browser:open-url', listener)
  },
  browserState: (): Promise<BrowserBridgeState> => ipcRenderer.invoke('freya:browser:state'),
  browserExecute: (input: BrowserRequest): Promise<BrowserResult> => {
    const bounded = normaliseRendererBrowserRequest(input)
    if (!bounded.ok) return Promise.reject(new Error(bounded.reason))
    return ipcRenderer.invoke('freya:browser:execute', bounded.request)
  },

  /**
   * One Semantic Browser Protocol operation.
   *
   * Normalised here *and* in the main process, on purpose. The preload check gives the
   * renderer an immediate refusal rather than a round trip; the main process check is the one
   * that counts, because a renderer that is not this preload is not stopped by this preload.
   *
   * The normaliser refuses a request with no element reference, a reference that is not in
   * the `rN` shape, or no snapshot revision — so an act cannot be expressed without saying
   * which instant it was decided from.
   */
  browserCommand: (input: unknown): Promise<SemanticBrowserResult> => {
    const bounded = normaliseSemanticBrowserRequest(input)
    if (!bounded.ok) {
      return Promise.resolve({
        ok: false,
        op: 'tabs',
        code: 'request-malformed',
        reason: bounded.reason,
        data: {},
      })
    }
    return ipcRenderer.invoke('freya:browser:command', bounded.request)
  },

  /**
   * The browser state, pushed rather than polled.
   *
   * Every navigation, load, failure and close arrives here. A workspace that listens needs no
   * timer, which is the point: the previous build re-read the whole projection every 800 ms
   * whether or not anything had changed, and the cost of that grows with the tab count.
   */
  onBrowserEvent: (handler: (state: BrowserBridgeState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value !== 'object' || value === null) return
      handler(value as BrowserBridgeState)
    }
    ipcRenderer.on('freya:browser:event', listener)
    return () => ipcRenderer.removeListener('freya:browser:event', listener)
  },

  /**
   * Provider settings, and the one place a credential crosses this bridge — in
   * one direction only.
   *
   * `providerConfig` returns the masked view: base URL, model, the live flag and
   * whether a key is stored. It never returns the key, because the key never
   * leaves the main process and there is no field on the response for it.
   *
   * `saveProviderConfig` accepts the four named fields, rebuilt here from bounded
   * values exactly like a Core command payload. The key goes in and a masked view
   * comes back, so a window can set a credential and confirm it was stored without
   * ever being able to read it back.
   */
  providerConfig: (): Promise<ProviderConfig> => ipcRenderer.invoke('freya:provider:read'),
  voiceSettingsRead: () => ipcRenderer.invoke('freya:voice:settings:read'),
  voiceWakeStatus: () => ipcRenderer.invoke('freya:voice:wake:status'),
  voiceWakeAudio: (audio: Uint8Array): void => { if (audio instanceof Uint8Array && audio.length > 0 && audio.length <= 8192 && audio.length % 2 === 0) ipcRenderer.send('freya:voice:wake:pcm', audio) },
  voiceSettingsWrite: (input: unknown) => ipcRenderer.invoke('freya:voice:settings:write', voiceSettingsPatch(input)),
  saveProviderConfig: (input: unknown): Promise<ProviderConfig> => {
    const bounded = rendererProviderPayload(input)
    if (!bounded.ok) return Promise.reject(new Error(bounded.reason))
    return ipcRenderer.invoke('freya:provider:write', bounded.payload)
  },

  voiceConfig: (): Promise<VoiceConfig> => ipcRenderer.invoke('freya:voice-config:read'),
  saveVoiceConfig: (input: unknown): Promise<VoiceConfig> => {
    const bounded = rendererVoiceConfigPayload(input)
    if (!bounded.ok) return Promise.reject(new Error(bounded.reason))
    return ipcRenderer.invoke('freya:voice-config:write', bounded.payload)
  },

  /**
   * A dumb relay. The host asks once, as the window is closing, and the
   * renderer answers by saving through the function above — the host has no way
   * to build a layout and the renderer has no way to be asked in time.
   */
  onCollect: (handler: () => unknown): void => {
    ipcRenderer.on('freya:workspace:collect', () => {
      void api.saveWorkspace(handler())
    })
  },

  /**
   * Send one Core command.
   *
   * `requestId` is generated here rather than supplied, so the renderer cannot
   * collide two requests or replay an id it once saw.
   */
  coreSubmit: (command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult> => {
    if (!CORE_COMMANDS.has(command)) {
      return Promise.resolve({
        requestId: 'rejected',
        ok: false,
        refusal: { reason: `unknown command: ${String(command)}` },
      })
    }

    // The context bridge is a capability boundary, not a generic serializer.
    // Rebuild the payload from the small fields each renderer-reachable command
    // actually owns. This prevents a compromised window from attaching a huge
    // ignored blob to an otherwise valid command and making the main process
    // structured-clone it before Core can reject it.
    const bounded = rendererPayload(command, payload)
    if (!bounded.ok) {
      return Promise.resolve({
        requestId: 'rejected',
        ok: false,
        refusal: { reason: bounded.reason },
      })
    }

    const envelope: CoreCommandEnvelope = {
      command,
      requestId: newRequestId(),
      ...(bounded.payload === undefined ? {} : { payload: bounded.payload }),
    }
    return ipcRenderer.invoke('freya:core:submit', envelope)
  },

  coreStatus: (): Promise<CoreStatus> => ipcRenderer.invoke('freya:core:status'),

  /**
   * The activity feed: display-ready rows derived from durable events.
   *
   * Narrow on purpose. There is no generic "read events" call here, and no
   * channel the renderer can name itself — a window cannot ask for a payload, an
   * event id, or the journal. Command text is not in these rows and never will
   * be, which is the same property the journal itself has.
   */
  coreActivity: (): Promise<CoreActivityEvent[]> => ipcRenderer.invoke('freya:core:activity'),

  onCoreActivity: (handler: (activity: CoreActivityEvent[]) => void): (() => void) => {
    const listener = (_event: unknown, activity: CoreActivityEvent[]): void => handler(activity)
    ipcRenderer.on('freya:core:activity', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:activity', listener)
    }
  },

  /**
   * The conversation projection: the transcript, the conversation list, and
   * whether Freya can currently think.
   *
   * Content crosses here, because a transcript has to be rendered somewhere. What
   * does *not* cross is the store, the key, the filesystem path, or any way to ask
   * for a conversation that is not the one on screen. A window can read a
   * conversation; it cannot decrypt one itself, and it holds no key to do so with.
   */
  coreConversation: (): Promise<ConversationProjection | null> =>
    ipcRenderer.invoke('freya:core:conversation'),

  onCoreConversation: (handler: (projection: ConversationProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: ConversationProjection): void => handler(projection)
    ipcRenderer.on('freya:core:conversation', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:conversation', listener)
    }
  },

  /**
   * Voice status: where the voice state machine actually is, and the bounds.
   *
   * A read and a follow, never a configuration surface. There is no function here
   * that points Freya at a speech service: adapters are supplied by the host when
   * Freya is built, and a window cannot introduce one, name an endpoint, or supply
   * a credential. What a window gets is Core's own report of whether an engine
   * exists — so a microphone button can say "no engine is configured" instead of
   * looking live and quietly doing nothing.
   *
   * Note what does not cross: no audio, no provider name, no key, no way to
   * request permission. `voice.permission.report` is the only permission-related
   * function on this bridge and it is a *report* of what the operating system
   * said, not a request for it.
   */
  coreVoice: (): Promise<VoiceProjection | null> => ipcRenderer.invoke('freya:core:voice'),

  onCoreVoice: (handler: (projection: VoiceProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: VoiceProjection): void => handler(projection)
    ipcRenderer.on('freya:core:voice', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:voice', listener)
    }
  },

  /**
   * Transcript fragments, interim and final.
   *
   * Its own channel from the projection because the two have opposite trust. A
   * fragment marked `interim` is a guess an engine is still revising, and there is
   * no command on this bridge that would submit one — the conversation path takes
   * text a person confirmed.
   *
   * Fragments are pushed, not replayed: a fragment is an event, and re-sending the
   * last one on attach would put words on screen with no capture behind them.
   */
  onCoreVoiceTranscript: (handler: (fragment: VoiceTranscriptFragment) => void): (() => void) => {
    const listener = (_event: unknown, fragment: VoiceTranscriptFragment): void => handler(fragment)
    ipcRenderer.on('freya:core:voice:transcript', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:voice:transcript', listener)
    }
  },

  /**
   * Playback instructions, straight from the host's speech adapter.
   *
   * Not a Core command and not on the conversation path: Core decided *which*
   * stored answer may be spoken, this channel carries the words it read, and the
   * window plays them. The words arrive here rather than being sent from the
   * renderer for exactly that reason — a window cannot name what Freya says.
   *
   * `stop` ends the current utterance at a boundary; `cancel` cuts it off
   * mid-word. The difference is what a person hears, so it is carried rather than
   * collapsed into one "stop".
   */
  onVoiceOutput: (handler: (instruction: VoiceOutputInstruction) => void): (() => void) => {
    const listener = (_event: unknown, instruction: VoiceOutputInstruction): void => handler(instruction)
    ipcRenderer.on('freya:voice:output', listener)
    return () => {
      ipcRenderer.removeListener('freya:voice:output', listener)
    }
  },

  /**
   * Tell the host what this platform's speech engine turned out to be.
   *
   * Sent once at start-up and again whenever the platform changes its voice list.
   * It carries ids, labels and a sentence — no audio, no credential, and no way to
   * ask for anything: this is a capability report, and a window reporting "I have
   * no speech engine" is exactly as welcome as one reporting "I do".
   */
  reportVoiceCapabilities: (report: {
    available: boolean
    voices: readonly { voiceId: string; label: string; language: string | null; isDefault: boolean | null }[]
    detail: string
  }): void => {
    ipcRenderer.send('freya:voice:capabilities', report)
  },

  /**
   * The Brain projection: identity, the self-model, counts, recent admissions and
   * known conflicts.
   *
   * Memory *content* does not cross here — the projection carries subjects, ids,
   * source classes and confidences, not what was remembered. Content comes only
   * through an explicit `brain.recall`, which is a question with a query rather
   * than a standing feed, so a window cannot hold a copy of everything Freya knows
   * by simply being open.
   */
  coreBrain: (): Promise<BrainProjection | null> => ipcRenderer.invoke('freya:core:brain'),

  onCoreBrain: (handler: (projection: BrainProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: BrainProjection): void => handler(projection)
    ipcRenderer.on('freya:core:brain', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:brain', listener)
    }
  },

  /**
   * The Work projection: tasks, runs, steps, approvals and progress.
   *
   * What crosses is exactly what `core/work/projection.ts` says crosses: ids,
   * statuses, counts, measured lengths, and the bounded labels this Core process is
   * holding in memory. What does **not** cross is the substance of the work — no
   * step input, no observation contents, no capability or verifier instance, no
   * plan. A window can see that a step ran and whether it verified; it cannot read
   * what a capability was given or what it returned, and it cannot reach the code
   * that would let it describe its own approval.
   */
  coreWork: (): Promise<WorkProjection | null> => ipcRenderer.invoke('freya:core:work'),

  onCoreWork: (handler: (projection: WorkProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: WorkProjection): void => handler(projection)
    ipcRenderer.on('freya:core:work', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:work', listener)
    }
  },

  /**
   * The Mission projection: statuses, counts, limits and honesty about persistence.
   *
   * What does **not** cross is the point of the whole subsystem: no title, no intent,
   * no success criteria. Those live in the encrypted Mission store and come back only
   * through the explicit `coreMissionDetail` read, which is a question about one
   * Mission rather than a standing feed. A window that is merely open therefore does
   * not hold a copy of everything the owner asked Freya to do.
   *
   * `persistence` crosses precisely so the surface can say `FORGETS ON QUIT` rather
   * than implying durability the store may not have.
   */
  coreMission: (): Promise<MissionProjection | null> => ipcRenderer.invoke('freya:core:mission'),

  onCoreMission: (handler: (projection: MissionProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: MissionProjection): void => handler(projection)
    ipcRenderer.on('freya:core:mission', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:mission', listener)
    }
  },

  /**
   * The Workforce projection: which workers and teams exist, and what Core says
   * each is doing.
   *
   * What crosses is ids, names, states, counts and the labels Core assigned.
   * What does **not** cross — and has no function here at all — is any way to
   * name a worker, place one on a team, assign a capability, record a claim, or
   * reach the source this projection came from. The window is a viewer. It has
   * one Workforce command, `workforce.status.read`, and that command carries no
   * payload, so a compromised renderer cannot put an owner, a principal, an
   * authority, a trust level, a provenance or a capability into the Workforce
   * lane even by accident: the field never gets past this file.
   */
  coreWorkforce: (): Promise<WorkforceProjection | null> =>
    ipcRenderer.invoke('freya:core:workforce'),

  onCoreWorkforce: (handler: (projection: WorkforceProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: WorkforceProjection): void => handler(projection)
    ipcRenderer.on('freya:core:workforce', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:workforce', listener)
    }
  },

  /**
   * The Context projection: what Core says is around the current question.
   *
   * Two functions and no command. A window can pull what Core last reported
   * and follow what it pushes, and there is nothing else — no item write, no
   * revocation, no scope request, no reference resolution, and above all no
   * way to attach a provenance, a trust class or an authority to anything.
   * Context authority belongs to Core (issue #15); none of it is lent across
   * this bridge, and `CORE_COMMANDS` below carries no `context.*` name. Core's
   * own vocabulary does carry `context.status.read` and its siblings, and this
   * lane still whitelists none of them: a command arm is a door, and the
   * projection read above is the whole of the window's Context privilege —
   * whatever Core answers, it answers as metadata, with no argument this
   * bridge could fill.
   */
  coreContext: (): Promise<ContextProjection | null> =>
    ipcRenderer.invoke('freya:core:context'),

  onCoreContext: (handler: (projection: ContextProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: ContextProjection): void => handler(projection)
    ipcRenderer.on('freya:core:context', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:context', listener)
    }
  },

  /**
   * The Personality projection: temperament, the relationship record as
   * metadata, and one optional cue for Presence to draw.
   *
   * Two functions and no command, same as Context and tighter in reason. What
   * crosses is ids, code-owned keys, closed labels, counts and instants — what
   * does **not** cross is what the record *says*: no `text`, no `tags`, no
   * admission reason, no provenance sentence and no expression guidance, so a
   * window cannot hold the private half of a relationship by simply being open.
   *
   * And there is no function here that files one. A compromised renderer gets
   * from this bridge exactly two argument-free reads; it cannot record a
   * preference, mark a habit, name an inside joke, assert a confidence or pick
   * a cue, because no field of any request can reach Core through this lane at
   * all. Relationship truth, provenance, trust and authority stay in Core, and
   * this bridge lends none of them in either direction.
   */
  corePersonality: (): Promise<PersonalityProjection | null> =>
    ipcRenderer.invoke('freya:core:personality'),

  onCorePersonality: (handler: (projection: PersonalityProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: PersonalityProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:personality', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:personality', listener)
    }
  },

  /**
   * The Attention projection: counts, the focus reading Core derived, the last
   * decision as metadata and at most one cue.
   *
   * The note that matters is what does **not** cross: the event's `text` never
   * appears in a projection — only its measured length — and there is no field a
   * window could use to name a source, set an importance, assert an urgency, decide
   * an outcome, spend an interruption budget or bypass a cooldown. Ingestion is a
   * command with a narrow payload contract, not a widening of this read.
   */
  coreAttention: (): Promise<AttentionProjection | null> =>
    ipcRenderer.invoke('freya:core:attention'),

  onCoreAttention: (handler: (projection: AttentionProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: AttentionProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:attention', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:attention', listener)
    }
  },

  /**
   * The Office projection: Freya's station, live run stations, worker stations,
   * approval stations and the history timeline.
   *
   * What crosses is exactly what Core derived from real Work/Workforce/Core
   * state — ids, statuses, counts, measured lengths, closed labels and
   * deterministic positions. What does **not** cross is the substance: no step
   * input, no observation content, no message body, no task title, no mission
   * text, no authority, no capability instance. A window can see what is
   * happening and where; it cannot reach what a capability was given or what it
   * returned, and it cannot invent either.
   *
   * There is no function here that invents a station, inflates a count or
   * fabricates a percentage. The Office is a pure function of Core state, and
   * this bridge is a forwarding box on the way to it.
   */
  coreOffice: (): Promise<OfficeProjection | null> => ipcRenderer.invoke('freya:core:office'),

  onCoreOffice: (handler: (projection: OfficeProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: OfficeProjection): void => handler(projection)
    ipcRenderer.on('freya:core:office', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:office', listener)
    }
  },

  coreFoundry: (): Promise<FoundryProjection | null> =>
    ipcRenderer.invoke('freya:core:foundry'),

  onCoreFoundry: (handler: (projection: FoundryProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: FoundryProjection): void => handler(projection)
    ipcRenderer.on('freya:core:foundry', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:foundry', listener)
    }
  },

  /**
   * The Relay projection: which connectors are registered, which actions are
   * pending approval, and what recent actions settled.
   *
   * The note that matters is what does **not** cross: no credential or token
   * (there is no field one could occupy), no message body, no event title, no
   * issue text, no budget figure a window could raise and no capability name
   * a window could use to widen itself. Submitting an action is a command
   * with a narrow payload contract, not a widening of this read.
   */
  coreRelay: (): Promise<RelayProjection | null> => ipcRenderer.invoke('freya:core:relay'),

  onCoreRelay: (handler: (projection: RelayProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: RelayProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:relay', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:relay', listener)
    }
  },

  /**
   * The connector projection: which providers exist, their connection state,
   * the scopes granted, and whether a write is pending approval.
   *
   * A mirror, like every other channel here. What deliberately does **not**
   * cross: a token, a refresh token, a client secret, an authorization header,
   * a code verifier or any event payload. Starting an authorization and
   * completing one are different acts: this bridge can ask Core to start one
   * (`connector.connect.start`), and completing it is host-only, so no window
   * can manufacture a connection.
   */
  coreConnectors: (): Promise<ConnectorProjection | null> => ipcRenderer.invoke('freya:core:connectors'),

  onCoreConnectors: (handler: (projection: ConnectorProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: ConnectorProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:connectors', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:connectors', listener)
    }
  },

  /**
   * The Skills projection: procedures, lifecycle status, evidence as verdicts and
   * counts, and whether bodies survive a restart.
   *
   * A mirror, like every other channel here. What is deliberately **not** on it: any
   * method that writes a skill body, sets a status, submits a verification record, or
   * moves a promotion threshold. The renderer's route to those is `coreSubmit` with a
   * narrow payload contract per command, and Core's own admission, evaluation and
   * promotion tables sit behind them.
   */
  /**
   * The unified conscious context: one coherent account of what Freya currently
   * understands about herself and her situation, derived from the projections this
   * window could otherwise have to assemble itself.
   *
   * A read and a follow, and **nothing else**. There is deliberately no
   * `consciousness.*` name in `CORE_COMMANDS` below, so `coreSubmit` cannot reach
   * this lane at all - the absence of a write verb is the property, and it is
   * asserted against this file's source in
   * `tests/host/consciousnessBridge.test.ts` rather than left to this comment.
   *
   * Note what this lane reports on this build: Phase 21 Life and Phase 22
   * Self/World are not integrated yet, so the snapshot arrives `degraded` and
   * names `life` in its reason. That is the truthful reading, not a defect to be
   * smoothed over here.
   */
  coreConsciousness: (): Promise<ConsciousContextProjection | null> =>
    ipcRenderer.invoke('freya:core:consciousness'),

  onCoreConsciousness: (
    handler: (projection: ConsciousContextProjection) => void,
  ): (() => void) => {
    const listener = (_event: unknown, projection: ConsciousContextProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:consciousness', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:consciousness', listener)
    }
  },

  /**
   * The Continuous Life Loop: where it is, what woke it, what it concluded and how
   * loudly it was allowed to say so, whether it is waiting and until when.
   *
   * A read and a follow, and **nothing else** — the same rule as the conscious
   * context above, for a much sharper reason. A window that could wake the loop
   * could make Freya think; a window that could tick it could drive the clock; and
   * a window that could lift a stop could undo the owner's panic button. None of
   * those names exists in `CORE_COMMANDS` below and none exists on this bridge.
   *
   * The heartbeat the loop rides is the main process's existing attention timer,
   * not a channel, so there is no renderer-reachable way to drive the clock at all.
   */
  coreLifeLoop: (): Promise<LifeLoopProjection | null> =>
    ipcRenderer.invoke('freya:core:lifeloop'),

  onCoreLifeLoop: (
    handler: (projection: LifeLoopProjection) => void,
  ): (() => void) => {
    const listener = (_event: unknown, projection: LifeLoopProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:lifeloop', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:lifeloop', listener)
    }
  },

  coreSkills: (): Promise<SkillProjection | null> =>
    ipcRenderer.invoke('freya:core:skills'),

  /**
   * The Forge projection, read-only.
   *
   * One method and one subscription, for the same reason the Skills bridge has one:
   * every mutating Forge act is a  orge.* command through submit, so the bridge
   * cannot become a second admission door for a package body. No
   * onCoreForgeWrite, no coreForgeGenerate, no method that takes a manifest.
   */
  coreForge: (): Promise<ForgeProjection | null> => ipcRenderer.invoke('freya:core:forge'),

  onCoreForge: (handler: (projection: ForgeProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: ForgeProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:forge', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:forge', listener)
    }
  },

  onCoreSkills: (handler: (projection: SkillProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: SkillProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:skills', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:skills', listener)
    }
  },

  /**
   * The Life History projection, read-only.
   *
   * The counterpart to the command surface and the reason it is narrow: what
   * crosses is Core's report — ids, closed labels, dates, statuses and measured
   * lengths. An entry's own summary and body do not cross here; the one route to
   * them is the explicit `life.entry.read` for a single entry. There is no
   * `freya:core:life:write` channel and no bridge method that records, revises or
   * withdraws an entry.
   */
  coreLife: (): Promise<LifeProjection | null> => ipcRenderer.invoke('freya:core:life'),

  onCoreLife: (handler: (projection: LifeProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: LifeProjection): void =>
      handler(projection)
    ipcRenderer.on('freya:core:life', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:life', listener)
    }
  },

  /**
   * The World & self **summary**: counts, claim kinds, freshness, conflicts. Not the
   * graph — that is `coreSubmit('world.relations.read')`, which Core bounds and
   * Guard-evaluates. No method here creates anything: the two owner-facing world
   * commands are absent from `CORE_COMMANDS`.
   */
  coreWorld: (): Promise<WorldSummaryView | null> => ipcRenderer.invoke('freya:core:world'),

  onCoreWorld: (handler: (projection: WorldSummaryView) => void): (() => void) => {
    const listener = (_event: unknown, projection: WorldSummaryView): void => handler(projection)
    ipcRenderer.on('freya:core:world', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:world', listener)
    }
  },

  /**
   * Watch Core status. Returns a disposer, which `onCollect` conspicuously
   * lacks: a subscription you cannot cancel is a leak you have to design around,
   * and React effects need one to run cleanup.
   */
  onCoreStatus: (handler: (status: CoreStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: CoreStatus): void => handler(status)
    ipcRenderer.on('freya:core:status', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:status', listener)
    }
  },
}

/**
 * The commands a renderer may name.
 *
 * Deliberately a *subset* of `CoreCommandName`. Core can create and revoke
 * grants, but a window cannot: the bridge refuses those names, so a compromised
 * renderer has no path to grant governance even though the command exists in
 * Core. Adding a name here is a decision to hand a window a capability, and it
 * should read like one.
 *
 * The conversation names are here because chat is the product. Note what is *not*
 * reachable through them: a window may submit text and ask for a conversation, and
 * that is all. It cannot name a grant, choose a model, raise a token ceiling,
 * pick a turn id, or select a provider — and it cannot name `cognition.request`
 * directly, so the only route from a window to a model is a conversation turn,
 * which the Mind shapes and the Governor checks.
 */
const CORE_COMMANDS: ReadonlySet<string> = new Set<CoreCommandName>([
  'core.status.read',
  'core.command.submit',
  'cognition.status.read',
  'security.status.read',
  'security.stopAll',
  'security.resume',
  'conversation.create',
  'conversation.list',
  'conversation.read',
  // The sidebar's close button submits this. It was missing here while Core
  // implemented it, so closing a conversation failed with `unknown command`.
  'conversation.archive',
  'conversation.rename',
  'conversation.turn.submit',
  'conversation.turn.cancel',
  'conversation.mission.decide',
  // Model catalogue and selection. A window may ask which text models the
  // configured provider can serve, and may name one of them for subsequent
  // turns. Note what neither command reaches: no provider, no grant, no
  // budget, no ceiling, and no environment value — the catalogue is what Core's
  // provider says it is, and a selection is re-validated inside Core against
  // what a configured provider can actually serve before it means anything.
  'model.catalog.read',
  'model.select',
  // Voice. Read the comment in `CoreCommandName` before adding a name here; the
  // whole point of this list is that granting a window a voice command is a
  // decision that reads like one.
  //
  // Note what a window still cannot do through any of them: it cannot name what
  // Freya says (`voice.tts.speak` takes a turn id and Core reads the words), it
  // cannot grant itself permission (`voice.permission.report` is a report, and
  // capture is refused unless the last report was `granted`), and it cannot
  // execute an interim fragment — there is no command anywhere that would submit
  // one.
  'voice.status.read',
  'voice.mic.enable',
  'voice.mic.disable',
  'voice.permission.request',
  'voice.permission.report',
  'voice.capture.start',
  'voice.transcript.interim',
  'voice.capture.end',
  'voice.capture.cancel',
  'voice.submit.set',
  'voice.auto-speak.set',
  'voice.tts.speak',
  'voice.tts.stop',
  'voice.tts.cancel',
  'voice.tts.settle',
  'voice.tts.voice.read',
  'voice.tts.voice.select',
  'voice.mute.set',
  'voice.wake.arm',
  'voice.wake.disarm',
  'voice.wake.energy',
  // The Brain is readable and writable by the owner, because remembering is the
  // product. Note what is *not* reachable through these: a window cannot name a
  // source class, a confidence ceiling or a verification status. It says what it
  // wants remembered, and Core decides how much that is worth — a window that could
  // assert `owner-assertion` for itself would be a window that could launder a web
  // page's contents in as something the owner said.
  'brain.status.read',
  'brain.memory.write',
  'brain.memory.archive',
  'brain.recall',
  // Phase 5 research. The owner may search, read a public page and start research;
  // what it may *not* do is name a provider, a model, a limit, a budget or a
  // capability. Those are Core's, and the payload contracts below rebuild each one
  // from known fields so an ignored field never even reaches the main process.
  'search.web',
  'browser.read',
  'research.start',
  'research.cancel',
  'research.status.read',
  // Freya's Eye sessions: the same research capability, carried across a
  // conversation. These were implemented in Core and called by the renderer while
  // absent from this list, so the Eye route was refused before it could run.
  'research.session.create',
  'research.session.list',
  'research.session.read',
  'research.session.followup',
  'research.session.collect',
  'research.session.pause',
  'research.session.resume',
  'research.session.cancel',

  // Work. A window may plan and drive work and decide an approval, and that is the
  // whole list. Note what it still cannot do: it cannot name a capability Core does
  // not have, cannot raise a ceiling above Core's own, cannot declare a step
  // verified, cannot say who decided an approval, and cannot grant itself anything.
  // `work.approval.decide` is reachable here precisely because a window *is* the
  // owner's UI — and Core assigns that identity rather than reading one out of the
  // payload.
  'work.status.read',
  'work.task.create',
  'work.task.update',
  'work.run.create',
  'work.run.start',
  'work.run.pause',
  'work.run.resume',
  'work.run.cancel',
  'work.approval.decide',

  // Missions. A window may state what it wants accomplished and move that Mission
  // around. Note what it may *not* do, because these are the two things that make a
  // Mission trustworthy: it cannot raise a code-owned ceiling, and it cannot conclude
  // anything by asserting a status. `mission.requestCompletion` is reachable precisely
  // because a window is the owner's UI — but it *asks*, and only a code-owned verifier
  // decides whether the outcome was established.
  'mission.status.read',
  'mission.create',
  'mission.activate',
  'mission.pause',
  'mission.resume',
  'mission.cancel',
  'mission.fail',
  'mission.requestCompletion',

  // Workforce, and the list is one line long on purpose.
  //
  // A window may *read* the workforce. It may not create a worker, name one,
  // move one onto a team, assign it a capability, record a claim for it or
  // change a budget — none of those commands exist in `CoreCommandName` at all,
  // so they are refused here as unknown names before they can be serialised.
  // Workforce authority is Core's (issue #10); the renderer's entire privilege
  // in this lane is the ability to ask what is true.
  'workforce.status.read',

  // Context, and the entry is deliberately nothing.
  //
  // Core's vocabulary now carries `context.status.read` and four siblings, and
  // none of them is whitelisted here: a window naming any `context.*` command
  // is refused as an unknown command before this list is even consulted — the
  // correct answer for every spelling of "let me tell Core what is around me".
  // The window's entire Context
  // privilege is the two projection reads on the api object above: a pull and
  // a subscription. There is no write verb to be tempted by because there is
  // no write verb.

  // Personality, and the entry is nothing — deliberately, and for a sharper
  // reason than Context's.
  //
  // Not one `personality.*` name is whitelisted, so a window naming one is
  // refused as an unknown command before this list is even consulted. The
  // window's entire Personality privilege is the pull and the subscription on
  // the api object above, and that asymmetry is the whole defence: the thing a
  // caller would most want to supply here is relationship truth — "the owner
  // prefers this", "we have an inside joke about that" — and a door that takes
  // no payload cannot be talked into taking one.

  // Attention. A window may submit an event, register and cancel a schedule, read
  // the projection and read back one retained event. Note what none of these
  // reaches: no source (Core fixes it to `owner`), no importance, no urgency, no
  // outcome, no interruption budget and no cooldown. There is deliberately no
  // `attention.decide`, no `attention.budget.set` and no `attention.tick` here —
  // deciding, budgeting and waking are Core's.
  'attention.status.read',
  'attention.event.ingest',
  'attention.schedule.register',
  'attention.schedule.cancel',
  'attention.inbox.read',
  // Skills. Read plus bounded owner actions; no execution, verification fabrication,
  // runtime promotion or threshold-setting verb exists on the renderer surface.
  'skill.status.read',
  'skill.admit',
  'skill.revise',
  'skill.recordEvaluation',
  'skill.transition',
  'skill.retire',
  'skill.propose',
  'skill.proposal.settle',
  'skill.select',
  'skill.detail.read',
  // Forge. Every owner act over generated packages, and **none of the verbs that
  // would let a window assert trust**: there is no  orge.setStatus,
  //  orge.setVerified,  orge.setEnabled,  orge.grant, or anything that writes a
  // package into Core. Status comes from the pipeline; enabling re-checks what the
  // owner already holds.
  'forge.status.read',
  'forge.generate',
  'forge.validate',
  'forge.install',
  'forge.enable',
  'forge.disable',
  'forge.run',
  'forge.rollback',
  'forge.remove',
  'forge.approve',
  'forge.search',
  'forge.export',
  'forge.detail.read',
  'relay.status.read',
  'relay.email.read',
  'relay.email.draft.create',
  'relay.email.send',
  'relay.calendar.read',
  'relay.calendar.create',
  'relay.calendar.update',
  'relay.calendar.cancel',
  'relay.github.read',
  'relay.github.issue.create',
  'relay.github.pr.create',
  'relay.drive.read',
  'relay.drive.file.create',
  'relay.telegram.read',
  'relay.telegram.send',
  'relay.external.invoke',
  'relay.approval.decide',

  // Connectors (Phase 44). `connector.status.read` is the payloadless read;
  // `connector.connect.start` starts an authorization; `connector.disconnect`
  // revokes one; `connector.read` and `connector.action.execute` submit a typed
  // action. There is deliberately no `connector.authorize` and no
  // `connector.event.ingest` here: completing an authorization and delivering an
  // authenticated event are host-only acts, and a window reaching for those
  // names finds `unknown command`.
  'connector.status.read',
  'connector.connect.start',
  'connector.disconnect',
  'connector.read',
  'connector.action.execute',
  'foundry.status.read',

  // Life History. Three reads and nothing else: there is no `life.record`,
  // `life.consolidate`, `life.revise`, `life.withdraw`, `life.confidence.set` or
  // `life.promote` on the renderer surface, because a window that could write one
  // would be a second author of Freya's autobiography. The owner scope that
  // records, revises, consolidates and withdraws is Core-internal and has no
  // command name a window could reach.
  'life.status.read',
  'life.timeline.read',
  'life.entry.read',

  // World & self: five **reads**. `world.statement.submit` and `.withdraw` are
  // deliberately absent — owner-only in Core, whose own seams call the same admission
  // directly. Leaving them off is what makes "a renderer cannot invent an entity, a
  // relation, a trust level or a confidence" true of the bridge, not just its code.
  'world.summary.read',
  'world.entities.read',
  'world.entity.read',
  'world.relations.read',
  'self.status.read',

  // Office. A window may read the Office projection and ask for an agent to
  // join the desktop Presence. Note what it may *not* do: it cannot invent a
  // station, inflate a count, fabricate a percentage, name a principal, assert
  // an authority, grant a capability or reach a model. The presence request
  // takes a workerId and nothing else — Core validates the worker exists and
  // journals the request, and whether the agent actually appears is a Presence
  // concern (Phase 13), not the Office's.
  'office.status.read',
  'office.presence.request',
])

/**
 * One bounded optional string.
 *
 * `undefined` and `''` are the same thing for an *optional* field: both mean "not
 * supplied". Conflating them matters because an empty recall query is a real
 * request — it asks for Freya's most recent memories — and treating the empty
 * string as malformed made an ordinary button press fail as a bad payload. A
 * *required* field still refuses an empty string, because there a blank value is a
 * mistake rather than an absence.
 */
function readString(
  record: Record<string, unknown> | null,
  key: string,
  max: number,
  required = true,
): string | null | undefined {
  const value = record?.[key]
  if (value === undefined) return required ? null : undefined
  if (typeof value !== 'string') return null
  if (value.length === 0) return required ? null : undefined
  if (value.length > max) return null
  return value
}

type RendererPayloadResult =
  | { ok: true; payload?: unknown }
  | { ok: false; reason: string }

/**
 * A number inside a closed range, or the answer that the caller's own
 * tri-state needs.
 *
 * Three outcomes on purpose, matching `readString`: `null` means "you sent
 * something invalid", `undefined` means "you sent nothing, which is fine" and a
 * number means "here is the bounded value". A two-state check would have to
 * invent a default for a missing tuning parameter, and inventing a default here
 * is how a window ends up believing it set a rate it never set.
 */
function readBoundedNumber(
  record: Record<string, unknown> | null,
  key: string,
  min: number,
  max: number,
): number | null | undefined {
  const value = record?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < min || value > max) return null
  return value
}

/**
 * Whether a payload is empty: `undefined`, `null`, or an object with no keys.
 *
 * The mirror image of Core's own check, deliberately — the two must agree or a
 * window could pass the bridge and be refused by Core (or worse, the reverse).
 * A string, an array and a populated object all carry something, and all fail
 * here.
 */
function carriesNothing(payload: unknown): boolean {
  if (payload === undefined || payload === null) return true
  if (typeof payload !== 'object') return false
  if (Array.isArray(payload)) return false
  return Object.keys(payload as Record<string, unknown>).length === 0
}

/**
 * The world protocol's refusal sentence, restated rather than imported: importing it
 * would pull `core/protocol/world.ts` and every frozen absent projection into a preload
 * script every window parses at startup, and Phase 18 measures exactly that. A red-team
 * test asserts the two copies are the same string, so they cannot drift silently.
 */
const WORLD_NO_PAYLOAD = 'this world command takes no payload'

/**
 * Entity kinds a world read may name, written out rather than imported from
 * `core/world` for the same budget reason. Core re-checks every kind on arrival, so this
 * is a convenience, not a boundary.
 */
const WORLD_READ_KINDS: ReadonlySet<string> = new Set([
  'person', 'project', 'organisation', 'place', 'mission', 'run',
  'task', 'worker', 'team', 'skill', 'artifact', 'self',
])

/**
 * Narrow a world read to a closed field list plus a per-field check. One shape for all
 * three: one place to refuse is one place to audit, and an unlisted field is refused
 * whole rather than ignored.
 */
function narrowWorldRead(
  payload: unknown,
  fields: readonly string[],
  check: (body: Record<string, unknown>) => string | null,
): { ok: true } | { ok: false; reason: string } {
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    return { ok: false, reason: 'this world read takes an object' }
  }
  const body = (payload ?? {}) as Record<string, unknown>
  if (Object.keys(body).some((key) => !fields.includes(key))) {
    return { ok: false, reason: `this world read accepts only ${fields.join(', ')}` }
  }
  const refusal = check(body)
  return refusal === null ? { ok: true } : { ok: false, reason: refusal }
}

/** A usable, bounded id. */
function isBoundedId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

const MAX_ID_CHARS = 256
const LIFE_TIMELINE_LIMIT = 200
/** A model id is bounded like an id; the same ceiling Core re-checks inside. */
const MAX_MODEL_ID_CHARS = 256
/** Matches the Searcher's own ceiling, so the bridge and Core agree on the limit. */
const MAX_SEARCH_QUERY_CHARS = 512
const MAX_SOURCE_URL_CHARS = 2_048
const MAX_RESEARCH_QUESTION_CHARS = 4_096
const MAX_STOP_REASON_CHARS = 1_000
const MAX_COMMAND_ORIGIN_CHARS = 128
/** A provider base URL is a URL, bounded like one. */
const MAX_PROVIDER_URL_CHARS = 2_048
/** A provider model id is bounded like Core's own model id. */
const MAX_PROVIDER_MODEL_CHARS = 256
/** A provider credential, with generous headroom over any real key. */
const MAX_PROVIDER_KEY_CHARS = 4_096

/**
 * The provider settings a window may set, rebuilt from named fields.
 *
 * Same discipline as `rendererPayload`: an unrecognised field is dropped rather
 * than forwarded, so a compromised window cannot attach an unbounded blob to a
 * settings save. `apiKey` may be an explicit empty string — that is how a stored
 * credential is cleared — but it is never part of what comes back.
 */
function rendererVoiceConfigPayload(
  raw: unknown,
): { ok: true; payload: VoiceConfigPatch } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'voice configuration is invalid' }
  }
  const record = raw as Record<string, unknown>
  const payload: VoiceConfigPatch = {}

  if (record.sttProvider !== undefined) {
    if (record.sttProvider !== 'off' && record.sttProvider !== 'nanogpt') {
      return { ok: false, reason: 'voice STT provider is invalid' }
    }
    payload.sttProvider = record.sttProvider
  }
  if (record.sttModel !== undefined) {
    if (
      typeof record.sttModel !== 'string' ||
      record.sttModel.length === 0 ||
      record.sttModel.length > 160 ||
      !/^[A-Za-z0-9._:/-]+$/.test(record.sttModel)
    ) {
      return { ok: false, reason: 'voice STT model is invalid' }
    }
    payload.sttModel = record.sttModel
  }
  if (record.remoteSttEnabled !== undefined) {
    if (typeof record.remoteSttEnabled !== 'boolean') {
      return { ok: false, reason: 'remote voice consent is invalid' }
    }
    payload.remoteSttEnabled = record.remoteSttEnabled
  }
  if (record.ttsProvider !== undefined) {
    if (record.ttsProvider !== 'off' && record.ttsProvider !== 'platform') {
      return { ok: false, reason: 'voice TTS provider is invalid' }
    }
    payload.ttsProvider = record.ttsProvider
  }
  if (record.ttsVoiceId !== undefined) {
    if (
      record.ttsVoiceId !== null &&
      (typeof record.ttsVoiceId !== 'string' || record.ttsVoiceId.length === 0 || record.ttsVoiceId.length > 200)
    ) {
      return { ok: false, reason: 'voice id is invalid' }
    }
    payload.ttsVoiceId = record.ttsVoiceId
  }
  if (record.wakeProvider !== undefined) {
    if (record.wakeProvider !== 'off' && record.wakeProvider !== 'selected-stt') {
      return { ok: false, reason: 'wake provider is invalid' }
    }
    payload.wakeProvider = record.wakeProvider
  }
  if (record.autoSpeak !== undefined) {
    if (typeof record.autoSpeak !== 'boolean') {
      return { ok: false, reason: 'auto-speak setting is invalid' }
    }
    payload.autoSpeak = record.autoSpeak
  }
  if (record.proactiveAlerts !== undefined) {
    if (typeof record.proactiveAlerts !== 'boolean') {
      return { ok: false, reason: 'proactive voice alert setting is invalid' }
    }
    payload.proactiveAlerts = record.proactiveAlerts
  }
  return { ok: true, payload }
}

function rendererProviderPayload(
  raw: unknown,
): { ok: true; payload: ProviderConfigInput } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'provider configuration is invalid' }
  }
  const record = raw as Record<string, unknown>
  const payload: ProviderConfigInput = {}
  if (record.baseUrl !== undefined) {
    if (typeof record.baseUrl !== 'string' || record.baseUrl.length > MAX_PROVIDER_URL_CHARS) {
      return { ok: false, reason: 'provider base URL is too large or invalid' }
    }
    /**
     * The base URL is where the stored key is sent, so it is validated here against
     * the shared provider endpoint policy rather than only for length.
     *
     * This is the renderer boundary, which makes it the most likely place for a
     * compromised window to aim a credential at a host of its choosing: it needs
     * nothing but a call to `saveProviderConfig`, and it never has to read the key
     * back. The canonical policy lives in `core/model/provider-endpoint.ts` and is
     * the same object the provider itself uses, so there is no second, weaker rule
     * for a renderer to be held to.
     *
     * The same check runs again when the value is persisted and again on the
     * transport. This one exists to refuse *here*, with a reason a person can read,
     * instead of surfacing later as a provider that mysteriously cannot be reached.
     */
    const endpoint = checkProviderBaseUrl(record.baseUrl)
    if (!endpoint.ok) return { ok: false, reason: endpoint.refusal?.reason ?? 'provider base URL is not permitted' }
    payload.baseUrl = record.baseUrl
  }
  if (record.model !== undefined) {
    if (typeof record.model !== 'string' || record.model.length > MAX_PROVIDER_MODEL_CHARS) {
      return { ok: false, reason: 'provider model is too large or invalid' }
    }
    payload.model = record.model
  }
  if (record.liveEnabled !== undefined) {
    if (typeof record.liveEnabled !== 'boolean') {
      return { ok: false, reason: 'provider live flag is invalid' }
    }
    payload.liveEnabled = record.liveEnabled
  }
  if (record.apiKey !== undefined) {
    if (typeof record.apiKey !== 'string' || record.apiKey.length > MAX_PROVIDER_KEY_CHARS) {
      return { ok: false, reason: 'provider key is too large or invalid' }
    }
    payload.apiKey = record.apiKey
  }
  return { ok: true, payload }
}


/**
 * A bounded, validated contract, or null.
 *
 * Rebuilt here rather than forwarded, for the same reason every other payload in this
 * file is: a `contract` the bridge passes through unchanged could carry any shape at
 * all, and Core's admission would then be the only thing standing between a window and
 * an unbounded skill body. Four lists, each at most `maxContractEntries` entries, each
 * entry a bounded slug plus a bounded description ??? and the whole thing refused whole
 * rather than trimmed, because a procedure that silently lost an output would be one
 * the owner believes is complete.
 */
function boundedSkillContract(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const keys = ['inputs', 'outputs', 'preconditions', 'postconditions']
  const contract: Record<string, unknown> = {}
  for (const key of keys) {
    const list = source[key]
    if (!Array.isArray(list) || list.length > SKILL_LIMITS.maxContractEntries) return null
    const entries: { name: string; description: string }[] = []
    for (const item of list) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
      const entry = item as Record<string, unknown>
      if (typeof entry.name !== 'string' || entry.name.length === 0) return null
      if (entry.name.length > SKILL_LIMITS.maxNameChars) return null
      if (typeof entry.description !== 'string') return null
      if (entry.description.length > SKILL_LIMITS.maxEntryChars) return null
      entries.push({ name: entry.name, description: entry.description })
    }
    contract[key] = entries
  }
  return contract
}

/** A bounded list of applicability slugs, or null. Never trimmed. */
function boundedSkillTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > SKILL_LIMITS.maxApplicabilityTags) return null
  const tags: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || item.length > SKILL_LIMITS.maxTagChars) {
      return null
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item)) return null
    tags.push(item)
  }
  return tags
}

/**
 * A bounded list of capability names, or null.
 *
 * The *names* only. This bridge has no way to express what a capability grants, and
 * that is the point: the list a window supplies becomes a *declaration* of what a
 * procedure will ask for, which Core then checks against the forbidden list and
 * against what the executing Run already holds.
 */
function boundedCapabilities(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SKILL_LIMITS.maxRequiredCapabilities) {
    return null
  }
  const capabilities: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_ID_CHARS) return null
    capabilities.push(item)
  }
  return capabilities
}

/** A bounded list of step seeds, or null. Each needs a capability *and* a verifier. */
function boundedSkillSteps(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SKILL_LIMITS.maxSteps) return null
  const steps: { key: string; capability: string; verifier: string }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const step = item as Record<string, unknown>
    if (typeof step.key !== 'string' || step.key.length === 0 || step.key.length > 64) return null
    if (typeof step.capability !== 'string' || step.capability.length === 0) return null
    if (typeof step.verifier !== 'string' || step.verifier.length === 0) return null
    steps.push({ key: step.key, capability: step.capability, verifier: step.verifier })
  }
  return steps
}

/**
 * A bounded list of evidence items, or null.
 *
 * `kind`, `code`, `count` and nothing else ??? and no `at`, because an evidence item's
 * instant is Core's clock, not a window's. A window supplies what it observed; Core
 * stamps when it was told.
 */
function boundedEvidenceItems(raw: unknown): unknown[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > SKILL_LIMITS.maxEvidenceItems) return null
  const items: { kind: string; code: string; count: number }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    if (typeof entry.kind !== 'string' || entry.kind.length === 0) return null
    if (typeof entry.code !== 'string' || entry.code.length === 0) return null
    if (typeof entry.count !== 'number' || !Number.isInteger(entry.count) || entry.count < 0) {
      return null
    }
    items.push({ kind: entry.kind, code: entry.code, count: entry.count })
  }
  return items
}

/** A bounded list of metric measurements, or null. Never trimmed. */
function boundedMetrics(raw: unknown): unknown[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > SKILL_LIMITS.maxMetrics) return null
  const metrics: { name: string; value: number }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string' || entry.name.length === 0) return null
    if (typeof entry.value !== 'number' || !Number.isInteger(entry.value) || entry.value < 0) {
      return null
    }
    metrics.push({ name: entry.name, value: entry.value })
  }
  return metrics
}

function rendererPayload(command: CoreCommandName, payload: unknown): RendererPayloadResult {
  const record =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : null

  const string = (key: string, max: number, required = true): string | null | undefined =>
    readString(record, key, max, required)

  /**
   * The same check, against some other object.
   *
   * A step plan is a list of objects, so its fields cannot be read with the closure
   * above — which reads the command payload. Getting that wrong once already
   * happened here: every step came back "a step key is invalid", because the
   * helper was reading a key from the top level of a command that has none.
   */
  const from = (
    source: Record<string, unknown>,
    key: string,
    max: number,
    required = true,
  ): string | null | undefined => readString(source, key, max, required)

  switch (command) {
    case 'core.status.read':
    case 'cognition.status.read':
    case 'security.status.read':
    case 'security.resume':
    case 'conversation.list':
    case 'voice.status.read':
    case 'voice.permission.request':
    case 'voice.capture.start':
    case 'voice.capture.cancel':
    case 'voice.tts.stop':
    case 'voice.tts.voice.read':
    case 'voice.wake.disarm':
    case 'brain.status.read':
    case 'research.status.read':
      return { ok: true }

    case 'voice.mic.enable':
    case 'voice.mic.disable': {
      // `source` is how the wake path distinguishes itself, and it is validated as
      // a closed two-value set rather than a free string. A window claiming
      // `owner` is the ordinary case; one claiming `wake` gets *fewer* rights, so
      // the field is checked rather than trusted in either direction.
      const source = record?.source
      if (source === undefined) return { ok: true }
      if (source !== 'owner' && source !== 'wake') {
        return { ok: false, reason: 'the microphone activation source is owner or wake' }
      }
      const reason = string('reason', 200, false)
      return { ok: true, payload: { source, ...(reason === undefined || reason === null ? {} : { reason }) } }
    }

    case 'voice.permission.report': {
      // A report, not a request. The bridge forwards a closed vocabulary and drops
      // everything else, so a window cannot smuggle a field Core would read as
      // something it is not.
      const outcome = record?.outcome
      if (outcome !== 'granted' && outcome !== 'denied' && outcome !== 'revoked') {
        return { ok: false, reason: 'a permission report must say granted, denied or revoked' }
      }
      return { ok: true, payload: { outcome } }
    }

    case 'voice.transcript.interim': {
      const sessionId = string('sessionId', MAX_ID_CHARS)
      if (sessionId === null || sessionId === undefined) {
        return { ok: false, reason: 'an interim fragment needs the session id' }
      }
      // Bounded at the edge, at the same ceiling Core clips to, so a window cannot
      // move half a megabyte of text through this bridge in one message.
      const text = string('text', VOICE_LIMITS.maxInterimCharacters, false)
      if (text === null) return { ok: false, reason: 'an interim fragment is too long or invalid' }
      return { ok: true, payload: { sessionId, ...(text === undefined ? {} : { text }) } }
    }

    case 'voice.submit.set':
    case 'voice.auto-speak.set':
    case 'voice.mute.set': {
      // Booleans only. A truthy string here would be a window that believes it
      // turned auto-submit on while Core read something else.
      const key =
        command === 'voice.mute.set'
          ? 'muted'
          : 'enabled'
      const value = record?.[key]
      if (typeof value !== 'boolean') {
        return { ok: false, reason: `${key} is a true or false setting` }
      }
      return { ok: true, payload: { [key]: value } }
    }

    case 'voice.tts.speak': {
      // The payload is a turn id and a turn id. Nothing here reads a `text` field,
      // so anything a window attaches to it is dropped before it can be structured
      // cloned into the main process — Core reads the words out of its own store.
      const turnId = string('turnId', MAX_ID_CHARS)
      if (turnId === null || turnId === undefined) {
        return { ok: false, reason: 'speaking a turn needs the turn id' }
      }
      const rate = readBoundedNumber(record, 'rate', 0.5, 2)
      const pitch = readBoundedNumber(record, 'pitch', 0, 2)
      if (rate === null || pitch === null) {
        return { ok: false, reason: 'the speaking tuning is out of range' }
      }
      return {
        ok: true,
        payload: { turnId, ...(rate === undefined ? {} : { rate }), ...(pitch === undefined ? {} : { pitch }) },
      }
    }

    case 'voice.tts.cancel': {
      const reason = string('reason', 200, false)
      if (reason === null) return { ok: false, reason: 'the interruption reason is too long or invalid' }
      return { ok: true, payload: reason === undefined ? {} : { reason } }
    }

    case 'voice.tts.settle': {
      const utteranceId = string('utteranceId', MAX_ID_CHARS)
      const outcome = record?.outcome
      if (utteranceId === null || utteranceId === undefined) {
        return { ok: false, reason: 'a settlement needs the utterance id' }
      }
      if (outcome !== 'completed' && outcome !== 'failed') {
        return { ok: false, reason: 'a settlement is completed or failed' }
      }
      return { ok: true, payload: { utteranceId, outcome } }
    }

    case 'voice.tts.voice.select': {
      const voiceId = string('voiceId', 200)
      if (voiceId === null || voiceId === undefined) {
        return { ok: false, reason: 'selecting a voice needs the voice id' }
      }
      return { ok: true, payload: { voiceId } }
    }

    case 'voice.wake.arm': {
      const reason = string('reason', 200, false)
      if (reason === null) return { ok: false, reason: 'the wake reason is too long or invalid' }
      return { ok: true, payload: reason === undefined ? {} : { reason } }
    }

    case 'voice.wake.energy': {
      // Two bounded numbers. A window reporting its own level is trusted for
      // nothing except *asking*, and the ask still has to clear every ordinary
      // capture precondition in Core — so a forged level can at worst start a
      // microphone the owner already turned on.
      const level = readBoundedNumber(record, 'level', 0, 1)
      const sustainedMs = readBoundedNumber(record, 'sustainedMs', 0, VOICE_LIMITS.maxWakeArmedMs)
      if (level === undefined || sustainedMs === undefined) {
        return { ok: false, reason: 'a wake reading needs a level and a sustained duration' }
      }
      return { ok: true, payload: { level, sustainedMs } }
    }

    case 'work.status.read':
    case 'mission.status.read':
      return { ok: true }

    case 'workforce.status.read': {
      // The only Workforce arm, and the only command in this file whose whole
      // contract is "nothing".
      //
      // Anything at all attached to the read is refused rather than dropped —
      // `undefined`, `null` and `{}` pass; a string, an array or an object with
      // a key in it does not — so a window appending an owner, a principal, an
      // authority, a trust level, a provenance, a capability or a claim is told
      // the read carries no payload instead of being left believing the field
      // went somewhere. The payload is never rebuilt from named fields because
      // there are no named fields: this arm forwards zero bytes of what the
      // renderer sent, and says so in words Core repeats.
      if (!carriesNothing(payload)) {
        return { ok: false, reason: WORKFORCE_NO_PAYLOAD }
      }
      return { ok: true }
    }

    case 'mission.create': {
      // The three pieces of text a Mission is made of, and nothing else.
      //
      // What is deliberately absent is the interesting part. There is no `limits`
      // case, no `status`, no `verification`, no `verifierId`, no `principalId`, no
      // `deadlineAt` — so a window cannot raise a code-owned ceiling, declare itself
      // the owner, or assert an outcome it never established. A Mission's limits are
      // code's to set and a Mission's outcome is a verifier's to establish; this
      // bridge forwards the words and refuses the rest.
      const title = string('title', MISSION_LIMITS.maxTitleChars)
      if (title === null || title === undefined) return { ok: false, reason: 'a Mission title is required' }
      const intent = string('intent', MISSION_LIMITS.maxIntentChars)
      if (intent === null || intent === undefined) return { ok: false, reason: 'a Mission needs an intent' }

      const rawCriteria = record?.successCriteria
      if (rawCriteria !== undefined) {
        if (!Array.isArray(rawCriteria)) return { ok: false, reason: 'success criteria are invalid' }
        if (rawCriteria.length > MISSION_LIMITS.maxSuccessCriteria) {
          return {
            ok: false,
            reason: `a Mission may hold at most ${MISSION_LIMITS.maxSuccessCriteria} success criteria`,
          }
        }
        const criteria: string[] = []
        for (const raw of rawCriteria) {
          if (typeof raw !== 'string') return { ok: false, reason: 'a success criterion is invalid' }
          if (raw.length > MISSION_LIMITS.maxCriterionChars) {
            return { ok: false, reason: 'a success criterion is too long' }
          }
          criteria.push(raw)
        }
        return { ok: true, payload: { title, intent, successCriteria: criteria } }
      }
      return { ok: true, payload: { title, intent } }
    }

    case 'mission.activate':
    case 'mission.pause':
    case 'mission.resume':
    case 'mission.cancel':
    case 'mission.fail':
    case 'mission.requestCompletion': {
      // One block for all six. None of them accepts a second field: there is no
      // `verifierId` to name, because choosing the verifier is how a caller would
      // choose the answer.
      const missionId = string('missionId', MAX_ID_CHARS)
      if (missionId === null || missionId === undefined) return { ok: false, reason: 'a Mission id is required' }
      return { ok: true, payload: { missionId } }
    }

    case 'core.command.submit': {
      const text = string('text', 4_000)
      if (text === null || text === undefined) return { ok: false, reason: 'command text is invalid' }
      const origin = string('origin', MAX_COMMAND_ORIGIN_CHARS, false)
      if (origin === null) return { ok: false, reason: 'command origin is invalid' }
      return { ok: true, payload: { text, ...(origin === undefined ? {} : { origin }) } }
    }

    case 'security.stopAll': {
      const reason = string('reason', MAX_STOP_REASON_CHARS, false)
      if (reason === null) return { ok: false, reason: 'STOP ALL reason is too large or invalid' }
      return { ok: true, payload: reason === undefined ? undefined : { reason } }
    }

    case 'conversation.create': {
      const title = string('title', CONVERSATION_LIMITS.maxTitleCharacters, false)
      if (title === null) return { ok: false, reason: 'conversation title is too large or invalid' }
      return { ok: true, payload: title === undefined ? undefined : { title } }
    }

    case 'conversation.read': {
      const conversationId = string('conversationId', MAX_ID_CHARS)
      if (conversationId === null || conversationId === undefined) {
        return { ok: false, reason: 'conversation id is invalid' }
      }
      return { ok: true, payload: { conversationId } }
    }

    case 'conversation.rename': {
      const conversationId = string('conversationId', MAX_ID_CHARS)
      const title = string('title', CONVERSATION_LIMITS.maxTitleCharacters)
      if (!conversationId || !title || !title.trim()) return { ok: false, reason: 'Conversation id and a non-empty title are required.' }
      return { ok: true, payload: { conversationId, title } }
    }

    case 'conversation.mission.decide': {
      const conversationId = string('conversationId', MAX_ID_CHARS)
      const proposalMessageId = string('proposalMessageId', MAX_ID_CHARS)
      const decision = string('decision', 16)
      if (!conversationId || !proposalMessageId || !decision || !['approve', 'reject', 'cancel', 'resume'].includes(decision)) return { ok: false, reason: 'A valid Mission proposal decision is required.' }
      return { ok: true, payload: { conversationId, proposalMessageId, decision } }
    }

    case 'conversation.archive': {
      // Archiving is the owner tidying their own history. It carries the one id and
      // nothing else — in particular not a `permanent` or `delete` flag, because a
      // window that could name the difference could turn "close this" into "erase
      // this" behind the button's label.
      const conversationId = string('conversationId', MAX_ID_CHARS)
      if (conversationId === null || conversationId === undefined) {
        return { ok: false, reason: 'conversation id is invalid' }
      }
      return { ok: true, payload: { conversationId } }
    }

    case 'conversation.turn.submit': {
      const conversationId = string('conversationId', MAX_ID_CHARS)
      const text = string('text', CONVERSATION_LIMITS.maxMessageCharacters)
      if (conversationId === null || conversationId === undefined) {
        return { ok: false, reason: 'conversation id is invalid' }
      }
      if (text === null || text === undefined) {
        return { ok: false, reason: 'conversation message is too large or invalid' }
      }
      try {
        const attachments = validateModelAttachments(record?.attachments)
        return { ok: true, payload: { conversationId, text, ...(attachments.length ? { attachments } : {}) } }
      } catch { return { ok: false, reason: 'Conversation attachments are invalid or too large.' } }
    }

    case 'conversation.turn.cancel': {
      const turnId = string('turnId', MAX_ID_CHARS)
      if (turnId === null || turnId === undefined) {
        return { ok: false, reason: 'turn id is invalid' }
      }
      return { ok: true, payload: { turnId } }
    }

    case 'model.catalog.read':
      // A read with no arguments. Anything attached is dropped rather than
      // forwarded: there is nothing this command could usefully be told.
      return { ok: true }

    case 'model.select': {
      // One optional bounded string, and nothing else crosses.
      //
      // `model` present names a model for subsequent turns; `model` absent is
      // the spelled "back to the provider default". A value that is not a
      // string, or longer than a model id can be, is refused here at the
      // boundary and re-checked inside Core — the bridge is a capability
      // boundary, not the only wall.
      const model = string('model', MAX_MODEL_ID_CHARS, false)
      if (model === null) return { ok: false, reason: 'model id is invalid' }
      const providerId = string('providerId', MAX_ID_CHARS, false)
      if (providerId === null) return { ok: false, reason: 'provider id is invalid' }
      return { ok: true, payload: model === undefined ? {} : { model, ...(providerId === undefined ? {} : { providerId }) } }
    }

    case 'foundry.status.read': {
      if (!carriesNothing(payload)) return { ok: false, reason: FOUNDRY_NO_PAYLOAD }
      return { ok: true }
    }

    case 'attention.status.read': {
      // A payloadless read. Anything attached is refused rather than dropped, so a
      // window cannot smuggle a source, an importance, an urgency or an outcome
      // into the question of what Core decided.
      if (!carriesNothing(payload)) return { ok: false, reason: ATTENTION_NO_PAYLOAD }
      return { ok: true }
    }

    case 'attention.event.ingest': {
      // The named fields, and nothing else. Rebuilding the payload from known
      // fields means a `source`, an `importance`, an `urgency` or an `outcome`
      // supplied by a window never reaches the main process at all — Core would
      // ignore them, but this bridge does not even forward them.
      const kind = string('kind', 40)
      const text = string('text', ATTENTION_LIMITS.maxEventTextChars, false)
      if (kind === null || kind === undefined) return { ok: false, reason: 'attention kind is invalid' }
      if (text === null) return { ok: false, reason: 'attention text is too large or invalid' }
      const goalRef = string('goalRef', ATTENTION_LIMITS.maxRefChars, false)
      const sourceRef = string('sourceRef', ATTENTION_LIMITS.maxRefChars, false)
      const severityHint = string('severityHint', 16, false)
      const dueAt = string('dueAt', 64, false)
      if (goalRef === null) return { ok: false, reason: 'attention goal reference is invalid' }
      if (sourceRef === null) return { ok: false, reason: 'attention source reference is invalid' }
      if (severityHint === null) return { ok: false, reason: 'attention severity hint is invalid' }
      if (dueAt === null) return { ok: false, reason: 'attention due time is invalid' }
      return {
        ok: true,
        payload: {
          kind,
          text: text ?? '',
          ...(goalRef === undefined ? {} : { goalRef }),
          ...(sourceRef === undefined ? {} : { sourceRef }),
          ...(severityHint === undefined ? {} : { severityHint }),
          ...(dueAt === undefined ? {} : { dueAt }),
        },
      }
    }

    case 'attention.schedule.register': {
      const kind = string('kind', 40)
      const text = string('text', ATTENTION_LIMITS.maxEventTextChars, false)
      const dueAt = string('dueAt', 64)
      if (kind === null || kind === undefined) return { ok: false, reason: 'schedule kind is invalid' }
      if (text === null) return { ok: false, reason: 'schedule text is too large or invalid' }
      if (dueAt === null || dueAt === undefined) return { ok: false, reason: 'schedule due time is required' }
      const goalRef = string('goalRef', ATTENTION_LIMITS.maxRefChars, false)
      const severityHint = string('severityHint', 16, false)
      const condition = string('condition', 24, false)
      if (goalRef === null) return { ok: false, reason: 'schedule goal reference is invalid' }
      if (severityHint === null) return { ok: false, reason: 'schedule severity hint is invalid' }
      if (condition === null) return { ok: false, reason: 'schedule condition is invalid' }
      const intervalMs = record?.intervalMs
      const maxRepeats = record?.maxRepeats
      if (intervalMs !== undefined && (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs))) {
        return { ok: false, reason: 'schedule interval is invalid' }
      }
      if (maxRepeats !== undefined && (typeof maxRepeats !== 'number' || !Number.isInteger(maxRepeats))) {
        return { ok: false, reason: 'schedule repeat count is invalid' }
      }
      return {
        ok: true,
        payload: {
          kind,
          text: text ?? '',
          dueAt,
          ...(goalRef === undefined ? {} : { goalRef }),
          ...(severityHint === undefined ? {} : { severityHint }),
          ...(condition === undefined ? {} : { condition }),
          ...(intervalMs === undefined ? {} : { intervalMs }),
          ...(maxRepeats === undefined ? {} : { maxRepeats }),
        },
      }
    }

    case 'attention.schedule.cancel': {
      const scheduleId = string('scheduleId', MAX_ID_CHARS)
      if (scheduleId === null || scheduleId === undefined) {
        return { ok: false, reason: 'schedule id is invalid' }
      }
      if (
        record !== null &&
        Object.keys(record).some((key) => key !== 'scheduleId')
      ) {
        return { ok: false, reason: 'schedule cancellation accepts only scheduleId' }
      }
      return { ok: true, payload: { scheduleId } }
    }

    case 'attention.inbox.read': {
      const eventId = string('eventId', MAX_ID_CHARS)
      if (eventId === null || eventId === undefined) {
        return { ok: false, reason: 'attention event id is invalid' }
      }
      return { ok: true, payload: { eventId } }
    }

    case 'office.status.read': {
      // A payloadless read, exactly like `work.status.read` and
      // `workforce.status.read`. Anything attached is refused rather than
      // dropped, so a window cannot smuggle an instruction into a question.
      if (!carriesNothing(payload)) {
        return { ok: false, reason: 'the Office read carries no payload' }
      }
      return { ok: true }
    }

    case 'office.presence.request': {
      // One bounded field, and nothing else crosses.
      //
      // What is deliberately absent is the interesting part. There is no
      // `principal`, no `authority`, no `capability`, no `expression`, no
      // `position` and no `style` — so a window cannot assert who is asking,
      // grant the agent anything, or choose how it appears. The request is a
      // question to Presence (Phase 13), not an instruction, and the bridge
      // forwards the workerId and refuses the rest.
      const workerId = string('workerId', 128)
      if (workerId === null || workerId === undefined) {
        return { ok: false, reason: 'a workerId is required' }
      }
      if (record === null || Object.keys(record).some((key) => key !== 'workerId')) {
        return { ok: false, reason: 'presence request accepts only workerId' }
      }
      if (!/^[A-Za-z0-9._:-]+$/.test(workerId)) {
        return { ok: false, reason: 'workerId is invalid' }
      }
      return { ok: true, payload: { workerId } }
    }

    case 'relay.status.read': {
      // A payloadless read. Anything attached is refused rather than dropped,
      // so a window cannot smuggle a connector, an action or a capability
      // into the question of what Core reports.
      if (!carriesNothing(payload)) return { ok: false, reason: RELAY_NO_PAYLOAD }
      return { ok: true }
    }

    case 'relay.email.read':
    case 'relay.calendar.read':
    case 'relay.github.read': {
      // The named fields, and nothing else. A read carries a query, a limit
      // and a cursor — never a capability, a budget or a connector name.
      const query = string('query', 2_000, false)
      if (query === null) return { ok: false, reason: 'relay query is invalid' }
      const limit = record?.limit
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
        return { ok: false, reason: 'relay pagination limit is invalid' }
      }
      const cursor = string('cursor', RELAY_LIMITS.maxCursorChars, false)
      if (cursor === null) return { ok: false, reason: 'relay cursor is invalid' }
      if (command === 'relay.github.read') {
        const repo = string('repo', RELAY_LIMITS.maxRepoRefChars)
        if (repo === null || repo === undefined) return { ok: false, reason: 'a repo ref is required' }
        return {
          ok: true,
          payload: {
            repo,
            ...(query === undefined ? {} : { query }),
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        }
      }
      return {
        ok: true,
        payload: {
          ...(query === undefined ? {} : { query }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      }
    }

    case 'relay.email.draft.create':
    case 'relay.email.send': {
      // Recipients, subject, body and attachment metadata — separated, and
      // nothing else. There is deliberately no `bcc` field: a hidden recipient
      // is a recipient the approver cannot see, and the whole point of the
      // approval is that the approver sees who will be affected.
      const to = string('to', 4_096)
      if (to === null || to === undefined) return { ok: false, reason: 'a recipient list is required' }
      const cc = string('cc', 4_096, false)
      if (cc === null) return { ok: false, reason: 'the cc list is invalid' }
      const subject = string('subject', 998)
      if (subject === null || subject === undefined) return { ok: false, reason: 'a subject is required' }
      const body = string('body', 100_000)
      if (body === null || body === undefined) return { ok: false, reason: 'a body is required' }
      const rawAttachments = record?.attachments
      if (rawAttachments !== undefined) {
        if (!Array.isArray(rawAttachments)) return { ok: false, reason: 'attachments must be a list' }
        if (rawAttachments.length > RELAY_LIMITS.maxAttachments) {
          return { ok: false, reason: `at most ${RELAY_LIMITS.maxAttachments} attachments are allowed` }
        }
        for (const raw of rawAttachments) {
          if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'an attachment must be an object' }
          const attachment = raw as Record<string, unknown>
          if (typeof attachment.filename !== 'string' || attachment.filename.length === 0) {
            return { ok: false, reason: 'an attachment filename is required' }
          }
          if (typeof attachment.contentType !== 'string' || attachment.contentType.length === 0) {
            return { ok: false, reason: 'an attachment content type is required' }
          }
          if (typeof attachment.sizeBytes !== 'number' || !Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
            return { ok: false, reason: 'an attachment size is invalid' }
          }
        }
      }
      if (command === 'relay.email.send') {
        const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
        if (key === null || key === undefined) {
          return { ok: false, reason: 'an idempotency key is required to send' }
        }
        return {
          ok: true,
          payload: {
            to: to.split(',').map((address) => address.trim()).filter((address) => address.length > 0),
            ...(cc === undefined || cc === '' ? {} : { cc: cc.split(',').map((address) => address.trim()).filter((address) => address.length > 0) }),
            subject,
            body,
            ...(rawAttachments === undefined ? {} : { attachments: rawAttachments }),
            idempotencyKey: key,
          },
        }
      }
      return {
        ok: true,
        payload: {
          to: to.split(',').map((address) => address.trim()).filter((address) => address.length > 0),
          ...(cc === undefined || cc === '' ? {} : { cc: cc.split(',').map((address) => address.trim()).filter((address) => address.length > 0) }),
          subject,
          body,
          ...(rawAttachments === undefined ? {} : { attachments: rawAttachments }),
        },
      }
    }

    case 'relay.calendar.create': {
      const title = string('title', 2_000)
      if (title === null || title === undefined) return { ok: false, reason: 'a title is required' }
      const startsAt = string('startsAt', 64)
      const endsAt = string('endsAt', 64)
      if (startsAt === null || startsAt === undefined) return { ok: false, reason: 'a start time is required' }
      if (endsAt === null || endsAt === undefined) return { ok: false, reason: 'an end time is required' }
      const location = string('location', 1_000, false)
      if (location === null) return { ok: false, reason: 'a location is invalid' }
      const attendees = string('attendees', 8_192, false)
      if (attendees === null) return { ok: false, reason: 'an attendee list is invalid' }
      const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
      if (key === null || key === undefined) {
        return { ok: false, reason: 'an idempotency key is required' }
      }
      return {
        ok: true,
        payload: {
          title,
          startsAt,
          endsAt,
          ...(location === undefined || location === '' ? {} : { location }),
          ...(attendees === undefined || attendees === ''
            ? {}
            : { attendees: attendees.split(',').map((address) => address.trim()).filter((address) => address.length > 0) }),
          idempotencyKey: key,
        },
      }
    }

    case 'relay.calendar.update': {
      const eventId = string('eventId', MAX_ID_CHARS)
      if (eventId === null || eventId === undefined) return { ok: false, reason: 'an event id is required' }
      const title = string('title', 2_000, false)
      if (title === null) return { ok: false, reason: 'a title is invalid' }
      const startsAt = string('startsAt', 64, false)
      if (startsAt === null) return { ok: false, reason: 'a start time is invalid' }
      const endsAt = string('endsAt', 64, false)
      if (endsAt === null) return { ok: false, reason: 'an end time is invalid' }
      const location = string('location', 1_000, false)
      if (location === null) return { ok: false, reason: 'a location is invalid' }
      const attendees = string('attendees', 8_192, false)
      if (attendees === null) return { ok: false, reason: 'an attendee list is invalid' }
      const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
      if (key === null || key === undefined) {
        return { ok: false, reason: 'an idempotency key is required' }
      }
      return {
        ok: true,
        payload: {
          eventId,
          ...(title === undefined || title === '' ? {} : { title }),
          ...(startsAt === undefined || startsAt === '' ? {} : { startsAt }),
          ...(endsAt === undefined || endsAt === '' ? {} : { endsAt }),
          ...(location === undefined ? {} : { location: location === '' ? null : location }),
          ...(attendees === undefined || attendees === ''
            ? {}
            : { attendees: attendees.split(',').map((address) => address.trim()).filter((address) => address.length > 0) }),
          idempotencyKey: key,
        },
      }
    }

    case 'relay.calendar.cancel': {
      const eventId = string('eventId', MAX_ID_CHARS)
      if (eventId === null || eventId === undefined) return { ok: false, reason: 'an event id is required' }
      const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
      if (key === null || key === undefined) {
        return { ok: false, reason: 'an idempotency key is required' }
      }
      return { ok: true, payload: { eventId, idempotencyKey: key } }
    }

    case 'relay.github.issue.create':
    case 'relay.github.pr.create': {
      const repo = string('repo', RELAY_LIMITS.maxRepoRefChars)
      if (repo === null || repo === undefined) return { ok: false, reason: 'a repo ref is required' }
      const title = string('title', 2_000)
      if (title === null || title === undefined) return { ok: false, reason: 'a title is required' }
      const body = string('body', 100_000)
      if (body === null || body === undefined) return { ok: false, reason: 'a body is required' }
      const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
      if (key === null || key === undefined) {
        return { ok: false, reason: 'an idempotency key is required' }
      }
      if (command === 'relay.github.pr.create') {
        const head = string('head', 128)
        const base = string('base', 128)
        if (head === null || head === undefined) return { ok: false, reason: 'a head branch is required' }
        if (base === null || base === undefined) return { ok: false, reason: 'a base branch is required' }
        return { ok: true, payload: { repo, head, base, title, body, idempotencyKey: key } }
      }
      return { ok: true, payload: { repo, title, body, idempotencyKey: key } }
    }

    case 'relay.external.invoke': {
      const connector = string('connector', RELAY_LIMITS.maxExternalConnectorChars)
      if (connector === null || connector === undefined) {
        return { ok: false, reason: 'an external connector name is required' }
      }
      const operation = string('operation', RELAY_LIMITS.maxExternalOperationChars)
      if (operation === null || operation === undefined) {
        return { ok: false, reason: 'an external operation is required' }
      }
      const rawParams = record?.params
      if (rawParams !== undefined && !Array.isArray(rawParams)) {
        return { ok: false, reason: 'external parameters must be a list' }
      }
      const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
      if (key === null || key === undefined) {
        return { ok: false, reason: 'an idempotency key is required' }
      }
      return {
        ok: true,
        payload: {
          connector,
          operation,
          ...(rawParams === undefined ? {} : { params: rawParams }),
          idempotencyKey: key,
        },
      }
    }

    case 'relay.approval.decide': {
      // The decision and its subject, and nothing else. There is deliberately
      // no `decidedBy` here to read: identity for a decision is assigned by
      // Core from the principal that reached the command. A window that could
      // name its own approver could approve its own request.
      const approvalId = string('approvalId', MAX_ID_CHARS)
      const decision = string('decision', 16)
      if (approvalId === null || approvalId === undefined) {
        return { ok: false, reason: 'approval id is invalid' }
      }
      if (decision === null || decision === undefined) {
        return { ok: false, reason: 'approval decision is invalid' }
      }
      if (decision !== 'approved' && decision !== 'denied') {
        return { ok: false, reason: 'an approval decision must be approved or denied' }
      }
      return { ok: true, payload: { approvalId, decision } }
    }

    /* ----------------------------------------------------------- skills */
    //
    // Each arm rebuilds its payload from named fields, so a field this bridge does not
    // name is not merely refused by Core ??? it never crosses the bridge. The named
    // omissions are the security argument:
    //
    //   - `skill.admit` / `skill.revise` take no `source`, no `trustClass`, no
    //     `status`, no `verification` and no `version`. Core assigns the source, reads
    //     the version from the record, and derives verification from evaluations.
    //   - `skill.recordEvaluation` takes only evidence items with a `kind`, a `code` and
    //     a `count`, plus an optional commentary **length**. There is no field here for
    //     a verification record, for a verdict, or for commentary text ??? so a window
    //     cannot forge verification and cannot submit an opinion as evidence.
    //   - `skill.transition` takes a status *name* and nothing else. The evidence,
    //     the thresholds and the age window are Core's.
    //   - `skill.propose` takes a target kind, a target reference and a summary. The
    //     basis evaluations are derived by Core, so a window cannot choose which
    //     evidence a proposal rests on.
    //
    // There is no arm for offering an artifact into the runtime, and there is no
    // channel that accepts a source-file path. A window cannot ask Core to rewrite
    // itself, because there is nothing here to ask with.

    case 'skill.status.read': {
      // A payloadless read, like `attention.status.read` and `workforce.status.read`.
      if (!carriesNothing(payload)) return { ok: false, reason: SKILL_NO_PAYLOAD }
      return { ok: true }
    }

    case 'world.summary.read':
    case 'self.status.read':
      // Payloadless: a filter here is how a bounded read becomes a query.
      if (!carriesNothing(payload)) return { ok: false, reason: WORLD_NO_PAYLOAD }
      return { ok: true }

    case 'world.entities.read':
      return narrowWorldRead(payload, ['kind', 'includeWithdrawn'], (body) => {
        if (body.kind != null && !WORLD_READ_KINDS.has(String(body.kind))) {
          return 'that is not an entity kind this Core knows'
        }
        if (body.includeWithdrawn !== undefined && typeof body.includeWithdrawn !== 'boolean') {
          return 'includeWithdrawn is true or false'
        }
        return null
      })

    case 'world.entity.read':
      // One id and nothing else: there is no "list every claim's text" form.
      return narrowWorldRead(payload, ['entityId'], (body) =>
        isBoundedId(body.entityId) ? null : 'entityId is not a usable id',
      )

    case 'world.relations.read':
      // `maxDepth` caps at 2 so a window cannot ask for the whole world by walking.
      return narrowWorldRead(payload, ['focusEntityId', 'kinds', 'maxDepth'], (body) => {
        if (body.focusEntityId != null && !isBoundedId(body.focusEntityId)) {
          return 'focusEntityId is not a usable entity id'
        }
        if (body.kinds != null) {
          const list = body.kinds as unknown[]
          if (!Array.isArray(list) || list.length === 0 || list.length > 12) {
            return 'kinds must be a short list of entity kinds'
          }
          if (list.some((kind) => typeof kind !== 'string' || !WORLD_READ_KINDS.has(kind))) {
            return 'kinds must contain only entity kinds'
          }
        }
        const depth = body.maxDepth
        if (depth != null && (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > 2)) {
          return 'maxDepth is 0, 1 or 2'
        }
        return null
      })

    case 'skill.admit':
    case 'skill.revise': {
      const name = string('name', SKILL_LIMITS.maxNameChars)
      const kind = string('kind', 24)
      const summary = string('summary', SKILL_LIMITS.maxSummaryChars)
      if (name === null || name === undefined) return { ok: false, reason: 'a skill name is required' }
      if (kind === null || kind === undefined) return { ok: false, reason: 'a skill kind is required' }
      if (summary === null || summary === undefined) {
        return { ok: false, reason: 'a skill summary is required' }
      }
      const contract = boundedSkillContract(record?.contract)
      if (contract === null) return { ok: false, reason: 'the skill contract is invalid or too large' }
      const applicability = boundedSkillTags(record?.applicability)
      if (applicability === null) return { ok: false, reason: 'skill applicability tags are invalid' }
      const requiredCapabilities = boundedCapabilities(record?.requiredCapabilities)
      if (requiredCapabilities === null) {
        return { ok: false, reason: 'skill required capabilities are invalid' }
      }
      const steps = boundedSkillSteps(record?.steps)
      if (steps === null) return { ok: false, reason: 'skill steps are invalid' }
      const base = { name, kind, summary, contract, applicability, requiredCapabilities, steps }
      if (command === 'skill.admit') return { ok: true, payload: base }
      const skillId = string('skillId', MAX_ID_CHARS)
      if (skillId === null || skillId === undefined) {
        return { ok: false, reason: 'a revision needs the skill id it revises' }
      }
      return { ok: true, payload: { ...base, skillId } }
    }

    case 'skill.recordEvaluation': {
      const skillId = string('skillId', MAX_ID_CHARS)
      if (skillId === null || skillId === undefined) {
        return { ok: false, reason: 'an evaluation needs the skill it is about' }
      }
      const subjectKind = string('subjectKind', 24)
      if (subjectKind === null || subjectKind === undefined) {
        return { ok: false, reason: 'an evaluation needs a subject kind' }
      }
      const subjectRef = string('subjectRef', MAX_ID_CHARS)
      if (subjectRef === null || subjectRef === undefined) {
        return { ok: false, reason: 'an evaluation needs a subject reference' }
      }
      const evidence = boundedEvidenceItems(record?.evidence)
      if (evidence === null) return { ok: false, reason: 'evaluation evidence is invalid' }
      const metrics = boundedMetrics(record?.metrics)
      if (metrics === null) return { ok: false, reason: 'evaluation metrics are invalid' }
      // A *length*, never text. There is no `commentary` string field on this bridge,
      // so there is no way for a window to hand Core an opinion as anything but a
      // count of characters ??? which is the only shape `evaluateOutcome` ever reads.
      const commentaryLength = record?.commentaryLength
      if (
        commentaryLength !== undefined &&
        (typeof commentaryLength !== 'number' ||
          !Number.isInteger(commentaryLength) ||
          commentaryLength < 0 ||
          commentaryLength > SKILL_LIMITS.maxCommentaryChars)
      ) {
        return { ok: false, reason: 'commentary is recorded as a character count' }
      }
      return {
        ok: true,
        payload: {
          skillId,
          subjectKind,
          subjectRef,
          evidence,
          metrics,
          ...(commentaryLength === undefined ? {} : { commentaryLength }),
        },
      }
    }

    case 'skill.transition': {
      const skillId = string('skillId', MAX_ID_CHARS)
      const to = string('to', 24)
      if (skillId === null || skillId === undefined) {
        return { ok: false, reason: 'a transition needs the skill id' }
      }
      if (to === null || to === undefined) return { ok: false, reason: 'a transition needs a status' }
      return { ok: true, payload: { skillId, to } }
    }

    case 'skill.retire': {
      const skillId = string('skillId', MAX_ID_CHARS)
      const reason = string('reason', 40)
      if (skillId === null || skillId === undefined) {
        return { ok: false, reason: 'a retirement needs the skill id' }
      }
      if (reason === null || reason === undefined) return { ok: false, reason: 'a retirement needs a reason' }
      return { ok: true, payload: { skillId, reason } }
    }

    case 'skill.propose': {
      const target = string('target', 32)
      const targetRef = string('targetRef', SKILL_LIMITS.maxRefChars)
      const summary = string('summary', SKILL_LIMITS.maxSummaryChars, false)
      if (target === null || target === undefined) return { ok: false, reason: 'a proposal needs a target kind' }
      if (targetRef === null || targetRef === undefined) {
        return { ok: false, reason: 'a proposal needs a target reference' }
      }
      if (summary === null) return { ok: false, reason: 'the proposal summary is invalid' }
      return {
        ok: true,
        payload: { target, targetRef, ...(summary === undefined ? {} : { summary }) },
      }
    }

    case 'skill.proposal.settle': {
      const proposalId = string('proposalId', MAX_ID_CHARS)
      const decision = string('decision', 16)
      if (proposalId === null || proposalId === undefined) {
        return { ok: false, reason: 'a settlement needs the proposal id' }
      }
      if (decision === null || decision === undefined) {
        return { ok: false, reason: 'a settlement needs a decision' }
      }
      const reason = string('reason', 48, false)
      if (reason === null) return { ok: false, reason: 'the settlement reason is invalid' }
      return {
        ok: true,
        payload: { proposalId, decision, ...(reason === undefined ? {} : { reason }) },
      }
    }

    case 'skill.select': {
      const applicability = record?.applicability
      const tags = boundedSkillTags(applicability ?? [])
      if (tags === null) return { ok: false, reason: 'selection applicability tags are invalid' }
      const includeTrial = record?.includeTrial
      const includeVerified = record?.includeVerified
      for (const value of [includeTrial, includeVerified]) {
        if (value !== undefined && typeof value !== 'boolean') {
          return { ok: false, reason: 'selection flags are booleans' }
        }
      }
      const limit = record?.limit
      if (
        limit !== undefined &&
        (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 64)
      ) {
        return { ok: false, reason: 'the selection limit is invalid' }
      }
      return {
        ok: true,
        payload: {
          applicability: tags,
          ...(includeTrial === undefined ? {} : { includeTrial }),
          ...(includeVerified === undefined ? {} : { includeVerified }),
          ...(limit === undefined ? {} : { limit }),
        },
      }
    }

    case 'skill.detail.read': {
      const skillId = string('skillId', MAX_ID_CHARS)
      if (skillId === null || skillId === undefined) {
        return { ok: false, reason: 'a detail read needs the skill id' }
      }
      return { ok: true, payload: { skillId } }
    }

    case 'life.status.read': {
      // The payloadless read. Anything attached is refused rather than dropped, so
      // a window cannot accompany "what do you remember" with a status, a
      // derivation class, a confidence or a date.
      if (!carriesNothing(payload)) {
        return { ok: false, reason: LIFE_NO_PAYLOAD }
      }
      return { ok: true }
    }

    case 'life.timeline.read': {
      if (payload === undefined || payload === null) return { ok: true }
      if (record === null) {
        return { ok: false, reason: 'a timeline read takes a bounded limit and known entry kinds' }
      }
      for (const key of Object.keys(record)) {
        if (key !== 'limit' && key !== 'kinds' && key !== 'includeWithdrawn') {
          return { ok: false, reason: 'a timeline read takes a bounded limit and known entry kinds' }
        }
      }
      const result: Record<string, unknown> = {}
      const limit = record.limit
      if (limit !== undefined) {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > LIFE_TIMELINE_LIMIT) {
          return { ok: false, reason: 'the timeline limit is invalid' }
        }
        result.limit = limit
      }
      const kinds = record.kinds
      if (kinds !== undefined) {
        if (!Array.isArray(kinds) || kinds.length > 8) {
          return { ok: false, reason: 'the timeline kinds are invalid' }
        }
        const accepted = new Set(['episode', 'milestone', 'period', 'theme'])
        for (const kind of kinds) {
          if (typeof kind !== 'string' || !accepted.has(kind)) {
            return { ok: false, reason: 'the timeline kinds are invalid' }
          }
        }
        result.kinds = [...kinds]
      }
      const includeWithdrawn = record.includeWithdrawn
      if (includeWithdrawn !== undefined) {
        if (typeof includeWithdrawn !== 'boolean') {
          return { ok: false, reason: 'the timeline withdrawal flag is invalid' }
        }
        result.includeWithdrawn = includeWithdrawn
      }
      return { ok: true, payload: result }
    }

    case 'life.entry.read': {
      // One id. The one route to an entry's own text, and it carries nothing else:
      // no confidence, no derivation class, no body.
      const entryId = string('entryId', MAX_ID_CHARS)
      if (entryId === null || entryId === undefined) {
        return { ok: false, reason: 'an entry read needs the entry id' }
      }
      return { ok: true, payload: { entryId } }
    }

    case 'voice.capture.end': {
      const sessionId = string('sessionId', MAX_ID_CHARS)
      const audio = record?.audio
      const durationMs = record?.durationMs
      const cancelled = record?.cancelled

      if (sessionId === null || sessionId === undefined) {
        return { ok: false, reason: 'voice session id is invalid' }
      }
      if (!(audio instanceof Uint8Array)) {
        return { ok: false, reason: 'voice audio payload is invalid' }
      }
      // The byte ceiling is checked here rather than only in Core: this bridge is a
      // capability boundary, and a payload large enough to be a denial of service
      // belongs to be refused before it is structured-cloned into the main process.
      if (audio.byteLength > VOICE_LIMITS.maxAudioBytes) {
        return { ok: false, reason: 'voice audio payload exceeds the capture limit' }
      }
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        return { ok: false, reason: 'voice capture duration is invalid' }
      }
      if (cancelled !== undefined && typeof cancelled !== 'boolean') {
        return { ok: false, reason: 'voice cancellation flag is invalid' }
      }

      /*
       * The descriptive fields are forwarded as *strings from closed sets*, or not
       * at all.
       *
       * Core re-validates all of them — a bridge that trusted its own earlier check
       * would be trusting a window — but forwarding a bounded set of known-good
       * values is cheaper and stricter than forwarding whatever arrived and letting
       * a second validator sort it out. Anything outside the sets is refused here,
       * which means a malformed declaration never reaches the trusted half at all.
       */
      const format = record?.format
      if (format !== undefined && format !== VOICE_LIMITS.format) {
        return { ok: false, reason: `voice audio must be ${VOICE_LIMITS.format}` }
      }
      const codec = record?.codec
      if (codec !== undefined && (typeof codec !== 'string' || !VOICE_CODECS.has(codec))) {
        return { ok: false, reason: 'voice audio codec is not accepted' }
      }
      const mimeType = record?.mimeType
      if (mimeType !== undefined && (typeof mimeType !== 'string' || !VOICE_MIME_TYPES.has(mimeType.toLowerCase()))) {
        return { ok: false, reason: 'voice audio container type is not accepted' }
      }
      const sampleRate = record?.sampleRate
      if (sampleRate !== undefined && (typeof sampleRate !== 'number' || !VOICE_SAMPLE_RATES.has(sampleRate))) {
        return { ok: false, reason: 'voice sample rate is not accepted' }
      }
      const channels = record?.channels
      if (channels !== undefined && (typeof channels !== 'number' || !VOICE_CHANNEL_COUNTS.has(channels))) {
        return { ok: false, reason: 'voice channel count is not accepted' }
      }

      return {
        ok: true,
        payload: {
          sessionId,
          audio,
          durationMs,
          ...(cancelled === undefined ? {} : { cancelled }),
          ...(format === undefined ? {} : { format }),
          ...(codec === undefined ? {} : { codec }),
          ...(mimeType === undefined ? {} : { mimeType }),
          ...(sampleRate === undefined ? {} : { sampleRate }),
          ...(channels === undefined ? {} : { channels }),
        },
      }
    }

    case 'brain.memory.write': {
      // Bounded here rather than only in Core: this bridge is a capability
      // boundary, and a payload large enough to be a denial-of-service belongs to
      // be refused before it is structured-cloned into the main process.
      const content = string('content', BRAIN_LIMITS.maxMemoryContentChars)
      const subject = string('subject', BRAIN_LIMITS.maxMemorySubjectChars, false)
      const kind = string('kind', 40, false)
      if (content === null || content === undefined) {
        return { ok: false, reason: 'memory content is too large or invalid' }
      }
      if (subject === null) return { ok: false, reason: 'memory subject is too large or invalid' }
      if (kind === null) return { ok: false, reason: 'memory kind is invalid' }
      return {
        ok: true,
        payload: {
          content,
          ...(subject === undefined ? {} : { subject }),
          ...(kind === undefined ? {} : { kind }),
        },
      }
    }

    case 'brain.memory.archive': {
      const memoryId = string('memoryId', MAX_ID_CHARS)
      const reason = string('reason', MAX_STOP_REASON_CHARS, false)
      if (memoryId === null || memoryId === undefined) {
        return { ok: false, reason: 'memory id is invalid' }
      }
      if (reason === null) return { ok: false, reason: 'memory archive reason is invalid' }
      return { ok: true, payload: { memoryId, ...(reason === undefined ? {} : { reason }) } }
    }

    case 'brain.recall': {
      const query = string('query', 2_000, false)
      if (query === null) return { ok: false, reason: 'recall query is invalid' }
      // Bounded to the same ceiling Core clamps to, so a window cannot ask for an
      // unbounded pack. `clampBudget` enforces it again inside Core; this is the
      // first of the two, not the only one.
      const limit = record?.limit
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) {
        return { ok: false, reason: 'recall limit is invalid' }
      }
      return {
        ok: true,
        payload: { ...(query === undefined ? {} : { query }), ...(limit === undefined ? {} : { limit }) },
      }
    }

    case 'search.web': {
      // One field. A renderer cannot attach a provenance class, a provider, a result
      // count or a budget; the payload is rebuilt from `query` alone, so a large
      // ignored blob never gets structured-cloned into the main process.
      const query = string('query', MAX_SEARCH_QUERY_CHARS)
      if (query === null || query === undefined) {
        return { ok: false, reason: 'a search query is required' }
      }
      return { ok: true, payload: { query } }
    }

    case 'browser.read': {
      const url = string('url', MAX_SOURCE_URL_CHARS)
      if (url === null || url === undefined) {
        return { ok: false, reason: 'a URL is required' }
      }
      return { ok: true, payload: { url } }
    }

    case 'research.start': {
      const question = string('question', MAX_RESEARCH_QUESTION_CHARS)
      if (question === null || question === undefined) {
        return { ok: false, reason: 'a research question is required' }
      }
      // Nothing else is forwarded. In particular not `modelTurns`, `durationMs`,
      // `maxOutputTokens` or `limits`: research budgets are code-owned, and a window
      // that could raise them would make the whole ceiling advisory.
      return { ok: true, payload: { question } }
    }

    case 'research.cancel': {
      const researchId = string('researchId', MAX_ID_CHARS)
      if (researchId === null || researchId === undefined) {
        return { ok: false, reason: 'a research id is required' }
      }
      return { ok: true, payload: { researchId } }
    }

    /* ------------------------------------------------ Freya's Eye sessions */
    // The Eye sessions are the same capability as `research.start`, spread over a
    // conversation: a request, a follow-up, and the lifecycle verbs. They were
    // missing from `CORE_COMMANDS` while Core and the renderer both already
    // implemented them, so the composer's Eye route was refused with
    // `unknown command` and the turn never ran at all.
    //
    // Nothing beyond the two strings is forwarded, for the same reason as
    // `research.start`: iteration counts, budgets and models stay Core's.

    case 'research.session.create': {
      const request = string('request', MAX_RESEARCH_QUESTION_CHARS)
      if (request === null || request === undefined) {
        return { ok: false, reason: 'a search request is required' }
      }
      return { ok: true, payload: { request } }
    }

    case 'research.session.list': {
      // No payload at all: the list is the whole answer, and a window cannot narrow
      // it by naming a subset.
      return { ok: true, payload: {} }
    }

    case 'research.session.read': {
      const sessionId = string('sessionId', MAX_ID_CHARS)
      if (sessionId === null || sessionId === undefined) {
        return { ok: false, reason: 'a session id is required' }
      }
      return { ok: true, payload: { sessionId } }
    }

    case 'research.session.followup': {
      const sessionId = string('sessionId', MAX_ID_CHARS)
      if (sessionId === null || sessionId === undefined) {
        return { ok: false, reason: 'a session id is required' }
      }
      const text = string('text', MAX_RESEARCH_QUESTION_CHARS)
      if (text === null || text === undefined) {
        return { ok: false, reason: 'a follow-up is required' }
      }
      return { ok: true, payload: { sessionId, text } }
    }

    // The four lifecycle verbs are the same shape, and share one contract rather
    // than four copies that can drift.
    case 'research.session.collect':
    case 'research.session.pause':
    case 'research.session.resume':
    case 'research.session.cancel': {
      const sessionId = string('sessionId', MAX_ID_CHARS)
      if (sessionId === null || sessionId === undefined) {
        return { ok: false, reason: 'a session id is required' }
      }
      return { ok: true, payload: { sessionId } }
    }


    case 'work.task.create': {
      const title = string('title', WORK_LIMITS.maxLabelChars)
      if (title === null || title === undefined) {
        return { ok: false, reason: 'task title is too large or invalid' }
      }
      return { ok: true, payload: { title } }
    }

    case 'work.task.update': {
      const taskId = string('taskId', MAX_ID_CHARS)
      const status = string('status', 32)
      if (taskId === null || taskId === undefined) return { ok: false, reason: 'task id is invalid' }
      if (status === null || status === undefined) {
        return { ok: false, reason: 'task status is invalid' }
      }
      return { ok: true, payload: { taskId, status } }
    }

    case 'work.run.create': {
      /**
       * A plan is a request, and this is where its *size* is bounded.
       *
       * Each step is rebuilt from named fields — key, capability, verifier, label,
       * requiresApproval — and `input` is passed as the caller sent it, because the
       * engine's sanitiser is the thing that decides what may reach a capability. A
       * second sanitiser here would be a second set of rules that could disagree with
       * the one that matters.
       *
       * What is dropped is everything else, so a window cannot attach an ignored
       * blob to an otherwise valid plan and make the main process structured-clone
       * it. Note also what a step cannot carry: a verdict. There is no field here
       * for a window to say a step succeeded.
       */
      const rawSteps = record?.steps
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { ok: false, reason: 'a run needs at least one step' }
      }
      if (rawSteps.length > WORK_LIMITS.maxRunSteps) {
        return { ok: false, reason: `a plan may hold at most ${WORK_LIMITS.maxRunSteps} steps` }
      }
      const steps: Record<string, unknown>[] = []
      for (const raw of rawSteps) {
        if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'a step was malformed' }
        const step = raw as Record<string, unknown>
        const key = from(step, 'key', 64)
        const capability = from(step, 'capability', 64)
        const verifier = from(step, 'verifier', 64)
        const label = from(step, 'label', WORK_LIMITS.maxLabelChars)
        if (key === null || key === undefined) return { ok: false, reason: 'a step key is invalid' }
        if (capability === null || capability === undefined) {
          return { ok: false, reason: 'a step capability is invalid' }
        }
        if (verifier === null || verifier === undefined) {
          return { ok: false, reason: 'a step verifier is invalid' }
        }
        if (label === null || label === undefined) return { ok: false, reason: 'a step label is invalid' }
        steps.push({
          key,
          capability,
          verifier,
          label,
          ...(step.input === undefined ? {} : { input: step.input }),
          ...(step.requiresApproval === true ? { requiresApproval: true } : {}),
        })
      }

      const taskId = string('taskId', MAX_ID_CHARS, false)
      if (taskId === null) return { ok: false, reason: 'task id is invalid' }
      // A window may say *which Mission* this Run belongs to, and nothing else about
      // its parent. There is deliberately no `parent` case here: an earlier version
      // forwarded a `{ kind, id }` pair read straight off the payload, which let any
      // window attach a Run to anything by asserting one. Naming a parent is a claim
      // about structure, and structure is Core's to decide. Refused rather than
      // dropped, so code still sending the old shape is told.
      if (record !== null && 'parent' in record) {
        return {
          ok: false,
          reason: "a run's parent is decided by Core; name a missionId instead of a parent",
        }
      }
      const missionId = string('missionId', MAX_ID_CHARS, false)
      if (missionId === null) return { ok: false, reason: 'mission id is invalid' }
      // Rebuilt from the four named ceilings rather than forwarded as an object.
      //
      // Every other field on this command is rebuilt for one reason: an ignored blob
      // would still be structured-cloned into the main process before Core could refuse
      // it, so a window could attach an arbitrarily large payload to an otherwise valid
      // command. `limits` was the one field that skipped that, for no stated reason.
      //
      // None of these can raise anything — Core clamps each one downward against
      // WORK_LIMITS — so this is about the size of what crosses the boundary, not about
      // what it can do.
      const rawLimits = record?.limits
      let limits: Record<string, number> | undefined
      if (rawLimits !== undefined) {
        if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) {
          return { ok: false, reason: 'run limits are invalid' }
        }
        const requested = rawLimits as Record<string, unknown>
        limits = {}
        for (const name of ['maxSteps', 'maxActions', 'maxDurationMs', 'maxAttemptsPerStep']) {
          const value = requested[name]
          if (value === undefined || value === null) continue
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            return { ok: false, reason: `run limit ${name} is invalid` }
          }
          limits[name] = Math.floor(value)
        }
        // An object carrying only unrecognised keys carries no request at all, and
        // forwarding it would be forwarding an empty lie.
        if (Object.keys(limits).length === 0) limits = undefined
      }
      return {
        ok: true,
        payload: {
          steps,
          ...(taskId === undefined ? {} : { taskId }),
          ...(missionId === undefined ? {} : { missionId }),
          ...(limits === undefined ? {} : { limits }),
        },
      }
    }

    case 'work.run.start':
    case 'work.run.pause':
    case 'work.run.resume':
    case 'work.run.cancel': {
      const runId = string('runId', MAX_ID_CHARS)
      if (runId === null || runId === undefined) return { ok: false, reason: 'run id is invalid' }
      if (command === 'work.run.cancel') {
        const reason = string('reason', MAX_STOP_REASON_CHARS, false)
        if (reason === null) return { ok: false, reason: 'cancellation reason is invalid' }
        return { ok: true, payload: reason === undefined ? { runId } : { runId, reason } }
      }
      return { ok: true, payload: { runId } }
    }

    case 'work.approval.decide': {
      // The decision and its subject, and nothing else. There is deliberately no
      // `decidedBy` here to read: identity for an approval is assigned by Core from
      // the principal that reached the command. A window that appended one is
      // ignored, and a window that could name its own approver could approve its own
      // request.
      const approvalId = string('approvalId', MAX_ID_CHARS)
      const decision = string('decision', 16)
      const reason = string('reason', MAX_STOP_REASON_CHARS, false)
      if (approvalId === null || approvalId === undefined) {
        return { ok: false, reason: 'approval id is invalid' }
      }
      if (decision === null || decision === undefined) {
        return { ok: false, reason: 'approval decision is invalid' }
      }
      if (decision !== 'approved' && decision !== 'denied') {
        return { ok: false, reason: 'an approval decision must be approved or denied' }
      }
      if (reason === null) return { ok: false, reason: 'approval reason is invalid' }
      return {
        ok: true,
        payload: {
          approvalId,
          decision,
          ...(reason === undefined ? {} : { reason }),
        },
      }
    }

    /* ------------------------------------------------ relay drive/telegram */

    case 'relay.drive.read':
    case 'relay.telegram.read': {
      const query = string('query', 2_000, false)
      if (query === null) return { ok: false, reason: 'relay query is invalid' }
      const limit = record?.limit
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
        return { ok: false, reason: 'relay pagination limit is invalid' }
      }
      const cursor = string('cursor', RELAY_LIMITS.maxCursorChars, false)
      if (cursor === null) return { ok: false, reason: 'relay cursor is invalid' }
      if (command === 'relay.telegram.read') {
        const chatId = string('chatId', MAX_ID_CHARS)
        if (chatId === null || chatId === undefined) return { ok: false, reason: 'a chat id is required' }
        return {
          ok: true,
          payload: {
            chatId,
            ...(query === undefined ? {} : { query }),
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        }
      }
      const fileId = string('fileId', MAX_ID_CHARS, false)
      if (fileId === null) return { ok: false, reason: 'a file id is invalid' }
      return {
        ok: true,
        payload: {
          ...(query === undefined ? {} : { query }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(fileId === undefined ? {} : { fileId }),
        },
      }
    }

    case 'relay.drive.file.create': {
      const name = string('name', RELAY_LIMITS.maxDriveNameChars)
      const mimeType = string('mimeType', 255)
      const content = string('content', RELAY_LIMITS.maxDriveContentChars, false)
      if (name === null || name === undefined) return { ok: false, reason: 'a file name is required' }
      if (mimeType === null || mimeType === undefined) return { ok: false, reason: 'a content type is required' }
      if (content === null) return { ok: false, reason: 'file content is invalid' }
      const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
      if (key === null || key === undefined) return { ok: false, reason: 'an idempotency key is required' }
      return {
        ok: true,
        payload: { name, mimeType, ...(content === undefined ? {} : { content }), idempotencyKey: key },
      }
    }

    case 'relay.telegram.send': {
      const chatId = string('chatId', MAX_ID_CHARS)
      const text = string('text', RELAY_LIMITS.maxTelegramMessageChars)
      if (chatId === null || chatId === undefined) return { ok: false, reason: 'a chat id is required' }
      if (text === null || text === undefined) return { ok: false, reason: 'message text is required' }
      const key = string('idempotencyKey', RELAY_LIMITS.maxIdempotencyKeyChars)
      if (key === null || key === undefined) return { ok: false, reason: 'an idempotency key is required' }
      return { ok: true, payload: { chatId, text, idempotencyKey: key } }
    }

    /* -------------------------------------------------------- connectors */

    case 'connector.status.read': {
      if (!carriesNothing(payload)) return { ok: false, reason: CONNECTOR_NO_PAYLOAD }
      return { ok: true }
    }

    case 'connector.connect.start': {
      const connector = string('connector', 64)
      if (connector === null || connector === undefined) return { ok: false, reason: 'a connector is required' }
      const authority = string('authority', 16, false)
      if (authority === null) return { ok: false, reason: 'a connect authority is invalid' }
      if (authority !== undefined && authority !== 'read' && authority !== 'write') {
        return { ok: false, reason: 'a connect authority must be read or write' }
      }
      return { ok: true, payload: { connector, ...(authority === undefined ? {} : { authority }) } }
    }

    case 'connector.disconnect': {
      const connector = string('connector', 64)
      if (connector === null || connector === undefined) return { ok: false, reason: 'a connector is required' }
      const reason = string('reason', 300, false)
      if (reason === null) return { ok: false, reason: 'a disconnect reason is invalid' }
      return { ok: true, payload: { connector, ...(reason === undefined ? {} : { reason }) } }
    }

    case 'connector.read':
    case 'connector.action.execute': {
      // A typed connector action: a connector, an action and the action's own
      // bounded params. There is no scope, token, account, capability, budget or
      // limit here, because a window has no name for any of them.
      const connector = string('connector', 64)
      const action = string('action', 64)
      if (connector === null || connector === undefined) return { ok: false, reason: 'a connector is required' }
      if (action === null || action === undefined) return { ok: false, reason: 'a connector action is required' }
      const rawParams = record?.params
      if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
        return { ok: false, reason: 'connector action params must be an object' }
      }
      const serialized = JSON.stringify(rawParams ?? {})
      if (serialized === undefined || serialized.length > 256_000) {
        return { ok: false, reason: 'connector action params are too large' }
      }
      return {
        ok: true,
        payload: {
          connector,
          action,
          ...(rawParams === undefined ? {} : { params: rawParams }),
        },
      }
    }

    // Grant governance is intentionally not in CORE_COMMANDS. Keeping a default
    // refusal here makes that property survive if the command vocabulary grows
    // and someone forgets to add a bounded renderer shape at the same time.
    default:
      return { ok: false, reason: 'command has no renderer payload contract' }
  }
}

/**
 * One web address, or nothing.
 *
 * Read on the way in so the handler never sees a `file:` path, a `data:` document or a
 * ten-kilobyte string dressed as a URL. Returning `null` rather than throwing keeps
 * the refusal in the shape the caller already handles.
 */
function boundedMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** A request id the renderer cannot choose, so it cannot collide or replay. */
function newRequestId(): string {
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

contextBridge.exposeInMainWorld('freyaHost', api)

export type FreyaHost = typeof api
