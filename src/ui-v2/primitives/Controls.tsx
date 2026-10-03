import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type HTMLAttributes } from 'react'
import { Glyph } from './Glyph'

export function Button({ variant = 'quiet', className = '', type = 'button', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'quiet' | 'primary' | 'danger' }) {
  return <button type={type} className={`f-button f-button--${variant} ${className}`} {...props} />
}
export function Field({ label, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const generated = useId()
  const fieldId = id ?? generated
  return <label className="f-field" htmlFor={fieldId}><span>{label}</span><input id={fieldId} {...props} /></label>
}
const panelIcons: Record<string, string> = {
  'Current focus': 'focus', Mission: 'mission', Attention: 'life', People: 'people', Workforce: 'workforce',
  'Recent memory': 'memory', World: 'world', 'Selected connection': 'people', Conversations: 'relay',
  Connections: 'world', 'Workforce summary': 'workforce', 'Active agents': 'people', 'Mission linkage': 'mission',
  Foundry: 'forge', 'Creation assistant': 'create', 'My creations': 'forge',
}
export function Panel({ title, meta, children, className = '', icon, ...props }:
  { title: string; meta?: ReactNode; children: ReactNode; className?: string; icon?: string } & HTMLAttributes<HTMLElement>) {
  const id = useId(), symbol = icon ?? panelIcons[title]
  return <section className={`f-panel ${className}`} aria-labelledby={id} {...props}>
    <header className="f-panel-head"><div className="f-panel-label">{symbol && <Glyph name={symbol} size={27} />}<h2 id={id}>{title}</h2></div>
      {meta ?? <span className="f-panel-more" aria-hidden="true">•••</span>}</header>{children}
  </section>
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'positive' | 'attention' | 'danger' | 'cognition' }) {
  return <span className="f-badge" data-tone={tone}>{children}</span>
}
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="f-empty"><h3>{title}</h3><p>{detail}</p></div>
}
export function Progress({ label, value }: { label: string; value: number | null }) {
  const known = value !== null && Number.isFinite(value)
  const progress = known ? Math.min(100, Math.max(0, value)) : undefined
  return <div className="f-progress" role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
    aria-valuetext={known ? undefined : 'Progress unavailable'}>
    <span style={{ width: progress === undefined ? '25%' : `${progress}%` }} data-known={known} />
  </div>
}
