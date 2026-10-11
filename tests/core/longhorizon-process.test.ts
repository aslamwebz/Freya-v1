// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { connectRpc, listenRpc, type RpcPeer } from '../../shared/runtime/rpc'
import { ProcessGoals } from '../../core/longhorizon/process-store'
import { ProcessGoalRuntime } from '../../core/longhorizon/process-runtime'
import type { GoalPacket } from '../../core/longhorizon/process-contract'
import { MemoryGoalStore } from '../../core/longhorizon/memory-store'
import { EventFabric } from '../../core/events/fabric'
import { EphemeralEventStore } from '../../core/events/ephemeral-store'

it('keeps Goal persistence admitted, read notifications bounded, and recovery truthful over authenticated RPC', async () => {
  const fabric = await EventFabric.open({ store: new EphemeralEventStore() })
  const onChange = vi.fn()
  let stopped = false, stopDuringDispatch = false
  const goals = new ProcessGoals({ fabric, store: new MemoryGoalStore(), principalId: 'owner', onChange, stopAll: () => stopped,
    continuation: { verifyCheckpoint: async () => { throw new Error('Core must not run Goal verification') } } })
  const runtime = new ProcessGoalRuntime()
  let corePeer: RpcPeer | undefined
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\goal-test-${randomUUID()}` : `/tmp/goal-test-${randomUUID()}.sock`
  const server = await listenRpc(endpoint, 'test-token', peer => { corePeer = peer; peer.handle((method, value) => goals.handle(method, value)) })
  const client = await connectRpc(endpoint, 'test-token')
  client.handle(async (method, value) => {
    if (method === 'goal.configure') return runtime.configure(client, value as GoalPacket)
    if (method === 'goal.close') return runtime.close()
    if (method === 'goal.run') {
      if (stopDuringDispatch) stopped = true
      return runtime.run(value as Parameters<ProcessGoalRuntime['run']>[0])
    }
    throw new Error('unexpected test operation')
  })
  try {
    await goals.open()
    await expect(goals.handle('goal.store.write', { id: 'invented', args: [] })).rejects.toThrow('admitted Goal operation')
    await goals.connect(corePeer!)
    const created = await goals.createGoal({ title: 'Retain goal', description: 'Private content survives reconnection', completionCriteria: ['Verify the result'] })
    expect(created.ok).toBe(true)
    onChange.mockClear()
    const detail = await goals.detail(created.goalId!)
    expect(detail?.content?.description).toBe('Private content survives reconnection')
    expect(onChange).not.toHaveBeenCalled()
    const roadmap = await goals.getPlanner().proposeRoadmap(detail!.content!)
    expect(roadmap.ok).toBe(true)
    const sequence = fabric.lastSequence
    stopDuringDispatch = true
    await expect(goals.activateGoal(created.goalId!)).rejects.toThrow('STOP ALL')
    expect(fabric.lastSequence).toBe(sequence)
    stopDuringDispatch = false; stopped = false
    expect((await goals.activateGoal(created.goalId!)).ok).toBe(true)
    const wake = await goals.continuation.handleWake({ wakeId: 'goal-wake', source: 'owner', goalId: created.goalId!, authorized: true })
    expect(wake.decision.decision).toBe('continue')
    await goals.connect(corePeer!)
    expect(goals.state().goals.get(created.goalId!)?.state).toBe('paused')
    expect((await goals.detail(created.goalId!))?.content?.description).toBe('Private content survives reconnection')
    expect((await fabric.readAll()).filter(event => event.type === 'longhorizon.goal.created')).toHaveLength(1)
  } finally {
    await goals.close(); client.close(); await server.close(); await runtime.close(); await fabric.close()
  }
})
