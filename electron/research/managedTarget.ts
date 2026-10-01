import { randomUUID } from 'node:crypto'
import { BrowserWindow, session, type Session } from 'electron'
import type { BrowserTarget, BrowserTargetFactory, ReadableDocument } from '../../core/research/browser'
import { withResearchAbort } from '../../core/research/async'
import { ResearchError, safeResearchError } from '../../core/research/errors'
import type { SafeHttpTransport } from '../../core/research/transport'
import { assertPublicUrl } from '../../core/research/url-policy'
import { EXTRACTION_SCRIPT, normalizeExtractedDocument } from './extract'

// Inline presentation CSS preserves visibility; all stylesheet/resource URL loads are denied.
export const RESEARCH_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
const SCHEME = 'freya-research'

class ElectronBrowserTarget implements BrowserTarget {
  private window?: BrowserWindow
  private closed = false
  private busy = false
  private loading = false
  private served = false
  private html: string | null = null
  private source: { url: string; retrievedAt: string } | null = null
  private readonly lifetime = new AbortController()
  private terminalFailure?: ResearchError
  private cleanup?: Promise<void>
  private readonly internalUrl = `${SCHEME}://document/${randomUUID()}`
  private readonly prevent = (event: { preventDefault(): void }): void => event.preventDefault()
  private readonly crashed = (): void => { this.terminalFailure = new ResearchError('network_error'); void this.close() }
  private readonly externallyClosed = (): void => { if (!this.closed) this.crashed() }

  constructor(private readonly id: string, private readonly ses: Session, private readonly transport: SafeHttpTransport, private readonly now: () => Date) {}

  initialize(): void {
    this.ses.setPermissionCheckHandler(() => false)
    this.ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.ses.on('will-download', this.prevent)
    this.ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: this.closed || !this.loading || details.resourceType !== 'mainFrame' || details.url !== this.internalUrl }))
    this.ses.protocol.handle(SCHEME, (request) => {
      if (this.closed || !this.loading || this.served || this.html === null || request.url !== this.internalUrl || request.method !== 'GET') return new Response(null, { status: 403 })
      this.served = true
      return new Response(this.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': RESEARCH_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
    })
    this.window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: this.ses, sandbox: true, contextIsolation: true,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webSecurity: true, webviewTag: false, devTools: false,
        safeDialogs: true, disableDialogs: true, spellcheck: false, navigateOnDragDrop: false,
      },
    })
    const contents = this.window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', this.prevent)
    contents.on('will-frame-navigate', this.prevent)
    contents.on('will-redirect', this.prevent)
    contents.on('will-attach-webview', this.prevent)
    contents.on('render-process-gone', this.crashed)
    this.window.on('closed', this.externallyClosed)
  }

  private async run<T>(signal: AbortSignal, operation: (active: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw this.terminalFailure ?? new ResearchError('cancelled')
    if (this.busy) throw new ResearchError('invalid_response')
    this.busy = true
    try {
      return await withResearchAbort(AbortSignal.any([signal, this.lifetime.signal]), 15000, async (active) => {
        const result = await operation(active)
        if (this.closed || active.aborted) throw this.terminalFailure ?? new ResearchError('cancelled')
        return result
      })
    } catch (error) {
      // close() destroys synchronously. Public cancellation must not wait for storage cleanup.
      void this.close()
      throw this.terminalFailure ?? safeResearchError(error, 'network_error')
    } finally { this.busy = false }
  }

  async navigate(url: string, signal: AbortSignal): Promise<void> {
    return this.run(signal, async (active) => {
      this.source = null
      const response = await this.transport.get(assertPublicUrl(url).href, { signal: active, maxBytes: 2097152, timeoutMs: 15000, redirects: 3, headers: { accept: 'text/html' } })
      if (active.aborted || this.closed) throw new ResearchError('cancelled')
      if (response.body.byteLength > 2097152) throw new ResearchError('response_too_large')
      if (response.status < 200 || response.status >= 300 || !/^text\/html(?:\s*;|\s*$)/i.test(response.headers['content-type'] ?? '')) throw new ResearchError('unsupported_document')
      const source = assertPublicUrl(response.url).href
      this.html = Buffer.from(response.body).toString('utf8')
      this.served = false
      this.loading = true
      try { await this.window!.loadURL(this.internalUrl) }
      finally { this.loading = false; this.html = null }
      if (active.aborted || this.closed) throw new ResearchError('cancelled')
      this.source = { url: source, retrievedAt: this.now().toISOString() }
    })
  }

  async read(signal: AbortSignal): Promise<ReadableDocument> {
    return this.run(signal, async () => {
      if (!this.source) throw new ResearchError('unsupported_document')
      const data: unknown = await this.window!.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: EXTRACTION_SCRIPT }], false)
      return normalizeExtractedDocument(data, { id: this.id, ...this.source })
    })
  }

  close(): Promise<void> {
    if (this.cleanup) return this.cleanup
    this.closed = true
    this.loading = false
    this.html = null
    this.source = null
    this.lifetime.abort()
    // No asynchronous work precedes window destruction.
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    if (this.window) {
      const contents = this.window.webContents
      contents.removeListener('will-navigate', this.prevent)
      contents.removeListener('will-frame-navigate', this.prevent)
      contents.removeListener('will-redirect', this.prevent)
      contents.removeListener('will-attach-webview', this.prevent)
      contents.removeListener('render-process-gone', this.crashed)
      this.window.removeListener('closed', this.externallyClosed)
    }
    // Independent teardown steps: one failed Electron API must not skip the rest.
    for (const dispose of [
      () => this.ses.removeListener('will-download', this.prevent),
      () => this.ses.webRequest.onBeforeRequest(null),
      () => this.ses.protocol.unhandle(SCHEME),
      () => this.ses.setPermissionCheckHandler(null),
      () => this.ses.setPermissionRequestHandler(null),
    ]) {
      try { dispose() } catch { try { dispose() } catch { /* target stays closed and inaccessible */ } }
    }
    this.cleanup = withResearchAbort(undefined, 1000, async () => { await Promise.allSettled([this.ses.clearStorageData(), this.ses.clearCache()]) }).catch(() => {})
    return this.cleanup
  }
}

/** Main-process only. Requires Electron app readiness; no dependency installs or default session. */
export class ElectronBrowserTargetFactory implements BrowserTargetFactory {
  constructor(private readonly transport: SafeHttpTransport, private readonly now: () => Date = () => new Date()) {}
  async create(sessionId: string, signal: AbortSignal): Promise<BrowserTarget> {
    if (signal.aborted) throw new ResearchError('cancelled')
    let target: ElectronBrowserTarget | undefined
    try {
      const ses = session.fromPartition(`freya-research-${randomUUID()}`, { cache: false })
      target = new ElectronBrowserTarget(sessionId, ses, this.transport, this.now)
      target.initialize()
      if (signal.aborted) throw new ResearchError('cancelled')
      return target
    } catch (error) { void target?.close(); throw safeResearchError(error, 'network_error') }
  }
}
