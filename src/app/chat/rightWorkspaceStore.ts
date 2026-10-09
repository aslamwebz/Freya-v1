/**
 * Universal Right Workspace store.
 *
 * Coordinates the single, reusable right-hand workspace across its eight content types:
 *  - browser: Freya's docked native browser
 *  - sources: web research citations and evidence cards
 *  - canvas: long-form document and code artifacts
 *  - documents: PDF and document previews
 *  - media: images, video, and audio player/gallery
 *  - charts: generated interactive SVG charts and data tables
 *  - execution: verified agent tool step records
 *  - files: composer attachment drafts and staged files
 *
 * Framework-free store with useSyncExternalStore subscription.
 */
import type { CanvasSpec } from './CanvasPanel'
import type { TypedSource } from './assistantParts'
import type { ToolStepRecord } from '../../../core/mind/tools'

export type RightWorkspaceTab =
  | 'browser'
  | 'sources'
  | 'canvas'
  | 'documents'
  | 'media'
  | 'charts'
  | 'execution'
  | 'files'

export interface RightWorkspaceSnapshot {
  readonly open: boolean
  readonly activeTab: RightWorkspaceTab
  readonly percent: number
  readonly selectedMediaIndex: number
  readonly selectedDocumentIndex: number
  readonly selectedChartIndex: number
  readonly activeCanvas: CanvasSpec | null
  readonly explicitSources: readonly TypedSource[] | null
  readonly explicitExecutionSteps: readonly ToolStepRecord[] | null
  readonly selectedFileId: string | null
}

export interface RightWorkspaceStore {
  getSnapshot(): RightWorkspaceSnapshot
  subscribe(listener: (snapshot: RightWorkspaceSnapshot) => void): () => void
  open(tab?: RightWorkspaceTab): void
  close(): void
  toggle(tab?: RightWorkspaceTab): void
  setTab(tab: RightWorkspaceTab): void
  setPercent(percent: number): void
  openCanvas(canvas: CanvasSpec): void
  openChart(index?: number): void
  openMedia(index?: number): void
  openDocument(index?: number): void
  openSources(sources?: readonly TypedSource[]): void
  openExecution(steps?: readonly ToolStepRecord[]): void
  openFiles(fileId?: string): void
  reset(): void
}

const DEFAULT_PERCENT = 52
const MIN_PERCENT = 28
const MAX_PERCENT = 72

function clampPercent(percent: number): number {
  return Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, Math.round(percent)))
}

export function createRightWorkspaceStore(initialTab: RightWorkspaceTab = 'browser'): RightWorkspaceStore {
  let open = false
  let activeTab: RightWorkspaceTab = initialTab
  let percent = DEFAULT_PERCENT
  let selectedMediaIndex = 0
  let selectedDocumentIndex = 0
  let selectedChartIndex = 0
  let activeCanvas: CanvasSpec | null = null
  let explicitSources: readonly TypedSource[] | null = null
  let explicitExecutionSteps: readonly ToolStepRecord[] | null = null
  let selectedFileId: string | null = null

  const listeners = new Set<(snapshot: RightWorkspaceSnapshot) => void>()
  let currentSnapshot: RightWorkspaceSnapshot = Object.freeze({
    open,
    activeTab,
    percent,
    selectedMediaIndex,
    selectedDocumentIndex,
    selectedChartIndex,
    activeCanvas,
    explicitSources,
    explicitExecutionSteps,
    selectedFileId,
  })

  function publish(): void {
    currentSnapshot = Object.freeze({
      open,
      activeTab,
      percent,
      selectedMediaIndex,
      selectedDocumentIndex,
      selectedChartIndex,
      activeCanvas,
      explicitSources,
      explicitExecutionSteps,
      selectedFileId,
    })
    for (const listener of [...listeners]) {
      try {
        listener(currentSnapshot)
      } catch {
        // Listener error must not break store publishing
      }
    }
  }

  return {
    getSnapshot(): RightWorkspaceSnapshot {
      return currentSnapshot
    },
    subscribe(listener: (snapshot: RightWorkspaceSnapshot) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(tab?: RightWorkspaceTab): void {
      open = true
      if (tab) activeTab = tab
      publish()
    },
    close(): void {
      open = false
      publish()
    },
    toggle(tab?: RightWorkspaceTab): void {
      if (open && (!tab || tab === activeTab)) {
        open = false
      } else {
        open = true
        if (tab) activeTab = tab
      }
      publish()
    },
    setTab(tab: RightWorkspaceTab): void {
      activeTab = tab
      open = true
      publish()
    },
    setPercent(next: number): void {
      percent = clampPercent(next)
      publish()
    },
    openCanvas(canvas: CanvasSpec): void {
      activeCanvas = canvas
      activeTab = 'canvas'
      open = true
      publish()
    },
    openChart(index = 0): void {
      selectedChartIndex = Math.max(0, index)
      activeTab = 'charts'
      open = true
      publish()
    },
    openMedia(index = 0): void {
      selectedMediaIndex = Math.max(0, index)
      activeTab = 'media'
      open = true
      publish()
    },
    openDocument(index = 0): void {
      selectedDocumentIndex = Math.max(0, index)
      activeTab = 'documents'
      open = true
      publish()
    },
    openSources(sources?: readonly TypedSource[]): void {
      if (sources !== undefined) explicitSources = sources
      activeTab = 'sources'
      open = true
      publish()
    },
    openExecution(steps?: readonly ToolStepRecord[]): void {
      if (steps !== undefined) explicitExecutionSteps = steps
      activeTab = 'execution'
      open = true
      publish()
    },
    openFiles(fileId?: string): void {
      if (fileId !== undefined) selectedFileId = fileId
      activeTab = 'files'
      open = true
      publish()
    },
    reset(): void {
      open = false
      activeTab = 'browser'
      percent = DEFAULT_PERCENT
      selectedMediaIndex = 0
      selectedDocumentIndex = 0
      selectedChartIndex = 0
      activeCanvas = null
      explicitSources = null
      explicitExecutionSteps = null
      selectedFileId = null
      publish()
    },
  }
}

let sharedStore: RightWorkspaceStore | null = null

export function sharedRightWorkspaceStore(): RightWorkspaceStore {
  if (sharedStore === null) {
    sharedStore = createRightWorkspaceStore()
  }
  return sharedStore
}
