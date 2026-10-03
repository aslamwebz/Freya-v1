/**
 * THE SELF-IMPROVEMENT DOMAIN — Phase 30's vocabulary.
 *
 * Types, closed tables and ceilings only: no logic, no I/O, no clock, no model, no randomness.
 *
 * ## What this domain is
 *
 * PLAN.md §15 row 30: *"staging-branch improvement loop with tests, review, rollback and
 * owner-controlled merge."*
 *
 * It is the ledger for a proposed change to Freya's own architecture, and nothing else. It does
 * not build code (Foundry does), does not run tests (the verifier does), does not read or write a
 * file, does not know what a branch is in git, and **cannot apply, install or merge anything**.
 * What it owns is:
 *
 * ```
 *   ImprovementProposal → StagedChange → GateLedger → MergeDecision → merged
 *   a claim that          what would be    every gate,    may this land    never alone,
 *   something is wrong    different, and    with a verdict and stay?        and never
 *                        what it would cost                              by a machine
 * ```
 *
 * ## The five boundaries, stated as contracts
 *
 * 1. **Nothing is applied by anything here.** `IMPROVEMENT_APPLIES_NOTHING` is a value, and
 *    `StageExecution` — the only description of how a change would be carried out — carries an
 *    `appliedBy: 'owner'` field with no producer. A proposal is a description of a change; the
 *    person who merges it is the person who made it real.
 * 2. **A change starts unmerged and unstaged.** `ImprovementStatuses` begins at `proposed` and
 *    there is no constructor parameter that sets a status, so a proposal cannot arrive staged,
 *    tested or merged.
 * 3. **Rollback is a first-class state, not a revert.** `rolled-back` is reachable from `staging`
 *    and all the way through `merged`, because a rollback that cannot undo a landed change is a
 *    promise rather than a mechanism. `merged → rolled-back` is the only edge out of `merged`.
 * 4. **Rollback must be *proven*, not promised.** `rollback-verified` is a gate like any other: a
 *    change that has never been rolled back on demand cannot be merged, whatever else it has.
 * 5. **No authority widening, ever.** `FORBIDDEN_IMPROVEMENTS` and `PROTECTED_IMPROVEMENT_SURFACES`
 *    are refused at construction, *and* recomputed as derived gates on every decision, so a
 *    hand-edited row still meets a gate that refuses it.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count, stated in
 * `IMPROVEMENT_LIMITS`.
 */

import type { Confidence } from '../brain/types'

/* -------------------------------------------------------------- proposals */

/**
 * Why a change is being proposed.
 *
 * Every member is a claim about *Freya's own operation* — something measurably costing her — and
 * not a wish. There is deliberately no `make-me-better` kind: an improvement nobody can point at
 * a cost is a preference, and a self-modifying system with preferences is a system that will
 * eventually optimise for them.
 */
export const IMPROVEMENT_KINDS = [
  'latency-too-high',
  'work-failing-repeatedly',
  'token-budget-overrun',
  'knowledge-gap-repeated',
  'retrieval-missing',
  'tool-limitation',
  'procedure-too-weak',
  'crash-or-degradation-recovered',
] as const
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number]

export function isImprovementKind(value: unknown): value is ImprovementKind {
  return typeof value === 'string' && (IMPROVEMENT_KINDS as readonly string[]).includes(value)
}

export function isImprovementClosedReason(value: unknown): value is ImprovementClosedReason {
  return typeof value === 'string' && (IMPROVEMENT_CLOSED_REASONS as readonly string[]).includes(value)
}

/** Closed reasons a proposal may be closed. A proposal cannot simply stop being a proposal. */
export const IMPROVEMENT_CLOSED_REASONS = [
  'change-merged',
  'rollback-completed',
  'owner-rejected-this-proposal',
  'owner-withdrew-this-proposal',
  'tests-failed',
  'red-team-found-something',
  'review-rejected-the-change',
  'rollback-unverified-so-refused',
  'gates-not-satisfied',
  'aged-out-past-retention',
] as const
export type ImprovementClosedReason = (typeof IMPROVEMENT_CLOSED_REASONS)[number]

/**
 * Where a proposal has got to.
 *
 * ```
 *   proposed → staging → staged → testing → tested → reviewing → reviewed → merging → merged
 *       │         │         │          │         │           │          │         │
 *       └─────────┴─────────┴──────────┴─────────┴───────────┴──────────┴──→ rolled-back
 *       └─────────┴─────────┴──────────┴─────────┴───────────┴──────────┴──→ rejected | expired
 * ```
 *
 * Every terminal status is terminal. A rejected change is a **new proposal**, not a retry of this
 * one, so a failure cannot be quietly edited into a pass — the same rule Phase 29 uses for a
 * failed acquisition.
 */
export const IMPROVEMENT_STATUSES = [
  'proposed',
  'staging',
  'staged',
  'testing',
  'tested',
  'reviewing',
  'reviewed',
  'merging',
  'merged',
  'rolled-back',
  'rejected',
  'expired',
] as const
export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number]

export function isImprovementStatus(value: unknown): value is ImprovementStatus {
  return typeof value === 'string' && (IMPROVEMENT_STATUSES as readonly string[]).includes(value)
}

/**
 * The transition table, and the only authority over it.
 *
 * Two edges deserve their reasons written down:
 *
 * - **`merged → rolled-back`** is the only way out of `merged`. A landed change that cannot be
 *   undone is not a change anyone approved; it is a change that happened. So there is no
 *   `merged → merging` edge, no `merged → reviewed`, and no way to re-merge the same proposal.
 * - **`tested → reviewing → reviewed`** is two steps rather than one, because review and testing
 *   are done by different parties and a single state would let one of them sign for the other.
 */
export const IMPROVEMENT_TRANSITIONS: Readonly<Record<ImprovementStatus, readonly ImprovementStatus[]>> =
  Object.freeze({
    proposed: Object.freeze(['staging', 'rejected', 'expired'] as const),
    staging: Object.freeze(['staged', 'rolled-back', 'rejected', 'expired'] as const),
    staged: Object.freeze(['testing', 'rolled-back', 'rejected', 'expired'] as const),
    testing: Object.freeze(['tested', 'rolled-back', 'rejected', 'expired'] as const),
    tested: Object.freeze(['reviewing', 'rolled-back', 'rejected', 'expired'] as const),
    reviewing: Object.freeze(['reviewed', 'rolled-back', 'rejected', 'expired'] as const),
    reviewed: Object.freeze(['merging', 'rejected', 'expired'] as const),
    merging: Object.freeze(['merged', 'rolled-back', 'expired'] as const),
    merged: Object.freeze(['rolled-back'] as const),
    'rolled-back': Object.freeze([] as const),
    rejected: Object.freeze([] as const),
    expired: Object.freeze([] as const),
  })

export function canTransitionImprovement(from: ImprovementStatus, to: ImprovementStatus): boolean {
  return IMPROVEMENT_TRANSITIONS[from].includes(to)
}

/* --------------------------------------------------------------- retention */

/**
 * How long each thing may stand before it stops being live.
 *
 * All three are code-owned, resolved once and stored as absolute instants. Two reasons that
 * matters, both learned from Phase 29:
 *
 * 1. **Nothing watches a clock.** An expiry is a fact a reader evaluates
 *    (`expireStaleProposals(now)`), never a background thread that quietly retired something.
 * 2. **A landed change must not become permanent by silence.** `maxMergedLifetimeMs` is separate
 *    from the proposal lifetime, so "the owner merged this once" never quietly becomes "this is
 *    now how Freya works, forever" — an unreviewed change comes back for a second decision.
 */
export const IMPROVEMENT_RETENTION = Object.freeze({
  /** How long a proposal may sit before it is stale. */
  maxProposalLifetimeMs: 45 * 24 * 60 * 60 * 1_000,
  /** How long a merge may stand before it must be reviewed again. */
  maxMergedLifetimeMs: 60 * 24 * 60 * 60 * 1_000,
  /** How long a rollback record is kept before it ages out of the ledger. */
  maxRollbackLifetimeMs: 90 * 24 * 60 * 60 * 1_000,
})

/* ----------------------------------------------------------------- stages */

/**
 * Where a staged change would be carried out.
 *
 * A code-owned vocabulary of *targets*, deliberately not paths. Naming a path in a proposal would
 * put a file name in a durable record that a later phase might act on, and the set of paths that
 * matter is exactly the set this phase is not allowed to know.
 */
export const STAGE_TARGETS = [
  'module-code',
  'procedure-definition',
  'skill-body',
  'prompt-template',
  'retrieval-config',
  'scheduling-policy',
  'telemetry-config',
] as const
export type StageTarget = (typeof STAGE_TARGETS)[number]

export function isStageTarget(value: unknown): value is StageTarget {
  return typeof value === 'string' && (STAGE_TARGETS as readonly string[]).includes(value)
}

/**
 * What a staged change would do, described without naming anything executable.
 *
 * `appliedBy` is `'owner'` with no producer anywhere in this domain: there is no code path that
 * fills it with a machine, because a self-merge is the failure this phase exists to make
 * impossible.
 */
export interface StageExecution {
  readonly target: StageTarget
  /** A bounded summary of the change, in words. Never a diff, a path or a command. */
  readonly summary: string
  /** How many files the change is expected to touch. A count, never a list. */
  readonly breadth: number
  /** Always `'owner'`. There is no other producer and no way to name one. */
  readonly appliedBy: 'owner'
}

/* ------------------------------------------------------------------ gates */

/**
 * Every gate a merge must clear. Closed, and **all** of them required.
 *
 * Read as prose: the change is staged somewhere real; its tests passed; the red team found
 * nothing; a named reviewer read it and said so; **it has been rolled back on demand at least
 * once**; it touches no protected surface; it grants no authority; and the owner approved this
 * specific merge.
 *
 * Three of them cannot be satisfied by the proposer:
 *
 * - `owner-merge-approved` — the engine has no method that records it on its own authority.
 * - `no-authority-widening` and `no-protected-surface` — evaluated from the proposal's own
 *   declared requirements and targets, so a proposal declaring a forbidden one can never reach
 *   them.
 */
export const IMPROVEMENT_GATE_KINDS = [
  'staged-verified',
  'tests-passed',
  'red-team-clean',
  'review-recorded',
  'rollback-verified',
  'no-protected-surface',
  'no-authority-widening',
  'owner-merge-approved',
] as const
export type ImprovementGateKind = (typeof IMPROVEMENT_GATE_KINDS)[number]

export function isImprovementGateKind(value: unknown): value is ImprovementGateKind {
  return typeof value === 'string' && (IMPROVEMENT_GATE_KINDS as readonly string[]).includes(value)
}

export const IMPROVEMENT_GATE_VERDICTS = ['passed', 'failed', 'pending', 'not-applicable'] as const
export type ImprovementGateVerdict = (typeof IMPROVEMENT_GATE_VERDICTS)[number]

export function isImprovementGateVerdict(value: unknown): value is ImprovementGateVerdict {
  return typeof value === 'string' && (IMPROVEMENT_GATE_VERDICTS as readonly string[]).includes(value)
}

/** Why a gate reads the way it does. Closed labels, never a sentence. */
export const IMPROVEMENT_GATE_REASONS = [
  'stage-was-confirmed-by-a-named-check',
  'stage-was-not-confirmed',
  'stage-not-confirmed-yet',
  'tests-reported-passing',
  'tests-failed',
  'tests-not-reported',
  'red-team-reported-clean',
  'red-team-found-something',
  'red-team-not-reported',
  'review-recorded-by-a-named-reviewer',
  'review-found-a-problem',
  'review-not-reported',
  'rollback-rehearsed-successfully',
  'rollback-rehearsal-failed',
  'rollback-never-rehearsed',
  'touches-no-protected-surface',
  'touches-a-protected-surface',
  'requires-no-forbidden-change',
  'requires-a-forbidden-change',
  'owner-approved-this-merge',
  'owner-has-not-approved',
  'owner-declined',
  'awaiting-owner-merge-approval',
  'marked-not-applicable-by-verifier',
] as const
export type ImprovementGateReason = (typeof IMPROVEMENT_GATE_REASONS)[number]

export const IMPROVEMENT_GATE_REASONS_BY_KIND: Readonly<
  Record<ImprovementGateKind, readonly ImprovementGateReason[]>
> = Object.freeze({
  'staged-verified': Object.freeze([
    'stage-was-confirmed-by-a-named-check',
    'stage-was-not-confirmed',
    'stage-not-confirmed-yet',
    'marked-not-applicable-by-verifier',
  ] as const),
  'tests-passed': Object.freeze([
    'tests-reported-passing',
    'tests-failed',
    'tests-not-reported',
    'marked-not-applicable-by-verifier',
  ] as const),
  'red-team-clean': Object.freeze([
    'red-team-reported-clean',
    'red-team-found-something',
    'red-team-not-reported',
    'marked-not-applicable-by-verifier',
  ] as const),
  'review-recorded': Object.freeze([
    'review-recorded-by-a-named-reviewer',
    'review-found-a-problem',
    'review-not-reported',
    'marked-not-applicable-by-verifier',
  ] as const),
  'rollback-verified': Object.freeze([
    'rollback-rehearsed-successfully',
    'rollback-rehearsal-failed',
    'rollback-never-rehearsed',
    'marked-not-applicable-by-verifier',
  ] as const),
  'no-protected-surface': Object.freeze([
    'touches-no-protected-surface',
    'touches-a-protected-surface',
  ] as const),
  'no-authority-widening': Object.freeze([
    'requires-no-forbidden-change',
    'requires-a-forbidden-change',
  ] as const),
  'owner-merge-approved': Object.freeze([
    'owner-approved-this-merge',
    'owner-declined',
    'awaiting-owner-merge-approval',
  ] as const),
})

/**
 * The reasons each verdict may carry.
 *
 * The second laundering route this closes: a verdict of `passed` carrying the reason
 * `tests-failed` is nonsense, and a ledger that accepts nonsense is a ledger nobody can read.
 */
export const IMPROVEMENT_GATE_REASONS_BY_VERDICT: Readonly<
  Record<ImprovementGateVerdict, readonly ImprovementGateReason[]>
> = Object.freeze({
  passed: Object.freeze([
    'stage-was-confirmed-by-a-named-check',
    'tests-reported-passing',
    'red-team-reported-clean',
    'review-recorded-by-a-named-reviewer',
    'rollback-rehearsed-successfully',
    'touches-no-protected-surface',
    'requires-no-forbidden-change',
    'owner-approved-this-merge',
  ] as const),
  failed: Object.freeze([
    'stage-was-not-confirmed',
    'tests-failed',
    'red-team-found-something',
    'review-found-a-problem',
    'rollback-rehearsal-failed',
    'touches-a-protected-surface',
    'requires-a-forbidden-change',
    'owner-declined',
  ] as const),
  pending: Object.freeze([
    'stage-not-confirmed-yet',
    'tests-not-reported',
    'red-team-not-reported',
    'review-not-reported',
    'rollback-never-rehearsed',
    'awaiting-owner-merge-approval',
  ] as const),
  'not-applicable': Object.freeze(['marked-not-applicable-by-verifier'] as const),
})

/** The gates a ledger can carry, and therefore the gates a decision has to read. */
export const LEDGER_IMPROVEMENT_GATE_KINDS = [
  'staged-verified',
  'tests-passed',
  'red-team-clean',
  'review-recorded',
  'rollback-verified',
  'owner-merge-approved',
] as const
export type LedgerImprovementGateKind = (typeof LEDGER_IMPROVEMENT_GATE_KINDS)[number]

export function isLedgerImprovementGateKind(value: unknown): value is LedgerImprovementGateKind {
  return typeof value === 'string' && (LEDGER_IMPROVEMENT_GATE_KINDS as readonly string[]).includes(value)
}

/** The gates computed from the proposal itself. Nobody may assert these by hand. */
export const DERIVED_IMPROVEMENT_GATE_KINDS = ['no-protected-surface', 'no-authority-widening'] as const
export type DerivedImprovementGateKind = (typeof DERIVED_IMPROVEMENT_GATE_KINDS)[number]

export function isDerivedImprovementGateKind(
  value: unknown,
): value is DerivedImprovementGateKind {
  return typeof value === 'string' && (DERIVED_IMPROVEMENT_GATE_KINDS as readonly string[]).includes(value)
}

export const IMPROVEMENT_GATE_PENDING_REASON_BY_KIND: Readonly<
  Record<LedgerImprovementGateKind, ImprovementGateReason>
> = Object.freeze({
  'staged-verified': 'stage-not-confirmed-yet',
  'tests-passed': 'tests-not-reported',
  'red-team-clean': 'red-team-not-reported',
  'review-recorded': 'review-not-reported',
  'rollback-verified': 'rollback-never-rehearsed',
  'owner-merge-approved': 'awaiting-owner-merge-approval',
})

export const DERIVED_IMPROVEMENT_GATE_REASON_BY_VERDICT: Readonly<
  Record<DerivedImprovementGateKind, Readonly<Record<'passed' | 'failed', ImprovementGateReason>>>
> = Object.freeze({
  'no-protected-surface': Object.freeze({
    passed: 'touches-no-protected-surface',
    failed: 'touches-a-protected-surface',
  }),
  'no-authority-widening': Object.freeze({
    passed: 'requires-no-forbidden-change',
    failed: 'requires-a-forbidden-change',
  }),
})

/** Who or what produced a gate verdict. */
export type ImprovementGateAuthority = 'owner' | 'verifier' | 'core' | 'gate'

/* -------------------------------------------------------------- protected */

/**
 * Surfaces an improvement may never touch.
 *
 * Mirrors Phase 29's `PROTECTED_TARGETS` and is deliberately **closed here too**, because a
 * boundary that lives only in one domain is a boundary a future module can route around. The
 * security root, the cognitive budget, the gate machinery itself and the source tree are all
 * here, and a proposal naming one is refused at construction rather than at merge — the earlier
 * the refusal, the less work was done for nothing.
 */
export const PROTECTED_IMPROVEMENT_SURFACES = [
  'authority',
  'guard',
  'governor',
  'security-policy',
  'improvement-gates',
  'rollback-mechanism',
  'capability-vocabulary',
  'key-material',
  'trusted-runtime',
  'constitution',
  'freya-source',
  'event-journal',
] as const
export type ProtectedImprovementSurface = (typeof PROTECTED_IMPROVEMENT_SURFACES)[number]

export function isProtectedImprovementSurface(value: unknown): value is ProtectedImprovementSurface {
  return typeof value === 'string' && (PROTECTED_IMPROVEMENT_SURFACES as readonly string[]).includes(value)
}

/**
 * Changes an improvement may never require.
 *
 * The same shape as Phase 29's `FORBIDDEN_REQUIREMENTS`, stated here as well so a proposal is
 * refused at construction rather than relying on a downstream check that may not run. Note the
 * two additions specific to this phase: nothing may alter the improvement gates themselves, and
 * nothing may disable or narrow the rollback mechanism. An architecture improvement that can turn
 * off its own brakes is not an improvement.
 */
export const FORBIDDEN_IMPROVEMENTS = [
  'security.authority.manage',
  'security.policy.write',
  'security.budget.manage',
  'security.stop.clear',
  'cognition.grant.manage',
  'work.approval.decide',
  'work.run.manage',
  'mission.manage',
  'guard.policy.write',
  'improvement.gates.write',
  'improvement.rollback.disable',
  'improvement.merge.auto',
  'acquisition.activation.manage',
] as const

export function isForbiddenImprovement(value: unknown): value is string {
  return typeof value === 'string' && (FORBIDDEN_IMPROVEMENTS as readonly string[]).includes(value)
}

/* ----------------------------------------------------------------- spend */

/**
 * The cost currency. Deliberately **not money**, and deliberately *separate* from Phase 29's
 * acquisition units: an architecture change and a capability build are different kinds of work,
 * and one domain's ceiling must not be spendable in the other.
 */
export const IMPROVEMENT_COST_UNITS = Object.freeze({
  perStage: 2,
  perTestRun: 3,
  perRedTeamSweep: 3,
  perReview: 2,
  perRollbackRehearsal: 4,
  perMergeAttempt: 5,
})

/* --------------------------------------------------------------- refusals */

export const IMPROVEMENT_REFUSAL_CODES = Object.freeze([
  'domain-rule',
  'journal-not-trustworthy',
  'stop-all-active',
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'proposal-bound-reached',
  'merge-bound-reached',
  'not-an-object',
  'key-set-mismatch',
  'forbidden-field-refused',
  'invalid-id',
  'invalid-kind',
  'invalid-slug',
  'invalid-text',
  'invalid-instant',
  'invalid-evidence-refs',
  'invalid-tags',
  'invalid-confidence',
  'invalid-target',
  'invalid-closed-reason',
  'invalid-gate-kind',
  'invalid-gate-verdict',
  'invalid-gate-reason',
  'missing-verifier',
  'protected-surface',
  'forbidden-improvement',
  'no-such-proposal',
  'illegal-transition',
  'not-owner',
  'not-mergeable',
  'gate-not-satisfied',
  'gate-may-not-be-self-reported',
  'already-merged',
  'already-terminal',
  'nothing-to-roll-back',
  'store-unavailable',
  'store-degraded',
  'invalid-record',
] as const)
export type ImprovementRefusalCode = (typeof IMPROVEMENT_REFUSAL_CODES)[number]

export function isImprovementRefusalCode(value: unknown): value is ImprovementRefusalCode {
  return typeof value === 'string' && (IMPROVEMENT_REFUSAL_CODES as readonly string[]).includes(value)
}

/* ----------------------------------------------------------------- limits */

export const IMPROVEMENT_LIMITS = Object.freeze({
  /** Open proposals before the retention bound retires the oldest. */
  maxOpenProposals: 24,
  /** Merged-and-not-yet-rolled-back changes at once. */
  maxActiveMerges: 6,
  /** Evidence reference ids one record may carry. */
  maxEvidenceRefs: 16,
  /** Tags one record may carry. */
  maxTagsPerRecord: 8,
  /** Requirements one proposal may declare. */
  maxRequirements: 8,
  /** Rollback steps one proposal may declare. */
  maxRollbackSteps: 12,
  /** Cost units one proposal may be granted. */
  maxCostUnits: 512,
  /** Records one broad projection read may return. */
  maxProjectionRecords: 64,
  /** Characters in an id. */
  maxIdChars: 128,
  /** Characters in a proposal slug. */
  maxSlugChars: 80,
  /** Characters in a symptom or summary. */
  maxSummaryChars: 600,
  /** Characters in a note or reason. */
  maxReasonChars: 500,
  /** Characters in a tag. */
  maxTagChars: 32,
  /** Characters in a verifier or reviewer name. */
  maxVerifierChars: 64,
  /** Characters in an opaque reference id. */
  maxRefChars: 128,
  /** Gate verdicts one proposal may retain in its ledger. */
  maxGateVerdicts: 64,
  /** Change summaries one proposal may declare. */
  maxChanges: 12,
  /** Bytes of one serialised record accepted from the store. */
  maxRecordBodyBytes: 16_384,
})

/* ----------------------------------------------------------------- shapes */

/**
 * A claim that something about how Freya works is costing her.
 *
 * `symptom` is a measurement in bounded words, and `confidence` is capped at `medium` for every
 * source including the owner: a proposal is a generalisation beyond the observation behind it,
 * and the owner being sure of it does not make it an observation.
 */
export interface ImprovementProposal {
  readonly proposalId: string
  readonly kind: ImprovementKind
  /** A bounded code-owned slug for the change. Never a file path, a command or a capability. */
  readonly subject: string
  /** What was observed, in bounded words. A symptom, not a diagnosis. */
  readonly symptom: string
  /** How many times it was seen. A count of occurrences, never a measure of importance. */
  readonly occurrences: number
  readonly evidenceRefs: readonly string[]
  /** Changes the proposal would make, in bounded words. Descriptions, never instructions. */
  readonly changes: readonly string[]
  readonly requirements: readonly string[]
  readonly targets: readonly string[]
  /** How the change would be undone, in bounded words. Not executed by anything here. */
  readonly rollbackSteps: readonly string[]
  readonly costCeiling: number
  readonly costSpent: number
  readonly tags: readonly string[]
  readonly confidence: Confidence
  readonly status: ImprovementStatus
  readonly createdAt: string
  /** Resolved once from `IMPROVEMENT_RETENTION`. Absolute, so readers cannot disagree. */
  readonly expiresAt: string
  /** Set at merge time from `IMPROVEMENT_RETENTION.maxMergedLifetimeMs`. Null until then. */
  readonly mergedAt: string | null
  readonly mergedExpiresAt: string | null
  /** The revision a rollback restores. Set at stage time, never invented at rollback time. */
  readonly restoresRevision: string | null
  readonly closedAt: string | null
  readonly closedReason: ImprovementClosedReason | null
}

/** One gate's verdict, its provenance, and why. */
export interface ImprovementGateRecord {
  readonly kind: ImprovementGateKind
  readonly verdict: ImprovementGateVerdict
  readonly reason: ImprovementGateReason
  readonly authority: ImprovementGateAuthority
  /**
   * The named producer, for a gate that had one.
   *
   * Required for a ledger gate, `null` for a derived one. A gate that says "tests passed"
   * without naming who ran them is not evidence, and requiring the name is what makes the absence
   * visible rather than merely defaulted.
   */
  readonly verifier: string | null
  /** What the verdict rested on. Ids and opaque references, never content. */
  readonly evidenceRefs: readonly string[]
  readonly recordedAt: string
}

/** A merge decision. */
export interface MergeDecision {
  readonly proposalId: string
  readonly approved: boolean
  /** Every gate, always. Not only the ones that passed. */
  readonly gates: readonly ImprovementGateRecord[]
  readonly unsatisfied: readonly ImprovementGateKind[]
  readonly decidedAt: string
  /** Whether the owner was the one who approved. Always true when `approved`. */
  readonly ownerApproved: boolean
  /**
   * The first check in the precedence order that refused, or null when nothing did.
   *
   * Reported rather than merely obeyed, because a single reason code is what makes precedence
   * auditable: a ledger that recorded only "refused" would let a later reader assume the domain
   * rule was what stopped something when in fact a stop was.
   */
  readonly precedence: ImprovementPrecedence | null
}

/**
 * The precedence this domain checks, in order. First match refuses.
 *
 * Identical in shape to Phase 29's ladder, and for the same reasons: the journal is worse than a
 * stop because a log with a hole in it may have lost the stop; a stop is worse than an approval
 * because a latch is not a decision; and a domain rule is last so that a reader who sees
 * `domain-rule` knows every security check passed and this proposal was simply not allowed.
 */
export const IMPROVEMENT_PRECEDENCE = [
  'journal-not-trustworthy',
  'stop-all-active',
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'domain-rule',
] as const
export type ImprovementPrecedence = (typeof IMPROVEMENT_PRECEDENCE)[number]

export function isImprovementPrecedence(value: unknown): value is ImprovementPrecedence {
  return typeof value === 'string' && (IMPROVEMENT_PRECEDENCE as readonly string[]).includes(value)
}

/** Everything this domain folds and derives from. Metadata and text, encrypted. */
export interface ImprovementState {
  readonly proposals: Map<string, ImprovementProposal>
  /** Gate records by proposal id, oldest first. */
  readonly gates: Map<string, readonly ImprovementGateRecord[]>
  readonly decisions: Map<string, MergeDecision>
  sequence: number
}

/** The derived view of what Freya is trying to change about herself. */
export interface ImprovementDerivation {
  readonly schemaVersion: number
  readonly counts: {
    readonly openProposals: number
    readonly proposals: number
    readonly byStatus: Readonly<Record<ImprovementStatus, number>>
    readonly byKind: Readonly<Record<ImprovementKind, number>>
    /** Merged changes currently standing. The number that should be small and known. */
    readonly activeMerges: number
    /** Terminal proposals, by reason. */
    readonly terminal: number
    /** Proposals rolled back after landing. A rollback count is a health number. */
    readonly rolledBack: number
    readonly costSpent: number
    readonly costRemaining: number
    readonly stale: number
  }
  readonly furthestStatus: ImprovementStatus | null
  /** Proposals finished and waiting on the one gate only a person can pass. */
  readonly awaitingOwner: readonly string[]
  /** Every gate kind any live proposal still has unsatisfied, counted. */
  readonly blockedOn: Readonly<Record<ImprovementGateKind, number>>
  /** Merged changes whose own retention bound has passed. Not yet rolled back. */
  readonly mergesAwaitingReview: readonly string[]
  /** This domain applies nothing and merges nothing. Rendered rather than respected. */
  readonly mergeAuthority: 'none'
}

/* -------------------------------------------------------------- utilities */

export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** A bounded code-owned slug: lower-case letters, digits, dashes. */
export function isImprovementSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
}

/** A bounded opaque reference id. */
export function isImprovementRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= IMPROVEMENT_LIMITS.maxRefChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/**
 * Field names that would turn a description of a change into an instruction or a grant.
 *
 * Same refuse-not-ignore rule as every other domain in Core, and the same reason: a field this
 * domain silently drops today is a field somebody will read next month. Normalised and
 * affix-tolerant, so `appliesCode`, `mergeNow` and `selfApply` are one family.
 */
export const IMPROVEMENT_FORBIDDEN_FIELDS = Object.freeze([
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
  'apply',
  'applycode',
  'applies',
  'automerge',
  'commit',
  'push',
  'forcepush',
  'checkout',
  'execute',
  'spawn',
  'script',
  'approve',
  'approval',
  'merge',
  'merged',
  'rollbackdisable',
  'disable',
  'trusted',
  'trust',
  'verified',
  'secret',
  'credential',
  'token',
  'apikey',
  'spend',
  'budget',
  'clearsstopall',
  'always',
  'status',
  'scope',
] as const)

export function normaliseImprovementFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/about|for|toward|towards|to|the/g, '')
}

export function isForbiddenImprovementFieldName(name: string): boolean {
  const token = normaliseImprovementFieldName(name)
  for (const listed of IMPROVEMENT_FORBIDDEN_FIELDS) {
    const normalised = normaliseImprovementFieldName(listed)
    if (token === normalised) return true
    if (token.startsWith(normalised) || token.endsWith(normalised)) return true
  }
  return false
}

/** Bounded, non-empty text. */
export function isBoundedImprovementText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/**
 * The whole boundary as data, so a surface can render it.
 *
 * Six fields, and each one is a refusal a reader can see rather than a promise in a docstring.
 * `rollbackAlwaysAvailable` is the one worth noticing: a change that has landed can always be
 * undone, because `merged → rolled-back` is the only edge out of `merged`.
 */
export const IMPROVEMENT_APPLIES_NOTHING = Object.freeze({
  appliesCode: false as const,
  executesChange: false as const,
  grantsCapability: false as const,
  grantsAuthority: false as const,
  maySelfMerge: false as const,
  mayDisableItsOwnGates: false as const,
  rollbackAlwaysAvailable: true as const,
  reason: 'a change is described, gated and reviewed here; only the owner merges it, and only this domain can be rolled back',
})