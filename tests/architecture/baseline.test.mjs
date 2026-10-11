// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { captureBaseline, ratchetBaseline } from '../../scripts/architecture/baseline.mjs'
import { checkRepository } from '../../scripts/architecture/check.mjs'

const original = { version: 1, forbiddenEdges: ['electron/a.ts -> core/a.ts'], cyclicEdges: [], dependencyBags: [], oversized: { 'core/engine.ts': { ceiling: 650, limit: 600, reason: 'Existing unchanged engine', retainInStrict: true, hash: 'old' } } }
function result(overrides = {}) {
  return { issues: [], observations: { forbiddenEdges: [], cyclicEdges: [], dependencyBags: [], oversized: { 'core/engine.ts': { ceiling: 610, limit: 600, hash: 'new' } }, ...overrides } }
}
const roots = []
function repository(source) {
  const root = mkdtempSync(join(tmpdir(), 'architecture-baseline-'))
  roots.push(root)
  mkdirSync(join(root, 'core'))
  writeFileSync(join(root, 'core/engine.ts'), source)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('explicit baseline ratchet', () => {
  it('removes resolved exceptions and lowers ceilings', () => {
    const next = ratchetBaseline(original, result())
    expect(next.forbiddenEdges).toEqual([])
    expect(next.oversized['core/engine.ts'].ceiling).toBe(610)
    expect(next.oversized['core/engine.ts'].hash).toBe('old')
  })
  it('refuses new exceptions even if the caller forgot violation results', () => {
    expect(() => ratchetBaseline(original, result({ forbiddenEdges: ['freya/a.ts -> core/a.ts'] }))).toThrow()
    expect(() => ratchetBaseline(original, result({ oversized: { 'core/new.ts': { ceiling: 650, limit: 600 } } }))).toThrow()
    expect(() => ratchetBaseline(original, result({ oversized: { 'core/engine.ts': { ceiling: 651, limit: 600 } } }))).toThrow()
  })
  it('refuses updates when the actual checker reports a violation', () => {
    expect(() => ratchetBaseline(original, { ...result(), issues: [{ code: 'unresolved' }] })).toThrow()
  })
  it('captures only once and refuses to overwrite an existing baseline', () => {
    const root = repository('export const value = 1')
    const path = join(root, 'architecture-baseline.json')
    captureBaseline(root, path)
    const before = readFileSync(path, 'utf8')
    expect(() => captureBaseline(root, path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
  it('retains an unchanged existing engine in strict mode across line endings', () => {
    const source = Array.from({ length: 601 }, (_, i) => `export const v${i} = ${i}`).join('\n')
    const root = repository(source)
    const baseline = captureBaseline(root, join(root, 'architecture-baseline.json'))
    writeFileSync(join(root, 'core/engine.ts'), source.replaceAll('\n', '\r\n'))
    expect(checkRepository(root, baseline, { strict: true }).issues).toEqual([])
    writeFileSync(join(root, 'core/engine.ts'), source.replace('v0 = 0', 'v0 = 1'))
    expect(checkRepository(root, baseline, { strict: true }).issues.map(issue => issue.code)).toContain('size')
  })
  it('the actual command rejects violations and leaves the baseline byte-for-byte unchanged', () => {
    const root = repository('export const value = 1')
    const path = join(root, 'architecture-baseline.json')
    captureBaseline(root, path)
    const before = readFileSync(path, 'utf8')
    const script = fileURLToPath(new URL('../../scripts/check-architecture.mjs', import.meta.url))
    expect(spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' }).status).toBe(0)
    writeFileSync(join(root, 'core/engine.ts'), 'export function run(context: any) {}')
    const failure = spawnSync(process.execPath, [script, '--json'], { cwd: root, encoding: 'utf8' })
    expect(failure.status).toBe(1)
    expect(JSON.parse(failure.stdout).issues.map(issue => issue.code)).toContain('dependency-bag')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})
