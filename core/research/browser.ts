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
interface SessionEntry {
  id: string
  state: BrowserEvent['stage']
  controller: AbortController
  target?: BrowserTarget
}

export class ManagedBrowserService {
  private readonly sessions = new Map<string, SessionEntry>()
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
          await target.close().catch(() => {})
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
    const source = assertPublicUrl(url).href
    return this.operation(id, 'navigating', options, (target, signal) => target.navigate(source, signal))
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
    await entry.target?.close().catch(() => {})
  }

  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (entry) await this.dispose(entry)
  }

  async closeAll(): Promise<void> { await Promise.all([...this.sessions.values()].map((entry) => this.dispose(entry))) }

  activeSessions(): BrowserSession[] {
    return [...this.sessions.values()].flatMap(({ id, state }) => state === 'ready' || state === 'navigating' || state === 'reading' ? [{ id, state }] : [])
  }

  async readWebPage(url: string, options: { signal?: AbortSignal } = {}): Promise<ReadableDocument> {
    const source = assertPublicUrl(url).href
    const id = await this.create(options)
    try {
      await this.navigate(id, source, options)
      return await this.read(id, options)
    } finally { await this.close(id) }
  }
}
