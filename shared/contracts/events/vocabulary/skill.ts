/**
 * THE SKILL DOMAIN — Phase 17's vocabulary.
 *
 * This file is types and closed tables only: no I/O, no clock read, no model, no
 * randomness, no filesystem. It is the shape everything else in `core/skills/` is
 * built from, so admission, evaluation, promotion, selection, the journal fold and
 * the projection can all depend on it without depending on each other.
 *
 * ## What a skill is, and is not
 *
 * A skill is a **bounded reusable procedure**: a named contract (inputs, outputs,
 * preconditions, postconditions), a declared capability requirement, and an ordered
 * sequence of Work steps each naming a *registered* capability and a *registered*
 * verifier. That is the whole of it.
 *
 * A skill is **not** a prompt that carries authority, and this file is where that
 * is made structural rather than aspirational:
 *
 * - **No authority field.** There is no `capability`, `grant`, `allowed`,
 *   `override`, `bypassGuard`, `approve`, `spend`, `clearStopAll` or `model` on any
 *   skill shape. A stored skill never *grants* anything; `requiredCapabilities` is a
 *   **declaration of what the skill will ask for**, checked against what the
 *   executing Run already holds (see `execution.ts`), and adding a field that reads
 *   as authority would be a visible contract change.
 * - **No capability a skill may require.** `SKILL_FORBIDDEN_CAPABILITIES` below is
 *   the load-bearing list: a skill may not require Guard, Governor, approval,
 *   security or grant-governance capabilities, because a reusable procedure that
 *   needs to *decide* whether it may act is not a procedure. Refusing at admission
 *   is the point; the alternative is a skill that launders authority in through its
 *   own declaration.
 * - **No target of self-modification.** `PROTECTED_DOMAINS` names everything a
 *   revision may never touch. Constitution, Identity, Guard, Governor, STOP ALL,
 *   spending and approval policy, capability definitions, security policy, trusted
 *   boot and keyring boundaries are code, and no skill lifecycle reaches code.
 *
 * ## What "verified" means here
 *
 * A skill's status says how far it got through a **code-owned** lifecycle
 * (`candidate → draft → trial → verified → promoted`), and each edge is in one
 * table. Promotion reads *evaluation records*, and an evaluation is produced from
 * deterministic evidence — tests, checks, Work/Mission verification records, explicit
 * owner feedback, completion results. Model commentary is recorded as a
 * **measurement of its length** and is never read by any decision, so "Freya thinks
 * this worked" can never become "this worked".
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count, both
 * stated in `SKILL_LIMITS`. An unbounded registry of reusable procedures is how a
 * skill store quietly becomes a prompt library.
 */

/* ----------------------------------------------------------------- kinds */

/**
 * What shape of reusable thing a skill is.
 *
 * A closed set, because the kind selects what a plan may contain: a `template`
 * produces text, a `plan` produces Work steps, a `procedure` is an ordered set of
 * steps, and a `tool-sequence` is a bounded sequence of capability calls. Nothing
 * outside this list is accepted, so a skill cannot invent a kind that means
 * "whatever the caller wanted".
 */
export const SKILL_KINDS = ['procedure', 'template', 'plan', 'tool-sequence'] as const
export type SkillKind = (typeof SKILL_KINDS)[number]
/* --------------------------------------------------------------- statuses */

/**
 * The promotion lifecycle, as one closed table.
 *
 * ```
 *   candidate → draft → trial → verified → promoted
 *       │         │       │        │          │
 *       └─────────┴───────┴────────┴──────────┴──→ retired | blocked
 * ```
 *
 * `candidate` is what admission produces: something exists, and it has been recorded
 * with a provenance and a contract, and it has proved nothing. `draft` means the
 * owner has looked at it. `trial` means it may be planned into a Run. `verified`
 * means the evidence thresholds were met for *this exact version*. `promoted` means
 * the owner chose it.
 *
 * `retired` and `blocked` are terminal. There is no un-retire edge: a retired skill
 * that turned out to be wanted again is a **new** version, admitted again, with its
 * history visible. That is what stops "just re-enable it, it was fine last time"
 * from being an operation with a button.
 */
export const SKILL_STATUSES = [
  'candidate',
  'draft',
  'trial',
  'verified',
  'promoted',
  'retired',
  'blocked',
] as const
export type SkillStatus = (typeof SKILL_STATUSES)[number]
/* ---------------------------------------------------------------- sources */

/**
 * Where a skill came from, as a **closed** set assigned by Core.
 *
 * There is no `web`, `document`, `email`, `connector`, `renderer` or `model` source
 * here, for the reason the Constitution gives as C9: untrusted content stays
 * untrusted, and it cannot become durable owner truth merely by containing
 * imperative language. A window that could name its own source could launder a page's
 * contents in as Core's own judgement, so the renderer's only admission route fixes
 * the source to `owner` and reads nothing from the payload.
 *
 * `improvement` is the controlled-improvement lane: a revision Core derived from
 * recorded evaluations. It is not a trust class (see below) — a revision inherits
 * the trust class of the version it revises.
 */
export const SKILL_SOURCES = ['owner', 'core', 'mission', 'work', 'improvement'] as const
export type SkillSource = (typeof SKILL_SOURCES)[number]
/**
 * How much a skill's *content* is trusted, as opposed to where it came from.
 *
 * The distinction matters because a revision is always `improvement`-sourced yet
 * carries its parent's trust class: deriving a revision from an owner-declared skill
 * does not make it code-owned, and recording that honestly is what stops an
 * improvement loop from laundering trust upward one version at a time.
 *
 * `untrusted-content` is in the vocabulary on purpose. It is a real state a real
 * proposal can be in — a candidate assembled from text a page supplied — and the
 * only thing it may ever reach is `candidate`, from which nothing is selectable. It
 * is recorded rather than refused so the attempt is auditable instead of invisible.
 */
export const SKILL_TRUST_CLASSES = [
  'code-owned',
  'owner-declared',
  'derived',
  'untrusted-content',
] as const
export type SkillTrustClass = (typeof SKILL_TRUST_CLASSES)[number]
/* ------------------------------------------------------------- retirement */

export const SKILL_RETIREMENT_REASONS = [
  'owner-request',
  'verification-failed',
  'unsafe',
  'superseded',
  'conflicting-evidence',
  'boundary-violation',
] as const
export type SkillRetirementReason = (typeof SKILL_RETIREMENT_REASONS)[number]
/**
 * What controlled improvement *is* allowed to propose a revision of.
 *
 * Deliberately short. An ordinary skill, an ordinary procedure, and an ordinary
 * implementation artifact — and each still has to pass admission, verification and
 * owner promotion like anything else. "Ordinary" is doing real work in that
 * sentence: it is what distinguishes Phase 17's promise ("Freya may improve
 * ordinary implementation/procedures") from the thing Phase 17 may never do.
 */
export const IMPROVEMENT_TARGETS = ['skill', 'procedure', 'implementation-artifact'] as const
export type ImprovementTarget = (typeof IMPROVEMENT_TARGETS)[number]
/* -------------------------------------------------------------- verdicts */

/**
 * What an evaluation concluded.
 *
 * `established` is the only verdict that counts toward promotion, and it is
 * unreachable without deterministic evidence. `contradicted` is stronger than
 * `not-established`: it means the evidence says the outcome was *not* achieved, or
 * the owner said it was not, and it is what blocks promotion outright rather than
 * merely failing to satisfy it.
 */
export const SKILL_VERDICTS = ['established', 'not-established', 'contradicted', 'inconclusive'] as const
export type SkillVerdict = (typeof SKILL_VERDICTS)[number]
/**
 * Closed evaluation reason codes.
 *
 * Every one of them is a statement about *what evidence was present*, never about
 * what anyone concluded. `no_deterministic_evidence` is the reason a model opinion
 * alone produces, and it is a first-class tested outcome rather than a special case.
 */
export const EVALUATION_REASONS = [
  'owner-confirmed',
  'owner-rejected',
  'verification-passed',
  'verification-failed',
  'tests-passed',
  'tests-failed',
  'checks-failed',
  'completion-not-established',
  'completion-cancelled',
  'no-deterministic-evidence',
  'only-negative-evidence',
] as const
export type EvaluationReason = (typeof EVALUATION_REASONS)[number]
/** What an evaluation was *about*. A closed set, so "subject" cannot be a blob. */
export const EVALUATION_SUBJECT_KINDS = ['trial-run', 'mission', 'verification', 'owner-report'] as const
export type EvaluationSubjectKind = (typeof EVALUATION_SUBJECT_KINDS)[number]
/**
 * Who authored an evaluation.
 *
 * `model` is **not** in this list, and that absence is the structural form of "no
 * self-awarded success": there is no spelling of an evaluation that a model produced
 * authoritatively, so a model cannot report its own work as passing. Its opinion is
 * retained only as a length on a `model-opinion` evidence item, which no decision
 * reads.
 */
export const EVALUATION_AUTHORS = ['system', 'owner'] as const
export type EvaluationAuthor = (typeof EVALUATION_AUTHORS)[number]
/* --------------------------------------------------------- refusal codes */

/**
 * Closed refusal codes for the skill domain.
 *
 * A code rather than a sentence for the same reason Mission reasons are codes: a
 * decision that cannot be counted cannot be audited, and a refusal somebody cannot
 * examine is indistinguishable from an arbitrary one.
 */
export const SKILL_REFUSAL_CODES = [
  // Admission.
  'invalid-skill-name',
  'invalid-skill-kind',
  'contract-incomplete',
  'contract-oversize',
  'forbidden-capability-required',
  'unknown-capability-required',
  'capability-not-registered',
  'step-capability-mismatch',
  'step-verifier-missing',
  'too-many-steps',
  'no-steps',
  'untrusted-content',
  'boundary-violation',
  'skill-store-full',
  'duplicate-identity',
  'duplicate-version',
  'no-such-skill',
  'no-such-version',
  // Lifecycle.
  'illegal-transition',
  'evidence-missing',
  'evidence-stale',
  'evidence-contradicted',
  'evidence-insufficient',
  'evidence-self-reported',
  'status-not-selectable',
  'already-promoted',
  // Improvement.
  'no-evaluation-basis',
  'too-many-proposals',
  'revision-limit',
  'identical-revision',
  'runtime-promotion-unavailable',
  'artifact-refused',
  // Execution.
  'not-in-work',
  'work-run-unusable',
  'work-step-missing',
  'capability-not-granted',
  'capability-laundering',
  'stop-all',
  'not-executable',
  // Storage and runtime.
  'store-unavailable',
  'no-model-calls',
] as const
export type SkillRefusalCode = (typeof SKILL_REFUSAL_CODES)[number]