import { describe, expect, it } from 'vitest'
import {
  GATE_STATES,
  RELEASE_GATES,
  buildCapabilityInventory,
  canonicalReportJson,
  normaliseGateState,
  qualify,
  qualificationMarkdown,
  unrecordedRequiredGates,
  type CapabilityInventory,
  type GateId,
  type GateResult,
  type GateState,
} from '../../core/qualification'
import { QUALIFIED_MODULES, floorFacts } from './fixture'

/**
 * The rule this suite exists to enforce:
 *
 * > A gate that did not run is not a gate that passed.
 *
 * Every test below is an attempt to get a `ship` verdict out of the roll-up without
 * having actually earned one. All of them must fail. If any of them ever succeeds, the
 * release layer has learned to say yes without evidence, and it is worse than having
 * no release layer at all.
 */

function gate(id: GateId, state: GateState, exitCode: number | null = state === 'pass' ? 0 : 1): GateResult {
  return {
    id,
    state,
    command: ['npm', 'run', `gate:${id}`],
    exitCode,
    durationMs: 10,
    detail: `recorded as ${state}`,
    output: [],
  }
}

function inventory(
  overrides: Partial<Parameters<typeof buildCapabilityInventory>[0]> = {},
): CapabilityInventory {
  return buildCapabilityInventory({
    facts: floorFacts(),
    presentModules: QUALIFIED_MODULES,
    ...overrides,
  })
}

/** Every gate, honestly passing. The only starting point allowed to ship. */
function allPassing(): GateResult[] {
  return RELEASE_GATES.map((declaration) => gate(declaration.id, 'pass'))
}

const generatedAt = '2026-01-01T00:00:00.000Z'

describe('Phase 49 verdict', () => {
  it('ships only when every gate passed and every shipping capability is running', () => {
    const report = qualify({
      results: allPassing(),
      inventory: inventory(),
      generatedAt,
      revision: 'abc1234',
    })
    expect(report.verdict).toBe('ship')
    expect(report.reasons).toEqual([])
    expect(report.scopeComplete).toBe(true)
  })

  it.each(GATE_STATES.filter((state) => state !== 'pass'))(
    'refuses to ship with one gate recorded as %s',
    (state) => {
      const results = allPassing().map((result) =>
        result.id === 'stop-all' ? { ...result, state, exitCode: state === 'fail' ? 1 : 0 } : result,
      )
      const report = qualify({ results, inventory: inventory(), generatedAt, revision: 'abc1234' })
      expect(report.verdict).toBe('no-ship')
      expect(report.reasons.some((reason) => reason.subject === 'stop-all')).toBe(true)
    },
  )

  it('refuses to ship when a gate is missing from the results entirely', () => {
    const results = allPassing().filter((result) => result.id !== 'browser-extension')
    const report = qualify({ results, inventory: inventory(), generatedAt, revision: 'abc1234' })
    expect(report.verdict).toBe('no-ship')
    expect(unrecordedRequiredGates(results)).toEqual(['browser-extension'])
    expect(report.gates.find((gate) => gate.id === 'browser-extension')?.state).toBe('not-run')
  })

  it('refuses to ship on a pass that no process produced', () => {
    const fabricated = RELEASE_GATES.map((declaration) =>
      declaration.id === 'persistence-recovery'
        ? { ...gate(declaration.id, 'pass'), command: null, exitCode: null }
        : gate(declaration.id, 'pass'),
    )
    const report = qualify({
      results: fabricated,
      inventory: inventory(),
      generatedAt,
      revision: 'abc1234',
    })
    expect(report.verdict).toBe('no-ship')
    const gate0 = report.gates.find((gate) => gate.id === 'persistence-recovery')!
    expect(gate0.state).toBe('not-run')
    expect(gate0.detail).toContain('no command ran')
  })

  it('refuses to ship on a pass whose process failed', () => {
    const contradicted = RELEASE_GATES.map((declaration) =>
      declaration.id === 'runtime-activation-truth'
        ? { ...gate(declaration.id, 'pass'), exitCode: 3 }
        : gate(declaration.id, 'pass'),
    )
    const report = qualify({
      results: contradicted,
      inventory: inventory(),
      generatedAt,
      revision: 'abc1234',
    })
    expect(report.verdict).toBe('no-ship')
    expect(report.gates.find((gate) => gate.id === 'runtime-activation-truth')?.state).toBe('fail')
  })

  it('refuses to ship when a capability the release claims is not running', () => {
    // The Brain is declared `shipping`. A Core with no Brain keyring entry runs it
    // degraded, which is allowed; a Core that has stopped it is not.
    const report = qualify({
      results: allPassing(),
      inventory: inventory({ facts: floorFacts({ stopAllActive: true }) }),
      generatedAt,
      revision: 'abc1234',
    })
    expect(report.verdict).toBe('no-ship')
    expect(report.reasons.some((reason) => reason.subject === 'core.brain')).toBe(true)
    expect(
      report.reasons.filter((reason) => reason.kind === 'capability-not-shipping').length,
    ).toBeGreaterThan(10)
  })

  it('refuses to ship when a shipping capability is missing from this build entirely', () => {
    const report = qualify({
      results: allPassing(),
      inventory: inventory({
        presentModules: QUALIFIED_MODULES.filter((id) => id !== 'core.brain'),
      }),
      generatedAt,
      revision: 'abc1234',
    })
    expect(report.verdict).toBe('no-ship')
    const reason = report.reasons.find((entry) => entry.subject === 'core.brain')
    expect(reason?.kind).toBe('capability-missing')
  })

  it('refuses to ship when a capability has no shipping claim at all', () => {
    const withoutClaim = inventory().capabilities.filter((capability) => capability.id !== 'core.foundry')
    const report = qualify({
      results: allPassing(),
      inventory: { ...inventory(), capabilities: withoutClaim, ids: withoutClaim.map((c) => c.id) },
      generatedAt,
      revision: 'abc1234',
    })
    expect(report.verdict).toBe('no-ship')
    expect(report.scopeComplete).toBe(false)
    expect(report.reasons.some((reason) => reason.kind === 'scope-incomplete')).toBe(true)
  })

  it('accepts a degraded shipping capability, because it is still running', () => {
    const report = qualify({
      results: allPassing(),
      inventory: inventory(),
      generatedAt,
      revision: 'abc1234',
    })
    const brain = report.capabilities.find((capability) => capability.id === 'core.brain')!
    expect(brain.readiness).toBe('degraded')
    expect(brain.shipping).toBe(true)
    expect(brain.meetsClaim).toBe(true)
  })

  it('does not let a non-shipping capability decide the verdict either way', () => {
    const report = qualify({
      results: allPassing(),
      inventory: inventory(),
      generatedAt,
      revision: 'abc1234',
    })
    const hands = report.capabilities.find((capability) => capability.id === 'core.device-hands')!
    expect(hands.claim).toBe('not-shipping')
    expect(hands.readiness).toBe('blocked')
    expect(hands.meetsClaim).toBe(true)
    expect(report.reasons.some((reason) => reason.subject === 'core.device-hands')).toBe(false)
  })

  it('counts every gate state and the counts sum to the catalogue', () => {
    const report = qualify({
      results: allPassing(),
      inventory: inventory(),
      generatedAt,
      revision: 'abc1234',
    })
    const total = Object.values(report.gateCounts).reduce((sum, value) => sum + value, 0)
    expect(total).toBe(RELEASE_GATES.length)
    expect(report.gateCounts.pass).toBe(RELEASE_GATES.length)
    for (const state of GATE_STATES) expect(typeof report.gateCounts[state]).toBe('number')
  })
})

describe('Phase 49 gate result normalisation', () => {
  it('turns a pass with no evidence into not-run and says why', () => {
    const normalised = normaliseGateState({
      id: 'stop-all',
      state: 'pass',
      command: null,
      exitCode: null,
      durationMs: 0,
      detail: 'looks good',
      output: [],
    })
    expect(normalised.state).toBe('not-run')
    expect(normalised.detail).toContain('no command ran')
  })

  it('turns a pass with a failing exit code into fail', () => {
    const normalised = normaliseGateState({
      id: 'stop-all',
      state: 'pass',
      command: ['npm', 'run', 'x'],
      exitCode: 2,
      durationMs: 5,
      detail: '',
      output: [],
    })
    expect(normalised.state).toBe('fail')
    expect(normalised.detail).toContain('exited 2')
  })

  it('leaves every honest outcome exactly as recorded, including a genuine pass', () => {
    for (const state of GATE_STATES) {
      const result: GateResult = {
        id: 'device-hands',
        state,
        command: ['npm', 'run', 'x'],
        exitCode: state === 'fail' ? 1 : 0,
        durationMs: 5,
        detail: 'recorded',
        output: [],
      }
      expect(normaliseGateState(result)).toBe(result)
    }
  })
})

describe('Phase 49 report shape', () => {
  it('produces byte-identical JSON for the same inputs, so two runs diff cleanly', () => {
    const a = qualify({ results: allPassing(), inventory: inventory(), generatedAt, revision: 'abc' })
    const b = qualify({ results: allPassing(), inventory: inventory(), generatedAt, revision: 'abc' })
    expect(canonicalReportJson(a)).toBe(canonicalReportJson(b))
    expect(canonicalReportJson(a).endsWith('\n')).toBe(true)
  })

  it('puts the verdict on its own line before anything else', () => {
    const passing = qualificationMarkdown(
      qualify({ results: allPassing(), inventory: inventory(), generatedAt, revision: 'abc' }),
    )
    expect(passing.split('\n').slice(0, 4).join('\n')).toContain('## Verdict: ship')

    const failing = qualificationMarkdown(
      qualify({
        results: allPassing().map((result) =>
          result.id === 'lint' ? { ...result, state: 'fail', exitCode: 1 } : result,
        ),
        inventory: inventory(),
        generatedAt,
        revision: 'abc',
      }),
    )
    expect(failing.split('\n').slice(0, 4).join('\n')).toContain('## Verdict: no-ship')
  })

  it('names every gate in the prose report, so a reader is never left guessing', () => {
    const markdown = qualificationMarkdown(
      qualify({ results: allPassing(), inventory: inventory(), generatedAt, revision: 'abc' }),
    )
    for (const declaration of RELEASE_GATES) {
      expect(markdown).toContain(`\`${declaration.id}\``)
      expect(markdown).toContain(declaration.claim)
    }
  })

  it('reports every capability with its readiness, so the five states are all visible', () => {
    const markdown = qualificationMarkdown(
      qualify({ results: allPassing(), inventory: inventory(), generatedAt, revision: 'abc' }),
    )
    for (const capability of inventory().capabilities) {
      expect(markdown).toContain(`\`${capability.id}\``)
    }
  })
})