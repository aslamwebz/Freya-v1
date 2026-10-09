import { MIND_TOOL_LIMITS, type CanvasSpec, type ChartSpec, type ToolSource } from '../mind/tools'
import { ConversationStoreError } from './store'

export interface MessageArtifacts {
  sources?: readonly ToolSource[]
  charts?: readonly ChartSpec[]
  canvas?: CanvasSpec
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}
function webUrl(value: unknown): value is string {
  if (!text(value, 4096)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch { return false }
}

function source(value: unknown): ToolSource | null {
  const row = record(value)
  if (!row || !text(row.title, MIND_TOOL_LIMITS.maxTitleChars) || !webUrl(row.url)
    || !text(row.sourceDomain, 256) || !text(row.snippet, MIND_TOOL_LIMITS.maxSnippetChars)
    || typeof row.rank !== 'number' || !Number.isInteger(row.rank) || row.rank < 1 || row.rank > 1000
    || !(row.retrievedAt === null || (text(row.retrievedAt, 64) && Number.isFinite(Date.parse(row.retrievedAt))))) return null
  for (const key of ['mediaUrl', 'thumbnailUrl'] as const) {
    if (row[key] !== undefined && row[key] !== null && !webUrl(row[key])) return null
  }
  if (row.vertical !== undefined && !text(row.vertical, 32)) return null
  if (row.duration !== undefined && row.duration !== null && !text(row.duration, 80)) return null
  return {
    title: row.title, url: row.url, sourceDomain: row.sourceDomain, snippet: row.snippet,
    rank: row.rank, retrievedAt: row.retrievedAt,
    ...(row.mediaUrl === undefined ? {} : { mediaUrl: row.mediaUrl as string | null }),
    ...(row.thumbnailUrl === undefined ? {} : { thumbnailUrl: row.thumbnailUrl as string | null }),
    ...(row.vertical === undefined ? {} : { vertical: row.vertical as string }),
    ...(row.duration === undefined ? {} : { duration: row.duration as string | null }),
  }
}

function chart(value: unknown): ChartSpec | null {
  const row = record(value)
  if (!row || !text(row.title, MIND_TOOL_LIMITS.maxChartTitleChars) || !text(row.unit, MIND_TOOL_LIMITS.maxChartUnitChars)
    || (row.kind !== 'bar' && row.kind !== 'line') || !Array.isArray(row.points)
    || row.points.length > MIND_TOOL_LIMITS.maxChartPoints) return null
  const points: { label: string; value: number }[] = []
  for (const item of row.points) {
    const point = record(item)
    if (!point || !text(point.label, MIND_TOOL_LIMITS.maxChartLabelChars) || typeof point.value !== 'number' || !Number.isFinite(point.value)) return null
    points.push({ label: point.label, value: point.value })
  }
  return { title: row.title, kind: row.kind, unit: row.unit, points }
}

function canvas(value: unknown): CanvasSpec | null {
  const row = record(value)
  if (!row || !text(row.title, MIND_TOOL_LIMITS.maxCanvasTitleChars) || !text(row.content, MIND_TOOL_LIMITS.maxCanvasChars)
    || (row.kind !== 'document' && row.kind !== 'code')
    || !['markdown', 'html', 'javascript', 'python', 'css', 'json', 'text'].includes(String(row.language))) return null
  return { title: row.title, content: row.content, kind: row.kind, language: row.language as CanvasSpec['language'] }
}

/** Revalidate persisted payloads; malformed data never becomes a citation or chart. */
export function decodeMessageArtifacts(raw: string | null): MessageArtifacts {
  if (!raw || raw.length > 600_000) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  const row = record(parsed)
  if (!row) return {}
  const result: MessageArtifacts = {}
  if (Array.isArray(row.sources) && row.sources.length > 0 && row.sources.length <= 100) {
    const sources = row.sources.map(source)
    if (sources.every((item): item is ToolSource => item !== null)) result.sources = sources
  }
  if (Array.isArray(row.charts) && row.charts.length > 0 && row.charts.length <= MIND_TOOL_LIMITS.maxToolCalls) {
    const charts = row.charts.map(chart)
    if (charts.every((item): item is ChartSpec => item !== null)) result.charts = charts
  }
  const document = canvas(row.canvas)
  if (document) result.canvas = document
  return result
}

/** Only closed typed fields are persisted; a plain message retains a null column. */
export function encodeMessageArtifacts(value: MessageArtifacts): string | null {
  if (!value.sources?.length && !value.charts?.length && !value.canvas) return null
  const decoded = decodeMessageArtifacts(JSON.stringify({ sources: value.sources, charts: value.charts, canvas: value.canvas }))
  if ((value.sources?.length && !decoded.sources) || (value.charts?.length && !decoded.charts) || (value.canvas && !decoded.canvas)) {
    throw new ConversationStoreError('invalid-record', 'Message artifacts are invalid or exceed their storage bounds.')
  }
  return Object.keys(decoded).length === 0 ? null : JSON.stringify(decoded)
}
