// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedBrowserService, type BrowserTarget, type ReadableDocument } from '../../../core/research/browser'

const document: ReadableDocument = { id: 'doc', url: 'https://example.com/', canonicalUrl: null, title: 'Title', sourceDomain: 'example.com', retrievedAt: '2026-10-01T00:00:00.000Z', headings: [], text: 'Content', links: [], metadata: {}, contentLength: 7, truncated: false }
function target(): BrowserTarget {
  return { navigate: vi.fn(async () => {}), read: vi.fn(async () => document), close: vi.fn(async () => {}) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())
describe('managed browser', () => {
  it('creates, reads and closes a source, emitting metadata only', async () => {
    const page = target()
    const events: unknown[] = []
    const browser = new ManagedBrowserService({ create: async () => page }, { newId: () => 'session', onEvent: (event) => events.push(event) })
    await expect(browser.readWebPage(document.url)).resolves.toEqual(document)
    expect(page.close).toHaveBeenCalledTimes(1)
    expect(browser.activeSessions()).toEqual([])
    expect(JSON.stringify(events)).not.toContain(document.url)
    expect(JSON.stringify(events)).not.toContain('Content')
  })
  it('keeps only metadata and makes close idempotent', async () => {
    const page = target()
    const browser = new ManagedBrowserService({ create: async () => page }, { newId: () => 'session' })
    const id = await browser.create()
    expect(browser.activeSessions()).toEqual([{ id, state: 'ready' }])
    await browser.navigate(id, document.url)
    expect(browser.activeSessions()).toEqual([{ id, state: 'ready' }])
    await Promise.all([browser.close(id), browser.close(id), browser.closeAll()])
    expect(page.close).toHaveBeenCalledTimes(1)
    await expect(browser.read(id)).rejects.toMatchObject({ code: 'cancelled' })
  })
  it.each(['create', 'navigate', 'read'] as const)('redacts %s failure and closes all acquired resources', async (stage) => {
    const page = target()
    if (stage !== 'create') page[stage] = vi.fn(async () => { throw new Error('private-host-detail') })
    const browser = new ManagedBrowserService({ create: async () => { if (stage === 'create') throw new Error('private-host-detail'); return page } })
    await expect(browser.readWebPage(document.url)).rejects.toMatchObject({ code: 'network_error', message: 'The network request failed.' })
    expect(browser.activeSessions()).toEqual([])
    expect(page.close).toHaveBeenCalledTimes(stage === 'create' ? 0 : 1)
  })
  it('rejects pre-aborted and unsafe source requests without creating resources', async () => {
    const create = vi.fn(async () => target())
    const browser = new ManagedBrowserService({ create })
    await expect(browser.readWebPage(document.url, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' })
    await expect(browser.readWebPage('http://127.0.0.1/')).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(create).not.toHaveBeenCalled()
    expect(browser.activeSessions()).toEqual([])
  })
  it.each(['create', 'navigate', 'read'] as const)('times out %s even if dependency ignores cancellation', async (stage) => {
    vi.useFakeTimers()
    const page = target()
    const never = () => new Promise<never>(() => {})
    if (stage !== 'create') page[stage] = never
    const browser = new ManagedBrowserService({ create: stage === 'create' ? never : async () => page })
    const waiting = expect(browser.readWebPage(document.url)).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(15000)
    await waiting
    expect(browser.activeSessions()).toEqual([])
    expect(page.close).toHaveBeenCalledTimes(stage === 'create' ? 0 : 1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['create', 'navigate', 'read'] as const)('closes late %s completion without resurrection after abort', async (stage) => {
    const page = target()
    const pending = deferred<never>()
    const controller = new AbortController()
    if (stage !== 'create') page[stage] = () => pending.promise
    const browser = new ManagedBrowserService({ create: stage === 'create' ? () => pending.promise : async () => page })
    const promise = browser.readWebPage(document.url, { signal: controller.signal })
    const rejected = expect(promise).rejects.toMatchObject({ code: 'cancelled' })
    for (let i = 0; i < 15; i++) await Promise.resolve()
    controller.abort()
    await rejected
    pending.resolve((stage === 'create' ? page : stage === 'read' ? document : undefined) as never)
    for (let i = 0; i < 15; i++) await Promise.resolve()
    expect(page.close).toHaveBeenCalledTimes(1)
    expect(browser.activeSessions()).toEqual([])
  })
  it('closeAll cancels pending creation and closes its late target', async () => {
    const page = target()
    const pending = deferred<BrowserTarget>()
    const browser = new ManagedBrowserService({ create: () => pending.promise })
    const waiting = expect(browser.create()).rejects.toMatchObject({ code: 'cancelled' })
    await Promise.resolve()
    await browser.closeAll()
    await waiting
    pending.resolve(page)
    for (let i = 0; i < 15; i++) await Promise.resolve()
    expect(page.close).toHaveBeenCalledTimes(1)
    expect(browser.activeSessions()).toEqual([])
  })
  it('event observer failure does not leak a target', async () => {
    const page = target()
    const browser = new ManagedBrowserService({ create: async () => page }, { onEvent: () => { throw new Error('observer') } })
    await expect(browser.readWebPage(document.url)).resolves.toEqual(document)
    expect(page.close).toHaveBeenCalledTimes(1)
  })
})
