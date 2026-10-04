import { evaluateRequirements, degradedRequirements, missingRequirements } from './dependencies'
import { initialRuntimeFold, reduceRuntimeEntry } from './state'
import type {
  RuntimeDependencyEvidence,
  RuntimeDomainDescriptor,
  RuntimeDomainView,
  RuntimeEventType,
  RuntimeFacts,
  RuntimeFoldState,
  RuntimeJournalEntry,
  RuntimeLifecycle,
  RuntimePayload,
  RuntimeProjection,
  RuntimeStatus,
} from './types'
import { EMPTY_COUNTS } from './types'

/**
 * The runtime activation controller.
 *
 * One owner for activation, start, stop, restart and the activation record. It
 * is deterministic in three senses:
 *
 *   - **Order.** Domains activate in registry order and stop in reverse, so STOP
 *     ALL is always the last thing released and the first thing recorded.
 *   - **Idempotency.** An entry whose sequence is not greater than the last
 *     applied is ignored; a handler is started once and stopped once; a status
 *     that has not changed is not journalled again.
 *   - **No self-activation.** A domain can only be activated by this controller
 *     from a fact set it was handed. There is no method on a domain that reaches
 *     the controller, and no way for a handler to widen its own status.
 *
 * The controller holds no authority of its own: it cannot grant a capability,
 * clear a stop, approve anything or contact a model. Every status it reports is
 * either a dependency measurement or a journaled decision.
 */

/** The durable journal the controller records into. */
export interface RuntimeJournalPort {
  append(type: RuntimeEventType, payload: RuntimePayload): Promise<void>
  replay(): Promise<readonly RuntimeJournalEntry[]>
}

/**
 * What a wired domain has to offer.
 *
 * `start` and `stop` must be idempotent; the controller also guards them. A
 * handler is the only place a domain can have a side effect, and it is called
 * only by the controller.
 */
export interface RuntimeActivationHandler {
  readonly id: string
  start(): Promise<void>
  stop(reason: string): Promise<void>
}

export interface RuntimeActivationControllerOptions {
  readonly journal: RuntimeJournalPort
  readonly now?: () => string
  readonly onChange?: () => void
}

interface ComputedDomain {
  readonly descriptor: RuntimeDomainDescriptor
  readonly evidence: readonly RuntimeDependencyEvidence[]
  readonly missing: readonly string[]
  readonly degraded: readonly string[]
  readonly status: RuntimeStatus
  readonly reason: string
  readonly outcome: 'allowed' | 'blocked'
  readonly stopRelated: boolean
}

/** The security spine is never stopped by STOP ALL: it is what enforces it. */
const STOP_ALL_EXEMPT = 'core.security-spine'

function defaultNow(): string {
  return new Date().toISOString()
}

export class RuntimeActivationController {
  private readonly journal: RuntimeJournalPort
  private readonly now: () => string
  private readonly onChange: () => void

  private descriptors: readonly RuntimeDomainDescriptor[] = []
  private readonly handlers = new Map<string, RuntimeActivationHandler>()
  private readonly started = new Set<string>()
  private fold: RuntimeFoldState = initialRuntimeFold()
  private facts: RuntimeFacts | null = null
  private lifecycle: RuntimeLifecycle = 'unstarted'
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: RuntimeActivationControllerOptions) {
    this.journal = options.journal
    this.now = options.now ?? defaultNow
    this.onChange = options.onChange ?? (() => {})
  }

  register(
    descriptors: readonly RuntimeDomainDescriptor[],
    handlers: readonly RuntimeActivationHandler[] = [],
  ): void {
    this.descriptors = [...descriptors].sort((a, b) => a.order - b.order)
    this.handlers.clear()
    for (const handler of handlers) this.handlers.set(handler.id, handler)
  }

  /** Rehydrate the fold from the durable activation journal. */
  async load(facts: RuntimeFacts): Promise<RuntimeProjection> {
    return await this.enqueue(async () => {
      const entries = await this.journal.replay()
      let fold = initialRuntimeFold()
      for (const entry of entries) fold = reduceRuntimeEntry(fold, entry)
      this.fold = fold
      await this.apply(facts, { restart: true })
      return this.buildProjection()
    })
  }

  /** Re-evaluate every domain against a fresh fact set. */
  async refresh(facts: RuntimeFacts): Promise<RuntimeProjection> {
    return await this.enqueue(async () => {
      await this.apply(facts, {})
      return this.buildProjection()
    })
  }

  /**
   * STOP ALL.
   *
   * Every active domain except the security spine is stopped, in reverse order,
   * and the stop is recorded with the reason. The spine is exempt because a
   * stopped Guard is a Guard that cannot enforce the stop.
   */
  async stopAll(reason: string, facts?: RuntimeFacts): Promise<RuntimeProjection> {
    return await this.enqueue(async () => {
      const base = facts ?? this.facts
      if (base === null) {
        this.lifecycle = 'stopped-all'
        return this.buildProjection()
      }
      await this.apply(base, { stopAllActive: true, stopReason: reason })
      return this.buildProjection()
    })
  }

  /** The owner cleared STOP ALL; re-evaluate and re-activate what is eligible. */
  async resume(facts: RuntimeFacts): Promise<RuntimeProjection> {
    return await this.enqueue(async () => {
      await this.apply(facts, { stopAllActive: false })
      return this.buildProjection()
    })
  }

  /** Restart: stop every started handler, then re-evaluate and re-activate. */
  async restart(facts: RuntimeFacts, reason = 'restart'): Promise<RuntimeProjection> {
    return await this.enqueue(async () => {
      await this.stopHandlers(reason)
      await this.apply(facts, { restart: true })
      return this.buildProjection()
    })
  }

  /** Core is shutting down. Stop handlers and record the reason; no re-activation. */
  async shutdown(reason: string): Promise<void> {
    await this.enqueue(async () => {
      const ordered = [...this.descriptors].sort((a, b) => b.order - a.order)
      for (const descriptor of ordered) {
        if (this.started.has(descriptor.id)) {
          await this.stopHandler(descriptor.id, reason)
        }
        const record = this.fold.domains.get(descriptor.id)
        if (record && (record.status === 'active' || record.status === 'degraded')) {
          await this.record('runtime.activation.stopped', {
            domainId: descriptor.id,
            reason,
            missing: [],
          })
        }
      }
      this.lifecycle = 'stopped'
      this.onChange()
    })
  }

  projection(): RuntimeProjection {
    return this.buildProjection()
  }

  /* ------------------------------------------------------------- internals */

  private async apply(
    facts: RuntimeFacts,
    options: { restart?: boolean; stopAllActive?: boolean; stopReason?: string },
  ): Promise<void> {
    this.facts = facts
    this.lifecycle = 'evaluating'
    const stopAllActive = options.stopAllActive ?? facts.stopAllActive

    const computedDomains = this.descriptors.map((descriptor) => ({
      descriptor,
      computed: this.compute(descriptor, facts, stopAllActive),
    }))

    // Decisions are recorded in activation order, so the journal reads the same
    // way a start does.
    for (const { descriptor, computed } of computedDomains) {
      const previous = this.fold.domains.get(descriptor.id)

      if (previous === undefined) {
        await this.record('runtime.activation.decided', {
          domainId: descriptor.id,
          outcome: computed.outcome,
          status: computed.status,
          reason: computed.reason,
          missing: [...computed.missing],
          requestedAt: this.now(),
        })
      } else if (
        options.restart === true &&
        (previous.status === 'active' || previous.status === 'degraded')
      ) {
        await this.record('runtime.activation.reconciled', {
          domainId: descriptor.id,
          previousStatus: previous.status,
          status: computed.status,
          reason: computed.reason,
          missing: [...computed.missing],
        })
      } else if (previous.status !== computed.status) {
        if (computed.stopRelated && (previous.status === 'active' || previous.status === 'degraded')) {
          await this.record('runtime.activation.stopped', {
            domainId: descriptor.id,
            reason: options.stopReason ?? computed.reason,
            missing: [...computed.missing],
          })
        } else {
          await this.record('runtime.activation.changed', {
            domainId: descriptor.id,
            from: previous.status,
            to: computed.status,
            reason: computed.reason,
            missing: [...computed.missing],
          })
        }
      }
    }

    // Start in activation order.
    for (const { descriptor, computed } of computedDomains) {
      const shouldRun = computed.status === 'active' || computed.status === 'degraded'
      const handler = this.handlers.get(descriptor.id)
      if (shouldRun && handler && !this.started.has(descriptor.id)) {
        await handler.start()
        this.started.add(descriptor.id)
      }
    }

    // Stop in reverse activation order, with the caller's reason when there is
    // one. The security spine is never stopped here because `compute` keeps it
    // active during STOP ALL.
    for (const { descriptor, computed } of [...computedDomains].reverse()) {
      const shouldRun = computed.status === 'active' || computed.status === 'degraded'
      if (!shouldRun && this.started.has(descriptor.id)) {
        await this.stopHandler(descriptor.id, options.stopReason ?? computed.reason)
      }
    }

    this.lifecycle = stopAllActive
      ? 'stopped-all'
      : facts.coreLifecycle === 'stopped' || facts.coreLifecycle === 'stopping'
        ? 'stopped'
        : 'active'
    this.onChange()
  }

  private async stopHandler(domainId: string, reason: string): Promise<void> {
    const handler = this.handlers.get(domainId)
    if (!handler || !this.started.has(domainId)) return
    await handler.stop(reason)
    this.started.delete(domainId)
  }

  private async stopHandlers(reason: string): Promise<void> {
    const ordered = [...this.descriptors].sort((a, b) => b.order - a.order)
    for (const descriptor of ordered) await this.stopHandler(descriptor.id, reason)
  }

  /**
   * The whole decision for one domain.
   *
   * Precedence is fixed and stated rather than emergent: fail-closed beats
   * everything; STOP ALL beats dependency state; a missing required dependency
   * beats an otherwise-available domain; and only then does the activation mode
   * decide between active, degraded and available.
   */
  private compute(
    descriptor: RuntimeDomainDescriptor,
    facts: RuntimeFacts,
    stopAllActive: boolean,
  ): ComputedDomain {
    const evidence = evaluateRequirements(descriptor.requirements, facts)
    const missing = missingRequirements(evidence)
    const degraded = degradedRequirements(evidence)
    const base = { descriptor, evidence, missing, degraded }

    if (descriptor.activation === 'fail-closed') {
      return {
        ...base,
        status: 'blocked',
        reason: descriptor.note,
        outcome: 'blocked',
        stopRelated: false,
      }
    }

    if (stopAllActive && descriptor.id !== STOP_ALL_EXEMPT) {
      return {
        ...base,
        status: 'blocked',
        reason: 'STOP ALL is active',
        outcome: 'blocked',
        stopRelated: true,
      }
    }

    if (missing.length > 0) {
      return {
        ...base,
        status: 'blocked',
        reason: `missing required dependency: ${missing.join('; ')}`,
        outcome: 'blocked',
        stopRelated: false,
      }
    }

    if (descriptor.activation === 'blocked') {
      return {
        ...base,
        status: 'blocked',
        reason: descriptor.note,
        outcome: 'blocked',
        stopRelated: false,
      }
    }

    if (descriptor.activation === 'core-owned') {
      if (facts.coreLifecycle !== 'ready' && facts.coreLifecycle !== 'degraded') {
        return {
          ...base,
          status: 'blocked',
          reason: `Core is ${facts.coreLifecycle}; it has not reached ready`,
          outcome: 'blocked',
          stopRelated: false,
        }
      }
      if (degraded.length > 0) {
        return {
          ...base,
          status: 'degraded',
          reason: `running with reduced capability: ${degraded.join('; ')}`,
          outcome: 'allowed',
          stopRelated: false,
        }
      }
      return {
        ...base,
        status: 'active',
        reason: 'owned and running under this Core',
        outcome: 'allowed',
        stopRelated: false,
      }
    }

    // Activatable: a wired handler makes it active; without one it is available
    // and dependency-checked, which is the honest reading rather than a claim.
    if (this.handlers.has(descriptor.id)) {
      return {
        ...base,
        status: 'active',
        reason: 'activated by the runtime activation controller',
        outcome: 'allowed',
        stopRelated: false,
      }
    }
    return {
      ...base,
      status: 'available',
      reason: 'dependencies satisfied; no activation handler is wired in this build',
      outcome: 'allowed',
      stopRelated: false,
    }
  }

  private async record(type: RuntimeEventType, payload: RuntimePayload): Promise<void> {
    try {
      await this.journal.append(type, payload)
    } catch (error) {
      // A journal that cannot record a decision is a journal that cannot be
      // trusted about it, but the activation system must not take Core down with
      // it. The status stays where it was; the failure is reported once.
      console.error('[freya.runtime] an activation decision could not be recorded', error)
      return
    }
    this.fold = reduceRuntimeEntry(this.fold, {
      sequence: this.fold.lastSequence + 1,
      type,
      payload,
      recordedAt: this.now(),
    })
  }

  private buildProjection(): RuntimeProjection {
    const facts = this.facts
    const domains: RuntimeDomainView[] = this.descriptors.map((descriptor) => {
      const record = this.fold.domains.get(descriptor.id)
      const evidence = facts
        ? evaluateRequirements(descriptor.requirements, facts)
        : []
      const missing = record?.missing ?? (evidence.length > 0 ? missingRequirements(evidence) : [])
      return {
        id: descriptor.id,
        family: descriptor.family,
        title: descriptor.title,
        module: descriptor.module,
        kind: descriptor.kind,
        activation: descriptor.activation,
        status: record?.status ?? 'registered',
        reason: record?.reason ?? 'registered but not yet evaluated',
        missing,
        evidence,
        activatedAt: record?.activatedAt ?? null,
        changedAt: record?.changedAt ?? null,
        lastOutcome: record?.lastOutcome ?? null,
        note: descriptor.note,
      }
    })

    const counts: Record<RuntimeStatus, number> = { ...EMPTY_COUNTS }
    for (const domain of domains) counts[domain.status] += 1

    return {
      lifecycle: this.lifecycle,
      generatedAt: this.now(),
      stopAllActive: this.lifecycle === 'stopped-all',
      counts,
      domains,
      active: domains
        .filter((domain) => domain.status === 'active' || domain.status === 'degraded')
        .map((domain) => domain.id),
      blocked: domains
        .filter((domain) => domain.status === 'blocked')
        .map((domain) => ({ id: domain.id, reason: domain.reason, missing: domain.missing })),
      degraded: domains
        .filter((domain) => domain.status === 'degraded')
        .map((domain) => ({ id: domain.id, reason: domain.reason })),
      lastStopReason: this.fold.lastStopReason,
      lastReconciledAt: this.fold.lastReconciledAt,
      recoveredDomains: this.fold.recoveredDomains,
    }
  }

  /** Serialise every mutation, and never let a throw escape into Core. */
  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }
}
