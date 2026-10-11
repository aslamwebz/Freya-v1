import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { CanvasSpec } from './CanvasPanel'
import type { ChartSpec } from './ChartView'
import type { TypedSource } from './assistantParts'
import type { ToolStepRecord } from '../../../core/mind/tools'
import type { MediaItem } from '../../../core/media/types'
import { MediaGrid } from './MediaCards'
import type { ConversationMessageView } from '../../../core/protocol/conversation'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { copyText } from './clipboard'
import { attachmentTray, type AttachmentDraft } from './attachments'
import {
  DockedBrowser,
  openUrlInDockedBrowser,
  sharedDockedBrowserStore,
  type DockedTabOrigin,
} from './BrowserWorkspace'
import {
  sharedRightWorkspaceStore,
  type RightWorkspaceTab,
  type RightWorkspaceStore,
} from './rightWorkspaceStore'

export type { RightWorkspaceTab }

export interface RightWorkspaceProps {
  readonly open: boolean
  readonly activeTab?: RightWorkspaceTab
  readonly onTabChange?: (tab: RightWorkspaceTab) => void
  readonly onClose: () => void
  readonly percent?: number
  readonly onPercentChange?: (percent: number) => void
  readonly messages?: readonly ConversationMessageView[]
  readonly canvas?: CanvasSpec | null
  readonly sources?: readonly TypedSource[]
  readonly charts?: readonly ChartSpec[]
  readonly mediaItems?: readonly MediaItem[]
  readonly executionSteps?: readonly ToolStepRecord[]
  readonly browserRequestedUrl?: string | null
  readonly browserExpanded?: boolean
  readonly onBrowserExpandedToggle?: () => void
  readonly onBrowserRequestedUrlHandled?: () => void
  readonly onBrowserOpenUrl?: (url: string, origin?: DockedTabOrigin) => void
  readonly store?: RightWorkspaceStore
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * Tab 2: Web Research Sources View
 * ------------------------------------------------------------------ */
function SourcesView({
  sources,
  onOpenInBrowser,
}: {
  readonly sources: readonly TypedSource[]
  readonly onOpenInBrowser: (url: string, title?: string) => void
}) {
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => {
    if (!filter.trim()) return sources
    const query = filter.toLowerCase()
    return sources.filter(
      (s) =>
        s.title.toLowerCase().includes(query) ||
        s.sourceDomain.toLowerCase().includes(query) ||
        (s.snippet && s.snippet.toLowerCase().includes(query)),
    )
  }, [sources, filter])

  if (sources.length === 0) {
    return (
      <div className="chats-rw-empty">
        <Glyph name="search" size={28} />
        <b>No Research Sources Yet</b>
        <p>
          Ask Freya a question with Web Search enabled to collect and inspect structured source
          citations here.
        </p>
      </div>
    )
  }

  return (
    <div className="chats-rw-sources-pane">
      <div className="chats-rw-pane-toolbar">
        <span className="chats-rw-badge">{sources.length} sources retrieved</span>
        {sources.length > 3 ? (
          <input
            type="search"
            className="chats-rw-search-input"
            placeholder="Filter sources…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter sources"
          />
        ) : null}
      </div>
      <ol className="chats-rw-source-list" aria-label="Web research sources">
        {filtered.map((source) => (
          <li key={`${source.rank}:${source.url}`} className="chats-rw-source-card">
            <header className="chats-rw-source-card-head">
              <span className="chats-rw-source-rank">[{source.rank}]</span>
              <span className="chats-rw-source-domain">{source.sourceDomain}</span>
              {source.retrievedAt ? (
                <time className="chats-rw-source-date" dateTime={source.retrievedAt}>
                  {source.retrievedAt.slice(0, 10)}
                </time>
              ) : null}
            </header>
            <h4 className="chats-rw-source-title">
              <button
                type="button"
                className="chats-rw-source-open-btn"
                onClick={() => onOpenInBrowser(source.url, source.title)}
                title={`Open ${source.url} in Freya Browser`}
              >
                {source.title}
              </button>
            </h4>
            {source.snippet ? (
              <blockquote className="chats-rw-source-snippet">{source.snippet}</blockquote>
            ) : null}
            <footer className="chats-rw-source-card-foot">
              <button
                type="button"
                className="chats-rw-action-btn"
                onClick={() => onOpenInBrowser(source.url, source.title)}
              >
                <Glyph name="world" size={13} />
                <span>Open in Browser</span>
              </button>
              <button
                type="button"
                className="chats-rw-action-btn"
                onClick={() => void copyText(source.url)}
              >
                Copy URL
              </button>
            </footer>
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 3: Canvas View
 * ------------------------------------------------------------------ */
function CanvasView({
  canvases,
  activeCanvas,
}: {
  readonly canvases: readonly CanvasSpec[]
  readonly activeCanvas: CanvasSpec | null
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const [copied, setCopied] = useState(false)

  const current = activeCanvas ?? canvases[selectedIndex] ?? null
  const sourceText = current?.content ?? ''

  const wordCount = useMemo(
    () => sourceText.trim().split(/\s+/).filter(Boolean).length,
    [sourceText],
  )
  const lineCount = useMemo(() => sourceText.split('\n').length, [sourceText])
  const charCount = sourceText.length

  const handleCopy = async () => {
    if (!sourceText) return
    const ok = await copyText(sourceText)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }

  if (!current) {
    return (
      <div className="chats-rw-empty">
        <Glyph name="create" size={28} />
        <b>No Canvas Artifacts</b>
        <p>When Freya generates long-form documents or code, they will be rendered here.</p>
      </div>
    )
  }

  return (
    <div className="chats-rw-canvas-pane">
      <header className="chats-rw-pane-toolbar">
        {canvases.length > 1 ? (
          <select
            className="chats-rw-select"
            value={selectedIndex}
            onChange={(e) => setSelectedIndex(Number(e.target.value))}
            aria-label="Select canvas artifact"
          >
            {canvases.map((c, i) => (
              <option key={i} value={i}>
                {c.title} ({c.kind})
              </option>
            ))}
          </select>
        ) : (
          <div className="chats-rw-meta-title">
            <b>{current.title}</b>
            <small>{current.kind} · {current.language}</small>
          </div>
        )}
        <div className="chats-rw-tabs-mini" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'rendered'}
            className="chats-rw-tab-mini"
            onClick={() => setMode('rendered')}
          >
            Rendered
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            className="chats-rw-tab-mini"
            onClick={() => setMode('source')}
          >
            Source
          </button>
        </div>
        <button
          type="button"
          className="chats-rw-action-btn"
          onClick={() => void handleCopy()}
          aria-label="Copy canvas content"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>

      <div className="chats-rw-stats-strip">
        <span>{charCount.toLocaleString()} chars</span>
        <span>{lineCount.toLocaleString()} lines</span>
        <span>{wordCount.toLocaleString()} words</span>
      </div>

      <div className="chats-rw-canvas-content">
        {mode === 'source' ? (
          <pre className="chats-rw-code-block">
            <code>{sourceText}</code>
          </pre>
        ) : current.kind === 'code' ? (
          <pre className="chats-rw-code-block">
            <code>{sourceText}</code>
          </pre>
        ) : current.language === 'html' ? (
          <iframe
            className="chats-rw-iframe"
            sandbox="allow-same-origin"
            srcDoc={sourceText}
            title={current.title}
          />
        ) : (
          <div className="chats-rw-markdown-body">
            <pre className="chats-rw-doc-text">{sourceText}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 4: Documents View
 * ------------------------------------------------------------------ */
function DocumentsView({
  documents,
  attachmentDrafts,
  onOpenInBrowser,
}: {
  readonly documents: readonly MediaItem[]
  readonly attachmentDrafts: readonly AttachmentDraft[]
  readonly onOpenInBrowser: (url: string, title?: string) => void
}) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const pdfDrafts = useMemo(
    () => attachmentDrafts.filter((d) => d.kind === 'pdf'),
    [attachmentDrafts],
  )
  const totalCount = documents.length + pdfDrafts.length
  const currentDoc = documents[selectedIndex] ?? null

  if (totalCount === 0) {
    return (
      <div className="chats-rw-empty">
        <Glyph name="relay" size={28} />
        <b>No Documents</b>
        <p>Attach a PDF or ask Freya to retrieve documents to preview them here.</p>
      </div>
    )
  }

  return (
    <div className="chats-rw-docs-pane">
      <div className="chats-rw-pane-toolbar">
        <span className="chats-rw-badge">{totalCount} document{totalCount === 1 ? '' : 's'}</span>
        {documents.length > 1 ? (
          <select
            className="chats-rw-select"
            value={selectedIndex}
            onChange={(e) => setSelectedIndex(Number(e.target.value))}
            aria-label="Select document"
          >
            {documents.map((doc, i) => (
              <option key={i} value={i}>
                {doc.title || `Document ${i + 1}`}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {currentDoc ? (
        <div className="chats-rw-doc-card">
          <header className="chats-rw-doc-header">
            <h3>{currentDoc.title || 'Document'}</h3>
            <div className="chats-rw-doc-meta">
              <span>{currentDoc.host || hostOf(currentDoc.page)}</span>
              {currentDoc.pages ? <span>{currentDoc.pages} pages</span> : null}
            </div>
          </header>
          <div className="chats-rw-doc-body">
            <div className="chats-rw-doc-placeholder">
              <span className="chats-rw-doc-badge">PDF / DOCUMENT</span>
              <p>{currentDoc.url}</p>
            </div>
          </div>
          <footer className="chats-rw-pane-footer">
            <button
              type="button"
              className="chats-rw-action-btn"
              onClick={() => onOpenInBrowser(currentDoc.page || currentDoc.url, currentDoc.title)}
            >
              <Glyph name="world" size={13} />
              <span>Open in Browser</span>
            </button>
            <button
              type="button"
              className="chats-rw-action-btn"
              onClick={() => void copyText(currentDoc.url)}
            >
              Copy Link
            </button>
          </footer>
        </div>
      ) : null}

      {pdfDrafts.length > 0 ? (
        <div className="chats-rw-attached-docs">
          <h5>Pending Attached PDFs</h5>
          {pdfDrafts.map((draft) => (
            <div key={draft.id} className="chats-rw-draft-item">
              <b>{draft.name}</b>
              <small>{draft.detail ?? `${Math.round(draft.sizeBytes / 1024)} KB`}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 5: Images & Media View
 * ------------------------------------------------------------------ */
function MediaView({
  mediaItems,
  onOpenInBrowser,
}: {
  readonly mediaItems: readonly MediaItem[]
  readonly onOpenInBrowser: (url: string, title?: string) => void
}) {
  if (mediaItems.length === 0) {
    return (
      <div className="chats-rw-empty">
        <Glyph name="dress" size={28} />
        <b>No Media Items</b>
        <p>Images, videos, and audio found by Freya will appear here.</p>
      </div>
    )
  }

  return (
    <div className="chats-rw-media-pane">
      <div className="chats-rw-pane-toolbar">
        <span className="chats-rw-badge">
          {mediaItems.length} media item{mediaItems.length === 1 ? '' : 's'}
        </span>
        <small className="chats-rw-media-hint">Select to preview ? Navigate inside viewer</small>
      </div>
      {/* This workspace is a gallery, never a second hidden player.
          Only MediaOverlay may mount an iframe or audio/video element. */}
      <MediaGrid
        items={mediaItems}
        onOpenBrowserUrl={(url) => onOpenInBrowser(url, url)}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 6: Generated Charts View
 * ------------------------------------------------------------------ */
function ChartsView({ charts }: { readonly charts: readonly ChartSpec[] }) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const current = charts[selectedIndex] ?? null

  const stats = useMemo(() => {
    if (!current || current.points.length === 0) return null
    const values = current.points.map((p) => p.value)
    const sum = values.reduce((a, b) => a + b, 0)
    const max = Math.max(...values)
    const min = Math.min(...values)
    const avg = sum / values.length
    return { sum, max, min, avg }
  }, [current])

  const copyAsJson = async () => {
    if (!current) return
    await copyText(JSON.stringify(current, null, 2))
  }

  const copyAsCsv = async () => {
    if (!current) return
    const rows = ['Label,Value', ...current.points.map((p) => `"${p.label}",${p.value}`)]
    await copyText(rows.join('\n'))
  }

  if (charts.length === 0 || !current) {
    return (
      <div className="chats-rw-empty">
        <Glyph name="focus" size={28} />
        <b>No Generated Charts</b>
        <p>When Freya visualizes numerical data, charts and structured tables will appear here.</p>
      </div>
    )
  }

  return (
    <div className="chats-rw-charts-pane">
      <div className="chats-rw-pane-toolbar">
        {charts.length > 1 ? (
          <select
            className="chats-rw-select"
            value={selectedIndex}
            onChange={(e) => setSelectedIndex(Number(e.target.value))}
            aria-label="Select chart"
          >
            {charts.map((chart, i) => (
              <option key={i} value={i}>
                {chart.title} ({chart.kind})
              </option>
            ))}
          </select>
        ) : (
          <div className="chats-rw-meta-title">
            <b>{current.title}</b>
            <small>{current.kind} chart · {current.unit}</small>
          </div>
        )}
        <div className="chats-rw-btn-group">
          <button type="button" className="chats-rw-action-btn" onClick={() => void copyAsJson()}>
            Copy JSON
          </button>
          <button type="button" className="chats-rw-action-btn" onClick={() => void copyAsCsv()}>
            Copy CSV
          </button>
        </div>
      </div>

      {stats ? (
        <div className="chats-rw-stats-grid">
          <div className="chats-rw-stat-card">
            <small>Points</small>
            <b>{current.points.length}</b>
          </div>
          <div className="chats-rw-stat-card">
            <small>Max</small>
            <b>{stats.max.toLocaleString()}</b>
          </div>
          <div className="chats-rw-stat-card">
            <small>Average</small>
            <b>{stats.avg.toFixed(1)}</b>
          </div>
          <div className="chats-rw-stat-card">
            <small>Total Sum</small>
            <b>{stats.sum.toLocaleString()}</b>
          </div>
        </div>
      ) : null}

      <div className="chats-rw-table-wrap">
        <table className="chats-rw-data-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Value ({current.unit})</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {current.points.map((p, idx) => {
              const share = stats && stats.sum > 0 ? ((p.value / stats.sum) * 100).toFixed(1) : '—'
              return (
                <tr key={`${p.label}:${idx}`}>
                  <td>{p.label}</td>
                  <td><b>{p.value.toLocaleString()}</b></td>
                  <td>{share}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 7: Agent Execution Results View
 * ------------------------------------------------------------------ */
function ExecutionView({ steps }: { readonly steps: readonly ToolStepRecord[] }) {
  const [filter, setFilter] = useState<'all' | 'ok' | 'failed' | 'denied'>('all')

  if (steps.length === 0) {
    return (
      <div className="chats-rw-empty">
        <Glyph name="mind" size={28} />
        <b>No Tool Execution Steps</b>
        <p>
          When Freya executes verified tools (browser, search, chart generation, files), honest step
          records and outcomes appear here.
        </p>
      </div>
    )
  }

  const successCount = steps.filter((s) => s.outcome === 'ok').length
  const failedCount = steps.filter((s) => s.outcome === 'failed').length
  const deniedCount = steps.filter((s) => s.outcome === 'denied').length
  const visibleSteps = steps.filter((s) => filter === 'all' || s.outcome === filter)

  return (
    <div className="chats-rw-exec-pane">
      <div className="chats-rw-pane-toolbar">
        <span className="chats-rw-badge">{steps.length} verified steps</span>
        <div className="chats-rw-exec-counts">
          <button
            type="button"
            className={`chats-rw-exec-filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`chats-rw-exec-filter-btn chats-rw-exec-ok ${filter === 'ok' ? 'active' : ''}`}
            onClick={() => setFilter('ok')}
          >
            {successCount} passed
          </button>
          {failedCount > 0 ? (
            <button
              type="button"
              className={`chats-rw-exec-filter-btn chats-rw-exec-fail ${filter === 'failed' ? 'active' : ''}`}
              onClick={() => setFilter('failed')}
            >
              {failedCount} failed
            </button>
          ) : null}
          {deniedCount > 0 ? (
            <button
              type="button"
              className={`chats-rw-exec-filter-btn chats-rw-exec-denied ${filter === 'denied' ? 'active' : ''}`}
              onClick={() => setFilter('denied')}
            >
              {deniedCount} denied
            </button>
          ) : null}
        </div>
      </div>

      <ol className="chats-rw-exec-list" aria-label="Tool execution steps">
        {visibleSteps.map((step) => {
          const outcomeClass =
            step.outcome === 'ok'
              ? 'ok'
              : step.outcome === 'failed'
              ? 'fail'
              : 'denied'
          const outcomeLabel =
            step.outcome === 'ok'
              ? 'Verified OK'
              : step.outcome === 'failed'
              ? 'Execution Failed'
              : 'Blocked / Denied'

          return (
            <li key={step.index} className="chats-rw-exec-card" data-outcome={outcomeClass}>
              <header className="chats-rw-exec-head">
                <span className="chats-rw-exec-step-num">Step #{step.index}</span>
                <span className="chats-rw-exec-tool">
                  <b>{step.tool}</b>
                  <small>{step.capability}</small>
                </span>
                <span className={`chats-rw-outcome-badge ${outcomeClass}`}>{outcomeLabel}</span>
              </header>

              <div className="chats-rw-exec-details">
                <div className="chats-rw-exec-row">
                  <span>Executed Truth:</span>
                  <b>{step.executed ? 'Executed by Core/Mind' : 'Refused / Not run'}</b>
                </div>
                {step.sourceCount !== undefined && step.sourceCount > 0 ? (
                  <div className="chats-rw-exec-row">
                    <span>Sources Produced:</span>
                    <b>{step.sourceCount}</b>
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 8: File Previews View
 * ------------------------------------------------------------------ */
function FilesView({ drafts }: { readonly drafts: readonly AttachmentDraft[] }) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const current = drafts[selectedIndex] ?? null

  if (drafts.length === 0) {
    return (
      <div className="chats-rw-empty">
        <Glyph name="attach" size={28} />
        <b>No Attached Files</b>
        <p>Use the attach button in the composer to stage files for preview and inspection here.</p>
      </div>
    )
  }

  return (
    <div className="chats-rw-files-pane">
      <div className="chats-rw-pane-toolbar">
        <span className="chats-rw-badge">{drafts.length} staged file{drafts.length === 1 ? '' : 's'}</span>
        {drafts.length > 1 ? (
          <select
            className="chats-rw-select"
            value={selectedIndex}
            onChange={(e) => setSelectedIndex(Number(e.target.value))}
            aria-label="Select file"
          >
            {drafts.map((d, i) => (
              <option key={d.id} value={i}>
                {d.name} ({d.kind})
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="chats-rw-action-btn warn"
          onClick={() => {
            if (current) attachmentTray.remove(current.id)
          }}
        >
          Remove
        </button>
      </div>

      {current ? (
        <div className="chats-rw-file-card">
          <header className="chats-rw-file-head">
            <b>{current.name}</b>
            <small>
              {current.kind} · {Math.round(current.sizeBytes / 1024)} KB
              {current.modelMimeType ? ` · ${current.modelMimeType}` : ''}
            </small>
          </header>

          <div className="chats-rw-file-preview-body">
            {current.kind === 'text' && current.text ? (
              <pre className="chats-rw-code-block">
                <code>{current.text}</code>
              </pre>
            ) : current.detail ? (
              <p className="chats-rw-file-note">{current.detail}</p>
            ) : (
              <p className="chats-rw-file-note">
                Binary payload staged for model transmission. Raw bytes are preserved securely.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Main Universal Right Workspace Component
 * ------------------------------------------------------------------ */
export function RightWorkspaceRail({
  open,
  activeTab,
  browserEnabled,
  messages = [],
  canvas = null,
  sources,
  charts,
  mediaItems,
  executionSteps,
  store: injectedStore,
  onClose,
}: {
  readonly open: boolean
  readonly activeTab: RightWorkspaceTab
  readonly browserEnabled: boolean
  readonly messages?: readonly ConversationMessageView[]
  readonly canvas?: CanvasSpec | null
  readonly sources?: readonly TypedSource[]
  readonly charts?: readonly ChartSpec[]
  readonly mediaItems?: readonly MediaItem[]
  readonly executionSteps?: readonly ToolStepRecord[]
  readonly store?: RightWorkspaceStore
  readonly onClose: () => void
}) {
  const store = injectedStore ?? sharedRightWorkspaceStore()
  const drafts = useSyncExternalStore(
    attachmentTray.subscribe, attachmentTray.getSnapshot, attachmentTray.getSnapshot,
  )
  const counts: Record<RightWorkspaceTab, number> = {
    browser: 0,
    sources: sources?.length ?? messages.reduce((max, m) => Math.max(max, m.sources?.length ?? 0), 0),
    canvas: messages.filter((m) => m.canvas).length + (canvas && !messages.some((m) => m.canvas?.title === canvas.title) ? 1 : 0),
    documents: mediaItems?.filter((x) => x.kind === 'document').length ?? messages.reduce((sum, m) => sum + (m.media?.filter((x) => x.kind === 'document').length ?? 0), 0),
    media: mediaItems?.filter((x) => x.kind !== 'document').length ?? messages.reduce((sum, m) => sum + (m.media?.filter((x) => x.kind !== 'document').length ?? 0), 0),
    charts: charts?.length ?? messages.reduce((sum, m) => sum + (m.charts?.length ?? 0), 0),
    execution: executionSteps?.length ?? messages.reduce((max, m) => Math.max(max, m.steps?.length ?? 0), 0),
    files: drafts.length,
  }
  const entries = [
    { tab: 'browser', label: 'Browser', icon: 'world' },
    { tab: 'sources', label: 'Sources', icon: 'search' },
    { tab: 'canvas', label: 'Canvas', icon: 'create' },
    { tab: 'documents', label: 'Docs', icon: 'relay' },
    { tab: 'media', label: 'Media', icon: 'dress' },
    { tab: 'charts', label: 'Charts', icon: 'focus' },
    { tab: 'execution', label: 'Execution', icon: 'mind' },
    { tab: 'files', label: 'Files', icon: 'attach' },
  ] as const

  return (
    <nav className="chats-workspace-rail" role="tablist" aria-label="Workspace content types">
      {entries.map(({ tab, label, icon }) => {
        const enabled = tab !== 'browser' || browserEnabled
        const selected = open && activeTab === tab
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-label={label}
            aria-selected={selected}
            aria-controls="chats-right-panel"
            disabled={!enabled}
            className="chats-workspace-rail-button"
            title={enabled ? label : 'Enable Chat Browser to use Browser'}
            onClick={() => {
              if (selected) onClose()
              else store.open(tab)
            }}
          >
            <Glyph name={icon} size={18} />
            {counts[tab] > 0 ? <small className="chats-workspace-rail-count" aria-hidden="true">{counts[tab] > 99 ? '99+' : counts[tab]}</small> : null}
          </button>
        )
      })}
    </nav>
  )
}


export function UniversalRightWorkspace({
  open,
  activeTab: propActiveTab,
  onTabChange,
  onClose,
  percent: _propPercent = 52,
  onPercentChange: _onPercentChange,
  messages = [],
  canvas = null,
  sources: explicitSources,
  charts: explicitCharts,
  mediaItems: explicitMedia,
  executionSteps: explicitSteps,
  browserRequestedUrl = null,
  browserExpanded = false,
  onBrowserExpandedToggle,
  onBrowserRequestedUrlHandled = () => {},
  onBrowserOpenUrl,
  store: injectedStore,
}: RightWorkspaceProps) {
  const store = injectedStore ?? sharedRightWorkspaceStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const activeTab = propActiveTab ?? snapshot.activeTab
  const drafts = useSyncExternalStore(
    attachmentTray.subscribe,
    attachmentTray.getSnapshot,
    attachmentTray.getSnapshot,
  )

  // Aggregate artifacts across messages
  const allCanvases = useMemo(() => {
    const list: CanvasSpec[] = []
    if (canvas) list.push(canvas)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg?.canvas && !list.some((c) => c.title === msg.canvas?.title && c.content === msg.canvas?.content)) {
        list.push(msg.canvas)
      }
    }
    return list
  }, [canvas, messages])

  const allSources = useMemo(() => {
    if (explicitSources && explicitSources.length > 0) return explicitSources
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg?.sources && msg.sources.length > 0) return msg.sources
    }
    return []
  }, [explicitSources, messages])

  const allCharts = useMemo(() => {
    if (explicitCharts && explicitCharts.length > 0) return explicitCharts
    const list: ChartSpec[] = []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg?.charts) {
        for (const c of msg.charts) {
          if (!list.some((existing) => existing.title === c.title)) list.push(c)
        }
      }
    }
    return list
  }, [explicitCharts, messages])

  const allMedia = useMemo(() => {
    if (explicitMedia && explicitMedia.length > 0) return explicitMedia
    const list: MediaItem[] = []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg?.media) {
        for (const item of msg.media) {
          if (item.kind !== 'document' && !list.some((m) => m.url === item.url)) {
            list.push(item)
          }
        }
      }
    }
    return list
  }, [explicitMedia, messages])

  const allDocs = useMemo(() => {
    const list: MediaItem[] = []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg?.media) {
        for (const item of msg.media) {
          if (item.kind === 'document' && !list.some((m) => m.url === item.url)) {
            list.push(item)
          }
        }
      }
    }
    return list
  }, [messages])

  const allSteps = useMemo(() => {
    if (explicitSteps && explicitSteps.length > 0) return explicitSteps
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg?.steps && msg.steps.length > 0) return msg.steps
    }
    return []
  }, [explicitSteps, messages])

  const handleTabClick = (tab: RightWorkspaceTab) => {
    store.setTab(tab)
    onTabChange?.(tab)
  }

  const handleOpenInBrowser = useCallback(
    (url: string, title?: string) => {
      if (onBrowserOpenUrl) {
        onBrowserOpenUrl(url, { kind: 'link', from: 'chat', ownerText: title ?? url })
      } else {
        void openUrlInDockedBrowser(sharedDockedBrowserStore(), url, {
          origin: { kind: 'link', from: 'chat', ownerText: title ?? url },
        })
      }
      handleTabClick('browser')
    },
    [onBrowserOpenUrl],
  )

  if (!open) return null

  return (
    <aside
      className="chats-right-workspace"
      data-active-tab={activeTab}
      role="region"
      aria-label="Universal Right Workspace"
    >
      <header className="chats-rw-head">
        <div className="chats-rw-tabs" role="tablist" aria-label="Workspace content types">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'browser'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('browser')}
          >
            <Glyph name="world" size={14} />
            <span>Browser</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sources'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('sources')}
          >
            <Glyph name="search" size={14} />
            <span>Sources</span>
            {allSources.length > 0 ? (
              <small className="chats-rw-count">{allSources.length}</small>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'canvas'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('canvas')}
          >
            <Glyph name="create" size={14} />
            <span>Canvas</span>
            {allCanvases.length > 0 ? (
              <small className="chats-rw-count">{allCanvases.length}</small>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'documents'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('documents')}
          >
            <Glyph name="relay" size={14} />
            <span>Docs</span>
            {allDocs.length > 0 ? (
              <small className="chats-rw-count">{allDocs.length}</small>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'media'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('media')}
          >
            <Glyph name="dress" size={14} />
            <span>Media</span>
            {allMedia.length > 0 ? (
              <small className="chats-rw-count">{allMedia.length}</small>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'charts'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('charts')}
          >
            <Glyph name="focus" size={14} />
            <span>Charts</span>
            {allCharts.length > 0 ? (
              <small className="chats-rw-count">{allCharts.length}</small>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'execution'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('execution')}
          >
            <Glyph name="mind" size={14} />
            <span>Execution</span>
            {allSteps.length > 0 ? (
              <small className="chats-rw-count">{allSteps.length}</small>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'files'}
            className="chats-rw-tab"
            onClick={() => handleTabClick('files')}
          >
            <Glyph name="attach" size={14} />
            <span>Files</span>
            {drafts.length > 0 ? (
              <small className="chats-rw-count">{drafts.length}</small>
            ) : null}
          </button>
        </div>

        <button
          type="button"
          className="chats-rw-close"
          onClick={onClose}
          aria-label="Close workspace"
        >
          ×
        </button>
      </header>

      <div className="chats-rw-body">
        {activeTab === 'browser' ? (
          <DockedBrowser
            requestedUrl={browserRequestedUrl}
            requestedOrigin={{ kind: 'link', from: 'chat', ownerText: 'browser workspace' }}
            onRequestedUrlHandled={onBrowserRequestedUrlHandled}
            onClose={onClose}
            expanded={browserExpanded}
            onToggleExpanded={onBrowserExpandedToggle}
            onViewChange={handleTabClick}
          />
        ) : activeTab === 'sources' ? (
          <SourcesView sources={allSources} onOpenInBrowser={handleOpenInBrowser} />
        ) : activeTab === 'canvas' ? (
          <CanvasView canvases={allCanvases} activeCanvas={canvas} />
        ) : activeTab === 'documents' ? (
          <DocumentsView
            documents={allDocs}
            attachmentDrafts={drafts}
            onOpenInBrowser={handleOpenInBrowser}
          />
        ) : activeTab === 'media' ? (
          <MediaView mediaItems={allMedia} onOpenInBrowser={handleOpenInBrowser} />
        ) : activeTab === 'charts' ? (
          <ChartsView charts={allCharts} />
        ) : activeTab === 'execution' ? (
          <ExecutionView steps={allSteps} />
        ) : activeTab === 'files' ? (
          <FilesView drafts={drafts} />
        ) : null}
      </div>
    </aside>
  )
}
