import type {
  ForgeAccessLevel,
  ForgeApprovalState,
  ForgeOrigin,
  ForgeRefusalCode,
  ForgeRunState,
  ForgeRuntimeKind,
  ForgeStatus,
  ForgeValidationStage,
} from '../forge/types'

/**
 * THE FORGE PROTOCOL — what a window may know about packages and candidates.
 *
 * A **view**, not a channel. Everything here is built by Core, is read-only, and
 * is a mirror of state Core already decided. No field in this file can be written
 * by a caller, and no command in this vocabulary asserts a verdict.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, slugs, closed labels, versions, integrity hashes, instants,
 * counts, validation *verdicts and closed stage codes*, approval **states**,
 * last-run **outcomes with their metrics**, and the reason a package is
 * quarantined.
 *
 * Does not cross:
 *
 * - **A program.** Not one step, not one binding, not one literal. The program is
 *   Freya's own content and it lives in the encrypted body store; `forge.detail.read`
 *   is the single explicit owner read, exactly as `skill.detail.read` is for a
 *   procedure body.
 * - **Input or output of a run.** A projection that carried a run's payload would
 *   be a standing feed of everything anyone pasted into Freya. Runs cross as
 *   hashes, counts and verdicts.
 * - **Host paths.** Nothing in this protocol carries a path, because a package has
 *   none: the runtime has no filesystem to name.
 * - **The capability *list* on the list projection.** As with Skills, counts by
 *   default — see {@link ForgePackageView.declaredCapabilityCount}. The full list
 *   is on the owner-only detail read, which is where "what will this ask for?"
 *   gets answered without turning the catalog into a capability map.
 *
 * ## The sentence about the runtime
 *
 * `runtimeNotice` exists because the most important thing a person can know about
 * a generated skill is what it *cannot* do. Freya does not have a secure
 * general-purpose sandbox, so the supported runtime is a bounded declarative
 * subset; that is stated on the projection rather than left for someone to
 * discover by trying to write a plugin.
 */

/* ------------------------------------------------------------------ views */

/** One validation stage, as a verdict and a closed code. Never as free text. */
export interface ForgeStageView {
  readonly stage: ForgeValidationStage
  readonly verdict: 'pass' | 'fail' | 'not-applicable'
  readonly code: ForgeRefusalCode | null
}

export interface ForgeRunView {
  readonly runId: string
  readonly version: number
  readonly state: ForgeRunState
  readonly failure: string | null
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly opsUsed: number
  readonly outputChars: number
  readonly durationMs: number
  /** True when the run was still marked running when the process restarted. */
  readonly interrupted: boolean
}

export interface ForgeVersionView {
  readonly version: number
  readonly integrityHash: string
  readonly status: ForgeStatus
  readonly verified: boolean
  readonly validationRanAt: string | null
  readonly failingStage: ForgeValidationStage | null
  readonly failingCode: ForgeRefusalCode | null
  readonly stageVerdicts: readonly ('pass' | 'fail' | 'not-applicable')[]
  readonly testChecks: number
  readonly testFailures: number
  readonly approval: ForgeApprovalState
  readonly installedAt: string | null
  readonly enabledAt: string | null
  readonly quarantinedAt: string | null
  readonly quarantineReason: string | null
  readonly supersededBy: number | null
  readonly removedAt: string | null
}

export interface ForgePackageView {
  readonly skillId: string
  readonly name: string
  readonly runtime: ForgeRuntimeKind
  readonly version: number
  readonly status: ForgeStatus
  readonly enabled: boolean
  readonly integrityHash: string
  readonly origin: ForgeOrigin
  readonly createdAt: string
  readonly updatedAt: string
  readonly descriptionLength: number
  readonly tags: readonly string[]
  readonly declaredCapabilityCount: number
  readonly dependencyCount: number
  readonly programStepCount: number
  readonly access: {
    readonly network: ForgeAccessLevel
    readonly filesystem: ForgeAccessLevel
    readonly device: ForgeAccessLevel
    readonly keyring: ForgeAccessLevel
    readonly process: ForgeAccessLevel
  }
  readonly approval: ForgeApprovalState
  readonly verified: boolean
  /**
   * Why this version is quarantined, as a closed refusal code.
   *
   * Carried on the package rather than only on a version because a surface asks
   * "why is this one refused?" about the one it is looking at.
   */
  readonly quarantineReason: ForgeRefusalCode | null
  /** A newer version exists that is not the current one. */
  readonly updateAvailable: boolean
  readonly updateVersion: number | null
  readonly lastRun: ForgeRunView | null
  readonly versions: readonly ForgeVersionView[]
}

/** One refused attempt, so a probing pattern cannot hide in silence. */
export interface ForgeRejectionView {
  readonly code: ForgeRefusalCode
  readonly skillId: string | null
  readonly at: string
}

export interface ForgeSearchView {
  readonly skillId: string
  readonly name: string
  readonly runtime: ForgeRuntimeKind
  readonly status: ForgeStatus
  readonly version: number
  readonly enabled: boolean
  readonly score: number
  readonly matchedTags: readonly string[]
}

export interface ForgeSearchReportView {
  readonly hits: readonly ForgeSearchView[]
  readonly considered: number
  readonly emptyReason: 'no-match' | 'limit-zero' | 'nothing-searchable' | null
}

export interface ForgeCountsView {
  readonly packages: number
  readonly candidates: number
  readonly installed: number
  readonly enabled: number
  readonly disabled: number
  readonly quarantined: number
  readonly removed: number
  readonly runs: number
  readonly interruptedRuns: number
  readonly rejections: number
}

export interface ForgePersistenceView {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly reason: string | null
}

export interface ForgeProjection {
  readonly health: 'ready' | 'unavailable'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly counts: ForgeCountsView
  readonly packages: readonly ForgePackageView[]
  readonly rejections: readonly ForgeRejectionView[]
  readonly lastSearch: ForgeSearchReportView | null
  readonly persistence: ForgePersistenceView
  readonly limits: {
    readonly maxPackages: number
    readonly maxProgramSteps: number
    readonly maxOpsPerRun: number
    readonly maxInputChars: number
    readonly maxOutputChars: number
    readonly maxRunBudgetMs: number
  }
  /**
   * What the runtime is, in words a person can act on.
   *
   * Not decoration. Freya cannot promise a secure general-purpose sandbox in this
   * architecture, so it runs a bounded declarative subset and says so here rather
   * than letting someone discover it by writing a plugin that cannot run.
   */
  readonly runtimeNotice: string
}

/** One package's own body, on the owner's explicit read. */
export interface ForgeDetailView {
  readonly skillId: string
  readonly name: string
  readonly runtime: ForgeRuntimeKind
  readonly version: number
  readonly integrityHash: string
  readonly description: string
  readonly declaredCapabilities: readonly string[]
  readonly access: ForgePackageView['access']
  readonly dependencies: readonly { readonly name: string; readonly version: number }[]
  readonly inputs: readonly { readonly name: string; readonly type: string; readonly required: boolean }[]
  readonly outputs: readonly { readonly name: string; readonly type: string; readonly required: boolean }[]
  readonly program: readonly { readonly op: string; readonly to: string | null; readonly from: string | null }[]
  readonly provenance: {
    readonly origin: ForgeOrigin
    readonly model: string | null
    readonly requestHash: string | null
    readonly originRef: string | null
    readonly createdAt: string
  }
}

/* --------------------------------------------------------------- outcomes */

export type ForgeOperation =
  | 'status'
  | 'generated'
  | 'validated'
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'rolledback'
  | 'quarantined'
  | 'removed'
  | 'approved'
  | 'run'
  | 'search'
  | 'detail'
  | 'refused'

export interface ForgeCommandOutcome {
  readonly operation: ForgeOperation
  readonly ok: boolean
  /** Closed codes. A refusal always carries one. */
  readonly code?: ForgeRefusalCode
  readonly reason?: string
  readonly skillId?: string
  readonly version?: number
  readonly status?: ForgeStatus
  readonly projection?: ForgeProjection
  /** Present on `forge.validate` only. Every stage, always. */
  readonly stages?: readonly ForgeStageView[]
  readonly search?: ForgeSearchReportView
  /** Present on `forge.detail.read` only. */
  readonly detail?: ForgeDetailView
  /** Present on `forge.run` only. Evidence, never a fabricated success. */
  readonly run?: ForgeRunView
}

/* ---------------------------------------------------------------- absent */

export const ABSENT_FORGE_PROJECTION: ForgeProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a Forge domain yet',
  schemaVersion: 1,
  sequence: 0,
  counts: Object.freeze({
    packages: 0,
    candidates: 0,
    installed: 0,
    enabled: 0,
    disabled: 0,
    quarantined: 0,
    removed: 0,
    runs: 0,
    interruptedRuns: 0,
    rejections: 0,
  }),
  packages: Object.freeze([]) as readonly ForgePackageView[],
  rejections: Object.freeze([]) as readonly ForgeRejectionView[],
  lastSearch: null,
  persistence: Object.freeze({ mode: 'ephemeral' as const, durable: false, reason: null }),
  limits: Object.freeze({
    maxPackages: 0,
    maxProgramSteps: 0,
    maxOpsPerRun: 0,
    maxInputChars: 0,
    maxOutputChars: 0,
    maxRunBudgetMs: 0,
  }),
  runtimeNotice: '',
})

export const NO_FORGE_DOMAIN_REASON =
  'this Core has no Forge domain: no candidate has been generated, validated, installed or run, and none is simulated'

/** The sentence a window gets when a payloadless read carried something. */
export const FORGE_NO_PAYLOAD =
  'forge.status.read carries no payload: a window may ask what Core knows about packages and may not supply a status, a verdict, an approval or a filter'

/** The schema this lane speaks. */
export const FORGE_SCHEMA_VERSION = 1

/**
 * What the runtime is, stated once and exported so the host, a surface and the
 * tests quote the same words.
 */
export const FORGE_RUNTIME_NOTICE =
  'Freya runs Forge packages as a bounded declarative program in an interpreted runtime: no shell, no host filesystem, no keyring or Vault, no environment secrets, no network, and no JavaScript evaluator. Packages cannot be arbitrary plugins; a package that needs a network or device acts through the subsystem that holds that capability, under its own approval.'
