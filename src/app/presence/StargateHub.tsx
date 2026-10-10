import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { BrainState } from './state'
import { LiveOrb } from './LiveOrb'
import './stargate-hub.css'

interface Props {
  readonly state: BrainState
  readonly energy: number
  readonly onNavigate: (screen: string) => void
}

interface ComponentCard {
  readonly id: string
  readonly nav: string
  readonly label: string
  readonly description: string
  readonly icon: string
  readonly angle: number
}

const COMPONENTS: readonly ComponentCard[] = [
  { id: 'mind', nav: 'mind/overview', label: 'Mind', description: 'Mind overview and decisions', icon: 'mind', angle: 0 },
  { id: 'focus', nav: 'mind/focus', label: 'Focus & Attention', description: 'Mind focus and attention', icon: 'focus', angle: 36 },
  { id: 'library', nav: 'library/knowledge', label: 'Library', description: 'Knowledge and evidence', icon: 'memory', angle: 72 },
  { id: 'office', nav: 'office/scene', label: 'Office', description: 'Live agent workstations', icon: 'workforce', angle: 108 },
  { id: 'world', nav: 'world/digest', label: 'World', description: 'World and news digest', icon: 'world', angle: 144 },
  { id: 'memory', nav: 'mind/memory', label: 'Memory', description: 'Mind memory continuity', icon: 'memory', angle: 180 },
  { id: 'workflows', nav: 'workflows/tasks', label: 'Workflows', description: 'Tasks and execution', icon: 'widgets', angle: 216 },
  { id: 'settings', nav: 'settings/appearance', label: 'Settings', description: 'Personalization and controls', icon: 'settings', angle: 252 },
  { id: 'chat', nav: 'chat', label: 'Chats', description: 'Conversations and browser', icon: 'chat', angle: 288 },
  { id: 'missions', nav: 'missions/missions', label: 'Missions', description: 'Goals and verified outcomes', icon: 'mission', angle: 324 },
]

/** The Core and existing clients can still emit the original component IDs. */
const LEGACY_COMPONENT_ALIASES: Readonly<Record<string, string>> = {
  people: 'library',
  workforce: 'office',
  life: 'workflows',
  foundry: 'settings',
  relay: 'chat',
  mission: 'missions',
}

const HOT_BY_STATE: Record<BrainState, readonly string[]> = {
  calm: [],
  thinking: ['mind', 'focus', 'memory'],
  researching: ['mind', 'world', 'library'],
  delegating: ['office', 'workflows', 'missions'],
  load: COMPONENTS.map((card) => card.id),
  success: ['missions', 'workflows'],
  uncertainty: ['focus', 'library'],
}

// One fragment per subsystem, centred on that subsystem's angle. The socket is
// machined at the fragment's midpoint, so a port cannot drift off its fragment:
// the invariant is structural rather than hand-tuned.
const SEGMENT_HALF = 15

/** Unit-ish step pointing outward along `degrees`, used to slide a hot fragment open. */
function radialStep(degrees: number, distance: number): { x: string; y: string } {
  const angle = (degrees - 90) * Math.PI / 180
  return { x: `${(Math.cos(angle) * distance).toFixed(2)}px`, y: `${(Math.sin(angle) * distance).toFixed(2)}px` }
}

const COMPONENT_EVENT = 'freya:component-fire'

export function fireFreyaComponents(ids: readonly string[]): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(COMPONENT_EVENT, { detail: { ids } }))
}

function polar(cx: number, cy: number, radius: number, degrees: number): { x: number; y: number } {
  const angle = (degrees - 90) * Math.PI / 180
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
}

function arcPath(cx: number, cy: number, radius: number, start: number, end: number): string {
  const first = polar(cx, cy, radius, end)
  const last = polar(cx, cy, radius, start)
  const span = Math.abs(end - start)
  return `M ${first.x.toFixed(2)} ${first.y.toFixed(2)} A ${radius} ${radius} 0 ${span > 180 ? 1 : 0} 0 ${last.x.toFixed(2)} ${last.y.toFixed(2)}`
}

function sectorPath(cx: number, cy: number, inner: number, outer: number, start: number, end: number): string {
  const a = polar(cx, cy, outer, start)
  const b = polar(cx, cy, outer, end)
  const c = polar(cx, cy, inner, end)
  const d = polar(cx, cy, inner, start)
  return `M${a.x} ${a.y} A${outer} ${outer} 0 0 1 ${b.x} ${b.y} L${c.x} ${c.y} A${inner} ${inner} 0 0 0 ${d.x} ${d.y} Z`
}

export function StargateHub({ state, energy, onNavigate }: Props) {
  const hubRef = useRef<HTMLElement>(null)
  const [frame, setFrame] = useState({ width: 1000, height: 760, gate: 470 })
  const [fired, setFired] = useState<readonly string[]>([])

  useLayoutEffect(() => {
    const hub = hubRef.current
    if (!hub) return
    const measure = (): void => {
      const field = hub.getBoundingClientRect()
      const gate = hub.querySelector('.sg-gate')?.getBoundingClientRect()
      if (!gate) return
      setFrame({ width: field.width, height: field.height, gate: gate.width })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(hub)
    hub.querySelectorAll('.sg-gate').forEach((element) => observer.observe(element))
    window.addEventListener('resize', measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onFire = (event: Event): void => {
      const detail = (event as CustomEvent<{ ids?: readonly string[] }>).detail
      const ids = [...new Set(detail?.ids?.map((id) => LEGACY_COMPONENT_ALIASES[id] ?? id)
        .filter((id) => COMPONENTS.some((card) => card.id === id)) ?? [])]
      if (ids.length === 0) return
      setFired(ids)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setFired([]), 1700)
    }

    window.addEventListener(COMPONENT_EVENT, onFire)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener(COMPONENT_EVENT, onFire)
    }
  }, [])

  const hot = useMemo(() => new Set([...HOT_BY_STATE[state], ...fired]), [state, fired])
  const clampedEnergy = Math.max(0, Math.min(1, energy))

  const cx = frame.width / 2
  const cy = frame.height / 2
  const outer = Math.max(100, Math.min(cy - 18, cx - 64))
  const thickness = Math.min(82, Math.max(58, outer * .23))
  const inner = outer - thickness
  const strands = Object.fromEntries(COMPONENTS.map((card) => {
    const portAngle = card.angle
    const start = polar(cx, cy, frame.gate * 224 / 500, portAngle)
    const control = polar(cx, cy, frame.gate * 224 / 500 + 18, portAngle)
    const end = polar(cx, cy, inner, card.angle)
    const approach = polar(cx, cy, inner - 18, card.angle)
    return [card.id, `M${start.x} ${start.y} C${control.x} ${control.y} ${approach.x} ${approach.y} ${end.x} ${end.y}`]
 }))

  return (
    <section
      ref={hubRef}
      className="sg-hub"
      data-state={state}
      data-busy={clampedEnergy > .08 || undefined}
      style={{ '--sg-energy': clampedEnergy } as CSSProperties}
      aria-label="Freya containment field"
    >
      <svg className="sg-strands" aria-hidden="true">
        <defs>
          <filter id="sg-strand-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <linearGradient id="sg-strand-signal" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9cb8b3" />
            <stop offset=".52" stopColor="#d8ece7" />
            <stop offset="1" stopColor="#8fd8d0" />
          </linearGradient>
        </defs>
        {COMPONENTS.map((card, index) => (
          <g key={card.id} className="sg-strand-group" data-hot={hot.has(card.id) || undefined} style={{ '--sg-delay': `${index * -0.19}s` } as CSSProperties}>
            <path className="sg-strand-aura" d={strands[card.id]} />
            <path className="sg-strand-core" d={strands[card.id]} />
            <path className="sg-strand-pulse" d={strands[card.id]} pathLength="100" />
          </g>
        ))}
      </svg>

      <svg className="sg-gate" viewBox="0 0 500 500" aria-hidden="true">
        <defs>
          <linearGradient id="sg-metal" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0a0d0e" />
            <stop offset=".22" stopColor="#34393a" />
            <stop offset=".46" stopColor="#15191a" />
            <stop offset=".72" stopColor="#2c2d29" />
            <stop offset="1" stopColor="#07090a" />
          </linearGradient>
          <linearGradient id="sg-metal-face" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#a9bfbe" stopOpacity=".36" />
            <stop offset=".18" stopColor="#63858a" stopOpacity=".25" />
            <stop offset=".62" stopColor="#1b3440" stopOpacity=".2" />
            <stop offset="1" stopColor="#94aaa0" stopOpacity=".3" />
          </linearGradient>
          <linearGradient id="sg-edge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8a806d" />
            <stop offset=".5" stopColor="#c0b08d" />
            <stop offset="1" stopColor="#6d685b" />
          </linearGradient>
          <filter id="sg-gate-glow" x="-35%" y="-35%" width="170%" height="170%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Ten keyed fragments. Each owns its subsystem, and its socket sits at the
            fragment's own midpoint, so a port can never slide off its fragment.
            The only motion is the outward slide of an engaged fragment. */}
        {COMPONENTS.map((card) => {
          const start = card.angle - SEGMENT_HALF
          const end = card.angle + SEGMENT_HALF
          const marker = polar(250, 250, 201, card.angle)
          const port = polar(250, 250, 224, card.angle)
          const step = radialStep(card.angle, 4)
          return (
            <g key={card.id} className="sg-gate-segment" data-hot={hot.has(card.id) || undefined}
              style={{ '--sg-sx': step.x, '--sg-sy': step.y } as CSSProperties}>
              <path className="sg-gate-back" d={arcPath(250, 250, 201, start, end)} />
              <path className="sg-gate-body" d={arcPath(250, 250, 201, start + 1.5, end - 1.5)} />
              <path className="sg-gate-rim sg-gate-rim-outer" d={arcPath(250, 250, 224, start + 2, end - 2)} />
              <path className="sg-gate-rim sg-gate-rim-inner" d={arcPath(250, 250, 178, start + 2, end - 2)} />
              <path className="sg-gate-track" d={arcPath(250, 250, 211, start + 4, end - 4)} />
              {[start + 5, end - 5].map((angle) => {
                const point = polar(250, 250, 197, angle)
                return <g key={angle} transform={`translate(${point.x} ${point.y}) rotate(${angle})`}>
                  <path className="sg-gate-engraving" d="M-3 -8H3V-2H-3V5H3 M0 8V12" />
                  <circle className="sg-gate-bolt" cy="20" r="1.8" />
                </g>
              })}
              {[start, end].map((angle) => {
                const point = polar(250, 250, 201, angle)
                return <path key={angle} className="sg-gate-fracture" transform={`translate(${point.x} ${point.y}) rotate(${angle})`} d="M0 -23 3 -15 -2 -7 2 2 -3 13 0 23" />
              })}
              <g transform={`translate(${marker.x} ${marker.y}) rotate(${card.angle})`}>
                <path className="sg-gate-chevron" d="M0 -10 9 7 0 3 -9 7Z" />
                <circle className="sg-gate-node" cx="0" cy="0" r="3.2" />
              </g>
              <g className="sg-gate-socket" transform={`translate(${port.x} ${port.y}) rotate(${card.angle})`}>
                <path d="M-7 5V-4L-4 -7H4L7 -4V5Z" />
                <path className="sg-gate-socket-light" d="M-3 -3H3" />
              </g>
            </g>
          )
        })}
      </svg>

      <div className="sg-core" aria-label="Freya live core">
        <LiveOrb state={state} energy={energy} />
      </div>

      <svg className="sg-card-layer" aria-label="Component gate" viewBox={`0 0 ${frame.width} ${frame.height}`}>
        <defs>
          <linearGradient id="sg-card-glass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9ebdbb" stopOpacity=".24" />
            <stop offset=".45" stopColor="#28424a" stopOpacity=".3" />
            <stop offset="1" stopColor="#a6bdb0" stopOpacity=".12" />
          </linearGradient>
        </defs>
        {COMPONENTS.map((card, index) => {
          const start = card.angle - 15
          const end = card.angle + 15
          const lower = card.angle > 90 && card.angle < 270
          const labelRadius = outer - thickness * (lower ? .63 : .43)
          const labelStart = polar(cx, cy, labelRadius, lower ? end : start)
          const labelEnd = polar(cx, cy, labelRadius, lower ? start : end)
          const socket = polar(cx, cy, inner, card.angle)
          const marker = polar(cx, cy, outer - 9, card.angle)
          const labelId = `sg-label-${card.id}`
          return <g key={card.id} className="sg-card" role="button" tabIndex={0}
            data-hot={hot.has(card.id) || undefined} aria-label={`Open ${card.label}`}
            onClick={() => onNavigate(card.nav)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onNavigate(card.nav) }
            }}>
            <title>{card.description}</title>
            <path className="sg-card-face" d={sectorPath(cx, cy, inner, outer, start, end)} />
            <path className="sg-card-outer-rim" d={arcPath(cx, cy, outer - 4, start + 1, end - 1)} />
            <path className="sg-card-inner-rim" d={arcPath(cx, cy, inner + 5, start + 1, end - 1)} />
            <path className="sg-card-track" d={arcPath(cx, cy, outer - 11, start + 2, end - 2)} />
            <path id={labelId} className="sg-label-guide" d={`M${labelStart.x} ${labelStart.y} A${labelRadius} ${labelRadius} 0 0 ${lower ? 0 : 1} ${labelEnd.x} ${labelEnd.y}`} />
            <text className="sg-card-label" style={{
              fontSize: Math.max(9, Math.min(card.label.length > 12 ? 11 : 14, outer * (card.label.length > 12 ? .039 : .047))),
              letterSpacing: card.label.length > 12 ? '.35px' : undefined,
            }}>
              <textPath href={`#${labelId}`} startOffset="50%" textAnchor="middle">{card.label.toUpperCase()}</textPath>
            </text>
            <g className="sg-card-chevron" transform={`translate(${marker.x} ${marker.y}) rotate(${card.angle})`}>
              <path d="M-7 -3 0 4 7 -3M-4 -4 0 0 4 -4" />
            </g>
            <g className="sg-card-socket" transform={`translate(${socket.x} ${socket.y}) rotate(${card.angle})`}>
              <path d="M-7 -5V4H7V-5" /><path className="sg-card-contact" d="M-3 0H3" />
            </g>
            {[start + 3, end - 3].map((angle) => {
              const rune = polar(cx, cy, outer - thickness / 2, angle)
              return <g key={angle} className="sg-card-rune" transform={`translate(${rune.x} ${rune.y}) rotate(${angle})`}>
                <path d={index % 2 ? 'M-2 -8H2V-2H-2V4H2V8' : 'M0 -8V-3L3 0 0 3V8M-3 -5H3M-3 5H3'} />
              </g>
            })}
          </g>
        })}
      </svg>
    </section>
  )
}
