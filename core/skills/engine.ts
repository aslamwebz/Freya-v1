import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../protocol/core-protocol'
import type { WorkRegistry } from '../work/capability'
import type {
  SkillCommandOutcome,
  SkillDetailView,
  SkillProjection,
  SkillSelectionReport,
} from '../protocol/skills'
import { admitSkill, parseEvaluationRequest, type AdmissionRecord } from './admission'
import { evaluateOutcome } from './evaluation'
import { ClosedSkillExecutionPort, planSkillExecution, type SkillExecutionOutcome, type SkillExecutionPort } from './execution'
import { deriveSkillId, skillContentHash } from './identity'
import {
  InertSkillArtifactSink,
  assertMutableTarget,
  normaliseArtifactRef,
  planRevision,
  promoteIntoRuntime,
  wouldRaiseTrustClass,
  type SkillArtifactSink,
} from './improvement'
import { currentVersionEvaluations, decidePromotion } from './promotion'
import { projectSkills, skillDetailView } from './projection'
import { selectSkills } from './selection'
import { findSkill, findSkillByName, type SkillFoldRecord, type SkillState } from './state'
import {
  SKILL_LIMITS,
  canTransitionSkill,
  isSkillRetirementReason,
  isSkillStatus,
  SKILL_TERMINAL_STATUSES,
  type ImprovementTarget,
  type SkillRecord,
  type SkillRefusalCode,
  type SkillRetirementReason,
  type SkillStatus,
} from './types'

/**
 * THE SKILL ENGINE — admission, evaluation, promotion, selection and bounded
 * improvement, over a journal-derived fold and an encrypted body store.
 *
 * ## What this file cannot do
 *
 * It imports no gateway, no provider, no authority object, no `node:fs` and no
 * network. Its only impure dependency is the injected `EventFabric`, and its only
 * write outside the journal is a commit to the injected persistence runtime. That is
 * not tidiness — it is the property that makes "idle, startup and read paths cost
 * zero model calls" true by construction rather than by a test that happens to pass.
 *
 * ## The order of authority
 *
 * 1. **The fold** decides what exists. Status, version, verification and evaluations
 *    come from `skill.*` events and are never read from a live in-memory map.
 * 2. **The body store** decides what a skill *says*. A body is only ever used when the
 *    fold vouches for that skill at that version (`execution.ts` checks the pair).
 * 3. **Code-owned tables** decide what is allowed. The transition table, the forbidden
 *    capability list, the promotion thresholds, the closed vocabularies.
 * 4. **The owner scope** decides who may act. Admission, promotion and retirement are
 *    reachable only through the object Core issues; there is no way to acquire it by
 *    naming a capability.
 *
 * ## Two layers, on purpose
 *
 * The journal holds *metadata* — ids, closed labels, counts, instants, measured
 * lengths, slug-shaped applicability tags — and the encrypted store holds the *body*.
 * A stolen laptop yields neither a procedure nor its capability map. A rewritten
 * journal can move statuses around but cannot introduce a body, because the engine
 * only reads a body the fold vouches for.
 */

export interface SkillEngineOptions {
  readonly fabric: EventFabric
  /** Metadata authority. The fold, owned by Core's reducer. */
  readonly getState: () => SkillState
  /** Commit the retained bodies. Absent means this Core keeps them in memory. */
  readonly persistence?: { commit(records: readonly SkillRecord[]): void; health(): { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null } } | null
  /** What this Core can actually execute. Read at admission, never written. */
  readonly registry: WorkRegistry
  /** The narrow read port onto Work. Defaults to a port that says no to everything. */
  readonly work?: SkillExecutionPort
  /** Where an artifact candidate would go. The shipped sink declines promotion. */
  readonly artifacts?: SkillArtifactSink
  readonly now?: () => Date
  readonly newId?: () => string
  readonly onChange?: () => void
  /** Read fresh, per decision. A stopped Freya admits, promotes and plans nothing. */
  readonly stopAll: () => boolean
}

/**
 * The owner's face of skills.
 *
 * Holding this object is the authority to admit, revise, promote, retire and propose.
 * It is issued by Core and is not on any interface a window can name — the same
 * decision the attention source scope and the workforce owner scope make.
 *
 * Notice what it has **no** method for: evaluating a skill (Core derives evaluations
 * from evidence), executing one (only Work does), granting a capability, approving an
 * action, or touching any protected domain.
 */
export interface SkillOwnerScope {
  admit(payload: unknown, trustClass?: 'owner-declared' | 'untrusted-content'): Promise<SkillCommandOutcome>
  revise(skillId: string, payload: unknown): Promise<SkillCommandOutcome>
  recordEvaluation(payload: unknown): Promise<SkillCommandOutcome>
  transition(skillId: string, to: SkillStatus): Promise<SkillCommandOutcome>
  retire(skillId: string, reason: SkillRetirementReason): Promise<SkillCommandOutcome>
  propose(payload: unknown): Promise<SkillCommandOutcome>
  settle(proposalId: string, decision: 'accepted' | 'refused', reason: SkillRefusalCode): Promise<SkillCommandOutcome>
  /** Record an artifact candidate and be told it may not enter runtime. */
  offerArtifact(payload: unknown): Promise<SkillCommandOutcome>
  /** Read one skill's private body. */
  detail(skillId: string): SkillDetailView | null
}

export class SkillEngine {
  private readonly fabric: EventFabric
  private readonly getState: () => SkillState
  private readonly persistence: NonNullable<SkillEngineOptions['persistence']> | null
  private readonly registry: WorkRegistry
  private readonly work: SkillExecutionPort
  private readonly artifacts: SkillArtifactSink
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly onChange: () => void
  private readonly stopAll: () => boolean

  /** Bodies recovered from the store, keyed by skill id. Never a second truth. */
  private readonly bodies = new Map<string, SkillRecord>()
  /** The last selection a caller asked for. Reported, never recomputed on read. */
  private lastSelection: SkillSelectionReport | null = null
  private opened = false

  constructor(options: SkillEngineOptions) {
    this.fabric = options.fabric
    this.getState = options.getState
    this.persistence = options.persistence ?? null
    this.registry = options.registry
    this.work = options.work ?? new ClosedSkillExecutionPort()
    this.artifacts = options.artifacts ?? new InertSkillArtifactSink()
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.onChange = options.onChange ?? (() => {})
    this.stopAll = options.stopAll
  }

  /**
   * Adopt recovered bodies, and drop any the journal does not vouch for.
   *
   * The journal is the authority for what exists, so a body with no record is
   * discarded rather than adopted. Doing it the other way round would let anyone who
   * can write the encrypted file introduce a skill Core never recorded.
   */
  async open(recovered: readonly SkillRecord[]): Promise<void> {
    if (this.opened) return
    this.opened = true
    const state = this.getState()
    for (const body of recovered) {
      const record = findSkill(state, body.skillId)
      if (record === null) continue
      if (record.version !== body.version) continue
      if (findSkillByName(state, body.name)?.skillId !== body.skillId) continue
      this.bodies.set(body.skillId, body)
    }
  }

  projection(): SkillProjection {
    return projectSkills({
      sequence: this.fabric.lastSequence,
      state: this.getState(),
      persistence: this.persistence?.health() ?? {
        mode: 'ephemeral' as const,
        durable: false,
        reason: 'this Core holds skill procedures in this process only',
      },
      lastSelection: this.lastSelection,
    })
  }

  /* ------------------------------------------------------------- internals */

  private persist(): void {
    // `this.persistence` is narrowed into a local because it is a `readonly` field on
    // a class whose methods are called from async contexts; the local keeps the check
    // local to this statement instead of leaking an `undefined` into `commit`.
    const persistence = this.persistence
    if (persistence === null) return
    persistence.commit([...this.bodies.values()])
  }

  private async rejection(attemptId: string, code: SkillRefusalCode, targetRef: string | null): Promise<SkillCommandOutcome> {
    // Journalled rather than dropped: an unaudited refusal hides a probing pattern,
    // and the payload carries a *code* and a bounded ref, never any submitted text.
    await this.fabric.append(
      'skill.proposal.rejected',
      { attemptId, code, targetRef },
      { actor: 'system', correlationId: attemptId },
    )
    this.onChange()
    return { operation: 'refused', ok: false, code, reason: `this Core refused that (${code})` }
  }

  private bodyOf(skillId: string): SkillRecord | null {
    return this.bodies.get(skillId) ?? null
  }

  /** Mirror a folded status change onto the stored body, so detail reads agree. */
  private syncBody(record: SkillFoldRecord, now: string): void {
    const body = this.bodyOf(record.skillId)
    if (body === null) return
    this.bodies.set(record.skillId, {
      ...body,
      status: record.status,
      verification: record.verification,
      promotedAt: record.promotedAt,
      retiredAt: record.retiredAt,
      retirementReason: record.retirementReason,
      updatedAt: now,
    })
    this.persist()
  }

  /* ----------------------------------------------------------------- admit */

  async admit(
    payload: unknown,
    admittedBy: PrincipalId,
    trustClass: 'owner-declared' | 'untrusted-content' = 'owner-declared',
  ): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    if (this.stopAll()) {
      return this.refuseLocally(attemptId, 'stop-all', 'Freya is stopped, so nothing is admitted')
    }

    const parsed = admitSkill({
      // The source is Core's, never the payload's. A window cannot claim `core`.
      source: 'owner',
      trustClass,
      admittedBy,
      originRef: 'renderer',
      registry: this.registry,
      payload,
      existing: null,
    })
    if (!parsed.ok) return await this.rejection(attemptId, parsed.code, targetRefOf(payload))

    // Identity is derived from the name, so admitting a name that already exists is a
    // **refusal** rather than a second record — and the refusal says what to do instead.
    // Without this the caller would get `ok: true` for a skill the fold had silently
    // dropped, which is the worst of both answers: a success that changed nothing.
    const existing = findSkillByName(this.getState(), parsed.record.name)
    if (existing !== null) {
      return await this.rejection(
        attemptId,
        'duplicate-identity',
        parsed.record.name,
      )
    }

    const outcome = await this.appendAdmission(parsed.record, false)
    if (!outcome.ok) return outcome
    return {
      operation: 'admitted',
      ok: true,
      skillId: parsed.record.skillId,
      version: parsed.record.version,
      status: 'candidate',
    }
  }

  /** Write an admitted or revised body and its journal line. Shared by both. */
  private async appendAdmission(
    record: AdmissionRecord,
    revision: boolean,
  ): Promise<SkillCommandOutcome> {
    const now = this.now()
    const nowIso = now.toISOString()
    const existing = revision ? findSkill(this.getState(), record.skillId) : null
    const stored: SkillRecord = {
      skillId: record.skillId,
      name: record.name,
      kind: record.kind,
      status: 'candidate',
      version: record.version,
      verification: 'unverified',
      contentHash: record.contentHash,
      summary: record.summary,
      contract: record.contract,
      steps: record.steps,
      requiredCapabilities: record.requiredCapabilities,
      applicability: record.applicability,
      provenance: {
        source: record.source,
        trustClass: record.trustClass,
        admittedBy: record.admittedBy,
        admittedAt: existing === null ? nowIso : existing.admittedAt,
        parentSkillId: revision ? record.skillId : null,
        parentVersion: revision ? record.version - 1 : null,
        originRef: record.originRef,
      },
      createdAt: existing === null ? nowIso : nowIso,
      updatedAt: nowIso,
      retiredAt: null,
      retirementReason: null,
      promotedAt: null,
    }

    this.bodies.set(record.skillId, stored)

    const contract = stored.contract
    await this.fabric.append(
      revision ? 'skill.revised' : 'skill.admitted',
      {
        skillId: stored.skillId,
        name: stored.name,
        nameLength: stored.name.length,
        kind: stored.kind,
        version: stored.version,
        contentHash: stored.contentHash,
        source: stored.provenance.source,
        trustClass: stored.provenance.trustClass,
        admittedBy: stored.provenance.admittedBy,
        originRef: stored.provenance.originRef,
        stepCount: stored.steps.length,
        requiredCapabilityCount: stored.requiredCapabilities.length,
        applicabilityCount: stored.applicability.length,
        applicability: [...stored.applicability],
        inputCount: contract.inputs.length,
        outputCount: contract.outputs.length,
        preconditionCount: contract.preconditions.length,
        postconditionCount: contract.postconditions.length,
        summaryLength: stored.summary.length,
      },
      { actor: 'system', correlationId: stored.skillId },
    )
    this.persist()
    this.onChange()
    return {
      operation: revision ? 'revised' : 'admitted',
      ok: true,
      skillId: stored.skillId,
      version: stored.version,
      status: 'candidate',
    }
  }

  /* ---------------------------------------------------------------- revise */

  async revise(skillId: string, payload: unknown, admittedBy: PrincipalId): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    if (this.stopAll()) {
      return this.refuseLocally(attemptId, 'stop-all', 'Freya is stopped, so nothing is revised')
    }
    const record = findSkill(this.getState(), skillId)
    if (record === null) return this.refuseLocally(attemptId, 'no-such-skill', 'there is no such skill')
    if (SKILL_TERMINAL_STATUSES.includes(record.status as 'retired')) {
      return this.refuseLocally(
        attemptId,
        'illegal-transition',
        `a ${record.status} skill is never revised in place; admit it again as a new procedure`,
      )
    }

    const current = this.bodyOf(record.skillId)
    const currentHash = current?.contentHash ?? record.versions.find((v) => v.version === record.version)?.contentHash ?? ''
    // `version - 1`, not the metadata counter: the metadata counter belongs to the
    // version being *left*, and it resets to zero on every revision, so it cannot bound
    // a loop that always revises what it just created.
    const revisionsSoFar = record.version - 1

    // A revision inherits its parent's trust class and never raises it. This is the
    // laundering route's lock: `untrusted-content` stays `untrusted-content` forever,
    // however many times it is revised and however good the evidence gets.
    const trustClass = record.trustClass

    const parsed = admitSkill({
      source: 'improvement',
      trustClass,
      admittedBy,
      originRef: 'revision',
      registry: this.registry,
      payload,
      existing: { skillId: record.skillId, version: record.version },
    })
    if (!parsed.ok) return await this.rejection(attemptId, parsed.code, skillId)

    if (wouldRaiseTrustClass(record.trustClass, parsed.record.trustClass)) {
      return await this.rejection(attemptId, 'boundary-violation', skillId)
    }

    const plan = planRevision({
      currentVersion: record.version,
      revisionsSoFar,
      currentContentHash: currentHash,
      proposedContentHash: parsed.record.contentHash,
      summary: parsed.record.summary,
    })
    if (plan.refusal !== null) return await this.rejection(attemptId, plan.refusal, skillId)

    return await this.appendAdmission(parsed.record, true)
  }

  /* ------------------------------------------------------------- evaluation */

  async recordEvaluation(
    payload: unknown,
    author: 'system' | 'owner',
    fromCommand: boolean,
  ): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    const nowIso = this.now().toISOString()
    const parsed = parseEvaluationRequest(
      {
        skillId: (payload as Record<string, unknown> | null)?.skillId,
        subjectKind: (payload as Record<string, unknown> | null)?.subjectKind,
        subjectRef: (payload as Record<string, unknown> | null)?.subjectRef,
        evidence: (payload as Record<string, unknown> | null)?.evidence,
        verification: (payload as Record<string, unknown> | null)?.verification,
        metrics: (payload as Record<string, unknown> | null)?.metrics,
        commentaryLength: (payload as Record<string, unknown> | null)?.commentaryLength,
        author,
        fromCommand,
      },
      nowIso,
    )
    if (!parsed.ok) return this.refuseLocally(attemptId, parsed.code, parsed.reason)

    const record = findSkill(this.getState(), parsed.value.skillId)
    if (record === null) return this.refuseLocally(attemptId, 'no-such-skill', 'there is no such skill')

    const decision = evaluateOutcome({
      evidence: parsed.value.evidence,
      verification: parsed.value.verification,
      metrics: parsed.value.metrics,
      commentary: parsed.value.commentary,
    })
    const evaluationId = this.newId()

    await this.fabric.append(
      'skill.evaluation.recorded',
      {
        evaluationId,
        skillId: record.skillId,
        // The version is Core's own, read from the record. A caller naming a version
        // would be the stale-evidence-reuse attack in its simplest form.
        version: record.version,
        subjectKind: parsed.value.subjectKind,
        subjectRef: parsed.value.subjectRef,
        author: parsed.value.author,
        verdict: decision.verdict,
        reason: decision.reason,
        deterministicCount: decision.deterministicCount,
        positiveCount: decision.positiveCount,
        negativeCount: decision.negativeCount,
        commentaryChars: decision.commentaryChars,
      },
      { actor: author === 'owner' ? 'owner' : 'system', correlationId: record.skillId },
    )
    this.onChange()
    return {
      operation: 'evaluated',
      ok: true,
      skillId: record.skillId,
      version: record.version,
      evaluationId,
    }
  }

  /* ------------------------------------------------------------- transition */

  async transition(
    skillId: string,
    to: SkillStatus,
    requestedBy: 'system' | 'owner',
  ): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    if (!isSkillStatus(to)) {
      return this.refuseLocally(attemptId, 'illegal-transition', `${String(to)} is not a skill status`)
    }
    if (this.stopAll()) {
      return this.refuseLocally(attemptId, 'stop-all', 'Freya is stopped, so no skill changes status')
    }
    const record = findSkill(this.getState(), skillId)
    if (record === null) return this.refuseLocally(attemptId, 'no-such-skill', 'there is no such skill')

    const now = this.now()
    const decision = decidePromotion({ record, to, now, requestedBy })
    if (!decision.allowed) {
      return await this.rejection(attemptId, decision.reason === 'evaluation-basis' ? 'evidence-insufficient' : 'evidence-insufficient', skillId)
    }

    // Belt and braces: the transition table is checked here as well as inside
    // `decidePromotion`, so a future caller of this method cannot skip it.
    if (!canTransitionSkill(record.status, to)) {
      return this.refuseLocally(attemptId, 'illegal-transition', `a skill cannot go from ${record.status} to ${to}`)
    }

    await this.fabric.append(
      'skill.transitioned',
      {
        skillId,
        from: record.status,
        to,
        reason: decision.reason ?? 'evaluation-basis',
        evidence: {
          version: decision.evidence.version,
          established: decision.evidence.established,
          contradicted: decision.evidence.contradicted,
          distinctSubjects: decision.evidence.distinctSubjects,
        },
      },
      { actor: requestedBy === 'owner' ? 'owner' : 'system', correlationId: skillId },
    )
    const after = findSkill(this.getState(), skillId)
    if (after !== null) this.syncBody(after, now.toISOString())
    this.onChange()
    return { operation: 'transitioned', ok: true, skillId, version: record.version, status: to }
  }

  async retire(
    skillId: string,
    reason: SkillRetirementReason,
  ): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    if (!isSkillRetirementReason(reason)) {
      return this.refuseLocally(attemptId, 'illegal-transition', `${String(reason)} is not a retirement reason`)
    }
    const record = findSkill(this.getState(), skillId)
    if (record === null) return this.refuseLocally(attemptId, 'no-such-skill', 'there is no such skill')
    if (SKILL_TERMINAL_STATUSES.includes(record.status as 'retired')) {
      return this.refuseLocally(attemptId, 'illegal-transition', `this skill is already ${record.status}`)
    }
    const now = this.now().toISOString()
    await this.fabric.append(
      'skill.retired',
      {
        skillId,
        version: record.version,
        to: reason === 'unsafe' || reason === 'boundary-violation' ? 'blocked' : 'retired',
        reason,
      },
      { actor: 'owner', correlationId: skillId },
    )
    const after = findSkill(this.getState(), skillId)
    if (after !== null) this.syncBody(after, now)
    this.onChange()
    return {
      operation: 'retired',
      ok: true,
      skillId,
      version: record.version,
      status: reason === 'unsafe' || reason === 'boundary-violation' ? 'blocked' : 'retired',
    }
  }

  /* --------------------------------------------------------------- selection */

  select(request: {
    applicability?: readonly string[]
    includeTrial?: boolean
    includeVerified?: boolean
    limit?: number
  }): SkillSelectionReport {
    const report = selectSkills(this.getState(), { ...request, now: this.now() })
    this.lastSelection = {
      candidates: report.candidates.map((candidate) => ({
        skillId: candidate.skillId,
        name: candidate.name,
        kind: candidate.kind,
        status: candidate.status,
        version: candidate.version,
        verification: candidate.verification,
        trustClass: candidate.trustClass,
        establishedCount: candidate.establishedCount,
        matchedTags: candidate.matchedTags,
        executionsPlanned: candidate.executionsPlanned,
      })),
      considered: report.considered,
      emptyReason: report.emptyReason,
    }
    return this.lastSelection
  }

  /* ------------------------------------------------------------ improvement */

  async propose(payload: unknown, proposedBy: 'system' | 'owner'): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    const raw = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    const verdict = assertMutableTarget({ target: raw.target, targetRef: raw.targetRef, summary: raw.summary })
    if (!verdict.ok) {
      return await this.rejection(attemptId, verdict.code ?? 'boundary-violation', verdict.targetRef)
    }

    const state = this.getState()
    const openProposalsAt = state.proposals.filter((proposal) => proposal.status === 'open').length
    if (openProposalsAt >= SKILL_LIMITS.maxOpenProposals) {
      return this.refuseLocally(
        attemptId,
        'too-many-proposals',
        `Core already holds ${SKILL_LIMITS.maxOpenProposals} open improvement proposals`,
      )
    }

    const targetRef = verdict.targetRef ?? ''
    let skillId: string | null = null
    let baseVersion: number | null = null
    let basis: readonly string[] = []

    if (verdict.target === 'skill' || verdict.target === 'procedure') {
      skillId = targetRef
      const record = findSkill(state, skillId)
      if (record === null) {
        return this.refuseLocally(attemptId, 'no-such-skill', 'there is no such skill to improve')
      }
      baseVersion = record.version
      // The basis is *derived*, never supplied: a caller that could choose which
      // evidence a proposal rests on could propose an improvement from one good run.
      basis = currentVersionEvaluations(record).map((evaluation) => evaluation.evaluationId)
      if (basis.length === 0) {
        return this.refuseLocally(
          attemptId,
          'no-evaluation-basis',
          `nothing has been evaluated for version ${record.version}, so there is nothing to improve from`,
        )
      }
    } else {
      const normalised = normaliseArtifactRef(targetRef)
      if (normalised === null) {
        return this.refuseLocally(
          attemptId,
          'artifact-refused',
          'an artifact reference is a slug, not a path or a sentence',
        )
      }
    }

    const summaryLength = Math.min(
      String(raw.summary ?? '').length,
      SKILL_LIMITS.maxSummaryChars,
    )

    const proposalId = this.newId()
    await this.fabric.append(
      'skill.improvement.proposed',
      {
        proposalId,
        target: verdict.target as ImprovementTarget,
        targetRef,
        skillId,
        baseVersion,
        summaryLength,
        basisEvaluationIds: [...basis],
        proposedBy,
        openProposalsAt,
      },
      { actor: proposedBy === 'owner' ? 'owner' : 'system', correlationId: proposalId },
    )
    this.onChange()
    return { operation: 'proposed', ok: true, proposalId, skillId: skillId ?? undefined }
  }

  async settle(
    proposalId: string,
    decision: 'accepted' | 'refused',
    reason: SkillRefusalCode,
  ): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    const proposal = this.getState().proposals.find((entry) => entry.proposalId === proposalId)
    if (proposal === undefined || proposal.status !== 'open') {
      return this.refuseLocally(attemptId, 'no-evaluation-basis', 'there is no open proposal with that id')
    }
    if (decision === 'accepted' && reason !== 'no-evaluation-basis') {
      return this.refuseLocally(attemptId, reason, 'an acceptance needs no refusal code')
    }
    await this.fabric.append(
      'skill.improvement.settled',
      { proposalId, decision, reason: decision === 'refused' ? reason : 'accepted' },
      { actor: 'owner', correlationId: proposalId },
    )
    this.onChange()
    return { operation: 'settled', ok: true, proposalId }
  }

  /* ---------------------------------------------------------------- artifacts */

  async offerArtifact(payload: unknown): Promise<SkillCommandOutcome> {
    const attemptId = this.newId()
    const raw = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    const verdict = assertMutableTarget({
      target: 'implementation-artifact',
      targetRef: raw.targetRef,
      summary: raw.summary,
    })
    if (!verdict.ok || verdict.targetRef === null) {
      return await this.rejection(attemptId, verdict.code ?? 'artifact-refused', verdict.targetRef)
    }

    const state = this.getState()
    const skillId = typeof raw.skillId === 'string' ? raw.skillId : null
    const record = skillId === null ? null : findSkill(state, skillId)
    const artifactId = this.newId()

    const decision = await promoteIntoRuntime(this.artifacts, {
      artifactId,
      target: 'implementation-artifact',
      targetRef: verdict.targetRef,
      skillId: record?.skillId ?? null,
      baseVersion: record?.version ?? null,
      summaryLength: Math.min(String(raw.summary ?? '').length, SKILL_LIMITS.maxSummaryChars),
      proposedBy: 'owner',
    })

    // Journalled as a refusal even if a future sink accepted, because in this phase
    // nothing may enter runtime — and a refusal nobody can audit is the failure this
    // event family exists to prevent.
    await this.fabric.append(
      'skill.runtime.promotion.refused',
      { artifactId, targetRef: verdict.targetRef, reason: decision.reason ?? 'runtime-promotion-unavailable' },
      { actor: 'owner', correlationId: artifactId },
    )
    this.onChange()
    return {
      operation: 'refused',
      ok: false,
      code: decision.reason ?? 'runtime-promotion-unavailable',
      reason: decision.detail,
    }
  }

  /* --------------------------------------------------------------- execution */

  /**
   * Plan a skill into an existing Run/Step, or refuse in words.
   *
   * Pure with respect to the fold and the work port; the *record* of a successful
   * plan is a journal append, because "how often is this procedure used" is a fact
   * the projection reports and a registry that forgot it would under-report.
   */
  async plan(
    skillId: string,
    request: { missionId: string; runId: string; stepId: string; principal: PrincipalId },
  ): Promise<SkillExecutionOutcome> {
    const record = findSkill(this.getState(), skillId)
    const outcome = planSkillExecution({
      record,
      body: record === null ? null : this.bodyOf(record.skillId),
      request,
      work: this.work,
      stopAll: this.stopAll,
    })
    if (!outcome.ok) return outcome
    await this.fabric.append(
      'skill.execution.planned',
      {
        skillId: outcome.plan.skillId,
        version: outcome.plan.version,
        runId: outcome.plan.runId,
        stepId: outcome.plan.stepId,
        stepCount: outcome.plan.steps.length,
      },
      { actor: 'system', correlationId: outcome.plan.runId },
    )
    this.onChange()
    return outcome
  }

  /* ------------------------------------------------------------------ reads */

  detail(skillId: string): SkillDetailView | null {
    const record = findSkill(this.getState(), skillId)
    if (record === null) return null
    // A body is only ever returned when the fold vouches for this skill at this
    // version, so a stale cache can never be read as the skill's real contract.
    const body = this.bodyOf(record.skillId)
    if (body === null || body.version !== record.version) return null
    return skillDetailView(body)
  }

  /** The owner's scope. Issued by Core, never acquired by naming a capability. */
  ownerScope(principal: PrincipalId): SkillOwnerScope {
    return {
      admit: (payload, trustClass) => this.admit(payload, principal, trustClass),
      revise: (skillId, payload) => this.revise(skillId, payload, principal),
      recordEvaluation: (payload) => this.recordEvaluation(payload, 'owner', true),
      transition: (skillId, to) => this.transition(skillId, to, 'owner'),
      retire: (skillId, reason) => this.retire(skillId, reason),
      propose: (payload) => this.propose(payload, 'owner'),
      settle: (proposalId, decision, reason) => this.settle(proposalId, decision, reason),
      offerArtifact: (payload) => this.offerArtifact(payload),
      detail: (skillId) => this.detail(skillId),
    }
  }

  /** A refusal that never reaches the journal, because nothing was attempted. */
  private refuseLocally(
    _attemptId: string,
    code: SkillRefusalCode,
    reason: string,
  ): SkillCommandOutcome {
    return { operation: 'refused', ok: false, code, reason }
  }
}

/** A bounded, non-content reference out of a payload, for the rejection record. */
function targetRefOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const raw = (payload as Record<string, unknown>).name ?? (payload as Record<string, unknown>).skillId
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > SKILL_LIMITS.maxRefChars) return null
  return /^[A-Za-z0-9._:-]+$/.test(raw) ? raw : null
}

/** Re-exported so Core can derive a skill id without importing `identity` directly. */
export { deriveSkillId, skillContentHash }