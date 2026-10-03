/**
 * THE LEARNING DOMAIN — Phase 28's vocabulary.
 *
 * Files, closed tables and ceilings only: no logic, no I/O, no clock, no model, no
 * randomness. The pipeline, the fold, the derivation, the safeguards, the store, the
 * projection and the Vault repository are all built from this file, so they can depend
 * on the shapes without depending on each other.
 *
 * ## What this domain is
 *
 * The three-step pipeline from PLAN.md §14 row 28: **verified outcomes become structured
 * experience, knowledge and reusable procedures.** In code, four stages:
 *
 * ```
 *   VerifiedOutcome  →  LearningExperience  →  KnowledgeRecord  →  ProcedureProposal
 *   a check passed     a lesson, with the      a claim, with      an inert sketch for
 *                      limits on where it      evidence and       the Skills domain
 *                      does not generalise      a scope bound      to admit or refuse
 * ```
 *
 * Each arrow is one-way and each stage is strictly less confident than the one before it,
 * because each one generalises further than the last. That decreasing ladder is the whole
 * design: the only thing that makes "Freya learned something" safe to act on is that the
 * learning *narrows* as it climbs.
 *
 * ## It is not Phase 4's ExperienceRecord
 *
 * `core/brain`'s `ExperienceRecord` is the **episode**: what was attempted, with which
 * models and tools, and how much it cost. `LearningExperience` is the **lesson** drawn
 * from a checked episode. They are different records with different lifecycles, and this
 * domain never writes to Brain and never reads Brain's store — it takes ids and bounded
 * statements and stays pure, which is what lets the whole pipeline be tested with no
 * clock, no randomness and no model.
 *
 * ## The boundaries this file exists to make structural
 *
 * 1. **No knowledge record is ever `verified`.** `LEARNING_MAX_CONFIDENCE` is `medium`,
 *    for every source class, including the owner. A knowledge record generalises beyond
 *    the instances that were checked, and a generalisation is an inference however
 *    solid its evidence. There is no call anywhere in this domain that can raise one.
 * 2. **A knowledge record may not claim generality.** `LEARNING_SCOPES` has three members
 *    — `one-instance`, `one-environment`, `repeated-observations` — and no member that
 *    means "always" or "in general". Widening this would require adding a scope by name.
 * 3. **Every experience carries the closed reasons it does not generalise.**
 *    `LEARNING_SCOPE_LIMITS` is required and non-empty, so a lesson cannot be recorded
 *    without saying where it stops. This is the anti-overgeneralisation mechanism, and it
 *    is a required field rather than a note.
 * 4. **Nothing here grants anything.** `KNOWLEDGE_FORBIDDEN_FIELDS` refuses
 *    capability-, grant-, permission- and authority-shaped field names outright, and a
 *    `ProcedureProposal` carries `grantsCapability: false`, `executable: false` and
 *    `authority: 'none'` as fields so a consumer can *render* the guarantee rather than
 *    merely not violate it. Admission into Skills is the Skills domain's decision, under
 *    its own gates; see `safeguards.ts`.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count, all stated
 * in `LEARNING_LIMITS`. An unbounded store of "things Freya learned" is how a learning
 * layer becomes a second brain with none of the first brain's review rules.
 */

import {
  CONFIDENCE_RANK,
  type Confidence,
  type EpistemicStatus,
  type Provenance,
  type SourceTrust,
} from '../brain/types'

/* ---------------------------------------------------------------- pipeline */

/**
 * The four stages, in order.
 *
 * Declared so a test can assert that no pipeline record skips a stage: a knowledge record
 * that names no experience, or an experience that names no outcome, is refused.
 */
export const LEARNING_PIPELINE_STAGES = ['outcome', 'experience', 'knowledge', 'proposal'] as const
export type LearningPipelineStage = (typeof LEARNING_PIPELINE_STAGES)[number]

/**
 * Which domain a verified outcome came from.
 *
 * Closed, and it is a *description of who checked something*, not a claim about authority:
 * `work`, `mission` and `foundry` each own a verifier whose whole job is to establish
 * whether a specific thing happened. `brain` is an experience Core itself recorded.
 */
export const LEARNING_SOURCE_DOMAINS = ['work', 'mission', 'foundry', 'brain', 'owner', 'system'] as const
export type LearningSourceDomain = (typeof LEARNING_SOURCE_DOMAINS)[number]

export function isLearningSourceDomain(value: unknown): value is LearningSourceDomain {
  return typeof value === 'string' && (LEARNING_SOURCE_DOMAINS as readonly string[]).includes(value)
}

/* --------------------------------------------------------------- outcomes */

/**
 * What a verifier established.
 *
 * The honest content of this record is narrow on purpose: *this verifier checked this
 * subject and passed it*. It is not a statement that the approach works, that it will work
 * again, or that anything at all is true in general — that widening is the next stage's
 * job, and the next stage has to carry the limits.
 *
 * `checked` is the verifier's own bounded description of **what it examined**, not a
 * conclusion. A record whose `checked` field is "this always works" is refused by the
 * length bound and by `LEARNING_REFUSAL_CODES`, and the fix is to describe the check.
 */
export const LEARNING_OUTCOME_RESULTS = ['succeeded', 'failed', 'partial'] as const
export type LearningOutcomeResult = (typeof LEARNING_OUTCOME_RESULTS)[number]

/* ------------------------------------------------------------- experiences */

/**
 * What kind of lesson a distilled experience is.
 *
 * Every member is a statement about **work**, never about a person. There is no
 * `person-` kind, and there will not be one: what a person is and how they relate to
 * anyone is Phase 27's ledger, on the canonical Vault, with its own owner-only rules.
 * Duplicating it here would create a second, less guarded copy of the most private thing
 * Freya holds.
 */
export const LEARNING_EXPERIENCE_KINDS = [
  'outcome-lesson',
  'tool-lesson',
  'environment-lesson',
  'failure-lesson',
  'constraint-lesson',
] as const
export type LearningExperienceKind = (typeof LEARNING_EXPERIENCE_KINDS)[number]

export function isLearningExperienceKind(value: unknown): value is LearningExperienceKind {
  return typeof value === 'string' && (LEARNING_EXPERIENCE_KINDS as readonly string[]).includes(value)
}

/**
 * How far a claim reaches.
 *
 * **Three members, and none of them means "in general".** This is the anti-overgeneralisation
 * ladder. A record that wanted to say "this always works" would need a new member here,
 * named in a reviewable diff, rather than a string in a free-text field.
 */
export const LEARNING_SCOPES = ['one-instance', 'one-environment', 'repeated-observations'] as const
export type LearningScope = (typeof LEARNING_SCOPES)[number]

export function isLearningScope(value: unknown): value is LearningScope {
  return typeof value === 'string' && (LEARNING_SCOPES as readonly string[]).includes(value)
}

/**
 * The closed reasons a claim does not generalise. **Required, and never empty.**
 *
 * A lesson without one of these is a rule, and a rule learned from a single run is how a
 * system starts acting on a coincidence. The labels are code-owned words rather than
 * sentences so they can be counted, compared and rendered without becoming a place a
 * private detail rides out of Core.
 */
export const LEARNING_SCOPE_LIMITS = [
  'observed-once',
  'observed-in-one-environment',
  'no-future-guarantee',
  'conditions-may-change',
  'input-shape-unverified',
  'not-a-general-rule',
  'outcome-verified-process-unverified',
] as const
export type LearningScopeLimit = (typeof LEARNING_SCOPE_LIMITS)[number]

export function isLearningScopeLimit(value: unknown): value is LearningScopeLimit {
  return typeof value === 'string' && (LEARNING_SCOPE_LIMITS as readonly string[]).includes(value)
}

/* --------------------------------------------------------------- knowledge */

/**
 * What kind of claim a knowledge record is.
 *
 * A claim about **how something behaves**, never about what is true in general and never
 * about a person:
 *
 * | kind                 | what it records                                       |
 * | -------------------- | ----------------------------------------------------- |
 * | `tool-behaviour`     | what a specific tool did when checked                 |
 * | `environment-fact`   | something about this machine or setup that held       |
 * | `process-fact`       | a step of a process that worked                        |
 * | `failure-cause`      | why something failed, where that was checked           |
 * | `constraint-learned` | a limit that was hit rather than assumed away          |
 * | `outcome-pattern`    | a repeated shape across several checked outcomes      |
 */
export const LEARNING_KNOWLEDGE_KINDS = [
  'tool-behaviour',
  'environment-fact',
  'process-fact',
  'failure-cause',
  'constraint-learned',
  'outcome-pattern',
] as const
export type LearningKnowledgeKind = (typeof LEARNING_KNOWLEDGE_KINDS)[number]

export function isLearningKnowledgeKind(value: unknown): value is LearningKnowledgeKind {
  return typeof value === 'string' && (LEARNING_KNOWLEDGE_KINDS as readonly string[]).includes(value)
}

/** Re-exported so a consumer of this vocabulary needs one import. */
export type { Confidence, Provenance, SourceTrust }

/* -------------------------------------------------------------- lifecycle */

/**
 * The pipeline's lifecycle, on the same shape Phase 27 uses.
 *
 * ```
 *   candidate → admitted → superseded
 *        │          │  ├──→ retracted  (text destroyed)
 *        │          │  └──→ expired    (bounded retention; text destroyed)
 *        └──────────┴──→ rejected
 * ```
 *
 * Terminal statuses have no outgoing edges. A withdrawn lesson that turns out to be wanted
 * is a **new** record, admitted again with its history visible.
 */
export const LEARNING_STATUSES = [
  'candidate',
  'admitted',
  'superseded',
  'retracted',
  'expired',
  'rejected',
] as const
export type LearningStatus = (typeof LEARNING_STATUSES)[number]

export function isLearningStatus(value: unknown): value is LearningStatus {
  return typeof value === 'string' && (LEARNING_STATUSES as readonly string[]).includes(value)
}

export const LEARNING_TRANSITIONS: Readonly<Record<LearningStatus, readonly LearningStatus[]>> = Object.freeze({
  candidate: Object.freeze(['admitted', 'rejected'] as const),
  admitted: Object.freeze(['superseded', 'retracted', 'expired'] as const),
  superseded: Object.freeze([] as const),
  retracted: Object.freeze([] as const),
  expired: Object.freeze([] as const),
  rejected: Object.freeze([] as const),
})

export function canTransitionLearning(from: LearningStatus, to: LearningStatus): boolean {
  return LEARNING_TRANSITIONS[from].includes(to)
}

/** Statuses that contribute to the derived record set. Everything else is history. */
export const LIVE_LEARNING_STATUSES = ['admitted'] as const

export const LEARNING_LIFECYCLE_REASONS = [
  'owner-withdrew-this-record',
  'owner-rejected-this-record',
  'superseded-by-a-newer-record',
  'retention-bound-reached',
  'stale-record-expired',
] as const
export type LearningLifecycleReason = (typeof LEARNING_LIFECYCLE_REASONS)[number]

export function isLearningLifecycleReason(value: unknown): value is LearningLifecycleReason {
  return (
    typeof value === 'string' && (LEARNING_LIFECYCLE_REASONS as readonly string[]).includes(value)
  )
}

export const LEARNING_LIFECYCLE_REASON_BY_STATUS: Readonly<
  Record<LearningStatus, readonly LearningLifecycleReason[]>
> = Object.freeze({
  candidate: Object.freeze([] as const),
  admitted: Object.freeze([] as const),
  superseded: Object.freeze(['superseded-by-a-newer-record'] as const),
  retracted: Object.freeze(['owner-withdrew-this-record'] as const),
  expired: Object.freeze(['retention-bound-reached', 'stale-record-expired'] as const),
  rejected: Object.freeze(['owner-rejected-this-record'] as const),
})

export function isLearningLifecycleConsistent(
  status: LearningStatus,
  lifecycleAt: string | null,
  lifecycleReason: LearningLifecycleReason | null,
): boolean {
  const allowed = LEARNING_LIFECYCLE_REASON_BY_STATUS[status]
  if (allowed === undefined) return false
  if (allowed.length === 0) return lifecycleAt === null && lifecycleReason === null
  if (lifecycleAt === null || lifecycleReason === null) return false
  return allowed.includes(lifecycleReason)
}

/* --------------------------------------------------------------- ceilings */

/**
 * The most any source class can support **for a learning claim**.
 *
 * Note what is different from Brain's table and Phase 27's: the strongest row here is
 * `medium`, and no source class — not the owner, not a passed verification — reaches
 * `high` or `verified`. The reason is not caution for its own sake:
 *
 * > A knowledge record **generalises**. It says something about a class of situations
 * > from evidence about some of them. A generalisation is an inference, however solid
 * > the evidence, so no amount of verification behind it can make it an observation.
 *
 * The pipeline's decreasing ladder is therefore: `verified` (a check passed) →
 * `observed` (what that check establishes) → `inferred` (what it suggests) → `asserted`
 * (what someone said about it). `LEARNING_MAX_CONFIDENCE` is the mechanical statement of
 * that, and a test asserts it for every row.
 */
export const LEARNING_CEILING: Readonly<
  Record<SourceTrust, { confidence: Confidence; epistemic: EpistemicStatus }>
> = Object.freeze({
  'owner-assertion': Object.freeze({ confidence: 'medium', epistemic: 'asserted' }),
  'system-observation': Object.freeze({ confidence: 'medium', epistemic: 'observed' }),
  'experience-outcome': Object.freeze({ confidence: 'medium', epistemic: 'observed' }),
  'freya-inference': Object.freeze({ confidence: 'low', epistemic: 'inferred' }),
  'model-inference': Object.freeze({ confidence: 'low', epistemic: 'inferred' }),
  'external-untrusted': Object.freeze({ confidence: 'low', epistemic: 'asserted' }),
  'imported-document': Object.freeze({ confidence: 'low', epistemic: 'asserted' }),
})

/** The single strongest confidence any learning claim can ever carry. */
export const LEARNING_MAX_CONFIDENCE: Confidence = 'medium'

/**
 * The only source class a *derived* claim may cite.
 *
 * `experience-outcome` exists in Brain's trust hierarchy and, until this phase, nothing
 * assigned it. It is the right class here and only here: a claim distilled from outcomes
 * someone verified. It is not a claim the owner asserted, and the pipeline never launders
 * an inference into it.
 */
export const LEARNING_DISTILLED_SOURCE: SourceTrust = 'experience-outcome'

/**
 * The sources a *distilled* claim may come from.
 *
 * Narrower than the ceiling table on purpose. `external-untrusted`, `imported-document`
 * and `model-inference` cannot become learning: a page, a document or a guess is not
 * evidence about whether something worked. They may still be recorded as an **experience**
 * with their own source, which the owner can read and withdraw; they simply cannot be
 * distilled into a claim.
 */
export const LEARNING_DISTILLED_SOURCES: readonly SourceTrust[] = [
  'experience-outcome',
  'owner-assertion',
  'system-observation',
  'freya-inference',
]

/* --------------------------------------------------------- refused fields */

/**
 * Field names that would turn a lesson into an instruction, a grant, or a promise.
 *
 * Refused by name, loudly, and **before** the exact-key check, so the refusal says what
 * was refused rather than only that the payload was malformed. Four families:
 *
 * - **authority** — `capability`, `grant`, `permission`, `override`, `bypassGuard`,
 *   `approve`, `spend`, `clearStopAll`, `budget`.
 * - **promise** — `always`, `never-fails`, `guaranteed`, `forever`.
 * - **secrecy** — `secret`, `credential`, `token`, `key`.
 * - **person** — the intimacy vocabulary Phase 27 owns. A learning record is about work;
 *   a field named after a feeling belongs in that ledger, under its owner-only rules.
 *
 * Matching is normalised: lowercased, non-alphanumerics dropped, and a name is refused
 * when it equals, begins with, or ends with a listed token, so `capability`,
 * `grantedCapabilities`, `alwaysWorks` and `requires_grant` are one family written four
 * ways.
 */
export const LEARNING_FORBIDDEN_FIELDS = Object.freeze([
  // Authority.
  'capability',
  'capabilities',
  'grant',
  'grants',
  'granted',
  'permission',
  'permissions',
  'allow',
  'allowed',
  'override',
  'bypassguard',
  'approve',
  'approval',
  'spend',
  'spent',
  'clearstopall',
  'budget',
  'authority',
  'escalate',
  // Promise.
  'always',
  'never',
  'neverfails',
  'guaranteed',
  'forever',
  'permanent',
  // Secrecy.
  'secret',
  'secrets',
  'credential',
  'credentials',
  'token',
  'apikey',
  // Person.
  'feeling',
  'feelings',
  'mood',
  'affection',
  'attachment',
  'intimacy',
  'closeness',
  'bond',
  'love',
  'trust',
  'loyalty',
  'dependence',
  'missed',
  'guilt',
  'obligation',
  'need',
  'longing',
] as const)

export function normaliseLearningFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/about|for|toward|towards|to|the/g, '')
}

/** Whether a field *name* would turn a lesson into an instruction, a grant, or a promise. */
export function isForbiddenLearningFieldName(name: string): boolean {
  const token = normaliseLearningFieldName(name)
  for (const listed of LEARNING_FORBIDDEN_FIELDS) {
    const normalised = normaliseLearningFieldName(listed)
    if (token === normalised) return true
    if (token.startsWith(normalised) || token.endsWith(normalised)) return true
  }
  return false
}

/* --------------------------------------------------------------- refusals */

export const LEARNING_REFUSAL_CODES = Object.freeze([
  'not-an-object',
  'key-set-mismatch',
  'forbidden-field-refused',
  'invalid-id',
  'invalid-kind',
  'invalid-scope',
  'invalid-scope-limits',
  'missing-scope-limits',
  'invalid-claim',
  'invalid-tags',
  'invalid-source',
  'invalid-source-domain',
  'invalid-instant',
  'invalid-confidence',
  'invalid-actor',
  'invalid-result',
  'invalid-evidence-refs',
  'no-verification-evidence',
  'no-supporting-experience',
  'no-outcome',
  'distilled-source-forbidden',
  'confidence-ceiling',
  'too-generic',
  'illegal-transition',
  'illegal-lifecycle-reason',
  'not-candidate',
  'not-admitted',
  'self-supersession',
  'no-such-record',
  'insufficient-support',
  'proposal-not-inert',
  'store-unavailable',
  'store-degraded',
  'invalid-record',
  'not-found',
] as const)
export type LearningRefusalCode = (typeof LEARNING_REFUSAL_CODES)[number]

export function isLearningRefusalCode(value: unknown): value is LearningRefusalCode {
  return typeof value === 'string' && (LEARNING_REFUSAL_CODES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------ thresholds */

/**
 * The code-owned support thresholds a proposal must clear.
 *
 * Deliberately about **distinct checks**, not about how many times something was tried.
 * Repeating one run forty times is one piece of evidence, and a threshold counting repeats
 * would reward exactly the behaviour that produces a coincidence.
 */
export const LEARNING_PROPOSAL_THRESHOLDS = Object.freeze({
  /** Distinct verified outcomes behind a proposal. */
  minDistinctVerifications: 2,
  /** Distinct distilled experiences behind a proposal. */
  minDistinctExperiences: 2,
  /** Failed outcomes tolerated behind a proposal. Above this it is a failure record. */
  maxFailedOutcomes: 0,
  /** Recency: an outcome older than this cannot support a new proposal. */
  maxEvidenceAgeDays: 180,
})

/* ---------------------------------------------------------------- limits */

export const LEARNING_LIMITS = Object.freeze({
  /** Admitted live records per kind before the retention bound retires the oldest. */
  maxLiveRecords: 512,
  /** Evidence reference ids one record may carry. */
  maxEvidenceRefs: 16,
  /** Supporting experience ids one knowledge record may cite. */
  maxSupports: 8,
  /** Tags one record may carry. */
  maxTags: 12,
  /** Records one broad projection read may return. */
  maxProjectionRecords: 64,
  /** Procedure proposals one derivation may return. */
  maxProposals: 16,
  /** Steps one procedure proposal may sketch. */
  maxProposalSteps: 12,
  /** Characters in a record id. */
  maxIdChars: 128,
  /** Characters in an outcome's `checked` description. */
  maxCheckedChars: 400,
  /** Characters in an experience's lesson. */
  maxLessonChars: 1_000,
  /** Characters in a knowledge claim. */
  maxClaimChars: 1_000,
  /** Characters in a procedure name. */
  maxNameChars: 120,
  /** Characters in a step summary. */
  maxStepChars: 300,
  /** Characters in a tag. */
  maxTagChars: 32,
  /** Characters in an actor or verifier name. */
  maxActorChars: 64,
  /** Characters in an evidence reference id. */
  maxRefChars: 128,
  /** Characters in an admission or decision reason. */
  maxReasonChars: 500,
  /** Bytes of one serialised record accepted from the store. */
  maxRecordBodyBytes: 32_768,
})

/* ---------------------------------------------------------------- shapes */

/**
 * A check that passed.
 *
 * Ids, a result, an instant and a bounded description of *what was checked*. There is no
 * field for "what this tells us in general", because that is the next stage's job and it
 * has to say where it stops.
 */
export interface VerifiedOutcome {
  readonly outcomeId: string
  readonly sourceDomain: LearningSourceDomain
  /** The verification record that established this. An id, never content. */
  readonly verificationId: string
  /** The code-owned id of the verifier that established it. */
  readonly verifierId: string
  /** What the verifier examined, in its own bounded words. Never a conclusion. */
  readonly checked: string
  /** The domain subject: a run id, a mission id, an artifact hash, an experience id. */
  readonly subjectRef: string
  readonly result: LearningOutcomeResult
  readonly establishedAt: string
}

/**
 * The lesson drawn from one checked outcome.
 *
 * `lesson` is the claim; `scope` and `scopeLimits` are what keeps it from being a rule.
 * `scopeLimits` is required and must be non-empty — there is no way to record a lesson
 * without saying where it stops.
 */
export interface LearningExperience {
  readonly experienceId: string
  readonly outcomeId: string
  readonly kind: LearningExperienceKind
  readonly sourceDomain: LearningSourceDomain
  /** What the check established, bounded. Never a promise. */
  readonly lesson: string
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  readonly tags: readonly string[]
  /** Pathway-assigned. Never read from the payload. */
  readonly provenance: Provenance
  readonly evidenceRefs: readonly string[]
  readonly status: LearningStatus
  readonly admittedAt: string | null
  readonly admissionReason: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: LearningLifecycleReason | null
}

/**
 * A claim distilled from one or more distilled experiences.
 *
 * Carries the evidence it rests on (`supports`, `verificationIds`) and, always, the scope
 * it claims. There is no `confidence` above `medium`, no `verified` epistemic status, and
 * no field that could become a capability.
 */
export interface KnowledgeRecord {
  readonly knowledgeId: string
  readonly kind: LearningKnowledgeKind
  /** The claim, bounded. Not a rule, not an instruction. */
  readonly claim: string
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  /** Distilled experience ids this claim rests on. Never empty. */
  readonly supports: readonly string[]
  /** Verification ids behind those experiences. Never empty. */
  readonly verificationIds: readonly string[]
  readonly tags: readonly string[]
  readonly provenance: Provenance
  readonly confidence: Confidence
  readonly status: LearningStatus
  readonly admittedAt: string | null
  readonly admissionReason: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: LearningLifecycleReason | null
}

/**
 * An inert sketch for the Skills domain.
 *
 * Three fields exist to make the guarantee *readable* rather than merely respected:
 * `grantsCapability` is always `false`, `executable` is always `false`, `authority` is
 * always `'none'`. A surface can render "this grants nothing" from the proposal itself
 * rather than having to know the rule.
 *
 * A proposal is **data**. It does not execute, it cannot be selected, and the only way it
 * becomes anything is `admitToSkills`, which hands it to `core/skills` — whose own gates
 * then decide, independently, whether it becomes a candidate, a trial, or nothing at all.
 */
export interface ProcedureProposal {
  readonly proposalId: string
  readonly name: string
  readonly steps: readonly { readonly key: string; readonly summary: string }[]
  readonly knowledgeIds: readonly string[]
  readonly experienceIds: readonly string[]
  readonly distinctVerifications: number
  readonly failedOutcomes: number
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  readonly confidence: Confidence
  /** Always `false`. Rendered so a consumer can show it. */
  readonly grantsCapability: false
  /** Always `false`. A proposal is not runnable. */
  readonly executable: false
  /** Always `'none'`. A proposal carries no authority of any kind. */
  readonly authority: 'none'
  /** Why the proposal is (or is not) above the support thresholds. */
  readonly support: LearningProposalSupport
}

/** Whether a proposal clears the thresholds, stated as data rather than as a gate. */
export interface LearningProposalSupport {
  readonly aboveThreshold: boolean
  readonly distinctVerifications: number
  readonly distinctExperiences: number
  readonly failedOutcomes: number
  readonly staleVerifications: number
  readonly reason:
    | 'above-threshold'
    | 'too-few-verifications'
    | 'too-few-experiences'
    | 'failed-outcomes-present'
    | 'evidence-stale'
}

/** Everything the pipeline folds and derives from. Metadata and text, encrypted. */
export interface LearningState {
  readonly experiences: Map<string, LearningExperience>
  readonly knowledge: Map<string, KnowledgeRecord>
  /** Outcomes by id, so a proposal can count distinct verifications without re-asking. */
  readonly outcomes: Map<string, VerifiedOutcome>
  /**
   * How many records this fold has consumed.
   *
   * Mutable on purpose and the only mutable field, so a store can prove a re-read is a
   * re-read rather than progress.
   */
  sequence: number
}

/**
 * A proposal as the **derivation** reports it: everything except its steps.
 *
 * A step's `summary` *is* a claim's own text, so a derivation that carried the steps would
 * be a second copy of the text travelling a level further than it needs to. The full
 * proposal — steps included — is produced only by `deriveProposals`, for the engine to hand
 * to `core/skills`, which is the one consumer that genuinely needs them.
 *
 * Everything that makes the guarantee checkable is still here: `grantsCapability`,
 * `executable` and `authority`, plus the support arithmetic behind `aboveThreshold`.
 */
export type LearningProposalSummary = Omit<ProcedureProposal, 'steps'> & {
  /** How many steps the proposal has, without the steps themselves. */
  readonly stepCount: number
}

/** The derived view of what Freya has learned and how well supported it is. */
export interface LearningDerivation {
  readonly schemaVersion: number
  readonly counts: {
    readonly outcomes: number
    readonly experiences: number
    readonly knowledge: number
    readonly candidates: number
    readonly retracted: number
    readonly superseded: number
    readonly expired: number
    readonly rejected: number
    readonly byExperienceKind: Readonly<Record<LearningExperienceKind, number>>
    readonly byKnowledgeKind: Readonly<Record<LearningKnowledgeKind, number>>
    /** Claims carrying at least one verification id behind them. */
    readonly evidenced: number
  }
  /** Knowledge keys whose claims disagree. Disclosed, never resolved. */
  readonly conflictedClaims: readonly string[]
  /** Claims that reached the top scope. A fact about the records, not a measure of Freya. */
  readonly strongestScope: LearningScope
  /** Every claim's scope, for a surface to show why nothing is general. */
  readonly proposals: readonly LearningProposalSummary[]
  /** The domain grants nothing. Present so the guarantee can be rendered. */
  readonly authority: 'none'
  readonly confidenceCeiling: Confidence
}

/* -------------------------------------------------------------- utilities */

export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** A bounded opaque reference id. Same rule Phase 27 uses. */
export function isLearningRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LEARNING_LIMITS.maxRefChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/** A bounded non-empty string. */
export function isBoundedLearningText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/**
 * Whether a claim text overreaches its scope.
 *
 * A coarse, code-owned refusal for the words that turn a lesson into a promise: "always",
 * "never", "every time", "from now on", "guaranteed", "under all circumstances". A claim
 * carrying one is refused at construction rather than stored and later quoted, because a
 * quoted overclaim is how a bounded record becomes an unbounded belief downstream.
 *
 * It is deliberately a short list and deliberately substring-based. It is a **secondary**
 * gate: the primary gate is that `scope` has no member meaning "in general", so there is
 * nothing to word-match in the first place.
 */
export const LEARNING_OVERCLAIM_MARKERS = Object.freeze([
  'always',
  'never',
  'every time',
  'all the time',
  'from now on',
  'forever',
  'guaranteed',
  'under all circumstances',
  'no matter what',
  'in general',
  'universally',
  'any situation',
  'will always',
  'cannot fail',
] as const)

export function findOverclaimMarkers(text: string): readonly string[] {
  const normalised = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `
  return LEARNING_OVERCLAIM_MARKERS.filter((marker) => normalised.includes(` ${marker} `))
}

/** Cap a proposed confidence at a ceiling. Can only lower. */
export function capLearningConfidence(proposed: Confidence, ceiling: Confidence): Confidence {
  const proposedRank = CONFIDENCE_RANK[proposed]
  const ceilingRank = CONFIDENCE_RANK[ceiling]
  return proposedRank <= ceilingRank ? proposed : ceiling
}