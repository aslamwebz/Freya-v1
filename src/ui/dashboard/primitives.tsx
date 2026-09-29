import type { ReactNode } from 'react'

export function Panel({
  title,
  meta,
  action,
  children,
}: {
  title: string
  meta?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        <div className="panel-head-right">
          {meta}
          {action}
        </div>
      </header>
      {children}
    </section>
  )
}

/** The reference's progress bar, unchanged. */
export function Meter({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div
      className="meter"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <i style={{ width: `${clamped}%` }} />
    </div>
  )
}

export function Dot({ tone }: { tone: 'good' | 'amber' | 'idle' }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />
}

export function DemoTag({ children = 'Demo data' }: { children?: ReactNode }) {
  return (
    <span className="demo-tag" title="Fictional values shown for layout evaluation">
      {children}
    </span>
  )
}
