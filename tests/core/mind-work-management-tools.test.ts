// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createWorkManagementTools } from '../../core/mind/work-management-tools'

it('routes record mutations through guarded dispatch with only named fields', async () => {
  const dispatch = vi.fn(async () => ({ requestId: 'r', ok: true, mission: { ok: true, operation: 'created', missionId: 'm' } }))
  const tools = createWorkManagementTools({ dispatch })
  const mission = tools.find(tool => tool.name === 'mission_manage')!
  const result = await mission.run({ arguments: { action: 'create', title: 'Brush', intent: 'Habit', owner: 'system', budget: '99999', success_criteria: 'Done\nRecorded' } })
  expect(dispatch).toHaveBeenCalledWith('mission.create', { title: 'Brush', intent: 'Habit', successCriteria: ['Done', 'Recorded'] })
  expect(result.summary).toContain('m')
  expect(mission.capability).toBe('mission.manage')
  await mission.run({ arguments: { action: 'grant' } })
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('creates a daily reminder in Attention and honestly describes delivery limits', async () => {
  const dispatch = vi.fn(async () => ({ requestId: 'r', ok: true, attention: { ok: true, operation: 'scheduled' as const, scheduleId: 'schedule-1' } }))
  const tool = createWorkManagementTools({ dispatch }).find(tool => tool.name === 'reminder_manage')!
  const result = await tool.run({ arguments: { action: 'create', text: 'Brush your teeth', due_at: '2026-10-11T09:00:00+01:00', recurrence: 'daily' } })
  expect(dispatch).toHaveBeenCalledWith('attention.schedule.register', { kind: 'reminder', text: 'Brush your teeth', dueAt: '2026-10-11T08:00:00.000Z', intervalMs: 86_400_000, maxRepeats: null, condition: 'always' })
  expect(result.summary).toContain('schedule-1')
  expect(result.summary).toContain('running')
  expect(tool.capability).toBe('attention.schedule.manage')
})

it('rejects missing timezone or unimplemented recurrence without writing anything', async () => {
  const dispatch = vi.fn()
  const tool = createWorkManagementTools({ dispatch }).find(tool => tool.name === 'reminder_manage')!
  await tool.run({ arguments: { action: 'create', text: 'Brush', due_at: '2026-10-11T09:00:00', recurrence: 'daily' } })
  await tool.run({ arguments: { action: 'create', text: 'Brush', due_at: '2026-10-11T09:00:00Z', recurrence: 'weekly' } })
  expect(dispatch).not.toHaveBeenCalled()
})

it('does not turn an envelope or domain refusal into success and stops before aborted mutations', async () => {
  const dispatch = vi.fn(async () => ({ requestId: 'r', ok: true, goal: { ok: false, operation: 'refused' as const, reason: 'STOP ALL' } }))
  const tool = createWorkManagementTools({ dispatch }).find(tool => tool.name === 'goal_manage')!
  expect((await tool.run({ arguments: { action: 'create', title: 'A', description: 'B' } })).summary).toContain('STOP ALL')
  const controller = new AbortController(); controller.abort()
  await tool.run({ arguments: { action: 'delete', id: 'g' }, signal: controller.signal })
  expect(dispatch).toHaveBeenCalledTimes(1)
})
