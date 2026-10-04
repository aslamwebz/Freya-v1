/**
 * THE RELATIONSHIP LEDGER — Phase 27's only way to write a record.
 *
 * Four properties, and every one of them is a property of this file's *shape* rather
 * than of a caller's discipline:
 *
 * 1. **Provenance is assigned by the pathway, never asserted by the payload.** The
 *     candidate input has **no `source` field at all**. `source` is an argument to
 *     `createRelationshipLedgerEntry`, chosen by the trusted caller that observed
 *     something. There is therefore no JSON a page or a model can craft that says
 *     "I am an owner assertion".
 * 2. **Exact keys, refusing extras.** A field that is not in `ENTRY_INPUT_KEYS` fails
 *     the call. An intimacy-shaped field fails it too, loudly, via
 *     `findIntimacyField`. Nothing is silently dropped.
 * 3. **Confidence can only be capped.** `RELATIONSHIP_CEILING` has no `verified` row,
 *     so `capRelationshipConfidence` can lower but never raise, and `verified` is
 *     unreachable from every source class.
 * 4. **Owner-only kinds.** `correction`, `boundary-stated`, `expressed-preference` and
 *     `shared-history` refuse `model-inference`, `freya-inference`,
 *     `external-untrusted` and `imported-document`. A model cannot record that a
 *     person set a boundary.
 *
 * Admission is a separate, trusted step with a recorded reason, exactly as Brain
 * admission and Phase 11 relationship admission are: writing something down does not
 * make it part of the record set.
 */

import { findSecretShape } from '../brain/admission'
import type { Confidence, Provenance, SourceTrust } from '../brain/types'
import { hasExactKeys } from '../hands/validation'
import { findIntimacyField } from './safeguards'
import {
  LEDGER_LIFECYCLE_REASON_BY_STATUS,
  OWNER_ONLY_SOURCES,
  RELATIONSHIP_CEILING,
  RELATIONSHIP_LIMITS,
  UNTRUSTED_SOURCE_MAX_CONFIDENCE,
  capRelationshipConfidence,
  instantMs,
  isOwnerOnlyKind,
  isRelationshipLedgerKind,
  isRelationshipLedgerStatus,
  isRelationshipLifecycleReason,
  isRelationshipRef,
  isLedgerLifecycleConsistent,
  isRelationshipSlug,
  type RelationshipLedgerEntry,
  type RelationshipLedgerKind,
  type RelationshipLedgerStatus,
  type RelationshipLifecycleReason,
} from './types'

export type RelationshipEntryResult =
  | { readonly ok: true; readonly entry: RelationshipLedgerEntry }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** The exact keys a ledger-entry candidate must carry. Nothing else may exist. */
export const ENTRY_INPUT_KEYS: readonly string[] = [
  'entryId',
  'kind',
  'key',
  'text',
  'tags',
  'evidenceRefs',
  'observedAt',
  'recordedAt',
  'proposedConfidence',
  'actor',
]

/**
 * The exact keys a `RelationshipLedgerEntry` has.
 *
 * Declared so a test can assert the stored shape has not grown a field, and so a
 * payload that grew one is refused rather than tolerated.
 */
export const ENTRY_KEYS: readonly string[] = [
  'entryId',
  'kind',
  'key',
  'text',
  'tags',
  'provenance',
  'confidence',
  'evidenceRefs',
  'status',
  'admittedAt',
  'admissionReason',
  'lifecycleAt',
  'lifecycleReason',
]

const CONFIDENCE_VALUES: readonly string[] = ['unknown', 'low', 'medium', 'high', 'verified']

/** Source classes permitted to record an owner-only kind. A set, for O(1) lookup. */
const OWNER_ONLY_SOURCE_SET: ReadonlySet<SourceTrust> = new Set(OWNER_ONLY_SOURCES)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isValidTags(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > RELATIONSHIP_LIMITS.maxTagsPerEntry) return false
  return value.every(
    (tag) =>
      typeof tag === 'string' && isRelationshipSlug(tag) && tag.length <= RELATIONSHIP_LIMITS.maxTagChars,
  )
}

function isValidEvidenceRefs(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > RELATIONSHIP_LIMITS.maxEvidenceRefs) return false
  return value.every((ref) => isRelationshipRef(ref))
}

/** What only a re-read-from-storage needs: a destroyed-text record has no text. */
interface BuildOptions {
  readonly allowDestroyedText: boolean
}

/**
 * Construct a ledger entry candidate.
 *
 * `source` is an **argument, not a field**, which is the anti-poisoning hinge: the
 * only way to obtain `owner-assertion` is for trusted code to pass it, and the
 * caller's pathway is the evidence of who it was.
 *
 * Refuses rather than repairs throughout. A secret-shaped `text` fails whole, so
 * nothing is stored that a later reader could mistake for safe.
 */
export function createRelationshipLedgerEntry(
  input: unknown,
  source: SourceTrust,
): RelationshipEntryResult {
  return buildEntry(input, source, { allowDestroyedText: false })
}

function buildEntry(
  input: unknown,
  source: SourceTrust,
  options: BuildOptions,
): RelationshipEntryResult {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'not-an-object', reason: 'a relationship ledger entry input must be an object' }
  }
  // Intimacy refusal runs **before** the exact-key check, on purpose. An extra field
  // named `feeling` fails both rules, and the specific code is the one worth having: a
  // general `key-set-mismatch` says "your payload was malformed", while
  // `intimacy-field-refused` says "this domain will not hold that". Both refuse, so no
  // smuggling is possible either way; naming which rule fired is what makes the attempt
  // reviewable rather than merely blocked.
  const intimacyFields = findIntimacyField(input)
  if (intimacyFields.length > 0) {
    return {
      ok: false,
      code: 'intimacy-field-refused',
      reason: `the entry carries intimacy-shaped field(s) that this domain does not record: [${intimacyFields.join(', ')}]`,
    }
  }

  if (!hasExactKeys(input, ENTRY_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...ENTRY_INPUT_KEYS].sort()
    return {
      ok: false,
      code: 'key-set-mismatch',
      reason: `relationship ledger entry keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }

  if (!isBoundedString(input.entryId, RELATIONSHIP_LIMITS.maxEntryIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'entryId must be a non-empty bounded string' }
  }
  if (!isRelationshipLedgerKind(input.kind)) {
    return { ok: false, code: 'invalid-kind', reason: 'kind is not in the closed relationship ledger vocabulary' }
  }
  if (!isRelationshipSlug(input.key) || input.key.length > RELATIONSHIP_LIMITS.maxKeyChars) {
    return { ok: false, code: 'invalid-key', reason: 'key must be a bounded code-owned slug' }
  }
  if (typeof input.text !== 'string' || input.text.length > RELATIONSHIP_LIMITS.maxTextChars) {
    return { ok: false, code: 'invalid-text', reason: 'text must be a bounded string' }
  }
  if (!options.allowDestroyedText && input.text.length === 0) {
    return { ok: false, code: 'invalid-text', reason: 'text must be a non-empty bounded string' }
  }
  const secretShape = findSecretShape(input.text)
  if (secretShape !== null) {
    return {
      ok: false,
      code: 'secret-shaped-text-refused',
      reason: `the entry text is secret-shaped (${secretShape}) and was refused whole rather than redacted`,
    }
  }
  if (!isValidTags(input.tags)) {
    return { ok: false, code: 'invalid-tags', reason: 'tags must be bounded code-owned slugs' }
  }
  if (!isValidEvidenceRefs(input.evidenceRefs)) {
    return { ok: false, code: 'invalid-evidence-refs', reason: 'evidenceRefs must be bounded opaque ids' }
  }
  if (instantMs(input.observedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'observedAt must parse as an instant' }
  }
  if (instantMs(input.recordedAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'recordedAt must parse as an instant' }
  }
  if (typeof input.proposedConfidence !== 'string' || !CONFIDENCE_VALUES.includes(input.proposedConfidence)) {
    return { ok: false, code: 'invalid-confidence', reason: 'proposedConfidence must be a confidence category' }
  }
  if (!isBoundedString(input.actor, RELATIONSHIP_LIMITS.maxActorChars)) {
    return { ok: false, code: 'invalid-actor', reason: 'actor must be a non-empty bounded string' }
  }
  if (typeof source !== 'string' || !Object.prototype.hasOwnProperty.call(RELATIONSHIP_CEILING, source)) {
    return {
      ok: false,
      code: 'invalid-source',
      reason: 'source must be a known trust class assigned by the pathway',
    }
  }

  const kind = input.kind as RelationshipLedgerKind
  const evidenceRefs = input.evidenceRefs as readonly string[]

  // Owner-only kinds are refused for the untrusted source classes.
  if (isOwnerOnlyKind(kind) && !OWNER_ONLY_SOURCE_SET.has(source)) {
    return {
      ok: false,
      code: 'owner-only-kind',
      reason: `a ${kind} record may only come from owner-assertion or system-observation, not ${source}`,
    }
  }

  // Evidence rule: the owner is the evidence. Everything else must name a record.
  if (source !== 'owner-assertion' && evidenceRefs.length === 0) {
    return {
      ok: false,
      code: 'no-evidence',
      reason: 'a non-owner record must name at least one evidence reference id',
    }
  }

  const ceiling = RELATIONSHIP_CEILING[source]
  // The untrusted classes get Phase 27's own named ceiling rather than only the one
  // inherited from Brain admission.
  const effectiveCeiling =
    source === 'model-inference' || source === 'external-untrusted'
      ? capRelationshipConfidence(ceiling.confidence, UNTRUSTED_SOURCE_MAX_CONFIDENCE)
      : ceiling.confidence

  const proposed = input.proposedConfidence as Confidence
  const confidence = capRelationshipConfidence(proposed, effectiveCeiling)
  if (confidence !== proposed) {
    return {
      ok: false,
      code: 'confidence-ceiling',
      reason: `a ${source} relationship record may not carry confidence '${proposed}'; this domain caps it at '${effectiveCeiling}'`,
    }
  }

  const provenance: Provenance = Object.freeze({
    sourceType: source,
    sourceRef: null,
    observedAt: input.observedAt as string,
    recordedAt: input.recordedAt as string,
    actor: input.actor as string,
    verificationStatus: ceiling.epistemic,
    confidence,
    evidenceSummary: null,
  })

  return {
    ok: true,
    entry: Object.freeze({
      entryId: input.entryId as string,
      kind,
      key: input.key as string,
      text: input.text as string,
      tags: Object.freeze([...(input.tags as readonly string[])]),
      provenance,
      confidence,
      evidenceRefs: Object.freeze([...evidenceRefs]),
      status: 'candidate' as const,
      admittedAt: null,
      admissionReason: null,
      lifecycleAt: null,
      lifecycleReason: null,
    }),
  }
}

/**
 * Admit a candidate. The only path to `admitted`, and the only path anything derived
 * reads.
 *
 * Takes no decision about kind, key, text, source or evidence from the entry: the
 * candidate is already frozen and admission changes status and nothing else, so a
 * caller cannot re-describe a record on the way in.
 */
export function admitRelationshipEntry(
  candidate: RelationshipLedgerEntry,
  admission: { now: string; reason: string },
): RelationshipEntryResult {
  if (candidate.status !== 'candidate') {
    return { ok: false, code: 'not-candidate', reason: `only candidates can be admitted, not ${candidate.status}` }
  }
  if (instantMs(admission.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'admission now must parse as an instant' }
  }
  if (!isBoundedString(admission.reason, RELATIONSHIP_LIMITS.maxReasonChars)) {
    return {
      ok: false,
      code: 'invalid-instant',
      reason: 'the admission reason must be a non-empty bounded string',
    }
  }
  return {
    ok: true,
    entry: Object.freeze({
      ...candidate,
      status: 'admitted' as const,
      admittedAt: admission.now,
      admissionReason: admission.reason,
    }),
  }
}

/**
 * Reject a candidate. Kept as data with its reason, never deleted here.
 *
 * The text is **kept** on a rejected candidate rather than destroyed, matching Phase
 * 11: a candidate was never part of the record set, so no projection ever showed it,
 * and keeping it lets the owner read back what was declined.
 */
export function rejectRelationshipEntry(
  candidate: RelationshipLedgerEntry,
  decision: { now: string; reason: string },
): RelationshipEntryResult {
  if (candidate.status !== 'candidate') {
    return { ok: false, code: 'not-candidate', reason: `only candidates can be rejected, not ${candidate.status}` }
  }
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  if (!isBoundedString(decision.reason, RELATIONSHIP_LIMITS.maxReasonChars)) {
    return {
      ok: false,
      code: 'invalid-instant',
      reason: 'the rejection reason must be a non-empty bounded string',
    }
  }
  return {
    ok: true,
    entry: Object.freeze({
      ...candidate,
      status: 'rejected' as const,
      admittedAt: null,
      admissionReason: decision.reason,
      lifecycleAt: decision.now,
      lifecycleReason: 'owner-rejected-this-record' as const,
    }),
  }
}

/**
 * Mark an admitted entry as superseded by a newer one carrying the same key.
 *
 * Unlike retraction this **keeps the text**: the older record was true when it was
 * written and a person reading it back should still see what was said. It stops
 * feeding derivation — only `admitted` entries do — so superseding is the cheapest
 * honest way to stop an outdated record from steering anything.
 */
export function supersedeRelationshipEntry(
  entry: RelationshipLedgerEntry,
  decision: { now: string; supersedes: string },
): RelationshipEntryResult {
  if (entry.status !== 'admitted') {
    return { ok: false, code: 'not-admitted', reason: `only admitted records can be superseded, not ${entry.status}` }
  }
  if (instantMs(decision.now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  if (!isBoundedString(decision.supersedes, RELATIONSHIP_LIMITS.maxEntryIdChars)) {
    return { ok: false, code: 'invalid-id', reason: 'the superseding entry id must be a bounded non-empty string' }
  }
  if (decision.supersedes === entry.entryId) {
    return { ok: false, code: 'self-supersession', reason: 'a record cannot supersede itself' }
  }
  return {
    ok: true,
    entry: Object.freeze({
      ...entry,
      status: 'superseded' as const,
      lifecycleAt: decision.now,
      lifecycleReason: 'superseded-by-a-newer-record' as const,
    }),
  }
}

/**
 * Retract a live record. Destruction, not a flag.
 *
 * `text` becomes `''` and `status` becomes `retracted`, so the only way for withdrawn
 * words to leak afterwards is to have leaked them while they were live. Everything
 * else is kept — id, kind, key, tags, provenance, confidence, evidence refs, admitted
 * instant — because "this existed and was taken back" is an answer the domain owes
 * after a restart, and a record that vanished would answer `nothing here` instead.
 *
 * One caller, one reason: `owner-withdrew-this-record`. Core's own bounded retention
 * uses `expireRelationshipEntry`, and the distinction matters because pretending the
 * owner decided would be as dishonest as pretending they did not.
 */
export function retractRelationshipEntry(
  entry: RelationshipLedgerEntry,
  decision: { now: string },
): RelationshipEntryResult {
  return terminateEntry(entry, decision.now, 'owner-withdrew-this-record', 'retracted')
}

/**
 * Retire a live entry under Core's own bound. Deterministic and stated, never silent.
 *
 * Two reasons so the two causes stay distinguishable: `retention-bound-reached` for
 * the bound itself, `stale-record-expired` for a record retired because it aged out.
 */
export function expireRelationshipEntry(
  entry: RelationshipLedgerEntry,
  decision: {
    now: string
    reason: Extract<RelationshipLifecycleReason, 'retention-bound-reached' | 'stale-record-expired'>
  },
): RelationshipEntryResult {
  if (
    decision.reason !== 'retention-bound-reached' &&
    decision.reason !== 'stale-record-expired'
  ) {
    return {
      ok: false,
      code: 'illegal-lifecycle-reason',
      reason: 'the expiry reason must be one of the two expiry labels',
    }
  }
  return terminateEntry(entry, decision.now, decision.reason, 'expired')
}

function terminateEntry(
  entry: RelationshipLedgerEntry,
  now: string,
  reason: RelationshipLifecycleReason,
  status: 'retracted' | 'expired',
): RelationshipEntryResult {
  if (entry.status !== 'admitted') {
    return { ok: false, code: 'not-admitted', reason: `only admitted records can end, not ${entry.status}` }
  }
  if (instantMs(now) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'decision now must parse as an instant' }
  }
  if (!LEDGER_LIFECYCLE_REASON_BY_STATUS[status].includes(reason)) {
    return {
      ok: false,
      code: 'illegal-lifecycle-reason',
      reason: `a ${status} record cannot carry the lifecycle reason ${reason}`,
    }
  }
  return {
    ok: true,
    entry: Object.freeze({
      ...entry,
      text: '',
      status: status as RelationshipLedgerStatus,
      admittedAt: entry.admittedAt,
      lifecycleAt: now,
      lifecycleReason: reason,
    }),
  }
}

/**
 * Rebuild an entry from a stored value, re-running every construction rule.
 *
 * Used by the fold on read and by nothing else. **Re-deriving** the entry rather than
 * trusting the stored shape is what makes a hand-edited Vault row unable to carry a
 * confidence above its source ceiling, an owner-only kind from a model, or an
 * intimacy-shaped field: the row is parsed, the original candidate is reconstructed
 * from the stored provenance, and construction either produces the same entry or
 * refuses the row.
 *
 * The lifecycle fields are then carried across and validated against the closed
 * status/reason table, so a stored row claiming `admitted` with a lifecycle reason is
 * refused rather than believed.
 */
export function rebuildRelationshipEntry(stored: unknown): RelationshipEntryResult {
  if (!isPlainObject(stored)) {
    return { ok: false, code: 'not-an-object', reason: 'a stored relationship entry is not an object' }
  }
  if (!isRelationshipLedgerStatus(stored.status)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored relationship entry named an unknown status' }
  }
  if (!isPlainObject(stored.provenance)) {
    return { ok: false, code: 'invalid-record', reason: 'a stored relationship entry has no provenance' }
  }
  const provenance = stored.provenance
  const source = provenance.sourceType
  if (typeof source !== 'string' || !Object.prototype.hasOwnProperty.call(RELATIONSHIP_CEILING, source)) {
    return { ok: false, code: 'invalid-source', reason: 'a stored relationship entry has an unknown source class' }
  }

  const status = stored.status
  const destroyed = status === 'retracted' || status === 'expired'
  // A destroyed-text record must actually be destroyed. Accepting a stored `retracted`
  // row that still carries text would be a way to keep withdrawn words in the Vault.
  if (destroyed && stored.text !== '') {
    return {
      ok: false,
      code: 'invalid-record',
      reason: `a ${status} record must not retain its text`,
    }
  }
  if (!destroyed && stored.text === '') {
    return { ok: false, code: 'invalid-record', reason: `a ${status} record must carry its text` }
  }

  const rebuilt = buildEntry(
    {
      entryId: stored.entryId,
      kind: stored.kind,
      key: stored.key,
      text: stored.text,
      tags: stored.tags,
      evidenceRefs: stored.evidenceRefs,
      observedAt: provenance.observedAt,
      recordedAt: provenance.recordedAt,
      proposedConfidence: stored.confidence,
      actor: provenance.actor,
    },
    source as SourceTrust,
    { allowDestroyedText: destroyed },
  )
  if (!rebuilt.ok) return rebuilt

  const lifecycleAt = stored.lifecycleAt
  const lifecycleReason = stored.lifecycleReason
  if (lifecycleAt !== null && instantMs(lifecycleAt) === null) {
    return { ok: false, code: 'invalid-instant', reason: 'a stored lifecycle instant does not parse' }
  }
  if (lifecycleReason !== null && !isRelationshipLifecycleReason(lifecycleReason)) {
    return {
      ok: false,
      code: 'illegal-lifecycle-reason',
      reason: 'a stored lifecycle reason is outside the closed vocabulary',
    }
  }
  if (!isLedgerLifecycleConsistent(status, lifecycleAt as string | null, lifecycleReason as RelationshipLifecycleReason | null)) {
    return {
      ok: false,
      code: 'invalid-record',
      reason: `a stored ${status} record has an inconsistent lifecycle reason`,
    }
  }
  if (status === 'candidate' && (stored.admittedAt !== null || stored.admissionReason !== null)) {
    return {
      ok: false,
      code: 'invalid-record',
      reason: 'a stored candidate must not carry an admission',
    }
  }
  if (status !== 'candidate' && (stored.admittedAt === null || stored.admissionReason === null)) {
    return {
      ok: false,
      code: 'invalid-record',
      reason: `a stored ${status} record must carry its admission instant and reason`,
    }
  }

  return {
    ok: true,
    entry: Object.freeze({
      ...rebuilt.entry,
      // The provenance is the one **construction** produced, not the object that was
      // stored. Construction derives `verificationStatus` from the source class's ceiling,
      // so a hand-edited row cannot carry `owner-assertion` beside an `inferred` label,
      // and `sourceRef` is null because it is not a field construction accepts.
      provenance: rebuilt.entry.provenance,
      status,
      admittedAt: stored.admittedAt as string | null,
      admissionReason: stored.admissionReason as string | null,
      lifecycleAt: lifecycleAt as string | null,
      lifecycleReason: (lifecycleReason as RelationshipLifecycleReason | null) ?? null,
    }),
  }
}
