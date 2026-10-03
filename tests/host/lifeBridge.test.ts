// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import type { LifeProjection } from '../../core/protocol/life'

/**
 * The Life History lane across the host and the preload bridge.
 *
 * The host half tests what is mirrored and what crosses the process boundary. The
 * bridge half reads the bridge's own source to prove that the authority it does
 * **not** expose is absent from the code rather than merely unused by the tests.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-life-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, {
    attentionObserveSources: false,
  })
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

describe('the Life History mirror belongs to the process, not the window', () => {
  it('reports nothing before Core has started', () => {
    expect(host!.life()).toBeNull()
    const seen: LifeProjection[] = []
    host!.onLife((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
  })

  it('pushes a ready projection the moment a window attaches', async () => {
    await host!.start()
    const seen: LifeProjection[] = []
    const dispose = host!.onLife((projection) => seen.push(projection))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('ready')
    expect(seen[0]?.counts.total).toBe(0)
    expect(seen[0]?.persistence.durable).toBe(false)
    dispose()
  })

  it('answers the status and timeline reads through the command surface', async () => {
    await host!.start()
    const status = await host!.submit({ command: 'life.status.read', requestId: 'r1' })
    expect(status.ok).toBe(true)
    expect(status.life?.operation).toBe('status')
    expect(status.life?.projection?.health).toBe('ready')

    const timeline = await host!.submit({
      command: 'life.timeline.read',
      requestId: 'r2',
      payload: { limit: 10 },
    })
    expect(timeline.ok).toBe(true)
    expect(timeline.life?.timeline?.returned).toBe(0)
  })

  it('costs no model call for anything it mirrors', async () => {
    await host!.start()
    const before = host!.status().durableUsage.calls
    await host!.submit({ command: 'life.status.read', requestId: 'r1' })
    await host!.submit({ command: 'life.timeline.read', requestId: 'r2' })
    if (before !== undefined) {
      expect(host!.status().durableUsage.calls).toBe(before)
    }
  })
})

describe('the bridge exposes reads and no way to write', () => {
  it('lists exactly the three life reads in the command allowlist', async () => {
    const source = await readCodeOnly('../../electron/preload.ts')
    const listed = source.slice(source.indexOf('const CORE_COMMANDS'), source.indexOf('function readString'))
    expect(listed).toMatch(/'life\.status\.read'/)
    expect(listed).toMatch(/'life\.timeline\.read'/)
    expect(listed).toMatch(/'life\.entry\.read'/)
    expect(listed).not.toMatch(/life\.(record|revise|withdraw|consolidate|confidence|promote)/)
  })

  it('has a projection channel and no write channel', async () => {
    const source = await readCodeOnly('../../electron/preload.ts')
    expect(source).toMatch(/freya:core:life/)
    expect(source).not.toMatch(/freya:core:life:write/)
    expect(source).toMatch(/coreLife/)
    expect(source).toMatch(/onCoreLife/)
  })
})

async function readCodeOnly(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}
