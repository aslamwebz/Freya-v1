import { useMemo } from 'react'

export interface ChartPoint {
  readonly label: string
  readonly value: number
}
export interface ChartSpec {
  readonly title: string
  readonly kind: 'bar' | 'line'
  readonly unit: string
  readonly points: readonly ChartPoint[]
}

export interface ChartViewProps {
  readonly chart: ChartSpec
}

/**
 * Draw a typed chart from data the model returned.
 *
 * The journal keeps the literal model text, but the chart itself is data —
 * labelled points and a kind — so the renderer never has to read numbers out
 * of a paragraph. The drawing here is a small SVG: bars for kind=bar, a line
 * for kind=line, with axes and tick labels in the unit the model stated.
 * Nothing in here invents a number, and an empty series shows as "no data"
 * rather than a flat zero.
 */
export function ChartView({ chart }: ChartViewProps) {
  const layout = useMemo(() => computeLayout(chart), [chart])

  if (chart.points.length === 0) {
    return (
      <figure className="f-chart" data-kind={chart.kind}>
        <figcaption className="f-chart-title">{chart.title}</figcaption>
        <div className="f-chart-empty">No data was supplied for this chart.</div>
      </figure>
    )
  }

  return (
    <figure className="f-chart" data-kind={chart.kind}>
      <figcaption className="f-chart-title">{chart.title}</figcaption>
      <svg
        className="f-chart-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`${chart.title}: ${chart.kind} chart with ${chart.points.length} data points in ${chart.unit}`}
      >
        <defs>
          <linearGradient id="f-chart-bar-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6fdcff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#6fdcff" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        {/* Y-axis grid + labels */}
        {layout.ticks.map((tick) => (
          <g key={`tick-${tick.value}`}>
            <line x1={layout.left} x2={layout.right} y1={tick.y} y2={tick.y} className="f-chart-grid" />
            <text x={layout.left - 6} y={tick.y} className="f-chart-tick" dominantBaseline="middle" textAnchor="end">
              {formatTick(tick.value, chart.unit)}
            </text>
          </g>
        ))}
        {/* X-axis baseline */}
        <line x1={layout.left} x2={layout.right} y1={layout.bottom} y2={layout.bottom} className="f-chart-axis" />

        {chart.kind === 'bar' ? (
          chart.points.map((point, index) => {
            const slotWidth = (layout.right - layout.left) / chart.points.length
            const x = layout.left + slotWidth * index + slotWidth * 0.12
            const w = slotWidth * 0.76
            const y = layout.scaleY(point.value)
            const h = layout.bottom - y
            return (
              <g key={`b-${point.label}-${index}`}>
                <rect x={x} y={y} width={w} height={h} rx={2} className="f-chart-bar" />
                <text
                  x={x + w / 2}
                  y={layout.bottom + 14}
                  className="f-chart-x-label"
                  textAnchor="middle"
                >
                  {point.label}
                </text>
              </g>
            )
          })
        ) : (
          <>
            <polyline
              points={chart.points.map((point, index) => {
                const slotWidth = (layout.right - layout.left) / chart.points.length
                const x = layout.left + slotWidth * (index + 0.5)
                const y = layout.scaleY(point.value)
                return `${x},${y}`
              }).join(' ')}
              className="f-chart-line"
            />
            {chart.points.map((point, index) => {
              const slotWidth = (layout.right - layout.left) / chart.points.length
              const x = layout.left + slotWidth * (index + 0.5)
              const y = layout.scaleY(point.value)
              return (
                <g key={`p-${point.label}-${index}`}>
                  <circle cx={x} cy={y} r={3} className="f-chart-dot" />
                  <text
                    x={x}
                    y={layout.bottom + 14}
                    className="f-chart-x-label"
                    textAnchor="middle"
                  >
                    {point.label}
                  </text>
                </g>
              )
            })}
          </>
        )}
      </svg>
      <div className="f-chart-foot">
        <span className="f-chart-unit">{chart.unit}</span>
        <span className="f-chart-range">
          {formatRange(chart.points, chart.unit)}
        </span>
      </div>
    </figure>
  )
}

interface ChartLayout {
  readonly width: number
  readonly height: number
  readonly left: number
  readonly right: number
  readonly bottom: number
  readonly ticks: readonly { readonly value: number; readonly y: number }[]
  readonly scaleY: (value: number) => number
}

function computeLayout(chart: ChartSpec): ChartLayout {
  const width = 640
  const height = 220
  const left = 56
  const right = width - 16
  const top = 16
  const bottom = height - 36

  const values = chart.points.map((p) => p.value)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  // Always include zero in the range so a "growth" chart never lies by cropping the floor.
  const lo = min < 0 ? min : 0
  const hi = max > 0 ? max : 1
  const span = Math.max(1e-9, hi - lo)
  // A small headroom so the highest point never sits on the top edge.
  const paddedHi = lo === 0 ? hi * 1.08 : hi + span * 0.05
  const paddedLo = lo < 0 ? lo - span * 0.05 : 0
  const paddedSpan = Math.max(1e-9, paddedHi - paddedLo)

  const scaleY = (value: number): number => {
    const ratio = (value - paddedLo) / paddedSpan
    return bottom - ratio * (bottom - top)
  }

  // Four horizontal ticks: floor, thirds, ceiling.
  const ticks: { value: number; y: number }[] = []
  for (let i = 0; i <= 3; i += 1) {
    const v = paddedLo + (paddedSpan * i) / 3
    ticks.push({ value: v, y: scaleY(v) })
  }

  return { width, height, left, right, bottom, ticks, scaleY }
}

function formatTick(value: number, unit: string): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs === 0) return `0 ${unit}`.trim()
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B ${unit}`.trim()
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M ${unit}`.trim()
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K ${unit}`.trim()
  if (Number.isInteger(value)) return `${value} ${unit}`.trim()
  return `${value.toFixed(2)} ${unit}`.trim()
}

function formatRange(points: readonly ChartPoint[], unit: string): string {
  if (points.length === 0) return ''
  let min = points[0]?.value ?? 0
  let max = min
  for (const p of points) {
    if (p.value < min) min = p.value
    if (p.value > max) max = p.value
  }
  return `${formatTick(min, unit)} → ${formatTick(max, unit)}`
}
