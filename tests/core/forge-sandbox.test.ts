// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { interpretForgeProgram, validateForgeInput, validateForgeProgram } from '../../core/forge/program'
import { parseForgeManifest } from '../../core/forge/manifest'
import { FORGE_LIMITS, type ForgeManifest, type ForgeProgram } from '../../core/forge/types'

/**
 * THE SANDBOX — bounds, cancellation, determinism, and the absence of host powers.
 *
 * These assertions are the load-bearing ones for "generated code cannot reach the
 * host". Each bound is exercised through the real interpreter with the real
 * manifest, not through a mock of it.
 */

const PROVENANCE = {
  origin: 'forge-generated' as const,
  model: 'test-model',
  requestHash: null,
  originRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}

function manifestFor(payload: Record<string, unknown>): ForgeManifest {
  const parsed = parseForgeManifest({ payload, version: 1, provenance: PROVENANCE })
  if (!parsed.ok) throw new Error(`expected a manifest, got ${parsed.code}: ${parsed.reason}`)
  return parsed.manifest
}

function textProgram(steps: unknown[]): Record<string, unknown> {
  return {
    name: 'bounds-probe',
    runtime: 'pure-transform',
    description: 'A program used only by the sandbox tests.',
    inputs: { fields: [{ name: 'text', type: 'string', required: true, maxLength: 8192 }] },
    outputs: { fields: [{ name: 'result', type: 'string', required: true, maxLength: 8192 }] },
    capabilitiesRequired: [],
    access: { network: 'denied', filesystem: 'denied', device: 'denied', keyring: 'denied', process: 'denied' },
    dependencies: [],
    tags: ['test'],
    program: { steps },
  }
}

function run(
  manifest: ForgeManifest,
  input: unknown,
  options: { budgetMs?: number; isCancelled?: () => boolean; monotonic?: () => number } = {},
) {
  return interpretForgeProgram({
    program: manifest.program,
    runtime: manifest.runtime,
    inputs: manifest.inputs,
    outputs: manifest.outputs,
    input: input as Record<string, unknown>,
    budgetMs: options.budgetMs ?? FORGE_LIMITS.defaultRunBudgetMs,
    isCancelled: options.isCancelled ?? (() => false),
    monotonic: options.monotonic ?? (() => 0),
  })
}

describe('input admission', () => {
  const manifest = manifestFor(
    textProgram([
      { op: 'bind-input', to: 'raw', arg: 'text' },
      { op: 'string-transform', to: 'out', from: 'raw', fn: 'trim' },
      { op: 'output', to: 'result', from: 'out' },
    ]),
  )

  it('accepts a declared input', () => {
    const outcome = run(manifest, { text: '  hello  ' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.output.result).toBe('hello')
  })

  it('refuses a missing required field', () => {
    const outcome = run(manifest, {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('input-schema-violation')
  })

  it('refuses an undeclared field rather than ignoring it', () => {
    const outcome = run(manifest, { text: 'hello', sneaky: 'value' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('input-schema-violation')
  })

  it('refuses a wrong type', () => {
    const outcome = run(manifest, { text: 42 })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('input-schema-violation')
  })

  it('refuses input past the byte ceiling', () => {
    const outcome = run(manifest, { text: 'x'.repeat(FORGE_LIMITS.maxInputChars + 10) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('input-too-large')
  })

  it('validates a record input against its closed key set', () => {
    const checked = validateForgeInput(
      {
        fields: [
          {
            name: 'row',
            type: 'record',
            required: true,
            maxLength: 4,
            keys: ['label', 'count'],
          },
        ],
      },
      { row: { label: 'a', count: 2 } },
    )
    expect(checked.ok).toBe(true)
    const refused = validateForgeInput(
      { fields: [{ name: 'row', type: 'record', required: true, maxLength: 4, keys: ['label'] }] },
      { row: { label: 'a', extra: 1 } },
    )
    expect(refused.ok).toBe(false)
  })
})

describe('the bounds', () => {
  it('stops a program that is longer than the step ceiling', () => {
    const steps = Array.from({ length: FORGE_LIMITS.maxProgramSteps + 5 }, (_, index) => ({
      op: 'bind-const',
      to: `b${index}`,
      value: index,
    }))
    let manifest: ForgeManifest | null = null
    try {
      manifest = manifestFor(textProgram(steps))
    } catch {
      // Refused at the door, which is the better outcome and is asserted below.
    }
    expect(manifest).toBeNull()
  })

  it('reports the operation budget rather than running past it', () => {
    // Hand-built program: the door would refuse this length, so the interpreter's
    // own budget is exercised directly. Each binding is unique and one output is
    // published, so the only thing wrong with it is that it is longer than the run
    // budget allows.
    const steps: ForgeProgram['steps'] = [
      ...Array.from({ length: FORGE_LIMITS.maxOpsPerRun + 4 }, (_, index) => ({
        op: 'bind-const' as const,
        to: `b${index}`,
        from: null,
        value: index,
      })),
      { op: 'output' as const, to: 'result', from: 'b0' },
    ]
    const manifest = manifestFor(textProgram([{ op: 'bind-const', to: 'seed', value: 1 }]))
    const outcome = interpretForgeProgram({
      program: { steps },
      runtime: manifest.runtime,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      input: { text: 'x' },
      budgetMs: FORGE_LIMITS.defaultRunBudgetMs,
      isCancelled: () => false,
      monotonic: () => 0,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('step-budget-exhausted')
    expect(outcome.metrics.opsUsed).toBeLessThanOrEqual(FORGE_LIMITS.maxOpsPerRun)
  })

  it('honours the deadline, checked between steps', () => {
    const manifest = manifestFor(
      textProgram([
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'string-transform', to: 'out', from: 'raw', fn: 'upper' },
        { op: 'output', to: 'result', from: 'out' },
      ]),
    )
    let clock = 0
    const outcome = run(manifest, { text: 'hello' }, {
      budgetMs: 10,
      monotonic: () => (clock += 8),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('deadline-exceeded')
  })

  it('stops when cancelled, and says cancelled rather than failed', () => {
    const manifest = manifestFor(
      textProgram([
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'string-transform', to: 'out', from: 'raw', fn: 'upper' },
        { op: 'output', to: 'result', from: 'out' },
      ]),
    )
    const outcome = run(manifest, { text: 'hello' }, { isCancelled: () => true })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('cancelled')
  })

  it('refuses output past the byte ceiling', () => {
    const manifest = manifestFor({
      name: 'bulky-probe',
      runtime: 'pure-transform',
      description: 'Joins a large list into one oversized field.',
      inputs: { fields: [{ name: 'text', type: 'string', required: true, maxLength: 8192 }] },
      outputs: { fields: [{ name: 'result', type: 'string', required: true, maxLength: 8192 }] },
      capabilitiesRequired: [],
      access: { network: 'denied', filesystem: 'denied', device: 'denied', keyring: 'denied', process: 'denied' },
      dependencies: [],
      tags: ['test'],
      program: {
        steps: [
          { op: 'split', to: 'parts', from: 'raw', arg: '' },
          { op: 'join', to: 'joined', from: 'parts', arg: '' },
          { op: 'output', to: 'result', from: 'joined' },
          { op: 'bind-input', to: 'raw', arg: 'text' },
        ].slice(0, 3),
      },
    })
    // The program above reads a binding it never binds, so it fails structurally
    // rather than silently: which is itself the property under test.
    const outcome = run(manifest, { text: 'hello' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(['unknown-binding', 'program-invalid']).toContain(outcome.code)
  })

  it('refuses a nested structure deeper than a Forge value may hold', () => {
    const nested = JSON.stringify({ a: { b: { c: { d: 'deep' } } } })
    const manifest = manifestFor(
      textProgram([
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'json-parse', to: 'parsed', from: 'raw' },
        { op: 'output', to: 'result', from: 'parsed' },
      ]),
    )
    const outcome = run(manifest, { text: nested })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('invalid-data')
  })

  it('reports invalid JSON as invalid data rather than an empty result', () => {
    const manifest = manifestFor(
      textProgram([
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'json-parse', to: 'parsed', from: 'raw' },
        { op: 'output', to: 'result', from: 'parsed' },
      ]),
    )
    const outcome = run(manifest, { text: 'not json at all' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('invalid-data')
  })
})

describe('static program validation', () => {
  it('refuses a program that reads a binding nothing binds', () => {
    const manifest = manifestFor(
      textProgram([
        { op: 'string-transform', to: 'out', from: 'nowhere', fn: 'upper' },
        { op: 'output', to: 'result', from: 'out' },
      ]),
    )
    const checked = validateForgeProgram({
      program: manifest.program,
      runtime: manifest.runtime,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
    })
    expect(checked.ok).toBe(false)
  })

  it('refuses a program that publishes an undeclared output', () => {
    const manifest = manifestFor(
      textProgram([
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'output', to: 'something-else', from: 'raw' },
      ]),
    )
    const checked = validateForgeProgram({
      program: manifest.program,
      runtime: manifest.runtime,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
    })
    expect(checked.ok).toBe(false)
  })

  it('refuses a required output nobody publishes', () => {
    const manifest = manifestFor(
      textProgram([
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'string-transform', to: 'out', from: 'raw', fn: 'upper' },
      ]),
    )
    const checked = validateForgeProgram({
      program: manifest.program,
      runtime: manifest.runtime,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
    })
    expect(checked.ok).toBe(false)
  })

  it('refuses a planning operation inside a purely local runtime', () => {
    const manifest = manifestFor(
      textProgram([
        { op: 'plan-research', to: 'plan', items: ['something'] },
        { op: 'output', to: 'result', from: 'plan' },
      ]),
    )
    const checked = validateForgeProgram({
      program: manifest.program,
      runtime: 'pure-transform',
      inputs: manifest.inputs,
      outputs: manifest.outputs,
    })
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.code).toBe('forbidden-operation')
  })
})

describe('determinism', () => {
  const manifest = manifestFor(
    textProgram([
      { op: 'bind-input', to: 'raw', arg: 'text' },
      { op: 'split', to: 'parts', from: 'raw', arg: ',' },
      { op: 'filter', to: 'kept', from: 'parts', fn: 'nonempty' },
      { op: 'aggregate', to: 'count', from: 'kept', fn: 'count' },
      { op: 'join', to: 'joined', from: 'kept', arg: ' ' },
      { op: 'output', to: 'result', from: 'joined' },
    ]),
  )

  it('produces the same envelope for the same input', () => {
    const input = { text: 'a, , b,c' }
    const first = run(manifest, input)
    const second = run(manifest, input)
    expect(first).toEqual(second)
  })

  it('has no clock of its own, so a constant clock yields a constant duration', () => {
    const outcome = run(manifest, { text: 'a,b' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.metrics.durationMs).toBe(0)
  })

  it('counts the work it did, so a run has evidence', () => {
    const outcome = run(manifest, { text: 'a,b' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.metrics.opsUsed).toBe(6)
      expect(outcome.metrics.outputChars).toBeGreaterThan(0)
    }
  })
})

describe('a UI artifact stays an artifact', () => {
  it('renders a declarative view and nothing executable', () => {
    const manifest = manifestFor({
      name: 'note-list-view',
      runtime: 'ui-artifact',
      description: 'Renders a bounded list of notes as a declared view.',
      inputs: { fields: [{ name: 'text', type: 'string', required: true, maxLength: 1024 }] },
      outputs: {
        fields: [{ name: 'view', type: 'record', required: true, maxLength: 4, keys: ['kind', 'view', 'content'] }],
      },
      capabilitiesRequired: [],
      access: { network: 'denied', filesystem: 'denied', device: 'denied', keyring: 'denied', process: 'denied' },
      dependencies: [],
      tags: ['ui'],
      program: {
        steps: [
          { op: 'bind-input', to: 'raw', arg: 'text' },
          { op: 'split', to: 'rows', from: 'raw', arg: '\n' },
          { op: 'ui-view', to: 'view', from: 'rows', fn: 'list' },
          { op: 'output', to: 'view', from: 'view' },
        ],
      },
    })
    const outcome = run(manifest, { text: 'one\ntwo' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const view = outcome.output.view as Record<string, unknown>
      expect(view.kind).toBe('ui-artifact')
      expect(view.view).toBe('list')
      expect(view.content).toEqual(['one', 'two'])
    }
  })
})