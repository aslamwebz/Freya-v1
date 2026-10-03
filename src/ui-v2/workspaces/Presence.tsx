import { useEffect, useRef, useState, type CSSProperties } from 'react'
import portrait from '../assets/freya-portrait.webp'

export type PresenceMode = 'attentive' | 'planning' | 'creating' | 'searching' | 'unknown'
export function Compass({ compact = false, title = 'Phase 19', caption = 'Same mind. A brighter tomorrow.', presence = 'attentive', onFocus }:
  { compact?: boolean; title?: string; caption?: string; presence?: PresenceMode; onFocus?: (focus: string) => void }) {
  const stage = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(document.hidden)
  useEffect(() => {
    const visibility = () => setPaused(document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  const reset = () => { stage.current?.style.setProperty('--presence-x', '0px'); stage.current?.style.setProperty('--presence-y', '0px') }
  const labels = [['top', 'Understand', 'Product'], ['left', 'Plan', 'Strategy'], ['right', 'Create', 'Launch']]
  return <div className={`f-compass ${compact ? 'f-compass--compact' : ''}`} aria-label="Freya workspace identity" data-presence={presence} data-paused={paused}
    onPointerMove={event => {
      if (event.pointerType !== 'mouse') return
      const box = event.currentTarget.getBoundingClientRect()
      stage.current?.style.setProperty('--presence-x', `${Math.max(-5, Math.min(5, (event.clientX - box.left - box.width / 2) / box.width * 10))}px`)
      stage.current?.style.setProperty('--presence-y', `${Math.max(-4, Math.min(4, (event.clientY - box.top - box.height / 2) / box.height * 8))}px`)
    }} onPointerLeave={reset}>
    <div className="f-presence-stage" ref={stage}>
      <svg className="f-orbital-field" viewBox="0 0 500 500" fill="none" aria-hidden="true">
        <circle className="f-orbital-track" cx="250" cy="250" r="247" />
        <circle className="f-orbital-track" cx="250" cy="250" r="231" strokeDasharray="1 14" />
        <circle className="f-orbital-track" cx="250" cy="250" r="205" />
        <circle className="f-orbital-track" cx="250" cy="250" r="186" />
        <g className="f-orbital-rotor f-orbital-rotor--outer"><circle className="f-orbital-arc" cx="250" cy="250" r="247" strokeDasharray="155 170 34 340 64 790" />
          {[18, 90, 150, 220, 280].map((angle, index) => <g key={angle} transform={`rotate(${angle} 250 250)`}><circle className={`f-orbital-particle f-orbital-particle--${index % 2}`} cx="250" cy="19" r={index % 2 ? 3 : 2} /></g>)}</g>
        <g className="f-orbital-rotor f-orbital-rotor--inner"><circle className="f-orbital-arc f-orbital-arc--bright" cx="250" cy="250" r="205" strokeDasharray="285 190 78 210 180 345" />
          <circle className="f-orbital-particle" cx="250" cy="45" r="4" /><circle className="f-orbital-particle f-orbital-particle--1" cx="250" cy="455" r="3" /></g>
        <g className="f-orbital-rotor f-orbital-rotor--middle"><circle className="f-orbital-arc f-orbital-arc--lilac" cx="250" cy="250" r="219" strokeDasharray="80 70 3 650 120 454" /></g>
      </svg>
      <img className="f-presence-portrait" src={portrait} alt="Freya" draggable={false} />
    </div>
    {labels.map(([position, label, focus]) => onFocus ? <button type="button" className={`f-compass-label f-compass-label--${position}`} key={position} onClick={() => onFocus(focus!)}>{label}</button>
      : <span className={`f-compass-label f-compass-label--${position}`} key={position}>{label}</span>)}
    <div className="f-compass-heart"><b>FREYA</b><span>{title}</span><small>{caption}</small></div>
    <span className="f-compass-label f-compass-label--bottom">Remember · Connect · Act</span>
  </div>
}
export function AttentionRing({ value }: { value: number | null }) {
  // A live Core reports a closed `FocusState`, not a percentage, so `null` means "no
  // figure exists" and renders as such rather than as a confident 0%.
  const percent = value === null ? null : Math.min(100, Math.max(0, value))
  return <div className="f-attention-ring" style={{ '--attention-value': percent ?? 0 } as CSSProperties} role="meter" aria-label="Focused attention" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? 'No focus percentage' : undefined}>
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle className="f-attention-track" cx="50" cy="50" r="44" /><circle className="f-attention-value" cx="50" cy="50" r="44" pathLength="100" strokeDasharray={`${percent ?? 0} 100`} /></svg>
    <b>{percent === null ? '—' : percent}<span>{percent === null ? '' : '%'}</span></b>
  </div>
}
