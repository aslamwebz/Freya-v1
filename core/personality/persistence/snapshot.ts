/**
 * THE RECOVERY GATE.
 *
 * Everything that comes off disk is checked here before a single byte of it is
 * believed, and every refusal is a refusal of the *whole* snapshot.
 *
 * ## Why an authenticated record still has to be validated
 *
 * An AES tag proves that whoever wrote a record held the Personality key. It
 * says nothing about whether the record is a legal `RelationshipItem`: a bug
 * in a future writer, a file assembled by hand from two valid records, or a
 * writer that had the key and wrote nonsense all produce records that
 * authenticate perfectly. Handing such a record to the domain would mean the
 * domain's closed tables — the kind vocabulary, the status ladder, the
 * confidence ceiling — are enforced on the way *in* to a store but not on
 * the way *back out of storage*, which is the one direction where a stale or
 * hostile file gets to choose.
 *
 * So each record is re-checked against `../types` here: the kind must be a
 * kind this build recognises, the status must be in the closed ladder, the
 * confidence must be a valid category, the provenance must carry a known
 * source, the instants must parse, and the key must be a code-owned slug.
 *
 * ## Why the refusal is total
 *
 * Recovery is all-or-nothing on purpose. A store that served the records it
 * could parse and quietly dropped the rest would make its contents a function
 * of which records an attacker chose to damage, and — worse — would present
 * "we lost three items" as "there is nothing here". Every code path out of
 * this module ends the same way: refuse the snapshot, say why in words, and
 * let the caller hold an empty store that says it is degraded.
 */

import {
  CONFIDENCE_RANK,
  type Confidence,
  type Provenance,
  type SourceTrust,
} from '../../brain/types'
import { hasExactKeys } from '../../hands/validation'
import {
  PERSONALITY_LIMITS,
  RELATIONSHIP_STATUSES,
  isCueKind,
  isRelationshipItemKind,
  isSlug,
  type CueUsageEntry,
  type CueUsageLedger,
  type RelationshipItem,
  type RelationshipStatus,
} from '../types'
import {
  PERSONALITY_SNAPSHOT_VERSION,
  type PersonalitySnapshot,
} from './port'
import { PersonalityPersistenceError, isPersonalityPersistenceError } from './errors'

/**
 * The largest one record may be on the wire.
 *
 * Derived rather than guessed: admission caps text at 2,000 *characters*, and
 * UTF-8 costs at most 4 bytes each, so a legal record's plaintext cannot
 * exceed roughly 12 KB, which base64s to about 16 KB. This is twice that.
 */
export const MAX_PERSONALITY_RECORD_BYTES = 64 * 1024

/**
 * The largest whole snapshot this build will write or read.
 *
 * `maxRelationshipItems` (256) times the per-record ceiling, rounded up with
 * room to spare.
 */
export const MAX_PERSONALITY_SNAPSHOT_BYTES = 4 * 1024 * 1024

function refuse(reason: string): never {
  throw new PersonalityPersistenceError('corrupt', reason)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

/**
 * The exact keys a stored relationship item must carry.
 *
 * Same as RELATIONSHIP_ITEM_KEYS from the domain, restated here so the gate
 * is self-contained and a format change in one place cannot silently widen
 * the other.
 */
const STORED_ITEM_KEYS: readonly string[] = [
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
]

/**
 * The exact keys a stored provenance must carry.
 */
const STORED_PROVENANCE_KEYS: readonly string[] = [
  'sourceType',
  'sourceRef',
  'observedAt',
  'recordedAt',
  'actor',
  'verificationStatus',
  'confidence',
  'evidenceSummary',
]

/**
 * The exact keys a stored cue usage entry must carry.
 */
const STORED_LEDGER_ENTRY_KEYS: readonly string[] = [
  'cueHash',
  'kind',
  'lastUsedAt',
  'uses',
]

/**
 * The exact keys a stored ledger must carry.
 */
const STORED_LEDGER_KEYS: readonly string[] = [
  'schemaVersion',
  'maxEntries',
  'entries',
]

/** Known trust classes for provenance validation. */
const KNOWN_SOURCES: readonly string[] = [
  'owner-assertion',
  'system-observation',
  'experience-outcome',
  'freya-inference',
  'model-inference',
  'external-untrusted',
  'imported-document',
]

/**
 * The closed set of confidence values this build accepts for personality data.
 *
 * Derived from the Brain's confidence ladder, excluding `verified` — the
 * personality domain's own ceiling. A relationship item is a record of what
 * was said or seen, not a settled truth, and no persisted record may claim
 * the highest confidence category.
 */
const ALLOWED_CONFIDENCE: readonly string[] = Object.keys(CONFIDENCE_RANK).filter(
  (key) => key !== 'verified',
)

/**
 * The reserved record id for the ledger.
 *
 * A relationship item may never use this id, because the ledger record occupies
 * it in the encrypted store. Checked here so a hand-written file cannot smuggle
 * a second ledger in as a normal item.
 */
export const LEDGER_RECORD_ID = '__ledger__'

/**
 * Check one record, and return it as a fresh `RelationshipItem`.
 *
 * A *fresh* object rather than the parsed one, because the parsed object is
 * whatever was in the file: it may carry extra fields, and those fields would
 * then travel through the domain and back onto disk for ever. Rebuilding from
 * named fields is subtraction by construction — there is no path by which a
 * field the domain does not know about survives a round trip.
 */
export function decodePersonalityItem(value: unknown): RelationshipItem {
  if (!isObject(value)) refuse('a personality record is not an object')
  if (!hasExactKeys(value, STORED_ITEM_KEYS)) {
    refuse('a personality record has keys that do not match the closed shape')
  }

  const itemId = value['itemId']
  if (
    typeof itemId !== 'string' ||
    itemId.length === 0 ||
    itemId.length > PERSONALITY_LIMITS.maxItemIdChars
  ) {
    refuse('a personality record has no usable id')
  }
  if (itemId === LEDGER_RECORD_ID) {
    refuse(`a personality record uses the reserved ledger id ${LEDGER_RECORD_ID}`)
  }

  const kind = value['kind']
  if (!isRelationshipItemKind(kind)) {
    refuse('a personality record has a kind this build does not know')
  }

  const key = value['key']
  if (!isSlug(key) || key.length > PERSONALITY_LIMITS.maxItemKeyChars) {
    refuse('a personality record has a key that is not a code-owned slug')
  }

  const text = value['text']
  if (typeof text !== 'string' || text.length > PERSONALITY_LIMITS.maxItemTextChars) {
    refuse('a personality record has text that is not a legal length')
  }

  const tags = value['tags']
  if (!Array.isArray(tags) || tags.length > PERSONALITY_LIMITS.maxTagsPerItem) {
    refuse('a personality record has tags that are not a bounded list')
  }
  for (const tag of tags) {
    if (!isSlug(tag) || tag.length > PERSONALITY_LIMITS.maxTagChars) {
      refuse('a personality record has a tag that is not a code-owned slug')
    }
  }

  const cueKind = value['cueKind']
  if (cueKind !== null && !isCueKind(cueKind)) {
    refuse('a personality record has a cue kind that is not in the closed vocabulary')
  }

  const provenance = decodeProvenance(value['provenance'], itemId)

  const confidence = value['confidence']
  if (
    typeof confidence !== 'string' ||
    !ALLOWED_CONFIDENCE.includes(confidence)
  ) {
    refuse('a personality record has a confidence that is not a valid category')
  }

  const status = value['status']
  if (
    typeof status !== 'string' ||
    !(RELATIONSHIP_STATUSES as readonly string[]).includes(status)
  ) {
    refuse('a personality record has a status that is not in the closed ladder')
  }

  const admittedAt = value['admittedAt']
  if (admittedAt !== null && !isInstant(admittedAt)) {
    refuse('a personality record has an admission time that is not a time')
  }

  const admissionReason = value['admissionReason']
  if (admissionReason !== null) {
    if (typeof admissionReason !== 'string' || admissionReason.trim().length === 0) {
      refuse('a personality record has an admission reason that is empty')
    }
    if (admissionReason.length > PERSONALITY_LIMITS.maxReasonChars) {
      refuse('a personality record has an admission reason that is too long')
    }
  }

  // A retired item must have its text destroyed. A tombstone whose text was
  // never destroyed is a record whose text somebody believed was gone.
  if (status === 'retired' && text !== '') {
    refuse(`personality record ${itemId} was retired but still holds its text`)
  }

  return {
    itemId,
    kind,
    key,
    text,
    tags: Object.freeze([...tags] as readonly string[]),
    cueKind,
    provenance,
    confidence: confidence as Confidence,
    status: status as RelationshipStatus,
    admittedAt,
    admissionReason,
  }
}

function decodeProvenance(value: unknown, itemId: string): Provenance {
  if (!isObject(value)) refuse(`personality record ${itemId} has no provenance`)
  if (!hasExactKeys(value, STORED_PROVENANCE_KEYS)) {
    refuse(`personality record ${itemId} has provenance that does not match the closed shape`)
  }

  const sourceType = value['sourceType']
  if (
    typeof sourceType !== 'string' ||
    !KNOWN_SOURCES.includes(sourceType)
  ) {
    refuse(`personality record ${itemId} names a source this build does not know`)
  }

  const sourceRef = value['sourceRef']
  if (sourceRef !== null && (typeof sourceRef !== 'string' || sourceRef.length === 0)) {
    refuse(`personality record ${itemId} has a source reference that is not an id`)
  }

  const observedAt = value['observedAt']
  if (!isInstant(observedAt)) {
    refuse(`personality record ${itemId} has no usable observed time`)
  }

  const recordedAt = value['recordedAt']
  if (!isInstant(recordedAt)) {
    refuse(`personality record ${itemId} has no usable recorded time`)
  }

  const actor = value['actor']
  if (typeof actor !== 'string' || actor.length === 0 || actor.length > PERSONALITY_LIMITS.maxActorChars) {
    refuse(`personality record ${itemId} has an actor that is not usable`)
  }

  const verificationStatus = value['verificationStatus']
  if (
    typeof verificationStatus !== 'string' ||
    !['asserted', 'observed', 'inferred'].includes(verificationStatus)
  ) {
    refuse(`personality record ${itemId} has a verification status that is not valid`)
  }

  const confidence = value['confidence']
  if (
    typeof confidence !== 'string' ||
    !ALLOWED_CONFIDENCE.includes(confidence)
  ) {
    refuse(`personality record ${itemId} has a confidence that is not a valid category`)
  }

  const evidenceSummary = value['evidenceSummary']
  if (evidenceSummary !== null && typeof evidenceSummary !== 'string') {
    refuse(`personality record ${itemId} has an evidence summary that is not a string or null`)
  }

  return {
    sourceType: sourceType as SourceTrust,
    sourceRef: sourceRef as string | null,
    observedAt: observedAt as string,
    recordedAt: recordedAt as string,
    actor: actor as string,
    verificationStatus: verificationStatus as Provenance['verificationStatus'],
    confidence: confidence as Confidence,
    evidenceSummary: evidenceSummary as string | null,
  }
}

/**
 * Check one ledger entry, and return it as a fresh `CueUsageEntry`.
 */
export function decodeLedgerEntry(value: unknown): CueUsageEntry {
  if (!isObject(value)) refuse('a ledger entry is not an object')
  if (!hasExactKeys(value, STORED_LEDGER_ENTRY_KEYS)) {
    refuse('a ledger entry has keys that do not match the closed shape')
  }

  const cueHash = value['cueHash']
  if (typeof cueHash !== 'string' || cueHash.length === 0) {
    refuse('a ledger entry has no usable cue hash')
  }

  const kind = value['kind']
  if (!isCueKind(kind)) {
    refuse('a ledger entry has a kind that is not in the closed vocabulary')
  }

  const lastUsedAt = value['lastUsedAt']
  if (!isInstant(lastUsedAt)) {
    refuse('a ledger entry has no usable last-used time')
  }

  const uses = value['uses']
  if (typeof uses !== 'number' || !Number.isInteger(uses) || uses < 0) {
    refuse('a ledger entry has a use count that is not a non-negative integer')
  }

  return {
    cueHash,
    kind,
    lastUsedAt: lastUsedAt as string,
    uses,
  }
}

/**
 * Check the ledger, and return it as a fresh `CueUsageLedger`.
 */
export function decodeLedger(value: unknown): CueUsageLedger {
  if (!isObject(value)) refuse('the stored ledger is not an object')
  if (!hasExactKeys(value, STORED_LEDGER_KEYS)) {
    refuse('the stored ledger has keys that do not match the closed shape')
  }

  const schemaVersion = value['schemaVersion']
  if (schemaVersion !== 1) {
    refuse(`the stored ledger is version ${String(schemaVersion)}, and this build reads version 1`)
  }

  const maxEntries = value['maxEntries']
  if (
    typeof maxEntries !== 'number' ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 0 ||
    maxEntries > PERSONALITY_LIMITS.maxLedgerEntries
  ) {
    refuse('the stored ledger has a max entries value that is not usable')
  }

  const entries = value['entries']
  if (!Array.isArray(entries)) refuse('the stored ledger has no entry list')
  if (entries.length > maxEntries) {
    refuse(`the stored ledger holds ${entries.length} entries, and its maximum is ${maxEntries}`)
  }

  const decoded: CueUsageEntry[] = []
  for (const entry of entries) {
    decoded.push(decodeLedgerEntry(entry))
  }

  return {
    schemaVersion: 1,
    maxEntries,
    entries: Object.freeze(decoded),
  }
}

/**
 * Check a whole snapshot off disk, and return it as records this build accepts.
 *
 * Refuses rather than coerces: an unknown top-level shape, a version from the
 * future, a record count above the retention bound, a duplicate id and a
 * record that fails {@link decodePersonalityItem} all end here, as one total
 * refusal.
 */
export function decodePersonalitySnapshot(value: unknown): PersonalitySnapshot {
  if (!isObject(value)) refuse('the stored personality data is not an object')
  if (value['v'] !== PERSONALITY_SNAPSHOT_VERSION) {
    refuse(
      `the stored personality data is version ${String(value['v'])}, and this build reads version ${PERSONALITY_SNAPSHOT_VERSION}`,
    )
  }

  const items = value['items']
  if (!Array.isArray(items)) refuse('the stored personality data has no item list')
  if (items.length > PERSONALITY_LIMITS.maxRelationshipItems) {
    refuse(
      `the stored personality data holds ${items.length} items, and this build retains at most ${PERSONALITY_LIMITS.maxRelationshipItems}`,
    )
  }

  const seen = new Set<string>()
  const accepted: RelationshipItem[] = []
  for (const record of items) {
    const item = decodePersonalityItem(record)
    if (seen.has(item.itemId)) {
      refuse(`the stored personality data holds two records with the id ${item.itemId}`)
    }
    seen.add(item.itemId)
    accepted.push(item)
  }

  const ledger = decodeLedger(value['ledger'])

  return { v: PERSONALITY_SNAPSHOT_VERSION, items: accepted, ledger }
}

/**
 * Check a snapshot a caller is trying to commit, and return its records.
 *
 * The same gate on the way out as on the way in.
 */
export function encodePersonalitySnapshot(value: PersonalitySnapshot): PersonalitySnapshot {
  if (!isObject(value)) {
    throw new PersonalityPersistenceError('invalid', 'a personality snapshot must be an object')
  }
  if (!Array.isArray(value.items)) {
    throw new PersonalityPersistenceError('invalid', 'a personality snapshot must carry an item list')
  }
  try {
    return decodePersonalitySnapshot({ v: PERSONALITY_SNAPSHOT_VERSION, items: value.items, ledger: value.ledger })
  } catch (error) {
    if (isPersonalityPersistenceError(error)) {
      throw new PersonalityPersistenceError('invalid', `refusing to write personality data: ${error.message}`)
    }
    throw error
  }
}

/**
 * How many bytes this snapshot serialises to.
 */
export function personalitySnapshotBytes(snapshot: PersonalitySnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
}
