import type { ReactNode } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'

/**
 * A card — the v2 instrument panel.
 *
 * Dark smoked glass, a hairline top edge, an icon chip, a title and an optional
 * right-aligned menu. The body is whatever the card needs; the chrome is shared
 * so the whole board reads as one instrument rather than a pile of boxes.
 */
export function Card({ title, subtitle, icon, meta, className = '', children }: {
  title: string
  subtitle?: ReactNode
  icon: string
  meta?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <article className={`c-card ${className}`}>
      <header className="c-head">
        <span className="c-icon"><Glyph name={icon} /></span>
        <div className="c-titles">
          <h2>{title}{subtitle ? <small>{subtitle}</small> : null}</h2>
        </div>
        {meta ?? <span className="c-more" aria-hidden="true">•••</span>}
      </header>
      <div className="c-body">{children}</div>
    </article>
  )
}

/** A thin meter. A null value is an empty track, never a fake fill. */
export function Meter({ value, tone = 'intelligence' }: { value: number | null; tone?: string }) {
  const pct = value === null ? 0 : Math.min(100, Math.max(0, value))
  return (
    <span className="c-meter" data-tone={tone} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : pct}>
      <i style={{ width: `${pct}%` }} data-known={value !== null} />
    </span>
  )
}

export function Chip({ children, tone = 'quiet', pressed }: { children: ReactNode; tone?: 'quiet' | 'accent'; pressed?: boolean }) {
  return <span className="c-chip" data-tone={tone} data-pressed={pressed || undefined}>{children}</span>
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="c-empty"><b>{title}</b><span>{detail}</span></div>
}

/** A row with a leading chip, a title/detail pair, and a right-aligned end. */
export function Row({ icon, title, detail, end, tone }: { icon?: string; title: string; detail?: string; end?: ReactNode; tone?: string }) {
  return (
    <div className="c-row">
      {icon ? <span className="c-row-icon" data-tone={tone}><Glyph name={icon} size={16} /></span> : null}
      <span className="c-row-text"><b>{title}</b>{detail ? <small>{detail}</small> : null}</span>
      {end ? <span className="c-row-end">{end}</span> : null}
    </div>
  )
}
