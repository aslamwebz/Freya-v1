import { FORGE_KIND_FORBIDDEN_OPS, FORGE_LIMITS } from './types'
import { FORGE_STEP_FNS, FORGE_STEP_LIST_OPS } from './manifest'
import type {
  ForgeFieldSpec,
  ForgeProgram,
  ForgeRunFailureCode,
  ForgeRunMetrics,
  ForgeRuntimeKind,
  ForgeScalar,
  ForgeSchema,
  ForgeStep,
  ForgeValue,
} from './types'

/**
 * THE FORGE SANDBOX — the interpreter, and the honest limit of what it is.
 *
 * ## What this is
 *
 * A bounded interpreter for a straight-line list of pure operations. It walks
 * bindings, transforms scalars and lists, and returns a value envelope. It reads
 * no clock of its own, no network, no filesystem, no environment, no keyring, no
 * process, and it has no reference to any of them — there is no import of
 * `node:*` in this file at all, which is checkable by reading the imports.
 *
 * ## What it is not
 *
 * It is not a general-purpose sandbox for generated code, because this
 * architecture has none to give. `node:vm` is documented as not a security
 * boundary, and a worker thread or a subprocess shares the host's filesystem,
 * environment and keyring with the code it is supposed to contain. So rather than
 * ship a `new Function` behind a reassuring class name, Phase 48 restricted the
 * executable surface to this interpreter. The cost is real and is stated in the
 * projection: a Forge package cannot be an arbitrary plugin.
 *
 * ## The five bounds, and where each one is checked
 *
 * | bound                    | enforced by |
 * | ------------------------ | ----------- |
 * | input bytes              | `validateInput`, before the first step |
 * | output bytes             | after the last step, on the serialised envelope |
 * | operations               | `opsUsed > FORGE_LIMITS.maxOpsPerRun`, per step |
 * | deadline                 | `monotonic() - startedAt`, per step |
 * | cancellation             | `isCancelled()`, per step |
 *
 * There is also a structural bound that no counter needs: **a program cannot
 * loop**. It has no jumps, no recursion and no conditional, so the worst case is
 * bounded by its own step count. That is why the step budget is a backstop rather
 * than the primary defence.
 *
 * ## No regex, and that is deliberate
 *
 * There is no regular-expression operation. Catastrophic backtracking is a
 * denial-of-service inside a single synchronous call, which a per-step budget
 * cannot interrupt — a budget checked between steps bounds a loop, not one `exec`.
 * Omitting the operation is the honest way to keep a deadline that means
 * something.
 */

export interface ForgeExecutionInput {
  readonly program: ForgeProgram
  readonly runtime: ForgeRuntimeKind
  readonly inputs: ForgeSchema
  readonly outputs: ForgeSchema
  /** Untrusted, and validated against `inputs` before a step runs. */
  readonly input: Record<string, unknown>
  readonly budgetMs: number
  /** Read fresh, per step. A stop must not wait for the next checkpoint. */
  readonly isCancelled: () => boolean
  /** Monotonic milliseconds. Injected so a test can drive the deadline. */
  readonly monotonic: () => number
}

export type ForgeExecutionOutcome =
  | { readonly ok: true; readonly output: Record<string, ForgeValue>; readonly metrics: ForgeRunMetrics }
  | {
      readonly ok: false
      readonly code: ForgeRunFailureCode
      readonly reason: string
      readonly metrics: ForgeRunMetrics
    }

/* -------------------------------------------------------------- validation */

/**
 * Check a program against its runtime kind and its schemas, without running it.
 *
 * The isolated-test stage runs this; so does every execution. A program that
 * fails here is not "probably fine" — it is refused, and refused before any
 * binding exists.
 */
export function validateForgeProgram(input: {
  readonly program: ForgeProgram
  readonly runtime: ForgeRuntimeKind
  readonly inputs: ForgeSchema
  readonly outputs: ForgeSchema
}): { ok: true } | { ok: false; code: ForgeRunFailureCode; reason: string } {
  const { program, runtime, inputs, outputs } = input
  const forbidden = FORGE_KIND_FORBIDDEN_OPS[runtime]
  const bindings = new Set<string>()
  const inputFields = new Set(inputs.fields.map((field) => field.name))
  const outputFields = new Set(outputs.fields.map((field) => field.name))
  const produced = new Set<string>()
  const published = new Set<string>()

  for (const step of program.steps) {
    if (forbidden.includes(step.op)) {
      return {
        ok: false,
        code: 'forbidden-operation',
        reason: `a ${runtime} package may not contain ${step.op}`,
      }
    }

    const allowed = FORGE_STEP_FNS[step.op]
    if (allowed !== undefined) {
      if (step.fn === undefined || !allowed.includes(step.fn)) {
        return {
          ok: false,
          code: 'program-invalid',
          reason: `step ${step.op} needs a function of ${allowed.join(', ')}`,
        }
      }
    } else if (step.fn !== undefined) {
      return { ok: false, code: 'program-invalid', reason: `step ${step.op} does not take a function name` }
    }

    if (FORGE_STEP_LIST_OPS.includes(step.op) && (step.items === undefined || step.items.length === 0)) {
      return { ok: false, code: 'program-invalid', reason: `step ${step.op} must carry a bounded list` }
    }

    const to = step.to
    if (to === null) {
      return { ok: false, code: 'program-invalid', reason: 'every step binds a result' }
    }

    if (step.op === 'output') {
      if (!outputFields.has(to)) {
        return {
          ok: false,
          code: 'program-invalid',
          reason: `${to} is not a declared output field, so publishing it would widen the contract`,
        }
      }
      if (published.has(to)) {
        return { ok: false, code: 'program-invalid', reason: `output ${to} is published twice` }
      }
      published.add(to)
    } else if (produced.has(to)) {
      return { ok: false, code: 'program-invalid', reason: `binding ${to} is produced twice` }
    }
    produced.add(to)
    bindings.add(to)

    if (step.op === 'bind-input') {
      const field = step.arg
      if (field === undefined || !inputFields.has(field)) {
        return {
          ok: false,
          code: 'program-invalid',
          reason: `bind-input names ${String(field)}, which is not a declared input field`,
        }
      }
    }

    if (step.from !== null && !bindings.has(step.from) && step.op !== 'output') {
      return { ok: false, code: 'unknown-binding', reason: `step ${step.op} reads ${step.from}, which nothing bound` }
    }
  }

  for (const field of outputs.fields) {
    if (field.required && !published.has(field.name)) {
      return {
        ok: false,
        code: 'program-invalid',
        reason: `required output ${field.name} is never published`,
      }
    }
  }

  return { ok: true }
}

/* ------------------------------------------------------------- input check */

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'object') return 'record'
  return typeof value
}

function checkValue(spec: ForgeFieldSpec, value: unknown): string | null {
  if (value === null) return spec.type === 'string' || spec.type === 'number' || spec.type === 'boolean' || spec.type === 'list' || spec.type === 'record' ? null : 'null'
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return `expected string, got ${typeName(value)}`
      if (value.length > Math.min(spec.maxLength, FORGE_LIMITS.maxStringLength)) return `string longer than ${spec.maxLength}`
      return null
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `expected finite number, got ${typeName(value)}`
      return null
    case 'boolean':
      if (typeof value !== 'boolean') return `expected boolean, got ${typeName(value)}`
      return null
    case 'list':
      if (!Array.isArray(value)) return `expected list, got ${typeName(value)}`
      if (value.length > Math.min(spec.maxLength, FORGE_LIMITS.maxListLength)) return `list longer than ${spec.maxLength}`
      for (const item of value) {
        if (item === null) continue
        if (typeof item === 'object') return 'a list may hold scalars only'
        if (typeof item === 'number' && !Number.isFinite(item)) return 'a list may hold finite numbers only'
      }
      return null
    case 'record':
      if (typeof value !== 'object' || Array.isArray(value)) return `expected record, got ${typeName(value)}`
      return null
    default:
      return 'unknown field type'
  }
}

/**
 * Validate the caller's payload against the declared input schema.
 *
 * Extra keys are refused rather than ignored: a payload that carries a field the
 * contract does not declare is a payload someone believed was being read, and
 * silently dropping it would produce a result computed from less than the caller
 * asked for while looking complete.
 */
export function validateForgeInput(
  schema: ForgeSchema,
  input: unknown,
): { ok: true; value: Record<string, ForgeValue> } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'input must be an object of the declared fields' }
  }
  const raw = input as Record<string, unknown>
  const declared = new Set(schema.fields.map((field) => field.name))
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) {
      return { ok: false, reason: `input carries ${key}, which the contract does not declare` }
    }
  }
  const out: Record<string, ForgeValue> = {}
  for (const spec of schema.fields) {
    const value = raw[spec.name]
    if (value === undefined) {
      if (spec.required) return { ok: false, reason: `input is missing required field ${spec.name}` }
      continue
    }
    const problem = checkValue(spec, value)
    if (problem !== null) return { ok: false, reason: `${spec.name}: ${problem}` }
    if (spec.type === 'record' && value !== null && !Array.isArray(value) && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const keys = spec.keys
      for (const key of Object.keys(record)) {
        if (!keys.includes(key)) return { ok: false, reason: `${spec.name} carries ${key}, which is not a declared key` }
      }
      if (Object.keys(record).length > FORGE_LIMITS.maxRecordKeys) {
        return { ok: false, reason: `${spec.name} carries more keys than a record may hold` }
      }
      const inner: Record<string, ForgeValue> = {}
      for (const key of keys) {
        const item = record[key]
        if (item === undefined) continue
        const problem = checkValue({ ...spec, type: inferScalarType(item), name: `${spec.name}.${key}` }, item)
        if (problem !== null) return { ok: false, reason: `${spec.name}.${key}: ${problem}` }
        inner[key] = item as ForgeValue
      }
      out[spec.name] = inner
      continue
    }
    out[spec.name] = value as ForgeValue
  }
  return { ok: true, value: out }
}

function inferScalarType(value: unknown): ForgeFieldSpec['type'] {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return 'list'
  return 'record'
}

/* ------------------------------------------------------------- interpreter */

/**
 * How many container levels a value has.
 *
 * Scalars are at the depth they are handed, a list is one level deeper than the
 * value holding it, and a record is one level deeper than its deepest child. So
 * `{ loud: 'X' }` is 1, `{ plan: { queries: [...] } }` is 3, and the ceiling of 3
 * admits exactly the shape a research plan or a UI view needs while refusing a
 * structure that could be walked into something bigger than it declared.
 */
function valueDepth(value: ForgeValue, depth = 0): number {
  if (Array.isArray(value)) return depth + 1
  if (value !== null && typeof value === 'object') {
    let max = depth + 1
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, ForgeValue>)[key]
      if (child === undefined) continue
      max = Math.max(max, valueDepth(child, depth + 1))
    }
    return max
  }
  return depth
}

function countChars(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + countChars(item), 0)
  if (value !== null && typeof value === 'object') {
    let total = 0
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key]
      total += key.length + countChars(child)
    }
    return total
  }
  return 0
}

function asList(value: ForgeValue): ForgeScalar[] | null {
  return Array.isArray(value) ? value : null
}

function asText(value: ForgeValue): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function numeric(value: ForgeValue): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const TAG = /<[^>]*>/g

function applyStringTransform(fn: string, text: string): ForgeValue {
  switch (fn) {
    case 'upper':
      return text.toUpperCase()
    case 'lower':
      return text.toLowerCase()
    case 'trim':
      return text.trim()
    case 'reverse':
      return [...text].reverse().join('')
    case 'length':
      return text.length
    case 'slug':
      return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    case 'strip-tags':
      return text.replace(TAG, '')
    case 'collapse-space':
      return text.replace(/\s+/g, ' ').trim()
    default:
      return text
  }
}

function applyAggregate(fn: string, items: ForgeScalar[]): number {
  const numbers = items.map(numeric).filter((value): value is number => value !== null)
  if (fn === 'count') return items.length
  if (numbers.length === 0) return 0
  switch (fn) {
    case 'sum':
      return numbers.reduce((total, value) => total + value, 0)
    case 'min':
      return Math.min(...numbers)
    case 'max':
      return Math.max(...numbers)
    case 'mean':
      return numbers.reduce((total, value) => total + value, 0) / numbers.length
    default:
      return numbers.length
  }
}

/**
 * Validate what a run produced against the declared output schema.
 *
 * Symmetrical with {@link validateForgeInput}, and load-bearing for the same reason:
 * a package that publishes a field its contract does not declare, or publishes a
 * different type than it promised, has either widened its own contract or computed
 * something it did not describe. Both are recorded as `output-schema-violation` rather
 * than returned as a success, because "it ran" is not the same claim as "it produced
 * what it said it would".
 */
export function validateForgeOutput(
  schema: ForgeSchema,
  output: Record<string, ForgeValue>,
): { ok: true } | { ok: false; reason: string } {
  const declared = new Map(schema.fields.map((field) => [field.name, field]))
  for (const key of Object.keys(output)) {
    if (!declared.has(key)) {
      return { ok: false, reason: `the run produced ${key}, which the contract does not declare` }
    }
  }
  for (const spec of schema.fields) {
    const value = output[spec.name]
    if (value === undefined) {
      if (spec.required) return { ok: false, reason: `the run did not produce its required output ${spec.name}` }
      continue
    }
    const problem = checkValue(spec, value)
    if (problem !== null) return { ok: false, reason: `${spec.name}: ${problem}` }
    if (spec.type === 'record' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value as Record<string, ForgeValue>)) {
        if (!spec.keys.includes(key)) {
          return { ok: false, reason: `${spec.name} produced ${key}, which is not a declared key` }
        }
      }
    }
  }
  return { ok: true }
}

/**
 * Interpret a validated program.
 *
 * Deterministic given the same input, the same budget and the same clock
 * readings. There is no randomness, no clock read of its own and no I/O, so two
 * runs of the same program over the same input produce byte-identical envelopes —
 * which is what makes an idempotency key worth having.
 */
export function interpretForgeProgram(input: ForgeExecutionInput): ForgeExecutionOutcome {
  const startedAt = input.monotonic()
  const budget = Math.max(1, Math.min(input.budgetMs, FORGE_LIMITS.maxRunBudgetMs))
  let opsUsed = 0

  const metrics = (outputChars: number): ForgeRunMetrics => ({
    opsUsed,
    inputChars: countChars(input.input),
    outputChars,
    durationMs: Math.max(0, input.monotonic() - startedAt),
  })

  const fail = (code: ForgeRunFailureCode, reason: string, outputChars = 0): ForgeExecutionOutcome => ({
    ok: false,
    code,
    reason,
    metrics: metrics(outputChars),
  })

  const structural = validateForgeProgram(input)
  if (!structural.ok) return fail(structural.code, structural.reason)

  const inputChars = countChars(input.input)
  if (inputChars > FORGE_LIMITS.maxInputChars) {
    return fail('input-too-large', `input is ${inputChars} characters and the ceiling is ${FORGE_LIMITS.maxInputChars}`)
  }

  const checked = validateForgeInput(input.inputs, input.input)
  if (!checked.ok) return fail('input-schema-violation', checked.reason)

  const bindings = new Map<string, ForgeValue>(Object.entries(checked.value))
  const output: Record<string, ForgeValue> = {}

for (const step of input.program.steps) {
    // Checked before the increment, so `opsUsed` counts operations that actually
    // ran. A metric that counted the refused step would overstate the work done by
    // exactly one, which is the number a person reads when asking "how much did
    // that cost".
    if (opsUsed >= FORGE_LIMITS.maxOpsPerRun) {
      return fail('step-budget-exhausted', `a run may interpret at most ${FORGE_LIMITS.maxOpsPerRun} operations`)
    }
    opsUsed += 1
    if (input.isCancelled()) return fail('cancelled', 'the run was cancelled before it finished')
    if (input.monotonic() - startedAt > budget) {
      return fail('deadline-exceeded', `the run exceeded its ${budget}ms budget`)
    }

    const applied = applyStep(step, bindings, output)
    if (!applied.ok) return fail(applied.code, applied.reason)
    if (applied.bound !== undefined) bindings.set(applied.bound, applied.value)
  }

const serialised = JSON.stringify(output)
  const outputChars = serialised.length
  if (outputChars > FORGE_LIMITS.maxOutputChars) {
    return fail('output-too-large', `output is ${outputChars} characters and the ceiling is ${FORGE_LIMITS.maxOutputChars}`, outputChars)
  }
  if (valueDepth(output as ForgeValue) > FORGE_LIMITS.maxDepth) {
    return fail('output-too-large', 'the output nests deeper than a Forge envelope may', outputChars)
  }
  const conformant = validateForgeOutput(input.outputs, output)
  if (!conformant.ok) return fail('output-schema-violation', conformant.reason, outputChars)

  return { ok: true, output, metrics: metrics(outputChars) }
}

type Applied =
  | { ok: true; bound?: string; value: ForgeValue }
  | { ok: false; code: ForgeRunFailureCode; reason: string }

function applyStep(step: ForgeStep, bindings: Map<string, ForgeValue>, output: Record<string, ForgeValue>): Applied {
  const to = step.to
  if (to === null) return { ok: false, code: 'program-invalid', reason: 'every step binds a result' }
  const from = step.from
  const read = (): ForgeValue | undefined => (from === null ? undefined : bindings.get(from))

  switch (step.op) {
    case 'bind-input': {
      const value = bindings.get(step.arg ?? '')
      if (value === undefined) {
        return { ok: false, code: 'input-schema-violation', reason: `input field ${String(step.arg)} is absent` }
      }
      return { ok: true, bound: to, value }
    }
    case 'bind-const': {
      return { ok: true, bound: to, value: (step.value ?? null) as ForgeValue }
    }
    case 'string-transform': {
      const value = read()
      const text = value === undefined ? null : asText(value)
      if (text === null) {
        return { ok: false, code: 'type-mismatch', reason: `string-transform reads ${String(from)}, which is not text` }
      }
      return { ok: true, bound: to, value: applyStringTransform(step.fn ?? 'trim', text) }
    }
    case 'split': {
      const value = read()
      const text = value === undefined ? null : asText(value)
      if (text === null) {
        return { ok: false, code: 'type-mismatch', reason: `split reads ${String(from)}, which is not text` }
      }
      const separator = step.arg ?? ','
      const parts = separator.length === 0 ? [text] : text.split(separator)
      if (parts.length > FORGE_LIMITS.maxListLength) {
        return { ok: false, code: 'output-too-large', reason: 'split produced more items than a list may hold' }
      }
      return { ok: true, bound: to, value: parts }
    }
    case 'join': {
      const value = read()
      const items = value === undefined ? null : asList(value)
      if (items === null) {
        return { ok: false, code: 'type-mismatch', reason: `join reads ${String(from)}, which is not a list` }
      }
      const text = items.map((item) => (item === null ? '' : String(item))).join(step.arg ?? '')
      if (text.length > FORGE_LIMITS.maxStringLength) {
        return { ok: false, code: 'output-too-large', reason: 'join produced a string longer than the ceiling' }
      }
      return { ok: true, bound: to, value: text }
    }
    case 'filter': {
      const value = read()
      const items = value === undefined ? null : asList(value)
      if (items === null) {
        return { ok: false, code: 'type-mismatch', reason: `filter reads ${String(from)}, which is not a list` }
      }
      const bound = typeof step.count === 'number' ? step.count : 1
      const kept = items.filter((item) => {
        if (step.fn === 'numeric') return numeric(item) !== null
        if (step.fn === 'longer-than') return asText(item) !== null && (asText(item) as string).length > bound
        return asText(item) !== null && (asText(item) as string).trim().length > 0
      })
      return { ok: true, bound: to, value: kept }
    }
    case 'aggregate': {
      const value = read()
      const items = value === undefined ? null : asList(value)
      if (items === null) {
        return { ok: false, code: 'type-mismatch', reason: `aggregate reads ${String(from)}, which is not a list` }
      }
      return { ok: true, bound: to, value: applyAggregate(step.fn ?? 'count', items) }
    }
    case 'json-parse': {
      const value = read()
      const text = value === undefined ? null : asText(value)
      if (text === null) {
        return { ok: false, code: 'type-mismatch', reason: `json-parse reads ${String(from)}, which is not text` }
      }
      if (text.length > FORGE_LIMITS.maxStringLength) {
        return { ok: false, code: 'input-too-large', reason: 'json-parse was given more text than the ceiling' }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, code: 'invalid-data', reason: 'json-parse was given text that is not JSON' }
      }
      if (parsed !== null && typeof parsed === 'object' && valueDepth(parsed as ForgeValue) > FORGE_LIMITS.maxDepth - 1) {
        return { ok: false, code: 'invalid-data', reason: 'json-parse produced a structure deeper than a Forge value may hold' }
      }
      return { ok: true, bound: to, value: parsed as ForgeValue }
    }
    case 'json-stringify': {
      const value = read()
      if (value === undefined) {
        return { ok: false, code: 'unknown-binding', reason: `json-stringify reads ${String(from)}, which nothing bound` }
      }
      const text = JSON.stringify(value)
      if (text.length > FORGE_LIMITS.maxStringLength) {
        return { ok: false, code: 'output-too-large', reason: 'json-stringify produced more text than the ceiling' }
      }
      return { ok: true, bound: to, value: text }
    }
    case 'select': {
      const value = read()
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, code: 'type-mismatch', reason: `select reads ${String(from)}, which is not a record` }
      }
      const key = step.arg ?? ''
      if (!Object.keys(value).includes(key)) {
        return { ok: false, code: 'invalid-data', reason: `select found no ${key}` }
      }
      return { ok: true, bound: to, value: (value as Record<string, ForgeValue>)[key] as ForgeValue }
    }
    case 'output': {
      const value = read()
      if (value === undefined) {
        return { ok: false, code: 'unknown-binding', reason: `output reads ${String(from)}, which nothing bound` }
      }
      if (valueDepth(value) > FORGE_LIMITS.maxDepth) {
        return { ok: false, code: 'output-too-large', reason: 'a published value nests deeper than a Forge envelope may' }
      }
      output[to] = value
      return { ok: true, value }
    }
    case 'plan-research': {
      const queries = [...(step.items ?? [])]
      return {
        ok: true,
        bound: to,
        value: { kind: 'research-plan', queries },
      }
    }
    case 'plan-connector': {
      return {
        ok: true,
        bound: to,
        value: {
          kind: 'connector-plan',
          connector: step.arg ?? '',
          actions: [...(step.items ?? [])],
        },
      }
    }
    case 'ui-view': {
      const value = read()
      if (value === undefined) {
        return { ok: false, code: 'unknown-binding', reason: `ui-view reads ${String(from)}, which nothing bound` }
      }
      return {
        ok: true,
        bound: to,
        value: {
          kind: 'ui-artifact',
          view: step.fn ?? 'text',
          content: value,
        },
      }
    }
    case 'emit-recipe': {
      return {
        ok: true,
        bound: to,
        value: {
          kind: 'recipe',
          name: step.arg ?? '',
          steps: [...(step.items ?? [])],
        },
      }
    }
    default:
      return { ok: false, code: 'forbidden-operation', reason: `${String(step.op)} is not an operation this runtime interprets` }
  }
}
