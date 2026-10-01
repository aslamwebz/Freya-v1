import { randomUUID } from 'node:crypto'
import { withResearchAbort } from './async'
import { ResearchError, safeResearchError, type ResearchErrorCode } from './errors'
import { assertPublicUrl } from './url-policy'

export interface ReadableDocument {
  id: string
  url: string
  canonicalUrl: string | null
  title: string
  sourceDomain: string
  retrievedAt: string
  headings: string[]
  text: string
  links: { title: string; url: string }[]
  metadata: Record<string, string>
  contentLength: number
  truncated: boolean
}
export interface BrowserTarget {
  navigate(url: string, signal: AbortSignal): Promise<void>
  read(signal: AbortSignal): Promise<ReadableDocument>
  close(): Promise<void>
}
export interface BrowserTargetFactory { create(sessionId: string, signal: AbortSignal): Promise<BrowserTarget> }
export interface BrowserEvent { sessionId: string; stage: 'creating' | 'ready' | 'navigating' | 'reading' | 'closed'; failureCode?: ResearchErrorCode }
export interface BrowserSession { id: string; state: 'ready' | 'navigating' | 'reading' }
export interface ManagedBrowserOptions { newId?: () => string; onEvent?: (event: BrowserEvent) => void }
// Electron destroys its window synchronously; this bounds optional asynchronous cleanup.
async function closeTarget(target: BrowserTarget): Promise<void> {
  await withResearchAbort(undefined, 1000, async () => target.close()).catch(() => {})
}
interface SessionEntry {
  id: string
  state: BrowserEvent['stage']
  controller: AbortController
  target?: BrowserTarget
}

export class ManagedBrowserService {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly closing = new Set<Promise<void>>()
  constructor(private readonly factory: BrowserTargetFactory, private readonly options: ManagedBrowserOptions = {}) {}

  private emit(entry: SessionEntry, failureCode?: ResearchErrorCode): void {
    // Observability must never become a resource owner or interrupt cleanup.
    try { this.options.onEvent?.({ sessionId: entry.id, stage: entry.state, ...(failureCode ? { failureCode } : {}) }) } catch { /* observer isolation */ }
  }

  async create(options: { signal?: AbortSignal } = {}): Promise<string> {
    if (options.signal?.aborted) throw new ResearchError('cancelled')
    const id = this.options.newId?.() ?? randomUUID()
    if (this.sessions.has(id)) throw new ResearchError('invalid_response')
    const entry: SessionEntry = { id, state: 'creating', controller: new AbortController() }
    this.sessions.set(id, entry)
    this.emit(entry)
    try {
      await withResearchAbort(AbortSignal.any([entry.controller.signal, ...(options.signal ? [options.signal] : [])]), 15000, async (signal) => {
        const target = await this.factory.create(id, signal)
        // A factory may ignore abort. The late result is still ours to dispose of.
        if (signal.aborted || entry.state === 'closed') {
          await closeTarget(target)
          throw new ResearchError('cancelled')
        }
        entry.target = target
      })
      if (entry.state === 'closed') throw new ResearchError('cancelled')
      entry.state = 'ready'
      this.emit(entry)
      return id
    } catch (error) {
      const failure = safeResearchError(error, 'network_error')
      await this.dispose(entry, failure.code)
      throw failure
    }
  }

  private async operation<T>(id: string, stage: 'navigating' | 'reading', options: { signal?: AbortSignal }, run: (target: BrowserTarget, signal: AbortSignal) => Promise<T>): Promise<T> {
    const entry = this.sessions.get(id)
    if (!entry?.target || entry.state === 'closed') throw new ResearchError('cancelled')
    if (entry.state !== 'ready') throw new ResearchError('invalid_response')
    entry.state = stage
    this.emit(entry)
    try {
      const value = await withResearchAbort(AbortSignal.any([entry.controller.signal, ...(options.signal ? [options.signal] : [])]), 15000, (signal) => run(entry.target!, signal))
      if (entry.controller.signal.aborted) throw new ResearchError('cancelled')
      entry.state = 'ready'
      this.emit(entry)
      return value
    } catch (error) {
      const failure = safeResearchError(error, 'network_error')
      await this.dispose(entry, failure.code)
      throw failure
    }
  }

  async navigate(id: string, url: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.operation(id, 'navigating', options, (target, signal) => target.navigate(assertPublicUrl(url).href, signal))
  }

  async read(id: string, options: { signal?: AbortSignal } = {}): Promise<ReadableDocument> {
    return this.operation(id, 'reading', options, (target, signal) => target.read(signal))
  }

  private async dispose(entry: SessionEntry, failureCode?: ResearchErrorCode): Promise<void> {
    if (entry.state === 'closed') return
    entry.state = 'closed'
    this.sessions.delete(entry.id)
    entry.controller.abort()
    this.emit(entry, failureCode)
    if (entry.target) {
      const pending = closeTarget(entry.target)
      this.closing.add(pending)
      try { await pending } finally { this.closing.delete(pending) }
    }
  }

  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (entry) await this.dispose(entry)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((entry) => this.dispose(entry)))
    await Promise.all([...this.closing])
  }

  activeSessions(): BrowserSession[] {
    return [...this.sessions.values()].flatMap(({ id, state }) => state === 'ready' || state === 'navigating' || state === 'reading' ? [{ id, state }] : [])
  }

  async readWebPage(url: string, options: { signal?: AbortSignal } = {}): Promise<ReadableDocument> {
    const source = assertPublicUrl(url).href
    let id: string | undefined
    try {
      return await withResearchAbort(options.signal, 15000, async (signal) => {
        id = await this.create({ signal })
        await this.navigate(id, source, { signal })
        const document = await this.read(id, { signal })
        if (ManagedBrowserService.unreadable(document)) {
          throw new ResearchError('unsupported_document')
        }
        return document
      })
    } catch (error) { throw safeResearchError(error, 'network_error') }
    finally { if (id) await this.close(id) }
  }

  /**
   * True when a document carries nothing a person could read.
   *
   * A page whose only content was navigation and a cookie banner extracts to empty
   * text. Returning that as a successful read would put an empty document in front of
   * a person as though the page had been read, and into research as though a source
   * had contributed something.
   */
  private static unreadable(document: ReadableDocument): boolean {
    return document.text.trim().length === 0 && document.headings.length === 0 && document.links.length === 0
  }
}
