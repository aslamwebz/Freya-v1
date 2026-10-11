import { readSources, buildGraph } from './source.mjs'
import { forbiddenEdge, sizeLimit } from './policy.mjs'
import { cyclicEdges } from './cycles.mjs'
import { dependencyBags } from './dependency-bags.mjs'

export const emptyBaseline = () => ({ version: 1, forbiddenEdges: [], cyclicEdges: [], dependencyBags: [], oversized: {} })

export function validateBaseline(baseline) {
  if (baseline.version !== 1) throw new Error('Unsupported architecture baseline version')
  for (const key of ['forbiddenEdges', 'cyclicEdges', 'dependencyBags']) {
    if (!Array.isArray(baseline[key]) || baseline[key].some(item => typeof item !== 'string') || new Set(baseline[key]).size !== baseline[key].length) throw new Error(`Invalid baseline ${key}`)
  }
  if (!baseline.oversized || typeof baseline.oversized !== 'object' || Array.isArray(baseline.oversized)) throw new Error('Invalid baseline oversized')
  for (const [file, entry] of Object.entries(baseline.oversized)) {
    if (!Number.isInteger(entry.ceiling) || entry.ceiling <= sizeLimit(file) || entry.limit !== sizeLimit(file) || !entry.reason) throw new Error(`Invalid size baseline: ${file}`)
    if (entry.retainInStrict && (!entry.hash || !/engine\.[cm]?[jt]s$/.test(file))) throw new Error(`Strict size exceptions require an unchanged documented engine: ${file}`)
  }
}

export function checkRepository(root, baseline = emptyBaseline(), { strict = false } = {}) {
  validateBaseline(baseline)
  const files = readSources(root)
  const graph = buildGraph(root, files)
  const forbidden = graph.edges.filter(forbiddenEdge).map(edge => edge.key)
  const cyclic = cyclicEdges(graph.edges)
  const bags = [...files.values()].flatMap(dependencyBags)
  const issues = graph.unresolved.map(message => ({ code: 'unresolved', message }))
  const exceptions = { forbiddenEdges: 0, cyclicEdges: 0, dependencyBags: 0, oversized: 0 }
  function enforce(items, baselineKey, code) {
    const allowed = new Set(strict ? [] : baseline[baselineKey])
    for (const key of items) {
      if (allowed.has(key)) exceptions[baselineKey]++
      else issues.push({ code, message: key })
    }
  }
  enforce(forbidden, 'forbiddenEdges', 'boundary')
  enforce(cyclic, 'cyclicEdges', 'cycle')
  enforce(bags.map(bag => bag.key), 'dependencyBags', 'dependency-bag')
  const oversized = {}
  for (const file of files.values()) {
    const limit = sizeLimit(file.name)
    if (file.lines <= limit) continue
    oversized[file.name] = { ceiling: file.lines, limit, hash: file.hash }
    const legacy = baseline.oversized[file.name]
    const allowed = legacy && file.lines <= legacy.ceiling && (!strict || (legacy.retainInStrict && legacy.hash === file.hash))
    if (allowed) exceptions.oversized++
    else issues.push({ code: 'size', message: `${file.name}: ${file.lines} substantive lines; ceiling ${legacy && !strict ? legacy.ceiling : limit}` })
  }
  return { issues, exceptions, observations: { files: files.size, edges: graph.edges.length, forbiddenEdges: forbidden, cyclicEdges: cyclic, dependencyBags: bags.map(bag => bag.key), oversized } }
}
