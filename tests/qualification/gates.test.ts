import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GATE_IDS,
  GATE_KINDS,
  RELEASE_GATES,
  blockingPrerequisites,
  eligibleGates,
  gateById,
  isGateId,
  requiredGates,
} from '../../core/qualification'

/**
 * The gate catalogue has to be well-formed before any of it can be believed.
 *
 * A gate is a sentence plus a command plus a set of prerequisites. Each of those three
 * can rot in a way that is invisible at run time: a claim that cannot be falsified, a
 * command that no longer exists, a prerequisite that points at a gate nobody declared,
 * a dependency cycle that silently reorders the run. All four are checked here against
 * the actual repository rather than against a fixture, so deleting a test file or an
 * npm script is a failing test and not a permanently green gate.
 */

const root = resolve(__dirname, '../..')

const GATES_THE_PHASE_NAMES = [
  'typescript',
  'lint',
  'tests-unit-core',
  'tests-host',
  'tests-red-team',
  'e2e-electron',
  'release-policy',
  'extension-build',
  'startup-shutdown',
  'persistence-recovery',
  'stop-all',
  'provider-lifecycle-security',
  'runtime-activation-truth',
  'device-hands',
  'browser-extension',
] as const

describe('Phase 49 release gate catalogue', () => {
  it('declares a closed, unique set of gate ids', () => {
    expect(new Set(GATE_IDS).size).toBe(GATE_IDS.length)
    for (const declaration of RELEASE_GATES) expect(isGateId(declaration.id)).toBe(true)
    expect(RELEASE_GATES.map((declaration) => declaration.id).sort()).toEqual(
      [...GATE_IDS].sort(),
    )
  })

  it('covers every gate area the release decision rests on', () => {
    const declared = new Set(RELEASE_GATES.map((declaration) => declaration.id))
    for (const id of GATES_THE_PHASE_NAMES) expect(declared).toContain(id)
  })

  it('gives every gate a falsifiable claim rather than a slogan', () => {
    for (const declaration of RELEASE_GATES) {
      const claim = declaration.claim.trim()
      expect(claim.length).toBeGreaterThan(24)
      expect(claim.endsWith('.')).toBe(true)
      // A claim that cannot go false is not a gate. Each one here is phrased as a
      // property of the build that an executed command or an executed suite could
      // contradict.
      expect(claim.toLowerCase()).not.toMatch(/\b(works|is good|is fine|is ready|ok)\b/)
      expect(claim).not.toContain('should')
      expect(claim).not.toContain('hopefully')
    }
  })

  it('marks every gate required, so none can be quietly made optional', () => {
    for (const declaration of RELEASE_GATES) expect(declaration.required).toBe(true)
    expect(requiredGates()).toHaveLength(RELEASE_GATES.length)
  })

  it('declares a command for every gate, because a gate with no command measures nothing', () => {
    for (const declaration of RELEASE_GATES) expect(declaration.command).not.toBeNull()
  })

  it('uses only the two declared gate kinds', () => {
    for (const declaration of RELEASE_GATES) expect(GATE_KINDS).toContain(declaration.kind)
    expect(RELEASE_GATES.filter((declaration) => declaration.kind === 'command').length)
      .toBeGreaterThan(0)
    expect(RELEASE_GATES.filter((declaration) => declaration.kind === 'scenario').length)
      .toBeGreaterThan(0)
  })

  it('resolves every gate command to an npm script this repository actually declares', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const declaration of RELEASE_GATES) {
      const [program, , script] = declaration.command ?? []
      expect(program).toBe('npm')
      expect(script).toBeTruthy()
      expect(Object.keys(manifest.scripts)).toContain(String(script))
    }
  })

  it('points every scenario gate at a test file that exists', async () => {
    for (const declaration of RELEASE_GATES.filter((gate) => gate.kind === 'scenario')) {
      const script = String((declaration.command ?? [])[2])
      // `test:scenario:<name>` must name a real file under the qualification scenarios
      // directory. A scenario gate whose suite was deleted has to stop being a gate.
      const name = script.replace('test:scenario:', '')
      const path = resolve(root, 'tests/qualification/scenarios', `${name}.test.ts`)
      await expect(stat(path)).resolves.toBeDefined()
    }
  })

  it('declares prerequisites only from the closed gate set', () => {
    for (const declaration of RELEASE_GATES) {
      for (const id of declaration.requires) expect(isGateId(id)).toBe(true)
    }
  })

  it('has no dependency cycle, so the run order is always well defined', () => {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const walk = (id: string, trail: string[]): void => {
      if (visiting.has(id)) throw new Error(`gate cycle: ${[...trail, id].join(' -> ')}`)
      if (visited.has(id)) return
      visiting.add(id)
      for (const required of gateById(id as never).requires) walk(required, [...trail, id])
      visiting.delete(id)
      visited.add(id)
    }
    for (const declaration of RELEASE_GATES) walk(declaration.id, [])
    expect(visited.size).toBe(RELEASE_GATES.length)
  })

  it('puts the foundations first, so nothing downstream can hide behind them', () => {
    const requiresNothing = RELEASE_GATES.filter((declaration) => declaration.requires.length === 0)
    expect(new Set(requiresNothing.map((declaration) => declaration.id))).toEqual(
      new Set(['typescript', 'lint', 'tests-unit-core', 'extension-build']),
    )
  })

  it('makes every scenario gate depend on the type-check, so an untyped suite cannot qualify', () => {
    for (const declaration of RELEASE_GATES.filter((gate) => gate.kind === 'scenario')) {
      expect(declaration.requires).toContain('typescript')
    }
  })

  it('makes the end-to-end run and the release policy depend on the build they measure', () => {
    expect(gateById('e2e-electron').requires).toContain('build')
    expect(gateById('release-policy').requires).toContain('build')
    expect(gateById('build').requires).toContain('typescript')
    expect(gateById('build').requires).toContain('lint')
  })

  it('names at least one capability for every gate that measures behaviour', () => {
    for (const declaration of RELEASE_GATES.filter((gate) => gate.kind === 'scenario')) {
      expect(declaration.capabilities.length).toBeGreaterThan(0)
    }
  })
})

describe('Phase 49 gate eligibility', () => {
  const result = (id: (typeof GATE_IDS)[number], state: 'pass' | 'fail') => ({
    id,
    state,
    command: ['npm', 'run', 'x'],
    exitCode: state === 'pass' ? 0 : 1,
    durationMs: 1,
    detail: '',
    output: [],
  })

  it('withholds every gate whose prerequisites are not all passing', () => {
    // `typescript` failed and `lint` passed. Only what has actually passed is eligible to
    // run next: nothing that depends on the type-check, and not the type-check itself,
    // because it has already been decided.
    const eligible = eligibleGates([result('typescript', 'fail'), result('lint', 'pass')])
    expect(eligible).not.toContain('typescript')
    expect(eligible).not.toContain('tests-host')
    expect(eligible).not.toContain('build')
    expect(eligible).not.toContain('startup-shutdown')

    // `tests-unit-core` and `extension-build` need nothing, so they are still runnable —
    // which is the point of declaring prerequisites rather than relying on declaration order.
    expect(eligible).toContain('tests-unit-core')
    expect(eligible).toContain('extension-build')
  })

  it('makes an undecided prerequisite a blocker rather than an assumption', () => {
    expect(blockingPrerequisites(gateById('tests-host'), [])).toEqual(['typescript'])
  })

  it('reports a satisfied prerequisite as no blocker at all', () => {
    expect(blockingPrerequisites(gateById('tests-host'), [result('typescript', 'pass')])).toEqual([])
  })

  it('throws rather than inventing a gate that does not exist', () => {
    // @ts-expect-error — deliberately wrong, to prove the lookup is total and honest.
    expect(() => gateById('release-typo')).toThrow(/no such release gate/)
  })
})