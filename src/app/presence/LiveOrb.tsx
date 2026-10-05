import { memo, useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { BrainState } from './state'
import './live-orb.css'

type OrbShape = 'sphere' | 'vortex' | 'torus' | 'bloom'

export interface FreyaOrbSignal {
  readonly shape?: OrbShape
  readonly pulse?: number
  readonly primary?: string
  readonly secondary?: string
  readonly accent?: string
}

interface Props {
  readonly state: BrainState
  readonly energy?: number
}

interface VisualState {
  shape: OrbShape
  primary: string
  secondary: string
  accent: string
  speed: number
  turbulence: number
}

const SIGNAL_EVENT = 'freya:orb'

export function signalFreyaOrb(signal: FreyaOrbSignal): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<FreyaOrbSignal>(SIGNAL_EVENT, { detail: signal }))
}
const POINTS = 2600
const TAU = Math.PI * 2

const STATE: Record<BrainState, VisualState> = {
  calm: {
    shape: 'sphere',
    primary: '#70dcff',
    secondary: '#8d63ff',
    accent: '#ff71df',
    speed: 0.24,
    turbulence: 0.18,
  },
  thinking: {
    shape: 'vortex',
    primary: '#63c9ff',
    secondary: '#a85bff',
    accent: '#ff67d4',
    speed: 0.48,
    turbulence: 0.42,
  },
  researching: {
    shape: 'torus',
    primary: '#76e7ff',
    secondary: '#7569ff',
    accent: '#cf76ff',
    speed: 0.38,
    turbulence: 0.28,
  },
  delegating: {
    shape: 'bloom',
    primary: '#72d8ff',
    secondary: '#b465ff',
    accent: '#ff74d8',
    speed: 0.44,
    turbulence: 0.34,
  },
  load: {
    shape: 'vortex',
    primary: '#5fc9ff',
    secondary: '#c052ff',
    accent: '#ff5fcf',
    speed: 0.72,
    turbulence: 0.62,
  },
  success: {
    shape: 'bloom',
    primary: '#a6efff',
    secondary: '#9273ff',
    accent: '#ff9be7',
    speed: 0.34,
    turbulence: 0.24,
  },
  uncertainty: {
    shape: 'sphere',
    primary: '#8e7dff',
    secondary: '#cf58ff',
    accent: '#ff63c4',
    speed: 0.56,
    turbulence: 0.5,
  },
}

const SHAPE_INDEX: Record<OrbShape, number> = {
  sphere: 0,
  torus: 1,
  vortex: 2,
  bloom: 3,
}

const vertexShader = `
  attribute vec3 aSphere;
  attribute vec3 aTorus;
  attribute vec3 aVortex;
  attribute vec3 aBloom;
  attribute float aSeed;

  uniform float uTime;
  uniform vec4 uShapeWeights;
  uniform float uTurbulence;
  uniform float uPulse;

  varying float vGlow;
  varying float vSeed;

  void main() {
    vec3 base =
      aSphere * uShapeWeights.x +
      aTorus * uShapeWeights.y +
      aVortex * uShapeWeights.z +
      aBloom * uShapeWeights.w;

    float wave =
      sin(base.x * 4.7 + uTime * 1.13 + aSeed * 9.0) *
      cos(base.y * 5.3 - uTime * .83 + aSeed * 4.0);

    vec3 dir = normalize(base + vec3(.0001));
    vec3 displaced = base + dir * wave * (.035 + uTurbulence * .09);
    displaced *= 1.0 + sin(uTime * .9 + aSeed * 6.2831) * .012 + uPulse * .07;

    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = (2.3 + 2.2 * uTurbulence + uPulse * 2.4) * (7.0 / max(1.0, -mvPosition.z));

    vGlow = .48 + .52 * sin(aSeed * 28.0 + uTime * 1.7);
    vSeed = aSeed;
  }
`

const fragmentShader = `
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;
  uniform float uPulse;

  varying float vGlow;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - .5;
    float d = length(uv);
    if (d > .5) discard;

    float soft = smoothstep(.5, .02, d);
    vec3 colour = mix(uPrimary, uSecondary, smoothstep(.15, .85, vSeed));
    colour = mix(colour, uAccent, max(0.0, vGlow - .72) * 1.35);
    float alpha = soft * (.26 + vGlow * .54 + uPulse * .18);

    gl_FragColor = vec4(colour, alpha);
  }
`

const shellVertexShader = `
  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const shellFragmentShader = `
  uniform float uTime;
  uniform float uTurbulence;
  uniform float uPulse;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;

  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), viewDir)), 2.6);
    float flow =
      sin(vPosition.x * 5.0 + uTime * .7) +
      sin(vPosition.y * 6.0 - uTime * .5) +
      sin((vPosition.z + vPosition.x) * 4.0 + uTime * .37);

    flow = flow / 3.0 * .5 + .5;
    vec3 inner = mix(uSecondary, uPrimary, flow);
    inner = mix(inner, uAccent, smoothstep(.73, 1.0, flow));

    float veins = smoothstep(.76, .98, sin((vPosition.x - vPosition.y + vPosition.z) * 12.0 + uTime * 1.1) * .5 + .5);
    vec3 colour = inner * (.26 + flow * .34) + uAccent * veins * (.12 + uTurbulence * .22);
    colour += mix(uPrimary, vec3(1.0), .35) * fresnel * (1.0 + uPulse * .7);

    float alpha = .055 + fresnel * .34 + veins * .055 + uPulse * .035;
    gl_FragColor = vec4(colour, alpha);
  }
`

function fibonacciPoint(index: number, total: number): THREE.Vector3 {
  const y = 1 - (index / Math.max(1, total - 1)) * 2
  const radius = Math.sqrt(Math.max(0, 1 - y * y))
  const theta = Math.PI * (3 - Math.sqrt(5)) * index
  return new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius)
}

function writePoint(array: Float32Array, index: number, point: THREE.Vector3, scale = 1): void {
  const offset = index * 3
  array[offset] = point.x * scale
  array[offset + 1] = point.y * scale
  array[offset + 2] = point.z * scale
}

function buildParticleGeometry(): THREE.BufferGeometry {
  const sphere = new Float32Array(POINTS * 3)
  const torus = new Float32Array(POINTS * 3)
  const vortex = new Float32Array(POINTS * 3)
  const bloom = new Float32Array(POINTS * 3)
  const seeds = new Float32Array(POINTS)

  for (let i = 0; i < POINTS; i += 1) {
    const seed = (i * 0.618033988749895) % 1
    const p = fibonacciPoint(i, POINTS)
    writePoint(sphere, i, p, 1.23)

    const ring = (i / POINTS) * TAU * 17.0
    const tube = ((i * 37) % POINTS) / POINTS * TAU
    const major = 0.93 + Math.sin(seed * TAU * 3) * .06
    const minor = .28 + .05 * Math.sin(seed * TAU * 7)
    writePoint(
      torus,
      i,
      new THREE.Vector3(
        (major + minor * Math.cos(tube)) * Math.cos(ring),
        minor * Math.sin(tube),
        (major + minor * Math.cos(tube)) * Math.sin(ring),
      ),
      1.18,
    )

    const t = i / POINTS
    const arm = i % 5
    const angle = t * TAU * 9.0 + arm * (TAU / 5)
    const radius = .12 + Math.pow(t, .68) * 1.08
    const y = (seed - .5) * .9 + Math.sin(angle * .55) * .18
    writePoint(
      vortex,
      i,
      new THREE.Vector3(
        Math.cos(angle) * radius,
        y,
        Math.sin(angle) * radius,
      ),
      1.08,
    )

    const longitude = Math.atan2(p.z, p.x)
    const latitude = Math.asin(THREE.MathUtils.clamp(p.y, -1, 1))
    const petals = .82 + .3 * Math.sin(longitude * 5.0) * Math.cos(latitude * 3.0)
    const pinch = .86 + .14 * Math.cos(latitude * 6.0)
    writePoint(bloom, i, p, 1.2 * petals * pinch)

    seeds[i] = seed
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(sphere, 3))
  geometry.setAttribute('aSphere', new THREE.BufferAttribute(sphere, 3))
  geometry.setAttribute('aTorus', new THREE.BufferAttribute(torus, 3))
  geometry.setAttribute('aVortex', new THREE.BufferAttribute(vortex, 3))
  geometry.setAttribute('aBloom', new THREE.BufferAttribute(bloom, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  return geometry
}

function radialTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    gradient.addColorStop(0, 'rgba(176,116,255,.34)')
    gradient.addColorStop(.23, 'rgba(88,199,255,.19)')
    gradient.addColorStop(.56, 'rgba(102,76,255,.075)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 256, 256)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

function shapeWeights(shape: OrbShape): THREE.Vector4 {
  const weights = new THREE.Vector4(0, 0, 0, 0)
  weights.setComponent(SHAPE_INDEX[shape], 1)
  return weights
}

/**
 * New dashboard-only Freya orb.
 *
 * It deliberately does not use PresenceStage: other screens keep the existing
 * shared presence untouched while Home can evolve independently.
 *
 * Runtime systems may also signal it without coupling to React:
 * window.dispatchEvent(new CustomEvent('freya:orb', {
 *   detail: { shape: 'vortex', pulse: 1 }
 * }))
 */
export const LiveOrb = memo(function LiveOrb({ state, energy = 0 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef(state)
  const energyRef = useRef(energy)
  stateRef.current = state
  energyRef.current = energy

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, .1, 100)
    camera.position.set(0, 0, 5.2)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
    } catch {
      host.dataset.failed = 'true'
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.className = 'freya-live-orb-canvas'
    renderer.domElement.setAttribute('aria-hidden', 'true')
    host.appendChild(renderer.domElement)

    const root = new THREE.Group()
    scene.add(root)

    const haloMap = radialTexture()
    const haloMaterial = new THREE.SpriteMaterial({
      map: haloMap,
      color: 0x9a6dff,
      transparent: true,
      opacity: .75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const halo = new THREE.Sprite(haloMaterial)
    halo.scale.set(4.55, 4.55, 1)
    halo.position.z = -.7
    scene.add(halo)

    const geometry = buildParticleGeometry()
    const initial = STATE[stateRef.current]
    const uniforms = {
      uTime: { value: 0 },
      uShapeWeights: { value: shapeWeights(initial.shape) },
      uTurbulence: { value: initial.turbulence },
      uPulse: { value: 0 },
      uPrimary: { value: new THREE.Color(initial.primary) },
      uSecondary: { value: new THREE.Color(initial.secondary) },
      uAccent: { value: new THREE.Color(initial.accent) },
    }
    const particleMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const particles = new THREE.Points(geometry, particleMaterial)
    root.add(particles)

    const shellGeometry = new THREE.SphereGeometry(1.36, 72, 72)
    const shellUniforms = {
      uTime: { value: 0 },
      uTurbulence: { value: initial.turbulence },
      uPulse: { value: 0 },
      uPrimary: uniforms.uPrimary,
      uSecondary: uniforms.uSecondary,
      uAccent: uniforms.uAccent,
    }
    const shellMaterial = new THREE.ShaderMaterial({
      vertexShader: shellVertexShader,
      fragmentShader: shellFragmentShader,
      uniforms: shellUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    const shell = new THREE.Mesh(shellGeometry, shellMaterial)
    root.add(shell)

    const innerGeometry = new THREE.SphereGeometry(.62, 48, 48)
    const innerMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(initial.secondary),
      transparent: true,
      opacity: .055,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const inner = new THREE.Mesh(innerGeometry, innerMaterial)
    root.add(inner)

    const targetWeights = shapeWeights(initial.shape)
    const currentWeights = shapeWeights(initial.shape)
    const targetPrimary = new THREE.Color(initial.primary)
    const targetSecondary = new THREE.Color(initial.secondary)
    const targetAccent = new THREE.Color(initial.accent)
    let targetSpeed = initial.speed
    let targetTurbulence = initial.turbulence
    let pulse = stateRef.current === 'success' ? 1 : 0
    let customUntil = 0
    let previousState = stateRef.current
    let raf = 0
    let last = performance.now()
    let elapsed = 0
    let pointerX = 0
    let pointerY = 0

    const applyVisual = (visual: VisualState): void => {
      targetWeights.copy(shapeWeights(visual.shape))
      targetPrimary.set(visual.primary)
      targetSecondary.set(visual.secondary)
      targetAccent.set(visual.accent)
      targetSpeed = visual.speed
      targetTurbulence = visual.turbulence
    }

    const onSignal = (event: Event): void => {
      const detail = (event as CustomEvent<FreyaOrbSignal>).detail
      if (!detail) return
      const base = STATE[stateRef.current]
      const shape = detail.shape ?? base.shape
      targetWeights.copy(shapeWeights(shape))
      if (detail.primary) targetPrimary.set(detail.primary)
      if (detail.secondary) targetSecondary.set(detail.secondary)
      if (detail.accent) targetAccent.set(detail.accent)
      pulse = Math.max(pulse, THREE.MathUtils.clamp(detail.pulse ?? .7, 0, 1.5))
      customUntil = performance.now() + 2200
    }
    window.addEventListener(SIGNAL_EVENT, onSignal)

    const onPointer = (event: PointerEvent): void => {
      pointerX = (event.clientX / Math.max(1, window.innerWidth) - .5) * 2
      pointerY = (event.clientY / Math.max(1, window.innerHeight) - .5) * 2
    }
    window.addEventListener('pointermove', onPointer, { passive: true })

    const resize = (): void => {
      const rect = host.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(host)
    resize()

    const render = (now: number): void => {
      const dt = Math.min(.05, Math.max(.001, (now - last) / 1000))
      last = now
      elapsed += dt

      if (now >= customUntil && stateRef.current !== previousState) {
        previousState = stateRef.current
        applyVisual(STATE[previousState])
        pulse = Math.max(pulse, previousState === 'success' ? 1.2 : .42)
      } else if (now >= customUntil) {
        applyVisual(STATE[stateRef.current])
      }

      const visual = STATE[stateRef.current]
      const energyBoost = THREE.MathUtils.clamp(energyRef.current, 0, 1)
      currentWeights.lerp(targetWeights, 1 - Math.pow(.001, dt))
      uniforms.uShapeWeights.value.copy(currentWeights)

      uniforms.uPrimary.value.lerp(targetPrimary, 1 - Math.pow(.006, dt))
      uniforms.uSecondary.value.lerp(targetSecondary, 1 - Math.pow(.006, dt))
      uniforms.uAccent.value.lerp(targetAccent, 1 - Math.pow(.006, dt))
      uniforms.uTurbulence.value = THREE.MathUtils.lerp(uniforms.uTurbulence.value, targetTurbulence + energyBoost * .16, 1 - Math.pow(.01, dt))
      shellUniforms.uTurbulence.value = uniforms.uTurbulence.value

      pulse *= Math.pow(.12, dt)
      if (visual.shape === 'vortex') pulse = Math.max(pulse, energyBoost * .16)
      uniforms.uPulse.value = pulse
      shellUniforms.uPulse.value = pulse

      const speed = targetSpeed + energyBoost * .28
      uniforms.uTime.value = elapsed * (1 + speed)
      shellUniforms.uTime.value = elapsed * (1 + speed * .72)

      root.rotation.y += dt * (.08 + speed * .16)
      root.rotation.z = Math.sin(elapsed * .12) * .06
      root.rotation.x = THREE.MathUtils.lerp(root.rotation.x, pointerY * -.055, 1 - Math.pow(.02, dt))
      root.rotation.y += (pointerX * .045 - root.rotation.y * .008) * dt

      shell.scale.setScalar(1 + Math.sin(elapsed * .83) * .012 + pulse * .018)
      inner.scale.setScalar(1 + Math.sin(elapsed * 1.3) * .06 + pulse * .1)
      innerMaterial.color.lerp(uniforms.uSecondary.value, .035)
      innerMaterial.opacity = .045 + energyBoost * .025 + pulse * .035

      haloMaterial.color.lerp(uniforms.uSecondary.value, .018)
      haloMaterial.opacity = .62 + Math.sin(elapsed * .7) * .08 + energyBoost * .1


      renderer.render(scene, camera)
      raf = requestAnimationFrame(render)
    }

    if (reducedMotion) {
      currentWeights.copy(targetWeights)
      renderer.render(scene, camera)
    } else {
      raf = requestAnimationFrame(render)
    }

    return () => {
      cancelAnimationFrame(raf)
      observer?.disconnect()
      window.removeEventListener(SIGNAL_EVENT, onSignal)
      window.removeEventListener('pointermove', onPointer)
      geometry.dispose()
      particleMaterial.dispose()
      shellGeometry.dispose()
      shellMaterial.dispose()
      innerGeometry.dispose()
      innerMaterial.dispose()
      haloMap.dispose()
      haloMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div
      className="freya-live-orb"
      ref={hostRef}
      role="img"
      aria-label={`Freya live core — ${state}`}
      data-state={state}
    >
      <span className="freya-live-orb-fallback" aria-hidden="true" />
    </div>
  )
})
