/**
 * THE CAPABILITY ACQUISITION DOMAIN — Phase 29's vocabulary.
 *
 * Types, closed tables and ceilings only: no logic, no I/O, no clock, no model, no
 * randomness.
 *
 * ## What this domain is
 *
 * PLAN.md §14 row 29: *"detect capability gap → propose/build → verify → gated activation."*
 *
 * It is the **ledger and the gatekeeper** for that loop, and nothing else. It does not build
 * anything (Foundry does), does not admit skills (`core/skills` does), does not execute
 * anything (`core/work` does) and cannot register a capability anywhere. What it owns is:
 *
 * ```
 *   CapabilityGap  →  AcquisitionRequest  →  GateLedger  →  ActivationDecision
 *   a need, named     what would close it   every gate,     may this become active?
 *   but never held     and at what cost       with a verdict  never, and never alone
 * ```
 *
 * ## The four boundaries, stated as contracts
 *
 * 1. **A generated capability starts untrusted and inactive.** `TRUST_CLASSES.generated` is
 *    `'untrusted'` and `ACTIVATION_INITIAL` is `'inactive'`, and both are *fields on the
 *    request* rather than values a caller passes. There is no constructor parameter for
 *    either, so there is no shape in which a generated capability arrives already trusted or
 *    already running.
 * 2. **A gap is a need, not a permission.** `CapabilityGap.wanted` is a bounded code-owned
 *    slug and nothing else. This domain never mints, names, resolves or holds a `Capability`,
 *    because a system that can *name* the thing it wants is one refactor away from granting
 *    it.
 * 3. **Promotion requires verification *and* gates.** `GATE_KINDS` is closed and every kind
 *    must pass. `owner-approval` is one of them and is not reachable by the requester: the
 *    engine has no method that records it on its own authority.
 * 4. **No hidden loops, no unapproved spend.** Work is metered in `ACQUISITION_COST_UNITS`,
 *    a code-owned currency with no money in it, and `spendUnits` refuses at the bound. There
 *    is no scheduler, no timer, no retry-forever and no background flag in this domain —
 *    `docstring`-level claims about cost are not mechanisms, so there is nothing to turn on.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count, stated in
 * `ACQUISITION_LIMITS`.
 */

import type { Confidence } from '../brain/types'

/* ------------------------------------------------------------------- gaps */

/**
 * Why Freya cannot do something.
 *
 * Every member is a statement about **work**, not about a person and not about a
 * permission. There is no `missing-authority` kind on purpose: a lack of authority is a
 * correct state, not a gap to be closed, and naming it here would make "ask for more
 * permission" look like the same kind of problem as "there is no tool that reads this file".
 */
export const GAP_KINDS = [
  'tool-absent',
  'format-unsupported',
  'step-not-automatable',
  'evidence-missing',
  'environment-limit',
] as const
export type GapKind = (typeof GAP_KINDS)[number]

export function isGapKind(value: unknown): value is GapKind {
  return typeof value === 'string' && (GAP_KINDS as readonly string[]).includes(value)
}

/** Closed reasons a gap may be closed. A gap cannot simply stop being a gap. */
export const GAP_CLOSURE_REASONS = [
  'capability-acquired-and-activated',
  'work-changed-so-the-gap-closed',
  'owner-decided-it-is-not-a-gap',
  'aged-out-past-retention',
  'withdrawn-by-owner',
] as const
export type GapClosureReason = (typeof GAP_CLOSURE_REASONS)[number]

export function isGapClosureReason(value: unknown): value is GapClosureReason {
  return typeof value === 'string' && (GAP_CLOSURE_REASONS as readonly string[]).includes(value)
}

/* --------------------------------------------------------------- requests */

/**
 * Where an acquisition request has got to.
 *
 * ```
 *   proposed → building → built → verifying → verified → activation-requested → active
 *       │         │         │          │           │              │
 *       └─────────┴─────────┴──────────┴───────────┴──────────────┴──→ rejected | expired
 * ```
 *
 * `active` is reachable only through `activation-requested`, which is reachable only from
 * `verified`. Every terminal status is terminal: a request that failed verification is a
 * **new** request, not a retry of this one, so a failure cannot be quietly edited into a
 * pass.
 */
export const REQUEST_STATUSES = [
  'proposed',
  'building',
  'built',
  'verifying',
  'verified',
  'activation-requested',
  'active',
  'rejected',
  'expired',
] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value)
}

export const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = Object.freeze({
  proposed: Object.freeze(['building', 'rejected', 'expired'] as const),
  building: Object.freeze(['built', 'rejected', 'expired'] as const),
  built: Object.freeze(['verifying', 'rejected', 'expired'] as const),
  verifying: Object.freeze(['verified', 'rejected', 'expired'] as const),
  verified: Object.freeze(['activation-requested', 'rejected', 'expired'] as const),
  'activation-requested': Object.freeze(['active', 'rejected', 'expired'] as const),
  // `active` is *not* terminal, and this is the only thing that can change: the owner's
  // revocation, or the activation's own retention bound. There is deliberately no
  // `active -> activation-requested` edge, so a revoked activation can never be
  // re-activated — a new request is the only route, and it starts untrusted again.
  active: Object.freeze(['rejected', 'expired'] as const),
  rejected: Object.freeze([] as const),
  expired: Object.freeze([] as const),
})

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to)
}

export const REQUEST_LIFECYCLE_REASONS = [
  'owner-rejected-this-request',
  'verification-failed',
  'gate-failed',
  'owner-withdrew-this-request',
  'owner-revoked-this-activation',
  'retention-bound-reached',
  'stale-request-expired',
  'owner-declined-activation',
] as const
export type RequestLifecycleReason = (typeof REQUEST_LIFECYCLE_REASONS)[number]

export function isRequestLifecycleReason(value: unknown): value is RequestLifecycleReason {
  return typeof value === 'string' && (REQUEST_LIFECYCLE_REASONS as readonly string[]).includes(value)
}

export const REQUEST_LIFECYCLE_REASON_BY_STATUS: Readonly<
  Record<RequestStatus, readonly RequestLifecycleReason[]>
> = Object.freeze({
  proposed: Object.freeze([] as const),
  building: Object.freeze([] as const),
  built: Object.freeze([] as const),
  verifying: Object.freeze([] as const),
  verified: Object.freeze([] as const),
  'activation-requested': Object.freeze([] as const),
  active: Object.freeze([] as const),
  rejected: Object.freeze([
    'owner-rejected-this-request',
    'verification-failed',
    'gate-failed',
    'owner-withdrew-this-request',
    'owner-revoked-this-activation',
    'owner-declined-activation',
  ] as const),
  expired: Object.freeze([
    'retention-bound-reached',
    'stale-request-expired',
    'owner-revoked-this-activation',
  ] as const),
})

/* --------------------------------------------------------------- retention */

/**
 * How long a thing may sit unfinished before it stops being a live request.
 *
 * Bounded in **milliseconds of wall clock, resolved once at construction**, and stored on
 * the record as an absolute instant rather than as a duration that a later reader would
 * have to re-derive. Three reasons that matters:
 *
 * 1. **Nothing watches a clock.** There is no timer in this domain, so an expiry is a fact
 *    a reader evaluates (`expireStaleRequests(now)`), not a thing that happens on its own.
 *    A background thread that quietly expired things is a background thread.
 * 2. **A request cannot outlive its usefulness.** An unbuilt proposal from eleven weeks ago
 *    is not a pending item; it is clutter that reads as pending, which is the more
 *    dangerous of the two.
 * 3. **An activation cannot be permanent by accident.** `maxActiveLifetimeMs` is separate
 *    from the request lifetime, so "the owner approved this once" never becomes "this runs
 *    forever" without a second, dated decision.
 *
 * The numbers are deliberately unremarkable and deliberately *code-owned*: a caller may not
 * name its own deadline, because "no deadline at all" is the only value that would help
 * whoever is being bounded.
 */
export const ACQUISITION_RETENTION = Object.freeze({
  /** How long a detected gap stays open before it is retired. */
  maxGapLifetimeMs: 90 * 24 * 60 * 60 * 1_000,
  /** How long a request may sit before it is stale. */
  maxRequestLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
  /**
   * How long an activation may stand before it must be approved again.
   *
   * Shorter than the request lifetime on purpose: the longer a thing is *running*, the less
   * its author should be permitted to have forgotten approving it.
   */
  maxActiveLifetimeMs: 14 * 24 * 60 * 60 * 1_000,
})

export function isRequestLifecycleConsistent(
  status: RequestStatus,
  lifecycleAt: string | null,
  lifecycleReason: RequestLifecycleReason | null,
): boolean {
  const allowed = REQUEST_LIFECYCLE_REASON_BY_STATUS[status]
  if (allowed === undefined) return false
  if (allowed.length === 0) return lifecycleAt === null && lifecycleReason === null
  if (lifecycleAt === null || lifecycleReason === null) return false
  return allowed.includes(lifecycleReason)
}

/* ------------------------------------------------------------------ trust */

/**
 * Trust classes. A generated capability gets the only one available to it.
 *
 * `'owner-declared'` exists because the owner may declare an intent, and `'derived'` because
 * Core may summarise what it already has. There is deliberately no `'verified'` or
 * `'trusted'` member: a *generated* artifact is never one of those, whatever it is called
 * later. Promotion here means "the owner approved this specific thing", not "this became
 * true".
 */
export const TRUST_CLASSES = ['untrusted', 'owner-declared', 'derived'] as const
export type TrustClass = (typeof TRUST_CLASSES)[number]

export function isTrustClass(value: unknown): value is TrustClass {
  return typeof value === 'string' && (TRUST_CLASSES as readonly string[]).includes(value)
}

/** The trust class every generated artifact starts in. A constant, not a parameter. */
export const GENERATED_TRUST_CLASS: TrustClass = 'untrusted'

/** The activation state every generated artifact starts in. A constant, not a parameter. */
export const GENERATED_ACTIVATION: ActivationState = 'inactive'

/* ------------------------------------------------------------- activation */

export const ACTIVATION_STATES = ['inactive', 'activation-requested', 'active', 'revoked'] as const
export type ActivationState = (typeof ACTIVATION_STATES)[number]

export function isActivationState(value: unknown): value is ActivationState {
  return typeof value === 'string' && (ACTIVATION_STATES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ gates */

/**
 * Every gate an activation must clear. Closed, and **all** of them required.
 *
 * The list is the mechanism, so it is worth reading as prose: a generated capability is
 * untrusted and inactive; it has been built; it has been **verified**; its tests passed; the
 * red team found nothing; it does not touch a protected target; it does not widen any
 * capability; its spend stayed inside the bound; and **the owner approved this specific
 * activation**.
 *
 * Two of them cannot be satisfied by the requester at all:
 *
 * - `owner-approval` — the engine has no method that records it on its own authority.
 * - `no-capability-widening` — evaluated from the request's own declared requirements, and a
 *   request that declares a forbidden one can never reach it.
 */
export const GATE_KINDS = [
  'verification-passed',
  'tests-passed',
  'red-team-clean',
  'no-protected-target',
  'no-capability-widening',
  'budget-within-limit',
  'owner-approval',
] as const
export type GateKind = (typeof GATE_KINDS)[number]

export function isGateKind(value: unknown): value is GateKind {
  return typeof value === 'string' && (GATE_KINDS as readonly string[]).includes(value)
}

export const GATE_VERDICTS = ['passed', 'failed', 'pending', 'not-applicable'] as const
export type GateVerdict = (typeof GATE_VERDICTS)[number]

export function isGateVerdict(value: unknown): value is GateVerdict {
  return typeof value === 'string' && (GATE_VERDICTS as readonly string[]).includes(value)
}

/** Why a gate reads the way it does. Closed labels, never a sentence. */
export const GATE_REASONS = [
  'verified-by-a-named-verifier',
  'verification-did-not-pass',
  'verification-not-run',
  'tests-reported-passing',
  'tests-failed',
  'tests-not-reported',
  'red-team-reported-clean',
  'red-team-found-something',
  'red-team-not-reported',
  'target-is-not-protected',
  'target-is-protected',
  'requires-no-forbidden-capability',
  'requires-a-forbidden-capability',
  'spend-stayed-within-the-bound',
  'spend-exceeded-the-bound',
  'owner-approved-this-activation',
  'owner-has-not-approved',
  'owner-declined',
  'awaiting-owner-approval',
  'marked-not-applicable-by-verifier',
] as const
export type GateReason = (typeof GATE_REASONS)[number]

/**
 * The reasons each gate kind may carry, and nothing else.
 *
 * Without this, a verdict could be laundered: a caller holding `tests-passed` could record it
 * with the reason `owner-approved-this-activation`, and the ledger would then read as though
 * the owner had approved something on the strength of a test run. Binding the reason to the
 * kind makes the label describe the thing it is attached to, which is the only reason to
 * have a closed vocabulary of labels at all.
 */
export const GATE_REASONS_BY_KIND: Readonly<Record<GateKind, readonly GateReason[]>> = Object.freeze({
  'verification-passed': Object.freeze([
    'verified-by-a-named-verifier',
    'verification-did-not-pass',
    'verification-not-run',
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
  'no-protected-target': Object.freeze([
    'target-is-not-protected',
    'target-is-protected',
  ] as const),
  'no-capability-widening': Object.freeze([
    'requires-no-forbidden-capability',
    'requires-a-forbidden-capability',
  ] as const),
  'budget-within-limit': Object.freeze([
    'spend-stayed-within-the-bound',
    'spend-exceeded-the-bound',
  ] as const),
  'owner-approval': Object.freeze([
    'owner-approved-this-activation',
    'owner-declined',
    'awaiting-owner-approval',
  ] as const),
})

/**
 * The reasons each verdict may carry.
 *
 * The second laundering route this closes: a verdict of `passed` carrying the reason
 * `tests-failed` is nonsense, and a ledger that accepts nonsense is a ledger nobody can read.
 * A verdict and its reason must agree about which way the gate went.
 */
export const GATE_REASONS_BY_VERDICT: Readonly<Record<GateVerdict, readonly GateReason[]>> = Object.freeze({
  passed: Object.freeze([
    'verified-by-a-named-verifier',
    'tests-reported-passing',
    'red-team-reported-clean',
    'target-is-not-protected',
    'requires-no-forbidden-capability',
    'spend-stayed-within-the-bound',
    'owner-approved-this-activation',
  ] as const),
  failed: Object.freeze([
    'verification-did-not-pass',
    'tests-failed',
    'red-team-found-something',
    'target-is-protected',
    'requires-a-forbidden-capability',
    'spend-exceeded-the-bound',
    'owner-declined',
  ] as const),
  pending: Object.freeze([
    'verification-not-run',
    'tests-not-reported',
    'red-team-not-reported',
    'awaiting-owner-approval',
  ] as const),
  'not-applicable': Object.freeze(['marked-not-applicable-by-verifier'] as const),
})

/**
 * The gates a ledger can carry, and therefore the gates a decision has to read.
 *
 * The complement of `DERIVED_GATE_KINDS`: three of the seven are computed from the request
 * every time a decision is made, and four are recorded by a named party. Listing the
 * complement by name is what makes "these are the only verdicts a ledger may hold" a check
 * rather than a hope, and it is why `decideActivation` never has to invent a placeholder for
 * a derived gate.
 */
export const LEDGER_GATE_KINDS = [
  'verification-passed',
  'tests-passed',
  'red-team-clean',
  'owner-approval',
] as const
export type LedgerGateKind = (typeof LEDGER_GATE_KINDS)[number]

export function isLedgerGateKind(value: unknown): value is LedgerGateKind {
  return typeof value === 'string' && (LEDGER_GATE_KINDS as readonly string[]).includes(value)
}

/**
 * The reason each ledger gate reports when nothing has been recorded against it yet.
 *
 * Per kind, because a single "pending" label on a ledger where three different parties owe
 * verdicts tells a reader nothing about who still owes one — and "nobody owes anything" is
 * exactly the impression a vague placeholder creates.
 */
export const GATE_PENDING_REASON_BY_KIND: Readonly<Record<LedgerGateKind, GateReason>> = Object.freeze({
  'verification-passed': 'verification-not-run',
  'tests-passed': 'tests-not-reported',
  'red-team-clean': 'red-team-not-reported',
  'owner-approval': 'awaiting-owner-approval',
})

/**
 * The reasons a *derived* gate may carry, keyed by the verdict it takes.
 *
 * Kept beside the tables above rather than in `gates.ts`, so the "these three are computed,
 * never asserted" rule is visible in the vocabulary rather than only in the evaluator.
 */
export const DERIVED_GATE_REASON_BY_VERDICT: Readonly<
  Record<
    'no-protected-target' | 'no-capability-widening' | 'budget-within-limit',
    Readonly<Record<'passed' | 'failed', GateReason>>
  >
> =
  Object.freeze({
    'no-protected-target': Object.freeze({ passed: 'target-is-not-protected', failed: 'target-is-protected' }),
    'no-capability-widening': Object.freeze({
      passed: 'requires-no-forbidden-capability',
      failed: 'requires-a-forbidden-capability',
    }),
    'budget-within-limit': Object.freeze({
      passed: 'spend-stayed-within-the-bound',
      failed: 'spend-exceeded-the-bound',
    }),
  })

/**
 * The gates that may only be satisfied by something that was *checking*, not by whoever
 * asked for the activation.
 *
 * A closed membership test rather than a heuristic, for the same reason `core/skills`
 * protects its domains by name: widening what counts as evidence has to be a visible line
 * in a diff, and it must never be reachable by adding a value somewhere else.
 */
export const EVIDENCE_GATE_KINDS = [
  'verification-passed',
  'tests-passed',
  'red-team-clean',
] as const
export type EvidenceGateKind = (typeof EVIDENCE_GATE_KINDS)[number]

export function isEvidenceGateKind(value: unknown): value is EvidenceGateKind {
  return typeof value === 'string' && (EVIDENCE_GATE_KINDS as readonly string[]).includes(value)
}

/** The gates a gate produces from the request itself. Nobody may assert these by hand. */
export const DERIVED_GATE_KINDS = [
  'no-protected-target',
  'no-capability-widening',
  'budget-within-limit',
] as const
export type DerivedGateKind = (typeof DERIVED_GATE_KINDS)[number]

export function isDerivedGateKind(value: unknown): value is DerivedGateKind {
  return typeof value === 'string' && (DERIVED_GATE_KINDS as readonly string[]).includes(value)
}

/**
 * Who or what produced a gate verdict.
 *
 * Three members plus the owner, and the split is the whole provenance argument:
 * `verifier` is something that ran a check, `core` is the domain recording its own
 * bookkeeping, `gate` is the evaluator's own arithmetic, and `owner` is a person. A verdict
 * about *this request* cannot be attributed to a person by anyone but the owner, because
 * `recordGateVerdict` refuses the `owner-approval` kind from every other authority.
 */
export type GateAuthority = 'owner' | 'verifier' | 'core' | 'gate'

/* -------------------------------------------------------------- protected */

/**
 * Targets an acquisition may never touch.
 *
 * Mirrors `core/skills`'s protected domains in spirit and is deliberately **closed here
 * too**, because a boundary that lives only in one domain is a boundary that a future
 * module can route around. Authority, Guard, Governor, key material and the source tree are
 * all here, and a request naming one is refused at construction rather than at activation —
 * the earlier the refusal, the less work was done for nothing.
 */
export const PROTECTED_TARGETS = [
  'authority',
  'guard',
  'governor',
  'security-policy',
  'capability-definition',
  'key-material',
  'trusted-runtime',
  'constitution',
  'budget-policy',
  'freya-source',
] as const
export type ProtectedTarget = (typeof PROTECTED_TARGETS)[number]

export function isProtectedTarget(value: unknown): value is ProtectedTarget {
  return typeof value === 'string' && (PROTECTED_TARGETS as readonly string[]).includes(value)
}

/**
 * Capabilities an acquisition may never require.
 *
 * The same shape as `core/skills`'s forbidden list: security, cognition grants, approval
 * decisions, mission and run management. Stated here as well so a request can be refused at
 * construction rather than relying on a downstream check that may not run.
 */
export const FORBIDDEN_REQUIREMENTS = [
  'security.authority.manage',
  'security.policy.write',
  'security.budget.manage',
  'security.stop.clear',
  'cognition.grant.manage',
  'work.approval.decide',
  'work.run.manage',
  'mission.manage',
  'guard.policy.write',
] as const

export function isForbiddenRequirement(value: unknown): value is string {
  return typeof value === 'string' && (FORBIDDEN_REQUIREMENTS as readonly string[]).includes(value)
}

/* ----------------------------------------------------------------- spend */

/**
 * The cost currency. Deliberately **not money**.
 *
 * A code-owned unit that means "one bounded step of work". There is no conversion to a
 * provider price, no currency and no rate in this domain, so nothing here can be read as
 * authorisation to spend anything. PLAN.md §11 reserves real spending to a later explicit
 * owner decision, and a domain that cannot represent money cannot pre-authorise it.
 */
export const ACQUISITION_COST_UNITS = Object.freeze({
  /** One unit is one step. Charged when a step is charged. */
  perBuildStep: 1,
  /** One verification run. */
  perVerification: 2,
  /** One red-team sweep. */
  perRedTeamSweep: 3,
  /** One activation attempt. */
  perActivationAttempt: 4,
})

/* ------------------------------------------------------------- refusals */

export const ACQUISITION_REFUSAL_CODES = Object.freeze([
  'domain-rule',
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
  'invalid-actor',
  'invalid-gate-kind',
  'invalid-gate-verdict',
  'invalid-gate-reason',
  'missing-verifier',
  'protected-target',
  'forbidden-requirement',
  'no-such-gap',
  'no-such-request',
  'illegal-transition',
  'illegal-lifecycle-reason',
  'not-owner',
  'not-verifiable',
  'gate-not-satisfied',
  'gate-may-not-be-self-reported',
  'budget-exhausted',
  'request-bound-reached',
  'activation-bound-reached',
  'already-active',
  'already-terminal',
  'already-withdrawn',
  'store-unavailable',
  'store-degraded',
  'invalid-record',
  'journal-not-trustworthy',
  'stop-all-active',
  'guard-denied',
  'governor-denied',
] as const)
export type AcquisitionRefusalCode = (typeof ACQUISITION_REFUSAL_CODES)[number]

export function isAcquisitionRefusalCode(value: unknown): value is AcquisitionRefusalCode {
  return typeof value === 'string' && (ACQUISITION_REFUSAL_CODES as readonly string[]).includes(value)
}

/* ---------------------------------------------------------------- limits */

export const ACQUISITION_LIMITS = Object.freeze({
  /** Open gaps before the retention bound retires the oldest. */
  maxOpenGaps: 64,
  /** Live acquisition requests before the retention bound retires the oldest. */
  maxLiveRequests: 32,
  /** Active requests before the activation retention bound retires the oldest. */
  maxActiveRequests: 4,
  /** Evidence reference ids one record may carry. */
  maxEvidenceRefs: 16,
  /** Tags one record may carry. */
  maxTagsPerRecord: 8,
  /** Requirements one request may declare. */
  maxRequirements: 8,
  /** Build steps one request may declare. */
  maxSteps: 24,
  /** Cost units one request may be granted. */
  maxCostUnits: 512,
  /** Records one broad projection read may return. */
  maxProjectionRecords: 64,
  /** Characters in an id. */
  maxIdChars: 128,
  /** Characters in a wanted-capability slug. */
  maxWantedChars: 80,
  /** Characters in a symptom description. */
  maxSymptomChars: 600,
  /** Characters in a note or reason. */
  maxReasonChars: 500,
  /** Characters in a tag. */
  maxTagChars: 32,
  /** Characters in a verifier name. */
  maxVerifierChars: 64,
  /** Characters in an opaque reference id. */
  maxRefChars: 128,
  /** Gate verdicts one request may retain in its ledger. */
  maxGateVerdicts: 64,
  /** Bytes of one serialised record accepted from the store. */
  maxRecordBodyBytes: 16_384,
})

/* ---------------------------------------------------------------- shapes */

/**
 * A need, named.
 *
 * `wanted` is a bounded slug describing the *shape* of the thing needed — `csv-export`,
 * `archive-reader` — and is deliberately **not** a `Capability` from the closed capability
 * registry. Naming a capability is how a system ends up holding one: the moment a gap says
 * `work.run.manage`, something downstream will look for a grant to match it. A slug cannot
 * be granted, so a slug cannot be laundered.
 */
export interface CapabilityGap {
  readonly gapId: string
  readonly kind: GapKind
  /** A code-owned slug for the *shape* of what is needed. Never a capability id. */
  readonly wanted: string
  /** What was observed, in bounded words. A symptom, not a diagnosis. */
  readonly symptom: string
  /** How many times it was seen. A count of occurrences, never a measure of importance. */
  readonly occurrences: number
  readonly evidenceRefs: readonly string[]
  readonly tags: readonly string[]
  readonly detectedBy: 'core' | 'owner'
  readonly detectedAt: string
  /** Resolved once from `ACQUISITION_RETENTION`. Absolute, so readers cannot disagree. */
  readonly expiresAt: string
  readonly status: 'open' | 'closed'
  readonly closedAt: string | null
  readonly closureReason: GapClosureReason | null
}

/**
 * What would close a gap, and at what cost.
 *
 * The two fields that make the boundary structural: `trustClass` is always
 * `GENERATED_TRUST_CLASS` and `activation` is always `GENERATED_ACTIVATION` at
 * construction, and neither is a constructor parameter. There is no code path that produces
 * a request carrying anything else.
 */
export interface AcquisitionRequest {
  readonly requestId: string
  readonly gapId: string
  /** A code-owned slug for what is being built. Never a capability id. */
  readonly subject: string
  /** What the build would produce, in bounded words. A description, not an instruction. */
  readonly intent: string
  /** Requirements the built thing will ask for at run time. Never a grant. */
  readonly requirements: readonly string[]
  /** Targets the build would read or write. A protected one is refused at construction. */
  readonly targets: readonly string[]
  readonly steps: readonly string[]
  /** The cost ceiling, in code-owned units. Not money and not a provider budget. */
  readonly costCeiling: number
  /** Cost units already charged. */
  readonly costSpent: number
  readonly tags: readonly string[]
  readonly confidence: Confidence
  /** Always `GENERATED_TRUST_CLASS`. */
  readonly trustClass: TrustClass
  /** Always `GENERATED_ACTIVATION` until an owner-approved activation. */
  readonly activation: ActivationState
  readonly status: RequestStatus
  readonly createdAt: string
  /** Resolved once from `ACQUISITION_RETENTION`. Absolute, so readers cannot disagree. */
  readonly expiresAt: string
  /**
   * When an activation stops standing, once it is granted.
   *
   * Null until then, and set from `ACQUISITION_RETENTION.maxActiveLifetimeMs` at the moment
   * of approval — never from the request's own `expiresAt`, because "the owner approved this"
   * and "this proposal is still fresh" are different decisions with different deadlines.
   */
  readonly activationExpiresAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: RequestLifecycleReason | null
}

/**
 * One gate's verdict, its provenance, and why.
 *
 * `verifier` is the provenance: a bounded name for whatever produced the verdict. It is
 * **mandatory and non-empty** for an evidence gate, `null` for a gate the evaluator computed
 * from the request, and never a sentence. A gate that says "verified" without naming who
 * verified it is not evidence, and requiring the name at construction is what makes the
 * absence visible rather than merely defaulted.
 */
export interface GateVerdictRecord {
  readonly kind: GateKind
  readonly verdict: GateVerdict
  readonly reason: GateReason
  /** Who or what produced the verdict. `'owner'` is the only value the owner can produce. */
  readonly authority: GateAuthority
  /**
   * The named producer, for a gate that had one.
   *
   * Required for an evidence gate, `null` for a derived gate. There is no third option and
   * no way to pass a fabricated one: a name is a name, and a verdict with no name behind it
   * is treated as unsatisfied rather than assumed.
   */
  readonly verifier: string | null
  /** What the verdict rested on. Ids and opaque references, never content. */
  readonly evidenceRefs: readonly string[]
  readonly recordedAt: string
}

/**
 * An activation decision.
 *
 * `approved` is the only way a request becomes `active`, and it cannot be true while any
 * gate is unsatisfied — enforced in `gates.ts` and asserted in every test that reaches
 * `active`.
 */
export interface ActivationDecision {
  readonly requestId: string
  readonly approved: boolean
  /** Every gate, always. Not only the ones that passed. */
  readonly gates: readonly GateVerdictRecord[]
  readonly unsatisfied: readonly GateKind[]
  readonly decidedAt: string
  /** Whether the owner was the one who approved. Always true when `approved`. */
  readonly ownerApproved: boolean
  /**
   * The first check in the precedence order that refused, or null when nothing did.
   *
   * Reported rather than merely obeyed, because a single reason code is what makes
   * precedence auditable: a journal that recorded only "refused" would let a later reader
   * assume the domain rule was what stopped something when in fact a stop was.
   */
  readonly precedence: AcquisitionPrecedence | null
}

/**
 * The precedence this domain checks, in order. First match refuses.
 *
 * The order is the argument, so it is written down as data rather than implied by the shape
 * of a function:
 *
 * 1. `journal-not-trustworthy` — a log that failed validation has a hole in it, and the
 *    discarded segment may have held the very latch or refusal that would have applied. This
 *    outranks everything, including a valid owner approval, and it is the same rule the
 *    Cognition Governor applies for the same reason.
 * 2. `stop-all-active` — the owner's global latch. It outranks an owner approval, because a
 *    latch is not an approval and "the owner stopped Freya" must beat "the owner clicked a
 *    button twenty minutes ago".
 * 3. `guard-denied` — the principal did not hold `acquisition.propose` /
 *    `acquisition.activation.manage`. Outranks the domain rules, so an unauthorised caller
 *    never learns whether *its particular* request would have passed.
 * 4. `governor-denied` — cognition is refused for this background work: no allowance, an
 *    expired one, or a policy that will not permit unattended building. Building is model
 *    work; it spends.
 * 5. `budget-exhausted` — the request's own ceiling. Below the authority rules because
 *    "you have no authority" and "this one is too expensive" are different facts and only one
 *    of them is true of a given caller.
 * 6. `domain-rule` — everything in this module: lifecycle, gates, provenance, protected
 *    targets, forbidden requirements.
 */
export const ACQUISITION_PRECEDENCE = [
  'journal-not-trustworthy',
  'stop-all-active',
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'domain-rule',
] as const
export type AcquisitionPrecedence = (typeof ACQUISITION_PRECEDENCE)[number]

export function isAcquisitionPrecedence(value: unknown): value is AcquisitionPrecedence {
  return typeof value === 'string' && (ACQUISITION_PRECEDENCE as readonly string[]).includes(value)
}

/** Everything this domain folds and derives from. Metadata and text, encrypted. */
export interface AcquisitionState {
  readonly gaps: Map<string, CapabilityGap>
  readonly requests: Map<string, AcquisitionRequest>
  /** Gate verdicts by request id, newest last. */
  readonly gates: Map<string, readonly GateVerdictRecord[]>
  readonly decisions: Map<string, ActivationDecision>
  sequence: number
}

/** The derived view of what Freya is trying to acquire and what is blocking her. */
export interface AcquisitionDerivation {
  readonly schemaVersion: number
  readonly counts: {
    readonly openGaps: number
    readonly closedGaps: number
    readonly requests: number
    readonly byStatus: Readonly<Record<RequestStatus, number>>
    readonly byGapKind: Readonly<Record<GapKind, number>>
    /** Requests that are `active`. The number a person would want to be zero. */
    readonly active: number
    /** Terminal requests, by reason. A retention bound that fired shows up here. */
    readonly terminal: number
    /** Cost units charged across every live request. */
    readonly costSpent: number
    /** Cost units still available across every live request. */
    readonly costRemaining: number
    /** Live requests whose absolute deadline has already passed at this instant. */
    readonly stale: number
  }
  /** The request furthest along, if any. A fact about the ledger, not a priority score. */
  readonly furthestStatus: RequestStatus | null
  /** Requests whose gates are all satisfied and which are awaiting the owner. */
  readonly awaitingOwner: readonly string[]
  /** Every gate kind any live request still has unsatisfied, counted. */
  readonly blockedOn: Readonly<Record<GateKind, number>>
  /** The domain grants nothing and activates nothing. Rendered rather than respected. */
  readonly activationAuthority: 'none'
  readonly trustClassFloor: TrustClass
}

/* -------------------------------------------------------------- utilities */

export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** A bounded code-owned slug: lower-case letters, digits, dashes. */
export function isAcquisitionSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value)
}

/** A bounded opaque reference id. */
export function isAcquisitionRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ACQUISITION_LIMITS.maxRefChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/**
 * Field names that would turn a description of a build into an instruction or a grant.
 *
 * Same refuse-not-ignore rule as every other domain in Core, and the same reason: a field
 * this domain silently drops today is a field somebody will read next month. Normalised and
 * affix-tolerant, so `grantsCapability`, `requiredCapability` and `installs` are one family.
 */
export const ACQUISITION_FORBIDDEN_FIELDS = Object.freeze([
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
  'activate',
  'activation',
  'register',
  'install',
  'enable',
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
  /**
   * `status` and `scope` are here rather than in the exact-key rule, and the distinction matters.
   *
   * A *stored* record legitimately carries `status` — that is how a lifecycle advance is
   * persisted — and a rebuild validator, not this list, is what checks it. On the way **in**,
   * though, `status: 'active'` is an attempt to hand a request a running lifecycle and `scope:
   * 'owner'` is an attempt to hand it authority, so both are refused by name and reported as the
   * laundering they are, instead of as a key-set mismatch that sounds like a typo.
   */
  'status',
  'scope',
] as const)

export function normaliseAcquisitionFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/about|for|toward|towards|to|the/g, '')
}

export function isForbiddenAcquisitionFieldName(name: string): boolean {
  const token = normaliseAcquisitionFieldName(name)
  for (const listed of ACQUISITION_FORBIDDEN_FIELDS) {
    const normalised = normaliseAcquisitionFieldName(listed)
    if (token === normalised) return true
    if (token.startsWith(normalised) || token.endsWith(normalised)) return true
  }
  return false
}

/** Bounded, non-empty text. */
export function isBoundedAcquisitionText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** The whole boundary as data, so a surface can render it. */
export const ACQUISITION_GRANTS_NOTHING = Object.freeze({
  grantsCapability: false as const,
  grantsAuthority: false as const,
  registersWithWork: false as const,
  admitsSkills: false as const,
  mayActivateItself: false as const,
  maySelfApprove: false as const,
  generatedStartsUntrusted: true as const,
  generatedStartsInactive: true as const,
  reason: 'generated capability is untrusted and inactive until an owner approves this activation',
})