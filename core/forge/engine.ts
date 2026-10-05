import type { EventFabric } from '../events/fabric'
import type { Capability, PrincipalId } from '../protocol/core-protocol'
import type {
  ForgeCommandOutcome,
  ForgeDetailView,
  ForgeProjection,
  ForgeSearchReportView,
} from '../protocol/forge'
import { forgeDetailView, projectForge } from './projection'
import { discoverForgePackages, type ForgeSearchQuery } from './discovery'
import { forgeIntegrityHash, parseForgeManifest } from './manifest'
import { interpretForgeProgram } from './program'
import { runForgePipeline } from './pipeline'
import { scanForgeCandidate } from './security'
import {
  findForgePackage,
  findForgePackageByName,
  findForgeVersion,
  versionSummaryOf,
  type ForgeRecord,
  type ForgeState,
} from './state'
import { detectForgeTamper, planInstall, planRollback } from './versions'
import { FORGE_LIMITS, forgePackageId, isForgePackageDefect } from './types'
import type {
  ForgeManifest,
  ForgeOrigin,
  ForgeProvenance,
  ForgeRefusalCode,
  ForgeStageVerdict,
  ForgeValidationReport,
} from './types'

/**
 * THE FORGE ENGINE — generation, validation, install, enable, run, rollback.
 *
 * ## What this file cannot do
 *
 * It imports no gateway, no provider, no filesystem and no `node:*` module. Its
 * only impure dependencies are the injected journal, the injected body store, and
 * the two authority ports — which is the same shape as the Skill engine, for the
 * same reason: a subsystem that can reach a capability it was not given cannot
 * enforce that a package may not obtain one.
 *
 * ## The order of authority
 *
 * 1. **The fold** decides what exists. Every status, version, approval and run
 *    outcome comes from a `forge.*` event.
 * 2. **The pipeline** decides what is verified. It reads the candidate's bytes and
 *    Core's registrations, and nothing a caller asserts.
 * 3. **The authority ports** decide who may act and what is stopped. `holds()` is
 *    Guard's answer, read fresh per run; `stopAll()` is read before every run.
 * 4. **The owner scope** decides who may reach it. No method on it grants a
 *    capability, approves an approval, or touches a protected domain.
 *
 * ## Install does not enable
 *
 * Structural, not conventional: `install` appends `forge.installed` and nothing
 * else, `enable` is a separate method, and the fold refuses an `forge.enabled`
 * line for any version it never saw installed. There is no overload that does
 * both, and no flag that means "and turn it on".
 */

/** What this Core can execute, and what the acting principal holds. */
export interface ForgeCapabilityPort {
  /** Does any registered Work capability need this Guard capability? */
  isRegistered(capability: Capability): boolean
  /** Guard's answer, read fresh. Never cached, never widened by Forge. */
  holds(capability: Capability): boolean
}

/** A port that knows nothing, so an unwired Core admits nothing. */
export class ClosedForgeCapabilityPort implements ForgeCapabilityPort {
  isRegistered(): boolean {
    return false
  }
  holds(): boolean {
    return false
  }
}

/**
 * One stored body: the manifest for one exact version.
 *
 * payload is the candidate **exactly as it was submitted**, kept beside the
 * canonical manifest for one reason: the security scan must read the bytes that arrived,
 * not the shape the parser produced. Scanning the parsed object instead would make the
 * door refuse its own output, because a parsed manifest legitimately carries
 * provenance and a canonical access object.
 */
export interface ForgeStoredPackage {
  readonly skillId: string
  readonly version: number
  readonly manifest: ForgeManifest
  readonly integrityHash: string
  readonly payload: unknown
}

export interface ForgeBodyStore {
  commit(packages: readonly ForgeStoredPackage[]): void
  load(): Promise<readonly ForgeStoredPackage[]>
  health(): { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null }
}

export interface ForgeEngineOptions {
  readonly fabric: EventFabric
  readonly getState: () => ForgeState
  readonly actor: PrincipalId
  readonly capabilities?: ForgeCapabilityPort
  readonly store?: ForgeBodyStore | null
  readonly now?: () => Date
  readonly newId?: () => string
  readonly monotonic?: () => number
  readonly onChange?: () => void
  /** Read fresh, per run and per write. A stopped Freya writes and runs nothing. */
  readonly stopAll: () => boolean
  /** The owner requires a decision before this package may be installed. */
  readonly approvalRequired?: (manifest: ForgeManifest) => boolean
  readonly maxRunBudgetMs?: number
}

export interface ForgeGenerateRequest {
  readonly payload: unknown
  readonly origin: ForgeOrigin
  readonly model?: string | null
  readonly requestHash?: string | null
  readonly originRef?: string | null
}

export interface ForgeRunRequest {
  readonly skillId: string
  readonly input: Record<string, unknown>
  readonly idempotencyKey?: string | null
  readonly budgetMs?: number
}

export interface ForgeImportEnvelope {
  readonly skillId: string
  readonly name: string
  readonly version: number
  readonly integrityHash: string
  readonly manifest: unknown
}

/**
 * The owner's face of Forge.
 *
 * Issued by Core, absent from every interface a window can name. Note what it has
 * no method for: granting a capability, deciding an approval on the owner's behalf
 * (it records *their* decision), editing Core, or making a package enabled without
 * an explicit `enable`.
 */
export interface ForgeOwnerScope {
  generate(request: ForgeGenerateRequest): Promise<ForgeCommandOutcome>
  importPackage(envelope: unknown): Promise<ForgeCommandOutcome>
  validate(skillId: string): Promise<ForgeCommandOutcome>
  install(skillId: string, options?: { allowDowngrade?: boolean }): Promise<ForgeCommandOutcome>
  enable(skillId: string): Promise<ForgeCommandOutcome>
  disable(skillId: string, reason?: string): Promise<ForgeCommandOutcome>
  run(request: ForgeRunRequest): Promise<ForgeCommandOutcome>
  rollback(skillId: string, version: number): Promise<ForgeCommandOutcome>
  remove(skillId: string, version?: number): Promise<ForgeCommandOutcome>
  approve(skillId: string, decision: 'approved' | 'refused', reason?: string): Promise<ForgeCommandOutcome>
  exportPackage(skillId: string): ForgeCommandOutcome
  discover(query?: ForgeSearchQuery): ForgeSearchOutcome
  detail(skillId: string): ForgeDetailView | null
  /** The current projection. Same read as the bridge, plus the search echo. */
  projection(): ForgeProjection
}

export interface ForgeSearchOutcome {
  readonly ok: boolean
  readonly code?: ForgeRefusalCode
  readonly reason?: string
  readonly report?: ForgeSearchReportView
  readonly projection?: ForgeProjection
}

function bodyKey(skillId: string, version: number): string {
  return `${skillId}@${version}`
}

export class ForgeEngine {
  private readonly fabric: EventFabric
  private readonly getState: () => ForgeState
  private readonly actor: PrincipalId
  private readonly capabilities: ForgeCapabilityPort
  private readonly store: ForgeBodyStore | null
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly monotonic: () => number
  private readonly onChange: () => void
  private readonly stopAll: () => boolean
  private readonly approvalRequired: (manifest: ForgeManifest) => boolean
  private readonly maxRunBudgetMs: number

  /** Bodies, keyed `skillId@version`. The journal says they exist; this holds them. */
  private readonly bodies = new Map<string, ForgeStoredPackage>()
  private lastSearch: ForgeSearchReportView | null = null
  private opened = false

  constructor(options: ForgeEngineOptions) {
    this.fabric = options.fabric
    this.getState = options.getState
    this.actor = options.actor
    this.capabilities = options.capabilities ?? new ClosedForgeCapabilityPort()
    this.store = options.store ?? null
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.monotonic = options.monotonic ?? (() => Date.now())
    this.onChange = options.onChange ?? (() => {})
    this.stopAll = options.stopAll
    this.approvalRequired = options.approvalRequired ?? defaultApprovalRequired
    this.maxRunBudgetMs = options.maxRunBudgetMs ?? FORGE_LIMITS.maxRunBudgetMs
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Adopt recovered bodies, mark interrupted runs, and enable nothing.
   *
   * Three rules, all about what a restart is allowed to do:
   *
   * - A body is adopted only when the fold vouches for that exact version *and*
   *   its bytes still hash to what the journal recorded. Anything else is dropped,
   *   and a package whose body disagrees is quarantined rather than run.
   * - A run still marked `running` becomes `interrupted`. It is not retried and it
   *   is not reported as succeeded: a run whose result was not durably recorded
   *   did not provably happen.
   * - **Nothing is auto-run.** There is no resume path, no replay path and no
   *   "run whatever was in flight" branch anywhere in this file.
   */
  async open(): Promise<void> {
    if (this.opened) return
    this.opened = true
const state = this.getState()
    const recovered = this.store === null ? [] : await this.store.load()
    for (const stored of recovered) {
      const version = findForgeVersion(state, stored.skillId, stored.version)
      if (version === null) continue
      if (version.integrityHash !== stored.integrityHash) {
        // The body disagrees with the journal. Dropping it silently would leave a
        // package that reports `enabled` and cannot run, with no reason anywhere;
        // quarantining keeps the history and names the reason.
        await this.quarantine(
          stored.skillId,
          stored.version,
          'integrity-mismatch',
          'a stored package body does not hash to the value the journal recorded for it',
        )
        continue
      }
      this.bodies.set(bodyKey(stored.skillId, stored.version), stored)
    }

    for (const run of state.runs.values()) {
      if (run.state !== 'running') continue
      await this.fabric.append(
        'forge.run.recorded',
        {
          runId: run.runId,
          skillId: run.skillId,
          version: run.version,
          state: 'interrupted' as const,
          failure: 'recovery-interrupted' as const,
          startedAt: run.startedAt,
          finishedAt: this.now().toISOString(),
          idempotencyKey: run.idempotencyKey,
          inputHash: run.inputHash,
          opsUsed: run.metrics?.opsUsed ?? 0,
          outputChars: run.metrics?.outputChars ?? 0,
          durationMs: run.metrics?.durationMs ?? 0,
          outputHash: null,
        },
        { actor: 'system', correlationId: run.runId },
      )
    }
    this.onChange()
  }

  /* ------------------------------------------------------------ projection */

  projection(): ForgeProjection {
    return projectForge({
      sequence: this.fabric.lastSequence,
      state: this.getState(),
      persistence: this.store?.health() ?? {
        mode: 'ephemeral' as const,
        durable: false,
        reason: 'this Core holds Forge packages in this process only, so nothing survives a restart',
      },
      lastSearch: this.lastSearch,
    })
  }

  /* --------------------------------------------------------------- refusals */

  private async refuse(
    operation: ForgeCommandOutcome['operation'],
    code: ForgeRefusalCode,
    reason: string,
    skillId: string | null = null,
  ): Promise<ForgeCommandOutcome> {
    // Journalled: an unaudited refusal hides a probing pattern. The payload is a
    // closed code and an id — never the text that was refused.
    await this.fabric.append(
      'forge.refused',
      { code, skillId, at: this.now().toISOString() },
      { actor: this.actor },
    )
    this.onChange()
    return { operation, ok: false, code, reason, ...(skillId === null ? {} : { skillId }) }
  }

  /* ------------------------------------------------------------ generation */

  private provenanceFor(request: ForgeGenerateRequest, at: string): ForgeProvenance {
    return {
      origin: request.origin,
      model: request.model ?? null,
      requestHash: request.requestHash ?? null,
      originRef: request.originRef ?? null,
      createdAt: at,
    }
  }

  /**
   * Turn a submitted payload into a candidate.
   *
   * The payload is parsed, hashed and recorded as a `candidate` with **zero
   * authority**: it is not installed, not enabled, not runnable, and its
   * `capabilitiesRequired` list is an unchecked declaration until the pipeline
   * says otherwise. Generation never enables, never installs, never fetches, and
   * never installs a dependency — the manifest is a description, and nothing here
   * turns a description into a thing that runs.
   */
  private async createCandidate(
    request: ForgeGenerateRequest,
    at: string,
  ): Promise<{ ok: true; skillId: string; version: number; integrityHash: string } | { ok: false; code: ForgeRefusalCode; reason: string }> {
    const state = this.getState()
    const existing = existingFor(state, request.payload)
    const version = existing === null ? 1 : existing.currentVersion + 1
    if (existing !== null && existing.versions.size >= FORGE_LIMITS.maxVersionsPerPackage) {
      return { ok: false, code: 'limit-exceeded', reason: `a package retains at most ${FORGE_LIMITS.maxVersionsPerPackage} versions` }
    }

    const parsed = parseForgeManifest({
      payload: request.payload,
      version,
      provenance: this.provenanceFor(request, at),
    })
    if (!parsed.ok) return { ok: false, code: parsed.code, reason: parsed.reason }

    const scan = scanForgeCandidate(request.payload, parsed.manifest)
    if (!scan.clean) {
      const first = scan.findings[0]
      return {
        ok: false,
        code: first?.code ?? 'security-finding',
        reason: first?.reason ?? 'the static scan refused this candidate',
      }
    }

    const skillId = forgePackageId(parsed.manifest.name)
    const manifest = parsed.manifest

    await this.fabric.append(
      'forge.candidate.created',
      {
        skillId,
        name: manifest.name,
        runtime: manifest.runtime,
        version,
        integrityHash: parsed.integrityHash,
        origin: manifest.provenance.origin,
        model: manifest.provenance.model,
        requestHash: manifest.provenance.requestHash,
        originRef: manifest.provenance.originRef,
        accessNetwork: manifest.access.network,
        accessDevice: manifest.access.device,
        declaredCapabilities: [...manifest.capabilitiesRequired],
        tags: [...manifest.tags],
        dependencyCount: manifest.dependencies.length,
        programStepCount: manifest.program.steps.length,
        descriptionLength: manifest.description.length,
        createdAt: at,
      },
      { actor: this.actor },
    )

    this.bodies.set(bodyKey(skillId, version), {
      skillId,
      version,
      manifest,
      integrityHash: parsed.integrityHash,
      payload: request.payload,
    })
    this.persist()
    this.onChange()
    return { ok: true, skillId, version, integrityHash: parsed.integrityHash }
  }

  async generate(request: ForgeGenerateRequest): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) {
      return this.refuse('generated', 'stop-all', 'Freya is stopped, so nothing is generated')
    }
    if (!isForgeOrigin(request.origin)) {
      return this.refuse('generated', 'malformed-manifest', 'a candidate must state where it came from')
    }
    if (this.getState().packages.size >= FORGE_LIMITS.maxPackages && existingFor(this.getState(), request.payload) === null) {
      return this.refuse('generated', 'limit-exceeded', `this Core retains at most ${FORGE_LIMITS.maxPackages} packages`)
    }
    const at = this.now().toISOString()
    const created = await this.createCandidate(request, at)
    if (!created.ok) return this.refuse('generated', created.code, created.reason)
    return {
      operation: 'generated',
      ok: true,
      skillId: created.skillId,
      version: created.version,
      status: 'candidate',
      reason: 'a candidate has zero authority: it is not installed, not enabled and not runnable until the pipeline passes',
      projection: this.projection(),
    }
  }

  /**
   * Import an exported envelope.
   *
   * The envelope is untrusted input wearing a hash. The hash is recomputed from
   * the manifest it carries and compared to what the envelope claims; a mismatch
   * is refused, never repaired. An imported package becomes a `local-import`
   * candidate and goes through the same pipeline as a generated one.
   */
  async importPackage(envelope: unknown): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) {
      return this.refuse('generated', 'stop-all', 'Freya is stopped, so nothing is imported')
    }
    const parsed = readImportEnvelope(envelope)
    if (!parsed.ok) return this.refuse('generated', 'malformed-manifest', parsed.reason)

    const outcome = await this.generate({
      payload: parsed.value.manifest,
      origin: 'local-import',
      originRef: `import:${parsed.value.name}`,
    })
    if (!outcome.ok || outcome.skillId === undefined) return outcome
    const record = findForgePackage(this.getState(), outcome.skillId)
    const version = findForgeVersion(this.getState(), outcome.skillId, outcome.version ?? 1)
    if (record === null || version === null) return outcome
    // The envelope's own claim is checked against the recomputed hash. A lying
    // envelope cannot smuggle a body past the pipeline by asserting integrity.
    if (parsed.value.integrityHash !== version.integrityHash) {
      return this.refuse(
        'generated',
        'integrity-mismatch',
        'the envelope claims an integrity hash that does not describe the manifest it carries',
        record.skillId,
      )
    }
    return outcome
  }

  /* ------------------------------------------------------------ validation */

  async validate(skillId: string): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) return this.refuse('validated', 'stop-all', 'Freya is stopped, so nothing is validated', skillId)
    const record = findForgePackage(this.getState(), skillId)
    if (record === null) return this.refuse('validated', 'no-such-package', 'there is no such package', skillId)
    const version = findForgeVersion(this.getState(), skillId, record.currentVersion)
    if (version === null) {
      return this.refuse('validated', 'no-such-version', 'this package has no such version', skillId)
    }
    const stored = this.bodies.get(bodyKey(skillId, record.currentVersion)) ?? null
    if (stored === null) {
      return this.refuse('validated', 'no-such-version', 'this package body is not readable in this Core', skillId)
    }

    const tamper = detectForgeTamper(stored.manifest, version.integrityHash)
    if (tamper.tampered) {
      await this.quarantine(skillId, record.currentVersion, 'integrity-mismatch', 'the stored body no longer hashes to what the journal recorded')
      return this.refuse('validated', 'integrity-mismatch', 'the stored body no longer hashes to what the journal recorded', skillId)
    }

    const ranAt = this.now().toISOString()
    await this.fabric.append(
      'forge.validating.recorded',
      { skillId, version: record.currentVersion, integrityHash: version.integrityHash, startedAt: ranAt },
      { actor: this.actor },
    )

    const report = runForgePipeline({
      payload: stored.payload,
      manifest: stored.manifest,
      manifestCode: null,
      manifestReason: null,
      integrityHash: tamper.computed,
      environment: {
        isCapabilityRegistered: (capability) => this.capabilities.isRegistered(capability),
        installed: () => this.installedSummaries(),
        approvalRequired: (manifest) => this.approvalRequired(manifest),
        approvalState: (manifest) => this.approvalStateOf(record, manifest),
      },
      ranAt,
      monotonic: this.monotonic,
    })
    return this.recordValidation(record, report)
  }

  private approvalStateOf(record: ForgeRecord, manifest: ForgeManifest): 'not-required' | 'pending' | 'approved' | 'refused' {
    const version = record.versions.get(manifest.version)
    if (version === undefined) return 'not-required'
    if (!this.approvalRequired(manifest)) return 'not-required'
    return version.approval.required ? version.approval.state : 'pending'
  }

  private async recordValidation(record: ForgeRecord, report: ForgeValidationReport): Promise<ForgeCommandOutcome> {
    const stageVerdicts: ForgeStageVerdict[] = report.stages.map((entry) => entry.verdict)
    await this.fabric.append(
      'forge.validation.recorded',
      {
        skillId: record.skillId,
        version: record.currentVersion,
        integrityHash: report.integrityHash ?? '',
        passed: report.passed,
        failingStage: report.failingStage,
        code: report.code,
        ranAt: report.ranAt,
        stageVerdicts,
        testChecks: report.tests?.checks ?? 0,
        testFailures: report.tests?.failures ?? 0,
      },
      { actor: this.actor },
    )
    this.onChange()
    const updated = findForgePackage(this.getState(), record.skillId)
    return {
      operation: 'validated',
      ok: report.passed,
      skillId: record.skillId,
      version: record.currentVersion,
      status: updated?.versions.get(record.currentVersion)?.status ?? 'candidate',
      code: report.code ?? undefined,
      reason: report.reason ?? 'every stage passed',
      stages: report.stages.map((entry) => ({ stage: entry.stage, verdict: entry.verdict, code: entry.code })),
      projection: this.projection(),
    }
  }

  /* ---------------------------------------------------------------- install */

  async install(skillId: string, options?: { allowDowngrade?: boolean }): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) return this.refuse('installed', 'stop-all', 'Freya is stopped, so nothing is installed', skillId)
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return this.refuse('installed', 'no-such-package', 'there is no such package', skillId)
    const version = findForgeVersion(state, skillId, record.currentVersion)
    if (version === null) return this.refuse('installed', 'no-such-version', 'this package has no such version', skillId)
    if (!version.validationPassed) {
      return this.refuse('installed', 'not-verified', 'a package must pass the whole pipeline before it may be installed', skillId)
    }
    if (version.status === 'quarantined' || version.status === 'removed') {
      return this.refuse('installed', version.status, `this version is ${version.status}`, skillId)
    }
    const stored = this.bodies.get(bodyKey(skillId, record.currentVersion)) ?? null
    if (stored === null) return this.refuse('installed', 'no-such-version', 'this package body is not readable in this Core', skillId)
    if (forgeIntegrityHash(stored.manifest) !== version.integrityHash) {
      await this.quarantine(skillId, record.currentVersion, 'integrity-mismatch', 'the stored body no longer hashes to what the journal recorded')
      return this.refuse('installed', 'integrity-mismatch', 'the stored body no longer hashes to what the journal recorded', skillId)
    }

    const plan = planInstall(versionSummaryOf(record), stored.manifest, version.integrityHash, options?.allowDowngrade === true)
    if (!plan.ok) return this.refuse('installed', plan.code, plan.reason, skillId)

    await this.fabric.append(
      'forge.installed',
      {
        skillId,
        version: record.currentVersion,
        integrityHash: version.integrityHash,
        action: plan.action,
        installedAt: this.now().toISOString(),
      },
      { actor: this.actor },
    )
    this.onChange()
    const updated = findForgePackage(this.getState(), skillId)
    return {
      operation: 'installed',
      ok: true,
      skillId,
      version: record.currentVersion,
      status: updated?.versions.get(record.currentVersion)?.status ?? 'installed',
      reason: 'installed. Installation never enables a package; that is a separate, explicit act.',
      projection: this.projection(),
    }
  }

  /* ---------------------------------------------------------- enable/state */

  async enable(skillId: string): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) return this.refuse('enabled', 'stop-all', 'Freya is stopped, so nothing is enabled', skillId)
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return this.refuse('enabled', 'no-such-package', 'there is no such package', skillId)
    const version = findForgeVersion(state, skillId, record.currentVersion)
    if (version === null) return this.refuse('enabled', 'no-such-version', 'this package has no such version', skillId)
    if (version.status === 'quarantined') {
      return this.refuse('enabled', 'quarantined', 'a quarantined package may not be enabled', skillId)
    }
    if (version.status === 'removed') {
      return this.refuse('enabled', 'removed', 'a removed package may not be enabled', skillId)
    }
    if (version.status !== 'installed' && version.status !== 'disabled') {
      return this.refuse('enabled', 'not-installed', 'a package must be installed before it is enabled', skillId)
    }

    const stored = this.bodies.get(bodyKey(skillId, record.currentVersion)) ?? null
    if (stored === null) return this.refuse('enabled', 'no-such-version', 'this package body is not readable in this Core', skillId)

    if (this.approvalRequired(stored.manifest)) {
      const approval = version.approval
      if (!approval.required) {
        return this.refuse('enabled', 'approval-required', 'this package needs an owner decision before it is enabled', skillId)
      }
      if (approval.state === 'refused') {
        return this.refuse('enabled', 'approval-refused', 'the owner refused this exact version', skillId)
      }
      if (approval.state !== 'approved') {
        return this.refuse('enabled', 'approval-required', 'this package is waiting for an owner decision', skillId)
      }
    }

    await this.fabric.append(
      'forge.enabled',
      { skillId, version: record.currentVersion, enabledAt: this.now().toISOString() },
      { actor: this.actor },
    )
    this.onChange()
    return {
      operation: 'enabled',
      ok: true,
      skillId,
      version: record.currentVersion,
      status: 'enabled',
      projection: this.projection(),
    }
  }

  async disable(skillId: string, reason?: string): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) return this.refuse('disabled', 'stop-all', 'Freya is stopped, so nothing is disabled', skillId)
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return this.refuse('disabled', 'no-such-package', 'there is no such package', skillId)
    const version = findForgeVersion(state, skillId, record.currentVersion)
    if (version === null) return this.refuse('disabled', 'no-such-version', 'this package has no such version', skillId)
    if (version.status !== 'enabled') {
      return this.refuse('disabled', 'not-enabled', 'this package is not enabled', skillId)
    }
    await this.fabric.append(
      'forge.disabled',
      {
        skillId,
        version: record.currentVersion,
        disabledAt: this.now().toISOString(),
        reason: truncate(reason ?? 'disabled by owner'),
      },
      { actor: this.actor },
    )
    this.onChange()
    return {
      operation: 'disabled',
      ok: true,
      skillId,
      version: record.currentVersion,
      status: 'disabled',
      projection: this.projection(),
    }
  }

  async approve(skillId: string, decision: 'approved' | 'refused', reason?: string): Promise<ForgeCommandOutcome> {
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return this.refuse('approved', 'no-such-package', 'there is no such package', skillId)
    const version = findForgeVersion(state, skillId, record.currentVersion)
    if (version === null) return this.refuse('approved', 'no-such-version', 'this package has no such version', skillId)
    if (version.status === 'installed' || version.status === 'enabled') {
      return this.refuse('approved', 'approval-required', 'an installed package is enabled or disabled directly, not approved', skillId)
    }
    const at = this.now().toISOString()
    await this.fabric.append(
      'forge.approval.recorded',
      {
        skillId,
        version: record.currentVersion,
        state: decision,
        decidedBy: this.actor,
        decidedAt: at,
        reason: truncate(reason ?? (decision === 'approved' ? 'approved by owner' : 'refused by owner')),
      },
      { actor: this.actor },
    )
    this.onChange()
    return {
      operation: 'approved',
      ok: true,
      skillId,
      version: record.currentVersion,
      status: findForgeVersion(this.getState(), skillId, record.currentVersion)?.status,
      projection: this.projection(),
    }
  }

  async rollback(skillId: string, target: number): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) return this.refuse('rolledback', 'stop-all', 'Freya is stopped, so nothing is rolled back', skillId)
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return this.refuse('rolledback', 'no-such-package', 'there is no such package', skillId)
    const plan = planRollback(versionSummaryOf(record), target)
    if (!plan.ok) return this.refuse('rolledback', plan.code, plan.reason, skillId)
    const stored = this.bodies.get(bodyKey(skillId, target)) ?? null
    if (stored === null) {
      return this.refuse('rolledback', 'no-such-version', 'this Core holds no body for that version', skillId)
    }
    const version = findForgeVersion(state, skillId, target)
    if (version === null || !version.validationPassed) {
      return this.refuse('rolledback', 'not-verified', 'the version being returned to was never verified', skillId)
    }
    if (forgeIntegrityHash(stored.manifest) !== version.integrityHash) {
      await this.quarantine(skillId, target, 'integrity-mismatch', 'the stored body no longer hashes to what the journal recorded')
      return this.refuse('rolledback', 'integrity-mismatch', 'the stored body no longer hashes to what the journal recorded', skillId)
    }
    await this.fabric.append(
      'forge.rolledback',
      { skillId, fromVersion: plan.from, toVersion: plan.version, at: this.now().toISOString() },
      { actor: this.actor },
    )
    this.onChange()
    return {
      operation: 'rolledback',
      ok: true,
      skillId,
      version: plan.version,
      status: findForgeVersion(this.getState(), skillId, plan.version)?.status,
      reason: 'rolled back. A rollback returns to installed, never to enabled: turning it on is a separate act.',
      projection: this.projection(),
    }
  }

  async remove(skillId: string, version?: number): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) return this.refuse('removed', 'stop-all', 'Freya is stopped, so nothing is removed', skillId)
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return this.refuse('removed', 'no-such-package', 'there is no such package', skillId)
    const target = version ?? record.currentVersion
    const entry = findForgeVersion(state, skillId, target)
    if (entry === null) return this.refuse('removed', 'no-such-version', 'this package has no such version', skillId)
    if (entry.status === 'removed') return this.refuse('removed', 'removed', 'this version is already removed', skillId)
    await this.fabric.append(
      'forge.removed',
      { skillId, version: target, at: this.now().toISOString(), reason: truncate('removed by owner') },
      { actor: this.actor },
    )
    this.bodies.delete(bodyKey(skillId, target))
    this.persist()
    this.onChange()
    return {
      operation: 'removed',
      ok: true,
      skillId,
      version: target,
      status: 'removed',
      projection: this.projection(),
    }
  }

  private async quarantine(
    skillId: string,
    version: number,
    code: ForgeRefusalCode,
    reason: string,
  ): Promise<void> {
    await this.fabric.append(
      'forge.quarantined',
      { skillId, version, code, reason: truncate(reason), at: this.now().toISOString() },
      { actor: 'system' },
    )
    this.bodies.delete(bodyKey(skillId, version))
    this.persist()
    this.onChange()
  }

  /* ------------------------------------------------------------------- run */

  /**
   * Run an enabled package.
   *
   * The checks, in order, and each one is a refusal rather than a repair:
   * STOP ALL → the package exists → its current version is enabled → the body is
   * readable and matches its recorded hash → every declared capability is one the
   * acting principal **already holds** → then the interpreter runs under a budget
   * with cancellation.
   *
   * `idempotencyKey` makes a retried run a *replay of the recorded outcome* rather
   * than a second execution, which is what stops a timeout-retry from doubling
   * whatever the package did.
   */
  async run(request: ForgeRunRequest): Promise<ForgeCommandOutcome> {
    if (this.stopAll()) return this.refuse('run', 'stop-all', 'Freya is stopped, so nothing runs', request.skillId)

    const state = this.getState()
    const record = findForgePackage(state, request.skillId)
    if (record === null) return this.refuse('run', 'no-such-package', 'there is no such package', request.skillId)
    const versionNumber = record.currentVersion
    const version = findForgeVersion(state, request.skillId, versionNumber)
    if (version === null) return this.refuse('run', 'no-such-version', 'this package has no such version', request.skillId)
    if (version.status === 'quarantined') return this.refuse('run', 'quarantined', 'a quarantined package does not run', request.skillId)
    if (version.status === 'removed') return this.refuse('run', 'removed', 'a removed package does not run', request.skillId)
    if (version.status !== 'enabled') {
      return this.refuse('run', 'not-enabled', 'a package runs only while it is enabled', request.skillId)
    }

    const stored = this.bodies.get(bodyKey(request.skillId, versionNumber)) ?? null
    if (stored === null) {
      return this.refuse('run', 'no-such-version', 'this package body is not readable in this Core', request.skillId)
    }
    const tamper = detectForgeTamper(stored.manifest, version.integrityHash)
    if (tamper.tampered) {
      await this.quarantine(
        request.skillId,
        versionNumber,
        'integrity-mismatch',
        'the stored body no longer hashes to what the journal recorded',
      )
      return this.refuse('run', 'integrity-mismatch', 'the stored body no longer hashes to what the journal recorded', request.skillId)
    }

    // Capability admission at *run* time, checked against the principal's held
    // capabilities rather than the package's wishes. Installing never granted
    // anything; this is where the declaration is finally cashed, and a package
    // whose requirements the principal does not hold simply does not run.
    for (const capability of stored.manifest.capabilitiesRequired) {
      if (!this.capabilities.holds(capability)) {
        return this.refuse(
          'run',
          'capability-not-held',
          `this package declares ${capability}, which the acting principal does not hold; installing a package never grants a capability`,
          request.skillId,
        )
      }
    }

    const inputHash = hashInput(request.input)
    const key = request.idempotencyKey ?? null
    if (key !== null) {
      const previous = [...state.runs.values()].find(
        (run) => run.idempotencyKey === key && run.inputHash === inputHash && run.state !== 'running',
      )
      if (previous !== undefined) {
        return {
          operation: 'run',
          ok: previous.state === 'succeeded',
          skillId: request.skillId,
          version: previous.version,
          code: previous.state === 'succeeded' ? undefined : (previous.failure ?? 'run-failed'),
          reason:
            previous.state === 'succeeded'
              ? 'this idempotency key already ran; the recorded outcome is replayed and nothing ran twice'
              : 'this idempotency key already failed; the recorded failure is replayed rather than retried silently',
          run: {
            runId: previous.runId,
            version: previous.version,
            state: previous.state,
            failure: previous.failure,
            startedAt: previous.startedAt,
            finishedAt: previous.finishedAt,
            opsUsed: previous.metrics?.opsUsed ?? 0,
            outputChars: previous.metrics?.outputChars ?? 0,
            durationMs: previous.metrics?.durationMs ?? 0,
            interrupted: previous.state === 'interrupted',
          },
          projection: this.projection(),
        }
      }
    }

    const runId = this.newId()
    const startedAt = this.now().toISOString()
    const budgetMs = Math.max(1, Math.min(request.budgetMs ?? FORGE_LIMITS.defaultRunBudgetMs, this.maxRunBudgetMs))

    await this.fabric.append(
      'forge.run.recorded',
      {
        runId,
        skillId: request.skillId,
        version: versionNumber,
        state: 'running' as const,
        failure: null,
        startedAt,
        finishedAt: null,
        idempotencyKey: key,
        inputHash,
        opsUsed: 0,
        outputChars: 0,
        durationMs: 0,
        outputHash: null,
      },
      { actor: this.actor },
    )
    this.onChange()

    const outcome = interpretForgeProgram({
      program: stored.manifest.program,
      runtime: stored.manifest.runtime,
      inputs: stored.manifest.inputs,
      outputs: stored.manifest.outputs,
      input: request.input,
      budgetMs,
      isCancelled: () => this.stopAll(),
      monotonic: this.monotonic,
    })

    const finishedAt = this.now().toISOString()
    const metrics = outcome.metrics
    const runState: 'succeeded' | 'failed' | 'cancelled' = outcome.ok
      ? 'succeeded'
      : outcome.code === 'cancelled'
        ? 'cancelled'
        : 'failed'

    await this.fabric.append(
      'forge.run.recorded',
      {
        runId,
        skillId: request.skillId,
        version: versionNumber,
        state: runState,
        failure: outcome.ok ? null : outcome.code,
        startedAt,
        finishedAt,
        idempotencyKey: key,
        inputHash,
        opsUsed: metrics.opsUsed,
        outputChars: metrics.outputChars,
        durationMs: metrics.durationMs,
        outputHash: outcome.ok ? hashInput(outcome.output as Record<string, unknown>) : null,
      },
      { actor: this.actor },
    )

    // A run that died inside the program is evidence about the package, so the version
    // is degraded rather than left enabled and quietly failing on every call. A bad
    // payload, a cancellation and a deadline are not: they say nothing about whether
    // the package works, and degrading on them would let anyone who can type the
    // wrong shape switch a working package off.
    if (!outcome.ok && isForgePackageDefect(outcome.code)) {
      await this.fabric.append(
        'forge.degraded',
        {
          skillId: request.skillId,
          version: versionNumber,
          code: outcome.code,
          reason: truncate('a run failed on the package itself, so it is no longer enabled'),
          at: finishedAt,
        },
        { actor: 'system' },
      )
    }

    this.onChange()

    if (!outcome.ok) {
      return {
        operation: 'run',
        ok: false,
        skillId: request.skillId,
        version: versionNumber,
        code: outcome.code,
        reason: outcome.reason,
        run: {
          runId,
          version: versionNumber,
          state: runState,
          failure: outcome.code,
          startedAt,
          finishedAt,
          opsUsed: metrics.opsUsed,
          outputChars: metrics.outputChars,
          durationMs: metrics.durationMs,
          interrupted: false,
        },
        projection: this.projection(),
      }
    }

    return {
      operation: 'run',
      ok: true,
      skillId: request.skillId,
      version: versionNumber,
      reason: 'the run finished inside every bound',
      run: {
        runId,
        version: versionNumber,
        state: runState,
        failure: null,
        startedAt,
        finishedAt,
        opsUsed: metrics.opsUsed,
        outputChars: metrics.outputChars,
        durationMs: metrics.durationMs,
        interrupted: false,
      },
      projection: this.projection(),
    }
  }

  /* ------------------------------------------------------------- discovery */

  discover(query: ForgeSearchQuery = {}): ForgeSearchOutcome {
    const state = this.getState()
    const records = [...state.packages.values()].map((record) => {
      const version = record.versions.get(record.currentVersion)
      return {
        skillId: record.skillId,
        name: record.name,
        descriptionLength: record.descriptionLength,
        description: '',
        runtime: record.runtime,
        status: version?.status ?? 'candidate',
        version: record.currentVersion,
        enabled: record.enabledVersion !== null,
        tags: record.tags,
        capabilitiesRequired: record.declaredCapabilities,
      }
    })
    const report = discoverForgePackages(records, query)
    const view: ForgeSearchReportView = {
      hits: report.hits,
      considered: report.considered,
      emptyReason: report.emptyReason,
    }
    this.lastSearch = view
    this.onChange()
    return { ok: true, report: view, projection: this.projection() }
  }

  detail(skillId: string): ForgeDetailView | null {
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return null
    const stored = this.bodies.get(bodyKey(skillId, record.currentVersion)) ?? null
    if (stored === null) return null
    if (forgeIntegrityHash(stored.manifest) !== stored.integrityHash) return null
    const detail = forgeDetailView(record, stored.manifest, stored.integrityHash)
    return {
      skillId: detail.skillId,
      name: detail.name,
      runtime: detail.runtime,
      version: detail.version,
      integrityHash: detail.integrityHash,
      description: detail.description,
      declaredCapabilities: detail.declaredCapabilities,
      access: detail.access,
      dependencies: detail.dependencies,
      inputs: detail.inputs,
      outputs: detail.outputs,
      program: detail.program,
      provenance: detail.provenance,
    }
  }

  /** An export envelope the owner may keep. Integrity is recomputed, not trusted. */
  exportPackage(skillId: string): ForgeCommandOutcome {
    const state = this.getState()
    const record = findForgePackage(state, skillId)
    if (record === null) return { operation: 'detail', ok: false, code: 'no-such-package', reason: 'there is no such package', skillId }
    const stored = this.bodies.get(bodyKey(skillId, record.currentVersion)) ?? null
    if (stored === null) {
      return { operation: 'detail', ok: false, code: 'no-such-version', reason: 'this package body is not readable in this Core', skillId }
    }
    const integrityHash = forgeIntegrityHash(stored.manifest)
    if (integrityHash !== stored.integrityHash) {
      return { operation: 'detail', ok: false, code: 'integrity-mismatch', reason: 'the stored body no longer hashes to what the journal recorded', skillId }
    }
    return {
      operation: 'detail',
      ok: true,
      skillId,
      version: record.currentVersion,
      detail: {
        skillId,
        name: stored.manifest.name,
        runtime: stored.manifest.runtime,
        version: stored.manifest.version,
        integrityHash,
        description: stored.manifest.description,
        declaredCapabilities: [...stored.manifest.capabilitiesRequired],
        access: stored.manifest.access,
        dependencies: stored.manifest.dependencies.map((dependency) => ({
          name: dependency.name,
          version: dependency.version,
        })),
        inputs: stored.manifest.inputs.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required,
        })),
        outputs: stored.manifest.outputs.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required,
        })),
        program: stored.manifest.program.steps.map((step) => ({ op: step.op, to: step.to, from: step.from })),
        provenance: stored.manifest.provenance,
      },
    }
  }

  /* -------------------------------------------------------------- internals */

  private installedSummaries(): { name: string; version: number; status: string }[] {
    const out: { name: string; version: number; status: string }[] = []
    for (const record of this.getState().packages.values()) {
      const version = record.versions.get(record.installedVersion ?? record.currentVersion)
      if (version === undefined) continue
      out.push({ name: record.name, version: record.currentVersion, status: version.status })
    }
    return out
  }

  private persist(): void {
    const store = this.store
    if (store === null) return
    store.commit([...this.bodies.values()])
  }

  /** The owner's face. Holding it is the authority; it grants nothing. */
  ownerScope(): ForgeOwnerScope {
    return {
      generate: (request) => this.generate(request),
      importPackage: (envelope) => this.importPackage(envelope),
      validate: (skillId) => this.validate(skillId),
      install: (skillId, options) => this.install(skillId, options),
      enable: (skillId) => this.enable(skillId),
      disable: (skillId, reason) => this.disable(skillId, reason),
      run: (request) => this.run(request),
      rollback: (skillId, version) => this.rollback(skillId, version),
      remove: (skillId, version) => this.remove(skillId, version),
      approve: (skillId, decision, reason) => this.approve(skillId, decision, reason),
      exportPackage: (skillId) => this.exportPackage(skillId),
      discover: (query) => this.discover(query),
      detail: (skillId) => this.detail(skillId),
      projection: () => this.projection(),
    }
  }
}

/* ---------------------------------------------------------------- helpers */

function existingFor(state: ForgeState, payload: unknown): ForgeRecord | null {
  if (typeof payload !== 'object' || payload === null) return null
  const name = (payload as Record<string, unknown>).name
  if (typeof name !== 'string') return null
  return findForgePackageByName(state, name.trim())
}

function truncate(value: string, max = FORGE_LIMITS.maxDescriptionChars): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function hashInput(input: unknown): string {
  const text = JSON.stringify(input ?? null)
  // A local, dependency-free digest is enough here: this hash exists to detect
  // "the same input again" and "the same output again", not to resist an attacker
  // who already owns the journal.
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return `h${hash.toString(16).padStart(8, '0')}`
}

function readImportEnvelope(raw: unknown): { ok: true; value: ForgeImportEnvelope } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'an export envelope must be an object' }
  }
  const value = raw as Record<string, unknown>
  if (typeof value.manifest !== 'object' || value.manifest === null) {
    return { ok: false, reason: 'an export envelope carries a manifest' }
  }
  const name = typeof value.name === 'string' ? value.name : ''
  if (name.length === 0 || name.length > FORGE_LIMITS.maxNameChars) {
    return { ok: false, reason: 'an export envelope names its package' }
  }
  if (typeof value.integrityHash !== 'string' || value.integrityHash.length === 0) {
    return { ok: false, reason: 'an export envelope carries the integrity hash it claims' }
  }
  return {
    ok: true,
    value: {
      skillId: typeof value.skillId === 'string' ? value.skillId : forgePackageId(name),
      name,
      version: typeof value.version === 'number' ? value.version : 1,
      integrityHash: value.integrityHash,
      manifest: value.manifest,
    },
  }
}

function isForgeOrigin(value: unknown): value is ForgeOrigin {
  return value === 'owner-authored' || value === 'forge-generated' || value === 'local-import' || value === 'acquired-remote'
}

/**
 * Which packages need the owner to decide before they are installed.
 *
 * A remote package always does, because its author is unknown. So does any
 * package that declares a capability, because declaring one is a request for
 * authority and the answer is a person's. A purely local transform with no
 * declared capability and no dependencies does not: there is nothing to decide
 * beyond "it passed", and asking anyway trains people to click through.
 */
function defaultApprovalRequired(manifest: ForgeManifest): boolean {
  return (
    manifest.provenance.origin === 'acquired-remote' ||
    manifest.capabilitiesRequired.length > 0 ||
    manifest.dependencies.length > 0
  )
}

