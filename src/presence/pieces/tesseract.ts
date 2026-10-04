import * as THREE from 'three'
import {
  ACCENT,
  ACCENT_HI,
  flatMaterial,
  ghostMaterial,
  lineMaterial,
  pointCloud,
  rand,
  type PointSeed,
} from '../stage/primitives'
import type { Centerpiece, BuildContext } from './types'

/**
 * Tesseract — sixteen vertices projected from four dimensions.
 *
 * A deliberate change of key from the orb: no simplex displacement, just a
 * lattice rotating through an extra axis, held inside a faint shell.
 */
export function buildTesseract(ctx: BuildContext): Centerpiece {
  const group = new THREE.Group()
  group.position.y = ctx.height
  ctx.world.add(group)
  const { random, pixelRatio } = ctx

  const corners = Array.from({ length: 16 }, (_, i) => [
    i & 1 ? 1 : -1,
    i & 2 ? 1 : -1,
    i & 4 ? 1 : -1,
    i & 8 ? 1 : -1,
  ])

  const edges: [number, number][] = []
  for (let i = 0; i < 16; i += 1) {
    for (let j = i + 1; j < 16; j += 1) {
      const x = i ^ j
      if ((x & (x - 1)) === 0) edges.push([i, j])
    }
  }

  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true)
  const struts = edges.map(() => {
    const mesh = new THREE.Mesh(cylinder, flatMaterial('#b79cff', 0.8))
    group.add(mesh)
    return mesh
  })

  const vertexPoints = pointCloud(
    corners.map(() => ({ x: 0, y: 0, z: 0, c: ACCENT_HI.clone().multiplyScalar(0.9), s: 5 })),
    0.4,
    pixelRatio,
  )
  group.add(vertexPoints)
  const vertexAttribute = vertexPoints.geometry.attributes.position!

  const shell = new THREE.Group()
  group.add(shell)
  const ico = new THREE.IcosahedronGeometry(1.6, 0)
  shell.add(new THREE.LineSegments(new THREE.EdgesGeometry(ico), lineMaterial('#6fc3ff', 0.4)))
  shell.add(new THREE.Mesh(ico, ghostMaterial('#9b6bff', 0.25)))

  const octahedron = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.28, 0)),
    lineMaterial('#d9c7ff', 0.9),
  )
  group.add(octahedron)

  const dust: PointSeed[] = []
  for (let i = 0; i < 600; i += 1) {
    const u = random() * 2 - 1
    const th = random() * 6.28
    const r = Math.cbrt(random()) * 1.5
    const s2 = Math.sqrt(1 - u * u)
    dust.push({
      x: Math.cos(th) * s2 * r,
      y: u * r,
      z: Math.sin(th) * s2 * r,
      c: ACCENT.clone().multiplyScalar(0.4),
      s: rand(random, 0.4, 1.2),
    })
  }
  const dustCloud = pointCloud(dust, 1, pixelRatio)
  group.add(dustCloud)

  const up = new THREE.Vector3(0, 1, 0)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const d = new THREE.Vector3()
  const projected: number[][] = []

  function project(v: readonly number[], t: number): [number, number, number, number] {
    let [x = 0, y = 0, z = 0, w = 0] = v
    let c = Math.cos(t * 0.45)
    let s = Math.sin(t * 0.45)
    ;[x, w] = [x * c - w * s, x * s + w * c]
    c = Math.cos(t * 0.29)
    s = Math.sin(t * 0.29)
    ;[y, w] = [y * c - w * s, y * s + w * c]
    c = Math.cos(t * 0.17)
    s = Math.sin(t * 0.17)
    ;[z, w] = [z * c - w * s, z * s + w * c]
    const k = (1.5 / (3.2 - w)) * 0.72
    return [x * k, y * k, z * k, w]
  }

  return {
    group,
    hud: true,
    labels: [
      ['DIMENSIONS', () => '4D'],
      ['W-ROTATION', (t) => `${(((t * 0.45 * 57.3) % 360) + 360) % 360 | 0}°`],
      ['INTEGRITY', (t) => `${(99.1 + Math.sin(t) * 0.6).toFixed(1)}%`],
    ],
    update(t) {
      corners.forEach((corner, i) => {
        const next = project(corner, t)
        projected[i] = next
        vertexAttribute.setXYZ(i, next[0], next[1], next[2])
      })
      vertexAttribute.needsUpdate = true

      edges.forEach(([i, j], k) => {
        const p = projected[i]!
        const q = projected[j]!
        const [px = 0, py = 0, pz = 0, pw = 0] = p
        const [qx = 0, qy = 0, qz = 0, qw = 0] = q
        a.set(px, py, pz)
        b.set(qx, qy, qz)
        d.subVectors(b, a)
        const length = d.length()
        const mesh = struts[k]!
        mesh.position.addVectors(a, b).multiplyScalar(0.5)
        mesh.quaternion.setFromUnitVectors(up, d.normalize())
        mesh.scale.set(0.011, length, 0.011)
        mesh.material.opacity = 0.35 + 0.55 * ((pw + qw) / 4 + 0.5)
      })

      group.rotation.y = t * 0.12
      group.rotation.x = Math.sin(t * 0.2) * 0.2
      shell.rotation.y = -t * 0.18
      shell.rotation.z = t * 0.07
      octahedron.rotation.y = t * 1.2
      octahedron.rotation.x = t * 0.7
      dustCloud.rotation.y = -t * 0.05
    },
  }
}
