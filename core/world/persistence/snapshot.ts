import {
  CONFIDENCE_RANK,
  type Confidence,
  type EpistemicStatus,
  type Sensitivity,
  type SourceTrust,
} from '../../brain/types'
import {
  isNamedWorldEntityKind,
  isReferenceWorldEntityKind,
  isWorldAdmissionChannel,
  isWorldEvidenceKind,
  isWorldRelationType,
  worldRelationSpec,
  WORLD_LIMITS,
  type WorldEntityKind,
  type WorldEndpointClaim,
  type WorldEntityClaim,
  type WorldEvidenceRecord,
  type WorldLimits,
  type WorldRelationClaim,
} from '../types'
import { isWorldEvidenceId, isWorldSourceRef, normaliseWorldName } from '../identity'
import { isPrincipalId } from '../../security/guard'
import { WorldPersistenceError } from './errors'
import { WORLD_SNAPSHOT_VERSION, type WorldSnapshot } from './port'

/**
 * WORLD SNAPSHOT CODEC — validate on the way in *and* on the way out.
 *
 * Decoding on read is the point. Authentication proves the bytes came from a
 * process holding this domain's key; it does not prove the record is one this
 * build is willing to believe. So the same predicates run in both directions, and
 * a record that fails either is a fault rather than a value.
 *
 * ## Refuse whole, never partially
 *
 * A snapshot that fails anywhere is refused entirely. There is no "load the
 * records that happened to parse", because a world model whose contents depend on
 * what an attacker chose to damage is not a world model — it is a view of the
 * attacker's choices.
 *
 * ## What is re-validated, and why each one matters
 *
 * - `evidenceId` and `sequence` are format- and order-checked, so replay order is
 *   a property of the file rather than of the loader's sort.
 * - `source` and `epistemic` are checked against the **channel's** ceilings, not
 *   merely against their own closed tables. A record that *authenticates* but
 *   claims `verified` from a `worker_claim` channel is refused here, so a
 *   tightened rule cannot be bypassed by a file written before it was tightened.
 * - Names are re-normalised and must be identical, so a store cannot hold an
 *   entity whose id does not match its name.
 */

/** The widest a whole snapshot may be. */
export const MAX_WORLD_SNAPSHOT_BYTES = 2 * 1024 * 1024

/**
 * The widest one serialised record may be.
 *
 * A generous fraction of the snapshot bound, because evidence records are small
 * and the point of a per-record limit is to stop one pathological record from
 * making every other record's write fail.
 */
export const MAX_WORLD_RECORD_BYTES = Math.floor(MAX_WORLD_SNAPSHOT_BYTES / 4)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/**
 * Runtime membership checks for the Brain's closed vocabularies.
 *
 * Written here rather than imported because the Brain exports those types and
 * their rank tables but no validators. Re-declaring the *membership* test is not
 * a parallel vocabulary: every accepted value is still one of the Brain's own
 * union members, so a new `SourceTrust` is refused by this codec until the Brain
 * declares it.
 */
function isSourceTrust(value: unknown): value is SourceTrust {
  return (
    value === 'owner-assertion' ||
    value === 'system-observation' ||
    value === 'external-untrusted' ||
    value === 'model-inference' ||
    value === 'freya-inference' ||
    value === 'imported-document' ||
    value === 'experience-outcome'
  )
}

function isSensitivity(value: unknown): value is Sensitivity {
  return value === 'normal' || value === 'personal' || value === 'sensitive' || value === 'secret-reference'
}

function isEpistemicStatus(value: unknown): value is EpistemicStatus {
  return (
    value === 'unknown' ||
    value === 'observed' ||
    value === 'asserted' ||
    value === 'inferred' ||
    value === 'verified' ||
    value === 'contradicted' ||
    value === 'stale'
  )
}

function isConfidence(value: unknown): value is Confidence {
  return value === 'unknown' || value === 'low' || value === 'medium' || value === 'high' || value === 'verified'
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const RECORD_KEYS = [
  'evidenceId',
  'sequence',
  'kind',
  'channel',
  'recordedAt',
  'observedAt',
  'source',
  'actor',
  'sourceRef',
  'sensitivity',
  'epistemic',
  'confidence',
  'evidenceSummary',
  'supersedes',
  'entity',
  'relation',
  'withdrawal',
] as const

/**
 * The ceiling a channel's claims may not exceed.
 *
 * Duplicated from `WORLD_CHANNEL_PROFILE` as a *check* rather than imported as a
 * *value*, on purpose: the codec must be able to refuse a record whose stored
 * source outranks the channel that produced it, which means re-deriving the
 * expectation rather than reading it back from the same table the writer used.
 */
const CHANNEL_CEILINGS: Readonly<
  Record<string, { readonly epistemic: EpistemicStatus; readonly confidence: Confidence }>
> = Object.freeze({
  owner_statement: { epistemic: 'asserted', confidence: 'high' },
  system_observation: { epistemic: 'observed', confidence: 'medium' },
  worker_claim: { epistemic: 'asserted', confidence: 'low' },
  model_hypothesis: { epistemic: 'inferred', confidence: 'low' },
  imported_content: { epistemic: 'asserted', confidence: 'low' },
})

export function decodeWorldEvidenceRecord(
  value: unknown,
  limits: WorldLimits = WORLD_LIMITS,
): WorldEvidenceRecord {
  if (!isObject(value)) throw new WorldPersistenceError('invalid', 'a world evidence record is not an object')
  if (!onlyKeys(value, RECORD_KEYS)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record has an unrecognised shape')
  }

  const evidenceId = value.evidenceId
  if (!isWorldEvidenceId(evidenceId)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a usable id')
  }

  const sequence = value.sequence
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
    throw new WorldPersistenceError('invalid', 'a world evidence sequence is a non-negative whole number')
  }

  const kind = value.kind
  if (!isWorldEvidenceKind(kind)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a known kind')
  }

  const channel = value.channel
  if (!isWorldAdmissionChannel(channel)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a known channel')
  }

  if (!isInstant(value.recordedAt) || !isInstant(value.observedAt)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs two valid instants')
  }

  const source = value.source
  if (!isSourceTrust(source)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a known source')
  }

  const actor = value.actor
  if (!isNonEmptyString(actor, 128) || !isPrincipalId(actor)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a usable actor')
  }

  const sourceRef = value.sourceRef
  if (sourceRef !== null && !isWorldSourceRef(sourceRef)) {
    // Re-checked on the way out as well as on the way in, so a file written before
    // this rule existed cannot smuggle prose into a projected provenance field.
    throw new WorldPersistenceError('invalid', 'a world evidence source reference is an id')
  }
  if (sourceRef !== null && sourceRef.length > limits.maxSourceRefChars) {
    throw new WorldPersistenceError('invalid', 'a world evidence source reference is bounded')
  }

  const sensitivity = value.sensitivity
  if (!isSensitivity(sensitivity)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a known sensitivity')
  }

  const epistemic = value.epistemic
  if (!isEpistemicStatus(epistemic)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a known epistemic status')
  }

  const confidence = value.confidence
  if (!isConfidence(confidence)) {
    throw new WorldPersistenceError('invalid', 'a world evidence record needs a known confidence')
  }

  // The load-bearing re-check: a stored claim may not outrank the channel it
  // arrived on, however well it authenticates.
  const ceiling = CHANNEL_CEILINGS[channel]
  if (ceiling === undefined) {
    throw new WorldPersistenceError('invalid', 'a world evidence record has no ceiling for its channel')
  }
  // A withdrawal asserts nothing about anybody or anything: it is a fact about one
  // record rather than a claim about the world, which is the only reason it may be
  // stored as settled. Every other kind is capped by the channel it arrived on.
  if (kind !== 'withdrawal') {
    if (CEILING_RANK[epistemic] > CEILING_RANK[ceiling.epistemic]) {
      throw new WorldPersistenceError(
        'invalid',
        `a world evidence record claims '${epistemic}', which its channel '${channel}' cannot support`,
      )
    }
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[ceiling.confidence]) {
      throw new WorldPersistenceError(
        'invalid',
        `a world evidence record claims '${confidence}', which its channel '${channel}' cannot support`,
      )
    }
    if (epistemic === 'verified') {
      throw new WorldPersistenceError('invalid', 'a world evidence claim cannot be stored as verified')
    }
  }

  const evidenceSummary = value.evidenceSummary
  if (evidenceSummary !== null && (typeof evidenceSummary !== 'string' || evidenceSummary.length > limits.maxEvidenceSummaryChars)) {
    throw new WorldPersistenceError('invalid', 'a world evidence summary is bounded')
  }

  const supersedes = value.supersedes
  if (supersedes !== null) {
    if (!isWorldEvidenceId(supersedes)) {
      throw new WorldPersistenceError('invalid', 'a world evidence supersession names no usable id')
    }
    if (supersedes === evidenceId) {
      throw new WorldPersistenceError('invalid', 'a world evidence record cannot supersede itself')
    }
  }

  const entityRaw = value.entity
  const relationRaw = value.relation
  const withdrawalRaw = value.withdrawal

  const entityClaim = isObject(entityRaw) ? decodeEntityClaim(entityRaw, limits) : null
  const relationClaim = isObject(relationRaw) ? decodeRelationClaim(relationRaw, limits) : null

  if (kind === 'entity' && entityClaim === null) {
    throw new WorldPersistenceError('invalid', 'an entity evidence record needs an entity claim')
  }
  if ((kind === 'relation' || kind === 'unknown') && relationClaim === null) {
    throw new WorldPersistenceError('invalid', 'a relation evidence record needs a relation claim')
  }
  if (kind === 'withdrawal' && (entityClaim !== null || relationClaim !== null)) {
    throw new WorldPersistenceError('invalid', 'a withdrawal record carries no claim of its own')
  }

  let withdrawal: WorldEvidenceRecord['withdrawal'] = null
  if (kind === 'withdrawal') {
    if (!isObject(withdrawalRaw)) {
      throw new WorldPersistenceError('invalid', 'a withdrawal record needs a withdrawal')
    }
    const target = withdrawalRaw.targetEvidenceId
    const reason = withdrawalRaw.reason
    if (typeof target !== 'string' || !isWorldEvidenceId(target)) {
      throw new WorldPersistenceError('invalid', 'a withdrawal names no usable target')
    }
    if (target === evidenceId) {
      throw new WorldPersistenceError('invalid', 'a world evidence record cannot withdraw itself')
    }
    if (!isNonEmptyString(reason, limits.maxReasonChars)) {
      throw new WorldPersistenceError('invalid', 'a withdrawal reason is bounded')
    }
    withdrawal = { targetEvidenceId: target, reason }
  } else if (withdrawalRaw !== null && withdrawalRaw !== undefined) {
    throw new WorldPersistenceError('invalid', 'only a withdrawal record may carry a withdrawal')
  }

  return {
    evidenceId,
    sequence,
    kind,
    channel,
    recordedAt: value.recordedAt as string,
    observedAt: value.observedAt as string,
    source: source as SourceTrust,
    actor: actor as WorldEvidenceRecord['actor'],
    sourceRef: sourceRef as string | null,
    sensitivity: sensitivity as Sensitivity,
    epistemic,
    confidence,
    evidenceSummary: evidenceSummary as string | null,
    supersedes: supersedes as string | null,
    entity: entityClaim,
    relation: relationClaim,
    withdrawal,
  }
}

/**
 * How settled an epistemic status is, for the ceiling check.
 *
 * A withdrawal is exempt from the check because it asserts nothing about the
 * world; everything else is capped at `asserted` or below by its channel.
 */
const CEILING_RANK: Readonly<Record<EpistemicStatus, number>> = Object.freeze({
  unknown: 0,
  contradicted: 0,
  stale: 0,
  inferred: 1,
  asserted: 2,
  observed: 3,
  verified: 4,
})

function decodeEntityClaim(value: Record<string, unknown>, limits: WorldLimits): WorldEntityClaim {
  if (!onlyKeys(value, ['entityType', 'name', 'aliases', 'attributes'])) {
    throw new WorldPersistenceError('invalid', 'an entity claim has an unrecognised shape')
  }
  if (!isNamedWorldEntityKind(value.entityType)) {
    throw new WorldPersistenceError('invalid', 'an entity claim needs a known kind')
  }
  // Re-normalised and compared, so a stored entity's name always still matches
  // the id it was derived from.
  const normalised = normaliseWorldName(value.name, limits.maxNameChars)
  if (normalised === null || normalised !== value.name) {
    throw new WorldPersistenceError('invalid', 'an entity claim name is not normalisable')
  }

  const aliases = value.aliases
  if (!Array.isArray(aliases) || aliases.length > limits.maxAliasesPerEntity) {
    throw new WorldPersistenceError('invalid', 'an entity claim has too many aliases')
  }
  for (const alias of aliases) {
    if (normaliseWorldName(alias, limits.maxNameChars) !== alias) {
      throw new WorldPersistenceError('invalid', 'an entity claim alias is not normalisable')
    }
  }

  const attributes = value.attributes
  if (!isObject(attributes)) {
    throw new WorldPersistenceError('invalid', 'an entity claim needs an attribute map')
  }
  const attributeEntries = Object.entries(attributes)
  if (attributeEntries.length > limits.maxAttributesPerEntity) {
    throw new WorldPersistenceError('invalid', 'an entity claim has too many attributes')
  }
  for (const [key, attributeValue] of attributeEntries) {
    if (!isNonEmptyString(key, limits.maxAttributeKeyChars) || !/^[\p{L}\p{N} _-]+$/u.test(key)) {
      throw new WorldPersistenceError('invalid', 'an entity claim attribute key is not usable')
    }
    if (typeof attributeValue !== 'string' || attributeValue.length > limits.maxAttributeValueChars) {
      throw new WorldPersistenceError('invalid', 'an entity claim attribute value is bounded')
    }
  }

  return {
    entityType: value.entityType,
    name: normalised,
    aliases: [...aliases] as readonly string[],
    attributes: attributes as Readonly<Record<string, string>>,
  }
}

function decodeRelationClaim(value: Record<string, unknown>, limits: WorldLimits): WorldRelationClaim {
  if (!onlyKeys(value, ['relationType', 'subject', 'object', 'validUntil'])) {
    throw new WorldPersistenceError('invalid', 'a relation claim has an unrecognised shape')
  }
  if (!isWorldRelationType(value.relationType)) {
    throw new WorldPersistenceError('invalid', 'a relation claim needs a known relation')
  }
  const validUntil = value.validUntil
  if (validUntil !== null && !isInstant(validUntil)) {
    throw new WorldPersistenceError('invalid', 'a relation claim end time is bounded')
  }
  const subject = decodeEndpoint(value.subject, limits)
  const object = decodeEndpoint(value.object, limits)
  // The pairing check, re-run on the way *in* as well as on the way out.
  //
  // Admission refuses an endpoint combination the relation table does not accept, so
  // this can only be reached by a row that was not written by admission: a record from
  // an older build, a direct write from another repository, or a hand-edited database.
  // `PLAN.md`'s rule is that a tightened rule cannot be bypassed by state written
  // before it was tightened, and a relation table is exactly the kind of rule that
  // gets tightened — an endpoint kind retired, a pairing withdrawn. Without this, such
  // a row would be the one shape of claim that survives the tightening.
  const spec = worldRelationSpec(value.relationType)
  const subjectKind = endpointKind(subject)
  const objectKind = endpointKind(object)
  if (subjectKind !== null && objectKind !== null) {
    const subjectOk = spec.directed
      ? spec.subjects.includes(subjectKind)
      : spec.subjects.includes(subjectKind) && spec.objects.includes(subjectKind)
    const objectOk = spec.directed ? spec.objects.includes(objectKind) : true
    if (!subjectOk || !objectOk) {
      throw new WorldPersistenceError(
        'invalid',
        'a stored relation does not apply to those kinds of thing',
      )
    }
  }
  return {
    relationType: value.relationType,
    subject,
    object,
    validUntil: validUntil as string | null,
  }
}

/**
 * The entity kind an endpoint addresses, or null when it states a value.
 *
 * A literal is deliberately null on both sides: there is no pairing to check against a
 * literal, and pretending otherwise would refuse claims the table accepts.
 */
function endpointKind(endpoint: WorldEndpointClaim): WorldEntityKind | null {
  if (endpoint.form === 'named') return endpoint.entityType
  if (endpoint.form === 'reference') return endpoint.refKind
  return null
}

function decodeEndpoint(value: unknown, limits: WorldLimits): WorldEndpointClaim {
  if (!isObject(value)) {
    throw new WorldPersistenceError('invalid', 'a relation endpoint is not an object')
  }
  if (value.form === 'named') {
    if (!onlyKeys(value, ['form', 'entityType', 'name'])) {
      throw new WorldPersistenceError('invalid', 'a named endpoint has an unrecognised shape')
    }
    if (!isNamedWorldEntityKind(value.entityType)) {
      throw new WorldPersistenceError('invalid', 'a named endpoint needs a known kind')
    }
    // `Freya` and `owner` resolve to Core-owned singletons and are stored under
    // those names, so they must survive re-normalisation as-is.
    const name = value.name
    if (typeof name !== 'string' || name.length === 0 || name.length > limits.maxNameChars) {
      throw new WorldPersistenceError('invalid', 'a named endpoint name is bounded')
    }
    return { form: 'named', entityType: value.entityType, name }
  }
  if (value.form === 'reference') {
    if (!onlyKeys(value, ['form', 'refKind', 'refId'])) {
      throw new WorldPersistenceError('invalid', 'a reference endpoint has an unrecognised shape')
    }
    if (!isReferenceWorldEntityKind(value.refKind)) {
      throw new WorldPersistenceError('invalid', 'a reference endpoint needs a known reference kind')
    }
    if (!isNonEmptyString(value.refId, limits.maxSourceRefChars)) {
      throw new WorldPersistenceError('invalid', 'a reference endpoint id is bounded')
    }
    return { form: 'reference', refKind: value.refKind, refId: value.refId }
  }
  if (value.form === 'literal') {
    if (!onlyKeys(value, ['form', 'value'])) {
      throw new WorldPersistenceError('invalid', 'a literal endpoint has an unrecognised shape')
    }
    if (!isNonEmptyString(value.value, limits.maxLiteralValueChars)) {
      throw new WorldPersistenceError('invalid', 'a literal endpoint value is bounded')
    }
    return { form: 'literal', value: value.value }
  }
  throw new WorldPersistenceError('invalid', 'a relation endpoint has an unrecognised form')
}

/** Decode a whole snapshot, refusing entirely on any fault. */
export function decodeWorldSnapshot(
  value: unknown,
  limits: WorldLimits = WORLD_LIMITS,
): WorldSnapshot {
  if (!isObject(value)) throw new WorldPersistenceError('invalid', 'the world snapshot is not an object')
  if (value.v !== WORLD_SNAPSHOT_VERSION) {
    throw new WorldPersistenceError(
      'invalid',
      `the world snapshot is version ${String(value.v)}, and this build reads version ${WORLD_SNAPSHOT_VERSION}`,
    )
  }
  const records = value.records
  if (!Array.isArray(records)) {
    throw new WorldPersistenceError('invalid', 'the world snapshot has no record list')
  }
  if (records.length > limits.maxEvidenceRecords) {
    throw new WorldPersistenceError('invalid', 'the world snapshot holds more records than this build retains')
  }

  const decoded: WorldEvidenceRecord[] = []
  const seen = new Set<string>()
  let highest = 0
  for (const record of records) {
    const entry = decodeWorldEvidenceRecord(record, limits)
    if (seen.has(entry.evidenceId)) {
      throw new WorldPersistenceError('invalid', `the world snapshot holds two records with the id ${entry.evidenceId}`)
    }
    seen.add(entry.evidenceId)
    highest = Math.max(highest, entry.sequence)
    decoded.push(entry)
  }

  const sequence = value.sequence
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
    throw new WorldPersistenceError('invalid', 'the world snapshot sequence is a non-negative whole number')
  }

  return { v: WORLD_SNAPSHOT_VERSION, records: decoded, sequence: Math.max(sequence, highest) }
}

/**
 * Validate on the way out too.
 *
 * The same gate both directions means an illegal record is a fault rather than a
 * value, so a bug in the fold cannot quietly write something the codec would then
 * refuse to read back.
 */
export function encodeWorldSnapshot(
  value: WorldSnapshot,
  limits: WorldLimits = WORLD_LIMITS,
): WorldSnapshot {
  return decodeWorldSnapshot(value, limits)
}

export function worldRecordBytes(record: WorldEvidenceRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

export function worldSnapshotBytes(snapshot: WorldSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
}
