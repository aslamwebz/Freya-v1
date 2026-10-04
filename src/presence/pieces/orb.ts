import * as THREE from 'three'
import { CYAN, ACCENT_HI, SNOISE, U, pointCloud, rand, type PointSeed } from '../stage/primitives'
import type { Centerpiece, BuildContext } from './types'

const VOICE_BARS = 128

/**
 * Liquid orb — Freya's default centrepiece.
 *
 * Two nested noise-displaced shells with an iridescent fresnel, a counter-rotating
 * halo, and an equatorial band of bars that rise and fall with the voice level.
 * The bars are what make it read as listening rather than merely decorative.
 */
export function buildOrb(ctx: BuildContext): Centerpiece {
  const group = new THREE.Group()
  group.position.y = ctx.height
  ctx.world.add(group)
  const { random, pixelRatio } = ctx

  const shellMaterial = (amp: number, hue: number, gain: number) =>
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAmp: { value: amp }, uHue: { value: hue }, uGain: { value: gain } },
      vertexShader:
        SNOISE +
        /* glsl */ `
        uniform float uTime, uAmp; varying vec3 vN, vV; varying float vD;
        float field(vec3 p){ return snoise(p * 1.5 + vec3(0.0, uTime * 0.35, 0.0)) * 0.7 + snoise(p * 3.1 - vec3(uTime * 0.22)) * 0.3; }
        vec3 displace(vec3 p){ vec3 n = normalize(p); return n * (1.0 + uAmp * field(n)); }
        void main(){
          vec3 n = normalize(position);
          vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 t2 = cross(n, t1);
          vec3 p = displace(n), p1 = displace(n + t1 * 0.01), p2 = displace(n + t2 * 0.01);
          vD = field(n);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * normalize(cross(p1 - p, p2 - p))); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uHue, uGain; varying vec3 vN, vV; varying float vD;
        vec3 pal(float t){ return 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + t)); }
        void main(){
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
          vec3 iri = pal(f * 0.7 + vD * 0.45 + uTime * 0.04 + uHue);
          vec3 base = mix(vec3(0.38, 0.2, 0.95), vec3(0.2, 0.85, 1.0), f);
          vec3 c = base * (0.03 + 0.8 * f) * mix(vec3(1.0), iri, 0.55);
          c += vec3(0.61, 0.42, 1.0) * pow(f, 7.0) * 0.5;
          gl_FragColor = vec4(c * uGain, 1.0);
        }`,
    })

  const outer = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 40), shellMaterial(0.2, 0.0, 1.0))
  outer.scale.setScalar(1.05)
  group.add(outer)

  const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 28), shellMaterial(0.35, 0.4, 0.8))
  inner.scale.setScalar(0.5)
  group.add(inner)

  group.add(
    pointCloud(
      [
        { x: 0, y: 0, z: 0, c: new THREE.Color('#9b6bff').multiplyScalar(0.3), s: 90 },
        { x: 0, y: 0, z: 0, c: ACCENT_HI.clone().multiplyScalar(0.5), s: 26 },
      ],
      0.3,
      pixelRatio,
    ),
  )

  // Equatorial voice bars.
  const positions: number[] = []
  const angles: number[] = []
  const ends: number[] = []
  for (let i = 0; i < VOICE_BARS; i += 1) {
    const a = (i / VOICE_BARS) * Math.PI * 2
    for (const e of [-1, 1]) {
      positions.push(Math.cos(a) * 1.62, 0, Math.sin(a) * 1.62)
      angles.push(a)
      ends.push(e)
    }
  }
  const barGeometry = new THREE.BufferGeometry()
  barGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  barGeometry.setAttribute('aAngle', new THREE.Float32BufferAttribute(angles, 1))
  barGeometry.setAttribute('aEnd', new THREE.Float32BufferAttribute(ends, 1))
  const barMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uSpk: { value: 0 } },
    vertexShader:
      SNOISE +
      /* glsl */ `
      uniform float uTime, uLevel, uSpk; attribute float aAngle, aEnd; varying float vE, vA;
      void main(){
        float h = 0.03 + 0.30 * pow(abs(snoise(vec3(cos(aAngle) * 1.5, sin(aAngle) * 1.5, uTime * 0.9))), 1.4);
        vec3 p = position; p.y = aEnd * h * (0.22 + uLevel * 1.5);
        vE = aEnd; vA = aAngle;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uLevel, uSpk; varying float vE, vA;
      void main(){
        vec3 c = mix(vec3(0.3, 0.85, 1.0), vec3(0.65, 0.4, 1.0), 0.5 + 0.5 * sin(vA * 2.0));
        c = mix(c, vec3(0.72, 0.55, 1.0), uSpk * 0.6);
        gl_FragColor = vec4(c * (0.2 + 0.8 * abs(vE)) * (0.45 + uLevel * 0.9), 1.0);
      }`,
  })
  const bars = new THREE.LineSegments(barGeometry, barMaterial)
  bars.rotation.x = 0.18
  group.add(bars)

  // Two counter-rotating halo shells.
  const halos = [0, 1].map((k) => {
    const list: PointSeed[] = []
    for (let i = 0; i < 1800; i += 1) {
      const u = random() * 2 - 1
      const th = random() * 6.28
      const r = rand(random, 1.25, 2.1)
      const s2 = Math.sqrt(1 - u * u)
      const color = (k ? new THREE.Color('#9b6bff') : CYAN).clone().multiplyScalar(0.35)
      list.push({
        x: Math.cos(th) * s2 * r,
        y: u * r * 0.8,
        z: Math.sin(th) * s2 * r,
        c: color,
        s: rand(random, 0.4, 1.2),
      })
    }
    const cloud = pointCloud(list, 1, pixelRatio)
    group.add(cloud)
    return cloud
  })

  return {
    group,
    hud: true,
    labels: [
      ['PRESENCE', (t, a) => `${Math.round(72 + a * 26 + Math.sin(t * 0.5) * 3)}%`],
      ['RESONANCE', (t) => `${(432 + Math.sin(t * 0.8) * 3).toFixed(1)} Hz`],
      ['LISTENING', (_t, _a, v) => (v.user > 0.2 ? 'ACTIVE' : v.ai > 0.2 ? 'REPLYING' : 'STANDBY')],
    ],
    update(t, _dt, levels, activity) {
      U(outer.material as THREE.ShaderMaterial).uTime!.value = t
      U(inner.material as THREE.ShaderMaterial).uTime!.value = t
      U(barMaterial).uTime!.value = t
      U(barMaterial).uLevel!.value = Math.max(levels.user, levels.ai)
      U(barMaterial).uSpk!.value = levels.ai
      outer.rotation.y = t * 0.08
      inner.rotation.y = -t * 0.2
      halos[0]!.rotation.y = t * 0.05
      halos[1]!.rotation.y = -t * 0.07
      bars.rotation.y = t * 0.1
      group.scale.setScalar(1 + activity * 0.02)
    },
  }
}

