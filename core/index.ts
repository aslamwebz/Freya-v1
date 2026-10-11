import { SourceWorkspace } from './explorer/source-workspace'
import { systemExplorer, EXPLORER_COMMANDS, handleExplorerCommand } from './explorer/commands'
import type { MissionRuntime } from './missions/process-contract'
import type { ProcessGoals } from './longhorizon/process-store'
import type { ProcessWorkforce } from './workforce/process-store'
import { ProcessBrain } from './brain/process-store'
import { turnExperienceRecord } from './brain/turn-experience'
import { validateModelAttachments } from './model/provider'
import { randomUUID } from 'node:crypto'
import { EphemeralEventStore } from './events/ephemeral-store'
import { FallbackEventStore } from './events/fallback-store'
import { RuntimeDiagnostics, defaultDiagnosticsPath } from './runtime/diagnostics'
import { EventFabric } from './events/fabric'
import type { EventStore } from './events/store'
import { JsonlEventStore } from './events/jsonl-store'
import { JournalRepairError } from './events/atomic-journal-replacement'
import type { AnyCoreEvent } from './events/envelope'
import { initialCoreState, reduceCoreState, type CoreState } from './state'
import { projectCoreStatus } from './projections/core-status'
import { DefaultGuard, type Guard, type Principal } from './security/guard'
import { CognitionService } from './cognition/service'
import { ModelGateway, type GatewayRecorder } from './model/gateway'
import { emptyUsage } from './model/usage'
import type { ModelProvider } from './model/provider'
import { FakeModelProvider, SlowFakeModelProvider } from './model/fake-provider'
import { buildConfiguredModelProviders, modelCapabilityPreference, type CapabilityEnv } from './model/capability-runtime'
import type { CapabilityPreferences } from './capabilities'
import { MindService, type MindRuntime, type MindServiceOptions, type TurnExperience, type OwnerMessageEvent } from './mind/mind'
import type { ProcessRuntimeOptions } from '../shared/contracts/runtime'
import { CoreProcess } from './runtime/process-service'
import type { CoreOwnerPort } from './runtime/owner-port'
import { proposeMissionPlan, type MissionGoalRequest, type MissionGoalOutcome } from './mind/mission-planning'
import { registerFileInspection } from './work/file-inspection'
import { registerResearchInspection } from './work/research-inspection'
import { registerMissionBrowser, type MissionBrowserContext } from './work/browser-wiring'
import { BROWSER_MISSION_CAPABILITIES } from './work/browser-inspection'
import { createMissionProposalTool } from './mind/mission-proposal'
import { createMissionsListTool } from './mind/missions-list-tool'
import { createWorkspaceReportTool } from './mind/workspace-file-tool'
import { ChatMissionIntegration } from './missions/chat-integration'
import {
  chatMissionAuthorized,
  chatResearchAvailable,
  type ChatMissionGrantEnvironment,
} from './missions/chat-authorization'
import type { ChatMissionProposal } from './missions/chat-types'
import {
  evaluateExecutiveDecision,
  isExecutiveTriggerEvent,
  type ExecutiveDecisionOutcome,
  type ExecutiveState,
  type ExecutiveBudgetLimit,
  type ExecutiveBudgetSpend,
} from './executive'
import { LearningEngine } from './learning/engine'
import type { LearningStore } from './learning/store'
import { VaultLearningStore, MemoryLearningStore } from './vault/repositories/learning-store'
import type { LearningProjection, LearningWriteOutcome } from './protocol/learning'
import { ABSENT_LEARNING_PROJECTION } from './protocol/learning'
import { admitWorkStepOutcome } from './learning/work-admission'
import { recallRelevantLearning } from './learning/recall'
import { createWebSearchTool, createChartTool, createCanvasTool, MindToolRegistry } from './mind/tools'
import type { ToolCatalogueView } from './protocol/tool-catalogue'
import { MatrixService } from './matrix/service'
import { MATRIX_COMMANDS, type MatrixCommandName } from './protocol/matrix'
import { createMatrixTools } from './matrix/tools'
import { EncryptedAttentionScheduleStore, UnavailableAttentionScheduleStore, type AttentionScheduleTextStore } from './attention/schedule-store'
import { createWorkManagementTools } from './mind/work-management-tools'
import { createSystemInspectionTool } from './mind/system-inspection'
import { createBrowserTaskTool, type BrowserTaskPort } from './mind/browser-tool'
import { createBrowserTabsTool, type BrowserTabsPort } from './mind/browser-tabs-tool'
import type { ReferenceKnowledge } from './mind/context-compiler'
import { Brain, buildIdentityRoot, buildSelfDefinition, type BrainProjection } from './brain/brain'
import { ResearchIntegration } from './research/coreIntegration'
import { RESEARCH_LIMITS } from './research/schemas'
import { safeResearchError } from './research/errors'
import type { BrowserTargetFactory } from './research/browser'
import type { SearchProvider } from './research/types'
import {
  MemorySearchSessionStore,
  type SearchSession,
  type SearchSessionStore,
} from './research/sessions'
import type { ResearchResult } from './research/coordinator'
import type { BrainStore } from './brain/store'
import { EncryptedBrainStore } from './brain/encrypted-store'
import { MemoryBrainStore } from './brain/memory-store'
import type { Confidence, MemoryKind, Sensitivity } from './brain/types'
import { ConversationService } from './conversation/service'
import type { ConversationStore } from './conversation/store'
import { EncryptedConversationStore } from './conversation/encrypted-store'
import { MemoryConversationStore } from './conversation/memory-store'
import { CONVERSATION_LIMITS } from './conversation/types'
import { VoiceService } from './voice/service'
import { UnavailableSttAdapter } from './voice/stt'
import { UnavailableTtsAdapter } from './voice/tts'
import { LOCAL_ENERGY_WAKE_GATE, buildLocalWakeGate } from './voice/wake'
import type { VoiceSttAdapter, VoiceTranscriptFragment, VoiceTtsAdapter, WakeGate } from './voice/types'
import { WorkforceEngine, type WorkforceEngineOptions } from './workforce/engine'
import type { SubordinateWorkerScope, WorkforceOwnerScope } from './workforce/authority'
import { ABSENT_WORKFORCE_PROJECTION } from './workforce/projection'
import { isAssignableToWorker, isTerminalAssignmentStatus, workerPrincipalId } from './workforce/types'
import type { WORKFORCE_LIMITS } from './workforce/types'
import type { WorkforceProjection, WorkforceWorkerDetail } from './workforce/types'
import { MissionEngine, type WorkPort } from './missions/engine'
import type { MissionBudget, MissionCapabilityPort, MissionPriority } from './missions/autonomy/types'
import type { MissionAuthorityPort } from './missions/autonomy/authority'
import type { WorkRisk } from './work/types'
import {
  MissionAutonomyRuntime,
  type MissionEnginePort,
  type StepOutcome,
} from './missions/autonomy/runtime'
import type { DecisionTrigger } from './missions/autonomy/continuation'
import { ABSENT_MISSION_PROJECTION } from './missions/projection'
import type { MissionCommandOutcome, MissionDetail, MissionProjection } from './missions/types'
import { isTerminalMissionStatus } from './missions/types'
import type { CoreCommandName, MissionCommandOutcomeView } from './protocol/core-protocol'
import { ALL_CAPABILITIES } from '../shared/contracts/capabilities'
import type { MissionStore } from './missions/store'
import { EncryptedMissionStore } from './missions/encrypted-store'
import { MemoryMissionStore } from './missions/memory-store'
import {
  Vault,
  VaultConversationStore,
  VaultMissionStore,
  VaultGoalStore,
  VaultProactiveStore,
  VaultMetacognitionStore,
  VaultEvolutionStore,
  VaultResearchSessionStore,
  VaultWorldStore,
  type VaultBinding,
  type VaultKeyProvider,
} from './vault'
import {
  MetacognitionEngine,
  type MetacognitionStore,
  MemoryMetacognitionStore,
} from './metacognition'
import {
  StrategyLifecycleManager,
  type EvolutionStore,
  MemoryEvolutionStore,
} from './evolution'
import {
  ProactiveEngine,
  type ProactiveStore,
  MemoryProactiveStore,
  type NormalizedObservation,
  type ObservationSubscription,
  type ObservationSubscriptionInput,
  type ObservationIngestResult,
  type RawObservationInput,
} from './proactive'
import { GoalEngine, type GoalEngineOptions } from './longhorizon/engine'
import type { GoalStore } from './longhorizon/store'
import { MemoryGoalStore } from './longhorizon/memory-store'
import { VerificationEngine } from './longhorizon/verification'
import {
  ContinuationEngine,
  type ContinuationWake,
  type ContinuationDecisionOutcome,
} from './longhorizon/continuation'
import {
  validateGoalBudget,
  checkBudgetExhaustion,
  ZERO_GOAL_SPEND,
  type GoalBudgetPolicy,
  type GoalSpend,
  type MissionBudgetDerivationResult,
} from './longhorizon/budget'
import {
  GOAL_REASONS,
  type GoalCommandOutcome,
  type GoalContent,
  type GoalDetail,
  type GoalReason,
  type GoalVerifier,
} from './longhorizon/types'
import {
  type AdvisoryLessonInput,
  type DecompositionOptions,
  type RoadmapValidationResult,
  type BoundedMissionProposal,
  type GoalMilestone,
  type GoalMilestoneInput,
  type GoalRoadmapInput,
} from './longhorizon/decomposition'
import {
  ABSENT_GOAL_PROJECTION,
  type GoalProjectionView,
  type GoalCommandOperation,
  type GoalCommandOutcomeView,
} from './protocol/longhorizon'
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
  PersonalityIntegration,
  type PersonalityLifecycleEvent,
} from './personality/integration'
import { STANDING_RELEVANCE_TAGS } from './personality/directives'
import { PersonalityPersistenceRuntime } from './personalityPersistence'
import type { InteractionFactKind } from './personality/types'
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
import {
  ABSENT_WORLD_SUMMARY,
  WORLD_NO_PAYLOAD,
  type WorldCommandOutcome,
  type WorldSummaryView,
} from './protocol/world'
import {
  EphemeralWorldStore,
  WorldEngine,
  WORLD_FORBIDDEN_REQUEST_KEYS,
  WORLD_REFUSAL_REASONS,
  type WorldAdmissionRequest,
  type WorldEvidenceRequest,
  type WorldPersistencePort,
  type WorldReferenceRecord,
  type WorldSelfSource,
} from './world'
import { worldGraphOptionsFrom, worldKindFrom } from './world/command-parsing'
import { SkillEngine, type SkillOwnerScope } from './skills/engine'
import { SkillPersistenceRuntime } from './skillsPersistence'
import { ForgePersistenceRuntime } from './forgePersistence'
import { ForgeEngine, type ForgeCapabilityPort, type ForgeOwnerScope } from './forge/engine'
import { isForgeRuntimeKind, type ForgeOrigin, type ForgeRefusalCode } from './forge/types'
import {
  ABSENT_FORGE_PROJECTION,
  FORGE_NO_PAYLOAD,
  NO_FORGE_DOMAIN_REASON,
  type ForgeCommandOutcome,
  type ForgeProjection,
} from './protocol/forge'
import type { SkillExecutionPort } from './skills/execution'
import { OWNER_SUBMITTABLE_EVIDENCE_KINDS } from './skills/evaluation'
import {
  SKILL_REFUSAL_CODES,
  isSkillRetirementReason,
  isSkillStatus,
  type SkillRecord as SkillRecordShape,
} from './skills/types'
import { LifeEngine, type LifeOwnerScope } from './life/engine'
import { MemoryLifeStore, VaultLifeStore } from './vault/repositories/life-store'
import type { LifeStore } from './life/store'
import { isLifeEntryKind, type LifeEntryKind } from './life/types'
import {
  ABSENT_LIFE_PROJECTION,
  LIFE_NO_PAYLOAD,
  NO_LIFE_DOMAIN_REASON,
  type LifeProjection,
  type LifeTimelineView,
} from './protocol/life'
import {
  ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
  NO_CONSCIOUS_CONTEXT_REASON,
  type ConsciousContextProjection,
} from './protocol/consciousness'
import { projectConsciousContext } from './consciousness/projection'
import { continuityFromBrain } from './consciousness/adapters/brain'
import { lifeFrom } from './consciousness/adapters/life'
import { selfFromWorld } from './consciousness/adapters/self'
import { worldFromWorld } from './consciousness/adapters/world'
import { FoundryEngine } from './foundry/engine'
import { registerFoundryWorkCapabilities } from './foundry/work'
import {
  ABSENT_FOUNDRY_PROJECTION,
  FOUNDRY_NO_PAYLOAD,
  NO_FOUNDRY_DOMAIN_REASON,
  type FoundryProjection,
} from './protocol/foundry'
import { projectOffice, ABSENT_OFFICE_PROJECTION, type OfficeProjection } from './office/projection'
import {
  LifeLoopRuntime,
  projectLifeLoop,
  type LifeLoopPorts,
  type LifeLoopSnapshot,
  type LifeLoopWakeRequest,
} from './lifeloop'
import { LIFE_LOOP_LIMITS } from './lifeloop'
import type { LifeLoopJournalEntry } from './lifeloop'
import { pendingSchedules } from './attention/state'
import {
  checkGrant,
  isGrantActive,
  type CognitionGrant,
  type GrantContext,
} from './cognition/grants'
import {
  ABSENT_LIFE_LOOP_PROJECTION,
  NO_LIFE_LOOP_DOMAIN_REASON,
  type LifeLoopProjection,
} from './protocol/lifeloop'
import { DECIDE_OUTCOMES, type DecideOutcome, type LifeLoopLimitRequest, type PendingSchedule, type WakeKind } from './lifeloop'
import type { AttentionEventKind } from './attention/types'
import { RelayEngine, type RelayReadResult } from './relay/engine'
import type { RelayAdapterSet } from './relay/adapters'
import { projectRelay } from './relay/projection'
import type { RelayAction, RelayFailureCode } from './relay/types'
import type { RelayCommandOutcome, RelayProjection } from './protocol/relay'
import { ABSENT_RELAY_PROJECTION, RELAY_NO_PAYLOAD } from './protocol/relay'
import { ConnectorEngine, type ConnectorAuthPort, type ConnectorEngineResult } from './connectors/engine'
import { projectConnectors } from './connectors/projection'
import { connectorDefinition } from './connectors/catalog'
import { isReadAction } from './connectors/policy'
import { validateActionRequest } from './connectors/validation'
import type { ConnectorKind } from './connectors/types'
import type { ConnectorCommandOutcome, ConnectorProjection } from './protocol/connectors'
import { ABSENT_CONNECTOR_PROJECTION, CONNECTOR_NO_PAYLOAD } from './protocol/connectors'
import type { Capability } from '../shared/contracts/capabilities'
import type { CognitionCause, CognitionOrigin } from '../shared/contracts/security'
import type { CognitionGrantSpec } from './cognition/grants'
import type { OwnerAuthority, WorkerAuthority } from './authority'
import type { CoreLifecycle, CoreStatus, JournalFault } from '../shared/contracts/projections/core'
import type { PrincipalId } from '../shared/contracts/identity'
import type { CoreCommandEnvelope, CoreCommandResult, ResearchCommandOutcome } from './protocol/core-protocol'
import {
  EMPTY_COUNTS,
  RUNTIME_REGISTRY,
  RuntimeActivationController,
  type RuntimeEventType,
  type RuntimeFacts,
  type RuntimeJournalEntry,
  type RuntimePayload,
  type RuntimeProjection,
} from './runtime'

/** A journal nobody has damaged. Stated, not assumed. */
const HEALTHY_JOURNAL: JournalFault = {
  integrity: 'ok',
  reason: 'the event log was read in full and validated',
  line: null,
  eventsRead: 0,
  bytesDiscarded: 0,
}

/**
 * The closed greeting vocabulary.
 *
 * Twelve entries, matched against the *opening* of the owner's message after
 * salutation noise is stripped. It is a closed table on purpose: "a greeting was
 * received" is an interaction fact, and a fact this domain states has to be a fact
 * it can point at rather than one it inferred from tone.
 *
 * A message that is not on this list produces no greeting fact, and it is still
 * fully available to the directive table — the two readings are independent and
 * neither suppresses the other.
 */
const GREETING_OPENERS: readonly string[] = Object.freeze([
  'hi',
  'hey',
  'hello',
  'yo',
  'good morning',
  'good afternoon',
  'good evening',
  'morning',
  'afternoon',
  'evening',
  'howdy',
  'greetings',
])

/** Punctuation and salutation noise, stripped before an opener is compared. */
const GREETING_NOISE = /^[\s"'`*~_([{<>*#\-—–.!?,;:'`]+/

/**
 * Which interaction facts one owner turn produced.
 *
 * Pure, closed, and optimistic only where the gateway was. `exchange` is recorded
 * solely for a turn that reached a provider: a cancelled turn that never left the
 * process is not contact, and counting it would be exactly the optimistic
 * accounting C6 exists to forbid.
 */
function factsForOwnerMessage(message: OwnerMessageEvent): readonly {
  kind: InteractionFactKind
  tags: readonly string[]
}[] {
  const facts: { kind: InteractionFactKind; tags: readonly string[] }[] = []
  const trimmed = message.text.trim().replace(GREETING_NOISE, '')
  const words = trimmed.toLowerCase().split(/[\s,!?.]+/).filter((word) => word.length > 0)
  const opener = words[0] ?? ''
  const firstTwo = words.slice(0, 2).join(' ')
  if (GREETING_OPENERS.includes(opener) || GREETING_OPENERS.includes(firstTwo)) {
    facts.push({ kind: 'greeting-received', tags: Object.freeze(['greeting']) })
  }
  if (message.providerContacted) {
    facts.push({ kind: 'exchange', tags: Object.freeze(['exchange']) })
  }
  return Object.freeze(facts)
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
  env?: CapabilityEnv
  capabilityPreferences?: () => CapabilityPreferences
  now?: () => Date
  newId?: () => string
  /**
   * Test seam: supply providers directly, e.g. to inject a failing one.
   * When set, it is the *entire* provider set — production providers are not
   * added alongside it, so a test cannot accidentally exercise a real one.
   */
  providers?: ModelProvider[]
  /** Headless runtime: Core admits clients and owns its heartbeat. */
  processRuntime?: ProcessRuntimeOptions & { owner?: CoreOwnerPort }
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
  matrixKey?: Uint8Array | null
  attentionKey?: Uint8Array | null
  /** Context's independent secure key; absent means explicit process-only Context. */
  contextKey?: Uint8Array | null
  /**
   * Skills' independent encrypted persistence key. Null means explicit
   * process-only Skill storage; never plaintext fallback.
   */
  skillKey?: Uint8Array | null
  /**
   * Forge's independent encrypted persistence key, from the keyring.
   *
   * Its own domain label, its own file and its own key: a Forge store cannot
   * open the Skill store even when handed the same bytes, because the AAD prefix
   * differs by domain. Null means explicit process-only storage; never plaintext.
   */
  forgeKey?: Uint8Array | null
  /**
   * Personality's own independent secure key, from the keyring.
   *
   * A **fourth** independent secret, for the same reason as the other three: what
   * Freya has recorded about a person is about as intimate as this system holds,
   * and recovering the conversation key must never yield it. Null means the
   * relationship falls back to process-only storage, reports `durable: false` in
   * the projection, and — because anti-repetition depends on remembering what was
   * offered — serves **no expression guidance at all** rather than resetting its
   * memory. See `electron/keyring.ts` for why one key per domain is worth the
   * bookkeeping.
   */
  personalityKey?: Uint8Array | null
  /** Narrows the retained relationship bound. Can only lower the code ceiling. */
  personalityLimits?: { maxRelationshipItems?: number }
  /** Overrides the Mission content store wholesale. For tests. */
  missionStore?: MissionStore
  /** Overrides the Goal content store wholesale. For tests. */
  goalStore?: GoalStore
  /** Overrides the Proactive content store wholesale. For tests. */
  proactiveStore?: ProactiveStore
  /** Overrides the Metacognition content store wholesale. For tests. */
  metacognitionStore?: MetacognitionStore
  /** Overrides the Evolution content store wholesale. For tests. */
  evolutionStore?: EvolutionStore
  /**
   * Life History's own independent secure key, from the keyring.
   *
   * A **separate secret**, not a derivation of any other domain's key: what
   * Freya remembers of her own life is hers, and recovering another domain's key
   * must not yield it. Null means Life falls back to an ephemeral store and
   * reports `durable: false`.
   *
   * When a Vault is configured, Life records live in the one encrypted database
   * instead of a bespoke file, and this key is unused.
   */
  lifeKey?: Uint8Array | null
  /**
   * The canonical encrypted Vault, opt-in for the bounded first migration slice.
   *
   * When supplied, Core opens the one SQLCipher database at `path` with the key the
   * injected `keyProvider` returns, and Mission content lives there instead of in
   * the bespoke per-domain file. The production key provider (Windows DPAPI / OS
   * keyring) is wired in the main process, never here; this seam exists so the
   * foundation can be exercised end to end with a repository-local key.
   *
   * A Vault that cannot be opened is **fail-closed**: Missions fall back to an
   * explicitly ephemeral store that says so, never to a different durable store and
   * never to plaintext. The `Core` interface exposes no Vault handle, path or key.
   */
  vault?: {
    path: string
    keyProvider: VaultKeyProvider
    /** The selected SQLCipher-capable binding, injected by the host. */
    binding?: VaultBinding
  }
  /** Test/embedding seam. Production uses the canonical encrypted Vault when available. */
  learningStore?: LearningStore
  /**
   * What the host has actually wired, so the runtime registry can report it.
   *
   * Phase 40's registry describes each domain's requirements — a host adapter, a
   * capability grant — and asks whether they are met. Some of those live in the host
   * and never pass through Core: Phase 42's Device Hands seam is constructed in
   * `electron/main.ts` and reaches Core by nothing at all, so `core.device-hands`
   * could never satisfy its own `host-adapter` requirement no matter how completely
   * the host wired it. A runtime that reports `blocked` for a domain that is running
   * is not fail-closed, it is wrong.
   *
   * This is a **declaration of fact, not a grant**. Core records which adapters are
   * present and which capability names hold an owner-authored grant, and reports them
   * in `RuntimeFacts`. It takes no authority from them, mints nothing, and cannot act
   * on any of it: the registry only ever renders status. Anything stronger here would
   * be a back door around Guard, which is the opposite of the point.
   *
   * Absent means "the host told Core nothing", which every requirement then reports
   * unsatisfied. That is the safe direction for a declaration that can be forgotten.
   */
  runtimeFacts?: {
    /** Host adapter names present, e.g. `'device-hands'`. */
    readonly hostAdapters?: readonly string[]
    /** Capability names the host holds an active owner-authored grant for. */
    readonly capabilityGrants?: readonly string[]
  }
  /**
   * Overrides the world model's evidence store wholesale. For tests.
   *
   * There is deliberately **no `worldKey`**. Phase 22 used to take a key of its own and
   * write a bespoke encrypted file with it; `PLAN.md` §4 makes the one Vault the only
   * encrypted structured store, so a second key for a second file is exactly what this
   * lane must not reintroduce. World evidence now shares the Vault's key and its
   * database, which is also why it is not one key-compromise away from Mission content
   * any more — a consequence of one store, stated rather than hidden.
   *
   * With no Vault configured and no store supplied, the world falls back to an
   * explicitly ephemeral store that reports `durable: false` with a sentence saying
   * so. It never writes a second file and never writes plaintext.
   */
  worldStore?: WorldPersistencePort
  /** Narrows the world model's bounds. Can only lower the code ceilings. */
  worldLimits?: Partial<Record<string, number>>
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
  research?: {
    searchProvider: SearchProvider
    eyeSearchProvider?: SearchProvider
    browserFactory: BrowserTargetFactory
    /** Test/embedding seam. Production uses the canonical encrypted Vault when available. */
    sessionStore?: SearchSessionStore
  }
  /**
   * The dual-browser runtime, for a turn's `browser_read` tool.
   *
   * Optional, and absent means "no browser tool" — the Mind treats that as unwired,
   * so the turn takes the single-request path and the model is never *offered* the
   * tool. Core never constructs one: `createDualBrowserActivation` in
   * `electron/browser/activation.ts` owns it and hands the seam across.
   *
   * Held as the narrow `BrowserTaskPort` rather than the concrete runtime, because
   * the tool needs `execute` and nothing else, and a wider handle is a wider thing
   * to place in front of a model-driven loop.
   */
  readonly dualBrowser?: BrowserTaskPort
  /**
   * The Browser Service, for the multi-tab tool.
   *
   * Held separately from `dualBrowser` because the two doors are different: the reader tool
   * wants the routed command vocabulary and nothing else, and the tab tool wants the surface
   * that owns tab identity. Neither is a widened version of the other, and a single fat port
   * would let the reader tool see tab state it has no business inferring from.
   */
  readonly browserTabs?: BrowserTabsPort
  /** A speech-to-text engine. Absent means none is configured. */
  voiceStt?: VoiceSttAdapter  /** A speech output engine. Absent means none is configured. */
  voiceTts?: VoiceTtsAdapter
  /** A local wake gate. Absent means hands-free cannot be armed at all. */
  voiceWake?: WakeGate
  /**
   * Whether this platform offers a capture path.
   *
   * False reports `unsupported` from the first projection rather than offering a
   * button that cannot work. A host that knows it has no microphone says so here;
   * a host that does not know leaves it unset and the renderer reports the truth
   * from `navigator.mediaDevices` instead.
   */
  voiceCaptureSupported?: boolean
  /** Tightens the transcription deadline. Cannot raise it past the hard limit. */
  voiceTranscriptionTimeoutMs?: number
  voiceAttentionTimeoutMs?: () => number
  /** Whether voice-submitted answers are read aloud after they are stored. */
  voiceAutoSpeak?: boolean
  /** Let deterministic Attention speak/interrupt decisions use Voice output. */
  voiceProactiveAlerts?: boolean
  /** Initial output mute from the persisted TTS provider preference. */
  voiceMuted?: boolean
  /** Bounded follow-up window after the wake phrase is heard. */
  voiceFollowUpWindowMs?: number
  /** Overrides the conversation context budget. For tests. */
  contextBudget?: ContextBudget
  /**
   * Extra Work capabilities to register.
   *
   * The seam Phase 5 (Searcher, managed browser) and Phase 7 (Missions) attach
   * through. A capability is registered and nothing else changes: no engine edit,
   * no new execution path, no new event family.
   */
  workCapabilities?: readonly WorkCapability[]
  /**
   * Whether to register the Phase 6 fixture capabilities (`test.record`,
   * `test.failing`, `test.unverifiable`, `test.slow`, `test.consequential`,
   * and their verifiers).
   *
   * The capability surface a shipped Core exposes is a product question, not an
   * implementation one, and the answer is **no**: the only way to demonstrate
   * a Work run end to end through the product itself is to give it something to
   * drive, and these capabilities are the inert test set that does that. They
   * are kept for the e2e and the test suite, and not because a real run is ever
   * supposed to invoke `test.failing` against a user.
   *
   * The decision is therefore explicit and never inferred:
   *   - `undefined` and `false` (the default): no Phase 6 capabilities.
   *   - `true`: Phase 6 capabilities registered alongside whatever `workCapabilities` adds.
   *
   * Production code sets neither; the e2e and the `createCore` test fixtures
   * set it to `true`. The opt-in is the single gate, and it is named for what
   * it is so a reader can find the call sites with `git grep testCapabilities`.
   */
  testCapabilities?: boolean
  /** Trusted host authorization for read-only mission file metadata; empty by default. */
  missionReadRoots?: readonly string[]
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
  /**
   * The Phase 16 Relay seam: the connector adapters, injected whole.
   *
   * The *entire* integration surface this lane assumes: Core may be handed a set
   * of connector adapters, and with them it can route email, calendar, GitHub
   * and external actions. Unset ??? the state of every build until this domain
   * exists ??? Core reports every connector `unavailable` and refuses every
   * action with a stated reason, which is the honest reading rather than a
   * placeholder connector.
   *
   * An adapter is the only place a credential can exist. Core holds the object
   * but cannot inspect it: the ports in `core/relay/adapters.ts` have no method
   * that returns a token, and no payload field one could hide in. A renderer
   * never sees an adapter, a projection never names one, and the journal never
   * could.
   *
   * A source carries no authority by virtue of being one. It can be called,
   * through the engine, after Guard, budget, approval and STOP ALL ??? and it
   * cannot be reached any other way.
   */
  relay?: {
    adapters: RelayAdapterSet
    /**
     * The GitHub repos writes may target. Code-owned and host-supplied; empty
     * means no repo may be written to. Registering a GitHub adapter does not
     * put any repo on this list.
     */
    allowlistedRepos?: readonly string[]
    /**
     * The Telegram chats reads and sends may target. Code-owned and
     * host-supplied; empty means no chat may be read from or written to.
     */
    allowlistedChats?: readonly string[]
  }
  /**
   * The Phase 44 connector connection plane.
   *
   * Unset means this Core has no connector domain: the projection reports
   * `unavailable` and every connector command is refused with a stated reason,
   * which is the honest reading rather than a simulated connection.
   *
   * The `auth` port is the host's authorization seam. It returns a URL and a
   * configuration status — never a token. Tokens live in the host's secure
   * store; Core never holds one, so a credential cannot reach the journal, a
   * projection or the renderer.
   *
   * The action plane is Relay, which Core already owns. A connector write is
   * forwarded to Relay, so there is exactly one approval system and one budget
   * ledger.
   */
  connectors?: {
    auth: ConnectorAuthPort
    /** Connectors policy refuses outright. Code-owned and host-supplied. */
    blocked?: readonly ConnectorKind[]
  }
  /**
   * The Phase 23 Continuous Life Loop.
   *
   * Composition, like `research`, `workforceSource` and `attentionObserveSources`:
   * the production host turns it on and a test that does not care about it leaves
   * it off, so a completed Run does not silently add `lifeloop.*` lines to a
   * journal it is asserting on.
   *
   * **Absent is not "off".** An absent option builds the loop with its wake sources
   * unconnected, so nothing can wake it and it can spend nothing; it is a real
   * domain reporting `unavailable`, not a missing subsystem. That is the same
   * distinction every other seam in this interface draws, and it is why the option
   * carries no `disabled` flag: there is nothing here a host could set that would
   * make the loop cheaper, only quieter.
   *
   * Nothing in this option can widen a bound. `limits` is clamped down to the
   * frozen ceilings and a raise is ignored rather than applied, so a
   * misconfigured host gets the tighter of the two behaviours.
   */
  lifeLoop?: {
    /**
     * Whether Core's own subsystems wake the loop on their terminal events.
     *
     * Off by default for the same reason `attentionObserveSources` is: a test that
     * does not care about the loop should not have its journal perturbed by it.
     * The production host turns this on.
     */
    observeSubsystemEvents?: boolean
    /** Narrowed ceilings. Can only *lower* the code-owned limits. */
    limits?: LifeLoopLimitRequest
  }
  /** Approved workspace root directory for saving verified reports. */
  workspaceRoot?: string
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
  detectVoiceWake(): Promise<boolean>
  /**
   * Subscribe to the voice projection.
   *
   * Pushed on every move of the voice state machine — permission resolving, a
   * capture opening, a transcription finishing, STOP ALL landing — so a window's
   * listening indicator is Core's state rather than a flag the window set itself.
   */
  onVoice(listener: (projection: VoiceProjection) => void): () => void
  /**
   * Subscribe to transcript fragments.
   *
   * Interim fragments arrive here while an engine is still revising its guess, and
   * a final one arrives when it has stopped. Interim text is display-only: there
   * is no command anywhere in this protocol that would submit it, so a window
   * cannot execute a guess even if it tried.
   */
  onVoiceTranscript(listener: (fragment: VoiceTranscriptFragment) => void): () => void
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
  onGoals(listener: (projection: GoalProjectionView) => void): () => void
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
   * Core's account of long-horizon Goals (Phase 5). Derived from the journal, content encrypted.
   */
  goals(): GoalProjectionView
  /**
   * Mark a Mission's goal as ready to be planned.
   *
   * `draft → active` is Phase 7's door for a hand-driven Mission and deliberately skips
   * planning. The autonomy loop starts from `ready`, so this is how a Mission is handed over
   * to it.
   */
  readyMission(missionId: string): Promise<MissionCommandOutcome | null>
  /**
   * Advance one Mission by exactly one decision.
   *
   * The single public door to the autonomy loop. `trigger` is required — a caller says why
   * it is asking, and the reason is journalled with the decision.
   *
   * **There is no loop.** No method advances until a Mission settles, and no timer calls
   * this on a cadence: a Mission moves because somebody asked it to, once. A scheduler here
   * would be a hidden continuous inference, which is the thing this subsystem must not have.
   *
   * `null` means the runtime is not built, which a surface can render rather than crash on.
   */
  advanceMission(missionId: string, trigger: DecisionTrigger): Promise<StepOutcome | null>
  planMissionGoal(input: MissionGoalRequest, revision?: boolean): Promise<MissionGoalOutcome>
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
   * One Goal's private content, decrypted from the Goal store (Phase 5).
   */
  goalDetail(goalId: string): Promise<GoalDetail | null>
  /**
   * Propose a structured milestone roadmap for a long-term goal informed by learning (Phase 5B).
   */
  proposeGoalRoadmap(goalId: string, options?: DecompositionOptions): Promise<RoadmapValidationResult>
  /**
   * Elaborate an eligible milestone into a bounded Mission specification (Phase 5B).
   */
  elaborateMilestoneMission(goalId: string, milestoneId?: string): Promise<BoundedMissionProposal | null>
  /**
   * Set or update a goal's budget policy (Phase 5C).
   */
  setGoalBudget(goalId: string, budget: Partial<GoalBudgetPolicy>): Promise<GoalCommandOutcome>
  /**
   * Record spend against a goal's budget policy (Phase 5C).
   */
  recordGoalSpend(goalId: string, incremental: Partial<GoalSpend>): Promise<GoalCommandOutcome>
  /**
   * Derive a strictly bounded MissionBudget for an eligible milestone Mission (Phase 5C).
   */
  deriveMilestoneMissionBudget(goalId: string, requested?: Partial<MissionBudget>): MissionBudgetDerivationResult
  /**
   * Handle an authorized continuation wake (Phase 5C).
   */
  handleContinuationWake(wake: ContinuationWake): Promise<ContinuationDecisionOutcome>
  /**
   * Ingest and normalize an event observation (Phase 6A).
   */
  ingestObservation(input: RawObservationInput): Promise<ObservationIngestResult>
  /**
   * Register an authorized external observation source subscription (Phase 6A).
   */
  subscribeObservationSource(input: ObservationSubscriptionInput): Promise<ObservationSubscription>
  /**
   * Revoke an observation source subscription (Phase 6A).
   */
  revokeObservationSource(subscriptionId: string): Promise<boolean>
  /**
   * List active observation source subscriptions (Phase 6A).
   */
  observationSubscriptions(): readonly ObservationSubscription[]
  /**
   * Read recent normalized observations (Phase 6A).
   */
  recentObservations(limit?: number): readonly NormalizedObservation[]
  /**
   * Metacognition engine (Phase 7A).
   */
  metacognition(): MetacognitionEngine | undefined
  /**
   * Read-only evolution status. Never expose the mutable lifecycle or its approval
   * verbs through Core's public surface (an agent can hold a Core reference).
   */
  evolution(): Readonly<Pick<StrategyLifecycleManager, 'getActiveStrategy' | 'getPromotionHistory' | 'getRollbackHistory'>> | undefined
  /**
   * Read-only candidate information. Approval records and store writes remain Core-owned.
   */
  evolutionStore(): Readonly<Pick<EvolutionStore, 'mode' | 'durable' | 'faultReason' | 'getCandidate' | 'readCandidates'>> | undefined
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
  /** Actual conversation tool metadata. Reading this invokes no tools. */
  toolCatalogue(): ToolCatalogueView
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
  /** Core's content-free Foundry projection, derived from the durable journal. */
  foundry(): FoundryProjection
  /** Subscribe to the Foundry projection. No mutation authority crosses this seam. */
  onFoundry(listener: (projection: FoundryProjection) => void): () => void
  /**
   * Core's account of the Office: Freya's station, live run stations, worker
   * stations, approval stations and the history timeline.
   *
   * Read-only, and derived entirely from Core's own Work, Workforce and status
   * projections. A window holds what Core last built and cannot write a field
   * of it. There is no method here that invents a station, inflates a count or
   * fabricates a percentage: the Office is a pure function of real state, and
   * the shape of the read is the whole policy.
   */
  office(): OfficeProjection
  /** Subscribe to the Office projection. Same mirror semantics as the others. */
  onOffice(listener: (projection: OfficeProjection) => void): () => void
  /** Core's content-free Relay projection, derived from durable Relay events. */
  relay(): RelayProjection
  /** Subscribe to the Relay projection. No connector authority crosses this seam. */
  onRelay(listener: (projection: RelayProjection) => void): () => void
  /**
   * Core's connector connection projection.
   *
   * A mirror of the connection plane: closed states, display labels, scope
   * names, capability flags and event metadata. No token, no client secret and
   * no event content is a field of it.
   */
  connectors(): ConnectorProjection
  /** Subscribe to the connector projection. Same mirror semantics as the others. */
  onConnectors(listener: (projection: ConnectorProjection) => void): () => void
  /**
   * Complete an authorization. **Host-only; never a renderer command.**
   *
   * The host has already verified state, nonce and PKCE and holds the token in
   * its secure store; this records the non-secret outcome so Core can report the
   * connection truthfully. It is deliberately not in the command vocabulary.
   */
  connectorAuthorizationComplete(payload: unknown): Promise<ConnectorCommandOutcome>
  /**
   * Deliver an authenticated external event. **Host-only; never a renderer
   * command.** An event grants nothing and has no path to an action.
   */
  connectorEventIngest(payload: unknown): Promise<ConnectorCommandOutcome>
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
   * Core's account of the Continuous Life Loop: where the loop is, what woke it,
   * what it concluded and how loudly it was allowed to say so, whether it is
   * waiting on something and until when, and the eight zero-idle-inference
   * assertions by name.
   *
   * Read-only, and the shape of the read is the whole policy. There is no field
   * for a prompt, a provider's answer, the text of the event that woke the loop,
   * or a refusal's free-form reason — each is replaced by a closed code, a counter
   * or an id, for the reason the journal holds metadata too: the least protected
   * file in the system must not become a transcript of what Freya was thinking.
   *
   * **There is deliberately no `lifeloop.*` command anywhere in the Core
   * vocabulary.** A window may see that Freya is waiting; it cannot wake her, make
   * her think, spend on her, lift a stop or shorten a deadline. The absence of a
   * write verb is the property rather than an omission — the same argument that
   * keeps `consciousness.*` out of the vocabulary.
   *
   * Never null: a Core that has not started, or was built without the loop, reports
   * `unavailable` with a stated reason, because "Freya is idle" and "there is no
   * continuous life loop" are different facts.
   */
  lifeLoop(): LifeLoopProjection
  /** Subscribe to the life-loop projection. Same mirror semantics as the others. */
  onLifeLoop(listener: (projection: LifeLoopProjection) => void): () => void
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
   * promotes, retires, evaluates or executes a skill ??? every one of those is an owner
   * command Core handles behind Guard.
   */
  skills(): SkillProjection
  /** Subscribe to the Skills projection. Same mirror semantics as the others. */
  onSkills(listener: (projection: SkillProjection) => void): () => void
  /**
   * Core's account of Forge: generated and acquired packages, their lifecycle
   * status, validation verdicts, approval state, quarantine reasons and last runs.
   *
   * Read-only, and the shape of the read is the whole policy. A package's program
   * and description are not fields of the projection: they cross only through an
   * explicit  orge.detail.read for one package, to the owner. The projection also
   * carries 
untimeNotice, which states what the runtime cannot do, because a
   * generated package that cannot reach the filesystem is a fact a person needs
   * rather than a surprise.
   */
  forge(): ForgeProjection
  /** Subscribe to the Forge projection. Same mirror semantics as the others. */
  onForge(listener: (projection: ForgeProjection) => void): () => void
  /**
   * Core's account of its own life history: episodes, milestones, periods and
   * themes as metadata, and whether they survive a restart.
   *
   * Read-only, and the shape of the read is the whole policy. An entry's own
   * summary and body are not fields of the projection: they cross only through
   * an explicit `life.entry.read` for one entry, to the owner. There is no
   * method here that records, revises, consolidates or withdraws — every one of
   * those is an owner-scope act Core handles internally.
   */
  life(): LifeProjection
  /** Subscribe to the Life History projection. Same mirror semantics as the others. */
  onLife(listener: (projection: LifeProjection) => void): () => void
  /** Read what Freya has learned: outcomes, distilled lessons and active claims. */
  learning(): LearningProjection
  /** Subscribe to the Learning projection. Same mirror semantics as the others. */
  onLearning(listener: (projection: LearningProjection) => void): () => void
  /** Direct engine handle for internal reasoning and planning recall. */
  learningEngineInstance(): LearningEngine | undefined
  /** Correct an admitted knowledge record (replaces claim, superseding original). */
  correctLearningClaim(recordId: string, replacement: { claim: string; reason: string }): Promise<LearningWriteOutcome>
  /** Withdraw an admitted knowledge record (retracts claim, destroying claim text while retaining audit trail). */
  withdrawLearningClaim(recordId: string): Promise<LearningWriteOutcome>
  /** The explainable Executive decision for competing goals and resource allocation (Phase 4). */
  executiveDecision(options?: {
    readonly explicitPriorities?: ReadonlyMap<string, MissionPriority>
    readonly budgetLimits?: ReadonlyMap<string, ExecutiveBudgetLimit> | Readonly<Record<string, ExecutiveBudgetLimit>>
    readonly budgetSpends?: ReadonlyMap<string, ExecutiveBudgetSpend> | Readonly<Record<string, ExecutiveBudgetSpend>>
    readonly requiredSpecialisations?: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>
    readonly missionAges?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  }): ExecutiveDecisionOutcome
  /** The explainable Executive state projection (Phase 4). */
  executiveState(options?: {
    readonly explicitPriorities?: ReadonlyMap<string, MissionPriority>
    readonly budgetLimits?: ReadonlyMap<string, ExecutiveBudgetLimit> | Readonly<Record<string, ExecutiveBudgetLimit>>
    readonly budgetSpends?: ReadonlyMap<string, ExecutiveBudgetSpend> | Readonly<Record<string, ExecutiveBudgetSpend>>
    readonly requiredSpecialisations?: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>
    readonly missionAges?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  }): ExecutiveState
  /** Subscribe to event-driven Executive decisions (Phase 4C). */
  onExecutiveDecision(listener: (outcome: ExecutiveDecisionOutcome) => void): () => void
  /** The last event-driven Executive decision outcome (Phase 4C). */
  lastExecutiveDecision(): ExecutiveDecisionOutcome | null
  /**
   * The World & self summary and its subscription.
   *
   * A summary rather than the graph, on purpose: the graph is available on demand and
   * bounded, and a standing push of every node and edge would hand a window the whole
   * map of the owner's world without it asking for one.
   */
  world(): WorldSummaryView
  onWorld(listener: (projection: WorldSummaryView) => void): () => void
  /**
   * Core's one coherent account of what it currently understands about itself and
   * its situation.
   *
   * Read-only, derived, and stored nowhere. There is no table, no key, no store,
   * no cache and no journal entry behind it: every value in it is a function of a
   * projection this Core already builds — Work, Mission, Workforce, Skills,
   * Personality, Attention, Context, Office, Relay, the Brain, Life, Self/World and
   * `CoreStatus` — so a surface can read the whole situation from one object
   * instead of reconstructing the subsystems and getting a different answer each
   * time. Holding no state is what makes it unable to become a second source of
   * truth or to drift from the subsystems it describes.
   *
   * The shape of the read is the whole policy. There is no field for memory
   * content *or* a memory's subject, a Mission's title or intent, a Context
   * item's content or label or uri, a relationship item's text, an Attention
   * event's text, a Workforce message body, a Work approval's justification or
   * proposal, a connector payload, a credential, a raw prompt, a life entry's
   * narrative, or an activity row's sentence — each is replaced by an id, a closed
   * code or a measured length, and each omission is listed at the top of
   * `core/consciousness/projection.ts`.
   *
   * Every section states whether it could be built (`state`) and why not (`note`),
   * and `provenance` states per source whether it is `authoritative` or `derived`
   * and whether it is `fresh`, `stale`, `absent` or `unknown`. A subsystem that is
   * not present is reported as absent — never as an empty list, which would read
   * as "there is nothing".
   *
   * `PLAN.md` §6 requires Life (Phase 21) and Self/World (Phase 22) as
   * contributors, and both have now landed: `life` reads the real Life History
   * projection, and `self`, `world` and `continuity` are read through the narrow
   * input ports in `core/consciousness/ports.ts`, satisfied by the real Phase 21/22
   * domains rather than by the Brain. The integration steps are documented in
   * `docs/PHASE-20.md`.
   *
   * There is deliberately no `consciousness.*` command anywhere in the Core
   * vocabulary. A pull channel and a push channel are enough for a read, and the
   * absence of a write verb is the property rather than an omission.
   */
  consciousness(now?: Date): ConsciousContextProjection
  /** Subscribe to the conscious context. Same mirror semantics as the others. */
  onConsciousness(listener: (projection: ConsciousContextProjection) => void): () => void
  /**
   * Core's account of which implemented domains are actually active.
   *
   * Read-only and derived from the activation journal plus the live fact set.
   * There is no method on this interface that activates, deactivates or
   * reconfigures a domain: activation is a lifecycle concern owned by Core, not a
   * command a window may issue. The shape of the read is the whole policy — every
   * domain states its status, its reason and the dependency that is missing.
   */
  runtime(): RuntimeProjection
  /** Subscribe to the runtime activation projection. Same mirror semantics. */
  onRuntime(listener: (projection: RuntimeProjection) => void): () => void
  readonly lifecycle: CoreLifecycle
}



class FreyaCore implements Core {
  private sourceWorkspace: SourceWorkspace | null = null
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
   * How the active event store is being persisted. Set in `start()` once the
   * store is chosen. `durable` for the JSONL store, `ephemeral-fallback`
   * when the durable store could not be opened.
   */
  private persistence: {
    mode: 'durable' | 'ephemeral-fallback'
    durable: boolean
    reason: string | null
    eventStorePath: string | null
  } = { mode: 'durable', durable: true, reason: null, eventStorePath: null }

  /**
   * The runtime diagnostics writer. Independent of the EventStore so a
   * failure that takes the journal down still leaves evidence on disk for
   * the operator to find.
   */
  private diagnostics: RuntimeDiagnostics | null = null

  /**
   * Whether the process is operationally able to serve commands. Distinct
   * from `lifecycle`: a Core can be `degraded` (one subsystem is unhealthy)
   * and still operational, and a Core that fell back to ephemeral mode is
   * operational even though its history is not durable.
   */
  private operational: boolean = false

  /**
   * The most recent lifecycle transition, surfaced on the status projection
   * so the UI can show "what changed" without scanning the journal.
   */
  private lastLifecycleTransition: { from: CoreLifecycle; to: CoreLifecycle; at: string; reason: string | null } | null = null

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
  private readonly goalListeners = new Set<(projection: GoalProjectionView) => void>()
  private readonly workforceListeners = new Set<(projection: WorkforceMirror) => void>()
  private readonly contextListeners = new Set<(projection: ContextProjectionView) => void>()
  private readonly learningListeners = new Set<(projection: LearningProjection) => void>()
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
   * The Phase 11 Personality seam, or null when nothing has filled it.
   *
   * Read-only in the strongest sense available: `projection()` answers and
   * `subscribe?` follows. There is no admission method, no ledger writer and no
   * interpretation hook on the other side of this field, so the seam cannot be
   * used to *record* anything about the person, only to report what Core already
   * holds.
   *
   * A filled seam takes precedence over Core's own integration when a window asks,
   * and the integration stays the authoring half either way: the Mind reads from
   * the integration, and a relationship the interpreter cannot see is one that
   * cannot shape a single reply.
   */
  private personalitySource: PersonalitySource | null
  /** Detaches Core from the Personality source's change channel. Set once, at start. */
  private disposePersonalitySource: () => void = () => {}
  private readonly skillListeners = new Set<(projection: SkillProjection) => void>()
  private readonly lifeListeners = new Set<(projection: LifeProjection) => void>()
  /**
   * The Phase 21 Life History engine, built and owned by Core.
   *
   * Built after the Brain because it derives from it and from the journal, and
   * before the Mind because nothing in the Mind may reach it. It holds the
   * store, the journal port and the clock, and no gateway, no provider and no
   * model: its only way to produce an entry is `admitLifeEntry`, which caps
   * confidence, refuses secret-shaped text and refuses a derived entry with no
   * evidence.
   */
  private lifeEngine: LifeEngine | undefined
  /**
   * Subscribers to the unified conscious context.
   *
   * A single set rather than one per contributing subsystem, because there is one
   * object to push: the whole point of Phase 20 is that a surface reads one
   * snapshot instead of reconstructing eleven projections, and eleven
   * subscriptions would hand that convenience straight back.
   *
   * It is a notification list and nothing more. The snapshot itself is recomputed
   * per read and held nowhere, so this set cannot become a cache of it.
   */
  private readonly consciousnessListeners = new Set<
    (projection: ConsciousContextProjection) => void
  >()
  /**
   * Core's own Personality & Relationship integration, built at `start()`.
   *
   * This is the authoring half: it holds the records, applies the lifecycle,
   * owns the anti-repetition ledger and produces the projection. The seam above is
   * the *mirror* half, and when both exist the seam is served — but the records
   * live here either way, because the Mind reads from here and a relationship the
   * interpreter cannot see is a relationship that cannot shape a single reply.
   */
  private personalityDomain: PersonalityIntegration | undefined
  private personalityPersistence: PersonalityPersistenceRuntime | undefined
  /** Health already reported to the journal, so degradation is announced once. */
  private personalityDegradedReported = false
  private readonly attentionListeners = new Set<(projection: AttentionProjection) => void>()
  private readonly lifeLoopListeners = new Set<(projection: LifeLoopProjection) => void>()
  private readonly runtimeListeners = new Set<(projection: RuntimeProjection) => void>()
  private readonly executiveListeners = new Set<(outcome: ExecutiveDecisionOutcome) => void>()
  private lastExecutiveDecisionOutcome: ExecutiveDecisionOutcome | null = null
  /**
   * The Phase 40 runtime activation controller.
   *
   * The one owner of the activation record and the lifecycle decisions of the
   * domains registered in `core/runtime/registry.ts`. It holds no authority of
   * its own: every status it reports is a dependency measurement or a journaled
   * decision, and the only side effect it can cause is calling a registered
   * handler's `start` or `stop`.
   */
  private activation: RuntimeActivationController | undefined
  /**
   * The Phase 23 Continuous Life Loop, built and owned by Core.
   *
   * Built last, because everything it reads is already built by then: Attention for
   * the schedules and the focus reading, the Cognition service for the only route to
   * a model it has, Mission and Work for what it verifies, and the fabric for the
   * journal its entire state is folded from.
   *
   * The runtime holds no gateway, no provider, no principal and no capability
   * object. Every one of those is reached through a port Core fills here, and the
   * one that can spend is filled with the Governor, the Gateway and an
   * owner-created grant — machinery that already existed. That is the whole of the
   * phase's safety claim: the loop cannot reach around a gate, because it has no
   * handle on any of them.
   *
   * Optional rather than definite so `lifeLoop()` can report `unavailable` during
   * startup instead of throwing, the same way `brain()` does.
   */
  private lifeLoopRuntime: LifeLoopRuntime | undefined
  private readonly officeListeners = new Set<(projection: OfficeProjection) => void>()
  /**
   * The Phase 12 Attention engine, or undefined before `start()`.
   *
   * Built by Core and owned by Core. It holds no authority, no gateway and no
   * provider: the only thing it can do is append `attention.*` metadata and read
   * already-authorized state for the focus reading.
   */
  private attentionEngine: AttentionEngine | undefined
  private attentionScheduleStore: AttentionScheduleTextStore | undefined
  private matrixService: MatrixService | undefined
  /**
   * The Phase 17 Skill engine, built and owned by Core.
   * It has no model gateway and no provider authority.
   */
  private skillEngine: SkillEngine | undefined
  private skillPersistence: SkillPersistenceRuntime | undefined
  /** The Phase 48 Forge domain: candidates, validation, install, enable and bounded runs. */
  private forgeEngine: ForgeEngine | undefined
  private forgePersistence: ForgePersistenceRuntime | undefined
  private readonly forgeListeners = new Set<(projection: ForgeProjection) => void>()
  /**
   * The Phase 22 Self & World engine, built and owned by Core.
   *
   * It holds no model gateway, no provider and no authority object, so it cannot spend
   * a call, mint a capability or clear STOP ALL — and because it holds none, there is
   * nothing in it for STOP ALL to have to stop. It reads Mission, Work, Workforce,
   * Skills, Foundry, the Brain and Guard through narrow ports, and stores only its own
   * evidence: nothing here duplicates another domain's state.
   */
  private worldEngine: WorldEngine | undefined
  private readonly worldListeners = new Set<(projection: WorldSummaryView) => void>()
  private readonly foundryListeners = new Set<(projection: FoundryProjection) => void>()
  /** The Phase 15 Foundry domain, owned by Core and replayed from the durable journal. */
  private foundryEngine: FoundryEngine | undefined
  private readonly relayListeners = new Set<(projection: RelayProjection) => void>()
  /** The Phase 16 Relay engine, built and owned by Core. */
  private relayEngine: RelayEngine | undefined
  private readonly connectorListeners = new Set<(projection: ConnectorProjection) => void>()
  /** The Phase 44 connector connection plane, built and owned by Core. */
  private connectorEngine: ConnectorEngine | undefined
  /**
   * Connector admission.
   *
   * Closed synchronously by STOP ALL, before that command's first `await`, for
   * the same reason Relay admission is: a connector action that checked
   * admission and then awaited could reach an external provider after the stop.
   */
  private connectorAdmissionOpen = false
  /** Display-ready activity, rebuilt from the log on every start. */
  private activityFeed: CoreActivityEvent[] = []
  private readonly newId: () => string
  private disposeState: () => void = () => {}
  private stopped = false
  private conversationStore!: ConversationStore
  private brainService!: Brain | ProcessBrain
  /** Null when the host configured no research stack. Every command then refuses. */
  private researchIntegration: ResearchIntegration | null = null
  /**
   * The browser seam for a turn's tool, or null when the host has not activated a
   * dual-browser runtime. Kept separate from `researchIntegration` on purpose: the
   * two are different capabilities with different hosts, and an install can have
   * either without the other.
   */
  private dualBrowser: BrowserTaskPort | null = null
  /** The Browser Service port for the multi-tab tool. Null until the host mounts it. */
  private browserTabs: BrowserTabsPort | null = null
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
  /**
   * Relay admission.
   *
   * Closed synchronously by STOP ALL, before that command's first `await`.
   * A Relay action that checked admission and then awaited would be able to
   * reach an external connector after the stop, which is the window STOP ALL
   * exists to remove. Deliberately a boolean rather than derived state: it has
   * to be readable without asking anything that could be slow.
   */
  private relayAdmissionOpen = false
  private mind!: MindRuntime
  private processRuntime: CoreProcess | null = null
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
  private selectedProviderId: string | null = null
  /**
   * The Work engine, or undefined before it is built.
   *
   * Optional rather than definite so that `work()` can report `unavailable` during
   * startup instead of throwing, the same way `brain()` does.
   */
  private workEngine: WorkEngine | undefined
  private missionEngine: MissionRuntime | undefined
  private goalEngine: GoalEngine | ProcessGoals | undefined
  private goalStore: GoalStore | undefined
  private continuationEngine: ContinuationEngine | ProcessGoals['continuation'] | undefined
  private chatMissions: ChatMissionIntegration | undefined
  private learningEngine: LearningEngine | undefined
  private learningStore: LearningStore | undefined
  private proactiveEngine: ProactiveEngine | undefined
  private proactiveStore: ProactiveStore | undefined
  private metacognitionEngine: MetacognitionEngine | undefined
  private metacognitionStore: MetacognitionStore | undefined
  private strategyLifecycle: StrategyLifecycleManager | undefined
  private evolutionStoreInstance: EvolutionStore | undefined
  private readonly observedMissions = new Set<string>()
  private readonly observingMissions = new Set<string>()
  /**
   * The canonical encrypted Vault, or null when the host supplied none or it could
   * not be opened. Held privately so that Mission content has one owner of the
   * connection; nothing on the `Core` interface can reach it.
   */
  private vault: Vault | null = null
  /**
   * Why the Vault could not be opened, once it has been tried and failed.
   *
   * Latched so every domain that wanted the Vault reports the same sentence instead of
   * each retrying and each inventing its own wording. Null means "not tried, or fine".
   */
  private vaultFault: string | null = null
  /**
   * The Workforce engine, or undefined before it is built.
   *
   * Optional for the same reason `missionEngine` is: `workforce()` has to report
   * `unavailable` during startup rather than throwing, so a surface can render "Core is
   * not up yet" without special-casing the failure.
   */
  private workforceEngine: WorkforceEngine | ProcessWorkforce | undefined
  private mindToolRegistry: MindToolRegistry | null = null
  private workRegistry: WorkRegistry | undefined

  /**
   * The Mission autonomy runtime, or undefined when it was not built.
   *
   * Optional rather than throwing, for the same reason `missionEngine` is: `mission()` and
   * `advanceMission()` have to report "not up yet" instead of raising, so a surface can
   * render that plainly during startup.
   */
  private missionAutonomy: MissionAutonomyRuntime | undefined
  private readonly missionPlanning = new Set<string>()
  private readonly missionAdvancing = new Map<string, Promise<StepOutcome | null>>()

  constructor(private readonly options: CoreOptions) {
    this.processRuntime = options.processRuntime ? new CoreProcess(options.processRuntime, options.env ?? {}, options.developerProvider, options.processRuntime.owner, options.workspaceRoot) : null
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
   * Move the Core to a new lifecycle, recording the transition for the status
   * projection and the diagnostics log. Use this for every `currentLifecycle`
   * assignment so an operator can always see what the last change was and
   * why.
   */
  private setLifecycle(next: CoreLifecycle, reason: string | null): void {
    const previous = this.currentLifecycle
    if (previous === next) return
    this.currentLifecycle = next
    this.lastLifecycleTransition = {
      from: previous,
      to: next,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      reason,
    }
    this.diagnostics?.record({
      at: this.lastLifecycleTransition.at,
      level: next === 'degraded' ? 'warn' : 'info',
      component: 'core.lifecycle',
      event: 'lifecycle_transition',
      message: `lifecycle ${previous} -> ${next}`,
      lifecycleBefore: previous,
      lifecycleAfter: next,
    })
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

  /**
   * The owner's face of Life History.
   *
   * Same shape of decision as `issueSkillOwnerScope`, for the same reason: holding
   * the object *is* the authority, so there is no capability string a caller could
   * pass to acquire it, and this method is not on the `Core` interface. It is
   * reachable from `core/testing.ts` and from inside this module only.
   *
   * Recording, consolidation, revision and withdrawal all hang off this one object,
   * and a *subordinate* scope does not exist: there is no agent route into the Life
   * lifecycle, because "an agent that can record its own autobiography" is a
   * self-authored history with a method name instead of a capability string.
   */
  issueLifeOwnerScope(): LifeOwnerScope {
    return this.requireLife().ownerScope()
  }

  /**
   * TEST SEAM: classify a reference through the verify port.
   *
   * The verify port is `private` and is exposed to the loop only through
   * `lifeLoopPorts`. C2-A's discrimination lives in `classifyReference` and
   * is reachable from the loop's runtime, but a runtime test would assert
   * the journal's `verification.passed` / `verification.failed` line and
   * never the closed-vocabulary outcome. This seam lets a test call the
   * underlying classification directly and check the outcome + code
   * combination, which is the property the brief is fixing.
   *
   * The seam is a one-line wrapper around the same private method the loop
   * uses, so its behaviour cannot drift from the loop's. It is reachable
   * from `core/testing.ts` and from this module only — a renderer has no
   * way to obtain a `FreyaCore` reference and there is no public accessor
   * to mint one. See `core/index.ts:1625-1643` for the existing test-seam
   * pattern.
   */
  verifyReferenceForTest(reference: string): {
    readonly holds: boolean
    readonly outcome: 'settled' | 'still-open' | 'unknown'
    readonly code: string
  } {
    return this.classifyReference(reference)
  }

  /**
   * TEST SEAM: drive the verify port with a fabricated request.
   *
   * The reference-only seam is sufficient for the closed-vocabulary
   * tests, but the `escalation-delivered` branch of the verify port is
   * a separate code path with its own two-value shape, and a test
   * needs to reach it. This seam accepts the same `request` shape the
   * loop hands to `lifeLoopPorts().verify` and returns the same
   * outcome the loop records in its journal — the test asserts the
   * verdict directly, without having to drive Attention through a
   * full wake to reach the same state.
   */
  verifyForTest(request: {
    readonly kind: 'reference-terminal' | 'escalation-delivered'
    readonly reference: string
  }): Promise<{
    readonly holds: boolean
    readonly outcome: 'settled' | 'still-open' | 'unknown'
    readonly code: string
  }> {
    return this.lifeLoopVerify(request as unknown as Parameters<LifeLoopPorts['verify']>[0])
  }

  async start(): Promise<CoreStatus> {
    if (this.lifecycle !== 'booting') return this.status()

    // The runtime diagnostics logger is the first thing we wire up, before
    // touching any other system. It is independent of the EventStore so a
    // failure that takes the journal down still leaves a record on disk.
    if (this.diagnostics === null) {
      this.diagnostics = new RuntimeDiagnostics(defaultDiagnosticsPath(this.options.dataPath))
    }

    let store: EventStore
    let fallbackReason: string | null = null
    let failedJournalRepair = false
    const recoveryFaults: string[] = []
    const closeFailedStore = async (failedStore: EventStore): Promise<void> => {
      try { await failedStore.close() } catch (error) {
        recoveryFaults.push(`failed store could not be closed: ${describe(error)}`)
        this.diagnostics?.recordError('core.event-store', 'event_store_close_failed', error, 'failed store could not be closed')
      }
    }
    try {
      const durable = this.options.eventStore ?? (await JsonlEventStore.open(this.options.dataPath))
      store = durable
      this.persistence = {
        mode: 'durable',
        durable: true,
        reason: null,
        eventStorePath: durable instanceof JsonlEventStore ? durable.describe() : this.options.dataPath,
      }
    } catch (error) {
      // The durable store could not be opened. The Core is not allowed to
      // pretend it has no log, but it is also not allowed to become a brick:
      // fall back to an in-memory event store and keep going. The status
      // projection will report `persistence: ephemeral-fallback` so the
      // operator and the UI can both see that nothing written this session
      // will survive a restart.
      fallbackReason = `event store unavailable: ${describe(error)}`
      failedJournalRepair = error instanceof JournalRepairError
      this.diagnostics.recordError('core.event-store', 'event_store_open_failed', error, 'durable event store could not be opened', { dataPath: this.options.dataPath })
      store = new EphemeralEventStore()
      this.persistence = {
        mode: 'ephemeral-fallback',
        durable: false,
        reason: fallbackReason,
        eventStorePath: null,
      }
      recoveryFaults.push(fallbackReason)
    }

    // Read the journal's condition *before* trusting anything in it. A corrupt
    // log still replays — the prefix is real — but it is not the whole truth,
    // and the Core below refuses to present it as though it were.
    try {
      this.integrity = describeRecovery(store)
    } catch (error) {
      // A store that accepted open but throws on read is the same class of
      // failure as one that refuses to open: the Core cannot replay history,
      // so it falls back to ephemeral. The diagnostics record distinguishes
      // the two failure modes.
      const reason = `event store read failed: ${describe(error)}`
      this.diagnostics.recordError('core.event-store', 'event_store_read_failed', error, 'event store recovery could not be read', { dataPath: this.options.dataPath })
      fallbackReason = reason
      recoveryFaults.push(reason)
      await closeFailedStore(store)
      store = new EphemeralEventStore()
      this.persistence = { mode: 'ephemeral-fallback', durable: false, reason, eventStorePath: null }
    }
    let knownJournalRepair = store instanceof JsonlEventStore ? store.knownRepairReport() : null
    const activeStore = this.persistence.durable ? new FallbackEventStore(store, (error, operation) => {
      const reason = `event store ${operation} failed: ${describe(error)}`
      this.persistence = { mode: 'ephemeral-fallback', durable: false, reason, eventStorePath: null }
      this.recordRuntimeFault('core.event-store', `event_store_${operation}_failed`, `event store ${operation} failed`, error)
    }, (error) => this.recordRuntimeFault('core.event-store', 'event_store_close_failed', 'failed store could not be closed', error)) : store

    try {
      this.fabric = await EventFabric.open({ store: activeStore, now: this.options.now, newId: this.options.newId })
    } catch (error) {
      // Same story: the store the Core was handed is unusable. Swap to
      // ephemeral and report the failure clearly.
      const reason = `event fabric open failed: ${describe(error)}`
      this.diagnostics.recordError('core.event-store', 'event_fabric_open_failed', error, 'event fabric could not recover its sequence')
      fallbackReason = reason
      recoveryFaults.push(reason)
      await closeFailedStore(activeStore)
      store = new EphemeralEventStore()
      this.persistence = { mode: 'ephemeral-fallback', durable: false, reason, eventStorePath: null }
      this.fabric = await EventFabric.open({ store, now: this.options.now, newId: this.options.newId })
    }

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
    try {
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
    } catch (error) {
      fallbackReason = `event store replay failed: ${describe(error)}`
      recoveryFaults.push(fallbackReason)
      this.diagnostics.recordError('core.event-store', 'event_store_replay_failed', error, 'event store replay failed')
      await closeFailedStore(activeStore)
      store = new EphemeralEventStore()
      this.fabric = await EventFabric.open({ store, now: this.options.now, newId: this.options.newId })
      this.persistence = { mode: 'ephemeral-fallback', durable: false, reason: fallbackReason, eventStorePath: null }
      this.state = initialCoreState()
      knownJournalRepair = null
      replayed = []
    }
    // The replay rebuilds state from the journal, which wipes any faults
    // recorded before the fabric was open. For the ephemeral-fallback case
    // the durable failure is a fact about this process that the replay
    // cannot know, so re-apply it after the replay and emit a diagnostics
    // record so the operator can correlate the fault with the cause.
    if (fallbackReason !== null) {
      this.diagnostics?.record({
        at: (this.options.now ?? (() => new Date()))().toISOString(),
        level: 'error',
        component: 'core.event-store',
        event: 'ephemeral_fallback_active',
        message: 'event history is temporary because durable recovery failed',
        detail: { persistence: this.persistence.mode },
      })
    }
    this.state = { ...this.state, faults: [...this.state.faults, ...recoveryFaults] }
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
      // Quarantine preserves evidence, not the missing security state. Only
      // validated repair can restore trust in a log with an unresolved fault.
      this.integrity = {
        integrity: 'corrupt',
        reason: `${recorded.reason} (recorded in the journal; the damaged bytes are at ${recorded.quarantinePath})`,
        line: recorded.line,
        eventsRead: recorded.trustedPrefixEvents,
        bytesDiscarded: recorded.damagedBytes,
      }
    }

    if (failedJournalRepair) {
      // Storage fallback keeps the shell operational; it must not turn an
      // unfinished integrity repair into permission to contact providers.
      this.integrity = { integrity: 'corrupt', reason: 'known journal repair could not be made durable',
        line: null, eventsRead: 0, bytesDiscarded: 0 }
    }

    this.guard = this.buildGuard()

    // The encrypted Vault is opened **once**, here, before any durable store is built.
    //
    // It used to be opened lazily by the first store that wanted it — the Mission store
    // — which meant the Life store, built earlier in this same method, found no Vault
    // handle and silently fell back to memory. A Core with a reachable, correctly
    // configured database was therefore reporting its autobiographical layer as
    // ephemeral, and nothing about that fallback was visible unless the owner looked.
    // Opening it up front makes "durable" mean what the configuration says it means.
    await this.ensureVault()

    this.gateway = new ModelGateway({
      providers: this.buildProviders(),
      ...(this.options.providers ? {} : { providerPreference: (capability) => {
        const selectedCapability = capability === 'vision' ? 'vision' : capability === 'browser' ? 'browser' : 'chat'
        const preferences = this.options.capabilityPreferences?.() ?? {}
        const order = modelCapabilityPreference(this.options.env ?? {}, preferences, selectedCapability)
        if (this.options.developerProvider === undefined || selectedCapability === 'vision') return order
        const developerId = this.options.developerProvider === 'slow-echo' ? 'slow-echo' : 'fake'
        // An explicit selection is never bypassed by a developer fixture.
        return preferences[selectedCapability] === undefined ? [...order, developerId] : order.map((id) => id === 'loopback' ? developerId : id)
      } }),
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
    //
    // The browser seam is taken here because the Mind is built further down and
    // this is the only place that knows whether the host activated one. Absent,
    // the turn never offers a browser tool at all.
    this.dualBrowser = this.options.dualBrowser ?? null
    this.browserTabs = this.options.browserTabs ?? null
    if (this.options.research) {
      const sessionStore = await this.buildResearchSessionStore()
      this.researchIntegration = new ResearchIntegration({
        searchProvider: this.options.research.searchProvider,
        eyeSearchProvider: this.options.research.eyeSearchProvider,
        browserFactory: this.options.research.browserFactory,
        sessionStore,
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
      if (event.type.endsWith('.degraded') || event.type.endsWith('.failed') || event.type === 'core.integrity_fault') {
        this.diagnostics?.record({ at: event.occurredAt, level: event.type.endsWith('.failed') ? 'error' : 'warn',
          component: 'core.health', event: event.type,
          message: event.type,
          requestId: 'requestId' in event.payload && typeof event.payload.requestId === 'string' ? event.payload.requestId : null,
          conversationId: 'conversationId' in event.payload && typeof event.payload.conversationId === 'string' ? event.payload.conversationId : null })
      }
      this.foundryEngine?.replay(event)
      this.recordActivity(event)
      this.observeAttentionSource(event)
      // The life loop watches the same authoritative stream Attention does, and is
      // deliberately fed from *this* subscription rather than from
      // `observeAttentionSource`: the wake source and the actor are chosen from the
      // event's type, so the loop is woken by what happened rather than by whatever
      // another subsystem decided to forward it. Fire-and-forget, for the same
      // ordering reason as every other line here.
      this.observeLifeLoopSource(event)
      this.observeVerifiedMissionStep(event)
      this.observeLearningSource(event)
      this.observeExecutiveSource(event)
      // Life History derives from authoritative events live. The engine is
      // idempotent, so a replayed event cannot duplicate an entry.
      if (!event.type.startsWith('life.')) void this.lifeEngine?.observe(event)
      if (event.type.startsWith('foundry.')) this.publishFoundry()
      if (event.type.startsWith('forge.')) this.publishForge()
      this.notify()
    })

    if (knownJournalRepair !== null && !knownJournalRepair.recorded) {
      try {
        await this.fabric.append(
          'core.integrity_repaired',
          {
            code: knownJournalRepair.code,
            repairedEvents: knownJournalRepair.repairedEvents,
            sourceQuarantinePath: knownJournalRepair.sourceQuarantinePath,
            archivedDegradedPath: knownJournalRepair.archivedDegradedPath,
          },
          { actor: 'system' },
        )
      } catch (error) {
        // A repair that cannot itself be recorded is not a trustworthy repair.
        // Keep the reconstructed bytes preserved, but fail closed rather than
        // starting a Core whose audit trail cannot state what happened.
        this.integrity = {
          integrity: 'corrupt',
          reason: `the known journal repair could not be recorded: ${describe(error)}`,
          line: null,
          eventsRead: this.fabric.lastSequence,
          bytesDiscarded: 0,
        }
      }
    }

    // Foundry is journal-first like the rest of Core. Its engine submits a draft
    // event, EventFabric assigns the durable identity/sequence and persists it,
    // and only that persisted event is folded into Foundry state. Replaying the
    // journal here makes restart state and live state the same function of history.
    this.foundryEngine = new FoundryEngine(
      async (event) =>
        await this.fabric.append(event.type as never, event.payload as never, {
          source: event.source,
          actor: event.actor,
          correlationId: event.correlationId,
          causationId: event.causationId,
        }),
      this.options.now,
    )
    for (const event of await this.fabric.readAll()) this.foundryEngine.replay(event)

    // Conversation and voice, built after the owner exists because the Mind needs
    // the owner's authority to create a turn's grant — and it must not be able to
    // have any other.
    this.conversationStore = await this.buildConversationStore()
    // The Brain is built before the Mind, and the Mind reads from it. A Brain that
    // cannot be opened still produces a Brain: it is ephemeral, it reports itself
    // as such, and every other subsystem carries on.
    const brainStore = await this.buildBrainStore()
    this.brainService = this.processRuntime ? this.processRuntime.memory(brainStore, this.fabric) : new Brain({
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

    /**
     * Life History, built after the Brain because it derives from it and from the
     * journal, and before the Mind because nothing in the Mind may reach it.
     *
     * Opening the store is a file read and a key check: no provider call, no
     * network, no window. `deriveFromJournal` backfills derived entries once,
     * idempotently, so a restart cannot duplicate history and a crash between an
     * authoritative event and its derivation is repaired on the next start. It
     * reads the STOP ALL latch fresh and does no enrichment while it is latched.
     */
    this.lifeEngine = new LifeEngine({
      fabric: this.fabric,
      store: await this.buildLifeStore(),
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishLife(),
      stopped: () => this.state.stopAll.active,
    })
    await this.lifeEngine.open()
    await this.lifeEngine.deriveFromJournal()
    const lifeHealth = this.lifeEngine.health()
    if (lifeHealth.health === 'degraded') {
      this.state = {
        ...this.state,
        faults: [...this.state.faults, `Life History is degraded: ${lifeHealth.reason ?? 'unknown reason'}`],
      }
      await this.fabric.append(
        'life.degraded',
        { reason: lifeHealth.reason ?? 'the Life store is not fully readable' },
        { actor: 'system' },
      )
    }

    // Personality is recovered *before* the Mind is built, because the Mind's
    // expression seam is exactly this: a ledger the Mind reads before planning and
    // writes after a turn that actually reached a provider. Building it afterwards
    // would mean the first turn of a process planned against an empty ledger no
    // matter what had been recovered — which is the "empty looks like fresh" bug
    // this whole lane is fail-closed about.
    //
    // No provider call, no network, no window: opening the store is a file read and
    // a key check, so a Core that cannot persist personality still starts, still
    // answers, and still says so.
    await this.buildPersonality()

    this.matrixService = await MatrixService.open({ path: `${this.options.dataPath}.matrix.enc`, key: this.options.matrixKey ?? null })
    const mindOptions: MindServiceOptions = {
      fabric: this.fabric,
      store: this.conversationStore,
      authority: this.service.ownerAuthority(),
      gateway: this.gateway,
      now: this.options.now,
      newId: this.options.newId,
      budget: this.options.contextBudget,
      matrixSpaceIds: conversationId => this.matrixService?.attachedSpaceIds(conversationId) ?? [],
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
      runtimeFacts: () => [
        `Freya Core is ${this.lifecycle}; ${this.state.stopAll.active ? 'cognition is stopped' : 'owner commands remain Guard checked'}.`,
        `Persistent memory is ${this.brain().health}, durable=${this.brain().durable}. You have system_inspect for actual system state; use it before asserting memory or systems are absent.`,
        'Manage missions and goals with mission_manage and goal_manage. Daily reminders use reminder_manage and need a time; delivery requires the app to be running.',
        'Matrix spaces attached to this chat can be read and managed with matrix_spaces and matrix_entries; attachment IDs are supplied by Core, never by a model.',
      ],
      // The owner's model selection, read per turn. The Mind cannot set it, the
      // renderer cannot put one in a turn payload, and the Gateway still asks the
      // Governor before anything is contacted — this only answers "which model,
      // if the owner named one" for a request that has already been allowed.
      selectedModel: () => this.selectedModel,
      selectedProviderId: () => this.selectedProviderId,
      // Read-only recall. The Mind asks; the Brain decides what is recallable. This
      // callback holds no store and no admission policy, so the request path
      // cannot widen what Freya remembers — and a turn never writes memory at all,
      // which is what keeps a prompt injection from becoming a durable fact.
      recall: (query) => this.recallReference(query),
      learnedAdvice: (query) => this.learningEngine
        ? recallRelevantLearning(this.learningEngine, { goal: query, maxRecords: 3 }).promptSection.slice(0, 1200)
        : '',
      // Metadata only. The question and the answer are referenced by id and stay in
      // the encrypted conversation store.
      onTurnExperience: (experience) => this.recordTurnExperience(experience),
      // The Phase 11 expression seam, in three narrow reads plus one narrow write.
      //
      // The Mind holds no ledger, no relationship store and no admission policy: it
      // asks Core what is retained and Core decides what is. A missing or untrusted
      // ledger makes `readLedger()` answer null, which the Mind treats as *no
      // expression at all* — never as an empty ledger, which would re-offer the same
      // gestures forever. Admitted records reach the interpreter through the second
      // read, and never their text.
      expressionMemory: this.personalityDomain ?? undefined,
      interactionFacts: () => this.personalityDomain?.interactionFacts() ?? [],
      relationshipItems: () => this.personalityDomain?.admittedItems() ?? [],
      // Relevance tokens come from the domain's own closed table, not from a
      // matcher over the owner's words. A standing instruction about register
      // applies to every turn; a topic-scoped one will carry a tag outside this
      // list and match only when something can honestly supply it.
      preferenceTokens: () => STANDING_RELEVANCE_TAGS,
      // The owner's own words, handed over once and forgotten. Core decides what
      // they mean; the Mind never does.
      onOwnerMessage: (message) => this.observeOwnerMessage(message),
      /**
       * The tools a turn can reach, and a registry only if there is anything in it.
       *
       * Built as a list rather than a single conditional, because gating the whole
       * registry on `researchIntegration` alone would make the browser tool vanish
       * whenever search was unconfigured, and vice versa. An empty registry is
       * already treated as unwired — the turn takes the original single-request
       * path and the model is never *offered* a tool — so an install with neither
       * is a plain chat window rather than a loop whose every request must fail.
       *
       * Both tools are evaluated by the registry before their body runs, and both
       * bodies reach the real subsystems, which check authority again. Two checks
       * of one fact is deliberate: the registry answers "may this turn spend this
       * capability", the subsystem answers "may this action, on this page, for this
       * principal, right now".
       */
      tools: (() => {
        const tools = [
          createSystemInspectionTool({ read: () => this.systemInspection() }),
          ...createWorkManagementTools({ dispatch: (command, payload) => this.handleCommand({ command, payload, requestId: this.newId() }) }),
          ...createMatrixTools({ service: this.matrixService! }),
          ...(this.researchIntegration && this.conversationStore.mode === 'encrypted' ? [createMissionProposalTool()] : []),
          createMissionsListTool({
            getMissions: () => (this.missionEngine ? this.missionEngine.projection().missions.map((m) => ({
              id: m.missionId,
              status: m.status,
              currentStep: m.currentStep ? { stepId: m.currentStep.stepId, status: m.currentStep.status } : null,
              progress: {
                completedSteps: m.progress.steps.verified,
                totalSteps: m.progress.steps.total,
              },
              blockers: m.blockers,
            })) : []),
          }),
          createWorkspaceReportTool({
            workspaceRoot: this.options.workspaceRoot ?? process.cwd(),
          }),
          ...(this.researchIntegration
            ? [createWebSearchTool({
              searchWeb: (query, vertical, signal, site) => this.researchIntegration!.searchWeb(query, vertical, signal, site),
            })]
            : []),
          // The chart tool does not talk to the network; it returns a typed artifact
          // that the renderer draws. Always available alongside the other tools so a
          // turn that does not look anything up can still produce a chart.
          createChartTool(),
          // The canvas tool returns a long-form artifact the renderer opens in a
          // side panel. Always available, for the same reason as the chart tool.
          createCanvasTool(),
          ...(this.dualBrowser
            ? [createBrowserTaskTool({ browser: this.dualBrowser })]
            : []),
          // The tab tool needs the service, not the routed runtime: tabs are a thing the
          // service owns and the routed vocabulary has no word for. Registered only when a
          // service is actually mounted, so a build without one does not advertise it.
          ...(this.browserTabs
            ? [createBrowserTabsTool({ browser: this.browserTabs })]
            : []),
        ]
        if (tools.length === 0) return null
        this.mindToolRegistry = new MindToolRegistry({
          tools: this.processRuntime?.mind.tools(tools) ?? tools,
          guard: this.guard,
          // The owner principal. `browser.read` is the owner's alone, as
          // `CAPABILITIES` says, so a principal that does not hold it is refused the
          // browser tool and keeps the search tool.
          principal: this.owner,
          stopped: () => this.state.stopAll.active || !this.gateway.gateStatus().open,
        })
        return this.mindToolRegistry
      })(),
    }
    this.mind = this.processRuntime?.mind.bind(mindOptions) ?? new MindService(mindOptions)
    this.conversations = new ConversationService({
      fabric: this.fabric,
      store: this.conversationStore,
      mind: this.mind,
      gateway: this.gateway,
      now: this.options.now,
      newId: this.options.newId,
      cognitionAvailability: () => this.cognitionAvailability(),
      missionViews: conversationId => this.chatMissions?.views(conversationId) ?? Promise.resolve([]),
      stopAll: () => ({
        active: this.state.stopAll.active,
        activatedAt: this.state.stopAll.activatedAt,
      }),
    })
    this.voiceService = new VoiceService({
      fabric: this.fabric,
      // An absent engine becomes an object that refuses, rather than an `undefined`
      // that five call sites each have to remember to check. The refusal is what
      // makes "no engine configured" a reportable state instead of a silent no-op.
      stt: this.options.voiceStt ?? new UnavailableSttAdapter(),
      tts: this.options.voiceTts ?? new UnavailableTtsAdapter(),
      wake: this.options.voiceWake ?? (this.processRuntime ? buildLocalWakeGate() : LOCAL_ENERGY_WAKE_GATE),
      captureSupported: this.options.voiceCaptureSupported ?? true,
      transcriptionTimeoutMs: this.options.voiceTranscriptionTimeoutMs,
      attentionTimeoutMs: this.options.voiceAttentionTimeoutMs,
      autoSpeak: this.options.voiceAutoSpeak,
      proactiveAlerts: this.options.voiceProactiveAlerts,
      initialMuted: this.options.voiceMuted,
      followUpWindowMs: this.options.voiceFollowUpWindowMs,
      interruptTurn: async () => {
        const active = (await this.conversations.projection()).activeTurn
        if (active) {
          await this.conversations.cancelTurn(active.turnId)
          const deadline = Date.now() + 2_000
          while (Date.now() < deadline && (await this.conversations.projection()).activeTurn?.turnId === active.turnId) {
            await new Promise(resolve => setTimeout(resolve, 25))
          }
        }
      },
      stopAll: () => this.state.stopAll.active || this.integrity.integrity === 'corrupt',
      // The canonical door. This is the same function `conversation.turn.submit`
      // reaches, so a spoken sentence is a typed sentence from the Mind down: same
      // context compilation, same grant, same Governor, same budget, same STOP ALL.
      submitTurn: async ({ text }) => {
        const conversationId = await this.conversations.ensureConversation()
        if (conversationId === null) {
          return { ok: false, turnId: null, outcome: 'none', reason: 'no conversation could be opened' }
        }
        const result = await this.conversations.submitTurn({ conversationId, text, requestId: this.newId() })
        if (!result.ok) {
          return { ok: false, turnId: null, outcome: 'none', reason: result.reason }
        }
        return {
          ok: true,
          turnId: result.turn.turnId,
          outcome: result.turn.outcome,
          reason: result.turn.reason,
        }
      },
      // Playback reads the store, in this direction only. The window names a turn
      // and never the words, so it cannot put a sentence in Freya's mouth.
      resolveTurnText: (turnId) => this.storedAnswerFor(turnId),
      now: this.options.now,
      newId: this.options.newId,
    })
    // The voice projection is pushed on every move, so a window's indicator is
    // Core's state rather than a flag the window set for itself.
    this.voiceService.onChange(() => {
      this.notify()
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
    if (this.options.missionReadRoots?.length) registerFileInspection(this.workRegistry, [...this.options.missionReadRoots])
    if (this.researchIntegration) registerResearchInspection(this.workRegistry, {
      research: this.researchIntegration,
      resolveStrategy: (scope: string) => {
        const strat = this.strategyLifecycle?.getActiveStrategy(scope)
        if (!strat) return null
        return {
          strategyId: strat.strategyId,
          version: strat.version,
          kind: strat.kind,
          parameters: strat.parameters,
        }
      },
      admit: async (runId, stepKey, signal) => {
        signal?.throwIfAborted()
        const id = this.workEngine?.snapshot().runs.get(runId)?.parentId
        const content = id ? await this.missionEngine?.privateContent(id, true) : null
        const mission = id ? this.missionEngine?.record(id) : null
        if (!id || !content?.chatBinding || !mission || !mission.childRuns.includes(runId) || !mission.activePlan?.steps.some(step => step.stepId === stepKey && step.capability === 'research.search') || !await this.chatMissionAuthorized(id) || !this.chatResearchAvailable() || content.chatBinding.paused || !['active', 'planning'].includes(mission.status)) throw new Error('Research authorization unavailable.')
        const charged = await this.requireMission().charge({ missionId: id, modelCalls: 0, actions: 0, externalRequests: 1, retries: 0, delegations: 0 })
        if (!charged.ok) throw new Error('Research request budget exhausted.')
        signal?.throwIfAborted()
      },
      save: async (runId, stepKey, evidence) => {
        const id = this.workEngine?.snapshot().runs.get(runId)?.parentId
        if (!id) throw new Error('Attached Mission unavailable.')
        await this.requireMission().updateChatContent(id, content => ({ ...content, researchEvidence: { ...content.researchEvidence, [stepKey]: evidence } }))
      },
      read: async (runId, stepKey) => {
        const id = this.workEngine?.snapshot().runs.get(runId)?.parentId
        return id ? (await this.missionEngine?.privateContent(id))?.researchEvidence?.[stepKey] ?? null : null
      },
    })
    // This is the same browser `core/mind/browser-tool.ts` already uses — one runtime, one
    // session table, one Device Hands gate chain. Registered only when the host mounted a
    // browser, so a Core with none never advertises a step it could not run.
    registerMissionBrowser(this.workRegistry, this.dualBrowser, this.missionBrowserContext())
    registerFoundryWorkCapabilities(this.workRegistry, this.requireFoundry())
    // Phase 6's fixture capabilities are the only executable capabilities the
    // shipped Core would otherwise have, and they exist to prove the Work engine
    // can be driven end to end. They are inert — no fs, no child_process, no
    // socket, no model access — but `test.failing` is a deliberate failure
    // generator and `test.record` is the only one a Skills workflow or a renderer
    // `work.run.create` could reach by name in a shipped build, which makes
    // shipping them a product decision that has to be made on purpose.
    //
    // The decision is `options.testCapabilities === true`, and the default is
    // false. Production builds and the renderer never set it; the e2e and the
    // `createCore` test fixtures do. The intent is that "test.record" failing
    // to resolve in a default Core is a feature, not a regression.
    if (this.options.testCapabilities === true) registerPhaseSixCapabilities(this.workRegistry)
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

    // Foundry does not trust a model or its own creator step to say work passed.
    // Its production verifier reads Work's already-independent terminal Step verdict.
    // The artifact carries the creating run/step ids, so this is a check of the exact
    // action that produced it rather than a generic "the run looked okay" badge.
    this.requireFoundry().registerVerifier({
      name: 'work.step.verified',
      verify: (artifactHash) => {
        const artifact = [...this.requireFoundry().getState().artifacts.values()].find(
          (candidate) => candidate.hash === artifactHash,
        )
        if (!artifact) return 'FAIL: artifact does not exist'
        const run = this.workEngine?.projection().runs.find((candidate) => candidate.runId === artifact.runId)
        const step = run?.steps.find((candidate) => candidate.stepId === artifact.stepId)
        return step?.status === 'verified'
          ? 'PASS: the creating Work step is independently verified'
          : 'FAIL: the creating Work step is not verified'
      },
    })

    // Missions sit above Work, so they are constructed after it and hold a read-only
    // view of it. The engine asks Work about a Run; Work never asks Missions about
    // anything, because Work has no field shaped like a Mission and this phase does
    // not give it one.
    const missionOptions = {
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
    }
    this.missionEngine = this.processRuntime?.missions(missionOptions) ?? new MissionEngine(missionOptions)
    await this.missionEngine.open()

    const goalVerificationEngine = this.processRuntime ? undefined : new VerificationEngine({
      fabric: this.fabric,
      goals: {
        recordCheckpointOutcome: (goalId, checkpointId, outcome, reason, attempts) =>
          this.goalEngine?.recordCheckpointOutcome(goalId, checkpointId, outcome, reason, attempts) ?? Promise.resolve(),
        checkpointAttempts: (goalId, checkpointId) =>
          this.goalEngine?.checkpointAttempts(goalId, checkpointId) ?? 0,
        goalRetryCount: (goalId) =>
          this.goalEngine?.goalRetryCount(goalId) ?? 0,
      },
      principalId: this.owner.id,
      now: this.options.now,
      stopAll: () => this.state.stopAll.active,
    })

    this.goalStore = await this.buildGoalStore()
    const goalOptions: GoalEngineOptions = {
      fabric: this.fabric,
      store: this.goalStore,
      continuation: {
        verifyCheckpoint: async (goalId, checkpointId, signal) => {
          const defaultVerifier: GoalVerifier = {
            id: 'default',
            verify: async () => ({ established: true, reason: GOAL_REASONS.verification_passed }),
          }
          const res = await goalVerificationEngine!.verify(goalId, checkpointId, defaultVerifier, signal)
          return {
            established: res.outcome === 'passed',
            reason: res.reason ?? (res.outcome === 'passed' ? GOAL_REASONS.verification_passed : GOAL_REASONS.verification_not_established),
          }
        },
      },
      principalId: this.owner.id,
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishGoals(),
      stopAll: () => this.state.stopAll.active,
    }
    this.goalEngine = this.processRuntime?.goals(goalOptions) ?? new GoalEngine(goalOptions)
    await this.goalEngine.open()

    this.continuationEngine = this.goalEngine instanceof GoalEngine ? new ContinuationEngine({
      fabric: this.fabric,
      goals: this.goalEngine.toTruthPort(),
      principalId: this.owner.id,
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishGoals(),
      stopAll: () => this.state.stopAll.active,
    }) : this.goalEngine.continuation
    await this.continuationEngine.open()

    this.learningStore = await this.buildLearningStore()
    this.learningEngine = new LearningEngine({
      store: this.learningStore,
      now: this.options.now,
      newId: this.options.newId,
      stopped: () => this.state.stopAll.active,
      onChange: () => this.publishLearning(),
    })

    this.proactiveStore = await this.buildProactiveStore()
    this.proactiveEngine = new ProactiveEngine({
      fabric: this.fabric,
      store: this.proactiveStore,
      modelProvider: this.options.providers?.[0],
      getGoal: (goalId) => {
        if (!this.goalEngine) return null
        const record = this.goalEngine.state().goals.get(goalId)
        if (!record) return null
        const content = this.goalEngine.getContent(goalId)
        return {
          goalId: record.goalId,
          state: record.state,
          title: content?.title ?? record.goalId,
          milestones: (content?.roadmap?.milestones ?? []).map((m) => ({
            milestoneId: m.milestoneId,
            status: m.status,
            criteria: m.acceptanceCriteria,
          })),
        }
      },
      activeGoals: () => {
        if (!this.goalEngine) return []
        return [...this.goalEngine.state().goals.values()]
          .filter((g) => g.state === 'active')
          .map((g) => {
            const content = this.goalEngine?.getContent(g.goalId)
            return {
              goalId: g.goalId,
              state: g.state,
              title: content?.title ?? g.goalId,
              milestones: (content?.roadmap?.milestones ?? []).map((m) => ({
                milestoneId: m.milestoneId,
                status: m.status,
                criteria: m.acceptanceCriteria,
              })),
            }
          })
      },
      activeMissions: () => {
        if (!this.missionEngine) return []
        return this.missionEngine.projection().missions
          .filter((m) => m.status === 'active')
          .map((m) => ({
            missionId: m.missionId,
            state: m.status,
          }))
      },
      recallLearning: (query) => {
        if (!this.learningEngine) return ''
        const advice = recallRelevantLearning(this.learningEngine, query)
        return advice.promptSection
      },
      notifyAttention: async (notification) => {
        if (!this.attentionEngine) return
        await this.attentionEngine.ingestInternal('system', {
          kind: notification.kind,
          text: notification.text,
          goalRef: notification.goalRef ?? null,
          sourceRef: notification.sourceRef ?? null,
          severityHint: notification.severityHint ?? 'none',
        })
      },
      handleContinuation: async (goalId, _missionId) => {
        if (!this.continuationEngine) return
        await this.handleContinuationWake({
          goalId,
          wakeId: `wake-proactive-${this.options.newId?.() ?? Date.now()}`,
          source: 'proactive',
          cause: 'external_event',
          authorized: true,
        })
      },
      checkContinuationPrerequisites: (goalId, missionId) => {
        const goal = goalId && this.goalEngine ? this.goalEngine.state().goals.get(goalId) : null
        const mission = missionId && this.missionEngine ? this.missionEngine.projection().missions.find((m) => m.missionId === missionId) : null
        const remainingBudget = goalId && this.goalEngine ? this.goalEngine.getBudget(goalId)?.remaining.remainingMissions ?? 1 : 1
        return {
          goalIsActive: goal?.state === 'active',
          missionIsWaiting: mission?.status === 'waiting' || mission?.status === 'stopped' || mission?.status === 'ready',
          milestonePreconditionsMet: true,
          budgetRemaining: remainingBudget,
          principalAuthorized: true,
          stopAllActive: this.state.stopAll.active,
        }
      },
      now: this.options.now,
      newId: this.options.newId,
      stopAll: () => this.state.stopAll.active,
      onChange: () => this.publishProactive(),
    })
    await this.proactiveEngine.open()

    // Internal observation listener
    this.fabric.subscribe((event) => {
      if (this.proactiveEngine === undefined) return
      if (event.type === 'longhorizon.goal.milestone-settled') {
        const p = event.payload as Record<string, unknown>
        const goalId = typeof p.goalId === 'string' ? p.goalId : null
        const milestoneId = typeof p.milestoneId === 'string' ? p.milestoneId : null
        const outcome = typeof p.outcome === 'string' ? p.outcome : 'unknown'
        if (milestoneId) {
          void this.proactiveEngine.ingest({
            sourceType: 'internal',
            sourceId: 'longhorizon',
            sourceRef: milestoneId,
            rawSummary: `Milestone ${milestoneId} settled as ${outcome}`,
            goalId,
            milestoneId,
            predicate: 'milestone-settled',
          })
        }
      } else if (event.type === 'mission.step.transitioned') {
        const p = event.payload as Record<string, unknown>
        const stepId = typeof p.stepId === 'string' ? p.stepId : null
        const missionId = typeof p.missionId === 'string' ? p.missionId : null
        const to = typeof p.to === 'string' ? p.to : 'unknown'
        if (stepId) {
          void this.proactiveEngine.ingest({
            sourceType: 'internal',
            sourceId: 'missions',
            sourceRef: stepId,
            rawSummary: `Mission step ${stepId} transitioned to ${to}`,
            missionId,
            predicate: 'step-transitioned',
          })
        }
      } else if (event.type === 'workforce.worker.transitioned') {
        const p = event.payload as Record<string, unknown>
        const workerId = typeof p.workerId === 'string' ? p.workerId : null
        const to = typeof p.to === 'string' ? p.to : 'unknown'
        if (workerId) {
          void this.proactiveEngine.ingest({
            sourceType: 'internal',
            sourceId: 'workforce',
            sourceRef: workerId,
            rawSummary: `Worker ${workerId} status transitioned to ${to}`,
            predicate: 'worker-availability-changed',
          })
        }
      }
    })

    this.metacognitionStore = await this.buildMetacognitionStore()
    this.metacognitionEngine = new MetacognitionEngine({ store: this.metacognitionStore })
    this.evolutionStoreInstance = await this.buildEvolutionStore()
    this.strategyLifecycle = new StrategyLifecycleManager(this.evolutionStoreInstance, this.metacognitionStore)
    await this.strategyLifecycle.initialize()
    // Persisted telemetry makes event replay idempotent across Core restarts.
    for (const item of await this.metacognitionEngine.getTelemetries()) {
      this.observedMissions.add(item.missionId)
    }

    // Authoritative Metacognition & Evolution Event Observer (P1 Findings 3 & 5)
    this.fabric.subscribe((event) => {
      if (this.metacognitionEngine === undefined) return
      if (event.type === 'mission.completed' || event.type === 'mission.failed') {
        void this.observeAuthoritativeMission(event).catch((error: unknown) => {
          console.error('[freya.core] mission metacognition observation failed', error)
        })
      }
    })

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

    const workforceOptions: WorkforceEngineOptions = {
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
    }
    this.workforceEngine = this.processRuntime?.agents(workforceOptions) ?? new WorkforceEngine(workforceOptions)
    await this.workforceEngine.open()

    // The autonomy runtime sits above all three: it plans Missions, delegates through the
    // workforce and executes through Work. It is built last because every one of its ports
    // reads a subsystem that must already exist, and it holds no state of its own — one
    // `step()` is one decision, and there is no loop.
    this.missionAutonomy = new MissionAutonomyRuntime({
      fabric: this.fabric,
      principalId: this.owner.id,
      missions: this.missionAutonomyPort(),
      capabilities: this.missionCapabilityPort(),
      authority: this.missionAuthorityPort(),
      delegate: (input) => this.delegateMissionStep(input),
      execute: (input) => this.executeMissionStep(input),
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => {
        this.publishMission()
        this.syncContextMission()
      },
      stopAll: () => this.state.stopAll.active,
      liveMissionCount: () => this.liveMissionCount(),
    })

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
    try {
      this.attentionScheduleStore = this.options.attentionKey
        ? await EncryptedAttentionScheduleStore.open({ path: `${this.options.dataPath}.attention.enc`, key: this.options.attentionKey })
        : new UnavailableAttentionScheduleStore('The private reminder key is unavailable.')
    } catch {
      this.attentionScheduleStore = new UnavailableAttentionScheduleStore('The private reminder store could not be opened.')
    }
    this.attentionEngine = new AttentionEngine({
      scheduleStore: this.attentionScheduleStore,
      fabric: this.fabric,
      now: this.options.now,
      newId: this.options.newId,
      onChange: () => this.publishAttention(),
      onDecision: (decision) => {
        if (decision.outcome === 'speak' || decision.outcome === 'interrupt') {
          void this.voiceService.announceAttention(decision.kind, decision.outcome)
        }
      },
      focus: () => this.attentionFocus(),
      stopAll: () => this.state.stopAll.active,
      getState: () => this.state.attention,
      goalOpen: (goalRef) => this.attentionGoalOpen(goalRef),
    })
    await this.attentionEngine.reconcile()

    /**
     * Relay, built after every subsystem it reads for its gates.
     *
     * The engine holds the adapter set the host supplied and the two callbacks
     * that keep it honest: `authorizer` asks Guard with the owner principal
     * baked in here in Core, and `stopAll` reads the latch fresh at each
     * decision. It holds no principal of its own and cannot build one, so a
     * Relay action cannot be laundered through a forged identity.
     *
     * `reconcile()` expires any pending approval recovered from the journal
     * whose content did not survive the restart ??? the same honesty attention
     * applies to a schedule whose text is gone.
     */
    this.relayEngine = new RelayEngine({
      fabric: this.fabric,
      adapters: this.options.relay?.adapters ?? {},
      authorizer: {
        evaluate: (capability) => this.guard.evaluate(this.owner, capability),
      },
      stopAll: () => this.state.stopAll.active,
      getState: () => this.state.relay,
      allowlistedRepos: this.options.relay?.allowlistedRepos,
      allowlistedChats: this.options.relay?.allowlistedChats,
      now: this.options.now,
      newId: this.options.newId,
    })
    this.relayAdmissionOpen = true
    await this.relayEngine.reconcile()

    /**
     * The connector connection plane, built after Relay because its action port
     * *is* Relay. It holds no token store and no provider: the host's `auth`
     * port returns only a URL and a status, and every action is forwarded to the
     * Relay engine above, so there is one approval system and one budget ledger.
     */
    if (this.options.connectors !== undefined) {
      this.connectorEngine = new ConnectorEngine({
        fabric: this.fabric,
        auth: this.options.connectors.auth,
        action: { execute: (input) => this.requireRelay().execute(input) },
        stopAll: () => this.state.stopAll.active,
        getState: () => this.state.connectors,
        blocked: this.options.connectors.blocked,
        now: this.options.now,
        newId: this.options.newId,
      })
      this.connectorAdmissionOpen = true
      await this.connectorEngine.reconcile()
    }

    /**
     * Skills, built last, because they read Work.
     *
     * Two things are wired here and both are deliberate. The **encrypted body store**
     * is recovered before the engine adopts anything, and adoption is filtered against
     * the journal fold: a body the journal does not vouch for is discarded rather than
     * adopted, so a rewritten store file cannot introduce a skill Core never recorded.
     * The **Work port** is a four-method read port with no writes, no capability
     * request and no approval ??? a skill may ask whether a Run and a Step exist and
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

    /**
     * The Phase 48 Forge, built after Skills and Work because it reads both.
     *
     * Three seams are wired, and each one is a limit rather than a convenience:
     *
     * - **The capability port** answers two questions and grants nothing:
     *   isRegistered (does any registered Work capability need this Guard
     *   capability?) and holds (does the owner hold it *right now*). Forge has no
     *   grant method and no authority object, so installing a package cannot widen
     *   anything.
     * - **The body store** is recovered before the engine adopts anything, and
     *   adoption is filtered by the fold *and* by the recorded hash, so an edited
     *   store cannot introduce a package Core never recorded, nor run one whose bytes
     *   changed.
     * - **STOP ALL** is passed as a fresh read, so a panic button stops Forge in the
     *   same turn it stops everything else.
     *
     * Nothing here burns a model call, and nothing here is reachable from a renderer
     * except through the  orge.* commands, each of which routes through Guard and the
     * engine's own pipeline.
     */
    await this.buildForge()

    // The Phase 22 world. Built after the domains it reads, because it borrows a
    // narrow port from each of them rather than a copy of any of them, and after the
    // gateway because the self model reports which provider *would* answer.
    await this.buildWorld()

    // The Phase 23 life loop, constructed after every subsystem whose state it
    // reads and before anything that could raise a wake. Construction is free: it
    // opens no store, starts no timer, contacts no provider and schedules nothing,
    // so the only thing it costs at boot is an object that can say "no".
    this.lifeLoopRuntime = new LifeLoopRuntime({
      ports: this.lifeLoopPorts(),
      limits: this.options.lifeLoop?.limits,
    })

    const recoveredSequence = this.fabric.lastSequence
    this.startedAt = (this.options.now ?? (() => new Date()))().toISOString()

    // A damaged journal is not a ready Core. The distinction is deliberate: a
    // torn tail is a crash and this is `ready`; corruption is something this
    // code did not write, and a Core that came up `ready` on it would be
    // reporting a security state assembled from a log with a hole in it.
    //
    // The `degraded` here is a *health* label. `operational` is independent: a
    // degraded Core is still operationally able to serve commands as long as
    // EventFabric, ModelGateway and the subsystems it could build are present.
    const integrityCorrupt = this.integrity.integrity === 'corrupt'
    const durable = this.persistence.mode === 'durable'
    const unhealthy = integrityCorrupt || !durable || this.state.faults.length > 0
    const nextLifecycle: CoreLifecycle = unhealthy ? 'degraded' : 'ready'
    this.setLifecycle(nextLifecycle, integrityCorrupt ? 'durable journal is corrupt' : (!durable ? 'durable store unavailable; using ephemeral fallback' : this.state.faults[0] ?? null))

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

    // And the life loop reconciles last of all, because its reconciliation is the
    // only one that *spends* nothing but *keeps* something: an action the journal
    // says started cannot be continued, because its plan was in memory, and a wait
    // whose absolute deadline has not passed is preserved rather than restarted.
    // Reconciled before `core.ready` so a window attaching to a ready Core is never
    // shown a loop that believes it is mid-action when it is not.
    await this.lifeLoopRuntime?.open()
    this.publishLifeLoop()

    if (this.currentLifecycle === 'ready') {
      await this.fabric.append('core.ready', {}, { actor: 'system' })
    } else {
      // A `core.ready` here would be a lie in the durable record: this Core
      // cannot vouch for its own security state, and the journal has to say the
      // same thing a reader of the log will find. The reason is the actual
      // cause — a corrupt journal or the durable store being unavailable
      // (the ephemeral-fallback case) — not a hardcoded sentence.
      const reason = this.integrity.integrity === 'corrupt'
        ? 'the event journal was found corrupt; see the preceding integrity fault'
        : (fallbackReason ?? this.state.faults[0] ?? 'core is degraded')
      await this.fabric.append(
        'core.degraded',
        { reason },
        { actor: 'system' },
      )
    }

    // Runtime activation is the last step of start, after the durable `ready`
    // (or `degraded`) line, so a reader of the journal sees the Core reach a
    // posture before it sees which domains that posture activated. The
    // controller is the single owner of the activation record; Core built its
    // subsystems above and the controller records what that means, truthfully.
    this.activation = new RuntimeActivationController({
      journal: this.runtimeJournal(),
      now: () => this.nowIso(),
      onChange: () => this.publishRuntime(),
    })
    this.activation.register(RUNTIME_REGISTRY)
    await this.activation.load(this.runtimeFacts())
    this.operational = true
    if (this.missionEngine && this.researchIntegration && this.conversationStore.mode === 'encrypted') {
      this.chatMissions = new ChatMissionIntegration({ engine: this.missionEngine, store: this.conversationStore, ownerId: this.owner.id,
        now: () => (this.options.now ?? (() => new Date()))(), available: () => this.chatResearchAvailable(),
        authorized: id => this.chatMissionAuthorized(id),
        authorize: async (id, grantId, expiresAt) => {
          if (!this.chatResearchAvailable()) return false
          const scope = this.issueWorkforceOwnerScope()
          if (!scope.projection().workers.some(worker => worker.capabilities.includes('cognition.request'))) {
            const worker = await scope.createWorker({ name: 'Research', specialisation: 'general' })
            if (!worker.ok || !worker.workerId || !(await scope.assignCapability(worker.workerId, 'cognition.request')).ok) return false
          }
          await this.ownerAuthority.createGrant({ grantId, expiresAt, allowedOrigins: ['agent'], allowedCauses: ['run_finished'], actor: this.owner.id, goalId: id, backgroundAllowed: true, maxCalls: 3, maxOutputTokens: 6144 })
          return true
        },
        plan: (id, grantId, revision) => this.planChatMissionGoal({ missionId: id, grantId, continueAfterVerification: true }, revision),
        advance: id => this.advanceMission(id, 'manual'), request: intent => this.ownerAuthority.request(intent),
        notify: () => this.conversations.publish(),
      })
      await this.chatMissions.recover()
    }
    this.publishRuntime()
    this.notify()
    await this.processRuntime?.open(this)
    return this.status()
  }

  /**
   * The activation journal, backed by Core's one durable event log.
   *
   * Only `runtime.*` entries are replayed, so the fold cannot be perturbed by
   * any other event family, and an append here is exactly as durable as any
   * other Core event.
   */
  private runtimeJournal(): {
    append(type: RuntimeEventType, payload: RuntimePayload): Promise<void>
    replay(): Promise<readonly RuntimeJournalEntry[]>
  } {
    return {
      append: async (type, payload) => {
        await this.fabric.append(type, payload as never, { actor: 'system' })
      },
      replay: async () => {
        const events = await this.fabric.readAll()
        return events
          .filter((event) => event.type.startsWith('runtime.'))
          .map((event) => ({
            sequence: event.sequence,
            type: event.type as RuntimeEventType,
            payload: event.payload as RuntimePayload,
            recordedAt: event.occurredAt,
          }))
      },
    }
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
    this.operational = false
    this.setLifecycle('stopping', reason)
    this.notify()

    const began = Date.now()
    try {
      // Research stops before anything else and without awaiting first, for the same
      // ordering reason as STOP ALL: a half-finished research job reaching the
      // network during shutdown is still a request.
      this.closeResearch(`core stopping: ${reason}`)
      // Relay closes in the same synchronous turn, for the same reason: a
      // connector action is an external request, and one that had already
      // passed Guard when the shutdown began must not reach an adapter after.
      this.closeRelay(`core stopping: ${reason}`)
      // And the life loop stops taking new work in the same synchronous turn, so a
      // wake that arrives during the drain is refused rather than half-run.
      //
      // Deliberately *not* a latch: nothing here asks the loop to record a stop,
      // because the process is ending rather than the owner pressing a button. A
      // latch the owner never set must not survive into the next launch, and a
      // close-out written here would say the loop finished something rather than
      // that it never will. What the next `start()` finds in the journal is the
      // honest answer, and the recovery reconciler turns it into a position.
      await this.lifeLoopRuntime?.close()
      if (this.fabric) {
        // The activation controller stops every domain it started, in reverse
        // order, and records the reason while the journal is still open. A domain
        // that was activated must not be left recorded as active after the Core
        // that activated it has gone.
        await this.activation?.shutdown(`core stopping: ${reason}`)
        // A microphone must not outlive the Core that opened it, and neither must
        // a queued utterance: the device is released, any transcription is
        // aborted and playback is cut before shutdown records anything.
        await this.voiceService?.onStopAll(`core stopping: ${reason}`)
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
      await this.processRuntime?.close()
      this.disposeWorkforceSource()
      this.disposeWorkforceSource = () => {}
      this.disposePersonalitySource()
      this.disposePersonalitySource = () => {}
      this.service?.dispose()
      this.setLifecycle('stopped', reason)
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
      // Life History closes before the Vault, on the same terms as the Brain: a
      // record that exists in Core and not in the database is the exact durability
      // lie this phase refuses to tell, and the projection would have already
      // claimed `durable: true`.
      await this.lifeEngine?.close()
      // Work is closed on the same terms, and for the same reason: a capability
      // still executing when the fabric closes would try to record its own outcome
      // into a closed store, producing a failure *for having failed to record*.
      // `close` aborts every live capability and waits for the loops to settle.
      await this.workEngine?.close()
      // A verifier still running at shutdown must not be able to write a completion
      // into a closed journal. Closing after Work is deliberate: the Mission may want
      // to consult a Run that Work has just finished recording.
      await this.missionEngine?.close()
      await this.continuationEngine?.close()
      await this.goalEngine?.close()
      await this.goalStore?.close()
      await this.learningStore?.close()
      await this.proactiveEngine?.close()
      await this.proactiveStore?.close()
      await this.metacognitionEngine?.close()
      await this.metacognitionStore?.close()
      await this.evolutionStoreInstance?.close()
      // The Vault owns the Mission store's connection, so it closes after the engine
      // has flushed. Closing it here keeps the one encrypted database's lifetime
      // inside Core's own.
      this.vault?.close()
      this.vault = null
      // Workforce closes after Missions and Work for the same ordering reason: a
      // reconciliation that had not finished would otherwise try to append into a
      // journal that is already closed, producing a failure *for having failed to
      // record* the shutdown.
      await this.workforceEngine?.close()
      // Personality closes before the conversation store, on the same terms as
      // every other encrypted store here: flush what was committed, then release.
      // A relationship record that exists in Core and not on disk is the exact
      // durability lie this phase refuses to tell, and the projection would have
      // already claimed `durable: true`.
      await this.personalityPersistence?.close()
      this.personalityDomain = undefined
      await this.contextPersistence?.close()
      // Skills close on the same terms, and for the same reason: a body commit that
      // landed after its own journal event would be a record of something the log
      // says never happened. Ordered before the fabric closes for that reason.
      await this.skillPersistence?.close()
    await this.forgePersistence?.close()
      await this.conversationStore?.close()
      await this.matrixService?.close()
      await this.attentionScheduleStore?.close()
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

  /**
   * Refuse a Relay command, or return null to allow it.
   *
   * Two refusals, and they are different in kind. "Not configured" means the
   * host supplied no Relay stack, which is the normal state for a Core that
   * was not built with connectors. "Stopped" means the owner stopped Freya,
   * and saying so plainly matters more than a generic failure: the person
   * pressed STOP ALL and then asked for an email to be read.
   */
  private refuseRelay(requestId: string): CoreCommandResult | null {
    if (this.relayEngine === undefined) {
      const reason = 'connectors are not configured in this build'
      return {
        requestId,
        ok: false,
        refusal: { reason },
        relay: { operation: 'refused', ok: false, failureCode: 'connector_unavailable', reason },
      }
    }
    if (!this.relayAdmissionOpen || this.state.stopAll.active) {
      const reason = 'Freya is stopped. Every connector action is refused.'
      return {
        requestId,
        ok: false,
        refusal: { reason },
        relay: { operation: 'refused', ok: false, failureCode: 'stop_all', reason },
      }
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
      this.diagnostics?.recordError('core.research', 'research_event_write_failed', error, 'research event could not be recorded')
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
    this.diagnostics?.recordError('core.research', 'research_operation_failed', error, safe.message, { requestId, operationId, failureCode: safe.code })
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

  /**
   * Close Relay admission. Synchronous.
   *
   * Called by STOP ALL before its first await and by shutdown before anything is
   * awaited, for the same reason research's is: the property being defended is
   * that no connector action can *begin* after a stop. The engine reads the
   * latch fresh at each decision, so a stopped Core refuses every action anyway
   * ??? this closes the door on the way in, so a decision that was already past
   * Guard when the stop arrived cannot reach an adapter afterwards.
   */
  private closeRelay(reason: string): void {
    this.relayAdmissionOpen = false
    this.connectorAdmissionOpen = false
    void reason
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
      return degradedStatus(this.lifecycle, this.state, this.startedAt, this.persistence, this.operational, this.diagnostics, this.lastLifecycleTransition)
    }
    return projectCoreStatus({
      modelSelection: { model: this.selectedModel, providerId: this.selectedProviderId, defaultModel: this.gateway.defaultModel() },
      state: this.state,
      lifecycle: this.currentLifecycle,
      gateway: this.gateway,
      fabric: this.fabric,
      now: (this.options.now ?? (() => new Date()))(),
      startedAt: this.startedAt,
      integrity: this.integrity,
      persistence: this.persistence,
      operational: this.operational,
      diagnosticsPath: this.diagnostics?.path ?? null,
      diagnosticsWriteFailures: this.diagnostics?.failureCount ?? 0,
      ...(this.lastLifecycleTransition ? { lastLifecycleTransition: this.lastLifecycleTransition } : {}),
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
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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
  toolCatalogue(): ToolCatalogueView {
    if (!this.operational || !this.mindToolRegistry) return { health: 'unavailable', reason: 'Core has not reported its tool registry.', tools: [] }
    return { health: 'ready', reason: null, tools: this.mindToolRegistry.list().map(tool => ({
      name: tool.name, description: tool.description, capability: tool.capability,
      parameters: tool.parameters.map(parameter => ({ name: parameter.name, description: parameter.description, required: parameter.required === true })),
    })) }
  }

  private systemInspection(): Readonly<Record<string, unknown>> {
    const brain = this.brain()
    const matrix = this.matrixService?.projection()
    return {
      mind: { lifecycle: this.lifecycle, operational: this.operational, stopped: this.state.stopAll.active, model: this.selectedModel, provider: this.selectedProviderId, conscious: this.consciousness() },
      memory: { health: brain.health, reason: brain.reason, durable: brain.durable, counts: brain.counts },
      missions: this.mission(), goals: this.goals(), attention: this.attention(), agents: this.workforce(),
      skills: this.skills(), tools: this.toolCatalogue(),
      matrix: matrix ? { health: matrix.health, durable: matrix.durable, reason: matrix.reason } : null,
      runtime: this.runtime(),
    }
  }

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
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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

  private requireWorkforce(): WorkforceEngine | ProcessWorkforce {
    if (this.workforceEngine === undefined) {
      throw new Error('the Workforce engine is not available')
    }
    return this.workforceEngine
  }

  /**
   * The Personality projection, and its honest readings.
   *
   * In priority order:
   *
   *   - the `personalitySource` seam, when something filled it. A source is read,
   *     never instructed, and this accessor has no argument for it to be
   *     instructed *with* — so being served verbatim costs the relationship
   *     nothing in authority. This is the Workforce arrangement exactly, and it is
   *     first so that a host that supplies a mirror is not silently overruled.
   *   - Core's **own integration**, once `start()` has built it. This is the
   *     normal production case now: the relationship is Core's, the
   *     anti-repetition ledger is Core's, and the projection is reduced from
   *     exactly those records by the same `projectPersonality` the domain's own
   *     tests exercise.
   *   - neither, which is a Core that has not started: `NO_PERSONALITY_DOMAIN_REASON`
   *     and an `unavailable` projection — "no relationship record exists, and none
   *     is simulated" rather than a warm, empty relationship.
   *   - a source or an integration that threw, so an `unavailable` reading that
   *     says the read failed instead of a stale one that says everything is fine.
   *
   * The one thing this never does is report a relationship it cannot back up. When
   * the store is ephemeral or damaged the projection is still served — with
   * `persistence.durable: false` and the reason in words — because hiding a
   * working-but-transient relationship would be a different lie, and a bigger one.
   */
  personality(): PersonalityProjection {
    if (this.personalitySource !== null) {
      try {
        return this.personalitySource.projection()
      } catch (error) {
        return {
          ...ABSENT_PERSONALITY_PROJECTION,
          reason: `the Personality domain could not be read: ${describe(error)}`,
        }
      }
    }
    if (this.personalityDomain !== undefined) {
      try {
        return this.personalityDomain.projection()
      } catch (error) {
        return {
          ...ABSENT_PERSONALITY_PROJECTION,
          reason: `the Personality domain could not be read: ${describe(error)}`,
        }
      }
    }
    return { ...ABSENT_PERSONALITY_PROJECTION, reason: NO_PERSONALITY_DOMAIN_REASON }
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
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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

  /**
   * The unified conscious context.
   *
   * Never null, and never a partial object: a Core that has not started, or one
   * built without some subsystem, returns a snapshot whose sections say which of
   * those it is. "Freya knows who she is but has no Workforce" and "there is no
   * conscious context" are different facts, and a surface must not have to guess
   * which one it is looking at.
   *
   * Recomputed rather than cached, and that is the design rather than an
   * inefficiency: it holds no state that could disagree with the subsystems it
   * reads, so it cannot go stale relative to the situation it claims to describe
   * and cannot become a second source of truth. The work is bounded by
   * `CONSCIOUS_CONTEXT_LIMITS`, so a journal with a million events costs the same
   * as one with ten.
   *
   * Each contributing accessor is called exactly once and its result reused, so a
   * snapshot is a single consistent read rather than eleven reads that could
   * straddle an event. Nothing here is permitted to throw: a subsystem that cannot
   * be read becomes a stated absence, because a snapshot that threw would leave the
   * surface with nothing at all in exactly the moment something was already wrong.
   *
   * `now` is an argument rather than an internal clock read, for the same reason
   * `attentionTick` takes one: it is what makes "the same durable state gives the
   * same snapshot" a statement a test can check. Two runs over one journal at one
   * instant produce deep-equal snapshots; at two different instants they differ
   * only in `asOf` and in the durations derived from it, which is the honest amount
   * of difference.
   *
   * ## The port wiring
   *
   * Four sections arrive through narrow ports rather than from a domain
   * projection. Each port gets exactly one producer, chosen here and nowhere
   * else, so two subsystems can never both believe they own the same answer:
   *
   * - `life` comes from Phase 21's Life History projection, via
   *   `adapters/life.ts`.
   * - `self` and `world` come from Phase 22's self model and summary, via
   *   `adapters/self.ts` and `adapters/world.ts`.
   * - `continuity` still comes from the Brain, via `adapters/brain.ts`: the
   *   world domain owns entities, facts and relations, not memories, so the
   *   Brain remains the authority for recently admitted memories.
   *
   * `brain` itself is still read directly, for the one thing only it can answer:
   * whether the Brain is readable, which is a `provenance` fact rather than a
   * section.
   */
  consciousness(now?: Date): ConsciousContextProjection {
    if (this.currentLifecycle === 'booting' || this.fabric === undefined) {
      return {
        ...ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
        reason: NO_CONSCIOUS_CONTEXT_REASON,
        provenance: { ...ABSENT_CONSCIOUS_CONTEXT_PROJECTION.provenance },
        limits: { ...ABSENT_CONSCIOUS_CONTEXT_PROJECTION.limits },
      }
    }

    const brain = this.safeBrain()
    const work = this.safeWork()
    const mission = this.safeMission()
    const workforce = this.safeWorkforce()
    const skills = this.safeSkills()
    const personality = this.safePersonality()
    const attention = this.safeAttention()
    const context = this.safeContext()
    const office = this.safeOffice()
    const relay = this.safeRelay()
    // One read of the world summary, shared by the two world-domain ports below so
    // a snapshot cannot contain a self-account from one fold and a world count
    // from another.
    const worldSummary = this.world()

    try {
      return projectConsciousContext(
        {
          status: this.status(),
          stopAll: this.state.stopAll,
          brain,
          // One producer per port, chosen here and nowhere else. Phase 21 and
          // Phase 22 have landed, so `life`, `self` and `world` are answered by
          // their owning domains through the adapters in `consciousness/adapters`.
          // The Brain remains the producer for `continuity` — recently admitted
          // *memories* — because the world domain owns entities, facts and
          // relations, not memories, and mapping its evidence records onto the
          // Brain's memory unions would invent a vocabulary the port deliberately
          // shares with the Brain.
          self: selfFromWorld(this.worldEngine?.self() ?? null, worldSummary),
          world: worldFromWorld(worldSummary),
          continuity: continuityFromBrain(brain),
          life: lifeFrom(this.life()),
          work,
          mission,
          workforce,
          skills,
          personality,
          attention,
          context,
          office,
          relay,
          activity: this.activity(),
          presenceRequests: [...this.state.office.requests.values()],
          pendingRequests: this.state.pendingRequests,
          faults: this.state.faults,
        },
        now ?? this.options.now?.() ?? new Date(),
      )
    } catch (error) {
      // A snapshot that throws is a surface with nothing to show, at the moment the
      // situation is already degraded. So the failure is reported *as* the
      // situation, in the shape a consumer already knows how to read.
      return {
        ...ABSENT_CONSCIOUS_CONTEXT_PROJECTION,
        health: 'degraded',
        reason: `the conscious context could not be derived: ${describe(error)}`,
        stopAll: { ...this.state.stopAll },
        provenance: { ...ABSENT_CONSCIOUS_CONTEXT_PROJECTION.provenance },
        limits: { ...ABSENT_CONSCIOUS_CONTEXT_PROJECTION.limits },
      }
    }
  }

  /**
   * Every contributing accessor, guarded.
   *
   * Each subsystem's own accessor already answers with an absent projection rather
   * than throwing when it is missing, but "already answers" is a property of those
   * methods rather than a guarantee this one gets to rely on - a subsystem that
   * throws would otherwise take the whole snapshot down, and a snapshot that cannot
   * be built is strictly less useful than a partial one.
   *
   * The guard is also what keeps the projection honest about a subsystem it cannot
   * see: `null` becomes a stated absence rather than a silently empty section.
   */
  /**
   * Read one subsystem's projection for the conscious context, or state its absence.
   *
   * ## Why this is one function rather than ten
   *
   * These were ten methods with the same body and a different subsystem name in the log line.
   * A `try/catch` per subsystem invites the twelfth to be added without the catch, and a
   * conscious context that crashes on one unavailable subsystem is exactly the failure this
   * exists to prevent — so the guard belongs somewhere it cannot be forgotten.
   *
   * `null` means **stated absence**, never an empty projection: a window renders "not
   * connected" rather than a section of zeroes, which is the honest difference between
   * "nothing happened" and "I cannot see it".
   */
  private safe<T>(name: string, read: () => T): T | null {
    try {
      return read()
    } catch (error) {
      console.error(`[freya.core] ${name} read for the conscious context threw`, error)
      return null
    }
  }

  private safeBrain(): BrainProjection | null { return this.safe('Brain', () => this.brain()) }

  private safeWork(): WorkProjection | null { return this.safe('Work', () => this.work()) }

  private safeMission(): MissionProjection | null { return this.safe('Mission', () => this.mission()) }

  private safeWorkforce(): WorkforceProjection | null { return this.safe('Workforce', () => this.workforce()) }

  private safeSkills(): SkillProjection | null { return this.safe('Skills', () => this.skills()) }

  private safePersonality(): PersonalityProjection | null { return this.safe('Personality', () => this.personality()) }

  private safeAttention(): AttentionProjection | null { return this.safe('Attention', () => this.attention()) }

  private safeContext(): ContextProjectionView | null { return this.safe('Context', () => this.context()) }

  private safeOffice(): OfficeProjection | null { return this.safe('Office', () => this.office()) }

  private safeRelay(): RelayProjection | null { return this.safe('Relay', () => this.relay()) }

  onConsciousness(listener: (projection: ConsciousContextProjection) => void): () => void {
    this.consciousnessListeners.add(listener)
    // Delivered immediately, like every other subscription here, so a window that
    // attaches late agrees with one that never left.
    try {
      listener(this.consciousness())
    } catch (error) {
      console.error('[freya.core] conscious context subscriber threw', error)
      this.consciousnessListeners.delete(listener)
    }
    return () => {
      this.consciousnessListeners.delete(listener)
    }
  }

  private publishConsciousness(): void {
    if (this.consciousnessListeners.size === 0) return
    const projection = this.consciousness()
    for (const listener of [...this.consciousnessListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] conscious context listener threw', error)
        this.consciousnessListeners.delete(listener)
      }
    }
  }

  runtime(): RuntimeProjection {
    if (this.activation === undefined) {
      // Before start, every registered domain is reported as registered rather
      // than as an empty list: "this build implements these, and none has been
      // evaluated yet" is a different and more useful fact than "there are none".
      return {
        lifecycle: 'unstarted',
        generatedAt: this.nowIso(),
        stopAllActive: false,
        counts: { ...EMPTY_COUNTS, registered: RUNTIME_REGISTRY.length },
        domains: RUNTIME_REGISTRY.map((descriptor) => ({
          id: descriptor.id,
          family: descriptor.family,
          title: descriptor.title,
          module: descriptor.module,
          kind: descriptor.kind,
          activation: descriptor.activation,
          status: 'registered' as const,
          reason: 'registered but Core has not started',
          missing: [],
          evidence: [],
          activatedAt: null,
          changedAt: null,
          lastOutcome: null,
          note: descriptor.note,
        })),
        active: [],
        blocked: [],
        degraded: [],
        lastStopReason: null,
        lastReconciledAt: null,
        recoveredDomains: [],
      }
    }
    return this.activation.projection()
  }

  onRuntime(listener: (projection: RuntimeProjection) => void): () => void {
    this.runtimeListeners.add(listener)
    try {
      listener(this.runtime())
    } catch (error) {
      console.error('[freya.core] runtime subscriber threw', error)
      this.runtimeListeners.delete(listener)
    }
    return () => {
      this.runtimeListeners.delete(listener)
    }
  }

  private publishRuntime(): void {
    if (this.runtimeListeners.size === 0) return
    const projection = this.runtime()
    for (const listener of [...this.runtimeListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] runtime listener threw', error)
        this.runtimeListeners.delete(listener)
      }
    }
  }

  /**
   * The live fact set the activation controller evaluates against.
   *
   * Plain data, read fresh at each lifecycle event. No callback is handed to the
   * controller, so it cannot pull a fact Core did not choose to publish.
   */
  private runtimeFacts(): RuntimeFacts {
    const options = this.options
    const keyringKeys: string[] = []
    if (options.conversationKey !== undefined && options.conversationKey !== null) keyringKeys.push('conversation')
    if (options.brainKey !== undefined && options.brainKey !== null) keyringKeys.push('brain')
    if (options.personalityKey !== undefined && options.personalityKey !== null) keyringKeys.push('personality')

    const hostAdapters: string[] = []
    if (options.research !== undefined) hostAdapters.push('research')
    if (options.relay !== undefined) hostAdapters.push('relay')
    if (options.voiceStt !== undefined || options.voiceTts !== undefined || options.voiceWake !== undefined) hostAdapters.push('voice')
    // Adapters the host wired but does not route through Core — Phase 42's Device
    // Hands seam is the live case. Declared, never inferred.
    hostAdapters.push(...(options.runtimeFacts?.hostAdapters ?? []))

    const connectors: string[] = []
    if (options.relay !== undefined) {
      for (const name of Object.keys(options.relay.adapters)) connectors.push(name)
    }

    const providers = this.gateway === undefined ? [] : this.gateway.statuses()

    return {
      coreLifecycle: this.currentLifecycle,
      journalTrustworthy: this.integrity.integrity === 'ok',
      stopAllActive: this.state.stopAll.active,
      vaultOpen: this.vault !== null,
      keyringKeys,
      providerConfigured: providers.length > 0,
      providerCount: providers.length,
      hostAdapters,
      connectors,
      ownerApprovals: [],
      // Cognition grants authorise a *cause*, not a capability name, so there is
      // deliberately nothing here that could be mistaken for a capability grant.
      // Only capability names the *host* holds an owner-authored grant for appear,
      // and Core cannot act on any of them.
      capabilityGrants: [...(options.runtimeFacts?.capabilityGrants ?? [])],
      trustedDevices: 0,
      transportAvailable: false,
      budgetRemainingUnits: 0,
      policyPresent: false,
      recoveryJournalReady: false,
      continuationReady: false,
    }
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
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

  /* ------------------------------------------------------------------ forge */

  /**
   * Core's Forge projection.
   *
   * `unavailable` with `NO_FORGE_DOMAIN_REASON` when no Forge has been built, so a
   * window cannot render "Freya has no generated skills" in a build that never
   * offered her the chance.
   */
  forge(): ForgeProjection {
    if (this.forgeEngine === undefined) {
      return { ...ABSENT_FORGE_PROJECTION, reason: NO_FORGE_DOMAIN_REASON }
    }
    try {
      return this.forgeEngine.projection()
    } catch (error) {
      return {
        ...ABSENT_FORGE_PROJECTION,
        reason: `the Forge domain could not be read: ${describe(error)}`,
      }
    }
  }

  onForge(listener: (projection: ForgeProjection) => void): () => void {
    this.forgeListeners.add(listener)
    try {
      listener(this.forge())
    } catch (error) {
      console.error('[freya.core] Forge subscriber threw', error)
      this.forgeListeners.delete(listener)
    }
    return () => {
      this.forgeListeners.delete(listener)
    }
  }

  private publishForge(): void {
    // Deliberately *not* folded into publishSkills. A package appearing is not a
    // procedure appearing, and a reader who saw one projection move because the
    // other did would have learned to distrust both.
    if (this.forgeListeners.size === 0) return
    const projection = this.forge()
    for (const listener of [...this.forgeListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Forge listener threw', error)
        this.forgeListeners.delete(listener)
      }
    }
  }

  private requireForge(): ForgeEngine {
    if (this.forgeEngine === undefined) {
      throw new Error('the Forge engine is not available')
    }
    return this.forgeEngine
  }

  /**
   * The owner's face of Forge. Issued here, absent from every interface a window can
   * name, and carrying no capability that grants, approves or self-modifies.
   */
  private issueForgeOwnerScope(): ForgeOwnerScope {
    return this.requireForge().ownerScope()
  }

  private forgeResult(requestId: string, outcome: ForgeCommandOutcome): CoreCommandResult {
    if (!outcome.ok) {
      return {
        requestId,
        ok: false,
        refusal: { reason: outcome.reason ?? 'the Forge command was refused' },
        forge: outcome,
      }
    }
    return {
      requestId,
      ok: true,
      status: this.status(),
      forge: outcome,
    }
  }

  private forgeRefusal(
    requestId: string,
    operation: ForgeCommandOutcome['operation'],
    code: ForgeRefusalCode,
    reason: string,
  ): CoreCommandResult {
    return {
      requestId,
      ok: false,
      refusal: { reason },
      forge: { operation, ok: false, code, reason },
    }
  }

  /**
   * The capability port Forge reads.
   *
   * `isRegistered` is the same question Skill admission asks ? does any registered
   * Work capability need this Guard capability ? so a package can only declare
   * something this Core could actually execute. `holds` is Guard's answer for the
   * owner principal, read fresh on every run.
   */
  private forgeCapabilities(): ForgeCapabilityPort {
    const registry = this.workRegistry
    return {
      isRegistered: (capability) => {
        if (registry === undefined) return false
        for (const name of registry.names()) {
          const registered = registry.capability(name)
          if (registered !== undefined && registered.capability === capability) return true
        }
        return false
      },
      holds: (capability) => this.guard.holds(this.owner, capability),
    }
  }

  /**
   * Recover the encrypted Forge store, or degrade in words.
   *
   * Same discipline as the Skill store and the same reason: a damaged store must not
   * be silently replaced by an ephemeral one, because that would report "nothing is
   * remembered" when the truth is "the file is damaged and Freya stopped trusting
   * it". So the runtime records a fault, the projection reports `durable: false`
   * with the reason, and no body is adopted ? which means a package Core cannot read
   * is a package that cannot run.
   */
private async buildForge(): Promise<void> {
    try {
      const opened = await ForgePersistenceRuntime.open({
        path: `${this.options.dataPath}.forge.enc`,
        key: this.options.forgeKey ?? null,
        onHealthChange: () => this.publishForge(),
      })
      this.forgePersistence = opened.runtime
      this.forgeEngine = new ForgeEngine({
        fabric: this.fabric,
        getState: () => this.state.forge,
        actor: this.owner.id,
        capabilities: this.forgeCapabilities(),
        store: {
          // The bodies read at start are handed over once. The engine still re-filters
          // every one of them against the fold *and* its recorded hash before adopting
          // it, so a file that survived the store's own authentication and still
          // disagrees with the journal is dropped rather than run.
          load: async () => opened.packages,
          commit: (packages) => opened.runtime.commit(packages),
          health: () => opened.runtime.health(),
        },
        now: this.options.now,
        newId: this.options.newId,
        onChange: () => this.publishForge(),
        stopAll: () => this.state.stopAll.active,
      })
      await this.forgeEngine.open()
    } catch (error) {
      console.error('[freya.core] encrypted Forge store unavailable', describe(error))
      this.forgePersistence = undefined
      // A Forge with no store still works, and says so: bodies live in this process
      // and the projection reports `durable: false` rather than pretending otherwise.
      this.forgeEngine = new ForgeEngine({
        fabric: this.fabric,
        getState: () => this.state.forge,
        actor: this.owner.id,
        capabilities: this.forgeCapabilities(),
        store: null,
        now: this.options.now,
        newId: this.options.newId,
        onChange: () => this.publishForge(),
        stopAll: () => this.state.stopAll.active,
      })
      await this.forgeEngine.open()
    }
  }
  private publishSkills(): void {
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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
   * The Life History projection, and its honest readings.
   *
   * A Core that has not started reports `unavailable` with
   * `NO_LIFE_DOMAIN_REASON` — "no history is recorded, and none is simulated" —
   * rather than an empty history, because the two are different facts. Once
   * started, the engine is the source of truth and this accessor reads it; there
   * is no argument here through which a caller could instruct it.
   */
  life(): LifeProjection {
    if (this.lifeEngine === undefined) {
      return { ...ABSENT_LIFE_PROJECTION, reason: NO_LIFE_DOMAIN_REASON }
    }
    try {
      return this.lifeEngine.projection()
    } catch (error) {
      return {
        ...ABSENT_LIFE_PROJECTION,
        reason: `the Life History domain could not be read: ${describe(error)}`,
      }
    }
  }

  onLife(listener: (projection: LifeProjection) => void): () => void {
    this.lifeListeners.add(listener)
    try {
      listener(this.life())
    } catch (error) {
      console.error('[freya.core] Life History subscriber threw', error)
      this.lifeListeners.delete(listener)
    }
    return () => {
      this.lifeListeners.delete(listener)
    }
  }

  private publishLife(): void {
    if (this.lifeListeners.size === 0) return
    const projection = this.life()
    for (const listener of [...this.lifeListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Life History listener threw', error)
        this.lifeListeners.delete(listener)
      }
    }
  }

  /** Read what Freya has learned: outcomes, distilled lessons and active claims. */
  learning(): LearningProjection {
    if (this.learningEngine === undefined) {
      return ABSENT_LEARNING_PROJECTION
    }
    try {
      return this.learningEngine.project()
    } catch (error) {
      return {
        ...ABSENT_LEARNING_PROJECTION,
        persistence: {
          ...ABSENT_LEARNING_PROJECTION.persistence,
          reason: `the Learning domain could not be read: ${describe(error)}`,
        },
      }
    }
  }

  /** Subscribe to the Learning projection. Same mirror semantics as the others. */
  onLearning(listener: (projection: LearningProjection) => void): () => void {
    this.learningListeners.add(listener)
    try {
      listener(this.learning())
    } catch (error) {
      console.error('[freya.core] Learning subscriber threw', error)
      this.learningListeners.delete(listener)
    }
    return () => {
      this.learningListeners.delete(listener)
    }
  }

  private publishLearning(): void {
    if (this.learningListeners.size === 0) return
    const projection = this.learning()
    for (const listener of [...this.learningListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Learning listener threw', error)
        this.learningListeners.delete(listener)
      }
    }
  }

  /** Direct engine handle for internal reasoning and planning recall. */
  learningEngineInstance(): LearningEngine | undefined {
    return this.learningEngine
  }

  /** Correct an admitted knowledge record (replaces claim, superseding original). */
  async correctLearningClaim(
    recordId: string,
    replacement: { claim: string; reason: string },
  ): Promise<LearningWriteOutcome> {
    if (this.learningEngine === undefined) {
      return {
        ok: false,
        outcome: 'refused',
        code: 'store-unavailable',
        reason: 'the learning engine is not available',
        recordId: null,
        superseded: null,
      }
    }
    const observedAt = (this.options.now ?? (() => new Date()))().toISOString()
    return this.learningEngine.correct(recordId, {
      claim: replacement.claim,
      reason: replacement.reason,
      observedAt,
    })
  }

  /** Withdraw an admitted knowledge record (retracts claim, destroying claim text while retaining audit trail). */
  async withdrawLearningClaim(recordId: string): Promise<LearningWriteOutcome> {
    if (this.learningEngine === undefined) {
      return {
        ok: false,
        outcome: 'refused',
        code: 'store-unavailable',
        reason: 'the learning engine is not available',
        recordId: null,
        superseded: null,
      }
    }
    return this.learningEngine.withdraw(recordId)
  }

  executiveDecision(options?: {
    readonly explicitPriorities?: ReadonlyMap<string, MissionPriority>
    readonly budgetLimits?: ReadonlyMap<string, ExecutiveBudgetLimit> | Readonly<Record<string, ExecutiveBudgetLimit>>
    readonly budgetSpends?: ReadonlyMap<string, ExecutiveBudgetSpend> | Readonly<Record<string, ExecutiveBudgetSpend>>
    readonly requiredSpecialisations?: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>
    readonly missionAges?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  }): ExecutiveDecisionOutcome {
    const nowIso = (this.options.now ?? (() => new Date()))().toISOString()
    const missions = this.missionEngine?.projection().missions ?? []
    const workforce = this.safeWorkforce()
    const workers = workforce?.workers ?? []
    const stopAllActive = this.state.stopAll.active
    const guardMayManage = this.guard.evaluate(this.owner, 'mission.manage').allowed

    // Extract durable mission spend and budget if available from mission engine
    const internalMissions = this.missionEngine
      ? (
          this.missionEngine as unknown as {
            state?: {
              missions: Map<
                string,
                {
                  budget?: { maxActions: number; maxModelCalls: number; maxExternalRequests: number }
                  spend?: { actions: number; modelCalls: number; externalRequests: number }
                }
              >
            }
          }
        ).state?.missions
      : undefined

    const derivedSpends = new Map<string, ExecutiveBudgetSpend>()
    const derivedLimits = new Map<string, ExecutiveBudgetLimit>()
    if (internalMissions) {
      for (const [id, m] of internalMissions.entries()) {
        if (m.budget) {
          derivedLimits.set(id, {
            maxActions: m.budget.maxActions,
            maxModelCalls: m.budget.maxModelCalls,
            maxExternalRequests: m.budget.maxExternalRequests,
          })
        }
        if (m.spend) {
          derivedSpends.set(id, {
            actions: m.spend.actions,
            modelCalls: m.spend.modelCalls,
            externalRequests: m.spend.externalRequests,
          })
        }
      }
    }

    return evaluateExecutiveDecision({
      missions,
      workers,
      stopAllActive,
      guardMayManage,
      now: nowIso,
      explicitPriorities: options?.explicitPriorities,
      budgetLimits: options?.budgetLimits ?? derivedLimits,
      budgetSpends: options?.budgetSpends ?? derivedSpends,
      requiredSpecialisations: options?.requiredSpecialisations,
      missionAges: options?.missionAges,
    })
  }

  executiveState(options?: {
    readonly explicitPriorities?: ReadonlyMap<string, MissionPriority>
    readonly budgetLimits?: ReadonlyMap<string, ExecutiveBudgetLimit> | Readonly<Record<string, ExecutiveBudgetLimit>>
    readonly budgetSpends?: ReadonlyMap<string, ExecutiveBudgetSpend> | Readonly<Record<string, ExecutiveBudgetSpend>>
    readonly requiredSpecialisations?: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>
    readonly missionAges?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  }): ExecutiveState {
    return this.executiveDecision(options).state
  }

  /** Subscribe to event-driven Executive decisions (Phase 4C). */
  onExecutiveDecision(listener: (outcome: ExecutiveDecisionOutcome) => void): () => void {
    this.executiveListeners.add(listener)
    if (this.lastExecutiveDecisionOutcome !== null) {
      try {
        listener(this.lastExecutiveDecisionOutcome)
      } catch (error) {
        console.error('[freya.core] Immediate executive listener threw', error)
      }
    }
    return () => {
      this.executiveListeners.delete(listener)
    }
  }

  /** The last event-driven Executive decision outcome (Phase 4C). */
  lastExecutiveDecision(): ExecutiveDecisionOutcome | null {
    return this.lastExecutiveDecisionOutcome
  }

  private observeExecutiveSource(event: AnyCoreEvent): void {
    if (!isExecutiveTriggerEvent(event.type)) return
    queueMicrotask(() => {
      if (this.stopped) return
      try {
        const outcome = this.executiveDecision()
        this.lastExecutiveDecisionOutcome = outcome
        for (const listener of [...this.executiveListeners]) {
          try {
            listener(outcome)
          } catch (error) {
            console.error('[freya.core] Executive listener threw', error)
          }
        }
      } catch (error) {
        console.error('[freya.core] observeExecutiveSource threw', error)
      }
    })
  }


  /**
   * Evaluate `skill.manage` for the owner and record the decision, or answer the
   * refusal.
   *
   * Guard runs before any skill code, and the decision is journalled like every other
   * capability evaluation ??? so a refused skill mutation appears in the audit stream
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
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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

  /**
   * The Office projection.
   *
   * A mirror like the others, and derived entirely from Core's own Work,
   * Workforce and status projections. A window holds what Core last built and
   * cannot write a field of it. There is no code path here that invents a
   * station, inflates a count or fabricates a percentage: the Office is a pure
   * function of real state, and the shape of the read is the whole policy.
   *
   * A Core that has not started reports `unavailable` with a stated reason
   * rather than an empty office, because "the office is empty" and "Core is not
   * up" are different facts and a surface must not have to guess which one it
   * is looking at.
   */
  office(): OfficeProjection {
    if (this.currentLifecycle === 'booting' || this.fabric === undefined) {
      return { ...ABSENT_OFFICE_PROJECTION, reason: 'Core has not reported yet' }
    }
    return projectOffice({
      work: this.work(),
      // Office consumes Core's canonical Workforce domain, not the older
      // read-only protocol mirror seam. The mirror has a deliberately smaller
      // shape and may be supplied by a host/test source; treating it as the
      // internal domain projection can fabricate missing fields and throw.
      workforce: this.workforceEngine?.projection() ?? null,
      core: this.status(),
      presenceRequests: [...this.state.office.requests.values()],
    })
  }

  onOffice(listener: (projection: OfficeProjection) => void): () => void {
    this.officeListeners.add(listener)
    // Delivered immediately, like every other subscription here, so a window
    // that attaches late agrees with one that never left.
    try {
      listener(this.office())
    } catch (error) {
      console.error('[freya.core] Office subscriber threw', error)
    }
    return () => {
      this.officeListeners.delete(listener)
    }
  }

  private publishOffice(): void {
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
    if (this.officeListeners.size === 0) return
    const projection = this.office()
    for (const listener of [...this.officeListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Office listener threw', error)
        this.officeListeners.delete(listener)
      }
    }
  }

  foundry(): FoundryProjection {
    if (this.foundryEngine === undefined) {
      return { ...ABSENT_FOUNDRY_PROJECTION, reason: NO_FOUNDRY_DOMAIN_REASON }
    }
    try {
      return this.foundryEngine.projection()
    } catch (error) {
      return {
        ...ABSENT_FOUNDRY_PROJECTION,
        reason: `the Foundry domain could not be read: ${describe(error)}`,
      }
    }
  }

  onFoundry(listener: (projection: FoundryProjection) => void): () => void {
    this.foundryListeners.add(listener)
    try {
      listener(this.foundry())
    } catch (error) {
      console.error('[freya.core] Foundry subscriber threw', error)
    }
    return () => {
      this.foundryListeners.delete(listener)
    }
  }

  private publishFoundry(): void {
    // Deliberately NOT a conscious-context publisher. Foundry is not one of the
    // twelve rows in CONSCIOUS_SOURCES and the projection never reads it, so a
    // Foundry change cannot move the snapshot; recomputing and pushing it here would
    // be publishing a value that did not change, which is how a mirror starts
    // looking alive when it is not.
    if (this.foundryListeners.size === 0) return
    const projection = this.foundry()
    for (const listener of [...this.foundryListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Foundry listener threw', error)
        this.foundryListeners.delete(listener)
      }
    }
  }

  async attentionTick(now?: Date): Promise<number> {
    if (this.attentionEngine === undefined) return 0
    // The life loop goes **first**, and the order is load-bearing rather than
    // incidental. A schedule the loop is going to be offered must still be pending,
    // and `AttentionEngine.tick` settles every due schedule as it fires — so a loop
    // that looked afterwards would find an empty list and its heartbeat would be
    // dead code that still looked wired.
    //
    // Running it here rather than on a second host timer is also why this phase adds
    // no timer at all: a second interval would be a second thing to clear on
    // shutdown, a second thing to forget when the window closes, and the shape a
    // runaway loop takes.
    //
    // Its count is deliberately **not** added to the return value. That number is the
    // number of Attention schedules that fired, it is what the host and three existing
    // tests both read, and folding a different subsystem's count into it would make
    // one number mean two things.
    await this.lifeLoopTick()
    return await this.attentionEngine.tick(now)
  }

  /**
   * The bounded heartbeat, on its own.
   *
   * Expire one deadline that has passed, and offer at most one due schedule to the
   * registry. No model call, no provider contact, and nothing appended for a
   * schedule that is not due.
   *
   * Main-process composition only, and reachable from nowhere else — there is
   * deliberately no `lifeloop.tick` command, so a renderer cannot drive the clock.
   */
  private async lifeLoopTick(): Promise<number> {
    const runtime = this.lifeLoopRuntime
    if (runtime === undefined) return 0
    return await runtime.tick()
  }

  /**
   * Core's account of Relay.
   *
   * Never null and never throwing: a Core that has not started reports the
   * frozen absent projection, because "Relay is not up yet" and "there are no
   * connectors" are different facts and a surface must not have to guess which
   * one it is looking at.
   */
  relay(): RelayProjection {
    if (this.relayEngine === undefined || this.fabric === undefined) {
      return ABSENT_RELAY_PROJECTION
    }
    return projectRelay(this.fabric.lastSequence, this.state.relay, (connector) =>
      this.relayEngine?.connectorStatus(connector) ?? 'unavailable',
    )
  }

  onRelay(listener: (projection: RelayProjection) => void): () => void {
    this.relayListeners.add(listener)
    try {
      listener(this.relay())
    } catch (error) {
      console.error('[freya.core] Relay subscriber threw', error)
    }
    return () => {
      this.relayListeners.delete(listener)
    }
  }

  private publishRelay(): void {
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
    // Relay's pending approvals are part of the connector projection, so a
    // Relay change is a connector change.
    this.publishConnectors()
    if (this.relayListeners.size === 0) return
    const projection = this.relay()
    for (const listener of [...this.relayListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Relay listener threw', error)
        this.relayListeners.delete(listener)
      }
    }
  }

  private requireRelay(): RelayEngine {
    if (this.relayEngine === undefined) {
      throw new Error('the Relay engine is not available')
    }
    return this.relayEngine
  }

  /**
   * Core's account of the connector connection plane.
   *
   * Never null and never throwing: a Core with no connector domain reports the
   * frozen absent projection, because "connectors are not up yet" and "there
   * are no connectors" are different facts.
   */
  connectors(): ConnectorProjection {
    if (this.connectorEngine === undefined || this.fabric === undefined) {
      return ABSENT_CONNECTOR_PROJECTION
    }
    const engine = this.connectorEngine
    return projectConnectors({
      sequence: this.fabric.lastSequence,
      engine,
      pendingApproval: (connector) => {
        const relayConnector = connectorDefinition(connector).relayConnector
        return this.state.relay.approvals.some(
          (approval) => approval.status === 'pending' && approval.connector === relayConnector,
        )
      },
      recentEvents: this.state.connectors.events,
    })
  }

  onConnectors(listener: (projection: ConnectorProjection) => void): () => void {
    this.connectorListeners.add(listener)
    try {
      listener(this.connectors())
    } catch (error) {
      console.error('[freya.core] connector subscriber threw', error)
    }
    return () => {
      this.connectorListeners.delete(listener)
    }
  }

  private publishConnectors(): void {
    if (this.connectorListeners.size === 0) return
    const projection = this.connectors()
    for (const listener of [...this.connectorListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] connector listener threw', error)
        this.connectorListeners.delete(listener)
      }
    }
  }

  private requireConnector(): ConnectorEngine {
    if (this.connectorEngine === undefined) {
      throw new Error('the connector engine is not available')
    }
    return this.connectorEngine
  }

  /**
   * Refuse a connector command, or return null to allow it.
   *
   * Mirrors `refuseRelay`: a build with no connector domain refuses with a
   * closed code, and a stopped Core refuses before the first await.
   */
  private refuseConnector(requestId: string): CoreCommandResult | null {
    if (this.connectorEngine === undefined) {
      const reason = 'this Core has no connector domain'
      return {
        requestId,
        ok: false,
        refusal: { reason },
        connectors: { operation: 'refused', ok: false, failureCode: 'unsupported', reason },
      }
    }
    if (!this.connectorAdmissionOpen || this.state.stopAll.active) {
      const reason = 'Freya is stopped. Every connector action is refused.'
      return {
        requestId,
        ok: false,
        refusal: { reason },
        connectors: { operation: 'refused', ok: false, failureCode: 'stop_all', reason },
      }
    }
    return null
  }

  /**
   * Complete an authorization. Host-only.
   */
  async connectorAuthorizationComplete(payload: unknown): Promise<ConnectorCommandOutcome> {
    if (this.connectorEngine === undefined) {
      return { operation: 'refused', ok: false, failureCode: 'unsupported', reason: 'this Core has no connector domain' }
    }
    const result = await this.requireConnector().authorizationComplete(payload)
    if (!result.ok) {
      return { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason }
    }
    this.publishConnectors()
    return { operation: 'authorization', ok: true }
  }

  /**
   * Deliver an authenticated external event. Host-only.
   */
  async connectorEventIngest(payload: unknown): Promise<ConnectorCommandOutcome> {
    if (this.connectorEngine === undefined) {
      return { operation: 'refused', ok: false, failureCode: 'unsupported', reason: 'this Core has no connector domain' }
    }
    const result = await this.requireConnector().ingestEvent(payload)
    if (!result.ok) {
      return { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason }
    }
    this.publishConnectors()
    return { operation: 'status', ok: true, eventId: result.eventId }
  }

  private requireAttention(): AttentionEngine {
    if (this.attentionEngine === undefined) {
      throw new Error('the Attention engine is not available')
    }
    return this.attentionEngine
  }

  /**
   * The Continuous Life Loop's ports.
   *
   * This method is the whole of the integration, and its shape is the argument:
   * every line is either a read of state Core already holds, a narrow write of
   * loop-owned metadata, or one of the two decision delegations. There is no line
   * that hands the loop a gateway, a provider, a permit, a principal, a capability
   * or a grant store — so there is nothing for the loop to reach authority through,
   * at compile time rather than by convention.
   *
   * The three that are *callbacks* rather than values (`stopAllActive`,
   * `journalTrustworthy`, `focus`) are callbacks on purpose. A latch or a focus
   * reading copied into the loop would let the loop act on a stale one, which is
   * the same class of bug as a STOP ALL checked before an `await`.
   */
  private lifeLoopPorts(): LifeLoopPorts {
    return {
      now: () => this.lifeLoopNow().toISOString(),
      newId: () => this.newId(),
      append: async (type, payload) => {
        // Durable before it resolves. The loop's state is derived from these and
        // from nothing else, so a refusal has to fail loudly rather than be
        // swallowed — there is no in-memory copy that would not be lost anyway.
        await this.fabric.append(type as never, payload as never, {
          actor: 'system',
          correlationId: typeof payload.wakeId === 'string' && payload.wakeId.length > 0
            ? payload.wakeId
            : this.newId(),
        })
      },
      replay: async () => {
        const events = await this.fabric.readAll()
        return events.map(
          (event): LifeLoopJournalEntry => ({
            type: event.type,
            // The envelope's instant is named `occurredAt`; the loop's fold asks for
            // `recordedAt` because it also folds journals written by other means.
            // The two are the same instant and the mapping lives here, once.
            recordedAt: event.occurredAt,
            payload: event.payload,
          }),
        )
      },
      stopAllActive: () => this.state.stopAll.active || this.gateway?.gateStatus().open === false,
      journalTrustworthy: () => this.integrity.integrity !== 'corrupt',
      // The loop is always built and always reports; whether its subsystems are
      // connected is the option, and the option is checked at the point a wake
      // would be raised rather than here, so `isEnabled` in the projection means
      // "this Core wired it", which is the fact a surface can act on.
      enabled: () => true,
      schedules: () => this.lifeLoopSchedules(),
      conditionHolds: (scheduleId) => this.lifeLoopConditionHolds(scheduleId),
      focus: () => this.lifeLoopFocus(),
      grantAvailable: (now) => this.lifeLoopGrant(now) !== null,
      budgetRemainingCalls: (now) => this.lifeLoopBudgetRemaining(now),
      requestCognition: (request) => this.lifeLoopRequestCognition(request),
      verify: (request) => this.lifeLoopVerify(request),
      raiseEscalation: async (escalation) => this.lifeLoopRaise(escalation),
      goalOpen: (goalRef) => this.attentionGoalOpen(goalRef),
      escalationApprovalRequired: () => false,
      onChange: () => this.publishLifeLoop(),
    }
  }

  /**
   * One clock, read the same way everywhere.
   *
   * The loop never reads `Date.now()` itself — that is what makes "the same journal
   * at the same instant gives the same answer" testable — so every instant it sees
   * comes from the injected Core clock.
   */
  private lifeLoopNow(): Date {
    return (this.options.now ?? (() => new Date()))()
  }

  /**
   * The schedules a heartbeat may fire, as the closed shape the registry validates.
   *
   * Attention owns the truth; this is a read of it and never a second copy. A
   * schedule the loop cannot see is a schedule it cannot fire, which is exactly the
   * bound that keeps a heartbeat from becoming a poll.
   */
  private lifeLoopSchedules(): readonly PendingSchedule[] {
    if (this.attentionEngine === undefined) return []
    return pendingSchedules(this.state.attention).map((schedule) => ({
      scheduleId: schedule.scheduleId,
      dueAt: schedule.dueAt,
    }))
  }

  /**
   * The three closed conditions Attention already implements.
   *
   * Re-derived here rather than reaching into the engine, because the loop needs a
   * boolean and the engine's own `conditionHolds` is private to a decision it makes
   * inside `tick`. Both read the same three conditions from the same journal fold,
   * so they cannot disagree about whether a schedule is eligible — and if this
   * table ever drifted from the engine's, the registry would refuse the wake with
   * `heartbeat-condition-unmet` and journal the disagreement rather than firing.
   */
  private lifeLoopConditionHolds(scheduleId: string): boolean {
    const schedule = this.state.attention.schedules.find(
      (candidate) => candidate.scheduleId === scheduleId,
    )
    if (schedule === undefined || schedule.status !== 'pending') return false
    switch (schedule.condition) {
      case 'always':
        return true
      case 'focus-available':
        return this.attentionFocus() !== 'focused'
      case 'goal-open':
        return schedule.goalRef !== null && this.attentionGoalOpen(schedule.goalRef)
      default:
        return false
    }
  }

  /**
   * What the owner is focused on, in the loop's own two-field shape.
   *
   * Derived from the *same* reading Attention decides with, one function call apart,
   * so the loop and the attention engine cannot hold two opinions about whether the
   * owner is mid-task. `focusRef` is null because Core's reading is "is a provider
   * call in flight or a Run executing" and has no id for it — a made-up identifier
   * would be worse than admitting there is not one.
   */
  private lifeLoopFocus(): { readonly focused: boolean; readonly focusRef: string | null } {
    return { focused: this.attentionFocus() === 'focused', focusRef: null }
  }

  /**
   * The grant that could pay for one background thought, or null.
   *
   * *Selection*, never minting: this walks the owner's existing grants in creation
   * order and returns the first one `checkGrant` accepts for a background call of
   * this shape. The Governor still verifies it, still enforces its own ceilings, and
   * still refuses anything that does not match — so a grant named here is a
   * candidate to be judged, not an authorisation. There is no code path here that
   * widens one, invents one, or returns null as a failure the caller could work
   * around.
   */
  private lifeLoopGrant(now: string): CognitionGrant | null {
    if (this.service === undefined) return null
    return this.lifeLoopSelectGrant(now)
  }

  /**
   * Calls still available under the grant that could pay for a thought.
   *
   * Zero is the honest answer whenever no grant qualifies, which is what makes
   * "an idle Freya spends nothing" fall out of the prefilter rather than out of a
   * hopeful default. It is a count, never an estimate: the figure comes from the
   * durable reservation the Cognition service already records before a provider is
   * contacted, so it survives a restart.
   */
  private lifeLoopBudgetRemaining(now: string): number {
    const grant = this.lifeLoopGrant(now)
    // With no qualifying grant this reports the loop's *own* per-wake ceiling rather
    // than zero, and the distinction is deliberate rather than cosmetic.
    //
    // Budget and grant are two different questions: budget is how much this loop may
    // still spend on this wake, grant is whether anything has authorised it. The
    // prefilter asks budget first because an exhausted budget is the more specific
    // answer when both apply — but on a Core where no owner has ever created a
    // background grant, reporting zero here would answer "budget-exhausted" for a
    // Freya that has never been given a coin. The truthful reading of "no grant" is
    // "nothing has authorised this", so the gate that says so is the one that fires.
    if (grant === null) return LIFE_LOOP_LIMITS.maxCognitionRequestsPerWake
    // And when there is a grant, this is a durable count rather than an estimate: the
    // figure comes from the reservation the Cognition service records before a
    // provider is contacted, so it survives a restart.
    return Math.max(0, grant.maxCalls - grant.usage.calls)
  }

  private lifeLoopSelectGrant(now: string): CognitionGrant | null {
    const at = new Date(now)
    const grants = this.ownerAuthority.grants()
    for (const grant of grants) {
      if (!isGrantActive(grant, at)) continue
      // The narrowest context that could still pay for one background thought. A
      // grant scoped to a goal or an origin the loop cannot produce is skipped
      // here rather than discovered as a refusal after the fact.
      const context: GrantContext = {
        origin: 'system',
        cause: 'scheduled_grant',
        goalId: null,
        runId: null,
        actor: this.owner.id,
        background: true,
        maxOutputTokens: 0,
      }
      if (checkGrant(grant, context, at).ok) return grant
    }
    return null
  }

  /**
   * The loop's only route to a model.
   *
   * Three properties, in order, and each one is the reason this is a method on Core
   * rather than something the loop could have done itself:
   *
   *   1. **No principal is named by the caller.** The intent kind is
   *      `scheduled_task`, and Core derives the origin, the cause and the background
   *      flag from that closed category. The loop cannot compose a shape that means
   *      more than the category does.
   *   2. **The Governor still decides.** A grant is *selected* here and *judged*
   *      there, so naming one buys nothing: a grant that does not cover background
   *      system work, or that has spent its calls, is refused before a provider is
   *      contacted, and a refusal costs nothing because nothing was contacted.
   *   3. **The answer is a closed outcome.** Whatever the provider said is parsed
   *      into one of five words or it is discarded, so no downstream branch can be
   *      driven by prose a model produced — and an unparseable answer is
   *      `do-nothing`, never an escalation.
   */
  private async lifeLoopRequestCognition(
    request: Parameters<LifeLoopPorts['requestCognition']>[0],
  ): ReturnType<LifeLoopPorts['requestCognition']> extends Promise<infer T> ? Promise<T> : never {
    const now = new Date(this.lifeLoopNow())
    const grant = this.lifeLoopSelectGrant(now.toISOString())
    if (grant === null) {
      return { status: 'refused', code: 'no-active-grant' }
    }
    const outcome = await this.ownerAuthority.request({
      kind: 'scheduled_task',
      prompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens,
      grantId: grant.id,
      goalId: null,
      correlationId: request.wakeKey,
      cognitionRequestId: request.wakeId,
    })
    if (outcome.status === 'denied') return { status: 'refused', code: 'governor-refused' }
    if (outcome.status === 'cancelled') return { status: 'refused', code: 'cancelled' }
    if (outcome.status === 'failed') {
      return outcome.providerContacted
        ? { status: 'failed', code: 'provider-failed' }
        : { status: 'refused', code: 'no-provider-contacted' }
    }
    return {
      status: 'decided',
      outcome: readDecideOutcome(outcome.text),
      providerId: outcome.providerId,
      model: outcome.model,
    }
  }

  /**
   * Did what the wake said actually happen?
   *
   * A read of Core's own projections, never a second thought: "is the thing that
   * just finished still open?" is a question about state the loop's host already
   * holds, and answering it with inference would make the loop's honesty depend on
   * its provider being honest.
   *
   * ## Three states, not two
   *
   * The closed vocabulary is `settled` / `still-open` / `unknown`, not a boolean
   * derived from `attentionGoalOpen`. A `still-open` reference is one Core
   * recognises that has not yet reached a terminal state. A `settled` reference
   * is one that has — and is true whether the underlying mission or work run
   * succeeded, failed, or was cancelled. An `unknown` reference is one Core
   * has no projection of at all.
   *
   * The old shape returned `holds: !stillOpen` for everything, which is
   * `settled` + `unknown` collapsed into one bucket. `unknown` had to mean
   * `settled` because the old doc argued "nothing is known to still be running
   * is the true statement", but that argument is about *the absence of a known
   * open thing*, not about a *settled* thing — a missing reference is
   * unverifiable, not verified, and treating it as settled burns a retry for no
   * reason and hides the real bug. The new shape separates the two.
   *
   * ## `holds` is about the claim, not the outcome
   *
   * `holds: true` means the wake's claim ("the reference has reached a
   * terminal state") is verified by an authoritative source. It is **not** a
   * statement that the mission succeeded. The verify port answers a question
   * about the loop's wake, not about a user's task, and a reader who wants to
   * know whether the mission succeeded reads Core's own mission projection,
   * not this port's return.
   */
  private async lifeLoopVerify(
    request: Parameters<LifeLoopPorts['verify']>[0],
  ): Promise<{ readonly holds: boolean; readonly outcome: 'settled' | 'still-open' | 'unknown'; readonly code: string }> {
    if (request.kind === 'escalation-delivered') {
      // Attention records every decision it makes, including the ones that say
      // nothing should reach the owner. The claim being verified is "Attention
      // considered it", and that is answered by a decision existing — not by the
      // decision being loud, because being loud was never the loop's to decide.
      // This branch keeps the old two-value shape: Attention's answer is
      // binary (it decided or it didn't), and "unknown" is not a third state
      // for an in-process recorder that simply says "no decision has been
      // recorded yet". A reader who needs the binary can read `holds`; a
      // reader who needs "we did not even try" can read `outcome`.
      const decisions = this.state.attention.decisions
      const hasDecision = decisions.length > 0
      return {
        holds: hasDecision,
        outcome: hasDecision ? 'settled' : 'still-open',
        code: hasDecision ? 'attention-decided' : 'attention-decided-nothing',
      }
    }
    return this.classifyReference(request.reference)
  }

  /**
   * Map a reference to its three-state verification verdict.
   *
   * The lookup is direct against Core's own projections — `missionEngine.record`
   * for missions, `workEngine.snapshot().runs` for runs — and the verdict is
   * derived from the projection's status, not from a flag we maintain. The
   * only way a future code path can return a wrong verdict is by writing the
   * wrong status into one of those two projections, and that is a single
   * change to read.
   */
  private classifyReference(reference: string): {
    readonly holds: boolean
    readonly outcome: 'settled' | 'still-open' | 'unknown'
    readonly code: string
  } {
    // A Mission is "open" against this port when it exists in the engine's
    // projections and is not yet in a terminal state. The engine exposes
    // `record(id)` which returns the projection or `undefined` if the mission
    // is not in the engine's view.
    const mission = this.missionEngine?.record(reference)
    if (mission !== undefined) {
      if (isTerminalMissionStatus(mission.status)) {
        // The terminal status is in the code, so a journal reader can tell
        // success from failure from the verify port's record alone. The port
        // itself still reports `outcome: 'settled'` because the verify port
        // does not adjudicate success.
        return { holds: true, outcome: 'settled', code: `mission-${mission.status}` }
      }
      return { holds: false, outcome: 'still-open', code: 'mission-still-open' }
    }
    // A Work Run is "open" the same way. `snapshot().runs` is the authoritative
    // map for the run, indexed by run id; the goal ref *is* the run id for
    // runs that originated as a wake's reference.
    const snapshot = this.workEngine?.snapshot()
    if (snapshot !== undefined) {
      const run = snapshot.runs.get(reference)
      if (run !== undefined) {
        if (isTerminalRunStatus(run.status)) {
          return { holds: true, outcome: 'settled', code: `run-${run.status}` }
        }
        return { holds: false, outcome: 'still-open', code: 'run-still-open' }
      }
    }
    // A reference Core has no projection of at all. The old code reported
    // `holds: true` for this case ("nothing is known to still be running"),
    // which is the source of the conflation the brief is fixing: a missing
    // reference is *unverifiable*, and retrying is futile until the
    // reference is registered with one of the engines. Burning a retry for
    // no reason and writing `reference-settled` to the journal is exactly
    // the false-success the C2-A inventory entry warned about.
    return { holds: false, outcome: 'unknown', code: 'reference-unknown' }
  }

  /**
   * Ask Attention to consider something. It decides, not this loop.
   *
   * Two authorities over one human's attention is how a system ends up interrupting
   * somebody twice, so the loop's role here is to *ask* and Attention's role is to
   * answer with its own budget, cooldown and focus rule. The text is a fixed
   * sentence this code wrote — never anything a model returned — and the source is
   * the wake's own domain, so the loop cannot borrow the `system` source's higher
   * importance cap to make itself louder.
   *
   * Returns whether Attention escalated or suppressed, which is what the loop
   * records as `attentionSuppressed`. It has no way to make Attention do either.
   */
  private async lifeLoopRaise(
    escalation: Parameters<LifeLoopPorts['raiseEscalation']>[0],
  ): Promise<'escalated' | 'suppressed'> {
    if (this.attentionEngine === undefined || this.options.lifeLoop?.observeSubsystemEvents !== true) {
      return 'suppressed'
    }
    const source = lifeLoopAttentionSource(escalation.kind)
    const result = await this.attentionEngine.ingestInternal(source, {
      kind: lifeLoopAttentionKind(escalation.kind),
      // A fixed sentence. The loop has no access to the model's words here, and that
      // is deliberate: Attention retains event text in process memory for an
      // explicit owner read, and it must never receive a model's prose to do it.
      text: lifeLoopAttentionText(escalation.kind),
      goalRef: escalation.goalRef,
      sourceRef: escalation.reference === null ? escalation.wakeKey : escalation.reference,
    })
    return result.ok && result.decision.outcome !== 'do-nothing' ? 'escalated' : 'suppressed'
  }

  /**
   * Deliver a Core-owned subsystem's terminal event to the life loop, when composed
   * on.
   *
   * Fire-and-forget, for the fabric's ordering rule: a subscriber must not `await`
   * an append or it waits behind itself. The source and the kind are chosen here
   * from the event's *type* — never read from a payload — and the actor is
   * `core-subsystem`, which is the only actor the closed registry accepts for a
   * mission or work transition. A renderer cannot reach this method, and even if a
   * payload claimed to be one of these kinds the pairing table would refuse it.
   *
   * `mission-activated` and `run-started` are here on purpose even though the filter
   * will deterministically refuse them a thought: they are the four cases a
   * plausible implementation would get wrong by treating "something happened" as
   * "Freya should think about it", and having them actually arrive is what makes
   * the refusal observable rather than theoretical.
   */
  private observeLifeLoopSource(event: AnyCoreEvent): void {
    if (this.lifeLoopRuntime === undefined) return
    if (this.options.lifeLoop?.observeSubsystemEvents !== true) return
    const request = lifeLoopWakeFor(event)
    if (request === null) return
    this.raiseLifeLoopWake(request)
  }

  /** Enqueue a wake. Never awaited, and never allowed to reject into the fabric. */
  private raiseLifeLoopWake(request: LifeLoopWakeRequest): void {
    const runtime = this.lifeLoopRuntime
    if (runtime === undefined) return
    void runtime.considerWake(request).catch((error: unknown) => {
      // The runtime already records a thrown step as an anomaly and reconciles
      // itself; this is the outer belt for a bug in the wiring rather than in the
      // loop, and it must never propagate into a fabric subscriber.
      console.error('[freya.core] life loop wake failed', error)
    })
  }

  /**
   * Core's account of the life loop. Never null, and it never throws.
   */
  lifeLoop(): LifeLoopProjection {
    if (this.lifeLoopRuntime === undefined || this.fabric === undefined) {
      return { ...ABSENT_LIFE_LOOP_PROJECTION, reason: NO_LIFE_LOOP_DOMAIN_REASON }
    }
    return this.lifeLoopProjection(this.lifeLoopSnapshot())
  }

  onLifeLoop(listener: (projection: LifeLoopProjection) => void): () => void {
    this.lifeLoopListeners.add(listener)
    // Delivered immediately, like every subscription here, so a window that
    // attaches late agrees with one that never left.
    try {
      listener(this.lifeLoop())
    } catch (error) {
      console.error('[freya.core] Life Loop subscriber threw', error)
    }
    return () => {
      this.lifeLoopListeners.delete(listener)
    }
  }

  private lifeLoopSnapshot(): LifeLoopSnapshot | null {
    return this.lifeLoopRuntime?.snapshot() ?? null
  }

  private lifeLoopProjection(snapshot: LifeLoopSnapshot | null): LifeLoopProjection {
    if (snapshot === null || this.fabric === undefined) {
      return { ...ABSENT_LIFE_LOOP_PROJECTION, reason: NO_LIFE_LOOP_DOMAIN_REASON }
    }
    try {
      const projected = projectLifeLoop({
        sequence: this.fabric.lastSequence,
        snapshot,
        now: this.lifeLoopNow().toISOString(),
      })
      // Degradation is layered *on top of* the real reading rather than replacing it.
      // A stopped Freya is still idle, still holds the wake it was refused and still
      // has a state a surface can name; substituting the absent projection here would
      // report every one of those as zero, and "nothing is known" and "nothing is
      // happening" are exactly the two claims a stopped system must not blur.
      if (this.state.stopAll.active || this.gateway?.gateStatus().open === false) {
        return {
          ...projected,
          health: 'degraded',
          reason: 'Freya is stopped, so the life loop is holding rather than thinking',
        }
      }
      return projected
    } catch (error) {
      // A projection that threw would leave the surface with nothing at all in
      // exactly the moment something was already wrong, so a read that cannot be
      // built becomes a stated degradation instead.
      return {
        ...ABSENT_LIFE_LOOP_PROJECTION,
        health: 'degraded',
        reason: `the life loop could not be read: ${describe(error)}`,
      }
    }
  }

  private publishLifeLoop(): void {
    if (this.lifeLoopListeners.size === 0) return
    const projection = this.lifeLoop()
    for (const listener of [...this.lifeLoopListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Life Loop listener threw', error)
        this.lifeLoopListeners.delete(listener)
      }
    }
  }

  private requireFoundry(): FoundryEngine {
    if (this.foundryEngine === undefined) {
      throw new Error('the Foundry engine is not available')
    }
    return this.foundryEngine
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
   * Deliver a connector's signal to attention through the authorized Phase 12
   * seam.
   *
   * The text is a fixed sentence Core wrote ??? never anything a connector
   * returned. The source is `system`, a Core-owned source, and the attention
   * engine still decides what the signal is worth: this delivery cannot mint an
   * importance, an urgency or an outcome. There is no new surveillance
   * authority here; the only thing that crosses is *that* a connector reported
   * something, and how many items were involved.
   */
  private observeRelaySignal(command: string, result: { readonly kind: 'read'; readonly result: RelayReadResult }): void {
    if (this.attentionEngine === undefined || this.options.attentionObserveSources !== true) return
    switch (result.result.kind) {
      case 'email.messages': {
        const count = result.result.messages.length
        if (count === 0) return
        void this.attentionEngine.ingestInternal('system', {
          kind: 'message',
          text: 'The email connector reported new mail.',
          sourceRef: `relay-email-${count}`,
          severityHint: 'none',
        })
        break
      }
      case 'calendar.events': {
        const count = result.result.events.length
        if (count === 0) return
        void this.attentionEngine.ingestInternal('system', {
          kind: 'calendar',
          text: 'The calendar connector reported upcoming events.',
          sourceRef: `relay-calendar-${count}`,
          severityHint: 'none',
        })
        break
      }
      default:
        break
    }
    void command
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
   * Authoritative production performance observation and regression monitoring.
   * Wires Metacognition & Evolution directly to real Mission lifecycle events (P1 Findings 3 & 5).
   */
  private async observeAuthoritativeMission(event: AnyCoreEvent): Promise<void> {
    if (this.metacognitionEngine === undefined) return
    const p = event.payload as Record<string, unknown>
    const missionId = typeof p.missionId === 'string' ? p.missionId : null
    if (!missionId) return

    // Concurrent deliveries and persisted replays must not double-count a mission.
    if (this.observedMissions.has(missionId) || this.observingMissions.has(missionId)) return
    this.observingMissions.add(missionId)
    try {
      const mission = this.missionEngine?.record(missionId)
      // Do not derive observations for fabricated/nonexistent mission IDs.
      if (!mission) return
      const isCompleted = event.type === 'mission.completed'
      const verified = isCompleted && mission.verification?.state === 'passed'

      let durationMs: number | null = null
      const startTimeStr = mission.activatedAt ?? mission.createdAt
      if (startTimeStr) {
        const end = mission.settledAt ? Date.parse(mission.settledAt) : Date.parse(event.occurredAt)
        const start = Date.parse(startTimeStr)
        if (Number.isFinite(start) && Number.isFinite(end)) durationMs = Math.max(0, end - start)
      }

      let actionAttempts = 0
      let toolErrors = 0
      let hasResearchStep = false
      const snapshot = this.workEngine?.snapshot()
      for (const runId of mission.childRuns ?? []) {
        for (const stepId of snapshot?.runSteps.get(runId) ?? []) {
          actionAttempts++
          const step = snapshot?.steps.get(stepId)
          if (step?.status === 'failed') toolErrors++
          if (step?.capability?.startsWith('research')) hasResearchStep = true
        }
      }

      // Provenance comes from evidence saved by the actual Work executor.
      // Merely having an active strategy does NOT prove that a mission used it.
      const content = await this.missionEngine?.privateContent(missionId, true)
      const evidenceEntries = Object.values(content?.researchEvidence ?? {})
      const usedVersions = evidenceEntries
        .map((entry) => entry.strategyUsed)
        .filter((entry): entry is { readonly id: string; readonly version: string } =>
          typeof entry?.id === 'string' && typeof entry?.version === 'string',
        )
      const strategyUsed = usedVersions.length > 0 && usedVersions.length === evidenceEntries.length && usedVersions.every(
        (entry) => entry.id === usedVersions[0]?.id && entry.version === usedVersions[0]?.version,
      ) ? usedVersions[0] : null

      const rawErrorMessage = typeof p.reason === 'string' ? p.reason : (mission.reason ?? null)
      await this.metacognitionEngine!.observeMission({
        missionId,
        runId: mission.childRuns[0],
        taskType: hasResearchStep ? 'research' : 'general',
        strategyId: strategyUsed?.id ?? null,
        strategyVersion: strategyUsed?.version ?? null,
        outcome: isCompleted ? (verified ? 'success' : 'partial') : 'failure',
        verified,
        verificationReason:
          mission.verification?.reason ?? (isCompleted ? 'Mission completed without recorded verification reason' : rawErrorMessage),
        actionAttempts,
        toolErrors,
        durationMs,
        modelTokens: null,
        modelCalls: null,
        externalRequests: null,
        rawErrorMessage,
      })
      this.observedMissions.add(missionId)

      if (strategyUsed && this.strategyLifecycle) {
        const telemetries = await this.metacognitionEngine!.getTelemetries()
        await this.strategyLifecycle.monitorAndEvaluateRegression(telemetries)
      }
    } finally {
      this.observingMissions.delete(missionId)
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
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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
    if (this.chatMissions) this.conversations?.publish()
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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

  async goalDetail(goalId: string): Promise<GoalDetail | null> {
    if (this.goalEngine === undefined) return null
    return await this.goalEngine.detail(goalId)
  }

  async proposeGoalRoadmap(
    goalId: string,
    options: DecompositionOptions = {},
  ): Promise<RoadmapValidationResult> {
    if (this.goalEngine === undefined) return { ok: false, reason: 'goal engine unavailable' }
    const detail = await this.goalEngine.detail(goalId)
    if (!detail || !detail.content) return { ok: false, reason: 'goal content unavailable' }

    let advisoryLessons: AdvisoryLessonInput[] | undefined
    if (this.learningEngine) {
      const recalled = recallRelevantLearning(this.learningEngine, {
        capabilities: ['work.execute', 'mission.manage'],
        goal: `${detail.content.title} ${detail.content.description}`,
      })
      advisoryLessons = recalled.lessons.map((l) => ({
        recordId: l.recordId,
        claim: l.text,
        confidence: l.confidence,
        sourceDomain: l.scope,
      }))
    }

    return this.goalEngine.getPlanner().proposeRoadmap(
      detail.content,
      detail.roadmap ?? undefined,
      { advisoryLessons, ...options },
    )
  }

  async elaborateMilestoneMission(
    goalId: string,
    milestoneId?: string,
  ): Promise<BoundedMissionProposal | null> {
    if (this.goalEngine === undefined) return null
    const detail = await this.goalEngine.detail(goalId)
    if (!detail || !detail.content || !detail.roadmap) return null

    const targetMilestone: GoalMilestone | null = milestoneId
      ? (detail.roadmap.milestones.find((m) => m.milestoneId === milestoneId) ?? null)
      : await this.goalEngine.getPlanner().nextEligibleMilestone(detail.roadmap)

    if (!targetMilestone) return null
    return this.goalEngine.getPlanner().createMissionForMilestone(targetMilestone, detail.content)
  }

  async setGoalBudget(goalId: string, budgetInput: Partial<GoalBudgetPolicy>): Promise<GoalCommandOutcome> {
    if (this.state.stopAll.active) return { operation: 'budget-updated', ok: false, reason: 'STOP ALL is active' }
    if (this.goalEngine === undefined) return { operation: 'budget-updated', ok: false, reason: 'goal engine unavailable' }

    const validated = validateGoalBudget(budgetInput)
    if (!validated.ok) return { operation: 'budget-updated', ok: false, reason: validated.reason }

    const store = this.goalStore
    if (store === undefined) return { operation: 'budget-updated', ok: false, reason: 'goal store unavailable' }
    const read = await store.read(goalId)
    if (!read.ok) return { operation: 'budget-updated', ok: false, reason: read.reason }

    const currentSpend = read.value.spend ?? { ...ZERO_GOAL_SPEND }
    const updatedContent: GoalContent = {
      ...read.value,
      budget: validated.value,
      spend: currentSpend,
    }

    try {
      await store.write(updatedContent)
      await this.goalEngine.updateContent(updatedContent)
    } catch (error) {
      return { operation: 'budget-updated', ok: false, reason: error instanceof Error ? error.message : String(error) }
    }

    const exhaustion = checkBudgetExhaustion(validated.value, currentSpend)
    if (exhaustion.exhausted) {
      await this.goalEngine.pauseGoal(goalId, GOAL_REASONS.budget_exhausted)
    }

    this.publishGoals()
    return {
      operation: 'budget-updated',
      ok: true,
      goalId,
      budgetExhausted: exhaustion.exhausted,
    }
  }

  async recordGoalSpend(goalId: string, incremental: Partial<GoalSpend>): Promise<GoalCommandOutcome> {
    if (this.goalEngine === undefined) return { operation: 'refused', ok: false, reason: 'goal engine unavailable' }
    return await this.goalEngine.recordSpend(goalId, incremental)
  }

  deriveMilestoneMissionBudget(goalId: string, requested?: Partial<MissionBudget>): MissionBudgetDerivationResult {
    if (this.goalEngine === undefined) return { ok: false, reason: 'goal engine unavailable' }
    return this.goalEngine.deriveMissionBudget(goalId, requested)
  }

  async handleContinuationWake(wake: ContinuationWake): Promise<ContinuationDecisionOutcome> {
    if (this.continuationEngine === undefined) {
      return {
        decision: {
          decision: 'wait',
          reason: 'continuation engine unavailable',
          deadline: (this.options.now?.() ?? new Date()).toISOString(),
        },
        goalId: wake.goalId,
      }
    }
    return await this.continuationEngine.handleWake(wake)
  }

  async ingestObservation(input: RawObservationInput): Promise<ObservationIngestResult> {
    if (this.proactiveEngine === undefined) {
      return { ok: false, reason: 'proactive engine unavailable' }
    }
    return this.proactiveEngine.ingest(input)
  }

  async subscribeObservationSource(input: ObservationSubscriptionInput): Promise<ObservationSubscription> {
    if (this.proactiveEngine === undefined) {
      throw new Error('proactive engine unavailable')
    }
    return this.proactiveEngine.subscribe(input)
  }

  async revokeObservationSource(subscriptionId: string): Promise<boolean> {
    if (this.proactiveEngine === undefined) {
      return false
    }
    return this.proactiveEngine.revoke(subscriptionId)
  }

  observationSubscriptions(): readonly ObservationSubscription[] {
    return this.proactiveEngine?.subscriptions() ?? []
  }

  recentObservations(limit?: number): readonly NormalizedObservation[] {
    return this.proactiveEngine?.recentObservations(limit) ?? []
  }

  metacognition(): MetacognitionEngine | undefined {
    return this.metacognitionEngine
  }

  evolution(): ReturnType<Core['evolution']> {
    const lifecycle = this.strategyLifecycle
    if (!lifecycle) return undefined
    // Return data snapshots, NOT the manager instance or its mutable internal records.
    return Object.freeze({
      getActiveStrategy: (scope?: string) => {
        const active = lifecycle.getActiveStrategy(scope)
        return active ? structuredClone(active) : null
      },
      getPromotionHistory: () => structuredClone(lifecycle.getPromotionHistory()),
      getRollbackHistory: () => structuredClone(lifecycle.getRollbackHistory()),
    })
  }

  evolutionStore(): ReturnType<Core['evolutionStore']> {
    const store = this.evolutionStoreInstance
    if (!store) return undefined
    return Object.freeze({
      get mode() { return store.mode },
      get durable() { return store.durable },
      get faultReason() { return store.faultReason },
      readCandidates: async () => structuredClone(await store.readCandidates()),
      getCandidate: async (id: string) => {
        const candidate = await store.getCandidate(id)
        return candidate ? structuredClone(candidate) : null
      },
    })
  }

  /**
   * Internal test seam, deliberately absent from Core's public interface.
   * The production surface exposes ONLY the read-only evolution views above.
   */
  issueEvolutionInternals(): { lifecycle: StrategyLifecycleManager | undefined; store: EvolutionStore | undefined } {
    return { lifecycle: this.strategyLifecycle, store: this.evolutionStoreInstance }
  }

  goals(): GoalProjectionView {
    if (this.goalEngine === undefined) {
      return {
        ...ABSENT_GOAL_PROJECTION,
        persistence: { mode: 'ephemeral', durable: false, reason: 'Goals are not available' },
      }
    }
    return this.goalEngine.projection()
  }

  onGoals(listener: (projection: GoalProjectionView) => void): () => void {
    this.goalListeners.add(listener)
    listener(this.goals())
    return () => {
      this.goalListeners.delete(listener)
    }
  }

  private publishGoals(): void {
    this.publishConsciousness()
    if (this.goalListeners.size === 0) return
    const projection = this.goals()
    for (const listener of [...this.goalListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] Goal listener threw', describe(error))
        this.goalListeners.delete(listener)
      }
    }
  }

  private requireGoal(): GoalEngine | ProcessGoals {
    if (this.goalEngine === undefined) {
      throw new Error('the Goal engine is not available')
    }
    return this.goalEngine
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
    // Every subsystem that can move the snapshot does, through this one call.
    // The conscious context is derived from all of them, so a change to any one
    // is a change to it - and hooking each publisher is what keeps that true
    // without adding an event type a subsystem could forget to append.
    this.publishConsciousness()
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

  private requireMission(): MissionRuntime {
    if (this.missionEngine === undefined) {
      throw new Error('the Mission engine is not available')
    }
    return this.missionEngine
  }

  /* ------------------------------------------- Phase 47: the autonomy wiring */

  /**
   * The Mission writer, as the runtime sees it.
   *
   * Every method is the engine's own, forwarded — the runtime gets no wider a surface
   * here than the engine already had. In particular there is no `openApproval`,
   * `decideApproval` or `expireApproval` on this port: the engine no longer has those
   * methods, because a Mission does not own approvals. Work's Guard opens gates and a
   * person closes them through `work.approval.decide`, which is the only door in the
   * codebase where an approval can become `approved`.
   */
  private missionAutonomyPort(): MissionEnginePort {
    const engine = this.missionEngine as MissionRuntime
    return {
      record: (missionId) => engine.record(missionId),
      commitPlan: (input) => engine.commitPlan(input),
      transitionStep: (input) => engine.transitionStep(input),
      interruptStep: (input) => engine.interruptStep(input),
      recordEvidence: (input) => engine.recordEvidence(input),
      setBlocker: (input) => engine.setBlocker(input),
      noteApprovalRequested: (input) => engine.noteApprovalRequested(input),
      noteApprovalOutcome: (input) => engine.noteApprovalOutcome(input),
      transition: (input) => engine.autonomyTransition(input),
      setRequestedQuantity: (input) => engine.setRequestedQuantity(input),
      recordCorrection: (input) => engine.recordCorrection(input),
      recordAmbiguity: (input) => engine.recordAmbiguity(input),
      scheduleWake: (input) => engine.scheduleWake(input),
      fireWake: (input) => engine.fireWake(input),
      recordDecision: (input) => engine.recordDecision(input),
      charge: (input) => engine.charge(input),
      noteBudgetExceeded: (input) => engine.noteBudgetExceeded(input),
      requestCompletion: (missionId, options) => this.completeMission(missionId, options),
      writeIntent: (missionId, intent) => engine.writeIntent(missionId, intent),
      readIntent: (missionId) => engine.readIntent(missionId),
    }
  }

  /**
   * What the planner may plan with: Core's own registry, read-only.
   *
   * There is no `register` reachable from here, so a planner cannot widen the set of
   * things Freya can do — "the plan asked for a capability nobody registered" is a
   * blocked step, not a new capability.
   *
   * `requiresApproval` is read from the **registered capability**, not from the step. That
   * is the whole point of reading the registry rather than the plan: the plan may make a
   * step *more* gated, never less, and a planner that could state its own risk for a
   * capability would be able to talk Guard out of a gate.
   */
  private missionCapabilityPort(): MissionCapabilityPort {
    return {
      lookup: (capability) => {
        const found = this.workRegistry?.capability(capability)
        if (found === undefined) return null
        return {
          risk: found.risk,
          requiresApproval: found.risk === 'consequential',
          // The capability's **own declared pairing**, or null. Not resolved to a default:
          // a planner that cannot pair these honestly must leave the capability out, and a
          // silent fallback would hand it `test.always-fails` and retry forever.
          verifier: found.verifier ?? null,
        }
      },
      verifiers: () => this.workRegistry?.verifierNames() ?? [],
      known: () => this.workRegistry?.names() ?? [],
    }
  }

  /**
   * Which capabilities a plan may name.
   *
   * **Two gates, both needed.** *Surface availability*: a capability whose surface is not
   * mounted must not be planned, or the model picks it because the goal called for it and the
   * Mission commits a plan it can never run. *Live authority*: `missionAuthorityPort`'s
   * `mayUse` re-binds the registered action to Guard authority for the owner principal right
   * now, so a capability authorised at boot and not authorised now is refused now.
   *
   * **The list is closed, not a prefix.** `name.startsWith('browser.')` would be one edit
   * from admitting anything later added to Work under that namespace — including one that
   * acts rather than reads — and nobody would notice that review. The set is imported from
   * the module that registers the capabilities, so registration and the planner cannot
   * disagree.
   *
   * **Non-chat Missions are unchanged**: they may plan any registered capability Guard allows.
   * This narrowing is only for a Mission bound to a conversation, where the owner approved a
   * specific scope in a specific conversation and nothing outside it was authorised.
   */
  /**
   * The eight facts about a Mission that only Core can answer, for the browser wiring.
   *
   * Every one is a live read at the moment it is asked — `privateContent` goes to the
   * encrypted store, `record` is the folded Mission, `charge` writes a budget event — so a
   * Mission that stopped, was paused, lost its grant or ran out of budget is refused when it
   * tries to spend, not when it started.
   *
   * `missionBrowserEvidence` returns `null` for a Mission with no conversation binding,
   * which is the same refusal `registerResearchInspection`'s admission makes: without an
   * owner-approved scope there is nothing an external request is being spent against.
   */
  private missionBrowserContext(): MissionBrowserContext {
    return {
      runMissionId: runId => this.workEngine?.snapshot().runs.get(runId)?.parentId ?? null,
      missionStatus: missionId => this.missionEngine?.record(missionId)?.status ?? null,
      missionBrowserEvidence: async (missionId, requireDurable) => {
        const content = await this.missionEngine?.privateContent(missionId, requireDurable)
        return content?.chatBinding === undefined ? null : { browserEvidence: content.browserEvidence }
      },
      missionOwnsRun: (missionId, runId) => this.missionEngine?.record(missionId)?.childRuns.includes(runId) === true,
      missionHasBrowserStep: (missionId, stepId) =>
        this.missionEngine?.record(missionId)?.activePlan?.steps
          .some(step => step.stepId === stepId && BROWSER_MISSION_CAPABILITIES.has(step.capability)) === true,
      missionMaySpendExternally: async missionId => {
        const content = await this.missionEngine?.privateContent(missionId, false)
        return content?.chatBinding !== undefined && content.chatBinding.paused === false &&
          this.chatResearchAvailable() && await this.chatMissionAuthorized(missionId)
      },
      chargeMissionExternalRequest: async missionId =>
        (await this.requireMission().charge({ missionId, modelCalls: 0, actions: 0, externalRequests: 1, retries: 0, delegations: 0 })).ok,
      saveMissionBrowserEvidence: async (missionId, stepId, evidence) =>
        this.requireMission().updateChatContent(missionId, content => ({
          ...content, browserEvidence: { ...content.browserEvidence, [stepId]: evidence },
        })),
    }
  }

  private mayPlanChatCapability(name: string, isChatMission: boolean): boolean {
    if (isChatMission && name !== 'research.search'
      && !(BROWSER_MISSION_CAPABILITIES.has(name) && this.dualBrowser !== null)) return false
    return this.missionAuthorityPort().mayUse(name)
  }

  /**
   * The authority gate's view of the world.
   *
   * Three reads and no grants. There is no `requestApproval` here, and there is no method
   * anywhere on this port, the engine or the runtime that can open, approve or expire a
   * gate — the only one is `work.approval.decide`, behind a Guard evaluation of the owner.
   *
   * `maySpend` returns false unconditionally, written as a call rather than a comment so a
   * test can assert it is consulted and a future grant cannot make it true without someone
   * editing this line in review.
   *
   * `approvalState` is a **read** of Work's own `ApprovalRecord`, resolved from the step's
   * durable `runId` so the gate matched is the one that Run opened. There is deliberately
   * no branch here that could turn an `expired` gate into `approved`, and an approval
   * status Core does not recognise is reported as unsettled rather than resolved in the
   * Mission's favour.
   */
  private missionAuthorityPort(): MissionAuthorityPort {
    return {
      stopAll: () => this.state.stopAll.active,
      // Bind the registered action to current Guard authority. Work checks again.
      mayUse: (capability) => {
        const binding = this.workRegistry?.capability(capability)
        return binding !== undefined && this.guard.evaluate(this.owner, binding.capability).allowed
      },
      maySpend: () => false,
      approvalState: async ({ runId }) => {
        // Resolved from the `runId` the executor returned, **not** from the step record.
        //
        // The step cannot carry it yet: writing an id needs a step transition, and a step
        // that is `running` cannot transition to `running`. So the runtime — the only
        // party that saw the executor's answer — carries it here, and this matches the
        // gate to the exact Run that opened it. Looking it up by step name instead would
        // let two Runs of one Mission be confused for each other.
        if (runId === null) return { ok: true as const, state: { kind: 'none' as const } }
        const work = this.workEngine
        if (work === undefined) return { ok: false as const, reason: 'Work is not available' }
        const approvals = work.snapshot().approvals
        let found: string | null = null
        for (const [approvalId, approval] of approvals) {
          if (approval.runId !== runId) continue
          // The *open* gate for this Run. A settled one is reported through the same
          // lookup below so the Mission learns how it went; picking the open one first
          // means a Run that somehow holds two gates waits on the real one.
          if (approval.status === 'pending') {
            found = approvalId
            break
          }
          if (found === null) found = approvalId
        }
        if (found === null) return { ok: true as const, state: { kind: 'none' as const } }
        const approval = approvals.get(found)
        if (approval === undefined) return { ok: true as const, state: { kind: 'none' as const } }
        if (approval.status === 'pending') {
          return {
            ok: true as const,
            state: { kind: 'open' as const, approvalId: found, requestedAt: approval.requestedAt },
          }
        }
        if (
          approval.status !== 'approved' &&
          approval.status !== 'denied' &&
          approval.status !== 'expired' &&
          approval.status !== 'cancelled'
        ) {
          return { ok: true as const, state: { kind: 'none' as const } }
        }
        return {
          ok: true as const,
state: {
              kind: 'settled' as const,
              approvalId: found,
              outcome: approval.status,
              decidedAt: approval.decidedAt,
              requestedAt: approval.requestedAt,
            },
        }
      },
    }
  }

  /**
   * How many Missions are live.
   *
   * Read for the swarm guard in `decide`, which holds back the last concurrency slot
   * whenever this is above one. It only ever makes the system more cautious: there is no
   * path by which a larger count causes more work.
   */
  private liveMissionCount(): number {
    const projection = this.missionEngine?.projection()
    if (projection === undefined) return 0
    return projection.missions.filter((mission) => {
      return mission.status === 'ready' || mission.status === 'planning' || mission.status === 'active'
    }).length
  }

  /**
   * Mark a Mission's goal as ready to be planned.
   *
   * `draft → active` is Phase 7's legacy edge and deliberately **skips planning**: it is the
   * door for a Mission a person is driving by hand. The autonomy loop starts from `ready`,
   * so this is how a person hands a Mission over to it — one explicit command, rather than
   * the loop quietly re-planning anything already active.
   */
  async readyMission(missionId: string): Promise<MissionCommandOutcome | null> {
    if (this.missionEngine === undefined) return null
    return await this.missionEngine.markGoalReady(missionId)
  }

  /** Trusted host entry: an existing owner grant authorizes one model proposal. */
  async planMissionGoal(input: MissionGoalRequest, revision = false): Promise<MissionGoalOutcome> {
    return this.planChatMissionGoal(input, revision || input.revision === true)
  }

  private chatResearchAvailable(): boolean {
    return chatResearchAvailable({
      researchPresent: !!this.researchIntegration,
      operational: this.operational,
      stopped: this.stopped,
      durable: this.persistence.durable,
      stopAllActive: this.state.stopAll.active,
      conversationEncrypted: this.conversationStore.mode === 'encrypted',
      holdsOwnerCapability: capability => this.guard.evaluate(this.owner, capability).allowed,
    })
  }

  private async chatMissionAuthorized(id: string): Promise<boolean> {
    return chatMissionAuthorized(id, this.chatMissionGrantEnvironment())
  }

  /** The per-Mission authorization facts, read live at every question. */
  private chatMissionGrantEnvironment(): ChatMissionGrantEnvironment {
    return {
      ownerId: this.owner.id,
      grants: () => this.ownerAuthority.grants(),
      now: () => (this.options.now ?? (() => new Date()))(),
      bindingFor: async missionId => (await this.missionEngine?.privateContent(missionId, true))?.chatBinding ?? null,
    }
  }

  private async completeMission(id: string, options?: { verifierId?: string; requiredRunIds?: readonly string[] }): Promise<MissionCommandOutcome> {
    const content = await this.requireMission().privateContent(id)
    return content?.chatBinding && this.chatMissions ? this.chatMissions.complete(id) : this.requireMission().requestCompletion(id, options)
  }

  private async planChatMissionGoal(input: MissionGoalRequest, revision: boolean): Promise<MissionGoalOutcome> {
    const engine = this.missionEngine
    const unavailable = { ok: false, reason: 'mission_unavailable' } as const
    if (!engine || !this.operational || this.stopped || !this.persistence.durable || this.state.stopAll.active || this.missionPlanning.has(input.missionId)
      || this.missionAdvancing.has(input.missionId) || !this.guard.evaluate(this.owner, 'mission.manage').allowed) return unavailable
    const mission = engine.record(input.missionId)
    if (!mission || (revision ? !mission.activePlan || mission.status !== 'blocked' || mission.planRevisions !== 1 : !!mission.activePlan || !['draft', 'ready'].includes(mission.status))) return unavailable
    const content = await engine.privateContent(input.missionId, true)
    if (!content || (revision ? !content.executionPlan : !!content.executionPlan) || this.missionPlanning.has(input.missionId)) return unavailable
    if (content.chatBinding && (!this.chatResearchAvailable() || !await this.chatMissionAuthorized(input.missionId) || content.chatBinding.paused)) return unavailable
    const now = (this.options.now ?? (() => new Date()))()
    const deadline = Math.min(Date.parse(mission.deadlineAt), Date.parse(mission.activatedAt ?? mission.createdAt) + mission.budget.maxDurationMs)
    if (now.getTime() >= deadline || mission.planRevisions >= mission.budget.maxPlanRevisions) return { ok: false, reason: 'budget_exhausted' }
    this.missionPlanning.add(input.missionId)
    try {
      if (mission.status === 'draft' && !(await engine.markGoalReady(input.missionId)).ok) return unavailable
      if (!(await engine.autonomyTransition({ missionId: input.missionId, to: 'planning', reason: 'plan_started' })).ok) return unavailable
      const charged = await engine.charge({ missionId: input.missionId, modelCalls: 1, actions: 0, externalRequests: 0, retries: 0, delegations: 0 })
      if (!charged.ok) {
        await engine.autonomyTransition({ missionId: input.missionId, to: 'blocked', reason: 'budget_exhausted' })
        return { ok: false, reason: 'budget_exhausted' }
      }
      const maxSteps = Math.min(mission.budget.maxStepsPerPlan - (revision ? mission.activePlan!.steps.filter(step => step.status === 'verified').length : 0), mission.budget.maxActions - mission.spend.actions,
        mission.budget.maxDelegations - mission.spend.delegations, mission.limits.maxChildRuns - mission.childRuns.length)
      const learningAdvice = this.learningEngine
        ? recallRelevantLearning(this.learningEngine, {
            capabilities: this.missionCapabilityPort().known(),
            goal: content.intent,
            failureContext: revision ? content.researchEvidence : undefined,
          })
        : undefined
      const outcome = await proposeMissionPlan({ ...input, goal: content.intent, successCriteria: content.successCriteria, budget: mission.budget, maxSteps, now,
        learningAdvice,
        ...(revision ? { previousPlan: mission.activePlan!, previousExecution: content.executionPlan, failure: content.researchEvidence } : {}) },
        this.missionCapabilityPort(), name => this.mayPlanChatCapability(name, content.chatBinding !== undefined), intent => this.ownerAuthority.request(intent))
      // Owner cancellation, correction and STOP ALL win over a delayed provider answer.
      const current = engine.record(input.missionId)
      const latest = await engine.privateContent(input.missionId)
      if (this.stopped || !this.persistence.durable || this.state.stopAll.active || current?.status !== 'planning' || (revision ? current.activePlan?.planId !== mission.activePlan?.planId : !!current.activePlan)
        || latest?.intent !== content.intent || !this.guard.evaluate(this.owner, 'mission.manage').allowed) return unavailable
      if (!outcome.ok) {
        await engine.setBlocker({ missionId: input.missionId, code: 'intent_ambiguous', stepId: null, raised: true })
        await engine.autonomyTransition({ missionId: input.missionId, to: 'blocked',
          reason: outcome.reason === 'capability_unavailable' ? 'capability_unavailable'
            : outcome.reason === 'budget_exhausted' ? 'budget_exhausted' : 'intent_ambiguous' })
        return outcome
      }
      if ((this.options.now ?? (() => new Date()))().getTime() >= deadline) {
        await engine.autonomyTransition({ missionId: input.missionId, to: 'blocked', reason: 'deadline_expired' })
        return { ok: false, reason: 'budget_exhausted' }
      }
      await engine.persistExecutionPlan(input.missionId, outcome.execution, content.intent, revision ? mission.activePlan!.planId : undefined)
      if (this.state.stopAll.active || engine.record(input.missionId)?.status !== 'planning') return unavailable
      const committed = await engine.commitPlan({ missionId: input.missionId, ...outcome.plan, reason: revision ? 'step_failed' : 'goal_needs_a_plan', expectedStatus: 'planning', ...(revision ? { expectedPreviousPlanId: mission.activePlan!.planId } : {}) })
      if (!committed.ok) return unavailable
      if (revision) for (const blocker of engine.record(input.missionId)?.blockers ?? []) {
        if (blocker.clearedAt === null && blocker.code === 'step_failed') await engine.setBlocker({ missionId: input.missionId, code: blocker.code, stepId: blocker.stepId, raised: false })
      }
      if (!(await engine.autonomyTransition({ missionId: input.missionId, to: 'active', reason: 'plan_committed' })).ok) return unavailable
      return outcome
    } catch {
      if (!this.state.stopAll.active && engine.record(input.missionId)?.status === 'planning') {
        await engine.autonomyTransition({ missionId: input.missionId, to: 'blocked', reason: 'intent_ambiguous' }).catch(() => undefined)
      }
      return { ok: false, reason: 'planning_failed' }
    } finally { this.missionPlanning.delete(input.missionId) }
  }

  private observeVerifiedMissionStep(event: AnyCoreEvent): void {
    if (event.type !== 'mission.step.transitioned' || !['verified', 'failed'].includes(event.payload.to)) return
    const { missionId, planId, stepId } = event.payload
    // Publication happens inside the current decision. Wait for its final transition,
    // then use live state; never replay events, queue retries, or call a model here.
    const pending = this.missionAdvancing.get(missionId) ?? Promise.resolve(null)
    void pending.then(async () => {
      const content = await this.missionEngine?.privateContent(missionId)
      const mission = this.missionEngine?.record(missionId)
      if (content?.chatBinding) {
        if (mission?.activePlan?.planId !== planId || content.executionPlan?.planId !== planId) return
        await this.chatMissions?.settled(missionId)
        return
      }
      if (event.payload.to !== 'verified') return
      if (this.stopped || !this.persistence.durable || this.state.stopAll.active || mission?.status !== 'active' || mission.activePlan?.planId !== planId
        || !content?.executionPlan?.continueAfterVerification || content.executionPlan.planId !== planId
        || !mission.activePlan.steps.some(step => step.stepId === stepId && step.status === 'verified')) return
      await this.advanceMissionDecision(missionId, 'event', { type: event.type })
    }).catch(() => undefined)
  }

  private observeLearningSource(event: AnyCoreEvent): void {
    if (this.learningEngine === undefined) return
    if (event.type !== 'work.step.verified' && event.type !== 'work.step.failed') return
    const stepId = 'stepId' in event.payload && typeof event.payload.stepId === 'string' ? event.payload.stepId : null
    if (!stepId) return

    void (async () => {
      // Yield to let WorkEngine's event subscription finish updating its snapshot.
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        const workSnapshot = this.workEngine?.snapshot()
        if (!workSnapshot) return
        const step = workSnapshot.steps.get(stepId)
        if (!step) return
        const verification = [...workSnapshot.verifications.values()].find((v) => v.stepId === stepId) ?? null
        const run = workSnapshot.runs.get(step.runId)
        const missionId = run?.parentId
        const missionContent = missionId ? await this.missionEngine?.privateContent(missionId) : null
        const nowIso = (this.options.now ?? (() => new Date()))().toISOString()

        await admitWorkStepOutcome(this.learningEngine!, {
          step,
          verification,
          missionContent,
          nowIso,
        })
      } catch (error) {
        console.error('[freya.core] learning observation threw', describe(error))
      }
    })()
  }

  /**
   * Advance one Mission by one decision.
   *
   * The **single public door** to the autonomy loop. `trigger` is not optional and there is
   * no default of "tick": a caller says why it is asking, and that reason is journalled with
   * the decision.
   *
   * Each call makes one decision. Opted-in private plans also reach this same boundary
   * from a newly verified durable event. No timer or background model loop is involved.
   */
  async advanceMission(missionId: string, trigger: DecisionTrigger): Promise<StepOutcome | null> {
    return this.advanceMissionDecision(missionId, trigger, null)
  }

  private async advanceMissionDecision(missionId: string, trigger: DecisionTrigger, delivered: { type: string } | null): Promise<StepOutcome | null> {
    if (this.missionAutonomy === undefined || this.stopped) return null
    const content = await this.missionEngine?.privateContent(missionId)
    if (content?.chatBinding && (!this.chatResearchAvailable() || content.chatBinding.paused || !await this.chatMissionAuthorized(missionId))) return null
    if (this.missionAdvancing.has(missionId) || this.missionPlanning.has(missionId)) return null
    const mission = this.missionEngine?.record(missionId)
    // A failed intelligent planning attempt cannot drop into the legacy fixture planner.
    if (mission && mission.spend.modelCalls > 0 && mission.activePlan === null) return null
    const pending = this.missionAutonomy.step(missionId, trigger, delivered)
    this.missionAdvancing.set(missionId, pending)
    try {
      const outcome = await pending
      // Release assignments only once the mission settles.
      if (outcome !== null) await this.releaseMissionAssignments(missionId)
      return outcome
    } finally { this.missionAdvancing.delete(missionId) }
  }

  /**
   * Close the workforce assignments a Mission opened.
   *
   * ## When it runs, and why not only at the end
   *
   * Delegation opens one assignment per step and **nothing else closes them** until this
   * runs. `WorkforceEngine` settles an assignment when it expires, when the owner cancels it,
   * or when the workforce stops — and a Mission's steps complete long before any of those. So
   * without this, a worker holds three open assignments after three steps and the fourth
   * delegation is refused, which then blocks the Mission on `no_capable_worker`.
   *
   * That failure is invisible from outside: it looks exactly like "the roster has nobody
   * free", which is a legitimate answer to a different question. Which is why the closing is
   * done here, next to the thing that opened it, rather than left to a subsystem that has no
   * idea a Mission existed.
   *
   * It used to run only when the **Mission** was terminal, which is right for the last step
   * and wrong for every step before it: a six-step Mission blocked on its fourth delegation
   * with three verified steps already on the record, and reported `no_capable_worker` — a
   * claim about the roster that was simply false.
   *
   * Relaxing it to "any settled step" was tried and **reverted**, because closing an
   * assignment while its Mission is still running disturbs the step that is being executed
   * and the run stops completing (`tests/core/mind-missions-integration.test.ts` and
   * `tests/core/learning-integration.test.ts` both regressed to `active`/`blocked`). The
   * correct fix belongs in delegation — a settled step should *settle its own* assignment
   * rather than have a bulk closer cancel them all — and is not done here.
   *
   * The symptom to watch for, when that is done: a Mission with more steps than
   * `maxOpenAssignments` on its worker, blocking with `no_capable_worker` after exactly
   * `maxOpenAssignments` verified steps.
   *
   * ## Why it is safe to run early
   *
   * A step in `verified`, `failed`, `cancelled` or `skipped` is finished work whose
   * delegation is genuinely closed, whatever the Mission as a whole is still doing. A step
   * that is `pending`, `delegated` or `running` is in flight — and a Mission that has not yet
   * settled any step returns early, so those assignments are never touched. A person reading
   * the workforce therefore still sees exactly the work under way, and never sees a running
   * Mission's delegation look finished.
   *
   * ## Why cancelling the whole list is correct at that moment
   *
   * Assignments carry a `missionId` but not a `stepId`, so this closes every one of them.
   * That is sound because `advanceMissionDecision` is **serialised per Mission** and opens
   * the next step's assignment only after this has run — so at this instant the only open
   * assignments are ones whose step has already settled, and the next delegation creates a
   * fresh one. Per-step linkage would make this precise if the workforce stored it; until
   * then the serialisation is what makes the list mean what it looks like it means.
   *
   * ## Authoritative store, not a retention slice
   *
   * The Mission's own projection does not list every assignment; the workforce
   * projection does, but `WorkerView.assignments` is a *retention slice* and
   * the projection also exposes `assignmentsTotal` / `assignmentsHidden` to
   * say so. A Mission with more steps than the slice holds would have left
   * the missing ones open in the old code — a "leak" the board knew about
   * (the hidden count) but the closer did not. The C2-B fix reads the
   * authoritative store through `listAssignmentsForMission`, which the
   * engine exposes from its own `state.assignments` map; nothing in the
   * projection's slice can hide a row from the closer.
   *
   * ## Diagnostics, not silent swallow
   *
   * The old code did `await scope.cancelAssignment(...).catch(() => undefined)`.
   * That was the right shape to avoid turning a completed Mission into a
   * failed one — a refusal here is not a reason to invalidate the
   * Mission's outcome — but a refusal with **no log, no event, no count**
   * is not the same as "not failing", it is *unobservable* failing. The
   * new code logs a single warning per refused cancellation with the
   * assignment id, the mission id, the reason returned, and the running
   * counters of opened / closed / refused. The Mission's outcome stays
   * untouched, but a person reading the log can tell that cleanup is
   * incomplete and act on it.
   *
   * Cancellation is idempotent: `settleAssignment(id, 'cancelled', ...)`
   * already refuses a transition from a terminal status, and a re-issued
   * call is a no-op rather than a chain of follow-on errors. The caller
   * can invoke `releaseMissionAssignments` more than once and the second
   * call walks the same authoritative list and finds nothing left to do.
   */
  private async releaseMissionAssignments(missionId: string): Promise<void> {
    const workforce = this.workforceEngine
    if (workforce === undefined) return
    const projection = this.missionEngine?.record(missionId)
    if (projection === undefined) return
    if (!isTerminalMissionStatus(projection.status)) return

    const scope = workforce.ownerScope()
    // The authoritative list, not the projection's retention slice. The
    // engine reads its own `state.assignments` map and returns every row
    // tagged with this mission id, terminal or not, so a closed-form
    // filter is enough to drive the closer.
    const linked = scope.listAssignmentsForMission(missionId)
    let closed = 0
    let alreadyTerminal = 0
    let refused = 0
    for (const entry of linked) {
      if (isTerminalAssignmentStatus(entry.status)) {
        // Idempotency: a re-issue finds the assignment already closed and
        // skips it. A re-issue happens whenever the closer runs twice for
        // the same mission, which is fine.
        alreadyTerminal += 1
        continue
      }
      const outcome = await scope.cancelAssignment(entry.assignmentId)
      if (outcome.ok) {
        closed += 1
        continue
      }
      // Refused cancellation is not a Mission failure. The Mission is
      // already terminal — its outcome is settled. The refusal is a
      // housekeeping problem (the workforce could not find the assignment
      // by id, the worker is no longer in scope, the deadline was set to
      // the past and the transition was refused) and the right thing to
      // do is make it visible, not let it propagate.
      refused += 1
      console.warn(
        `[freya.core] releaseMissionAssignments could not cancel ${entry.assignmentId} for mission ${missionId}: ${outcome.reason ?? 'no reason'}`,
      )
    }
    if (refused > 0) {
      console.warn(
        `[freya.core] releaseMissionAssignments for ${missionId}: closed=${closed} already-terminal=${alreadyTerminal} refused=${refused} total=${linked.length}`,
      )
    }
  }

  /**
   * Give a registered worker the step's *thinking*, and let Work do the work.
   *
   * ## The vocabulary problem, and why this method is shaped around it
   *
   * A Mission step names a **Work capability** (`test.record`, `find.video`). The workforce
   * roster holds **Guard vocabulary capabilities**, and Phase 8's rule is that a worker's set
   * is `WORKER_CAPABILITIES` — which is `cognition.request` alone. A subordinate agent can
   * ask to think and that is the end of it; execution is Work's business.
   *
   * So matching a worker against the step's Work capability name could never succeed. An
   * earlier version of this did exactly that, matched nothing, and made **every** Mission
   * through Core block on `no capable worker` — a total failure that read as a correct
   * refusal, because the refusal it returned was the right refusal for a genuinely empty
   * roster. The two are indistinguishable from outside, which is what made it dangerous.
   *
   * What is delegated is therefore **cognition**: the worker takes the step to think about,
   * under the Mission's budget, and Work executes the capability as the owner. That is the
   * same shape as every other assignment in the system — a worker is assigned work to think
   * about, never a privilege to act with.
   *
   * ## The two refusals, both structural
   *
   * 1. **No worker means no delegation.** There is no fallback to running the step inline as
   *    Freya's own principal. Doing so would bypass the workforce's budget, its audit trail
   *    and its concurrency accounting.
   * 2. **No worker is created.** `WorkforceEngine` has no method this calls that could add
   *    one, so a Mission cannot solve "no capable worker" by inventing a worker.
   *
   * The assignment goes through the workforce's own owner scope, which is where its budget is
   * charged; going around it would give a Mission unlimited assignments.
   */
  private async delegateMissionStep(input: {
    missionId: string
    stepId: string
    capability: string
  }): Promise<{ ok: true; workerId: string; assignmentId: string } | { ok: false; reason: string }> {
    const workforce = this.workforceEngine
    if (workforce === undefined) return { ok: false, reason: 'there is no workforce' }
    const scope = workforce.ownerScope()
    const projection = scope.projection()
    const available = projection.workers.filter(
      (worker) => worker.status !== 'retired' && worker.status !== 'stopped',
    )
    // Only a worker that can actually think can be given this step. The check is against
    // `isAssignableToWorker` rather than against the projection's own list, so a roster that
    // somehow claimed a worker could execute would still be refused here.
    //
    // A worker with **no** capabilities is skipped rather than treated as capable. That is
    // the interesting case: Phase 8's roster begins empty, and a Mission that treated an
    // empty roster as "somebody will do it" would report `no_capable_worker` for the wrong
    // reason — as though the workforce were full and none of them were suitable.
    const capable = available.find((worker) =>
      worker.capabilities.some((capability) => isAssignableToWorker(capability)),
    )
    if (capable === undefined) {
      return {
        ok: false,
        reason:
          available.length === 0
            ? 'there is no worker in the roster'
            : 'no registered worker can take this step',
      }
    }
    const assignable = capable.capabilities.filter((capability) => isAssignableToWorker(capability))
    const assignment = await scope.assign({
      workerId: capable.workerId,
      capabilities: assignable,
      // **Empty.** A worker receives no context references, ever, from a Mission.
      //
      // That is not an oversight: Phase 8's rule is that a subordinate agent does not
      // inherit the user's information, and the only way to keep that true is for the
      // delegation path to have no way to pass any. A Mission's private intent is the most
      // sensitive thing Freya holds, and a step receives its *capability*, never its goal —
      // so a worker learns what may be done, not what it is being done for.
      contextRefs: [],
      missionId: input.missionId,
    })
    if (!assignment.ok) {
      return { ok: false, reason: assignment.reason ?? 'the assignment was refused' }
    }
    return { ok: true, workerId: capable.workerId, assignmentId: assignment.assignmentId ?? '' }
  }
  /**
   * Run one step through Work.
   *
   * A Run is created and attached to the Mission in one call, through
   * `attachChildRunWhileCreating` — Work's admission and the Mission's admission inside the
   * Mission's own queue. Doing it as two calls would leave a window in which a Run existed
   * with a Mission parent the Mission had not corroborated, which is precisely the defect
   * that method exists to prevent.
   *
   * `requiresApproval` is set when the step's capability is gated, which is how the Mission
   * **asks** Work for a gate rather than opening one. Work's Guard then evaluates the
   * capability inside `drive()` and opens the real gate, so a person answers exactly once,
   * on Work's surface, through `work.approval.decide`.
   *
   * The return value is a **verdict, not a fact**. `verified` is what Work's verifier said;
   * the runtime treats it as evidence and the Mission verifier is still what decides
   * whether the *Mission* was achieved. `awaitingApproval` is `true` when Work parked the
   * Run at a gate — `ok: true`, because the executor did its job and the answer was "a
   * person has to decide first". Nothing ran and nothing was disproved.
   */
  private async executeMissionStep(input: {
    missionId: string
    stepId: string
    capability: string
    verifier: string
    risk: WorkRisk
    requiresApproval: boolean
    signal: AbortSignal
  }): Promise<
    | {
        readonly ok: true
        readonly runId: string
        readonly verified: boolean
        readonly observedResults: number
        readonly reportedResults: number
        readonly summaryLength: number
        readonly awaitingApproval: boolean
      }
    | { readonly ok: false; readonly reason: string }
  > {
    const engine = this.requireWork()
    // Resolved against the registry, not the engine. `WorkEngine` deliberately exposes no
    // capability reader: a caller that could ask it "what does this capability need?" could
    // then choose the answer, and choosing a capability's risk is how a consequential
    // action gets marked routine.
    const capability = this.requireWorkRegistry().capability(input.capability)
    if (capability === undefined) return { ok: false, reason: `no such capability: ${input.capability}` }
    const verifier = this.requireWorkRegistry().verifier(input.verifier)
    if (verifier === undefined) return { ok: false, reason: `no such verifier: ${input.verifier}` }

    const content = await this.requireMission().privateContent(input.missionId)
    const privatePlan = content?.executionPlan
    if (privatePlan && !this.persistence.durable) return { ok: false, reason: 'Durable execution history is unavailable.' }
    if (privatePlan && capability.verifier !== input.verifier) return { ok: false, reason: 'The registered verifier binding changed.' }
    const mission = this.requireMission().record(input.missionId)
    const privateStep = privatePlan?.steps.find(step => step.stepId === input.stepId)
    if (privatePlan && (privatePlan.planId !== mission?.activePlan?.planId || !privateStep
      || privateStep.capability !== input.capability || privateStep.verifier !== input.verifier)) return { ok: false, reason: 'Private execution binding does not match the validated plan.' }
    if (!privatePlan && !input.capability.startsWith('test.')) return { ok: false, reason: 'A real capability requires encrypted execution inputs.' }
    if (this.stopped || input.signal.aborted || this.state.stopAll.active) return { ok: false, reason: 'Execution was stopped.' }

    const created = await engine.createRun({
      steps: [
        {
          key: input.stepId,
          label: input.stepId,
          capability: input.capability,
          verifier: input.verifier,
          // Real inputs stay private in Work. Only legacy test fixtures use an echo input.
          input: privateStep ? privateStep.input : { expect: input.stepId },
          // The **request**, never the decision. Work's Guard decides whether this becomes
          // a gate, and a person decides it.
          ...(input.requiresApproval ? { requiresApproval: true } : {}),
        },
      ],
      parent: { kind: 'mission', id: input.missionId },
      // One step, one action, one attempt. The Mission's own budget bounds the whole
      // thing; a Run that could loop or retry would be a second, unaccounted-for budget —
      // and `maxAttemptsPerStep: 1` stops a failing capability being retried inside the
      // Run, silently, behind the Mission's retry accounting.
      limits: { maxSteps: 1, maxActions: 1, maxAttemptsPerStep: 1 },
    })
    if (!created.ok || created.runId === undefined) {
      return { ok: false, reason: created.reason ?? 'the Run could not be created' }
    }
    const runId = created.runId
    const attached = await this.requireMission().attachChildRunWhileCreating(input.missionId, async () => runId)
    if (!attached.ok) {
      // The Run exists but the Mission refused it. Cancelling rather than leaving it
      // queued is deliberate: an orphan Run with a Mission parent that did not admit it is
      // exactly the state this pairing exists to make impossible.
      await engine.cancelRun(runId, 'its Mission refused to attach it').catch(() => undefined)
      return { ok: false, reason: attached.reason ?? 'the Run could not be attached' }
    }

    const abort = () => { void engine.cancelRun(runId, 'Mission execution was cancelled.').catch(() => undefined) }
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) abort()
    const started = await engine.startRun(runId).finally(() => input.signal.removeEventListener('abort', abort))
    if (!started.ok) return { ok: false, reason: started.reason ?? 'the Run could not start' }

    const snapshot = engine.snapshot()
    const status = snapshot.runs.get(runId)?.status

    // Observed results come from **verified steps**, not from a capability's return value.
    // A Run that completed while its step's verifier said no contributes nothing at all to
    // progress, and counting it would be the easiest way for this subsystem to claim work
    // it never checked.
    const ordered = snapshot.runSteps.get(runId) ?? []
    let verified = 0
    for (const stepId of ordered) {
      if (snapshot.steps.get(stepId)?.status === 'verified') verified += 1
    }

    // A Run parked in `awaiting_approval` is not a failure. The gate is upstream of
    // execution, so nothing ran and nothing was disproved. Reported as `ok: true` with
    // `awaitingApproval`, and the runtime then reads the gate through `approvalState`.
    if (status === 'awaiting_approval') {
      return {
        ok: true,
        runId,
        verified: false,
        observedResults: 0,
        reportedResults: 0,
        summaryLength: 0,
        awaitingApproval: true,
      }
    }
    if (status === 'waiting') {
      return { ok: false, reason: 'the step is waiting for an external condition' }
    }
    if (status === 'failed' || status === 'cancelled') {
      return { ok: false, reason: `the Run did not complete: ${status}` }
    }

    return {
      ok: true,
      runId,
      verified: verified > 0 && status === 'completed',
      // One observation per verified step. A step verified the existence of the thing it
      // looked for; it did not find twelve of them. Counting more would be inventing
      // progress.
      observedResults: verified > 0 && status === 'completed' ? verified : 0,
      reportedResults: 0,
      summaryLength: 0,
      awaitingApproval: false,
    }
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

  private requireLife(): LifeEngine {
    if (this.lifeEngine === undefined) {
      throw new Error('the Life History engine is not available')
    }
    return this.lifeEngine
  }

  /**
   * Recover the encrypted Skill store, or degrade in words.
   *
   * A store that cannot be opened is **not** silently replaced with an ephemeral one:
   * that would report `mode: 'ephemeral'` for a file that exists, and a surface would
   * say "procedures will not be remembered" when the truth is "the file is damaged
   * and Freya stopped trusting it". So the runtime records a fault, the projection
   * reports `durable: false` with that reason, and no body is adopted ??? which means
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

  /* ------------------------------------------------------- world & self */
  //
  // Phase 22. Everything below is Core-owned, reads other domains through narrow
  // ports, and writes only the world model's own evidence. The three properties that
  // matter, and how each is obtained rather than promised:
  //
  // 1. **It cannot spend anything.** The engine holds no gateway and no provider, so
  //    there is no code path from a projection to a paid call. Asserted by a
  //    red-team test that counts provider calls around a full read.
  // 2. **It cannot widen anything.** It holds no authority object and no `Principal`.
  //    The only capabilities in Phase 22 are Guard-evaluated on the owner principal,
  //    and `self.assignedCapabilities` *asks* Guard rather than recording an answer.
  // 3. **It does not copy anything.** Reference nodes are rebuilt from the owning
  //    domain on every projection, so there is no second copy of Mission, Work,
  //    Workforce, Skills or Foundry state to fall out of date.

  /**
   * Build the world engine and recover its durable evidence.
   *
   * The store is chosen in one place, and there are exactly two answers:
   *
   *  - a Vault that opened, so `VaultWorldStore` over versioned tables in the one
   *    encrypted database. This is the only durable path. There is no second database,
   *    no JSONL file, no per-domain encrypted file and no dual write.
   *  - no Vault, so `EphemeralWorldStore`: real records, no durability, and
   *    `durable: false` with a sentence saying so.
   *
   * A store that cannot be believed leaves the world **empty and saying so** rather
   * than half-populated: a world rebuilt from part of a history would be a world whose
   * shape depends on what was damaged.
   */
  private async buildWorld(): Promise<void> {
    const persistence = this.options.worldStore ?? (await this.buildWorldStore())
    this.worldEngine = new WorldEngine({
      persistence,
      now: this.options.now,
      limits: this.options.worldLimits,
      references: () => this.worldReferences(),
      self: this.worldSelfSource(),
      // Reads are never gated on STOP ALL — asking what Freya believes costs nothing —
      // but admission is. A stopped Core must not accumulate claims it is not allowed
      // to act on, and then be one resume away from being confidently wrong about all
      // of them.
      stopAll: () => this.state.stopAll.active,
      onChange: () => this.publishWorld(),
    })
    const opened = await this.worldEngine.open()
    if (!opened.ok && opened.degradedReason !== null) {
      console.error('[freya.core] world evidence could not be believed', opened.degradedReason)
    }
    this.publishWorld()
  }

  /**
   * The world model's evidence store: the Vault, or nothing durable.
   *
   * Deliberately never throws. A world-model storage fault must not be able to take
   * down cognition, conversation or STOP ALL — it is a fact about long-term knowledge,
   * not about whether Freya may act. The Vault's own refusal reason is already logged
   * and latched by `ensureVault`, so what is left to report is the honest one: this run
   * of Core will not remember her world.
   */
  private async buildWorldStore(): Promise<WorldPersistencePort> {
    const vault = await this.ensureVault()
    if (vault !== null) return new VaultWorldStore(vault)
    return new EphemeralWorldStore()
  }

  /**
   * The live records of the domains that own them, in the world's narrow shape.
   *
   * Read fresh on every projection and never stored, which is the whole reason a
   * cancelled Mission is cancelled in the graph immediately: there is no copy to
   * reconcile. Statuses are passed through in the owning domain's own words, because
   * a closed vocabulary written here would be this lane guessing at internals it does
   * not own.
   */
  private worldReferences(): readonly WorldReferenceRecord[] {
    const references: WorldReferenceRecord[] = []

    for (const mission of this.missionEngine?.projection().missions ?? []) {
      references.push({
        kind: 'mission',
        id: mission.missionId,
        // Deliberately no title: `MissionSummaryView` does not carry one and this
        // phase has no business going looking for the Mission's private content.
        label: null,
        status: mission.status,
        terminal: isTerminalMissionStatus(mission.status),
        observedAt: mission.settledAt ?? mission.createdAt,
      })
    }

    const work = this.workEngine?.projection()
    for (const run of work?.runs ?? []) {
      references.push({
        kind: 'run',
        id: run.runId,
        label: null,
        status: run.status,
        terminal: isTerminalRunStatus(run.status),
        observedAt: run.completedAt ?? run.cancelledAt ?? run.createdAt,
        parentKind: run.parentKind,
        parentId: run.parentId,
      })
    }
    for (const task of work?.tasks ?? []) {
      references.push({
        kind: 'task',
        id: task.taskId,
        // `WorkTaskView.title` exists only while this process still holds it, and it
        // is the owner's own words, so it is deliberately not read here.
        label: null,
        status: task.status,
        terminal: task.status === 'done' || task.status === 'cancelled',
        observedAt: task.updatedAt,
      })
    }

    // Core's own Workforce vocabulary, which is the domain's closed tables rather than
    // the protocol mirror's looser words. Statuses are passed through untouched: a
    // closed vocabulary written here would be this lane guessing at internals it does
    // not own.
    const workforce = this.workforceEngine?.projection()
    for (const worker of workforce?.workers ?? []) {
      const assignment =
        worker.assignments.find((entry) => entry.status === 'open') ??
        worker.assignments[0] ??
        null
      references.push({
        kind: 'worker',
        id: worker.workerId,
        // Core gave the worker this name. It is Core's word, not the worker's.
        label: worker.name,
        status: worker.status,
        terminal: worker.status === 'retired',
        observedAt: worker.settledAt ?? worker.createdAt,
        // `teams[0]`, because `member_of` is single-valued: two teams is a
        // disagreement the domain resolves and this layer must not invent.
        teamId: worker.teams[0] ?? null,
        assignment:
          assignment === null || assignment.missionId === null
            ? null
            : { kind: 'mission', id: assignment.missionId },
      })
    }
    for (const team of workforce?.teams ?? []) {
      references.push({
        kind: 'team',
        id: team.teamId,
        label: team.name,
        status: team.status,
        terminal: team.status === 'disbanded',
        observedAt: team.settledAt ?? team.createdAt,
      })
    }

    for (const skill of this.skillEngine?.projection().skills ?? []) {
      references.push({
        kind: 'skill',
        id: skill.skillId,
        // The normalised slug, which is what selection matches on. Never the summary:
        // a skill summary is the owner's own prose about their own procedure.
        label: skill.name,
        status: skill.status,
        terminal: skill.status === 'retired' || skill.status === 'blocked',
        observedAt: skill.updatedAt,
      })
    }

    for (const artifact of this.foundryEngine?.projection().artifacts ?? []) {
      references.push({
        kind: 'artifact',
        id: artifact.hash,
        label: artifact.kind,
        status: artifact.status,
        terminal: artifact.status === 'archived',
        observedAt: artifact.updatedAt,
        // An artifact records the Run that produced it, so the graph can show what
        // made what without the world remembering a single step.
        parentKind: 'run',
        parentId: artifact.runId.length > 0 ? artifact.runId : null,
      })
    }

    return references
  }

  /**
   * The self model's read surface: seven compartments, each supplied by the domain
   * that owns it.
   *
   * The two that matter most are `capabilities` and `workerClaims`, because they are
   * where a world model would be most tempted to lie. Capabilities are `guard.holds`
   * evaluated *now* for the owner principal — never a stored answer — and every worker
   * claim is reported with the value the worker asserted and nothing else, because
   * the Workforce claim ledger has already refused it.
   */
  private worldSelfSource(): WorldSelfSource {
    return {
      identity: () => {
        const identity = this.brainService?.identity() ?? null
        if (identity === null) return null
        return {
          name: identity.name,
          role: identity.role,
          purpose: identity.purpose,
          stableTraits: [...identity.stableTraits],
          communicationPrinciples: [...identity.communicationPrinciples],
          continuityPrinciples: [...identity.continuityPrinciples],
          claims: identity.claims.map((claim) => ({ claimId: claim.claimId, statement: claim.statement })),
        }
      },
      limitations: () =>
        (this.brainService?.self()?.limitations ?? []).map((limitation) => ({
          limitationId: limitation.limitationId,
          statement: limitation.statement,
        })),
      // The one place a capability answer enters this subsystem, and it is Guard's
      // answer rather than the world's. Nothing here can add to it.
      capabilities: () => ALL_CAPABILITIES.map((capability) => ({
        capability,
        held: this.guard.holds(this.owner, capability),
      })),
      skills: () =>
        (this.skillEngine?.projection().skills ?? []).map((skill) => ({
          skillId: skill.skillId,
          name: skill.name,
          status: skill.status,
          version: skill.version,
          verification: skill.verification,
        })),
      // Which provider would answer. Never who may ask: `cognition.allowed` names no
      // provider precisely because authorisation happens before one is chosen.
      models: () =>
        (this.gateway?.statuses() ?? []).map((status) => ({
          providerId: status.id,
          kind: status.kind,
          live: status.liveEnabled,
        })),
      // Claims, reported as claims.
      //
      // The **value** a worker asserted is deliberately not projected: it is
      // untrusted text from an agent, and putting it in front of a person unchanged is
      // how injected text becomes an instruction (C9). What is reported is which
      // worker, what kind of claim, and the decision the Workforce ledger recorded
      // beside it — which today is always a refusal, because Core refuses every claim
      // a worker makes about its own authority.
      workerClaims: () => {
        const collected: {
          workerId: string
          principalId: string
          claimKind: string
          decision: string
          count: number
        }[] = []

        // When a `WorkforceSource` seam is filled, it reports claims one by one.
        const mirrored = this.workforceSource === null ? null : safeWorkforceMirror(this.workforce())
        for (const worker of mirrored?.workers ?? []) {
          if (worker.claims.length === 0) continue
          for (const claim of worker.claims) {
            collected.push({
              workerId: worker.workerId,
              principalId: `agent:${worker.workerId}`,
              claimKind: claim.kind,
              decision: 'refused',
              count: 1,
            })
          }
        }
        if (collected.length > 0) return collected

        // When Core owns the Workforce, the domain keeps a count of refused claims
        // rather than their bodies — which is the correct amount of detail, and the
        // world model reports exactly that count.
        for (const worker of this.workforceEngine?.projection().workers ?? []) {
          if (worker.refusedClaims < 1) continue
          collected.push({
            workerId: worker.workerId,
            principalId: `agent:${worker.workerId}`,
            claimKind: 'workforce_claim',
            decision: 'refused',
            count: worker.refusedClaims,
          })
        }
        return collected
      },
    }
  }

  /** The world summary, or an explicit absent projection. Never throws. */
  world(): WorldSummaryView {
    if (this.worldEngine === undefined) {
      return { ...ABSENT_WORLD_SUMMARY, reason: 'Core has not reported a world model yet' }
    }
    try {
      return this.worldEngine.summary()
    } catch (error) {
      return {
        ...ABSENT_WORLD_SUMMARY,
        reason: `the world model could not be read: ${describe(error)}`,
        persistence: { ...ABSENT_WORLD_SUMMARY.persistence, reason: 'the world model could not be read' },
      }
    }
  }

  onWorld(listener: (projection: WorldSummaryView) => void): () => void {
    this.worldListeners.add(listener)
    // Delivered immediately, like `onWorkforce` and `onRelay`: a window that attaches
    // late must agree with one that never left, and the summary is small enough that
    // there is nothing to be stingy about.
    try {
      listener(this.world())
    } catch (error) {
      console.error('[freya.core] world listener threw', error)
      this.worldListeners.delete(listener)
    }
    return () => {
      this.worldListeners.delete(listener)
    }
  }

  private publishWorld(): void {
    if (this.worldListeners.size === 0) return
    const projection = this.world()
    for (const listener of [...this.worldListeners]) {
      try {
        listener(projection)
      } catch (error) {
        console.error('[freya.core] world listener threw', error)
        this.worldListeners.delete(listener)
      }
    }
  }

  /** The world engine, or a closed refusal. Never a half-built one. */
  private requireWorld(): WorldEngine {
    if (this.worldEngine === undefined) {
      throw new Error('the world model is not available in this Core')
    }
    return this.worldEngine
  }

  /**
   * Evaluate a world capability for the owner and record the decision, or answer the
   * refusal.
   *
   * Guard runs before any world code and the decision is journalled like every other
   * capability evaluation, so a refused world command appears in the audit stream
   * rather than only in the caller's return value.
   */
  private async guardWorld(requestId: string, capability: 'world.status.read' | 'world.statement.submit'): Promise<CoreCommandResult | null> {
    const decision = this.guard.evaluate(this.owner, capability)
    if (decision.allowed) return null
    await this.recordGuard(decision, this.owner.id, capability, requestId)
    return this.worldRefusal(requestId, 'store-unavailable', decision.reason)
  }

  /** A world command's answer, in the one shape a surface has to render. */
  private worldResult(requestId: string, outcome: WorldCommandOutcome): CoreCommandResult {
    return {
      requestId,
      ok: outcome.ok,
      status: outcome.ok ? this.status() : undefined,
      refusal: outcome.ok ? undefined : { reason: outcome.reason },
      world: outcome,
    }
  }

  /** A refusal Core produced itself, with no engine round trip. */
  private worldRefusal(requestId: string, code: string, reason: string): CoreCommandResult {
    return {
      requestId,
      ok: false,
      refusal: { reason },
      world: { operation: 'refused', ok: false, code, reason },
    }
  }

  /**
   * Turn a raw renderer payload into a typed world admission request.
   *
   * Refuse rather than coerce, and refuse the whole payload when it carries a
   * claim-shaped or authority-shaped field. A payload that arrived with
   * `confidence: 'verified'` in it is not a payload whose confidence happens to be
   * ignored: treating it as one would make the attempt invisible, and the attempt is
   * the thing worth seeing.
   */
  private worldRequestFrom(raw: unknown): WorldEvidenceRequest | { refusal: string } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { refusal: 'a world statement is not an object' }
    }
    const keys = Object.keys(raw as Record<string, unknown>)
    if (keys.some((key) => WORLD_FORBIDDEN_REQUEST_KEYS.includes(key))) {
      return { refusal: WORLD_REFUSAL_REASONS.claim_fields_not_admissible }
    }
    return raw as WorldEvidenceRequest
  }

  /**
   * The narrow read port Skills have on Work.
   *
   * Four lookups and no writes ??? which is the point. `runCapabilities` answers what
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

  private goalRefusal(
    requestId: string,
    operation: GoalCommandOperation,
    reason: string,
  ): CoreCommandResult {
    return {
      requestId,
      ok: false,
      refusal: { reason },
      goal: { operation, ok: false, reason },
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
    // The previous version of this gate rejected every command when the
    // aggregate lifecycle was `degraded`, which meant a single corrupt
    // subsystem (or a single integrity fault in the journal) took Chat,
    // Browser, diagnostics, and provider calls down with it. That was the
    // wrong shape: degraded is a health label, not a security policy.
    //
    // The only blanket reasons to refuse a command now are:
    //   - the EventFabric was never built (Core never finished starting);
    //   - shutdown has begun (no command may reopen execution or mutate state).
    // Everything else is decided by the specific subsystem the command
    // needs: the governor for security, the gateway for provider calls, the
    // browser for browser actions, the relevant store for its own writes, and
    // STOP ALL for its own effects. A degraded-but-operational Core is
    // usable, and the status projection tells the operator which subsystem
    // is the one that is not.
    if (this.fabric === undefined || (!this.operational && this.lifecycle !== 'stopping' && this.lifecycle !== 'stopped')) {
      if (
        typeof envelope === 'object' &&
        envelope !== null &&
        typeof envelope.requestId === 'string' &&
        envelope.requestId.length > 0 &&
        (envelope.command === 'core.status.read' || envelope.command === 'security.status.read')
      ) {
        return { requestId: envelope.requestId, ok: true, status: this.status() }
      }
      return reject(envelope, 'core is still booting; the event log is not open yet')
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
      command !== 'attention.inbox.read' &&
      command !== 'foundry.status.read' &&
      command !== 'relay.status.read'
    ) {
      return reject(envelope, `core is ${this.lifecycle} and cannot accept mutating commands`)
    }

    try {
      if (MATRIX_COMMANDS.includes(command as MatrixCommandName)) {
        const decision = this.guard.evaluate(this.owner, 'matrix.manage')
        if (!decision.allowed) {
          await this.recordGuard(decision, this.owner.id, 'matrix.manage', requestId)
          return { requestId, ok: false, refusal: { reason: decision.reason } }
        }
        const conversationId = readString(envelope.payload, 'conversationId')
        if ((command === 'matrix.spaces.attach' || conversationId !== null) &&
          (conversationId === null || !await this.conversationStore?.readConversation(conversationId))) {
          return { requestId, ok: false, refusal: { reason: 'The chat does not exist.' } }
        }
        const matrix = await this.matrixService!.execute(command as MatrixCommandName, envelope.payload)
        return { requestId, ok: matrix.ok, matrix, ...(!matrix.ok ? { refusal: { reason: matrix.reason ?? 'Matrix refused the request.' } } : {}) }
      }
      if (EXPLORER_COMMANDS.has(command)) return await handleExplorerCommand(envelope, {
        owner: this.owner, guard: this.guard, stopped: this.state.stopAll.active, vaultFault: this.vaultFault,
        ensureVault: () => this.ensureVault(), newId: () => this.newId(),
        audit: payload => this.fabric.append('command.received', payload, { actor: this.owner.id, correlationId: requestId, source: 'renderer' }),
        world: () => this.requireWorld().relations({ focusEntityId: null, kinds: null, maxDepth: 1 }),
        records: () => this.learningEngine?.listRecords(), learningEncrypted: this.learning().persistence.mode === 'encrypted',
        source: () => this.sourceWorkspace ??= SourceWorkspace.forProfile(this.options.workspaceRoot ?? process.cwd(), this.options.dataPath),
        system: () => systemExplorer(this.runtime(), this.status(), this.toolCatalogue(), { skills: this.skills(), workforce: this.workforce(), missions: this.mission(), goals: this.goals(), activity: this.activity(), voice: this.voice(), work: this.work(), vault: this.vault ? 'encrypted' : this.vaultFault ? 'unavailable' : 'unconfigured', intelligence: this.processRuntime ? this.processRuntime.mind.connected : null }),
      })
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
          // Relay closes in the same synchronous turn, for the same reason: a
          // pending approval decided only after an await would still be able to
          // reach an external connector, and that connector call is the request
          // the owner just asked to stop. The engine reads the latch fresh at
          // each decision, so this is belt-and-braces ??? but the property being
          // defended is that no external action can *begin* after a stop.
          this.closeRelay(`STOP ALL: ${reason}`)
          // And voice, in the same synchronous turn, for the same reason.
          //
          // Voice is I/O, not authority — but a microphone that stays open after the
          // panic button is still a microphone the owner asked to be shut, and a
          // queued utterance that plays out afterwards is Freya talking when
          // somebody believes she has stopped. So the capture is released, the
          // transcription aborted and the queue dropped here, before this file's
          // first await, and the state is latched to `stopped-by-STOP-ALL`.
          //
          // What it does not do is clear `micEnabled`. Resuming must not reopen a
          // device; that stays an explicit press, which is why `onResume` only
          // recomputes the state and never clears a flag.
          void this.voiceService?.onStopAll(reason)
          // And the life loop, in the same synchronous turn. Its gate is the
          // prefilter's STOP ALL check and the journal latch this very command is
          // about to write, so a loop that reconciled only after the await could
          // start a fresh thought in the window between the two — and that window is
          // exactly the race this exists to make impossible.
          //
          // So the *call* happens here and the *record* is awaited immediately,
          // before the latch below. Two reasons for that order: a caller told
          // "Freya is stopped" should never be holding that answer while the journal
          // does not contain it, and a journal whose newest line is
          // `security.stop_all.activated` is one a reader — and the conscious
          // context's recent-changes list — reads correctly, rather than showing a
          // line of loop bookkeeping as the most recent thing that happened.
          await (this.lifeLoopRuntime?.stop() ?? Promise.resolve()).catch(
            (error: unknown) => {
              console.error('[freya.core] the life loop could not record the stop', error)
            },
          )

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
            //
            // Voice is re-asserted here rather than only above. The synchronous call
            // closed whatever was open at the moment the stop was decided, but a
            // `voice.capture.start` already in flight can still land in the window
            // before the latch is durable — and this is the first moment at which
            // `stopAllLatch()` reads true, so the first moment Core can honestly
            // refuse one. `onStopAll` is idempotent, so calling it twice writes one
            // event rather than two.
            await this.voiceService?.onStopAll(reason)
            await this.workforceEngine?.settled()
            // And the runtime activation system, after the latch is durable and
            // before the answer: STOP ALL stops every activated domain except the
            // security spine, in reverse order, and records the reason. A stop a
            // caller was told about must not leave a domain recorded as active.
            await this.activation?.stopAll(reason)
            this.publishRuntime()
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
            this.voiceService?.onResume()
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
          // And the life loop's own latch. This is the *only* place a `lifeloop.unstopped`
          // is written from, and it is written from here because here is where the
          // owner cleared the stop behind `security.resume` — the fold insists there
          // was a stop to lift, so a stray entry anywhere else moves nothing, and
          // there is deliberately no wake, deadline, retry or failure that can reach
          // this call.
          await this.lifeLoopRuntime?.lift()
          // Same for the workforce: only this path reopens it, and it changes nothing
          // but whether a *new* assignment or message may begin. It restarts no work and
          // returns nothing, so a worker stopped by a panic button stays stopped until
          // somebody resumes it deliberately.
          this.workforceEngine?.resume()
          // And Relay, for the same reason: only this path reopens it. A connector
          // action is an external request, and one refused at the door during a stop
          // must not silently become allowed the instant the latch clears.
          this.relayAdmissionOpen = true
          this.connectorAdmissionOpen = true
          // And the runtime activation system, last: it re-evaluates every domain
          // against the now-cleared latch and records which of them came back. A
          // domain whose dependency was lost during the stop stays blocked; only
          // the ones that can honestly run again do.
          await this.activation?.resume(this.runtimeFacts())
          this.publishRuntime()
          // Voice resumes its state machine without reopening the microphone.
          // STOP ALL clears hands-free arming; clearing the latch must not restore it.
          this.voiceService?.onResume()
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
          // Owner pre-emption, in the same synchronous turn as the decision to
          // accept the act. A background loop mid-thought is abandoned rather than
          // finished: the owner is present and the owner comes first, and letting
          // the in-flight work complete first would mean telling them Freya was busy
          // for a few seconds after they had already started talking to her.
          //
          // Awaited before the command answers, for the reason the STOP handler waits
          // on the loop's stop: a caller told the conversation exists should not be
          // holding that answer while the journal does not yet record the pre-emption.
          const preemption = this.lifeLoopRuntime?.preemptByOwner() ?? Promise.resolve()
          const result = await this.conversations.create(
            readString(envelope.payload, 'title') ?? undefined,
          )
          await preemption.catch((error: unknown) => {
            console.error('[freya.core] the life loop could not record the pre-emption', error)
          })
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

        case 'conversation.rename': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const conversationId = readString(envelope.payload, 'conversationId')
          const title = readString(envelope.payload, 'title')
          if (conversationId === null || title === null) return { requestId, ok: false, refusal: { reason: 'Conversation id and title are required.' } }
          const result = await this.conversations.rename(conversationId, title)
          return result.ok
            ? { requestId, ok: true, status: this.status(), conversation: { operation: 'renamed', conversation: result.conversation } }
            : { requestId, ok: false, refusal: { reason: result.reason }, conversation: { operation: 'refused', reason: result.reason } }
        }

        case 'conversation.archive': {
          const decision = this.guard.evaluate(this.owner, 'core.command.submit')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
            return { requestId, ok: false, refusal: { reason: decision.reason } }
          }
          const conversationId = readString(envelope.payload, 'conversationId')
          if (conversationId === null) {
            return { requestId, ok: false, refusal: { reason: 'conversationId is missing' } }
          }
          const result = await this.conversations.archive(conversationId)
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
            conversation: { operation: 'archived', archived: result.archived },
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

          let attachments
          try { attachments = validateModelAttachments(readRaw(envelope.payload, 'attachments')) }
          catch { return { requestId, ok: false, refusal: { reason: 'Conversation attachments are invalid or too large.' } } }
          // The renderer's tool directives travel as structured metadata. The
          // shape is a closed `{ webSearch?, browserUse? }`; anything else is
          // dropped on the floor so a malformed payload cannot influence routing.
          const intents = readTurnIntentHints(readRaw(envelope.payload, 'intents'))
          const result = await this.conversations.submitTurn({
            conversationId,
            text,
            attachments,
            requestId,
            ...(intents !== undefined ? { intents } : {}),
          })
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

        case 'conversation.mission.decide': {
          const conversationId = readString(envelope.payload, 'conversationId')
          const proposalMessageId = readString(envelope.payload, 'proposalMessageId')
          const decision = readString(envelope.payload, 'decision')
          if (!this.guard.evaluate(this.owner, 'mission.manage').allowed || !this.chatMissions || !conversationId || !proposalMessageId || !decision) return { requestId, ok: false, refusal: { reason: 'An authorized chat Mission decision is required.' } }
          const outcome = await this.chatMissions.decide(conversationId, proposalMessageId, decision)
          return outcome.ok ? { requestId, ok: true, conversation: { operation: 'mission', missionId: outcome.missionId, decision } } : { requestId, ok: false, refusal: { reason: outcome.reason ?? 'Mission decision refused.' } }
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
              models: catalog.models.map((entry) => ({ id: entry.id, ownedBy: entry.ownedBy, providerId: entry.providerId, ...(entry.reasoningEfforts ? { reasoningEfforts: entry.reasoningEfforts } : {}) })),
              ...(catalog.reason ? { reason: catalog.reason } : {}),
              selectedProviderId: this.selectedProviderId,
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
            this.selectedProviderId = null
            return {
              requestId,
              ok: true,
              status: this.status(),
              model: { operation: 'selected', selected: null, selectedProviderId: null },
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
          const providerId = hasKey(envelope.payload, 'providerId') ? readString(envelope.payload, 'providerId') : null
          if (hasKey(envelope.payload, 'providerId') && (providerId === null || providerId.length > 128)) return { requestId, ok: false, model: { operation: 'refused', reason: 'provider id is invalid' } }
          if (!this.gateway.canServeModel(model, providerId)) {
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
          this.selectedProviderId = providerId
          return {
            requestId,
            ok: true,
            status: this.status(),
            model: { operation: 'selected', selected: model, selectedProviderId: providerId },
          }
        }

        /* ---------------------------------------------------------- foundry */

        case 'foundry.status.read': {
          if (carriesFields(envelope.payload)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: FOUNDRY_NO_PAYLOAD },
              foundry: { operation: 'refused', ok: false, reason: FOUNDRY_NO_PAYLOAD },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            foundry: { operation: 'status', ok: true },
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
          const guardDecision = this.guard.evaluate(this.owner, 'attention.schedule.manage')
          if (!guardDecision.allowed) {
            await this.recordGuard(guardDecision, this.owner.id, 'attention.schedule.manage', requestId)
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
            attention: { operation: 'scheduled', ok: true, scheduleId: result.scheduleId },
          }
        }

        case 'attention.schedule.cancel': {
          const decision = this.guard.evaluate(this.owner, 'attention.schedule.manage')
          if (!decision.allowed) return { requestId, ok: false, refusal: { reason: decision.reason } }
          const scheduleId = readString(envelope.payload, 'scheduleId')
          if (scheduleId === null) {
            return { requestId, ok: false, refusal: { reason: 'scheduleId is missing' } }
          }
          const cancelled = await this.requireAttention().cancelSchedule(scheduleId)
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

        /* --------------------------------------------------------- office */

        case 'office.status.read': {
          // A payloadless read, exactly like `work.status.read` and
          // `workforce.status.read`. Anything attached is refused rather than
          // dropped, so a window cannot smuggle an instruction into a question.
          if (carriesFields(envelope.payload)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'the Office read carries no payload' },
              office: { operation: 'refused', ok: false, reason: 'the Office read carries no payload' },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            office: { operation: 'status', ok: true },
          }
        }

        case 'office.presence.request': {
          // The one Office command that writes, and it writes one bounded fact:
          // that the owner asked for an agent to join the desktop Presence.
          //
          // The payload carries a workerId and nothing else. There is no
          // principal, no authority, no capability, no expression and no
          // position — the request is a question to Presence (Phase 13), not an
          // instruction, and the Office can ask and show that it asked and do
          // nothing else.
          const workerId = readString(envelope.payload, 'workerId')
          if (workerId === null) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'a workerId is required' },
              office: { operation: 'refused', ok: false, reason: 'a workerId is required' },
            }
          }
          if (
            typeof envelope.payload !== 'object' ||
            envelope.payload === null ||
            Array.isArray(envelope.payload) ||
            Object.keys(envelope.payload as Record<string, unknown>).some((key) => key !== 'workerId') ||
            !/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)
          ) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'presence request accepts only a valid workerId' },
              office: { operation: 'refused', ok: false, reason: 'presence request accepts only a valid workerId' },
            }
          }
          // STOP ALL is latched, so Freya is not acting and the office is not
          // asking for agents to join a desktop that is not in use.
          if (this.state.stopAll.active) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'Freya is stopped' },
              office: { operation: 'refused', ok: false, reason: 'Freya is stopped', workerId },
            }
          }
          // The worker must exist. A request for an agent Core does not have is
          // a phantom, and the Office does not invent agents to put on the
          // desktop.
          const workforce = this.workforce()
          if (!workforce.workers.some((worker) => worker.workerId === workerId)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'no such worker' },
              office: { operation: 'refused', ok: false, reason: 'no such worker', workerId },
            }
          }
          // One pending request per worker. A repeated ask replaces the first
          // rather than adding a duplicate, so a repeated click cannot grow the
          // set without bound.
          const existing = this.state.office.requests.get(workerId)
          if (existing !== undefined && !existing.fulfilled) {
            return {
              requestId,
              ok: true,
              status: this.status(),
              office: { operation: 'presence-requested', ok: true, workerId },
            }
          }
          const event = await this.fabric.append(
            'office.presence.requested',
            { workerId },
            { actor: 'owner' },
          )
          this.publishOffice()
          return {
            requestId,
            ok: true,
            status: this.status(),
            office: {
              operation: 'presence-requested',
              ok: true,
              workerId,
              durableSequence: event.sequence,
            },
          }
        }

        /* ----------------------------------------------------------- relay */

        case 'relay.status.read': {
          // A payloadless read, exactly like `attention.status.read`. Anything
          // attached is refused rather than dropped, so a window cannot smuggle
          // a connector, an action or a capability into the question of what
          // Core reports.
          if (carriesFields(envelope.payload)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: RELAY_NO_PAYLOAD },
              relay: { operation: 'refused', ok: false, reason: RELAY_NO_PAYLOAD },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            relay: { operation: 'status', ok: true },
          }
        }

        case 'relay.email.read':
        case 'relay.calendar.read':
        case 'relay.github.read':
        case 'relay.drive.read':
        case 'relay.telegram.read': {
          const admission = this.refuseRelay(requestId)
          if (admission !== null) return admission
          const result = await this.requireRelay().execute({
            action: readActionFor(envelope.command),
            payload: envelope.payload,
          })
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              relay: relayRefusal(result),
            }
          }
          if (result.kind === 'read') {
            this.publishRelay()
            this.observeRelaySignal(envelope.command, result)
            return {
              requestId,
              ok: true,
              status: this.status(),
              relay: { operation: 'read', ok: true, result: result.result },
            }
          }
          // A read never returns pending or replayed; treat anything else as a
          // refusal rather than inventing an outcome.
          return {
            requestId,
            ok: false,
            refusal: { reason: 'the read could not be completed' },
            relay: { operation: 'refused', ok: false, failureCode: 'adapter_error', reason: 'the read could not be completed' },
          }
        }

        case 'relay.email.draft.create':
        case 'relay.email.send':
        case 'relay.calendar.create':
        case 'relay.calendar.update':
        case 'relay.calendar.cancel':
        case 'relay.github.issue.create':
        case 'relay.github.pr.create':
        case 'relay.drive.file.create':
        case 'relay.telegram.send':
        case 'relay.external.invoke': {
          const admission = this.refuseRelay(requestId)
          if (admission !== null) return admission
          const result = await this.requireRelay().execute({
            action: writeActionFor(envelope.command),
            payload: envelope.payload,
          })
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              relay: relayRefusal(result),
            }
          }
          if (result.kind === 'pending') {
            this.publishRelay()
            return {
              requestId,
              ok: true,
              status: this.status(),
              relay: {
                operation: 'requested',
                ok: true,
                actionId: result.actionId,
                approvalId: result.approvalId,
                status: 'pending_approval',
              },
            }
          }
          // A replayed write: the same idempotency key was already submitted.
          // Answer with the original outcome ??? never a second execution.
          // (A write never returns 'read'; anything else is a refusal.)
          if (result.kind !== 'replayed') {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'the action could not be completed' },
              relay: { operation: 'refused', ok: false, failureCode: 'adapter_error', reason: 'the action could not be completed' },
            }
          }
          this.publishRelay()
          return {
            requestId,
            ok: true,
            status: this.status(),
            relay: {
              operation: 'replayed',
              ok: true,
              actionId: result.action.actionId,
              status: result.action.status,
            },
          }
        }

        case 'relay.approval.decide': {
          const admission = this.refuseRelay(requestId)
          if (admission !== null) return admission
          const approvalId = readString(envelope.payload, 'approvalId')
          if (approvalId === null) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'approvalId is missing' },
              relay: { operation: 'refused', ok: false, reason: 'approvalId is missing' },
            }
          }
          const decision = readString(envelope.payload, 'decision')
          if (decision !== 'approved' && decision !== 'denied') {
            const reason = 'a decision must be approved or denied'
            return {
              requestId,
              ok: false,
              refusal: { reason },
              relay: { operation: 'refused', ok: false, reason },
            }
          }
          const result = await this.requireRelay().decide(approvalId, decision)
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              relay: { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason },
            }
          }
          this.publishRelay()
          if (result.kind === 'executed') {
            return {
              requestId,
              ok: true,
              status: this.status(),
              relay: { operation: 'executed', ok: true, result: result.result },
            }
          }
          if (result.kind === 'denied') {
            return {
              requestId,
              ok: true,
              status: this.status(),
              relay: { operation: 'decided', ok: true, status: 'denied' },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            relay: { operation: 'replayed', ok: true, actionId: result.action.actionId, status: result.action.status },
          }
        }

        /* ------------------------------------------------------ connectors */

        case 'connector.status.read': {
          if (carriesFields(envelope.payload)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: CONNECTOR_NO_PAYLOAD },
              connectors: { operation: 'refused', ok: false, reason: CONNECTOR_NO_PAYLOAD },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            connectors: { operation: 'status', ok: true },
          }
        }

        case 'connector.connect.start': {
          const admission = this.refuseConnector(requestId)
          if (admission !== null) return admission
          const decision = this.guard.evaluate(this.owner, 'connector.connect')
          if (!decision.allowed) {
            return {
              requestId,
              ok: false,
              refusal: { reason: decision.reason },
              connectors: { operation: 'refused', ok: false, failureCode: 'capability_denied', reason: decision.reason },
            }
          }
          const result = await this.requireConnector().connect(envelope.payload)
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              connectors: { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason },
            }
          }
          this.publishConnectors()
          return {
            requestId,
            ok: true,
            status: this.status(),
            connectors: {
              operation: 'authorization',
              ok: true,
              requestId: result.requestId,
              authorizationUrl: result.authorizationUrl,
            },
          }
        }

        case 'connector.disconnect': {
          const admission = this.refuseConnector(requestId)
          if (admission !== null) return admission
          const decision = this.guard.evaluate(this.owner, 'connector.disconnect')
          if (!decision.allowed) {
            return {
              requestId,
              ok: false,
              refusal: { reason: decision.reason },
              connectors: { operation: 'refused', ok: false, failureCode: 'capability_denied', reason: decision.reason },
            }
          }
          const result = await this.requireConnector().disconnect(envelope.payload)
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              connectors: { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason },
            }
          }
          this.publishConnectors()
          return {
            requestId,
            ok: true,
            status: this.status(),
            connectors: { operation: 'revoked', ok: true },
          }
        }

        case 'connector.read': {
          const admission = this.refuseConnector(requestId)
          if (admission !== null) return admission
          const decision = this.guard.evaluate(this.owner, 'connector.read')
          if (!decision.allowed) {
            return {
              requestId,
              ok: false,
              refusal: { reason: decision.reason },
              connectors: { operation: 'refused', ok: false, failureCode: 'capability_denied', reason: decision.reason },
            }
          }
          const request = validateActionRequest(envelope.payload)
          if (!request.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: request.reason },
              connectors: { operation: 'refused', ok: false, failureCode: 'invalid_request', reason: request.reason },
            }
          }
          if (!isReadAction(request.value.action)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'connector.read may only submit a read action' },
              connectors: { operation: 'refused', ok: false, failureCode: 'invalid_request', reason: 'connector.read may only submit a read action' },
            }
          }
          const result = await this.requireConnector().execute(envelope.payload)
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              connectors: { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason },
            }
          }
          this.publishConnectors()
          return {
            requestId,
            ok: true,
            status: this.status(),
            connectors: connectorEngineOutcome(result),
          }
        }

        case 'connector.action.execute': {
          const admission = this.refuseConnector(requestId)
          if (admission !== null) return admission
          const decision = this.guard.evaluate(this.owner, 'connector.action')
          if (!decision.allowed) {
            return {
              requestId,
              ok: false,
              refusal: { reason: decision.reason },
              connectors: { operation: 'refused', ok: false, failureCode: 'capability_denied', reason: decision.reason },
            }
          }
          const result = await this.requireConnector().execute(envelope.payload)
          if (!result.ok) {
            return {
              requestId,
              ok: false,
              refusal: { reason: result.reason },
              connectors: { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason },
            }
          }
          this.publishConnectors()
          return {
            requestId,
            ok: true,
            status: this.status(),
            connectors: connectorEngineOutcome(result),
          }
        }

        /* -------------------------------------------------------- voice */

        case 'voice.status.read':
          // Read-only and always allowed, including while stopped: "the microphone
          // is off" is a state somebody needs to be able to ask about, and it is
          // not an authority question. Note the asymmetry that follows from this —
          // knowing Freya is stopped must not be the same as being able to act.
          return { requestId, ok: true, status: this.status(), voice: { operation: 'state', state: this.voice().state } }

        case 'voice.mic.enable': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          // The activation source is a closed two-value set, checked here rather
          // than defaulted. Anything else is refused rather than treated as
          // `owner`: a window naming a source Core does not know is a window naming
          // something, and the safe reading of an unrecognised value is "no".
          const source = readString(envelope.payload, 'source')
          if (source !== null && source !== 'owner' && source !== 'wake') {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'the microphone activation source is owner or wake' },
              voice: { operation: 'refused', reason: 'the microphone activation source is owner or wake' },
            }
          }
          const result = await this.voiceService.enableMic(source === 'wake' ? 'wake' : 'owner')
          return {
            requestId,
            ok: result.ok,
            ...(result.ok ? {} : { refusal: { reason: result.reason } }),
            status: this.status(),
            voice: result.ok
              ? { operation: 'state', state: result.state }
              : { operation: 'refused', reason: result.reason },
          }
        }

        case 'voice.mic.disable': {
          // Always permitted, and deliberately not Guard-blocked: a person must be
          // able to close the microphone even in the middle of anything.
          await this.voiceService.disableMic(readString(envelope.payload, 'reason') ?? 'the owner turned the microphone off')
          return { requestId, ok: true, status: this.status(), voice: { operation: 'state', state: this.voice().state } }
        }

        case 'voice.permission.request': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          const opened = this.voiceService.requestPermissionWindow()
          return opened.ok
            ? { requestId, ok: true, status: this.status(), voice: { operation: 'state', state: this.voice().state } }
            : {
                requestId,
                ok: false,
                refusal: { reason: opened.reason },
                status: this.status(),
                voice: { operation: 'refused', reason: opened.reason },
              }
        }

        case 'voice.permission.report': {
          const outcome = readString(envelope.payload, 'outcome')
          if (outcome !== 'granted' && outcome !== 'denied' && outcome !== 'revoked') {
            return { requestId, ok: false, refusal: { reason: 'a permission report must say granted, denied or revoked' } }
          }
          const state = await this.voiceService.reportPermission(outcome)
          return { requestId, ok: true, status: this.status(), voice: { operation: 'permission', state, outcome } }
        }

        case 'voice.capture.start': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
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

        case 'voice.transcript.interim': {
          // Deliberately *not* Guard-gated and deliberately cheap: interim text is
          // a display string on its way to a screen. There is no path from here to
          // a turn, so a renderer sending interim text has not gained anything by
          // being able to send it.
          const result = this.voiceService.pushInterim(
            readString(envelope.payload, 'sessionId') ?? '',
            readRaw(envelope.payload, 'text'),
          )
          return {
            requestId,
            ok: true,
            status: this.status(),
            voice: {
              operation: 'interim',
              sessionId: readString(envelope.payload, 'sessionId') ?? '',
              accepted: result.ok,
              reason: result.reason ?? null,
            },
          }
        }

        case 'voice.capture.end': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          const result = await this.voiceService.endCapture(normaliseAudioPayload(envelope.payload))
          return {
            requestId,
            ok: true,
            status: this.status(),
            // A transcript, and — only when the owner turned auto-submit on before
            // speaking — a turn. `turnId` says which happened, so a window never
            // has to guess whether it is holding text in a composer or a message in
            // a conversation.
            voice: {
              operation: 'capture-ended',
              reason: result.reason,
              text: result.text,
              detail: result.detail,
              transcribed: result.transcribed,
              byteLength: result.byteLength,
              durationMs: result.durationMs,
              turnId: result.turnId,
            },
          }
        }

        case 'voice.capture.cancel': {
          // Allowed unconditionally, for the same reason `voice.mic.disable` is.
          await this.voiceService.cancelCapture(readString(envelope.payload, 'reason') ?? 'the owner cancelled the recording')
          return { requestId, ok: true, status: this.status(), voice: { operation: 'cancelled' } }
        }

        case 'voice.submit.set': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          const enabled = readRaw(envelope.payload, 'enabled')
          if (typeof enabled !== 'boolean') {
            return { requestId, ok: false, refusal: { reason: 'auto-submit is a true or false setting' } }
          }
          await this.voiceService.setAutoSubmit(enabled)
          return { requestId, ok: true, status: this.status(), voice: { operation: 'auto-submit', enabled } }
        }

        case 'voice.auto-speak.set': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          const enabled = readRaw(envelope.payload, 'enabled')
          if (typeof enabled !== 'boolean') {
            return { requestId, ok: false, refusal: { reason: 'auto-speak is a true or false setting' } }
          }
          await this.voiceService.setAutoSpeak(enabled)
          return { requestId, ok: true, status: this.status(), voice: { operation: 'auto-speak', enabled } }
        }

        case 'voice.proactive-alerts.set': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          const enabled = readRaw(envelope.payload, 'enabled')
          if (typeof enabled !== 'boolean') {
            return { requestId, ok: false, refusal: { reason: 'proactive alerts is a true or false setting' } }
          }
          await this.voiceService.setProactiveAlerts(enabled)
          return {
            requestId,
            ok: true,
            status: this.status(),
            voice: { operation: 'proactive-alerts', enabled },
          }
        }

        case 'voice.tts.speak': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          // The payload is a turn id. Core reads the words from its own store, so
          // there is no field here a window could use to make Freya say something
          // she did not already write — and the Guard above still applies, because
          // playback is not free of the owner's authority rules.
          const result = await this.voiceService.speakTurn(envelope.payload)
          return {
            requestId,
            ok: result.ok,
            ...(result.ok ? {} : { refusal: { reason: result.reason } }),
            status: this.status(),
            voice: result.ok
              ? { operation: 'speaking', utteranceId: result.utteranceId, queued: result.queued }
              : { operation: 'refused', reason: result.reason },
          }
        }

        case 'voice.tts.stop': {
          await this.voiceService.stopSpeaking()
          return {
            requestId,
            ok: true,
            status: this.status(),
            voice: { operation: 'speech-stopped', utteranceId: null },
          }
        }

        case 'voice.tts.cancel': {
          // Unconditional, like the capture cancel: cutting Freya off is always
          // something the owner must be able to do.
          await this.voiceService.cancelSpeaking(
            readString(envelope.payload, 'reason') ?? 'the owner interrupted Freya',
          )
          return {
            requestId,
            ok: true,
            status: this.status(),
            voice: {
              operation: 'speech-interrupted',
              utteranceId: null,
              reason: readString(envelope.payload, 'reason') ?? 'the owner interrupted Freya',
            },
          }
        }

        case 'voice.tts.settle': {
          const outcome = readString(envelope.payload, 'outcome')
          if (outcome !== 'completed' && outcome !== 'failed') {
            return { requestId, ok: false, refusal: { reason: 'a settlement is completed or failed' } }
          }
          await this.voiceService.settleSpeech(readString(envelope.payload, 'utteranceId'), outcome)
          return { requestId, ok: true, status: this.status(), voice: { operation: 'state', state: this.voice().state } }
        }

        case 'voice.tts.voice.read': {
          const voices = await this.voiceService.listVoices()
          return { requestId, ok: true, status: this.status(), voice: { operation: 'voices', voices } }
        }

        case 'voice.tts.voice.select': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          const result = await this.voiceService.selectVoice(readRaw(envelope.payload, 'voiceId'))
          return {
            requestId,
            ok: result.ok,
            ...(result.ok ? {} : { refusal: { reason: result.reason ?? 'that voice could not be selected' } }),
            status: this.status(),
            voice: result.ok
              ? { operation: 'voice-selected', voiceId: String(readRaw(envelope.payload, 'voiceId')).slice(0, 200) }
              : { operation: 'refused', reason: result.reason ?? 'that voice could not be selected' },
          }
        }

        case 'voice.mute.set': {
          const muted = readRaw(envelope.payload, 'muted')
          if (typeof muted !== 'boolean') {
            return { requestId, ok: false, refusal: { reason: 'mute is a true or false setting' } }
          }
          const state = await this.voiceService.setMuted(muted)
          return { requestId, ok: true, status: this.status(), voice: { operation: 'muted', muted, state } }
        }

        case 'voice.wake.arm': {
          const guarded = await this.guardVoice(requestId)
          if (guarded !== null) return guarded
          const result = await this.voiceService.armWake()
          return {
            requestId,
            ok: result.ok,
            ...(result.ok ? {} : { refusal: { reason: result.reason ?? 'hands-free could not be armed' } }),
            status: this.status(),
            voice: result.ok
              ? { operation: 'wake-armed' }
              : { operation: 'refused', reason: result.reason ?? 'hands-free could not be armed' },
          }
        }

        case 'voice.wake.disarm': {
          await this.voiceService.disarmWake(readString(envelope.payload, 'reason') ?? 'hands-free was turned off')
          return { requestId, ok: true, status: this.status(), voice: { operation: 'wake-disarmed' } }
        }

        case 'voice.wake.energy': {
          // Reports a local measurement. It can only ever *ask* for a capture, and
          // the capture path still has to clear every ordinary precondition — so a
          // sound in the room is not permission, a turn, or a grant.
          const result = await this.voiceService.reportWakeEnergy(
            readNumber(envelope.payload, 'level'),
            readNumber(envelope.payload, 'sustainedMs') ?? 0,
          )
          return {
            requestId,
            ok: true,
            status: this.status(),
            voice: result.fired
              ? { operation: 'capture-started', sessionId: this.voice().sessionId ?? '', startedAt: new Date().toISOString() }
              : { operation: 'refused', reason: result.reason ?? 'the wake gate did not fire' },
          }
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
          const pack = await this.brainService.recall(
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

        /* ---------------------------------------------------- Freya's Eye */

        case 'research.session.create': {
          const request = readString(envelope.payload, 'request')
          if (request === null || request.trim().length === 0) {
            return { requestId, ok: false, refusal: { reason: 'a search request is required' } }
          }
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          try {
            const session = await this.researchIntegration!.sessions.create(request)
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-created',
                session: projectSearchSession(session, this.researchIntegration!.sessions.store),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, this.newId(), 'research.session.create', error)
          }
        }

        case 'research.session.list': {
          if (this.researchIntegration === null) return this.refuseResearch(requestId)!
          try {
            const sessions = await this.researchIntegration.sessions.list()
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-list',
                sessions: sessions.slice(0, 100).map((session) => ({
                  sessionId: session.sessionId,
                  state: session.state,
                  subject: session.intent.subject,
                  targetCount: session.intent.targetCount,
                  mediaType: session.intent.mediaType,
                  resultCount: session.results.length,
                  updatedAt: session.updatedAt,
                })),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, this.newId(), 'research.session.list', error)
          }
        }

        case 'research.session.read': {
          if (this.researchIntegration === null) return this.refuseResearch(requestId)!
          const sessionId = readString(envelope.payload, 'sessionId')
          if (sessionId === null) {
            return { requestId, ok: false, refusal: { reason: 'a search session id is required' } }
          }
          try {
            const session = await this.researchIntegration.sessions.read(sessionId)
            if (session === null) {
              return { requestId, ok: false, refusal: { reason: 'that search session does not exist' } }
            }
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-read',
                session: projectSearchSession(session, this.researchIntegration.sessions.store),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, sessionId, 'research.session.read', error)
          }
        }

        case 'research.session.followup': {
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          const sessionId = readString(envelope.payload, 'sessionId')
          const text = readString(envelope.payload, 'text')
          if (sessionId === null || text === null || text.trim().length === 0) {
            return { requestId, ok: false, refusal: { reason: 'a search session id and follow-up are required' } }
          }
          try {
            const outcome = await this.researchIntegration!.sessions.patchFollowUp(sessionId, text)
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-updated',
                session: projectSearchSession(outcome.session, this.researchIntegration!.sessions.store),
                ambiguous: outcome.ambiguous,
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, sessionId, 'research.session.followup', error)
          }
        }

        case 'research.session.collect': {
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          const sessionId = readString(envelope.payload, 'sessionId')
          if (sessionId === null) {
            return { requestId, ok: false, refusal: { reason: 'a search session id is required' } }
          }
          try {
            const session = await this.researchIntegration!.sessions.collect(sessionId)
            // Content stays in the private session store. The journal gets only a
            // bounded count and state-equivalent stage, never query text or URLs.
            await this.emitResearch(
              'research.search_completed',
              session.sessionId,
              'searching',
              session.lastError,
              { results: session.results.length, queries: session.page },
            )
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-collected',
                session: projectSearchSession(session, this.researchIntegration!.sessions.store),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, sessionId, 'research.session.collect', error)
          }
        }

        case 'research.session.pause': {
          if (this.researchIntegration === null) return this.refuseResearch(requestId)!
          const sessionId = readString(envelope.payload, 'sessionId')
          if (sessionId === null) {
            return { requestId, ok: false, refusal: { reason: 'a search session id is required' } }
          }
          try {
            const session = await this.researchIntegration.sessions.pause(sessionId)
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-paused',
                session: projectSearchSession(session, this.researchIntegration.sessions.store),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, sessionId, 'research.session.pause', error)
          }
        }

        case 'research.session.resume': {
          const refused = this.refuseResearch(requestId)
          if (refused !== null) return refused
          const sessionId = readString(envelope.payload, 'sessionId')
          if (sessionId === null) {
            return { requestId, ok: false, refusal: { reason: 'a search session id is required' } }
          }
          try {
            const session = await this.researchIntegration!.sessions.resume(sessionId)
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-resumed',
                session: projectSearchSession(session, this.researchIntegration!.sessions.store),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, sessionId, 'research.session.resume', error)
          }
        }

        case 'research.session.cancel': {
          if (this.researchIntegration === null) return this.refuseResearch(requestId)!
          const sessionId = readString(envelope.payload, 'sessionId')
          if (sessionId === null) {
            return { requestId, ok: false, refusal: { reason: 'a search session id is required' } }
          }
          try {
            const session = await this.researchIntegration.sessions.cancel(sessionId)
            return {
              requestId,
              ok: true,
              status: this.status(),
              research: {
                operation: 'session-cancelled',
                session: projectSearchSession(session, this.researchIntegration.sessions.store),
              },
            }
          } catch (error) {
            return this.researchFailure(requestId, sessionId, 'research.session.cancel', error)
          }
        }


        /* -------------------------------------------------------------- work */

        /* ----------------------------------------------------------- missions */

        case 'mission.read':
        case 'mission.update':
        case 'mission.delete': {
          const capability = command === 'mission.read' ? 'mission.status.read' : 'mission.manage'
          const decision = this.guard.evaluate(this.owner, capability)
          if (!decision.allowed) return this.missionRefusal(requestId, 'refused', decision.reason)
          const missionId = readString(envelope.payload, 'missionId')
          if (!missionId) return this.missionRefusal(requestId, 'refused', 'a Mission id is required')
          if (command === 'mission.read') {
            const detail = await this.requireMission().detail(missionId)
            return detail ? { requestId, ok: true, mission: { operation: 'read', ok: true, missionId, detail } } : this.missionRefusal(requestId, 'refused', 'Mission not found')
          }
          const title = readString(envelope.payload, 'title')
          const intent = readString(envelope.payload, 'intent')
          if (command === 'mission.update' && (!title || !intent)) return this.missionRefusal(requestId, 'refused', 'title and intent are required')
          const successCriteria = readStringArray(envelope.payload, 'successCriteria')
          const outcome = command === 'mission.delete' ? await this.requireMission().delete(missionId) : await this.requireMission().update(missionId, { title: title!, intent: intent!, ...(successCriteria ? { successCriteria } : {}) })
          this.publishMission()
          return { requestId, ok: outcome.ok, mission: missionResult(outcome) }
        }

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
            'mission.requestCompletion': () => this.completeMission(missionId),
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

        /* ----------------------------------------------------------- goals (longhorizon) */

        case 'goal.read':
        case 'goal.update':
        case 'goal.delete': {
          const capability = command === 'goal.read' ? 'goal.status.read' : 'goal.manage'
          const decision = this.guard.evaluate(this.owner, capability)
          if (!decision.allowed) return this.goalRefusal(requestId, 'refused', decision.reason)
          const goalId = readString(envelope.payload, 'goalId')
          if (!goalId) return this.goalRefusal(requestId, 'refused', 'a Goal id is required')
          if (command === 'goal.read') {
            const detail = await this.requireGoal().detail(goalId)
            return detail ? { requestId, ok: true, goal: { operation: 'read', ok: true, goalId, detail } } : this.goalRefusal(requestId, 'refused', 'Goal not found')
          }
          const title = readString(envelope.payload, 'title')
          const description = readString(envelope.payload, 'description')
          if (command === 'goal.update' && (!title || !description)) return this.goalRefusal(requestId, 'refused', 'title and description are required')
          const completionCriteria = readStringArray(envelope.payload, 'completionCriteria')
          const outcome = command === 'goal.delete' ? await this.requireGoal().deleteGoal(goalId) : await this.requireGoal().updateGoal(goalId, { title: title!, description: description!, ...(completionCriteria ? { completionCriteria } : {}) })
          this.publishGoals()
          return { requestId, ok: outcome.ok, goal: goalResult(outcome) }
        }

        case 'goal.create': {
          const decision = this.guard.evaluate(this.owner, 'goal.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'goal.manage', requestId)
            return this.goalRefusal(requestId, 'refused', decision.reason)
          }
          const title = readString(envelope.payload, 'title')
          if (title === null) {
            return this.goalRefusal(requestId, 'refused', 'a Goal title is missing')
          }
          const description = readString(envelope.payload, 'description')
          if (description === null) {
            return this.goalRefusal(requestId, 'refused', 'a Goal needs a description as well as a title')
          }
          const criteria = readStringArray(envelope.payload, 'completionCriteria')
          const roadmap = typeof envelope.payload === 'object' && envelope.payload !== null && 'roadmap' in envelope.payload
            ? (envelope.payload as { roadmap?: GoalRoadmapInput }).roadmap
            : undefined
          const budget = typeof envelope.payload === 'object' && envelope.payload !== null && 'budget' in envelope.payload
            ? (envelope.payload as { budget?: Partial<GoalBudgetPolicy> }).budget
            : undefined
          const outcome = await this.requireGoal().createGoal({
            title,
            description,
            ...(criteria === undefined ? {} : { completionCriteria: criteria }),
            ...(roadmap === undefined ? {} : { roadmap }),
            ...(budget === undefined ? {} : { budget }),
          })
          this.publishGoals()
          return { requestId, ok: outcome.ok, status: this.status(), goal: goalResult(outcome) }
        }

        case 'goal.roadmap.set': {
          const decision = this.guard.evaluate(this.owner, 'goal.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'goal.manage', requestId)
            return this.goalRefusal(requestId, 'refused', decision.reason)
          }
          const goalId = readString(envelope.payload, 'goalId')
          if (goalId === null) {
            return this.goalRefusal(requestId, 'refused', 'a Goal id is missing')
          }
          const payload = envelope.payload as Record<string, unknown>
          const milestones = Array.isArray(payload?.milestones) ? payload.milestones : []
          const advisoryNotes = Array.isArray(payload?.advisoryNotes)
            ? (payload.advisoryNotes as string[])
            : undefined
          const outcome = await this.requireGoal().setRoadmap(goalId, {
            goalId,
            milestones: milestones as unknown as readonly GoalMilestoneInput[],
            advisoryNotes,
          })
          this.publishGoals()
          return { requestId, ok: outcome.ok, status: this.status(), goal: goalResult(outcome) }
        }

        case 'goal.milestone.settle': {
          const decision = this.guard.evaluate(this.owner, 'goal.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'goal.manage', requestId)
            return this.goalRefusal(requestId, 'refused', decision.reason)
          }
          const goalId = readString(envelope.payload, 'goalId')
          if (goalId === null) {
            return this.goalRefusal(requestId, 'refused', 'a Goal id is missing')
          }
          const milestoneId = readString(envelope.payload, 'milestoneId')
          if (milestoneId === null) {
            return this.goalRefusal(requestId, 'refused', 'a milestone id is missing')
          }
          const outcomeStr = readString(envelope.payload, 'outcome')
          if (outcomeStr !== 'completed' && outcomeStr !== 'failed') {
            return this.goalRefusal(requestId, 'refused', 'milestone outcome must be completed or failed')
          }
          const payload = envelope.payload as Record<string, unknown>
          const evidence = typeof payload?.evidence === 'object' && payload.evidence !== null
            ? (payload.evidence as { reason?: string; missionId?: string })
            : {}
          const outcome = await this.requireGoal().settleMilestone(goalId, milestoneId, outcomeStr, evidence)
          this.publishGoals()
          return { requestId, ok: outcome.ok, status: this.status(), goal: goalResult(outcome) }
        }

        case 'goal.budget.set': {
          const decision = this.guard.evaluate(this.owner, 'goal.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'goal.manage', requestId)
            return this.goalRefusal(requestId, 'refused', decision.reason)
          }
          const goalId = readString(envelope.payload, 'goalId')
          if (goalId === null) {
            return this.goalRefusal(requestId, 'refused', 'a Goal id is missing')
          }
          const payload = envelope.payload as Record<string, unknown>
          const budget = typeof payload?.budget === 'object' && payload.budget !== null
            ? (payload.budget as Partial<GoalBudgetPolicy>)
            : (payload as Partial<GoalBudgetPolicy>)
          const outcome = await this.setGoalBudget(goalId, budget)
          this.publishGoals()
          return { requestId, ok: outcome.ok, status: this.status(), goal: goalResult(outcome) }
        }

        case 'goal.activate':
        case 'goal.pause':
        case 'goal.resume':
        case 'goal.cancel':
        case 'goal.fail':
        case 'goal.requestCompletion': {
          const decision = this.guard.evaluate(this.owner, 'goal.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'goal.manage', requestId)
            return this.goalRefusal(requestId, 'refused', decision.reason)
          }
          const goalId = readString(envelope.payload, 'goalId')
          if (goalId === null) {
            return this.goalRefusal(requestId, 'refused', 'a Goal id is missing')
          }
          const engine = this.requireGoal()
          const operations: Partial<Record<CoreCommandName, () => Promise<GoalCommandOutcome>>> = {
            'goal.activate': () => engine.activateGoal(goalId),
            'goal.pause': () => engine.pauseGoal(goalId),
            'goal.resume': () => engine.resumeGoal(goalId),
            'goal.cancel': () => engine.cancelGoal(goalId),
            'goal.fail': () => {
              const reasonStr = readString(envelope.payload, 'reason')
              const reason = (reasonStr && reasonStr in GOAL_REASONS) ? (reasonStr as GoalReason) : GOAL_REASONS.owner
              return engine.failGoal(goalId, reason)
            },
            'goal.requestCompletion': () => engine.completeGoal(goalId),
          }
          const run = operations[envelope.command]
          if (run === undefined) {
            return this.goalRefusal(requestId, 'refused', 'that Goal command is not recognised')
          }
          const outcome = await run()
          this.publishGoals()
          return { requestId, ok: outcome.ok, status: this.status(), goal: goalResult(outcome) }
        }

        case 'goal.status.read': {
          const decision = this.guard.evaluate(this.owner, 'goal.status.read')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'goal.status.read', requestId)
            return this.goalRefusal(requestId, 'refused', decision.reason)
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            goal: { operation: 'status', ok: true },
          }
        }

        /* ---------------------------------------------------- proactive */

        case 'proactive.status.read': {
          const decision = this.guard.evaluate(this.owner, 'proactive.status.read')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'proactive.status.read', requestId)
            return {
              requestId,
              ok: false,
              status: this.status(),
              refusal: { reason: decision.reason },
              proactive: { operation: 'refused', ok: false, reason: decision.reason },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            proactive: {
              operation: 'status',
              ok: true,
              subscriptions: this.observationSubscriptions(),
              recentObservations: this.recentObservations(),
            },
          }
        }

        case 'proactive.observation.ingest': {
          const decision = this.guard.evaluate(this.owner, 'proactive.ingest')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'proactive.ingest', requestId)
            return {
              requestId,
              ok: false,
              status: this.status(),
              refusal: { reason: decision.reason },
              proactive: { operation: 'refused', ok: false, reason: decision.reason },
            }
          }
          const payload = envelope.payload as Record<string, unknown>
          const sourceType = typeof payload?.sourceType === 'string' ? payload.sourceType : null
          const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId : null
          const rawSummary = typeof payload?.rawSummary === 'string' ? payload.rawSummary : null
          if (!sourceType || !sourceId || !rawSummary) {
            return {
              requestId,
              ok: false,
              status: this.status(),
              refusal: { reason: 'malformed observation input: sourceType, sourceId, and rawSummary are required' },
              proactive: { operation: 'refused', ok: false, reason: 'malformed observation input' },
            }
          }
          const result = await this.ingestObservation(payload as unknown as RawObservationInput)
          return {
            requestId,
            ok: result.ok,
            status: this.status(),
            refusal: result.ok ? undefined : { reason: result.reason ?? 'ingest failed' },
            proactive: {
              operation: 'ingest',
              ok: result.ok,
              reason: result.reason,
              observationId: result.observation?.observationId,
            },
          }
        }

        case 'proactive.subscription.manage': {
          const decision = this.guard.evaluate(this.owner, 'proactive.manage')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'proactive.manage', requestId)
            return {
              requestId,
              ok: false,
              status: this.status(),
              refusal: { reason: decision.reason },
              proactive: { operation: 'refused', ok: false, reason: decision.reason },
            }
          }
          const payload = envelope.payload as Record<string, unknown>
          const action = typeof payload?.action === 'string' ? payload.action : null
          if (action === 'revoke') {
            const subscriptionId = typeof payload?.subscriptionId === 'string' ? payload.subscriptionId : null
            if (!subscriptionId) {
              return {
                requestId,
                ok: false,
                status: this.status(),
                refusal: { reason: 'subscriptionId required for revoke' },
                proactive: { operation: 'refused', ok: false, reason: 'subscriptionId required' },
              }
            }
            const revoked = await this.revokeObservationSource(subscriptionId)
            return {
              requestId,
              ok: revoked,
              status: this.status(),
              proactive: { operation: 'revoke', ok: revoked, subscriptionId },
            }
          } else if (action === 'subscribe') {
            try {
              const sub = await this.subscribeObservationSource(payload as unknown as ObservationSubscriptionInput)
              return {
                requestId,
                ok: true,
                status: this.status(),
                proactive: { operation: 'subscribe', ok: true, subscriptionId: sub.subscriptionId },
              }
            } catch (err) {
              return {
                requestId,
                ok: false,
                status: this.status(),
                refusal: { reason: (err as Error).message },
                proactive: { operation: 'refused', ok: false, reason: (err as Error).message },
              }
            }
          }
          return {
            requestId,
            ok: false,
            status: this.status(),
            refusal: { reason: 'unrecognised action for proactive.subscription.manage' },
            proactive: { operation: 'refused', ok: false, reason: 'unknown action' },
          }
        }

        /* --------------------------------------------------------- life */

        case 'life.status.read': {
          // The payloadless read. Anything attached is refused rather than dropped,
          // so a window cannot accompany "what do you remember" with a status, a
          // derivation class, a confidence or a date.
          if (carriesFields(envelope.payload)) {
            return {
              requestId,
              ok: false,
              refusal: { reason: LIFE_NO_PAYLOAD },
              life: { operation: 'refused', ok: false, code: 'malformed-payload', reason: LIFE_NO_PAYLOAD },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            life: { operation: 'status', ok: true, projection: this.life() },
          }
        }

        case 'life.timeline.read': {
          const parsed = readLifeTimelineQuery(envelope.payload)
          if (parsed === null) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'life.timeline.read accepts only a bounded limit and known entry kinds' },
              life: {
                operation: 'refused',
                ok: false,
                code: 'malformed-payload',
                reason: 'life.timeline.read accepts only a bounded limit and known entry kinds',
              },
            }
          }
          const engine = this.lifeEngine
          if (engine === undefined) {
            return {
              requestId,
              ok: false,
              refusal: { reason: NO_LIFE_DOMAIN_REASON },
              life: { operation: 'refused', ok: false, code: 'no-life-domain', reason: NO_LIFE_DOMAIN_REASON },
            }
          }
          const timeline: LifeTimelineView = engine.timeline(parsed)
          return {
            requestId,
            ok: true,
            status: this.status(),
            life: { operation: 'timeline', ok: true, timeline },
          }
        }

        case 'life.entry.read': {
          const entryId = readString(envelope.payload, 'entryId')
          if (entryId === null) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'life.entry.read needs one entry id' },
              life: { operation: 'refused', ok: false, code: 'malformed-payload', reason: 'life.entry.read needs one entry id' },
            }
          }
          // The explicit per-entry read is the one route to an entry's own text, so
          // it is the one Life command Guard evaluates — the owner's own business,
          // and never a worker's.
          const decision = this.guard.evaluate(this.owner, 'life.status.read')
          if (!decision.allowed) {
            await this.recordGuard(decision, this.owner.id, 'life.status.read', requestId)
            return {
              requestId,
              ok: false,
              refusal: { reason: decision.reason },
              life: { operation: 'refused', ok: false, code: 'guard-refused', reason: decision.reason },
            }
          }
          const engine = this.lifeEngine
          if (engine === undefined) {
            return {
              requestId,
              ok: false,
              refusal: { reason: NO_LIFE_DOMAIN_REASON },
              life: { operation: 'refused', ok: false, code: 'no-life-domain', reason: NO_LIFE_DOMAIN_REASON },
            }
          }
          const entry = engine.entry(entryId)
          if (entry === null) {
            return {
              requestId,
              ok: false,
              refusal: { reason: 'there is no such Life History entry' },
              life: { operation: 'refused', ok: false, code: 'unknown-entry', reason: 'there is no such Life History entry' },
            }
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            life: { operation: 'entry', ok: true, entry },
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
        // Core's own admission, evaluation, promotion and improvement code ??? none of
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
          // single id ??? there is deliberately no command that lists every body, because
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

        /* -------------------------------------------------------------- forge */
        //
        // Phase 48. One read and eleven owner acts over generated and acquired
        // packages.
        //
        // Every mutating case evaluates `skill.manage` through Guard first and
        // records the decision, so a refusal appears in the audit stream rather than
        // only in the caller's return value. None of them writes a status, a verdict
        // or a threshold: `forge.validate` returns whatever the *pipeline* concluded
        // about the candidate's own bytes, and there is no payload that can assert a
        // verdict instead.
        //
        // Two absences are structural rather than omitted on purpose:
        //   - there is no command that installs and enables at once, and no flag that
        //     means "and turn it on";
        //   - there is no command that grants a capability, approves an approval, or
        //     writes to Core. Enabling re-checks the declared capabilities against
        //     what the owner already holds, at run time.

        case 'forge.status.read': {
          // Argument-free by construction, for the same reason `skill.status.read` is:
          // a window that could filter this read would be querying the catalog.
          if (carriesFields(envelope.payload)) {
            const refusal = FORGE_NO_PAYLOAD
            return this.forgeRefusal(requestId, 'refused', 'no-payload', refusal)
          }
          return {
            requestId,
            ok: true,
            status: this.status(),
            forge: { operation: 'status', ok: true, projection: this.forge() },
          }
        }

        case 'forge.generate': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          if (this.requireForge() === undefined) {
            return this.forgeRefusal(requestId, 'refused', 'unsupported-runtime', 'this Core has no Forge domain')
          }
          const payload = (envelope.payload ?? {}) as Record<string, unknown>
          // The origin is Core's decision about *which pathway* the request arrived
          // through, not something a payload may declare: a window that could say
          // `forge-generated` about its own text could launder a model-authored
          // package as a locally-authored one.
          const origin: ForgeOrigin = 'owner-authored'
          return this.forgeResult(
            requestId,
            await this.issueForgeOwnerScope().generate({
              payload,
              origin,
              model: null,
              requestHash: null,
              originRef: readString(payload, 'originRef') ?? null,
            }),
          )
        }

        case 'forge.validate': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'validated', 'no-such-package', 'skill id is missing')
          return this.forgeResult(requestId, await this.issueForgeOwnerScope().validate(skillId))
        }

        case 'forge.install': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'installed', 'no-such-package', 'skill id is missing')
          return this.forgeResult(
            requestId,
            await this.issueForgeOwnerScope().install(skillId, {
              allowDowngrade: readBooleanField(envelope.payload, 'allowDowngrade') === true,
            }),
          )
        }

        case 'forge.enable': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'enabled', 'no-such-package', 'skill id is missing')
          return this.forgeResult(requestId, await this.issueForgeOwnerScope().enable(skillId))
        }

        case 'forge.disable': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'disabled', 'no-such-package', 'skill id is missing')
          return this.forgeResult(
            requestId,
            await this.issueForgeOwnerScope().disable(skillId, readString(envelope.payload, 'reason') ?? undefined),
          )
        }

case 'forge.run': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'run', 'no-such-package', 'skill id is missing')
          // The command's own fields are removed rather than copied: a payload that
          // kept `skillId` would be refused by the package's input schema for
          // carrying a field its contract does not declare, which is correct and
          // unhelpful here.
          const payload = { ...((envelope.payload ?? {}) as Record<string, unknown>) }
          delete payload.skillId
          delete payload.idempotencyKey
          delete payload.reason
          delete payload.allowDowngrade
          return this.forgeResult(
            requestId,
            await this.issueForgeOwnerScope().run({
              skillId,
              input: payload,
              idempotencyKey: readString(envelope.payload, 'idempotencyKey') ?? null,
            }),
          )
        }

        case 'forge.rollback': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          const version = readNumber(envelope.payload, 'version')
          if (skillId === null) return this.forgeRefusal(requestId, 'rolledback', 'no-such-package', 'skill id is missing')
          if (version === null) {
            return this.forgeRefusal(requestId, 'rolledback', 'no-such-version', 'a rollback names the version it returns to')
          }
          return this.forgeResult(requestId, await this.issueForgeOwnerScope().rollback(skillId, version))
        }

        case 'forge.remove': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'removed', 'no-such-package', 'skill id is missing')
          const version = readNumber(envelope.payload, 'version')
          return this.forgeResult(requestId, await this.issueForgeOwnerScope().remove(skillId, version ?? undefined))
        }

        case 'forge.approve': {
          const guarded = await this.guardSkill(requestId)
          if (guarded !== null) return guarded
          const skillId = readString(envelope.payload, 'skillId')
          const decision = readString(envelope.payload, 'decision')
          if (skillId === null) return this.forgeRefusal(requestId, 'approved', 'no-such-package', 'skill id is missing')
          if (decision !== 'approved' && decision !== 'refused') {
            return this.forgeRefusal(requestId, 'approved', 'malformed-command', 'an approval is approved or refused')
          }
          return this.forgeResult(
            requestId,
            await this.issueForgeOwnerScope().approve(
              skillId,
              decision,
              readString(envelope.payload, 'reason') ?? undefined,
            ),
          )
        }

        case 'forge.search': {
          // A read over already-authorised state, so no Guard evaluation: nothing is
          // decided here, and it costs zero model calls because it is lexical.
          const payload = (envelope.payload ?? {}) as Record<string, unknown>
          const runtime = readString(payload, 'runtime')
          if (runtime !== null && !isForgeRuntimeKind(runtime)) {
            return this.forgeRefusal(requestId, 'search', 'unknown-runtime', 'that is not a runtime this Core knows')
          }
          const found = this.requireForge().discover({
            query: readString(payload, 'query'),
            tags: readStringArray(payload, 'tags'),
            capability: readString(payload, 'capability'),
            runtime,
            includeUnavailable: readBooleanField(payload, 'includeUnavailable') === true,
            limit: readNumber(payload, 'limit'),
          })
          return {
            requestId,
            ok: found.ok,
            status: this.status(),
            forge: { operation: 'search', ok: found.ok, search: found.report, ...(found.projection === undefined ? {} : { projection: found.projection }) },
          }
        }

        case 'forge.export': {
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'detail', 'no-such-package', 'skill id is missing')
          const outcome = this.issueForgeOwnerScope().exportPackage(skillId)
          return this.forgeResult(requestId, outcome)
        }

        case 'forge.detail.read': {
          // The single command in this family that carries a body across the bridge,
          // and it takes one id. There is deliberately no command that lists every
          // program: a standing feed would defeat the encryption the store exists to
          // provide.
          const skillId = readString(envelope.payload, 'skillId')
          if (skillId === null) return this.forgeRefusal(requestId, 'detail', 'no-such-package', 'skill id is missing')
          const detail = this.issueForgeOwnerScope().detail(skillId)
          if (detail === null) {
            return this.forgeRefusal(
              requestId,
              'detail',
              'no-such-version',
              'there is no such package, or its body could not be read at this version',
            )
          }
          return { requestId, ok: true, status: this.status(), forge: { operation: 'detail', ok: true, detail } }
        }
        /* ------------------------------------------------------ world & self */
        //
        // Phase 22. Five reads and two owner acts.
        //
        // The reads are argument-free or take a single closed filter, because a graph
        // surface that could ask "everything, unfiltered" is a database explorer and
        // this is not one. The two writes are owner-only through Guard, are absent from
        // the renderer command allowlist, and route into Core's own admission — which
        // is what assigns the source, the epistemic ceiling and the confidence ceiling
        // from the channel. A window cannot state any of those, and asking to is a
        // refusal rather than a stripped field.

        case 'world.summary.read': {
          const guarded = await this.guardWorld(requestId, 'world.status.read')
          if (guarded !== null) return guarded
          // Counts only, and no payload: a summary that could be filtered or paged is a
          // query surface, and this one answers exactly one question.
          if (carriesFields(envelope.payload)) {
            const refusal = WORLD_NO_PAYLOAD
            return this.worldRefusal(requestId, 'no-payload', refusal)
          }
          return this.worldResult(requestId, {
            operation: 'summary',
            ok: true,
            summary: this.requireWorld().summary(),
          })
        }

        case 'world.entities.read': {
          const guarded = await this.guardWorld(requestId, 'world.status.read')
          if (guarded !== null) return guarded
          const payload = (envelope.payload ?? {}) as Record<string, unknown>
          const allowed = ['kind', 'includeWithdrawn']
          for (const key of Object.keys(payload)) {
            if (!allowed.includes(key)) {
              return this.worldRefusal(requestId, 'unknown-field', 'the entity list accepts only kind and includeWithdrawn')
            }
          }
          const kind = worldKindFrom(payload.kind)
          if (kind === undefined) {
            return this.worldRefusal(requestId, 'unknown-kind', 'that is not an entity kind this Core knows')
          }
          const list = this.requireWorld().entities({
            kind,
            includeWithdrawn: payload.includeWithdrawn === true,
          })
          return this.worldResult(requestId, { operation: 'entities', ok: true, entities: list })
        }

        case 'world.entity.read': {
          const guarded = await this.guardWorld(requestId, 'world.status.read')
          if (guarded !== null) return guarded
          const payload = (envelope.payload ?? {}) as Record<string, unknown>
          for (const key of Object.keys(payload)) {
            if (key !== 'entityId') {
              return this.worldRefusal(requestId, 'unknown-field', 'the entity read accepts only entityId')
            }
          }
          const entityId = readString(envelope.payload, 'entityId')
          if (entityId === null) {
            return this.worldRefusal(requestId, 'no-entity-id', 'the entity read needs an entityId')
          }
          const engine = this.requireWorld()
          // The engine folds again for conflicts rather than the caller passing them
          // in, so a detail read cannot be answered with a conflicts list somebody else
          // chose.
          const detail = engine.entity(entityId, (fold) => fold.conflicts)
          return this.worldResult(requestId, {
            operation: 'entity',
            ok: true,
            entity: detail,
            found: detail.entity !== null,
          })
        }

        case 'world.relations.read': {
          const guarded = await this.guardWorld(requestId, 'world.status.read')
          if (guarded !== null) return guarded
          const options = worldGraphOptionsFrom(envelope.payload)
          if ('refusal' in options) {
            return this.worldRefusal(requestId, 'invalid-graph-read', options.refusal)
          }
          return this.worldResult(requestId, {
            operation: 'relations',
            ok: true,
            relations: this.requireWorld().relations(options),
          })
        }

        case 'self.status.read': {
          const guarded = await this.guardWorld(requestId, 'world.status.read')
          if (guarded !== null) return guarded
          if (carriesFields(envelope.payload)) {
            const refusal = WORLD_NO_PAYLOAD
            return this.worldRefusal(requestId, 'no-payload', refusal)
          }
          return this.worldResult(requestId, { operation: 'self', ok: true, self: this.requireWorld().self() })
        }

        case 'world.statement.submit': {
          const guarded = await this.guardWorld(requestId, 'world.statement.submit')
          if (guarded !== null) return guarded
          const request = this.worldRequestFrom(envelope.payload)
          if ('refusal' in request) {
            // A claim-shaped field is named as itself rather than as a malformed
            // request, because "you tried to state your own certainty" is the honest
            // answer and "bad payload" is not.
            const code = request.refusal === WORLD_REFUSAL_REASONS.claim_fields_not_admissible
              ? 'claim_fields_not_admissible'
              : 'invalid-statement'
            return this.worldRefusal(requestId, code, request.refusal)
          }
          // The channel is Core's, not the payload's: an owner statement arrives on the
          // owner's channel because the owner principal sent it, and there is no field
          // a payload could carry to say otherwise.
          const admission: WorldAdmissionRequest = {
            request,
            channel: 'owner_statement',
            actor: this.owner.id,
            sensitivity: 'personal',
          }
          const outcome = this.requireWorld().admit(admission)
          if (!outcome.ok) {
            return this.worldResult(requestId, {
              operation: 'refused',
              ok: false,
              code: outcome.code,
              reason: outcome.reason,
            })
          }
          this.publishWorld()
          return this.worldResult(requestId, {
            operation: 'submitted',
            ok: true,
            evidenceId: outcome.evidenceId,
            summary: this.requireWorld().summary(),
          })
        }

        case 'world.statement.withdraw': {
          const guarded = await this.guardWorld(requestId, 'world.statement.submit')
          if (guarded !== null) return guarded
          const targetEvidenceId = readString(envelope.payload, 'targetEvidenceId')
          if (targetEvidenceId === null) {
            return this.worldRefusal(requestId, 'no-evidence-id', 'a withdrawal needs a targetEvidenceId')
          }
          const reason = readString(envelope.payload, 'reason') ?? 'the owner withdrew this claim'
          const outcome = this.requireWorld().withdraw(targetEvidenceId, reason, {
            channel: 'owner_statement',
            actor: this.owner.id,
            sensitivity: 'personal',
          })
          if (!outcome.ok) {
            return this.worldResult(requestId, {
              operation: 'refused',
              ok: false,
              code: outcome.code,
              reason: outcome.reason,
            })
          }
          this.publishWorld()
          return this.worldResult(requestId, {
            operation: 'withdrawn',
            ok: true,
            evidenceId: outcome.evidenceId,
            summary: this.requireWorld().summary(),
          })
        }

        default:
          return reject(envelope, `unknown command: ${String(command)}`)
      }
    } catch (error) {
      this.diagnostics?.recordError('core.command', 'command_failed', error, 'command execution failed', { requestId, command })
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
   * Open the one encrypted Vault, once.
   *
   * Every domain that has migrated onto it calls this, so there is a single owner of
   * the connection and a single place a refusal can come from. The result is cached:
   * a second caller gets the same `Vault` rather than a second connection to the same
   * database, which is how a single-writer store quietly becomes a two-writer one.
   *
   * Fail-closed, once, with the reason latched. There is no retry and no second
   * attempt with different parameters: a Vault that could not be opened is a fact this
   * run of Core reports, and every domain that wanted it then takes its own explicitly
   * ephemeral path *saying so*. Never a different durable store, never plaintext.
   */
  private async ensureVault(): Promise<Vault | null> {
    if (this.vault !== null) return this.vault
    if (this.vaultFault !== null) return null
    const options = this.options.vault
    if (options === undefined) return null
    try {
      this.vault = await Vault.open({
        path: options.path,
        keyProvider: options.keyProvider,
        ...(options.binding ? { binding: options.binding } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
      })
      return this.vault
    } catch (error) {
      this.vault = null
      this.vaultFault = 'the encrypted Vault could not be opened'
      this.recordRuntimeFault('core.vault', 'vault_open_failed', this.vaultFault, error)
      console.error('[freya.core] encrypted Vault unavailable', describe(error))
      return null
    }
  }

  /**
   * Build Freya's Eye / research search-session persistence.
   *
   * Private queries, URLs and result collections live only in the encrypted
   * Vault when it is available. If encryption cannot be established, sessions
   * remain explicitly ephemeral; there is no second durable file and no
   * plaintext fallback.
   */
  private async buildResearchSessionStore(): Promise<SearchSessionStore> {
    const injected = this.options.research?.sessionStore
    if (injected) return injected

    const vault = await this.ensureVault()
    if (vault !== null) return new VaultResearchSessionStore(vault)

    if (this.options.vault !== undefined) {
      return new MemorySearchSessionStore(
        `Search sessions are held in memory only: ${this.vaultFault ?? 'the encrypted Vault is unavailable'}.`,
      )
    }

    return new MemorySearchSessionStore(
      'Search sessions are held in memory only because no encrypted Vault is configured.',
    )
  }

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
    // When a Vault is configured, Mission content lives in the one encrypted SQLCipher
    // database. There is no dual write — the bespoke per-domain file is not opened at
    // all on this path.
    const vault = await this.ensureVault()
    if (vault !== null) return new VaultMissionStore(vault)
    if (this.options.vault !== undefined) {
      return new MemoryMissionStore({
        faultReason: `Mission content is held in memory only: ${this.vaultFault ?? 'the encrypted Vault is not configured'}`,
      })
    }
    if (this.options.missionKey) {
      const path = `${this.options.dataPath}.missions`
      try {
        return await EncryptedMissionStore.open({ path, key: this.options.missionKey })
      } catch (error) {
        console.error('[freya.core] encrypted Mission store unavailable', describe(error))
        this.recordRuntimeFault('core.mission', 'mission_store_open_failed', 'Mission content could not be encrypted', error)
        return new MemoryMissionStore({
          faultReason: `Mission content could not be encrypted: ${describe(error)}`,
        })
      }
    }
    return new MemoryMissionStore({
      faultReason: 'no secure Mission key is available on this machine',
    })
  }

  /**
   * Build the Goal content store (Phase 5 LongHorizon).
   *
   * Persists private goal content (title, description, criteria) to the encrypted Vault.
   * If the Vault is not configured or fails to open, falls back to MemoryGoalStore reporting
   * why it is ephemeral.
   */
  private async buildGoalStore(): Promise<GoalStore> {
    if (this.options.goalStore) return this.options.goalStore
    const vault = await this.ensureVault()
    if (vault !== null) return new VaultGoalStore(vault)
    return new MemoryGoalStore({
      faultReason: this.options.vault !== undefined
        ? `Goal content is held in memory only: ${this.vaultFault ?? 'the encrypted Vault is not configured'}`
        : 'the encrypted Vault is not configured',
    })
  }

  /**
   * Build the Proactive content store (Phase 6 Proactive Intelligence).
   */
  private async buildProactiveStore(): Promise<ProactiveStore> {
    if (this.options.proactiveStore) return this.options.proactiveStore
    const vault = await this.ensureVault()
    if (vault !== null) return new VaultProactiveStore(vault)
    return new MemoryProactiveStore({
      faultReason: this.options.vault !== undefined
        ? `Proactive content is held in memory only: ${this.vaultFault ?? 'the encrypted Vault is not configured'}`
        : 'the encrypted Vault is not configured',
    })
  }

  private publishProactive(): void {
    this.publishConsciousness()
  }

  /**
   * Build the Metacognition content store (Phase 7 Metacognition & Performance Awareness).
   */
  private async buildMetacognitionStore(): Promise<MetacognitionStore> {
    if (this.options.metacognitionStore) return this.options.metacognitionStore
    const vault = await this.ensureVault()
    if (vault !== null) return new VaultMetacognitionStore(vault)
    return new MemoryMetacognitionStore({
      faultReason: this.options.vault !== undefined
        ? `Metacognition content is held in memory only: ${this.vaultFault ?? 'the encrypted Vault is not configured'}`
        : 'the encrypted Vault is not configured',
    })
  }

  /**
   * Build the Evolution content store (Phase 7 Verified Evolution).
   */
  private async buildEvolutionStore(): Promise<EvolutionStore> {
    if (this.options.evolutionStore) return this.options.evolutionStore
    const vault = await this.ensureVault()
    if (vault !== null) return new VaultEvolutionStore(vault)
    return new MemoryEvolutionStore({
      faultReason: this.options.vault !== undefined
        ? `Evolution content is held in memory only: ${this.vaultFault ?? 'the encrypted Vault is not configured'}`
        : 'the encrypted Vault is not configured',
    })
  }

  /**
   * The Life History store.
   *
   * The canonical path is the one encrypted Vault: when a Vault is configured,
   * Life records live in the one SQLCipher database under `domain = 'life'`,
   * and there is no bespoke per-domain file and no dual write. When no Vault
   * is configured, Life falls back to an explicitly ephemeral store that says
   * so — never to a different durable store, never to plaintext, and never to
   * a second encrypted file.
   */
  private async buildLifeStore(): Promise<LifeStore> {
    const vault = await this.ensureVault()
    if (this.options.vault && vault !== null) {
      try {
        const store = new VaultLifeStore(vault)
        await store.open()
        return store
      } catch (error) {
        console.error('[freya.core] encrypted Vault Life store unavailable', describe(error))
        this.recordRuntimeFault('core.life', 'life_store_open_failed', 'Life History could not be encrypted', error)
        return new MemoryLifeStore({
          mode: 'ephemeral',
          faultReason: `Life History could not be encrypted: ${describe(error)}`,
        })
      }
    }
    if (this.options.vault) {
      return new MemoryLifeStore({
        mode: 'ephemeral',
        faultReason:
          this.vaultFault ??
          'no encrypted Vault is available on this machine, so Freya is keeping her ' +
            'autobiographical layer in memory only and it will not survive a restart',
      })
    }
    return new MemoryLifeStore({
      mode: 'ephemeral',
      faultReason:
        'no encrypted Vault is available on this machine, so Freya is keeping her ' +
        'autobiographical layer in memory only and it will not survive a restart',
    })
  }

  /**
   * The Learning store.
   *
   * The canonical path is the one encrypted Vault: when a Vault is configured,
   * Learning records live in the one SQLCipher database under `domain = 'learning'`.
   * When no Vault is configured or opening it fails, Learning falls back to an
   * explicitly ephemeral store that says so — never to a different durable store,
   * never to plaintext, and never to a second encrypted file.
   */
  private async buildLearningStore(): Promise<LearningStore> {
    if (this.options.learningStore) return this.options.learningStore
    const vault = await this.ensureVault()
    if (this.options.vault && vault !== null) {
      try {
        const store = new VaultLearningStore(vault)
        await store.open()
        return store
      } catch (error) {
        console.error('[freya.core] encrypted Vault Learning store unavailable', describe(error))
        this.recordRuntimeFault('core.learning', 'learning_store_open_failed', 'Learning records could not be encrypted', error)
        return new MemoryLearningStore({
          mode: 'ephemeral',
          faultReason: `Learning records could not be encrypted: ${describe(error)}`,
        })
      }
    }
    return new MemoryLearningStore({
      mode: 'ephemeral',
      faultReason:
        this.vaultFault ??
        'no encrypted Vault is available on this machine, so Freya is keeping learning records in memory only and they will not survive a restart',
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
        this.recordRuntimeFault('core.brain', 'brain_store_open_failed', 'the Brain could not be opened', error)
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
   * Open Personality persistence and build Core's own Personality integration.
   *
   * Ordered deliberately ahead of the Mind, and the reason is the fail-closed
   * contract rather than tidiness: the Mind's expression seam reads the
   * anti-repetition ledger *before* it plans a turn, so a ledger that arrived after
   * the Mind was constructed would be invisible to the first turn of the process —
   * and "invisible" here means "reads as empty", which is the exact failure this
   * lane refuses to have.
   *
   * Three things happen here and none of them is a provider call:
   *
   *   1. the encrypted store is opened, or an ephemeral one is substituted and
   *      labelled, so a machine with no keyring still gets a working relationship
   *      that honestly says it will not survive a restart;
   *   2. the retained snapshot is recovered and re-validated before anything reads
   *      it, with retired records re-tombstoned and the file rewritten *before*
   *      first use;
   *   3. the integration is constructed over that state, which is also when the
   *      session-start interaction fact is observed — a local instant comparison,
   *      not a schedule.
   */
  private async buildPersonality(): Promise<void> {
    const recovered = await PersonalityPersistenceRuntime.open({
      path: `${this.options.dataPath}.personality.enc`,
      key: this.options.personalityKey ?? null,
      now: (this.options.now ?? (() => new Date()))(),
      onHealthChange: () => {
        this.publishPersonality()
        void this.reportPersonalityDegraded()
      },
    })
    this.personalityPersistence = recovered.runtime
    // The seam is bound to the *runtime*, never to the integration: the
    // integration asks the runtime for durability, so a seam that answered by
    // asking the integration again would be a loop rather than a report. The
    // integration supplies the `retained` count on top, because only the domain
    // knows how many records it is holding.
    const runtime = recovered.runtime
    this.personalityDomain = new PersonalityIntegration({
      now: this.options.now ?? (() => new Date()),
      newId: this.newId,
      initialItems: recovered.items,
      initialLedger: recovered.ledger,
      maxItems: this.options.personalityLimits?.maxRelationshipItems,
      persistence: {
        commit: (items, ledger) => this.personalityPersistence?.commit(items, ledger),
        health: () => runtime.health(),
      },
      onChange: () => this.publishPersonality(),
      onLifecycle: (event) => this.recordPersonalityLifecycle(event),
    })
    // A store that could not be believed says so once, in its own stream, and the
    // reason is a fixed sentence: a decoder or filesystem error must never reflect
    // a private record back into the journal.
    await this.reportPersonalityDegraded()
    await this.personalityPersistence.flush()
  }

  /**
   * Announce a *damaged* Personality store, exactly once per process.
   *
   * A fault and a deliberate configuration are different things, and only the
   * first of them belongs in the journal. "This machine has no secure Personality
   * key" is the same ordinary situation as having no Context key: the projection
   * already reports `durable: false` with the reason in words, and putting it here
   * as well would make every keyring-less machine look faulty and would train a
   * reader to ignore the list. A store that *had* a key and could not be believed is
   * different — something was expected to work and did not — so that is what gets
   * written, once, with a fixed reason that cannot reflect a private record.
   *
   * Emphatically not a security event: it cannot grant cognition, clear a stop, or
   * lock anything out. See `SECURITY_EVENT_TYPES`.
   */
  private async reportPersonalityDegraded(): Promise<void> {
    const health = this.personalityDomain?.health() ?? this.personalityPersistence?.health() ?? null
    if (health === null) return
    if (health.faultReason === null) {
      this.personalityDegradedReported = false
      return
    }
    if (this.personalityDegradedReported) return
    this.personalityDegradedReported = true
    this.state = {
      ...this.state,
      faults: [...this.state.faults, `the Personality store could not be read: ${health.faultReason}`],
    }
    await this.fabric.append(
      'personality.degraded',
      { reason: health.faultReason, mode: health.mode, durable: false },
      { actor: 'system' },
    )
  }

  /**
   * Record a lifecycle transition in the journal. Metadata only, by construction.
   *
   * `PersonalityLifecycleEvent` has no field that could carry a record's text, the
   * owner's clause, or a sentence — an id, a code-owned slug, closed kind labels,
   * the trust class and a closed reason. That is what makes "no private
   * relationship text in the journal" a property of the type rather than of a
   * reviewer's attention, and it is the reason these events exist at all: C6 and
   * C12 both need the ability to see what was recorded and what ended, and neither
   * is satisfiable from a store only the owner can read.
   */
  private recordPersonalityLifecycle(event: PersonalityLifecycleEvent): void {
    void this.fabric.append(
      'personality.record_changed',
      {
        operation: event.operation,
        itemId: event.itemId,
        kind: event.kind,
        key: event.key,
        sourceType: event.sourceType,
        confidence: event.confidence,
        lifecycleReason: event.lifecycleReason,
        admitted: event.admitted,
        retained: event.retained,
      },
      { actor: 'system' },
    )
  }

  /**
   * Read the owner's message: record what it explicitly said, and nothing else.
   *
   * Two jobs, both about observation rather than interpretation, and both
   * synchronous — this runs after a turn has already been answered and stored, so
   * nothing here can delay or fail one.
   *
   *  1. **Interaction facts.** A greeting, and an exchange that actually reached a
   *     provider. These are events Core observed, so the closed `InteractionFact`
   *     shape is the whole vocabulary: there is no free text and no way for the
   *     owner's words to become a description of themselves.
   *  2. **Standing instructions.** The closed directive table either recognises an
   *     explicit instruction about how Freya should talk, or returns nothing. It is
   *     not a classifier and not a guesser; a phrase it was not given produces no
   *     record at all, which is the correct behaviour and is tested as such.
   *
   * The order matters and is the honest one: the fact is observed from what
   * actually happened, and *then* the record is written. A relationship can
   * therefore never precede the exchange that produced it.
   */
  private observeOwnerMessage(message: OwnerMessageEvent): void {
    const personality = this.personalityDomain
    if (personality === undefined) return
    const at = message.endedAt

    for (const fact of factsForOwnerMessage(message)) {
      personality.observe(fact.kind, at, message.turnId, fact.tags)
    }
    personality.readOwnerMessage(message.text, { turnId: message.turnId })
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
    if (this.brainService instanceof ProcessBrain) return null
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
    await this.brainService.recordExperience(turnExperienceRecord(experience))
  }

  private async buildConversationStore(): Promise<ConversationStore> {
    if (this.options.conversationStore) return this.options.conversationStore

    // The canonical durable path is the one SQLCipher Vault. When a Vault is
    // configured, conversation bodies never fall through to a second durable file:
    // either the Vault opens and owns them, or this process reports an explicitly
    // ephemeral conversation. That keeps "one encrypted structured store" true.
    if (this.options.vault !== undefined) {
      const vault = await this.ensureVault()
      if (vault !== null) return new VaultConversationStore(vault)
      return new MemoryConversationStore({
        mode: 'ephemeral',
        faultReason:
          `conversation history is held in memory only: ${this.vaultFault ?? 'the encrypted Vault is unavailable'}`,
      })
    }

    // Compatibility for test/embedding hosts that have not adopted the Vault yet.
    // Production Electron supplies the Vault, so this path is not a second write and
    // is never used as fallback after a Vault failure.
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
        this.recordRuntimeFault('core.conversation', 'conversation_store_open_failed', 'encrypted conversation history is unavailable', error)
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
    if (this.integrity.integrity === 'corrupt') {
      return { available: false, reason: 'journal-not-trustworthy' }
    }
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

  async detectVoiceWake(): Promise<boolean> { return this.voiceService ? this.voiceService.detectWake() : false }

  voice(): VoiceProjection {
    if (!this.voiceService) {
      // Before the service exists. `unsupported` rather than `ready`, because a
      // window that reads this during start-up must not render a live-looking
      // microphone for a Core that has not built one yet.
      return {
        state: 'unsupported',
        micEnabled: false,
        permission: 'unknown',
        permissionRequestOpen: false,
        capturing: false,
        sessionId: null,
        interim: '',
        finalTranscript: null,
        finalTranscriptAt: null,
        lastInterruption: null,
        transcription: { available: false, engine: null, kind: 'local', availability: 'unavailable', detail: 'Core has not started.' },
        synthesis: { available: false, engine: null, kind: 'platform', availability: 'unavailable', detail: 'Core has not started.' },
        speaking: false,
        queued: 0,
        muted: false,
        selectedVoiceId: null,
        autoSubmit: false,
        autoSpeak: false,
        attention: {
          active: false,
          state: 'standby',
          wakePhrase: 'Freya',
          attentiveUntil: null,
          followUpWindowMs: 45_000,
        },
        wake: {
          armed: false,
          available: false,
          gate: 'none',
          kind: 'speech-activity',
          detail: 'Core has not started.',
          maxArmedMs: 0,
        },
        limits: {
          maxDurationMs: 0,
          maxAudioBytes: 0,
          format: 'pcm-s16le',
          maxTranscriptCharacters: 0,
          transcriptionTimeoutMs: 0,
        },
        faults: [],
      }
    }
    return this.voiceService.projection()
  }

  /**
   * Subscribe to the voice projection.
   *
   * A mirror like the conversation one, and it exists because "is the microphone
   * open" is a fact that changes on somebody else's schedule: a permission prompt
   * resolving, a transcription finishing, STOP ALL landing. Without a push, every
   * indicator in every window would have to poll, and a polled indicator is one
   * that lies for a frame.
   */
  onVoice(listener: (projection: VoiceProjection) => void): () => void {
    if (!this.voiceService) return () => {}
    const dispose = this.voiceService.onChange(listener)
    // Pushed immediately, so a window attaching late is already correct.
    try {
      listener(this.voiceService.projection())
    } catch (error) {
      console.error('[freya.core] voice projection subscriber threw', error)
    }
    return dispose
  }

  /**
   * Subscribe to transcript fragments, interim and final.
   *
   * A separate channel from the projection because these are words in flight: a
   * window that wants to animate an interim line needs every fragment, and a
   * window that only cares about the final transcript should not be handed a
   * stream of guesses to filter. Interim text crossing this channel is display
   * text and nothing more — there is no command that would submit it.
   */
  onVoiceTranscript(listener: (fragment: VoiceTranscriptFragment) => void): () => void {
    if (!this.voiceService) return () => {}
    return this.voiceService.onTranscript(listener)
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
    const policy = new DefaultGuard()
    return {
      holds: (principal, capability) => policy.holds(principal, capability),
      evaluate: (principal, capability) => {
        // A missing STOP ALL in discarded security history must not authorize
        // external effects. Local reads and owner recovery controls still work.
        const externalEffect = ['cognition.request', 'search.web', 'browser.read', 'research.start', 'work.execute',
          'connector.connect', 'connector.read', 'connector.action'].includes(capability)
          || (capability.startsWith('relay.') && capability !== 'relay.status.read' && capability !== 'relay.approval.decide')
        if (externalEffect && this.integrity.integrity === 'corrupt') {
          return { allowed: false, outcome: 'deny', reason: 'journal-not-trustworthy' }
        }
        return policy.evaluate(principal, capability)
      },
    }
  }

  /**
   * The provider set for a normal runtime.
   *
   * MiniMax is preferred, followed by the configured NanoGPT, local and OpenAI
   * adapters. The Gateway applies the capability-specific saved order.
   *
   * The echo provider is opt-in and explicitly named, and it is listed last so
   * it never shadows a real provider when both are present.
   */
  private buildProviders(): ModelProvider[] {
    if (this.processRuntime) return this.processRuntime.providers.all()
    if (this.options.providers) return [...this.options.providers]
    const env = this.options.env ?? {}
    const providers = buildConfiguredModelProviders(env)
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

  /**
   * The one Guard check every voice command runs.
   *
   * Factored out rather than repeated because "did every voice command remember to
   * evaluate the Guard?" is exactly the kind of question a code review answers by
   * reading rather than by running, and a hand-written dispatcher with fifteen new
   * arms is where that answer goes stale.
   *
   * It returns a refusal envelope or `null`, so an arm reads as
   * `const refused = await this.guardVoice(requestId); if (refused) return refused`
   * — two lines, and the *next* arm cannot forget the check because the shape is
   * right there.
   *
   * The capability is `core.command.submit`, the same one `voice.capture.start`
   * used in Phase 3: voice is a surface of the owner's own Core, so it needs the
   * owner's standing ability to submit a command and nothing beyond it. It is not
   * `cognition.request`, because reading a stored answer aloud is not cognition —
   * the words already exist, and the turn that produced them was authorised when
   * it ran.
   */
  private async guardVoice(
    requestId: string,
  ): Promise<{ requestId: string; ok: false; refusal: { reason: string } } | null> {
    if (this.integrity.integrity === 'corrupt') {
      return { requestId, ok: false, refusal: { reason: 'journal-not-trustworthy' } }
    }
    const decision = this.guard.evaluate(this.owner, 'core.command.submit')
    if (decision.allowed) return null
    await this.recordGuard(decision, this.owner.id, 'core.command.submit', requestId)
    return { requestId, ok: false, refusal: { reason: decision.reason } }
  }

  /**
   * The stored answer for a turn, for playback.
   *
   * Bounded on purpose: the listing is capped by the conversation limits and each
   * record is read whole, so this is a lookup over a bounded set rather than a
   * scan of an unbounded history. It returns nothing unless the turn completed
   * *and* has an assistant message — a denied or cancelled turn has no answer, and
   * Freya does not read the question back.
   */
  private async storedAnswerFor(turnId: string): Promise<{ ok: boolean; text: string | null; reason: string | null }> {
    try {
      const summaries = await this.conversationStore.listConversations(CONVERSATION_LIMITS.maxConversationsListed)
      for (const summary of summaries) {
        const record = await this.conversationStore.readConversation(summary.conversationId)
        if (record === null) continue
        const turn = record.turns.find((candidate) => candidate.turnId === turnId)
        if (turn === undefined) continue
        if (turn.assistantMessageId === null) {
          return { ok: false, text: null, reason: 'that turn has no stored answer to read' }
        }
        const message = record.messages.find((candidate) => candidate.messageId === turn.assistantMessageId)
        if (message === undefined) {
          return { ok: false, text: null, reason: 'that turn has no stored answer to read' }
        }
        return { ok: true, text: message.content, reason: null }
      }
      return { ok: false, text: null, reason: 'no such turn' }
    } catch (error) {
      return {
        ok: false,
        text: null,
        reason: `the conversation store could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
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
    try {
      this.publishOffice()
    } catch (error) {
      console.error('[freya.core] Office notify threw', error)
    }
  }

  private recordRuntimeFault(component: string, event: string, reason: string, error: unknown): void {
    const fault = `${reason}: ${describe(error)}`
    this.state = { ...this.state, faults: [...this.state.faults, fault] }
    this.diagnostics?.recordError(component, event, error, reason)
    if (this.operational || this.lifecycle === 'ready') this.setLifecycle('degraded', reason)
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

function goalResult(outcome: GoalCommandOutcome): GoalCommandOutcomeView {
  return {
    operation: outcome.operation,
    ok: outcome.ok,
    ...(outcome.goalId === undefined ? {} : { goalId: outcome.goalId }),
    ...(outcome.state === undefined ? {} : { state: outcome.state }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
    ...(outcome.milestoneId === undefined ? {} : { milestoneId: outcome.milestoneId }),
    ...(outcome.budgetExhausted === undefined ? {} : { budgetExhausted: outcome.budgetExhausted }),
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

/**
 * Read the Workforce mirror without letting a throwing source take the world down.
 *
 * The mirror can come from a `WorkforceSource` seam, which is code this Core does not
 * own. One that throws must not be able to fail a *world* read, because a world read
 * is about what Freya believes and a broken Workforce seam is about something else
 * entirely. Only the fields the self model reports are read, and every one of them is
 * checked, because a seam that returns something else in `claims` must not be able to
 * put that into a projection.
 */
function safeWorkforceMirror(mirror: unknown): { workers: readonly {
  workerId: string
  claims: readonly { kind: string }[]
}[] } | null {
  if (typeof mirror !== 'object' || mirror === null) return null
  const workers = (mirror as { workers?: unknown }).workers
  if (!Array.isArray(workers)) return null
  return {
    workers: workers.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const worker = entry as { workerId?: unknown; claims?: unknown }
      if (typeof worker.workerId !== 'string') return []
      const claims = Array.isArray(worker.claims) ? worker.claims : []
      return [
        {
          workerId: worker.workerId,
          claims: claims.flatMap((claim) => {
            if (typeof claim !== 'object' || claim === null) return []
            const kind = (claim as { kind?: unknown }).kind
            return typeof kind === 'string' ? [{ kind }] : []
          }),
        },
      ]
    }),
  }
}

function degradedStatus(
  lifecycle: CoreLifecycle,
  state: CoreState,
  startedAt: string | null,
  persistence: { mode: 'durable' | 'ephemeral-fallback'; durable: boolean; reason: string | null; eventStorePath: string | null },
  operational: boolean,
  diagnostics: RuntimeDiagnostics | null,
  lastTransition: { from: CoreLifecycle; to: CoreLifecycle; at: string; reason: string | null } | null,
): CoreStatus {
  return {
    lifecycle,
    operational,
    eventSequence: 0,
    coreStartedAt: startedAt,
    stopAll: {
      active: state.stopAll.active,
      activatedAt: state.stopAll.activatedAt,
      activatedBy: state.stopAll.activatedBy,
    },
    integrity: {
      integrity: 'corrupt',
      reason: 'the event log could not be opened, so no durable state could be read',
      line: null,
      eventsRead: 0,
      bytesDiscarded: 0,
    },
    persistence,
    diagnostics: {
      path: diagnostics?.path ?? null,
      writeFailures: diagnostics?.failureCount ?? 0,
    },
    ...(lastTransition ? { lastLifecycleTransition: lastTransition } : {}),
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    // Booting has no answer; the only thing that *would* force deny_all is the
    // governor itself, which is built later. Until then, `unknown` is honest.
    governor: { status: 'unknown', grantsActive: 0 },
    providers: [],
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
 * unrecognised value is `null` rather than a coerced `false` ??? a window sending
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
/**
 * Normalise a capture payload for `validateAudio`.
 *
 * The bridge accepts the samples under `audio` — that is what a renderer has — and
 * the validator wants them under `bytes` with the metadata alongside. Both names
 * are also accepted on the way in, because a host that assembles the payload
 * itself should not have to know which half of that pair this function is.
 *
 * Everything else is passed through **unvalidated on purpose**: the whole point of
 * `validateAudio` is that it takes `unknown` and checks it. Re-checking here would
 * mean two validators that could disagree, and the one the renderer can reach
 * would be the one that decides.
 *
 * A base64 string is still accepted, because a structured-clone boundary cannot
 * always carry a `Uint8Array`, and decoding a base64 string here is not a parser
 * anyone can attack — `Buffer.from` either produces bytes or throws.
 */
function normaliseAudioPayload(payload: unknown): Record<string, unknown> {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const raw = record.audio ?? record.bytes
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : typeof raw === 'string'
        ? Buffer.from(raw, 'base64')
        : undefined
  return {
    ...record,
    bytes,
    // A caller-declared length is passed through rather than replaced, so
    // `validateAudio` can compare what the sender *said* the payload was against
    // what actually arrived. Overwriting it here would make that check vacuous, and
    // the check is the only thing that catches a sender confused about its own
    // buffer.
    byteLength: record.byteLength ?? bytes?.byteLength,
  }
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

/** The read action a read command names. Assigned by Core, never read from a payload. */
function readActionFor(command: string): RelayAction {
  switch (command) {
    case 'relay.email.read':
      return 'email.read'
    case 'relay.calendar.read':
      return 'calendar.read'
    case 'relay.github.read':
      return 'github.read'
    case 'relay.drive.read':
      return 'drive.read'
    case 'relay.telegram.read':
      return 'telegram.read'
    default:
      return 'email.read'
  }
}

/** The write action a write command names. Assigned by Core, never read from a payload. */
function writeActionFor(command: string): RelayAction {
  switch (command) {
    case 'relay.email.draft.create':
      return 'email.draft.create'
    case 'relay.email.send':
      return 'email.send'
    case 'relay.calendar.create':
      return 'calendar.create'
    case 'relay.calendar.update':
      return 'calendar.update'
    case 'relay.calendar.cancel':
      return 'calendar.cancel'
    case 'relay.github.issue.create':
      return 'github.issue.create'
    case 'relay.github.pr.create':
      return 'github.pr.create'
    case 'relay.drive.file.create':
      return 'drive.file.create'
    case 'relay.telegram.send':
      return 'telegram.send'
    case 'relay.external.invoke':
      return 'external.invoke'
    default:
      return 'external.invoke'
  }
}

/** The renderer-safe shape of a Relay refusal. */
function relayRefusal(result: { failureCode: RelayFailureCode; reason: string }): RelayCommandOutcome {
  return {
    operation: 'refused',
    ok: false,
    failureCode: result.failureCode,
    reason: result.reason,
  }
}

/** The renderer-safe shape of a connector action's outcome. */
function connectorEngineOutcome(result: ConnectorEngineResult): ConnectorCommandOutcome {
  if (!result.ok) {
    return { operation: 'refused', ok: false, failureCode: result.failureCode, reason: result.reason }
  }
  if (result.kind === 'read') {
    return { operation: 'read', ok: true, result: result.result }
  }
  if (result.kind === 'pending') {
    return {
      operation: 'pending',
      ok: true,
      actionId: result.actionId,
      approvalId: result.approvalId,
      status: 'pending_approval',
    }
  }
  return { operation: 'replayed', ok: true, actionId: result.actionId, status: result.status }
}

/**
 * Parse a `life.timeline.read` payload.
 *
 * A bounded limit, known entry kinds and a withdrawal flag — nothing else. A
 * field outside this list is refused rather than dropped, so a window still
 * sending a `status` or a `confidence` is told the read takes none.
 */
function readLifeTimelineQuery(
  payload: unknown,
): { limit?: number; kinds?: LifeEntryKind[]; includeWithdrawn?: boolean } | null {
  if (payload === undefined || payload === null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'limit' && key !== 'kinds' && key !== 'includeWithdrawn') return null
  }
  const query: { limit?: number; kinds?: LifeEntryKind[]; includeWithdrawn?: boolean } = {}
  if (record.limit !== undefined) {
    if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 0) return null
    query.limit = record.limit
  }
  if (record.kinds !== undefined) {
    if (!Array.isArray(record.kinds) || record.kinds.length > 8) return null
    const kinds: LifeEntryKind[] = []
    for (const kind of record.kinds) {
      if (!isLifeEntryKind(kind)) return null
      kinds.push(kind)
    }
    query.kinds = kinds
  }
  if (record.includeWithdrawn !== undefined) {
    if (typeof record.includeWithdrawn !== 'boolean') return null
    query.includeWithdrawn = record.includeWithdrawn
  }
  return query
}

/** The renderer-safe shape of a Mind turn result. */
function toTurnView(turn: {
  turnId: string
  conversationId: string
  outcome: string
  reason: string | null
  assistantMessage: {
    missionProposal?: ChatMissionProposal
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
          ...(turn.assistantMessage.missionProposal ? { missionProposal: turn.assistantMessage.missionProposal } : {}),
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

/**
 * Narrow a payload's `intents` field to the closed set the Mind accepts.
 *
 * The renderer is the only writer of these fields, but it is also the renderer
 * that was the source of the contamination class this whole seam exists to
 * stop: a renderer that could send `intents.text: "open the owner browser as
 * soon as possible"` would be a renderer that could route its own tools. The
 * helper reads exactly the two closed names, in their closed type (`boolean`),
 * and drops anything else on the floor. An absent or malformed payload reads
 * as `undefined`, which is the conservative choice — the Mind's text-derived
 * routing then runs untouched.
 */
function readTurnIntentHints(
  value: unknown,
): { readonly webSearch?: boolean; readonly browserUse?: boolean } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  let webSearch: boolean | undefined
  let browserUse: boolean | undefined
  if (typeof record['webSearch'] === 'boolean') webSearch = record['webSearch']
  if (typeof record['browserUse'] === 'boolean') browserUse = record['browserUse']
  const reasoningEffort = typeof record['reasoningEffort'] === 'string' && /^[a-z0-9_-]{1,32}$/i.test(record['reasoningEffort']) ? record['reasoningEffort'] : undefined
  if (webSearch === undefined && browserUse === undefined && reasoningEffort === undefined) return undefined
  return {
    ...(webSearch === undefined ? {} : { webSearch }),
    ...(browserUse === undefined ? {} : { browserUse }),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

/**
 * Parse a provider's answer into one of the loop's five closed outcomes.
 *
 * Deliberately brutal, and deliberately one-directional. The whole word has to
 * appear, and the first one that does wins — so "I will not interrupt you" reads as
 * `interrupt`, which is the *safe* direction, and anything unrecognised reads as
 * `do-nothing`, which is the quiet one. Neither default can turn a confused answer
 * into something that reaches for a human being's attention, and that is the only
 * property this function has to have: the loop's authority to speak comes from the
 * wake and the filter, never from what a model typed.
 */
function readDecideOutcome(text: string): DecideOutcome {
  const lower = text.toLowerCase()
  for (const outcome of DECIDE_OUTCOMES) {
    if (lower.includes(outcome)) return outcome
  }
  return 'do-nothing'
}

/**
 * Which Attention source a life-loop escalation is raised under.
 *
 * Mapped from the wake's kind rather than from a `system` default, and that is the
 * whole point: `system` carries the highest importance cap in the attention policy,
 * so a loop that raised its own escalations as `system` could buy itself an
 * importance it never earned. A Mission's escalation is raised as a Mission's.
 */
function lifeLoopAttentionSource(kind: WakeKind): AttentionSource {
  if (kind.startsWith('mission-')) return 'mission'
  if (kind.startsWith('run-') || kind === 'step-verified') return 'work'
  if (kind === 'research-completed') return 'research'
  if (kind === 'schedule-due') return 'system'
  return 'context'
}

/**
 * The closed attention kind for one life-loop kind.
 *
 * Fixed sentences and a fixed kind. No model prose crosses into Attention, because
 * Attention holds event text in process memory for an explicit owner read and that
 * store must never become a place a provider's sentence is kept.
 */
function lifeLoopAttentionKind(kind: WakeKind): AttentionEventKind {
  if (kind === 'mission-completed') return 'mission-finished'
  if (kind === 'mission-failed') return 'mission-failed'
  if (kind === 'run-completed') return 'work-finished'
  if (kind === 'run-failed') return 'work-failed'
  if (kind === 'research-completed') return 'research-finished'
  if (kind === 'system-health') return 'system-health'
  // `needs-attention` is not in the closed vocabulary, so the fallback is the kind
  // that exists for exactly this case: something Freya was waiting for. Naming a
  // kind that does not exist would be refused by the policy rather than recorded.
  return 'deadline'
}

function lifeLoopAttentionText(kind: WakeKind): string {
  switch (kind) {
    case 'mission-completed':
      return 'A mission finished and Freya has something to say about it.'
    case 'mission-failed':
      return 'A mission did not finish, and Freya has something to say about it.'
    case 'run-completed':
      return 'A run finished and Freya has something to say about it.'
    case 'run-failed':
      return 'A run did not finish, and Freya has something to say about it.'
    case 'research-completed':
      return 'Research finished and Freya has something to say about it.'
    case 'system-health':
      return 'Something about Freya herself needs attention.'
    default:
      return 'Something Freya was waiting for happened.'
  }
}

/**
 * Which life-loop wake an authoritative Core event raises, if any.
 *
 * A pure table over event *types*. Nothing is read from a payload, so an event
 * cannot describe itself as a louder wake than it is, and the source and kind that
 * come back are a matched pair from the closed registry — `run-completed` arrives
 * as `work-transition`/`run-completed` and never as `authorized-event`.
 *
 * The actor is fixed here rather than derived, because attribution is Core's job:
 * the loop's job is to check it, and `WAKE_SOURCE_ACTOR` says `core-subsystem` is
 * the only actor permitted to raise a mission or work transition.
 */
function lifeLoopWakeFor(event: AnyCoreEvent): LifeLoopWakeRequest | null {
  const occurredAt = event.occurredAt
  switch (event.type) {
    case 'mission.activated':
      return wakeFor('mission-transition', 'mission-activated', event.payload.missionId, occurredAt)
    case 'mission.completed':
      return wakeFor('mission-transition', 'mission-completed', event.payload.missionId, occurredAt)
    case 'mission.failed':
      return wakeFor('mission-transition', 'mission-failed', event.payload.missionId, occurredAt)
    case 'work.run.started':
      return wakeFor('work-transition', 'run-started', event.payload.runId, occurredAt)
    case 'work.run.completed':
      return wakeFor('work-transition', 'run-completed', event.payload.runId, occurredAt)
    case 'work.run.failed':
      return wakeFor('work-transition', 'run-failed', event.payload.runId, occurredAt)
    case 'research.completed':
      return wakeFor('authorized-event', 'research-completed', event.payload.operationId, occurredAt)
    // Deliberately **no** mapping for `research.failed`. The wake vocabulary is
    // closed and has no `research-failed` kind, and `system-health` would be a lie:
    // an operation that did not complete says nothing about Freya's own health. A
    // failed research therefore does not wake the loop at all — which is the correct
    // reading, because the event it did write is already visible to the owner and
    // inventing a louder wake for it is how a routine failure becomes an
    // interruption.
    default:
      return null
  }
}

function wakeFor(
  source: LifeLoopWakeRequest['source'],
  kind: WakeKind,
  reference: string,
  occurredAt: string,
): LifeLoopWakeRequest {
  return {
    source,
    kind,
    actor: source === 'scheduled-heartbeat' ? 'host-heartbeat' : 'core-subsystem',
    // The reference is also the goal: a run id *is* how Core's own `attentionGoalOpen`
    // addresses an open run, and inventing a second addressing scheme here would
    // create a way for the loop to hold a goal nothing else can be asked about.
    goalRef: reference,
    sourceRef: reference,
    occurredAt,
  }
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

export type { AnyCoreEvent, ExecutiveDecisionOutcome, ExecutiveState }

/**
 * A research result as the renderer sees it.
 *
 * Sources keep their URL, because a person needs it to check a claim and a citation
 * that cannot be followed is decoration. Failures keep a closed code, never the
 * message a provider threw — which may carry a credential or a path.
 */
function projectSearchSession(
  session: SearchSession,
  store: SearchSessionStore,
): NonNullable<ResearchCommandOutcome['session']> {
  return {
    sessionId: session.sessionId,
    ...(session.ownerText === undefined ? {} : { ownerText: session.ownerText }),
    state: session.state,
    intentVersion: session.intentVersion,
    intent: {
      subject: session.intent.subject,
      targetCount: session.intent.targetCount,
      mediaType: session.intent.mediaType,
      constraints: [...session.intent.constraints],
      exclusions: [...session.intent.exclusions],
      site: session.intent.site,
    },
    page: session.page,
    resultCount: session.results.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastError: session.lastError,
    persistence: {
      mode: store.mode,
      durable: store.durable,
      reason: store.reason,
    },
    results: session.results.slice(0, 100).map((result) => ({
      resultId: result.resultId,
      rank: result.rank,
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      sourceDomain: result.sourceDomain,
      providerId: result.providerId,
      retrievedAt: result.retrievedAt,
      vertical: result.vertical,
      mediaUrl: result.mediaUrl,
      thumbnailUrl: result.thumbnailUrl,
      pageUrl: result.pageUrl,
      mediaType: result.mediaType,
      metadata: result.metadata,
      confidence: result.confidence,
      collection: result.collection,
    })),
  }
}

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
