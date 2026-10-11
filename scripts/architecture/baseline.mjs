import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkRepository, emptyBaseline, validateBaseline } from './check.mjs'

export function ratchetBaseline(original, result) {
  validateBaseline(original)
  if (result.issues.length) throw new Error('Refusing to ratchet a failing architecture check')
  const next = { ...original, oversized: {} }
  for (const key of ['forbiddenEdges', 'cyclicEdges', 'dependencyBags']) {
    const allowed = new Set(original[key])
    if (result.observations[key].some(item => !allowed.has(item))) throw new Error(`Refusing new ${key} exceptions`)
    next[key] = [...result.observations[key]].sort()
  }
  for (const [file, entry] of Object.entries(result.observations.oversized)) {
    const previous = original.oversized[file]
    if (!previous || entry.ceiling > previous.ceiling) throw new Error(`Refusing increased size exception: ${file}`)
    // Never renew the "unchanged engine" fingerprint through a ratchet.
    next.oversized[file] = { ...previous, ceiling: entry.ceiling }
  }
  return next
}

export function captureBaseline(root, path) {
  if (existsSync(path)) throw new Error('Baseline already exists; use --ratchet, which cannot add exceptions')
  const result = checkRepository(root)
  if (result.issues.some(issue => issue.code === 'unresolved')) throw new Error('Cannot capture unresolved source edges')
  const baseline = emptyBaseline()
  for (const key of ['forbiddenEdges', 'cyclicEdges', 'dependencyBags']) baseline[key] = result.observations[key]
  for (const [file, entry] of Object.entries(result.observations.oversized)) {
    const engine = /(?:^|\/)engine\.[cm]?[jt]s$/.test(file)
    baseline.oversized[file] = { ...entry, retainInStrict: engine, reason: engine ? 'Existing engine: strict retention requires this exact unchanged source hash; explicitly ratchet shrinking ceilings.' : 'Transitional extraction exception: must shrink to the ordinary/assembly limit before strict mode.' }
  }
  validateBaseline(baseline)
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
  return baseline
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd()
  const path = resolve(root, 'architecture-baseline.json')
  try {
    const mode = process.argv.slice(2)
    if (mode.length !== 1 || !['--capture-once', '--ratchet'].includes(mode[0])) throw new Error('Usage: node scripts/architecture/baseline.mjs --capture-once | --ratchet')
    const baseline = mode[0] === '--capture-once' ? captureBaseline(root, path) : ratchetBaseline(JSON.parse(readFileSync(path, 'utf8')), checkRepository(root, JSON.parse(readFileSync(path, 'utf8'))))
    if (mode[0] === '--ratchet') writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log('Architecture baseline explicitly updated; review and version this diff.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
