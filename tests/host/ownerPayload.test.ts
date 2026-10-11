// @vitest-environment node
import { expect, it, vi } from 'vitest'
const bridge = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true })), api: null as null | { coreSubmit(command: string, payload?: unknown): Promise<unknown> } }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_name: string, api: typeof bridge.api) { bridge.api = api } }, ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() } }))
import '../../electron/preload'
it('preserves off switches and reported effort through the actual preload', async () => {
  await bridge.api!.coreSubmit('conversation.turn.submit', { conversationId: 'chat', text: 'find videos', intents: { webSearch: false, browserUse: false, reasoningEffort: 'xhigh', authority: 'owner' } })
  expect(bridge.invoke).toHaveBeenLastCalledWith('freya:core:submit', expect.objectContaining({ payload: { conversationId: 'chat', text: 'find videos', intents: { webSearch: false, browserUse: false, reasoningEffort: 'xhigh' } } }))
})
it('forwards bounded CRUD and null daily recurrence without authority fields', async () => {
  await bridge.api!.coreSubmit('mission.update', { missionId: 'mission', title: 'Read', intent: 'Read today', principalId: 'forged' })
  expect(bridge.invoke).toHaveBeenLastCalledWith('freya:core:submit', expect.objectContaining({ payload: { missionId: 'mission', title: 'Read', intent: 'Read today' } }))
  await bridge.api!.coreSubmit('matrix.spaces.attach', { conversationId: 'chat', spaceIds: ['space'], trust: 'owner' })
  expect(bridge.invoke).toHaveBeenLastCalledWith('freya:core:submit', expect.objectContaining({ payload: { conversationId: 'chat', spaceIds: ['space'] } }))
  await bridge.api!.coreSubmit('attention.schedule.register', { kind: 'reminder', text: 'Brush', dueAt: '2026-10-12T09:00:00Z', intervalMs: 86400000, maxRepeats: null })
  expect(bridge.invoke).toHaveBeenLastCalledWith('freya:core:submit', expect.objectContaining({ payload: expect.objectContaining({ maxRepeats: null }) }))
})
it('refuses oversized files before crossing IPC', async () => {
  const before = bridge.invoke.mock.calls.length
  const result = await bridge.api!.coreSubmit('matrix.entries.create', { spaceId: 'space', title: 'big', kind: 'file', dataBase64: 'a'.repeat(1_400_000) })
  expect(result).toMatchObject({ ok: false })
  expect(bridge.invoke.mock.calls.length).toBe(before)
})
