import * as THREE from 'three'
import { GOLD_HI, U, pointMaterial, rand, smooth } from '../stage/primitives'
import type { Centerpiece, BuildContext } from './types'

const STARS = 26000

/**
 * Galaxy — a barred spiral.
 *
 * The only centrepiece with no instrument rings of its own: it is the one that
 * reads as a wide field rather than an object, so the HUD stays off.
 */
export function buildGalaxy(ctx: BuildContext): Centerpiece {
  const group = new THREE.Group()
  group.position.y = ctx.height
  ctx.world.add(group)
  const { random, pixelRatio } = ctx

  const disc = new THREE.Group()
  disc.rotation.set(0.62, 0, 0.12)
  disc.scale.setScalar(1.2)
  group.add(disc)

  const geometry = new THREE.BufferGeometry()
  const position = new Float32Array(STARS * 3)
  const radius = new Float32Array(STARS)
  const angle = new Float32Array(STARS)
  const height = new Float32Array(STARS)
  const size = new Float32Array(STARS)
  const seed = new Float32Array(STARS)
  const color = new Float32Array(STARS * 3)

  const inner = new THREE.Color('#ffd9a0')
  const mid = new THREE.Color('#7f9dff')
  const outer = new THREE.Color('#a070ff')
  const c = new THREE.Color()

  for (let i = 0; i < STARS; i += 1) {
    const r = Math.pow(random(), 1.7) * 2.15 + 0.03
    const arm = Math.floor(random() * 3)
    const spread = Math.pow(random(), 3) * (random() < 0.5 ? -1 : 1) * (0.9 / (r + 0.4))
    radius[i] = r * (1 + (random() - 0.5) * 0.12)
    angle[i] = (arm / 3) * Math.PI * 2 + r * 2.5 + spread
    height[i] = (random() + random() + random() - 1.5) * 0.1 * Math.max(0.15, 1 - r / 1.2)
    size[i] = rand(random, 0.35, 1.0) * (r < 0.3 ? 1.6 : 1)
    seed[i] = random() * 100
    const k = Math.min(1, r / 2.1)
    c.copy(inner).lerp(mid, Math.min(1, k * 1.8)).lerp(outer, Math.max(0, k * 1.6 - 0.6)).multiplyScalar(0.34)
    color.set([c.r, c.g, c.b], i * 3)
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  for (const [name, array, itemSize] of [
    ['aR', radius, 1],
    ['aA', angle, 1],
    ['aY', height, 1],
    ['aSize', size, 1],
    ['aSeed', seed, 1],
    ['aColor', color, 3],
  ] as const) {
    geometry.setAttribute(name, new THREE.BufferAttribute(array as Float32Array, itemSize))
  }
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3)

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPR: { value: pixelRatio }, uScale: { value: 30 } },
    vertexShader: /* glsl */ `
      attribute float aR, aA, aY, aSize, aSeed; attribute vec3 aColor;
      uniform float uTime, uPR, uScale; varying vec3 vC; varying float vA;
      void main(){
        float ang = aA + uTime * 0.16 / (aR * 0.7 + 0.25);
        vec4 mv = modelViewMatrix * vec4(cos(ang) * aR, aY, sin(ang) * aR, 1.0);
        vC = aColor; vA = 0.7 + 0.3 * sin(uTime * 2.0 + aSeed);
        gl_PointSize = aSize * uPR * (uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d); a *= a;
        gl_FragColor = vec4(vC * a * vA, a * vA);
      }`,
  })
  disc.add(new THREE.Points(geometry, material))

  const core = pointMaterial(0.1, pixelRatio)
  disc.add(
    new THREE.Points(
      (() => {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
        g.setAttribute('aColor', new THREE.Float32BufferAttribute([1, 0.81, 0.54], 3))
        g.setAttribute('size', new THREE.Float32BufferAttribute([70], 1))
        g.setAttribute('phase', new THREE.Float32BufferAttribute([0], 1))
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1)
        return g
      })(),
      core,
    ),
  )

  const stars = pointMaterial(1, pixelRatio)
  const starSeeds: number[] = []
  for (let i = 0; i < 140; i += 1) {
    const r = rand(random, 0.4, 2.0)
    const a = random() * 6.28
    starSeeds.push(Math.cos(a) * r, (random() - 0.5) * 0.05, Math.sin(a) * r)
  }
  const starGeometry = new THREE.BufferGeometry()
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starSeeds, 3))
  starGeometry.setAttribute(
    'aColor',
    new THREE.Float32BufferAttribute(
      Array.from({ length: 140 }, () => [GOLD_HI.r * 0.8, GOLD_HI.g * 0.8, GOLD_HI.b * 0.8]).flat(),
      3,
    ),
  )
  starGeometry.setAttribute('size', new THREE.Float32BufferAttribute(Array.from({ length: 140 }, () => rand(random, 2.5, 5)), 1))
  starGeometry.setAttribute('phase', new THREE.Float32BufferAttribute(Array.from({ length: 140 }, () => random() * 6.28), 1))
  starGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3)
  const starCloud = new THREE.Points(starGeometry, stars)
  disc.add(starCloud)

  return {
    group,
    hud: false,
    labels: [
      ['STARS', (t) => `${(1.28 + t * 0.0004).toFixed(3)}M`],
      ['ARMS', (t) => `${3 + (Math.floor(t / 9) % 2)}`],
      ['EXPANSION', (t) => `+${(0.42 + Math.sin(t * 0.3) * 0.05).toFixed(2)}%/h`],
    ],
    update(t, _dt, _voice, activity) {
      U(material).uTime!.value = t
      U(stars).uTime!.value = t
      U(core).uTime!.value = t
      starCloud.rotation.y = t * 0.05
      group.rotation.y = Math.sin(t * 0.1) * 0.25
      group.scale.setScalar(1 + smooth(0, 1, activity) * 0.03)
    },
  }
}
