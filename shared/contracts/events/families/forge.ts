import type { Capability } from '../../capabilities'

import type {
  ForgeAccessLevel,
  ForgeOrigin,
  ForgeRefusalCode,
  ForgeRunFailureCode,
  ForgeRunState,
  ForgeRuntimeKind,
  ForgeStageVerdict,
  ForgeValidationStage,
} from '../vocabulary/forge.ts'

export const FORGE_EVENT_TYPES = [
// Forge (Phase 48) — metadata only, and the family where the *body* is absent.
  //
  // A Forge package is a generated or acquired program. The program itself, its
  // description, a run's input and a run's output are **not in this journal** —
  // they live in the encrypted body store, and this family records only that a
  // version exists, what it hashes to, what state it is in, what the pipeline
  // decided, and how a run ended.
  //
  // There is no `forge.installed` that also enables, and there is no event whose
  // name could be read as "a generated package became trusted Core code". The
  // vocabulary is deliberately small: a candidate was created, a validation ran,
  // a version was installed, enabled, disabled, rolled back, quarantined, degraded
  // or removed, an approval was recorded, a run started and ended, and something
  // was refused. Every payload is an id, a slug, a closed label, a closed code, an
  // integer, a measured length, a hash or an instant.
  'forge.candidate.created',
'forge.validating.recorded',
'forge.validation.recorded',
'forge.installed',
'forge.enabled',
'forge.disabled',
'forge.rolledback',
'forge.quarantined',
'forge.degraded',
'forge.removed',
'forge.approval.recorded',
'forge.run.recorded',
/**
   * An attempt was refused.
   *
   * Journalled rather than dropped, for the same reason `skill.proposal.rejected`
   * exists: a refusal pattern is what an investigation needs, and the payload is a
   * closed code plus an id — never the text that was refused.
   */
  'forge.refused',
'forge.limit.exceeded',
] as const

export interface ForgeEventPayloads {
/* --------------------------------------------------------------- forge */

  /**
   * A candidate package exists, as a version, with a hash.
   *
   * `declaredCapabilities` is the one list here, and it is a list of **Guard
   * vocabulary entries** rather than the package's own words — a capability map
   * that survives a restart is exactly the thing an attacker would want to edit,
   * so the fold stores the closed names and re-derives the permission question at
   * install and at every run. It is bounded by the domain's own limit.
   */
  'forge.candidate.created': {
    skillId: string
    name: string
    runtime: ForgeRuntimeKind
    version: number
    integrityHash: string
    origin: ForgeOrigin
    model: string | null
    requestHash: string | null
    originRef: string | null
    accessNetwork: ForgeAccessLevel
    accessDevice: ForgeAccessLevel
    declaredCapabilities: Capability[]
    tags: string[]
    dependencyCount: number
    programStepCount: number
    descriptionLength: number
    createdAt: string
  }

/** A validation attempt began. Distinct from its result so an audit can see the attempt. */
  'forge.validating.recorded': {
    skillId: string
    version: number
    integrityHash: string
    startedAt: string
  }

/**
   * The whole pipeline's result, as one verdict and one closed code per stage.
   *
   * `stageVerdicts` always has one entry per stage in pipeline order, including
   * the stages that did not run — a truncated pipeline is the shape that lets a
   * reader assume the rest was considered.
   */
  'forge.validation.recorded': {
    skillId: string
    version: number
    integrityHash: string
    passed: boolean
    failingStage: ForgeValidationStage | null
    code: ForgeRefusalCode | null
    ranAt: string
    stageVerdicts: ForgeStageVerdict[]
    testChecks: number
    testFailures: number
  }

'forge.installed': {
    skillId: string
    version: number
    integrityHash: string
    action: 'install-new' | 'upgrade' | 'downgrade'
    installedAt: string
  }

'forge.enabled': {
    skillId: string
    version: number
    enabledAt: string
  }

'forge.disabled': {
    skillId: string
    version: number
    disabledAt: string
    reason: string
  }

'forge.rolledback': {
    skillId: string
    fromVersion: number
    toVersion: number
    at: string
  }

'forge.quarantined': {
    skillId: string
    version: number
    code: ForgeRefusalCode
    reason: string
    at: string
  }

'forge.degraded': {
    skillId: string
    version: number
    code: ForgeRunFailureCode
    reason: string
    at: string
  }

'forge.removed': {
    skillId: string
    version: number
    at: string
    reason: string
  }

'forge.approval.recorded': {
    skillId: string
    version: number
    state: 'approved' | 'refused'
    decidedBy: string
    decidedAt: string
    reason: string
  }

/**
   * A run, twice: once when it starts and once when it ends.
   *
   * A run whose `finishedAt` is null is one that was in flight. Recovery turns
   * those into `interrupted` rather than retrying them, because a result that was
   * not durably recorded did not provably happen.
   */
  'forge.run.recorded': {
    runId: string
    skillId: string
    version: number
    state: ForgeRunState
    failure: ForgeRunFailureCode | null
    startedAt: string
    finishedAt: string | null
    idempotencyKey: string | null
    inputHash: string | null
    opsUsed: number
    outputChars: number
    durationMs: number
    outputHash: string | null
  }

'forge.refused': {
    code: ForgeRefusalCode
    skillId: string | null
    at: string
  }

'forge.limit.exceeded': {
    limit: string
    reason: string
  }
}