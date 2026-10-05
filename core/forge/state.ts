import type { AnyCoreEvent } from '../events/envelope'
import { FORGE_LIMITS, FORGE_TRANSITIONS } from './types'
import type {
  ForgeAccessLevel,
  ForgeApproval,
  ForgeOrigin,
  ForgeRefusalCode,
  ForgeRunRecord,
  ForgeRuntimeKind,
  ForgeStageVerdict,
  ForgeStatus,
  ForgeValidationStage,
} from './types'

/**
 * THE FORGE FOLD — what exists, derived from the journal and nothing else.
 *
 * Same rule as every other domain here: **the fold decides what exists.** Status,
 * version, verification, approval, quarantine and run outcomes come from
 * `forge.*` events; nothing in this file reads a live map a caller could have
 * written, and no caller can move a package by handing the engine a status.
 *
 * ## Metadata only
 *
 * The journal holds ids, slugs, closed labels, versions, hashes, counts, measured
 * lengths, instants and closed codes. It holds **no program, no description, no
 * input and no output**. That is what lets a backup or a support bundle be
 * harmless, and it is why a package body has to come from the store before it can
 * run — a journal entry vouches for a version, the store holds what it said.
 *
 * ## What a forged line cannot do
 *
 * Every transition here is checked against `canTransitionForge`, so a hand-written
 * `candidate → enabled` line is refused by the fold as well as by the engine. And
 * every version's status is derived, never assigned: a line claiming
 * `forge.enabled` for a version the fold never saw installed changes nothing,
 * because the reducer marks the *version* enabled only when it can also name a
 * version whose status admits it.
 */

export interface ForgeVersionState {
  readonly version: number
  readonly integrityHash: string
  readonly status: ForgeStatus
  readonly validationPassed: boolean
  readonly validationRanAt: string | null
  readonly failingStage: ForgeValidationStage | null
  readonly failingCode: ForgeRefusalCode | null
  readonly stageVerdicts: readonly ForgeStageVerdict[]
  readonly testChecks: number
  readonly testFailures: number
  readonly approval: ForgeApproval
  readonly installedAt: string | null
  readonly enabledAt: string | null
  readonly disabledAt: string | null
  readonly quarantinedAt: string | null
  readonly quarantineReason: string | null
  readonly supersededBy: number | null
  readonly removedAt: string | null
}

export type ForgeRunSummary = ForgeRunRecord

export interface ForgeRecord {
  readonly skillId: string
  readonly name: string
  readonly runtime: ForgeRuntimeKind
  readonly origin: ForgeOrigin
  readonly model: string | null
  readonly requestHash: string | null
  readonly originRef: string | null
  readonly descriptionLength: number
  readonly tags: readonly string[]
  readonly declaredCapabilities: readonly string[]
  readonly accessNetwork: ForgeAccessLevel
  readonly accessDevice: ForgeAccessLevel
  readonly dependencyCount: number
  readonly programStepCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly versions: ReadonlyMap<number, ForgeVersionState>
  readonly currentVersion: number
  /** Every version that was ever installed, ascending. Distinct from versions. */
  readonly installedVersions: readonly number[]
  readonly enabledVersion: number | null
  readonly installedVersion: number | null
  readonly runs: readonly ForgeRunRecord[]
  readonly rejections: readonly { readonly code: ForgeRefusalCode; readonly skillId: string | null; readonly at: string }[]
}

export interface ForgeState {
  readonly sequence: number
  readonly packages: ReadonlyMap<string, ForgeRecord>
  readonly rejections: readonly { readonly code: ForgeRefusalCode; readonly skillId: string | null; readonly at: string }[]
  /** Every run ever seen, keyed by run id, so recovery can find the interrupted ones. */
  readonly runs: ReadonlyMap<string, ForgeRunRecord>
}

export function initialForgeState(): ForgeState {
  return { sequence: 0, packages: new Map(), rejections: [], runs: new Map() }
}

const NO_APPROVAL: ForgeApproval = Object.freeze({
  required: false,
  state: 'not-required' as const,
  decidedBy: null,
  decidedAt: null,
  reason: null,
})

export function findForgePackage(state: ForgeState, skillId: string): ForgeRecord | null {
  return state.packages.get(skillId) ?? null
}

export function findForgePackageByName(state: ForgeState, name: string): ForgeRecord | null {
  for (const record of state.packages.values()) {
    if (record.name === name) return record
  }
  return null
}

export function findForgeVersion(state: ForgeState, skillId: string, version: number): ForgeVersionState | null {
  return state.packages.get(skillId)?.versions.get(version) ?? null
}

/** Every version summary, for the versioning planner. */
export function versionSummaryOf(record: ForgeRecord): {
  versions: readonly number[]
  currentVersion: number | null
  installedVersions: readonly number[]
  installedVersion: number | null
  hashes: Readonly<Record<number, string>>
} {
  const hashes: Record<number, string> = {}
  for (const [version, value] of record.versions) hashes[version] = value.integrityHash
  return {
    versions: [...record.versions.keys()].sort((left, right) => left - right),
    currentVersion: record.currentVersion,
    installedVersions: record.installedVersions,
    installedVersion: record.installedVersion,
    hashes,
  }
}

export function summariseForgeCounts(state: ForgeState): {
  packages: number
  candidates: number
  installed: number
  enabled: number
  disabled: number
  quarantined: number
  removed: number
  runs: number
  interruptedRuns: number
  rejections: number
} {
  let candidates = 0
  let installed = 0
  let enabled = 0
  let disabled = 0
  let quarantined = 0
  let removed = 0
  for (const record of state.packages.values()) {
    const current = record.versions.get(record.currentVersion)
    const status = current?.status ?? 'candidate'
    if (status === 'candidate' || status === 'generated' || status === 'validating' || status === 'verified') candidates += 1
    if (status === 'installed') installed += 1
    if (status === 'enabled') enabled += 1
    if (status === 'disabled' || status === 'degraded') disabled += 1
    if (status === 'quarantined') quarantined += 1
    if (status === 'removed') removed += 1
  }
  let interrupted = 0
  for (const run of state.runs.values()) {
    if (run.state === 'interrupted') interrupted += 1
  }
  return {
    packages: state.packages.size,
    candidates,
    installed,
    enabled,
    disabled,
    quarantined,
    removed,
    runs: state.runs.size,
    interruptedRuns: interrupted,
    rejections: state.rejections.length,
  }
}

/* ------------------------------------------------------------------- fold */

export function isForgeEvent(event: AnyCoreEvent): boolean {
  return event.type.startsWith('forge.')
}

function withVersion(
  record: ForgeRecord,
  version: number,
  update: (current: ForgeVersionState) => ForgeVersionState,
): ForgeRecord {
  const existing = record.versions.get(version)
  const base: ForgeVersionState = existing ?? newVersionState(version)
  const versions = new Map(record.versions)
  versions.set(version, update(base))
  return { ...record, versions }
}

function newVersionState(version: number): ForgeVersionState {
  return {
    version,
    integrityHash: '',
    status: 'candidate',
    validationPassed: false,
    validationRanAt: null,
    failingStage: null,
    failingCode: null,
    stageVerdicts: [],
    testChecks: 0,
    testFailures: 0,
    approval: NO_APPROVAL,
    installedAt: null,
    enabledAt: null,
    disabledAt: null,
    quarantinedAt: null,
    quarantineReason: null,
    supersededBy: null,
    removedAt: null,
  }
}

function canReach(current: ForgeStatus, next: ForgeStatus): boolean {
  return current === next || FORGE_TRANSITIONS[current].includes(next)
}

/**
 * Fold one event into the state.
 *
 * Total: an event that cannot apply — an unknown package, an illegal transition,
 * a version the record does not hold — returns the state unchanged rather than
 * inventing an exception. A journal that cannot be believed produces a smaller
 * truth, and the projection says so.
 */
export function reduceForgeState(state: ForgeState, event: AnyCoreEvent): ForgeState {
  if (!isForgeEvent(event)) return state
  const packages = new Map(state.packages)
  let rejections = state.rejections
  const runs: Map<string, ForgeRunRecord> = new Map(state.runs)

  switch (event.type) {
case 'forge.candidate.created': {
      const payload = event.payload
      const existing = packages.get(payload.skillId)
      if (packages.size >= FORGE_LIMITS.maxPackages && existing === undefined) {
        return { ...state, sequence: event.sequence }
      }
      const versions = new Map<number, ForgeVersionState>(existing?.versions ?? [])
      versions.set(
        payload.version,
        withIntegrity(newVersionState(payload.version), payload.integrityHash),
      )
      // A second candidate for a name that already exists **adds a version**. It does
      // not replace the record: doing that would wipe the version history, the
      // installed set, the run log and the quarantine reasons, and "which version is
      // installed?" would then have no answer. Generation is additive by construction,
      // which is what makes a retried generation idempotent.
      packages.set(payload.skillId, {
        skillId: payload.skillId,
        name: payload.name,
        runtime: payload.runtime,
        origin: existing?.origin ?? payload.origin,
        model: existing?.model ?? payload.model,
        requestHash: existing?.requestHash ?? payload.requestHash,
        originRef: existing?.originRef ?? payload.originRef,
        descriptionLength: payload.descriptionLength,
        tags: payload.tags,
        declaredCapabilities: payload.declaredCapabilities,
        accessNetwork: payload.accessNetwork,
        accessDevice: payload.accessDevice,
        dependencyCount: payload.dependencyCount,
        programStepCount: payload.programStepCount,
        createdAt: existing?.createdAt ?? payload.createdAt,
        updatedAt: payload.createdAt,
        versions,
        currentVersion: payload.version,
        installedVersions: existing?.installedVersions ?? [],
        enabledVersion: existing?.enabledVersion ?? null,
        installedVersion: existing?.installedVersion ?? null,
        runs: existing?.runs ?? [],
        rejections: existing?.rejections ?? [],
      })
      break
    }

    case 'forge.validation.recorded': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const verdicts = event.payload.stageVerdicts as readonly ForgeStageVerdict[]
      const updated = withVersion(record, event.payload.version, (current) => {
        const passed = event.payload.passed
        const next: ForgeStatus = passed ? 'verified' : 'rejected'
        const status = canReach(current.status, next) ? next : current.status
        return {
          ...current,
          integrityHash: event.payload.integrityHash,
          status,
          validationPassed: passed,
          validationRanAt: event.payload.ranAt,
          failingStage: event.payload.failingStage,
          failingCode: event.payload.code,
          stageVerdicts: verdicts,
          testChecks: event.payload.testChecks,
          testFailures: event.payload.testFailures,
        }
      })
      packages.set(updated.skillId, updated)
      break
    }

    case 'forge.installed': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const { version, integrityHash, installedAt } = event.payload
      if (!record.versions.has(version)) break
      // The version being installed becomes current, and any previously installed
      // version is superseded rather than silently left "installed" behind it.
      let updated = record
      if (record.installedVersion !== null && record.installedVersion !== version) {
        const previous = record.installedVersion
        updated = withVersion(updated, previous, (current) => ({ ...current, status: 'superseded', supersededBy: version }))
      }
      updated = withVersion(updated, version, (current) => {
        const status: ForgeStatus = canReach(current.status, 'installed') ? 'installed' : current.status
        return { ...current, integrityHash, status, installedAt }
      })
      if (updated.enabledVersion !== null && updated.enabledVersion !== version) {
        updated = { ...updated, enabledVersion: null }
      }
      updated = {
        ...updated,
        currentVersion: version,
        installedVersion: version,
        installedVersions: updated.installedVersions.includes(version)
          ? updated.installedVersions
          : [...updated.installedVersions, version].sort((left, right) => left - right),
      }
      packages.set(updated.skillId, updated)
      break
    }

    case 'forge.enabled': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const version = record.versions.get(event.payload.version)
      if (version === undefined) break
      // Only a version that is actually installed may be enabled. This is the
      // structural half of "install does not auto-enable": the fold will not
      // honour the line if install never happened.
      if (version.status !== 'installed') break
      let updated = withVersion(record, event.payload.version, (current) => ({
        ...current,
        status: 'enabled',
        enabledAt: event.payload.enabledAt,
      }))
      updated = { ...updated, enabledVersion: event.payload.version }
      packages.set(updated.skillId, updated)
      break
    }

    case 'forge.disabled': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const version = record.versions.get(event.payload.version)
      if (version === undefined) break
      if (version.status !== 'enabled') break
      const updated = withVersion(record, event.payload.version, (current) => ({
        ...current,
        status: 'disabled',
        disabledAt: event.payload.disabledAt,
      }))
      packages.set(updated.skillId, { ...updated, enabledVersion: null })
      break
    }

    case 'forge.rolledback': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const { toVersion, at } = event.payload
      if (!record.versions.has(toVersion)) break
      let updated = withVersion(record, toVersion, (current) => ({
        ...current,
        status: current.installedAt === null ? 'verified' : 'installed',
        quarantinedAt: null,
        quarantineReason: null,
        supersededBy: null,
        enabledAt: null,
      }))
      if (updated.enabledVersion !== null && updated.enabledVersion !== toVersion) {
        updated = { ...updated, enabledVersion: null }
      }
      updated = {
        ...updated,
        currentVersion: toVersion,
        installedVersion: toVersion,
        installedVersions: updated.installedVersions.includes(toVersion)
          ? updated.installedVersions
          : [...updated.installedVersions, toVersion].sort((left, right) => left - right),
        updatedAt: at,
      }
      packages.set(updated.skillId, updated)
      break
    }

    case 'forge.quarantined': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const version = record.versions.get(event.payload.version)
      if (version === undefined) break
      const updated = withVersion(record, event.payload.version, (current) => ({
        ...current,
        status: 'quarantined',
        quarantinedAt: event.payload.at,
        quarantineReason: event.payload.code,
        enabledAt: null,
      }))
      packages.set(updated.skillId, { ...updated, enabledVersion: null })
      break
    }

    case 'forge.degraded': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const version = record.versions.get(event.payload.version)
      if (version === undefined) break
      const updated = withVersion(record, event.payload.version, (current) => ({
        ...current,
        status: 'degraded',
        quarantineReason: event.payload.code,
        enabledAt: null,
      }))
      packages.set(updated.skillId, { ...updated, enabledVersion: null })
      break
    }

    case 'forge.removed': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const version = record.versions.get(event.payload.version)
      if (version === undefined) break
      const updated = withVersion(record, event.payload.version, (current) => ({
        ...current,
        status: 'removed',
        removedAt: event.payload.at,
        enabledAt: null,
      }))
      packages.set(updated.skillId, { ...updated, enabledVersion: null })
      break
    }

    case 'forge.approval.recorded': {
      const record = packages.get(event.payload.skillId)
      if (record === undefined) break
      const version = record.versions.get(event.payload.version)
      if (version === undefined) break
      const updated = withVersion(record, event.payload.version, (current) => ({
        ...current,
        approval: {
          required: true,
          state: event.payload.state,
          decidedBy: event.payload.decidedBy,
          decidedAt: event.payload.decidedAt,
          reason: event.payload.reason,
        },
      }))
      packages.set(updated.skillId, updated)
      break
    }

    case 'forge.run.recorded': {
      const payload = event.payload
      const record = packages.get(payload.skillId)
      if (record === undefined) break
      const run: ForgeRunRecord = {
        runId: payload.runId,
        skillId: payload.skillId,
        version: payload.version,
        state: payload.state,
        failure: payload.failure,
        startedAt: payload.startedAt,
        finishedAt: payload.finishedAt,
        idempotencyKey: payload.idempotencyKey,
        inputHash: payload.inputHash,
        metrics: {
          opsUsed: payload.opsUsed,
          inputChars: 0,
          outputChars: payload.outputChars,
          durationMs: payload.durationMs,
        },
        outputHash: payload.outputHash,
      }
      runs.set(payload.runId, run)
      const kept = [...record.runs.filter((entry) => entry.runId !== payload.runId), run].slice(-FORGE_LIMITS.maxRetainedRuns)
      packages.set(record.skillId, { ...record, runs: kept })
      break
    }

    case 'forge.refused': {
      const skillId = event.payload.skillId
      const entry = { code: event.payload.code, skillId, at: event.payload.at }
      rejections = [...rejections, entry].slice(-FORGE_LIMITS.maxRejections)
      const record = skillId === null ? null : (packages.get(skillId) ?? null)
      if (record !== null && skillId !== null) {
        packages.set(skillId, {
          ...record,
          rejections: [...record.rejections, entry].slice(-FORGE_LIMITS.maxRejections),
        })
      }
      break
    }

    case 'forge.limit.exceeded':
      break

    default:
      break
  }

  return { sequence: event.sequence, packages, rejections, runs }
}

function withIntegrity(version: ForgeVersionState, hash: string): ForgeVersionState {
  return { ...version, integrityHash: hash }
}

