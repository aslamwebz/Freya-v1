import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { ACCENT, ACCENT_HI, BLUE, BLUE_HI, CYAN, U, ghostMaterial, pointCloud, rand, smooth, type PointSeed } from '../stage/primitives'
import type { Centerpiece, BuildContext } from './types'
import type { BrainStyle } from '../labState'

const BRAIN_Y = 0.95
const BRAIN_SCALE = 1.55
const HEMI_CX = 0.225
const CORE_POINTS = 2200
const NODES = 420
const STEM = 900

/* ---------------------------------------------------------------- noise */

const PERM = new Uint8Array(512)
{
  const p = Array.from({ length: 256 }, (_, i) => i)
  let seed = 7
  const random = () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = p[i]!
    p[i] = p[j]!
    p[j] = swap
  }
  for (let i = 0; i < 512; i += 1) PERM[i] = p[i & 255]!
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const mix = (t: number, a: number, b: number) => a + (b - a) * t
const grad = (h: number, x: number, y: number, z: number) => {
  h &= 15
  const u = h < 8 ? x : y
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v)
}

function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255
  const Y = Math.floor(y) & 255
  const Z = Math.floor(z) & 255
  x -= Math.floor(x)
  y -= Math.floor(y)
  z -= Math.floor(z)
  const u = fade(x)
  const v = fade(y)
  const w = fade(z)
  const A = PERM[X]! + Y
  const AA = PERM[A & 511]! + Z
  const AB = PERM[(A + 1) & 511]! + Z
  const B = PERM[(X + 1) & 255]! + Y
  const BA = PERM[B & 511]! + Z
  const BB = PERM[(B + 1) & 511]! + Z
  return mix(
    w,
    mix(
      v,
      mix(u, grad(PERM[AA & 511]!, x, y, z), grad(PERM[BA & 511]!, x - 1, y, z)),
      mix(u, grad(PERM[AB & 511]!, x, y - 1, z), grad(PERM[BB & 511]!, x - 1, y - 1, z)),
    ),
    mix(
      v,
      mix(u, grad(PERM[(AA + 1) & 511]!, x, y, z - 1), grad(PERM[(BA + 1) & 511]!, x - 1, y, z - 1)),
      mix(u, grad(PERM[(AB + 1) & 511]!, x, y - 1, z - 1), grad(PERM[(BB + 1) & 511]!, x - 1, y - 1, z - 1)),
    ),
  )
}

/* -------------------------------------------------------------- shaping */

type Shaped = [number, number, number, number]

function shapeHemisphere(x: number, y: number, z: number, side: number): Shaped {
  const lx = x < 0 ? x * 0.3 : x
  const frontal = Math.max(0, z)
  let px = lx * 0.68 * (1 - 0.12 * frontal * frontal)
  let py = y * 0.8 * (1 - 0.15 * frontal * frontal)
  const pz = z * 1.12
  if (py < -0.22) py = -0.22 + (py + 0.22) * 0.55
  const temporal =
    Math.exp(-((z - 0.2) ** 2) / 0.1 - ((y + 0.45) ** 2) / 0.06) * Math.max(0, x)
  py -= temporal * 0.22
  px += temporal * 0.06
  px += HEMI_CX
  const X = px * side
  const fissure = py - (-0.12 - pz * 0.22)
  const groove =
    Math.exp(-(fissure * fissure) / 0.003) * smooth(0.25, 0.6, lx) * (pz > -0.5 && pz < 0.9 ? 1 : 0)
  const ridge =
    Math.abs(noise3(X * 3.6 + 7.1, py * 3.6, pz * 3.6)) + 0.4 * Math.abs(noise3(X * 7.5 + 3, py * 7.5, pz * 7.5))
  let fold = smooth(0.02, 0.2, ridge)
  const k = 1 + 0.045 * fold - 0.04 - 0.08 * groove
  fold *= 1 - groove
  return [(HEMI_CX + (px - HEMI_CX) * k) * side, py * k, pz * k, fold]
}

function shapeCerebellum(x: number, y: number, z: number): Shaped {
  const px = x * 0.6
  const py = y * 0.28
  const pz = z * 0.34
  const folia = 0.5 + 0.5 * Math.sin(py * 90 + noise3(px * 4, py * 4, pz * 4) * 3)
  const k = 1 + 0.035 * folia
  return [px * k, py * k - 0.46, pz * k - 0.74, smooth(0.25, 0.75, folia)]
}

function sculpt(detail: number, shape: (x: number, y: number, z: number) => Shaped): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail)
  geometry.deleteAttribute('normal')
  geometry.deleteAttribute('uv')
  geometry = mergeVertices(geometry)
  const position = geometry.attributes.position as THREE.BufferAttribute
  const fold = new Float32Array(position.count)
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i).normalize()
    const [x, y, z, f] = shape(v.x, v.y, v.z)
    position.setXYZ(i, x, y, z)
    fold[i] = f
  }
  geometry.setAttribute('fold', new THREE.BufferAttribute(fold, 1))
  geometry.computeVertexNormals()
  return geometry
}

/* --------------------------------------------------------------- build */

export interface Brain {
  group: THREE.Group
  styles: Record<BrainStyle, THREE.Group>
  hud: Centerpiece
  setStyle(style: BrainStyle): void
}

export function buildBrain(ctx: BuildContext): Brain {
  const { random, pixelRatio } = ctx
  const group = new THREE.Group()
  group.position.y = BRAIN_Y
  group.scale.setScalar(BRAIN_SCALE)
  ctx.world.add(group)

  const styles = {
    current: new THREE.Group(),
    slices: new THREE.Group(),
    flow: new THREE.Group(),
    glass: new THREE.Group(),
  }
  Object.values(styles).forEach((style) => group.add(style))

  const hemispheres = [1, -1].map((side) => sculpt(48, (x, y, z) => shapeHemisphere(x, y, z, side)))
  const cerebellum = sculpt(28, shapeCerebellum)
  const surfaces = [...hemispheres, cerebellum]

  const scanUniform = { value: 0 }

  const cortexMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScan: scanUniform,
      uBlue: { value: BLUE },
      uCyan: { value: CYAN },
      uAccent: { value: ACCENT },
    },
    vertexShader: /* glsl */ `
      attribute float fold; varying vec3 vN, vV, vW; varying float vFold;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        vec4 mv = viewMatrix * w;
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vFold = fold;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uScan; uniform vec3 uBlue, uCyan, uAccent;
      varying vec3 vN, vV, vW; varying float vFold;
      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
        float sulcus = 1.0 - smoothstep(0.0, 0.4, vFold);
        vec3 c = uBlue * (0.012 + 0.55 * fres) + uCyan * sulcus * (0.07 + 0.38 * fres);
        float scan = exp(-pow((vW.y - uScan) / 0.06, 2.0));
        c += (uCyan * 0.5 + uAccent * 0.4 * sulcus) * scan;
        c *= 0.8 + 0.2 * step(0.45, fract(vW.y * 55.0 - uTime * 0.6));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
  surfaces.forEach((geometry) => styles.current.add(new THREE.Mesh(geometry, cortexMaterial)))

  // Dust along the crests.
  const crest: PointSeed[] = []
  for (const geometry of surfaces) {
    const position = geometry.attributes.position as THREE.BufferAttribute
    const fold = geometry.attributes.fold as THREE.BufferAttribute
    for (let i = 0; i < position.count; i += 1) {
      if (fold.getX(i) > 0.7 && random() < 0.3) {
        crest.push({
          x: position.getX(i),
          y: position.getY(i),
          z: position.getZ(i),
          c: BLUE_HI.clone().lerp(CYAN, random()).multiplyScalar(0.28),
          s: rand(random, 0.35, 0.8),
        })
      }
    }
  }
  styles.current.add(pointCloud(crest, 0.5, pixelRatio))

  const inside = (min: number, max: number) => {
    const side = random() < 0.5 ? 0 : 1
    const geometry = hemispheres[side]!
    const position = geometry.attributes.position as THREE.BufferAttribute
    const i = Math.floor(random() * position.count)
    const centre = HEMI_CX * (side ? -1 : 1)
    const scale = rand(random, min, max)
    return new THREE.Vector3(
      centre + (position.getX(i) - centre) * scale,
      position.getY(i) * scale,
      position.getZ(i) * scale,
    )
  }

  const core: PointSeed[] = []
  for (let i = 0; i < CORE_POINTS; i += 1) {
    const v = inside(0.1, 0.85)
    core.push({
      x: v.x,
      y: v.y,
      z: v.z,
      c: ACCENT.clone().lerp(BLUE, random() * 0.5).multiplyScalar(0.3),
      s: rand(random, 0.5, 1.2),
    })
  }
  group.add(pointCloud(core, 0.5, pixelRatio))

  // Neural network: violet nodes, connections carrying light pulses.
  const nodes: PointSeed[] = []
  for (let i = 0; i < NODES; i += 1) {
    const v = inside(0.45, 1.0)
    nodes.push({
      x: v.x,
      y: v.y,
      z: v.z,
      c: ACCENT.clone().lerp(ACCENT_HI, random() * 0.7),
      s: rand(random, 1.4, 3.8),
    })
  }
  const nodeCloud = pointCloud(nodes, 1, pixelRatio)
  group.add(nodeCloud)

  const netPositions: number[] = []
  const netT: number[] = []
  const netSeed: number[] = []
  nodes.forEach((a, i) => {
    const va = new THREE.Vector3(a.x, a.y, a.z)
    nodes
      .map((b, j) => {
        const vb = new THREE.Vector3(b.x, b.y, b.z)
        return { j, d: va.distanceTo(vb) }
      })
      .filter((candidate) => candidate.j > i && candidate.d < 0.36)
      .sort((p, q) => p.d - q.d)
      .slice(0, 3)
      .forEach((candidate) => {
        const b = nodes[candidate.j]!
        const s = random() * 10
        netPositions.push(a.x, a.y, a.z, b.x, b.y, b.z)
        netT.push(0, 1)
        netSeed.push(s, s)
      })
  })
  const netGeometry = new THREE.BufferGeometry()
  netGeometry.setAttribute('position', new THREE.Float32BufferAttribute(netPositions, 3))
  netGeometry.setAttribute('aT', new THREE.Float32BufferAttribute(netT, 1))
  netGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(netSeed, 1))
  const netMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uBase: { value: new THREE.Color('#4b7fc4') },
      uPulse: { value: new THREE.Color(ACCENT_HI) },
    },
    vertexShader: /* glsl */ `
      attribute float aT, aSeed; varying float vT, vSeed;
      void main() { vT = aT; vSeed = aSeed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uBase, uPulse; varying float vT, vSeed;
      void main() {
        float speed = 0.25 + fract(vSeed * 3.7) * 0.5;
        float head = fract(uTime * speed + vSeed);
        float d = head - vT;
        float p = d > 0.0 ? exp(-d * d / 0.01) : 0.0;
        float on = step(0.45, fract(vSeed * 1.37));
        gl_FragColor = vec4(uBase * 0.09 + uPulse * p * on * 1.2, 1.0);
      }`,
  })
  const net = new THREE.LineSegments(netGeometry, netMaterial)
  group.add(net)

  /* ---- A · slices: the cortex cut into glowing horizontal contours ---- */

  function contours(geometry: THREE.BufferGeometry, levels: number, y0: number, y1: number) {
    const position = geometry.attributes.position as THREE.BufferAttribute
    const fold = geometry.attributes.fold as THREE.BufferAttribute
    const index = geometry.index!
    const out: number[] = []
    const outFold: number[] = []
    const outLevel: number[] = []
    const step = (y1 - y0) / levels
    for (let t = 0; t < index.count; t += 3) {
      const tri = [index.getX(t), index.getX(t + 1), index.getX(t + 2)]
      const ys = tri.map((i) => position.getY(i))
      const lo = Math.ceil((Math.min(...ys) - y0) / step)
      const hi = Math.floor((Math.max(...ys) - y0) / step)
      for (let k = lo; k <= hi; k += 1) {
        const y = y0 + k * step
        const hits: number[][] = []
        for (let e = 0; e < 3; e += 1) {
          const a = tri[e]!
          const b = tri[(e + 1) % 3]!
          const ya = ys[e]!
          const yb = ys[(e + 1) % 3]!
          if ((ya - y) * (yb - y) < 0) {
            const f = (y - ya) / (yb - ya)
            hits.push([
              position.getX(a) + (position.getX(b) - position.getX(a)) * f,
              y,
              position.getZ(a) + (position.getZ(b) - position.getZ(a)) * f,
              fold.getX(a) + (fold.getX(b) - fold.getX(a)) * f,
            ])
          }
        }
        if (hits.length === 2) {
          for (const hit of hits) {
            out.push(hit[0]!, hit[1]!, hit[2]!)
            outFold.push(hit[3]!)
            outLevel.push(k)
          }
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
    g.setAttribute('fold', new THREE.Float32BufferAttribute(outFold, 1))
    g.setAttribute('aLevel', new THREE.Float32BufferAttribute(outLevel, 1))
    return g
  }

  const sliceMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScan: scanUniform,
      uCentre: { value: new THREE.Vector3(0, BRAIN_Y, 0) },
    },
    vertexShader: /* glsl */ `
      attribute float fold, aLevel; varying float vFold, vLevel; varying vec3 vW;
      void main() {
        vFold = fold; vLevel = aLevel;
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uScan; uniform vec3 uCentre; varying float vFold, vLevel; varying vec3 vW;
      void main() {
        float front = dot(normalize(vW - uCentre), normalize(cameraPosition - uCentre));
        float depth = 0.25 + 0.75 * smoothstep(-0.7, 0.7, front);
        float shimmer = 0.55 + 0.45 * sin(vLevel * 0.55 - uTime * 1.6);
        float crest = 0.55 + 0.45 * smoothstep(0.2, 0.9, vFold);
        vec3 accent = vec3(1.0, 0.68, 0.3);
        vec3 c = accent * 0.2 * shimmer * crest * depth * depth;
        float scan = exp(-pow((vW.y - uScan) / 0.07, 2.0));
        c += vec3(0.55, 0.85, 1.0) * scan * 1.3 * depth;
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
  for (const geometry of surfaces) {
    styles.slices.add(new THREE.LineSegments(contours(geometry, 40, -0.72, 0.82), sliceMaterial))
  }
  const sliceGhost = ghostMaterial('#9b6bff', 0.12)
  for (const geometry of surfaces) styles.slices.add(new THREE.Mesh(geometry, sliceGhost))

  /* ---- B · flow: particles streaming over the folded surface ---- */

  const TEXTURE_W = 384
  const TEXTURE_H = 192
  const BANDS = 3
  const bake = new Float32Array(TEXTURE_W * TEXTURE_H * BANDS * 4)
  const bandShapes = [
    (x: number, y: number, z: number) => shapeHemisphere(x, y, z, 1),
    (x: number, y: number, z: number) => shapeHemisphere(x, y, z, -1),
    shapeCerebellum,
  ]
  bandShapes.forEach((shape, band) => {
    for (let j = 0; j < TEXTURE_H; j += 1) {
      const phi = ((j + 0.5) / TEXTURE_H - 0.5) * Math.PI
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      for (let i = 0; i < TEXTURE_W; i += 1) {
        const theta = ((i + 0.5) / TEXTURE_W) * Math.PI * 2
        const [x, y, z] = shape(sp, cp * Math.sin(theta), cp * Math.cos(theta))
        bake.set([x!, y!, z!, 1], ((band * TEXTURE_H + j) * TEXTURE_W + i) * 4)
      }
    }
  })
  const positionTexture = new THREE.DataTexture(bake, TEXTURE_W, TEXTURE_H * BANDS, THREE.RGBAFormat, THREE.FloatType)
  positionTexture.magFilter = THREE.NearestFilter
  positionTexture.minFilter = THREE.NearestFilter
  positionTexture.wrapS = THREE.RepeatWrapping
  positionTexture.needsUpdate = true

  const FLOW = 26000
  const flowGeometry = new THREE.BufferGeometry()
  const uv = new Float32Array(FLOW * 2)
  const band = new Float32Array(FLOW)
  const speed = new Float32Array(FLOW)
  const fsize = new Float32Array(FLOW)
  const fseed = new Float32Array(FLOW)
  const fcolor = new Float32Array(FLOW * 3)
  for (let i = 0; i < FLOW; i += 1) {
    const r = random()
    band[i] = r < 0.44 ? 0 : r < 0.88 ? 1 : 2
    uv[i * 2] = random()
    uv[i * 2 + 1] = Math.asin(random() * 2 - 1) / Math.PI + 0.5
    speed[i] = rand(random, 0.012, 0.035) * (band[i] === 1 ? -1 : 1)
    fsize[i] = rand(random, 0.45, 1.15)
    fseed[i] = random() * 100
    const colour = random() < 0.06 ? ACCENT_HI.clone().multiplyScalar(0.8) : BLUE_HI.clone().lerp(CYAN, random() * 0.6).multiplyScalar(0.5)
    fcolor.set([colour.r, colour.g, colour.b], i * 3)
  }
  flowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLOW * 3), 3))
  flowGeometry.setAttribute('aUV', new THREE.BufferAttribute(uv, 2))
  flowGeometry.setAttribute('aBand', new THREE.BufferAttribute(band, 1))
  flowGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1))
  flowGeometry.setAttribute('aSize', new THREE.BufferAttribute(fsize, 1))
  flowGeometry.setAttribute('aSeed', new THREE.BufferAttribute(fseed, 1))
  flowGeometry.setAttribute('aColor', new THREE.BufferAttribute(fcolor, 3))
  flowGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3)

  const flowMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPR: { value: pixelRatio },
      uScale: { value: 30 },
      uPos: { value: positionTexture },
      uScan: scanUniform,
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uPos; uniform float uTime, uPR, uScale, uScan;
      attribute vec2 aUV; attribute float aBand, aSpeed, aSize, aSeed; attribute vec3 aColor;
      varying vec3 vC; varying float vA;
      void main() {
        float u = fract(aUV.x + uTime * aSpeed);
        float v = clamp(aUV.y + 0.012 * sin(u * 25.0 + uTime * 0.8 + aSeed), 0.002, 0.998);
        vec3 p = texture2D(uPos, vec2(u, (aBand + v) / 3.0)).xyz;
        vec4 w = modelMatrix * vec4(p, 1.0);
        vec4 mv = viewMatrix * w;
        float wave = pow(0.5 + 0.5 * sin(u * 42.0 - uTime * 2.4 + v * 9.0), 6.0);
        float scan = exp(-pow((w.y - uScan) / 0.07, 2.0));
        vA = 0.06 + 1.5 * wave + scan * 1.2;
        vC = mix(aColor, vec3(0.6, 0.9, 1.0), scan * 0.6);
        gl_PointSize = aSize * uPR * (uScale / -mv.z) * (0.7 + 0.6 * wave);
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
  styles.flow.add(new THREE.Points(flowGeometry, flowMaterial))
  const flowGhost = ghostMaterial('#3f96ff', 0.14)
  for (const geometry of surfaces) styles.flow.add(new THREE.Mesh(geometry, flowGhost))

  /* ---- C · glass: violet glass cortex, blue reserved for data ---- */

  const glassMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScan: scanUniform },
    vertexShader: /* glsl */ `
      attribute float fold; varying vec3 vN, vV, vW; varying float vFold;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        vec4 mv = viewMatrix * w;
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vFold = fold;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uScan; varying vec3 vN, vV, vW; varying float vFold;
      void main() {
        vec3 N = normalize(vN), V = normalize(vV);
        float fres = pow(1.0 - abs(dot(N, V)), 3.0);
        vec3 L = normalize(vec3(-0.45, 0.8, 0.55));
        float diff = max(dot(N, L), 0.0);
        float spec = pow(max(dot(N, normalize(L + V)), 0.0), 48.0);
        float gyrus = smoothstep(0.25, 1.0, vFold);
        vec3 accent = vec3(1.0, 0.6, 0.22);
        vec3 c = accent * (0.006 + 0.05 * diff * gyrus) + accent * fres * 0.32 + vec3(1.0, 0.88, 0.62) * spec * 0.55 * gyrus;
        float scan = exp(-pow((vW.y - uScan) / 0.06, 2.0));
        c += vec3(0.45, 0.8, 1.0) * scan * (0.35 + 0.5 * fres);
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
  for (const geometry of surfaces) styles.glass.add(new THREE.Mesh(geometry, glassMaterial))

  const STYLE_NET: Record<BrainStyle, [string, string]> = {
    current: ['#4b7fc4', '#d9c7ff'],
    slices: ['#2f2a52', '#d9c7ff'],
    flow: ['#3a6fb0', '#b79cff'],
    glass: ['#2a2450', '#bfe8ff'],
  }

  // Brain stem, descending into the beam.
  const stem: PointSeed[] = []
  for (let i = 0; i < STEM; i += 1) {
    const t = random()
    const a = random() * 6.28
    const r = 0.13 * (1 - t * 0.45) * Math.sqrt(random())
    stem.push({
      x: Math.cos(a) * r,
      y: -0.35 - t * 0.9,
      z: Math.sin(a) * r - 0.2,
      c: BLUE_HI.clone().lerp(ACCENT, random() * 0.4).multiplyScalar(0.4),
      s: rand(random, 0.5, 1.2),
    })
  }
  const stemCloud = pointCloud(stem, 0.6, pixelRatio)
  group.add(stemCloud)

  const hud: Centerpiece = {
    group,
    hud: true,
    labels: [
      ['NEURAL LOAD', (t, a) => `${Math.round(58 + a * 34 + Math.sin(t * 0.7) * 5)}%`],
      ['SYNAPTIC FLOW', (t) => `${(9.4 + Math.sin(t * 0.3) * 0.5).toFixed(1)}K /s`],
      ['LATENCY', (t) => `${(0.9 + Math.abs(Math.sin(t * 0.5)) * 0.4).toFixed(2)} ms`],
    ],
    update(t, _dt, voice) {
      // The brain is the fixed centre of the Presence. Motion belongs in its
      // scan/pulse materials and surrounding HUD, not in the whole brain object
      // itself. Keeping this transform stable prevents the middle from visibly
      // drifting even while the rest of the Presence remains alive.
      group.rotation.set(0, 0, 0)
      group.position.set(0, BRAIN_Y, 0)
      U(cortexMaterial).uTime!.value = t
      U(sliceMaterial).uTime!.value = t
      U(flowMaterial).uTime!.value = t
      U(glassMaterial).uTime!.value = t
      U(netMaterial).uTime!.value = t
      U(cortexMaterial).uCyan!.value.copy(CYAN).multiplyScalar(0.6 + Math.max(voice.user, voice.ai) * 0.6)
      scanUniform.value = BRAIN_Y + Math.sin(t * 0.6) * 1.05 * (0.4 + voice.morph)
    },
  }

  const brain: Brain = {
    group,
    styles,
    hud,
    setStyle(style: BrainStyle) {
      Object.entries(styles).forEach(([key, value]) => {
        value.visible = key === style
      })
      U(netMaterial).uBase!.value.set(STYLE_NET[style][0]!)
      U(netMaterial).uPulse!.value.set(STYLE_NET[style][1]!)
    },
  }
  return brain
}

export { BRAIN_Y, BRAIN_SCALE }
