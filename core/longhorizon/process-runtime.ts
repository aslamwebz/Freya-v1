import { AsyncLocalStorage } from 'node:async_hooks'
import type { RpcPeer } from '../../shared/runtime/rpc'
import type { EventFabric } from '../events/fabric'
import type { AnyCoreEvent } from '../events/envelope'
import { GoalEngine } from './engine'
import { ContinuationEngine } from './continuation'
import { VerificationEngine } from './verification'
import { GOAL_REASONS } from './types'
import type { GoalStore } from './store'
import type { GoalPacket, GoalViewPacket } from './process-contract'

export class ProcessGoalRuntime {
  private engine: GoalEngine | null = null
  private continuation: ContinuationEngine | null = null
  private verification: VerificationEngine | null = null
  private readonly leases = new AsyncLocalStorage<{ id: string; failure?: Error }>()
  private connection: RpcPeer | null = null
  private stopped = true
  private operation<T>(method: string, ...args: unknown[]): Promise<T> {
    const lease = this.leases.getStore()
    if (!lease || !this.connection?.connected) throw new Error('Goal effect has no connected Core lease')
    return this.connection.call<T>(method, { id: lease.id, args })
  }
  private view(): GoalViewPacket {
    const engine = this.engine!
    return { projection: engine.projection(), eligible: [...engine.state().goals.keys()].filter(id => engine.hasEligibleMilestone(id)) }
  }
  async configure(connection: RpcPeer, packet: GoalPacket) {
    if (packet.version !== 1) throw new Error('unsupported Goal transport version')
    await this.close(); this.connection = connection; this.stopped = packet.stopped
    const listeners = new Set<(event: AnyCoreEvent) => void>()
    const fabric = { replay: async <S>(initial: S, reduce: (state: S, event: AnyCoreEvent) => S) => packet.events.reduce(reduce, initial),
      subscribe: (listener: (event: AnyCoreEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      append: async (type: string, payload: unknown) => {
        try {
          const event = await this.operation<AnyCoreEvent>('goal.event', type, payload)
          for (const listener of listeners) listener(event)
          return event
        } catch (error) { const lease = this.leases.getStore(); if (lease) lease.failure = error as Error; throw error }
      } } as unknown as EventFabric
    const store: GoalStore = { ...packet.store, health: () => packet.store.health, close: async () => {},
      write: content => this.operation('goal.store.write', content), read: id => this.operation('goal.store.read', id), remove: id => this.operation('goal.store.remove', id) }
    const verification = new VerificationEngine({ fabric, principalId: packet.principalId, stopAll: () => this.stopped,
      goals: { recordCheckpointOutcome: (...args) => this.engine!.recordCheckpointOutcome(...args),
        checkpointAttempts: (...args) => this.engine!.checkpointAttempts(...args), goalRetryCount: id => this.engine!.goalRetryCount(id) } })
    this.verification = verification
    const engine = new GoalEngine({ store, fabric, principalId: packet.principalId, stopAll: () => this.stopped,
      continuation: { verifyCheckpoint: async (goalId, checkpointId, signal) => {
        const result = await verification.verify(goalId, checkpointId, { id: 'default', verify: async () => ({ established: true, reason: GOAL_REASONS.verification_passed }) }, signal)
        return { established: result.outcome === 'passed', reason: result.reason ?? (result.outcome === 'passed' ? GOAL_REASONS.verification_passed : GOAL_REASONS.verification_not_established) }
      } } })
    this.engine = engine
    this.continuation = new ContinuationEngine({ fabric, goals: engine.toTruthPort(), principalId: packet.principalId, stopAll: () => this.stopped })
    const lease = { id: packet.id } as { id: string; failure?: Error }
    await this.leases.run(lease, async () => { await engine.open(); await this.continuation!.open() })
    if (lease.failure) throw lease.failure
    return this.view()
  }
  async run(value: { id: string; method: string; args: unknown[]; stopped: boolean }) {
    const engine = this.engine
    if (!engine || !Array.isArray(value.args)) throw new Error('Freya Goals are not configured')
    this.stopped = value.stopped
    const lease = { id: value.id } as { id: string; failure?: Error }
    return this.leases.run(lease, async () => {
      let result: unknown
      switch (value.method) {
        case 'createGoal': result = await engine.createGoal(...value.args as Parameters<GoalEngine['createGoal']>); break
        case 'updateGoal': result = await engine.updateGoal(...value.args as Parameters<GoalEngine['updateGoal']>); break
        case 'deleteGoal': result = await engine.deleteGoal(...value.args as Parameters<GoalEngine['deleteGoal']>); break
        case 'activateGoal': result = await engine.activateGoal(...value.args as Parameters<GoalEngine['activateGoal']>); break
        case 'pauseGoal': result = await engine.pauseGoal(...value.args as Parameters<GoalEngine['pauseGoal']>); break
        case 'resumeGoal': result = await engine.resumeGoal(...value.args as Parameters<GoalEngine['resumeGoal']>); break
        case 'cancelGoal': result = await engine.cancelGoal(...value.args as Parameters<GoalEngine['cancelGoal']>); break
        case 'failGoal': result = await engine.failGoal(...value.args as Parameters<GoalEngine['failGoal']>); break
        case 'completeGoal': result = await engine.completeGoal(...value.args as Parameters<GoalEngine['completeGoal']>); break
        case 'startCheckpoint': result = await engine.startCheckpoint(...value.args as Parameters<GoalEngine['startCheckpoint']>); break
        case 'setRoadmap': result = await engine.setRoadmap(...value.args as Parameters<GoalEngine['setRoadmap']>); break
        case 'settleMilestone': result = await engine.settleMilestone(...value.args as Parameters<GoalEngine['settleMilestone']>); break
        case 'recordSpend': result = await engine.recordSpend(...value.args as Parameters<GoalEngine['recordSpend']>); break
        case 'recordCheckpointOutcome': result = await engine.recordCheckpointOutcome(...value.args as Parameters<GoalEngine['recordCheckpointOutcome']>); break
        case 'detail': result = await engine.detail(...value.args as Parameters<GoalEngine['detail']>); break
        case 'updateContent': result = engine.updateContent(...value.args as Parameters<GoalEngine['updateContent']>); break
        case 'planner.proposeRoadmap': result = engine.getPlanner().proposeRoadmap(...value.args as Parameters<ReturnType<GoalEngine['getPlanner']>['proposeRoadmap']>); break
        case 'planner.nextEligibleMilestone': result = engine.getPlanner().nextEligibleMilestone(...value.args as Parameters<ReturnType<GoalEngine['getPlanner']>['nextEligibleMilestone']>); break
        case 'planner.createMissionForMilestone': result = engine.getPlanner().createMissionForMilestone(...value.args as Parameters<ReturnType<GoalEngine['getPlanner']>['createMissionForMilestone']>); break
        case 'continuation.handleWake': result = await this.continuation!.handleWake(...value.args as Parameters<ContinuationEngine['handleWake']>); break
        default: throw new Error('operation unavailable to Freya Goals')
      }
      if (lease.failure) throw lease.failure
      process.stdout.write(`[freya] Goal ${value.method} completed; pid=${process.pid}\n`)
      return { result, view: this.view() }
    })
  }
  async close() {
    const engine = this.engine, continuation = this.continuation, verification = this.verification
    this.engine = null; this.connection = null; this.continuation = null; this.verification = null
    await continuation?.close(); await verification?.close(); await engine?.close()
  }
}
