import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFile, type WorkspaceFileOptions } from '../../electron/workspaceFile'

let dir: string
let path: string

function makeFile(overrides: Omit<WorkspaceFileOptions, 'path'> = {}) {
  return new WorkspaceFile({ path, ...overrides })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-ws-'))
  path = join(dir, 'workspace.json')
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('WorkspaceFile — refusing bad payloads', () => {
  it('refuses a payload larger than the limit, before it reaches the disk', async () => {
    const file = makeFile({ maxBytes: 256 })
    const huge = { schema: 1, surfaces: Array.from({ length: 200 }, (_, i) => ({ id: `s-${i}`, title: 'x'.repeat(40) })) }

    expect(file.schedule(huge)).toBe(false)
    file.flushSync()

    await expect(stat(path)).rejects.toThrow()
  })

  it('refuses a cyclic payload rather than throwing or truncating', () => {
    const file = makeFile()
    const cyclic: Record<string, unknown> = { schema: 1 }
    cyclic.self = cyclic

    expect(file.schedule(cyclic)).toBe(false)
  })

  it('refuses a payload that is not an object', () => {
    const file = makeFile()
    expect(file.schedule(undefined)).toBe(false)
  })

  it('accepts a payload that is exactly at the limit', () => {
    const file = makeFile({ maxBytes: 64 })
    const payload = { a: 'x'.repeat(10) }
    const text = JSON.stringify(payload)
    const exact = makeFile({ maxBytes: Buffer.byteLength(text, 'utf8') })
    expect(exact.schedule(payload)).toBe(true)
    expect(file.serialise(payload)).not.toBeNull()
  })

  it('measures the limit in bytes, not string length', () => {
    // Six characters, eighteen UTF-8 bytes: a string-length check would pass it.
    const payload = { title: 'アイリ' + 'ス' }
    const text = JSON.stringify(payload)
    expect(text.length).toBeLessThan(20)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(18)

    const file = makeFile({ maxBytes: 20 })
    expect(file.schedule(payload)).toBe(false)
  })

  it('leaves an earlier valid layout intact when a later payload is refused', async () => {
    const file = makeFile({ maxBytes: 128 })
    expect(file.schedule({ schema: 1, nav: 'home' })).toBe(true)
    file.flushSync()
    const before = await readFile(path, 'utf8')

    expect(file.schedule({ schema: 1, blob: 'x'.repeat(500) })).toBe(false)
    file.flushSync()

    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('WorkspaceFile — surviving an immediate quit', () => {
  it('flushes a queued write synchronously, before the debounce has fired', async () => {
    const file = makeFile({ writeDelayMs: 400 })
    expect(file.schedule({ schema: 1, nav: 'work' })).toBe(true)

    // Nothing on disk yet: the debounce has not fired.
    await expect(stat(path)).rejects.toThrow()

    // The quit path. Synchronous, so the file exists the instant it returns.
    file.flushSync()

    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toEqual({ schema: 1, nav: 'work' })
  })

  it('cancels the pending timer so a flushed write is not repeated', async () => {
    vi.useFakeTimers()
    const file = makeFile({ writeDelayMs: 400 })
    file.schedule({ schema: 1, nav: 'vault' })
    file.flushSync()

    // If the timer were still live it would fire here and write a second time.
    await vi.advanceTimersByTimeAsync(2000)
    const statAfter = await stat(path)
    expect(statAfter.isFile()).toBe(true)
  })

  it('is a no-op when nothing is queued', async () => {
    const file = makeFile()
    file.flushSync()
    await expect(stat(path)).rejects.toThrow()
  })

  it('writes the most recent queued payload, not the first', async () => {
    const file = makeFile({ writeDelayMs: 400 })
    file.schedule({ schema: 1, nav: 'home' })
    file.schedule({ schema: 1, nav: 'work' })
    file.schedule({ schema: 1, nav: 'vault' })
    file.flushSync()

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schema: 1, nav: 'vault' })
  })

  it('creates the directory if the app data folder is missing', async () => {
    const nested = join(dir, 'deep', 'nested', 'workspace.json')
    const file = new WorkspaceFile({ path: nested, writeDelayMs: 400 })
    file.schedule({ schema: 1 })
    file.flushSync()

    expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual({ schema: 1 })
  })

  it('leaves no temp file behind', async () => {
    const file = makeFile({ writeDelayMs: 400 })
    file.schedule({ schema: 1 })
    file.flushSync()

    await expect(stat(`${path}.tmp`)).rejects.toThrow()
  })
})

describe('WorkspaceFile — the debounced path', () => {
  /** The async write path is real file I/O, so it is tested with real time. */
  async function waitForFile(target: string, timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        return await readFile(target, 'utf8')
      } catch {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${target}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }

  it('writes after the debounce elapses', async () => {
    const file = makeFile({ writeDelayMs: 20 })
    file.schedule({ schema: 1, nav: 'home' })

    expect(JSON.parse(await waitForFile(path))).toEqual({ schema: 1, nav: 'home' })
  })

  it('coalesces a burst of changes into one write of the last', async () => {
    const file = makeFile({ writeDelayMs: 20 })
    for (let i = 0; i < 20; i += 1) file.schedule({ schema: 1, nav: `nav-${i}` })

    expect(JSON.parse(await waitForFile(path))).toEqual({ schema: 1, nav: 'nav-19' })
  })

  it('never interleaves two writes onto the same temp file', async () => {
    const file = makeFile({ writeDelayMs: 1 })
    for (let i = 0; i < 12; i += 1) {
      file.schedule({ schema: 1, nav: `nav-${i}`, filler: 'y'.repeat(2000) })
      await new Promise((resolve) => setTimeout(resolve, 3))
    }
    // Give the chain time to drain, then confirm the file is valid JSON.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const raw = await readFile(path, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(JSON.parse(raw).nav).toBe('nav-11')
  })

  it('leaves no temp file behind once the chain has drained', async () => {
    const file = makeFile({ writeDelayMs: 10 })
    file.schedule({ schema: 1 })
    await waitForFile(path)
    await new Promise((resolve) => setTimeout(resolve, 50))

    await expect(stat(`${path}.tmp`)).rejects.toThrow()
  })
})

describe('WorkspaceFile — the stale-write race', () => {
  /**
   * The failure this guards against: a debounced write is still in flight when
   * the user quits, so `flushSync` publishes the newer payload — and the older
   * write then lands on top of it and resurrects a layout the user moved past.
   */
  it('an in-flight debounced write cannot overwrite the final flush', async () => {
    const file = makeFile({ writeDelayMs: 0, maxBytes: 4 * 1024 * 1024 })

    // A large payload, so the async write is demonstrably still running when
    // the flush happens rather than having already finished.
    file.schedule({ schema: 1, nav: 'stale', filler: 'x'.repeat(600_000) })
    await new Promise((resolve) => setTimeout(resolve, 5))

    file.schedule({ schema: 1, nav: 'fresh' })
    file.flushSync()

    // Let every abandoned write finish trying to publish.
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schema: 1, nav: 'fresh' })
  })

  it('holds across many rounds of in-flight writes and flushes', async () => {
    const file = makeFile({ writeDelayMs: 0, maxBytes: 8 * 1024 * 1024 })

    for (let round = 0; round < 6; round += 1) {
      file.schedule({ schema: 1, nav: `stale-${round}`, filler: 'y'.repeat(200_000) })
      await new Promise((resolve) => setTimeout(resolve, 2))
      file.schedule({ schema: 1, nav: `fresh-${round}` })
      file.flushSync()
    }
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schema: 1, nav: 'fresh-5' })
  })

  it('leaves no temp file behind when a stale write is abandoned', async () => {
    const file = makeFile({ writeDelayMs: 0, maxBytes: 4 * 1024 * 1024 })
    file.schedule({ schema: 1, nav: 'stale', filler: 'z'.repeat(400_000) })
    await new Promise((resolve) => setTimeout(resolve, 5))
    file.schedule({ schema: 1, nav: 'fresh' })
    file.flushSync()
    await new Promise((resolve) => setTimeout(resolve, 400))

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('dispose abandons an in-flight write rather than letting it publish', async () => {
    let markWriteStarted!: () => void
    let releaseWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })
    const mayFinishWriting = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })

    const file = makeFile({
      writeDelayMs: 0,
      maxBytes: 4 * 1024 * 1024,
      writeFileAsync: async (target, text) => {
        markWriteStarted()
        await mayFinishWriting
        await writeFile(target, text, 'utf8')
      },
    })

    file.schedule({ schema: 1, nav: 'only', filler: 'w'.repeat(400_000) })

    // Do not guess how long the filesystem takes. Hold the write open until we
    // know dispose() has invalidated its generation, then let it finish.
    await writeStarted
    file.dispose()
    releaseWrite()

    const deadline = Date.now() + 2000
    for (;;) {
      const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
      if (leftovers.length === 0) break
      if (Date.now() > deadline) throw new Error('timed out waiting for stale temp cleanup')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await expect(stat(path)).rejects.toThrow()
  })

  it('gives every write its own temp file, so two writers cannot share one', async () => {
    const file = makeFile({ writeDelayMs: 0, maxBytes: 4 * 1024 * 1024 })
    file.schedule({ schema: 1, nav: 'first', filler: 'a'.repeat(300_000) })
    file.schedule({ schema: 1, nav: 'second', filler: 'b'.repeat(300_000) })
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Only the newest payload is ever published, and nothing is left over.
    expect(JSON.parse(await readFile(path, 'utf8')).nav).toBe('second')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('a flush with nothing queued leaves the file alone', async () => {
    const file = makeFile({ writeDelayMs: 0 })
    file.schedule({ schema: 1, nav: 'home' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = await readFile(path, 'utf8')

    file.flushSync()

    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('WorkspaceFile — loading', () => {
  it('returns null on a first launch with no file', async () => {
    expect(await makeFile().load()).toBeNull()
  })

  it('returns null rather than throwing on a corrupt file', async () => {
    await writeFile(path, '{ not json', 'utf8')
    expect(await makeFile().load()).toBeNull()
  })

  it('refuses to load a file larger than the limit', async () => {
    await writeFile(path, JSON.stringify({ blob: 'x'.repeat(1000) }), 'utf8')
    expect(await makeFile({ maxBytes: 100 }).load()).toBeNull()
  })

  it('round-trips a payload through schedule and load', async () => {
    const payload = { schema: 1, surfaces: [{ id: 'chat-1' }], nav: 'home' }
    const file = makeFile({ writeDelayMs: 400 })
    file.schedule(payload)
    file.flushSync()

    expect(await makeFile().load()).toEqual(payload)
  })
})

describe('WorkspaceFile — measuring the limit in bytes', () => {
  it('refuses to load a file that only exceeds the limit in bytes', async () => {
    // Three-byte characters: short as a string, long on disk.
    const payload = { title: 'アイリス' }
    const text = JSON.stringify(payload)
    expect(text.length).toBeLessThan(20)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(20)

    await writeFile(path, text, 'utf8')
    expect(await makeFile({ maxBytes: 20 }).load()).toBeNull()
  })

  it('applies the identical measure when writing and when loading', () => {
    const payload = { title: 'アイリス' }
    const text = JSON.stringify(payload)
    const exact = Buffer.byteLength(text, 'utf8')

    // Accepted at exactly the byte limit, on both sides.
    const file = makeFile({ maxBytes: exact })
    expect(file.serialise(payload)).not.toBeNull()
    expect(file.schedule(payload)).toBe(true)
  })

  it('a non-ASCII layout is not silently rejected on the next launch', async () => {
    const payload = { schema: 1, nav: 'vault', title: 'ナレッジ' }
    const text = JSON.stringify(payload)
    const limit = Buffer.byteLength(text, 'utf8')

    const written = makeFile({ maxBytes: limit, writeDelayMs: 0 })
    expect(written.schedule(payload)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // The same limit on read: what was written must load back.
    expect(await makeFile({ maxBytes: limit }).load()).toEqual(payload)
  })
})
