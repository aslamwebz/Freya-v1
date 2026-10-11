// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkRepository } from '../../scripts/architecture/check.mjs'

const roots = []
const emptyBaseline = { version: 1, forbiddenEdges: [], cyclicEdges: [], dependencyBags: [], oversized: {} }
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'architecture-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return root
}
function codes(root, baseline = emptyBaseline, options = {}) {
  return checkRepository(root, baseline, options).issues.map(issue => issue.code)
}
const lines = count => Array.from({ length: count }, (_, i) => `export const value${i} = ${i}`).join('\n')
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('architecture gate on real source fixtures', () => {
  it('rejects cycles including import types and re-exports', () => {
    expect(codes(fixture({
      'core/a.ts': 'import type { B } from "./b"; export type A = B',
      'core/b.ts': 'export type { A as B } from "./a"',
    }))).toContain('cycle')
  })
  it('rejects implementation imports across component boundaries', () => {
    expect(codes(fixture({ 'freya/agent.ts': 'import { run } from "../core/engine"; run()', 'core/engine.ts': 'export const run = () => {}' }))).toContain('boundary')
  })
  it('rejects forbidden edges even from component entry points', () => {
    expect(codes(fixture({ 'core/main.ts': 'export { run } from "../freya/engine"', 'freya/engine.ts': 'export const run = () => {}' }))).toContain('boundary')
  })
  it('keeps shared a leaf including type imports', () => {
    expect(codes(fixture({ 'shared/types.ts': 'import type { A } from "../core/types"; export type B = A', 'core/types.ts': 'export type A = string' }))).toContain('boundary')
  })
  it('allows components to consume shared contracts', () => {
    expect(codes(fixture({ 'shared/types.ts': 'export type Id = string', 'freya/agent.ts': 'import type { Id } from "../shared/types"; export type Job = Id' }))).toEqual([])
  })
  it('rejects type imports from component implementation trees', () => {
    expect(codes(fixture({ 'freya/agent.ts': 'import type { DTO } from "../core/types"', 'core/types.ts': 'export type DTO = string' }))).toContain('boundary')
  })
  it('allows owned runtime composition and rejects foreign composition', () => {
    const files = { 'runtimes/core/index.ts': 'export { run } from "../../core/engine"', 'runtimes/freya/index.ts': 'export { run } from "../../freya/engine"', 'runtimes/superapp/index.ts': 'export { run } from "../../electron/engine"', 'core/engine.ts': 'export const run = 1', 'freya/engine.ts': 'export const run = 1', 'electron/engine.ts': 'export const run = 1' }
    expect(codes(fixture(files))).toEqual([])
    expect(codes(fixture({ ...files, 'runtimes/freya/index.ts': 'export { run } from "../../core/engine"' }))).toContain('boundary')
  })
  it('resolves JS extension mappings, dynamic imports and require calls', () => {
    expect(codes(fixture({ 'core/a.ts': 'export const b = import("./b.js")', 'core/b.ts': 'const a = require("./a"); export { a }' }))).toContain('cycle')
  })
  it('resolves import type expressions and import-equals require edges', () => {
    expect(codes(fixture({ 'core/a.ts': 'export type A = import("./b").B', 'core/b.ts': 'import a = require("./a"); export type B = typeof a' }))).toContain('cycle')
  })
  it('follows local source edges outside the initial component roots to find cycles', () => {
    expect(codes(fixture({ 'core/a.ts': 'export { b } from "../ports/b"', 'ports/b.ts': 'export { a as b } from "../core/a"' }))).toContain('cycle')
  })
  it('rejects new ordinary and assembly modules over their limits', () => {
    expect(codes(fixture({ 'core/engine.ts': lines(601) }))).toContain('size')
    expect(codes(fixture({ 'freya/assembly.ts': lines(251) }))).toContain('size')
  })
  it.each(['runtimes/core/index.ts', 'freya/assemble.ts', 'src/app/router.ts', 'freya/runtime/domains/work.ts', 'core/runtime/boot.ts', 'electron/app/windows.ts'])('limits composition file %s to 250 lines', path => {
    expect(codes(fixture({ [path]: lines(251) }))).toContain('size')
  })
  it('counts code lines rather than blank and comment-only lines', () => {
    expect(codes(fixture({ 'core/engine.ts': `${'/* explanation\nmore explanation */\n\n'.repeat(650)}${lines(600)}` }))).toEqual([])
  })
  it('counts template literal types and regex literals without consuming following comments', () => {
    const source = 'export type Principal = `agent:${string}`\n' + '// comment\n'.repeat(650) + 'export const pattern = /https?:\\/\\/example/\n' + lines(598)
    expect(codes(fixture({ 'core/engine.ts': source }))).toEqual([])
  })
  it('rejects growth of a legacy oversized file', () => {
    const baseline = { ...emptyBaseline, oversized: { 'core/engine.ts': { ceiling: 601, limit: 600, reason: 'legacy engine', retainInStrict: false } } }
    expect(codes(fixture({ 'core/engine.ts': lines(601) }), baseline)).toEqual([])
    expect(codes(fixture({ 'core/engine.ts': lines(602) }), baseline)).toContain('size')
  })
  it('allows exact legacy edges but rejects added edges and strict legacy exceptions', () => {
    const baseline = { ...emptyBaseline, forbiddenEdges: ['electron/host.ts -> core/engine.ts'] }
    const root = fixture({ 'electron/host.ts': 'export { run } from "../core/engine"', 'core/engine.ts': 'export const run = () => {}' })
    expect(codes(root, baseline)).toEqual([])
    expect(codes(root, baseline, { strict: true })).toContain('boundary')
    writeFileSync(join(root, 'electron/host.ts'), 'export { run } from "../core/engine"; export { other } from "../core/other"')
    writeFileSync(join(root, 'core/other.ts'), 'export const other = 1')
    expect(codes(root, baseline)).toContain('boundary')
  })
  it('rejects a newly cyclic baseline edge when only another edge was excepted', () => {
    const root = fixture({ 'core/a.ts': 'export { b } from "./b"', 'core/b.ts': 'export { a as b } from "./a"' })
    expect(codes(root, { ...emptyBaseline, cyclicEdges: ['core/a.ts -> core/b.ts'] })).toContain('cycle')
    expect(codes(root, { ...emptyBaseline, cyclicEdges: ['core/a.ts -> core/b.ts', 'core/b.ts -> core/a.ts'] })).toEqual([])
    expect(codes(root, { ...emptyBaseline, cyclicEdges: ['core/a.ts -> core/b.ts', 'core/b.ts -> core/a.ts'] }, { strict: true })).toContain('cycle')
  })
  it.each([
    'export function run(context: any) {}',
    'export function run(deps: Record<string, any>) {}',
    'export function run(context: Record<string, unknown>) {}',
    'interface RequestContext { [name: string]: unknown }; export function run(context: RequestContext) {}',
    'interface ServiceBag { [name: string]: any }; export function run(services: ServiceBag) {}',
    'interface ApplicationContext { model: ModelGateway; voice: VoiceService; tasks: TaskEngine }',
    'export function run(core: FreyaCore) {}',
    'type WholeSystem = FreyaCore; export function run(core: WholeSystem) {}',
    'export function run(core: Partial<FreyaCore>) {}',
    'export function run(core: Readonly<FreyaCore>) {}',
    'export function run(core: Pick<FreyaCore, keyof FreyaCore>) {}',
    'export function run(core: Pick<FreyaCore, "read">) {}',
  ])('rejects an obvious whole-system dependency container: %s', source => {
    expect(codes(fixture({ 'freya/agent.ts': source }))).toContain('dependency-bag')
  })
  it('allows explicit domain contexts and narrowed ports', () => {
    expect(codes(fixture({ 'freya/agent.ts': 'interface RequestContext { id: string; deadline: number; tags: string[] }; interface ReadPort { read(id: string): string }; export function run(context: RequestContext, port: ReadPort) {}' }))).toEqual([])
  })
  it('allows domain operation ports with several methods and callbacks', () => {
    expect(codes(fixture({ 'core/port.ts': 'interface MigrationContext { exec(sql: string): void; run(sql: string): void; get(sql: string): string; now(): Date }; interface GateDeps { record: () => void; fold: () => void; clock: () => number }' }))).toEqual([])
  })
})
