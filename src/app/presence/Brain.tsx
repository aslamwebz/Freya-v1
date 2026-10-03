import { useEffect, useRef, useState } from 'react'
import type * as ThreeTypes from 'three'
import type { BrainState } from './state'
import type { CentreStyle } from '../dressing/store'

/**
 * The Brain — Freya thinking.
 *
 * A luminous point lattice inside a few instrument rings, drawn with three.js.
 * It is the one constant of every screen: the CSS gives it a fixed, contained
 * box, so no panel, rail fold or screen switch can move or resize it.
 *
 * Motion is internal and state-driven (calm → load). Colours come from the active
 * theme's CSS tokens, so it recolours with the skin. No beam, no pedestal.
 *
 * If this machine gives no WebGL context, it renders a quiet still rather than a
 * broken or blank centre.
 */

const CONFIG: Record<BrainState, { spin: number; glow: number; core: 'cognition' | 'intelligence' | 'positive' | 'attention' }> = {
  calm: { spin: 0.04, glow: 0.35, core: 'cognition' },
  thinking: { spin: 0.5, glow: 0.85, core: 'cognition' },
  researching: { spin: 0.7, glow: 0.9, core: 'intelligence' },
  delegating: { spin: 0.35, glow: 0.7, core: 'cognition' },
  load: { spin: 1.1, glow: 1, core: 'intelligence' },
  success: { spin: 0.2, glow: 0.8, core: 'positive' },
  uncertainty: { spin: 0.3, glow: 0.6, core: 'attention' },
}

const FALLBACK = { cognition: '#b79cf0', intelligence: '#6fdcff', positive: '#5fe3bd', attention: '#f0b45c' }

function token(element: HTMLElement, name: keyof typeof FALLBACK): string {
  const value = getComputedStyle(element).getPropertyValue(
    name === 'intelligence' ? '--f-action' : name === 'positive' ? '--f-positive' : name === 'attention' ? '--f-attention' : '--f-cognition',
  ).trim()
  return value.length > 0 ? value : FALLBACK[name]
}

interface BrainHandle {
  setState(state: BrainState): void
}

export function Brain({ state, variant = 'lattice', rings = true }: { state: BrainState; variant?: CentreStyle; rings?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const handleRef = useRef<BrainHandle | null>(null)
  const stateRef = useRef<BrainState>(state)
  stateRef.current = state
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null

    const boot = async () => {
      try {
        const THREE = await import('three')
        const canvas = canvasRef.current
        if (disposed || canvas === null) return
        cleanup = build(THREE, canvas, stateRef, variant, rings, (handle) => {
          handleRef.current = handle
          handle.setState(stateRef.current)
        })
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error))
      }
    }
    void boot()
    return () => {
      disposed = true
      cleanup?.()
      cleanup = null
      handleRef.current = null
    }
  }, [variant, rings])

  useEffect(() => {
    handleRef.current?.setState(state)
  }, [state])

  return (
    <div className="a-brain">
      <canvas ref={canvasRef} className="a-centre-canvas" aria-label={`Freya cognition: ${state}`} role="img" />
      {failure !== null ? (
        <p className="a-brain-fallback" role="status">
          The Brain could not start on this machine ({failure}). The rest of Freya is unaffected.
        </p>
      ) : null}
    </div>
  )
}

function build(
  THREE: typeof ThreeTypes,
  canvas: HTMLCanvasElement,
  stateRef: { current: BrainState },
  variant: CentreStyle,
  rings: boolean,
  onReady: (handle: BrainHandle) => void,
): () => void {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
  camera.position.z = 5.2

  // A point distribution for the chosen style.
  const shellPositions = shellPoints(variant)
  const shellGeom = new THREE.BufferGeometry()
  shellGeom.setAttribute('position', new THREE.Float32BufferAttribute(shellPositions, 3))

  const corePositions: number[] = []
  for (let i = 0; i < 140; i += 1) {
    const u = Math.random() * 2 - 1
    const theta = Math.random() * Math.PI * 2
    const r = 0.28 * Math.cbrt(Math.random())
    const s = Math.sqrt(Math.max(0, 1 - u * u))
    corePositions.push(Math.cos(theta) * s * r, u * r, Math.sin(theta) * s * r)
  }
  const coreGeom = new THREE.BufferGeometry()
  coreGeom.setAttribute('position', new THREE.Float32BufferAttribute(corePositions, 3))

  const intelligenceColor = new THREE.Color(token(canvas, 'intelligence'))
  const cognitionColor = new THREE.Color(token(canvas, 'cognition'))
  const positiveColor = new THREE.Color(token(canvas, 'positive'))
  const attentionColor = new THREE.Color(token(canvas, 'attention'))
  const coreColors = { cognition: cognitionColor, intelligence: intelligenceColor, positive: positiveColor, attention: attentionColor }

  const shellMat = new THREE.PointsMaterial({ color: intelligenceColor, size: 0.03, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true })
  const coreMat = new THREE.PointsMaterial({ color: cognitionColor, size: 0.05, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true })
  const shell = new THREE.Points(shellGeom, shellMat)
  const core = new THREE.Points(coreGeom, coreMat)

  const lattice = new THREE.Group()
  lattice.add(shell, core)
  scene.add(lattice)

  const lineMat = (color: ThreeTypes.Color, opacity: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })

  // Instrument rings, facing the camera.
  const ringGroup = new THREE.Group()
  scene.add(ringGroup)

  const tickRing = (radius: number, count: number, len: number, color: ThreeTypes.Color, opacity: number) => {
    const points: number[] = []
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2
      const l = i % 10 === 0 ? len * 2.6 : i % 5 === 0 ? len * 1.6 : len
      points.push(Math.cos(a) * radius, Math.sin(a) * radius, 0, Math.cos(a) * (radius + l), Math.sin(a) * (radius + l), 0)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    return new THREE.LineSegments(g, lineMat(color, opacity))
  }
  const arc = (radius: number, start: number, length: number, color: ThreeTypes.Color, opacity: number, segments = 80) => {
    const points: number[] = []
    for (let i = 0; i <= segments; i += 1) {
      const a = start + (i / segments) * length
      points.push(Math.cos(a) * radius, Math.sin(a) * radius, 0)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    return new THREE.Line(g, lineMat(color, opacity))
  }

  ringGroup.add(tickRing(1.55, 150, 0.045, intelligenceColor, 0.5))
  if (rings) {
    ringGroup.add(arc(1.8, 0.2, 1.4, cognitionColor, 0.7))
    ringGroup.add(arc(1.8, 2.4, 0.9, cognitionColor, 0.5))
    ringGroup.add(arc(1.3, 3.4, 1.8, intelligenceColor, 0.45))
  }

  // Beacons orbiting the lattice.
  const beaconPositions = new Float32Array([0, 1.9, 0, 1.9, 0, 0, 0, -1.9, 0])
  const beaconGeom = new THREE.BufferGeometry()
  beaconGeom.setAttribute('position', new THREE.Float32BufferAttribute(beaconPositions, 3))
  const beacons = new THREE.Points(beaconGeom, new THREE.PointsMaterial({ color: cognitionColor, size: 0.09, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }))
  scene.add(beacons)

  let spin = CONFIG.calm.spin
  let glow = CONFIG.calm.glow
  let coreColor = cognitionColor

  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  resize()

  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const clock = new THREE.Clock()
  let raf = 0

  const renderFrame = (time: number) => {
    lattice.rotation.y = time * spin * 0.6
    lattice.rotation.x = Math.sin(time * 0.15) * 0.12
    beacons.rotation.z = time * 0.25
    ringGroup.rotation.z = -time * 0.05
    renderer.render(scene, camera)
  }

  const loop = () => {
    const time = clock.getElapsedTime()
    renderFrame(time)
    raf = requestAnimationFrame(loop)
  }

  const handle: BrainHandle = {
    setState(state: BrainState) {
      const config = CONFIG[state]
      spin = config.spin
      glow = config.glow
      coreColor = coreColors[config.core]
      const blend = 0.18 + glow * 0.4
      shellMat.opacity = 0.4 + glow * 0.5
      coreMat.opacity = 0.5 + glow * 0.5
      shellMat.color.copy(intelligenceColor).lerp(coreColor, 0.25)
      coreMat.color.copy(coreColor)
      ringGroup.children.forEach((child) => {
        const material = (child as ThreeTypes.Line).material as ThreeTypes.LineBasicMaterial
        material.opacity = Math.min(1, material.opacity * 0.4 + blend * 0.6)
      })
      if (reduced) renderFrame(0)
    },
  }

  onReady(handle)
  handle.setState(stateRef.current)
  if (!reduced) loop()

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { resize(); if (reduced) renderFrame(0) })
  observer?.observe(canvas)

  return () => {
    if (raf !== 0) cancelAnimationFrame(raf)
    observer?.disconnect()
    shellGeom.dispose(); coreGeom.dispose(); beaconGeom.dispose()
    shellMat.dispose(); coreMat.dispose(); (beacons.material as ThreeTypes.Material).dispose()
    renderer.dispose()
  }
}

/** The point distribution for a centre style. */
function shellPoints(variant: CentreStyle): number[] {
  const points: number[] = []
  if (variant === 'slices') {
    const bands = 14
    const per = 36
    for (let band = 0; band < bands; band += 1) {
      const y = -1 + (band / (bands - 1)) * 2
      const radius = Math.sqrt(Math.max(0, 1 - y * y)) * 0.98
      const phase = band * 0.7
      for (let i = 0; i < per; i += 1) {
        const angle = phase + (i / per) * Math.PI * 2
        points.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
      }
    }
    return points
  }
  if (variant === 'flow') {
    const n = 520
    for (let i = 0; i < n; i += 1) {
      const t = i / n
      const angle = t * Math.PI * 2 * 7
      const y = Math.sin(t * Math.PI * 2 * 3) * 0.55
      const shell = Math.sqrt(Math.max(0, 1 - y * y))
      const radius = (0.75 + 0.25 * Math.sin(t * Math.PI * 6)) * shell
      points.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
    }
    return points
  }
  const n = 480
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (i / (n - 1)) * 2
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const angle = i * golden
    const thickness = 0.92 + Math.random() * 0.16
    points.push(Math.cos(angle) * radius * thickness, y * thickness, Math.sin(angle) * radius * thickness)
  }
  return points
}
