// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createCore } from '../../core/index'
import type { CoreCommandName } from '../../core/protocol/core-protocol'

it('connects owner CRUD, persistent Matrix bindings and daily reminders through Core', async () => {
  await mkdir('.kilo/tmp', { recursive: true })
  const directory = await mkdtemp(join(process.cwd(), '.kilo/tmp/owner-controls-'))
  const core = createCore({ dataPath: join(directory, 'events.jsonl'), matrixKey: new Uint8Array(32).fill(61), attentionKey: new Uint8Array(32).fill(62) })
  let sequence = 0
  const command = (name: CoreCommandName, payload?: unknown) => core.handleCommand({ command: name, requestId: `request-${++sequence}`, payload })
  try {
    await core.start()
    const mission = await command('mission.create', { title: 'Read report', intent: 'Read report today' })
    const missionId = mission.mission?.missionId
    expect((await command('mission.read', { missionId })).mission?.detail?.content?.title).toBe('Read report')
    expect((await command('mission.update', { missionId, title: 'Read two reports', intent: 'Read two today' })).ok).toBe(true)
    expect((await command('mission.delete', { missionId })).ok).toBe(true)
    expect((await command('mission.read', { missionId })).ok).toBe(false)
    const goal = await command('goal.create', { title: 'Learn', description: 'Learn physics' })
    expect((await command('goal.read', { goalId: goal.goal?.goalId })).goal?.detail?.content?.title).toBe('Learn')
    const space = await command('matrix.spaces.create', { name: 'Physics', description: 'Study notes' })
    expect(space.matrix?.ok).toBe(true)
    const created = await command('conversation.create')
    const conversationId = created.conversation?.operation === 'created' ? created.conversation.conversation.conversationId : ''
    expect((await command('matrix.spaces.attach', { conversationId, spaceIds: [space.matrix?.space?.id] })).matrix?.attachedSpaceIds).toEqual([space.matrix?.space?.id])
    const scheduled = await command('attention.schedule.register', { kind: 'reminder', text: 'Brush daily', dueAt: new Date(Date.now() + 60_000).toISOString(), intervalMs: 86_400_000, maxRepeats: null, condition: 'always' })
    expect(scheduled.attention?.scheduleId).toEqual(expect.any(String))
    expect(core.toolCatalogue().tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['system_inspect', 'mission_manage', 'goal_manage', 'reminder_manage', 'matrix_spaces', 'matrix_entries']))
  } finally { await core.stop(); await rm(directory, { recursive: true, force: true }) }
})
