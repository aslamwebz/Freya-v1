import type { MindTool, ChartKind, ChartPoint } from './types'
import { MIND_TOOL_LIMITS } from './limits'
import { boundChart } from './artifact-bounds'

/**
 * The chart maker.
 *
 * One tool, two shapes (bar, line), one job: turn the numbers the model can
 * already see into a typed chart payload that travels beside the prose and
 * the renderer can draw without re-parsing. The model does not draw the
 * chart — the renderer does — so the data here is what the chart is, not a
 * description of one.
 *
 * Capability: `search.web`. The same gate that admits web search admits the
 * chart tool, because both produce visible artifacts from external data and
 * the owner is the only principal that holds either.
 */
export function createChartTool(): MindTool {
  return {
    name: 'make_chart',
    description:
      'Attach a typed chart to the answer, drawn by the renderer. Use it when the answer '
      + 'is a series of numbers the reader is going to want to compare — yearly sales, '
      + 'monthly growth, a survey over time. Two kinds: `bar` for comparing a handful of '
      + 'values side by side, `line` for showing a trend. The data travels as labelled '
      + 'points; the renderer never re-parses the prose to find a number.',
    capability: 'search.web',
    parameters: [
      { name: 'title', description: 'A short title for the chart, e.g. "NVIDIA revenue 2010–2020".', required: true },
      {
        name: 'kind',
        description: '`bar` for comparing values, `line` for showing a trend.',
        required: true,
      },
      { name: 'unit', description: 'The unit of the value, e.g. "USD billion", "%", "million units".', required: true },
      {
        name: 'points',
        description: 'A JSON-encoded string containing an array of `{ label, value }` pairs; value is a finite number. Encode this argument as a string, like every other tool argument.',
        required: true,
        maxChars: MIND_TOOL_LIMITS.maxRequestChars,
      },
    ],
    async run(request) {
      const title = request.arguments['title'] ?? ''
      if (title.trim().length === 0) throw new Error('the chart title was empty')
      const kind = readChartKind(request.arguments['kind'])
      const unit = request.arguments['unit'] ?? ''
      if (unit.trim().length === 0) throw new Error('the chart unit was empty')
      const points = parseChartPoints(request.arguments['points'])
      const chart = boundChart({ title, kind, unit, points })
      const span = points.length === 0
        ? 'no points'
        : points.length === 1
          ? '1 point'
          : `${points.length} points`
      return {
        summary: `Made a ${kind} chart "${chart.title}" (${chart.unit}) with ${span}.`,
        sources: [],
        chart,
      }
    },
  }
}

function readChartKind(value: unknown): ChartKind {
  if (typeof value !== 'string') return 'bar'
  const asked = value.trim().toLowerCase()
  if (asked === 'bar' || asked === 'bars' || asked === 'column' || asked === 'columns') return 'bar'
  if (asked === 'line' || asked === 'lines' || asked === 'trend') return 'line'
  return 'bar'
}

function parseChartPoints(value: unknown): readonly ChartPoint[] {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Chart points must be supplied as a JSON-encoded array string.')
  // A malformed series is a failed tool call, not a successful empty chart.
  // An explicitly supplied [] remains a valid empty series.
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Chart points were not valid JSON. Supply a JSON-encoded array string.')
  }
  if (!Array.isArray(parsed)) throw new Error('Chart points must be an array of label/value pairs.')
  const out: ChartPoint[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) throw new Error('Each chart point must contain a label and numeric value.')
    const record = entry as Record<string, unknown>
    const label = record['label']
    const numeric = record['value']
    if (typeof label !== 'string' || label.length === 0 || typeof numeric !== 'number' || !Number.isFinite(numeric)) throw new Error('Each chart point must contain a non-empty label and finite numeric value.')
    out.push({ label, value: numeric })
  }
  return out
}
