import { EVALUATION_AUTHORS, EVALUATION_REASONS, EVALUATION_SUBJECT_KINDS, IMPROVEMENT_TARGETS, SKILL_KINDS, SKILL_REFUSAL_CODES, SKILL_RETIREMENT_REASONS, SKILL_SOURCES, SKILL_STATUSES, SKILL_TRUST_CLASSES, SKILL_VERDICTS, type EvaluationAuthor, type EvaluationReason, type EvaluationSubjectKind, type ImprovementTarget, type SkillKind, type SkillRefusalCode, type SkillRetirementReason, type SkillSource, type SkillStatus, type SkillTrustClass, type SkillVerdict } from '../../shared/contracts/events/vocabulary/skill'
export { EVALUATION_AUTHORS, EVALUATION_REASONS, EVALUATION_SUBJECT_KINDS, IMPROVEMENT_TARGETS, SKILL_KINDS, SKILL_REFUSAL_CODES, SKILL_RETIREMENT_REASONS, SKILL_SOURCES, SKILL_STATUSES, SKILL_TRUST_CLASSES, SKILL_VERDICTS } from '../../shared/contracts/events/vocabulary/skill'
export type { EvaluationAuthor, EvaluationReason, EvaluationSubjectKind, ImprovementTarget, SkillKind, SkillRefusalCode, SkillRetirementReason, SkillSource, SkillStatus, SkillTrustClass, SkillVerdict } from '../../shared/contracts/events/vocabulary/skill'
import { CAPABILITIES, WORKER_CAPABILITIES, type Capability } from '../../shared/contracts/capabilities'


export function isSkillKind(value: unknown): value is SkillKind {
  return typeof value === 'string' && (SKILL_KINDS as readonly string[]).includes(value)
}


export function isSkillStatus(value: unknown): value is SkillStatus {
  return typeof value === 'string' && (SKILL_STATUSES as readonly string[]).includes(value)
}


export const SKILL_TERMINAL_STATUSES = ['retired', 'blocked'] as const


/**
 * Every status transition that exists.
 *
 * Declared centrally so nothing can move a skill by writing to it, and so a
 * hand-edited journal line claiming `candidate → promoted` is refused by the fold
 * as well as by the engine. Two things are load-bearing:
 *
 *  - `verified → draft` is the **re-verification** edge. Every revision produces a
 *    new version at `candidate`, and this edge exists so an *existing* version whose
 *    evidence went stale returns to a status that cannot be selected from, rather
 *    than keeping a `verified` badge it no longer supports.
 *  - `promoted → trial` exists for the same reason a promotion can be withdrawn
 *    without retiring the skill's history. Promotion is a choice, not a property.
 */
export const SKILL_TRANSITIONS: Readonly<Record<SkillStatus, readonly SkillStatus[]>> = Object.freeze({
  candidate: ['draft', 'trial', 'retired', 'blocked'],
  draft: ['trial', 'retired', 'blocked'],
  trial: ['verified', 'draft', 'retired', 'blocked'],
  verified: ['promoted', 'draft', 'trial', 'retired', 'blocked'],
  promoted: ['trial', 'retired', 'blocked'],
  retired: [],
  blocked: [],
})


export function canTransitionSkill(from: SkillStatus, to: SkillStatus): boolean {
  return SKILL_TRANSITIONS[from].includes(to)
}


/** Statuses a Run may plan a skill from. Everything else is metadata. */
export const SELECTABLE_SKILL_STATUSES = ['trial', 'verified', 'promoted'] as const

export type SelectableSkillStatus = (typeof SELECTABLE_SKILL_STATUSES)[number]


export function isSelectableSkillStatus(value: SkillStatus): value is SelectableSkillStatus {
  return (SELECTABLE_SKILL_STATUSES as readonly string[]).includes(value)
}


/**
 * How strongly a status prefers selection, lowest number first.
 *
 * A total order used as a *tiebreak of last resort* — see `selection.ts`, where the
 * primary ordering is evidence and the id. Exported because the projection renders
 * a rank and two windows must not disagree about which is stronger.
 */
export function statusPreference(status: SkillStatus): number {
  switch (status) {
    case 'promoted':
      return 0
    case 'verified':
      return 1
    case 'trial':
      return 2
    case 'draft':
      return 3
    case 'candidate':
      return 4
    case 'blocked':
      return 5
    case 'retired':
      return 6
  }
}


export function isSkillSource(value: unknown): value is SkillSource {
  return typeof value === 'string' && (SKILL_SOURCES as readonly string[]).includes(value)
}


export function isSkillTrustClass(value: unknown): value is SkillTrustClass {
  return typeof value === 'string' && (SKILL_TRUST_CLASSES as readonly string[]).includes(value)
}


/**
 * Trust classes that may ever be *selected* into a Run.
 *
 * `derived` is included because it is what a verified improvement produces, and
 * excluding it would make controlled improvement decorative. `untrusted-content` is
 * excluded, which is the whole of the anti-poisoning argument: text from a page, a
 * document, an email, a connector or a model's own output cannot become a procedure
 * Freya runs, no matter how many times it is revised.
 */
export const EXECUTABLE_TRUST_CLASSES = ['code-owned', 'owner-declared', 'derived'] as const


/* ---------------------------------------------------------- verification */

/**
 * A skill's verification state, which is *not* its status.
 *
 * Separate because they answer different questions and drift independently: a
 * `promoted` skill whose current version has no evidence is `stale`, and that is a
 * materially different thing from a skill that was never verified. Collapsing them
 * would mean a withdrawn promotion and an untested skill looked alike.
 */
export const SKILL_VERIFICATION_STATES = ['unverified', 'verified', 'failed', 'stale'] as const

export type SkillVerificationState = (typeof SKILL_VERIFICATION_STATES)[number]


export function isSkillVerificationState(value: unknown): value is SkillVerificationState {
  return typeof value === 'string' && (SKILL_VERIFICATION_STATES as readonly string[]).includes(value)
}


export function isSkillRetirementReason(value: unknown): value is SkillRetirementReason {
  return typeof value === 'string' && (SKILL_RETIREMENT_REASONS as readonly string[]).includes(value)
}


/* ---------------------------------------------------- protected boundaries */

/**
 * Domains no skill lifecycle may modify, supersede, or route around.
 *
 * This list is the hard immutability boundary of Phase 17, and it is a *closed
 * vocabulary* rather than a prefix match so that a proposal naming
 * `core/security/guard.ts` cannot be waved through by a rule that only knows the
 * word `guard`. The entries are code:
 *
 * | domain                | why it is here |
 * | --------------------- | -------------- |
 * | `constitution`        | the rules above prompts, personality, agents and renderers |
 * | `identity`            | who Freya is and what she claims about herself |
 * | `authority`           | `core/authority.ts`: who may say what |
 * | `guard`               | deny-by-default capability evaluation |
 * | `governor`            | cognition budgets, grants and their ceilings |
 * | `stop-all`            | the panic button's latch semantics |
 * | `spending-policy`     | what may be spent, and on whose approval |
 * | `approval-policy`     | who may approve, and what an approval means |
 * | `capability-definition`| the closed capability vocabulary itself |
 * | `security-policy`     | admission, provenance and trust classes |
 * | `trusted-boot`        | journal recovery, integrity faults and degraded posture |
 * | `keyring`             | key separation and OS secure storage |
 * | `core-protocol`       | the vocabulary Core and a renderer share |
 * | `core-runtime`        | Freya's own production source |
 *
 * A revision targeting any of these is refused with `boundary-violation` and the
 * refusal is journalled, because an unaudited refusal hides a probing pattern.
 */
export const PROTECTED_DOMAINS = [
  'constitution',
  'identity',
  'authority',
  'guard',
  'governor',
  'stop-all',
  'spending-policy',
  'approval-policy',
  'capability-definition',
  'security-policy',
  'trusted-boot',
  'keyring',
  'core-protocol',
  'core-runtime',
] as const

export type ProtectedDomain = (typeof PROTECTED_DOMAINS)[number]


export function isProtectedDomain(value: unknown): value is ProtectedDomain {
  return typeof value === 'string' && (PROTECTED_DOMAINS as readonly string[]).includes(value)
}


export function isImprovementTarget(value: unknown): value is ImprovementTarget {
  return typeof value === 'string' && (IMPROVEMENT_TARGETS as readonly string[]).includes(value)
}


/* ---------------------------------------------------- capability boundary */

/**
 * Capabilities a skill may never require, whatever it declares.
 *
 * The single most important list in this file. Every entry is a capability whose
 * meaning is *deciding whether Freya may act*:
 *
 * - `security.*` — the panic button and the ability to read the security posture.
 * - `cognition.grant.manage` — the ability to widen its own allowance.
 * - `work.approval.decide` — the ability to approve its own request.
 * - `mission.manage` — including concluding a Mission, which is the one operation
 *   that says "this is done".
 * - `work.run.manage` — planning, pausing and cancelling further work.
 *
 * A reusable procedure that needs any of these is not a procedure; it is an
 * authority, and Phase 17's promise is explicitly that Freya does not rewrite her
 * own authority. Refusing at admission is what makes "a stored skill never grants
 * capability" true of the *declaration* as well as of the execution path.
 */
export const SKILL_FORBIDDEN_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter(
  (capability) =>
    capability.startsWith('security.') ||
    capability === 'cognition.grant.manage' ||
    capability === 'work.approval.decide' ||
    capability === 'mission.manage' ||
    capability === 'work.run.manage',
)


/**
 * Capabilities a worker-run may hold, and therefore the *only* capabilities a skill
 * can require when the executing Run belongs to a worker.
 *
 * `WORKER_CAPABILITIES` is the closed worker vocabulary — today exactly
 * `cognition.request`. A skill that requires more than this cannot be planned into
 * a worker's Run at all, which is checked in `execution.ts` against the actual
 * principal rather than assumed here.
 */
export const SKILL_WORKER_CAPABILITIES: readonly Capability[] = WORKER_CAPABILITIES


export function isSkillCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}


/**
 * The capabilities a skill declares, as a writable list during parsing.
 *
 * Named so the admission module can build one with `push` while every other
 * consumer sees a readonly tuple: a required-capability list that something could
 * append to after validation would be a hole in the laundering check.
 */
export type SkillRequiredCapabilities = Capability[]


export function isForbiddenSkillCapability(value: Capability): boolean {
  return SKILL_FORBIDDEN_CAPABILITIES.includes(value)
}


/* -------------------------------------------------------------- evidence */

/**
 * What kind of evidence an evaluation rests on.
 *
 * The first five are **deterministic**: they are facts about tests, checks,
 * verification records, what the owner said, or whether a completion result exists.
 * They are what a verdict is computed from.
 *
 * `model-opinion` is in the vocabulary for a different reason: it must be *nameable*
 * so that "a model said it worked" is a recorded, countable fact rather than a
 * sentence smuggled through a metric. `evaluateOutcome` never reads it, a renderer
 * may never submit it, and only its **length** is ever retained.
 */
export const SKILL_EVIDENCE_KINDS = [
  'test-result',
  'check',
  'verification-record',
  'owner-feedback',
  'completion-result',
  'model-opinion',
] as const

export type SkillEvidenceKind = (typeof SKILL_EVIDENCE_KINDS)[number]


export function isSkillEvidenceKind(value: unknown): value is SkillEvidenceKind {
  return typeof value === 'string' && (SKILL_EVIDENCE_KINDS as readonly string[]).includes(value)
}


/** The evidence kinds a verdict may be computed from. `model-opinion` is absent. */
export const DETERMINISTIC_EVIDENCE_KINDS: readonly SkillEvidenceKind[] = SKILL_EVIDENCE_KINDS.filter(
  (kind) => kind !== 'model-opinion',
)


export function isDeterministicEvidence(kind: SkillEvidenceKind): boolean {
  return kind !== 'model-opinion'
}


/**
 * Closed outcome codes per evidence kind.
 *
 * A code, never a sentence, so an evaluation can be counted, compared and asserted
 * on — and so a renderer cannot smuggle the words "the tests passed" into a field
 * the policy reads. The projection prints codes; the surface maps them to words.
 */
export const EVIDENCE_CODES: Readonly<Record<SkillEvidenceKind, readonly string[]>> = Object.freeze({
  'test-result': ['passed', 'failed', 'skipped', 'errored'],
  check: ['passed', 'failed', 'skipped'],
  'verification-record': ['passed', 'failed', 'timeout', 'cancelled'],
  'owner-feedback': ['confirmed', 'rejected', 'no-opinion'],
  'completion-result': ['established', 'not-established', 'cancelled'],
  'model-opinion': ['positive', 'negative', 'uncertain'],
})


export function isEvidenceCode(kind: SkillEvidenceKind, value: unknown): value is string {
  return typeof value === 'string' && EVIDENCE_CODES[kind].includes(value)
}


/**
 * Closed metric names.
 *
 * A metric is a measurement, never a score. There is deliberately no
 * `quality`, `confidence` or `success` here: a number that could be optimised is a
 * Goodhart loop waiting for a phase to be tired, and this phase is not tired.
 */
export const SKILL_METRIC_NAMES = [
  'attempts',
  'failures',
  'retries',
  'durationMs',
  'stepsVerified',
  'stepsTotal',
] as const

export type SkillMetricName = (typeof SKILL_METRIC_NAMES)[number]


export function isSkillMetricName(value: unknown): value is SkillMetricName {
  return typeof value === 'string' && (SKILL_METRIC_NAMES as readonly string[]).includes(value)
}


export function isSkillVerdict(value: unknown): value is SkillVerdict {
  return typeof value === 'string' && (SKILL_VERDICTS as readonly string[]).includes(value)
}


export function isEvaluationReason(value: unknown): value is EvaluationReason {
  return typeof value === 'string' && (EVALUATION_REASONS as readonly string[]).includes(value)
}


export function isEvaluationSubjectKind(value: unknown): value is EvaluationSubjectKind {
  return typeof value === 'string' && (EVALUATION_SUBJECT_KINDS as readonly string[]).includes(value)
}


export function isEvaluationAuthor(value: unknown): value is EvaluationAuthor {
  return typeof value === 'string' && (EVALUATION_AUTHORS as readonly string[]).includes(value)
}


export function isSkillRefusalCode(value: unknown): value is SkillRefusalCode {
  return typeof value === 'string' && (SKILL_REFUSAL_CODES as readonly string[]).includes(value)
}


/* ---------------------------------------------------------------- limits */

/**
 * The ceilings. Checked *before* the thing they bound, never after.
 *
 * A caller may lower any of these and may never raise one above `SKILL_LIMITS`, so
 * a misconfigured Core gets the tighter behaviour rather than a silent widening.
 */
export const SKILL_LIMITS = Object.freeze({
  /** Skills held across the whole registry, all versions. */
  maxRetainedSkills: 200,
  /** Versions retained per skill. The oldest are dropped, never silently reused. */
  maxVersionsPerSkill: 12,
  /** Evaluation records retained per skill. */
  maxRetainedEvaluations: 64,
  /** Improvement proposals held open at once. */
  maxOpenProposals: 16,
  /**
   * Revisions one skill lineage may accumulate. The loop bound.
   *
   * Counted over the lineage (`version - 1`) rather than over one version, because a
   * bound that resets every revision is not a bound at all: a loop that revises the
   * version it just created would see `0` every time and never stop.
   */
  maxRevisionsPerSkill: 3,
  /** Steps one skill may declare. */
  maxSteps: 24,
  /** Entries in each contract list (inputs, outputs, preconditions, postconditions). */
  maxContractEntries: 24,
  /** Capabilities one skill may declare. */
  maxRequiredCapabilities: 8,
  /** Applicability tags one skill may declare. */
  maxApplicabilityTags: 12,
  /** Characters in a name. */
  maxNameChars: 64,
  /** Characters in a summary. Measured, never journalled as text. */
  maxSummaryChars: 400,
  /** Characters in a contract entry. */
  maxEntryChars: 200,
  /** Characters in an applicability tag. */
  maxTagChars: 48,
  /** Skills one selection may return. */
  maxSelection: 8,
  /** Evidence items one evaluation may carry. */
  maxEvidenceItems: 16,
  /** Verification evidence items one evaluation may carry. */
  maxVerificationItems: 8,
  /** Metrics one evaluation may carry. */
  maxMetrics: 8,
  /** Characters of model commentary Core will even measure. */
  maxCommentaryChars: 4_000,
  /** Characters in an opaque reference a payload may carry. */
  maxRefChars: 128,
  /** Bytes of a serialised skill body Core will accept from the encrypted store. */
  maxSkillBodyBytes: 16_384,
  /** Bytes of a whole snapshot. */
  maxSnapshotBytes: 1_048_576,
})


/* ---------------------------------------------------------------- shapes */

/**
 * One named thing a skill takes in, produces, needs, or guarantees.
 *
 * `name` is a bounded opaque token and `length` is a measurement of the
 * description. The description itself is *private* and lives in the encrypted
 * store; the journal and the projection carry only the name and the length, which
 * is the same bargain Brain and Work make with anything a person might not want in
 * a backup.
 */
export interface SkillContractEntry {
  readonly name: string
  readonly description: string
}


/**
 * One Work step a skill declares.
 *
 * `capability` must be a registered Work capability and `verifier` must be a
 * registered Work verifier, both checked at admission against the same registry the
 * engine will execute against. This is the mechanism behind "a skill never grants
 * capability": the capability named here is the one the *Run* must already hold, and
 * the verifier named here is the only thing that may close the step.
 */
export interface SkillStepSeed {
  readonly key: string
  readonly capability: string
  readonly verifier: string
}


/**
 * The declared contract of a skill: what it takes, what it gives, what must be true
 * before it runs, and what must be true after.
 *
 * Presence of all four is required at admission, and each may be empty **only** for
 * a `template` with no declared preconditions — no, more simply: `inputs`,
 * `outputs` and `postconditions` must be non-empty, and `preconditions` may be
 * empty because "nothing must be true first" is a legitimate, checkable claim. An
 * empty list is recorded as an empty list, never inferred.
 */
export interface SkillContract {
  readonly inputs: readonly SkillContractEntry[]
  readonly outputs: readonly SkillContractEntry[]
  readonly preconditions: readonly SkillContractEntry[]
  readonly postconditions: readonly SkillContractEntry[]
}


/**
 * A skill's provenance, as recorded once at admission and never rewritten.
 *
 * `admittedBy` is the principal whose act created the record, assigned by Core and
 * never read from a payload — a caller that could name its own author could launder
 * a page's contents in as Core's judgement. `parentSkillId`/`parentVersion` are
 * non-null exactly when this version is a revision, so "which version is this derived
 * from" is always answerable.
 */
export interface SkillProvenance {
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly admittedAt: string
  readonly parentSkillId: string | null
  readonly parentVersion: number | null
  /** A closed origin label, e.g. the subsystem that proposed it. Never free text. */
  readonly originRef: string | null
}


/**
 * One skill version, as Core holds it.
 *
 * This is the **private** record. Its contract text and summaries live only in the
 * encrypted skill store; the journal carries the metadata below and nothing else.
 */
export interface SkillRecord {
  readonly skillId: string
  /** Normalised, bounded, and the *only* key. Identity is derived from it. */
  readonly name: string
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  /** Deterministic digest of the body's semantic content. */
  readonly contentHash: string
  readonly summary: string
  readonly contract: SkillContract
  readonly steps: readonly SkillStepSeed[]
  readonly requiredCapabilities: readonly Capability[]
  readonly applicability: readonly string[]
  readonly provenance: SkillProvenance
  readonly createdAt: string
  readonly updatedAt: string
  readonly retiredAt: string | null
  readonly retirementReason: SkillRetirementReason | null
  readonly promotedAt: string | null
}


/** One piece of deterministic (or explicitly non-deterministic) evidence. */
export interface SkillEvidence {
  readonly kind: SkillEvidenceKind
  readonly code: string
  /** How many times this was observed. Never a score. */
  readonly count: number
  readonly at: string
}


/** One measurement. Bounded name, integer value. */
export interface SkillMetric {
  readonly name: SkillMetricName
  readonly value: number
}


/** One verification record, which only Core's own Work/Mission verifier may produce. */
export interface SkillVerificationEvidence {
  readonly verificationId: string
  readonly verifier: string
  readonly verdict: 'passed' | 'failed'
  readonly at: string
}


/**
 * Model commentary, retained as a measurement and nothing else.
 *
 * `chars` is the entire record. The text is never journalled, never projected and
 * never read by `evaluateOutcome`, so the honest statement "Freya thought this went
 * well" can be made without the sentence becoming evidence.
 */
export interface SkillCommentary {
  readonly source: 'model'
  readonly chars: number
}


/** Everything one evaluation was computed from. */
export interface SkillEvaluationInput {
  readonly evidence: readonly SkillEvidence[]
  readonly verification: readonly SkillVerificationEvidence[]
  readonly metrics: readonly SkillMetric[]
  readonly commentary: SkillCommentary | null
}


/** What `evaluateOutcome` concluded, and why. Pure and total. */
export interface SkillEvaluationDecision {
  readonly verdict: SkillVerdict
  readonly reason: EvaluationReason
  /** Deterministic evidence items considered. `0` is how model-only evidence reads. */
  readonly deterministicCount: number
  /** Positive deterministic signals. Never the model. */
  readonly positiveCount: number
  /** Negative deterministic signals. Never the model. */
  readonly negativeCount: number
  /** Model commentary characters *observed*. Never read into the verdict. */
  readonly commentaryChars: number
}


/**
 * One recorded evaluation: the decision plus the metadata needed to audit it.
 *
 * `skillId` and `version` together are what makes stale-evidence reuse impossible:
 * an evaluation recorded against version 3 says nothing about version 4, and
 * `promotion.ts` reads only evaluations whose `version` equals the version being
 * promoted.
 */
export interface SkillEvaluation {
  readonly evaluationId: string
  readonly skillId: string
  readonly version: number
  readonly subjectKind: EvaluationSubjectKind
  readonly subjectRef: string
  readonly author: EvaluationAuthor
  readonly evaluatedAt: string
  readonly decision: SkillEvaluationDecision
}


/** One improvement proposal, as Core holds it. */
export interface SkillProposal {
  readonly proposalId: string
  readonly target: ImprovementTarget
  /** A skill id, or a bounded artifact reference. Never a protected domain. */
  readonly targetRef: string
  readonly skillId: string | null
  readonly baseVersion: number | null
  readonly summaryLength: number
  readonly basisEvaluationIds: readonly string[]
  readonly proposedBy: EvaluationAuthor
  readonly createdAt: string
  readonly status: 'open' | 'accepted' | 'refused'
  readonly settledAt: string | null
  readonly settledReason: SkillRefusalCode | null
}


/** What the fold retains. Metadata only — never a contract entry's text. */
export interface SkillVersionRecord {
  readonly version: number
  readonly contentHash: string
  readonly createdAt: string
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly stepCount: number
  readonly requiredCapabilityCount: number
  readonly applicabilityCount: number
  readonly inputCount: number
  readonly outputCount: number
  readonly preconditionCount: number
  readonly postconditionCount: number
  readonly summaryLength: number
}


/** The fold's per-skill record: status, verification, provenance and counts. */
export interface SkillStateRecord {
  readonly skillId: string
  readonly name: string
  readonly nameLength: number
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly admittedAt: string
  readonly promotedAt: string | null
  readonly retiredAt: string | null
  readonly retirementReason: SkillRetirementReason | null
  readonly versions: readonly SkillVersionRecord[]
  readonly evaluations: readonly SkillEvaluation[]
  readonly establishedCount: number
  readonly contradictedCount: number
  readonly inconclusiveCount: number
  readonly updatedAt: string
}


/* -------------------------------------------------------------- utilities */

/**
 * Whether a string is a bounded opaque reference id.
 *
 * Same predicate Phase 12 uses, deliberately: two domains sharing one notion of
 * "an id a caller may carry" is worth more than two perfectly-tuned ones.
 */
export function isRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SKILL_LIMITS.maxRefChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}


/**
 * Normalise a skill name into the one form identity is derived from.
 *
 * Lowercased, trimmed, internal whitespace and separators collapsed to a single
 * `-`, restricted to `[a-z0-9-]`, and bounded. Refuses rather than repairs: a name
 * that arrives as `../../etc/passwd` or `Constitution §1` is a bad request, and
 * turning it into a slug would create two names that differ only in punctuation and
 * make "which skill did you mean" unanswerable.
 *
 * This is also the anti-poisoning hinge for **naming**: an owner cannot name a skill
 * after a protected domain in a way that later collides with one, because identity is
 * `hash(domain | normalised name)` and a protected domain is never accepted as a
 * target at all.
 */
export function normaliseSkillName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > SKILL_LIMITS.maxNameChars) return null
  const collapsed = trimmed.replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-')
  // Neither a leading nor a trailing dash: without that rule `a` and `a-` would be two
  // skills, and a trailing dash is invisible in every list a person reads.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(collapsed)) return null
  return collapsed
}


/**
 * Normalise one contract entry's name, and bound its description.
 *
 * The name uses the same slug rule as a skill name; the description is
 * control-stripped and collapsed like Phase 12's event text, because it is
 * private content that will be encrypted and must not carry terminal escapes into
 * anything that might later render it.
 */
export function normaliseContractEntry(
  raw: unknown,
): { name: string; description: string } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const name = normaliseSkillName(entry.name)
  if (name === null) return null
  // The description must be a string *before* it is sanitised. Defaulting a missing
  // one to `''` would be a repair, and a contract entry that silently lost its
  // description is a contract the owner did not write.
  if (typeof entry.description !== 'string') return null
  const description = sanitiseSkillText(entry.description, SKILL_LIMITS.maxEntryChars)
  return { name, description }
}


/**
 * Normalise an applicability tag.
 *
 * A tag is a closed-shape slug, not prose, because tags are what selection matches
 * on. A tag that could be a sentence would let a caller smuggle text into the
 * decision surface.
 */
export function normaliseTag(raw: unknown): string | null {
  return normaliseSkillName(raw)
}


/**
 * Control-strip and bound a piece of private text.
 *
 * This is not a security boundary on its own — a description is content, never
 * authority — but it keeps a pathological payload from becoming a 4 MB string in
 * memory and keeps terminal control sequences out of anything that might later
 * render it. It never *interprets* the text.
 */
export function sanitiseSkillText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const isControl =
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    if (isControl) continue
    out += character
  }
  const collapsed = out.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed
}


/** Whether a string parses as an instant. No clock read, no repair. */
export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}


/**
 * The canonical serialisation a content hash is taken over.
 *
 * Keys are emitted in a fixed order and lists keep their declared order, so the same
 * semantic body always produces the same bytes. That is what makes `identical-
 * revision` detectable and what makes a content hash comparable across processes.
 */
export function canonicalSkillBody(record: {
  readonly name: string
  readonly kind: SkillKind
  readonly summary: string
  readonly contract: SkillContract
  readonly steps: readonly SkillStepSeed[]
  readonly requiredCapabilities: readonly string[]
  readonly applicability: readonly string[]
}): string {
  const entries = (list: readonly SkillContractEntry[]): unknown[] =>
    list.map((entry) => ({ d: entry.description, n: entry.name }))
  return JSON.stringify({
    a: [...record.applicability],
    c: [...record.requiredCapabilities],
    k: record.kind,
    n: record.name,
    o: entries(record.contract.outputs),
    p: entries(record.contract.preconditions),
    q: entries(record.contract.postconditions),
    s: record.steps.map((step) => ({ c: step.capability, k: step.key, v: step.verifier })),
    sum: record.summary,
    i: entries(record.contract.inputs),
  })
}