// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SafeHttpTransport } from '../../core/research/transport'
import { ElectronBrowserTargetFactory, RESEARCH_CSP } from '../../electron/research/managedTarget'
import { EXTRACTION_SCRIPT } from '../../electron/research/extract'

const electron = vi.hoisted(() => ({ fromPartition: vi.fn(), BrowserWindow: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: electron.fromPartition }, BrowserWindow: electron.BrowserWindow }))
let contents: EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn>; executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn> }
let window: EventEmitter & { webContents: typeof contents; loadURL: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }
let ses: EventEmitter & { protocol: { handle: ReturnType<typeof vi.fn>; unhandle: ReturnType<typeof vi.fn> }; webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }; setPermissionCheckHandler: ReturnType<typeof vi.fn>; setPermissionRequestHandler: ReturnType<typeof vi.fn>; clearStorageData: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn> }
let destroyed: boolean
const signal = () => new AbortController().signal
function transport(options: { html?: string; type?: string; status?: number; pending?: Promise<never> } = {}) {
  const request = vi.fn(async () => options.pending ?? ({ status: options.status ?? 200, headers: { 'content-type': options.type ?? 'text/html' }, body: (async function* () { yield Buffer.from(options.html ?? '<p>Readable text</p>') })() }))
  return { request, value: new SafeHttpTransport({ resolver: async () => [{ address: '93.184.216.34', family: 4 }], request }) }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
beforeEach(() => {
  vi.clearAllMocks(); destroyed = false
  contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ title: 'Title', text: 'Readable text', headings: [], links: [] })) })
  window = Object.assign(new EventEmitter(), { webContents: contents, loadURL: vi.fn(async () => {}), destroy: vi.fn(() => { destroyed = true }), isDestroyed: () => destroyed })
  ses = Object.assign(new EventEmitter(), { protocol: { handle: vi.fn(), unhandle: vi.fn() }, webRequest: { onBeforeRequest: vi.fn() }, setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}) })
  electron.fromPartition.mockReturnValue(ses)
  electron.BrowserWindow.mockImplementation(function () { return window })
})
afterEach(() => vi.useRealTimers())
describe('sandboxed Electron research target', () => {
  it('bounds and reuses non-persistent partitions, with explicit secure window settings', async () => {
    const factory = new ElectronBrowserTargetFactory(transport().value)
    // Many sequential reads. Electron has no API to destroy a Session, so a partition
    // per read would accumulate one per page for the life of the process.
    for (let index = 0; index < 12; index += 1) {
      const target = await factory.create('a', signal())
      await target.close()
    }
    const partitions = electron.fromPartition.mock.calls.map((call) => call[0] as string)
    // Bounded, and reused rather than minted per read.
    expect(partitions.length).toBeLessThanOrEqual(4)
    expect(new Set(partitions).size).toBe(partitions.length)
    expect(partitions.every((value) => !value.startsWith('persist:'))).toBe(true)
    expect(electron.BrowserWindow.mock.calls[0]?.[0]).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, devTools: false } })
    expect(electron.BrowserWindow.mock.calls[0]?.[0].webPreferences).not.toHaveProperty('preload')
  })
  it('fetches through safe transport and serves only one owned HTML request with CSP', async () => {
    const source = transport()
    let served: unknown
    window.loadURL.mockImplementation(async (url: string) => {
      const handler = ses.protocol.handle.mock.calls[0]?.[1] as (request: { url: string; method: string }) => Response
      served = await handler({ url, method: 'GET' }).text()
      expect(handler({ url: 'file:///secret', method: 'GET' }).status).toBe(403)
      expect(handler({ url, method: 'POST' }).status).toBe(403)
      expect(handler({ url, method: 'GET' }).status).toBe(403)
    })
    const target = await new ElectronBrowserTargetFactory(source.value).create('session', signal())
    await target.navigate('https://example.com/', signal())
    expect(source.request).toHaveBeenCalledTimes(1)
    expect(served).toBe('<p>Readable text</p>')
    const handler = ses.protocol.handle.mock.calls[0]?.[1] as (request: { url: string; method: string }) => Response
    expect(handler({ url: window.loadURL.mock.calls[0]?.[0], method: 'GET' }).status).toBe(403)
    expect(RESEARCH_CSP).toContain("default-src 'none'")
    for (const directive of ['script-src','connect-src','frame-src','form-action','base-uri']) expect(RESEARCH_CSP).toContain(`${directive} 'none'`)
    await target.close()
  })
  it('denies subresources, permissions, popups, downloads, frames and navigation', async () => {
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    const request = ses.webRequest.onBeforeRequest.mock.calls[0]?.[0] as (details: { url: string; resourceType: string }, callback: (value: { cancel: boolean }) => void) => void
    for (const url of ['https://example.com/', 'file:///secret', 'data:text/html,hi', 'freya-research://document/subresource']) {
      const callback = vi.fn(); request({ url, resourceType: 'script' }, callback); expect(callback).toHaveBeenCalledWith({ cancel: true })
    }
    expect(ses.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false)
    const permission = vi.fn(); ses.setPermissionRequestHandler.mock.calls[0]?.[0]({}, 'media', permission); expect(permission).toHaveBeenCalledWith(false)
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    for (const event of ['will-navigate','will-frame-navigate','will-redirect','will-attach-webview']) {
      const preventDefault = vi.fn(); contents.emit(event, { preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(1)
    }
    const preventDefault = vi.fn(); ses.emit('will-download', { preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(1)
    await target.close()
  })
  it('runs the constant extraction script in an isolated world and preserves source provenance', async () => {
    const target = await new ElectronBrowserTargetFactory(transport().value, () => new Date('2026-10-01T00:00:00.000Z')).create('session', signal())
    await target.navigate('https://example.com/source', signal())
    const doc = await target.read(signal())
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1001, [{ code: EXTRACTION_SCRIPT }], false)
    expect(doc).toMatchObject({ id: 'session', url: 'https://example.com/source', retrievedAt: '2026-10-01T00:00:00.000Z', text: 'Readable text' })
    await target.close()
  })
  it('rejects pre-aborted creation before allocating a window', async () => {
    await expect(new ElectronBrowserTargetFactory(transport().value).create('session', AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' })
    expect(electron.BrowserWindow).not.toHaveBeenCalled()
  })
  it('refuses rather than minting a fifth partition when all four are busy', async () => {
    // A bounded pool that silently grows is not a bounded pool. Four concurrent
    // reads lease everything; a fifth is refused instead of growing the pool.
    const factory = new ElectronBrowserTargetFactory(transport().value)
    const held = [await factory.create('a', signal()), await factory.create('b', signal()),
      await factory.create('c', signal()), await factory.create('d', signal())]
    await expect(factory.create('e', signal())).rejects.toMatchObject({ code: 'network_error' })
    for (const target of held) await target.close()
    // Released, so a later read succeeds.
    const after = await factory.create('f', signal())
    await after.close()
  })

  it('redacts session allocation failures before any target exists', async () => {
    electron.fromPartition.mockImplementationOnce(() => { throw new Error('private-storage-path') })
    await expect(new ElectronBrowserTargetFactory(transport().value).create('session', signal())).rejects.toMatchObject({ code: 'network_error', message: 'The network request failed.' })
  })
  it('cleans protocol and session if window construction fails', async () => {
    electron.BrowserWindow.mockImplementationOnce(() => { throw new Error('private-details') })
    await expect(new ElectronBrowserTargetFactory(transport().value).create('session', signal())).rejects.toMatchObject({ code: 'network_error' })
    expect(ses.protocol.unhandle).toHaveBeenCalledWith('freya-research')
  })
  it.each([{ type: 'application/pdf' }, { status: 403 }])('closes rejected sources without browser loading %j', async (opts) => {
    const target = await new ElectronBrowserTargetFactory(transport(opts).value).create('session', signal())
    await expect(target.navigate('https://example.com/', signal())).rejects.toMatchObject({ code: 'unsupported_document' })
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.destroy).toHaveBeenCalledTimes(1)
  })
  it.each(['navigate','read'] as const)('redacts %s runtime failure and destroys target', async (phase) => {
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    if (phase === 'navigate') window.loadURL.mockRejectedValueOnce(new Error('private-path'))
    else { await target.navigate('https://example.com/', signal()); contents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('private-path')) }
    await expect(phase === 'navigate' ? target.navigate('https://example.com/', signal()) : target.read(signal())).rejects.toMatchObject({ code: 'network_error', message: 'The network request failed.' })
    expect(window.destroy).toHaveBeenCalledTimes(1)
  })
  it.each(['navigate','read'] as const)('aborts pending %s and cannot resurrect after late completion', async (phase) => {
    let finish!: (value?: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    if (phase === 'navigate') window.loadURL.mockImplementationOnce(() => pending)
    else { await target.navigate('https://example.com/', signal()); contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => pending) }
    const controller = new AbortController()
    const outcome = (phase === 'navigate' ? target.navigate('https://example.com/', controller.signal) : target.read(controller.signal)).catch((error: unknown) => error)
    await flush(); controller.abort(); expect(await outcome).toMatchObject({ code: 'cancelled' })
    finish({ text: 'late' }); await flush()
    expect(window.destroy).toHaveBeenCalledTimes(1)
    await expect(target.read(signal())).rejects.toMatchObject({ code: 'cancelled' })
  })
  it('crash rejects a pending read and destroys the window without waiting for storage cleanup', async () => {
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    await target.navigate('https://example.com/', signal())
    contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise(() => {}))
    ses.clearStorageData.mockImplementationOnce(() => new Promise(() => {}))
    const outcome = target.read(signal()).catch((error: unknown) => error)
    await flush(); contents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(window.destroy).toHaveBeenCalledTimes(1)
    expect(await outcome).toMatchObject({ code: 'network_error' })
  })
  it.each(['navigate','read'] as const)('bounds %s waits to fifteen seconds', async (phase) => {
    vi.useFakeTimers()
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    if (phase === 'navigate') window.loadURL.mockImplementationOnce(() => new Promise(() => {}))
    else { await target.navigate('https://example.com/', signal()); contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise(() => {})) }
    const outcome = (phase === 'navigate' ? target.navigate('https://example.com/', signal()) : target.read(signal())).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15000)
    expect(await outcome).toMatchObject({ code: 'timeout' })
    expect(window.destroy).toHaveBeenCalledTimes(1)
  })
  it('continues resource cleanup when protocol teardown fails', async () => {
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    ses.protocol.unhandle.mockImplementationOnce(() => { throw new Error('teardown-private') })
    await expect(target.close()).resolves.toBeUndefined()
    expect(window.destroy).toHaveBeenCalledTimes(1)
    // Twice, deliberately: once when the partition is leased and once when it is
    // released. A lease that cleared only on release would hand its storage to the
    // next reader whenever a previous close was interrupted.
    expect(ses.clearStorageData).toHaveBeenCalledTimes(2)
    expect(ses.listenerCount('will-download')).toBe(0)
  })
  it('captures webContents before destroying a native window whose getters become invalid', async () => {
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    Object.defineProperty(window, 'webContents', { configurable: true, get: () => { if (destroyed) throw new Error('Object has been destroyed'); return contents } })
    await expect(target.close()).resolves.toBeUndefined()
    expect(contents.listenerCount('render-process-gone')).toBe(0)
    // Twice, deliberately: once when the partition is leased and once when it is
    // released. A lease that cleared only on release would hand its storage to the
    // next reader whenever a previous close was interrupted.
    expect(ses.clearStorageData).toHaveBeenCalledTimes(2)
  })
  it('cleans externally destroyed windows using the retained WebContents', async () => {
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    Object.defineProperty(window, 'webContents', { configurable: true, get: () => { if (destroyed) throw new Error('Object has been destroyed'); return contents } })
    destroyed = true
    expect(() => window.emit('closed')).not.toThrow()
    await expect(target.close()).resolves.toBeUndefined()
    expect(contents.listenerCount('render-process-gone')).toBe(0)
    expect(ses.protocol.unhandle).toHaveBeenCalledWith('freya-research')
    // Twice, deliberately: once when the partition is leased and once when it is
    // released. A lease that cleared only on release would hand its storage to the
    // next reader whenever a previous close was interrupted.
    expect(ses.clearStorageData).toHaveBeenCalledTimes(2)
    await expect(target.read(signal())).rejects.toMatchObject({ code: 'network_error' })
  })
  it('close removes listeners/protocol and destroys synchronously, is idempotent', async () => {
    const target = await new ElectronBrowserTargetFactory(transport().value).create('session', signal())
    const closing = target.close()
    expect(window.destroy).toHaveBeenCalledTimes(1)
    await closing; await target.close()
    expect(window.destroy).toHaveBeenCalledTimes(1)
    expect(ses.protocol.unhandle).toHaveBeenCalledWith('freya-research')
    expect(contents.listenerCount('render-process-gone')).toBe(0)
    expect(ses.listenerCount('will-download')).toBe(0)
    // Twice, deliberately: once when the partition is leased and once when it is
    // released. A lease that cleared only on release would hand its storage to the
    // next reader whenever a previous close was interrupted.
    expect(ses.clearStorageData).toHaveBeenCalledTimes(2)
  })
})
