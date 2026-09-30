import * as THREE from 'three'
import { SNOISE, U, lineMaterial, lineSegments, makeRandom, rand } from './primitives'

/**
 * The background instrument rings.
 *
 * They live on their own full-window canvas behind every panel, so they read as
 * true background: larger than the centre column, never tilting, and pinned to
 * the centrepiece's screen position.
 *
 * While Freya is speaking, the outermost ring erodes into particles that shake
 * with the voice; when it goes quiet the particles settle back into lines. The
 * line and the particles sample the same noise field, so the erosion is exact
 * rather than approximate.
 */
export class RingLayer {
  readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.OrthographicCamera
  private readonly rings = new THREE.Group()
  private readonly uniforms = {
    uTime: { value: 0 },
    uMorph: { value: 0 },
    uUser: { value: 0 },
    uAI: { value: 0 },
  }
  private readonly noMorph = { value: 0 }
  private dust: THREE.ShaderMaterial | null = null
  private readonly objects: { group: THREE.Group; speed: number }[] = []
  private readonly centre = new THREE.Vector2()
  private pixelsPerUnit = 80
  private disposed = false

  /**
   * The ratio this layer renders and sizes its dust at.
   *
   * Held in one place because three things have to agree on it — the renderer's
   * drawing buffer, the canvas' CSS box and the `uPR` point-size uniform — and
   * when they disagree the dust is drawn at one resolution and scaled as if it
   * belonged to another. Capped lower than the stage's: a thousand points get
   * expensive fast and the rings are behind everything anyway.
   */
  private ratio(): number {
    return Math.min(window.devicePixelRatio || 1, 1.5)
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setClearColor(0x000000, 0)

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50)
    this.camera.position.z = 10
    this.rings.scale.setScalar(1.28)
    this.scene.add(this.rings)

    this.buildRing1()
    this.buildRing2()
    this.buildRing3(this.ratio())
    this.resize()
  }

  private arcMaterial(color: THREE.Color, radius: number, width: number, morph: { value: number } | null) {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uniforms.uTime,
        uMorph: morph ?? this.uniforms.uMorph,
        uColor: { value: color },
        uR: { value: radius },
        uW: { value: width },
        uDots: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader:
        SNOISE +
        /* glsl */ `
        uniform float uTime, uMorph, uR, uW, uDots; uniform vec3 uColor; varying vec2 vP;
        float erodeField(float ang, float rr) {
          return snoise(vec3(cos(ang) * 6.0, sin(ang) * 6.0, rr * 30.0 + uTime * 0.4)) * 0.45 + 0.5;
        }
        void main() {
          float r = length(vP), ang = atan(vP.y, vP.x);
          float across = 1.0 - abs(r - uR) / (uW * 0.5);
          float core = 0.5 + 0.5 * smoothstep(0.1, 0.9, across);
          float keep = smoothstep(uMorph - 0.06, uMorph + 0.06, erodeField(ang, r));
          float a = keep * smoothstep(0.0, 0.3, across);
          if (uDots > 0.0) a *= step(0.55, fract(ang / 6.2831853 * uDots));
          gl_FragColor = vec4(uColor * core * a, a);
        }`,
    })
  }

  private addRing(speed: number, build: (group: THREE.Group) => void): void {
    const group = new THREE.Group()
    build(group)
    this.rings.add(group)
    this.objects.push({ group, speed })
  }

  /** 1 — a white tick ring with a single red marker. */
  private buildRing1(): void {
    const radius = 2.1
    const solid = (color: THREE.Color, r: number, w: number) => this.arcMaterial(color, r, w, this.noMorph)
    this.addRing(0.03, (group) => {
      group.add(
        new THREE.Mesh(
          new THREE.RingGeometry(radius - 0.007, radius + 0.007, 192),
          solid(new THREE.Color('#dfe9f2').multiplyScalar(0.16), radius, 0.014),
        ),
      )
      const ticks: number[] = []
      for (let i = 0; i < 180; i += 1) {
        const a = (i / 180) * Math.PI * 2
        const l = i % 20 === 0 ? 0.07 : i % 5 === 0 ? 0.035 : 0.018
        ticks.push(
          Math.cos(a) * radius,
          Math.sin(a) * radius,
          0,
          Math.cos(a) * (radius + l),
          Math.sin(a) * (radius + l),
          0,
        )
      }
      group.add(lineSegments(ticks, lineMaterial('#dfe9f2', 0.14)))
      group.add(
        new THREE.Mesh(
          new THREE.RingGeometry(radius + 0.02, radius + 0.04, 12, 1, 0.9, 0.16),
          solid(new THREE.Color('#ff4b4b').multiplyScalar(0.5), radius + 0.03, 0.02),
        ),
      )
    })
  }

  /** 2 — broken light-blue arcs with a faint gradient band. */
  private buildRing2(): void {
    const radius = 2.42
    const width = 0.045
    const random = makeRandom(0x21ab)
    const solid = (color: THREE.Color, r: number, w: number) => this.arcMaterial(color, r, w, this.noMorph)
    const pieces = arcPieces(random)
    this.addRing(-0.02, (group) => {
      const line = solid(new THREE.Color('#5aa9d6').multiplyScalar(0.42), radius, width)
      for (const [start, length] of pieces) {
        group.add(
          new THREE.Mesh(
            new THREE.RingGeometry(radius - width / 2, radius + width / 2, Math.max(24, Math.round(length * 90)), 1, start, length),
            line,
          ),
        )
      }
      group.add(
        new THREE.Mesh(
          new THREE.RingGeometry(2.18, 2.34, 48, 1, 3.7, 0.75),
          new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: { uA0: { value: 3.7 }, uLen: { value: 0.75 } },
            vertexShader: /* glsl */ `
              varying vec2 vP;
              void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: /* glsl */ `
              uniform float uA0, uLen; varying vec2 vP;
              void main() {
                float k = mod(atan(vP.y, vP.x) - uA0 + 12.566371, 6.2831853) / uLen;
                float a = clamp(1.0 - k, 0.0, 1.0) * 0.1;
                gl_FragColor = vec4(vec3(0.35, 0.7, 0.9) * a, a);
              }`,
          }),
        ),
      )
    })
  }

  /** 3 — the dotted ring that dissolves while anyone is speaking. */
  private buildRing3(pixelRatio: number): void {
    const radius = 2.75
    const width = 0.012
    const color = new THREE.Color('#8fd3ff').multiplyScalar(0.5)
    const random = makeRandom(0x7a1c)
    this.addRing(0.012, (group) => {
      const line = this.arcMaterial(color, radius, width, null)
      U(line).uDots!.value = 420
      group.add(new THREE.Mesh(new THREE.RingGeometry(radius - width / 2, radius + width / 2, 384), line))

      const count = 1800
      const angle = new Float32Array(count)
      const offset = new Float32Array(count)
      const seed = new Float32Array(count)
      const size = new Float32Array(count)
      for (let i = 0; i < count; i += 1) {
        angle[i] = random() * Math.PI * 2
        offset[i] = (random() - 0.5) * width * 3
        seed[i] = random() * 100
        size[i] = rand(random, 0.5, 1.0)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
      geometry.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1))
      geometry.setAttribute('aOff', new THREE.BufferAttribute(offset, 1))
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
      geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4)

      const dust = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: this.uniforms.uTime,
          uMorph: this.uniforms.uMorph,
          uUser: this.uniforms.uUser,
          uAI: this.uniforms.uAI,
          uPR: { value: pixelRatio },
          uScale: { value: 10 },
          uColor: { value: color },
          uR: { value: radius },
          uRing: { value: 2 },
          uFreq: { value: 7 },
        },
        vertexShader:
          SNOISE +
          /* glsl */ `
          uniform float uTime, uMorph, uUser, uAI, uPR, uScale, uR, uRing, uFreq; uniform vec3 uColor;
          attribute float aAngle, aOff, aSeed, aSize; varying vec3 vC; varying float vA;
          float erodeField(float ang, float rr) {
            return snoise(vec3(cos(ang) * 6.0, sin(ang) * 6.0, rr * 30.0 + uTime * 0.4)) * 0.45 + 0.5;
          }
          void main() {
            float lvl = max(uUser, uAI);
            float ang = aAngle;
            float n = snoise(vec3(cos(ang) * 1.8 + uRing * 3.1, sin(ang) * 1.8, uTime * 1.7));
            float travel = sin(ang * uFreq - uTime * 7.0 + uRing * 1.7);
            // You: jagged noisy shaking. Freya: smooth waves running round the ring.
            float disp = uUser * 0.22 * n + uAI * 0.15 * travel * (0.65 + 0.35 * n);
            float jit = lvl * 0.05 * sin(uTime * 41.0 + aSeed * 17.0);
            float spray = lvl * lvl * 0.35 * pow(fract(aSeed * 7.13), 4.0);
            float r = uR + aOff + (disp + jit + spray) * uMorph;
            vec4 mv = modelViewMatrix * vec4(cos(ang) * r, sin(ang) * r, lvl * 0.12 * n * uMorph, 1.0);
            float show = 1.0 - smoothstep(uMorph - 0.06, uMorph + 0.06, erodeField(ang, uR + aOff));
            vec3 tint = mix(uColor, vec3(0.55, 0.85, 1.0) * 0.6, uUser * 0.4);
            vC = mix(tint, vec3(0.75), uAI * 0.35);
            vA = show * (0.7 + lvl * 0.6);
            gl_PointSize = aSize * uPR * (uScale / -mv.z) * show;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vC; varying float vA;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.0, d); a *= a;
            gl_FragColor = vec4(vC * a * vA, a * vA);
          }`,
      })
      this.dust = dust
      group.add(new THREE.Points(geometry, dust))
    })
  }

  /** Where the centrepiece is on screen, in CSS pixels. */
  setCentre(x: number, y: number, pixelsPerUnit: number): void {
    this.centre.set(x, y)
    this.pixelsPerUnit = pixelsPerUnit
  }

  resize(): void {
    // Re-read the ratio here for the same reason the stage does: this canvas is
    // window-sized, so it is the one most obviously stretched when the window
    // moves to a screen with a different scale factor. `uPR` sizes the dust
    // points in the same units, so it has to move with it or the dust is drawn
    // at the previous screen's resolution.
    const ratio = this.ratio()
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(window.innerWidth, window.innerHeight, false)
    if (this.dust) U(this.dust).uPR!.value = ratio
  }

  setVisible(visible: boolean): void {
    this.rings.visible = visible
  }

  update(time: number, delta: number, user: number, ai: number, morph: number): void {
    this.uniforms.uTime.value = time
    this.uniforms.uMorph.value = morph
    this.uniforms.uUser.value = user
    this.uniforms.uAI.value = ai
    const level = Math.max(user, ai)
    for (const { group, speed } of this.objects) {
      group.rotation.z += delta * speed * (1 + level * 4)
    }
  }

  render(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.camera.left = -this.centre.x / this.pixelsPerUnit
    this.camera.right = (w - this.centre.x) / this.pixelsPerUnit
    this.camera.top = this.centre.y / this.pixelsPerUnit
    this.camera.bottom = -(h - this.centre.y) / this.pixelsPerUnit
    this.camera.updateProjectionMatrix()
    if (this.dust) U(this.dust).uScale!.value = 10 * this.pixelsPerUnit * 0.014
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
    this.renderer.dispose()
  }
}

/** Three or four arcs of random length, with random gaps between them. */
function arcPieces(random: () => number): [number, number][] {
  const count = random() < 0.5 ? 3 : 4
  const cover = rand(random, 0.72, 0.88) * Math.PI * 2
  const widths = Array.from({ length: count }, () => rand(random, 0.35, 1.7))
  const widthTotal = widths.reduce((a, b) => a + b, 0)
  const gaps = Array.from({ length: count }, () => rand(random, 0.5, 1.5))
  const gapTotal = gaps.reduce((a, b) => a + b, 0)
  let a = random() * Math.PI * 2
  return widths.map((width, i) => {
    const length = (width / widthTotal) * cover
    const piece: [number, number] = [a, length]
    a += length + (gaps[i] ?? 0) / gapTotal * (Math.PI * 2 - cover)
    return piece
  })
}
