// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MemorySearchSessionStore,
  SearchSessionManager,
  applyIntentPatch,
  parseSearchRequest,
  patchFromFollowUp,
  queryForIntent,
} from '../../../core/research/sessions'
import type { SearchResult } from '../../../core/research/types'

function row(page: number, index: number, extras: Partial<SearchResult> = {}): SearchResult {
  const n = page * 10 + index
  return {
    title: `Cat video ${n} in the barn`,
    url: `https://youtube.com/watch?v=${n}`,
    snippet: 'A black cat playing in the barn.',
    sourceDomain: 'youtube.com',
    rank: index + 1,
    publishedAt: null,
    retrievedAt: '2026-10-05T00:00:00.000Z',
    ...extras,
  }
}

describe("Freya's Eye search sessions", () => {
  it('parses a bounded media intent from "find 100 cat videos"', () => {
    expect(parseSearchRequest('find 100 cat videos').intent).toEqual({
      subject: 'cat',
      targetCount: 100,
      mediaType: 'video',
      constraints: [],
      exclusions: [],
      site: null,
    })
  })

  it('patches "in the barn" onto the same active intent', () => {
    const current = parseSearchRequest('find 100 cat videos').intent
    const interpreted = patchFromFollowUp('in the barn', current)
    expect(interpreted).toEqual({ patch: { addConstraints: ['in the barn'] }, ambiguous: false })
    expect(applyIntentPatch(current, interpreted.patch!)).toMatchObject({
      subject: 'cat',
      targetCount: 100,
      mediaType: 'video',
      constraints: ['in the barn'],
    })
  })

  it('handles count, site, media and exclusion corrections deterministically', () => {
    const current = parseSearchRequest('find 100 cat videos').intent
    expect(patchFromFollowUp('make it 50', current)).toEqual({ patch: { targetCount: 50 }, ambiguous: false })
    expect(patchFromFollowUp('only YouTube', current)).toEqual({ patch: { site: 'youtube.com' }, ambiguous: false })
    expect(patchFromFollowUp('only images', current)).toEqual({ patch: { mediaType: 'image' }, ambiguous: false })
    expect(patchFromFollowUp('not shorts', current)).toEqual({ patch: { addExclusions: ['shorts'] }, ambiguous: false })
  })

  it('asks instead of guessing for an ambiguous short correction', () => {
    const current = parseSearchRequest('find 100 cat videos').intent
    expect(patchFromFollowUp('barn', current)).toEqual({ patch: null, ambiguous: true })
  })

  it('builds a bounded provider query from the structured intent', () => {
    const intent = applyIntentPatch(parseSearchRequest('find 100 cat videos').intent, {
      addConstraints: ['in the barn'],
      addExclusions: ['shorts'],
      site: 'youtube.com',
    })
    expect(queryForIntent(intent)).toBe('cat videos in the barn site:youtube.com -shorts')
  })

  it('collects 100 results as ten requests of at most ten and never widens the low-level cap', async () => {
    const calls: Array<{ limit: number | undefined; offset: number | undefined }> = []
    const manager = new SearchSessionManager({
      newId: () => 'eye-100',
      now: () => new Date('2026-10-05T00:00:00.000Z'),
      searcher: {
        searchWeb: async (_query, options) => {
          const opts = options ?? {}
          calls.push({ limit: opts.limit, offset: opts.offset })
          const page = opts.offset ?? 0
          return Array.from({ length: opts.limit ?? 10 }, (_, index) => row(page, index))
        },
      },
    })

    const created = await manager.create('find 100 cat videos')
    const done = await manager.collect(created.sessionId)

    expect(done.state).toBe('completed')
    expect(done.results).toHaveLength(100)
    expect(calls).toHaveLength(10)
    expect(calls.every((call) => (call.limit ?? 0) <= 10)).toBe(true)
    expect(calls.map((call) => call.offset)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(done.results.map((result) => result.url)).size).toBe(100)
    expect(done.results.every((result) => result.collection === 'Videos Found')).toBe(true)
  })

  it('deduplicates results across pages', async () => {
    const manager = new SearchSessionManager({
      newId: () => 'eye-dedupe',
      searcher: {
        searchWeb: async (_query, options) => {
          const page = options?.offset ?? 0
          if (page === 0) return Array.from({ length: 10 }, (_, index) => row(0, index))
          return [row(0, 0), ...Array.from({ length: 9 }, (_, index) => row(page, index))]
        },
      },
    })
    const created = await manager.create('find 20 cat videos')
    const done = await manager.collect(created.sessionId, { maxPages: 3 })
    expect(new Set(done.results.map((result) => result.url)).size).toBe(done.results.length)
    expect(done.results.length).toBeGreaterThanOrEqual(18)
  })

  it('patches the same session, resets paging, and keeps only results compatible with the correction', async () => {
    const store = new MemorySearchSessionStore()
    const manager = new SearchSessionManager({
      newId: () => 'eye-patch',
      store,
      searcher: {
        searchWeb: async () => [
          row(0, 0),
          row(0, 1, { title: 'Cat video on a sofa', snippet: 'A cat indoors on a sofa.' }),
          row(0, 2, { title: 'Black cat video in the barn', snippet: 'Black cat in the barn.' }),
        ],
      },
    })
    const created = await manager.create('find 3 cat videos')
    const initial = await manager.collect(created.sessionId, { maxPages: 1 })
    expect(initial.results).toHaveLength(3)

    const patched = await manager.patchFollowUp(created.sessionId, 'in the barn')
    expect(patched.ambiguous).toBe(false)
    expect(patched.session.sessionId).toBe(created.sessionId)
    expect(patched.session.intent.constraints).toEqual(['in the barn'])
    expect(patched.session.page).toBe(0)
    expect(patched.session.intentVersion).toBe(2)
    expect(patched.session.results.map((result) => result.title)).not.toContain('Cat video on a sofa')
    expect(patched.session.results.every((result) => /barn/i.test(`${result.title} ${result.snippet}`))).toBe(true)
  })

  it('requires all meaningful terms when preserving results for "only black cats"', async () => {
    const manager = new SearchSessionManager({
      newId: () => 'eye-black',
      searcher: {
        searchWeb: async () => [
          row(0, 0, { title: 'Black cat video', snippet: 'A black cat.' }),
          row(0, 1, { title: 'White cat video', snippet: 'A white cat.' }),
        ],
      },
    })
    const created = await manager.create('find 2 cat videos')
    await manager.collect(created.sessionId, { maxPages: 1 })
    const patched = await manager.patchFollowUp(created.sessionId, 'only black cats')
    expect(patched.session.results.map((result) => result.title)).toEqual(['Black cat video'])
  })

  it('supports explicit pause, resume and cancellation without creating a new session', async () => {
    const manager = new SearchSessionManager({
      newId: () => 'eye-state',
      searcher: { searchWeb: async () => [] },
    })
    const created = await manager.create('find cat videos')
    expect((await manager.pause(created.sessionId)).state).toBe('paused')
    expect((await manager.resume(created.sessionId)).state).toBe('active')
    const cancelled = await manager.cancel(created.sessionId)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.sessionId).toBe(created.sessionId)
    expect((await manager.resume(created.sessionId)).state).toBe('cancelled')
  })

  it('classifies obvious media URLs into persistent result collections', async () => {
    const manager = new SearchSessionManager({
      newId: () => 'eye-media',
      searcher: {
        searchWeb: async () => [
          row(0, 0, { title: 'Photo', url: 'https://example.com/cat.jpg', sourceDomain: 'example.com' }),
          row(0, 1, { title: 'Audio', url: 'https://example.com/cat.mp3', sourceDomain: 'example.com' }),
          row(0, 2, { title: 'Report', url: 'https://example.com/cat.pdf', sourceDomain: 'example.com' }),
        ],
      },
    })
    const created = await manager.create({
      subject: 'cats',
      targetCount: 3,
      mediaType: 'auto',
      constraints: [],
      exclusions: [],
      site: null,
    })
    const done = await manager.collect(created.sessionId, { maxPages: 1 })
    expect(done.results.map((result) => result.collection)).toEqual(['Images Found', 'Audio Found', 'Files Found'])
  })
})


describe('Finder collection in Eye', () => {
  it('sends the requested vertical and retains the original request', async () => {
    const calls: unknown[] = []
    const manager = new SearchSessionManager({ searcher: { searchWeb: async (_query, options) => { calls.push(options); return [] } } })
    const created = await manager.create('  find 3 podcasts about climate on example.org  ')
    expect(created).toMatchObject({ ownerText: '  find 3 podcasts about climate on example.org  ', intent: { site: 'example.org', mediaType: 'audio' } })
    await manager.collect(created.sessionId)
    expect(calls[0]).toMatchObject({ vertical: 'audio' })
  })
  it('keeps domain matching on hostname boundaries', async () => {
    const manager = new SearchSessionManager({ searcher: { searchWeb: async () => [row(0, 0, { sourceDomain: 'notexample.org', url: 'https://notexample.org/podcast.mp3' })] } })
    const created = await manager.create('find audio on example.org')
    const done = await manager.collect(created.sessionId)
    expect(done.results).toHaveLength(0)
  })
})


describe('Eye completeness and source identity', () => {
  it('reports partial when a provider exhausts before the requested count', async () => {
    const manager = new SearchSessionManager({ newId: () => 'short-eye', searcher: { searchWeb: async () => [row(0, 0)] } })
    const session = await manager.create('find 10 cat videos')
    const result = await manager.collect(session.sessionId)
    expect(result.state).toBe('partial')
    expect(result.results).toHaveLength(1)
  })
  it('does not classify an article on YouTube as a video', async () => {
    const manager = new SearchSessionManager({ newId: () => 'article-eye', searcher: { searchWeb: async () => [row(0, 0, { url: 'https://youtube.com/about/policies', title: 'YouTube policies', snippet: 'Platform rules.', vertical: 'web' })] } })
    const session = await manager.create('find 1 websites about policies')
    const result = await manager.collect(session.sessionId)
    expect(result.results[0]?.mediaType).toBe('web')
  })
})
