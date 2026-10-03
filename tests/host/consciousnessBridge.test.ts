// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ElectronCoreHost } from '../../electron/coreHost'
import type { ConsciousContextProjection } from '../../core/protocol/consciousness'

/**
 * The Phase 20 bridge, and the absence of a write door.
 *
 * This phase adds an Electron lane that no surface uses yet, so the tests here are
 * not about behaviour a person can see. They are about the *shape* of the lane,
 * asserted against the source rather than against a running app — because the
 * property being protected is an absence, and an absence cannot be demonstrated
 * by exercising the code that is supposed to lack it.
 *
 * Comments are stripped before every source assertion, so a doc comment cannot
 * satisfy a claim about code. That is the whole reason this file reads the
 * sources instead of trusting the documentation beside them.
 */

/** The source with comment lines removed, so assertions cannot be satisfied by prose. */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

async function codeOf(relative: string): Promise<string> {
  return stripCommentLines(await readFile(new URL(relative, import.meta.url), 'utf8'))
}

let dir: string
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-conscious-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {})
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

describe('the host lane before Core has started', () => {
  it('says nothing rather than manufacturing an empty mind', () => {
    expect(host?.consciousness(), 'a host with no Core reports null').toBeNull()
  })

  it('pushes nothing to a window that attaches early', () => {
    const seen: ConsciousContextProjection[] = []
    host?.onConsciousness((projection) => seen.push(projection))
    expect(seen, 'attached and told nothing').toHaveLength(0)
  })

  it('stops delivering once disposed', () => {
    const seen: ConsciousContextProjection[] = []
    const dispose = host?.onConsciousness((projection) => seen.push(projection))
    dispose?.()
    expect(seen).toHaveLength(0)
  })
})

describe('the host owns no conscious-context authority, and says so structurally', () => {
  it('offers exactly a read and a subscription, and no verb', () => {
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(host))
    const conscious = own.filter((name) => name.toLowerCase().includes('conscious'))
    // `broadcastConsciousness` is the internal direction Core pushes in — Core
    // calling the host, not the host accepting anything. It takes the snapshot
    // from Core rather than from a caller, so it is not a door; it is the hinge.
    expect(conscious.sort()).toEqual([
      'broadcastConsciousness',
      'consciousness',
      'onConsciousness',
    ])
  })

  it('has no method that could change what a window is shown', () => {
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(host))
    const suspicious = own.filter((name) =>
      /conscious.*(set|write|apply|ingest|merge|correct|refresh|rebuild|invalidate)/i.test(name),
    )
    expect(suspicious).toEqual([])
  })

  it('broadcasts rather than being told, so nothing can push a value in', () => {
    // `broadcast*` is how Core reaches windows. It is the only direction this
    // class has, and it takes the snapshot from Core rather than from a caller.
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(host))
    expect(own).toContain('broadcastConsciousness')
  })
})

describe('the preload bridge gives a window two reads and no verb', () => {
  it('lists no consciousness command in the renderer allowlist', async () => {
    const source = await codeOf('../../electron/preload.ts')
    const start = source.indexOf('const CORE_COMMANDS')
    const end = source.indexOf('function readString', start)
    expect(start, 'CORE_COMMANDS was not found').toBeGreaterThan(-1)
    expect(end, 'the end of CORE_COMMANDS was not found').toBeGreaterThan(start)
    const listed = source.slice(start, end)
    // The strongest statement this phase makes about the surface: there is no
    // `consciousness.*` name for `coreSubmit` to accept, so `coreSubmit` cannot
    // reach this lane at all.
    expect(listed.toLowerCase()).not.toMatch(/conscious/)
  })

  it('exposes exactly two consciousness methods on the API object', async () => {
    const source = await codeOf('../../electron/preload.ts')
    const keys = [...source.matchAll(/^\s{2}([a-zA-Z]*[Cc]onscious[a-zA-Z]*):\s/gm)].map((match) => match[1])
    expect(keys.sort()).toEqual(['coreConsciousness', 'onCoreConsciousness'])
  })

  it('reads and follows, and neither takes a payload', async () => {
    const source = await codeOf('../../electron/preload.ts')
    // The tolerant whitespace runs are deliberate. These assertions are about the
    // *shape* of the two methods - one takes nothing and resolves a projection, one
    // takes a handler and returns a disposer - and a claim about shape should not
    // be breakable by a formatter reflowing a parameter list. Comment lines are
    // already stripped above, so this still cannot be satisfied by prose.
    expect(source).toMatch(
      /coreConsciousness:\s*\(\):\s*Promise<ConsciousContextProjection \| null>\s*=>\s*\n?\s*ipcRenderer\.invoke\('freya:core:consciousness'\)/,
    )
    expect(source).toMatch(
      /onCoreConsciousness:\s*\(\s*\n?\s*handler:\s*\(projection:\s*ConsciousContextProjection\)\s*=>\s*void,?\s*\n?\s*\):\s*\(\(\)\s*=>\s*void\)\s*=>\s*\{/,
    )
    expect(source).toMatch(/ipcRenderer\.on\('freya:core:consciousness',\s*listener\)/)
    expect(source).toMatch(/ipcRenderer\.removeListener\('freya:core:consciousness',\s*listener\)/)
  })

  it('offers no generic channel escape hatch to smuggle one through', async () => {
    const source = await codeOf('../../electron/preload.ts')
    // Every Core function is named individually. A generic `invoke(channel)`
    // would make the allowlist above decorative.
    expect(source).not.toMatch(/ipcRenderer\.invoke\(channel/)
    expect(source).not.toMatch(/invoke:\s*\(/)
    expect(source).not.toMatch(/\bsend\(channel:/)
  })
})

describe('the main process registers one read channel and no write door', () => {
  it('names the channel exactly twice, both read paths', async () => {
    const source = await codeOf('../../electron/main.ts')
    expect([...source.matchAll(/'freya:core:consciousness'/g)]).toHaveLength(2)
    expect(source).toMatch(
      /ipcMain\.handle\('freya:core:consciousness', \(\) => requireCore\(\)\.consciousness\(\)\)/,
    )
    expect(source).toMatch(/webContents\.send\('freya:core:consciousness', projection\)/)
  })

  it('registers no listener a window could send into', async () => {
    const source = await codeOf('../../electron/main.ts')
    // `ipcMain.on` would be a door Core could be pushed through. There is none for
    // this lane, and the only two `ipcMain.on` calls in the app are Presence's.
    expect(source).not.toMatch(/ipcMain\.on\('freya:core:consciousness'/)
  })

  it('registers no write channel under any name', async () => {
    const source = (await codeOf('../../electron/main.ts')).toLowerCase()
    expect(source).not.toMatch(/consciousness:(write|submit|update|set|patch|refresh|rebuild|delete)/)
  })
})

describe('the renderer type surface agrees with the bridge', () => {
  it('declares exactly a read and a subscription', async () => {
    const source = await codeOf('../../src/platform/host.ts')
    const start = source.indexOf('export interface FreyaHostBridge {')
    expect(start, 'the bridge interface was not found').toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('\n}', start))
    const members = [...block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\(/gm)].map((match) => match[1])
    const conscious = members.filter((name) => name?.toLowerCase().includes('conscious'))
    expect(conscious.sort()).toEqual(['coreConsciousness', 'onCoreConsciousness'])
  })
})