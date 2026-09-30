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
import { FakeModelProvider } from './model/fake-provider'
import { NanoGptProvider, readNanoGptConfig, type NanoGptEnv } from './model/nanogpt-provider'
import { describeActivity, mergeActivity } from './protocol/activity'
import type { CoreActivityEvent } from './protocol/activity'
import type { Capability, CognitionCause, CognitionOrigin } from './protocol/core-protocol'
import type { CognitionGrantSpec } from './cognition/grants'
import type { OwnerAuthority, WorkerAuthority } from './authority'
import type {
  CoreCommandEnvelope,
  CoreCommandResult,
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

export interface CoreOptions {
  /** Where the durable log lives. */
  dataPath: string
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
   * Developer seam: add the local echo provider to the production set.
   *
   * Named for what it is and opt-in, because the failure mode it guards against
   * is a build that appears to work while answering from a canned string. It is
   * never inferred from a debug flag, a test runner, or an absent credential.
   */
  developerEchoProvider?: boolean
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
  /** Display-ready activity, rebuilt from the log on every start. */
  private activityFeed: CoreActivityEvent[] = []
  private readonly newId: () => string
  private disposeState: () => void = () => {}
  private stopped = false

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
      store = await JsonlEventStore.open(this.options.dataPath)
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

    // State follows the log, for both replay and live appends.
    this.disposeState = this.fabric.subscribe((event) => {
      this.state = reduceCoreState(this.state, event)
      this.recordActivity(event)
      this.notify()
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
      if (this.fabric) {
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
      await this.fabric?.close()
      this.notify()
    }
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

          try {
            const event = await this.fabric.append(
              'security.stop_all.activated',
              { by: this.owner.id, reason },
              { actor: this.owner.id, correlationId: requestId },
            )
            return { requestId, ok: true, status: this.status(), durableSequence: event.sequence }
          } catch (error) {
            // No latch was written, so there is no stop to keep. Leaving the
            // gate shut would refuse everything with nothing durable to explain
            // it, and nothing would ever open it again — so the gate goes back to
            // how it was and the failure is reported.
            this.gateway?.resume()
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
            // The gate is reopened even when there was no latch, because this is
            // the only command that can legitimately open it and an already-open
            // gate is not a capability worth withholding. It restores permission
            // and does nothing else: no cancelled request is restarted, no
            // reservation is returned, and no result is replayed.
            this.gateway?.resume()
            return { requestId, ok: true, status: this.status() }
          }
          const event = await this.fabric.append(
            'security.stop_all.cleared',
            { by: this.owner.id },
            { actor: this.owner.id, correlationId: requestId },
          )
          this.gateway?.resume()
          return { requestId, ok: true, status: this.status(), durableSequence: event.sequence }
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
    if (this.options.developerEchoProvider === true) providers.push(new FakeModelProvider())
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
          record,
          { actor: 'system', correlationId: record.requestId },
        )
      },
      cancelled: async (record) => {
        await this.fabric.append(
          'model.request.cancelled',
          record,
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
