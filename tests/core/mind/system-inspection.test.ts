import { expect, it } from 'vitest'
import { createSystemInspectionTool } from '../../../core/mind/system-inspection'
it('reads current facts each time without caching an invented capability list', async () => {
  let goals = 0
  const tool = createSystemInspectionTool({ read: () => ({ goals: { count: goals }, memory: { durable: false } }) })
  expect((await tool.run({ arguments: { section: 'goals' } })).provenance?.extract).toEqual(['goals: {"count":0}'])
  goals = 2
  expect((await tool.run({ arguments: { section: 'goals' } })).provenance?.extract).toEqual(['goals: {"count":2}'])
  await expect(tool.run({ arguments: { section: 'credentials' } })).rejects.toThrow('Unknown system section')
})
