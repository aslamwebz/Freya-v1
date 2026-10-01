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
import type { ContextBudget } from './mind/context-compiler'
import type { ConversationProjection, ConversationTurnView, VoiceProjection } from './protocol/conversation'
import { describeActivity, mergeActivity } from './protocol/activity'
import type { CoreActivityEvent } from './protocol/activity'
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
}

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

  constructor(private readonly options: CoreOptions) {
    this.newId = options.newId ?? (() => randomUUID())
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
      // The conversation service is built after the Mind, so this resolves lazily
      // and is the only thing that couples the two. Without it a window would only
      // learn a turn had started after it had already finished.
      onTurnStateChange: () => this.conversations?.publish(),
      // The only fact about the outside world the Mind is told, and it is a fact
      // about Freya rather than about any provider.
      runtimeFacts: () => (this.state.stopAll.active ? ['Cognition is currently stopped.'] : []),
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
      command !== 'brain.status.read'
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
          // reason. The gateway is what stops a model turn; research also reaches
          // the network and a browser, and neither is behind the gateway gate. A
          // research job cancelled only after an await would still be able to issue
          // its next search, and that next search is the request the owner just
          // asked to stop.
          this.closeResearch(`STOP ALL: ${reason}`)

          try {
            const event = await this.fabric.append(
              'security.stop_all.activated',
              { by: this.owner.id, reason },
              { actor: this.owner.id, correlationId: requestId },
            )
            // The conversation projection reports whether Freya is stopped and
            // whether she can think, so a stop has to refresh it. Without this a
            // Chat window keeps a composer it believes is still open.
            this.conversations?.publish()
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
            this.conversations?.publish()
            return { requestId, ok: true, status: this.status() }
          }
          const event = await this.fabric.append(
            'security.stop_all.cleared',
            { by: this.owner.id },
            { actor: this.owner.id, correlationId: requestId },
          )
          this.gateway?.resume()
          // As above: a resume has to reach the surfaces that report it, or Chat
          // stays visibly locked after Core has reopened.
          this.conversations?.publish()
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
          const result = await this.researchIntegration!.research(question)
          return {
            requestId,
            ok: true,
            status: this.status(),
            research: { operation: 'research', operationId: result.id, limits: this.researchLimits(), result: projectResearch(result) },
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

/** A valid CoreStatus for a Core whose log is not open. */
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
