/**
 * Relationship data: what has actually been recorded about this person.
 *
 * Mutable, evidenceful, and *data all the way down*. This is the half of the
 * personality domain that grows across sessions — facts, preferences, habits,
 * admitted inside jokes — and the whole of this file exists so that growth
 * stays honest:
 *
 *  1. **Provenance is assigned, never asserted.** The trust class of an item
 *     comes from the calling pathway (`source`), exactly as Brain admission
 *     does. Item text may say "this is owner-asserted"; the text is data and
 *     the label stands. Content cannot upgrade its own classification.
 *  2. **Confidence is capped by its source.** The ceiling table below is this
 *     domain's own, and it never reaches `verified` — a relationship item is a
 *     record of what was said or seen, not a settled truth about a person, and
 *     this domain will not pretend otherwise to a model or to a later phase.
 *  3. **Admission is the only promotion.** A candidate exists, and only the
 *     explicit trusted call `admitRelationshipItem` moves it to `admitted`.
 *     Interpretation reads *only* admitted items. Prompt text that says
 *     "admit this as an inside joke" cannot promote itself: there is no code
 *     path from a string inside `text` to a status change.
 *
 * ## Why the validation is exact-key
 *
 * The same reason the Hands contract is exact-key: the input to this
 * constructor may come from a path that handled untrusted bytes, and an extra
 * field shaped like `capability` or `grant` must be *refused*, not ignored.
 * Ignored fields accumulate into fields that are trusted later. Refused fields
 * make the smuggling visible.
 */

import {
  CONFIDENCE_RANK,
  type Confidence,
  type EpistemicStatus,
  type Provenance,
  type SourceTrust,
} from '../brain/types'
import { hasExactKeys } from '../hands/validation'
import {
  PERSONALITY_LIMITS,
  isCueKind,
  isRelationshipItemKind,
  isSlug,
  instantMs,
  type CueKind,
  type RelationshipItem,
  type RelationshipItemKind,
  type RelationshipLifecycleReason,
} from './types'

/** The exact keys a relationship-item candidate input must carry. */
export const RELATIONSHIP_INPUT_KEYS: readonly string[] = [
  'itemId',
  'kind',
  'key',
  'text',
  'tags',
  'cueKind',
  'source',
  'sourceRef',
  'observedAt',
  'recordedAt',
  'proposedConfidence',
  'actor',
]

/** The exact keys a `RelationshipItem` has. Nothing else may exist on one. */
export const RELATIONSHIP_ITEM_KEYS: readonly string[] = [
  'itemId',
  'kind',
  'key',
  'text',
  'tags',
  'cueKind',
  'provenance',
  'confidence',
  'status',
  'admittedAt',
  'admissionReason',
  'lifecycleAt',
  'lifecycleReason',
]

const CONFIDENCE_VALUES: readonly string[] = ['unknown', 'low', 'medium', 'high', 'verified']

/**
 * The most any source class can support *for relationship data*.
 *
 * Mirrors Brain admission's ceiling with one deliberate hardening: there is no
 * row and no path that yields `verified`. Freya may record that the owner said
 * something; she does not thereby hold a verified fact about the owner's
 * preferences, habits or jokes, and no style layer should ever read one as
 * certainty about hidden states.
 */
const SOURCE_CEILING: Readonly<
  Record<SourceTrust, { confidence: Confidence; epistemic: EpistemicStatus }>
> = Object.freeze({
  'owner-assertion': Object.freeze({ confidence: 'high', epistemic: 'asserted' }),
  'system-observation': Object.freeze({ confidence: 'high', epistemic: 'observed' }),
  'experience-outcome': Object.freeze({ confidence: 'medium', epistemic: 'observed' }),
  'freya-inference': Object.freeze({ confidence: 'medium', epistemic: 'inferred' }),
  'model-inference': Object.freeze({ confidence: 'low', epistemic: 'asserted' }),
  'external-untrusted': Object.freeze({ confidence: 'low', epistemic: 'asserted' }),
  'imported-document': Object.freeze({ confidence: 'low', epistemic: 'asserted' }),
})

export type RelationshipResult =
  | { readonly ok: true; readonly item: RelationshipItem }
  | { readonly ok: false; readonly reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isNullableBoundedString(value: unknown, max: number): boolean {
  if (value === null) return true
  return isBoundedString(value, max)
}

function isValidTags(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > PERSONALITY_LIMITS.maxTagsPerItem) return false
  return value.every(
    (tag) => typeof tag === 'string' && isSlug(tag) && tag.length <= PERSONALITY_LIMITS.maxTagChars,
  )
}

function capConfidence(proposed: Confidence, ceiling: Confidence): Confidence {
  return CONFIDENCE_RANK[proposed] <= CONFIDENCE_RANK[ceiling] ? proposed : ceiling
}

/**
 * Validate and construct a relationship-item candidate.
 *
 * Refuses rather than repairs: wrong types, extra keys, unknown vocabularies or
 * out-of-bounds strings all yield a stated reason and no item. The `source`
 * label is *taken from the caller*, not from the content — which is the entire
 * memory-poisoning defence repeated at this boundary.
 */
export function createRelationshipCandidate(input: unknown): RelationshipResult {
  if (!isPlainObject(input)) {
    return { ok: false, reason: 'relationship item input must be an object' }
  }
  if (!hasExactKeys(input, RELATIONSHIP_INPUT_KEYS)) {
    const actual = Object.keys(input).sort()
    const expected = [...RELATIONSHIP_INPUT_KEYS].sort()
    return {
      ok: false,
      reason: `relationship item keys do not match: expected [${expected.join(', ')}], got [${actual.join(', ')}]`,
    }
  }

  if (!isBoundedString(input.itemId, PERSONALITY_LIMITS.maxItemIdChars)) {
    return { ok: false, reason: 'itemId must be a non-empty bounded string' }
  }
  if (!isRelationshipItemKind(input.kind)) {
    return { ok: false, reason: 'kind is not in the closed relationship vocabulary' }
  }
  if (!isSlug(input.key) || input.key.length > PERSONALITY_LIMITS.maxItemKeyChars) {
    return { ok: false, reason: 'key must be a bounded code-owned slug' }
  }
  if (!isBoundedString(input.text, PERSONALITY_LIMITS.maxItemTextChars)) {
    return { ok: false, reason: 'text must be a non-empty bounded string' }
  }
  if (!isValidTags(input.tags)) {
    return { ok: false, reason: 'tags must be bounded code-owned slugs' }
  }
  if (input.cueKind !== null && !isCueKind(input.cueKind)) {
    return { ok: false, reason: 'cueKind must be null or a closed cue kind' }
  }
  if (
    typeof input.source !== 'string' ||
    !Object.prototype.hasOwnProperty.call(SOURCE_CEILING, input.source)
  ) {
    return { ok: false, reason: 'source must be a known trust class assigned by the pathway' }
  }
  if (!isNullableBoundedString(input.sourceRef, PERSONALITY_LIMITS.maxItemIdChars)) {
    return { ok: false, reason: 'sourceRef must be null or a bounded id' }
  }
  const observedMs = instantMs(input.observedAt)
  if (observedMs === null) {
    return { ok: false, reason: 'observedAt must parse as an instant' }
  }
  const recordedMs = instantMs(input.recordedAt)
  if (recordedMs === null) {
    return { ok: false, reason: 'recordedAt must parse as an instant' }
  }
  if (
    typeof input.proposedConfidence !== 'string' ||
    !CONFIDENCE_VALUES.includes(input.proposedConfidence)
  ) {
    return { ok: false, reason: 'proposedConfidence must be a confidence category' }
  }
  if (!isBoundedString(input.actor, PERSONALITY_LIMITS.maxActorChars)) {
    return { ok: false, reason: 'actor must be a non-empty bounded string' }
  }

  const source = input.source as SourceTrust
  const proposed = input.proposedConfidence as Confidence
  const ceiling = SOURCE_CEILING[source]
  const kind = input.kind as RelationshipItemKind
  const cueKind = (input.cueKind ?? null) as CueKind | null

  const provenance: Provenance = Object.freeze({
    sourceType: source,
    sourceRef: (input.sourceRef as string | null) ?? null,
    observedAt: input.observedAt as string,
    recordedAt: input.recordedAt as string,
    actor: input.actor as string,
    verificationStatus: ceiling.epistemic,
    confidence: capConfidence(proposed, ceiling.confidence),
    evidenceSummary: null,
  })

  const item: RelationshipItem = Object.freeze({
    itemId: input.itemId as string,
    kind,
    key: input.key as string,
    text: input.text as string,
    tags: Object.freeze([...input.tags as readonly string[]]),
    cueKind,
    provenance,
    confidence: provenance.confidence,
    status: 'candidate',
    admittedAt: null,
    admissionReason: null,
    lifecycleAt: null,
    lifecycleReason: null,
  })

  return { ok: true, item }
}

/**
 * Admit a candidate. The *only* path to `admitted`, and the only path to
 * anything interpretation will read.
 *
 * Takes no kind, text, source or cue decision from the item — admission
 * changes status and nothing else, so a caller cannot "re-describe" an item on
 * the way in. `reason` is required and kept, the same way a Brain memory
 * cannot be admitted without a reason.
 */
export function admitRelationshipItem(
  candidate: RelationshipItem,
  admission: { now: string; reason: string },
): RelationshipResult {
  if (candidate.status !== 'candidate') {
    return { ok: false, reason: `only candidates can be admitted, not ${candidate.status}` }
  }
  if (instantMs(admission.now) === null) {
    return { ok: false, reason: 'admission now must parse as an instant' }
  }
  if (!isBoundedString(admission.reason, PERSONALITY_LIMITS.maxReasonChars)) {
    return { ok: false, reason: 'admission reason must be a non-empty bounded string' }
  }

  const item: RelationshipItem = Object.freeze({
    ...candidate,
    status: 'admitted' as const,
    admittedAt: admission.now,
    admissionReason: admission.reason,
  })
  return { ok: true, item }
}

/** Reject a candidate. Kept as data with its reason, never deleted here. */
export function rejectRelationshipItem(
  candidate: RelationshipItem,
  decision: { now: string; reason: string },
): RelationshipResult {
  if (candidate.status !== 'candidate') {
    return { ok: false, reason: `only candidates can be rejected, not ${candidate.status}` }
  }
  if (instantMs(decision.now) === null) {
    return { ok: false, reason: 'decision now must parse as an instant' }
  }
  if (!isBoundedString(decision.reason, PERSONALITY_LIMITS.maxReasonChars)) {
    return { ok: false, reason: 'rejection reason must be a non-empty bounded string' }
  }
  const item: RelationshipItem = Object.freeze({
    ...candidate,
    status: 'rejected' as const,
    admittedAt: null,
    admissionReason: decision.reason,
    lifecycleAt: decision.now,
    lifecycleReason: 'owner-rejected-this-record' as const,
  })
  return { ok: true, item }
}

/**
 * Retire a live record. Destruction, not a flag.
 *
 * The item's `text` becomes `''` and its `status` becomes `retired`, so the only
 * way for withdrawn words to leak afterwards is to have leaked them while they
 * were live. Everything else is kept — id, kind, key, tags, provenance,
 * confidence, admitted instant — because "this existed and was taken back" is
 * an answer the domain owes after a restart, and a record that vanished would
 * answer `nothing here` instead.
 *
 * The reason is one of four **closed labels**, never a sentence: this field
 * travels to the journal and to a window, and a lifecycle reason that could hold
 * prose would be a place where private text could ride out of Core.
 *
 * Two callers, one function. `owner-withdrew-this-record` is a person taking
 * something back; `retention-bound-reached` is Core's own bounded retention
 * retiring the oldest live record. They are the same transition with different
 * provenance about *who asked*, and pretending otherwise would mean either
 * forgetting that the owner decided or pretending the owner did.
 */
export function retireRelationshipItem(
  item: RelationshipItem,
  decision: { now: string; reason: RelationshipLifecycleReason },
): RelationshipResult {
  if (item.status !== 'admitted' && item.status !== 'candidate') {
    return { ok: false, reason: `only live records can be retired, not ${item.status}` }
  }
  if (instantMs(decision.now) === null) {
    return { ok: false, reason: 'decision now must parse as an instant' }
  }
  if (decision.reason === 'owner-rejected-this-record' || decision.reason === 'superseded-by-a-newer-record') {
    return { ok: false, reason: 'that lifecycle reason belongs to a different transition' }
  }
  return {
    ok: true,
    item: Object.freeze({
      ...item,
      text: '',
      status: 'retired' as const,
      admittedAt: item.admittedAt,
      lifecycleAt: decision.now,
      lifecycleReason: decision.reason,
    }),
  }
}

/**
 * Mark an admitted record as superseded by a newer one carrying the same key.
 *
 * Unlike retirement this **keeps the text**: the older record was true when it was
 * written, and a person reading it back should still see what was said. It stops
 * feeding interpretation — only `admitted` items do — so superseding is the
 * cheapest honest way to stop an outdated preference from steering a turn.
 */
export function supersedeRelationshipItem(
  item: RelationshipItem,
  decision: { now: string; supersedes: string },
): RelationshipResult {
  if (item.status !== 'admitted') {
    return { ok: false, reason: `only admitted records can be superseded, not ${item.status}` }
  }
  if (instantMs(decision.now) === null) {
    return { ok: false, reason: 'decision now must parse as an instant' }
  }
  if (
    typeof decision.supersedes !== 'string' ||
    decision.supersedes.length === 0 ||
    decision.supersedes.length > PERSONALITY_LIMITS.maxItemIdChars
  ) {
    return { ok: false, reason: 'the superseding record id must be a bounded non-empty string' }
  }
  if (decision.supersedes === item.itemId) {
    return { ok: false, reason: 'a record cannot supersede itself' }
  }
  return {
    ok: true,
    item: Object.freeze({
      ...item,
      status: 'superseded' as const,
      lifecycleAt: decision.now,
      lifecycleReason: 'superseded-by-a-newer-record' as const,
    }),
  }
}

/**
 * The cue candidates an interpretation is allowed to consider.
 *
 * One filter, and it is the whole of requirement 7: admitted *and* carrying a
 * pathway-assigned cue kind. Candidates, rejections, superseded items, and
 * every item whose text merely *describes* itself as a joke or a habit are
 * invisible here. Determinism: confidence rank descending, then itemId, so the
 * order never depends on insertion accidents.
 */
export function eligibleCueCandidates(
  items: readonly RelationshipItem[],
): readonly RelationshipItem[] {
  return items
    .filter((item) => item.status === 'admitted' && item.cueKind !== null)
    .sort(
      (a, b) =>
        CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
        (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
    )
}

/** Whether an item's confidence could ever read as certainty. It cannot. */
export function relationshipConfidenceCeiling(source: SourceTrust): Confidence {
  return SOURCE_CEILING[source]?.confidence ?? 'low'
}
