/**
 * THE PROPOSAL LIFECYCLE, THE MERGE GATES, AND COST.
 *
 * A merge is a **conjunction over a closed list of eight gates**, and this file is where that
 * conjunction is evaluated. There is no second way to reach `merged`, no override, no emergency
 * path and no "skip the gates because the owner is in a hurry".
 *
 * ## Two of the eight the proposer cannot satisfy
 *
 * - **`owner-merge-approved`** is recorded by exactly one function, `recordOwnerMergeApproval`,
 *   whose `authority` is hard-set to `'owner'`. There is no parameter for it, so nothing — not a
 *   model, not Core, not the proposer — can produce a merge approval. The engine exposes no method
 *   that calls this without an owner principal.
 * - **`no-authority-widening`** and **`no-protected-surface`** are computed from the proposal's
 *   own declared requirements and targets. A proposal declaring a forbidden one was already
 *   refused at construction, so these gates are a second, independent check rather than the only
 *   one: if the construction rule were ever weakened, these would still refuse.
 *
 * ## The gate that is Phase 30's own idea
 *
 * **`rollback-verified`**. A change that has never been rolled back on demand cannot be merged,
 * however many tests it passed. The reason is narrow and worth stating: a rollback discovered to
 * be impossible *during* an incident is not a rollback, it is a post-mortem. So the rehearsal
 * happens while the change is still staged, and its cost is charged.
 *
 * ## A gate verdict is never replaced, only appended
 *
 * `recordImprovementGate` appends. `latestLedgerGateRecords` reads the newest record per kind, so
 * a later failure overrides an earlier pass — the correct instinct for a security gate. A gate
 * that passed once and fails later is a gate that fails.
 *
 * ## `not-applicable` is not a way out
 *
 * `decideMerge` counts only `passed` as satisfied. A `not-applicable` verdict is reported as
 * unsatisfied with its own reason, because a gate quietly marked not-applicable by whoever is
 * being evaluated is exactly the loophole this file closes.
 */

import { hasExactKeys } from '../hands/validation'
import {
  DERIVED_IMPROVEMENT_GATE_KINDS,
  DERIVED_IMPROVEMENT_GATE_REASON_BY_VERDICT,
  FORBIDDEN_IMPROVEMENTS,
  IMPROVEMENT_COST_UNITS,
  IMPROVEMENT_GATE_KINDS,
  IMPROVEMENT_GATE_PENDING_REASON_BY_KIND,
  IMPROVEMENT_GATE_REASONS,
  IMPROVEMENT_GATE_REASONS_BY_KIND,
  IMPROVEMENT_GATE_REASONS_BY_VERDICT,
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_RETENTION,
  IMPROVEMENT_TRANSITIONS,
  LEDGER_IMPROVEMENT_GATE_KINDS,
  instantMs,
  isBoundedImprovementText,
  isDerivedImprovementGateKind,
  isForbiddenImprovementFieldName,
  isImprovementGateKind,
  isImprovementGateVerdict,
  isImprovementRef,
  isLedgerImprovementGateKind,
  isProtectedImprovementSurface,
  type DerivedImprovementGateKind,
  type ImprovementClosedReason,
  type ImprovementGateAuthority,
  type ImprovementGateKind,
  type ImprovementGateReason,
  type ImprovementGateRecord,
  type ImprovementGateVerdict,
  type ImprovementPrecedence,
  type ImprovementProposal,
  type ImprovementStatus,
  type LedgerImprovementGateKind,
  type MergeDecision,
} from './types'

export type GateOutcome =
  | { readonly ok: true; readonly record: ImprovementGateRecord }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** The only fields a gate record may be built from. Exact, before anything else. */
export const IMPROVEMENT_GATE_INPUT_KEYS: readonly string[] = [
  'kind',
  'verdict',
  'reason',
  'verifier',
  'evidenceRefs',
]

/** The gates a verifier, Core or the evaluator may report on. */
export const RECORDABLE_IMPROVEMENT_GATES: readonly LedgerImprovementGateKind[] =
  LEDGER_IMPROVEMENT_GATE_KINDS

/**
 * Record a gate record produced by a verifier or by Core's own bookkeeping.
 *
 * Six refusals, each closing a specific route to a landed change:
 *
 * 1. a forbidden field name — before the exact-key check, so a payload smuggling `applyCode` is
 *    refused as such rather than as a key mismatch;
 * 2. `owner-merge-approved` from anything but the owner — the single most important line here;
 * 3. a derived gate — those are computed from the proposal, never asserted;
 * 4. the `gate` authority on a ledger gate — the evaluator may not be the evidence;
 * 5. a missing `verifier` on a ledger gate — "tests passed" with nothing behind it is an assertion
 *    in a gate's clothes;
 * 6. a reason that belongs to another gate, or that disagrees with the verdict about which way the
 *    gate went.
 */
export function recordImprovementGate(
  input: unknown,
  authority: 'verifier' | 'core' | 'gate',
  recordedAt: string,
): GateOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'not-an-object', reason: 'a gate record must be an object' }
  }
  const value = input as Record<string, unknown>
  const forbidden = Object.keys(value).filter((name) => isForbiddenImprovementFieldName(name))
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden-field-refused',
      reason: `a gate record carries field(s) a verdict may not hold: [${forbidden.join(', ')}]`,
    }
  }
  if (!hasExactKeys(value, IMPROVEMENT_GATE_INPUT_KEYS)) {
    const actual = Object.keys(value).sort()
    const expected = [...IMPROVEMENT_GATE_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `a gate record carries exactly [${expected.join(', ')}] and nothing else, got [${actual.join(', ')}]`,
    }
  }
  if (!isImprovementGateKind(value.kind)) {
    return { ok: false, code: 'invalid-gate-kind', reason: 'kind is not in the closed gate vocabulary' }
  }
  const kind = value.kind
  if (!isImprovementGateVerdict(value.verdict)) {
    return { ok: false, code: 'invalid-gate-verdict', reason: 'verdict is not in the closed vocabulary' }
  }
  const verdict = value.verdict
  if (
    typeof value.reason !== 'string' ||
    !(IMPROVEMENT_GATE_REASONS as readonly string[]).includes(value.reason)
  ) {
    return { ok: false, code: 'invalid-gate-reason', reason: 'reason is not a closed gate label' }
  }
  const reason = value.reason as ImprovementGateReason
  if (!IMPROVEMENT_GATE_REASONS_BY_KIND[kind].includes(reason)) {
    return {
      ok: false,
      code: 'invalid-gate-reason',
      reason: `${reason} is not a reason the ${kind} gate can carry`,
    }
  }
  if (!IMPROVEMENT_GATE_REASONS_BY_VERDICT[verdict].includes(reason)) {
    return {
      ok: false,
      code: 'invalid-gate-reason',
      reason: `${reason} does not agree with a verdict of ${verdict}`,
    }
  }
  if (instantMs(recordedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the gate instant must parse as an instant' }
  }
  // Stated as an outright refusal rather than an authority comparison, because `authority` cannot
  // be the owner here: this function is typed without it.
  if (kind === 'owner-merge-approved') {
    return {
      ok: false,
      code: 'not-owner',
      reason:
        'the owner-merge-approved gate is recorded by recordOwnerMergeApproval alone, and only from the owner scope',
    }
  }
  if (isDerivedImprovementGateKind(kind)) {
    return {
      ok: false,
      code: 'gate-may-not-be-self-reported',
      reason: `${kind} is computed from the proposal at decision time and may never be asserted by hand`,
    }
  }
  const ledgerKind = kind as LedgerImprovementGateKind
  const evidenceRefs = value.evidenceRefs
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length > IMPROVEMENT_LIMITS.maxEvidenceRefs ||
    !evidenceRefs.every((ref) => isImprovementRef(ref))
  ) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'evidenceRefs must be bounded opaque ids: a verdict rests on something that was observed',
    }
  }
  if (authority === 'gate') {
    return {
      ok: false,
      code: 'gate-may-not-be-self-reported',
      reason: `the gate evaluator may not report ${ledgerKind}; evidence must come from a named verifier`,
    }
  }
  if (!isBoundedImprovementText(value.verifier, IMPROVEMENT_LIMITS.maxVerifierChars)) {
    return {
      ok: false,
      code: 'missing-verifier',
      reason: `the ${ledgerKind} gate must name who produced it; an unnamed verdict is not evidence`,
    }
  }
  if (evidenceRefs.length === 0) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: `the ${ledgerKind} gate must cite at least one thing that was checked`,
    }
  }
  return {
    ok: true,
    record: Object.freeze({
      kind,
      verdict,
      reason,
      authority,
      verifier: value.verifier as string,
      evidenceRefs: Object.freeze([...(evidenceRefs as readonly string[])]),
      recordedAt,
    }),
  }
}

/**
 * Record the owner's approval or refusal of a merge.
 *
 * The `authority` is hard-set and there is no way to pass one. This is the only function in the
 * domain that can produce an `owner-merge-approved` verdict, and the only route into it from
 * outside is `ImprovementEngine.ownerScope`, which issues a scope to the owner principal and to
 * nothing else.
 *
 * The verdict names the owner as its verifier and carries no evidence reference, because an
 * approval is a decision and not a check — and a check-shaped owner gate would invite exactly the
 * reading that some verifier had cleared it.
 */
export function recordOwnerMergeApproval(
  approved: boolean,
  recordedAt: string,
): GateOutcome {
  if (instantMs(recordedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the decision instant must parse as an instant' }
  }
  return {
    ok: true,
    record: Object.freeze({
      kind: 'owner-merge-approved' as ImprovementGateKind,
      verdict: approved ? ('passed' as ImprovementGateVerdict) : ('failed' as ImprovementGateVerdict),
      reason: approved ? 'owner-approved-this-merge' : 'owner-declined',
      authority: 'owner' as ImprovementGateAuthority,
      verifier: 'owner',
      evidenceRefs: Object.freeze([]),
      recordedAt,
    }),
  }
}

/**
 * Evaluate the gates that are a function of the proposal itself.
 *
 * Returns the records a caller would otherwise have to compute by hand, and computes them **from
 * the proposal**, not from anything the caller passes in. `no-protected-surface` is recomputed
 * here and not only at construction, so a proposal whose record was hand-edited afterwards still
 * meets a gate about its own targets.
 */
export function evaluateDerivedGates(
  proposal: ImprovementProposal,
  recordedAt: string,
): readonly ImprovementGateRecord[] {
  const touched = proposal.targets.find((target) => isProtectedImprovementSurface(target))
  const forbidden = proposal.requirements.filter((item) =>
    (FORBIDDEN_IMPROVEMENTS as readonly string[]).includes(item),
  )
  return Object.freeze([
    derived('no-protected-surface', touched === undefined, recordedAt),
    derived('no-authority-widening', forbidden.length === 0, recordedAt),
  ])
}

function derived(
  kind: DerivedImprovementGateKind,
  passed: boolean,
  recordedAt: string,
): ImprovementGateRecord {
  return Object.freeze({
    kind,
    verdict: passed ? ('passed' as ImprovementGateVerdict) : ('failed' as ImprovementGateVerdict),
    reason: DERIVED_IMPROVEMENT_GATE_REASON_BY_VERDICT[kind][passed ? 'passed' : 'failed'],
    // `gate` is the evaluator's own arithmetic, which is why `recordImprovementGate` refuses this
    // authority for ledger gates and why these two are never read from a ledger.
    authority: 'gate' as ImprovementGateAuthority,
    // Null, not empty string: a computed gate has no named producer because nothing produced it.
    verifier: null,
    evidenceRefs: Object.freeze([]),
    recordedAt,
  })
}

/** The newest record per gate kind, over whatever it is handed. */
export function latestGateRecords(
  ledger: readonly ImprovementGateRecord[],
): Readonly<Record<string, ImprovementGateRecord>> {
  const latest: Record<string, ImprovementGateRecord> = {}
  for (const record of ledger) latest[record.kind] = record
  return Object.freeze(latest)
}

/**
 * The newest record per **ledger** gate kind.
 *
 * Derived kinds are dropped by construction. A ledger entry naming one is ignored rather than
 * honoured, so a hand-written row cannot supply the widest possible answer to a gate the
 * proposal itself answers.
 */
export function latestLedgerGateRecords(
  ledger: readonly ImprovementGateRecord[],
): Readonly<Record<LedgerImprovementGateKind, ImprovementGateRecord>> {
  const latest: Partial<Record<LedgerImprovementGateKind, ImprovementGateRecord>> = {}
  for (const record of ledger) {
    if (!isLedgerImprovementGateKind(record.kind)) continue
    latest[record.kind] = record
  }
  return Object.freeze(latest as Record<LedgerImprovementGateKind, ImprovementGateRecord>)
}

/** Every gate kind that is not currently `passed`. Derived gates included. */
export function unsatisfiedImprovementGates(
  proposal: ImprovementProposal,
  ledger: readonly ImprovementGateRecord[],
  recordedAt: string,
): readonly ImprovementGateKind[] {
  const latest = latestLedgerGateRecords(ledger)
  const records = Object.freeze([
    ...evaluateDerivedGates(proposal, recordedAt),
    ...LEDGER_IMPROVEMENT_GATE_KINDS.map((kind) => latest[kind] ?? pendingGate(kind, recordedAt)),
  ])
  return Object.freeze(records.filter((gate) => gate.verdict !== 'passed').map((gate) => gate.kind))
}

function pendingGate(
  kind: LedgerImprovementGateKind,
  recordedAt: string,
): ImprovementGateRecord {
  return Object.freeze({
    kind,
    verdict: 'pending' as ImprovementGateVerdict,
    reason: IMPROVEMENT_GATE_PENDING_REASON_BY_KIND[kind],
    authority: 'gate' as ImprovementGateAuthority,
    verifier: null,
    evidenceRefs: Object.freeze([]),
    recordedAt,
  })
}

/**
 * Decide a merge.
 *
 * `approved` is `true` only when **every** gate in `IMPROVEMENT_GATE_KINDS` reads `passed`. There
 * is no partial approval, no "approved except the tests" and no path where a missing gate is
 * treated as a pass.
 *
 * `precedence` is carried rather than assumed: a decision taken while a stop was latched, or
 * while the journal could not be believed, is not a gate failure, and a reader who saw only
 * "refused" would reasonably assume the domain rule was what stopped it.
 */
export function decideMerge(
  proposal: ImprovementProposal,
  ledger: readonly ImprovementGateRecord[],
  decidedAt: string,
  precedence: ImprovementPrecedence | null = null,
): MergeDecision {
  const latest = latestLedgerGateRecords(ledger)
  const gates = Object.freeze([
    ...evaluateDerivedGates(proposal, decidedAt),
    ...LEDGER_IMPROVEMENT_GATE_KINDS.map((kind) => latest[kind] ?? pendingGate(kind, decidedAt)),
  ])
  const unsatisfied = Object.freeze(
    gates.filter((gate) => gate.verdict !== 'passed').map((gate) => gate.kind),
  )
  const ownerApproved = latest['owner-merge-approved']?.verdict === 'passed'
  return Object.freeze({
    proposalId: proposal.proposalId,
    approved: unsatisfied.length === 0,
    gates,
    unsatisfied,
    decidedAt,
    ownerApproved,
    precedence,
  })
}

/**
 * Build a closure reason from a decision.
 *
 * The owner first, and only when the owner actually *declined* — an unanswered owner gate is
 * pending, and reporting that as a refusal would put a decision nobody made into the ledger.
 * Then the specific failures in the order they matter, then a general one.
 */
export function reasonForMergeDecision(decision: MergeDecision): ImprovementClosedReason | null {
  if (decision.approved) return null
  const owner = decision.gates.find((gate) => gate.kind === 'owner-merge-approved')
  // Only a recorded decline is a decision. An unanswered owner gate is pending, and reporting
  // that as a refusal would put a decision nobody made into the ledger.
  if (owner !== undefined && owner.verdict === 'failed') return 'owner-rejected-this-proposal'
  // A recorded failure is a decision somebody made, so those come before the gates that are merely
  // unanswered: "the tests failed" is more informative than "the rehearsal has not happened".
  const tests = decision.gates.find((gate) => gate.kind === 'tests-passed')
  if (tests !== undefined && tests.verdict === 'failed') return 'tests-failed'
  const redTeam = decision.gates.find((gate) => gate.kind === 'red-team-clean')
  if (redTeam !== undefined && redTeam.verdict === 'failed') return 'red-team-found-something'
  const review = decision.gates.find((gate) => gate.kind === 'review-recorded')
  if (review !== undefined && review.verdict === 'failed') return 'review-rejected-the-change'
  const rollback = decision.gates.find((gate) => gate.kind === 'rollback-verified')
  // An unrehearsed rollback is unverified whether it failed or was never run: the reason names
  // the missing proof rather than asserting a failure that may not have happened.
  if (rollback !== undefined && rollback.verdict !== 'passed') return 'rollback-unverified-so-refused'
  // Something is unsatisfied and none of the specific reasons applies. Named rather than mapped
  // onto an owner's decision, because attributing it to the owner would be a fabrication.
  return 'gates-not-satisfied'
}

/** Whether every gate is currently satisfied for this proposal at this instant. */
export function everyGateSatisfied(
  proposal: ImprovementProposal,
  ledger: readonly ImprovementGateRecord[],
  recordedAt: string,
): boolean {
  return unsatisfiedImprovementGates(proposal, ledger, recordedAt).length === 0
}

/** An owner verdict, rebuilt through the one function that can produce one. */
function rebuildOwnerGate(
  record: Record<string, unknown>,
  recordedAt: string,
): GateOutcome {
  const rebuilt = recordOwnerMergeApproval(record.verdict === 'passed', recordedAt)
  if (!rebuilt.ok) {
    return { ok: false, code: 'invalid-gate-verdict', reason: 'a stored owner approval carries an unreadable verdict' }
  }
  // The stored reason is re-derived rather than believed, so a hand-edited row cannot turn a
  // declined merge into an approved one by editing its label.
  if (record.reason !== rebuilt.record.reason) {
    return { ok: false, code: 'invalid-gate-reason', reason: 'a stored owner approval carries another reason' }
  }
  return rebuilt
}

/**
 * Whether a stored ledger gate record is well formed, re-run on read.
 *
 * The store validates every row, so a hand-edited or half-written ledger degrades the store
 * rather than being folded as though it were the truth. Construction-time refusals are re-run
 * here — including the kind/reason/verdict agreements — because a ledger row does not pass
 * through `recordImprovementGate` when it arrives from disk.
 */
export function validateImprovementGate(
  value: unknown,
): { ok: true; record: ImprovementGateRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a gate record is not an object' }
  }
  const record = value as Record<string, unknown>
  const expected = ['kind', 'verdict', 'reason', 'authority', 'verifier', 'evidenceRefs', 'recordedAt']
  if (!hasExactKeys(record, expected)) {
    return { ok: false, reason: 'a stored gate record does not carry exactly the ledger fields' }
  }
  if (!isImprovementGateKind(record.kind)) return { ok: false, reason: 'a stored gate record names an unknown gate' }
  if (!isLedgerImprovementGateKind(record.kind)) {
    return { ok: false, reason: 'a stored ledger carries a gate that is derived from the proposal' }
  }
  if (
    record.authority !== 'owner' &&
    record.authority !== 'verifier' &&
    record.authority !== 'core' &&
    record.authority !== 'gate'
  ) {
    return { ok: false, reason: 'a stored gate record names an unknown authority' }
  }
  const recordedAt = typeof record.recordedAt === 'string' ? record.recordedAt : ''
  if (record.kind === 'owner-merge-approved') {
    if (record.authority !== 'owner') {
      return { ok: false, reason: 'a stored owner approval does not name the owner as its authority' }
    }
    if (record.verifier !== 'owner') {
      return { ok: false, reason: 'a stored owner approval is not attributed to the owner' }
    }
    if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length !== 0) {
      return { ok: false, reason: 'an owner approval is a decision and carries no evidence references' }
    }
    return rebuildOwnerGate(record, recordedAt)
  }
  if (record.authority === 'owner') {
    return { ok: false, reason: 'only the owner-merge-approved gate may carry the owner authority' }
  }
  const rebuilt = recordImprovementGate(
    {
      kind: record.kind,
      verdict: record.verdict,
      reason: record.reason,
      verifier: record.verifier,
      evidenceRefs: record.evidenceRefs,
    },
    record.authority as 'verifier' | 'core' | 'gate',
    recordedAt,
  )
  if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
  return { ok: true, record: rebuilt.record }
}

/**
 * One gate as a **decision** carries it.
 *
 * Different from a stored ledger entry, and deliberately: a decision legitimately holds all eight
 * gates, including the two computed ones, because its job is to show the whole conjunction at the
 * instant it was taken. What is checked here is therefore stricter in one direction and looser in
 * another — a computed gate must be exactly what the evaluator computes (right reason for its
 * verdict, `gate` authority, no verifier, no evidence), and a ledger gate must still be well
 * formed under `validateImprovementGate`.
 */
export function validateDecisionGate(
  value: unknown,
): { ok: true; record: ImprovementGateRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a decision gate is not an object' }
  }
  const gate = value as Record<string, unknown>
  if (!isImprovementGateKind(gate.kind)) return { ok: false, reason: 'a decision names an unknown gate' }
  if (isLedgerImprovementGateKind(gate.kind)) {
    // A `pending` gate in a decision is a placeholder for "nobody has answered this yet", not a
    // verdict anybody recorded — so it is checked against the pending table rather than through
    // the ledger validator, which rightly refuses an evaluator reporting its own evidence.
    if (gate.verdict === 'pending') return pendingDecisionGate(gate)
    return validateImprovementGate(gate)
  }
  const verdict = gate.verdict
  if (verdict !== 'passed' && verdict !== 'failed') {
    return { ok: false, reason: 'a computed gate is either passed or failed, never pending' }
  }
  const kind = gate.kind as DerivedImprovementGateKind
  const expected = DERIVED_IMPROVEMENT_GATE_REASON_BY_VERDICT[kind]?.[verdict]
  if (gate.reason !== expected) {
    return { ok: false, reason: 'a decision carries a computed gate with another reason' }
  }
  if (
    gate.authority !== 'gate' ||
    gate.verifier !== null ||
    !Array.isArray(gate.evidenceRefs) ||
    gate.evidenceRefs.length !== 0
  ) {
    return { ok: false, reason: 'a computed gate may name no producer and no evidence' }
  }
  if (instantMs(gate.recordedAt) === null) {
    return { ok: false, reason: 'a decision gate has an unreadable instant' }
  }
  return { ok: true, record: derived(kind, verdict === 'passed', gate.recordedAt as string) }
}

/** A placeholder gate: owed, unanswered, produced by nobody. */
function pendingDecisionGate(
  gate: Record<string, unknown>,
): { ok: true; record: ImprovementGateRecord } | { ok: false; reason: string } {
  const kind = gate.kind as LedgerImprovementGateKind
  if (gate.reason !== IMPROVEMENT_GATE_PENDING_REASON_BY_KIND[kind]) {
    return { ok: false, reason: 'a pending gate carries another pending reason' }
  }
  if (
    gate.authority !== 'gate' ||
    gate.verifier !== null ||
    !Array.isArray(gate.evidenceRefs) ||
    gate.evidenceRefs.length !== 0
  ) {
    return { ok: false, reason: 'a pending gate may name no producer and no evidence' }
  }
  if (instantMs(gate.recordedAt) === null) {
    return { ok: false, reason: 'a decision gate has an unreadable instant' }
  }
  return { ok: true, record: pendingGate(kind, gate.recordedAt as string) }
}

/* ---------------------------------------------------------------- lifecycle */

/** Whether a proposal has outlived its deadline at this instant. A fact, not a decision. */
export function isStaleProposal(proposal: ImprovementProposal, now: string): boolean {
  const at = instantMs(now)
  const deadline = instantMs(proposal.expiresAt)
  if (at === null || deadline === null) return false
  return at > deadline
}

/** Whether a merge has outlived its own, longer deadline at this instant. */
export function isMergeStale(proposal: ImprovementProposal, now: string): boolean {
  if (proposal.mergedExpiresAt === null) return false
  const at = instantMs(now)
  const deadline = instantMs(proposal.mergedExpiresAt)
  if (at === null || deadline === null) return false
  return at >= deadline
}

/**
 * Staleness as a refusal rather than a boolean.
 *
 * Returned in the refusal shape so the caller reports the *same* thing whether it was refused by
 * the transition table or by the clock, and so the deadline is checked in exactly one place.
 */
function stalenessRefusal(
  proposal: ImprovementProposal,
  now: string,
): { readonly ok: false; readonly code: string; readonly reason: string } | null {
  const at = instantMs(now)
  const deadline = instantMs(proposal.expiresAt)
  if (at === null || deadline === null) return null
  if (at <= deadline) return null
  return {
    ok: false,
    code: 'illegal-transition',
    reason: `this proposal expired at ${proposal.expiresAt}; a stale proposal is closed, not advanced`,
  }
}

/**
 * Advance a proposal, checking the closed transition table.
 *
 * Two rules beyond the table, and both are load-bearing:
 *
 * - **A stale proposal may not be advanced at any stage.** It has to be closed through
 *   `expireStaleImprovement`, which is the only route out. A proposal whose evidence has expired
 *   must not still be able to reach `merged`.
 * - **Only a `merged` proposal may carry a merge instant, and only a `reviewed` one may carry a
 *   revision to restore.** Both are assigned by the engine, not by a parameter, because a
 *   rollback that invented its own target revision would be a rollback to nowhere.
 */
export function advanceImprovement(
  proposal: ImprovementProposal,
  decision: { now: string; to: ImprovementStatus; restoresRevision?: string },
): { readonly ok: true; readonly value: ImprovementProposal } | { readonly ok: false; readonly code: string; readonly reason: string } {
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the decision instant must parse as an instant' }
  }
  if (proposal.status === decision.to) {
    return { ok: false, code: 'illegal-transition', reason: `the proposal is already ${decision.to}` }
  }
  if (!IMPROVEMENT_TRANSITIONS[proposal.status].includes(decision.to)) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `a ${proposal.status} proposal cannot become ${decision.to}`,
    }
  }
  if (decision.to === 'staged' && decision.restoresRevision !== undefined) {
    if (!isImprovementRef(decision.restoresRevision)) {
      return {
        ok: false,
        code: 'invalid-id',
        reason: 'restoresRevision must be a bounded opaque revision id',
      }
    }
  }
  if (decision.to === 'rolled-back') {
    // Refused outright rather than accepted: a rollback is the one transition with a precondition
    // of its own — a recorded revision to restore — and `rollBackImprovement` is the only place
    // that precondition is enforced. Letting the table do it too would mean two routes to the same
    // status, one of which forgets the check.
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'a rollback is reached through rollBackImprovement, which checks that a revision was recorded',
    }
  }
  const stale = stalenessRefusal(proposal, decision.now)
  if (stale !== null) return stale
  if (decision.to !== 'staged' && decision.to !== 'merged' && proposal.status === 'merged') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'a merged proposal can only be rolled back; it is never re-staged or re-merged',
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...proposal,
      status: decision.to,
      // A merge records its own instant and the deadline it expires at, both derived from the
      // code-owned retention table rather than accepted from anywhere.
      mergedAt: decision.to === 'merged' ? decision.now : proposal.mergedAt,
      mergedExpiresAt:
        decision.to === 'merged'
          ? new Date(
              (instantMs(decision.now) as number) + IMPROVEMENT_RETENTION.maxMergedLifetimeMs,
            ).toISOString()
          : proposal.mergedExpiresAt,
      restoresRevision:
        decision.to === 'staged' && decision.restoresRevision !== undefined
          ? decision.restoresRevision
          : proposal.restoresRevision,
      closedAt: null,
      closedReason: null,
    }),
  }
}

/**
 * Roll a change back.
 *
 * The one route to `rolled-back`, and reachable from `staging` all the way through `merged`
 * because a rollback that cannot undo a landed change is a promise rather than a mechanism.
 *
 * Refuses when no revision was recorded, which is the honest answer: a rollback with no recorded
 * target restores nothing, and recording one at rollback time — "roll back to whatever was there"
 * — is precisely the rollback that cannot be relied on under pressure.
 */
export function rollBackImprovement(
  proposal: ImprovementProposal,
  decision: { now: string },
): { readonly ok: true; readonly value: ImprovementProposal } | { readonly ok: false; readonly code: string; readonly reason: string } {
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the rollback instant must parse as an instant' }
  }
  if (!IMPROVEMENT_TRANSITIONS[proposal.status].includes('rolled-back')) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `a ${proposal.status} proposal cannot be rolled back`,
    }
  }
  if (proposal.restoresRevision === null) {
    return {
      ok: false,
      code: 'nothing-to-roll-back',
      reason: 'no revision was recorded at staging, so there is nothing this rollback could restore',
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...proposal,
      status: 'rolled-back' as ImprovementStatus,
      // The merge's own deadline goes with it: a rolled-back change is not standing, so it is not
      // awaiting review either.
      mergedExpiresAt: null,
      closedAt: decision.now,
      closedReason: 'rollback-completed' as ImprovementClosedReason,
    }),
  }
}

/**
 * Close a proposal that outlived its deadline.
 *
 * Refused before the deadline, and refused for a `merged` proposal, which has its own and
 * different deadline. Keeping the two apart is the point: "the proposal went stale" and "the
 * change has been standing too long" are different facts and get different closure reasons.
 */
export function expireStaleImprovement(
  proposal: ImprovementProposal,
  decision: { now: string },
): { readonly ok: true; readonly value: ImprovementProposal } | { readonly ok: false; readonly code: string; readonly reason: string } {
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the expiry instant must parse as an instant' }
  }
  if (proposal.status === 'merged') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: 'a merged proposal expires through its own deadline, not its own proposal lifetime',
    }
  }
  if (!isStaleProposal(proposal, decision.now)) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `this proposal is not stale until ${proposal.expiresAt}`,
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...proposal,
      status: 'expired' as ImprovementStatus,
      closedAt: decision.now,
      closedReason: 'aged-out-past-retention' as ImprovementClosedReason,
    }),
  }
}

/**
 * Close a merge whose own deadline has passed.
 *
 * `aged-out-past-retention` rather than a merge-specific reason, because what expired is the
 * *approval to keep this change standing*: the change may be perfectly good and simply needs a
 * second, dated decision. The proposal becomes terminal, so continuing to rely on the change
 * requires a new proposal rather than a quiet re-approval.
 */
export function expireStaleMerge(
  proposal: ImprovementProposal,
  decision: { now: string },
): { readonly ok: true; readonly value: ImprovementProposal } | { readonly ok: false; readonly code: string; readonly reason: string } {
  if (proposal.status !== 'merged') {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `only a merged proposal has a merge deadline, and this one is ${proposal.status}`,
    }
  }
  if (!isMergeStale(proposal, decision.now)) {
    return {
      ok: false,
      code: 'illegal-transition',
      reason: `this change stands until ${proposal.mergedExpiresAt}`,
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...proposal,
      status: 'expired' as ImprovementStatus,
      closedAt: decision.now,
      closedReason: 'aged-out-past-retention' as ImprovementClosedReason,
    }),
  }
}

/* ------------------------------------------------------------------- cost */

/**
 * Charge cost against a proposal.
 *
 * Four properties, and all of them are the anti-hidden-loop mechanism:
 *
 * - the charge is **refused at the ceiling** rather than allowed to overshoot and be noticed
 *   later, so a loop that keeps going simply stops;
 * - a terminal proposal cannot be charged at all, so a rejected change cannot keep billing;
 * - there is no `spendForever`, no retry budget and no background flag anywhere in this domain;
 * - the units are code-owned and mean nothing to any provider, so a ceiling cannot be read as
 *   permission to spend money.
 */
export function chargeImprovementCost(
  proposal: ImprovementProposal,
  units: number,
): { readonly ok: true; readonly value: ImprovementProposal } | { readonly ok: false; readonly code: string; readonly reason: string } {
  if (!Number.isInteger(units) || units < 1 || units > IMPROVEMENT_LIMITS.maxCostUnits) {
    return {
      ok: false,
      code: 'invalid-id',
      reason: 'cost units must be a positive whole number within the domain bound',
    }
  }
  if (proposal.status === 'rejected' || proposal.status === 'expired' || proposal.status === 'rolled-back') {
    return {
      ok: false,
      code: 'already-terminal',
      reason: `a ${proposal.status} proposal cannot be charged; the work it paid for is over`,
    }
  }
  const spent = proposal.costSpent + units
  if (spent > proposal.costCeiling) {
    return {
      ok: false,
      code: 'budget-exhausted',
      reason: `charging ${units} unit(s) would exceed the ceiling of ${proposal.costCeiling}; the loop stops here`,
    }
  }
  return { ok: true, value: Object.freeze({ ...proposal, costSpent: spent }) }
}

/** The stage, test, review, rehearsal and merge prices, re-exported for one import. */
export { IMPROVEMENT_COST_UNITS, DERIVED_IMPROVEMENT_GATE_KINDS, IMPROVEMENT_GATE_KINDS }