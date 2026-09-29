import * as THREE from 'three'
import { CYAN, BLUE_HI, U, flatMaterial, lineMaterial, lineSegments, pointCloud, rand, type PointSeed } from '../stage/primitives'
import type { Centerpiece, BuildContext } from './types'

const BOLTS = 6
const BOLT_STEPS = 9

/**
 * Arc reactor — a contained core in a slotted housing.
 *
 * The electric arcs are regenerated a few times a second rather than per frame:
 * they are meant to look intermittent, and a new bolt list every frame is both
 * expensive and less convincing.
 */
export function buildReactor(ctx: BuildContext): Centerpiece {
  const group = new THREE.Group()
  group.position.y = ctx.height
  ctx.world.add(group)
  const { random, pixelRatio } = ctx

  const face = new THREE.Group()
  face.rotation.x = -0.12
  group.add(face)

  const coreMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN, vV;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLevel; varying vec3 vN, vV;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.4);
        vec3 c = mix(vec3(0.85, 0.97, 1.0) * 1.3, vec3(0.2, 0.6, 1.0), f) * (0.9 + 0.1 * sin(uTime * 9.0));
        gl_FragColor = vec4(c * (0.7 + uLevel * 0.8), 1.0);
      }`,
  })
  face.add(new THREE.Mesh(new THREE.SphereGeometry(0.24, 40, 24), coreMaterial))
  face.add(
    pointCloud(
      [
        { x: 0, y: 0, z: 0, c: CYAN.clone().multiplyScalar(0.7), s: 60 },
        { x: 0, y: 0, z: 0, c: new THREE.Color('#2f7cff').multiplyScalar(0.35), s: 130 },
      ],
      0.2,
      pixelRatio,
    ),
  )
  face.add(new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.022, 10, 96), flatMaterial('#c8f2ff', 0.85)))

  const coils = new THREE.Group()
  face.add(coils)
  for (let i = 0; i < 10; i += 1) {
    const start = (i / 10) * Math.PI * 2 + 0.06
    const geometry = new THREE.RingGeometry(0.52, 0.9, 6, 1, start, (Math.PI * 2) / 10 - 0.12)
    coils.add(new THREE.Mesh(geometry, flatMaterial('#3fb4ff', 0.2)))
    coils.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), lineMaterial('#bfeaff', 0.9)))
  }

  const housing = new THREE.Group()
  face.add(housing)
  housing.add(new THREE.Mesh(new THREE.RingGeometry(0.98, 1.02, 128), flatMaterial('#ffc46b', 0.75)))
  housing.add(facing(tickRing(1.08, 120, 0.035, '#ffc46b', 0.6)))

  const outerArcs = facing(arcsXY(1.3, 0.03, [[0.2, 1.2], [1.6, 0.4], [2.3, 1.7], [4.3, 0.5], [5.0, 1.0]], '#ffb450', 0.6))
  face.add(outerArcs)
  const outerThin = facing(arcsXY(1.4, 0.008, [[0, 2.8], [3.2, 2.7]], '#9fd8ff', 0.5))
  face.add(outerThin)

  const gyros = [0, 1, 2].map((i) => {
    const mesh = new THREE.Mesh(
      new THREE.TorusGeometry(1.55 + i * 0.06, 0.005, 6, 180),
      flatMaterial(i === 1 ? '#ffc46b' : '#6fc3ff', 0.45),
    )
    group.add(mesh)
    return mesh
  })

  const ringSeeds: PointSeed[] = []
  for (let i = 0; i < 1200; i += 1) {
    const a = random() * 6.28
    const r = 0.71 + (random() + random() - 1) * 0.16
    ringSeeds.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      z: (random() - 0.5) * 0.08,
      c: CYAN.clone().lerp(BLUE_HI, random()).multiplyScalar(0.5),
      s: rand(random, 0.4, 1.1),
    })
  }
  const ringPoints = pointCloud(ringSeeds, 1, pixelRatio)
  face.add(ringPoints)

  const boltPositions = new Float32Array(BOLTS * BOLT_STEPS * 6)
  const boltGeometry = new THREE.BufferGeometry()
  boltGeometry.setAttribute('position', new THREE.BufferAttribute(boltPositions, 3))
  boltGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2)
  face.add(new THREE.LineSegments(boltGeometry, lineMaterial('#e6f8ff', 0.95)))
  let nextArc = 0

  function strike(t: number): void {
    let offset = 0
    for (let b = 0; b < BOLTS; b += 1) {
      const a = random() * Math.PI * 2
      const inner = 0.25
      const outer = 0.5 + random() * 0.45
      let px = Math.cos(a) * inner
      let py = Math.sin(a) * inner
      for (let k = 1; k <= BOLT_STEPS; k += 1) {
        const f = k / BOLT_STEPS
        const r = inner + (outer - inner) * f
        const angle = a + (random() - 0.5) * 0.35 * Math.sin(f * Math.PI)
        const nx = Math.cos(angle) * r
        const ny = Math.sin(angle) * r
        boltPositions.set([px, py, 0.02, nx, ny, 0.02], offset)
        offset += 6
        px = nx
        py = ny
      }
    }
    boltGeometry.attributes.position!.needsUpdate = true
    nextArc = t + 0.08 + random() * 0.1
  }

  return {
    group,
    hud: false,
    labels: [
      ['CORE OUTPUT', (t, a) => `${(2.4 + a * 1.6 + Math.sin(t * 0.9) * 0.2).toFixed(2)} GJ/s`],
      ['FIELD STABILITY', (t) => `${(98.2 + Math.sin(t * 0.4) * 1.1).toFixed(1)}%`],
      ['CORE TEMP', (t) => `${Math.round(3200 + Math.sin(t * 0.6) * 60)} K`],
    ],
    update(t, _delta, levels) {
      U(coreMaterial).uTime!.value = t
      U(coreMaterial).uLevel!.value = Math.max(levels.user, levels.ai, 0.25)
      group.rotation.y = Math.sin(t * 0.3) * 0.5
      coils.rotation.z = t * 0.35
      ringPoints.rotation.z = -t * 0.9
      outerArcs.rotation.z = -t * 0.12
      outerThin.rotation.z = t * 0.05
      housing.rotation.z = t * 0.03
      gyros[0]!.rotation.set(t * 0.4, t * 0.2, 0)
      gyros[1]!.rotation.set(Math.PI / 2 + t * 0.25, 0, t * 0.3)
      gyros[2]!.rotation.set(t * 0.15, Math.PI / 3, -t * 0.35)
      if (t > nextArc) strike(t)
    },
  }
}

function facing<T extends THREE.Object3D>(object: T): T {
  object.rotation.x = Math.PI / 2
  return object
}

function arcsXY(radius: number, width: number, arcs: [number, number][], color: string, opacity: number) {
  const group = new THREE.Group()
  for (const [start, length] of arcs) {
    group.add(new THREE.Mesh(new THREE.RingGeometry(radius - width, radius, 72, 1, start, length), flatMaterial(color, opacity)))
  }
  return group
}

function tickRing(radius: number, count: number, length: number, color: string, opacity: number) {
  const points: number[] = []
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2
    const l = i % 10 === 0 ? length * 2.6 : i % 5 === 0 ? length * 1.6 : length
    points.push(Math.cos(a) * radius, 0, Math.sin(a) * radius, Math.cos(a) * (radius + l), 0, Math.sin(a) * (radius + l))
  }
  return lineSegments(points, lineMaterial(color, opacity))
}

export { tickRing, arcsXY, facing }
