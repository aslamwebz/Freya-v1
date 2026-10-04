import * as THREE from 'three'

/**
 * Shared shader and random primitives for the presence stage.
 *
 * The stage is seeded: the same lattice, the same rings, the same constellation
 * on every launch. Freya's appearance is its identity, not a lottery.
 */

// Freya's accent is violet + cyan. These were the old gold pair; the gold is
// gone — ACCENT is the violet, ACCENT_HI its pale highlight.
export const ACCENT = new THREE.Color('#9b6bff')
export const ACCENT_HI = new THREE.Color('#d9c7ff')
export const BLUE = new THREE.Color('#3f96ff')
export const BLUE_HI = new THREE.Color('#bfe2ff')
export const CYAN = new THREE.Color('#7fdcff')

export function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const rand = (r: () => number, a: number, b: number) => a + r() * (b - a)

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Ashima simplex noise, injected into any shader that needs a field. */
export const SNOISE = /* glsl */ `
  vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85378472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g; vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx; vec3 x2 = x0 - i2 + C.yyy; vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857; vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z); vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy; vec4 y = y_ * ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0; vec4 s1 = floor(b1) * 2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x); vec3 p1 = vec3(a0.zw, h.y); vec3 p2 = vec3(a1.xy, h.z); vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0); m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }`

/** Additive, per-point size and colour, with a twinkle term. */
export function pointMaterial(twinkle = 1, pixelRatio = 1) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPR: { value: pixelRatio },
      uScale: { value: 30 },
      uTw: { value: twinkle },
      uGain: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float size; attribute float phase; attribute vec3 aColor;
      uniform float uTime, uPR, uScale, uTw; varying vec3 vC; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = mix(1.0, 0.55 + 0.45 * sin(uTime * 2.2 + phase), uTw);
        vC = aColor; vA = tw;
        gl_PointSize = size * uPR * (uScale / -mv.z) * (0.6 + 0.4 * tw);
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
}

export interface PointSeed {
  x: number
  y: number
  z: number
  c: THREE.Color
  s: number
}

export function pointCloud(list: PointSeed[], twinkle: number, pixelRatio: number) {
  const geometry = new THREE.BufferGeometry()
  const n = list.length
  const position = new Float32Array(n * 3)
  const color = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const phase = new Float32Array(n)
  const random = makeRandom(0x51a7e)
  list.forEach((p, i) => {
    position.set([p.x, p.y, p.z], i * 3)
    color.set([p.c.r, p.c.g, p.c.b], i * 3)
    size[i] = p.s
    phase[i] = random() * 6.28
  })
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  geometry.setAttribute('size', new THREE.BufferAttribute(size, 1))
  geometry.setAttribute('phase', new THREE.BufferAttribute(phase, 1))
  geometry.computeBoundingSphere()
  return new THREE.Points(geometry, pointMaterial(twinkle, pixelRatio))
}

export const lineMaterial = (color: string | number, opacity: number) =>
  new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })

export const flatMaterial = (color: string | number, opacity: number) =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

/** A fresnel-only shell: the silhouette glow that sells a holographic form. */
export function ghostMaterial(color: string, gain: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uGain: { value: gain } },
    vertexShader: /* glsl */ `
      varying vec3 vN, vV;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN, vV;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        gl_FragColor = vec4(uColor * f * uGain, 1.0);
      }`,
  })
}

export function lineGeometry(points: number[]) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return geometry
}

export function lineSegments(points: number[], material: THREE.Material) {
  return new THREE.LineSegments(lineGeometry(points), material)
}

/**
 * Typed access to a shader's uniform bag.
 *
 * `ShaderMaterial.uniforms` is an untyped dictionary, so writing
 * `material.uniforms.uTime.value` from TypeScript means either a cast at every
 * one of the ~40 write sites or nothing at all. One helper, one cast.
 */
export const U = (material: THREE.ShaderMaterial): Record<string, THREE.IUniform> =>
  material.uniforms as Record<string, THREE.IUniform>

/** Advance a point cloud's own clock. `pointCloud` owns the material, not us. */
export function tickPoints(points: THREE.Points, time: number): void {
  U(points.material as THREE.ShaderMaterial).uTime!.value = time
}
