import {
  CONTEXT_KIND_SOURCES,
  CONTEXT_LIMITS,
  contextLimits,
  isContextKind,
  isContextScopeKind,
  isContextSource,
  type ContextItem,
  type ContextLimits,
  type ContextProvenance,
  type ContextScope,
} from '../types'
import { CONTEXT_SNAPSHOT_VERSION, type ContextSnapshot } from './port'
import { ContextPersistenceError, isContextPersistenceError } from './errors'

/**
 * THE RECOVERY GATE.
 *
 * Everything that comes off disk is checked here before a single byte of it is
 * believed, and every refusal is a refusal of the *whole* snapshot.
 *
 * ## Why an authenticated record still has to be validated
 *
 * An AES tag proves that whoever wrote a record held the Context key. It says
 * nothing about whether the record is a legal `ContextItem`: a bug in a future
 * writer, a file assembled by hand from two valid records, or a writer that had
 * the key and wrote nonsense all produce records that authenticate perfectly.
 * Handing such a record to the domain would mean the domain's closed tables —
 * the kind/source table, the scope vocabulary, the TTL ceiling — are enforced on
 * the way *in* to a store but not on the way *back out of storage*, which is the
 * one direction where a stale or hostile file gets to choose.
 *
 * So each record is re-checked against `../types` here: the kind must be a kind
 * this build sources (a deferred kind on disk would be a record claiming to be
 * something it is not), the *pairing* of kind and source must be one
 * `CONTEXT_KIND_SOURCES` admits, the provenance must name an origin wherever the
 * domain would have demanded one, the instants must be ordered the way admission
 * orders them, the scope must be a real scope, and the TTL must lie inside the
 * ceiling no matter which limits wrote it.
 *
 * Each of those is a rule the domain already enforces on the way in. Re-stating
 * them here is not duplication: it is the difference between a rule that a stale
 * file can choose and a rule only a caller can break.
 *
 * ## Why the refusal is total
 *
 * Recovery is all-or-nothing on purpose. A store that served the records it
 * could parse and quietly dropped the rest would make its contents a function of
 * which records an attacker chose to damage, and — worse — would present "we
 * lost three items" as "there is nothing here". Every code path out of this
 * module ends the same way: refuse the snapshot, say why in words, and let the
 * caller hold an empty store that says it is degraded.
 */

/**
 * The largest one record may be on the wire.
 *
 * Derived rather than guessed: admission caps content at 4,000 *characters*, and
 * UTF-8 costs at most 4 bytes each, so a legal record's plaintext cannot exceed
 * roughly 25 KB (content + label + URI), which base64s to about 34 KB. This is
 * twice that, so a legal record never trips the ceiling and an illegal one cannot
 * use the store to write a megabyte.
 */
export const MAX_CONTEXT_RECORD_BYTES = 64 * 1024

/**
 * The largest whole snapshot this build will write or read.
 *
 * `maxItems` (64) times the per-record ceiling, rounded up with room to spare.
 * The domain's own limits are the real bound; this is the independent second
 * gate, so a caller who forgets to normalise cannot turn the encrypted store
 * into an unbounded file — the same reasoning as the Mission record ceiling.
 */
export const MAX_CONTEXT_SNAPSHOT_BYTES = 4 * 1024 * 1024

/** Ids are short and minted by the domain; anything longer is not one. */
const MAX_CONTEXT_ID_CHARS = 256

function refuse(reason: string): never {
  throw new ContextPersistenceError('corrupt', reason)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isMeasure(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Check one record, and return it as a fresh `ContextItem`.
 *
 * A *fresh* object rather than the parsed one, because the parsed object is
 * whatever was in the file: it may carry extra fields, and those fields would
 * then travel through the domain and back onto disk for ever. Rebuilding from
 * named fields is subtraction by construction — there is no path by which a field
 * the domain does not know about survives a round trip.
 */
export function decodeContextItem(value: unknown, limits: ContextLimits): ContextItem {
  if (!isObject(value)) refuse('a context record is not an object')

  const contextId = value['contextId']
  if (
    typeof contextId !== 'string' ||
    contextId.length === 0 ||
    contextId.length > MAX_CONTEXT_ID_CHARS
  ) {
    refuse('a context record has no usable id')
  }

  const kind = value['kind']
  if (!isContextKind(kind)) {
    // Deferred kinds are named rather than lumped in with unknown ones because
    // they are a different failure: `agent_work` is declared for truthful refusal
    // but is still not sourced by this build. (`active_window` became a real kind
    // when the Phase 9 observation lane landed.)
    return refuse(
      kind === 'agent_work'
        ? `a context record claims a kind this build does not source: ${String(kind)}`
        : 'a context record has a kind this build does not know',
    )
  }

  const provenance = decodeProvenance(value['provenance'], contextId, limits)
  // The kind/source table, enforced on the way *back out of storage* as well as on
  // the way in. This is the load-bearing half of provenance: a record naming a
  // pairing the domain would never have admitted — a `current_mission` the host
  // reported, a `shared_tab` Core invented, a `file` from `core_record` — must not
  // survive a restart, or a stale or buggy writer would launder it into the store
  // on the strength of a valid tag. Checked after the kind and the source are each
  // known to be real, so this can only be about the pairing.
  if (!CONTEXT_KIND_SOURCES[kind].includes(provenance.source)) {
    return refuse(
      `context record ${contextId} claims that the kind ${kind} came from the source ${provenance.source}, which this build does not allow`,
    )
  }
  const scope = decodeScope(value['scope'], contextId, limits)

  const content = value['content']
  const label = value['label']
  const uri = value['uri']
  if (typeof content !== 'string' || content.length > limits.maxContentChars) {
    refuse(`context record ${contextId} has content that is not a legal length`)
  }
  if (typeof label !== 'string' || label.length > limits.maxLabelChars) {
    refuse(`context record ${contextId} has a label that is not a legal length`)
  }
  if (uri !== null && (typeof uri !== 'string' || uri.length > limits.maxUriChars)) {
    refuse(`context record ${contextId} has a reference that is not a legal length`)
  }

  const admittedAt = value['admittedAt']
  const expiresAt = value['expiresAt']
  if (!isInstant(admittedAt) || !isInstant(expiresAt)) {
    refuse(`context record ${contextId} does not carry usable instants`)
  }
  const admitted = Date.parse(admittedAt)
  const expires = Date.parse(expiresAt)
  // Measured against the *ceiling*, not the caller's lowered limits: a store
  // opened with a smaller `maxTtlMs` must refuse the record rather than admit it
  // with a shortened TTL and call that recovery. The domain clamps a TTL on the
  // way in, so the ceiling is what makes a clamped record detectable instead of
  // silently mutated by recovery.
  if (expires <= admitted) refuse(`context record ${contextId} does not outlive its own admission`)
  if (expires - admitted > CONTEXT_LIMITS.maxTtlMs) {
    refuse(`context record ${contextId} claims a longer life than this build allows`)
  }
  if (Date.parse(provenance.capturedAt) > admitted) {
    refuse(`context record ${contextId} was captured after it was admitted`)
  }

  const contentLength = value['contentLength']
  const labelLength = value['labelLength']
  if (!isMeasure(contentLength) || !isMeasure(labelLength)) {
    refuse(`context record ${contextId} has no usable measurements`)
  }
  // The measurement was taken at admission, so it survives destruction but never
  // exceeds what was admitted, and an intact private part must still match it.
  if (contentLength < content.length || labelLength < label.length) {
    refuse(`context record ${contextId} is larger than the measurement it carries`)
  }
  if (content !== '' && (contentLength !== content.length || labelLength !== label.length)) {
    refuse(`context record ${contextId} contradicts its own measurements`)
  }

  const revokedAt = value['revokedAt']
  if (revokedAt !== null && !isInstant(revokedAt)) {
    refuse(`context record ${contextId} has a revocation that is not a time`)
  }
  const revocationReason = value['revocationReason']
  if (revocationReason !== null) {
    if (revokedAt === null) {
      refuse(`context record ${contextId} states a reason for a revocation that never happened`)
    }
    if (typeof revocationReason !== 'string' || revocationReason.trim().length === 0) {
      refuse(`context record ${contextId} has a revocation reason that is empty`)
    }
    if (revocationReason.length > limits.maxReasonChars) {
      refuse(`context record ${contextId} has a revocation reason that is too long`)
    }
  }
  // A revocation destroys the private part, always. A record that was taken back
  // and still carries its content is a record whose content somebody believed
  // was gone — and the tombstone existing at all is what makes that checkable.
  if (revokedAt !== null && (content !== '' || label !== '' || uri !== null)) {
    refuse(`context record ${contextId} was revoked but still holds its content`)
  }

  return {
    contextId,
    kind,
    provenance,
    scope,
    label,
    content,
    uri,
    admittedAt,
    expiresAt,
    contentLength,
    labelLength,
    revokedAt,
    revocationReason,
  }
}

function decodeProvenance(value: unknown, contextId: string, limits: ContextLimits): ContextProvenance {
  if (!isObject(value)) refuse(`context record ${contextId} has no provenance`)
  const source = value['source']
  if (!isContextSource(source)) {
    refuse(`context record ${contextId} names a source this build does not know`)
  }
  const capturedAt = value['capturedAt']
  if (!isInstant(capturedAt)) refuse(`context record ${contextId} has no usable capture time`)
  const originId = value['originId']
  if (originId !== null && (typeof originId !== 'string' || originId.length === 0)) {
    refuse(`context record ${contextId} has an origin that is not an id`)
  }
  if (originId !== null && originId.length > limits.maxOriginIdChars) {
    refuse(`context record ${contextId} has an origin that is too long`)
  }
  // The same origin requirement the domain enforces on admission: content that
  // did not come from the owner's own hand must name the record it came from,
  // so "the host said so" is never a bare assertion on disk either.
  const ownerHeld =
    source === 'owner_selection' || source === 'owner_share' || source === 'owner_authorization'
  if (originId === null && !ownerHeld) {
    refuse(`context record ${contextId} claims a source it cannot have without naming an origin`)
  }
  return { source, capturedAt, originId }
}

function decodeScope(value: unknown, contextId: string, limits: ContextLimits): ContextScope {
  if (!isObject(value)) refuse(`context record ${contextId} has no scope`)
  const scopeKind = value['scopeKind']
  if (!isContextScopeKind(scopeKind)) {
    refuse(`context record ${contextId} names a scope boundary this build does not know`)
  }
  const scopeId = value['scopeId']
  if (typeof scopeId !== 'string' || scopeId.length === 0 || scopeId.length > limits.maxScopeIdChars) {
    refuse(`context record ${contextId} has a scope id that is not usable`)
  }
  return { scopeKind, scopeId }
}

/**
 * Check a whole snapshot off disk, and return it as records this build accepts.
 *
 * Refuses rather than coerces: an unknown top-level shape, a version from the
 * future, a record count above the retention bound, a duplicate id and a record
 * that fails {@link decodeContextItem} all end here, as one total refusal.
 */
export function decodeContextSnapshot(
  value: unknown,
  overrides: Partial<ContextLimits> = {},
): ContextSnapshot {
  const limits = contextLimits(overrides)
  if (!isObject(value)) refuse('the stored context is not an object')
  if (value['v'] !== CONTEXT_SNAPSHOT_VERSION) {
    refuse(
      `the stored context is version ${String(value['v'])}, and this build reads version ${CONTEXT_SNAPSHOT_VERSION}`,
    )
  }
  const records = value['records']
  if (!Array.isArray(records)) refuse('the stored context has no record list')
  if (records.length > limits.maxItems) {
    refuse(
      `the stored context holds ${records.length} records, and this build retains at most ${limits.maxItems}`,
    )
  }

  const seen = new Set<string>()
  const accepted: ContextItem[] = []
  for (const record of records) {
    const item = decodeContextItem(record, limits)
    // Two records claiming one id means a rewrite would drop one of them, and
    // the loser's tombstone — if it had one — would vanish with it.
    if (seen.has(item.contextId)) {
      refuse(`the stored context holds two records with the id ${item.contextId}`)
    }
    seen.add(item.contextId)
    accepted.push(item)
  }
  return { v: CONTEXT_SNAPSHOT_VERSION, records: accepted }
}

/**
 * Check a snapshot a caller is trying to commit, and return its records.
 *
 * The same gate on the way out as on the way in. `contextLimits` clamps anything
 * a caller tries to raise, and the ceiling check in {@link decodeContextItem}
 * means a record cannot claim a longer life than the build allows — so a commit
 * cannot write a snapshot that the next open would refuse.
 *
 * Reported as `invalid` rather than `corrupt`: nothing on disk is wrong, the
 * caller is. That distinction is the difference between "your disk is damaged"
 * and "your code passed me something impossible", and a person cannot act on the
 * first one wrongly.
 */
export function encodeContextSnapshot(
  value: ContextSnapshot,
  overrides: Partial<ContextLimits> = {},
): ContextSnapshot {
  if (!isObject(value)) {
    throw new ContextPersistenceError('invalid', 'a context snapshot must be an object')
  }
  if (!Array.isArray(value.records)) {
    throw new ContextPersistenceError('invalid', 'a context snapshot must carry a record list')
  }
  try {
    return decodeContextSnapshot({ v: CONTEXT_SNAPSHOT_VERSION, records: value.records }, overrides)
  } catch (error) {
    if (isContextPersistenceError(error)) {
      throw new ContextPersistenceError('invalid', `refusing to write context: ${error.message}`)
    }
    throw error
  }
}

/**
 * How many bytes this snapshot serialises to.
 *
 * Measured rather than estimated, so a ceiling that claims to bound the file is
 * actually bounding the file.
 */
export function contextSnapshotBytes(snapshot: ContextSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
}