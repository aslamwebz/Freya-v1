import { createCore, type Core, type CoreOptions } from '../core/index'
import type { CoreCommandEnvelope, CoreCommandResult, CoreStatus } from '../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../core/protocol/activity'
import type { ConversationProjection, VoiceProjection } from '../core/protocol/conversation'
import type { VoiceTranscriptFragment } from '../core/voice/types'
import type { VoiceSttAdapter, VoiceTtsAdapter, WakeGate } from '../core/voice/types'
import type { BrainProjection } from '../core/brain/brain'
import type { WorkProjection } from '../core/work/projection'
import type { MissionProjection } from '../core/missions/types'
import type { WorkforceProjection, WorkforceSource } from '../core/protocol/workforce'
import type { PersonalityProjection, PersonalitySource } from '../core/protocol/personality'
import type { AttentionProjection } from '../core/protocol/attention'
import type { SkillProjection } from '../core/protocol/skills'
import type { ForgeProjection } from '../core/protocol/forge'
import type { LifeProjection } from '../core/protocol/life'
import type { WorldSummaryView } from '../core/protocol/world'
import type { ConsciousContextProjection } from '../core/protocol/consciousness'
import type { LifeLoopProjection } from '../core/protocol/lifeloop'
import type { FoundryProjection } from '../core/protocol/foundry'
import type { RelayProjection } from '../core/protocol/relay'
import type { ContextProjection, ContextProjectionView, ContextScopeRef } from '../core/protocol/context'
import type { OfficeProjection } from '../core/office/projection'
import type { RelayAdapterSet } from '../core/relay/adapters'
import type { ConnectorAuthPort } from '../core/connectors/engine'
import type { ConnectorKind } from '../core/connectors/types'
import type { ConnectorCommandOutcome, ConnectorProjection } from '../core/protocol/connectors'
import { createWindowObservationRuntime, type WindowObservationRuntime } from './context/windowObservationRuntime'
import { createIntervalTimer, type ActiveWindowProvider, type WindowSourceStatus, type WindowTimer } from '../core/context/sources/window'
import type { NanoGptEnv } from '../core/model/nanogpt-provider'
import { BraveSearchProvider } from '../core/research/providers/brave'
import { ElectronBrowserTargetFactory } from './research/managedTarget'
import { fixtureSearchProvider, fixtureTransport, researchFixturesEnabled } from './research/e2eFixtures'
import { SafeHttpTransport } from '../core/research/transport'
import type { SearchProvider } from '../core/research/types'
import type { ModelProvider } from '../core/model/provider'
import type { DeviceHandsActionKey, GrantFact } from '../core/devicehands'
import type { BrowserTargetFactory } from '../core/research/browser'
import { randomUUID } from 'node:crypto'
import {
  createDeviceHandsActivation,
  type DeviceHandsActivation,
  type DeviceHandsActivationStatus,
  type DeviceHandsAuthority,
  type DeviceHandsEffects,
  type DeviceHandsJournal,
} from './devicehands'

/**
 * The environment the host reads, main-process only.
 *
 * `BRAVE_SEARCH_API_KEY` and `FREYA_ALLOW_WEB_SEARCH` are named here so the shape
 * of what main hands Core is explicit. Neither is returned by any projection, any
 * status or any command: the provider keeps the key in a private field, and Core
 * receives a `SearchProvider` it cannot inspect.
 *
 * `FREYA_ALLOW_WEB_SEARCH` is separate from the credential on purpose. A machine
 * that happens to have a key in its environment must not start calling a paid
 * search API because the key was there. Search is enabled explicitly.
 */
export interface HostEnv extends NanoGptEnv {
  BRAVE_SEARCH_API_KEY?: string
  FREYA_ALLOW_WEB_SEARCH?: string
  /**
   * E2E gates. Main-process only, and both must be present before any research
   * fixture is used.
   *
   * Read from the environment by the host rather than passed by the renderer, so
   * that no window can switch a production build into fixture mode. They replace the
   * transport's DNS and socket seams only — the URL policy, the bounds and the
   * browser target remain the real ones.
   */
  FREYA_E2E?: string
  FREYA_E2E_RESEARCH?: string
}

/**
 * The far side of the Context seam, as the *host* sees it.
 *
 * Core reports context in its own vocabulary — `context()` answers a
 * `ContextProjectionView`, the audit-shaped projection the Context integration
 * inside Core builds — and this host transports the *window's* vocabulary, the
 * `ContextProjection` #24 declared. `ContextChannel` binds *structurally* to a
 * candidate with both halves of the mirror contract, translates what arrives
 * into the window's shape, and forwards it. A candidate that already speaks the
 * window's shape (the seam #24 documented for a Core that grows its own mirror)
 * is forwarded verbatim, because it is already the answer.
 *
 * `ContextChannel` cannot write into a Core, cannot substitute a projection,
 * and has no branch that runs when nothing binds. Electron owns no Context
 * authority here; it owns a forwarding box, a translation and a disposer.
 */
export interface ContextReportingCore {
  context(): ContextProjection | ContextProjectionView
  onContext(
    listener: (projection: ContextProjection | ContextProjectionView) => void,
  ): () => void
}

/** Whether a Core object actually is a context reporter, checked by shape. */
export function isContextReportingCore(candidate: unknown): candidate is ContextReportingCore {
  if (typeof candidate !== 'object' || candidate === null) return false
  const record = candidate as Partial<ContextReportingCore>
  return (
    typeof record.context === 'function' &&
    typeof record.onContext === 'function'
  )
}

/**
 * One projection of Core's Context truth, in the vocabulary a window reads.
 *
 * A Core reporting the window's own `ContextProjection` is already the answer
 * and is returned as it came. A Core reporting `ContextProjectionView` — the
 * shape this repository's Core actually answers — is translated field by field,
 * and the translation is where every "Core does not say" is decided:
 *
 *  - **`label` is always null.** Core's audit row carries the *length* of a
 *    label and never the label, because a file name is private in exactly the
 *    way the content is. The surface falls back to `kind`, which is Core's own
 *    word.
 *  - **`ttlSeconds` is always null.** Core reports the instant an item stops
 *    being valid; it does not report a granted lifetime, and arithmetic on two
 *    instants would be this file inventing one.
 *  - **`references` is always empty.** Core's projection holds no standing
 *    references: `context.reference.read` resolves a term inside Core and is
 *    consumed there, so "no open references" is the truth about the projection
 *    rather than a gap in it.
 *  - **scope and provenance are reported verbatim**, as ids and instants —
 *    metadata, with nothing a sentence could hide in.
 *
 * Health follows the one fact a window cannot check for itself: a Core that has
 * not built its Context integration reports zeroed limits, and one that has can
 * only report positive ones (`contextLimits` clamps into `[1, ceiling]`), so an
 * integration that is not there is `unavailable` in Core's own words rather
 * than `ready` with an empty list.
 */
export function toContextProjection(
  projection: ContextProjection | ContextProjectionView,
): ContextProjection {
  if ('health' in projection) return projection

  const view = projection
  const available = view.limits.maxItems > 0
  return {
    persistence: { ...view.persistence },
    health: available ? 'ready' : 'unavailable',
    reason: available ? null : (view.persistence.reason ?? 'Core has not reported a Context yet'),
    items: view.items.map((row) => ({
      itemId: row.contextId,
      kind: row.kind,
      label: null,
      state: row.state,
      provenance: {
        sourceClass: row.source,
        detail: row.originId,
        admittedAt: row.admittedAt,
      },
      scope: { label: row.scopeKind, detail: row.scopeId },
      expiresAt: row.expiresAt,
      ttlSeconds: null,
    })),
    references: [],
    counts: {
      items: view.counts.retained,
      current: view.counts.live,
      expired: view.counts.expired,
      revoked: view.counts.revoked,
      references: 0,
      unresolvedReferences: 0,
    },
    sequence: view.sequence,
  }
}

/**
 * The host's Context transport: a window set, one optional binding, and no
 * authority.
 *
 * Every method is a read or a subscription. `bind` is called once per Core and
 * only *follows* what that Core reports; `pull` repeats Core's last answer or
 * says there is none. There is deliberately no `emit`, no `submit` and no way
 * for a window — or this class — to introduce a context item, because an
 * Electron-side route for context to get *in* would be Electron holding Context
 * authority, which is exactly what issue #15's lane reserves for Core.
 */
export class ContextChannel {
  private core: ContextReportingCore | null = null
  private disposeCore: (() => void) | null = null
  private readonly windows = new Set<(projection: ContextProjection) => void>()

  /**
   * Follow a Core that reports context. Anything else — a Core built without
   * the Context facade — binds to nothing and is not an error.
   */
  bind(candidate: unknown): void {
    if (!isContextReportingCore(candidate)) return
    this.core = candidate
    this.disposeCore = candidate.onContext((projection) =>
      this.broadcast(toContextProjection(projection)),
    )
  }

  /**
   * Release the current Core binding, if any.
   *
   * `bind` overwrites `this.disposeCore`, so rebinding without disposing first
   * leaves the previous subscription attached to a Core that has been stopped, with
   * no reference left to remove it. Each provider reconfiguration rebinds, so this
   * is what stops that from accumulating one listener per save.
   */
  unbind(): void {
    this.disposeCore?.()
    this.disposeCore = null
    this.core = null
  }

  /** Core's last reported projection, or null when no Core is reporting. */
  pull(): ContextProjection | null {
    return this.core === null ? null : toContextProjection(this.core.context())
  }

  /**
   * Attach a window. Returns a disposer. A window attaching to a reporting
   * Core is pulled immediately, like every other channel; a window attaching
   * to one that is not is told nothing, which is the honest silence.
   */
  on(send: (projection: ContextProjection) => void): () => void {
    this.windows.add(send)
    const projection = this.pull()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Context push threw', error)
        this.windows.delete(send)
      }
    }
    return () => {
      this.windows.delete(send)
    }
  }

  /** Detach everything and unbind. A stopped host has no Context to mirror. */
  close(): void {
    this.disposeCore?.()
    this.disposeCore = null
    this.core = null
    this.windows.clear()
  }

  private broadcast(projection: ContextProjection): void {
    for (const send of [...this.windows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Context push threw', error)
        this.windows.delete(send)
      }
    }
  }
}

/**
 * The Core host.
 *
 * One Core per main process, created before any window exists and destroyed
 * only when the process ends. A renderer reload re-attaches to the same Core
 * instead of starting a second one — reloading is a renderer concern, and a
 * reload must never restart Core, replay its log, or cost a provider call.
 *
 * The renderer never sees the Core object. It sees `submit` and a status
 * subscription, both of which are already narrow.
 */

export interface CoreHost {
  /** Start the Core. Safe to await more than once. */
  start(): Promise<void>
  /**
   * Run a command from a renderer.
   *
   * There is deliberately no caller parameter. In Phase 1 the renderer is the
   * owner's UI and the only thing that can reach this host, so the only identity
   * worth passing is the one the host already assumes. Adding a caller argument
   * now would create a field a future module could populate with a forged value,
   * which is worse than having no field at all. When a second kind of caller
   * exists, this host becomes the place that decides which one it is.
   */
  submit(envelope: CoreCommandEnvelope): Promise<CoreCommandResult>
  /**
   * Attach a window. Returns a disposer. The host pushes the current status
   * immediately, so a renderer that has just reloaded knows where it stands
   * without asking.
   */
  attach(send: (status: CoreStatus) => void): () => void
  /**
   * Attach to the activity feed. Returns a disposer.
   *
   * Narrow on purpose: a window gets display-ready rows, not the event fabric.
   * There is no channel here that could carry a payload, so no future event can
   * leak its contents into a window through this door.
   */
  onActivity(send: (activity: CoreActivityEvent[]) => void): () => void
  activity(): CoreActivityEvent[]
  status(): CoreStatus
  /** Attach to the conversation projection. Returns a disposer. */
onConversation(send: (projection: ConversationProjection) => void): () => void
  onVoice(send: (projection: VoiceProjection) => void): () => void
  onVoiceTranscript(send: (fragment: VoiceTranscriptFragment) => void): () => void
  conversation(): Promise<ConversationProjection | null>
  voice(): VoiceProjection | null
  /**
   * Attach to the Brain projection. Returns a disposer.
   *
   * Its own channel, not another field on the status. The Brain is where Freya's
   * long-term knowledge lives; shipping it inside a security projection would put
   * it wherever status is cached, logged or forwarded.
   */
  onBrain(send: (projection: BrainProjection) => void): () => void
  brain(): BrainProjection | null
  /**
   * Attach to the Work projection. Returns a disposer.
   *
   * Its own channel for the reason the Brain has one, and here the payload is
   * *live execution state*: which capability is running, which run is waiting on a
   * person. Shipping that inside a security status would put it wherever status is
   * cached, logged or forwarded, and a security projection is exactly the wrong
   * place for something that changes several times a second.
   */
  onWork(send: (projection: WorkProjection) => void): () => void
  work(): WorkProjection | null
  onMission(send: (projection: MissionProjection) => void): () => void
  mission(): MissionProjection | null
  /**
   * Attach to the Workforce projection. Returns a disposer.
   *
   * Its own channel, as every subsystem has, and the same bargain: what a
   * window needs in order to render crosses, and nothing that protects or
   * decides workforce state crosses at all. No source, no authority object, no
   * rule, no worker credential — the host can read a projection and forward it,
   * which is the entire of what it knows how to do with a workforce.
   */
  onWorkforce(send: (projection: WorkforceProjection) => void): () => void
  workforce(): WorkforceProjection | null
  /**
   * Attach to the Context projection, as Core last reported it.
   *
   * Its own channel like every subsystem's, and the note that matters is about
   * what is *not* here: the host has no way to write a context item, no source
   * to hand to Core, and no projection of its own to substitute. A Core that
   * reports no context leaves `context()` answering `null` and this channel a
   * closed door with a disposer; a Core that does report one is followed, and
   * what it says arrives translated into the window's vocabulary. Forwarding
   * what Core says is the entire of what the host knows how to do with context.
   */
  onContext(send: (projection: ContextProjection) => void): () => void
  context(): ContextProjection | null
  /**
   * Attach to the Personality projection. Returns a disposer.
   *
   * Its own channel like every subsystem's, and the note that matters is what
   * is *not* here: the host cannot record a preference, admit a habit, file an
   * inside joke, choose a cue or report a confidence. It reads a projection and
   * forwards it. What a window receives is Core's report of relationship
   * *metadata* — never the recorded text, never a key, never a path — and this
   * host is a forwarding box on the way to that, not a second author of it.
   */
  onPersonality(send: (projection: PersonalityProjection) => void): () => void
  personality(): PersonalityProjection | null
  /**
   * Attach to the Attention projection. Returns a disposer.
   *
   * Its own channel like every subsystem's, and the note that matters is what is
   * *not* here: the host cannot decide, escalate, spend a budget, bypass a cooldown,
   * schedule anything or read an event's text. It reads a projection and forwards
   * it. What a window receives is Core's report — counts, the focus reading, closed
   * labels and at most one cue — and this host is a forwarding box, not a second
   * author of any of it.
   */
  onAttention(send: (projection: AttentionProjection) => void): () => void
  attention(): AttentionProjection | null
  onFoundry(send: (projection: FoundryProjection) => void): () => void
  foundry(): FoundryProjection | null

  /**
   * Attach to the Skills projection. Returns a disposer.
   * Core pushes; the window receives a read-only mirror.
   */
  onSkills(send: (projection: SkillProjection) => void): () => void
  skills(): SkillProjection | null
  /**
   * Attach to the Forge projection. Returns a disposer.
   *
   * A projection mirror and nothing else: no authority, no engine handle and no
   * method that takes an instruction. Mutating Forge work goes through Core's own
   *  orge.* commands, behind Guard.
   */
  onForge(send: (projection: ForgeProjection) => void): () => void
  forge(): ForgeProjection | null
  /**
   * Attach to the Life History projection. Returns a disposer.
   *
   * Its own channel like every other subsystem's, and the note that matters is
   * what is *not* here: the host cannot record, revise, consolidate or withdraw
   * an entry, cannot raise a confidence, cannot set a derivation class and
   * cannot reach a model. It reads a projection and forwards it. What a window
   * receives is Core's report — ids, closed labels, dates, statuses, measured
   * lengths and conflict edges — and this host is a forwarding box, not a
   * second author of any of it.
   */
  onLife(send: (projection: LifeProjection) => void): () => void
  life(): LifeProjection | null
  /**
   * The World & self summary, pushed immediately.
   *
   * The *summary* and not the graph: a standing push of every node and edge of the
   * owner's world would hand a window the whole map without it asking. The graph is
   * there, read on demand and bounded, through `world.relations.read`.
   */
  onWorld(send: (projection: WorldSummaryView) => void): () => void
  world(): WorldSummaryView | null
  /**
   * Attach to the unified conscious context, pushed immediately.
   *
   * A read and a follow, like every other lane here and nothing more: there is no
   * `consciousness.set`, no `consciousness.refresh`, and no method on this class
   * that rebuilds, corrects or requests a snapshot on a window's say-so. A
   * surface that wanted a fresher picture than Core last pushed would need a
   * command Core does not have.
   */
  onConsciousness(send: (projection: ConsciousContextProjection) => void): () => void
  /**
   * The unified conscious context, or `null` before Core has started.
   *
   * `null` rather than the frozen absent snapshot, following the same rule as
   * every other pull on this class: a host with nothing to report says nothing,
   * and the renderer turns `null` into the protocol's own absent value. A Core
   * that *is* running returns a snapshot whose sections say which subsystems are
   * missing, so the two absences stay distinguishable all the way to the surface.
   */
consciousness(): ConsciousContextProjection | null
  /**
   * Attach to the Continuous Life Loop, pushed immediately. Returns a disposer.
   *
   * A forwarding box and nothing more. There is no `lifeLoopTick`, no
   * `lifeLoopWake` and no `lifeLoopStop` on this interface, and that omission is
   * the security property: the host can read where the loop is, and cannot make it
   * wake, make it think, spend on it, lift a stop or shorten a deadline. The
   * heartbeat the loop rides is the *existing* attention tick above, so there is
   * also no second timer for a window or a plugin to schedule.
   */
  onLifeLoop(send: (projection: LifeLoopProjection) => void): () => void
  /** Null before the Core has started. Never a manufactured idle loop. */
  lifeLoop(): LifeLoopProjection | null
  /**
   * Attach to the Office projection. Returns a disposer.
   *
   * Its own channel like every subsystem's, and the note that matters is what
   * is *not* here: the host cannot invent a station, inflate a count or
   * fabricate a percentage. It reads a projection and forwards it. What a
   * window receives is Core's report — Freya's station, live run stations,
   * worker stations, approval stations and the history timeline — and this
   * host is a forwarding box, not a second author of any of it.
   */
  onOffice(send: (projection: OfficeProjection) => void): () => void
  office(): OfficeProjection | null
  /**
   * Evaluate due attention schedules. The bounded wake, driven by the composition
   * root. Performs no model call and no provider contact; it only fires schedules
   * already due whose condition holds against state Core already has.
   */
  attentionTick(): Promise<number>
  /**
   * Attach to the Relay projection. Returns a disposer.
   *
   * Its own channel like every subsystem's, and the note that matters is what
   * is *not* here: the host cannot register a connector, fault one, set an
   * allowlist, execute an action or decide an approval. It reads a projection
   * and forwards it. What a window receives is Core's report ??? which
   * connectors exist, which actions are pending, what settled ??? and this host
   * is a forwarding box, not a second author of any of it.
   */
  onRelay(send: (projection: RelayProjection) => void): () => void
  relay(): RelayProjection | null
  /**
   * Attach to the connector projection. Returns a disposer.
   *
   * The host is a forwarding box here too: it cannot configure a connector,
   * start an authorization, complete one or deliver an event. It reads Core's
   * report and forwards it.
   */
  onConnectors(send: (projection: ConnectorProjection) => void): () => void
  connectors(): ConnectorProjection | null
  /**
   * Complete an authorization. **Host-only; never exposed to a renderer.**
   *
   * The OAuth callback is handled in the main process, which holds the token in
   * the secure store; this records the non-secret outcome in Core.
   */
  connectorAuthorizationComplete(payload: unknown): Promise<ConnectorCommandOutcome>
  /** Deliver an authenticated external event. **Host-only.** */
  connectorEventIngest(payload: unknown): Promise<ConnectorCommandOutcome>
  stop(reason?: string): Promise<void>
}

/**
 * The Phase 42 Device Hands seam.
 *
 * This is the whole of what the host must supply to switch Phase 35 on: the real
 * effect adapters, a durable journal, and an authority Core policy already backs
 * (STOP ALL, the owner switch, the grants and the owner's approvals). The host does
 * not mint any of them here — Core's STOP ALL latch is composed in on top of whatever
 * the authority reports, so the latch always wins.
 *
 * `enabled` defaults to false. A host that supplies the seam and forgets to opt in
 * gets an opened, policy-loaded, grant-registered runtime that refuses every action at
 * its own `enabled` gate — which is the fail-closed reading, not a broken one.
 */
export interface DeviceHandsHostOptions {
  readonly effects: DeviceHandsEffects
  readonly journal: DeviceHandsJournal
  readonly authority: DeviceHandsAuthority
  /** The surface policy. Must name the Vault and keyring roots among its denied roots. */
  readonly policy?: unknown
  /**
   * Grants Core policy already authorized. Registered here, never minted here.
   *
   * Typed rather than `unknown[]` because the host reads `revokedAt` and `scope` off
   * these to report runtime facts, and an untyped array silently becomes `unknown` at
   * every use — which is how a revoked grant would end up counted as a live one.
   */
  readonly grants?: readonly GrantFact[]
  /** Whether to switch the phase on at start. Default false. */
  readonly enabled?: boolean
  /** Development profile: no grant/approval/allowlist friction, but no deletion. */
  readonly localUnrestricted?: boolean
  /** Whether a journal that does not chain refuses to open. Default true. */
  readonly requireTrustworthyJournal?: boolean
}

export interface CoreHostOptions {
  /**
   * The conversation master key, from the OS secure storage.
   *
   * Injected rather than constructed here so that the host is testable without
   * Electron's credential store, and so that "no key" is a real, reachable state
   * rather than a branch nobody exercises. Null means Core falls back to an
   * ephemeral conversation store and says so.
   */
  conversationKey?: Uint8Array | null
  /**
   * Explicit host-side conversation store override.
   *
   * Used by tests/embedding and by the Linux Electron E2E harness when the
   * repository's Windows-only SQLCipher native binding is unavailable. Never
   * exposed to a renderer. Production Windows leaves this undefined and Core
   * selects the canonical Vault-backed conversation store.
   */
  conversationStore?: CoreOptions['conversationStore']
  /**
   * The Brain's own key, from the keyring.
   *
   * A **separate secret**, not a derivation of the conversation key: compromising
   * conversation history must not yield the Brain, and vice versa. See
   * `electron/keyring.ts` for why the isolation is worth two secrets to protect.
   * Null means the Brain falls back to ephemeral and reports `durable: false`.
   */
  brainKey?: Uint8Array | null
  /**
   * Missions' own key, from the keyring.
   *
   * A **third** independent secret, for the same reason as the other two: what a
   * person asked Freya to accomplish is theirs, and recovering the conversation key
   * must not yield it. See `electron/keyring.ts` for why the isolation is worth a
   * secret per domain. Null means Missions fall back to an ephemeral store and
   * report `durable: false` rather than implying a persistence they do not have.
   */
  missionKey?: Uint8Array | null
  contextKey?: Uint8Array | null
  /**
   * Personality's own key, from the keyring.
   *
   * An independent secret for the same reason as the other four: what
   * Freya has recorded about a person should not be one key-compromise away from
   * the conversation log, and recovering another domain's key must not yield it.
   * Null means Core falls back to an ephemeral relationship, reports
   * `durable: false` in the projection, and — because anti-repetition depends on
   * remembering what was offered — serves no expression guidance at all rather
   * than resetting its memory.
   */
  personalityKey?: Uint8Array | null
  /** Skills' independent encrypted persistence key. */
  skillKey?: Uint8Array | null
  /**
   * Forge's independent encrypted persistence key, from the keyring.
   *
   * A separate key from every other domain on purpose: a Forge package body is a
   * program Freya can run, and a store that could be opened with the Skill key could
   * be moved between domains by anyone holding either one. Null means Core falls
   * back to process-only storage and *reports* durable: false � never plaintext.
   */
  forgeKey?: Uint8Array | null
  /** Canonical Core-private SQLCipher Vault. Never accepted from a renderer. */
  vault?: CoreOptions['vault']
  /** Explicit main-process opt-in; never accepted from a renderer. */
  windowObservation?: {
    enabled: boolean
    provider: ActiveWindowProvider
    scope: ContextScopeRef
    timer?: WindowTimer | null
  }
  /**
   * The developer echo provider, when one was explicitly asked for.
   *
   * Forwarded verbatim to Core, which is the only place that decides what a
   * provider is. The host does not construct one.
   */
  developerProvider?: 'echo' | 'slow-echo'
  /**
   * Replaces the entire provider set. For tests.
   *
   * Whole-set rather than additive, so a run cannot accidentally reach a real
   * provider. Production passes none of this.
   */
  providers?: ModelProvider[]
  /**
   * The desktop speech output adapter, forwarded straight into Core.
   *
   * Note the asymmetry with speech *input*: production passes this and passes no
   * `voiceStt`, because the platform gives us a speech engine and does not give
   * us a local recogniser. That is not a gap to be papered over with a hosted
   * service — it is the honest state of this build, and Core reports it as
   * `configuration-required` and discards recordings rather than sending them.
   */
  voiceTts?: VoiceTtsAdapter
  /** A speech-to-text adapter. Unset in production; see `voiceTts`. */
  voiceStt?: VoiceSttAdapter
  /** A local wake gate. Unset in production, so hands-free cannot be armed. */
  voiceWake?: WakeGate
  /** Whether the platform offers a capture path at all. */
  voiceCaptureSupported?: boolean
  /**
   * Replaces the production research stack wholesale. For tests.
   *
   * Whole-stack rather than per-part, so a test cannot accidentally exercise the
   * real Brave provider or the real Electron target while believing it is offline.
   */
  research?: { searchProvider: SearchProvider; browserFactory: BrowserTargetFactory }
  /**
   * Fills Core's Workforce seam. For assembly and tests; production passes
   * none, and the host does not build one.
   *
   * Forwarded *into* Core and nowhere else. This is not Electron deciding who
   * is on a team or what a worker may do — it cannot, because the type it
   * forwards is something Core can read, not something that takes an
   * instruction. Workforce authority lives in Core (issue #10); the host's job
   * is to hand over a reader and then mirror what comes back.
   */
  workforceSource?: WorkforceSource
  /**
   * Fills Core's Personality seam. For assembly and tests; production passes
   * none, and the host does not build one.
   *
   * Forwarded *into* Core and nowhere else, exactly like `workforceSource`.
   * This is not Electron deciding what Freya knows about the person — it
   * cannot, because the type it forwards answers a question rather than takes
   * an instruction. Relationship authority lives in Core, in the Phase 11
   * personality domain; the host's job is to hand over a reader and then mirror
   * what comes back.
   */
  personalitySource?: PersonalitySource
  /**
   * Whether Core wires its own subsystems into attention as event sources.
   *
   * On by default in the production host, so a finished Run or Mission becomes an
   * attention event. Tests of other subsystems construct Core directly and leave
   * this off, so their journals are not perturbed.
   */
  attentionObserveSources?: boolean
  /**
   * Fills Core's Relay seam. For assembly and tests; production passes none,
   * and the host does not build one.
   *
   * Forwarded *into* Core and nowhere else, exactly like `workforceSource`.
   * This is not Electron deciding which connectors exist ??? it cannot,
   * because the option it forwards is something Core can read, not something
   * that takes an instruction. Relay authority lives in Core; the host's job
   * is to hand over the adapters it was given and then mirror what Core
   * reports.
   */
  relay?: {
    adapters: RelayAdapterSet
    allowlistedRepos?: readonly string[]
  }
  /**
   * The Phase 44 connector connection plane.
   *
   * Forwarded into Core; tokens remain in the host secure store and never cross
   * the renderer bridge.
   */
  connectors?: {
    auth: ConnectorAuthPort
    blocked?: readonly ConnectorKind[]
  }
  /**
   * Lazy production connector runtime, constructed in the main process where
   * Electron secure storage is available.
   */
  connectorRuntime?: () => Promise<{ auth: ConnectorAuthPort; blocked?: readonly ConnectorKind[] }>
  /**
   * The Phase 42 Device Hands activation seam. Absent — the state of every build
   * until the owner supplies real adapters and an authority — the runtime is never
   * constructed, and no surface exists to reach.
   */
  deviceHands?: DeviceHandsHostOptions
}

export class ElectronCoreHost implements CoreHost {
  private core: Core | null = null
  private starting: Promise<void> | null = null
  private stopRequested = false
  private readonly windows = new Set<(status: CoreStatus) => void>()
  private readonly activityWindows = new Set<(activity: CoreActivityEvent[]) => void>()
  private readonly conversationWindows = new Set<(projection: ConversationProjection) => void>()
  private readonly voiceWindows = new Set<(projection: VoiceProjection) => void>()
  private readonly voiceTranscriptWindows = new Set<(fragment: VoiceTranscriptFragment) => void>()
  private readonly brainWindows = new Set<(projection: BrainProjection) => void>()
  private readonly workWindows = new Set<(projection: WorkProjection) => void>()
  private readonly missionWindows = new Set<(projection: MissionProjection) => void>()
  private readonly workforceWindows = new Set<(projection: WorkforceProjection) => void>()
  private readonly personalityWindows = new Set<(projection: PersonalityProjection) => void>()
  private readonly attentionWindows = new Set<(projection: AttentionProjection) => void>()
  private readonly skillWindows = new Set<(projection: SkillProjection) => void>()
  private readonly lifeWindows = new Set<(projection: LifeProjection) => void>()
  private readonly worldWindows = new Set<(projection: WorldSummaryView) => void>()
  private readonly foundryWindows = new Set<(projection: FoundryProjection) => void>()
  /** Windows following the Forge projection. Cleared when a window goes away. */
  private readonly forgeWindows = new Set<(projection: ForgeProjection) => void>()
  private readonly officeWindows = new Set<(projection: OfficeProjection) => void>()
  private readonly relayWindows = new Set<(projection: RelayProjection) => void>()
  private readonly connectorWindows = new Set<(projection: ConnectorProjection) => void>()
  /**
   * Windows following the unified conscious context.
   *
   * Its own set rather than a reuse of an existing one, so detaching this lane
   * cannot detach a board or an office floor by accident - the subsystems it
   * reads keep their own subscribers, and this one carries a snapshot.
   */
  private readonly consciousnessWindows = new Set<
    (projection: ConsciousContextProjection) => void
  >()
  /**
   * Windows watching the Continuous Life Loop.
   *
   * A notification list like every other one here, and equally unable to become a
   * second source of truth: it carries a projection Core built, and a window holds
   * what it was last sent. Nothing in this set can write a field, wake the loop,
   * spend on it, lift a stop or shorten a deadline — the lane has no write verb at
   * all, which is the property rather than an omission.
   */
  private readonly lifeLoopWindows = new Set<(projection: LifeLoopProjection) => void>()
  /**
   * The Context transport box. Binds structurally to a reporting Core, holds a
   * window set, and can write nothing — see `ContextChannel`. Deliberately not
   * a field on Core's construction arguments: Core builds its own Context
   * integration and takes no context source from the host.
   */
  private readonly contextChannel = new ContextChannel()
  private windowObservation: WindowObservationRuntime | null = null
  private observedContextId: string | null = null
  private windowLane: ReturnType<Core['contextWindowLane']> | null = null
  /**
   * The in-flight provider rebuild, if any.
   *
   * Non-null means a rebuild is running. Saves that arrive while it runs update
   * {@link pendingReconfig} instead of queueing another rebuild, which is what makes
   * a burst of saves cost a bounded number of Core restarts rather than one each.
   */
  private reconfiguring: Promise<void> | null = null
  /** The newest environment a rebuild has not yet been started for. */
  private pendingReconfig: HostEnv | null = null
  /**
   * The Phase 42 Device Hands activation, or null when the seam was not supplied.
   *
   * Built and torn down with the Core, because its authority reads Core's own STOP ALL
   * latch: an activation that outlived the Core it reads would be reading a stopped
   * latch forever, which is safe but useless, and one built before the Core would have
   * nothing to read.
   */
  private deviceHands: DeviceHandsActivation | null = null

  constructor(
    private readonly dataPath: string,
    private env: HostEnv = {},
    private readonly options: CoreHostOptions = {},
  ) {}

  /**
   * Stop the running Core, swap the environment it is built from, and start again.
   *
   * Used when the provider configuration changes: the credential and the model
   * live in the environment Core reads at construction, so a live rebuild is the
   * only way a saved setting takes effect without a relaunch. The window set is
   * deliberately *not* cleared — unlike `stop()`, this is a Core swap, not a host
   * teardown, and every attached renderer must keep receiving status from the
   * replacement Core without re-attaching. The env is main-process memory only;
   * no renderer can name or supply it.
   *
   * ## Why this is a queue and not a direct swap
   *
   * Four things were wrong with the obvious implementation, and each one is a way
   * for a saved setting to silently not apply — or for the process to be left in a
   * state where it never will:
   *
   *   1. **It reused a stale startup.** `start()` returns `this.starting` when a
   *      start is in flight, and that promise was built with the *old* env. A save
   *      arriving during boot therefore set `this.env` and then awaited a Core
   *      constructed from the previous value, so the setting did nothing until the
   *      next relaunch. This now waits for any in-flight start to settle first.
   *   2. **It leaked a window observer.** `stop()` stops `windowObservation` and
   *      revokes the observed lane; this did neither, and `start()` then built a
   *      second poller. With observation enabled, every save left another watcher
   *      running and admitting against a stopped Core.
   *   3. **It leaked a Context subscription.** `ContextChannel.bind` overwrote its
   *      own disposer, so each rebind added a listener and dropped the reference
   *      needed to remove the previous one.
   *   4. **It was unbounded.** Every save stopped and rebuilt Core — cancelling
   *      in-flight turns and appending `core.stopping`/`core.stopped` — so a burst
   *      of saves was a way to keep Freya permanently mid-restart.
   *
   * Saves are now serialised, and a burst collapses: while one rebuild is in
   * flight, further saves only update the environment that the *next* rebuild will
   * use, so ten rapid saves cost at most two Core restarts.
   */
  async restartWithEnv(env: HostEnv): Promise<void> {
    this.pendingReconfig = env
    // Already rebuilding: the running loop will pick the newest environment up, so
    // this caller waits for the rebuild that carries its change rather than
    // starting a second one.
    if (this.reconfiguring !== null) return this.reconfiguring
    this.reconfiguring = this.drainReconfigs().finally(() => {
      this.reconfiguring = null
    })
    return this.reconfiguring
  }

  /** Run rebuilds until no newer environment is waiting. Never runs two at once. */
  private async drainReconfigs(): Promise<void> {
    while (this.pendingReconfig !== null) {
      const env = this.pendingReconfig
      this.pendingReconfig = null
      await this.reconfigure(env)
    }
  }

  private async reconfigure(env: HostEnv): Promise<void> {
    // (1) Let any startup finish before judging what is running, so a save during
    // boot cannot be satisfied by a Core built from the previous environment.
    try {
      await this.starting
    } catch {
      // The start caller receives its own failure; there is simply nothing to wait
      // for here, and the rebuild below is what gets the chance to succeed.
    }

    const previous = this.env
    const core = this.core
    this.core = null
    try {
      if (core !== null) await core.stop('provider configuration changed')
    } catch (error) {
      // A Core that will not stop cleanly must not be left referenced, and must not
      // be silently replaced either — fall through to the recovery attempt below.
      console.error('[freya] the core did not stop cleanly for a provider change', error)
    }

    // (2) Tear down everything that is bound to the Core being replaced, *before* a
    // replacement is built. Doing this after `start()` is what produced two
    // pollers and an orphaned Context listener per save.
    //
    // The attached window set is deliberately NOT cleared. That is the difference
    // between this and `stop()`: an attached window must keep receiving status from
    // the replacement Core without re-attaching, because the renderer cannot know a
    // swap happened. Clearing it here would leave every open surface showing a Core
    // that had gone away, and a renderer reload is not something to require here.
    this.releaseWindowObservation()
    this.contextChannel.unbind()
    this.releaseDeviceHands()
    this.env = env
    this.stopRequested = false
    // The settled startup promise would be returned by `start()` unchanged, so it is
    // cleared and a fresh one is built from the environment set above.
    this.starting = null

    try {
      await this.start()
    } catch (error) {
      /**
       * Leave a recoverable state rather than a dead one.
       *
       * A provider setting that cannot be applied should not leave the application
       * unable to start at all. The previous environment is restored and started so
       * there is a working Core to talk to, and the original failure is still thrown
       * so the surface that asked for the save learns it did not take effect.
       */
      console.error('[freya] the core could not be rebuilt with the new provider configuration', error)
      this.env = previous
      this.stopRequested = false
      this.starting = null
      await this.start().catch((recoveryError: unknown) => {
        console.error('[freya] the core could not be restored after a failed provider change', recoveryError)
      })
      throw error
    }
  }

  /**
   * Stop the window observer and release the lane it was admitted through.
   *
   * Shared by `stop()` and `reconfigure()` so the two teardown paths cannot drift —
   * which is exactly how the second path came to leak the first one's resources.
   */
  private releaseWindowObservation(): void {
    this.windowObservation?.stop()
    if (this.observedContextId) {
      this.windowLane?.revoke(this.observedContextId, 'window observation released')
    }
    this.windowObservation = null
    this.windowLane = null
    this.observedContextId = null
  }

  /**
   * Build the Phase 42 activation, if the seam was supplied, and switch it on only
   * when the owner explicitly asked.
   *
   * The authority's `stopAllActive` is composed with Core's own latch rather than
   * replacing it: Core's STOP ALL always wins, whatever the supplied authority says.
   * That is the one precedence rule this wiring must not be able to get wrong.
   */
  private async startDeviceHands(): Promise<void> {
    const seam = this.options.deviceHands
    if (seam === undefined) return
    const authority: DeviceHandsAuthority = {
      ...seam.authority,
      stopAllActive: () => (this.core?.status().stopAll.active ?? false) || seam.authority.stopAllActive(),
    }
    const activation = createDeviceHandsActivation({
      effects: seam.effects,
      journal: seam.journal,
      authority,
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      localUnrestricted: seam.localUnrestricted === true,
      ...(seam.requireTrustworthyJournal === undefined
        ? {}
        : { requireTrustworthyJournal: seam.requireTrustworthyJournal }),
    })
    await activation.open()
    if (seam.enabled === true && seam.policy !== undefined) {
      const result = await activation.activate({ policy: seam.policy, grants: seam.grants ?? [] })
      if (!result.ok) {
        // A seam that could not be activated is left open but off: every action is
        // refused at its own gates, which is the safe direction.
        console.error(`[freya] device hands did not activate: ${result.reason}`)
      }
    }
    this.deviceHands = activation
  }

  /** Deactivate and release the Device Hands activation, if one was built. */
  private releaseDeviceHands(): void {
    const activation = this.deviceHands
    this.deviceHands = null
    if (activation !== null) void activation.dispose()
  }

  /** The activation's own status, or null when the seam was not supplied. */
  deviceHandsStatus(): DeviceHandsActivationStatus | null {
    return this.deviceHands?.status() ?? null
  }

  /**
   * Run one Device Hands action on the activation this host owns.
   *
   * **This is the seam Phase 51 needed and the reason it needed one.** The dual-browser runtime
   * and the Phase 43 extension bridge are two doors onto the browser surface, and the only way
   * to keep them two doors rather than two authorities is for both of them to reach *this*
   * runtime — the one whose authority already composes Core's STOP ALL latch. So the host
   * exposes the perform call and nothing else: no grant source, no policy, no approval
   * channel, no way to reach a gate without walking it.
   */
  async performDeviceHandsAction(request: {
    readonly actionId: string
    readonly principalId: string
    readonly scope: string
    readonly actionKey: DeviceHandsActionKey
    readonly input: Readonly<Record<string, unknown>>
    readonly at: string
    readonly deadlineAt: string
  }): Promise<{
    readonly performed: boolean
    readonly verdict: 'passed' | 'failed' | 'unverified'
    readonly code: string | null
    readonly reason: string
  }> {
    const activation = this.deviceHands
    if (activation === null || !activation.active()) {
      return {
        performed: false,
        verdict: 'failed',
        code: 'subsystem-disabled',
        reason: 'Device Hands is not active in this build, so no browser action is authorised.',
      }
    }
    const outcome = await activation.runtime.perform({
      ...request,
      claimsAction: null,
    })
    return {
      performed: outcome.performed,
      verdict: outcome.verdict ?? 'failed',
      code: outcome.code,
      reason: outcome.reason,
    }
  }

  /**
   * The hash-chained journal Device Hands is already writing, or null when there is none.
   *
   * Exposed so the Phase 51 activation appends to the **same file** rather than opening a
   * second one. Two journals would mean two integrity chains and a restart that believed one of
   * them could be in a state the other contradicted.
   */
  deviceHandsJournal(): DeviceHandsJournal | null {
    return this.options.deviceHands?.journal ?? null
  }

  async start(): Promise<void> {
    if (this.core) return
    if (this.starting) return this.starting
    this.stopRequested = false
    this.starting = (async () => {
      const research = this.options.research ?? this.buildResearchStack()
      const connectors = this.options.connectors ?? (this.options.connectorRuntime ? await this.options.connectorRuntime() : undefined)
      const core = createCore({
        dataPath: this.dataPath,
        env: this.env,
        ...(research ? { research } : {}),
        // Bytes in, and nowhere else. Core does not persist it, journal it, log it
        // or put it in a projection, so there is nothing for it to leak through.
        ...(this.options.conversationKey
          ? { conversationKey: this.options.conversationKey }
          : {}),
        ...(this.options.conversationStore
          ? { conversationStore: this.options.conversationStore }
          : {}),
        ...(this.options.brainKey ? { brainKey: this.options.brainKey } : {}),
        ...(this.options.missionKey ? { missionKey: this.options.missionKey } : {}),
        contextKey: this.options.contextKey ?? null,
        personalityKey: this.options.personalityKey ?? null,
        skillKey: this.options.skillKey ?? null,
        ...(this.options.vault ? { vault: this.options.vault } : {}),
        // Declare what the host wired but does not route through Core, so the Phase 40
        // runtime registry reports Device Hands as present rather than permanently
        // blocked. Facts only — Core records them and Core cannot act on them.
        ...(this.options.deviceHands !== undefined
          ? {
              runtimeFacts: {
                hostAdapters: ['device-hands'],
                // Only unrevoked grants the owner authored. A revoked grant is not a
                // fact about what is currently permitted.
                capabilityGrants: (this.options.deviceHands.grants ?? [])
                  .filter((grant) => grant.revokedAt === null)
                  .map((grant) => grant.scope),
              },
            }
          : {}),
        // The Workforce seam, forwarded whole. Nothing is derived from it here:
        // the host neither reads nor interprets a workforce, it only hands Core
        // the reader it was given and mirrors what Core reports.
        ...(this.options.workforceSource
          ? { workforceSource: this.options.workforceSource }
          : {}),
        // The Personality seam, forwarded whole for the same reason. It is a
        // reader, not a door: the option reaches Core, not a window, and a
        // renderer has no name for it — so nothing a window can send arrives
        // here, and the only thing that travels back out is what Core reports.
        ...(this.options.personalitySource
          ? { personalitySource: this.options.personalitySource }
          : {}),
        // Attention's internal sources are composition, not authority: the engine
        // still decides, and a delivered event cannot mint a capability or reach a
        // model. On in production so a finished Run or Mission becomes attention.
        attentionObserveSources: this.options.attentionObserveSources ?? true,
        // And the life loop's own wake sources, on the same reasoning and the same
        // default: composition, not authority. A terminal Run or Mission reaches the
        // loop the same way it reaches Attention, the registry still decides whether
        // the wake is authorized, and the prefilter still decides whether it is worth
        // a model call. Nothing here can mint a capability or widen a bound — the
        // loop's only route to a provider is a grant the owner created.
        lifeLoop: {
          observeSubsystemEvents: this.options.attentionObserveSources ?? true,
        },
        // The Relay seam, forwarded whole for the same reason. It is a set of
        // adapters, not a door: the option reaches Core, not a window, and a
        // renderer has no name for it ??? so nothing a window can send arrives
        // here, and the only thing that travels back out is what Core reports.
        ...(this.options.relay ? { relay: this.options.relay } : {}),
        // The connector connection plane, forwarded whole for the same reason as
        // Relay: it reaches Core, not a window, and the only thing that travels
        // back out is what Core reports.
        ...(connectors ? { connectors } : {}),
        ...(this.options.developerProvider
          ? { developerProvider: this.options.developerProvider }
          : {}),
        // The *entire* provider set when one is supplied, forwarded verbatim so a
        // test can never exercise the real provider while believing it is offline.
        ...(this.options.providers ? { providers: this.options.providers } : {}),
        // Speech output, forwarded whole for the same reason as every other seam
        // above: the adapter reaches Core, not a window, and there is no renderer
        // name for it. A window never sends text to be spoken — Core reads the words
        // out of its own conversation store and this adapter forwards them to the
        // platform. Deliberately absent: a speech *input* adapter. This host supplies
        // none, so Core reports transcription as `configuration-required` and
        // discards recordings rather than reaching anywhere for a recogniser.
        ...(this.options.voiceTts ? { voiceTts: this.options.voiceTts } : {}),
        ...(this.options.voiceStt ? { voiceStt: this.options.voiceStt } : {}),
        ...(this.options.voiceWake ? { voiceWake: this.options.voiceWake } : {}),
        ...(this.options.voiceCaptureSupported === undefined
          ? {}
          : { voiceCaptureSupported: this.options.voiceCaptureSupported }),
      })
      await core.start()
      if (this.stopRequested) {
        await core.stop('host stopped during startup')
        return
      }
      this.core = core
      // Any window attached later still gets every subsequent change.
      core.subscribe((status) => this.broadcast(status))
      core.onActivity((activity) => this.broadcastActivity(activity))
      core.onConversation((projection) => this.broadcastConversation(projection))
      // Voice, two channels. The projection is state and goes to every attached
      // window; transcript fragments are words in flight and are forwarded to
      // whoever is listening, with Core doing the deciding about what they are.
      core.onVoice((projection) => this.broadcastVoice(projection))
      core.onVoiceTranscript((fragment) => this.broadcastVoiceTranscript(fragment))
      core.onBrain((projection) => this.broadcastBrain(projection))
      core.onWork((projection) => this.broadcastWork(projection))
      core.onMission((projection) => this.broadcastMission(projection))
      core.onWorkforce((projection) => this.broadcastWorkforce(projection))
      core.onPersonality((projection) => this.broadcastPersonality(projection))
      core.onAttention((projection) => this.broadcastAttention(projection))
      core.onFoundry((projection) => this.broadcastFoundry(projection))
      core.onOffice((projection) => this.broadcastOffice(projection))
      core.onRelay((projection) => this.broadcastRelay(projection))
      core.onConnectors((projection) => this.broadcastConnectors(projection))
      core.onSkills((projection) => this.broadcastSkills(projection))
      core.onForge((projection) => this.broadcastForge(projection))
      core.onLife((projection) => this.broadcastLife(projection))
      core.onWorld((projection) => this.broadcastWorld(projection))
      core.onConsciousness((projection) => this.broadcastConsciousness(projection))
    core.onLifeLoop((projection) => this.broadcastLifeLoop(projection))
      // The Context channel, bound by shape rather than by name: a Core that
      // reports `context()`/`onContext()` is followed and translated into the
      // window's vocabulary, with no edit here and no authority moved into
      // Electron. A Core that reports nothing still binds to nothing.
      this.contextChannel.bind(core)
      const observation = this.options.windowObservation
      if (observation?.enabled) {
        this.windowLane = core.contextWindowLane(observation.scope)
        this.windowObservation = createWindowObservationRuntime({
          ...observation,
          timer: observation.timer === undefined ? createIntervalTimer() : observation.timer,
          lane: this.windowLane,
          onAdmission: (outcome) => {
            if ('contextId' in outcome && outcome.ok) this.observedContextId = outcome.contextId ?? null
          },
        })
        this.windowObservation.start()
      }
      await this.startDeviceHands()
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * The production research stack: Brave from main's environment, and the real
   * managed Electron DOM target.
   *
   * Both transports are constructed here, in the main process. Core receives two
   * small interfaces and cannot construct a provider, read an environment variable
   * or reach the filesystem, so there is no path from a model or a page to a
   * credential even indirectly.
   */
  private buildResearchStack(): { searchProvider: SearchProvider; browserFactory: BrowserTargetFactory } {
    // The offline fixture path, behind two independent gate variables, replaces the
    // transport's DNS and socket seams only. The URL policy, the byte bounds, the
    // redirect handling and the browser target are all the real ones, so the E2E is
    // testing the production code path and not a parallel implementation of it.
    if (researchFixturesEnabled(this.env as Record<string, string | undefined>)) {
      return {
        searchProvider: fixtureSearchProvider(),
        browserFactory: new ElectronBrowserTargetFactory(fixtureTransport()),
      }
    }

    const transport = new SafeHttpTransport()
    return {
      searchProvider: new BraveSearchProvider({ env: this.env, transport }),
      // Shared deliberately: `SafeHttpTransport` holds no mutable instance state, so
      // a page read and a provider call cannot interfere. Two instances would add an
      // isolation boundary that does not exist and imply a separation the code does
      // not have.
      browserFactory: new ElectronBrowserTargetFactory(transport),
    }
  }

  async submit(envelope: CoreCommandEnvelope): Promise<CoreCommandResult> {
    if (!this.core) {
      return {
        requestId: typeof envelope?.requestId === 'string' ? envelope.requestId : 'unknown',
        ok: false,
        error: { message: 'core is not ready' },
      }
    }
    return this.core.handleCommand(envelope)
  }

  attach(send: (status: CoreStatus) => void): () => void {
    this.windows.add(send)
    try {
      send(this.status())
    } catch (error) {
      console.error('[freya.core] window status push threw', error)
    }
    return () => {
      this.windows.delete(send)
    }
  }

  onActivity(send: (activity: CoreActivityEvent[]) => void): () => void {
    this.activityWindows.add(send)
    try {
      send(this.activity())
    } catch (error) {
      console.error('[freya.core] window activity push threw', error)
    }
    return () => {
      this.activityWindows.delete(send)
    }
  }

  /**
   * Attach to the conversation projection.
   *
   * Its own channel, for the same reason status and activity are separate: a long
   * transcript is a much larger payload than a status, and a window that only
   * renders a security panel should not pay to receive one.
   */
  onConversation(send: (projection: ConversationProjection) => void): () => void {
    this.conversationWindows.add(send)
    const core = this.core
    if (core) {
      void core
        .conversation()
        .then((projection) => {
          try {
            send(projection)
          } catch (error) {
            console.error('[freya.core] window conversation push threw', error)
          }
        })
        .catch(() => {})
    }
    return () => {
      this.conversationWindows.delete(send)
    }
  }

  async conversation(): Promise<ConversationProjection | null> {
    if (!this.core) return null
    return this.core.conversation()
  }

  voice(): VoiceProjection | null {
    return this.core?.voice() ?? null
  }

  /**
   * Follow the voice projection.
   *
   * Pushed immediately, so a window that attaches after the microphone was turned
   * on already sees `micEnabled: true` instead of rendering an off microphone over
   * an open one. The voice projection's whole job is to make the indicator
   * truthful, and an indicator that is right for the first frame and wrong for
   * every one after it is worse than none.
   */
  onVoice(send: (projection: VoiceProjection) => void): () => void {
    this.voiceWindows.add(send)
    const core = this.core
    if (core) {
      try {
        send(core.voice())
      } catch (error) {
        console.error('[freya.core] window voice push threw', error)
      }
    }
    return () => {
      this.voiceWindows.delete(send)
    }
  }

  /**
   * Follow transcript fragments.
   *
   * Not pushed immediately, and deliberately: there is no "current fragment" to
   * replay, because a fragment is an event that happened rather than a state that
   * persists. Re-sending the last interim on attach would put a guess on screen
   * with no capture behind it.
   */
  onVoiceTranscript(send: (fragment: VoiceTranscriptFragment) => void): () => void {
    this.voiceTranscriptWindows.add(send)
    return () => {
      this.voiceTranscriptWindows.delete(send)
    }
  }

  onBrain(send: (projection: BrainProjection) => void): () => void {
    this.brainWindows.add(send)
    // Pushed immediately, so a window that attaches after startup still sees what
    // Freya already remembers rather than waiting for the next admission.
    const core = this.core
    if (core) {
      try {
        send(core.brain())
      } catch (error) {
        console.error('[freya.core] window Brain push threw', error)
      }
    }
    return () => {
      this.brainWindows.delete(send)
    }
  }

  brain(): BrainProjection | null {
    return this.core?.brain() ?? null
  }

  /**
   * Attach to the Work projection, pushed immediately.
   *
   * A window that reloads re-attaches to the same Core and is told where the work
   * stands without asking — which is the property that makes a renderer reload
   * something that does not interrupt anything.
   */
  onWork(send: (projection: WorkProjection) => void): () => void {
    this.workWindows.add(send)
    try {
      send(this.work() ?? ABSENT_WORK)
    } catch (error) {
      console.error('[freya.core] window Work push threw', error)
    }
    return () => {
      this.workWindows.delete(send)
    }
  }

  work(): WorkProjection | null {
    return this.core?.work() ?? null
  }

  activity(): CoreActivityEvent[] {
    return this.core?.activity() ?? []
  }

  status(): CoreStatus {
    return this.core?.status() ?? NOT_READY
  }

  windowObservationStatus(): WindowSourceStatus {
    return this.windowObservation?.status() ?? 'disabled'
  }

  async stop(reason = 'app shutdown'): Promise<void> {
    this.stopRequested = true
    try { await this.starting } catch { /* The start caller receives its own failure. */ }
    this.releaseWindowObservation()
    this.releaseDeviceHands()
    const core = this.core
    this.core = null
    this.windows.clear()
    this.activityWindows.clear()
    this.conversationWindows.clear()
    this.brainWindows.clear()
    this.workWindows.clear()
    this.workforceWindows.clear()
    this.personalityWindows.clear()
    this.attentionWindows.clear()
    this.officeWindows.clear()
    this.relayWindows.clear()
    this.connectorWindows.clear()
    this.skillWindows.clear()
    this.lifeWindows.clear()
    this.consciousnessWindows.clear()
    this.lifeLoopWindows.clear()
    this.contextChannel.close()
    await core?.stop(reason)
  }

  onMission(send: (projection: MissionProjection) => void): () => void {
    this.missionWindows.add(send)
    const projection = this.mission()
    if (projection !== null) send(projection)
    return () => {
      this.missionWindows.delete(send)
    }
  }

  mission(): MissionProjection | null {
    return this.core?.mission() ?? null
  }

  private broadcastMission(projection: MissionProjection): void {
    for (const send of [...this.missionWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Mission push threw', error)
        this.missionWindows.delete(send)
      }
    }
  }

  /**
   * Attach to the Workforce projection, pushed immediately.
   *
   * A window that reloads re-attaches to the same Core and is told what the
   * workforce is without asking — including, today, the honest sentence that no
   * Workforce domain exists. Null before the Core has started, so a host with
   * nothing to report says nothing rather than manufacturing an empty one.
   */
  onWorkforce(send: (projection: WorkforceProjection) => void): () => void {
    this.workforceWindows.add(send)
    const projection = this.workforce()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Workforce push threw', error)
      }
    }
    return () => {
      this.workforceWindows.delete(send)
    }
  }

  workforce(): WorkforceProjection | null {
    return this.core?.workforce() ?? null
  }

  /**
   * Attach to the Personality projection, pushed immediately.
   *
   * Null before the Core has started, so a host with nothing to report says
   * nothing rather than manufacturing a temperament or an empty relationship —
   * the same rule the Workforce attach follows, for the same reason.
   */
  onPersonality(send: (projection: PersonalityProjection) => void): () => void {
    this.personalityWindows.add(send)
    const projection = this.personality()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Personality push threw', error)
      }
    }
    return () => {
      this.personalityWindows.delete(send)
    }
  }

  personality(): PersonalityProjection | null {
    return this.core?.personality() ?? null
  }

  /**
   * Attach to the Attention projection, pushed immediately.
   *
   * Null before the Core has started, so a host with nothing to report says nothing
   * rather than manufacturing "nothing needs attention" — the same rule every other
   * attach here follows, for the same reason.
   */
  onAttention(send: (projection: AttentionProjection) => void): () => void {
    this.attentionWindows.add(send)
    const projection = this.attention()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Attention push threw', error)
      }
    }
    return () => {
      this.attentionWindows.delete(send)
    }
  }

  attention(): AttentionProjection | null {
    return this.core?.attention() ?? null
  }

  onFoundry(send: (projection: FoundryProjection) => void): () => void {
    this.foundryWindows.add(send)
    const projection = this.foundry()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Foundry push threw', error)
      }
    }
    return () => {
      this.foundryWindows.delete(send)
    }
  }

  foundry(): FoundryProjection | null {
    return this.core?.foundry() ?? null
  }

  private broadcastFoundry(projection: FoundryProjection): void {
    for (const send of [...this.foundryWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Foundry push threw', error)
        this.foundryWindows.delete(send)
      }
    }
  }

  /**
   * Attach to the Office projection, pushed immediately.
   *
   * Null before the Core has started, so a host with nothing to report says
   * nothing rather than manufacturing an empty office — the same rule every
   * other attach here follows, for the same reason.
   */
  onOffice(send: (projection: OfficeProjection) => void): () => void {
    this.officeWindows.add(send)
    const projection = this.office()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Office push threw', error)
      }
    }
    return () => {
      this.officeWindows.delete(send)
    }
  }

  office(): OfficeProjection | null {
    return this.core?.office() ?? null
  }

  /**
   * Attach to the Skills projection, pushed immediately.
   *
   * The immediate push is what makes a window that just reloaded agree with one that
   * never left, and returning `null` before Core starts is the honest reading rather
   * than a manufactured "no procedures".
   */
  onSkills(send: (projection: SkillProjection) => void): () => void {
    this.skillWindows.add(send)
    const projection = this.skills()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Skills push threw', error)
        this.skillWindows.delete(send)
      }
    }
    return () => {
      this.skillWindows.delete(send)
    }
  }

  skills(): SkillProjection | null {
    return this.core?.skills() ?? null
  }

  /**
   * Attach to the Forge projection, pushed immediately.
   *
   * Null before Core has started, so a host with nothing to report says nothing
   * rather than manufacturing an empty catalog.
   */
  onForge(send: (projection: ForgeProjection) => void): () => void {
    this.forgeWindows.add(send)
    const projection = this.forge()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Forge push threw', error)
        this.forgeWindows.delete(send)
      }
    }
    return () => {
      this.forgeWindows.delete(send)
    }
  }

  forge(): ForgeProjection | null {
    return this.core?.forge() ?? null
  }

  private broadcastForge(projection: ForgeProjection): void {
    for (const send of [...this.forgeWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Forge push threw', error)
        this.forgeWindows.delete(send)
      }
    }
  }

  /**
   * Attach to the Life History projection, pushed immediately.
   *
   * Null before the Core has started, so a host with nothing to report says
   * nothing rather than manufacturing an empty history — the same rule every
   * other attach here follows, for the same reason.
   */
  onLife(send: (projection: LifeProjection) => void): () => void {
    this.lifeWindows.add(send)
    const projection = this.life()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Life History push threw', error)
        this.lifeWindows.delete(send)
      }
    }
    return () => {
      this.lifeWindows.delete(send)
    }
  }

  life(): LifeProjection | null {
    return this.core?.life() ?? null
  }

  onConsciousness(send: (projection: ConsciousContextProjection) => void): () => void {
    this.consciousnessWindows.add(send)
    // Pushed immediately when Core is already up, and silent when it is not: the
    // same null-before-Core rule as every other lane here, so an early-attaching
    // window is not handed a manufactured empty mind.
    const projection = this.consciousness()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window conscious context push threw', error)
        this.consciousnessWindows.delete(send)
      }
    }
    return () => {
      this.consciousnessWindows.delete(send)
    }
  }

  consciousness(): ConsciousContextProjection | null {
    return this.core?.consciousness() ?? null
  }

  /**
   * Attach to the Continuous Life Loop, pushed immediately.
   *
   * Null before the Core has started, so an early-attaching window is handed
   * nothing rather than a manufactured idle loop: "Freya is idle" and "there is no
   * continuous life loop" are different facts, and a surface must not have to guess
   * which one it is looking at.
   */
  onLifeLoop(send: (projection: LifeLoopProjection) => void): () => void {
    this.lifeLoopWindows.add(send)
    const projection = this.lifeLoop()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window life loop push threw', error)
        this.lifeLoopWindows.delete(send)
      }
    }
    return () => {
      this.lifeLoopWindows.delete(send)
    }
  }

  lifeLoop(): LifeLoopProjection | null {
    return this.core?.lifeLoop() ?? null
  }

  async attentionTick(): Promise<number> {
    return (await this.core?.attentionTick()) ?? 0
  }

  /**
   * Attach to the Relay projection, pushed immediately.
   *
   * Null before the Core has started, so a host with nothing to report says
   * nothing rather than manufacturing an empty connector list ??? the same rule
   * every other attach here follows, for the same reason.
   */
  onRelay(send: (projection: RelayProjection) => void): () => void {
    this.relayWindows.add(send)
    const projection = this.relay()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Relay push threw', error)
      }
    }
    return () => {
      this.relayWindows.delete(send)
    }
  }

  relay(): RelayProjection | null {
    return this.core?.relay() ?? null
  }

  private broadcastRelay(projection: RelayProjection): void {
    for (const send of [...this.relayWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Relay push threw', error)
        this.relayWindows.delete(send)
      }
    }
  }

  /** Attach to the connector projection, pushed immediately. Null before start. */
  onConnectors(send: (projection: ConnectorProjection) => void): () => void {
    this.connectorWindows.add(send)
    const projection = this.connectors()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window connector push threw', error)
      }
    }
    return () => {
      this.connectorWindows.delete(send)
    }
  }

  connectors(): ConnectorProjection | null {
    return this.core?.connectors() ?? null
  }

  async connectorAuthorizationComplete(payload: unknown): Promise<ConnectorCommandOutcome> {
    if (this.core === null) {
      return { operation: 'refused', ok: false, failureCode: 'unsupported', reason: 'Core has not started' }
    }
    return this.core.connectorAuthorizationComplete(payload)
  }

  async connectorEventIngest(payload: unknown): Promise<ConnectorCommandOutcome> {
    if (this.core === null) {
      return { operation: 'refused', ok: false, failureCode: 'unsupported', reason: 'Core has not started' }
    }
    return this.core.connectorEventIngest(payload)
  }

  private broadcastConnectors(projection: ConnectorProjection): void {
    for (const send of [...this.connectorWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window connector push threw', error)
        this.connectorWindows.delete(send)
      }
    }
  }

  private broadcastAttention(projection: AttentionProjection): void {
    for (const send of [...this.attentionWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Attention push threw', error)
        this.attentionWindows.delete(send)
      }
    }
  }

  private broadcastOffice(projection: OfficeProjection): void {
    for (const send of [...this.officeWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Office push threw', error)
        this.officeWindows.delete(send)
      }
    }
  }

  onWorld(send: (projection: WorldSummaryView) => void): () => void {
    this.worldWindows.add(send)
    const projection = this.world()
    if (projection !== null) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window World push threw', error)
        this.worldWindows.delete(send)
      }
    }
    return () => {
      this.worldWindows.delete(send)
    }
  }

  world(): WorldSummaryView | null {
    return this.core?.world() ?? null
  }

  private broadcastWorld(projection: WorldSummaryView): void {
    for (const send of [...this.worldWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window World push threw', error)
        this.worldWindows.delete(send)
      }
    }
  }

  private broadcastConsciousness(projection: ConsciousContextProjection): void {
    for (const send of [...this.consciousnessWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window conscious context push threw', error)
        this.consciousnessWindows.delete(send)
      }
    }
  }

  private broadcastLifeLoop(projection: LifeLoopProjection): void {
    for (const send of [...this.lifeLoopWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window life loop push threw', error)
        this.lifeLoopWindows.delete(send)
      }
    }
  }

  private broadcastSkills(projection: SkillProjection): void {
    for (const send of [...this.skillWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Skills push threw', error)
        this.skillWindows.delete(send)
      }
    }
  }

  private broadcastLife(projection: LifeProjection): void {
    for (const send of [...this.lifeWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Life History push threw', error)
        this.lifeWindows.delete(send)
      }
    }
  }

  /**
   * Attach to the Context projection, as the channel saw it last.
   *
   * Null until a Core starts reporting, then Core's own facts in the window's
   * vocabulary — a window attaching late is pushed the current one, like every
   * other channel here. Nothing in this host decides what a projection means.
   */
  onContext(send: (projection: ContextProjection) => void): () => void {
    return this.contextChannel.on(send)
  }

  context(): ContextProjection | null {
    return this.contextChannel.pull()
  }

  private broadcastWorkforce(projection: WorkforceProjection): void {
    for (const send of [...this.workforceWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Workforce push threw', error)
        this.workforceWindows.delete(send)
      }
    }
  }

  private broadcastPersonality(projection: PersonalityProjection): void {
    for (const send of [...this.personalityWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Personality push threw', error)
        this.personalityWindows.delete(send)
      }
    }
  }

  private broadcastWork(projection: WorkProjection): void {
    for (const send of [...this.workWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Work push threw', error)
        this.workWindows.delete(send)
      }
    }
  }

  private broadcastBrain(projection: BrainProjection): void {
    for (const send of [...this.brainWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window Brain push threw', error)
        this.brainWindows.delete(send)
      }
    }
  }

  private broadcastConversation(projection: ConversationProjection): void {
    for (const send of [...this.conversationWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window conversation push threw', error)
        this.conversationWindows.delete(send)
      }
    }
  }

  private broadcastVoice(projection: VoiceProjection): void {
    for (const send of [...this.voiceWindows]) {
      try {
        send(projection)
      } catch (error) {
        console.error('[freya.core] window voice push threw', error)
        this.voiceWindows.delete(send)
      }
    }
  }

  private broadcastVoiceTranscript(fragment: VoiceTranscriptFragment): void {
    for (const send of [...this.voiceTranscriptWindows]) {
      try {
        send(fragment)
      } catch (error) {
        console.error('[freya.core] window voice transcript push threw', error)
        this.voiceTranscriptWindows.delete(send)
      }
    }
  }

  private broadcastActivity(activity: CoreActivityEvent[]): void {
    for (const send of [...this.activityWindows]) {
      try {
        send(activity)
      } catch (error) {
        console.error('[freya.core] window activity push threw', error)
        this.activityWindows.delete(send)
      }
    }
  }

  private broadcast(status: CoreStatus): void {
    for (const send of [...this.windows]) {
      try {
        send(status)
      } catch (error) {
        console.error('[freya.core] window status push threw', error)
        this.windows.delete(send)
      }
    }
  }
}

/**
 * A valid Work projection for a host whose Core has not started.
 *
 * Stated as unavailable rather than as an empty board: "Freya is not up yet" and
 * "there is no work" look identical otherwise, and they are very different things.
 */
const ABSENT_WORK: WorkProjection = {
  health: 'unavailable',
  reason: 'no Core has reported yet',
  detailAvailable: false,
  runs: [],
  tasks: [],
  approvals: [],
  counts: {
    runs: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    awaitingApproval: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pendingApprovals: 0,
    tasks: 0,
    liveCapabilities: 0,
  },
  runsRetained: 0,
  runsTotal: 0,
  runsHidden: 0,
  capabilities: [],
  verifiers: [],
  limits: { maxSteps: 0, maxActions: 0, maxDurationMs: 0, maxAttemptsPerStep: 0 },
  sequence: 0,
}

/** A valid status for a host whose Core has not started. Nothing is guessed. */
const NOT_READY: CoreStatus = {
  lifecycle: 'booting',
  eventSequence: 0,
  coreStartedAt: null,
  integrity: {
    integrity: 'ok',
    reason: 'no Core has reported yet',
    line: null,
    eventsRead: 0,
    bytesDiscarded: 0,
  },
  stopAll: { active: false, activatedAt: null, activatedBy: null },
  guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
  governor: { status: 'unknown', grantsActive: 0 },
  providers: [],
  // No Core, so no gateway, so nothing executing. Zero is the honest reading of
  // a host that has not started, not a guess at what a provider might be doing.
  activeProviderCalls: 0,
  sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  faults: [],
}
