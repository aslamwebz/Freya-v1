// @vitest-environment node
import { expect, it } from 'vitest'
import { createChartTool, MindToolRegistry } from '../../../core/mind/tools'
import { DefaultGuard } from '../../../core/security/guard'

function registry() {
  return new MindToolRegistry({ tools: [createChartTool()], guard: new DefaultGuard(), principal: { id: 'owner', trusted: true, capabilities: new Set(['search.web']) }, stopped: () => false })
}
it('returns a failed tool record for missing or malformed point data', async () => {
  for (const points of ['', 'A=2, B=4', '{"A":2}', '[{"label":"A","value":"two"}]']) {
    const result = await registry().invoke({ name: 'make_chart', arguments: { title: 'Values', kind: 'bar', unit: 'count', points } })
    expect(result.observation.kind).toBe('failed')
    expect(result.executed).toBe(true)
  }
})
it('retains a valid series longer than a short search query', async () => {
  const points = Array.from({ length: 12 }, (_, index) => ({ label: `Item ${index}`, value: index }))
  const result = await registry().invoke({ name: 'make_chart', arguments: { title: 'Supplied values', kind: 'bar', unit: 'count', points: JSON.stringify(points) } })
  expect(result.observation.kind).toBe('ok')
  if (result.observation.kind !== 'ok') throw new Error('Chart failed')
  expect(result.observation.chart?.points).toEqual(points)
})
