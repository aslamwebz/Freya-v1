/**
 * The presence lattice.
 *
 * A seeded, deterministic point field on a noise-displaced sphere, with edges
 * between near neighbours. Deterministic so the presence looks identical on
 * every launch — it is Freya's identity, not a random decoration.
 *
 * Generated once at construction, never per frame.
 */

export interface LatticeNode {
  x: number
  y: number
  z: number
  /** 0..1, how far this node sits from the core. */
  depth: number
  hue: 'core' | 'structure' | 'hub'
  phase: number
}

export interface LatticeEdge {
  a: number
  b: number
  depth: number
}

export interface Lattice {
  nodes: LatticeNode[]
  edges: LatticeEdge[]
}

/** Small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Cheap smooth 3D value noise, enough to fold a sphere into something organic. */
function makeNoise(rand: () => number) {
  const size = 16
  const table = new Float32Array(size * size * size)
  for (let i = 0; i < table.length; i += 1) table[i] = rand()
  // Indices are wrapped into range, so the read is always in bounds.
  const at = (x: number, y: number, z: number) =>
    table[
      (((x % size) + size) % size) * size * size +
        (((y % size) + size) % size) * size +
        (((z % size) + size) % size)
    ] ?? 0
  const fade = (t: number) => t * t * (3 - 2 * t)
  return (x: number, y: number, z: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const zi = Math.floor(z)
    const xf = fade(x - xi)
    const yf = fade(y - yi)
    const zf = fade(z - zi)
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t
    const c000 = at(xi, yi, zi)
    const c100 = at(xi + 1, yi, zi)
    const c010 = at(xi, yi + 1, zi)
    const c110 = at(xi + 1, yi + 1, zi)
    const c001 = at(xi, yi, zi + 1)
    const c101 = at(xi + 1, yi, zi + 1)
    const c011 = at(xi, yi + 1, zi + 1)
    const c111 = at(xi + 1, yi + 1, zi + 1)
    return lerp(
      lerp(lerp(c000, c100, xf), lerp(c010, c110, xf), yf),
      lerp(lerp(c001, c101, xf), lerp(c011, c111, xf), yf),
      zf,
    )
  }
}

export interface LatticeOptions {
  nodes: number
  /** Neighbour search radius in lattice units. */
  linkRadius: number
  maxLinksPerNode: number
  seed: number
  displacement: number
}

export const DEFAULT_LATTICE: LatticeOptions = {
  nodes: 380,
  linkRadius: 0.36,
  maxLinksPerNode: 3,
  seed: 0x5eed1e,
  displacement: 0.17,
}

export function buildLattice(options: LatticeOptions = DEFAULT_LATTICE): Lattice {
  const rand = mulberry32(options.seed)
  const noise = makeNoise(rand)
  const nodes: LatticeNode[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))

  for (let i = 0; i < options.nodes; i += 1) {
    // Fibonacci sphere: even coverage, no polar clustering.
    const t = i / (options.nodes - 1)
    const y = 1 - t * 2
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    const nx = Math.cos(theta) * radius
    const ny = y
    const nz = Math.sin(theta) * radius

    const fold =
      noise(nx * 2.1 + 3, ny * 2.1 + 7, nz * 2.1 + 11) * 0.7 +
      noise(nx * 5.3 + 1, ny * 5.3 + 5, nz * 5.3 + 2) * 0.3
    const r = 1 + (fold - 0.5) * 2 * options.displacement

    const depth = (ny + 1) / 2
    const roll = rand()
    const hue: LatticeNode['hue'] = roll > 0.955 ? 'hub' : roll > 0.34 ? 'structure' : 'core'

    nodes.push({
      x: nx * r,
      y: ny * r * 0.94,
      z: nz * r,
      depth,
      hue,
      phase: rand() * Math.PI * 2,
    })
  }

  // Edges: for each node, its nearest few neighbours. O(n²) once, not per frame.
  const edges: LatticeEdge[] = []
  const seen = new Set<number>()
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]
    if (!a) continue
    const candidates: { index: number; d: number }[] = []
    for (let j = 0; j < nodes.length; j += 1) {
      if (i === j) continue
      const b = nodes[j]
      if (!b) continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dz = a.z - b.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < options.linkRadius) candidates.push({ index: j, d })
    }
    candidates.sort((p, q) => p.d - q.d)
    for (const candidate of candidates.slice(0, options.maxLinksPerNode)) {
      const key = i < candidate.index ? i * 100000 + candidate.index : candidate.index * 100000 + i
      if (seen.has(key)) continue
      seen.add(key)
      const b = nodes[candidate.index]
      if (!b) continue
      edges.push({ a: i, b: candidate.index, depth: (a.depth + b.depth) / 2 })
    }
  }

  return { nodes, edges }
}
