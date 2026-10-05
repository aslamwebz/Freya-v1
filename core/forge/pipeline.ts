import { FORGE_LIMITS, FORGE_VALIDATION_STAGES, isForbiddenForgeCapability, type ForgeValidationStage } from './types'
import type {
  ForgeApprovalState,
  ForgeManifest,
  ForgeRefusalCode,
  ForgeRunFailureCode,
  ForgeStageResult,
  ForgeTestResult,
  ForgeValidationReport,
} from './types'
import { forgeIntegrityHash } from './manifest'
import { scanForgeCandidate } from './security'
import { interpretForgeProgram, validateForgeProgram } from './program'
import type { Capability } from '../protocol/core-protocol'

/**
 * THE VALIDATION PIPELINE — the stages a candidate must pass, in order, every
 * time.
 *
 * ```
 *   candidate
 *     → manifest        static shape and schema
 *     → dependencies    explicit, exact-version, policy-checked, installed
 *     → integrity       the hash matches the bytes it claims to describe
 *     → security        static scan: paths, host APIs, secrets, grant tampering
 *     → tests           isolated execution over deterministic fixtures
 *     → capabilities    declared ⊆ registered, and the right kind of authority
 *     → approval        the owner's decision, where one is required
 *   → install          writes metadata only
 *   → enable           a separate, explicit act
 * ```
 *
 * ## Why a stage cannot be skipped by model output
 *
 * Because **no stage reads an assertion.** Every stage is a function of the
 * candidate's own bytes plus this Core's own registrations. There is no
 * `verified: true` in any payload, no field a generator can set that a later
 * stage trusts, and no path from a model response into a verdict. A caller that
 * wants `verified` runs the pipeline; a caller that says `verified` is talking to
 * a package that is still a `candidate`.
 *
 * The report always contains **every** stage, in order, even after one fails.
 * A truncated pipeline is the shape that lets a reader assume the later stages
 * were considered, so `runForgePipeline` reports the ones that did not run as
 * `not-applicable` with the reason they did not run.
 */

export interface ForgeInstalledSummary {
  readonly name: string
  readonly version: number
  readonly status: string
}

export interface ForgeValidationEnvironment {
  /** What this Core can actually execute. Read, never written. */
  readonly isCapabilityRegistered: (capability: Capability) => boolean
  /** Every package this Core has installed, for dependency resolution. */
  readonly installed: () => readonly ForgeInstalledSummary[]
  /** Whether the owner must approve this package before it may be enabled. */
  readonly approvalRequired: (manifest: ForgeManifest) => boolean
  /** The approval state recorded for this exact version. */
  readonly approvalState: (manifest: ForgeManifest) => ForgeApprovalState
}

export interface ForgePipelineInput {
  /** The candidate payload exactly as submitted. The security stage scans these bytes. */
  readonly payload: unknown
  /** The parsed manifest, or the refusal the parser returned. */
  readonly manifest: ForgeManifest | null
  readonly manifestCode: ForgeRefusalCode | null
  readonly manifestReason: string | null
  readonly integrityHash: string | null
  readonly environment: ForgeValidationEnvironment
  readonly ranAt: string
  /** Injected so a test can drive the deadline deterministically. */
  readonly monotonic?: () => number
}

function stage(
  name: ForgeValidationStage,
  verdict: ForgeStageResult['verdict'],
  code: ForgeRefusalCode | null = null,
  reason: string | null = null,
): ForgeStageResult {
  return { stage: name, verdict, code, reason }
}

/**
 * Run every stage, in order, and report the whole thing.
 *
 * Pure: no clock of its own, no I/O, no randomness. `ranAt` is supplied.
 */
export function runForgePipeline(input: ForgePipelineInput): ForgeValidationReport {
  const { manifest, environment } = input
  const stages: ForgeStageResult[] = []
  let failingStage: ForgeValidationStage | null = null
  let failingCode: ForgeRefusalCode | null = null
  let failingReason: string | null = null
  // A one-slot holder rather than a bare `let`, because the tests stage must not
  // run before the security stage has passed: an empty holder means "the stage
  // never happened", which is different from "the stage ran and produced nothing".
  const ran: ForgeTestResult[] = []

  const fail = (name: ForgeValidationStage, code: ForgeRefusalCode, reason: string): void => {
    stages.push(stage(name, 'fail', code, reason))
    if (failingStage === null) {
      failingStage = name
      failingCode = code
      failingReason = reason
    }
  }

  const skipRemaining = (from: ForgeValidationStage): void => {
    const start = FORGE_VALIDATION_STAGES.indexOf(from)
    for (let index = start + 1; index < FORGE_VALIDATION_STAGES.length; index += 1) {
      const name = FORGE_VALIDATION_STAGES[index]
      if (name === undefined) continue
      stages.push(stage(name, 'not-applicable', null, 'an earlier stage failed, so this one did not run'))
    }
  }

  /* 1. manifest */
  if (manifest === null) {
    fail(
      'manifest',
      input.manifestCode ?? 'malformed-manifest',
      input.manifestReason ?? 'the candidate could not be parsed as a package manifest',
    )
    skipRemaining('manifest')
    return report(input, stages, failingStage, failingCode, failingReason, null)
  }

  const structural = validateForgeProgram({
    program: manifest.program,
    runtime: manifest.runtime,
    inputs: manifest.inputs,
    outputs: manifest.outputs,
  })
  if (!structural.ok) {
    fail('manifest', structural.code === 'unknown-binding' ? 'program-invalid' : 'malformed-manifest', structural.reason ?? 'the program is not valid for this runtime')
    skipRemaining('manifest')
    return report(input, stages, failingStage, failingCode, failingReason, null)
  }
  if (!declaresOutputs(manifest)) {
    fail('manifest', 'schema-invalid', 'a package must publish at least one declared output')
    skipRemaining('manifest')
    return report(input, stages, failingStage, failingCode, failingReason, null)
  }
  stages.push(stage('manifest', 'pass'))

  /* 2. dependencies */
  const dependency = checkDependencies(manifest, environment.installed())
  if (dependency.code !== null) {
    fail('dependencies', dependency.code, dependency.reason ?? 'a dependency is not available to this Core')
    skipRemaining('dependencies')
    return report(input, stages, failingStage, failingCode, failingReason, null)
  }
  stages.push(stage('dependencies', 'pass'))

  /* 3. integrity */
  const recomputed = forgeIntegrityHash(manifest)
  if (input.integrityHash === null || input.integrityHash !== recomputed) {
    fail(
      'integrity',
      'integrity-mismatch',
      'the integrity hash does not describe these bytes, so the package is not the one that was validated',
    )
    skipRemaining('integrity')
    return report(input, stages, failingStage, failingCode, failingReason, null)
  }
  stages.push(stage('integrity', 'pass'))

  /* 4. security */
  const scan = scanForgeCandidate(input.payload, manifest)
  if (!scan.clean) {
    const first = scan.findings[0]
    fail('security', (first?.code ?? 'security-finding') as ForgeRefusalCode, first?.reason ?? 'the static scan found something the runtime refuses')
    skipRemaining('security')
    return report(input, stages, failingStage, failingCode, failingReason, null)
  }
  stages.push(stage('security', 'pass'))

  /* 5. tests */
  ran.push(runIsolatedTests(manifest, input.ranAt, input.monotonic ?? defaultMonotonic))
  const testResult = ran[0] as ForgeTestResult
  if (testResult.verdict !== 'passed') {
    fail(
      'tests',
      'tests-failed',
      `the isolated test run reported ${testResult.failures} of ${testResult.checks} batteries failing, so nothing downstream may read this candidate as verified`,
    )
    skipRemaining('tests')
    return report(input, stages, failingStage, failingCode, failingReason, ran[0] ?? null)
  }
  stages.push(stage('tests', 'pass'))

  /* 6. capabilities */
  const capability = auditCapabilities(manifest, environment)
  if (capability.code !== null) {
    fail('capabilities', capability.code, capability.reason ?? 'a declared capability cannot be admitted')
    skipRemaining('capabilities')
    return report(input, stages, failingStage, failingCode, failingReason, ran[0] ?? null)
  }
  stages.push(stage('capabilities', 'pass'))

  /* 7. approval */
  if (!environment.approvalRequired(manifest)) {
    stages.push(stage('approval', 'not-applicable', null, 'this package needs no owner approval to be enabled'))
  } else {
    const state = environment.approvalState(manifest)
    if (state === 'approved') {
      stages.push(stage('approval', 'pass', null, 'the owner approved this exact version'))
    } else if (state === 'refused') {
      fail('approval', 'approval-refused', 'the owner refused this exact version')
    } else if (state === 'not-required') {
      fail('approval', 'approval-required', 'this package needs an owner decision before it may be installed')
    } else {
      fail('approval', 'approval-required', 'this package is waiting for an owner decision before it may be installed')
    }
  }

  return report(input, stages, failingStage, failingCode, failingReason, ran[0] ?? null)
}

function report(
  input: ForgePipelineInput,
  stages: readonly ForgeStageResult[],
  failingStage: ForgeValidationStage | null,
  code: ForgeRefusalCode | null,
  reason: string | null,
  tests: ForgeTestResult | null,
): ForgeValidationReport {
  return {
    stages,
    passed: failingStage === null,
    failingStage,
    code,
    reason,
    integrityHash: input.integrityHash,
    tests,
    ranAt: input.ranAt,
  }
}

function declaresOutputs(manifest: ForgeManifest): boolean {
  return manifest.program.steps.some((step) => step.op === 'output')
}

function checkDependencies(
  manifest: ForgeManifest,
  installed: readonly ForgeInstalledSummary[],
): { code: ForgeRefusalCode | null; reason: string | null } {
  if (manifest.dependencies.some((dependency) => dependency.name === manifest.name)) {
    return { code: 'dependency-cycle', reason: 'a package may not depend on itself' }
  }
  for (const dependency of manifest.dependencies) {
    const found = installed.find((entry) => entry.name === dependency.name)
    if (found === undefined) {
      return {
        code: 'dependency-missing',
        reason: `${dependency.name} is not installed, and Forge installs nothing on a package's behalf`,
      }
    }
    if (dependency.version !== 0 && found.version !== dependency.version) {
      return {
        code: 'dependency-refused',
        reason: `${dependency.name} is installed at version ${found.version} and this package pins ${dependency.version}; Forge will not resolve a version for you`,
      }
    }
    if (found.status === 'quarantined' || found.status === 'removed') {
      return {
        code: 'dependency-refused',
        reason: `${dependency.name} is ${found.status}, and a ${found.status} package cannot be depended on`,
      }
    }
  }
  return { code: null, reason: null }
}

function auditCapabilities(
  manifest: ForgeManifest,
  environment: ForgeValidationEnvironment,
): { code: ForgeRefusalCode | null; reason: string | null } {
  // A pure, local package may not declare authority at all. The check is by
  // runtime kind rather than by trust class because it is about what the runtime
  // *can* do, and the three compute kinds cannot do anything with a capability.
  const computeOnly =
    manifest.runtime === 'pure-transform' ||
    manifest.runtime === 'data-pipeline' ||
    manifest.runtime === 'ui-artifact' ||
    manifest.runtime === 'automation-recipe'
  if (computeOnly && manifest.capabilitiesRequired.length > 0) {
    return {
      code: 'forbidden-capability',
      reason: `a ${manifest.runtime} package computes locally and may not declare any capability`,
    }
  }

  for (const capability of manifest.capabilitiesRequired) {
    if (isForbiddenForgeCapability(capability)) {
      return { code: 'forbidden-capability', reason: `${capability} decides whether Freya may act` }
    }
    if (!environment.isCapabilityRegistered(capability)) {
      return {
        code: 'capability-not-registered',
        reason: `this Core has no registered capability that needs ${capability}, so installing it would be a promise nobody can keep`,
      }
    }
  }

  if (manifest.runtime === 'research-helper' && !manifest.capabilitiesRequired.some((value) => value.startsWith('research.') || value === 'search.web')) {
    return {
      code: 'capability-not-registered',
      reason: 'a research helper must declare the research capability it is planning work for',
    }
  }
  if (
    manifest.runtime === 'connector-wrapper' &&
    !manifest.capabilitiesRequired.some((value) => value.startsWith('relay.'))
  ) {
    return {
      code: 'capability-not-registered',
      reason: 'a connector wrapper must declare the relay capability its connector would need',
    }
  }

  return { code: null, reason: null }
}

/**
 * The isolated test run.
 *
 * Deterministic by construction: fixtures are synthesised from the declared
 * schema, not from anything the candidate supplies, and there is no clock, no
 * randomness and no I/O. A candidate cannot make its own tests pass by choosing
 * their inputs, because it never sees them.
 *
 * Two batteries run: one with every field present, and one with every *optional*
 * field absent. A package that only works when an optional field happens to be
 * there has a contract its own schema denies.
 */
function runIsolatedTests(manifest: ForgeManifest, ranAt: string, monotonic: () => number): ForgeTestResult {
  const full = fixture(manifest, true)
  const minimal = fixture(manifest, false)
  const batteries: { label: string; input: Record<string, unknown> }[] = [
    { label: 'all-fields-present', input: full },
    { label: 'optional-fields-absent', input: minimal },
  ]

  let checks = 0
  let failures = 0
  let firstFailure: ForgeRunFailureCode | null = null

  for (const battery of batteries) {
    const outcome = interpretForgeProgram({
      program: manifest.program,
      runtime: manifest.runtime,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      input: battery.input,
      budgetMs: FORGE_LIMITS.defaultRunBudgetMs,
      isCancelled: () => false,
      monotonic,
    })
    checks += 1
    if (!outcome.ok) {
      failures += 1
      if (firstFailure === null) firstFailure = outcome.code
    }
  }

  return {
    verdict: checks === 0 ? 'inconclusive' : failures === 0 ? 'passed' : 'failed',
    ranAt,
    checks,
    failures,
    failureHash: firstFailure === null ? null : `fail:${firstFailure}`,
  }
}

function fixture(manifest: ForgeManifest, includeOptional: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of manifest.inputs.fields) {
    if (!includeOptional && !field.required) continue
    out[field.name] = sampleValue(field.type, field.keys)
  }
  return out
}

function sampleValue(type: string, keys: readonly string[]): unknown {
  switch (type) {
    case 'number':
      return 1
    case 'boolean':
      return true
    case 'list':
      return ['alpha', 'beta']
    case 'record': {
      const record: Record<string, unknown> = {}
      const key = keys[0]
      if (key !== undefined) record[key] = 'sample'
      return record
    }
    default:
      return 'sample'
  }
}

function defaultMonotonic(): number {
  return Date.now()
}
