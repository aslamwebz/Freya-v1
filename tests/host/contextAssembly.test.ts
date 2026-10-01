// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElectronCoreHost, type CoreHostOptions } from '../../electron/coreHost'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { pollingOnly, FakeActiveWindowProvider } from '../core/context/window/fakeProvider'

let dir: string
let host: ElectronCoreHost
const scope = { scopeKind: 'surface', scopeId: 'desktop-window' } as const
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'freya-window-assembly-')) })
afterEach(async () => { await host?.stop(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })
function make(provider: FakeActiveWindowProvider, enabled: boolean) {
  host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, {
    providers: [new FakeModelProvider()], contextKey: new Uint8Array(32).fill(47),
    windowObservation: { enabled, provider, scope, timer: null },
  } as CoreHostOptions)
  return host
}
describe('production host window assembly', () => {
  it('does not start observation when shutdown interrupts startup', async () => {
    const provider = new FakeActiveWindowProvider()
    provider.queue(provider.info('Freya', 'startup title', new Date().toISOString()))
    make(provider, true)
    const starting = host.start()
    await host.stop()
    await starting
    expect(provider.calls.reads).toBe(0)
    expect(host.windowObservationStatus()).toBe('disabled')
    expect(host.context()).toBeNull()
  })

  it('keeps unchanged observed windows live in Context across the admission TTL', async () => {
    vi.useFakeTimers()
    const provider = new FakeActiveWindowProvider()
    const began = Date.now()
    for (let tick = 0; tick <= 26; tick += 1) {
      provider.queue(provider.info('Freya', 'same title', new Date(began + tick * 5_000).toISOString()))
    }
    host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, {
      providers: [new FakeModelProvider()],
      windowObservation: { enabled: true, provider: pollingOnly(provider), scope },
    })
    await host.start()
    await vi.advanceTimersByTimeAsync(130_000)
    expect(host.windowObservationStatus()).toBe('observed')
    expect(host.context()?.counts.current).toBe(1)
  })

  it('polls an opted-in production provider after delayed focus and cancels cadence on stop', async () => {
    vi.useFakeTimers()
    const provider = new FakeActiveWindowProvider()
    host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, {
      providers: [new FakeModelProvider()],
      windowObservation: { enabled: true, provider: pollingOnly(provider), scope },
    })
    await host.start()
    expect(host.context()?.items).toEqual([])
    provider.queue(provider.info('Freya', 'newly focused', new Date().toISOString()))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(host.context()?.counts.current).toBe(1)
    await host.stop()
    const reads = provider.calls.reads
    await vi.advanceTimersByTimeAsync(5_000)
    expect(provider.calls.reads).toBe(reads)
  })

  it('admits an opt-in observation through Core with host provenance and read-only projection', async () => {
    const provider = new FakeActiveWindowProvider()
    provider.queue(provider.info('Code editor', 'PRIVATE_WINDOW_TITLE', new Date().toISOString()))
    await make(provider, true).start()
    expect(host.context()?.items).toEqual([expect.objectContaining({ kind: 'active_window', provenance: expect.objectContaining({ sourceClass: 'host_report' }),
      scope: { label: 'surface', detail: 'desktop-window' }, state: 'live' })])
    expect(JSON.stringify(host.context())).not.toContain('PRIVATE_WINDOW_TITLE')
    expect(host.context()).toHaveProperty('persistence', { mode: 'encrypted', durable: true, reason: null })
    expect(host.status()?.sessionUsage.calls).toBe(0)
    await host.stop()
    expect(provider.calls.unsubscribe).toBe(1)
    provider.emit({ availability: 'ready', window: provider.info('Late', 'late title', new Date().toISOString()), reason: null })
    expect(host.context()).toBeNull()
  })
  it('does not even inspect the provider when observation is disabled', async () => {
    const provider = new FakeActiveWindowProvider()
    await make(provider, false).start()
    expect(provider.calls).toEqual({ availability: 0, reads: 0, subscribe: 0, unsubscribe: 0 })
    expect(host.context()?.items).toEqual([])
  })
  it('reports unsupported observation without inventing active-window context', async () => {
    const provider = new FakeActiveWindowProvider({ availability: 'unsupported' })
    await make(provider, true).start()
    expect(host.windowObservationStatus()).toBe('unsupported')
    expect(provider.calls.reads).toBe(0)
    expect(host.context()?.items).toEqual([])
  })
})
