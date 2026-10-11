// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MatrixService } from '../../core/matrix/service'
import { createMatrixTools } from '../../core/matrix/tools'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe('Freya Matrix tools', () => {
  it('binds every read and write to that invocation’s attached spaces', async () => {
    const folder = await mkdtemp(join(process.cwd(), '.kilo', 'matrix-tools-'))
    folders.push(folder)
    const service = await MatrixService.open({ path: join(folder, 'matrix.enc'), key: new Uint8Array(32).fill(5) })
    const a = (await service.execute('matrix.spaces.create', { name: 'Chat A' })).space!.id
    const b = (await service.execute('matrix.spaces.create', { name: 'Chat B' })).space!.id
    const tool = createMatrixTools({ service }).find(tool => tool.name === 'matrix_entries')!
    const context = { conversationId: 'chat-a', matrixSpaceIds: [a] }
    await tool.run({ arguments: { action: 'create', space_id: a, kind: 'knowledge', title: 'Plan', content: 'Alpha' }, context })
    await expect(tool.run({ arguments: { action: 'create', space_id: b, kind: 'knowledge', title: 'Leak', content: 'No' }, context })).rejects.toThrow(/not attached/)
    await expect(tool.run({ arguments: { action: 'list', space_id: a } })).rejects.toThrow(/not attached/)
    const answer = await tool.run({ arguments: { action: 'list', space_id: a }, context })
    expect(answer.summary).toContain('Alpha')
    expect((await service.execute('matrix.entries.read', { spaceId: b })).entries).toEqual([])
    await service.close()
  })

  it('paginates records and keeps read excerpts within the tool response limit', async () => {
    const folder = await mkdtemp(join(process.cwd(), '.kilo', 'matrix-tools-'))
    folders.push(folder)
    const service = await MatrixService.open({ path: join(folder, 'matrix.enc'), key: new Uint8Array(32).fill(5) })
    const spaceId = (await service.execute('matrix.spaces.create', { name: 'Bounded responses' })).space!.id
    const first = (await service.execute('matrix.entries.create', { spaceId, kind: 'knowledge', title: 'First', content: '\\'.repeat(1_000) })).entry!
    await service.execute('matrix.entries.create', { spaceId, kind: 'knowledge', title: 'Second', content: 'Next record' })
    const tool = createMatrixTools({ service }).find(tool => tool.name === 'matrix_entries')!
    const context = { conversationId: 'chat', matrixSpaceIds: [spaceId] }
    const list = await tool.run({ arguments: { action: 'list', space_id: spaceId }, context })
    expect(JSON.parse(list.summary).nextOffset).toBe(1)
    const page = await tool.run({ arguments: { action: 'list', space_id: spaceId, offset: '1' }, context })
    expect(page.summary).toContain('Second')
    const read = await tool.run({ arguments: { action: 'read', space_id: spaceId, entry_id: first.id }, context })
    expect(read.summary.length).toBeLessThanOrEqual(600)
    expect(JSON.parse(read.summary).nextOffset).toBeGreaterThan(0)
    await service.close()
  })
})
