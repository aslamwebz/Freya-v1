// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCore } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'

it('projects the actual registered tools as metadata without executing or contacting a model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freya-tool-catalogue-'))
  const provider = new FakeModelProvider()
  const complete = vi.spyOn(provider, 'complete')
  const core = createCore({ dataPath: join(directory, 'events.jsonl'), providers: [provider] })
  try {
    expect(core.toolCatalogue().health).toBe('unavailable')
    await core.start()
    const catalogue = core.toolCatalogue()
    expect(catalogue.health).toBe('ready')
    expect(catalogue.tools.map(tool => tool.name)).toEqual(['system_inspect', 'mission_manage', 'goal_manage', 'reminder_manage', 'matrix_spaces', 'matrix_entries', 'missions_list', 'workspace_save_report', 'make_chart', 'open_canvas'])
    expect(catalogue.tools.every(tool => tool.description.length > 0 && tool.capability.length > 0)).toBe(true)
    expect(catalogue.tools.every(tool => !('run' in tool))).toBe(true)
    expect(complete).not.toHaveBeenCalled()
    ;(catalogue.tools as unknown[]).length = 0
    expect(core.toolCatalogue().tools).toHaveLength(10)
  } finally {
    await core.stop('test-teardown')
    await rm(directory, { recursive: true, force: true })
  }
})
