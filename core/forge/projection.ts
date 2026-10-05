import {
  FORGE_RUNTIME_NOTICE,
  type ForgeCountsView,
  type ForgePackageView,
  type ForgeProjection,
  type ForgeRejectionView,
  type ForgeRunView,
  type ForgeSearchReportView,
  type ForgeStageView,
  type ForgeVersionView,
} from '../protocol/forge'
import { FORGE_LIMITS, type ForgeAccessDeclaration, type ForgeManifest, type ForgeRefusalCode } from './types'
import type { ForgeRecord, ForgeState, ForgeVersionState } from './state'
import { summariseForgeCounts } from './state'

/**
 * THE FORGE PROJECTION — the read-only vocabulary a window may hold.
 *
 * Built from the fold and from nothing else. The three rules it follows are the
 * same three every other projection in Core follows, and they are the reason
 * this file is short:
 *
 * 1. **No body crosses.** The program, the description, the inputs, the outputs
 *    and a run's payload are all absent. `ForgeDetailView` is the single
 *    explicit owner read, and it is one package at a time.
 * 2. **No source and no host path.** A package has no filesystem, so there is no
 *    field here that could leak one.
 * 3. **A refusal is a value.** Rejections are projected with their closed code,
 *    so a probing pattern cannot hide in the absence of a log line.
 *
 * The `runtimeNotice` is projected too, because the most useful thing a person
 * can know about a generated skill is the list of things it cannot do.
 */

export interface ForgeProjectionInput {
  readonly sequence: number
  readonly state: ForgeState
  readonly persistence: { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null }
  readonly lastSearch: ForgeSearchReportView | null
}

export function projectForge(input: ForgeProjectionInput): ForgeProjection {
  const packages: ForgePackageView[] = []
  for (const record of input.state.packages.values()) {
    packages.push(projectPackage(record))
  }
  packages.sort((left, right) => left.name.localeCompare(right.name))

  const rejections: ForgeRejectionView[] = [...input.state.rejections]
    .slice(-FORGE_LIMITS.maxRejections)
    .reverse()
    .map((entry) => ({ code: entry.code, skillId: entry.skillId, at: entry.at }))

  return {
    health: 'ready',
    reason: null,
    schemaVersion: 1,
    sequence: input.sequence,
    counts: summariseForgeCounts(input.state) as ForgeCountsView,
    packages,
    rejections,
    lastSearch: input.lastSearch,
    persistence: input.persistence,
    limits: {
      maxPackages: FORGE_LIMITS.maxPackages,
      maxProgramSteps: FORGE_LIMITS.maxProgramSteps,
      maxOpsPerRun: FORGE_LIMITS.maxOpsPerRun,
      maxInputChars: FORGE_LIMITS.maxInputChars,
      maxOutputChars: FORGE_LIMITS.maxOutputChars,
      maxRunBudgetMs: FORGE_LIMITS.maxRunBudgetMs,
    },
    runtimeNotice: FORGE_RUNTIME_NOTICE,
  }
}

function projectVersion(version: ForgeVersionState): ForgeVersionView {
  return {
    version: version.version,
    integrityHash: version.integrityHash,
    status: version.status,
    verified: version.validationPassed,
    validationRanAt: version.validationRanAt,
    failingStage: version.failingStage,
    failingCode: version.failingCode,
    stageVerdicts: version.stageVerdicts,
    testChecks: version.testChecks,
    testFailures: version.testFailures,
    approval: version.approval.state,
    installedAt: version.installedAt,
    enabledAt: version.enabledAt,
    quarantinedAt: version.quarantinedAt,
    quarantineReason: version.quarantineReason,
    supersededBy: version.supersededBy,
    removedAt: version.removedAt,
  }
}

function projectRun(record: ForgeRecord): ForgeRunView | null {
  const last = record.runs[record.runs.length - 1] ?? null
  if (last === null) return null
  return {
    runId: last.runId,
    version: last.version,
    state: last.state,
    failure: last.failure,
    startedAt: last.startedAt,
    finishedAt: last.finishedAt,
    opsUsed: last.metrics?.opsUsed ?? 0,
    outputChars: last.metrics?.outputChars ?? 0,
    durationMs: last.metrics?.durationMs ?? 0,
    interrupted: last.state === 'interrupted',
  }
}

function projectPackage(record: ForgeRecord): ForgePackageView {
  const current = record.versions.get(record.currentVersion)
  const versions = [...record.versions.values()].sort((left, right) => right.version - left.version)
  const newer = versions.find((version) => version.version > record.currentVersion && version.validationPassed)
  const last = record.runs[record.runs.length - 1] ?? null

  return {
    skillId: record.skillId,
    name: record.name,
    runtime: record.runtime,
    version: record.currentVersion,
    status: current?.status ?? 'candidate',
    enabled: record.enabledVersion !== null,
    integrityHash: current?.integrityHash ?? '',
    origin: record.origin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    descriptionLength: record.descriptionLength,
    tags: record.tags,
    declaredCapabilityCount: record.declaredCapabilities.length,
    dependencyCount: record.dependencyCount,
    programStepCount: record.programStepCount,
    access: {
      network: record.accessNetwork,
      filesystem: 'denied',
      device: record.accessDevice,
      keyring: 'denied',
      process: 'denied',
    },
    approval: current?.approval.state ?? 'not-required',
    verified: current?.validationPassed ?? false,
    quarantineReason: (current?.quarantineReason as ForgeRefusalCode | undefined) ?? null,
    updateAvailable: newer !== undefined,
    updateVersion: newer?.version ?? null,
    lastRun: last === null ? null : projectRun(record),
    versions: versions.map(projectVersion),
  }
}

/** The detail view: the one place a body is allowed to cross. */
export function forgeDetailView(
  record: ForgeRecord,
  manifest: ForgeManifest,
  integrityHash: string,
): {
  skillId: string
  name: string
  runtime: ForgeManifest['runtime']
  version: number
  integrityHash: string
  description: string
  declaredCapabilities: readonly string[]
  access: ForgeAccessDeclaration
  dependencies: readonly { name: string; version: number }[]
  inputs: readonly { name: string; type: string; required: boolean }[]
  outputs: readonly { name: string; type: string; required: boolean }[]
  program: readonly { op: string; to: string | null; from: string | null }[]
  provenance: ForgeManifest['provenance']
} {
  return {
    skillId: record.skillId,
    name: manifest.name,
    runtime: manifest.runtime,
    version: manifest.version,
    integrityHash,
    description: manifest.description,
    declaredCapabilities: [...manifest.capabilitiesRequired],
    access: manifest.access,
    dependencies: manifest.dependencies.map((dependency) => ({ name: dependency.name, version: dependency.version })),
    inputs: manifest.inputs.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
    })),
    outputs: manifest.outputs.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
    })),
    program: manifest.program.steps.map((step) => ({ op: step.op, to: step.to, from: step.from })),
    provenance: manifest.provenance,
  }
}

export function stageViews(
  stages: readonly { stage: ForgeStageView['stage']; verdict: ForgeStageView['verdict']; code: ForgeStageView['code'] }[],
): readonly ForgeStageView[] {
  return stages.map((entry) => ({ stage: entry.stage, verdict: entry.verdict, code: entry.code }))
}
