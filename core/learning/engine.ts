import { deriveLearning, deriveProposals } from './derive'
import {
  admitKnowledgeRecord,
  admitLearningExperience,
  createKnowledgeRecord,
  createLearningExperience,
  expireKnowledgeRecord,
  expireLearningExperience,
  rejectKnowledgeRecord,
  rejectLearningExperience,
  retractKnowledgeRecord,
  supersedeKnowledgeRecord,
} from './experience'
import { createVerifiedOutcome, sourceOfOutcome } from './outcome'
import { admitToSkills, assertProposalIsInert, type SkillAdmissionPacket } from './safeguards'
import { applyRecord, recordKey, type LearningRecord } from './fold'
import { LearningStoreError, type LearningStore } from './store'
import {
  LEARNING_LIMITS,
  instantMs,
  isForbiddenLearningFieldName,
  isLearningKnowledgeKind,
  isLearningRef,
  isLearningScope,
  isLearningScopeLimit,
  type Confidence,
  type KnowledgeRecord,
  type LearningDerivation,
  type LearningExperience,
  type LearningExperienceKind,
  type LearningKnowledgeKind,
  type LearningScope,
  type LearningScopeLimit,
  type ProcedureProposal,
  type SourceTrust,
  type VerifiedOutcome,
} from './types'
import {
  exportLearning,
  projectLearning,
  projectLearningClaim,
  projectLearningRecords,
  type LearningProjectionInput,
} from './projection'
import {
  LEARNING_SCHEMA_VERSION,
  type LearningClaimReadOutcome,
  type LearningExportItemView,
  type LearningExportOutcome,
  type LearningExportView,
  type LearningPersistenceView,
  type LearningProjection,
  type LearningRecordsOutcome,
  type LearningWriteOutcome,
} from '../protocol/learning'

/**
 * THE LEARNING ENGINE — the trusted pathways, and nothing else.
 *
 * Every way a learning record comes into existence is a named method, and **each one
 * fixes its own trust class**:
 *
 * ```
 *  recordVerifiedOutcome()  → the trust class is derived from where the check happened
 *  distilExperience()       → derived from the outcome it came from
 *  deriveKnowledge()        → the owner's or Core's own claim, never an inference from a model
 *  recordOwnerLesson()      → 'owner-assertion'
 * ```
 *
 * There is no method that accepts a `SourceTrust`, and no statement input with a source
 * field, so "record this as something a verifier checked" is not a value a caller can
 * supply. The one place a source *is* derived — an outcome's — is derived from the domain
 * that produced the check, which is code-owned, and an unrecognised domain resolves to the
 * weakest class rather than to something Core observed.
 *
 * ## The owner's acts
 *
 * `correct`, `withdraw`, `forget` and `export`, plus `reject` for a candidate. `withdraw`
 * destroys the text and keeps the fact; `forget` removes the row and **refuses a live
 * record**, so total destruction is always a separate, deliberate act.
 *
 * ## The exit
 *
 * `proposals()` returns inert proposals and `skillPackets()` turns them into packets for
 * `core/skills`. Neither of them can promote, execute or activate anything, and this
 * module imports no gateway, no authority object and no file system. The Skills domain
 * decides what happens next, on its own evidence, starting every admission at `candidate`.
 */

export interface VerifiedOutcomeInput {
  readonly outcomeId: string
  readonly sourceDomain: VerifiedOutcome['sourceDomain']
  readonly verificationId: string
  readonly verifierId: string
  readonly checked: string
  readonly subjectRef: string
  readonly result: VerifiedOutcome['result']
  readonly establishedAt: string
  readonly proposedConfidence?: Confidence
  readonly actor?: string
}

export interface ExperienceInput {
  readonly experienceId: string
  readonly kind: LearningExperienceKind
  readonly lesson: string
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  readonly tags?: readonly string[]
  readonly observedAt: string
}

export interface KnowledgeInput {
  readonly knowledgeId: string
  readonly kind: LearningKnowledgeKind
  readonly claim: string
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  /** Admitted experience ids this claim rests on. Never empty. */
  readonly supports: readonly string[]
  readonly tags?: readonly string[]
  readonly observedAt: string
}

export interface LearningEngineOptions {
  readonly store: LearningStore
  /** Injected so every instant is a test's choice rather than the host's wall clock. */
  readonly now?: () => Date
  readonly newId?: () => string
  /** Read fresh at each decision. Stops every write; reads stay available. */
  readonly stopped?: () => boolean
  readonly onChange?: () => void
}

export class LearningEngine {
  private readonly store: LearningStore
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly stopped: () => boolean
  private readonly onChange: () => void
  private counter = 0

  constructor(options: LearningEngineOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => `learning-${(this.counter += 1)}`)
    this.stopped = options.stopped ?? (() => false)
    this.onChange = options.onChange ?? (() => {})
  }

  /* ------------------------------------------------------------ stage one */

  /**
   * Record that a check passed.
   *
   * The trust class comes from `sourceDomain`, which the trusted caller supplies because it
   * is the domain that owns the verifier. Nothing else about the record is taken from the
   * caller except the bounded description of what was examined.
   */
  async recordVerifiedOutcome(input: VerifiedOutcomeInput): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    const source = sourceOfOutcome({
      outcomeId: input.outcomeId,
      sourceDomain: input.sourceDomain,
      verificationId: input.verificationId,
      verifierId: input.verifierId,
      checked: input.checked,
      subjectRef: input.subjectRef,
      result: input.result,
      establishedAt: input.establishedAt,
    })
    const created = createVerifiedOutcome(
      {
        outcomeId: input.outcomeId,
        sourceDomain: input.sourceDomain,
        verificationId: input.verificationId,
        verifierId: input.verifierId,
        checked: input.checked,
        subjectRef: input.subjectRef,
        result: input.result,
        establishedAt: input.establishedAt,
        // A path that reports a check is reporting an observation, so the strongest
        // confidence it may propose is `medium` and any higher proposal is refused rather
        // than capped down quietly.
        proposedConfidence: input.proposedConfidence ?? 'medium',
        actor: input.actor ?? 'core',
      },
      source,
    )
    if (!created.ok) return refuse(created.code, created.reason)
    await this.persist({ version: 1, kind: 'outcome', outcome: created.value })
    this.onChange()
    return { ok: true, outcome: 'recorded', recordId: created.value.outcomeId, reason: 'the checked outcome was recorded', superseded: null }
  }

  /* ------------------------------------------------------------ stage two */

  /**
   * Distil one checked outcome into a lesson.
   *
   * The evidence rule is enforced here rather than trusted to the caller: the outcome must
   * exist in the store, and the outcome id must appear among the experience's evidence
   * refs. A caller that names an outcome id Core never recorded gets
   * `no-verification-evidence` rather than a lesson resting on nothing.
   */
  async distilExperience(outcomeId: string, input: ExperienceInput): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    const outcome = this.store.state().outcomes.get(outcomeId)
    if (outcome === undefined) {
      return refuse('no-outcome', 'no checked outcome with that id has been recorded')
    }
    const created = createLearningExperience(
      {
        // The caller's fields are spread rather than re-listed, so an untyped payload that
        // carries something extra is *refused* by the constructor's forbidden-field and
        // exact-key rules instead of being quietly dropped on the way in. A field this
        // engine silently discarded today is a field somebody will read next month.
        ...input,
        experienceId: input.experienceId,
        tags: input.tags ?? [],
        evidenceRefs: [outcomeId],
        observedAt: input.observedAt,
        proposedConfidence: 'medium',
        actor: 'core',
      },
      sourceOfOutcome(outcome),
      {
        outcomeId,
        outcomeSourceDomain: outcome.sourceDomain,
        outcomeResult: outcome.result,
      },
    )
    if (!created.ok) return refuse(created.code, created.reason)
    const admitted = admitLearningExperience(created.value, {
      now: this.nowIso(),
      reason: 'distilled from a checked outcome',
    })
    if (!admitted.ok) return refuse(admitted.code, admitted.reason)
    await this.persist({ version: 1, kind: 'experience', experience: admitted.value })
    // The bound runs *after* the write, so the stored live set is never left one record over
    // the limit. Retention follows when something was observed, not when Core heard about it.
    await this.applyRetentionBound()
    this.onChange()
    return {
      ok: true,
      outcome: 'distilled',
      recordId: admitted.value.experienceId,
      reason: 'the lesson was distilled and bounded to what the check established',
      superseded: null,
    }
  }

  /**
   * Record a lesson the owner stated outright.
   *
   * An owner assertion is admitted as `owner-assertion` — capped at `medium` like
   * everything else here, because a claim generalises and the owner being sure of it does
   * not make it an observation. It is admitted as an **experience**, not a claim, so it
   * still has to be supported before anything can be proposed from it.
   */
  async recordOwnerLesson(input: ExperienceInput): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    // An owner lesson still names a checked outcome. There is no "the owner told me so"
    // path into learning, because a claim with no check behind it is a rule, and this
    // domain does not hold rules.
    return this.distilExperience(input.experienceId, input)
  }

  /* ---------------------------------------------------------- stage three */

  /**
   * Distil one or more admitted experiences into a claim.
   *
   * Two refusals carry the phase and both are enforced against the **store**, not the
   * input: an experience id that is not admitted is not counted as support, and a claim
   * left with no admitted support is refused. That is what stops a caller from writing
   * `supports: ['exp-that-does-not-exist']` and getting a stored claim.
   */
  async deriveKnowledge(input: KnowledgeInput, source: 'core' | 'owner' = 'core'): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    const state = this.store.state()
    const admitted = input.supports
      .map((id) => state.experiences.get(id))
      .filter((entry): entry is LearningExperience => entry !== undefined && entry.status === 'admitted')
    if (admitted.length === 0) {
      return refuse(
        'no-supporting-experience',
        'a claim must rest on at least one admitted experience; none of the cited ids is admitted',
      )
    }
    const verificationIds = [
      ...new Set(
        admitted
          .map((entry) => state.outcomes.get(entry.outcomeId)?.verificationId)
          .filter((id): id is string => id !== undefined),
      ),
    ]
    if (verificationIds.length === 0) {
      return refuse('no-verification-evidence', 'a claim must rest on at least one verification id')
    }
    const trustClass: SourceTrust = source === 'owner' ? 'owner-assertion' : 'experience-outcome'
    const created = createKnowledgeRecord(
      {
        // Spread, not re-listed: an extra field from an untyped payload is refused rather
        // than dropped. The engine decides `supports` and `verificationIds` because it is
        // the only place that can check them against the store.
        ...input,
        knowledgeId: input.knowledgeId,
        tags: input.tags ?? [],
        supports: admitted.map((entry) => entry.experienceId),
        verificationIds,
        observedAt: input.observedAt,
        proposedConfidence: 'medium',
        actor: source === 'owner' ? 'owner' : 'core',
      },
      trustClass,
    )
    if (!created.ok) return refuse(created.code, created.reason)
    const admittedRecord = admitKnowledgeRecord(created.value, {
      now: this.nowIso(),
      reason: 'distilled from admitted experiences',
    })
    if (!admittedRecord.ok) return refuse(admittedRecord.code, admittedRecord.reason)
    await this.persist({ version: 1, kind: 'knowledge', knowledge: admittedRecord.value })
    await this.applyRetentionBound()
    this.onChange()
    return {
      ok: true,
      outcome: 'distilled',
      recordId: admittedRecord.value.knowledgeId,
      reason: 'the claim was admitted with its evidence and its scope bound',
      superseded: null,
    }
  }

  /* ------------------------------------------------------------- owner acts */

  /**
   * Correct a claim. A replacement, not an edit.
   *
   * Writes the replacement first and supersedes the original second, so an interruption
   * between them leaves both live — which the derivation discloses as a conflict — rather
   * than leaving nothing. Losing a claim is worse than showing two.
   */
  async correct(
    recordId: string,
    replacement: { claim: string; reason: string; observedAt: string },
  ): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    const original = this.store.state().knowledge.get(recordId)
    if (original === undefined) return refuse('no-such-record', 'that knowledge record does not exist')
    if (original.status !== 'admitted') {
      return refuse('not-admitted', `only a live claim can be corrected, not ${original.status}`)
    }
    if (replacement.reason.length === 0 || replacement.reason.length > LEARNING_LIMITS.maxReasonChars) {
      return refuse('invalid-claim', 'a correction must carry a bounded non-empty reason')
    }
    const newId = this.newId()
    const written = await this.deriveKnowledge(
      {
        knowledgeId: newId,
        kind: original.kind,
        claim: replacement.claim,
        scope: original.scope,
        scopeLimits: original.scopeLimits,
        supports: original.supports,
        tags: original.tags,
        observedAt: replacement.observedAt,
      },
      original.provenance.sourceType === 'owner-assertion' ? 'owner' : 'core',
    )
    if (!written.ok) return written
    const superseded = supersedeKnowledgeRecord(original, { now: this.nowIso(), supersedes: newId })
    if (!superseded.ok) return refuse(superseded.code, superseded.reason)
    await this.persist({ version: 1, kind: 'knowledge', knowledge: superseded.value })
    this.onChange()
    return {
      ok: true,
      outcome: 'corrected',
      recordId: newId,
      reason: replacement.reason,
      superseded: recordId,
    }
  }

  /** Withdraw a claim. The claim text is destroyed; the fact that it was withdrawn is kept. */
  async withdraw(recordId: string): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    const record = this.store.state().knowledge.get(recordId)
    if (record === undefined) return refuse('no-such-record', 'that knowledge record does not exist')
    const result = retractKnowledgeRecord(record, { now: this.nowIso() })
    if (!result.ok) return refuse(result.code, result.reason)
    await this.persist({ version: 1, kind: 'knowledge', knowledge: result.value })
    this.onChange()
    return {
      ok: true,
      outcome: 'withdrawn',
      recordId,
      reason: 'the claim was withdrawn and its text destroyed',
      superseded: null,
    }
  }

  /**
   * Forget a record entirely: the row, the metadata, the withdrawal note.
   *
   * Refuses a live record and asks for the withdrawal first, so total destruction is always
   * a second, deliberate act and never a side effect of something else.
   */
  async forget(recordId: string): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    const state = this.store.state()
    const record = state.knowledge.get(recordId)
    const experience = state.experiences.get(recordId)
    if (record === undefined && experience === undefined) {
      return refuse('no-such-record', 'that learning record does not exist')
    }
    if ((record?.status ?? experience?.status) === 'admitted' || (record?.status ?? experience?.status) === 'candidate') {
      return refuse(
        'not-admitted',
        'withdraw the record before forgetting it; withdrawal keeps the fact that it was claimed',
      )
    }
    const key =
      record !== undefined
        ? recordKey({ version: 1, kind: 'knowledge', knowledge: record })
        : recordKey({ version: 1, kind: 'experience', experience: experience as LearningExperience })
    try {
      await this.store.forget(key)
    } catch (error) {
      return refuse('store-unavailable', describe(error))
    }
    this.onChange()
    return {
      ok: true,
      outcome: 'forgotten',
      recordId,
      reason: 'the record and its metadata were removed from the learning store',
      superseded: null,
    }
  }

  /** Reject a candidate outright. Never admitted, and never reaches a derivation. */
  async reject(recordId: string, reason: string): Promise<LearningWriteOutcome> {
    if (this.stopped()) return refuse('store-unavailable', 'the learning engine is stopped')
    const state = this.store.state()
    const experience = state.experiences.get(recordId)
    if (experience !== undefined && experience.status === 'candidate') {
      const result = rejectLearningExperience(experience, { now: this.nowIso(), reason })
      if (!result.ok) return refuse(result.code, result.reason)
      await this.persist({ version: 1, kind: 'experience', experience: result.value })
      this.onChange()
      return { ok: true, outcome: 'rejected', recordId, reason, superseded: null }
    }
    const record = state.knowledge.get(recordId)
    if (record === undefined) return refuse('no-such-record', 'that learning record does not exist')
    const rejected = rejectKnowledgeRecord(record, { now: this.nowIso(), reason })
    if (!rejected.ok) return refuse(rejected.code, rejected.reason)
    await this.persist({ version: 1, kind: 'knowledge', knowledge: rejected.value })
    this.onChange()
    return { ok: true, outcome: 'rejected', recordId, reason, superseded: null }
  }

  /* -------------------------------------------------------------- reads */

  /** The broad projection. Carries no lesson or claim text, by construction. */
  project(now?: string): LearningProjection {
    const input: LearningProjectionInput = {
      state: this.store.state(),
      persistence: this.persistence(),
      now: now ?? this.nowIso(),
    }
    return projectLearning(input)
  }

  /** The derivation itself, for a Core that wants the numbers rather than the view. */
  derive(now?: string): LearningDerivation {
    return deriveLearning(this.store.state(), now ?? this.nowIso())
  }

  /** A broad read of the pipeline: metadata only. */
  listRecords(options: { limit?: number; stage?: 'experience' | 'knowledge' } = {}): LearningRecordsOutcome {
    return projectLearningRecords(this.store.state(), options)
  }

  /** One claim's own words. Owner-only by construction: the engine is Core's own. */
  readClaim(recordId: string): LearningClaimReadOutcome {
    return projectLearningClaim(this.store.state(), recordId)
  }

  /** The owner's export. The one read that carries text at breadth, bounded and owner-only. */
  export(): LearningExportOutcome {
    return exportLearning(this.store.state(), this.persistence())
  }

  /**
   * Procedure proposals, above and below threshold.
   *
   * Both are returned. A surface that only ever saw the above-threshold ones would be
   * showing a flattering account of what Freya knows.
   */
  proposals(now?: string): readonly ProcedureProposal[] {
    // The full proposals, steps included — the only consumer is the Skills hand-off below,
    // which genuinely needs them. The derivation and the projection carry summaries.
    return deriveProposals(this.store.state(), now ?? this.nowIso())
  }

  /**
   * Packets for the Skills domain — and only above threshold.
   *
   * A below-threshold proposal is not offered at all: handing Skills something insufficient
   * would put the burden of re-deriving support in a domain that does not have the
   * evidence. It is still *reported*, so the owner can see what was noticed and not
   * established.
   */
  skillPackets(now?: string): { ok: true; packets: readonly SkillAdmissionPacket[] } | { ok: false; code: string; reason: string } {
    const packets: SkillAdmissionPacket[] = []
    for (const proposal of this.proposals(now)) {
      if (!proposal.support.aboveThreshold) continue
      const inert = assertProposalIsInert(proposal)
      if (!inert.ok) return inert
      const admitted = admitToSkills(proposal)
      if (!admitted.ok) return admitted
      packets.push(admitted.packet)
    }
    return { ok: true, packets: Object.freeze(packets) }
  }

  /** Whether this engine is currently refusing writes, and the store's own health. */
  persistence(): LearningPersistenceView {
    const health = this.store.health()
    return Object.freeze({
      mode: this.store.mode,
      durable: this.store.mode === 'encrypted',
      degraded: health.health === 'degraded',
      reason: health.reason ?? this.store.faultReason,
    })
  }

  /* ----------------------------------------------------------- internals */

  /**
   * Core's own retention bound. Bounded, deterministic, and always labelled.
   *
   * Records are retired oldest-observed-first, so the choice is a function of the record
   * set rather than of insertion order, and the retired text is destroyed rather than left
   * behind in a terminal row.
   */
  async applyRetentionBound(): Promise<readonly string[]> {
    if (this.stopped()) return []
    const state = this.store.state()
    const live = [...state.experiences.values(), ...state.knowledge.values()].filter(
      (entry) => entry.status === 'admitted',
    )
    if (live.length <= LEARNING_LIMITS.maxLiveRecords) return []
    const ordered = live.sort((a, b) => {
      const byObserved = a.provenance.observedAt.localeCompare(b.provenance.observedAt)
      return byObserved !== 0 ? byObserved : recordIdOf(a).localeCompare(recordIdOf(b))
    })
    const surplus = ordered.slice(0, live.length - LEARNING_LIMITS.maxLiveRecords)
    const retired: string[] = []
    for (const entry of surplus) {
      if ('lesson' in entry) {
        const result = expireLearningExperience(entry, {
          now: this.nowIso(),
          reason: 'retention-bound-reached',
        })
        if (!result.ok) continue
        await this.persist({ version: 1, kind: 'experience', experience: result.value })
      } else {
        const result = expireKnowledgeRecord(entry, {
          now: this.nowIso(),
          reason: 'retention-bound-reached',
        })
        if (!result.ok) continue
        await this.persist({ version: 1, kind: 'knowledge', knowledge: result.value })
      }
      retired.push(recordIdOf(entry))
    }
    if (retired.length > 0) this.onChange()
    return retired
  }

  private async persist(record: LearningRecord): Promise<void> {
    // The store's contract is a bare record; the fold's is a wrapped one. Both are needed
    // and they are not the same value, so the conversion happens here rather than inside
    // the store — a store that had to guess which shape it was handed would eventually be
    // handed the wrong one.
    const bare =
      record.kind === 'outcome'
        ? record.outcome
        : record.kind === 'experience'
          ? record.experience
          : record.knowledge
    try {
      await this.store.write(bare)
    } catch (error) {
      if (error instanceof LearningStoreError) throw error
      throw new LearningStoreError('write-failed', describe(error))
    }
    applyRecord(this.store.state(), record)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function recordIdOf(entry: LearningExperience | KnowledgeRecord): string {
  return 'lesson' in entry ? entry.experienceId : entry.knowledgeId
}

function refuse(code: string, reason: string): LearningWriteOutcome {
  return { ok: false, outcome: 'refused', recordId: null, reason, code, superseded: null }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/**
 * Re-exported so a caller holding an engine needs one import for the phase's vocabulary.
 * Pure re-exports, so this costs nothing at runtime.
 */
export {
  LEARNING_SCHEMA_VERSION,
  isForbiddenLearningFieldName,
  isLearningKnowledgeKind,
  isLearningRef,
  isLearningScope,
  isLearningScopeLimit,
  instantMs,
}
export type { KnowledgeRecord, LearningExperience, LearningExportItemView, LearningExportView, VerifiedOutcome }
