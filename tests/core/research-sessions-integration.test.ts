// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { SearchProvider, SearchResult } from '../../core/research/types'
import type { BrowserTarget, BrowserTargetFactory, ReadableDocument } from '../../core/research/browser'
import { MemorySearchSessionStore } from '../../core/research/sessions'

let directory = ''
let core: Core | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-eye-integration-'))
})

afterEach(async () => {
  await core?.stop('test teardown')
  core = undefined
  await rm(directory, { recursive: true, force: true })
})

const DOCUMENT: ReadableDocument = {
  id: 'doc',
  url: 'https://example.com/',
  canonicalUrl: null,
  title: 'Example',
  sourceDomain: 'example.com',
  retrievedAt: '2026-10-05T00:00:00.000Z',
  headings: [],
  text: 'example',
  links: [],
  metadata: {},
  contentLength: 7,
  truncated: false,
}

class BrowserFactory implements BrowserTargetFactory {
  async create(): Promise<BrowserTarget> {
    return {
      navigate: async () => {},
      read: async () => DOCUMENT,
      close: async () => {},
    }
  }
}

class PagedProvider implements SearchProvider {
  readonly id = 'paged'
  readonly calls: Array<{ query: string; limit: number; offset: number }> = []

  status() { return { ready: true, reason: 'ready' } }

  async search(
    query: string,
    options: { signal: AbortSignal; limit: number; offset?: number },
  ): Promise<SearchResult[]> {
    const offset = options.offset ?? 0
    this.calls.push({ query, limit: options.limit, offset })
    return Array.from({ length: options.limit }, (_, index) => {
      const n = offset * 10 + index
      return {
        title: `Cat video ${n} in the barn`,
        url: `https://youtube.com/watch?v=cat-${n}`,
        snippet: 'A black cat video filmed in the barn.',
        sourceDomain: 'youtube.com',
        rank: index + 1,
        publishedAt: null,
        retrievedAt: '2026-10-05T00:00:00.000Z',
      }
    })
  }
}

function command(name: string, payload?: unknown, requestId = name) {
  return core!.handleCommand({ command: name, requestId, payload } as never) as Promise<any>
}

async function start(
  provider = new PagedProvider(),
  store = new MemorySearchSessionStore('test session store is ephemeral'),
) {
  core = createCore({
    dataPath: join(directory, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    research: {
      searchProvider: provider,
      browserFactory: new BrowserFactory(),
      sessionStore: store,
    },
  })
  await core.start()
  return { provider, store }
}

describe("Freya's Eye Core integration", () => {
  it('creates a structured session without accepting renderer-controlled budgets or authority', async () => {
    await start()
    const response = await command('research.session.create', {
      request: 'find 100 cat videos',
      maxResults: 9999,
      pages: 9999,
      provider: 'attacker',
      principal: 'system',
      capability: 'security.resume',
    })

    expect(response.ok).toBe(true)
    expect(response.research.operation).toBe('session-created')
    expect(response.research.session.intent).toMatchObject({
      subject: 'cat',
      targetCount: 100,
      mediaType: 'video',
    })
    expect(response.research.session.persistence).toEqual({
      mode: 'ephemeral',
      durable: false,
      reason: 'test session store is ephemeral',
    })
    expect(JSON.stringify(response.research)).not.toMatch(/attacker|9999|security\.resume/)
  })

  it('collects 100 results through ten guarded requests of at most ten', async () => {
    const { provider } = await start()
    const created = await command('research.session.create', { request: 'find 100 cat videos' })
    const id = created.research.session.sessionId

    const collected = await command('research.session.collect', { sessionId: id })

    expect(collected.ok).toBe(true)
    expect(collected.research.operation).toBe('session-collected')
    expect(collected.research.session.sessionId).toBe(id)
    expect(collected.research.session.resultCount).toBe(100)
    expect(collected.research.session.state).toBe('completed')
    expect(provider.calls).toHaveLength(10)
    expect(provider.calls.every((call) => call.limit <= 10)).toBe(true)
    expect(provider.calls.map((call) => call.offset)).toEqual([0,1,2,3,4,5,6,7,8,9])
  })

  it('applies "in the barn" to the same Eye session instead of creating a barn search', async () => {
    await start()
    const created = await command('research.session.create', { request: 'find 100 cat videos' })
    const id = created.research.session.sessionId

    const followed = await command('research.session.followup', { sessionId: id, text: 'in the barn' })

    expect(followed.ok).toBe(true)
    expect(followed.research.ambiguous).toBe(false)
    expect(followed.research.session.sessionId).toBe(id)
    expect(followed.research.session.intent).toMatchObject({
      subject: 'cat',
      targetCount: 100,
      mediaType: 'video',
      constraints: ['in the barn'],
    })

    const sessions = await command('research.session.list')
    expect(sessions.research.sessions).toHaveLength(1)
    expect(sessions.research.sessions[0].sessionId).toBe(id)
  })

  it('returns ambiguity rather than silently changing intent for an unclear short follow-up', async () => {
    await start()
    const created = await command('research.session.create', { request: 'find 100 cat videos' })
    const id = created.research.session.sessionId

    const followed = await command('research.session.followup', { sessionId: id, text: 'barn' })

    expect(followed.ok).toBe(true)
    expect(followed.research.ambiguous).toBe(true)
    expect(followed.research.session.intent.constraints).toEqual([])
    expect(followed.research.session.intentVersion).toBe(1)
  })

  it('allows saved-session inspection after STOP ALL but refuses new collection/resume work', async () => {
    await start()
    const created = await command('research.session.create', { request: 'find 20 cat videos' })
    const id = created.research.session.sessionId

    await command('security.stopAll', { reason: 'owner stop' })

    expect((await command('research.session.read', { sessionId: id })).ok).toBe(true)
    expect((await command('research.session.list')).ok).toBe(true)
    expect((await command('research.session.collect', { sessionId: id })).ok).toBe(false)
    expect((await command('research.session.resume', { sessionId: id })).ok).toBe(false)
  })

  it('never writes the Eye query or result URLs into the journal', async () => {
    await start()
    const privateQuery = 'find 20 cat videos private-barn-phrase'
    const created = await command('research.session.create', { request: privateQuery })
    const id = created.research.session.sessionId
    await command('research.session.collect', { sessionId: id })

    const raw = await readFile(join(directory, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('private-barn-phrase')
    expect(raw).not.toContain('youtube.com')
    expect(raw).not.toContain('cat-0')
    expect(raw).toContain('research.search_completed')
  })

  it('preserves a named session through a new Core when the injected private store persists it', async () => {
    const store = new MemorySearchSessionStore('test persistent object')
    await start(new PagedProvider(), store)
    const created = await command('research.session.create', { request: 'find 20 cat videos' })
    const id = created.research.session.sessionId

    await core!.stop('restart')
    core = undefined

    await start(new PagedProvider(), store)
    const read = await command('research.session.read', { sessionId: id })
    expect(read.ok).toBe(true)
    expect(read.research.session.sessionId).toBe(id)
    expect(read.research.session.intent.subject).toBe('cat')
  })
})
