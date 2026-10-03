import { CONFIDENCE_RANK } from '../brain/types'
import {
  LIFE_LIMITS,
  isConfidence,
  isLifeDerivation,
  isLifeEntryKind,
  isLifeRefKind,
  isLifeSalience,
  isLifeSourceDomain,
  isLifeStoredStatus,
  type LifeConflict,
  type LifeEntry,
  type LifeReference,
  type LifeRevisionRef,
} from './types'
import { LifeStoreError, type LifeRecord, type LifeRecordKind, type LifeState } from './store'

/**
 * The Life fold, and the validation that guards it.
 *
 * One deterministic function from a sequence of records to a Life state, used by
 * the in-memory store and the Vault store alike. Two implementations of "how do
 * records become state" is how a store ends up disagreeing with itself about
 * what Freya remembers, so there is one.
 *
 * Validation runs on read as well as on write: a record that authenticates is
 * only proven to be the record that was written, not that it is well formed. A
 * record that fails validation is reported and the read stops — the store treats
 * it as a broken chain — rather than being silently skipped.
 */

const RECORD_KINDS: readonly LifeRecordKind[] = ['life-entry', 'life-conflict']

export const LIFE_RECORD_VERSION = 1

/**
 * Apply one record. Idempotent per id.
 *
 * An entry record replaces the entry with the same id: a revision is the *same*
 * entry advanced, and the lineage that proves it was advanced is carried on the
 * record itself. A conflict record adds an edge; it never edits either entry.
 */
export function applyRecord(state: LifeState, record: LifeRecord): void {
  state.sequence += 1
  switch (record.kind) {
    case 'life-entry':
      state.entries.set(record.entry.entryId, record.entry)
      return
    case 'life-conflict':
      if (!state.conflicts.has(record.conflict.conflictId)) {
        state.conflicts.set(record.conflict.conflictId, record.conflict)
      }
      return
    default:
      return
  }
}

export function validateRecord(
  value: unknown,
): { ok: true; record: LifeRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a Life record is not an object' }
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (typeof kind !== 'string' || !RECORD_KINDS.includes(kind as LifeRecordKind)) {
    return { ok: false, reason: 'a Life record named an unknown kind' }
  }
  if (kind === 'life-entry') {
    return validateEntry(record.entry)
  }
  return validateConflict(record.conflict)
}

function validateEntry(value: unknown): { ok: true; record: LifeRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'a Life entry is not an object' }
  }
  const entry = value as Record<string, unknown>
  if (!isId(entry.entryId)) return { ok: false, reason: 'a Life entry has no id' }
  if (!isLifeEntryKind(entry.kind)) return { ok: false, reason: 'a Life entry named an unknown kind' }
  if (!isText(entry.title, LIFE_LIMITS.maxTitleChars)) {
    return { ok: false, reason: 'a Life entry title is empty or exceeds the limit' }
  }
  if (!isText(entry.summary, LIFE_LIMITS.maxSummaryChars, true)) {
    return { ok: false, reason: 'a Life entry summary exceeds the limit' }
  }
  if (!isText(entry.body, LIFE_LIMITS.maxBodyChars, true)) {
    return { ok: false, reason: 'a Life entry body exceeds the limit' }
  }
  if (!isLifeStoredStatus(entry.status)) return { ok: false, reason: 'a Life entry has an unknown status' }
  if (!isLifeSalience(entry.salience)) return { ok: false, reason: 'a Life entry has an unknown salience' }
  if (!isLifeDerivation(entry.derivation)) {
    return { ok: false, reason: 'a Life entry has an unknown derivation class' }
  }
  if (!isConfidence(entry.confidence)) return { ok: false, reason: 'a Life entry has an unknown confidence' }
  if (!isProvenance(entry.provenance)) return { ok: false, reason: 'a Life entry provenance is malformed' }
  if (!Array.isArray(entry.references) || entry.references.length > LIFE_LIMITS.maxReferencesPerEntry) {
    return { ok: false, reason: 'a Life entry references are malformed' }
  }
  for (const reference of entry.references) {
    if (!isReference(reference)) return { ok: false, reason: 'a Life entry reference is malformed' }
  }
  if (entry.occurredAt !== null && !isInstant(entry.occurredAt)) {
    return { ok: false, reason: 'a Life entry occurredAt is malformed' }
  }
  if (!isInstant(entry.recordedAt) || !isInstant(entry.updatedAt)) {
    return { ok: false, reason: 'a Life entry timestamp is malformed' }
  }
  if (!isPositiveInt(entry.revision)) return { ok: false, reason: 'a Life entry revision is malformed' }
  if (entry.supersedes !== null && !isId(entry.supersedes)) {
    return { ok: false, reason: 'a Life entry supersedes reference is malformed' }
  }
  if (!Array.isArray(entry.lineage) || entry.lineage.length > LIFE_LIMITS.maxLineagePerEntry) {
    return { ok: false, reason: 'a Life entry lineage is malformed' }
  }
  for (const revision of entry.lineage) {
    if (!isRevisionRef(revision)) return { ok: false, reason: 'a Life entry lineage revision is malformed' }
  }
  if (!Array.isArray(entry.tags) || entry.tags.length > LIFE_LIMITS.maxTagsPerEntry) {
    return { ok: false, reason: 'a Life entry tags are malformed' }
  }
  for (const tag of entry.tags) {
    if (!isText(tag, LIFE_LIMITS.maxTagChars)) return { ok: false, reason: 'a Life entry tag is malformed' }
  }
  if (
    typeof entry.admissionReason !== 'string' ||
    entry.admissionReason.length === 0 ||
    entry.admissionReason.length > LIFE_LIMITS.maxReasonChars
  ) {
    return { ok: false, reason: 'a Life entry must state why it was admitted, within the reason limit' }
  }
  return { ok: true, record: { kind: 'life-entry', entry: value as unknown as LifeEntry } }
}

function validateConflict(value: unknown): { ok: true; record: LifeRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'a Life conflict is not an object' }
  }
  const conflict = value as Record<string, unknown>
  if (!isId(conflict.conflictId)) return { ok: false, reason: 'a Life conflict has no id' }
  if (!isId(conflict.entryA) || !isId(conflict.entryB)) {
    return { ok: false, reason: 'a Life conflict does not name two entries' }
  }
  if (conflict.entryA === conflict.entryB) {
    return { ok: false, reason: 'a Life conflict names the same entry twice' }
  }
  if (!isText(conflict.reason, LIFE_LIMITS.maxReasonChars)) {
    return { ok: false, reason: 'a Life conflict reason is malformed' }
  }
  if (!isInstant(conflict.detectedAt)) return { ok: false, reason: 'a Life conflict timestamp is malformed' }
  return { ok: true, record: { kind: 'life-conflict', conflict: value as unknown as LifeConflict } }
}

/** Refuse a record that is too large to store safely, before it reaches the disk. */
export function assertRecordSize(record: LifeRecord): void {
  const size = Buffer.byteLength(JSON.stringify(record), 'utf8')
  if (size > LIFE_LIMITS.maxRecordBytes) {
    throw new LifeStoreError(
      'too-large',
      `a Life record of ${size} bytes exceeds the ${LIFE_LIMITS.maxRecordBytes} byte limit`,
    )
  }
}

/**
 * The effective status of an entry: a conflict edge overrides `live`, and a
 * withdrawal is final.
 *
 * Computed rather than stored so that disclosing a conflict never rewrites either
 * side, and so that a withdrawn entry stays withdrawn even if a stale conflict
 * edge still names it.
 */
export function effectiveStatus(
  entry: LifeEntry,
  conflicts: Iterable<LifeConflict>,
): 'live' | 'conflicted' | 'withdrawn' {
  if (entry.status === 'withdrawn') return 'withdrawn'
  for (const conflict of conflicts) {
    if (conflict.entryA === entry.entryId || conflict.entryB === entry.entryId) return 'conflicted'
  }
  return 'live'
}

/** The entries a conflict edge names, for projection and tests. */
export function conflictPartners(state: LifeState, entryId: string): LifeConflict[] {
  const out: LifeConflict[] = []
  for (const conflict of state.conflicts.values()) {
    if (conflict.entryA === entryId || conflict.entryB === entryId) out.push(conflict)
  }
  return out
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}

function isText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max
}

function isInstant(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isReference(value: unknown): value is LifeReference {
  if (typeof value !== 'object' || value === null) return false
  const reference = value as Record<string, unknown>
  return (
    isLifeSourceDomain(reference.domain) &&
    isLifeRefKind(reference.refKind) &&
    isId(reference.refId) &&
    (reference.label === null || isText(reference.label, LIFE_LIMITS.maxReferenceLabelChars))
  )
}

function isRevisionRef(value: unknown): value is LifeRevisionRef {
  if (typeof value !== 'object' || value === null) return false
  const revision = value as Record<string, unknown>
  return (
    isPositiveInt(revision.revision) &&
    isInstant(revision.at) &&
    isText(revision.reason, LIFE_LIMITS.maxReasonChars) &&
    typeof revision.supersededContentHash === 'string' &&
    revision.supersededContentHash.length > 0 &&
    revision.supersededContentHash.length <= 128
  )
}

function isProvenance(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const provenance = value as Record<string, unknown>
  return (
    isLifeSourceDomain(provenance.sourceDomain) &&
    (provenance.sourceId === null || isId(provenance.sourceId)) &&
    isInstant(provenance.observedAt) &&
    isInstant(provenance.recordedAt) &&
    typeof provenance.actor === 'string' &&
    provenance.actor.length > 0 &&
    provenance.actor.length <= 128 &&
    isLifeDerivation(provenance.derivation) &&
    isConfidence(provenance.confidence)
  )
}

/** Exposed so a caller can compare a stored confidence to a class ceiling. */
export { CONFIDENCE_RANK }
