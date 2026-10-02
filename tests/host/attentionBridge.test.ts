// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import type { AttentionProjection } from '../../core/protocol/attention'

/**
 * The Attention lane across the host and the preload bridge.
 *
 * The host half tests what is mirrored and what the bounded wake does. The bridge
 * half reads the bridge's own source to prove that the authority it does *not*
 * expose is absent from the code rather than merely unused by the tests.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-attention-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, { attentionObserveSources: false })
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

describe('the Attention mirror belongs to the process, not the window', () => {
  it('reports nothing before Core has started', () => {
    expect(host!.attention()).toBeNull()
    const seen: AttentionProjection[] = []
    host!.onAttention((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
  })

  it('pushes a ready projection the moment a window attaches', async () => {
    await host!.start()
    const seen: AttentionProjection[] = []
    const dispose = host!.onAttention((projection) => seen.push(projection))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('ready')
    expect(seen[0]?.counts.decisions).toBe(0)
    expect(host!.attention()?.health).toBe('ready')
    dispose()
  })

  it('mirrors an owner ingest through the command surface', async () => {
    await host!.start()
    const seen: AttentionProjection[] = []
    host!.onAttention((projection) => seen.push(projection))

    const result = await host!.submit({
      command: 'attention.event.ingest',
      requestId: 'r1',
      payload: { kind: 'reminder', text: 'call back' },
    })
    expect(result.ok).toBe(true)
    expect(result.attention?.operation).toBe('ingested')
    expect(host!.attention()?.counts.decisions).toBe(1)
    expect(seen.at(-1)?.counts.decisions).toBe(1)
    // Text never crosses: the projection only knows its length.
    expect(JSON.stringify(seen.at(-1))).not.toContain('call back')
  })

  it('ticks the scheduler with no model call and no due work', async () => {
    await host!.start()
    expect(await host!.attentionTick()).toBe(0)
  })
})

/** One file's code with its prose removed. */
async function codeOnly(path: string): Promise<string> {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

describe('the preload bridge gives a window exactly two Attention reads', () => {
  it('names the pull and the subscription, and nothing that ticks or decides', async () => {
    const source = await codeOnly('../../electron/preload.ts')
    const keys = [...source.matchAll(/^\s{2}(\w*[Aa]ttention\w*):/gm)].map((match) => match[1])
    expect([...keys].sort()).toEqual(['coreAttention', 'onCoreAttention'])
    expect(source).not.toMatch(/attention\w*(Tick|Decide|Escalate|Budget|Cooldown|Bypass)/i)
  })

  it('whitelists only the five owner-facing attention commands', async () => {
    const source = await codeOnly('../../electron/preload.ts')
    const listed = source.slice(source.indexOf('const CORE_COMMANDS'), source.indexOf('function readString'))
    const names = [...listed.matchAll(/'(attention\.[^']+)'/g)].map((match) => match[1]).sort()
    expect(names).toEqual([
      'attention.event.ingest',
      'attention.inbox.read',
      'attention.schedule.cancel',
      'attention.schedule.register',
      'attention.status.read',
    ])
    expect(listed).not.toContain('attention.tick')
    expect(listed).not.toContain('attention.decide')
  })

  it('names only the read channel, with no write one anywhere in the host', async () => {
    const preload = await codeOnly('../../electron/preload.ts')
    const main = await codeOnly('../../electron/main.ts')
    const hostBridge = await codeOnly('../../src/platform/host.ts')
    expect(preload).toContain("ipcRenderer.invoke('freya:core:attention')")
    expect(preload).toContain("ipcRenderer.on('freya:core:attention'")
    expect(main).toContain("ipcMain.handle('freya:core:attention'")
    expect(main).toContain("webContents.send('freya:core:attention'")
    for (const file of [preload, main, hostBridge]) {
      expect(file).not.toContain('freya:core:attention:write')
      expect(file).not.toMatch(/attention\.(decide|tick|budget\.set|escalate)/)
    }
  })

  it('keeps the "no Attention domain" sentence in one place, quoted from the protocol', async () => {
    const protocol = await codeOnly('../../core/protocol/attention.ts')
    const preload = await codeOnly('../../electron/preload.ts')
    const main = await codeOnly('../../electron/main.ts')
    expect(protocol).toContain('NO_ATTENTION_DOMAIN_REASON')
    expect(protocol).toContain('this Core has no Attention domain')
    for (const file of [preload, main]) {
      expect(file).not.toContain('no Attention domain')
      expect(file).not.toContain('none is simulated')
    }
  })
})
