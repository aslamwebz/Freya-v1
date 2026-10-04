import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ACCENT_HI, U, flatMaterial, lineMaterial, lineSegments, makeRandom, pointCloud, type PointSeed } from './primitives'
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

/**
 * The device pixel ratio to render at, capped at 2.
 *
 * Read at every resize rather than once at construction. `devicePixelRatio` is a
 * property of the *screen*, not the window: dragging the window from a 125%
 * laptop panel to a 100% desktop changes it under us, and a renderer still
 * holding the old ratio sizes its drawing buffer for the old screen. The
 * canvas is then stretched by CSS across a box whose true backing store is a
 * different size — a soft, blurry orb, and a layout that is subtly wrong rather
 * than obviously broken.
 *
 * The cap is not a rounding concern. A 3x phone panel at full ratio is nine
 * times the fragments of a 1x desktop for a piece of ambient art, and nobody
 * can see the difference past 2x.
 */
function renderPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2)
}

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
  voice?: () => VoiceLevels
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
  private readonly gyro = new THREE.Group()
  private readonly beacons: THREE.Points
  private readonly beaconAttribute: THREE.BufferAttribute

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
      // The canvas has to be able to be *nothing*. Opaque black here paints a
      // dark rectangle over the atmosphere, because the canvas blends with
      // `screen` inside its own stacking context, where the atmosphere is not
      // the backdrop — so the "background" is the clear colour, not the space
      // behind it.
      alpha: true,
    })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(renderPixelRatio())
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1

    this.scene.add(this.world)
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.7, 0.45, 0.3)
    this.composer.addPass(this.bloom)
    // `premultipliedAlpha: false` and a transparent clear: without this the
    // output pass flattens the frame to opaque black and the rectangle is back.
    const output = new OutputPass()
    this.composer.addPass(output)

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


    this.beacons = this.buildBeacons(pixelRatio)
    this.beaconAttribute = this.beacons.geometry.attributes.position as THREE.BufferAttribute

    this.lab = { bg: 'space', piece: 'orb', style: 'current', rings: '1' }
    this.applyLab(this.lab)

  }

  /* ------------------------------------------------------------- pieces */

  private buildHud(): void {
    const equator = new THREE.Group()
    equator.rotation.x = 0.12
    this.hud.add(equator)

    const tickA = this.tickRing(2.08, 144, 0.04, '#7fcfff', 0.55)
    equator.add(tickA)
    this.hudSpin.push({ object: tickA, speed: 0.05 })

    const arcB = this.arcRing(2.32, 0.025, [[0, 1.4], [1.7, 0.5], [2.5, 2.1], [4.9, 0.9]], '#9b6bff', 0.7)
    equator.add(arcB)
    this.hudSpin.push({ object: arcB, speed: -0.09 })

    equator.add(this.circle(2.0, '#4fa6ff', 0.35))

    const arcD = this.arcRing(2.5, 0.008, [[0.3, 2.6], [3.3, 2.4]], '#9fd8ff', 0.5)
    equator.add(arcD)
    this.hudSpin.push({ object: arcD, speed: 0.03 })

    this.hud.add(this.gyro)
    const g1 = this.circle(2.0, '#4fa6ff', 0.25)
    g1.rotation.set(Math.PI / 2, 0, 0.5)
    this.gyro.add(g1)
    const g2 = this.tickRing(1.9, 96, 0.035, '#9b6bff', 0.3)
    g2.rotation.set(Math.PI / 2 - 0.4, 0.3, 0)
    this.gyro.add(g2)
  }

  private buildBeacons(pixelRatio: number): THREE.Points {
    const seeds: PointSeed[] = [0, 1, 2].map((i) => ({
      x: 0,
      y: 0,
      z: 0,
      c: (i === 1 ? ACCENT_HI : new THREE.Color('#bfe2ff')).clone(),
      s: 4.5,
    }))
    const beacons = pointCloud(seeds, 0.3, pixelRatio)
    this.hud.add(beacons)
    return beacons
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

    this.nextReadout = 0
    if (!this.running) this.draw(0)
  }

  setActivity(activity: number): void {
    this.activity = activity
  }

  resize(width: number, height: number): void {
    if (!width || !height) return
    // Before `setSize`, because the size is interpreted in CSS pixels and the
    // renderer multiplies by whatever ratio it is holding.
    this.renderer.setPixelRatio(renderPixelRatio())
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
    if (this.voiceSource) this.voice = this.voiceSource()

    for (const material of this.materials) {
      if (U(material).uTime) U(material).uTime!.value = time
    }

    for (const { object, speed } of this.hudSpin) object.rotation.y += speed * delta
    this.gyro.rotation.y = time * 0.15
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

    // Presence is anchored to the stage. Pointer movement belongs to the UI,
    // not to Freya's spatial identity: clicking or expanding the systems rail
    // must never tilt or shift the centerpiece relative to its rings.
    this.world.rotation.set(0, 0, 0)

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


