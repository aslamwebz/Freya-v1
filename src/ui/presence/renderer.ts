import type { PresenceState } from '../../core/presence'
import { buildLattice, DEFAULT_LATTICE, type Lattice } from './lattice'

/**
 * Canvas 2D presence renderer.
 *
 * Owns exactly one animation loop. React tells it *which state* Freya is in;
 * the renderer decides how that looks and eases between states itself. No
 * React re-render happens per frame.
 *
 * Cost control, in order of importance:
 *  - the loop stops entirely when the window is hidden or the user prefers
 *    reduced motion (one static frame is drawn instead);
 *  - draw calls are batched by colour so the 2D context state changes a
 *    handful of times per frame, not once per node;
 *  - `dt` is clamped so a backgrounded tab cannot produce a huge catch-up step.
 */

export interface PresenceVisual {
  /** Lattice spin, radians per second. */
  spin: number
  /** Overall brightness 0..1. */
  glow: number
  /** Frequency of the node twinkle, Hz. */
  pulse: number
  /** Ring expansion 0..1 — opens up when Freya needs the user. */
  expand: number
  /** Scanning band amplitude 0..1 — active while thinking or working. */
  scan: number
  /** 0..1, how much the lattice is agitated. */
  agitation: number
  core: [number, number, number]
  accent: [number, number, number]
}

const VISUALS: Record<PresenceState, PresenceVisual> = {
  idle: {
    spin: 0.06,
    glow: 0.55,
    pulse: 0.35,
    expand: 0,
    scan: 0.12,
    agitation: 0.05,
    core: [255, 176, 84],
    accent: [110, 180, 255],
  },
  listening: {
    spin: 0.13,
    glow: 0.85,
    pulse: 1.1,
    expand: 0.18,
    scan: 0.3,
    agitation: 0.2,
    core: [255, 208, 138],
    accent: [159, 228, 255],
  },
  thinking: {
    spin: 0.1,
    glow: 0.9,
    pulse: 0.85,
    expand: 0.1,
    scan: 1,
    agitation: 0.3,
    core: [255, 190, 110],
    accent: [150, 205, 255],
  },
  working: {
    spin: 0.24,
    glow: 1,
    pulse: 1.5,
    expand: 0.06,
    scan: 0.85,
    agitation: 0.5,
    core: [255, 196, 120],
    accent: [130, 190, 255],
  },
  'needs-user': {
    spin: 0.04,
    glow: 0.8,
    pulse: 0.7,
    expand: 1,
    scan: 0.2,
    agitation: 0.15,
    core: [242, 180, 65],
    accent: [255, 205, 130],
  },
  locked: {
    spin: 0,
    glow: 0.3,
    pulse: 0.12,
    expand: 0,
    scan: 0,
    agitation: 0,
    core: [140, 132, 120],
    accent: [130, 130, 130],
  },
  error: {
    spin: 0.05,
    glow: 0.75,
    pulse: 0.5,
    expand: 0.4,
    scan: 0.15,
    agitation: 0.9,
    core: [255, 110, 100],
    accent: [255, 140, 120],
  },
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

function blendColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

function rgba(color: [number, number, number], alpha: number): string {
  return `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${clamp(alpha, 0, 1).toFixed(3)})`
}

interface RingSpec {
  radius: number
  speed: number
  tilt: number
  ticks: number
  width: number
  tone: 'core' | 'accent'
  alpha: number
  arc?: [number, number][]
}

const RINGS: RingSpec[] = [
  { radius: 1.42, speed: 0.05, tilt: 0.14, ticks: 120, width: 0.006, tone: 'accent', alpha: 0.4 },
  { radius: 1.62, speed: -0.09, tilt: -0.22, ticks: 90, width: 0.01, tone: 'core', alpha: 0.5, arc: [[0, 1.1], [1.6, 0.7], [2.7, 2.0], [5.1, 0.9]] },
  { radius: 1.86, speed: 0.03, tilt: 0.38, ticks: 160, width: 0.004, tone: 'accent', alpha: 0.3 },
]

const PEDESTAL = [
  { radius: 0.72, y: -1.34, alpha: 0.42, dashes: 1 },
  { radius: 1.02, y: -1.44, alpha: 0.3, dashes: 18 },
  { radius: 1.34, y: -1.56, alpha: 0.2, dashes: 1 },
  { radius: 1.7, y: -1.7, alpha: 0.13, dashes: 34 },
]

export interface PresenceRendererOptions {
  reducedMotion: boolean
  maxPixelRatio?: number
}

export class PresenceRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly lattice: Lattice
  private readonly reducedMotion: boolean
  private readonly maxPixelRatio: number

  private raf = 0
  private running = false
  private visible = true
  private time = 0
  private last = 0
  private disposed = false

  private current: PresenceVisual = { ...VISUALS.idle, core: [...VISUALS.idle.core], accent: [...VISUALS.idle.accent] }
  private targetName: PresenceState = 'idle'
  private activity = 0
  private width = 0
  private height = 0

  constructor(canvas: HTMLCanvasElement, options: PresenceRendererOptions) {
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('Freya presence requires a 2D canvas context')
    this.canvas = canvas
    this.ctx = ctx
    this.lattice = buildLattice(DEFAULT_LATTICE)
    this.reducedMotion = options.reducedMotion
    this.maxPixelRatio = options.maxPixelRatio ?? 2
    this.resize()
  }

  setState(state: PresenceState): void {
    this.targetName = state
    if (this.reducedMotion) {
      this.current = this.snapshot(VISUALS[state])
      this.draw()
    }
  }

  /** 0..1, set by the voice control. Feeds the core brightness only. */
  setActivity(value: number): void {
    this.activity = clamp(value, 0, 1)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) this.start()
    else this.stop()
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio)
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (w === this.canvas.width && h === this.canvas.height) return
    this.canvas.width = w
    this.canvas.height = h
    this.width = rect.width
    this.height = rect.height
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (this.reducedMotion) this.draw()
  }

  start(): void {
    if (this.running || this.disposed || this.reducedMotion || !this.visible) return
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  private frame = (now: number): void => {
    if (!this.running) return
    const dt = Math.min((now - this.last) / 1000, 0.05)
    this.last = now
    this.time += dt
    this.draw(dt)
    this.raf = requestAnimationFrame(this.frame)
  }

  private snapshot(v: PresenceVisual): PresenceVisual {
    return { ...v, core: [...v.core], accent: [...v.accent] }
  }

  private draw(dt = 0): void {
    const ctx = this.ctx
    const w = this.width
    const h = this.height
    if (w === 0 || h === 0) return

    const target = VISUALS[this.targetName]
    if (dt > 0) {
      // Fast attack, slow release: state changes should be felt immediately
      // and then settle, rather than cross-fading like a video transition.
      const t = 1 - Math.exp(-dt * (target.spin > this.current.spin ? 9 : 3.4))
      this.current.spin = lerp(this.current.spin, target.spin, t)
      this.current.glow = lerp(this.current.glow, target.glow, t)
      this.current.pulse = lerp(this.current.pulse, target.pulse, t)
      this.current.expand = lerp(this.current.expand, target.expand, t)
      this.current.scan = lerp(this.current.scan, target.scan, t)
      this.current.agitation = lerp(this.current.agitation, target.agitation, t)
      this.current.core = blendColor(this.current.core, target.core, t)
      this.current.accent = blendColor(this.current.accent, target.accent, t)
    } else {
      this.current = this.snapshot(target)
    }

    ctx.clearRect(0, 0, w, h)

    const cx = w / 2
    const cy = h * 0.46
    const scale = Math.min(w, h) * 0.235
    const v = this.current
    const lift = 0.06 * Math.sin(this.time * 0.7)
    const breathe = 1 + 0.025 * Math.sin(this.time * 1.1)
    const expand = 1 + v.expand * 0.14

    this.drawBeam(ctx, cx, cy, scale, v)
    this.drawPedestal(ctx, cx, cy, scale)
    this.drawRings(ctx, cx, cy, scale, v, expand, 'back')
    this.drawLattice(ctx, cx, cy + lift * scale, scale, v, breathe, expand)
    this.drawCore(ctx, cx, cy, scale, v)
    this.drawRings(ctx, cx, cy, scale, v, expand, 'front')
    this.drawScan(ctx, cx, cy, scale, v, expand)
    this.drawVignette(ctx, w, h)
  }

  /* ------------------------------------------------------------ layers */

  private drawBeam(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, v: PresenceVisual): void {
    const top = cy - s * 3.4
    const bottom = cy + s * 1.9
    const height = bottom - top
    const gradient = ctx.createLinearGradient(0, top, 0, bottom)
    gradient.addColorStop(0, rgba(v.accent, 0))
    gradient.addColorStop(0.22, rgba(v.accent, 0.1 * v.glow))
    gradient.addColorStop(0.72, rgba(v.core, 0.09 * v.glow))
    gradient.addColorStop(1, rgba(v.core, 0))
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.moveTo(cx - s * 0.04, top)
    ctx.lineTo(cx + s * 0.04, top)
    ctx.lineTo(cx + s * 0.3, bottom)
    ctx.lineTo(cx - s * 0.3, bottom)
    ctx.closePath()
    ctx.fill()
  }

  private drawPedestal(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(1, 0.26)
    for (const ring of PEDESTAL) {
      ctx.beginPath()
      ctx.arc(0, ring.y / 0.26, ring.radius * s, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 190, 110, ${ring.alpha.toFixed(3)})`
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawRings(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    s: number,
    v: PresenceVisual,
    expand: number,
    pass: 'back' | 'front',
  ): void {
    ctx.save()
    ctx.translate(cx, cy)
    for (let i = 0; i < RINGS.length; i += 1) {
      const ring = RINGS[i]
      if (!ring) continue
      const color = ring.tone === 'core' ? v.core : v.accent
      // Alternating rings sit behind and in front of the lattice so the
      // core reads as genuinely embedded in the instrument.
      const isFront = i === 2
      if ((pass === 'front') !== isFront) continue

      ctx.save()
      ctx.rotate(this.time * ring.speed * 6)
      const tiltY = ring.tilt * Math.cos(this.time * ring.speed * 2.2)
      ctx.transform(1, 0, tiltY * 0.22, 1, 0, 0)

      const radius = ring.radius * s * expand
      ctx.strokeStyle = rgba(color, ring.alpha * v.glow)
      ctx.lineWidth = ring.width * s * 2
      if (ring.arc) {
        for (const [start, length] of ring.arc) {
          ctx.beginPath()
          ctx.arc(0, 0, radius, start, start + length)
          ctx.stroke()
        }
      } else {
        ctx.beginPath()
        ctx.arc(0, 0, radius, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Tick marks — the "instrument" cue.
      const ticks = ring.ticks
      const inner = radius
      const outer = radius + (i % 3 === 0 ? 0.075 : 0.035) * s * expand
      ctx.beginPath()
      for (let t = 0; t < ticks; t += 1) {
        const angle = (t / ticks) * Math.PI * 2
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        ctx.moveTo(cos * inner, sin * inner)
        ctx.lineTo(cos * outer, sin * outer)
      }
      ctx.strokeStyle = rgba(color, ring.alpha * 0.75 * v.glow)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()
  }

  private drawLattice(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    s: number,
    v: PresenceVisual,
    breathe: number,
    expand: number,
  ): void {
    const nodes = this.lattice.nodes
    const cosY = Math.cos(this.time * v.spin)
    const sinY = Math.sin(this.time * v.spin)
    const tilt = Math.sin(this.time * 0.13) * 0.12
    const squash = 1 - tilt * 0.5

    // Project once; reused for edges and nodes so both agree exactly.
    const px = new Float32Array(nodes.length)
    const py = new Float32Array(nodes.length)
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      if (!node) continue
      const agitation = 1 + v.agitation * 0.06 * Math.sin(this.time * 9 + node.phase)
      const radius = s * expand * breathe * agitation
      const x = node.x * radius
      const y = node.y * radius
      const z = node.z * radius
      px[i] = cx + x * cosY + z * sinY
      py[i] = cy + (x * sinY - z * cosY) * squash + y
    }

    // Edges, batched into three depth bands so the stroke style changes rarely.
    for (let band = 0; band < 3; band += 1) {
      ctx.beginPath()
      let any = false
      for (const edge of this.lattice.edges) {
        const depthBand = Math.min(2, (edge.depth * 3) | 0)
        if (depthBand !== band) continue
        const a = px[edge.a]
        const b = px[edge.b]
        if (a === undefined || b === undefined) continue
        ctx.moveTo(a, py[edge.a] ?? 0)
        ctx.lineTo(b, py[edge.b] ?? 0)
        any = true
      }
      if (!any) continue
      const fade = 0.05 + band * 0.035
      ctx.strokeStyle = rgba(v.accent, fade * v.glow)
      ctx.lineWidth = 0.7
      ctx.stroke()
    }

    // Nodes, batched by hue. Hubs are drawn last so they sit on top.
    for (const hue of ['core', 'structure', 'hub'] as const) {
      ctx.beginPath()
      let any = false
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        if (!node || node.hue !== hue) continue
        const twinkle = 0.55 + 0.45 * Math.sin(this.time * v.pulse * 3 + node.phase)
        const radius = hue === 'hub' ? 1.9 * twinkle : hue === 'structure' ? 1.15 : 0.85
        const x = px[i] ?? 0
        const y = py[i] ?? 0
        ctx.moveTo(x + radius, y)
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        any = true
      }
      if (!any) continue
      ctx.fillStyle = rgba(hue === 'core' ? v.core : v.accent, (hue === 'hub' ? 0.85 : 0.55) * v.glow)
      ctx.fill()
    }
  }

  private drawCore(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    s: number,
    v: PresenceVisual,
  ): void {
    const intensity = v.glow * (0.72 + this.activity * 0.28)
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.85)
    gradient.addColorStop(0, rgba(v.core, 0.5 * intensity))
    gradient.addColorStop(0.25, rgba(v.core, 0.16 * intensity))
    gradient.addColorStop(1, rgba(v.core, 0))
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(cx, cy, s * 0.85, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawScan(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    s: number,
    v: PresenceVisual,
    expand: number,
  ): void {
    if (v.scan < 0.02) return
    const y = cy + Math.sin(this.time * 0.55) * s * 0.62 * expand
    const band = s * 0.16
    const gradient = ctx.createLinearGradient(0, y - band, 0, y + band)
    gradient.addColorStop(0, rgba(v.accent, 0))
    gradient.addColorStop(0.5, rgba(v.accent, 0.16 * v.scan * v.glow))
    gradient.addColorStop(1, rgba(v.accent, 0))
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.ellipse(cx, y, s * 0.95 * expand, band, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  /** Fades the field toward the panel edges so it never clashes with text. */
  private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const gradient = ctx.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, Math.max(w, h) * 0.52)
    gradient.addColorStop(0, 'rgba(0,0,0,0)')
    gradient.addColorStop(0.66, 'rgba(0,0,0,0)')
    gradient.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
  }
}
