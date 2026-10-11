// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { connectRpc, listenRpc, type RpcPeer } from '../../../shared/runtime/rpc'
import { ProcessMissionRuntime } from '../../../core/missions/process-runtime'
import type { MissionPacket } from '../../../core/missions/process-contract'
import { ProcessMissions } from '../../../core/missions/process-store'
import { MemoryMissionStore } from '../../../core/missions/memory-store'
import { EventFabric } from '../../../core/events/fabric'
import { EphemeralEventStore } from '../../../core/events/ephemeral-store'

it('does not accept mission persistence or Work effects without a Core-issued operation lease', async () => {
  const missions = new ProcessMissions({ fabric: await EventFabric.open({ store: new EphemeralEventStore() }),
    store: new MemoryMissionStore(), principalId: 'owner', work: {
      run: () => undefined, stepsOf: () => [], isSettled: () => false,
      pauseRun: async () => { throw new Error('must not execute') }, cancelRun: async () => { throw new Error('must not execute') },
    } })
  await missions.open()
  expect(await missions.privateContent('disconnected-mission')).toBeNull()
  expect(await missions.readIntent('disconnected-mission')).toBeNull()
  for (const method of ['mission.store.write', 'mission.event', 'mission.work.pauseRun', 'mission.createChild']) {
    await expect(missions.handle(method, { id: 'invented', args: [] })).rejects.toThrow('admitted Mission operation')
  }
  await missions.close()
})

it('reads Missions over authenticated RPC without creating another change notification', async () => {
  const onChange = vi.fn()
  let stopped = false
  let stopDuringDispatch = false
  const fabric = await EventFabric.open({ store: new EphemeralEventStore() })
  const missions = new ProcessMissions({ fabric, store: new MemoryMissionStore(), principalId: 'owner', onChange,
    stopAll: () => stopped, work: { run: () => undefined, stepsOf: () => [], isSettled: () => false,
      pauseRun: async () => true, cancelRun: async () => true } })
  const runtime = new ProcessMissionRuntime()
  let corePeer: RpcPeer | undefined
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\mission-test-${randomUUID()}` : `/tmp/mission-test-${randomUUID()}.sock`
  const server = await listenRpc(endpoint, 'test-token', peer => {
    corePeer = peer
    peer.handle((method, value) => missions.handle(method, value))
  })
  const client = await connectRpc(endpoint, 'test-token')
  client.handle(async (method, value) => {
    if (method === 'mission.configure') return runtime.configure(client, value as MissionPacket)
    if (method === 'mission.close') return runtime.close()
    if (method === 'mission.run') {
      if (stopDuringDispatch) stopped = true
      return runtime.run(value as Parameters<ProcessMissionRuntime['run']>[0])
    }
    throw new Error('unexpected test operation')
  })
  try {
    await missions.open()
    await missions.connect(corePeer!)
    const result = await missions.create({ title: 'Transport Mission', intent: 'Keep the existing Mission rules.' })
    expect(result.ok).toBe(true)
    onChange.mockClear()
    await missions.detail(result.missionId!)
    await missions.privateContent(result.missionId!)
    await missions.readIntent(result.missionId!)
    expect(onChange).not.toHaveBeenCalled()
    const sequence = fabric.lastSequence
    stopDuringDispatch = true
    await expect(missions.activate(result.missionId!)).rejects.toThrow('STOP ALL')
    expect(fabric.lastSequence).toBe(sequence)
    expect(missions.record(result.missionId!)?.status).toBe('draft')
  } finally {
    await missions.close()
    client.close()
    await server.close()
    await runtime.close()
    await fabric.close()
  }
})
