// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ElectronCoreHost } from '../../electron/coreHost'

it('reads the Core tool catalogue without a command, model call or new activity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freya-tool-host-'))
  const host = new ElectronCoreHost(join(directory, 'events.jsonl'), {}, { attentionObserveSources: false })
  try {
    expect(host.toolCatalogue()).toBeNull()
    await host.start()
    const calls = host.status().durableUsage.calls
    const sequence = host.status().eventSequence
    expect(host.toolCatalogue()?.health).toBe('ready')
    expect(host.toolCatalogue()?.tools.some(tool => tool.name === 'make_chart')).toBe(true)
    expect(host.status().durableUsage.calls).toBe(calls)
    expect(host.status().eventSequence).toBe(sequence)
    expect(host.goals()).not.toBeNull()
  } finally {
    await host.stop('test-teardown')
    await rm(directory, { recursive: true, force: true })
  }
})
