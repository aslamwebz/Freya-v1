import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { GOLD_HI, U, flatMaterial, lineMaterial, lineSegments, makeRandom, pointCloud, rand, type PointSeed } from './primitives'
import type { LabState, Piece } from '../labState'
import type { Centerpiece, Readout, VoiceLevels } from '../pieces/types'
import { buildBrain } from '../pieces/brain'
import { buildGalaxy } from '../pieces/galaxy'
import { buildOrb } from '../pieces/orb'
import { buildReactor } from '../pieces/reactor'
import { buildTesseract } from '../pieces/tesseract'

const SCENE_W = 5.2
const SCENE_H = 6.6
const SCENE_CY = 0.45
const CENTRE_Y = 0.95

export interface StageOptions {
  canvas: HTMLCanvasElement
  reducedMotion: boolean
  onLabels: (readouts: [string, string][]) => void
  /**
   * Called at the end of every frame, with the same clock the stage is using.
   * The background ring layer renders from here so the two canvases can never
   * drift apart and only one animation loop exists.
   */
  onFrame?: (time: number, delta: number) => void
  /** Sampled once per frame, so the voice envelope advances with the clock. */
  voice?: (time: number) => VoiceLevels
}

/**
 * The presence stage.
 *
 * One scene, one loop, five interchangeable centrepieces and the instrument
 * furniture that surrounds them. The stage owns how Freya looks; the shell owns
 * what Freya is doing and tells it through `setActivity` and the voice envelope.
 */
export class PresenceStage {
  private readonly renderer: THREE.WebGLRenderer
  private readonly composer: EffectComposer
  private readonly bloom: UnrealBloomPass
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly world = new THREE.Group()
  private readonly materials: THREE.ShaderMaterial[] = []

  private readonly hud = new THREE.Group()
  private readonly hudSpin: { object: THREE.Object3D; speed: number }[] = []
  private readonly scanner = new THREE.Group()
  private scannerTicks: THREE.Object3D | null = null
  private readonly beacons: THREE.Points
  private readonly beaconAttribute: THREE.BufferAttribute

  /** Shared by both beam shells, so the extras toggle dims the whole column. */
  private readonly beamGain = { value: 1 }
  private readonly strands: THREE.Object3D
  private readonly screens: THREE.Object3D[] = []
  private readonly swirls: THREE.Group
  private readonly pedestalSpinners: { object: THREE.Object3D; speed: number }[] = []
  private readonly sparkAttribute: THREE.BufferAttribute
  private readonly sparkSpeed: number[]
  private readonly sparkTop: number
  private readonly sparkFloor: number

  private readonly pieces: Record<Piece, Centerpiece>
  private readonly brain: ReturnType<typeof buildBrain>

  private readonly reducedMotion: boolean
  private readonly onLabels: StageOptions['onLabels']
  private readonly onFrame: StageOptions['onFrame']
  private readonly voiceSource: StageOptions['voice']

  private raf = 0
  private running = false
  private visible = true
  private clock = new THREE.Clock()
  private elapsed = 0
  private disposed = false
  private pointerX = 0
  private pointerY = 0
  private nextReadout = 0

  private voice: VoiceLevels = { user: 0, ai: 0, morph: 0 }
  private activity = 0
  private lab: LabState

  constructor(options: StageOptions) {
    this.reducedMotion = options.reducedMotion
    this.onLabels = options.onLabels
    this.onFrame = options.onFrame
    this.voiceSource = options.voice

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setClearColor(0x000000, 1)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1

    this.scene.add(this.world)
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.7, 0.45, 0.3)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    const random = makeRandom(0x5eed1e)
    const pixelRatio = this.renderer.getPixelRatio()
    const context = { world: this.world, height: CENTRE_Y, random, pixelRatio }

    this.brain = buildBrain(context)
    this.pieces = {
      brain: this.brain.hud,
      reactor: buildReactor(context),
      orb: buildOrb(context),
      tesseract: buildTesseract(context),
      galaxy: buildGalaxy(context),
    }

    this.hud.position.y = CENTRE_Y
    this.world.add(this.hud)
    this.buildHud()
    this.scanner.visible = false
    this.hud.add(this.scanner)

    const beam = this.buildBeam()
    this.strands = beam.strands
    this.screens.push(...beam.screens)
    this.swirls = beam.swirls
    const sparks = beam.sparks
    this.sparkAttribute = sparks.attribute
    this.sparkSpeed = sparks.speed
    this.sparkTop = sparks.top
    this.sparkFloor = sparks.floor

    this.beacons = this.buildBeacons(pixelRatio)
    this.beaconAttribute = this.beacons.geometry.attributes.position as THREE.BufferAttribute

    this.lab = { bg: 'space', piece: 'orb', style: 'current', clean: '0', rings: '1' }
    this.applyLab(this.lab)

    this.onPointerMove = this.onPointerMove.bind(this)
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
  }

  /* --------------------------------------------------------------- input */

  private onPointerMove(event: PointerEvent): void {
    this.pointerX = event.clientX / window.innerWidth - 0.5
    this.pointerY = event.clientY / window.innerHeight - 0.5
  }

  /* ------------------------------------------------------------- pieces */

  private buildHud(): void {
    const equator = new THREE.Group()
    equator.rotation.x = 0.12
    this.hud.add(equator)

    const tickA = this.tickRing(2.08, 144, 0.04, '#7fcfff', 0.55)
    equator.add(tickA)
    this.hudSpin.push({ object: tickA, speed: 0.05 })

    const arcB = this.arcRing(2.32, 0.025, [[0, 1.4], [1.7, 0.5], [2.5, 2.1], [4.9, 0.9]], '#ffc46b', 0.7)
    equator.add(arcB)
    this.hudSpin.push({ object: arcB, speed: -0.09 })

    equator.add(this.circle(2.0, '#4fa6ff', 0.35))

    const arcD = this.arcRing(2.5, 0.008, [[0.3, 2.6], [3.3, 2.4]], '#9fd8ff', 0.5)
    equator.add(arcD)
    this.hudSpin.push({ object: arcD, speed: 0.03 })

    const gyro = new THREE.Group()
    this.hud.add(gyro)
    const g1 = this.circle(2.0, '#4fa6ff', 0.25)
    g1.rotation.set(Math.PI / 2, 0, 0.5)
    gyro.add(g1)
    const g2 = this.tickRing(1.9, 96, 0.035, '#ffc46b', 0.3)
    g2.rotation.set(Math.PI / 2 - 0.4, 0.3, 0)
    gyro.add(g2)
    this.hud.add(gyro)
    this.hud.add(gyro)

    this.scanner.add(this.arcRing(1.7, 0.012, [[0, Math.PI * 2]], '#9fe4ff', 0.8))
    this.scannerTicks = this.tickRing(1.72, 72, 0.05, '#9fe4ff', 0.6)
    this.scanner.add(this.scannerTicks)
    this.scanner.add(
      new THREE.Mesh(
        new THREE.CircleGeometry(1.7, 72),
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              float d = length(vUv - 0.5) * 2.0;
              float a = smoothstep(0.55, 1.0, d) * (1.0 - smoothstep(0.97, 1.0, d)) * 0.35;
              gl_FragColor = vec4(vec3(0.45, 0.8, 1.0) * a, a);
            }`,
        }),
      ),
    )
  }

  private buildBeacons(pixelRatio: number): THREE.Points {
    const seeds: PointSeed[] = [0, 1, 2].map((i) => ({
      x: 0,
      y: 0,
      z: 0,
      c: (i === 1 ? GOLD_HI : new THREE.Color('#bfe2ff')).clone(),
      s: 4.5,
    }))
    const beacons = pointCloud(seeds, 0.3, pixelRatio)
    this.hud.add(beacons)
    return beacons
  }

  private buildBeam() {
    const pedestalY = -2.35
    const topY = 3.6
    const height = topY - pedestalY
    const beamMaterial = (color: THREE.Color, power: number) =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uColor: { value: color }, uTime: { value: 0 }, uGain: this.beamGain },
        vertexShader: /* glsl */ `
          varying vec2 vUv; varying float vF;
          void main() {
            vUv = uv; vec3 n = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vF = abs(dot(n, normalize(-mv.xyz)));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uTime, uGain; varying vec2 vUv; varying float vF;
          void main() {
            float h = pow(1.0 - vUv.y, 1.4) * smoothstep(0.0, 0.05, vUv.y);
            float flicker = 0.85 + 0.15 * sin(vUv.y * 40.0 - uTime * 6.0);
            float a = pow(vF, ${power.toFixed(1)}) * h * flicker;
            gl_FragColor = vec4(uColor * a * uGain, a);
          }`,
      })
    void height
    const outer = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.62, height, 40, 1, true),
      beamMaterial(new THREE.Color('#3f8dff').multiplyScalar(0.28), 2.5),
    )
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.13, height, 20, 1, true),
      beamMaterial(new THREE.Color('#e8f4ff').multiplyScalar(0.45), 1.0),
    )
    for (const mesh of [outer, core]) {
      mesh.position.y = pedestalY + height / 2
      this.materials.push(mesh.material as THREE.ShaderMaterial)
      this.world.add(mesh)
    }

    const random = makeRandom(0x5ead)
    const strandPoints: number[] = []
    const strandColours: number[] = []
    for (let i = 0; i < 48; i += 1) {
      const a = random() * 6.28
      const r = rand(random, 0.05, 0.6)
      const h = rand(random, 0.8, 2.6)
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      strandPoints.push(x, pedestalY, z, x * 0.7, pedestalY + h, z * 0.7)
      strandColours.push(1, 0.75, 0.4, 0.05, 0.12, 0.25)
    }
    const strandGeometry = new THREE.BufferGeometry()
    strandGeometry.setAttribute('position', new THREE.Float32BufferAttribute(strandPoints, 3))
    strandGeometry.setAttribute('color', new THREE.Float32BufferAttribute(strandColours, 3))
    const strands = new THREE.LineSegments(
      strandGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    this.world.add(strands)

    const sparkCount = 320
    const sparkSeeds: PointSeed[] = []
    const sparkSpeed: number[] = []
    for (let i = 0; i < sparkCount; i += 1) {
      const a = random() * 6.28
      const r = Math.pow(random(), 1.5) * 0.9
      sparkSeeds.push({
        x: Math.cos(a) * r,
        y: rand(random, pedestalY, topY),
        z: Math.sin(a) * r,
        c: (random() < 0.6 ? GOLD_HI : new THREE.Color('#bfe2ff')).clone().multiplyScalar(0.6),
        s: rand(random, 0.6, 1.5),
      })
      sparkSpeed.push(rand(random, 0.25, 0.9))
    }
    const sparks = pointCloud(sparkSeeds, 1, this.renderer.getPixelRatio())
    this.world.add(sparks)

    // Pedestal: stacked rings that give the composition a floor.
    const pedestal = new THREE.Group()
    pedestal.position.y = pedestalY
    this.world.add(pedestal)
    const discs: { radius: number; width: number; colour: string; opacity: number; y: number; dash?: number; spin?: number }[] = [
      { radius: 0.55, width: 0.05, colour: '#fff1d0', opacity: 0.9, y: 0.02 },
      { radius: 0.9, width: 0.02, colour: '#ffc46b', opacity: 0.8, y: 0, dash: 24, spin: 0.25 },
      { radius: 1.25, width: 0.035, colour: '#ffb450', opacity: 0.7, y: -0.02 },
      { radius: 1.55, width: 0.015, colour: '#ffd699', opacity: 0.6, y: -0.05, dash: 60, spin: -0.12 },
      { radius: 1.85, width: 0.05, colour: '#e0993f', opacity: 0.55, y: -0.18 },
      { radius: 2.15, width: 0.02, colour: '#ffc46b', opacity: 0.45, y: -0.34, dash: 8, spin: 0.06 },
      { radius: 2.35, width: 0.04, colour: '#c9822f', opacity: 0.35, y: -0.5 },
    ]
    for (const disc of discs) {
      const holder = new THREE.Group()
      const parts = disc.dash ?? 1
      const gap = disc.dash ? ((Math.PI * 2) / parts) * 0.35 : 0
      for (let k = 0; k < parts; k += 1) {
        const length = (Math.PI * 2) / parts - gap
        holder.add(
          new THREE.Mesh(
            new THREE.RingGeometry(disc.radius - disc.width, disc.radius, disc.dash ? 8 : 128, 1, k * (length + gap), length),
            flatMaterial(disc.colour, disc.opacity * 0.55),
          ),
        )
      }
      holder.rotation.x = -Math.PI / 2
      holder.position.y = disc.y
      pedestal.add(holder)
      if (disc.spin) this.pedestalSpinners.push({ object: holder, speed: disc.spin })
    }
    pedestal.add(
      new THREE.Mesh(
        new THREE.CircleGeometry(2.6, 48),
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              float d = length(vUv - 0.5) * 2.0;
              float a = pow(1.0 - clamp(d, 0.0, 1.0), 2.5);
              gl_FragColor = vec4(vec3(1.0, 0.72, 0.36) * a * 0.3, a);
            }`,
        }),
      ),
    )

    // Floating chart panels.
    for (const side of [-1, 1]) {
      const material = new THREE.MeshBasicMaterial({
        map: chartTexture(side < 0 ? 0 : 1),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.875), material)
      mesh.position.set(side * 2.0, CENTRE_Y - 1.75, 0.4)
      mesh.rotation.y = -side * 0.55
      this.world.add(mesh)
      this.screens.push(mesh)
    }

    // Gold and blue spiral swirls.
    const swirls = new THREE.Group()
    this.world.add(swirls)
    for (const [offset, colour, strength] of [
      [0, new THREE.Color('#ffbf62'), 1.0],
      [Math.PI, new THREE.Color('#3f96ff'), 0.8],
    ] as const) {
      const list: PointSeed[] = []
      for (let i = 0; i < 1100; i += 1) {
        const t = i / 1100
        const a = offset + t * Math.PI * 2 * 1.7
        const r = 1.75 + 0.6 * Math.sin(t * Math.PI)
        list.push({
          x: Math.cos(a) * r + rand(random, -0.03, 0.03),
          y: pedestalY + 0.4 + t * 4.1 + rand(random, -0.03, 0.03),
          z: Math.sin(a) * r * 0.85,
          c: colour.clone().multiplyScalar(0.95 * strength * (0.3 + 0.7 * Math.sin(t * Math.PI))),
          s: rand(random, 0.8, 2.0) * (0.4 + Math.sin(t * Math.PI)),
        })
      }
      swirls.add(pointCloud(list, 0.5, this.renderer.getPixelRatio()))
    }

    return {
      outer,
      core,
      strands,
      screens: this.screens,
      swirls,
      sparks: { attribute: sparks.geometry.attributes.position as THREE.BufferAttribute, speed: sparkSpeed, top: topY, floor: pedestalY },
    }
  }

  /* ------------------------------------------------------------ geometry */

  private tickRing(radius: number, count: number, length: number, colour: string, opacity: number) {
    const points: number[] = []
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2
      const l = i % 10 === 0 ? length * 2.6 : i % 5 === 0 ? length * 1.6 : length
      points.push(
        Math.cos(a) * radius,
        0,
        Math.sin(a) * radius,
        Math.cos(a) * (radius + l),
        0,
        Math.sin(a) * (radius + l),
      )
    }
    return lineSegments(points, lineMaterial(colour, opacity))
  }

  private arcRing(radius: number, width: number, arcs: [number, number][], colour: string, opacity: number) {
    const group = new THREE.Group()
    for (const [start, length] of arcs) {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(radius - width, radius, 72, 1, start, length), flatMaterial(colour, opacity))
      mesh.rotation.x = -Math.PI / 2
      group.add(mesh)
    }
    return group
  }

  private circle(radius: number, colour: string, opacity: number, segments = 128) {
    const points: number[] = []
    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2
      points.push(Math.cos(a) * radius, 0, Math.sin(a) * radius)
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)),
      lineMaterial(colour, opacity),
    )
  }

  /* ---------------------------------------------------------- public API */

  applyLab(lab: LabState): void {
    this.lab = lab
    for (const [key, piece] of Object.entries(this.pieces)) {
      piece.group.visible = key === lab.piece
    }
    this.brain.setStyle(lab.style)
    this.hud.visible = this.pieces[lab.piece].hud
    this.scanner.visible = lab.piece === 'brain'

    const clean = lab.clean === '1'
    this.swirls.visible = !clean
    for (const screen of this.screens) screen.visible = !clean
    this.strands.visible = !clean
    this.beamGain.value = clean ? 0.3 : 1

    this.nextReadout = 0
    if (!this.running) this.draw(0)
  }

  setActivity(activity: number): void {
    this.activity = activity
  }

  resize(width: number, height: number): void {
    if (!width || !height) return
    this.renderer.setSize(width, height, false)
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(width, height)
    this.camera.aspect = width / height
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const distance = Math.max(SCENE_H / 2 / tangent, SCENE_W / 2 / (tangent * this.camera.aspect)) + 1.5
    this.camera.position.set(0, SCENE_CY + 1.1, distance)
    this.camera.lookAt(0, SCENE_CY, 0)
    this.camera.updateProjectionMatrix()
    if (!this.running) this.draw(0)
  }

  /** Screen position of the centrepiece, for pinning the background rings. */
  centreOnScreen(element: DOMRect): { x: number; y: number; pixelsPerUnit: number } {
    this.world.updateMatrixWorld()
    const probe = new THREE.Vector3(0, CENTRE_Y, 0).project(this.camera)
    const x = element.left + (probe.x * 0.5 + 0.5) * element.width
    const y = element.top + (-probe.y * 0.5 + 0.5) * element.height
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const distance = this.camera.position.distanceTo(new THREE.Vector3(0, CENTRE_Y, 0))
    return { x, y, pixelsPerUnit: element.height / (2 * tangent * distance) }
  }

  /** Draw a single frame. Used for reduced motion and for the first paint. */
  renderOnce(): void {
    this.draw(0)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) this.start()
    else this.stop()
  }

  start(): void {
    if (this.running || this.disposed || this.reducedMotion || !this.visible) return
    this.running = true
    this.clock.getDelta()
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
    window.removeEventListener('pointermove', this.onPointerMove)
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
    })
    this.renderer.dispose()
  }

  /* ---------------------------------------------------------------- loop */

  private frame = (): void => {
    if (!this.running) return
    this.draw(Math.min(this.clock.getDelta(), 0.05))
    this.raf = requestAnimationFrame(this.frame)
  }

  private draw(delta: number): void {
    const t = this.clock.elapsedTime
    if (delta > 0) this.elapsed = t
    const time = this.elapsed
    if (this.voiceSource) this.voice = this.voiceSource(time)

    for (const material of this.materials) {
      if (U(material).uTime) U(material).uTime!.value = time
    }

    this.brain.hud.group.rotation.y = time * 0.2
    this.brain.hud.group.position.y = CENTRE_Y + Math.sin(time * 0.8) * 0.04

    const scanY = Math.sin(time * 0.6) * 1.05
    this.scanner.position.y = scanY
    this.scanner.scale.setScalar(0.75 + 0.25 * Math.cos((scanY / 1.05) * (Math.PI / 2)))
    if (this.scannerTicks) this.scannerTicks.rotation.y = time * 0.4
    const cortex = this.brain.hud
    void cortex

    for (const { object, speed } of this.hudSpin) object.rotation.y += speed * delta
    const gyro = this.hud.children.find((child) => child.children.some((c) => c.type === 'Line' && c.rotation.x !== 0))
    if (gyro) gyro.rotation.y = time * 0.15
    for (let i = 0; i < 3; i += 1) {
      const a = time * (0.5 + i * 0.17) + i * 2.1
      const r = 2.08 + i * 0.2
      this.beaconAttribute.setXYZ(i, Math.cos(a) * r, Math.sin(a * 1.3) * 0.25, Math.sin(a) * r)
    }
    this.beaconAttribute.needsUpdate = true

    this.pieces[this.lab.piece].update(time, delta, this.voice, this.activity)
    for (const piece of Object.values(this.pieces)) {
      if (piece.group.visible && piece !== this.pieces[this.lab.piece]) piece.update(time, delta, this.voice, this.activity)
    }

    this.swirls.rotation.y = time * 0.16
    for (const { object, speed } of this.pedestalSpinners) object.rotation.z += speed * delta
    for (let i = 0; i < this.sparkSpeed.length; i += 1) {
      let y = this.sparkAttribute.getY(i) + (this.sparkSpeed[i] ?? 0) * delta
      if (y > this.sparkTop) y = this.sparkFloor
      this.sparkAttribute.setY(i, y)
    }
    this.sparkAttribute.needsUpdate = true

    this.world.rotation.y += (this.pointerX * 0.3 - this.world.rotation.y) * 0.04
    this.world.rotation.x += (this.pointerY * 0.06 - this.world.rotation.x) * 0.04

    this.bloom.strength = 0.55 + this.activity * 0.4
    this.composer.render(delta)

    this.onFrame?.(time, delta)

    if (time >= this.nextReadout) {
      this.nextReadout = time + 0.8
      this.pushReadouts(time)
    }
  }

  private pushReadouts(time: number): void {
    const piece = this.pieces[this.lab.piece]
    this.onLabels(piece.labels.map(([label, value]: Readout) => [label, value(time, this.activity, this.voice)]))
  }

  /** Exposed so the shell can label the presence with the active piece's title. */
  get pieceTitle(): string {
    return this.lab.piece
  }
}


/** A small 2D chart, drawn once into a texture for the floating panels. */
function chartTexture(kind: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 320
  const g = canvas.getContext('2d')
  if (!g) return new THREE.CanvasTexture(canvas)
  g.strokeStyle = 'rgba(110,190,255,.9)'
  g.lineWidth = 3
  g.strokeRect(6, 6, 244, 308)
  g.fillStyle = 'rgba(40,110,220,.15)'
  g.fillRect(6, 6, 244, 308)
  g.fillStyle = 'rgba(150,210,255,.9)'
  if (kind === 0) {
    for (let i = 0; i < 26; i += 1) {
      const h = 30 + Math.abs(Math.sin(i * 1.3)) * 120 + (i % 5) * 8
      g.fillRect(20 + i * 8.5, 290 - h, 5, h)
    }
  } else {
    g.lineWidth = 3
    g.strokeStyle = 'rgba(150,210,255,.9)'
    g.beginPath()
    for (let i = 0; i <= 20; i += 1) {
      const x = 20 + i * 11
      const y = 200 - Math.sin(i * 0.6) * 50 - i * 4
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    }
    g.stroke()
    for (let r = 0; r < 6; r += 1) g.fillRect(20, 240 + r * 10, 60 + ((r * 37) % 140), 4)
  }
  for (let r = 0; r < 3; r += 1) g.fillRect(20, 24 + r * 12, 50 + r * 30, 5)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

