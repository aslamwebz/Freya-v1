// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCore } from '../../core/index'
import { RUNTIME_REGISTRY } from '../../core/runtime'

it('serves the real registry and its measured dependencies through an owner command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freya-explorer-'))
  const core = createCore({ dataPath: join(dir, 'events.jsonl') })
  try {
    await core.start()
    const result = await core.handleCommand({ command: 'system.explorer.read' as never, requestId: 'explore' })
    expect(result.ok).toBe(true)
    const graph = (result as unknown as { explorer: { nodes: { id: string }[]; edges: { from: string; to: string }[] } }).explorer
    for (const item of RUNTIME_REGISTRY) expect(graph.nodes.some(node => node.id === item.id)).toBe(true)
    expect(graph.edges.length).toBeGreaterThan(0)
    for (const edge of graph.edges) {
      expect(graph.nodes.some(node => node.id === edge.from)).toBe(true)
      expect(graph.nodes.some(node => node.id === edge.to)).toBe(true)
    }
    const bad = await core.handleCommand({ command: 'system.explorer.read' as never, requestId: 'bad', payload: { sql: 'select secrets' } })
    expect(bad.ok).toBe(false)
  } finally { await core.stop(); await rm(dir, { recursive: true, force: true }) }
})
