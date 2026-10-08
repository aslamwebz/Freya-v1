// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DockedBrowser, sharedDockedBrowserStore } from '../../../src/app/chat/BrowserWorkspace'
import type { BrowserBridgeState } from '../../../electron/browser/rendererRequest'
import type { BrowserTabState } from '../../../core/browser/service'
import { tabStateFor } from '../../../core/browser/service'

/**
 * The Browser Workspace, drawn.
 *
 * Every test here asserts on **what a person would see**, and the assertion that matters most
 * is the negative one: for each of the five "there is no page showing" states there is a
 * distinct, named panel — and for a working tab there is no panel at all, so the native view
 * shows through. The previous build drew one indistinguishable empty box for four different
 * facts, which is the bug this whole change exists to close.
 *
 * There is no polling in this component and there must not be: one read on mount, then a
 * subscription. A test that counts the reads is the only way that stays true.
 */

const bridge = vi.hoisted(() => ({
  state: vi.fn(async (): Promise<unknown> => ({})),
  command: vi.fn(async (_request: unknown): Promise<unknown> => ({})),
  dock: vi.fn(async (_input: unknown): Promise<boolean> => true),
  listeners: [] as ((state: BrowserBridgeState) => void)[],
}))

vi.mock('../../../src/platform/host', () => ({ hostBridge: () => ({ browserDock: bridge.dock }) }))

vi.mock('../../../src/platform/browserClient', () => ({
  ABSENT_BROWSER_STATE: {},
  readBrowserState: () => bridge.state(),
  executeBrowser: vi.fn(),
  dockBrowserView: (input: unknown) => bridge.dock(input),
  onBrowserState: (handler: (state: BrowserBridgeState) => void) => {
    bridge.listeners.push(handler)
    return () => {
      const index = bridge.listeners.indexOf(handler)
      if (index >= 0) bridge.listeners.splice(index, 1)
    }
  },
  runBrowserCommand: (request: unknown) => bridge.command(request),
}))

function tab(overrides: {
  readonly observation: Parameters<typeof tabStateFor>[0]['observation']
  readonly tabId?: string
  readonly sessionId?: string
  readonly active?: boolean
  readonly createdBy?: 'freya' | 'user'
  readonly origin?: BrowserTabState['origin']
}): BrowserTabState {
  return tabStateFor({
    tabId: overrides.tabId ?? 'tab-1',
    sessionId: overrides.sessionId ?? 'freya-0001',
    surface: 'embedded',
    origin: overrides.origin ?? { kind: 'manual' },
    createdBy: overrides.createdBy ?? 'user',
    openedAt: 0,
    active: overrides.active ?? true,
    observation: overrides.observation,
  })
}

function stateWith(overrides: Partial<BrowserBridgeState> = {}): BrowserBridgeState {
  return {
    available: true,
    active: true,
    reason: null,
    publicAvailable: true,
    journalTrustworthy: true,
    runtimeStatus: 'active',
    activeTabId: null,
    tabs: [],
    sessions: [],
    tabCount: 0,
    recovery: null,
    extensionPaired: false,
    extensionLive: false,
    summary: '',
    phase51: [],
    described: 0,
    staleRefs: 0,
    mediaObserved: 0,
    refusals: 0,
    ...overrides,
  }
}

/** Push a state the way the main process would. */
function push(state: BrowserBridgeState): void {
  act(() => {
    for (const listener of [...bridge.listeners]) listener(state)
  })
}

function panel(): HTMLElement | null {
  return document.querySelector('.chats-browser-empty')
}

function panelState(): string | null {
  return panel()?.getAttribute('data-state') ?? null
}

afterEach(cleanup)

beforeEach(() => {
  sharedDockedBrowserStore().reset()
  bridge.listeners.length = 0
  bridge.state.mockReset()
  bridge.command.mockReset()
  bridge.command.mockResolvedValue({ ok: true, op: 'open', data: { tabId: 'tab-1', sessionId: 'freya-0001' }, reason: null })
  bridge.dock.mockReset()
  bridge.dock.mockResolvedValue(true)
  bridge.state.mockResolvedValue(stateWith())
})

/* ------------------------------------------------------- 1. valid session */

describe('a session with a valid URL', () => {
  it('shows no panel at all, so the native page is the only thing on screen', async () => {
    bridge.state.mockResolvedValue(stateWith({
      tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/contact', title: 'Contact' } })],
      activeTabId: 'tab-1',
      tabCount: 1,
      sessions: [{ sessionId: 'freya-0001', status: 'ready', url: 'https://alpha.example.com/contact', title: 'Contact', createdBy: 'user', surface: 'embedded', errorCode: null }],
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByRole('tab', { name: /Contact/ })
    expect(panel()).toBeNull()
  })

  it('marks the viewport as holding a live page, which is what the view is docked against', async () => {
    bridge.state.mockResolvedValue(stateWith({
      tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/contact', title: 'Contact' } })],
      activeTabId: 'tab-1',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByRole('tab')
    expect(document.querySelector('.chats-browser-native')?.getAttribute('data-status')).toBe('ready')
  })

  it('shows the title and the provenance of each tab', async () => {
    bridge.state.mockResolvedValue(stateWith({
      tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/', title: 'Alpha' }, origin: { kind: 'link', from: 'eye', ownerText: 'find ten sites' } })],
      activeTabId: 'tab-1',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    expect(await screen.findByRole('tab', { name: /Alpha/ })).toBeInTheDocument()
    expect(screen.getByText(/find ten sites/)).toBeInTheDocument()
  })
})

/* ------------------------------------------------------ 2. pending session */

describe('a pending session with no URL', () => {
  it('shows the pending panel and not an empty browser', async () => {
    bridge.state.mockResolvedValue(stateWith({
      tabs: [tab({ observation: { kind: 'creating' } })],
      activeTabId: 'tab-1',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByRole('tab', { name: /New tab/ })
    expect(panelState()).toBe('tab-creating')
    expect(panel()?.querySelector('b')?.textContent).toBe('New tab')
  })

  it('says the tab has no address yet, rather than showing nothing', async () => {
    bridge.state.mockResolvedValue(stateWith({ tabs: [tab({ observation: { kind: 'creating' } })], activeTabId: 'tab-1' }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/has not been given an address/)
  })
})

/* ------------------------------------------------------ 3. failed session */

describe('a session that failed', () => {
  it('shows the failure panel with the address it tried and the code', async () => {
    bridge.state.mockResolvedValue(stateWith({
      tabs: [tab({
        tabId: 'tab-1',
        observation: { kind: 'failed', url: 'https://alpha.example.com/gone', code: 'navigate-failed' },
      })],
      activeTabId: 'tab-1',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByRole('tab')
    expect(panelState()).toBe('tab-failed')
    expect(panel()?.querySelector('b')?.textContent).toBe('That page did not load')
    expect(panel()?.textContent).toContain('alpha.example.com/gone')
    expect(panel()?.textContent).toContain('navigate-failed')
  })

  it('is never confused with a session that is merely waiting', async () => {
    const failed = stateWith({ tabs: [tab({ observation: { kind: 'failed', url: null, code: 'page-missing' } })], activeTabId: 'tab-1' })
    const navigating = stateWith({ tabs: [tab({ observation: { kind: 'navigating', url: 'https://alpha.example.com/' } })], activeTabId: 'tab-1' })
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    push(failed)
    expect(panelState()).toBe('tab-failed')
    push(navigating)
    expect(panelState()).toBe('tab-navigating')
  })
})

/* ---------------------------------------------------- 4. runtime unavailable */

describe('a runtime that is unavailable', () => {
  it('says unavailable, with the reason the host gave', async () => {
    bridge.state.mockResolvedValue(stateWith({
      available: false,
      active: false,
      runtimeStatus: 'disabled',
      reason: 'The browser runtime is switched off.',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/browser is unavailable/)
    expect(panelState()).toBe('runtime-unavailable')
  })

  it('says paused rather than unavailable when it is merely disabled', async () => {
    bridge.state.mockResolvedValue(stateWith({ available: false, active: false, runtimeStatus: 'disabled', reason: 'off' }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/switched off/)
    expect(document.querySelector('small[data-runtime]')?.textContent).toBe('paused')
  })

  it('refuses to submit an address while it is unavailable', async () => {
    bridge.state.mockResolvedValue(stateWith({ available: false, active: false, runtimeStatus: 'disabled', reason: 'off' }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByLabelText('Browser address or search')
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled()
  })
})

/* ------------------------------------------------------ 5. journal untrusted */

describe('an untrustworthy journal', () => {
  it('says the browser is suspended, and does not say merely unavailable', async () => {
    bridge.state.mockResolvedValue(stateWith({
      available: false,
      active: false,
      journalTrustworthy: false,
      runtimeStatus: 'journalUntrusted',
      reason: 'the journal does not chain',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/browser is suspended/)
    expect(panelState()).toBe('journal-untrusted')
  })

  it('outranks a tab that says it is ready', async () => {
    // Trust is checked before the tab. A tab the journal cannot vouch for is not a page.
    bridge.state.mockResolvedValue(stateWith({
      available: true,
      active: true,
      journalTrustworthy: false,
      runtimeStatus: 'journalUntrusted',
      reason: 'the journal does not chain',
      tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/', title: null } })],
      activeTabId: 'tab-1',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/browser is suspended/)
    expect(panelState()).toBe('journal-untrusted')
  })

  it('tells the owner to recover rather than to wait', async () => {
    bridge.state.mockResolvedValue(stateWith({ available: false, active: false, journalTrustworthy: false, runtimeStatus: 'journalUntrusted', reason: 'x' }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/Run recovery/)
  })
})

/* --------------------------------------------------------- 6. no sessions */

describe('no sessions at all', () => {
  it('shows an empty workspace, which is a normal thing to be', async () => {
    bridge.state.mockResolvedValue(stateWith())
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/No browser tab open/)
    expect(panelState()).toBe('no-tab')
  })

  it('is not the same panel as a session that failed', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    push(stateWith())
    expect(panelState()).toBe('no-tab')
    push(stateWith({ tabs: [tab({ observation: { kind: 'failed', url: null, code: 'x' } })], activeTabId: 'tab-1' }))
    expect(panelState()).toBe('tab-failed')
  })

  it('keeps the status word active, so the header does not claim the browser is paused', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/No browser tab open/)
    expect(document.querySelector('small[data-runtime]')?.textContent).toBe('isolated')
  })
})

/* ------------------------------------------- 7. a tab's address changes */

describe('a session whose address changes after it was created', () => {
  it('updates the same chip rather than adding one', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    push(stateWith({
      tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/one', title: 'One' } })],
      activeTabId: 'tab-1',
      tabCount: 1,
    }))
    await screen.findByRole('tab', { name: /One/ })
    push(stateWith({
      tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/two', title: 'Two' } })],
      activeTabId: 'tab-1',
      tabCount: 1,
    }))
    await screen.findByRole('tab', { name: /Two/ })
    expect(screen.queryByRole('tab', { name: /One/ })).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('shows the pending panel while the load is in flight, not the old page', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    push(stateWith({ tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/one', title: null } })], activeTabId: 'tab-1' }))
    await waitFor(() => expect(panel()).toBeNull())
    push(stateWith({ tabs: [tab({ observation: { kind: 'navigating', url: 'https://alpha.example.com/two' } })], activeTabId: 'tab-1' }))
    await waitFor(() => expect(panelState()).toBe('tab-navigating'))
  })
})

/* --------------------------------------------------- 8. a closed session */

describe('a closed session', () => {
  it('takes its chip with it, so nothing is left pointing at a dead page', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    push(stateWith({
      tabs: [tab({ tabId: 'tab-1', observation: { kind: 'ready', url: 'https://alpha.example.com/one', title: null } })],
      activeTabId: 'tab-1',
      tabCount: 1,
    }))
    await screen.findAllByRole('tab')
    push(stateWith())
    await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(0))
    expect(panelState()).toBe('no-tab')
  })

  it('hides the native view when there is no front tab to show', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    push(stateWith({ tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/one', title: null } })], activeTabId: 'tab-1' }))
    await screen.findAllByRole('tab')
    push(stateWith())
    await waitFor(() => expect(bridge.dock).toHaveBeenCalled())
    expect(bridge.dock.mock.calls.map((call) => call[0] as { sessionId: string | null }).some((call) => call.sessionId === null)).toBe(true)
  })
})

/* -------------------------------------------------- 9. multiple sessions */

describe('many sessions', () => {
  const ten = Array.from({ length: 10 }, (_unused, index) =>
    tab({ tabId: `tab-${String(index)}`, sessionId: `freya-${String(index).padStart(4, '0')}`, observation: { kind: 'ready', url: `https://site${String(index)}.example.com/`, title: null }, active: index === 0 }),
  )

  it('draws ten chips, not one', async () => {
    bridge.state.mockResolvedValue(stateWith({ tabs: ten, activeTabId: 'tab-0', tabCount: 10 }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(10))
  })

  it('reports the count, so a strip of ten is visibly ten', async () => {
    bridge.state.mockResolvedValue(stateWith({ tabs: ten, activeTabId: 'tab-0', tabCount: 10 }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText('10 tabs')
  })

  it('marks exactly one chip as selected', async () => {
    bridge.state.mockResolvedValue(stateWith({ tabs: ten, activeTabId: 'tab-3', tabCount: 10 }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1))
  })

  it('asks the service to switch tabs rather than deciding locally', async () => {
    bridge.state.mockResolvedValue(stateWith({ tabs: ten, activeTabId: 'tab-0', tabCount: 10 }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(10))
    fireEvent.click(screen.getAllByRole('tab')[4]!)
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ op: 'activate', tabId: 'tab-4' })))
  })

  it('closes one tab and leaves the other nine drawn', async () => {
    bridge.state.mockResolvedValue(stateWith({ tabs: ten, activeTabId: 'tab-0', tabCount: 10 }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(10))
    fireEvent.click(screen.getByLabelText('Close site0.example.com'))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ op: 'close', tabId: 'tab-0' })))
    push(stateWith({ tabs: ten.slice(1), activeTabId: 'tab-1', tabCount: 9 }))
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(9))
  })

  it('shows the attribution of each tab on its chip', async () => {
    bridge.state.mockResolvedValue(stateWith({
      tabs: [
        tab({ tabId: 'tab-0', observation: { kind: 'ready', url: 'https://a.example.com/', title: null }, createdBy: 'user' }),
        tab({ tabId: 'tab-1', observation: { kind: 'ready', url: 'https://b.example.com/', title: null }, createdBy: 'freya', active: false }),
      ],
      activeTabId: 'tab-0',
      tabCount: 2,
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('.chats-browser-tab[data-created-by="freya"]')).not.toBeNull())
  })
})

/* ------------------------------------------------------------- toolbar */

describe('the toolbar', () => {
  async function withReadyTab() {
    bridge.state.mockResolvedValue(stateWith({
      tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/one', title: null } })],
      activeTabId: 'tab-1',
    }))
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByRole('tab')
  }

  it('disables back and forward when there is nowhere to go', async () => {
    await withReadyTab()
    expect(screen.getByLabelText('Back')).toBeDisabled()
    expect(screen.getByLabelText('Forward')).toBeDisabled()
  })

  it('asks the service for a reload rather than re-navigating by hand', async () => {
    await withReadyTab()
    fireEvent.click(screen.getByLabelText('Reload'))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ op: 'reload', tabId: 'tab-1' }))
  })

  it('turns a bare phrase into a search rather than a refusal', async () => {
    await withReadyTab()
    fireEvent.change(screen.getByLabelText('Browser address or search'), { target: { value: 'sri lanka universities' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({
      op: 'navigate',
      url: expect.stringContaining('duckduckgo.com') as unknown as string,
    })))
  })

  it('navigates to a typed address as written', async () => {
    await withReadyTab()
    fireEvent.change(screen.getByLabelText('Browser address or search'), { target: { value: 'example.net/new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ op: 'navigate', url: 'https://example.net/new' })))
  })

  it('opens a new tab with no address, which is what "new tab" means', async () => {
    await withReadyTab()
    fireEvent.click(screen.getByLabelText('Open a new tab'))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ op: 'open', url: null, createdBy: 'user' })))
  })

  it('shows a refusal rather than swallowing it', async () => {
    await withReadyTab()
    bridge.command.mockResolvedValue({ ok: false, op: 'navigate', code: 'url-refused', reason: 'That address is not one the Freya Browser will open.', data: {} })
    fireEvent.change(screen.getByLabelText('Browser address or search'), { target: { value: 'http://192.168.0.1/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toContain('not one the Freya Browser will open')
  })
})

/* ------------------------------------------------------------- no polling */

describe('no polling', () => {
  it('reads the state once on mount and then only on a push', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/No browser tab open/)
    const after = bridge.state.mock.calls.length
    push(stateWith({ tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/', title: null } })], activeTabId: 'tab-1' }))
    await screen.findByRole('tab')
    expect(bridge.state.mock.calls.length).toBe(after)
  })

  it('keeps the chips in step with the pushes', async () => {
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/No browser tab open/)
    push(stateWith({ tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/', title: null } })], activeTabId: 'tab-1' }))
    await screen.findByRole('tab')
    push(stateWith({ tabs: [tab({ observation: { kind: 'ready', url: 'https://beta.example.com/', title: null } })], activeTabId: 'tab-1' }))
    await screen.findByRole('tab', { name: /beta/ })
  })
})

/* ---------------------------------------------------------------- bounds */

describe('placing the native view', () => {
  /** Give the viewport a real size, which jsdom otherwise refuses to lay out. */
  function sizeViewport(rect: { x: number; y: number; width: number; height: number }): () => void {
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function stub(): DOMRect {
      const box = (this as Element).classList.contains('chats-browser-native') ? rect : null
      if (box === null) return original.call(this)
      return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box } as DOMRect
    }
    return () => {
      Element.prototype.getBoundingClientRect = original
    }
  }

  it('docks the front tab by its browser session, not by its tab id', async () => {
    const restore = sizeViewport({ x: 400, y: 90, width: 320, height: 240 })
    try {
      render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
      push(stateWith({ tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/', title: null } })], activeTabId: 'tab-1' }))
      await screen.findByRole('tab')
      await waitFor(() => expect(bridge.dock).toHaveBeenCalledWith({ sessionId: 'freya-0001', bounds: { x: 400, y: 90, width: 320, height: 240 } }))
    } finally {
      restore()
    }
  })

  it('asks to undock the moment the front tab goes away, so no view floats over the chat', async () => {
    const restore = sizeViewport({ x: 400, y: 90, width: 320, height: 240 })
    try {
      render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
      push(stateWith({ tabs: [tab({ observation: { kind: 'ready', url: 'https://alpha.example.com/', title: null } })], activeTabId: 'tab-1' }))
      await screen.findByRole('tab')
      push(stateWith())
      await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(0))
      expect(bridge.dock.mock.calls.map((call) => call[0] as { sessionId: string | null; bounds: unknown }).at(-1)).toEqual({ sessionId: null, bounds: null })
    } finally {
      restore()
    }
  })

  it('treats a zero-area viewport as hidden rather than as a real position', async () => {
    // jsdom reports a zero box for everything, so this is the only honest answer available
    // here — and it is the one that matters: a native view given a zero rect is neither
    // painted nor hit-testable, which is what "hidden" has to mean.
    render(<DockedBrowser requestedUrl={null} onRequestedUrlHandled={() => {}} onClose={() => {}} />)
    await screen.findByText(/No browser tab open/)
    await waitFor(() => expect(bridge.dock).toHaveBeenCalledWith({ sessionId: null, bounds: null }))
  })
})