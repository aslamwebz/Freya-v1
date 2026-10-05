import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
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
  readonly edge: 'left' | 'right' | 'top' | 'bottom'
}

const COMPONENTS: readonly ComponentCard[] = [
  { id: 'home', nav: 'home', label: 'Home', description: 'Central overview', icon: 'home', edge: 'bottom' },
  { id: 'chat', nav: 'chat', label: 'Chat', description: 'Talk with Freya', icon: 'chat', edge: 'right' },
  { id: 'mind', nav: 'mind', label: 'Mind', description: 'Cognition & reasoning', icon: 'mind', edge: 'left' },
  { id: 'mission', nav: 'focus', label: 'Mission', description: 'Goals & direction', icon: 'mission', edge: 'right' },
  { id: 'focus', nav: 'focus', label: 'Focus', description: 'Attention & deep work', icon: 'focus', edge: 'left' },
  { id: 'relay', nav: 'relay', label: 'Relay', description: 'Connections & signals', icon: 'relay', edge: 'right' },
  { id: 'people', nav: 'people', label: 'People', description: 'Relationships & context', icon: 'people', edge: 'left' },
  { id: 'foundry', nav: 'create', label: 'Foundry', description: 'Build & create', icon: 'forge', edge: 'right' },
  { id: 'workforce', nav: 'workforce', label: 'Workforce', description: 'Agents & automation', icon: 'workforce', edge: 'left' },
  { id: 'life', nav: 'life', label: 'Life', description: 'Growth & balance', icon: 'life', edge: 'top' },
  { id: 'world', nav: 'world', label: 'World', description: 'Real-time context', icon: 'world', edge: 'top' },
  { id: 'memory', nav: 'memory', label: 'Memory', description: 'Durable knowledge', icon: 'memory', edge: 'top' },
]

const HOT_BY_STATE: Record<BrainState, readonly string[]> = {
  calm: [],
  thinking: ['mind', 'focus', 'memory'],
  researching: ['mind', 'world', 'memory'],
  delegating: ['workforce', 'relay', 'mission'],
  load: COMPONENTS.map((card) => card.id),
  success: ['home', 'mission', 'life'],
  uncertainty: ['home', 'focus', 'relay'],
}

const STRANDS: Readonly<Record<string, string>> = {
  home: 'M500 174 C500 139 500 120 500 105',
  chat: 'M362 238 C327 194 302 151 290 121',
  mind: 'M638 238 C673 194 698 151 710 121',
  mission: 'M318 318 C280 296 246 282 226 273',
  focus: 'M682 318 C720 296 754 282 774 273',
  relay: 'M302 399 C257 405 220 419 197 431',
  people: 'M698 399 C743 405 780 419 803 431',
  foundry: 'M338 493 C301 528 273 555 249 579',
  workforce: 'M662 493 C699 528 727 555 751 579',
  life: 'M425 552 C405 597 384 622 358 644',
  world: 'M575 552 C595 597 616 622 642 644',
  memory: 'M500 568 C500 610 500 638 500 660',
}

const GATE_SEGMENTS: readonly [number, number][] = [
  [-84, -36],
  [-18, 27],
  [46, 91],
  [111, 160],
  [184, 229],
  [249, 296],
]

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

export function StargateHub({ state, energy, onNavigate }: Props) {
  const [fired, setFired] = useState<readonly string[]>([])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onFire = (event: Event): void => {
      const detail = (event as CustomEvent<{ ids?: readonly string[] }>).detail
      const ids = detail?.ids?.filter((id) => COMPONENTS.some((card) => card.id === id)) ?? []
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

  return (
    <section
      className="sg-hub"
      data-state={state}
      data-busy={clampedEnergy > .08 || undefined}
      style={{ '--sg-energy': clampedEnergy } as CSSProperties}
      aria-label="Freya containment field"
    >
      <svg className="sg-strands" viewBox="0 0 1000 760" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <filter id="sg-strand-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <linearGradient id="sg-strand-violet" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#9cb8b3" />
            <stop offset=".52" stopColor="#d8ece7" />
            <stop offset="1" stopColor="#8fd8d0" />
          </linearGradient>
        </defs>
        {COMPONENTS.map((card, index) => (
          <g key={card.id} className="sg-strand-group" data-hot={hot.has(card.id) || undefined} style={{ '--sg-delay': `${index * -0.19}s` } as CSSProperties}>
            <path className="sg-strand-aura" d={STRANDS[card.id]} />
            <path className="sg-strand-core" d={STRANDS[card.id]} />
            <path className="sg-strand-pulse" d={STRANDS[card.id]} pathLength="100" />
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
            <stop offset="0" stopColor="#444744" />
            <stop offset=".18" stopColor="#252928" />
            <stop offset=".62" stopColor="#141718" />
            <stop offset="1" stopColor="#2f302b" />
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

        <circle className="sg-gate-guide" cx="250" cy="250" r="202" />
        {GATE_SEGMENTS.map(([start, end], index) => {
          const mid = (start + end) / 2
          const marker = polar(250, 250, 201, mid)
          return (
            <g className="sg-gate-segment" key={start} style={{ '--sg-seg': index } as CSSProperties}>
              <path className="sg-gate-back" d={arcPath(250, 250, 201, start, end)} />
              <path className="sg-gate-body" d={arcPath(250, 250, 201, start + 1.5, end - 1.5)} />
              <path className="sg-gate-rim sg-gate-rim-outer" d={arcPath(250, 250, 224, start + 2, end - 2)} />
              <path className="sg-gate-rim sg-gate-rim-inner" d={arcPath(250, 250, 178, start + 2, end - 2)} />
              <g transform={`translate(${marker.x} ${marker.y}) rotate(${mid})`}>
                <path className="sg-gate-chevron" d="M0 -10 9 7 0 3 -9 7Z" />
                <circle className="sg-gate-node" cx="0" cy="0" r="3.2" />
              </g>
            </g>
          )
        })}
      </svg>

      <div className="sg-core" aria-label="Freya live core">
        <LiveOrb state={state} energy={energy} />
      </div>

      <div className="sg-card-layer">
        {COMPONENTS.map((card) => (
          <button
            key={card.id}
            type="button"
            className={`sg-card sg-card-${card.id}`}
            data-edge={card.edge}
            data-hot={hot.has(card.id) || undefined}
            onClick={() => onNavigate(card.nav)}
            aria-label={`Open ${card.label}`}
          >
            <span className="sg-card-runes" aria-hidden="true">⋮ ⋄ ∴</span>
            <span className="sg-card-icon"><Glyph name={card.icon} size={21} /></span>
            <span className="sg-card-copy"><b>{card.label}</b><small>{card.description}</small></span>
            <span className="sg-card-meter" aria-hidden="true"><i /><i /><i /></span>
            <span className="sg-card-coupler" aria-hidden="true" />
            <span className="sg-card-port" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  )
}
