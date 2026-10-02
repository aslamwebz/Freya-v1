import { randomUUID } from 'node:crypto'
import { EventFabric } from './events/fabric'
import type { EventStore } from './events/store'
import { JsonlEventStore } from './events/jsonl-store'
import type { AnyCoreEvent } from './events/envelope'
import { initialCoreState, reduceCoreState, type CoreState } from './state'
import { projectCoreStatus } from './projections/core-status'
import { DefaultGuard, type Guard, type Principal } from './security/guard'
import { CognitionService } from './cognition/service'
import { ModelGateway, type GatewayRecorder } from './model/gateway'
import { emptyUsage } from './model/usage'
import type { ModelProvider } from './model/provider'
import { FakeModelProvider, SlowFakeModelProvider } from './model/fake-provider'
import { NanoGptProvider, readNanoGptConfig, type NanoGptEnv } from './model/nanogpt-provider'
import { MindService, type TurnExperience } from './mind/mind'
import type { ReferenceKnowledge } from './mind/context-compiler'
import { Brain, buildIdentityRoot, buildSelfDefinition, type BrainProjection } from './brain/brain'
import { ResearchIntegration } from './research/coreIntegration'
import { RESEARCH_LIMITS } from './research/schemas'
import { safeResearchError } from './research/errors'
import type { BrowserTargetFactory } from './research/browser'
import type { SearchProvider } from './research/types'
import type { ResearchResult } from './research/coordinator'
import type { BrainStore } from './brain/store'
import { EncryptedBrainStore } from './brain/encrypted-store'
import { MemoryBrainStore } from './brain/memory-store'
import type { Confidence, MemoryKind, Sensitivity } from './brain/types'
import { ConversationService } from './conversation/service'
import type { ConversationStore } from './conversation/store'
import { EncryptedConversationStore } from './conversation/encrypted-store'
import { MemoryConversationStore } from './conversation/memory-store'
import { VoiceService } from './voice/service'
import type { VoiceTranscriber, VoiceSynthesizer } from './voice/types'
import { WorkforceEngine } from './workforce/engine'
import type { SubordinateWorkerScope, WorkforceOwnerScope } from './workforce/authority'
import { ABSENT_WORKFORCE_PROJECTION } from './workforce/projection'
import { workerPrincipalId } from './workforce/types'
import type { WORKFORCE_LIMITS } from './workforce/types'
import type { WorkforceProjection, WorkforceWorkerDetail } from './workforce/types'
import { MissionEngine, type WorkPort } from './missions/engine'
import { ABSENT_MISSION_PROJECTION } from './missions/projection'
import type { MissionCommandOutcome, MissionDetail, MissionProjection } from './missions/types'
import type { CoreCommandName, MissionCommandOutcomeView } from './protocol/core-protocol'
import type { MissionStore } from './missions/store'
import { EncryptedMissionStore } from './missions/encrypted-store'
import { MemoryMissionStore } from './missions/memory-store'
import { WorkEngine, type WorkCommandOutcome } from './work/engine'
import { ABSENT_WORK_PROJECTION, type WorkProjection } from './work/projection'
import {
  registerPhaseSixCapabilities,
  WorkRegistry,
  type WorkCapability,
} from './work/capability'
import {
  WORK_LIMITS,
  TASK_STATUSES,
  isTerminalRunStatus,
  type RunLimits,
  type StepRecord,
  type TaskStatus,
  type WorkStepPlan,
} from './work/types'
import type { ContextBudget } from './mind/context-compiler'
import {
  ContextIntegration,
  contextRefusal,
  type ContextIntegrationOptions,
} from './context/coreIntegration'
import type { ContextReference } from './context/types'
import { ContextPersistenceRuntime } from './contextPersistence'
import { bindTurnContext } from './mind/turn-context'
import type { ActiveWindowAdmissionLane } from './context/sources/window'
import type { ContextHostReport } from './context/coreIntegration'
import type { ContextCommandOutcome, ContextProjectionView, ContextScopeRef } from './protocol/context'
import { NO_ACTIVE_AGENT_CONTEXT_REASON } from './protocol/context'
import type { ConversationProjection, ConversationTurnView, VoiceProjection } from './protocol/conversation'
import {
  ABSENT_WORKFORCE_PROJECTION as ABSENT_WORKFORCE_MIRROR,
  NO_WORKFORCE_DOMAIN_REASON,
  WORKFORCE_NO_PAYLOAD,
  type WorkforceProjection as WorkforceMirrorProjection,
  type WorkforceSource,
} from './protocol/workforce'
import { describeActivity, mergeActivity } from './protocol/activity'
import type { CoreActivityEvent } from './protocol/activity'
import {
  ABSENT_PERSONALITY_PROJECTION,
  NO_PERSONALITY_DOMAIN_REASON,
  type PersonalityProjection,
  type PersonalitySource,
} from './protocol/personality'
import {
  ABSENT_ATTENTION_PROJECTION,
  ATTENTION_NO_PAYLOAD,
  NO_ATTENTION_DOMAIN_REASON,
  type AttentionDecisionView,
  type AttentionProjection,
} from './protocol/attention'
import { AttentionEngine, type AttentionSourceScope } from './attention/engine'
import type { AttentionDecision, AttentionSource, FocusState } from './attention/types'
import {
  ABSENT_SKILL_PROJECTION,
  NO_SKILL_DOMAIN_REASON,
  SKILL_NO_PAYLOAD,
  type SkillCommandOutcome,
  type SkillProjection,
} from './protocol/skills'
import { SkillEngine, type SkillOwnerScope } from './skills/engine'
import { SkillPersistenceRuntime } from './skillsPersistence'
import type { SkillExecutionPort } from './skills/execution'
import { OWNER_SUBMITTABLE_EVIDENCE_KINDS } from './skills/evaluation'
import {
  SKILL_REFUSAL_CODES,
  isSkillRetirementReason,
  isSkillStatus,
  type SkillRecord as SkillRecordShape,
} from './skills/types'
import type { Capability, CognitionCause, CognitionOrigin } from './protocol/core-protocol'
import type { CognitionGrantSpec } from './cognition/grants'
import type { OwnerAuthority, WorkerAuthority } from './authority'
import type {
  CoreCommandEnvelope,
  CoreCommandResult,
  ResearchCommandOutcome,
  CoreLifecycle,
  CoreStatus,
  JournalFault,
  PrincipalId,
} from './protocol/core-protocol'

/** A journal nobody has damaged. Stated, not assumed. */
const HEALTHY_JOURNAL: JournalFault = {
  integrity: 'ok',
  reason: 'the event log was read in full and validated',
  line: null,
  eventsRead: 0,
  bytesDiscarded: 0,
}

/**
 * The Freya Core.
 *
 * It starts once per application process, lives outside React, and contains no
 * Electron import and no browser global. Electron owns a Core; Core does not
 * know Electron exists.
 *
 * What Core deliberately does not expose: a provider, a gateway, a grant store
 * that can be written to, or a policy object. A caller gets a command surface
 * and a projection. Anything that could reach a model provider is reachable only
 * through `cognition.request`, which the Governor gates.
 */

export const CORE_VERSION = '0.1.0'

/**
 * How long shutdown waits for cancelled requests to record their outcome.
 *
 * Short enough that quitting feels like quitting, long enough that a provider
 * which obeys its signal has finished reacting. Past this bound the Core stops
 * waiting and closes anyway; the journal is then missing a terminal event, which
 * is the same thing a crash would have produced and is not a worse record.
 */
const SHUTDOWN_DRAIN_MS = 1_000

/**
 * How long shutdown waits for research to settle.
 *
 * Shorter than the cognition drain, because a research job is a chain of bounded
 * operations rather than one provider call, and a wedged browser target would
 * otherwise hold the application open for the whole 120s research ceiling.
 */
const RESEARCH_DRAIN_MS = 1_000


/**
 * What a Run cancellation means when the caller did not say.
 *
 * Named here rather than left undefined so the default is a sentence a person
 * reads on the board and in the journal, rather than a null reason.
 */
const WORK_CANCELLED = 'cancelled by the owner'

export interface CoreOptions {
  /** Where the durable log lives. */
  dataPath: string
  /**
   * Test seam for deterministic persistence-failure tests.
   * Production leaves this unset and opens the JSONL store from dataPath.
   */
  eventStore?: EventStore
  env?: NanoGptEnv
  now?: () => Date
  newId?: () => string
  /**
   * Test seam: supply providers directly, e.g. to inject a failing one.
   * When set, it is the *entire* provider set — production providers are not
   * added alongside it, so a test cannot accidentally exercise a real one.
   */
  providers?: ModelProvider[]
  /**
   * Developer seam: add a local echo provider to the production set.
   *
   * Named for what it is and opt-in, because the failure mode it guards against is
   * a build that appears to work while answering from a canned string. It is never
   * inferred from a debug flag, a test runner, or an absent credential.
   *
   * - `echo` answers immediately.
   * - `slow-echo` takes long enough that cancellation has something to interrupt,
   *   which is the only way the stop path can be demonstrated end to end.
   *
   * It is listed last in the provider set, so it can never shadow a real provider
   * when both are present, and its output is prefixed to say it is not
   * intelligence.
   */
  developerProvider?: 'echo' | 'slow-echo'
  /**
   * The conversation master key, supplied by the host.
   *
   * Core never generates, derives or persists a key, and has no default. A Core
   * constructed without one gets an **ephemeral** conversation store — real
   * conversation, no persistence, reported as such — rather than a weaker store
   * standing in for the encrypted one. The key does not leave this process: it is
   * not in the renderer, not in a model request, not in the journal, and not in a
   * log line.
   */
  conversationKey?: Uint8Array
  /** Overrides the conversation store wholesale. For tests. */
  conversationStore?: ConversationStore
  /**
   * The Brain's own 256-bit key, supplied by the host.
   *
   * **A separate secret from the conversation key**, not a derivation of it. The
   * Brain is expected to outlive the machine it was written on and holds the
   * longest-lived, most valuable state in the system, so it is deliberately not one
   * key-compromise away from the conversation log — see `electron/keyring.ts`.
   *
   * A Core with no Brain key still works: the Brain falls back to an ephemeral
   * in-memory store that reports `durable: false`, and the surface says Freya will
   * not remember across a restart. The Brain never refuses service, because a
   * missing memory is not a reason to stop answering.
   */
  brainKey?: Uint8Array
  /** Overrides the Brain store wholesale. For tests. */
  brainStore?: BrainStore
  /**
   * Missions' own key, from the keyring.
   *
   * A **third** independent secret. A Mission holds what a person asked Freya to
   * accomplish — their intent, their success criteria, in their words — which is as
   * private as a conversation, and recovering one domain's key must never yield
   * another's. See `electron/keyring.ts`.
   *
   * A Core with no Mission key still works: Missions fall back to an ephemeral store
   * that reports `mode: 'ephemeral'`, `durable: false`, and says why. Missions are
   * never silently presented as durable when they are not.
   */
  missionKey?: Uint8Array
  /** Context's independent secure key; absent means explicit process-only Context. */
  contextKey?: Uint8Array | null
  /**
   * Skills' own key, from the keyring. A **fifth** independent secret.
   *
   * A skill body is a procedure Freya wrote: its inputs, its outputs, its steps and
   * the capability map it will ask for. That is unpublished architecture and internal
   * policy in miniature, so it is protected exactly as Conversation, the Brain,
   * Missions and Context each are, and recovering any one of those keys must never
   * yield it. See `electron/keyring.ts`.
   *
   * A Core with no Skill key still works: procedures are held in this process only,
   * reported as `mode: 'ephemeral'` with `durable: false` and a sentence saying why,
   * and nothing may be planned into a Run from a body that will not survive a
   * restart. Skills are never silently presented as durable when they are not.
   */
  skillKey?: Uint8Array | null
  /** Overrides the Mission content store wholesale. For tests. */
  missionStore?: MissionStore
  /**
   * Narrowed Workforce ceilings. Can only *lower* the code-owned limits.
   *
   * A raise is ignored rather than clamped, so a misconfigured Core gets the tighter of
   * the two behaviours and never a silent widening. There is deliberately no way to
   * hand this subsystem extra capability names to distribute: which capabilities a
   * worker may hold is a closed vocabulary in `core/protocol/core-protocol.ts`, not a
   * configuration option, because "just this once, for this agent" is how a worker
   * capability set grows until it includes `work.approval.decide`.
   */
  workforceLimits?: Partial<Record<keyof typeof WORKFORCE_LIMITS, number>>
  /**
   * The Phase 5 research stack, injected whole.
   *
   * Core assembles it but never populates it: the search provider and the browser
   * target come from the host, so Core holds no search credential, knows nothing
   * about which vendor is configured, and cannot decide that a key existing means
   * search is enabled. Absent — the normal case for a Core built without research —
   * every research command is refused with a stated reason and nothing is called.
   */
  research?: { searchProvider: SearchProvider; browserFactory: BrowserTargetFactory }
  /** A local speech-to-text engine. Absent means none is configured. */
  voiceTranscriber?: VoiceTranscriber
  /** A local text-to-speech engine. Absent means none is configured. */
  voiceSynthesizer?: VoiceSynthesizer
  /** Overrides the conversation context budget. For tests. */
  contextBudget?: ContextBudget
  /**
   * Extra Work capabilities to register.
   *
   * The seam Phase 5 (Searcher, managed browser) and Phase 7 (Missions) attach
   * through. A capability is registered and nothing else changes: no engine edit,
   * no new execution path, no new event family. Phase 6 registers only its own
   * inert test set, so a Core built today can execute no external operation at all
   * — which is the correct starting posture rather than a gap.
   */
  workCapabilities?: readonly WorkCapability[]
  /**
   * The Phase 8 Workforce seam.
   *
   * The *entire* integration surface this lane assumes about issue #10: Core
   * may be handed something it can read a `WorkforceProjection` from, and
   * optionally follow. Unset — the state of every build until that domain
   * exists — Core reports `NO_WORKFORCE_DOMAIN_REASON` and an empty,
   * `unavailable` projection, which is the honest reading rather than a
   * placeholder workforce.
   *
   * A source carries no authority by virtue of being one. It can be read; it
   * cannot be instructed through this option, and nothing in it is reachable
   * from a renderer.
   */
  workforceSource?: WorkforceSource
  /**
   * The Phase 11 Personality & Relationship seam.
   *
   * The *entire* integration surface this lane assumes: Core may be handed
   * something it can read a `PersonalityProjection` from, and optionally follow.
   * Unset — the state of every build in this repository — Core reports
   * `NO_PERSONALITY_DOMAIN_REASON` and an `unavailable` projection, which is the
   * honest reading rather than an empty relationship.
   *
   * A source carries no authority by virtue of being one, and here the reason is
   * sharper than elsewhere: what it reports is *relationship truth* — records,
   * confidences, provenance classes, cue eligibility. It can be read; it cannot
   * be instructed through this option; and nothing in it is reachable from a
   * renderer, which has no function that names it.
   */
  personalitySource?: PersonalitySource
  /**
   * Whether Core wires its own subsystems into attention as event sources.
   *
   * Composition, like `research` and `workforceSource`: the production host turns
   * this on, and a test that does not care about attention leaves it off so a
   * completed Run does not silently add `attention.*` lines to a journal it is
   * asserting on. When on, a terminal Run/Mission/Research event is delivered to
   * the Attention engine through its narrow internal source scope — the engine
   * still decides, and the delivery cannot mint authority or reach a model.
   */
  attentionObserveSources?: boolean
}

/**
 * The Workforce mirror Core serves, from whichever half is the source of truth.
 *
 * Two lanes authored this type from opposite ends, and this is a merge, not a
 * rewrite: #16's Core-owned projection and #14's read-only protocol view are
 * two shapes of the same facts. The intersection is what `workforce()` and
 * `onWorkforce` serve. When #14's seam is filled, the source's projection is
 * served verbatim and carries the protocol's fields; when it is not, Core's
 * own Workforce engine produces the projection, with no second, parallel copy
 * of the same state anywhere between them.
 */
type WorkforceMirror = WorkforceProjection & WorkforceMirrorProjection

/**
 * The production capability surface of Core.
 *
 * What is *not* here matters as much as what is. There is no cognition
 * service, no grant store, no gateway, no provider and no policy object, so
 * there is nothing for a caller to reach authority through. Cognition is
 * reachable only by Core's own subsystems, which hold an authority object with
 * a principal already baked in — see `core/authority.ts`.
 *
 * Grant governance from outside Core is a *command*, and the handler records
 * the owner regardless of what the payload claims.
 */
export interface Core {
  start(): Promise<CoreStatus>
  stop(reason?: string): Promise<void>
  status(): CoreStatus
  handleCommand(envelope: CoreCommandEnvelope): Promise<CoreCommandResult>
  /** Subscribe to projection changes. Returns a disposer. */
  subscribe(listener: (status: CoreStatus) => void): () => void
  /**
   * Subscribe to durable events, as display-ready activity.
   *
   * The renderer never sees `EventFabric`. It sees this, which is a fixed shape
   * with no payload field, so a future event carrying text cannot leak through
   * by accident. A subscriber receives the current feed immediately, which is
   * what makes a renderer that attaches late agree with one that never left.
   */
  onActivity(listener: (activity: CoreActivityEvent[]) => void): () => void
  /** The current activity feed, newest last, capped. */
  activity(): CoreActivityEvent[]
  /**
   * Subscribe to the conversation projection.
   *
   * A mirror like the status: a window holds what Core last built and cannot write
   * to it. Conversation *content* appears here because the transcript has to be
   * rendered somewhere — the store, the keys and the filesystem do not.
   */
  onConversation(listener: (projection: ConversationProjection) => void): () => void
  /** The current conversation projection. */
  conversation(): Promise<ConversationProjection>
  /** The current voice projection. */
  voice(): VoiceProjection
  /**
   * Subscribe to the Brain projection.
   *
   * Same reason as the conversation mirror: the surface has to be able to say what
   * Freya has remembered without asking for it on every render.
   */
  onBrain(listener: (projection: BrainProjection) => void): () => void
  /**
   * The current Brain projection.
   *
   * A mirror like the others, and it carries long-term knowledge, so it is its own
   * slot rather than a widening of `CoreStatus`. A security projection that also
   * held Freya's memories would be copied, cached and logged wherever status is.
   */
  brain(): BrainProjection
  /** Subscribe to the Brain projection. Same mirror semantics as the others. */
  onBrain(listener: (projection: BrainProjection) => void): () => void
  /**
   * Subscribe to the Work projection.
   *
   * The board's whole input. Same mirror semantics as the others: the current
   * value is delivered on attach so a renderer that just reloaded knows where it
   * stands, and a window cannot write a single field of what it receives.
   */
  onWork(listener: (projection: WorkProjection) => void): () => void
  onMission(listener: (projection: MissionProjection) => void): () => void
  /**
   * The current Work projection.
   *
   * Its own slot and its own channel, for the reason the Brain has one: this is
   * where long-running execution state lives, and shipping it inside a security
   * status would mean it is copied, cached and logged wherever status is.
   *
   * Reachable before `start()` finishes, where it reports `unavailable` with a
   * stated reason rather than throwing — a surface must be able to render "Core is
   * not up yet" during startup without special-casing the failure.
   */
  work(): WorkProjection
  /**
   * Core's account of Missions. Derived from the journal, never assembled here.
   *
   * Never null: a Core that has not started, or was built without Missions, returns a
   * projection that says which of those it is — because "there are no Missions" and
   * "Missions are unavailable" are different facts and a surface must not have to
   * guess which one it is looking at.
   */
  mission(): MissionProjection
  /**
   * One worker with its mailbox, decrypted from this process's memory.
   *
   * The counterpart to the projection, and the reason message bodies are kept out of
   * both. Nothing but Core reaches it, and a body never enters a projection, the
   * journal, or an activity row.
   */
  workforceDetail(workerId: string): Promise<WorkforceWorkerDetail | null>
  /**
   * One Mission's private content, decrypted from the Mission store.
   *
   * The counterpart to the projection, and the reason the store is encrypted rather
   * than hidden: the owner has to be able to read back what they wrote. Nothing but
   * the owner principal reaches this, and the value never enters a projection or the
   * journal.
   */
  missionDetail(missionId: string): Promise<MissionDetail | null>
  /**
   * Core's account of the workforce: workers, teams, and what each is doing.
   *
   * Read-only and never null. A Core whose Workforce has never reported says so in
   * words — because "there are no workers" and "there is no Workforce" are different
   * facts and a surface must not have to guess which one it is looking at.
   *
   * One accessor serves both lanes without either owning the other's state. The
   * `WorkforceSource` seam #14 defined (#16's `workforceSource` option filling it) is
   * served verbatim when filled; otherwise Core's own engine projection IS the truth
   * the seam would have reported — there is no method here that takes an instruction
   * about workers, so no authority is reachable through this accessor in any direction.
   */
  workforce(): WorkforceMirror
  /** Subscribe to the Workforce mirror. Same mirror semantics as the others. */
  onWorkforce(listener: (projection: WorkforceMirror) => void): () => void
  /**
   * Core's account of personality: temperament, the relationship record as
   * *metadata*, deterministic interpretation, and at most one cue for Presence.
   *
   * Read-only, and the shape of the read is the whole policy: `text`, `tags` and
   * `admissionReason` are not fields of the projection, so no caller of this
   * accessor can receive what was recorded about the person — only that it
   * exists, what kind it is, and how much Core trusts it. A source that reports
   * is served and never instructed; there is no method here that admits,
   * supersedes or interprets anything, in either direction.
   *
   * A Core with no `personalitySource` answers `NO_PERSONALITY_DOMAIN_REASON`
   * rather than an empty record, because "nothing has been recorded" and "this
   * build records nothing" are different facts to a person reading them.
   */
  personality(): PersonalityProjection
  /** Subscribe to the Personality projection. Same mirror semantics as the others. */
  onPersonality(listener: (projection: PersonalityProjection) => void): () => void
  /**
   * Core's account of events and attention: counts, the focus reading Core
   * derived, the last decision as metadata, at most one directive for Presence, and
   * the schedules Core holds.
   *
   * Read-only, and the shape of the read is the whole policy: the event **text**
   * is not a field of the projection, so no caller of this accessor can receive
   * what arrived — only its measured length. There is no method here that decides,
   * escalates, spends a budget or bypasses a cooldown, in either direction.
   */
  attention(): AttentionProjection
  /** Subscribe to the Attention projection. Same mirror semantics as the others. */
  onAttention(listener: (projection: AttentionProjection) => void): () => void
  /**
   * Evaluate due schedules. The bounded wake mechanism, driven by the host.
   *
   * Main-process composition only — there is deliberately no `attention.tick`
   * command, so a renderer cannot drive the clock. It performs no model call, no
   * provider contact and no network access; it fires only schedules already due
   * whose condition holds against state Core already has.
   */
  attentionTick(now?: Date): Promise<number>
  /**
   * Core's account of context: what is held, in which scope, and what state.
   *
   * Metadata only, and that is not a rendering choice — the projection carries no
   * field a selected sentence could hide in, and no command in the Core vocabulary
   * returns one. What somebody shared stays in the Context Store, inside this
   * process, and the only thing that reads it is the code that is about to act on
   * the answer.
   *
   * There is nothing here about permission. Context says what "this" and "here"
   * *point at*; it says nothing about what may then be done with them, and a
   * context item can widen no grant and satisfy no capability.
   */
  context(): ContextProjectionView
  /** Main-process composition only; no protocol/preload door exposes this lane. */
  contextWindowLane(scope: ContextScopeRef): ActiveWindowAdmissionLane
  /** Subscribe to the Context projection. Same mirror semantics as the others. */
  onContext(listener: (projection: ContextProjectionView) => void): () => void
  /**
   * Core's account of skills: procedures, their lifecycle status, the evidence behind
   * them as counts, the open improvement proposals, and whether bodies survive a
   * restart.
   *
   * Read-only, and the shape of the read is the whole policy. A skill's summary,
   * contract descriptions and required-capability **list** are not fields of the
   * projection: they cross only through an explicit `skill.detail.read` for one skill,
   * to the owner. Commentary crosses as a *character count*. Nothing here is
   * writable by a window, and there is no method on this interface that admits,
   * promotes, retires, evaluates or executes a skill — every one of those is an owner
   * command Core handles behind Guard.
   */
  skills(): SkillProjection
  /** Subscribe to the Skills projection. Same mirror semantics as the others. */
  onSkills(listener: (projection: SkillProjection) => void): () => void
  readonly lifecycle: CoreLifecycle
}



class FreyaCore implements Core {
  private currentLifecycle: CoreLifecycle = 'booting'
  private fabric!: EventFabric
  private state: CoreState = initialCoreState()
  private gateway!: ModelGateway
  private service!: CognitionService
  private guard!: Guard
  private owner!: Principal
  private startedAt: string | null = null
  /**
   * What recovery found in the journal.
   *
   * Session state rather than something derived from the log, because the log is
   * exactly what cannot be trusted. Held for the life of the Core so the fault
   * cannot be quietly forgotten after start-up.
   */
  private integrity: JournalFault = HEALTHY_JOURNAL
  /**
   * Set when *this* start found corruption, so it can be written into the
   * journal. Distinct from `integrity`, which is what a caller sees: on a later
   * start the damage is already in the log and there is nothing new to write.
   */
  private freshIntegrityFault: {
    reason: string
    line: number
    quarantinePath: string
    trustedPrefixEvents: number
    trustedPrefixBytes: number
    damagedBytes: number
  } | null = null
  private readonly listeners = new Set<(status: CoreStatus) => void>()
  private readonly activityListeners = new Set<(activity: CoreActivityEvent[]) => void>()
  private readonly brainListeners = new Set<(projection: BrainProjection) => void>()
  private readonly workListeners = new Set<(projection: WorkProjection) => void>()
  private readonly missionListeners = new Set<(projection: MissionProjection) => void>()
  private readonly workforceListeners = new Set<(projection: WorkforceMirror) => void>()
  private readonly contextListeners = new Set<(projection: ContextProjectionView) => void>()
  /**
   * The Phase 9 Context integration, or undefined before `start()`.
   *
   * The whole of this lane: the store from #15 plus the Core boundary that decides
   * what may go into it and how refusals are worded. There is nothing here that
   * reaches the network, a provider or a file, so constructing it at boot costs
   * nothing — no key is read, no capture lane starts, and no inference is
   * scheduled.
   */
  private contextIntegration: ContextIntegration | undefined
  private contextPersistence: ContextPersistenceRuntime | undefined
  /** Context wiring handed in by Core itself, never by a payload. */
  private readonly contextOptions: Partial<ContextIntegrationOptions>
  /**
   * The Workforce seam, or null in every build where nothing has filled it.
   *
   * #14's read-only view across the seam. When it is filled, Core serves what it
   * reports verbatim; it is never a path to instruct anything, and no authority
   * travels in either direction along it. When it is *not* filled, Core's own
   * Workforce engine is the source of truth and the seam stays null rather than
   * both lanes keeping a parallel copy of the same facts.
   */
  private workforceSource: WorkforceSource | null
  /** Detaches Core from the source's change channel. Set once, at start. */
  private disposeWorkforceSource: () => void = () => {}
  private readonly personalityListeners = new Set<(projection: PersonalityProjection) => void>()
  /**
   * The Phase 11 Personality seam, or null in every build where nothing has
   * filled it — which is every build in this repository, Slice A being pure.
   *
   * Read-only in the strongest sense available: `projection()` answers and
   * `subscribe?` follows. There is no admission method, no ledger writer and no
   * interpretation hook on the other side of this field, so the seam cannot be
   * used to *record* anything about the person, only to report what Core already
   * holds.
   */
  private personalitySource: PersonalitySource | null
  /** Detaches Core from the Personality source's change channel. Set once, at start. */
  private disposePersonalitySource: () => void = () => {}
  private readonly attentionListeners = new Set<(projection: AttentionProjection) => void>()
  private readonly skillListeners = new Set<(projection: SkillProjection) => void>()
  /**
   * The Phase 12 Attention engine, or undefined before `start()`.
   *
   * Built by Core and owned by Core. It holds no authority, no gateway and no
   * provider: the only thing it can do is append `attention.*` metadata and read
   * already-authorized state for the focus reading.
   */
  private attentionEngine: AttentionEngine | undefined
  /**
   * The Phase 17 Skill engine, or undefined before `start()`.
   *
   * Built after Work, because admission validates a skill's declared capabilities and
   * verifiers against the *registered* Work set and execution reads a Run through the
   * narrow port below. It holds the journal, the encrypted body store and the Work
   * registry — and no gateway, no authority object and no provider, which is what
   * makes "idle, startup and read paths cost zero model calls" structural.
   */
  private skillEngine: SkillEngine | undefined
  private skillPersistence: SkillPersistenceRuntime | undefined
  /** Display-ready activity, rebuilt from the log on every start. */
  private activityFeed: CoreActivityEvent[] = []
  private readonly newId: () => string
  private disposeState: () => void = () => {}
  private stopped = false
  private conversationStore!: ConversationStore
  private brainService!: Brain
  /** Null when the host configured no research stack. Every command then refuses. */
  private researchIntegration: ResearchIntegration | null = null
  /**
   * Research admission.
   *
   * Closed synchronously by STOP ALL, before that command's first `await`. A
   * research operation that checked admission and then awaited would be able to
   * reach the network after the stop, which is the window STOP ALL exists to
   * remove. Deliberately a boolean rather than derived state: it has to be readable
   * without asking anything that could be slow.
   */
  private researchAdmissionOpen = false
  private mind!: MindService
  private conversations!: ConversationService
  private voiceService!: VoiceService
  /**
   * The model the owner selected for subsequent chat turns, or null for the
   * provider's own configured default.
   *
   * A session setting, deliberately not durable and never journaled: what each
   * turn actually used is already recorded per request by the Gateway's
   * `model.request.started`. Nothing reads this except the Mind, on the way to a
   * request the Governor must still authorise, so a selection can neither bypass
   * a budget nor survive a restart as a hidden preference.
   */
  private selectedModel: string | null = null
  /**
   * The Work engine, or undefined before it is built.
   *
   * Optional rather than definite so that `work()` can report `unavailable` during
   * startup instead of throwing, the same way `brain()` does.
   */
  private workEngine: WorkEngine | undefined
  private missionEngine: MissionEngine | undefined
  /**
   * The Workforce engine, or undefined before it is built.
   *
   * Optional for the same reason `missionEngine` is: `workforce()` has to report
   * `unavailable` during startup rather than throwing, so a surface can render "Core is
   * not up yet" without special-casing the failure.
   */
  private workforceEngine: WorkforceEngine | undefined
  private workRegistry: WorkRegistry | undefined

  constructor(private readonly options: CoreOptions) {
    this.newId = options.newId ?? (() => randomUUID())
    this.workforceSource = options.workforceSource ?? null
    this.personalitySource = options.personalitySource ?? null
    // Only the clock and the id factory, both already Core's own. The Context
    // integration is deliberately not a `CoreOptions` seam: every argument that
    // could widen it — a scope, a channel, a source, an agent source — is a claim
    // about provenance, and a host that could pass one would be a host that could
    // assert what the owner did. #16 will fill the agent seam from inside Core.
    this.contextOptions = {
      now: options.now,
      newId: this.newId,
    }
  }

  get lifecycle(): CoreLifecycle {
    return this.currentLifecycle
  }

  /**
   * The authority objects Core hands to its own subsystems.
   *
   * Not on the `Core` interface, on purpose. It is reachable from
   * `core/testing.ts` and from inside this module, and from nowhere else — a
   * future agent or module is written *inside* Core and is issued one of these
   * by Core, rather than importing a way to mint its own.
   */
  /**
   * The authority objects Core issues to its own subsystems.
   *
   * Reachable from `core/testing.ts` and from inside this module, and from
   * nowhere else. There is no public accessor and no interface member, so a
   * future agent is written *inside* Core and handed one of these, rather than
   * importing a way to mint its own.
   */
  issueOwnerAuthority(): OwnerAuthority {
    return this.service.ownerAuthority()
  }

  issueWorkerAuthority(principalId: PrincipalId): WorkerAuthority {
    return this.service.workerAuthority(principalId)
  }

  /**
   * The owner's face of the workforce.
   *
   * Same shape of decision as `issueOwnerAuthority`, for the same reason: holding the
   * object *is* the authority, so there is no capability string a caller could pass to
   * acquire it, and this method is not on the `Core` interface. It is reachable from
   * `core/testing.ts` and from inside this module only.
   *
   * Every roster, team, assignment and budget operation in this subsystem hangs off this
   * one object. A worker's scope has none of them — see `SubordinateWorkerScope`.
   */
  issueWorkforceOwnerScope(): WorkforceOwnerScope {
    return this.requireWorkforce().ownerScope()
  }

  /**
   * One worker's own scope.
   *
   * Issued by Core for a named worker, and the only subordinate surface that exists.
   * `workerId` is fixed at issuance and `principalId` is derived from it, so neither is a
   * parameter: a scope cannot speak as another agent, and cannot assert a principal.
   */
  issueSubordinateScope(workerId: string): SubordinateWorkerScope {
    return this.requireWorkforce().ownerScope().scopeFor(workerId)
  }

  /**
   * A narrow ingest scope for one authorized attention source.
   *
   * Not on the `Core` interface, for the same reason the workforce scopes are not:
   * holding the object is the authority to speak as that source, and it is issued
   * only from inside Core (and from `core/testing.ts`) rather than acquired by
   * naming a capability. A source can ingest, and it can do nothing else — it has
   * no method to decide, to set a budget, to schedule, or to reach a model.
   */
  issueAttentionSourceScope(source: AttentionSource): AttentionSourceScope {
    return this.requireAttention().sourceScope(source)
  }

  /**
   * The owner's face of skills.
   *
   * Same shape of decision as `issueOwnerAuthority`, for the same reason: holding the
   * object *is* the authority, so there is no capability string a caller could pass to
   * acquire it, and this method is not on the `Core` interface. It is reachable from
   * `core/testing.ts` and from inside this module only.
   *
   * Admission, revision, promotion, retirement and improvement proposals all hang off
   * this one object, and a *subordinate* scope does not exist: there is no agent route
   * into the skill lifecycle, because "an agent that can promote its own procedure" is
   * a self-awarded success with a method name instead of a capability string.
   */
  issueSkillOwnerScope(): SkillOwnerScope {
    return this.requireSkills().ownerScope(this.owner.id)
  }

  async start(): Promise<CoreStatus> {
    if (this.lifecycle !== 'booting') return this.status()

    let store: EventStore
    try {
      store = this.options.eventStore ?? (await JsonlEventStore.open(this.options.dataPath))
    } catch (error) {
      // Durability unavailable is a degraded Core, not a Core that silently
      // continues without a log.
      this.currentLifecycle = 'degraded'
      const reason = `event store unavailable: ${describe(error)}`
      this.state = { ...this.state, faults: [...this.state.faults, reason] }
      return this.status()
    }

    // Read the journal's condition *before* trusting anything in it. A corrupt
    // log still replays — the prefix is real — but it is not the whole truth,
    // and the Core below refuses to present it as though it were.
    this.integrity = describeRecovery(store)

    this.fabric = await EventFabric.open({ store, now: this.options.now, newId: this.options.newId })

    // Replayed once, deriving both state and activity from the same events in
    // the same order.
    //
    // Rebuilding the feed from the log rather than starting empty is what makes
    // a Core that has been running for a week still able to say what it did, and
    // it is why a renderer attaching late agrees with one that never left: there
    // is one function mapping an event to a row, whether it came off disk or off
    // the fabric.
    // Assigned, not appended to: `mergeActivity` is immutable, so discarding
    // its result would silently leave the replayed feed empty.
    let replayed: CoreActivityEvent[] = []
    this.state = await this.fabric.replay(initialCoreState(), (draft, event) => {
      const described = describeActivity({
        type: event.type,
        sequence: event.sequence,
        at: Date.parse(event.occurredAt),
        payload: event.payload as unknown as Record<string, unknown>,
      })
      if (described !== null) replayed = mergeActivity(replayed, [described])
      return reduceCoreState(draft, event)
    })
    this.activityFeed = replayed

    // Corruption found by *this* start, against corruption already recorded in
    // the journal. The second is what makes the fault survive: after recovery
    // truncated the damaged segment the file is clean, so only the durable
    // record distinguishes a repaired prefix from a prefix with a hole in it.
    if (this.integrity.integrity === 'corrupt') {
      const report = store instanceof JsonlEventStore ? store.recoveryReport() : null
      const reason = this.integrity.reason
      this.freshIntegrityFault = {
        reason,
        line: this.integrity.line ?? 1,
        quarantinePath:
          report?.quarantinePath ?? `${this.fabric.describe()}.quarantine-unrecorded`,
        trustedPrefixEvents: report?.eventsRead ?? 0,
        trustedPrefixBytes: this.fabric.lastSequence === 0 ? 0 : (report?.eventsRead ?? 0),
        damagedBytes: report?.bytesDiscarded ?? 0,
      }
    }

    if (this.state.integrityFault !== null) {
      const recorded = this.state.integrityFault
      this.integrity = {
        integrity: 'corrupt',
        reason: `${recorded.reason} (recorded in the journal; the damaged bytes are at ${recorded.quarantinePath})`,
        line: recorded.line,
        eventsRead: recorded.trustedPrefixEvents,
        bytesDiscarded: recorded.damagedBytes,
      }
    }

    this.guard = this.buildGuard()

    this.gateway = new ModelGateway({
      providers: this.buildProviders(),
      recorder: this.fabricRecorder(),
      now: this.options.now,
      // A request appearing in or leaving the registry is a change in what this
      // process is spending, and the status has to say so at the moment it
      // happens rather than whenever the next journal event happens to arrive.
      onActivityChange: () => this.notify(),
    })

    // A latch recovered from the journal is a stopped Core, and being stopped
    // includes the gateway refusing to contact anybody. Restoring permission only
    // where the latch is genuinely clear is what keeps a restarted, latched Core
    // from being one field away from spending money.
    if (this.state.stopAll.active) {
      this.gateway.cancelAll('STOP ALL was latched before this session started')
    }

    this.service = new CognitionService(
      {
        fabric: this.fabric,
        gateway: this.gateway,
        guard: this.guard,
        now: this.options.now,
        // The single switch that keeps a Core with an untrustworthy journal from
        // reaching a provider, whatever the replayed latch happens to say.
        journalTrustworthy: () => this.integrity.integrity !== 'corrupt',
      },
      this.state,
    )
    // The owner principal comes from the service, which is the only place in
    // Core that builds a trusted one.
    this.owner = this.service.ownerPrincipalFor()

    // Research, once an owner authority exists to issue its bounded grants. The
    // stack is opened here and never again: research starts only on an explicit
    // owner request, so boot does no network, browser or model work at all.
    if (this.options.research) {
      this.researchIntegration = new ResearchIntegration({
        searchProvider: this.options.research.searchProvider,
        browserFactory: this.options.research.browserFactory,
        authority: this.service.ownerAuthority(),
        guard: this.guard,
        principal: this.owner,
        stopped: () => this.state.stopAll.active || !this.gateway.gateStatus().open,
        closeAdmission: (reason) => this.closeResearch(reason),
        emit: async (type, payload) => {
          await this.fabric.append(type as never, payload as never, { actor: 'owner' })
        },
      })
      this.researchAdmissionOpen = true
    }

    // State follows the log, for both replay and live appends.
    //
    // Installed *before* anything else appends, deliberately. A subscription
    // registered after the Brain seeds itself would mean `brain.seeded` reached
    // the journal without ever reaching the activity feed — so a window open during
    // the first launch would disagree with a window that attached after a restart
    // and read the same log. Any event written before this line is a bug.
    this.disposeState = this.fabric.subscribe((event) => {
      this.state = reduceCoreState(this.state, event)
      this.recordActivity(event)
      this.observeAttentionSource(event)
      this.notify()
    })

    // Conversation and voice, built after the owner exists because the Mind needs
    // the owner's authority to create a turn's grant — and it must not be able to
    // have any other.
    this.conversationStore = await this.buildConversationStore()
    // The Brain is built before the Mind, and the Mind reads from it. A Brain that
    // cannot be opened still produces a Brain: it is ephemeral, it reports itself
    // as such, and every other subsystem carries on.
    const brainStore = await this.buildBrainStore()
    this.brainService = new Brain({
      store: brainStore,
      fabric: this.fabric,
      now: this.options.now,
      newId: this.options.newId,
    })
    // Only records the seeding when it actually happened. Re-announcing it on every
    // start would put a "seeded" event in the journal for a Brain that was seeded
    // weeks ago, and an audit reader would reasonably ask what it means that
    // Freya's identity is written down again each time she launches.
    const seeded = await this.brainService.seed({
      identity: buildIdentityRoot(),
      self: buildSelfDefinition(),
    })
    if (seeded) {
      const identity = buildIdentityRoot()
      const self = buildSelfDefinition()
      await this.fabric.append(
        'brain.seeded',
        {
          identityName: identity.name,
          identityClaimCount: identity.claims.length,
          capabilityCount: self.capabilities.length,
          limitationCount: self.limitations.length,
        },
        { actor: 'system' },
      )
    }
    // A Brain whose log could not be believed is reported once, in its own stream.
    // This is emphatically not a security event: it cannot grant cognition or clear
    // a stop, and it does not lock anything out either. See `SECURITY_EVENT_TYPES`.
    const brainHealth = this.brainService.health()
    if (brainHealth.health !== 'healthy') {
      this.state = {
        ...this.state,
        faults: [...this.state.faults, `the Brain is ${brainHealth.health}: ${brainHealth.reason ?? 'unknown reason'}`],
      }
      await this.fabric.append(
        'brain.degraded',
        { reason: brainHealth.reason ?? 'the Brain is not fully readable' },
        { actor: 'system' },
      )
    }
    this.mind = new MindService({
      fabric: this.fabric,
      store: this.conversationStore,
      authority: this.service.ownerAuthority(),
      gateway: this.gateway,
      now: this.options.now,
      newId: this.options.newId,
      budget: this.options.contextBudget,
      turnContext: (request) => {
        if (!request.conversationId || !this.contextIntegration) return null
        const source = this.contextIntegration.turnSource({
          scopeKind: 'conversation', scopeId: request.conversationId,
        })
        return bindTurnContext(source)(request)
      },
      // The conversation service is built after the Mind, so this resolves lazily
      // and is the only thing that couples the two. Without it a window would only
      // learn a turn had started after it had already finished.
      onTurnStateChange: () => this.conversations?.publish(),
      // The only fact about the outside world the Mind is told, and it is a fact
      // about Freya rather than about any provider.
      runtimeFacts: () => (this.state.stopAll.active ? ['Cognition is currently stopped.'] : []),
      // The owner's model selection, read per turn. The Mind cannot set it, the
      // renderer cannot put one in a turn payload, and the Gateway still asks the
      // Governor before anything is contacted — this only answers "which model,
      // if the owner named one" for a request that has already been allowed.
      selectedModel: () => this.selectedModel,
      // Read-only recall. The Mind asks; the Brain decides what is recallable. This
      // callback holds no store and no admission policy, so the request path
      // cannot widen what Freya remembers — and a turn never writes memory at all,
      // which is what keeps a prompt injection from becoming a durable fact.
      recall: (query) => this.recallReference(query),
      // Metadata only. The question and the answer are referenced by id and stay in
      // the encrypted conversation store.
      onTurnExperience: (experience) => this.recordTurnExperience(experience),
    })
    this.conversations = new ConversationService({
      fabric: this.fabric,
      store: this.conversationStore,
      mind: this.mind,
      gateway: this.gateway,
      now: this.options.now,
      newId: this.options.newId,
      cognitionAvailability: () => this.cognitionAvailability(),
      stopAll: () => ({
        active: this.state.stopAll.active,
        activatedAt: this.state.stopAll.activatedAt,
      }),
    })
    this.voiceService = new VoiceService({
      fabric: this.fabric,
      transcriber: this.options.voiceTranscriber,
      synthesizer: this.options.voiceSynthesizer,
      now: this.options.now,
      newId: this.options.newId,
    })

    /**
     * Work, built after the owner exists and after the state subscription, for two
     * reasons: the engine's authorizer closes over the owner principal, and any
     * event it appended before that subscription would reach the journal without
     * reaching the state — which is the disagreement between a window that attaches
     * after a restart and one that never left.
     *
     * The registry is the capability boundary, and Phase 6 populates it with inert
     * test capabilities only. Search, a browser, a terminal and an agent all
     * register here when they exist; nothing in `core/work/` names any of them, so
     * the engine can be proved without one.
     */
    this.workRegistry = new WorkRegistry()
    for (const capability of this.workCapabilities()) {
      this.workRegistry.register(capability)
    }
    registerPhaseSixCapabilities(this.workRegistry)
    this.workEngine = new WorkEngine({
      fabric: this.fabric,
      // The one place Work asks Guard anything. The owner principal is baked in
      // here in Core, so the engine holds no principal and cannot build one.
      authorizer: {
        evaluate: (capability) => this.guard.evaluate(this.owner, capability),
      },
      registry: this.workRegistry,
      principalId: this.owner.id,
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishWork(),
      // Read fresh at the moment of each decision, never copied into Work state.
      // A Run cannot be the one thing that keeps going after the panic button.
      stopAll: () => this.state.stopAll.active,
      stopAllReason: () =>
        this.state.stopAll.activatedBy === null
          ? 'Freya is stopped'
          : `Freya was stopped by ${this.state.stopAll.activatedBy}`,
    })
    await this.workEngine.open()

    // Missions sit above Work, so they are constructed after it and hold a read-only
    // view of it. The engine asks Work about a Run; Work never asks Missions about
    // anything, because Work has no field shaped like a Mission and this phase does
    // not give it one.
    this.missionEngine = new MissionEngine({
      fabric: this.fabric,
      store: await this.buildMissionStore(),
      work: this.workWorkPort(),
      principalId: this.owner.id,
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => {
        this.publishMission()
        this.syncContextMission()
      },
      // Read fresh at the moment of each decision. A Mission that could still be
      // activated after the panic button is a Mission that can go on creating work.
      stopAll: () => this.state.stopAll.active,
    })
    await this.missionEngine.open()

    // Context sits beside Missions rather than above them: it reads which Mission is
    // current and nothing else, and it is built here so the two are wired in one place.
    //
    // Recover through the separate secure persistence lifecycle before serving readers.
    // Context still owns no capture lane, authority, journal family or model.
    const recoveredContext = await ContextPersistenceRuntime.open({
      path: `${this.options.dataPath}.context.enc`,
      onHealthChange: () => this.publishContext(),
      key: this.options.contextKey ?? null,
      now: (this.options.now ?? (() => new Date()))(),
    })
    this.contextPersistence = recoveredContext.runtime
    this.contextIntegration = new ContextIntegration({
      ...this.contextOptions,
      initialRecords: recoveredContext.records,
      onChange: (records) => this.contextPersistence?.commit(records),
      persistenceHealth: () => recoveredContext.runtime.health(),
    })
    this.syncContextMission()
    await this.contextPersistence.flush()

    this.workforceEngine = new WorkforceEngine({
      fabric: this.fabric,
      core: {
        requestCognition: (workerId, intent) =>
          this.service.workerAuthority(workerPrincipalId(workerId)).request(intent),
        missionExists: (missionId) => this.missionEngine?.exists(missionId) === true,
      },
      principalId: this.owner.id,
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishWorkforce(),
      // Read fresh at the moment of each decision, never copied into worker state. An
      // agent that could start work after the panic button is an agent the button missed.
      stopAll: () => this.state.stopAll.active,
      limits: this.options.workforceLimits,
    })
    await this.workforceEngine.open()

    // The Workforce seam, if anything filled it.
    //
    // Subscribed here rather than in the constructor so a source that pushes
    // during boot cannot reach a listener set nobody has attached to yet, and
    // disposed in `stop()` so a source cannot outlive the Core reading it. A
    // source without `subscribe` is simply read again on the next attach.
    //
    // A filled seam is the read-only view #14 exposes; the engine above stays
    // the authoring half it cannot reach.
    this.disposeWorkforceSource =
      this.workforceSource?.subscribe?.(() => this.publishWorkforce()) ?? (() => {})

    // The Personality seam, on the same terms and for the same reason: subscribed
    // after boot has somewhere to publish to, disposed in `stop()` so a source
    // cannot outlive the Core reading it, and a source without `subscribe` is
    // simply read again the next time a window attaches.
    this.disposePersonalitySource =
      this.personalitySource?.subscribe?.(() => this.publishPersonality()) ?? (() => {})

    /**
     * Attention, built after every subsystem it reads for its focus signal.
     *
     * The engine holds the journal, the clock and the id factory, and nothing
     * else: no gateway, no authority, no provider. Its `focus` and `goalOpen`
     * callbacks read Core's already-authorized state, so attention introduces no
     * new surveillance primitive. `reconcile()` cancels any schedule recovered
     * from a previous process whose text did not survive, which is the same honesty
     * Work applies to an interrupted run.
     */
    this.attentionEngine = new AttentionEngine({
      fabric: this.fabric,
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishAttention(),
      focus: () => this.attentionFocus(),
      stopAll: () => this.state.stopAll.active,
      getState: () => this.state.attention,
      goalOpen: (goalRef) => this.attentionGoalOpen(goalRef),
    })
    await this.attentionEngine.reconcile()

    /**
     * Skills, built last, because they read Work.
     *
     * Two things are wired here and both are deliberate. The **encrypted body store**
     * is recovered before the engine adopts anything, and adoption is filtered against
     * the journal fold: a body the journal does not vouch for is discarded rather than
     * adopted, so a rewritten store file cannot introduce a skill Core never recorded.
     * The **Work port** is a four-method read port with no writes, no capability
     * request and no approval — a skill may ask whether a Run and a Step exist and
     * which capabilities that Run already holds, and that is all it may ask.
     *
     * Nothing here burns a model call, and nothing here is reachable from a renderer
     * except through the nine `skill.*` commands, each of which routes through the
     * admission, evaluation and promotion tables.
     */
    const recoveredSkills = await this.buildSkillPersistence()
    this.skillEngine = new SkillEngine({
      fabric: this.fabric,
      getState: () => this.state.skills,
      persistence: this.skillPersistence,
      registry: this.requireWorkRegistry(),
      work: this.skillWorkPort(),
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishSkills(),
      stopAll: () => this.state.stopAll.active,
    })
    await this.skillEngine.open(recoveredSkills)

    const recoveredSequence = this.fabric.lastSequence
    this.startedAt = (this.options.now ?? (() => new Date()))().toISOString()

    // A damaged journal is not a ready Core. The distinction is deliberate: a
    // torn tail is a crash and this is `ready`; corruption is something this
    // code did not write, and a Core that came up `ready` on it would be
    // reporting a security state assembled from a log with a hole in it.
    this.currentLifecycle = this.integrity.integrity === 'corrupt' ? 'degraded' : 'ready'

    await this.fabric.append(
      'core.started',
      {
        version: CORE_VERSION,
        storeKind: this.fabric.describe(),
        recoveredSequence,
      },
      { actor: 'system' },
    )

    // Fresh corruption is written into the trusted prefix before anything else,
    // so the damage is part of the journal rather than a fact that existed only
    // until this process exited. Recovery has already truncated the damaged
    // segment; without this the next start would read a clean file and come up
    // ready, with whatever followed the damage already discarded.
    if (this.freshIntegrityFault !== null) {
      await this.fabric.append(
        'core.integrity_fault',
        this.freshIntegrityFault,
        { actor: 'system' },
      )
      this.freshIntegrityFault = null
    }

    // Interrupted turns are recovered before `core.ready`, so a window that
    // attaches on a ready Core is never briefly shown a turn that was abandoned
    // by a previous process. Nothing is retried and nothing is spent: a question on
    // disk with no answer is the whole truth about a turn that did not finish.
    await this.conversations.recoverInterruptedTurns()

    // And interrupted Work, for the same reason and with the same honesty. A Run
    // the journal says was executing cannot be continued — its plan was in memory —
    // so it is recorded as failed with the reason stated, its pending approvals are
    // expired, and nothing is marked successful. History is not proof that
    // something is currently executing.
    await this.workEngine?.recoverInterruptedRuns()
    // Missions reconcile after Work has, because an expired Mission's Runs have to
    // already be settled before the Mission itself is concluded.
    this.publishMission()
    // And the workforce reconciles last of the three, because a `working` worker may hold
    // an assignment whose Run Work has just settled. Nothing is resumed and nothing is
    // marked successful: a worker's plan was in memory, so history is not proof of
    // execution.
    this.publishWorkforce()

    if (this.currentLifecycle === 'ready') {
      await this.fabric.append('core.ready', {}, { actor: 'system' })
    } else {
      // A `core.ready` here would be a lie in the durable record: this Core
      // cannot vouch for its own security state, and the journal has to say the
      // same thing a reader of the log will find.
      await this.fabric.append(
        'core.degraded',
        { reason: 'the event journal was found corrupt; see the preceding integrity fault' },
        { actor: 'system' },
      )
    }

    return this.status()
  }

  /**
   * Stop, in the only order that leaves an honest journal.
   *
   *   1. refuse everything new and abort what is already running;
   *   2. wait, briefly, for those requests to write their terminal events;
   *   3. write the two shutdown events;
   *   4. close the fabric, and with it the store.
   *
   * Step 2 is the one that is easy to get wrong. A cancelled request still owes
   * the journal an outcome, and closing the fabric first would leave it writing
   * into a closed store — so the process would record a cancellation, and then
   * record a failure for having failed to record a cancellation. The wait is
   * bounded because a provider that ignores its signal must not be able to hang
   * the application: if the bound is reached, shutdown continues and the journal
   * keeps the start with no finish, which is exactly what it would have said if
   * the process had died.
   */
  async stop(reason = 'shutdown'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.currentLifecycle = 'stopping'
    this.notify()

    const began = Date.now()
    try {
      // Research stops before anything else and without awaiting first, for the same
      // ordering reason as STOP ALL: a half-finished research job reaching the
      // network during shutdown is still a request.
      this.closeResearch(`core stopping: ${reason}`)
      if (this.fabric) {
        // A microphone must not outlive the Core that opened it.
        await this.voiceService?.abandon('the application is shutting down')
        this.gateway?.cancelAll(`core stopping: ${reason}`)
        await this.gateway?.drain(SHUTDOWN_DRAIN_MS)
        await this.fabric.append('core.stopping', { reason }, { actor: 'system' })
        await this.fabric.append(
          'core.stopped',
          { durationMs: Date.now() - began },
          { actor: 'system' },
        )
      }
    } finally {
      this.disposeState()
      this.disposeWorkforceSource()
      this.disposeWorkforceSource = () => {}
      this.disposePersonalitySource()
      this.disposePersonalitySource = () => {}
      this.service?.dispose()
      this.currentLifecycle = 'stopped'
      // Research is drained *before* the fabric closes, and on a bound: a browser
      // target or provider that ignores its signal must not be able to hang shutdown
      // forever. Bounded means the worst case is a job that never settled, which the
      // journal already describes honestly — the same record a crash would leave.
      await this.drainResearch()
      // Closed before the fabric, so the Brain's in-flight writes land while the
      // event stream that records them is still open. An experience record written
      // after its own journal event would be a record of something the log says
      // never happened.
      await this.brainService?.close()
      // Work is closed on the same terms, and for the same reason: a capability
      // still executing when the fabric closes would try to record its own outcome
      // into a closed store, producing a failure *for having failed to record*.
      // `close` aborts every live capability and waits for the loops to settle.
      await this.workEngine?.close()
      // A verifier still running at shutdown must not be able to write a completion
      // into a closed journal. Closing after Work is deliberate: the Mission may want
      // to consult a Run that Work has just finished recording.
      await this.missionEngine?.close()
      // Workforce closes after Missions and Work for the same ordering reason: a
      // reconciliation that had not finished would otherwise try to append into a
      // journal that is already closed, producing a failure *for having failed to
      // record* the shutdown.
      await this.workforceEngine?.close()
      await this.contextPersistence?.close()
      // Skills close on the same terms, and for the same reason: a body commit that
      // landed after its own journal event would be a record of something the log
      // says never happened. Ordered before the fabric closes for that reason.
      await this.skillPersistence?.close()
      await this.conversationStore?.close()
      await this.fabric?.close()
      this.notify()
    }
  }

  /**
   * Refuse a research command, or return null to allow it.
   *
   * Two refusals and they are different in kind. "Not configured" means the host
   * supplied no research stack, which is the normal state for a Core that was not
   * built with one. "Stopped" means the owner stopped Freya, and saying so plainly
   * matters more than a generic failure: the person pressed STOP ALL and then typed
   * a search, and being told "unknown command" would be a lie about what happened.
   */
  private refuseResearch(requestId: string): CoreCommandResult | null {
    if (this.researchIntegration === null) {
      return {
        requestId,
        ok: false,
        refusal: { reason: 'web search and research are not configured in this build' },
        research: { operation: 'refused', reason: 'web search and research are not configured in this build' },
      }
    }
    if (!this.researchAdmissionOpen || this.state.stopAll.active) {
      const reason = 'Freya is stopped. Every search, page read and research request is refused.'
      return { requestId, ok: false, refusal: { reason }, research: { operation: 'refused', reason } }
    }
    return null
  }

  /** The code-owned research ceilings, echoed so a window can show them. */
  private researchLimits(): ResearchCommandOutcome['limits'] {
    const { iterations, queries, results, pages, evidenceChars, durationMs, modelTurns, maxOutputTokens } =
      RESEARCH_LIMITS
    return { iterations, queries, results, pages, evidenceChars, durationMs, modelTurns, maxOutputTokens }
  }

  /**
   * Append one research stage event.
   *
   * `extra` is merged into the counters and may only contribute integers, so a
   * caller cannot smuggle a string into a payload the validator would reject — and
   * more importantly cannot smuggle one past a test that reads the journal.
   */
  private async emitResearch(
    type: string,
    operationId: string,
    stage: string,
    failureCode: string | null,
    extra: Readonly<Record<string, number>>,
  ): Promise<void> {
    try {
      await this.fabric.append(
        type as never,
        {
          operationId,
          sessionId: null,
          stage,
          counters: {
            iterations: 0,
            queries: 0,
            results: 0,
            pages: 0,
            evidenceChars: 0,
            modelTurns: 0,
            failures: failureCode === null ? 0 : 1,
            durationMs: 0,
            ...extra,
          },
          failureCode,
        } as never,
        { actor: 'owner' },
      )
    } catch (error) {
      // The journal records what happened; it is not the Brain's memory. Losing an
      // event must not lose the operation that produced it.
      console.error('[freya.core] a research event could not be recorded', describe(error))
    }
  }

  /**
   * A research failure as a closed public code.
   *
   * A provider, a page or a transport may throw anything at all, including text
   * carrying a credential or a filesystem path. `safeResearchError` reduces it to a
   * fixed message chosen by this repository, so nothing a third party said can reach
   * the renderer, the projection or the journal.
   */
  private researchFailure(
    requestId: string,
    operationId: string,
    startedEvent: string,
    error: unknown,
  ): CoreCommandResult {
    const safe = safeResearchError(error, 'provider_error')
    void this.emitResearch('research.failed', operationId, 'failed', safe.code, {})
    void startedEvent
    return {
      requestId,
      ok: false,
      refusal: { reason: safe.message },
      research: { operation: 'refused', reason: safe.message },
    }
  }

  /**
   * Close research admission and cancel everything in flight. Synchronous.
   *
   * Called by STOP ALL before its first await and by shutdown before anything is
   * awaited, because the property being defended is that no research operation can
   * *begin* a network, browser or model operation after a stop. Cancellation alone
   * would only interrupt what is already running.
   */
  private closeResearch(reason: string): void {
    this.researchAdmissionOpen = false
    // `cancelAll` aborts the coordinator's own controller; the integration also
    // closes managed browser sessions, whose windows must not outlive the process.
    this.researchIntegration?.closeAdmission(reason)
  }

  /** Wait for research to settle, on a bound. Never throws. */
  private async drainResearch(): Promise<void> {
    const integration = this.researchIntegration
    if (!integration) return
    await Promise.race([
      integration.coordinator.drain().catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, RESEARCH_DRAIN_MS)
        timer.unref?.()
      }),
    ]).catch(() => undefined)
    await integration.browser.closeAll().catch(() => undefined)
  }

  status(): CoreStatus {
    if (this.fabric === undefined || this.gateway === undefined) {
      // Booting or degraded: the log is not open, so there is nothing to derive.
      // Every fact that would require it stays null rather than being guessed.
      return degradedStatus(this.lifecycle, this.state, this.startedAt)
    }
    return projectCoreStatus({
      state: this.state,
      lifecycle: this.currentLifecycle,
      gateway: this.gateway,
      fabric: this.fabric,
      now: (this.options.now ?? (() => new Date()))(),
      startedAt: this.startedAt,
      integrity: this.integrity,
    })
  }

  activity(): CoreActivityEvent[] {
    return [...this.activityFeed]
  }

  onActivity(listener: (activity: CoreActivityEvent[]) => void): () => void {
    this.activityListeners.add(listener)
    try {
      listener([...this.activityFeed])
    } catch (error) {
      console.error('[freya.core] activity subscriber threw', error)
    }
    return () => {
      this.activityListeners.delete(listener)
    }
  }

  /**
   * Fold a durable event into the activity feed.
   *
   * Runs on the same subscription that reduces state, so the feed and the
   * projection are derived from the same event at the same moment and cannot
   * disagree about what happened.
   */
  private recordActivity(event: AnyCoreEvent): void {
    const described = describeActivity({
      type: event.type,
      sequence: event.sequence,
      at: Date.parse(event.occurredAt),
      payload: event.payload as unknown as Record<string, unknown>,
    })
    if (described === null) return
    this.activityFeed = mergeActivity(this.activityFeed, [described])
    for (const listener of [...this.activityListeners]) {
      try {
        listener([...this.activityFeed])
      } catch (error) {
        console.error('[freya.core] activity listener threw', error)
        this.activityListeners.delete(listener)
      }
    }
  }

  brain(): BrainProjection {
    // Booting or degraded, the Brain may not exist yet. A truthful empty projection
    // is returned rather than a throw: a surface must be able to render "no Brain
    // yet" during startup without having to special-case the failure.
    if (this.brainService === undefined) {
      return {
        health: 'unavailable',
        reason: 'the Brain is not available',
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
          withdrawn: 0,
          experiences: 0,
        },
        recentAdmissions: [],
        conflicts: [],
        sequence: 0,
      }
    }
    return this.brainService.projection()
  }

  onBrain(listener: (projection: BrainProjection) => void): () => void {
    this.brainListeners.add(listener)
    // Delivered immediately, like every other subscription here, so a window that
    // attaches late agrees with one that never left.
    try {
      listener(this.brain())
    } catch (error) {
      console.error('[freya.core] Brain subscriber threw', error)
    }
    return () => {
      this.brainListeners.delete(listener)
    }
  }

  /** Re-publish the Brain mirror. Called when the Brain's own state changes. */
  private publishBrain(): void {
    if (this.brainListeners.size === 0) return
    const projection = this.brain()
    for (const listener of [...this.brainListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Brain listener threw', error)
        this.brainListeners.delete(listener)
      }
    }
  }

  /**
   * The Workforce projection, and its mirror.
   *
   * Same semantics as every other projection here: Core built it, a listener cannot
   * write a field of it, and it is delivered on attach so a surface that reloads knows
   * where it stands.
   *
   * One source of truth, three honest readings:
   *
   *   - the `WorkforceSource` seam is filled, so what it reports is served
   *     verbatim — a source is read, never instructed;
   *   - no seam, and Core's own Workforce engine holds the domain, so its
   *     projection IS what the seam would have reported — no second, parallel
   *     state is kept anywhere; an engine whose fold is still empty reports the
   *     same reading the seam would, in the same words, because at that point
   *     "no worker or team exists" is still the whole truth;
   *   - a source that threw, so an `unavailable` reading that says the read
   *     failed, rather than a stale one that says everything is fine.
   */
  workforce(): WorkforceMirror {
    if (this.workforceSource !== null) {
      try {
        return this.workforceSource.projection() as WorkforceMirror
      } catch (error) {
        return {
          ...ABSENT_WORKFORCE_MIRROR,
          reason: `the Workforce domain could not be read: ${describe(error)}`,
        } as WorkforceMirror
      }
    }
    if (this.workforceEngine === undefined) {
      return {
        ...ABSENT_WORKFORCE_PROJECTION,
        reason: 'the Workforce engine is not available',
      } as WorkforceMirror
    }
    const projection = this.workforceEngine.projection()
    if (projection.sequence === 0) {
      return {
        ...ABSENT_WORKFORCE_MIRROR,
        reason: NO_WORKFORCE_DOMAIN_REASON,
      } as WorkforceMirror
    }
    return projection as WorkforceMirror
  }

  onWorkforce(listener: (projection: WorkforceMirror) => void): () => void {
    this.workforceListeners.add(listener)
    // Delivered immediately, like every other subscription here, so a window
    // that attaches late agrees with one that never left.
    try {
      listener(this.workforce())
    } catch (error) {
      console.error('[freya.core] Workforce subscriber threw', error)
    }
    return () => {
      this.workforceListeners.delete(listener)
    }
  }

  async workforceDetail(workerId: string): Promise<WorkforceWorkerDetail | null> {
    if (this.workforceEngine === undefined) return null
    return await this.workforceEngine.detail(workerId)
  }

  private publishWorkforce(): void {
    if (this.workforceListeners.size === 0) return
    const projection = this.workforce()
    for (const listener of [...this.workforceListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Workforce listener threw', error)
        this.workforceListeners.delete(listener)
      }
    }
  }

  private requireWorkforce(): WorkforceEngine {
    if (this.workforceEngine === undefined) {
      throw new Error('the Workforce engine is not available')
    }
    return this.workforceEngine
  }

  /**
   * The Personality projection, and its two honest readings.
   *
   *   - the `personalitySource` seam is filled, so what it reports is served
   *     verbatim — a source is read, never instructed, and this accessor has no
   *     argument for it to be instructed *with*;
   *   - no seam, which is every build in this repository until relationship
   *     persistence exists, so `NO_PERSONALITY_DOMAIN_REASON` and an
   *     `unavailable` projection — "no relationship record exists, and none is
   *     simulated" rather than a warm, empty relationship;
   *   - a source that threw, so an `unavailable` reading that says the read
   *     failed instead of a stale one that says everything is fine.
   */
  personality(): PersonalityProjection {
    if (this.personalitySource === null) {
      return { ...ABSENT_PERSONALITY_PROJECTION, reason: NO_PERSONALITY_DOMAIN_REASON }
    }
    try {
      return this.personalitySource.projection()
    } catch (error) {
      return {
        ...ABSENT_PERSONALITY_PROJECTION,
        reason: `the Personality domain could not be read: ${describe(error)}`,
      }
    }
  }

  onPersonality(listener: (projection: PersonalityProjection) => void): () => void {
    this.personalityListeners.add(listener)
    // Delivered immediately, like every subscription here, so a window that
    // attaches late agrees with one that never left — including on the honest
    // sentence a build with no Personality domain reports.
    try {
      listener(this.personality())
    } catch (error) {
      console.error('[freya.core] Personality subscriber threw', error)
    }
    return () => {
      this.personalityListeners.delete(listener)
    }
  }

  private publishPersonality(): void {
    if (this.personalityListeners.size === 0) return
    const projection = this.personality()
    for (const listener of [...this.personalityListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Personality listener threw', error)
        this.personalityListeners.delete(listener)
      }
    }
  }

  /**
   * The Attention projection, and its mirror.
   *
   * A Core that has not started reports `unavailable` with
   * `NO_ATTENTION_DOMAIN_REASON`, which is different from `ready` with zero
   * counts: "nothing needs attention" and "nothing is watching" must not look the
   * same. Once started, the engine is the source of truth and this accessor reads
   * it; there is no argument here through which a caller could instruct it.
   */
  attention(): AttentionProjection {
    if (this.attentionEngine === undefined) {
      return { ...ABSENT_ATTENTION_PROJECTION, reason: NO_ATTENTION_DOMAIN_REASON }
    }
    try {
      return this.attentionEngine.projection()
    } catch (error) {
      return {
        ...ABSENT_ATTENTION_PROJECTION,
        reason: `the Attention domain could not be read: ${describe(error)}`,
      }
    }
  }

  onAttention(listener: (projection: AttentionProjection) => void): () => void {
    this.attentionListeners.add(listener)
    // Delivered immediately, like every subscription here, so a window that
    // attaches late agrees with one that never left.
    try {
      listener(this.attention())
    } catch (error) {
      console.error('[freya.core] Attention subscriber threw', error)
    }
    return () => {
      this.attentionListeners.delete(listener)
    }
  }

  skills(): SkillProjection {
    if (this.skillEngine === undefined) {
      return { ...ABSENT_SKILL_PROJECTION, reason: NO_SKILL_DOMAIN_REASON }
    }
    try {
      return this.skillEngine.projection()
    } catch (error) {
      return {
        ...ABSENT_SKILL_PROJECTION,
        reason: `the Skill domain could not be read: ${describe(error)}`,
      }
    }
  }

  onSkills(listener: (projection: SkillProjection) => void): () => void {
    this.skillListeners.add(listener)
    try {
      listener(this.skills())
    } catch (error) {
      console.error('[freya.core] Skills subscriber threw', error)
      this.skillListeners.delete(listener)
    }
    return () => {
      this.skillListeners.delete(listener)
    }
  }

  private publishSkills(): void {
    if (this.skillListeners.size === 0) return
    const projection = this.skills()
    for (const listener of [...this.skillListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Skills listener threw', error)
        this.skillListeners.delete(listener)
      }
    }
  }

  /**
   * Evaluate `skill.manage` for the owner and record the decision, or answer the
   * refusal.
   *
   * Guard runs before any skill code, and the decision is journalled like every other
   * capability evaluation — so a refused skill mutation appears in the audit stream
   * rather than only in the caller's return value, and a Guard rule can be withdrawn
   * later with the evidence still there.
   */
  private async guardSkill(requestId: string): Promise<CoreCommandResult | null> {
    const decision = this.guard.evaluate(this.owner, 'skill.manage')
    if (decision.allowed) return null
    await this.recordGuard(decision, this.owner.id, 'skill.manage', requestId)
    return this.skillRefusal(requestId, 'no-model-calls', decision.reason)
  }

  /**
   * A skill command's answer, in the one shape a surface has to render.
   *
   * `ok: false` on the envelope as well as in the Skills slot, for the same reason
   * `workRefusal` and `missionRefusal` both set it: a window that only read the
   * envelope would otherwise render a refusal as a success, which is the failure this
   * slot exists to prevent.
   */
  private skillResult(requestId: string, outcome: SkillCommandOutcome): CoreCommandResult {
    return {
      requestId,
      ok: outcome.ok,
      status: outcome.ok ? this.status() : undefined,
      refusal: outcome.ok ? undefined : { reason: outcome.reason ?? 'this skill command was refused' },
      skill: outcome,
    }
  }

  /** A refusal Core produced itself, with no engine round trip. */
  private skillRefusal(
    requestId: string,
    code: SkillCommandOutcome['code'],
    reason: string,
  ): CoreCommandResult {
    return {
      requestId,
      ok: false,
      refusal: { reason },
      skill: { operation: 'refused', ok: false, code, reason },
    }
  }

  private publishAttention(): void {
    if (this.attentionListeners.size === 0) return
    const projection = this.attention()
    for (const listener of [...this.attentionListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Attention listener threw', error)
        this.attentionListeners.delete(listener)
      }
    }
  }

  async attentionTick(now?: Date): Promise<number> {
    if (this.attentionEngine === undefined) return 0
    return await this.attentionEngine.tick(now)
  }

  private requireAttention(): AttentionEngine {
    if (this.attentionEngine === undefined) {
      throw new Error('the Attention engine is not available')
    }
    return this.attentionEngine
  }

  /**
   * The focus reading, from state Core already holds.
   *
   * There is no new sensor here. `focused` means Freya is spending on the owner's
   * behalf right now (a provider call is in flight) or a Run is executing; nothing
   * else is claimed. A booting Core says `unknown` rather than guessing `available`.
   */
  private attentionFocus(): FocusState {
    if (this.currentLifecycle === 'booting' || this.gateway === undefined) return 'unknown'
    if (this.gateway.activeCallCount() > 0) return 'focused'
    const snapshot = this.workEngine?.snapshot()
    if (snapshot !== undefined) {
      for (const run of snapshot.runs.values()) {
        if (run.status === 'running') return 'focused'
      }
    }
    return 'available'
  }

  /**
   * Whether a referenced goal is still open, from Core's own Mission/Work state.
   *
   * A schedule's `goal-open` condition reads only this. It does not consult the
   * event's text, a model or anything outside Core, so a schedule cannot wait on a
   * condition it invented.
   */
  private attentionGoalOpen(goalRef: string): boolean {
    if (this.missionEngine?.exists(goalRef) === true) return true
    const snapshot = this.workEngine?.snapshot()
    if (snapshot !== undefined) {
      const run = snapshot.runs.get(goalRef)
      if (run !== undefined && !isTerminalRunStatus(run.status)) return true
    }
    return false
  }

  /**
   * Deliver a Core-owned subsystem's terminal event to attention, when composed on.
   *
   * The delivery is fire-and-forget: the subscriber must not `await` an append, for
   * the fabric's ordering rule. The source is a closed id passed here, never read
   * from the event, and the text is a fixed sentence generated by this code — never
   * anything a capability returned. Dedupe keys on the run/mission/operation id, so
   * a recovered or re-delivered event produces no second decision.
   */
  private observeAttentionSource(event: AnyCoreEvent): void {
    if (this.attentionEngine === undefined || this.options.attentionObserveSources !== true) return
    switch (event.type) {
      case 'work.run.completed':
        void this.attentionEngine.ingestInternal('work', {
          kind: 'work-finished',
          text: 'A run finished.',
          sourceRef: event.payload.runId,
        })
        break
      case 'work.run.failed':
        void this.attentionEngine.ingestInternal('work', {
          kind: 'work-failed',
          text: 'A run failed.',
          sourceRef: event.payload.runId,
        })
        break
      case 'mission.completed':
        void this.attentionEngine.ingestInternal('mission', {
          kind: 'mission-finished',
          text: 'A mission was completed.',
          goalRef: event.payload.missionId,
          sourceRef: event.payload.missionId,
        })
        break
      case 'mission.failed':
        void this.attentionEngine.ingestInternal('mission', {
          kind: 'mission-failed',
          text: 'A mission was not achieved.',
          goalRef: event.payload.missionId,
          sourceRef: event.payload.missionId,
        })
        break
      case 'research.completed':
        void this.attentionEngine.ingestInternal('research', {
          kind: 'research-finished',
          text: 'Research completed.',
          sourceRef: event.payload.operationId,
        })
        break
      case 'research.failed':
        void this.attentionEngine.ingestInternal('research', {
          kind: 'research-finished',
          text: 'Research did not complete.',
          sourceRef: event.payload.operationId,
        })
        break
      default:
        break
    }
  }

  /**
   * The Work projection.
   *
   * A mirror like the others. A window holds what Core last built and cannot write
   * to it, which is the whole of what "the renderer is a projection" means for
   * execution state: reloading a window re-reads this, and the work it describes
   * keeps running either way.
   */
  work(): WorkProjection {
    // Booting or degraded the engine may not exist yet. A truthful empty
    // projection rather than a throw, matching `brain()`: a board has to be able
    // to say "Core is not up" without special-casing the failure.
    if (this.workEngine === undefined) {
      return {
        ...ABSENT_WORK_PROJECTION,
        reason: 'the Work engine is not available',
      }
    }
    return this.workEngine.projection()
  }

  onWork(listener: (projection: WorkProjection) => void): () => void {
    this.workListeners.add(listener)
    // Delivered immediately, like every other subscription here, so a window that
    // attaches late agrees with one that never left.
    try {
      listener(this.work())
    } catch (error) {
      console.error('[freya.core] Work subscriber threw', error)
    }
    return () => {
      this.workListeners.delete(listener)
    }
  }

  /** Re-publish the Work mirror. Called when Work's own state changes. */
  private publishWork(): void {
    if (this.workListeners.size === 0) return
    const projection = this.work()
    for (const listener of [...this.workListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Work listener threw', error)
        this.workListeners.delete(listener)
      }
    }
  }

  /** The Work engine, refusing rather than throwing on a command. */
  /**
   * The read-only view of Work that Missions are given.
   *
   * Narrower than `WorkEngine` on purpose: Missions may consult a Run and may stop
   * one, and nothing else. Handing over the engine itself would let a Mission create
   * Runs, decide approvals, or move tasks — none of which a persistent outcome has any
   * business doing. The Mission is the *reason* for the Run, never its author.
   */
  private workWorkPort(): WorkPort {
    const engine = this.requireWork()
    return {
      run: (runId) => {
        const state = engine.snapshot()
        return state.runs.get(runId)
      },
      // `runSteps` holds ids in planned order; `steps` holds the records. Both are
      // needed, because the order is what "every step" means and the records are what
      // carry each step's verification verdict.
      stepsOf: (runId) => {
        const state = engine.snapshot()
        const ordered = state.runSteps.get(runId) ?? []
        const steps: StepRecord[] = []
        for (const stepId of ordered) {
          const step = state.steps.get(stepId)
          if (step !== undefined) steps.push(step)
        }
        return steps
      },
      isSettled: (status) => isTerminalRunStatus(status),
      pauseRun: async (runId, reason) => (await engine.pauseRun(runId, reason)).ok,
      cancelRun: async (runId, reason) => (await engine.cancelRun(runId, reason)).ok,
    }
  }

  async missionDetail(missionId: string): Promise<MissionDetail | null> {
    if (this.missionEngine === undefined) return null
    return await this.missionEngine.detail(missionId)
  }

  mission(): MissionProjection {
    if (this.missionEngine === undefined) {
      return {
        ...ABSENT_MISSION_PROJECTION,
        persistence: { mode: 'ephemeral', durable: false, reason: 'Missions are not available' },
      }
    }
    return this.missionEngine.projection()
  }

  onMission(listener: (projection: MissionProjection) => void): () => void {
    this.missionListeners.add(listener)
    listener(this.mission())
    return () => {
      this.missionListeners.delete(listener)
    }
  }

  private publishMission(): void {
    if (this.missionListeners.size === 0) return
    const projection = this.mission()
    for (const listener of [...this.missionListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Mission listener threw', error)
        this.missionListeners.delete(listener)
      }
    }
  }

  /**
   * Point "here" at the current Mission, if there is one.
   *
   * The narrow adapter, called whenever the Mission board moves. Which Mission is
   * *current* is the only thing read across — an id and a status — because that is
   * all a Mission's open record carries; its title, intent and success criteria live
   * in an encrypted store this deliberately cannot read, and admitting them here
   * would copy private Mission wording into another domain unnecessarily.
   *
   * Idempotent, so a Mission board that re-renders cannot churn context ids. "Which
   * Mission is active" is the read; "everything about the current Mission" is not,
   * and this is the line.
   */
  private syncContextMission(): void {
    if (this.contextIntegration === undefined || this.missionEngine === undefined) return
    const active = this.missionEngine
      .projection()
      .missions.filter((mission) => mission.status === 'active')
      // The board is sorted most-recent-first, so the head is the newest active
      // Mission. Two active Missions at once is a state the Mission engine does not
      // produce, and picking by recency is a tie-break that can be read, not guessed.
      .at(0)
    if (active === undefined) {
      this.contextIntegration.syncMissionContext(null)
      this.publishContext()
      return
    }
    const outcome = this.contextIntegration.syncMissionContext({
      missionId: active.missionId,
      status: active.status,
    })
    if (outcome.operation !== 'unchanged') this.publishContext()
  }

  /**
   * Core's account of context.
   *
   * Reachable before `start()` finishes, where it reports an empty projection with a
   * stated reason rather than throwing — the same treatment Work gets, so a surface
   * can render "Core is not up yet" during startup without special-casing the failure.
   *
   * Metadata only, and filtered to the active scope. A window learns which ids exist,
   * in which scope, from which source, in what state, and how long they last. It does
   * not learn a word of what was shared, and it cannot ask: there is no command in the
   * vocabulary that returns an item.
   */
  context(): ContextProjectionView {
    if (this.contextIntegration === undefined) {
      return {
        persistence: { mode: 'ephemeral', durable: false, reason: 'context is not available until Core has started' },
        activeScope: null,
        declaredScopes: [],
        agentContext: {
          wired: false,
          available: false,
          reason: NO_ACTIVE_AGENT_CONTEXT_REASON,
        },
        items: [],
        counts: { live: 0, revoked: 0, expired: 0, retained: 0, declaredScopes: 0 },
        limits: { maxItems: 0, maxLivePerScope: 0, maxScopes: 0 },
        sequence: 0,
      }
    }
    return this.contextIntegration.read()
  }

  onContext(listener: (projection: ContextProjectionView) => void): () => void {
    this.contextListeners.add(listener)
    // Delivered immediately, like every other mirror here, so a window that attaches
    // late agrees with one that never left.
    try {
      listener(this.context())
    } catch (error) {
      console.error('[freya.core] Context subscriber threw', error)
    }
    return () => {
      this.contextListeners.delete(listener)
    }
  }

  /**
   * Re-publish the Context mirror.
   *
   * Called after every operation that could change what is held. A listener that
   * throws is dropped rather than allowed to break the operation that reported the
   * change — observability must not become a resource owner.
   */
  private publishContext(): void {
    if (this.contextListeners.size === 0) return
    const projection = this.context()
    for (const listener of [...this.contextListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Context listener threw', error)
        this.contextListeners.delete(listener)
      }
    }
  }

  private requireMission(): MissionEngine {
    if (this.missionEngine === undefined) {
      throw new Error('the Mission engine is not available')
    }
    return this.missionEngine
  }

  /**
   * The Context integration, or a refusal rather than a throw.
   *
   * The other `require*` helpers throw because reaching them without the subsystem
   * would be a Core bug. This one returns, because a command can arrive before
   * `start()` has built the integration, and answering that with a stack trace
   * would turn an ordinary race into something a person sees.
   */
  contextWindowLane(scope: ContextScopeRef): ActiveWindowAdmissionLane {
    const owned = new Set<string>()
    const integration = this.requireContext()
    if (scope.scopeKind !== 'session') integration?.activateScope(scope)
    const publish = () => {
      this.publishContext()
      void this.contextPersistence?.flush().then(() => this.publishContext())
    }
    return {
      admitHostReport: (report: ContextHostReport) => {
        if (!integration || scope.scopeKind === 'session' || report.kind !== 'active_window' ||
            report.scope.scopeKind !== scope.scopeKind || report.scope.scopeId !== scope.scopeId) {
          return contextRefusal('scope_not_requestable')
        }
        const outcome = integration.admitHostReport(report)
        if (outcome.ok && outcome.contextId) owned.add(outcome.contextId)
        publish()
        return outcome
      },
      revoke: (contextId, reason) => {
        if (!integration || !owned.delete(contextId)) return contextRefusal('malformed_request')
        const outcome = integration.revoke(contextId, reason)
        publish()
        return outcome
      },
    }
  }

  private requireContext(): ContextIntegration | null {
    return this.contextIntegration ?? null
  }

  /**
   * Hand one Context command to the facade and render what it says.
   *
   * The facade does the deciding — provenance, scope, the field allowlist, which of
   * the five refusals a resolution was — and this method's only job is to read named
   * fields off an untrusted payload so the facade can refuse the rest. Notably absent
   * from this list: `source`, `principal`, `authority`, `capability`, `grant`. They
   * are not read here because reading them is half of accepting them, and the facade
   * refuses them by name when it finds them on the object.
   *
   * Returns `null` only when there is no integration at all, which the caller turns
   * into an envelope-level rejection.
   */
  private contextCommand(
    command: CoreCommandName,
    payload: unknown,
    integration: ContextIntegration | null,
  ): ContextCommandOutcome {
    if (integration === null) {
      return contextRefusal('malformed_request', 'context is not available until Core has started')
    }
    const fields = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}

    if (command === 'context.status.read') {
      // Same mirror discipline as the Workforce read: the *outcome* is on the command
      // and the projection arrives on its own channel. The `context?` slot carries what
      // one command produced and is deliberately not a second copy of the board, for
      // the same reason every other subsystem's is a slot rather than a widened
      // `status` — a projection that travelled inside a security status would be
      // copied and cached wherever status is, and this one describes what a person
      // selected.
      return { operation: 'status', ok: true }
    }
    if (command === 'context.scope.activate') {
      // A malformed scope is refused, not read as "clear the current one". `null` is
      // the honest way to say nothing is current and it comes from Core's own code
      // calling the facade directly; a payload with no usable scope is a broken
      // request, and silently treating it as a reset would hand anyone who could
      // send an empty object the ability to unscope every conversation in Core.
      const scope = readContextScope(fields.scope)
      if (scope === null) return contextRefusal('scope_unknown')
      return integration.activateScope(scope)
    }
    if (command === 'context.admit') {
      // The whole payload, not named fields. The facade is the parser: an allowlist
      // only refuses what it recognises, so this must not arrive pre-filtered.
      return integration.admit(payload)
    }
    if (command === 'context.revoke') {
      return integration.revoke(readString(payload, 'contextId') ?? '', readString(payload, 'reason') ?? '')
    }
    if (command === 'context.revokeScope') {
      const scope = readContextScope(fields.scope)
      if (scope === null) return contextRefusal('scope_unknown')
      return integration.revokeScope(scope, readString(payload, 'reason') ?? '')
    }
    // `context.reference.read`. Metadata resolution: ids and closed reasons, never
    // the item. The content-bearing `resolve` is deliberately not reachable from here.
    const term = readString(payload, 'term')
    const kind = readString(payload, 'kind')
    return integration.resolveMetadata({
      term: (term === null ? '' : term) as ContextReference['term'],
      kind: kind as ContextReference['kind'],
    })
  }

  private requireWork(): WorkEngine {
    if (this.workEngine === undefined) {
      throw new Error('the Work engine is not available')
    }
    return this.workEngine
  }

  private requireWorkRegistry(): WorkRegistry {
    if (this.workRegistry === undefined) {
      throw new Error('the Work registry is not available')
    }
    return this.workRegistry
  }

  private requireSkills(): SkillEngine {
    if (this.skillEngine === undefined) {
      throw new Error('the Skill engine is not available')
    }
    return this.skillEngine
  }

  /**
   * Recover the encrypted Skill store, or degrade in words.
   *
   * A store that cannot be opened is **not** silently replaced with an ephemeral one:
   * that would report `mode: 'ephemeral'` for a file that exists, and a surface would
   * say "procedures will not be remembered" when the truth is "the file is damaged
   * and Freya stopped trusting it". So the runtime records a fault, the projection
   * reports `durable: false` with that reason, and no body is adopted — which means
   * nothing can be planned into a Run from a procedure Core cannot read.
   */
  private async buildSkillPersistence(): Promise<readonly SkillRecordShape[]> {
    const path = `${this.options.dataPath}.skills.enc`
    try {
      const opened = await SkillPersistenceRuntime.open({
        path,
        key: this.options.skillKey ?? null,
        onHealthChange: () => this.publishSkills(),
      })
      this.skillPersistence = opened.runtime
      return opened.bodies
    } catch (error) {
      console.error('[freya.core] encrypted Skill store unavailable', describe(error))
      this.skillPersistence = undefined
      return []
    }
  }

  /**
   * The narrow read port Skills have on Work.
   *
   * Four lookups and no writes — which is the point. `runCapabilities` answers what
   * the Run *already holds*: it maps each planned step's registered capability to the
   * Guard capability that capability declares, which is exactly the set Guard will
   * evaluate again before anything executes. There is no `requestCapability`, no
   * `grant` and no `approve` on this object, so a skill cannot widen what it will be
   * allowed to do; it can only discover what it was already planned with.
   */
  private skillWorkPort(): SkillExecutionPort {
    const engine = this.workEngine
    const registry = this.workRegistry
    return {
      missionExists: (missionId) => this.missionEngine?.exists(missionId) === true,
      runExists: (runId) => {
        if (engine === undefined) return false
        return engine.snapshot().runs.has(runId)
      },
      runState: (runId) => {
        if (engine === undefined) return 'missing'
        const run = engine.snapshot().runs.get(runId)
        if (run === undefined) return 'missing'
        return isTerminalRunStatus(run.status) ? 'terminal' : 'running'
      },
      stepExists: (runId, stepId) => {
        if (engine === undefined) return false
        const state = engine.snapshot()
        return (state.runSteps.get(runId) ?? []).includes(stepId) && state.steps.has(stepId)
      },
      runCapabilities: (runId) => {
        if (engine === undefined || registry === undefined) return []
        const state = engine.snapshot()
        const held = new Set<Capability>()
        for (const stepId of state.runSteps.get(runId) ?? []) {
          const step = state.steps.get(stepId)
          if (step === undefined) continue
          const capability = registry.capability(step.capability)
          if (capability === undefined) continue
          held.add(capability.capability)
        }
        return [...held]
      },
    }
  }

  /**
   * A refused Work command, in the one shape a surface has to render.
   *
   * `ok: false` on the envelope with a `refusal`, *and* a Work result — because a
   * board that only reads `refusal` has to special-case Work, and a Work result
   * that only appeared on success would leave the failure path unexplained. The
   * same shape therefore arrives either way, which is also how a caller cannot
   * tell a refusal from a crash by its shape.
   */
  /**
   * A refused Mission command.
   *
   * `ok: false` on the envelope as well as in the Mission slot. A window that only
   * read the envelope would otherwise report a refusal as a success, which is the
   * same reasoning that makes `workRefusal` set both.
   */
  private missionRefusal(
    requestId: string,
    operation: string,
    reason: string,
  ): CoreCommandResult {
    return {
      requestId,
      ok: false,
      refusal: { reason },
      mission: { operation, ok: false, reason },
    }
  }

  private workRefusal(
    requestId: string,
    operation: string,
    reason: string,
  ): CoreCommandResult {
    return {
      requestId,
      ok: false,
      refusal: { reason },
      work: { operation, ok: false, reason },
    }
  }

  /**
   * Extra capabilities to register beyond Phase 6's inert test set.
   *
   * The seam Phase 5 and Phase 7 attach through: a Searcher, a browser, an agent
   * or a Mission arrives by being registered here and by nothing else. There is no
   * Work-side branch to add, no engine edit, and no second execution path.
   */
  private workCapabilities(): readonly WorkCapability[] {
    return this.options.workCapabilities ?? []
  }

  subscribe(listener: (status: CoreStatus) => void): () => void {
    this.listeners.add(listener)
    // A subscriber receives the current projection immediately, so a renderer
    // that reconnects never has to wait for the next change to know where it is.
    try {
      listener(this.status())
    } catch (error) {
      console.error('[freya.core] status subscriber threw', error)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  async handleCommand(envelope: CoreCommandEnvelope): Promise<CoreCommandResult> {
    if (this.lifecycle === 'degraded' || this.fabric === undefined) {
      return reject(envelope, 'core is degraded and cannot serve commands')
    }
    // Everything crossing this boundary is untrusted, whatever it claims.
    if (typeof envelope !== 'object' || envelope === null) {
      return reject(envelope, 'malformed command')
    }
    const { command, requestId } = envelope
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return reject(envelope, 'malformed request id')
    }

    // Once shutdown has started, no command is allowed to reopen execution or
    // mutate durable state. Status is still readable so the shell can report
    // what is happening while the process is winding down.
    if (
      (this.lifecycle === 'stopping' || this.lifecycle === 'stopped') &&
      command !== 'core.status.read' &&
      command !== 'security.status.read' &&
      command !== 'cognition.status.read' &&
      command !== 'voice.status.read' &&
      command !== 'brain.status.read' &&
      command !== 'work.status.read' &&
      command !== 'workforce.status.read' &&
      command !== 'mission.status.read' &&
      command !== 'context.status.read' &&
      command !== 'context.reference.read' &&
      command !== 'attention.status.read' &&
      command !== 'attention.inbox.read'
    ) {
      return reject(envelope, `core is ${this.lifecycle} and cannot accept mutating commands`)
    }

    try {
      switch (command) {
        case 'core.status.read':
          return { requestId, ok: true, status: this.status() }

        case 'security.status.read':
          return { requestId, ok: true, status: this.status() }

        case 'cognition.status.read':
          return { requestId, ok: true, status: this.status() }

        case 'core.command.submit': {
          const text = readString(envelope.payload, 'text')
          if (text === null) return { requestId, ok: false, refusal: { reason: 'command text is missing' } }
          if (text.length > 4000) return { requestId, ok: false, refusal: { reason: 'command text is too long' } }

          // The renderer is not trusted to be the owner; the bridge asserts an
          // identity and Guard decides what it may do.
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }

          // Durable first, and deliberately thin: the journal records that a
          // command of this length arrived, not what it said. The renderer
          // learns this happened because Core said so, not because the UI
          // assumed it.
          const commandId = this.newId()
          const event = await this.fabric.append(
            'command.received',
            {
              commandId,
              contentLength: text.length,
              source: readString(envelope.payload, 'origin') ?? 'command-bar',
            },
            { actor: 'owner', correlationId: requestId, source: 'renderer' },
          )
          return {
            requestId,
            ok: true,
            status: this.status(),
            // Proof it is durable, not a UI animation.
            durableSequence: event.sequence,
          }
        }

        case 'cognition.grant.create': {
          // The principal is *this* one. A `createdBy` in the payload is not
          // merely ignored: it is not read at all, so there is no code path
          // that could honour a forged author.
          const spec = readGrantSpec(envelope.payload)
          if (spec === null) {
            return { requestId, ok: false, refusal: { reason: 'grant spec is malformed' } }
          }
          try {
            await this.ownerAuthority.createGrant(spec)
            return { requestId, ok: true, status: this.status() }
          } catch (error) {
            return {
              requestId,
              ok: false,
              refusal: { reason: describe(error) },
            }
          }
        }

        case 'cognition.grant.revoke': {
          const grantId = readString(envelope.payload, 'grantId')
          if (grantId === null) {
            return { requestId, ok: false, refusal: { reason: 'grantId is missing' } }
          }
          const reason = readString(envelope.payload, 'reason') ?? 'revoked by owner'
          const revoked = await this.ownerAuthority.revokeGrant(grantId, reason)
          return revoked
            ? { requestId, ok: true, status: this.status() }
            : { requestId, ok: false, refusal: { reason: 'no such grant, or already revoked' } }
        }

        case 'security.stopAll': {
          const decision = this.guard.evaluate(this.owner, 'security.stop')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'security.stop', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          if (this.state.stopAll.active) {
            return { requestId, ok: true, status: this.status() }
          }
          const reason = readString(envelope.payload, 'reason') ?? 'requested by owner'

          // The gateway is closed *before* the latch is written, and in the same
          // synchronous turn as the decision to stop.
          //
          // Ordering it the other way round would leave a window where the
          // request had been authorised, the stop was on its way to disk, and a
          // provider could still be contacted. That window is exactly the race
          // this exists to make impossible, so the cheaper half happens first:
          // closing the gate costs nothing and can be undone, whereas a provider
          // call cannot be un-spent.
          this.gateway?.cancelAll(`STOP ALL: ${reason}`)
// Research admission closes in the *same synchronous turn*, for the same
          // reason. The gateway is what stops a model turn; research also reaches the
          // network and a browser, and neither is behind the gateway gate. A
          // research job cancelled only after an await would still be able to issue
          // its next search, and that next search is the request the owner just
          // asked to stop.
          this.closeResearch(`STOP ALL: ${reason}`)
          // And the workforce, for the same reason and also without awaiting first. The
          // latch here is set synchronously and stops every agent being assigned work or
          // sending messages; the durable `stopped` transitions follow. Without this an
          // agent could still be handed an assignment after the panic button, which
          // would make the button a control over models only.
          this.workforceEngine?.stopAll(`STOP ALL: ${reason}`)

          try {
            const event = await this.fabric.append(
              'security.stop_all.activated',
              { by: this.owner.id, reason },
              { actor: this.owner.id, correlationId: requestId },
            )
            // The workforce's *consequences* are drained here, after the latch is durable,
            // for the reason `Core.stop()` drains the gateway: the owner's stop still owes
            // the journal an outcome, and answering before the agents' `stopped`
            // transitions are written would report a stop over a board that has not been
            // told yet. The gate itself was closed synchronously above, so nothing could
            // slip in while this ran.
            await this.workforceEngine?.settled()
            // The conversation projection reports whether Freya is stopped and
            // whether she can think, so a stop has to refresh it. Without this a
            // Chat window keeps a composer it believes is still open.
            this.conversations?.publish()
            this.publishWorkforce()
            return { requestId, ok: true, status: this.status(), durableSequence: event.sequence }
          } catch (error) {
            // Fail closed. The owner's stop decision already closed the contact
            // gate and aborted anything in flight. If the durable latch cannot
            // be written, cognition stays refused rather than silently reopening
            // after a persistence failure. CoreStatus exposes that closed gate
            // as deny_all, and only an explicit owner resume may reopen it.
            this.notify()
            throw error
          }
        }

        case 'security.resume': {
          // Clearing the latch needs its own capability, held only by the owner.
          // No model, no agent and no module can present it.
          const decision = this.guard.evaluate(this.owner, 'security.resume')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'security.resume', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          if (!this.state.stopAll.active) {
            // A failed STOP append has no durable latch, but the gateway remains
            // deliberately fail-closed. This explicit owner command is the only
            // authority allowed to reopen it. Shutdown cannot be reopened here:
            // mutating commands are rejected above once lifecycle is stopping or
            // stopped, and degraded Core is rejected before command dispatch.
            this.gateway?.resume()
            this.workforceEngine?.resume()
            this.conversations?.publish()
            this.publishWorkforce()
            return { requestId, ok: true, status: this.status() }
          }
          const event = await this.fabric.append(
            'security.stop_all.cleared',
            { by: this.owner.id },
            { actor: this.owner.id, correlationId: requestId },
          )
          this.gateway?.resume()
          // Same for the workforce: only this path reopens it, and it changes nothing
          // but whether a *new* assignment or message may begin. It restarts no work and
          // returns nothing, so a worker stopped by a panic button stays stopped until
          // somebody resumes it deliberately.
          this.workforceEngine?.resume()
          // As above: a resume has to reach the surfaces that report it, or Chat
          // stays visibly locked after Core has reopened.
          this.conversations?.publish()
          this.publishWorkforce()
          return { requestId, ok: true, status: this.status(), durableSequence: event.sequence }
        }

        /* ------------------------------------------------- conversation */

        case 'conversation.create': {
          // A new conversation is an owner act, and the cheapest one there is: a
          // local record and a journal line. No model, no credits.
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const result = await this.conversations.create(
            readString(envelope.payload, 'title') ?? undefined,
          )
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              conversation: { operation: 'refused', reason: result.reason },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            conversation: { operation: 'created', conversation: result.conversation },
          }
        }

        case 'conversation.list': {
          const result = await this.conversations.list()
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              conversation: { operation: 'refused', reason: result.reason },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            conversation: { operation: 'listed', conversations: result.conversations },
          }
        }

        case 'conversation.read': {
          const conversationId = readString(envelope.payload, 'conversationId')
          if (conversationId === null) {
            return { requestId, ok: false, refusal: { reason: 'conversationId is missing' } }
          }
          const result = await this.conversations.read(conversationId)
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              conversation: { operation: 'refused', reason: result.reason },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            conversation: {
              operation: 'read',
              conversation: result.conversation,
              messages: result.messages,
            },
          }
        }

        case 'conversation.turn.submit': {
          // The one command that spends money, and it is reached from a window.
          //
          // The window supplies a conversation and some text. It does not supply a
          // grant, a model, a token ceiling, a turn id or a provider — the Mind
          // derives all of those and the Governor checks them. Everything below
          // this line is Core deciding, not a renderer asking.
          const decision = this.guard.evaluate(this.owner, 'cognition.request')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'cognition.request', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }

          const conversationId = readString(envelope.payload, 'conversationId')
          const text = readString(envelope.payload, 'text')
          if (conversationId === null) {
            return { requestId, ok: false, refusal: { reason: 'conversationId is missing' } }
          }
          if (text === null) {
            return { requestId, ok: false, refusal: { reason: 'message text is missing' } }
          }
          // Bounded at the edge, before anything is stored or spent, so a paste of
          // half a megabyte fails visibly here instead of becoming one request.
          if (text.length > 8000) {
            return {
              requestId,
              ok: false,
              refusal: { reason: `the message is too long (${text.length} characters, limit 8000)` },
            }
          }

          const result = await this.conversations.submitTurn({ conversationId, text, requestId })
          if (!result.ok) {
            return { requestId, ok: false, refusal: { reason: result.reason } }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            conversation: { operation: 'turn', turn: toTurnView(result.turn) },
          }
        }

        case 'conversation.turn.cancel': {
          // Scoped, and deliberately *not* a security stop. It aborts one provider
          // request and latches nothing: the contact gate stays open, STOP ALL
          // stays clear, and the next message can be sent straight away.
          const decision = this.guard.evaluate(this.owner, 'cognition.request')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'cognition.request', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const turnId = readString(envelope.payload, 'turnId')
          if (turnId === null) {
            return { requestId, ok: false, refusal: { reason: 'turnId is missing' } }
          }
          const result = await this.conversations.cancelTurn(turnId)
          return {
            requestId,
            ok: true,
            status: this.status(),
            conversation: { operation: 'cancelled', cancelled: result.cancelled },
          }
        }

        /* ------------------------------------------------------------------ *
         * Model catalogue and selection.
         *
         * Two commands, and neither is a door to a provider. The catalogue read
         * is a metadata fetch the Gateway performs through the provider it
         * already owns — no provider object ever crosses back — and the
         * selection is a session setting that reaches a turn only as the
         * `requestedModel` on an intent the Governor still has to authorise.
         * Selecting does not create a grant, raise a ceiling, open the contact
         * gate, or skip turn-context compilation: the selected model rides the
         * exact same path an unselected turn always took.
         * ------------------------------------------------------------------ */

        case 'model.catalog.read': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const catalog = await this.gateway.readModelCatalog()
          if (catalog.ok !== true) {
            // An honest sentence, not an empty list. A window that receives
            // `models: []` for a missing key would render "NanoGPT has no
            // models" — a fabrication this branch exists to prevent.
            return {
              requestId,
              ok: false,
              refusal: { reason: catalog.reason },
              model: { operation: 'refused', reason: catalog.reason },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            model: {
              operation: 'catalog',
              models: catalog.models.map((entry) => ({ id: entry.id, ownedBy: entry.ownedBy })),
              defaultModel: catalog.defaultModel,
              selected: this.selectedModel,
            },
          }
        }

        case 'model.select': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          // A payload with no `model` key means "back to the provider default".
          // Absence is a real instruction here, and treating it as malformed
          // would make "use the default" unspellable from a window.
          if (!hasKey(envelope.payload, 'model')) {
            this.selectedModel = null
            return {
              requestId,
              ok: true,
              status: this.status(),
              model: { operation: 'selected', selected: null },
            }
          }
          const model = readString(envelope.payload, 'model')
          if (model === null || model.length > 256) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'a model id must be a string of at most 256 characters' },
              model: { operation: 'refused', reason: 'a model id must be a string of at most 256 characters' },
            }
          }
          if (!this.gateway.canServeModel(model)) {
            // Refused now, visibly, rather than becoming a turn that spends a
            // grant and fails mid-call. This is the same question the Gateway
            // will ask when the turn arrives, so a selection accepted here can
            // still fail later only if the provider genuinely stops serving it.
            const reason =
              `no configured provider can serve model "${model}" — read the model catalogue first, ` +
              'or select the provider default'
            return {
              requestId,
              ok: false,
              refusal: { reason },
              model: { operation: 'refused', reason, selected: this.selectedModel },
            }
          }
          this.selectedModel = model
          return {
            requestId,
            ok: true,
            status: this.status(),
            model: { operation: 'selected', selected: model },
          }
        }

        /* -------------------------------------------------------- attention */

        case 'attention.status.read': {
          // A payloadless read, exactly like `workforce.status.read`. Anything
          // attached to it is refused rather than dropped, so a window cannot
          // smuggle a source, an importance, an urgency or an outcome into a read.
          if (carriesFields(envelope.payload)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: ATTENTION_NO_PAYLOAD },
              attention: { operation: 'refused', ok: false, reason: ATTENTION_NO_PAYLOAD },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            attention: { operation: 'status', ok: true },
          }
        }

        case 'attention.event.ingest': {
          const guardDecision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!guardDecision.allowed) {
            await this.recordGuard(guardDecision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: guardDecision.reason } }
          }
          // The source is fixed here to `owner`. A `source` in the payload is not
          // read at all, so a window cannot claim `system` or a Core subsystem.
          const result = await this.requireAttention().ingestFromPayload(envelope.payload, 'owner')
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              attention: { operation: 'refused', ok: false, reason: result.reason },
            }
          }
          this.publishAttention()
          return {
            requestId,
            ok: true,
            status: this.status(),
            attention: {
              operation: 'ingested',
              ok: true,
              decision: attentionDecisionView(result.decision),
            },
          }
        }

        case 'attention.schedule.register': {
          const guardDecision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!guardDecision.allowed) {
            await this.recordGuard(guardDecision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: guardDecision.reason } }
          }
          const result = await this.requireAttention().registerSchedule(envelope.payload)
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              attention: { operation: 'refused', ok: false, reason: result.reason },
            }
          }
          this.publishAttention()
          return {
            requestId,
            ok: true,
            status: this.status(),
            attention: { operation: 'scheduled', ok: true },
          }
        }

        case 'attention.schedule.cancel': {
          const scheduleId = readString(envelope.payload, 'scheduleId')
          if (scheduleId === null) {
            return { requestId, ok: false, refusal: { reason: 'scheduleId is missing' } }
          }
          const reason = readString(envelope.payload, 'reason') ?? 'cancelled by the owner'
          const cancelled = await this.requireAttention().cancelSchedule(scheduleId, reason)
          if (!cancelled) {
            const refusal = 'no pending schedule with that id'
            return {
              requestId,
              ok: false,
              refusal: { reason: refusal },
              attention: { operation: 'refused', ok: false, reason: refusal },
            }
          }
          this.publishAttention()
          return {
            requestId,
            ok: true,
            status: this.status(),
            attention: { operation: 'cancelled', ok: true },
          }
        }

        case 'attention.inbox.read': {
          // The owner's explicit read of one retained event's text. There is no
          // command that lists every text: a standing feed of what arrived would be
          // the log this domain deliberately does not keep.
          const eventId = readString(envelope.payload, 'eventId')
          if (eventId === null) {
            return { requestId, ok: false, refusal: { reason: 'eventId is missing' } }
          }
          const detail = this.requireAttention().detail(eventId)
          if (detail === null) {
            const refusal = 'no retained event with that id'
            return {
              requestId,
              ok: false,
              refusal: { reason: refusal },
              attention: { operation: 'refused', ok: false, reason: refusal },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            attention: { operation: 'detail', ok: true, detail },
          }
        }

        /* -------------------------------------------------------- voice */

        case 'voice.status.read':
          return { requestId, ok: true, status: this.status() }

        case 'voice.capture.start': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const result = await this.voiceService.beginCapture()
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              voice: { operation: 'refused', reason: result.reason },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            voice: {
              operation: 'capture-started',
              sessionId: result.session.sessionId,
              startedAt: result.session.startedAt,
            },
          }
        }

        case 'voice.capture.end': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const sessionId = readString(envelope.payload, 'sessionId')
          if (sessionId === null) {
            return { requestId, ok: false, refusal: { reason: 'sessionId is missing' } }
          }
          const result = await this.voiceService.endCapture({
            sessionId,
            audio: readAudioBytes(envelope.payload),
            durationMs: readNumber(envelope.payload, 'durationMs') ?? 0,
            cancelled: readRaw(envelope.payload, 'cancelled') === true,
          })
          return {
            requestId,
            ok: true,
            status: this.status(),
            // A transcript, not a turn. Nothing has been sent and nothing has been
            // spent; the window puts this text in a composer and waits for a Send.
            voice: {
              operation: 'capture-ended',
              reason: result.reason,
              text: result.text,
              detail: result.detail,
              transcribed: result.transcribed,
              byteLength: result.byteLength,
              durationMs: result.durationMs,
            },
          }
        }

        case 'voice.capture.cancel': {
          await this.voiceService.abandon('the owner released the microphone')
          return { requestId, ok: true, status: this.status(), voice: { operation: 'cancelled' } }
        }

        /* ------------------------------------------------------------ brain */

        case 'brain.status.read': {
          // Read-only, so it is allowed while stopping, and it needs no capability:
          // knowing what Freya remembers is the owner's own business.
          return {
            requestId,
            ok: true,
            status: this.status(),
            brain: { operation: 'status' },
          }
        }

        case 'brain.memory.write': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const content = readString(envelope.payload, 'content')
          if (content === null) {
            return { requestId, ok: false, refusal: { reason: 'content is missing' } }
          }
          // The owner pressing this button is the origin, and the handler assigns
          // that itself. Nothing in the payload can claim to be more trustworthy
          // than the pathway that admits it — see `admission.ts`.
          const outcome = await this.brainService.writeMemory({
            kind: readMemoryKind(envelope.payload),
            subject: readString(envelope.payload, 'subject') ?? 'unspecified',
            content,
            source: 'owner-assertion',
            sourceRef: readString(envelope.payload, 'sourceRef'),
            observedAt: readString(envelope.payload, 'observedAt') ?? undefined,
            confidence: readConfidence(envelope.payload),
            sensitivity: readSensitivity(envelope.payload),
            tags: readStringArray(envelope.payload, 'tags'),
            entityRefs: readStringArray(envelope.payload, 'entityRefs'),
          })
          this.publishBrain()
          if (outcome.outcome !== 'admitted') {
            return {
              requestId,
              ok: true,
              // Refused, not failed: the policy did its job, and the person is told
              // why rather than being met with a generic failure.
              status: this.status(),
              brain: {
                operation: 'memory-refused',
                reason: outcome.reason,
              },
            }
          }
          const memory = outcome.memory
          if (memory === null) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'the memory was admitted but could not be read back' },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            brain: {
              operation: 'memory-written',
              reason: outcome.reason,
              memory: {
                memoryId: memory.memoryId,
                kind: memory.kind,
                subject: memory.subject,
                status: memory.status,
                source: memory.source,
                confidence: memory.confidence,
                admittedAt: memory.admittedAt,
              },
            },
          }
        }

        case 'brain.memory.archive': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const memoryId = readString(envelope.payload, 'memoryId')
          if (memoryId === null) {
            return { requestId, ok: false, refusal: { reason: 'memoryId is missing' } }
          }
          const outcome = await this.brainService.archiveMemory(
            memoryId,
            readString(envelope.payload, 'reason') ?? 'the owner withdrew this',
          )
          this.publishBrain()
          return {
            requestId,
            ok: true,
            status: this.status(),
            brain: {
              operation: outcome.outcome === 'admitted' ? 'memory-archived' : 'memory-refused',
              reason: outcome.reason,
              ...(outcome.memory === null
                ? {}
                : {
                    memory: {
                      memoryId: outcome.memory.memoryId,
                      kind: outcome.memory.kind,
                      subject: outcome.memory.subject,
                      status: outcome.memory.status,
                      source: outcome.memory.source,
                      confidence: outcome.memory.confidence,
                      admittedAt: outcome.memory.admittedAt,
                    },
                  }),
            },
          }
        }

        case 'brain.recall': {
          const pack = this.brainService.recall(
            {
              text: readString(envelope.payload, 'query') ?? '',
              kinds: readMemoryKindArray(envelope.payload),
              tags: readStringArray(envelope.payload, 'tags'),
              entityRefs: readStringArray(envelope.payload, 'entityRefs'),
              limit: readNumber(envelope.payload, 'limit') ?? undefined,
            },
            {
              // Bounded from above inside `clampBudget`, so a renderer asking for a
              // huge pack cannot turn recall into a context flood.
              maxEstimatedTokens: readNumber(envelope.payload, 'maxEstimatedTokens') ?? 800,
              maxItems: readNumber(envelope.payload, 'maxItems') ?? 12,
            },
          )
          return {
            requestId,
            ok: true,
            status: this.status(),
            brain: {
              operation: 'recall',
              recall: {
                query: pack.query,
                items: pack.memories.map((item) => ({
                  memoryId: item.memoryId,
                  subject: item.subject,
                  content: item.content,
                  source: item.source,
                  confidence: item.confidence,
                  status: item.status,
                  score: item.score,
                })),
                conflicts: pack.conflicts,
                candidatesConsidered: pack.candidatesConsidered,
                omittedCount: pack.omittedCount,
                estimatedTokens: pack.estimatedTokens,
                empty: pack.empty,
              },
            },
          }
        }

        /* ---------------------------------------------------------- research */

        case 'search.web': {
          const query = readString(envelope.payload, 'query')
          if (query === null || query.trim().length === 0) {
            return { requestId, ok: false, refusal: { reason: 'a search query is required' } }
          }
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          const operationId = this.newId()
          try {
            const results = (await this.researchIntegration!.searchWeb(query)) as readonly {
              title: string
              url: string
              snippet: string
              sourceDomain: string
            }[]
            await await this.emitResearch('research.search_completed', operationId, 'searching', null, {
              results: results.length,
            })
            // A URL reaches the renderer because a person needs it in order to check
            // a claim. It reaches the journal as a count.
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'search',
                operationId,
                limits: this.researchLimits(),
                results: results.slice(0, 10).map((row) => ({
                  title: row.title,
                  url: row.url,
                  snippet: row.snippet,
                  sourceDomain: row.sourceDomain,
                })),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, operationId, 'search_started', error)
          }
        }

        case 'browser.read': {
          const url = readString(envelope.payload, 'url')
          if (url === null) {
            return { requestId, ok: false, refusal: { reason: 'a URL is required' } }
          }
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          const operationId = this.newId()
          await this.emitResearch('research.read_started', operationId, 'reading', null, {})
          try {
            const document = await this.researchIntegration!.readWebPage(url)
            await this.emitResearch('research.read_completed', operationId, 'reading', null, {
              evidenceChars: document.contentLength,
            })
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'read',
                operationId,
                limits: this.researchLimits(),
                document: {
                  title: document.title,
                  url: document.url,
                  sourceDomain: document.sourceDomain,
                  retrievedAt: document.retrievedAt,
                  headings: document.headings.slice(0, 32),
                  // Bounded by the extractor; sent as text and never as markup.
                  text: document.text.slice(0, 24_000),
                  links: document.links.slice(0, 32).map((link) => ({ title: link.title, url: link.url })),
                  truncated: document.truncated,
                },
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, operationId, 'read_started', error)
          }
        }

        case 'research.start': {
          const question = readString(envelope.payload, 'question')
          if (question === null || question.trim().length === 0) {
            return { requestId, ok: false, refusal: { reason: 'a research question is required' } }
          }
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          const operationId = this.newId()
          await this.emitResearch('research.started', operationId, 'authorizing', null, {})
          try {
            const result = await this.researchIntegration!.research(question)
            // The journal records that a job ended, not what it found.
            await this.emitResearch('research.completed', result.id, result.state, null, {
              ...result.usage,
            })
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'research',
                operationId: result.id,
                limits: this.researchLimits(),
                result: projectResearch(result),
              },
            }
          } catch (error) {
            // Routed through the safe mapper like its siblings. Every throw on this
            // path is a fixed-string ResearchError today, so nothing leaks yet - but
            // containment that depends on every future throw happening to be tidy is
            // not containment, and one raw throw would reach the renderer verbatim.
            return this.researchFailure(requestId, operationId, 'research.started', error)
          }
        }

        case 'research.cancel': {
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          const researchId = readString(envelope.payload, 'researchId')
          if (researchId === null) {
            return { requestId, ok: false, refusal: { reason: 'a research id is required' } }
          }
          const cancelled = this.researchIntegration!.coordinator.cancel(researchId)
          return {
            requestId,
            ok: cancelled,
            status: this.status(),
            research: cancelled
              ? { operation: 'cancelled', operationId: researchId }
              : { operation: 'refused', reason: 'that research operation is not running' },
          }
        }

        case 'research.status.read': {
          // Read-only, so it is answered even while stopped: a person watching a
          // cancelled research needs to see that it is cancelled.
          const current = this.researchIntegration?.coordinator.current() ?? null
          return {
            requestId,
            ok: true,
            status: this.status(),
            research: {
              operation: 'status',
              limits: this.researchLimits(),
              status: current === null ? null : { operationId: current.id, stage: current.stage },
            },
          }
        }


        /* -------------------------------------------------------------- work */

        /* ----------------------------------------------------------- missions */

        case 'mission.create': {
          const decision = this.guard.evaluate(this.owner, 'mission.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'mission.manage', requestId)
            return this.missionRefusal(requestId, 'refused', decision.reason)
          }
          const title = readString(envelope.payload, 'title')
          if (title === null) {
            return this.missionRefusal(requestId, 'refused', 'a Mission title is missing')
          }
          // Only the three pieces of text a Mission is made of. Deliberately *not*
          // forwarded: limits, principal, owner, status, verification, deadline. A
          // window that could put `maxChildRuns` in front of Core would be raising a
          // code-owned ceiling by asking nicely — see D24 for why the bridge does not
          // even carry these fields.
          const intent = readString(envelope.payload, 'intent')
          if (intent === null) {
            return this.missionRefusal(requestId, 'refused', 'a Mission needs an intent as well as a title')
          }
          const criteria = readStringArray(envelope.payload, 'successCriteria')
          const outcome = await this.requireMission().create({
            title,
            intent,
            ...(criteria === null ? {} : { successCriteria: criteria }),
          })
          this.publishMission()
          return { requestId, ok: outcome.ok, status: this.status(), mission: missionResult(outcome) }
        }

        case 'mission.activate':
        case 'mission.pause':
        case 'mission.resume':
        case 'mission.cancel':
        case 'mission.fail':
        case 'mission.requestCompletion': {
          // One block, because all six are the same privilege and the same shape, and
          // six near-identical handlers is six places for one of them to be written
          // more carefully than the other five.
          const decision = this.guard.evaluate(this.owner, 'mission.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'mission.manage', requestId)
            return this.missionRefusal(requestId, 'refused', decision.reason)
          }
          const missionId = readString(envelope.payload, 'missionId')
          if (missionId === null) {
            return this.missionRefusal(requestId, 'refused', 'a Mission id is missing')
          }
          const engine = this.requireMission()
          const operations: Partial<Record<CoreCommandName, () => Promise<MissionCommandOutcome>>> = {
            'mission.activate': () => engine.activate(missionId),
            'mission.pause': () => engine.pause(missionId),
            'mission.resume': () => engine.resume(missionId),
            'mission.cancel': () => engine.cancel(missionId),
            'mission.fail': () => engine.fail(missionId),
            // Completion is not a status setter. It asks a verifier, and completes the
            // Mission only if the verifier establishes the outcome.
            'mission.requestCompletion': () => engine.requestCompletion(missionId),
          }
          const run = operations[envelope.command]
          if (run === undefined) {
            // Unreachable: the case arm is only entered for these six commands. Checked
            // anyway, because a `switch` on a string is the one place in this file
            // where an unhandled value becomes a crash rather than a refusal.
            return this.missionRefusal(requestId, 'refused', 'that Mission command is not recognised')
          }
          const outcome = await run()
          this.publishMission()
          return { requestId, ok: outcome.ok, status: this.status(), mission: missionResult(outcome) }
        }

        /* ----------------------------------------------------------- context */

        case 'context.status.read':
        case 'context.reference.read':
        case 'context.scope.activate':
        case 'context.admit':
        case 'context.revoke':
        case 'context.revokeScope': {
          // One block for all six, for the same reason the six Mission commands
          // share one: they are one subsystem's write surface, and six near-identical
          // handlers is six places for one of them to be handled less carefully than
          // the other five.
          //
          // There is no capability on these, and that is deliberate rather than an
          // oversight. Guard governs *authority* — what a principal may do — and
          // context is not authority: admitting a selection grants nothing, and
          // resolving "here" performs no action. Reading what the owner shared and
          // choosing to share it are the owner's own business, exactly as
          // `work.status.read` and `brain.status.read` are.
          //
          // What the block does *not* do is trust the payload. The facade owns every
          // boundary decision below — provenance, scope, field allowlist — and this
          // arm's whole job is to hand it `unknown` and render what came back.
          const integration = this.requireContext()
          const outcome = this.contextCommand(envelope.command, envelope.payload, integration)
          await this.contextPersistence?.flush()
          // Every mutating context operation re-points or re-scopes something, so the
          // mirror moves. Publishing on the read arms too keeps one rule: the mirror
          // is rebuilt whenever a context command was understood.
          if (isContextMutation(envelope.command)) this.publishContext()
          // A refusal is `ok: false` on the envelope *and* a `refusal` on it, as well
          // as the Context slot, so a window that only reads the envelope cannot
          // report a declined admission as a success. `unchanged` is not that case:
          // Core understood the request and there was nothing to do, which is a
          // successful idempotent no-op — hence the test on `refusal` rather than
          // `ok`, so one operation code cannot quietly redefine "refused".
          const refused = outcome.refusal !== undefined
          return {
            requestId,
            ok: !refused,
            status: this.status(),
            ...(refused ? { refusal: { reason: outcome.reason ?? outcome.refusal ?? 'refused' } } : {}),
            context: outcome,
          }
        }

        case 'work.status.read':
          // Read-only, so it is allowed while stopping, and it needs no
          // capability: knowing what Freya is working on is the owner's own
          // business.
          return {
            requestId,
            ok: true,
            status: this.status(),
            work: { operation: 'status', ok: true },
          }

        case 'mission.status.read': {
          // Read-only, so it survives shutdown, and evaluated against a capability of
          // its own rather than waved through.
          //
          // That enforcement is the point of the split in §10 of PHASE-7: `work.status.read`
          // is deliberately ungated, and copying that here would leave the documented
          // read/manage separation decorative — a body allowed to watch a Mission should
          // be describable as one that may not conclude it, and that is only true if the
          // read is actually evaluated.
          const decision = this.guard.evaluate(this.owner, 'mission.status.read')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'mission.status.read', requestId)
            return this.missionRefusal(requestId, 'refused', decision.reason)
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            mission: { operation: 'status', ok: true },
          }
        }

        /* ------------------------------------------------------- workforce */

        case 'workforce.status.read': {
          // Read-only, so it survives shutdown — and it carries nothing, which
          // is the whole of this lane's write surface against Workforce: there
          // is none.
          //
          // The refusal is deliberate rather than a silent drop. A window that
          // appends an owner, a principal, an authority, a trust level, a
          // provenance, a capability or a claim is *told* the read takes no
          // payload, instead of being left believing the field went somewhere.
          // Core never reads a payload on this path at all — there is no code
          // here that could honour a forged field even if this check were
          // removed — but a boundary that refuses teaches, and one that quietly
          // ignores teaches a compromised window nothing.
          if (carriesFields(envelope.payload)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: WORKFORCE_NO_PAYLOAD },
              workforce: { operation: 'refused', ok: false, reason: WORKFORCE_NO_PAYLOAD },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            workforce: { operation: 'status', ok: true },
          }
        }

        case 'work.task.create': {
          const decision = this.guard.evaluate(this.owner, 'work.task.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'work.task.manage', requestId)
            return {
              requestId,
              ok: false,
              refusal: { reason: decision.reason },
              work: { operation: 'task-refused', ok: false, reason: decision.reason },
            }
          }
          const title = readString(envelope.payload, 'title')
          if (title === null) {
            return this.workRefusal(requestId, 'task-refused', 'a task title is missing')
          }
          const outcome = await this.requireWork().createTask(title)
          this.publishWork()
          return { requestId, ok: outcome.ok, status: this.status(), work: workResult(outcome) }
        }

        case 'work.task.update': {
          const decision = this.guard.evaluate(this.owner, 'work.task.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'work.task.manage', requestId)
            return this.workRefusal(requestId, 'task-refused', decision.reason)
          }
          const taskId = readString(envelope.payload, 'taskId')
          if (taskId === null) return this.workRefusal(requestId, 'task-refused', 'task id is missing')
          const status = readString(envelope.payload, 'status')
          if (status === null || !isTaskStatus(status)) {
            return this.workRefusal(requestId, 'task-refused', 'task status is missing or unknown')
          }
          const outcome = await this.requireWork().updateTask(taskId, status)
          this.publishWork()
          return { requestId, ok: outcome.ok, status: this.status(), work: workResult(outcome) }
        }

        case 'work.run.create': {
          const decision = this.guard.evaluate(this.owner, 'work.run.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'work.run.manage', requestId)
            return this.workRefusal(requestId, 'run-created', decision.reason)
          }
          // A plan is a request. Everything in it is validated inside the engine
          // against the registered capability set — the handler only has to make
          // sure it arrived as a plan at all, and that it is not enormous.
          const rawSteps = readRawArray(envelope.payload, 'steps')
          if (rawSteps === undefined) return this.workRefusal(requestId, 'run-created', 'a run needs steps')
          if (rawSteps.length === 0) return this.workRefusal(requestId, 'run-created', 'the plan contained no steps')
          if (rawSteps.length > WORK_LIMITS.maxRunSteps) {
            return this.workRefusal(
              requestId,
              'run-created',
              `a plan may hold at most ${WORK_LIMITS.maxRunSteps} steps`,
            )
          }
          const planSteps: WorkStepPlan[] = []
          // Read before the loop so a malformed ceiling is refused before any step
          // is even looked at. Clamping happens in the engine; this only checks the
          // shape, because a caller may narrow a ceiling but never raise one.
          const limits = readRunLimits(envelope.payload, 'limits')
          if (limits === 'invalid') {
            return this.workRefusal(requestId, 'run-created', 'the requested limits are malformed')
          }
          for (const raw of rawSteps) {
            if (typeof raw !== 'object' || raw === null) {
              return this.workRefusal(requestId, 'run-created', 'a step was malformed')
            }
            const step = raw as Record<string, unknown>
            const key = typeof step.key === 'string' ? step.key : null
            const capability = typeof step.capability === 'string' ? step.capability : null
            const verifier = typeof step.verifier === 'string' ? step.verifier : null
            const label = typeof step.label === 'string' ? step.label : null
            if (!key || !capability || !verifier || label === null) {
              return this.workRefusal(requestId, 'run-created', 'a step was missing a field')
            }
            // `input` is deliberately passed through uninspected: the engine
            // sanitises it, and a second sanitiser here would be a second set of
            // rules that could disagree with the one that matters.
            planSteps.push({
              key,
              capability,
              verifier,
              label,
              ...(step.input === undefined ? {} : { input: step.input as Record<string, unknown> }),
              ...(step.requiresApproval === true ? { requiresApproval: true } : {}),
            })
          }
          const taskId = readString(envelope.payload, 'taskId')
          // A window may say *which Mission* a Run belongs to. It may not say what kind
          // of parent it is, and it may not name one.
          //
          // This used to read `{ kind, id }` straight off the payload, which let any
          // window attach a Run to anything by asserting an arbitrary pair — and "kind"
          // is a claim about structure, which is Core's to make rather than a window's.
          // `missionId` is the whole of what crosses this boundary; Core builds the
          // parent from it. A window naming `parent` at all is refused rather than
          // ignored, so it cannot believe the old shape still worked.
          const missionId = readString(envelope.payload, 'missionId')
          if (hasKey(envelope.payload, 'parent')) {
            return this.workRefusal(
              requestId,
              'run-created',
              "a Run's parent is decided by Core; name a missionId instead of a parent",
            )
          }
          // Checked before the Run is built so a window gets an exact "no such
          // Mission" refusal cheaply. This is *not* the permission decision:
          // whether a mission-parented Run may durably exist is decided inside
          // `attachChildRunWhileCreating`, under the Mission's own lock, together
          // with the single `work.run.created` that names it as parent. The
          // earlier bug — create the Run first, attach after — left the journal
          // recording a parent that nothing corroborated when the Mission was a
          // draft, paused, terminal, expired or over a ceiling; now a refusal
          // happens strictly before any Work claim is written.
          if (missionId !== null && !this.requireMission().exists(missionId)) {
            return this.workRefusal(requestId, 'run-created', 'there is no Mission with that id')
          }
          const parent = missionId === null ? null : { kind: 'mission' as const, id: missionId }

          // The Work outcome of the Run created inside the Mission's queue. Set
          // only when Work accepted the plan: admission refused means creation
          // never ran, and a Work refusal throws instead.
          let created: WorkCommandOutcome | undefined

          if (parent === null) {
            const outcome = await this.requireWork().createRun({
              steps: planSteps,
              ...(taskId === null ? {} : { taskId }),
              ...(limits === null ? {} : { limits }),
            })
            this.publishWork()
            return { requestId, ok: outcome.ok, status: this.status(), work: workResult(outcome) }
          }

          // A mission-parented Run is created and corroborated as one act: the
          // admission check, Work's durable `work.run.created` and the
          // `mission.run.attached` all hold the Mission's queue, so no pause,
          // cancel, deadline settlement or rival attach can land between them.
          // A refusal here — draft, paused, terminal, past the deadline, at a
          // ceiling, stopped — is returned before the callback runs, so nothing
          // exists and the journal records no attempt at all.
          let attach: MissionCommandOutcome
          try {
            attach = await this.requireMission().attachChildRunWhileCreating(
              missionId as string,
              async () => {
                const attempt = await this.requireWork().createRun({
                  steps: planSteps,
                  ...(taskId === null ? {} : { taskId }),
                  parent,
                  ...(limits === null ? {} : { limits }),
                })
                if (!attempt.ok || attempt.runId === undefined) throw new RunPlanRefused(attempt)
                created = attempt
                return attempt.runId
              },
            )
          } catch (error) {
            // Work declining the plan (a bad capability, unsanitisable input, a
            // malformed ceiling) is the renderer's mistake and reads like any
            // other Work refusal; nothing durable was written on either side.
            if (error instanceof RunPlanRefused) {
              return this.workRefusal(requestId, 'run-created', error.outcome.reason ?? 'the run plan was refused')
            }
            throw error
          }
          if (!attach.ok) {
            // The Mission refused on its own terms, and nothing is named as its
            // child. Say so in the Mission's voice, not Work's: the Run does not
            // exist, so `ok: false` is honest here.
            return this.missionRefusal(requestId, 'run-refused', attach.reason ?? 'the Mission refused this Run')
          }
          if (created === undefined) {
            throw new Error('the Mission queue surrendered no Work outcome')
          }
          this.publishMission()
          this.publishWork()
          // A created Run is `queued`, not running: starting one is a separate,
          // explicit command, so nothing a renderer submits begins executing as a
          // side effect of being accepted.
          return { requestId, ok: true, status: this.status(), work: workResult(created) }
        }

        case 'work.run.start': {
          const decision = this.guard.evaluate(this.owner, 'work.run.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'work.run.manage', requestId)
            return this.workRefusal(requestId, 'run-started', decision.reason)
          }
          const runId = readString(envelope.payload, 'runId')
          if (runId === null) return this.workRefusal(requestId, 'run-started', 'run id is missing')
          const outcome = await this.requireWork().startRun(runId)
          this.publishWork()
          return { requestId, ok: outcome.ok, status: this.status(), work: workResult(outcome) }
        }

        case 'work.run.pause':
        case 'work.run.resume':
        case 'work.run.cancel': {
          // Pausing, resuming and cancelling are all `work.run.manage`. Cancelling
          // deliberately does not latch anything security-wide: it stops one Run,
          // exactly as `conversation.turn.cancel` stops one turn, and STOP ALL
          // remains the separate, much larger control.
          const capability: Capability = 'work.run.manage'
          const decision = this.guard.evaluate(this.owner, capability)
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, capability, requestId)
            return this.workRefusal(requestId, 'run-paused', decision.reason)
          }
          const runId = readString(envelope.payload, 'runId')
          if (runId === null) return this.workRefusal(requestId, 'run-started', 'run id is missing')
          const engine = this.requireWork()
          const outcome =
            command === 'work.run.pause'
              ? await engine.pauseRun(runId)
              : command === 'work.run.resume'
                ? await engine.resumeRun(runId)
                : await engine.cancelRun(runId, readString(envelope.payload, 'reason') ?? WORK_CANCELLED)
          this.publishWork()
          return { requestId, ok: outcome.ok, status: this.status(), work: workResult(outcome) }
        }

        case 'work.approval.decide': {
          // The one command that means *a person is being trusted*, and the only
          // Work capability that is not `work.run.manage`.
          //
          // Two properties are structural rather than checked in the payload:
          // `decidedBy` has no field on the engine's function to be read from, and
          // the worker capability set excludes `work.*` entirely. A model therefore
          // cannot approve its own request by any route — and neither can a window,
          // which reaches this as the owner because the owner is the only principal
          // that reaches Core at all.
          const decision = this.guard.evaluate(this.owner, 'work.approval.decide')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'work.approval.decide', requestId)
            return this.workRefusal(requestId, 'approval-unknown', decision.reason)
          }
          const approvalId = readString(envelope.payload, 'approvalId')
          if (approvalId === null) {
            return this.workRefusal(requestId, 'approval-unknown', 'approval id is missing')
          }
          const verdict = readString(envelope.payload, 'decision')
          if (verdict !== 'approved' && verdict !== 'denied') {
            return this.workRefusal(
              requestId,
              'approval-unknown',
              'a decision must be approved or denied',
            )
          }
          const outcome = await this.requireWork().decideApproval(
            approvalId,
            verdict,
            readString(envelope.payload, 'reason') ?? '',
            this.owner.id,
            'owner-surface',
          )
          this.publishWork()
          return { requestId, ok: outcome.ok, status: this.status(), work: workResult(outcome) }
        }

        /* ------------------------------------------------------------ skills */
        //
        // Phase 17. Nine commands, and the shape of the group is the same argument the
        // vocabulary makes: a window may *ask* what Core knows and may *do* the owner
        // acts Core has a table for, and it may do nothing else.
        //
        // Every mutating case below evaluates `skill.manage` through Guard first and
        // records the decision, so a refusal appears in the audit stream rather than
        // only in the caller's return value. Every one of them then routes through
        // Core's own admission, evaluation, promotion and improvement code — none of
        // them writes a status, a verdict or a threshold that this module decided.

        case 'skill.status.read': {
          // Argument-free by construction. A window that could accompany "what do you
          // know about procedures?" with a status, a trust class or a threshold would
          // be asking Core a question it has already answered.
          if (carriesFields(envelope.payload)) {
            const refusal = SKILL_NO_PAYLOAD
            return {
              requestId,
              ok: false,
              refusal: { reason: refusal },
              skill: { operation: 'refused', ok: false, reason: refusal },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            skill: {
              operation: 'status',
              ok: true,
              projection: this.skills(),
              evidenceKinds: [...OWNER_SUBMITTABLE_EVIDENCE_KINDS],
            },
          }
        }

        case 'skill.admit': {
          const guard = await this.guardSkill(requestId)
          if (guard !== null) return guard
          const outcome = await this.issueSkillOwnerScope().admit(
            envelope.payload,
            // The trust class is Core's, not the payload's: a window cannot declare
            // its own text `code-owned`. `untrusted-content` is reachable only from
            // inside Core, by the pathway that assembled the text.
            'owner-declared',
          )
          return this.skillResult(requestId, outcome)
        }

        case 'skill.revise': {
          const guard = await this.guardSkill(requestId)
          if (guard !== null) return guard
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.skillRefusal(requestId, 'no-such-skill', 'skill id is missing')
          const outcome = await this.issueSkillOwnerScope().revise(skillId, envelope.payload)
          return this.skillResult(requestId, outcome)
        }

        case 'skill.recordEvaluation': {
          const guard = await this.guardSkill(requestId)
          if (guard !== null) return guard
          // `author` is `owner` here by construction, and `fromCommand` is `true` by
          // construction, so `parseEvaluationRequest` refuses a `verification-record`
          // or a `model-opinion` evidence item outright. A window can report what it
          // saw; it cannot assert a verification, and it cannot submit an opinion as
          // evidence.
          const outcome = await this.issueSkillOwnerScope().recordEvaluation(envelope.payload)
          return this.skillResult(requestId, outcome)
        }

        case 'skill.transition': {
          const guard = await this.guardSkill(requestId)
          if (guard !== null) return guard
          const skillId = readString(envelope.payload, 'skillId')
          const to = readString(envelope.payload, 'to')
          if (skillId === null) return this.skillRefusal(requestId, 'no-such-skill', 'skill id is missing')
          if (to === null || !isSkillStatus(to)) {
            return this.skillRefusal(requestId, 'illegal-transition', 'the requested status is not one Freya knows')
          }
          const outcome = await this.issueSkillOwnerScope().transition(skillId, to)
          return this.skillResult(requestId, outcome)
        }

        case 'skill.retire': {
          const guard = await this.guardSkill(requestId)
          if (guard !== null) return guard
          const skillId = readString(envelope.payload, 'skillId')
          const reason = readString(envelope.payload, 'reason')
          if (skillId === null) return this.skillRefusal(requestId, 'no-such-skill', 'skill id is missing')
          if (reason === null || !isSkillRetirementReason(reason)) {
            return this.skillRefusal(
              requestId,
              'illegal-transition',
              'a retirement reason must be one of the reasons Freya records',
            )
          }
          const outcome = await this.issueSkillOwnerScope().retire(skillId, reason)
          return this.skillResult(requestId, outcome)
        }

        case 'skill.propose': {
          const guard = await this.guardSkill(requestId)
          if (guard !== null) return guard
          const outcome = await this.issueSkillOwnerScope().propose(envelope.payload)
          return this.skillResult(requestId, outcome)
        }

        case 'skill.proposal.settle': {
          const guard = await this.guardSkill(requestId)
          if (guard !== null) return guard
          const proposalId = readString(envelope.payload, 'proposalId')
          const decision = readString(envelope.payload, 'decision')
          if (proposalId === null) {
            return this.skillRefusal(requestId, 'no-evaluation-basis', 'proposal id is missing')
          }
          if (decision !== 'accepted' && decision !== 'refused') {
            return this.skillRefusal(requestId, 'artifact-refused', 'a proposal settles as accepted or refused')
          }
          // A refusal needs a closed code so a reader can tell *why*; an acceptance
          // carries none, because there is nothing to explain about a thing that was
          // allowed.
          const reason = readString(envelope.payload, 'reason')
          const code = decision === 'refused' ? reason : 'no-evaluation-basis'
          if (code === null || !SKILL_REFUSAL_CODES.includes(code as never)) {
            return this.skillRefusal(requestId, 'artifact-refused', 'a refusal needs a closed reason code')
          }
          const outcome = await this.issueSkillOwnerScope().settle(proposalId, decision, code as never)
          return this.skillResult(requestId, outcome)
        }

        case 'skill.select': {
          // A read. No Guard evaluation, because nothing is decided here: selection
          // is a pure function of already-authorized state, and Core decides it rather
          // than being asked to decide it.
          const outcome = this.requireSkills().select({
            applicability: readStringArray(envelope.payload, 'applicability'),
            includeTrial: readBooleanField(envelope.payload, 'includeTrial'),
            includeVerified: readBooleanField(envelope.payload, 'includeVerified'),
            limit: readNumber(envelope.payload, 'limit') ?? undefined,
          })
          return {
            requestId,
            ok: true,
            status: this.status(),
            skill: { operation: 'selected', ok: true, selection: outcome },
          }
        }

        case 'skill.detail.read': {
          // The owner's explicit read of one procedure's own text. The only command in
          // this family that carries body content across the bridge, and it takes a
          // single id — there is deliberately no command that lists every body, because
          // a standing feed of procedures would defeat the encryption the store exists
          // to provide.
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.skillRefusal(requestId, 'no-such-skill', 'skill id is missing')
          const detail = this.issueSkillOwnerScope().detail(skillId)
          if (detail === null) {
            return this.skillRefusal(
              requestId,
              'no-such-skill',
              'there is no such skill, or its stored body could not be read at this version',
            )
          }
          return { requestId, ok: true, status: this.status(), skill: { operation: 'detail', ok: true, detail } }
        }

        default:
          return reject(envelope, `unknown command: ${String(command)}`)
      }
    } catch (error) {
      // An unexpected failure is reported without a stack and without leaking
      // anything about the internals.
      return { requestId, ok: false, error: { message: describe(error) } }
    }
  }

  /* ----------------------------------------------------------- private */

  /**
   * The conversation store, and the only place the key is touched.
   *
   * Three outcomes, and no fourth:
   *
   *   - a key was supplied, so an encrypted store;
   *   - no key, so an **ephemeral** in-memory store that says so;
   *   - a store was injected, so that.
   *
   * There is deliberately no plaintext-on-disk path. A machine whose OS secure
   * storage is unavailable gets a working conversation for the session and a
   * truthful label, which is the only acceptable answer: silently writing
   * someone's conversation history in the clear would be a worse bug than
   * forgetting it.
   */
  /**
   * The Brain store, and the only place its key is touched.
   *
   * Three outcomes, mirroring the conversation store, and no fourth:
   *
   *   - a key was supplied, so an encrypted hash-chained store;
   *   - no key, so an **ephemeral** in-memory Brain that reports `durable: false`;
   *   - a store was injected, so that.
   *
   * No plaintext-on-disk path, and the failure mode is deliberately asymmetric
   * against the conversation store's: a Brain that cannot be opened is still a
   * working Brain for the session. Freya keeps answering, the surface says she will
   * not remember across a restart, and nothing is written unencrypted. Losing memory
   * is recoverable; silently persisting it in the clear is not.
   *
   * A Brain fault also never changes any authority. See `brain/store.ts`.
   */
  /**
   * Build the Mission content store.
   *
   * The rule is the Brain's, for the same reason: a store that cannot encrypt is
   * replaced by an **ephemeral one that says so**, never by a weaker store that
   * silently stands in. A Mission somebody was told is durable, and which is not, is
   * worse than no Mission at all — it is a promise the engine cannot keep, made
   * quietly, about the user's own words.
   */
  private async buildMissionStore(): Promise<MissionStore> {
    if (this.options.missionStore) return this.options.missionStore
    if (this.options.missionKey) {
      const path = `${this.options.dataPath}.missions`
      try {
        return await EncryptedMissionStore.open({ path, key: this.options.missionKey })
      } catch (error) {
        console.error('[freya.core] encrypted Mission store unavailable', describe(error))
        return new MemoryMissionStore({
          faultReason: `Mission content could not be encrypted: ${describe(error)}`,
        })
      }
    }
    return new MemoryMissionStore({
      faultReason: 'no secure Mission key is available on this machine',
    })
  }

  private async buildBrainStore(): Promise<BrainStore> {
    if (this.options.brainStore) return this.options.brainStore
    if (this.options.brainKey) {
      const path = `${this.options.dataPath}.brain`
      try {
        return await EncryptedBrainStore.open({ path, key: this.options.brainKey })
      } catch (error) {
        // Not replaced with a weaker *persistent* store. An ephemeral one that
        // reports itself is the only honest fallback.
        console.error('[freya.core] encrypted Brain store unavailable', describe(error))
        return new MemoryBrainStore({
          mode: 'ephemeral',
          faultReason: `the Brain could not be opened: ${describe(error)}`,
        })
      }
    }
    return new MemoryBrainStore({
      mode: 'ephemeral',
      faultReason:
        'no secure Brain key is available on this machine, so what Freya learns is being kept ' +
        'in memory only and will not survive a restart',
    })
  }

  /**
   * What Freya remembers about this text, for the Mind to render as reference.
   *
   * The projection from a `RecallPack` to the compiler's shape is here, in Core,
   * rather than in either component — so the Brain decides what is recallable and
   * the Mind decides nothing at all.
   *
   * The source class and confidence travel with every item *into the rendered text*.
   * A memory from a web page and a memory from the owner are indistinguishable once
   * flattened into "notes", and a provider reading "Freya's notes: the owner
   * prefers X" has been told a preference is a fact. Carrying the labels is what
   * keeps a stored claim looking like a claim.
   */
  private recallReference(query: string): ReferenceKnowledge | null {
    const pack = this.brainService.recall({ text: query }, { maxEstimatedTokens: 600, maxItems: 8 })
    if (pack.empty) return null
    return {
      items: pack.memories.map((item) => ({
        subject: item.subject,
        content: item.content,
        sourceLabel: item.source,
        confidenceLabel: item.confidence,
      })),
      conflicts: pack.conflicts.map((conflict) =>
        `${conflict.detail} (${conflict.memoryId} against ${conflict.conflictsWith.join(', ')})`,
      ),
      omittedCount: pack.omittedCount,
    }
  }

  /**
   * Record one conversation turn in the Brain's experience log.
   *
   * Everything here is an id, a count, a model name or a length. No text is
   * duplicated out of the encrypted conversation store, so the Brain cannot become a
   * second and less-protected home for the most private data in the system.
   */
  private async recordTurnExperience(experience: TurnExperience): Promise<void> {
    const result = experience.outcome === 'denied' ? 'denied' : experience.outcome
    await this.brainService.recordExperience({
      goalSummary: `answered a conversation turn`,
      startedAt: experience.startedAt,
      endedAt: experience.endedAt,
      modelsUsed: experience.model === null ? [] : [experience.model],
      toolsUsed: [],
      actions: [
        {
          at: experience.startedAt,
          summary: 'compiled context and requested one bounded cognition',
          outcome: experience.providerContacted ? 'succeeded' : 'skipped',
        },
      ],
      observations: [
        experience.referenceUsed
          ? `used ${experience.referenceItemCount} recalled item(s) as reference`
          : 'no reference memory was used',
      ],
      // Ids of the records that back the outcome. Not their content.
      evidenceRefs: experience.answerPersisted ? [experience.turnId] : [],
      result,
      humanCorrection: null,
      relatedEntities: [],
      relatedMemories: [],
      resourceUsage: {
        providerId: experience.providerId,
        model: experience.model,
        providerContacted: experience.providerContacted,
        // Phase 4 does not read per-call usage off the gateway for this record. Null
        // means "nothing reported here", which is not the same as zero — the
        // accounting that does track provider-reported usage is separate and
        // authoritative.
        inputTokens: null,
        outputTokens: null,
        usageUnknown: true,
      },
      answerPersisted: experience.answerPersisted,
      conversationId: experience.conversationId,
      turnId: experience.turnId,
    })
  }

  private async buildConversationStore(): Promise<ConversationStore> {
    if (this.options.conversationStore) return this.options.conversationStore
    if (this.options.conversationKey) {
      // Beside the journal, named from the Core's *data path*.
      //
      // Not from `fabric.describe()`: that returns a human description of the store
      // kind and the file it came from — something like `jsonl:/path/to/events` —
      // which is a label, not a filename. Using it here produced a directory
      // component containing a colon and a nested path, and the conversation store
      // silently fell back to being ephemeral.
      const path = `${this.options.dataPath}.conversations`
      try {
        return await EncryptedConversationStore.open({ path, key: this.options.conversationKey })
      } catch (error) {
        // A store that cannot be opened is not replaced with a weaker one. The
        // conversation commands are refused and the UI says why.
        console.error('[freya.core] encrypted conversation store unavailable', describe(error))
        return new MemoryConversationStore({
          mode: 'ephemeral',
          faultReason: `encrypted conversation history is unavailable: ${describe(error)}`,
        })
      }
    }
    return new MemoryConversationStore({
      mode: 'ephemeral',
      faultReason:
        'no secure conversation key is available on this machine, so this conversation is ' +
        'being kept in memory only and will not survive a restart',
    })
  }

  /**
   * Whether a model could be reached at all right now, and why not.
   *
   * Reported so the window can say "no cognition provider is available" instead of
   * letting someone press Send and wait. It is *not* a gate: a turn is still
   * accepted, the user's words are still stored, and the turn still fails
   * truthfully. Refusing before the person has spoken would be the model
   * deciding what they are allowed to say.
   */
  private cognitionAvailability(): { available: boolean; reason: string | null } {
    if (this.state.stopAll.active) {
      return { available: false, reason: 'Freya is stopped. Every model request is refused.' }
    }
    if (!this.gateway.gateStatus().open) {
      return {
        available: false,
        reason: this.gateway.gateStatus().reason ?? 'cognition is refused until the owner resumes',
      }
    }
    if (this.gateway.statuses().some((provider) => provider.status === 'configured')) {
      return { available: true, reason: null }
    }
    return {
      available: false,
      reason: 'No cognition provider is currently available, so Freya cannot answer yet.',
    }
  }

  onConversation(listener: (projection: ConversationProjection) => void): () => void {
    if (!this.conversations) {
      // Before start, or after stop. A window that attaches then gets a truthful
      // empty projection rather than nothing at all.
      void this.projectionWhenReady().then((projection) => {
        try {
          listener(projection)
        } catch {
          /* a subscriber that throws is dropped by the service */
        }
      })
      return () => {}
    }
    return this.conversations.subscribe(listener)
  }

  async conversation(): Promise<ConversationProjection> {
    if (!this.conversations) return this.emptyConversationProjection()
    return this.conversations.projection()
  }

  voice(): VoiceProjection {
    if (!this.voiceService) {
      return {
        transcription: { available: false, engine: null, detail: 'Core has not started.' },
        synthesis: { available: false, engine: null, detail: 'Core has not started.' },
        capturing: false,
        sessionId: null,
        limits: {
          maxDurationMs: 0,
          maxAudioBytes: 0,
          format: 'pcm-s16le',
        },
        localOnly: true,
        faults: [],
      }
    }
    return this.voiceService.projection()
  }

  /** Wait for the services, then project. Used by a window that attaches early. */
  private async projectionWhenReady(): Promise<ConversationProjection> {
    for (let attempt = 0; attempt < 50 && !this.conversations; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return this.conversation()
  }

  private async emptyConversationProjection(): Promise<ConversationProjection> {
    return {
      persistence: { mode: 'unavailable', reason: 'Core has not started' },
      conversations: [],
      activeConversationId: null,
      messages: [],
      activeTurn: null,
      cognition: { available: false, reason: 'Core has not started' },
      stopAll: {
        active: this.state.stopAll.active,
        activatedAt: this.state.stopAll.activatedAt,
      },
      maxMessageCharacters: 0,
      faults: ['Core has not started, so no conversation is available.'],
    }
  }



  private buildGuard(): Guard {
    // Deny by default. Nothing is on an approval list, because no approval
    // workflow exists; the concept is present and empty.
    return new DefaultGuard()
  }

  /**
   * The provider set for a normal runtime.
   *
   * NanoGPT and nothing else. If it is absent or disabled, there is no
   * configured provider, and a cognition request is refused for want of one.
   * That is the honest outcome: a refusal the user can see beats an echo of
   * their own words presented as an answer.
   *
   * The echo provider is opt-in and explicitly named, and it is listed last so
   * it never shadows a real provider when both are present.
   */
  private buildProviders(): ModelProvider[] {
    if (this.options.providers) return [...this.options.providers]
    const env = this.options.env ?? {}
    const providers: ModelProvider[] = [new NanoGptProvider({ config: readNanoGptConfig(env) })]
    if (this.options.developerProvider !== undefined) {
      providers.push(
        this.options.developerProvider === 'slow-echo'
          ? new SlowFakeModelProvider()
          : new FakeModelProvider(),
      )
    }
    return providers
  }

  /** Gateway audit events land on the durable fabric, not on a side channel. */
  private fabricRecorder(): GatewayRecorder {
    return {
      started: async (record) => {
        await this.fabric.append(
          'model.request.started',
          record,
          { actor: 'system', correlationId: record.requestId },
        )
      },
      completed: async (record) => {
        await this.fabric.append(
          'model.request.completed',
          record,
          { actor: 'system', correlationId: record.requestId },
        )
      },
      failed: async (record) => {
        await this.fabric.append(
          'model.request.failed',
          { ...record, reason: 'The model request failed.' },
          { actor: 'system', correlationId: record.requestId },
        )
      },
      cancelled: async (record) => {
        await this.fabric.append(
          'model.request.cancelled',
          { ...record, reason: 'The model request was cancelled.' },
          { actor: 'system', correlationId: record.requestId },
        )
      },
    }
  }

  /** The owner's authority. Identity lives here, not in any caller's payload. */
  private get ownerAuthority(): OwnerAuthority {
    return this.issueOwnerAuthority()
  }

  private async recordGuard(
    verdict: { allowed: false; outcome: 'deny' | 'approval_required'; reason: string },
    principal: PrincipalId,
    capability: Capability,
    correlationId: string,
  ): Promise<void> {
    await this.fabric.append(
      'guard.decision',
      {
        outcome: verdict.outcome,
        reason: verdict.reason,
        capability,
        principal,
      },
      { actor: principal, correlationId },
    )
  }

  private notify(): void {
    const status = this.status()
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch (error) {
        console.error('[freya.core] status subscriber threw', error)
      }
    }
  }
}

/**
 * Turn an engine outcome into the protocol's Work result.
 *
 * A thin rename rather than a translation, and the reason is worth a line: `ok`
 * travels with every outcome including the refusals, because "the approval was
 * denied" and "the engine could not be reached" must never render as success. The
 * reason travels too, for the Vault's reason — a refusal nobody can read is
 * indistinguishable from a refusal that was arbitrary.
 */
/** Core's Mission outcome, narrowed to the fields a window is allowed to see. */
function missionResult(outcome: MissionCommandOutcome): MissionCommandOutcomeView {
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    ...(outcome.missionId === undefined ? {} : { missionId: outcome.missionId }),
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  }
}

function workResult(outcome: WorkCommandOutcome): WorkCommandOutcome {
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
    ...(outcome.stepId === undefined ? {} : { stepId: outcome.stepId }),
    ...(outcome.approvalId === undefined ? {} : { approvalId: outcome.approvalId }),
    ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }),
    ...(outcome.status === undefined ? {} : { runStatus: outcome.status }),
  }
}

/** A refused Work command, in the one shape the surface has to render. */
/* A Run plan Work refused, raised out of the Mission queue.
 *
 * `attachChildRunWhileCreating` calls Work's own `createRun` as a callback, so a
 * Work refusal has to travel as an exception rather than an outcome value. The
 * Work result is carried whole, and the `work.run.create` handler turns it into
 * the same refusal a window would get with no Mission named — nothing durable
 * was written on either side.
 */
class RunPlanRefused extends Error {
  constructor(readonly outcome: WorkCommandOutcome) {
    super(outcome.reason ?? 'the run plan was refused')
  }
}

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}

/**
 * Whether a payload carries a key at all, even an unusable one.
 *
 * Needed so a window naming the *old* shape is refused rather than quietly ignored.
 * Ignoring an unrecognised field is usually the safer default, but here the field is
 * one a window might still be sending from older code, and answering "created"
 * would tell it the new shape is unnecessary.
 */
function hasKey(payload: unknown, key: string): boolean {
  return typeof payload === 'object' && payload !== null && key in (payload as Record<string, unknown>)
}

/**
 * The Context commands that change what is held, as opposed to reading it.
 *
 * Split out because the mirror has to move for exactly four of the six, and
 * publishing after a read would make a window redraw on every poll — which is the
 * kind of churn that looks like activity and teaches people to ignore the feed.
 */
function isContextMutation(command: CoreCommandName): boolean {
  return (
    command === 'context.scope.activate' ||
    command === 'context.admit' ||
    command === 'context.revoke' ||
    command === 'context.revokeScope'
  )
}

/**
 * A scope off the wire, or null when the payload does not name a usable one.
 *
 * Read here only to hand the facade a well-formed-or-nothing value; the facade
 * still checks the scope is one Core holds, and that it is not the ambient one. A
 * missing scope is not defaulted to the session, because the session is the widest
 * scope there is and defaulting into it would be the exact escalation this whole
 * boundary exists to refuse.
 */
function readContextScope(value: unknown): ContextScopeRef | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const scopeKind = raw.scopeKind
  if (scopeKind !== 'session' && scopeKind !== 'conversation' && scopeKind !== 'surface') return null
  const scopeId = raw.scopeId
  if (typeof scopeId !== 'string' || scopeId.trim().length === 0) return null
  return { scopeKind, scopeId: scopeId.trim() }
}

/**
 * Whether a payload carries any field at all.
 *
 * For the commands whose entire contract is "nothing" — today only
 * `workforce.status.read`. `undefined`, `null` and `{}` carry nothing; a
 * string, an array, or an object with a single key in it all do, and each is
 * refused rather than dropped so that code still sending fields is told the
 * read takes none.
 */
function carriesFields(payload: unknown): boolean {
  if (payload === undefined || payload === null) return false
  if (typeof payload !== 'object') return true
  if (Array.isArray(payload)) return true
  return Object.keys(payload as Record<string, unknown>).length > 0
}

function degradedStatus(
  lifecycle: CoreLifecycle,
  state: CoreState,
  startedAt: string | null,
): CoreStatus {
  return {
    lifecycle,
    eventSequence: 0,
    coreStartedAt: startedAt,
    stopAll: {
      active: state.stopAll.active,
      activatedAt: state.stopAll.activatedAt,
      activatedBy: state.stopAll.activatedBy,
    },
    // A Core whose log never opened has no journal to report on, and that is
    // exactly as trustworthy as it sounds.
    integrity: {
      integrity: 'corrupt',
      reason: 'the event log could not be opened, so no durable state could be read',
      line: null,
      eventsRead: 0,
      bytesDiscarded: 0,
    },
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    // Booting has no answer. Degraded genuinely cannot serve, so it denies.
    governor: { status: lifecycle === 'degraded' ? 'deny_all' : 'unknown', grantsActive: 0 },
    // No log means no providers, and saying so is safer than listing any.
    providers: [],
    // No gateway was ever built, so nothing was ever executing. Zero here is a
    // fact about this Core, not a guess about a provider.
    activeProviderCalls: 0,
    sessionUsage: emptyUsage(),
    durableUsage: state.durableUsage,
    faults: [...state.faults],
  }
}

/**
 * Read a grant spec from a command payload.
 *
 * Strictly structural: every field is checked, and anything unrecognised makes
 * the whole spec invalid rather than being carried through. There is
 * deliberately no path for a principal to arrive here.
 */
function readGrantSpec(payload: unknown): CognitionGrantSpec | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  const origins = p.allowedOrigins
  const causes = p.allowedCauses
  if (!Array.isArray(origins) || origins.length === 0) return null
  if (!Array.isArray(causes) || causes.length === 0) return null
  if (typeof p.grantId !== 'string' || p.grantId.length === 0) return null
  if (typeof p.expiresAt !== 'string') return null
  if (typeof p.backgroundAllowed !== 'boolean') return null
  if (!Number.isInteger(p.maxCalls) || !Number.isInteger(p.maxOutputTokens)) return null
  if (p.actor !== null && p.actor !== undefined && typeof p.actor !== 'string') return null
  if (p.goalId !== null && p.goalId !== undefined && typeof p.goalId !== 'string') return null

  return {
    grantId: p.grantId,
    expiresAt: p.expiresAt,
    allowedOrigins: origins as CognitionOrigin[],
    allowedCauses: causes as CognitionCause[],
    goalId: typeof p.goalId === 'string' ? p.goalId : null,
    runId: typeof p.runId === 'string' ? p.runId : null,
    actor: typeof p.actor === 'string' ? (p.actor as PrincipalId) : null,
    backgroundAllowed: p.backgroundAllowed,
    maxCalls: p.maxCalls as number,
    maxOutputTokens: p.maxOutputTokens as number,
    parentGrantId: typeof p.parentGrantId === 'string' ? p.parentGrantId : null,
  }
}


/**
 * A boolean field, or null.
 *
 * Only ever read for `includeTrial`/`includeVerified` on `skill.select`, so an
 * unrecognised value is `null` rather than a coerced `false` — a window sending
 * `includeTrial: "yes"` gets "no trials", which is the conservative reading, and the
 * selection report says how many candidates it considered so the discrepancy is
 * visible rather than silent.
 */
function readBooleanField(payload: unknown, key: string): boolean | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

function readNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readRaw(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[key]
}

/**
 * Audio bytes from a payload.
 *
 * Accepted as a `Uint8Array` (what structured clone delivers) or base64. The
 * bytes go straight to a local engine and are dropped: never journalled, never
 * written to disk, and never retained as "memory".
 */
function readAudioBytes(payload: unknown): Uint8Array | undefined {
  const raw = readRaw(payload, 'audio')
  if (raw instanceof Uint8Array) return raw
  if (typeof raw === 'string') {
    try {
      return new Uint8Array(Buffer.from(raw, 'base64'))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The renderer-safe shape of an attention decision. Metadata only. */
function attentionDecisionView(decision: AttentionDecision): AttentionDecisionView {
  return {
    decisionId: decision.decisionId,
    eventId: decision.eventId,
    source: decision.source,
    kind: decision.kind,
    outcome: decision.outcome,
    importance: decision.importance,
    urgency: decision.urgency,
    reason: decision.reason,
    cueCode: decision.cueCode,
    focus: decision.focus,
    decidedAt: decision.decidedAt,
  }
}

/** The renderer-safe shape of a Mind turn result. */
function toTurnView(turn: {
  turnId: string
  conversationId: string
  outcome: string
  reason: string | null
  assistantMessage: {
    messageId: string
    role: 'user' | 'assistant'
    content: string
    createdAt: string
    turnId: string
  } | null
  providerId: string | null
  model: string | null
  providerContacted: boolean
}): ConversationTurnView {
  return {
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    outcome: turn.outcome as ConversationTurnView['outcome'],
    reason: turn.reason,
    providerId: turn.providerId,
    model: turn.model,
    providerContacted: turn.providerContacted,
    assistantMessage: turn.assistantMessage
      ? {
          messageId: turn.assistantMessage.messageId,
          role: turn.assistantMessage.role,
          content: turn.assistantMessage.content,
          createdAt: turn.assistantMessage.createdAt,
          turnId: turn.assistantMessage.turnId,
        }
      : null,
  }
}

const MEMORY_KINDS: readonly MemoryKind[] = [
  'semantic',
  'episodic',
  'procedural',
  'working',
  'relationship',
  'autobiographical',
]

const CONFIDENCES: readonly Confidence[] = ['unknown', 'low', 'medium', 'high', 'verified']
const SENSITIVITIES: readonly Sensitivity[] = ['normal', 'personal', 'sensitive', 'secret-reference']

/**
 * Narrow a caller-supplied memory kind.
 *
 * Falls back to `semantic`, the most general kind, rather than throwing. A renderer
 * sending an unknown kind gets a memory labelled as knowledge rather than a crash,
 * and the label it *does* get is chosen here in trusted code.
 */
function readMemoryKind(payload: unknown): MemoryKind {
  const value = readString(payload, 'kind')
  return MEMORY_KINDS.find((kind) => kind === value) ?? 'semantic'
}

function readMemoryKindArray(payload: unknown): readonly MemoryKind[] | undefined {
  const raw = readStringArray(payload, 'kinds')
  if (raw === undefined) return undefined
  return raw.filter((value): value is MemoryKind => MEMORY_KINDS.includes(value as MemoryKind))
}

/**
 * Narrow a caller-supplied confidence, then let admission cap it.
 *
 * A renderer cannot grant itself `verified`, and cannot stop `admission.ts` from
 * lowering it either — the cap is applied against the source class there, so even a
 * future in-process caller naming `verified` would be recorded at the ceiling the
 * owner-assertion class supports, which is `high`.
 */
function readConfidence(payload: unknown): Confidence {
  const value = readString(payload, 'confidence')
  return CONFIDENCES.find((confidence) => confidence === value) ?? 'medium'
}

function readSensitivity(payload: unknown): Sensitivity {
  const value = readString(payload, 'sensitivity')
  return SENSITIVITIES.find((sensitivity) => sensitivity === value) ?? 'normal'
}

/** A string array, bounded and free of blanks. Never null, so callers stay simple. */
function readStringArray(payload: unknown, key: string): string[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return undefined
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 32)
}

/**
 * Read an array of unrecognised values.
 *
 * Deliberately *not* filtered: `readStringArray` keeps only the strings it
 * understands, which is right for a list of tags and wrong for a list of step
 * objects, where dropping one would mean quietly executing a smaller plan than
 * the caller asked for. Every element is validated individually instead.
 */
function readRawArray(payload: unknown, key: string): unknown[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return Array.isArray(value) ? value : undefined
}

/**
 * Read a partial set of Run ceilings off a command payload.
 *
 * Three answers because there are three honest ones: absent, present, or present
 * present and wrong. A caller may narrow any ceiling; `resolveLimits` in the
 * engine clamps everything downward afterwards, so nothing here can widen a bound.
 */
function readRunLimits(
  payload: unknown,
  key: string,
): Partial<RunLimits> | null | 'invalid' {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const raw = value as Record<string, unknown>
  const limits: Partial<RunLimits> = {}
  for (const name of ['maxSteps', 'maxActions', 'maxDurationMs', 'maxAttemptsPerStep'] as const) {
    const entry = raw[name]
    if (entry === undefined) continue
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) return 'invalid'
    Object.assign(limits, { [name]: Math.floor(entry) })
  }
  return limits
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function reject(envelope: CoreCommandEnvelope, reason: string): CoreCommandResult {
  const requestId =
    typeof envelope?.requestId === 'string' && envelope.requestId.length > 0
      ? envelope.requestId
      : 'unknown'
  return { requestId, ok: false, refusal: { reason } }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/**
 * Turn a recovery report into something a person can read and act on.
 *
 * The reason is written out rather than left as a code, because the two
 * situations call for different responses: a torn tail needs nothing, and a
 * corrupt journal needs somebody to look at the file.
 */
function describeRecovery(store: EventStore): JournalFault {
  const report = store instanceof JsonlEventStore ? store.recoveryReport() : null
  if (report === null) return HEALTHY_JOURNAL

  const base = {
    eventsRead: report.eventsRead,
    bytesDiscarded: report.bytesDiscarded,
  }

  if (report.corruption !== null) {
    return {
      integrity: 'corrupt',
      reason:
        `The event log is corrupt: line ${report.corruption.line} is a complete event that does ` +
        `not validate (${report.corruption.reason}). ${report.eventsRead} event(s) before it were ` +
        'read; everything from that line onward was discarded, so the security state derived from ' +
        'this log is incomplete. Cognition is refused until the log is repaired or removed.',
      line: report.corruption.line,
      ...base,
    }
  }

  if (report.tornTail) {
    return {
      integrity: 'torn',
      reason:
        `The last write was interrupted (${report.bytesDiscarded} byte(s) of a partial event ` +
        'discarded). This is what a crash during a write looks like; every complete event was ' +
        'read and validated.',
      line: null,
      ...base,
    }
  }

  return { integrity: 'ok', reason: 'the event log was read in full and validated', line: null, ...base }
}

/** Build a Core. One per application process. */
export function createCore(options: CoreOptions): Core {
  return new FreyaCore(options)
}

export type { AnyCoreEvent }

/**
 * A research result as the renderer sees it.
 *
 * Sources keep their URL, because a person needs it to check a claim and a citation
 * that cannot be followed is decoration. Failures keep a closed code, never the
 * message a provider threw — which may carry a credential or a path.
 */
function projectResearch(result: ResearchResult): NonNullable<ResearchCommandOutcome['result']> {
  return {
    id: result.id,
    state: result.state,
    findings: result.findings.map((finding) => ({ text: finding.text, sourceIds: [...finding.sourceIds] })),
    conflicts: result.conflicts.map((conflict) => ({ text: conflict.text, sourceIds: [...conflict.sourceIds] })),
    uncertainties: [...result.uncertainties],
    sources: result.sources.map((source) => ({
      sourceId: source.sourceId,
      url: source.url,
      title: source.title,
      domain: source.domain,
      retrievedAt: source.retrievedAt,
      excerpt: source.excerpt,
    })),
    failures: result.failures.map((failure) => ({ stage: failure.stage, code: failure.code })),
    usage: { ...result.usage },
  }
}
