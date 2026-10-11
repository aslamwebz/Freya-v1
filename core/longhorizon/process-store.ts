import { randomUUID } from 'node:crypto'
import type { RpcPeer } from '../../shared/runtime/rpc'
import type { GoalEngine, GoalEngineOptions } from './engine'
import type { ProgressiveRoadmapPlanner } from './decomposition/progressive-planner'
import type { ContinuationWake, ContinuationEngine } from './continuation'
import type { GoalPacket, GoalViewPacket } from './process-contract'
import { initialGoalState, reduceGoalState } from './state'
import { DEFAULT_GOAL_LIMITS, isTerminalGoalStatus, type GoalContent } from './types'
import { DEFAULT_GOAL_BUDGET, ZERO_GOAL_SPEND, calculateRemainingGoalBudget, checkBudgetExhaustion, deriveMilestoneMissionBudget } from './budget'
import type { MissionBudget } from '../missions/autonomy/types'

type RemoteMethod = 'createGoal' | 'updateGoal' | 'deleteGoal' | 'activateGoal' | 'pauseGoal' | 'resumeGoal' | 'cancelGoal' | 'failGoal' | 'completeGoal' | 'startCheckpoint' | 'setRoadmap' | 'settleMilestone' | 'recordSpend' | 'recordCheckpointOutcome' | 'detail'
export class ProcessGoals {
  private metadata = initialGoalState()
  private readonly contents = new Map<string, GoalContent>()
  private readonly active = new Map<string, string>()
  private peer: RpcPeer | null = null
  private view: GoalViewPacket | null = null
  private dispose: () => void = () => {}
  constructor(private readonly options: GoalEngineOptions) {}
  async open() {
    this.metadata = await this.options.fabric.replay(initialGoalState(), reduceGoalState)
    this.dispose = this.options.fabric.subscribe(event => { this.metadata = reduceGoalState(this.metadata, event) })
  }
  private cache(view: GoalViewPacket) { if (!this.view || view.projection.sequence >= this.view.projection.sequence) this.view = view }
  async connect(peer: RpcPeer) {
    this.peer = peer; peer.onClose(() => { if (this.peer === peer) this.peer = null })
    const id = randomUUID(); this.active.set(id, 'open')
    const packet: GoalPacket = { version: 1, id, principalId: this.options.principalId, stopped: this.options.stopAll?.() ?? false,
      events: (await this.options.fabric.readAll()).filter(event => event.type.startsWith('longhorizon.')),
      store: { mode: this.options.store.mode, durable: this.options.store.durable, faultReason: this.options.store.faultReason, health: this.options.store.health() } }
    try { this.cache(await peer.call('goal.configure', packet)); this.options.onChange?.() }
    finally { this.active.delete(id) }
  }
  async handle(method: string, raw: unknown): Promise<unknown> {
    const value = raw as { id: string; args: unknown[] }
    const admitted = this.active.get(value?.id)
    if (!admitted || !Array.isArray(value.args)) throw new Error('no admitted Goal operation')
    const [a, b] = value.args
    if (method === 'goal.store.read') {
      const read = await this.options.store.read(a as string)
      if (read.ok) this.contents.set(read.value.goalId, read.value)
      return read
    }
    if (admitted === 'detail' || admitted.startsWith('planner.')) throw new Error('the Goal operation is read-only')
    if (method === 'goal.store.write') {
      if (this.options.stopAll?.() && ['createGoal', 'setRoadmap'].includes(admitted)) throw new Error('STOP ALL prevents Goal work')
      const content = await this.options.store.write(a as GoalContent); this.contents.set(content.goalId, content); return content
    }
    if (method === 'goal.store.remove') { const removed = await this.options.store.remove(a as string); this.contents.delete(a as string); return removed }
    if (method === 'goal.event') {
      if (typeof a !== 'string' || !a.startsWith('longhorizon.')) throw new Error('Goal event scope mismatch')
      const payload = b as { to?: string; decision?: string }
      if (this.options.stopAll?.() && (payload?.to === 'active' || a === 'longhorizon.checkpoint.started' || payload?.decision === 'continue')) throw new Error('STOP ALL prevents Goal work')
      return this.options.fabric.append(a as never, b as never, { actor: this.options.principalId })
    }
    throw new Error('operation unavailable to Goals')
  }
  private async call<T>(method: string, args: unknown[]): Promise<T> {
    const peer = this.peer
    if (!peer?.connected) throw new Error('Freya Goals are unavailable; the operation was not retried')
    const id = randomUUID(); this.active.set(id, method)
    try {
      const response = await peer.call<{ result: T; view: GoalViewPacket }>('goal.run', { id, method, args, stopped: this.options.stopAll?.() ?? false })
      this.cache(response.view); return response.result
    } finally { this.active.delete(id); if (method !== 'detail' && !method.startsWith('planner.')) this.options.onChange?.() }
  }
  private run<K extends RemoteMethod>(method: K, args: Parameters<GoalEngine[K]>) { return this.call<Awaited<ReturnType<GoalEngine[K]>>>(method, args) }
  createGoal(...args: Parameters<GoalEngine['createGoal']>) { return this.run('createGoal', args) }
  updateGoal(...args: Parameters<GoalEngine['updateGoal']>) { return this.run('updateGoal', args) }
  deleteGoal(...args: Parameters<GoalEngine['deleteGoal']>) { return this.run('deleteGoal', args) }
  activateGoal(...args: Parameters<GoalEngine['activateGoal']>) { return this.run('activateGoal', args) }
  pauseGoal(...args: Parameters<GoalEngine['pauseGoal']>) { return this.run('pauseGoal', args) }
  resumeGoal(...args: Parameters<GoalEngine['resumeGoal']>) { return this.run('resumeGoal', args) }
  cancelGoal(...args: Parameters<GoalEngine['cancelGoal']>) { return this.run('cancelGoal', args) }
  failGoal(...args: Parameters<GoalEngine['failGoal']>) { return this.run('failGoal', args) }
  completeGoal(...args: Parameters<GoalEngine['completeGoal']>) { return this.run('completeGoal', args) }
  startCheckpoint(...args: Parameters<GoalEngine['startCheckpoint']>) { return this.run('startCheckpoint', args) }
  setRoadmap(...args: Parameters<GoalEngine['setRoadmap']>) { return this.run('setRoadmap', args) }
  settleMilestone(...args: Parameters<GoalEngine['settleMilestone']>) { return this.run('settleMilestone', args) }
  recordSpend(...args: Parameters<GoalEngine['recordSpend']>) { return this.run('recordSpend', args) }
  recordCheckpointOutcome(...args: Parameters<GoalEngine['recordCheckpointOutcome']>) { return this.run('recordCheckpointOutcome', args) }
  detail(...args: Parameters<GoalEngine['detail']>) { return this.run('detail', args).catch(() => null) }
  updateContent(content: GoalContent) { return this.call<void>('updateContent', [content]) }
  getPlanner() {
    const planner = <K extends 'proposeRoadmap' | 'nextEligibleMilestone' | 'createMissionForMilestone'>(method: K, args: Parameters<ProgressiveRoadmapPlanner[K]>) => this.call<ReturnType<ProgressiveRoadmapPlanner[K]>>(`planner.${method}`, args)
    return { proposeRoadmap: (...args: Parameters<ProgressiveRoadmapPlanner['proposeRoadmap']>) => planner('proposeRoadmap', args),
      nextEligibleMilestone: (...args: Parameters<ProgressiveRoadmapPlanner['nextEligibleMilestone']>) => planner('nextEligibleMilestone', args),
      createMissionForMilestone: (...args: Parameters<ProgressiveRoadmapPlanner['createMissionForMilestone']>) => planner('createMissionForMilestone', args) }
  }
  readonly continuation = { open: async () => {}, close: async () => {}, handleWake: (wake: ContinuationWake) => this.call<Awaited<ReturnType<ContinuationEngine['handleWake']>>>('continuation.handleWake', [wake]) }
  state() { return this.metadata }
  getContent(id: string) { return this.contents.get(id) ?? null }
  getBudget(id: string) {
    const content = this.getContent(id); if (!content) return null
    const budget = content.budget ?? DEFAULT_GOAL_BUDGET, spend = content.spend ?? ZERO_GOAL_SPEND
    return { budget, spend, remaining: calculateRemainingGoalBudget(budget, spend) }
  }
  deriveMissionBudget(id: string, requested?: Partial<MissionBudget>) {
    const content = this.getContent(id)
    return deriveMilestoneMissionBudget(content?.budget ?? DEFAULT_GOAL_BUDGET, content?.spend ?? ZERO_GOAL_SPEND, requested)
  }
  checkpointAttempts(goalId: string, checkpointId: string) { const checkpoint = this.metadata.checkpoints.get(checkpointId); return checkpoint?.goalId === goalId ? checkpoint.attempts : 0 }
  goalRetryCount(id: string) { return this.metadata.goals.get(id)?.retryCount ?? 0 }
  toTruthPort() {
    return { isGoalOpen: (id: string) => { const goal = this.metadata.goals.get(id); return !!goal && !isTerminalGoalStatus(goal.state) },
      goalState: (id: string) => this.metadata.goals.get(id)?.state ?? null, verifiedCheckpoints: (id: string) => this.metadata.goals.get(id)?.verifiedCheckpoints ?? 0,
      totalCheckpoints: (id: string) => this.metadata.goals.get(id)?.checkpoints.length ?? 0, retryCount: (id: string) => this.goalRetryCount(id),
      isBudgetExhausted: (id: string) => { const data = this.getBudget(id); return !!data && checkBudgetExhaustion(data.budget, data.spend).exhausted },
      hasEligibleMilestone: (id: string) => this.view?.eligible.includes(id) ?? false }
  }
  projection() {
    return this.view?.projection ?? { persistence: { mode: this.options.store.mode, reason: this.options.store.faultReason, durable: this.options.store.durable }, goals: [],
      counts: { total: 0, draft: 0, active: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, needsAttention: 0 }, limits: DEFAULT_GOAL_LIMITS, goalsRetained: 0, goalsTotal: 0, goalsHidden: 0, sequence: 0 }
  }
  async close() { this.dispose(); if (this.peer?.connected) await this.peer.call('goal.close', null).catch(() => {}); await this.options.store.close() }
}
