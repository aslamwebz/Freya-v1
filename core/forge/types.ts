import { CAPABILITIES, type Capability } from '../protocol/core-protocol'
import { deriveSkillId } from '../skills/identity'

/**
 * THE FORGE DOMAIN — Phase 48's vocabulary.
 *
 * This file is types and closed tables only: no I/O, no clock, no model, no
 * randomness, no filesystem, and — deliberately — **no way to write source code**.
 *
 * ## The one honest decision everything else follows from
 *
 * Phase 48 was asked to run generated and external skills in a constrained
 * runtime. Node and Electron cannot give one. `node:vm` is documented by its own
 * authors as not a security mechanism; a `worker_thread` shares the process, its
 * filesystem, its environment and its keyring handle; a subprocess has the same.
 * There is no `eval`-free general-purpose sandbox available in this architecture,
 * so pretending otherwise would be the single worst lie in the codebase.
 *
 * Therefore the executable surface of a Forge package is **not code**. A program
 * is a straight-line list of operations drawn from {@link FORGE_OPS}, interpreted
 * by {@link interpretForgeProgram} in `program.ts`. That buys the following as a
 * property of the *shape* rather than as a promise:
 *
 * - **No unrestricted shell, ever.** Nothing can name one; there is no operation
 *   that spawns anything, because there is no operation table entry for it.
 * - **No arbitrary host filesystem.** No path exists in the value model, so path
 *   traversal is not "blocked" — it is unrepresentable.
 * - **No keyring, Vault, or environment secrets.** No operation reads a process,
 *   an OS, or an environment.
 * - **No network, declared or not.** Network is a *downstream* act performed by
 *   Research or Relay under their own capability, approval and audit. A Forge
 *   program can only *plan* such an act.
 * - **No `eval`, no native module, no escape.** There is no code path from a
 *   manifest to a JavaScript evaluator, so there is nothing to escape into.
 * - **No loops.** A program is a bounded, straight-line list. It cannot spin, so
 *   the CPU bound is the step count, and the step budget is checked per step.
 *
 * What this costs is stated in the projection rather than hidden: a Forge package
 * in this phase can transform data, parse and format text, describe a research or
 * connector *plan*, render a declarative UI artifact and emit a recipe. It cannot
 * be an arbitrary plugin. {@link FORGE_RUNTIME_KINDS} is that list, closed.
 *
 * ## What a package is
 *
 * A **package** is a versioned, hashed, immutable thing with a declared
 * capability requirement, a declared access declaration and a lifecycle status.
 * It is bound to the Skill registry by *identity only*: {@link forgePackageId} is
 * derived from the same normalised name through the same `deriveSkillId` the
 * Skill domain uses, so a Forge candidate and a Skill record for one name are one
 * entity, not two that can disagree. This domain owns the **deployment**
 * lifecycle (generated → installed → enabled → quarantined). The Skill domain
 * keeps owning the **procedural trust** lifecycle (candidate → verified →
 * promoted). Neither invents a second registry of what Freya can do.
 *
 * ## What this file cannot express
 *
 * There is no field anywhere in this file that grants authority. `capabilities`
 * is a *declaration of what the package will ask for*, checked against
 * registered capabilities at install and against the caller's held capabilities
 * at run; `approval` records a person's decision; `integrityHash` detects change.
 * None of them mints anything, and there is no `grant`, `authority`, `principal`,
 * `bypass`, `override` or `clearStopAll` on any shape below.
 */

export { deriveSkillId as forgeSkillId }

/* ------------------------------------------------------------------- kinds */

/**
 * What shape of bounded thing a Forge package is.
 *
 * Closed because the kind decides which operations its program may contain and
 * what its access declaration is allowed to say. `pure-transform` and
 * `data-pipeline` compute; `research-helper` and `connector-wrapper` describe an
 * act for a downstream, authorised subsystem to perform; `ui-artifact` renders a
 * declarative view; `automation-recipe` emits a bounded list of named steps.
 *
 * None of them is "a plugin", and the list is the honest limit of what this
 * architecture can sandbox. A kind that meant "whatever the generator wanted"
 * would make the whole table decorative.
 */
export const FORGE_RUNTIME_KINDS = [
  'pure-transform',
  'data-pipeline',
  'research-helper',
  'connector-wrapper',
  'ui-artifact',
  'automation-recipe',
] as const
export type ForgeRuntimeKind = (typeof FORGE_RUNTIME_KINDS)[number]

export function isForgeRuntimeKind(value: unknown): value is ForgeRuntimeKind {
  return typeof value === 'string' && (FORGE_RUNTIME_KINDS as readonly string[]).includes(value)
}

/**
 * Operations a program may not contain, by runtime kind.
 *
 * The two planning kinds (`research-helper`, `connector-wrapper`) exist to
 * *describe* a privileged act to a subsystem that has the capability to perform
 * it; they may not perform one. The three compute kinds may not even describe
 * one, so a "pure transform" cannot smuggle a plan out as a side effect.
 */
export const FORGE_KIND_FORBIDDEN_OPS: Readonly<Record<ForgeRuntimeKind, readonly ForgeOp[]>> = Object.freeze({
  'pure-transform': ['plan-research', 'plan-connector'],
  'data-pipeline': ['plan-research', 'plan-connector'],
  'ui-artifact': ['plan-research', 'plan-connector'],
  'automation-recipe': ['plan-research', 'plan-connector'],
  'research-helper': ['plan-connector'],
  'connector-wrapper': ['plan-research'],
})

/* --------------------------------------------------------------- statuses */

/**
 * The deployment lifecycle, as one closed table.
 *
 * ```
 *   candidate → generated → validating → verified → installed → enabled
 *      │            │            │           │          │         │
 *      └────────────┴────────────┴───────────┴──────────┴─────────┴──→ rejected
 *                                                       disabled ⇄ enabled
 *   any installed state ──→ quarantined ──→ removed
 *   a superseded version ──→ superseded
 * ```
 *
 * Three properties are load-bearing:
 *
 * 1. **`candidate` has zero authority.** It is what generation produces. It is
 *    not installed, not enabled, not runnable, and its `capabilities` field is a
 *    declaration nobody has checked yet.
 * 2. **`installed` is not `enabled`.** There is no edge between them in either
 *    direction without an explicit act; `install` never sets `enabled`, and
 *    `enabled → disabled` is the owner's own revocation.
 * 3. **`quarantined` and `removed` are terminal for running.** A quarantined
 *    package keeps its history and its body so the refusal can be read, and it
 *    cannot be enabled or run until it is validated again as a *new* version.
 */
export const FORGE_STATUSES = [
  'candidate',
  'generated',
  'validating',
  'verified',
  'rejected',
  'installed',
  'enabled',
  'disabled',
  'degraded',
  'quarantined',
  'superseded',
  'removed',
] as const
export type ForgeStatus = (typeof FORGE_STATUSES)[number]

export function isForgeStatus(value: unknown): value is ForgeStatus {
  return typeof value === 'string' && (FORGE_STATUSES as readonly string[]).includes(value)
}

/** Statuses from which nothing runs, whatever the caller says. */
export const FORGE_NON_RUNNABLE_STATUSES: readonly ForgeStatus[] = Object.freeze([
  'candidate',
  'generated',
  'validating',
  'rejected',
  'degraded',
  'quarantined',
  'superseded',
  'removed',
])

export const FORGE_TRANSITIONS: Readonly<Record<ForgeStatus, readonly ForgeStatus[]>> = Object.freeze({
  candidate: ['generated', 'validating', 'verified', 'rejected'],
  generated: ['validating', 'verified', 'rejected', 'quarantined'],
  validating: ['verified', 'rejected', 'quarantined'],
  verified: ['installed', 'superseded', 'removed', 'rejected', 'quarantined'],
  rejected: ['quarantined', 'removed'],
  installed: ['enabled', 'disabled', 'degraded', 'quarantined', 'superseded', 'removed'],
  enabled: ['disabled', 'degraded', 'quarantined', 'superseded'],
  disabled: ['enabled', 'degraded', 'quarantined', 'superseded', 'removed'],
  degraded: ['disabled', 'quarantined', 'removed'],
  quarantined: ['removed'],
  superseded: ['removed'],
  removed: [],
})

export function canTransitionForge(from: ForgeStatus, to: ForgeStatus): boolean {
  return FORGE_TRANSITIONS[from].includes(to)
}

/* ------------------------------------------------------------ provenance */

/**
 * Where a candidate came from.
 *
 * `forge-generated` means a model was asked for it, so its provenance records the
 * model and a hash of the request and never records the response as truth.
 * `acquired-remote` means it came from somewhere else entirely and is therefore
 * *always* untrusted until validated, and always requires approval before it may
 * be enabled. There is no `trusted-remote`.
 */
export const FORGE_ORIGINS = ['owner-authored', 'forge-generated', 'local-import', 'acquired-remote'] as const
export type ForgeOrigin = (typeof FORGE_ORIGINS)[number]

export function isForgeOrigin(value: unknown): value is ForgeOrigin {
  return typeof value === 'string' && (FORGE_ORIGINS as readonly string[]).includes(value)
}

/** Signature/trust state. `unsupported` is a real answer, not a placeholder. */
export const FORGE_SIGNATURE_STATES = ['unsigned', 'unsupported'] as const
export type ForgeSignatureState = (typeof FORGE_SIGNATURE_STATES)[number]

export interface ForgeProvenance {
  readonly origin: ForgeOrigin
  /** Model id, when generation asked one. Metadata, never a claim about quality. */
  readonly model: string | null
  /** Hash of the generation request. The response body is never journaled. */
  readonly requestHash: string | null
  /** Where the candidate was produced, as a bounded slug or a host-neutral ref. */
  readonly originRef: string | null
  readonly createdAt: string
}

/* ----------------------------------------------------------------- access */

/**
 * The access a package *declares*.
 *
 * Two values only, and the names are the point: `denied` and `declared`. There is
 * no `granted` here, because granting is not a package's business — it is Core's,
 * through the capability vocabulary, and the declaration only ever has to be
 * checked against what already exists.
 *
 * A declaration is never an authorisation. `network: 'declared'` says "this
 * package would need the network"; it does not give it one, and in this build the
 * sandbox cannot use one regardless.
 */
export const FORGE_ACCESS_LEVELS = ['denied', 'declared'] as const
export type ForgeAccessLevel = (typeof FORGE_ACCESS_LEVELS)[number]

export function isForgeAccessLevel(value: unknown): value is ForgeAccessLevel {
  return typeof value === 'string' && (FORGE_ACCESS_LEVELS as readonly string[]).includes(value)
}

export interface ForgeAccessDeclaration {
  readonly network: ForgeAccessLevel
  readonly filesystem: ForgeAccessLevel
  readonly device: ForgeAccessLevel
  readonly keyring: ForgeAccessLevel
  readonly process: ForgeAccessLevel
}

export const DENIED_ACCESS: ForgeAccessDeclaration = Object.freeze({
  network: 'denied',
  filesystem: 'denied',
  device: 'denied',
  keyring: 'denied',
  process: 'denied',
})

export const FORGE_ACCESS_FIELDS = ['network', 'filesystem', 'device', 'keyring', 'process'] as const
export type ForgeAccessField = (typeof FORGE_ACCESS_FIELDS)[number]

/* ----------------------------------------------------------------- schema */

/** Closed value types. There is no `object` type a program can walk. */
export const FORGE_FIELD_TYPES = ['string', 'number', 'boolean', 'list', 'record'] as const
export type ForgeFieldType = (typeof FORGE_FIELD_TYPES)[number]

export function isForgeFieldType(value: unknown): value is ForgeFieldType {
  return typeof value === 'string' && (FORGE_FIELD_TYPES as readonly string[]).includes(value)
}

export interface ForgeFieldSpec {
  readonly name: string
  readonly type: ForgeFieldType
  readonly required: boolean
  /** Bound on a string or list length. Ignored for the other types. */
  readonly maxLength: number
  /** For `record`: the closed set of keys the record may carry. */
  readonly keys: readonly string[]
}

export interface ForgeSchema {
  readonly fields: readonly ForgeFieldSpec[]
}

/* ---------------------------------------------------------------- program */

export type ForgeScalar = string | number | boolean | null
export type ForgeValue = ForgeScalar | ForgeScalar[] | { readonly [key: string]: ForgeValue }

export const FORGE_STRING_TRANSFORMS = [
  'upper',
  'lower',
  'trim',
  'reverse',
  'length',
  'slug',
  'strip-tags',
  'collapse-space',
] as const
export type ForgeStringTransform = (typeof FORGE_STRING_TRANSFORMS)[number]

export const FORGE_AGGREGATES = ['sum', 'count', 'min', 'max', 'mean'] as const
export type ForgeAggregate = (typeof FORGE_AGGREGATES)[number]

export const FORGE_PREDICATES = ['nonempty', 'numeric', 'longer-than'] as const
export type ForgePredicate = (typeof FORGE_PREDICATES)[number]

export const FORGE_VIEWS = ['text', 'list', 'table'] as const
export type ForgeView = (typeof FORGE_VIEWS)[number]

/**
 * The operation vocabulary. Closed, and every entry is pure.
 *
 * There is no entry here that reads the clock, the network, a file, a process, an
 * environment variable, a keyring, or a random number generator. That is not an
 * oversight to be fixed in a later phase — it is the reason this phase can claim
 * a sandbox at all.
 */
export type ForgeOp =
  | 'bind-input'
  | 'bind-const'
  | 'string-transform'
  | 'split'
  | 'join'
  | 'filter'
  | 'aggregate'
  | 'json-parse'
  | 'json-stringify'
  | 'select'
  | 'output'
  | 'plan-research'
  | 'plan-connector'
  | 'ui-view'
  | 'emit-recipe'

export const FORGE_OPS: readonly ForgeOp[] = Object.freeze([
  'bind-input',
  'bind-const',
  'string-transform',
  'split',
  'join',
  'filter',
  'aggregate',
  'json-parse',
  'json-stringify',
  'select',
  'output',
  'plan-research',
  'plan-connector',
  'ui-view',
  'emit-recipe',
])

export function isForgeOp(value: unknown): value is ForgeOp {
  return typeof value === 'string' && (FORGE_OPS as readonly string[]).includes(value)
}

/** Every op writes `to`, except `output` which publishes `from`. */
export const FORGE_OUTPUT_OPS: readonly ForgeOp[] = Object.freeze(['output'])

export interface ForgeStep {
  readonly op: ForgeOp
  /** Binding name. Absent only on `output`. */
  readonly to: string | null
  /** Source binding. */
  readonly from: string | null
  /** An inline scalar constant (`bind-const`). */
  readonly value?: ForgeScalar
  /** Transform, aggregate, predicate or view name, depending on `op`. */
  readonly fn?: string
  /** A literal separator or key, bounded. */
  readonly arg?: string
  /** A numeric bound for `longer-than`. */
  readonly count?: number
  /** Bounded literal lists (`plan-research`, `plan-connector`, `emit-recipe`). */
  readonly items?: readonly string[]
}

export interface ForgeProgram {
  readonly steps: readonly ForgeStep[]
}

/* -------------------------------------------------------------- manifest */

/**
 * A validated, canonical package manifest.
 *
 * Produced by {@link parseForgeManifest} and by nothing else. Its
 * `integrityHash` is derived from {@link canonicalForgeManifest}, so a semantic
 * change produces a different hash and a re-serialisation of the same semantics
 * does not.
 */
export interface ForgeManifest {
  readonly name: string
  readonly version: number
  readonly description: string
  readonly runtime: ForgeRuntimeKind
  readonly inputs: ForgeSchema
  readonly outputs: ForgeSchema
  readonly capabilitiesRequired: readonly Capability[]
  readonly access: ForgeAccessDeclaration
  readonly dependencies: readonly ForgeDependency[]
  readonly tags: readonly string[]
  readonly program: ForgeProgram
  readonly provenance: ForgeProvenance
}

export interface ForgeDependency {
  readonly name: string
  /** Exact version. A range would be a silent upgrade waiting to happen. */
  readonly version: number
}

/* ------------------------------------------------------------- lifecycle */

export const FORGE_VALIDATION_STAGES = [
  'manifest',
  'dependencies',
  'integrity',
  'security',
  'tests',
  'capabilities',
  'approval',
] as const
export type ForgeValidationStage = (typeof FORGE_VALIDATION_STAGES)[number]

export const FORGE_STAGE_VERDICTS = ['pass', 'fail', 'not-applicable'] as const
export type ForgeStageVerdict = (typeof FORGE_STAGE_VERDICTS)[number]

export const FORGE_APPROVAL_STATES = ['not-required', 'pending', 'approved', 'refused'] as const
export type ForgeApprovalState = (typeof FORGE_APPROVAL_STATES)[number]

export interface ForgeApproval {
  readonly required: boolean
  readonly state: ForgeApprovalState
  readonly decidedBy: string | null
  readonly decidedAt: string | null
  readonly reason: string | null
}

export interface ForgeTestResult {
  readonly verdict: 'passed' | 'failed' | 'inconclusive'
  readonly ranAt: string
  readonly checks: number
  readonly failures: number
  /** Hash of the failure text. The text itself is never stored. */
  readonly failureHash: string | null
}

/** What one stage decided, in a form a projection and a test can both read. */
export interface ForgeStageResult {
  readonly stage: ForgeValidationStage
  readonly verdict: ForgeStageVerdict
  readonly code: ForgeRefusalCode | null
  readonly reason: string | null
}

export interface ForgeValidationReport {
  /** Always every stage, in pipeline order. A stage never disappears. */
  readonly stages: readonly ForgeStageResult[]
  readonly passed: boolean
  readonly failingStage: ForgeValidationStage | null
  readonly code: ForgeRefusalCode | null
  readonly reason: string | null
  readonly integrityHash: string | null
  readonly tests: ForgeTestResult | null
  readonly ranAt: string
}

/** A run's outcome. `interrupted` is a real state, not a missing one. */
export const FORGE_RUN_STATES = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'refused'] as const
export type ForgeRunState = (typeof FORGE_RUN_STATES)[number]

export const FORGE_RUN_FAILURE_CODES = [
  'input-schema-violation',
  'output-schema-violation',
  'input-too-large',
  'output-too-large',
  'step-budget-exhausted',
  'deadline-exceeded',
  'cancelled',
  'input-schema-violation',
  'output-schema-violation',
  'input-too-large',
  'output-too-large',
  'forbidden-operation',
  'unknown-binding',
  'type-mismatch',
  'invalid-data',
  'forbidden-operation',
  'program-invalid',
  'recovery-interrupted',
] as const
export type ForgeRunFailureCode = (typeof FORGE_RUN_FAILURE_CODES)[number]

/**
 * The failures that are evidence about the *package* rather than about the caller.
 *
 * A payload that did not match the contract, or a run that was cancelled or ran out
 * of time, says nothing about whether the package works — so those do not degrade it,
 * because degrading on them would let anyone who can type the wrong shape switch a
 * working package off. A run that died inside the program on data it should have
 * handled is evidence about the package, and that does degrade it.
 */
export const FORGE_PACKAGE_DEFECT_CODES: readonly ForgeRunFailureCode[] = Object.freeze([
  'invalid-data',
  'type-mismatch',
  'unknown-binding',
  'program-invalid',
  'forbidden-operation',
])

export function isForgePackageDefect(code: ForgeRunFailureCode): boolean {
  return FORGE_PACKAGE_DEFECT_CODES.includes(code)
}

export interface ForgeRunMetrics {
  readonly opsUsed: number
  readonly inputChars: number
  readonly outputChars: number
  readonly durationMs: number
}

export interface ForgeRunRecord {
  readonly runId: string
  readonly skillId: string
  readonly version: number
  readonly state: ForgeRunState
  readonly failure: ForgeRunFailureCode | null
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly idempotencyKey: string | null
  readonly inputHash: string | null
  readonly metrics: ForgeRunMetrics | null
  readonly outputHash: string | null
}

/* ------------------------------------------------------------- refusals */

/**
 * Every refusal Forge can state, in one closed list.
 *
 * Closed so a surface can branch on a code instead of parsing a sentence, and so
 * a test can assert that a refusal is one of these rather than "some string". The
 * list is read by the payload validators in `core/events/validate.ts`, so a code
 * that exists here is a code a journal line may carry.
 */
export const FORGE_REFUSAL_CODES = [
  'malformed-command',
  'no-payload',
  'unknown-command',
  'malformed-manifest',
  'unknown-runtime',
  'schema-invalid',
  'dependency-refused',
  'dependency-missing',
  'dependency-cycle',
  'integrity-mismatch',
  'identical-version',
  'version-conflict',
  'downgrade-not-explicit',
  'no-such-package',
  'no-such-version',
  'unknown-capability',
  'forbidden-capability',
  'capability-not-registered',
  'capability-not-held',
  'approval-required',
  'approval-refused',
  'security-finding',
  'tests-failed',
  'program-invalid',
  'impossible-access-declaration',
  'path-traversal',
  'protected-core-reference',
  'forbidden-host-api',
  'secret-access',
  'unrestricted-network',
  'hidden-dependency',
  'grant-metadata-tampering',
  'oversized-source',
  'illegal-transition',
  'not-installed',
  'not-enabled',
  'not-verified',
  'quarantined',
  'removed',
  'stop-all',
  'cancelled',
  'input-schema-violation',
  'output-schema-violation',
  'input-too-large',
  'output-too-large',
  'forbidden-operation',
  'deadline-exceeded',
  'run-failed',
  'run-budget-exceeded',
  'invalid-input',
  'invalid-data',
  'type-mismatch',
  'unknown-binding',
  'step-budget-exhausted',
  'invalid-output',
  'limit-exceeded',
  'recovery-interrupted',
  'degraded-store',
  'unsupported-runtime',
] as const
export type ForgeRefusalCode = (typeof FORGE_REFUSAL_CODES)[number]

export function isForgeRefusalCode(value: unknown): value is ForgeRefusalCode {
  return typeof value === 'string' && (FORGE_REFUSAL_CODES as readonly string[]).includes(value)
}

/** The closed findings a static security scan may report. */
export const FORGE_SECURITY_FINDINGS = [
  'path-traversal',
  'protected-core-reference',
  'forbidden-host-api',
  'secret-access',
  'unrestricted-network',
  'hidden-dependency',
  'grant-metadata-tampering',
  'oversized-source',
  'impossible-access-declaration',
] as const
export type ForgeSecurityFinding = (typeof FORGE_SECURITY_FINDINGS)[number]

/**
 * The specific management capabilities above the prefixes.
 *
 * Each one decides something about *other* things rather than doing a bounded piece
 * of work: approving a merge, rolling one back, activating an acquisition, approving
 * a relay action, or admitting and retiring a procedure. A package that needs any of
 * these is not a bounded module; it is a second way of deciding.
 */
const FORGE_MANAGEMENT_CAPABILITIES: readonly Capability[] = [
  'cognition.grant.manage',
  'work.approval.decide',
  'mission.manage',
  'work.run.manage',
  'skill.manage',
  'improvement.merge.approve',
  'improvement.rollback',
  'acquisition.activation.manage',
  'relay.approval.decide',
]

/* --------------------------------------------------------------- limits */

export const FORGE_LIMITS = Object.freeze({
  maxPackages: 200,
  maxVersionsPerPackage: 20,
  maxProgramSteps: 64,
  maxOpsPerRun: 64,
  maxInputs: 12,
  maxOutputs: 12,
  maxTags: 12,
  maxDependencies: 8,
  maxCapabilities: 6,
  maxNameChars: 64,
  maxDescriptionChars: 400,
  maxRefChars: 128,
  maxArgChars: 64,
  maxItemsPerLiteral: 12,
  maxInputChars: 8_192,
  maxOutputChars: 8_192,
  maxStringLength: 2_048,
  maxListLength: 64,
  maxDepth: 3,
  maxManifestBytes: 24_576,
  maxRecordKeys: 12,
  defaultRunBudgetMs: 1_000,
  maxRunBudgetMs: 10_000,
  maxRetainedRuns: 64,
  maxRejections: 32,
})

/* ------------------------------------------------------------- utilities */

/** The deterministic id of a package, derived from its normalised name. */
export function forgePackageId(normalisedName: string): string {
  return deriveSkillId(normalisedName)
}

/**
 * Capabilities a package may never declare.
 *
 * Every one of them decides whether Freya may act, so a generated package that
 * declares one is laundering authority through a manifest field. The list is the
 * Skill domain's forbidden list plus the Foundry and Forge management
 * capabilities, because a package that can install packages, activate artifacts
 * or manage Forge is not a bounded module either.
 */
export const FORGE_FORBIDDEN_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter(
  (capability) =>
    capability.startsWith('security.') ||
    capability.startsWith('foundry.') ||
    capability.startsWith('forge.') ||
    FORGE_MANAGEMENT_CAPABILITIES.includes(capability),
)

export function isForbiddenForgeCapability(value: Capability): boolean {
  return FORGE_FORBIDDEN_CAPABILITIES.includes(value)
}

/** The name shape: lower-case letters, digits and single dashes. */
export function normaliseForgeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (name.length === 0 || name.length > FORGE_LIMITS.maxNameChars) return null
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null
  if (name.includes('--')) return null
  return name
}

/** Bounded, control-character-free text. Used for descriptions and reasons. */
export function sanitiseForgeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[ -]/g, ' ').trim().slice(0, max)
}

/**
 * Canonical JSON with fixed key order.
 *
 * The integrity hash is taken over this, so it has to be *order-independent for
 * objects* and *order-dependent for lists* — a list is a program, and reordering
 * its steps is a change.
 */
export function canonicalForgeJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalForgeJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalForgeJson(record[key])}`).join(',')}}`
}

/** The exact bytes the integrity hash is taken over. */
export function canonicalForgeManifest(manifest: ForgeManifest): string {
  return canonicalForgeJson({
    access: manifest.access,
    capabilities: manifest.capabilitiesRequired,
    dependencies: manifest.dependencies,
    description: manifest.description,
    inputs: manifest.inputs,
    name: manifest.name,
    outputs: manifest.outputs,
    program: manifest.program,
    runtime: manifest.runtime,
    tags: manifest.tags,
    version: manifest.version,
  })
}
