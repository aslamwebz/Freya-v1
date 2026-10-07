import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DockedBrowser, sharedDockedBrowserStore } from '../../../src/app/chat/BrowserWorkspace'
const bridge = vi.hoisted(() => ({ execute: vi.fn(), dock: vi.fn(async () => true) }))
vi.mock('../../../src/platform/host', () => ({ hostBridge: () => ({ browserDock: bridge.dock }) }))
vi.mock('../../../src/platform/browserClient', () => ({
  readBrowserState: async () => ({ available: true, publicAvailable: true, sessions: [] }),
  executeBrowser: bridge.execute,
}))
afterEach(cleanup)
beforeEach(() => {
  sharedDockedBrowserStore().reset()
  bridge.execute.mockReset()
  bridge.execute.mockImplementation(async (request: { command: string; url?: string }) => ({ ok: true, data: request.command === 'session.open' ? { sessionId: 'freya-0001' } : { url: request.url, revision: 1 } }))
})
describe('shared native browser workspace', () => {
  it('retains address edits, displays Eye provenance and never reloads on switching', async () => {
    const store = sharedDockedBrowserStore()
    const first = store.openTab({ url: 'https://example.org', origin: { kind: 'link', from: 'eye', ownerText: '  exact request  ' } })
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(store.findTab(first.id)?.liveUrl).toBe('https://example.org'))
    const address = screen.getByLabelText('Browser address or search')
    fireEvent.change(address, { target: { value: 'example.net/new' } })
    expect(address).toHaveValue('example.net/new')
    expect(screen.getByTitle('  exact request  ', { normalizer: (value) => value })).toBeInTheDocument()
    const before = bridge.execute.mock.calls.length
    act(() => { const second = store.openTab(); store.activateTab(first.id); store.closeTab(second.id) })
    expect(bridge.execute.mock.calls).toHaveLength(before)
  })
  it('receives a finding opened after the dock mounted', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    act(() => { sharedDockedBrowserStore().openTab({ url: 'https://example.org/finding', title: 'A finding' }) })
    expect(await screen.findByRole('tab', { name: /A finding/ })).toBeInTheDocument()
    await waitFor(() => expect(bridge.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'page.navigate', url: 'https://example.org/finding' })))
  })
})
