import { createHash } from 'node:crypto'

import {
  FORGE_ACCESS_FIELDS,
  FORGE_AGGREGATES,
  FORGE_LIMITS,
  FORGE_PREDICATES,
  FORGE_STRING_TRANSFORMS,
  FORGE_VIEWS,
  canonicalForgeManifest,
  forgePackageId,
  isForgeAccessLevel,
  isForgeRuntimeKind,
  isForbiddenForgeCapability,
  isForgeFieldType,
  isForgeOp,
  normaliseForgeName,
  sanitiseForgeText,
  type ForgeAccessDeclaration,
  type ForgeDependency,
  type ForgeFieldSpec,
  type ForgeManifest,
  type ForgeProgram,
  type ForgeProvenance,
  type ForgeRefusalCode,
  type ForgeSchema,
  type ForgeStep,
} from './types'
import { CAPABILITIES, type Capability } from '../protocol/core-protocol'

/**
 * MANIFEST — the door a candidate's text comes through.
 *
 * Two properties this module is responsible for, and nothing else:
 *
 * 1. **Refuse rather than repair.** A missing field, an unknown operation, an
 *    access level outside the closed pair, a dependency that is not an exact
 *    version — each is a refusal carrying a closed code. Dropping the offending
 *    element would produce a manifest that *looks* valid and is scoped smaller
 *    than its author believed, which is invisible in review and is exactly how a
 *    capability quietly stops being checked.
 *
 * 2. **Canonicalisation.** What comes back is key-ordered, bounded and
 *    provenance-stamped by the caller, and its `integrityHash` is taken over
 *    {@link canonicalForgeManifest}. Two payloads that mean the same thing hash
 *    the same, and a payload that means something different cannot be installed
 *    over an existing version.
 *
 * ## What it refuses that is worth naming
 *
 * - `path-traversal` and `protected-core-reference` — a package that names a
 *   host path or Core's own source is a package that expects to be installed
 *   somewhere, and nothing here installs anything.
 * - `forbidden-capability` — a manifest that declares `security.*`,
 *   `cognition.grant.manage`, `work.approval.decide`, `foundry.*` or `forge.*` is
 *   laundering authority through a declaration.
 * - `unknown-capability` — a capability outside the closed vocabulary. Checked
 *   here so the phrase never reaches a registry.
 * - `impossible-access-declaration` (surfaced as `malformed-manifest`) — a
 *   package that declares keyring, process or filesystem access is refused
 *   outright rather than downgraded to "declared but harmless", because a
 *   manifest asking for a keyring is not a transform.
 */

export interface ParseManifestInput {
  /** The payload exactly as it arrived. Untrusted in full. */
  readonly payload: unknown
  /** The version the caller is asking to produce. Never read from the payload. */
  readonly version: number
  /** Assigned by Core. Provenance is Core's statement, not the author's. */
  readonly provenance: ForgeProvenance
}

export type ParseManifestOutcome =
  | { readonly ok: true; readonly manifest: ForgeManifest; readonly integrityHash: string }
  | { readonly ok: false; readonly code: ForgeRefusalCode; readonly reason: string }

function refuse(code: ForgeRefusalCode, reason: string): ParseManifestOutcome {
  return { ok: false, code, reason }
}

/** The sha256 of the canonical manifest, truncated for readability. */
export function forgeIntegrityHash(manifest: ForgeManifest): string {
  return createHash('sha256').update(canonicalForgeManifest(manifest), 'utf8').digest('hex').slice(0, 32)
}

export function parseForgeManifest(input: ParseManifestInput): ParseManifestOutcome {
  const { payload } = input
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return refuse('malformed-manifest', 'a package manifest must be an object')
  }
  const raw = payload as Record<string, unknown>

  const name = normaliseForgeName(raw.name)
  if (name === null) {
    return refuse(
      'malformed-manifest',
      'a package name is lower-case letters, digits and single dashes, at most 64 characters',
    )
  }

  const runtime = raw.runtime
  if (!isForgeRuntimeKind(runtime)) {
    return refuse(
      'unknown-runtime',
      'a runtime must be pure-transform, data-pipeline, research-helper, connector-wrapper, ui-artifact or automation-recipe',
    )
  }

  const description = sanitiseForgeText(raw.description, FORGE_LIMITS.maxDescriptionChars)
  if (description.length === 0) {
    return refuse('malformed-manifest', 'a package needs a description, bounded to 400 characters')
  }

  const inputs = parseSchema(raw.inputs)
  if (!inputs.ok) return refuse(inputs.code, inputs.reason)
  const outputs = parseSchema(raw.outputs)
  if (!outputs.ok) return refuse(outputs.code, outputs.reason)

  const capabilities = parseCapabilities(raw.capabilitiesRequired)
  if (!capabilities.ok) return refuse(capabilities.code, capabilities.reason)

  const access = parseAccess(raw.access)
  if (!access.ok) return refuse(access.code, access.reason)

  const dependencies = parseDependencies(raw.dependencies)
  if (!dependencies.ok) return refuse(dependencies.code, dependencies.reason)

  const tags = parseTags(raw.tags)
  if (!tags.ok) return refuse(tags.code, tags.reason)

  const program = parseProgram(raw.program)
  if (!program.ok) return refuse(program.code, program.reason)

  if (program.value.steps.length === 0) {
    return refuse('malformed-manifest', 'a package needs at least one operation, or it computes nothing')
  }

  const manifest: ForgeManifest = {
    name,
    version: input.version,
    description,
    runtime,
    inputs: inputs.value,
    outputs: outputs.value,
    capabilitiesRequired: capabilities.value,
    access: access.value,
    dependencies: dependencies.value,
    tags: tags.value,
    program: program.value,
    provenance: input.provenance,
  }

  return { ok: true, manifest, integrityHash: forgeIntegrityHash(manifest) }
}

/** The id a manifest's name implies, so callers never assemble one by hand. */
export function manifestPackageId(manifest: ForgeManifest): string {
  return forgePackageId(manifest.name)
}

/* ------------------------------------------------------------------ parts */

function parseSchema(raw: unknown): { ok: true; value: ForgeSchema } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'schema-invalid', reason: 'a schema must be an object with a fields list' }
  }
  const fields = (raw as Record<string, unknown>).fields
  if (!Array.isArray(fields)) {
    return { ok: false, code: 'schema-invalid', reason: 'a schema needs a fields list' }
  }
  if (fields.length === 0) {
    return { ok: false, code: 'schema-invalid', reason: 'a schema needs at least one field' }
  }
  if (fields.length > FORGE_LIMITS.maxInputs) {
    return {
      ok: false,
      code: 'schema-invalid',
      reason: `a schema holds at most ${FORGE_LIMITS.maxInputs} fields`,
    }
  }
  const seen = new Set<string>()
  const specs: ForgeFieldSpec[] = []
  for (const item of fields) {
    const spec = parseFieldSpec(item)
    if (!spec.ok) return { ok: false, code: spec.code, reason: spec.reason }
    if (seen.has(spec.value.name)) {
      return { ok: false, code: 'schema-invalid', reason: `field ${spec.value.name} is declared twice` }
    }
    seen.add(spec.value.name)
    specs.push(spec.value)
  }
  return { ok: true, value: { fields: specs } }
}

function parseFieldSpec(
  raw: unknown,
): { ok: true; value: ForgeFieldSpec } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'schema-invalid', reason: 'each schema field must be an object' }
  }
  const field = raw as Record<string, unknown>
  const name = normaliseForgeName(field.name)
  if (name === null) {
    return { ok: false, code: 'schema-invalid', reason: 'a schema field needs a slug name' }
  }
  if (!isForgeFieldType(field.type)) {
    return {
      ok: false,
      code: 'schema-invalid',
      reason: `field ${name} needs a type of string, number, boolean, list or record`,
    }
  }
  const required = field.required
  if (typeof required !== 'boolean') {
    return { ok: false, code: 'schema-invalid', reason: `field ${name} must state whether it is required` }
  }
  const maxLength = field.maxLength
  if (maxLength !== undefined && (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength <= 0)) {
    return { ok: false, code: 'schema-invalid', reason: `field ${name} maxLength must be a positive integer` }
  }
  const keys = field.keys
  if (keys !== undefined && !Array.isArray(keys)) {
    return { ok: false, code: 'schema-invalid', reason: `field ${name} keys must be a list when present` }
  }
  if (field.type === 'record' && (!Array.isArray(keys) || keys.length === 0)) {
    return {
      ok: false,
      code: 'schema-invalid',
      reason: `field ${name} is a record, so it must declare the closed set of keys it may carry`,
    }
  }
  if (Array.isArray(keys)) {
    if (keys.length > FORGE_LIMITS.maxRecordKeys) {
      return { ok: false, code: 'schema-invalid', reason: `field ${name} declares too many keys` }
    }
    for (const key of keys) {
      if (normaliseForgeName(key) === null) {
        return { ok: false, code: 'schema-invalid', reason: `field ${name} declares a key that is not a slug` }
      }
    }
  }
  const capped = typeof maxLength === 'number' ? Math.min(maxLength, FORGE_LIMITS.maxStringLength) : FORGE_LIMITS.maxStringLength
  return {
    ok: true,
    value: {
      name,
      type: field.type,
      required,
      maxLength: capped,
      keys: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [],
    },
  }
}

function parseCapabilities(
  raw: unknown,
): { ok: true; value: readonly Capability[] } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'malformed-manifest',
      reason: 'a package must declare the capabilities it will require, as a list',
    }
  }
  if (raw.length > FORGE_LIMITS.maxCapabilities) {
    return {
      ok: false,
      code: 'limit-exceeded',
      reason: `a package declares at most ${FORGE_LIMITS.maxCapabilities} capabilities`,
    }
  }
  const out: Capability[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !(CAPABILITIES as readonly string[]).includes(item)) {
      return {
        ok: false,
        code: 'unknown-capability',
        reason: `${String(item)} is not in the capability vocabulary, so it cannot be admitted`,
      }
    }
    const capability = item as Capability
    if (isForbiddenForgeCapability(capability)) {
      return {
        ok: false,
        code: 'forbidden-capability',
        reason: `${capability} decides whether Freya may act or manages other packages, so no generated package may require it`,
      }
    }
    if (!out.includes(capability)) out.push(capability)
  }
  return { ok: true, value: out }
}

function parseAccess(
  raw: unknown,
): { ok: true; value: ForgeAccessDeclaration } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'malformed-manifest', reason: 'a package must declare its access as an object' }
  }
  const declared = raw as Record<string, unknown>
  for (const key of Object.keys(declared)) {
    if (!(FORGE_ACCESS_FIELDS as readonly string[]).includes(key)) {
      return {
        ok: false,
        code: 'malformed-manifest',
        reason: `access declares ${key}, which is not one of ${FORGE_ACCESS_FIELDS.join(', ')}`,
      }
    }
  }
  const out: Record<string, 'denied' | 'declared'> = {}
  for (const field of FORGE_ACCESS_FIELDS) {
    const value = declared[field]
    if (value === undefined) {
      return {
        ok: false,
        code: 'malformed-manifest',
        reason: `access must state ${field} explicitly as denied or declared`,
      }
    }
    if (!isForgeAccessLevel(value)) {
      return { ok: false, code: 'malformed-manifest', reason: `access.${field} must be denied or declared` }
    }
    if (value === 'declared' && (field === 'keyring' || field === 'process' || field === 'filesystem')) {
      return {
        ok: false,
        code: 'malformed-manifest',
        reason: `access.${field} is denied to every generated package: this runtime cannot grant it and a manifest asking for it is not a transform`,
      }
    }
    out[field] = value
  }
  return {
    ok: true,
    value: {
      network: out.network ?? 'denied',
      filesystem: out.filesystem ?? 'denied',
      device: out.device ?? 'denied',
      keyring: out.keyring ?? 'denied',
      process: out.process ?? 'denied',
    },
  }
}

function parseDependencies(
  raw: unknown,
): { ok: true; value: readonly ForgeDependency[] } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'malformed-manifest', reason: 'dependencies must be a list' }
  }
  if (raw.length > FORGE_LIMITS.maxDependencies) {
    return {
      ok: false,
      code: 'limit-exceeded',
      reason: `a package declares at most ${FORGE_LIMITS.maxDependencies} dependencies`,
    }
  }
  const out: ForgeDependency[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, code: 'malformed-manifest', reason: 'each dependency must be an object' }
    }
    const entry = item as Record<string, unknown>
    const name = normaliseForgeName(entry.name)
    if (name === null) {
      return {
        ok: false,
        code: 'dependency-refused',
        reason: 'a dependency names a package with a slug name, or names nothing',
      }
    }
    // An exact version, as a positive integer or a string of digits. A range
    // ("^1.2", "latest", "*") is refused rather than interpreted: a dependency that
    // resolves to "whatever is there" is a silent upgrade waiting to happen, and
    // the whole point of declaring one is to not have that.
    const rawVersion = entry.version
    if (rawVersion !== undefined && typeof rawVersion !== 'number' && typeof rawVersion !== 'string') {
      return {
        ok: false,
        code: 'dependency-refused',
        reason: 'a dependency version must be an exact integer; a range would be a silent upgrade',
      }
    }
    const version = rawVersion === undefined ? 0 : Number(rawVersion)
    if (!Number.isInteger(version) || version < 0) {
      return {
        ok: false,
        code: 'dependency-refused',
        reason: 'a dependency version must be an exact non-negative integer',
      }
    }
    if (out.some((existing) => existing.name === name)) {
      return { ok: false, code: 'malformed-manifest', reason: `dependency ${name} is declared twice` }
    }
    out.push({ name, version })
  }
  return { ok: true, value: out }
}

function parseTags(raw: unknown): { ok: true; value: readonly string[] } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'malformed-manifest', reason: 'a package must declare tags as a list' }
  }
  if (raw.length > FORGE_LIMITS.maxTags) {
    return { ok: false, code: 'limit-exceeded', reason: `a package declares at most ${FORGE_LIMITS.maxTags} tags` }
  }
  const tags: string[] = []
  for (const item of raw) {
    const tag = normaliseForgeName(item)
    if (tag === null) {
      return {
        ok: false,
        code: 'malformed-manifest',
        reason: 'a tag is lower-case letters, digits and single dashes',
      }
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  return { ok: true, value: tags }
}

/* ---------------------------------------------------------------- program */

function parseProgram(raw: unknown): { ok: true; value: ForgeProgram } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'program-invalid', reason: 'a program must be an object with a steps list' }
  }
  const steps = (raw as Record<string, unknown>).steps
  if (!Array.isArray(steps)) {
    return { ok: false, code: 'program-invalid', reason: 'a program needs a steps list' }
  }
  if (steps.length === 0) {
    return { ok: false, code: 'program-invalid', reason: 'a program needs at least one step' }
  }
  if (steps.length > FORGE_LIMITS.maxProgramSteps) {
    return {
      ok: false,
      code: 'limit-exceeded',
      reason: `a program holds at most ${FORGE_LIMITS.maxProgramSteps} steps`,
    }
  }
  const out: ForgeStep[] = []
  for (const item of steps) {
    const step = parseStep(item)
    if (!step.ok) return { ok: false, code: step.code, reason: step.reason }
    out.push(step.value)
  }
  return { ok: true, value: { steps: out } }
}

function parseStep(raw: unknown): { ok: true; value: ForgeStep } | { ok: false; code: ForgeRefusalCode; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'program-invalid', reason: 'each step must be an object' }
  }
  const step = raw as Record<string, unknown>
  const op = step.op
  if (!isForgeOp(op)) {
    return {
      ok: false,
      code: 'program-invalid',
      reason: `${String(op)} is not an operation this runtime can interpret`,
    }
  }

  const to = step.to === undefined || step.to === null ? null : normaliseForgeName(step.to)
  if (step.to !== undefined && step.to !== null && to === null) {
    return { ok: false, code: 'program-invalid', reason: 'a step binding name is a slug' }
  }

  const from = step.from === undefined || step.from === null ? null : normaliseForgeName(step.from)
  if (step.from !== undefined && step.from !== null && from === null) {
    return { ok: false, code: 'program-invalid', reason: 'a step source binding name is a slug' }
  }

  if (to === null) {
    return { ok: false, code: 'program-invalid', reason: `step ${op} must bind a result` }
  }
  if (
    from === null &&
    op !== 'bind-const' &&
    op !== 'bind-input' &&
    op !== 'plan-research' &&
    op !== 'plan-connector' &&
    op !== 'emit-recipe'
  ) {
    return { ok: false, code: 'program-invalid', reason: `step ${op} must name the binding it reads` }
  }
  if (op === 'output' && from === null) {
    return { ok: false, code: 'program-invalid', reason: 'an output step must name the binding it publishes' }
  }

  const value = step.value
  if (op === 'bind-const') {
    if (value === undefined || (typeof value === 'object')) {
      return { ok: false, code: 'program-invalid', reason: 'bind-const needs a string, number, boolean or null' }
    }
    if (typeof value === 'string' && value.length > FORGE_LIMITS.maxArgChars) {
      return { ok: false, code: 'program-invalid', reason: 'a constant string is bounded' }
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { ok: false, code: 'program-invalid', reason: 'a constant number must be finite' }
    }
  } else if (value !== undefined) {
    return { ok: false, code: 'program-invalid', reason: `step ${op} does not take an inline value` }
  }

  const fn = step.fn
  if (fn !== undefined && typeof fn !== 'string') {
    return { ok: false, code: 'program-invalid', reason: 'a step function name is a string' }
  }

  const arg = step.arg
  if (arg !== undefined && (typeof arg !== 'string' || arg.length > FORGE_LIMITS.maxArgChars)) {
    return { ok: false, code: 'program-invalid', reason: 'a literal argument is a bounded string' }
  }

  const count = step.count
  if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) {
    return { ok: false, code: 'program-invalid', reason: 'a numeric bound is a non-negative integer' }
  }

  const items = step.items
  if (items !== undefined) {
    if (!Array.isArray(items) || items.length === 0 || items.length > FORGE_LIMITS.maxItemsPerLiteral) {
      return { ok: false, code: 'program-invalid', reason: 'a literal list holds between one and twelve strings' }
    }
    for (const item of items) {
      if (typeof item !== 'string' || item.length === 0 || item.length > FORGE_LIMITS.maxArgChars) {
        return { ok: false, code: 'program-invalid', reason: 'a literal list holds bounded non-empty strings' }
      }
    }
  }

  const out: ForgeStep = { op, to, from }
  if (value !== undefined) (out as { value: unknown }).value = value
  if (fn !== undefined) (out as { fn: string }).fn = fn
  if (arg !== undefined) (out as { arg: string }).arg = arg
  if (count !== undefined) (out as { count: number }).count = count
  if (items !== undefined) (out as { items: readonly string[] }).items = items as readonly string[]
  return { ok: true, value: out }
}

/**
 * Which operation a step needs from its own `fn` slot.
 *
 * Kept here rather than in the interpreter so the manifest door and the sandbox
 * cannot disagree about the shape of a program: `program.ts` reads this table
 * and no other list.
 */
export const FORGE_STEP_FNS: Readonly<Partial<Record<ForgeStep['op'], readonly string[]>>> = Object.freeze({
  'string-transform': FORGE_STRING_TRANSFORMS,
  aggregate: FORGE_AGGREGATES,
  filter: FORGE_PREDICATES,
  'ui-view': FORGE_VIEWS,
})

/** Ops whose `items` slot is required. */
export const FORGE_STEP_LIST_OPS: readonly ForgeStep['op'][] = Object.freeze([
  'plan-research',
  'plan-connector',
  'emit-recipe',
])
