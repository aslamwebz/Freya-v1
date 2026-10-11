// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RightWorkspaceRail, UniversalRightWorkspace } from '../../../src/app/chat/RightWorkspace'
import { createRightWorkspaceStore } from '../../../src/app/chat/rightWorkspaceStore'
import { attachmentTray } from '../../../src/app/chat/attachments'
import type { CanvasSpec } from '../../../src/app/chat/CanvasPanel'
import type { ChartSpec } from '../../../src/app/chat/ChartView'
import type { TypedSource } from '../../../src/app/chat/assistantParts'
import type { ToolStepRecord } from '../../../core/mind/tools'
import type { MediaItem } from '../../../core/media/types'

// Mock hostBridge
vi.mock('../../../src/platform/host', () => ({
  hostBridge: () => ({
    browserDock: vi.fn(async () => true),
    mediaThumbnail: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })),
    mediaDocument: vi.fn(async () => ({ ok: true, base64: 'JVBERi0xLjQK' })),
  }),
}))

// Mock browserClient for DockedBrowser
vi.mock('../../../src/platform/browserClient', () => ({
  ABSENT_BROWSER_STATE: {},
  readBrowserState: vi.fn(async () => ({
    available: true,
    active: true,
    runtimeStatus: 'active',
    reason: null,
    journalTrustworthy: true,
    tabs: [],
    activeTabId: null,
  })),
  executeBrowser: vi.fn(),
  dockBrowserView: vi.fn(async () => true),
  onBrowserState: vi.fn(() => () => {}),
  runBrowserCommand: vi.fn(async () => ({ ok: true, data: {} })),
}))

const sampleSources: TypedSource[] = [
  {
    rank: 1,
    title: 'MDN HTTP Caching Guide',
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching',
    sourceDomain: 'developer.mozilla.org',
    snippet: 'HTTP caching stores a technique for reusing previously fetched resources.',
    retrievedAt: '2026-10-09T18:00:00Z',
  },
  {
    rank: 2,
    title: 'RFC 9111 HTTP Caching',
    url: 'https://www.rfc-editor.org/rfc/rfc9111',
    sourceDomain: 'rfc-editor.org',
    snippet: 'This document defines HTTP caching mechanisms.',
    retrievedAt: '2026-10-09T18:01:00Z',
  },
]

const sampleCanvas: CanvasSpec = {
  title: 'API Architecture Blueprint',
  kind: 'document',
  language: 'markdown',
  content: '# System Architecture\n\nDetailed specifications for the service stack.\n\n- Gateway: port 9235\n- Core: SQLite Vault',
}

const sampleCharts: ChartSpec[] = [
  {
    title: 'Quarterly Cache Hit Ratios',
    kind: 'bar',
    unit: '%',
    points: [
      { label: 'Q1', value: 84 },
      { label: 'Q2', value: 91 },
      { label: 'Q3', value: 95 },
    ],
  },
]

const sampleMedia: MediaItem[] = [
  {
    kind: 'image',
    url: 'https://example.com/diagram.png',
    title: 'Cache Topology Diagram',
    page: 'https://example.com/cache',
    host: 'example.com',
    duration: null,
    bytes: 1024,
    pages: null,
    playable: false,
  },
]

const sampleDocs: MediaItem[] = [
  {
    kind: 'document',
    url: 'https://example.com/spec.pdf',
    title: 'HTTP Spec Specification',
    page: 'https://example.com/spec',
    host: 'example.com',
    duration: null,
    bytes: 4096,
    pages: 42,
    playable: false,
  },
]

const sampleSteps: ToolStepRecord[] = [
  {
    index: 1,
    tool: 'web_search',
    capability: 'search.web',
    outcome: 'ok',
    executed: true,
    sourceCount: 2,
  },
  {
    index: 2,
    tool: 'make_chart',
    capability: 'work.execute',
    outcome: 'ok',
    executed: true,
    sourceCount: 0,
  },
]

afterEach(() => {
  cleanup()
  attachmentTray.clear()
  vi.clearAllMocks()
})

describe('UniversalRightWorkspace', () => {
  it('keeps the icon rail available with closed content and disables Browser until Chat Browser is on', () => {
    const store = createRightWorkspaceStore()
    const onClose = vi.fn()
    const { rerender } = render(
      <RightWorkspaceRail open={false} activeTab="browser" browserEnabled={false} store={store} onClose={onClose} />,
    )
    expect(screen.getAllByRole('tab')).toHaveLength(8)
    const browser = screen.getByRole('tab', { name: 'Browser' })
    expect(browser).toBeDisabled()
    fireEvent.click(browser)
    expect(store.getSnapshot().open).toBe(false)
    const sources = screen.getByRole('tab', { name: 'Sources' })
    fireEvent.click(sources)
    expect(store.getSnapshot().activeTab).toBe('sources')
    expect(store.getSnapshot().open).toBe(true)
    rerender(<RightWorkspaceRail open={true} activeTab="sources" browserEnabled={true} store={store} onClose={onClose} />)
    expect(screen.getByRole('tab', { name: 'Browser' })).not.toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Sources' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders all eight content type tabs in the tab strip', () => {
    const store = createRightWorkspaceStore('browser')
    render(
      <>
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        sources={sampleSources}
        canvas={sampleCanvas}
        charts={sampleCharts}
        mediaItems={[...sampleMedia, ...sampleDocs]}
        executionSteps={sampleSteps}
      />
      </>,
    )

    expect(screen.getByRole('tab', { name: /Browser/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Sources/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Canvas/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Docs/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Media/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Charts/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Execution/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Files/ })).toBeInTheDocument()
  })

  it('displays accurate count badges for available artifacts', () => {
    const store = createRightWorkspaceStore('browser')
    render(
      <>
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        sources={sampleSources}
        charts={sampleCharts}
        mediaItems={sampleMedia}
        executionSteps={sampleSteps}
      />
      </>,
    )

    const sourcesTab = screen.getByRole('tab', { name: /Sources/ })
    expect(sourcesTab).toHaveTextContent('2')

    const chartsTab = screen.getByRole('tab', { name: /Charts/ })
    expect(chartsTab).toHaveTextContent('1')

    const execTab = screen.getByRole('tab', { name: /Execution/ })
    expect(execTab).toHaveTextContent('2')
  })

  it('switches between content tabs cleanly and renders the corresponding pane', () => {
    const store = createRightWorkspaceStore('browser')
    render(
      <>
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        sources={sampleSources}
        canvas={sampleCanvas}
        charts={sampleCharts}
        executionSteps={sampleSteps}
      />
      </>,
    )

    // Switch to Sources
    fireEvent.click(screen.getByRole('tab', { name: /Sources/ }))
    expect(screen.getByText('MDN HTTP Caching Guide')).toBeInTheDocument()
    expect(screen.getByText('developer.mozilla.org')).toBeInTheDocument()
    expect(screen.getByText(/HTTP caching stores a technique/)).toBeInTheDocument()

    // Switch to Canvas
    fireEvent.click(screen.getByRole('tab', { name: /Canvas/ }))
    expect(screen.getByText('API Architecture Blueprint')).toBeInTheDocument()
    expect(screen.getByText(/System Architecture/)).toBeInTheDocument()

    // Switch to Charts
    fireEvent.click(screen.getByRole('tab', { name: /Charts/ }))
    expect(screen.getByText('Quarterly Cache Hit Ratios')).toBeInTheDocument()
    expect(screen.getByText('Q1')).toBeInTheDocument()
    expect(screen.getByText('84')).toBeInTheDocument()

    // Switch to Execution
    fireEvent.click(screen.getByRole('tab', { name: /Execution/ }))
    expect(screen.getByText('Step #1')).toBeInTheDocument()
    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.getByText('Step #2')).toBeInTheDocument()
    expect(screen.getByText('make_chart')).toBeInTheDocument()
  })

  it('opens a research source link in the browser tab via the action button', () => {
    const store = createRightWorkspaceStore('sources')
    const onOpenBrowserUrl = vi.fn()
    render(
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        sources={sampleSources}
        onBrowserOpenUrl={onOpenBrowserUrl}
      />,
    )

    const openBtns = screen.getAllByRole('button', { name: 'Open in Browser' })
    fireEvent.click(openBtns[0]!)

    expect(onOpenBrowserUrl).toHaveBeenCalledWith(
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching',
      expect.objectContaining({ kind: 'link' }),
    )
    expect(store.getSnapshot().activeTab).toBe('browser')
  })

  it('supports rendered vs source mode toggle and copying on Canvas tab', () => {
    const store = createRightWorkspaceStore('canvas')
    render(
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        canvas={sampleCanvas}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
    expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/# System Architecture/)).toBeInTheDocument()

    const copyBtn = screen.getByRole('button', { name: 'Copy canvas content' })
    expect(copyBtn).toBeInTheDocument()
  })

  it('displays structured data table and summary metrics for generated charts', () => {
    const store = createRightWorkspaceStore('charts')
    render(
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        charts={sampleCharts}
      />,
    )

    expect(screen.getByText('Quarterly Cache Hit Ratios')).toBeInTheDocument()
    // Total sum = 84 + 91 + 95 = 270
    expect(screen.getByText('270')).toBeInTheDocument()
    // Max = 95
    expect(screen.getAllByText('95').length).toBeGreaterThanOrEqual(1)
    // Data table rows
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy CSV' })).toBeInTheDocument()
  })

  it('displays staged files from attachmentTray in the Files tab', () => {
    attachmentTray.add([
      {
        name: 'notes.txt',
        path: '/tmp/notes.txt',
        kind: 'text',
        contentType: 'text/plain',
        sizeBytes: 1500,
        text: 'Review system requirements for Freya Chat.',
        truncated: false,
        detail: null,
        modelAttachment: null,
        pdf: null,
      },
    ])

    const store = createRightWorkspaceStore('files')
    render(
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
      />,
    )

    expect(screen.getByText('notes.txt')).toBeInTheDocument()
    expect(screen.getByText('Review system requirements for Freya Chat.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('invokes onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    const store = createRightWorkspaceStore('browser')
    render(
      <UniversalRightWorkspace
        open={true}
        onClose={onClose}
        store={store}
      />,
    )

    const closeBtn = screen.getByRole('button', { name: 'Close workspace' })
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
  })

  it('renders clean guidance empty states when tabs have no content', () => {
    const store = createRightWorkspaceStore('sources')
    render(
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        sources={[]}
      />,
    )

    expect(screen.getByText('No Research Sources Yet')).toBeInTheDocument()
    expect(screen.getByText(/Ask Freya a question with Web Search enabled/)).toBeInTheDocument()
  })

  it('filters execution steps by outcome using toolbar filter buttons', () => {
    const multiSteps: readonly ToolStepRecord[] = [
      { index: 1, tool: 'web_search', capability: 'search.web', outcome: 'ok', executed: true, sourceCount: 2 },
      { index: 2, tool: 'browser_tabs', capability: 'browser.read', outcome: 'failed', executed: true, sourceCount: 0 },
      { index: 3, tool: 'fs_write', capability: 'work.execute', outcome: 'denied', executed: false, sourceCount: 0 },
    ]
    const store = createRightWorkspaceStore('execution')
    render(
      <UniversalRightWorkspace
        open={true}
        onClose={vi.fn()}
        store={store}
        executionSteps={multiSteps}
      />,
    )

    // Initially all 3 steps visible
    expect(screen.getByText('Step #1')).toBeInTheDocument()
    expect(screen.getByText('Step #2')).toBeInTheDocument()
    expect(screen.getByText('Step #3')).toBeInTheDocument()

    // Filter to Passed
    fireEvent.click(screen.getByRole('button', { name: '1 passed' }))
    expect(screen.getByText('Step #1')).toBeInTheDocument()
    expect(screen.queryByText('Step #2')).toBeNull()
    expect(screen.queryByText('Step #3')).toBeNull()

    // Filter to Failed
    fireEvent.click(screen.getByRole('button', { name: '1 failed' }))
    expect(screen.queryByText('Step #1')).toBeNull()
    expect(screen.getByText('Step #2')).toBeInTheDocument()
    expect(screen.queryByText('Step #3')).toBeNull()

    // Filter to Denied
    fireEvent.click(screen.getByRole('button', { name: '1 denied' }))
    expect(screen.queryByText('Step #1')).toBeNull()
    expect(screen.queryByText('Step #2')).toBeNull()
    expect(screen.getByText('Step #3')).toBeInTheDocument()
  })
})

