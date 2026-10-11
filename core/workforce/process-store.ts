import { randomUUID } from 'node:crypto'
import type { RpcPeer } from '../../shared/runtime/rpc'
import type { WorkforceEngineOptions } from './engine'
import type { WorkforceOwnerScope, SubordinateWorkerScope } from './authority'
import { initialWorkforceState, reduceWorkforceState } from './state'
import { ABSENT_WORKFORCE_PROJECTION } from './projection'
import { isAssignableToWorker, normaliseContextRef, workerPrincipalId, type WorkforceProjection, type WorkforceWorkerDetail } from './types'
import type { WorkforcePacket } from './process-contract'

type OwnerMethod = 'createWorker' | 'retireWorker' | 'suspendWorker' | 'resumeWorker' | 'createTeam' | 'disbandTeam' | 'joinTeam' | 'leaveTeam' | 'assignCapability' | 'assignContext' | 'assign' | 'cancelAssignment'
type WorkerMethod = 'readMailbox' | 'sendMessage' | 'requestCognition' | 'claimPermission' | 'reportAssignment'

/** Core admits only the events an in-flight Workforce operation may legitimately emit.
 * A connected intelligence process must not be able to turn a read-only lease into a
 * journal write, or use a worker message lease to mint workers or capabilities. */
const EVENTS_BY_METHOD: Readonly<Record<string, readonly string[]>> = {
  open: ['workforce.assignment.settled', 'workforce.worker.reconciled', 'workforce.worker.transitioned'],
  createWorker: ['workforce.worker.created', 'workforce.limit.exceeded'],
  retireWorker: ['workforce.worker.transitioned', 'workforce.assignment.settled'],
  suspendWorker: ['workforce.worker.transitioned'],
  resumeWorker: ['workforce.worker.transitioned'],
  createTeam: ['workforce.team.created', 'workforce.limit.exceeded'],
  disbandTeam: ['workforce.team.transitioned'],
  joinTeam: ['workforce.team.member.changed', 'workforce.limit.exceeded'],
  leaveTeam: ['workforce.team.member.changed'],
  assignCapability: ['workforce.capability.assigned'],
  assignContext: ['workforce.context.assigned', 'workforce.limit.exceeded'],
  assign: ['workforce.assignment.created', 'workforce.limit.exceeded'],
  cancelAssignment: ['workforce.assignment.settled'],
  'worker.sendMessage': ['workforce.message.sent', 'workforce.limit.exceeded'],
  'worker.requestCognition': ['workforce.cognition.recorded'],
  'worker.claimPermission': ['workforce.claim.recorded'],
  'worker.reportAssignment': ['workforce.assignment.settled'],
  reconcileExpiredAssignments: ['workforce.assignment.settled'],
  stopAll: ['workforce.assignment.settled', 'workforce.worker.transitioned'],
}
export class ProcessWorkforce {
  private metadata = initialWorkforceState()
  private peer: RpcPeer | null = null
  private cached: WorkforceProjection = ABSENT_WORKFORCE_PROJECTION
  private readonly active = new Map<string, { method: string; args: unknown[]; cognitionIssued?: boolean }>()
  private dispose: () => void = () => {}
  private stopping: Promise<void> = Promise.resolve()
  constructor(private readonly options: WorkforceEngineOptions) {}
  async open() {
    this.metadata = await this.options.fabric.replay(initialWorkforceState(), reduceWorkforceState)
    this.dispose = this.options.fabric.subscribe(event => { this.metadata = reduceWorkforceState(this.metadata, event) })
  }
  private cache(projection: WorkforceProjection) { if (projection.sequence >= this.cached.sequence) this.cached = projection }
  async connect(peer: RpcPeer) {
    this.peer = peer; peer.onClose(() => { if (this.peer === peer) this.peer = null })
    const id = randomUUID(); this.active.set(id, { method: 'open', args: [] })
    const packet: WorkforcePacket = { version: 1, id, principalId: this.options.principalId, stopped: this.options.stopAll?.() ?? false, limits: this.options.limits,
      events: (await this.options.fabric.readAll()).filter(event => event.type.startsWith('workforce.')) }
    try { this.cache(await peer.call('workforce.configure', packet)); this.options.onChange?.() }
    finally { this.active.delete(id) }
  }
  async handle(method: string, raw: unknown): Promise<unknown> {
    const value = raw as { id: string; args: unknown[] }
    const lease = this.active.get(value?.id)
    if (!lease || !Array.isArray(value.args)) throw new Error('no admitted Workforce operation')
    const [a, b, options] = value.args
    if (method === 'workforce.cognition') {
      if (lease.method !== 'worker.requestCognition' || a !== lease.args[0]) throw new Error('worker identity does not match the admitted operation')
      if (lease.cognitionIssued) throw new Error('the worker request was already issued')
      lease.cognitionIssued = true
      return this.options.core.requestCognition(a as string, { ...lease.args[1] as Parameters<SubordinateWorkerScope['requestCognition']>[0], kind: 'agent_step' })
    }
    if (method !== 'workforce.event' || typeof a !== 'string' || !a.startsWith('workforce.')) throw new Error('operation unavailable to Workforce')
    if (!EVENTS_BY_METHOD[lease.method]?.includes(a)) throw new Error('the Workforce event is not admitted for this operation')
    const payload = b as { workerId?: string; capability?: string; contextRef?: string; fromWorkerId?: string; to?: string }
    if (a === 'workforce.capability.assigned' && (lease.method !== 'assignCapability' || payload.workerId !== lease.args[0] || payload.capability !== lease.args[1] || !isAssignableToWorker(payload.capability as never))) throw new Error('capability assignment is not admitted')
    if (a === 'workforce.context.assigned' && (lease.method !== 'assignContext' || payload.workerId !== lease.args[0] || payload.contextRef !== normaliseContextRef(lease.args[1]))) throw new Error('context assignment is not admitted')
    if (this.options.stopAll?.() && (a === 'workforce.assignment.created' || payload.to === 'working')) throw new Error('STOP ALL prevents agent work')
    let actor = this.options.principalId
    if (a === 'workforce.message.sent') {
      if (lease.method !== 'worker.sendMessage' || payload.fromWorkerId !== lease.args[0]) throw new Error('message sender is not admitted')
      actor = workerPrincipalId(lease.args[0] as string)
    } else if (a === 'workforce.limit.exceeded' && ['createWorker', 'createTeam'].includes(lease.method)) actor = 'system'
    return this.options.fabric.append(a as never, b as never, { actor, correlationId: (options as { correlationId?: string })?.correlationId })
  }
  private async call<T>(method: string, args: unknown[]): Promise<T> {
    const peer = this.peer
    if (!peer?.connected) throw new Error('Freya agents are unavailable; the operation was not retried')
    const id = randomUUID(); this.active.set(id, { method, args })
    const input = args[0] as { missionId?: string } | undefined
    const missions = method === 'assign' && input?.missionId && this.options.core.missionExists(input.missionId) ? [input.missionId] : []
    try {
      const response = await peer.call<{ result: T; projection: WorkforceProjection }>('workforce.run', { id, method, args, missions, stopped: this.options.stopAll?.() ?? false })
      this.cache(response.projection); return response.result
    } finally { this.active.delete(id); if (method !== 'detail' && method !== 'worker.readMailbox') this.options.onChange?.() }
  }
  private owner<K extends OwnerMethod>(method: K, args: Parameters<WorkforceOwnerScope[K]>) { return this.call<Awaited<ReturnType<WorkforceOwnerScope[K]>>>(method, args) }
  private worker<K extends WorkerMethod>(id: string, method: K, args: Parameters<SubordinateWorkerScope[K]>) { return this.call<Awaited<ReturnType<SubordinateWorkerScope[K]>>>(`worker.${method}`, [id, ...args]) }
  ownerScope(): WorkforceOwnerScope {
    return { createWorker: (...args) => this.owner('createWorker', args), retireWorker: (...args) => this.owner('retireWorker', args),
      suspendWorker: (...args) => this.owner('suspendWorker', args), resumeWorker: (...args) => this.owner('resumeWorker', args),
      createTeam: (...args) => this.owner('createTeam', args), disbandTeam: (...args) => this.owner('disbandTeam', args), joinTeam: (...args) => this.owner('joinTeam', args), leaveTeam: (...args) => this.owner('leaveTeam', args),
      assignCapability: (...args) => this.owner('assignCapability', args), assignContext: (...args) => this.owner('assignContext', args), assign: (...args) => this.owner('assign', args), cancelAssignment: (...args) => this.owner('cancelAssignment', args),
      listAssignmentsForMission: missionId => [...this.metadata.assignments.values()]
        .filter(assignment => assignment.missionId === missionId)
        .map(assignment => ({ assignmentId: assignment.assignmentId, status: assignment.status })),
      stopAll: reason => this.stopAll(reason), settled: () => this.settled(), resume: () => this.resume(), scopeFor: id => this.scopeFor(id), projection: () => this.projection(), detail: id => this.detail(id) }
  }
  private scopeFor(id: string): SubordinateWorkerScope {
    return { workerId: id, principalId: workerPrincipalId(id), capabilities: () => this.metadata.workers.get(id)?.capabilities ?? [], contextRefs: () => this.metadata.workers.get(id)?.contextRefs ?? [],
      readMailbox: (...args) => this.worker(id, 'readMailbox', args), sendMessage: (...args) => this.worker(id, 'sendMessage', args), requestCognition: (...args) => this.worker(id, 'requestCognition', args),
      claimPermission: (...args) => this.worker(id, 'claimPermission', args), reportAssignment: (...args) => this.worker(id, 'reportAssignment', args) }
  }
  projection(): WorkforceProjection { return this.peer?.connected ? this.cached : { ...this.cached, health: 'unavailable', reason: 'Freya agents are disconnected', detailAvailable: false } }
  absent(reason = 'Freya agents are unavailable'): WorkforceProjection { return { ...ABSENT_WORKFORCE_PROJECTION, reason } }
  detail(id: string) { return this.call<WorkforceWorkerDetail | null>('detail', [id]).catch(() => null) }
  reconcileExpiredAssignments() { return this.call<number>('reconcileExpiredAssignments', []) }
  stopAll(reason: string) { this.stopping = this.peer?.connected ? this.call<void>('stopAll', [reason]).catch(() => {}) : Promise.resolve() }
  settled() { return this.stopping }
  resume() { if (this.peer?.connected) void this.call<void>('resume', []).catch(() => {}) }
  async close() { this.dispose(); if (this.peer?.connected) await this.peer.call('workforce.close', null).catch(() => {}) }
}
