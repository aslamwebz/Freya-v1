import type { ChartSpec, CanvasSpec, CanvasLanguage } from './types'
import { MIND_TOOL_LIMITS } from './limits'
import { sanitiseUntrustedText } from './text'

/**
 * Bound a chart returned by a tool: title and unit are text-bounded, points are
 * capped, and the kind is closed. The model cannot make an unbounded series,
 * and the renderer can trust the shape.
 */
export function boundChart(raw: ChartSpec): ChartSpec {
  const points = raw.points.slice(0, MIND_TOOL_LIMITS.maxChartPoints).map((point) => ({
    label: sanitiseUntrustedText(String(point.label), MIND_TOOL_LIMITS.maxChartLabelChars),
    value: point.value,
  }))
  return {
    title: sanitiseUntrustedText(String(raw.title), MIND_TOOL_LIMITS.maxChartTitleChars),
    kind: raw.kind === 'line' ? 'line' : 'bar',
    unit: sanitiseUntrustedText(String(raw.unit), MIND_TOOL_LIMITS.maxChartUnitChars),
    points,
  }
}

/**
 * Bound a canvas returned by a tool: the content is text-bounded, the title is
 * text-bounded, the kind is closed (document | code), and the language is
 * closed to a small set the renderer can handle honestly. A canvas that
 * exceeds the cap is truncated, with a "…" marker at the end, because a
 * document half-served is worse than one clearly cut.
 */
export function boundCanvas(raw: CanvasSpec): CanvasSpec {
  const content = sanitiseUntrustedText(String(raw.content), MIND_TOOL_LIMITS.maxCanvasChars)
  return {
    title: sanitiseUntrustedText(String(raw.title), MIND_TOOL_LIMITS.maxCanvasTitleChars),
    kind: raw.kind === 'code' ? 'code' : 'document',
    language: readCanvasLanguage(raw.language),
    content,
  }
}

export function readCanvasLanguage(value: unknown): CanvasLanguage {
  if (typeof value !== 'string') return 'text'
  const asked = value.trim().toLowerCase()
  if (asked === 'markdown' || asked === 'md') return 'markdown'
  if (asked === 'html' || asked === 'htm') return 'html'
  if (asked === 'javascript' || asked === 'js') return 'javascript'
  if (asked === 'python' || asked === 'py') return 'python'
  if (asked === 'css') return 'css'
  if (asked === 'json') return 'json'
  return 'text'
}
