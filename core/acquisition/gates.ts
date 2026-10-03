/**
 * THE GATE LEDGER — the whole of Phase 29's authority surface.
 *
 * An activation is a **conjunction over a closed list of gates**, and this file is where that
 * conjunction is evaluated. There is no second way to become `active`, no override, no
 * emergency path and no "skip the gates because the owner is in a hurry".
 *
 * ## Two of the seven gates the requester cannot satisfy
 *
 * - **`owner-approval`** is recorded by exactly one function, `recordOwnerApproval`, and its
 *   `authority` is hard-set to `'owner'`. There is no parameter for it, so nothing — not a
 *   model, not Core, not the requester — can produce an owner approval. The engine exposes no
 *   method that calls this without an owner principal.
 * - **`no-capability-widening`** is computed from the request's own declared requirements
 *   against `FORBIDDEN_REQUIREMENTS`. A request that declared one was already refused at
 *   construction, so this gate is a second, independent check rather than the only one: if the
 *   construction rule were ever weakened, this would still refuse.
 *
 * ## Three of the seven may never be asserted at all
 *
 * `no-protected-target`, `no-capability-widening` and `budget-within-limit` are
 * `DERIVED_GATE_KINDS`: they are functions of the request. `recordGateVerdict` refuses them by
 * name, so nobody can hand-write "spend stayed within the bound" for a request that spent too
 * much, and `decideActivation` recomputes them from the request on every call rather than
 * reading them from the ledger. That is why a hand-edited store row cannot widen a decision:
 * the widest thing it can do is lie about a gate the decision never reads.
 *
 * ## A gate verdict is never replaced, only appended
 *
 * `recordGateVerdict` appends to the request's ledger. `latestGateVerdicts` reads the newest
 * verdict per kind, so a later failure overrides an earlier pass — the opposite of the usual
 * instinct, and the correct one for a security gate. A gate that passed once and fails later
 * is a gate that fails.
 *
 * ## `not-applicable` is not a way out
 *
 * `decideActivation` counts only `passed` as satisfied. A `not-applicable` verdict is reported
 * as unsatisfied with its own reason, because a gate quietly marked not-applicable by whoever
 * is being evaluated is exactly the loophole this file closes.
 *
 * ## Evidence must name who produced it
 *
 * An evidence gate (`verification-passed`, `tests-passed`, `red-team-clean`) requires a
 * non-empty bounded `verifier` and at least one evidence reference, and the `gate` authority
 * may not record one at all: the evaluator of a gate cannot also be its evidence. A verdict
 * with no name behind it is treated as unsatisfied rather than assumed.
 */

import { hasExactKeys } from '../hands/validation'
import {
  ACQUISITION_LIMITS,
  DERIVED_GATE_KINDS,
  DERIVED_GATE_REASON_BY_VERDICT,
  FORBIDDEN_REQUIREMENTS,
  GATE_PENDING_REASON_BY_KIND,
  GATE_REASONS,
  GATE_REASONS_BY_KIND,
  GATE_REASONS_BY_VERDICT,
  LEDGER_GATE_KINDS,
  instantMs,
  isAcquisitionRef,
  isBoundedAcquisitionText,
  isForbiddenAcquisitionFieldName,
  isGateKind,
  isGateVerdict,
  isLedgerGateKind,
  isProtectedTarget,
  isRequestLifecycleConsistent,
  type AcquisitionPrecedence,
  type AcquisitionRequest,
  type ActivationDecision,
  type DerivedGateKind,
  type GateAuthority,
  type GateKind,
  type GateReason,
  type GateVerdict,
  type GateVerdictRecord,
  type LedgerGateKind,
  type RequestLifecycleReason,
} from './types'

export type GateResult =
  | { readonly ok: true; readonly verdict: GateVerdictRecord }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** The only fields a gate verdict may be built from. Exact, before anything else. */
export const GATE_VERDICT_INPUT_KEYS: readonly string[] = ['kind', 'verdict', 'reason', 'verifier', 'evidenceRefs']

/** The gates a verifier, Core or the evaluator may report on. */
export const RECORDABLE_GATE_KINDS: readonly LedgerGateKind[] = LEDGER_GATE_KINDS

/**
 * Record a gate verdict produced by a verifier or by Core's own bookkeeping.
 *
 * Six refusals, and each one closes a specific route to an activated capability:
 *
 * 1. a forbidden field name — before the exact-key check, so a payload smuggling
 *    `grantsCapability` is refused as such rather than as a key mismatch;
 * 2. `owner-approval` from anything but the owner — the single most important line here;
 * 3. a derived gate — those are computed from the request, never asserted;
 * 4. the `gate` authority on an evidence gate — the evaluator may not be the evidence;
 * 5. a missing `verifier` on an evidence gate — "verified" without a name is not evidence;
 * 6. a reason that belongs to another kind, or that disagrees with the verdict about which way
 *    the gate went.
 */
export function recordGateVerdict(
  input: unknown,
  authority: 'verifier' | 'core' | 'gate',
  recordedAt: string,
): GateResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'not-an-object', reason: 'a gate verdict must be an object' }
  }
  const value = input as Record<string, unknown>
  const forbidden = Object.keys(value).filter((name) => isForbiddenAcquisitionFieldName(name))
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'forbidden-field-refused',
      reason: `a gate verdict carries field(s) a verdict may not hold: [${forbidden.join(', ')}]`,
    }
  }
  if (!hasExactKeys(value, GATE_VERDICT_INPUT_KEYS)) {
    const actual = Object.keys(value).sort()
    const expected = [...GATE_VERDICT_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `a gate verdict carries exactly [${expected.join(', ')}] and nothing else, got [${actual.join(', ')}]`,
    }
  }
  if (!isGateKind(value.kind)) {
    return { ok: false, code: 'invalid-gate-kind', reason: 'kind is not in the closed gate vocabulary' }
  }
  const kind = value.kind
  if (!isGateVerdict(value.verdict)) {
    return { ok: false, code: 'invalid-gate-verdict', reason: 'verdict is not in the closed vocabulary' }
  }
  const verdict = value.verdict
  if (typeof value.reason !== 'string' || !(GATE_REASONS as readonly string[]).includes(value.reason)) {
    return { ok: false, code: 'invalid-gate-reason', reason: 'reason is not a closed gate label' }
  }
  const reason = value.reason as GateReason
  if (!GATE_REASONS_BY_KIND[kind].includes(reason)) {
    return {
      ok: false,
      code: 'invalid-gate-reason',
      reason: `${reason} is not a reason the ${kind} gate can carry`,
    }
  }
  if (!GATE_REASONS_BY_VERDICT[verdict].includes(reason)) {
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
  // be the owner here: `recordGateVerdict` is typed without it. There is no version of this call
  // that records an approval, which is the point of splitting it from `recordOwnerApproval`.
  if (kind === 'owner-approval') {
    return {
      ok: false,
      code: 'not-owner',
      reason: 'the owner-approval gate is recorded by recordOwnerApproval alone, and only from the owner scope',
    }
  }
  if (isDerivedGateKindName(kind)) {
    return {
      ok: false,
      code: 'gate-may-not-be-self-reported',
      reason: `${kind} is computed from the request at decision time and may never be asserted by hand`,
    }
  }
  const ledgerKind = kind as LedgerGateKind
  const evidenceRefs = value.evidenceRefs
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length > ACQUISITION_LIMITS.maxEvidenceRefs ||
    !evidenceRefs.every((ref) => isAcquisitionRef(ref))
  ) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: 'evidenceRefs must be bounded opaque ids: a verdict rests on something that was observed',
    }
  }
  if (authority === 'gate' && ledgerKind !== 'owner-approval') {
    return {
      ok: false,
      code: 'gate-may-not-be-self-reported',
      reason: `the gate evaluator may not report ${ledgerKind}; evidence must come from a named verifier`,
    }
  }
  if (
    ledgerKind !== 'owner-approval' &&
    !isBoundedAcquisitionText(value.verifier, ACQUISITION_LIMITS.maxVerifierChars)
  ) {
    return {
      ok: false,
      code: 'missing-verifier',
      reason: `the ${ledgerKind} gate must name who produced it; an unnamed verdict is not evidence`,
    }
  }
  if (ledgerKind !== 'owner-approval' && evidenceRefs.length === 0) {
    return {
      ok: false,
      code: 'invalid-evidence-refs',
      reason: `the ${ledgerKind} gate must cite at least one thing that was checked`,
    }
  }
  if (ledgerKind === 'owner-approval' && (value.verifier !== null || evidenceRefs.length > 0)) {
    return {
      ok: false,
      code: 'not-owner',
      reason: 'an owner approval is a person deciding, not a check: it carries no verifier and no evidence refs',
    }
  }
  return {
    ok: true,
    verdict: Object.freeze({
      kind,
      verdict,
      reason,
      authority,
      // The owner is the verifier of their own approval and is named as such, so a ledger
      // read never has to special-case a null where a name belongs.
      verifier: ledgerKind === 'owner-approval' ? 'owner' : (value.verifier as string),
      evidenceRefs: Object.freeze([...(evidenceRefs as readonly string[])]),
      recordedAt,
    }),
  }
}

/**
 * Record the owner's approval or refusal.
 *
 * The `authority` is hard-set and there is no way to pass one. This is the only function in the
 * domain that can produce an `owner-approval` verdict, and the only route into it from outside
 * is `AcquisitionEngine.ownerScope`, which issues a scope to the owner principal and to nothing
 * else.
 *
 * The verdict names the owner as its verifier and carries no evidence reference, because an
 * approval is a decision and not a check — and a check-shaped owner gate would invite exactly
 * the reading that some verifier had cleared it.
 */
export function recordOwnerApproval(
  approved: boolean,
  recordedAt: string,
): GateResult {
  if (instantMs(recordedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'the decision instant must parse as an instant' }
  }
  return {
    ok: true,
    verdict: Object.freeze({
      kind: 'owner-approval' as GateKind,
      verdict: approved ? ('passed' as GateVerdict) : ('failed' as GateVerdict),
      reason: approved ? 'owner-approved-this-activation' : 'owner-declined',
      authority: 'owner' as GateAuthority,
      verifier: 'owner',
      evidenceRefs: Object.freeze([]),
      recordedAt,
    }),
  }
}

/**
 * Evaluate the gates that are a function of the request itself.
 *
 * Returns the verdicts a caller would otherwise have to compute by hand, and computes them
 * **from the request**, not from anything the caller passes in. `no-protected-target` is here
 * rather than only at construction, so a request whose record was hand-edited after the fact
 * still meets a gate about its own targets.
 */
export function evaluateSelfGates(
  request: AcquisitionRequest,
  recordedAt: string,
): readonly GateVerdictRecord[] {
  const protectedTarget = request.targets.find((target) => isProtectedTarget(target))
  const forbidden = request.requirements.filter((item) => isForbiddenRequirement(item))
  const overBudget = request.costSpent > request.costCeiling
  const verdicts: GateVerdictRecord[] = []
  verdicts.push(
    derived('no-protected-target', protectedTarget === undefined, recordedAt),
    derived('no-capability-widening', forbidden.length === 0, recordedAt),
    derived('budget-within-limit', !overBudget, recordedAt),
  )
  return Object.freeze(verdicts)
}

function derived(kind: DerivedGateKind, passed: boolean, recordedAt: string): GateVerdictRecord {
  const verdict: GateVerdict = passed ? 'passed' : 'failed'
  return Object.freeze({
    kind,
    verdict,
    reason: DERIVED_GATE_REASON_BY_VERDICT[kind][passed ? 'passed' : 'failed'],
    // `gate` is the evaluator's own arithmetic, which is why `recordGateVerdict` refuses this
    // authority for evidence gates and why these three are never read from a ledger.
    authority: 'gate' as GateAuthority,
    // Null, not empty string: a computed gate has no named producer because nothing produced
    // it. That is a different fact from a check that forgot to name itself.
    verifier: null,
    evidenceRefs: Object.freeze([]),
    recordedAt,
  })
}

function isForbiddenRequirement(value: string): boolean {
  return (FORBIDDEN_REQUIREMENTS as readonly string[]).includes(value)
}

function isDerivedGateKindName(kind: GateKind): kind is DerivedGateKind {
  return (DERIVED_GATE_KINDS as readonly string[]).includes(kind)
}

/**
 * The newest verdict per gate kind, over whatever it is handed.
 *
 * Newest wins, including newest *failing*. Deterministic on equal instants: a later entry in
 * the ledger wins, so the order a caller recorded in is the order that is read.
 */
export function latestGateVerdicts(
  ledger: readonly GateVerdictRecord[],
): Readonly<Record<string, GateVerdictRecord>> {
  const latest: Record<string, GateVerdictRecord> = {}
  for (const verdict of ledger) latest[verdict.kind] = verdict
  return Object.freeze(latest)
}

/**
 * The newest verdict per **ledger** gate kind.
 *
 * Derived kinds are dropped by construction. A ledger entry naming one is ignored rather than
 * honoured, so a hand-written row cannot supply the widest possible answer to a gate the
 * request itself answers.
 */
export function latestLedgerVerdicts(
  ledger: readonly GateVerdictRecord[],
): Readonly<Record<LedgerGateKind, GateVerdictRecord>> {
  const latest: Partial<Record<LedgerGateKind, GateVerdictRecord>> = {}
  for (const verdict of ledger) {
    if (!isLedgerGateKind(verdict.kind)) continue
    latest[verdict.kind] = verdict
  }
  return Object.freeze(latest as Record<LedgerGateKind, GateVerdictRecord>)
}

/** Every gate kind that is not currently `passed`. Derived gates included. */
export function unsatisfiedGates(
  request: AcquisitionRequest,
  ledger: readonly GateVerdictRecord[],
  recordedAt: string,
): readonly GateKind[] {
  const latest = latestLedgerVerdicts(ledger)
  const verdicts = Object.freeze([
    ...evaluateSelfGates(request, recordedAt),
    ...LEDGER_GATE_KINDS.map((kind) => latest[kind] ?? pendingGate(kind, recordedAt)),
  ])
  return Object.freeze(verdicts.filter((gate) => gate.verdict !== 'passed').map((gate) => gate.kind))
}

function pendingGate(kind: LedgerGateKind, recordedAt: string): GateVerdictRecord {
  return Object.freeze({
    kind,
    verdict: 'pending' as GateVerdict,
    reason: GATE_PENDING_REASON_BY_KIND[kind],
    authority: 'gate' as GateAuthority,
    verifier: null,
    evidenceRefs: Object.freeze([]),
    recordedAt,
  })
}

/**
 * Decide an activation.
 *
 * `approved` is `true` only when **every** gate in `GATE_KINDS` reads `passed`. There is no
 * partial approval, no "approved except the tests" and no path where a missing gate is treated
 * as a pass.
 *
 * `precedence` is carried rather than assumed: a decision taken while a stop was latched, or
 * while the journal could not be believed, is not a gate failure, and a reader who saw only
 * "refused" would reasonably assume the domain rule was what stopped it.
 */
export function decideActivation(
  request: AcquisitionRequest,
  ledger: readonly GateVerdictRecord[],
  decidedAt: string,
  precedence: AcquisitionPrecedence | null = null,
): ActivationDecision {
  const latest = latestLedgerVerdicts(ledger)
  const gates = Object.freeze([
    ...evaluateSelfGates(request, decidedAt),
    ...LEDGER_GATE_KINDS.map((kind) => latest[kind] ?? pendingGate(kind, decidedAt)),
  ])
  const unsatisfied = Object.freeze(
    gates.filter((gate) => gate.verdict !== 'passed').map((gate) => gate.kind),
  )
  const ownerApproved = latest['owner-approval']?.verdict === 'passed'
  return Object.freeze({
    requestId: request.requestId,
    approved: unsatisfied.length === 0,
    gates,
    unsatisfied,
    decidedAt,
    ownerApproved,
    precedence,
  })
}

/**
 * Build a lifecycle reason from a decision.
 *
 * Owner first, because an owner refusal is a decision and every other gate failing is not
 * one; then verification, because "this did not work" is the most fundamental thing that can
 * be wrong; then everything else, which is reported as `gate-failed` rather than by inventing
 * a reason per gate, since a request that fails three gates has one failure, not three.
 */
export function reasonForDecision(decision: ActivationDecision): RequestLifecycleReason | null {
  if (decision.approved) return null
  // Only a *recorded decline* is a decision. An owner gate nobody has answered yet is pending,
  // and reporting that as a refusal would put a decision nobody made into the ledger.
  const owner = decision.gates.find((gate) => gate.kind === 'owner-approval')
  if (owner !== undefined && owner.verdict === 'failed') return 'owner-declined-activation'
  const verification = decision.gates.find((gate) => gate.kind === 'verification-passed')
  if (verification !== undefined && verification.verdict === 'failed') return 'verification-failed'
  return 'gate-failed'
}

/** Whether every gate is currently satisfied for this request at this instant. */
export function everyGateSatisfied(
  request: AcquisitionRequest,
  ledger: readonly GateVerdictRecord[],
  recordedAt: string,
): boolean {
  return unsatisfiedGates(request, ledger, recordedAt).length === 0
}

/** An owner verdict, rebuilt through the one function that can produce one. */
function rebuildOwnerVerdict(
  record: Record<string, unknown>,
  recordedAt: string,
): GateResult {
  const rebuilt = recordOwnerApproval(record.verdict === 'passed', recordedAt)
  if (!rebuilt.ok) {
    return { ok: false, code: 'invalid-gate-verdict', reason: 'a stored owner approval carries an unreadable verdict' }
  }
  // The stored reason is re-derived rather than believed, so a hand-edited row cannot turn a
  // declined approval into an approved one by editing its label.
  if (record.reason !== rebuilt.verdict.reason) {
    return { ok: false, code: 'invalid-gate-reason', reason: 'a stored owner approval carries another reason' }
  }
  return { ok: true, verdict: rebuilt.verdict }
}

/**
 * Whether a gate verdict is well formed, re-run on read.
 *
 * The store validates every row, so a hand-edited or half-written ledger degrades the store
 * rather than being folded as though it were the truth. Construction-time refusals are re-run
 * here — including the kind/reason/verdict agreements — because a ledger row does not pass
 * through `recordGateVerdict` when it arrives from disk.
 */
export function validateGateVerdict(value: unknown): { ok: true; verdict: GateVerdictRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a gate verdict is not an object' }
  }
  const record = value as Record<string, unknown>
  const expected = ['kind', 'verdict', 'reason', 'authority', 'verifier', 'evidenceRefs', 'recordedAt']
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...expected].sort())) {
    return { ok: false, reason: 'a stored gate verdict does not carry exactly the ledger fields' }
  }
  if (!isGateKind(record.kind)) return { ok: false, reason: 'a stored gate verdict names an unknown gate' }
  if (!isLedgerGateKind(record.kind)) {
    return { ok: false, reason: 'a stored ledger carries a gate that is derived from the request' }
  }
  if (record.authority !== 'owner' && record.authority !== 'verifier' && record.authority !== 'core' && record.authority !== 'gate') {
    return { ok: false, reason: 'a stored gate verdict names an unknown authority' }
  }
  const recordedAt = typeof record.recordedAt === 'string' ? record.recordedAt : ''
  if (record.kind === 'owner-approval') {
    if (record.authority !== 'owner') {
      return { ok: false, reason: 'a stored owner approval does not name the owner as its authority' }
    }
    if (record.verifier !== 'owner') {
      return { ok: false, reason: 'a stored owner approval is not attributed to the owner' }
    }
    if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length !== 0) {
      return { ok: false, reason: 'an owner approval is a decision and carries no evidence references' }
    }
    const ownerVerdict = rebuildOwnerVerdict(record, recordedAt)
    if (!ownerVerdict.ok) return { ok: false, reason: ownerVerdict.reason }
    return { ok: true, verdict: ownerVerdict.verdict }
  }
  if (record.authority === 'owner') {
    return { ok: false, reason: 'only the owner-approval gate may carry the owner authority' }
  }
  const rebuilt = recordGateVerdict(
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
  return { ok: true, verdict: rebuilt.verdict }
}

/**
 * One gate as a **decision** carries it.
 *
 * Different from a stored ledger entry, and deliberately: a decision legitimately holds all
 * seven gates, including the three computed ones, because its job is to show the whole
 * conjunction at the instant it was taken. What is checked here is therefore stricter in one
 * direction and looser in another — a computed gate must be exactly what the evaluator computes
 * (right reason for its verdict, `gate` authority, no verifier, no evidence), and a ledger gate
 * must still be well formed under `validateGateVerdict`.
 *
 * Without the distinction a decision could never be stored at all; with it, a decision cannot
 * carry a *computed* gate that claims a verifier did it.
 */
export function validateDecisionGate(value: unknown): { ok: true; verdict: GateVerdictRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a decision gate is not an object' }
  }
  const gate = value as Record<string, unknown>
  if (!isGateKind(gate.kind)) return { ok: false, reason: 'a decision names an unknown gate' }
  if (isLedgerGateKind(gate.kind)) {
    const verdict = gate.verdict
    // A `pending` gate in a decision is a placeholder for "nobody has answered this yet", not
    // a verdict anybody recorded — so it is checked against the pending table rather than
    // through the ledger validator, which rightly refuses an evaluator reporting its own
    // evidence. A `not-applicable` gate, by contrast, *was* recorded, by a named verifier.
    if (verdict === 'pending') return pendingDecisionGate(gate)
    return validateGateVerdict(gate)
  }
  const verdict = gate.verdict
  if (verdict !== 'passed' && verdict !== 'failed') {
    return { ok: false, reason: 'a computed gate is either passed or failed, never pending' }
  }
  const expected = DERIVED_GATE_REASON_BY_VERDICT[gate.kind]?.[verdict]
  if (gate.reason !== expected) {
    return { ok: false, reason: 'a decision carries a computed gate with another reason' }
  }
  if (gate.authority !== 'gate' || gate.verifier !== null || !Array.isArray(gate.evidenceRefs) || gate.evidenceRefs.length !== 0) {
    return { ok: false, reason: 'a computed gate may name no producer and no evidence' }
  }
  if (instantMs(gate.recordedAt) === null) {
    return { ok: false, reason: 'a decision gate has an unreadable instant' }
  }
  return {
    ok: true,
    verdict: Object.freeze({
      kind: gate.kind,
      verdict,
      reason: expected,
      authority: 'gate',
      verifier: null,
      evidenceRefs: Object.freeze([]),
      recordedAt: gate.recordedAt as string,
    }),
  }
}

/** A placeholder gate: owed, unanswered, produced by nobody. */
function pendingDecisionGate(gate: Record<string, unknown>): { ok: true; verdict: GateVerdictRecord } | { ok: false; reason: string } {
  const kind = gate.kind as LedgerGateKind
  if (gate.reason !== GATE_PENDING_REASON_BY_KIND[kind]) {
    return { ok: false, reason: 'a pending gate carries another pending reason' }
  }
  if (gate.authority !== 'gate' || gate.verifier !== null || !Array.isArray(gate.evidenceRefs) || gate.evidenceRefs.length !== 0) {
    return { ok: false, reason: 'a pending gate may name no producer and no evidence' }
  }
  if (instantMs(gate.recordedAt) === null) {
    return { ok: false, reason: 'a decision gate has an unreadable instant' }
  }
  return {
    ok: true,
    verdict: Object.freeze({
      kind,
      verdict: 'pending' as GateVerdict,
      reason: GATE_PENDING_REASON_BY_KIND[kind],
      authority: 'gate' as GateAuthority,
      verifier: null,
      evidenceRefs: Object.freeze([]),
      recordedAt: gate.recordedAt as string,
    }),
  }
}

/** Re-exported so the engine can validate without importing `types` directly. */
export { isAcquisitionRef, isRequestLifecycleConsistent }