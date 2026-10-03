import type { Confidence, Sensitivity } from '../brain/types'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  WORLD_CHANNEL_PROFILE,
  WORLD_CONFIDENCE_RANK,
  WORLD_REFUSAL_REASONS,
  isNamedWorldEntityKind,
  isWorldAdmissionChannel,
  isWorldEvidenceKind,
  isWorldRelationType,
  worldRelationSpec,
  type NamedWorldEntityKind,
  type WorldAdmissionChannel,
  type WorldEntityKind,
  type WorldEndpointClaim,
  type WorldEntityClaim,
  type WorldEvidenceRecord,
  type WorldEvidenceRequest,
  type WorldLimits,
  type WorldRefusalCode,
  type WorldRelationClaim,
  type WorldRelationType,
} from './types'
import {
  addressesSingleton,
  isReservedWorldName,
  isWorldEndpointClaim,
  isWorldEvidenceId,
  isWorldSourceRef,
  looksLikeCapability,
  normaliseWorldName,
} from './identity'
import { isValidWorldInstant } from './relations'

/**
 * THE ADMISSION SEAM.
 *
 * Everything that enters the world passes through here, and this is the only
 * place that decides how much a claim is worth.
 *
 * ## The channel is the trust
 *
 * An admission never names its own source. It names a *channel*, and
 * `WORLD_CHANNEL_PROFILE` — a frozen table this module cannot widen — assigns the
 * `SourceTrust`, the epistemic ceiling and the confidence ceiling. That is the
 * whole memory-poisoning defence: a web page, an email, a worker's message or a
 * model's answer can put the words "the owner said so" in its own text and it
 * will be recorded as exactly what it is, untrusted content from a worker.
 *
 * ## `verified` is unreachable from here
 *
 * Every channel's epistemic ceiling is below `verified`, so no admission — public,
 * Core-internal, or forged — can produce a verified claim. What *is* verified is
 * Core's own record of an authoritative domain, and that is a separate population
 * the fold derives rather than anything anybody admits. That separation is what
 * makes "fact versus claim" a distinction with something on the verified side of
 * it, rather than a word.
 *
 * ## Refuse, never repair
 *
 * Every failure is a named refusal and nothing is silently corrected. A name that
 * cannot be normalised is refused rather than cleaned, because repairing it means
 * guessing which of two entities a mangled name belonged to — and the person best
 * placed to make that guess maliciously is whoever chose the mangling.
 *
 * ## Validation order
 *
 * Fixed, and the order is the argument:
 *
 * ```
 * claim fields → kind → channel → clock → instants → name/aliases/attributes
 *              → relation type → endpoint shapes → endpoint pairing
 *              → supersession → bounds → channel ceilings
 * ```
 *
 * Claim fields come first because an authority-shaped key is the truest answer
 * available when several things are wrong, and it must never look like an unknown
 * key that "would have been ignored".
 */

/**
 * Keys that state authority, certainty or identity, refused by name.
 *
 * This is the Context domain's `AUTHORITY_KEYS` list, extended with the claim
 * fields Phase 22 added. A payload carrying one of these is refused **whole**,
 * rather than stripped: a payload that arrived with `authority: 'owner'` in it is
 * not a payload whose owner field happens to be ignored, and treating it as one
 * would make the attempt invisible.
 */
export const WORLD_FORBIDDEN_REQUEST_KEYS: readonly string[] = Object.freeze([
  // Authority and trust: Context's adapter list, kept deliberately the same.
  'access',
  'allowed',
  'authority',
  'authorized',
  'capabilities',
  'capability',
  'grant',
  'grants',
  'permission',
  'permissions',
  'principal',
  'trust',
  'trusted',
  // Claim status. A request may not say how settled or how certain it is. A
  // *confidence* is allowed on two channels and is a field rather than a name, so it
  // is checked separately rather than denied here.
  'confidence_level',
  'epistemic',
  'epistemicStatus',
  'source',
  'sourceTrust',
  'sourceType',
  'status',
  'verified',
  // Identity and position: who said it, which channel it arrived on, and where it
  // sits in the history. All Core's, and all of them things a payload could forge.
  'actor',
  'channel',
  'createdBy',
  'evidenceId',
  'recordedAt',
  'recordedBy',
  'sequence',
])

/**
 * Channels allowed to state their own confidence, and only up to their ceiling.
 *
 * The owner knows how sure they are about their own priorities. A Core subsystem
 * that observed something may know how sure it is of the observation. A worker or
 * a model does not get a say: a self-assessed certainty is a request to be
 * believed, and the channel profile is the answer.
 */
const CONFIDENCE_STATING_CHANNELS: readonly WorldAdmissionChannel[] = Object.freeze([
  'owner_statement',
  'system_observation',
])

/** What the pathway knew, and therefore what Core assigns. */
export interface WorldAdmissionContext {
  readonly channel: WorldAdmissionChannel
  /** The principal that assembled this. Never read from the request. */
  readonly actor: PrincipalId
  /** How private this is. Assigned by the pathway that knew where the bytes came from. */
  readonly sensitivity: Sensitivity
  readonly now: Date
  readonly limits: WorldLimits
  /** Evidence ids already retained, for supersession and withdrawal checks. */
  readonly known: ReadonlySet<string>
}

/** The refusal half of a validation result. Named so a caller can hand it straight back. */
export interface WorldRefusal {
  readonly ok: false
  readonly code: WorldRefusalCode
  readonly reason: string
}

export type WorldEvidenceResult = { readonly ok: true; readonly record: WorldEvidenceRecord } | WorldRefusal

export function worldRefusal(code: WorldRefusalCode): WorldRefusal {
  return { ok: false, code, reason: WORLD_REFUSAL_REASONS[code] }
}

/**
 * Build one durable evidence record, or refuse in words.
 *
 * `evidenceId` and `sequence` are supplied by the engine, not derived here: the
 * caller cannot choose where in the history its claim lands.
 */
export function buildEvidenceRecord(
  request: WorldEvidenceRequest,
  context: WorldAdmissionContext,
  evidenceId: string,
  sequence: number,
): WorldEvidenceResult {
  if (!isValidWorldInstant(context.now)) return worldRefusal('invalid_instant')
  if (!isWorldAdmissionChannel(context.channel)) return worldRefusal('channel_unknown')
  if (!isWorldEvidenceKind(request?.kind)) return worldRefusal('kind_unknown')
  if (!isWorldEvidenceId(evidenceId)) return worldRefusal('supersedes_unusable')

  if (request.kind === 'withdrawal') {
    return buildWithdrawal(request, context, evidenceId, sequence)
  }

  // --- instants -------------------------------------------------------------
  const observedAt = resolveObservedAt(request.observedAt ?? null, context.now)
  if (typeof observedAt !== 'string') return observedAt

  const validUntil = resolveValidUntil(
    request.kind === 'entity' ? null : (request.validUntil ?? null),
    observedAt,
  )
  if (typeof validUntil !== 'string' && validUntil !== null) return validUntil

  // --- supersession ---------------------------------------------------------
  const supersedes = request.supersedes ?? null
  if (supersedes !== null) {
    if (!isWorldEvidenceId(supersedes)) return worldRefusal('supersedes_unusable')
    if (supersedes === evidenceId) return worldRefusal('supersedes_self')
    if (!context.known.has(supersedes)) return worldRefusal('supersedes_unknown')
  }

  // --- bounds ---------------------------------------------------------------
  const sourceRef = request.sourceRef ?? null
  if (sourceRef !== null && !isWorldSourceRef(sourceRef)) {
    // Not merely bounded: id-*shaped*. A `sourceRef` is projected verbatim, so a
    // permissive character class would let a payload carry a sentence into a
    // provenance field and straight out to a surface.
    return worldRefusal('source_ref_too_large')
  }
  if (sourceRef !== null && sourceRef.length > context.limits.maxSourceRefChars) {
    return worldRefusal('source_ref_too_large')
  }

  const summary = request.evidenceSummary ?? null
  if (summary !== null) {
    if (typeof summary !== 'string') return worldRefusal('summary_too_large')
    if (summary.length > context.limits.maxEvidenceSummaryChars) return worldRefusal('summary_too_large')
  }

  const profile = WORLD_CHANNEL_PROFILE[context.channel]

  // The channel's ceiling, applied last so an over-claiming request is refused for
  // the truest reason rather than for something incidental.
  const confidence = resolveConfidence(request.confidence ?? null, context.channel, profile.confidenceCap)
  if (typeof confidence !== 'string') return confidence

  const recordedAt = context.now.toISOString()
  const base = {
    evidenceId,
    sequence,
    kind: request.kind,
    channel: context.channel,
    recordedAt,
    observedAt,
    source: profile.source,
    actor: context.actor,
    sourceRef,
    sensitivity: context.sensitivity,
    epistemic: profile.epistemicCap,
    confidence,
    evidenceSummary: summary,
    supersedes,
  }

  if (request.kind === 'entity') {
    const claim = validateEntityClaim(
      request.entityType,
      request.name,
      request.aliases ?? [],
      request.attributes ?? {},
      context.limits,
    )
    if (isWorldRefusal(claim)) return claim
    return { ok: true, record: { ...base, entity: claim, relation: null, withdrawal: null } }
  }

  // An `unknown` record names no relation at all: it records that two things are
  // connected and that nothing stronger is known. Normalising the stored relation
  // here rather than at fold time keeps the record and the edge it produces
  // describing the same thing.
  const relationType: WorldRelationType = request.kind === 'unknown' ? 'related_to' : request.relationType
  const claim = validateRelationClaim(relationType, request.subject, request.object, validUntil, context.limits)
  if (isWorldRefusal(claim)) return claim

  return { ok: true, record: { ...base, entity: null, relation: claim, withdrawal: null } }
}

function buildWithdrawal(
  request: Extract<WorldEvidenceRequest, { kind: 'withdrawal' }>,
  context: WorldAdmissionContext,
  evidenceId: string,
  sequence: number,
): WorldEvidenceResult {
  const target = request.targetEvidenceId
  if (typeof target !== 'string' || !isWorldEvidenceId(target)) return worldRefusal('withdrawal_unknown')
  if (target === evidenceId) return worldRefusal('withdrawal_self')
  if (!context.known.has(target)) return worldRefusal('withdrawal_unknown')

  const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
  if (reason.length === 0 || reason.length > context.limits.maxReasonChars) {
    return worldRefusal('summary_too_large')
  }

  const profile = WORLD_CHANNEL_PROFILE[context.channel]
  return {
    ok: true,
    record: {
      evidenceId,
      sequence,
      kind: 'withdrawal',
      channel: context.channel,
      recordedAt: context.now.toISOString(),
      observedAt: context.now.toISOString(),
      source: profile.source,
      actor: context.actor,
      sourceRef: null,
      sensitivity: context.sensitivity,
      // A withdrawal is a fact about the record, not a claim about the world, so it
      // is as settled as anything in this domain gets. It asserts nothing about
      // anybody or anything, which is why it may be `verified`.
      epistemic: 'verified',
      confidence: 'verified',
      evidenceSummary: null,
      supersedes: null,
      entity: null,
      relation: null,
      withdrawal: { targetEvidenceId: target, reason },
    },
  }
}

/* -------------------------------------------------------------- validation */

function resolveObservedAt(raw: string | null, now: Date): string | WorldEvidenceResult {
  if (raw === null || raw === undefined) return now.toISOString()
  if (typeof raw !== 'string') return worldRefusal('invalid_instant')
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return worldRefusal('invalid_instant')
  // Nothing was observed at an instant that has not happened yet. A future
  // observation would be provenance that has not occurred.
  if (parsed > now.getTime()) return worldRefusal('instant_in_future')
  return new Date(parsed).toISOString()
}

function resolveValidUntil(raw: string | null, observedAt: string): string | null | WorldEvidenceResult {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return worldRefusal('invalid_valid_until')
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return worldRefusal('invalid_valid_until')
  if (parsed < Date.parse(observedAt)) return worldRefusal('valid_until_before_observed')
  return new Date(parsed).toISOString()
}

/**
 * The confidence this admission gets.
 *
 * Two steps, and the second is the security one:
 *
 * 1. A channel that may state a confidence gets to say how sure it is, clamped
 *    down to the channel's ceiling.
 * 2. A channel that may not is refused outright rather than silently ignored —
 *    because a worker quietly discarding the confidence it asked for would leave
 *    the caller believing it had been weighed.
 */
function resolveConfidence(
  requested: Confidence | null,
  channel: WorldAdmissionChannel,
  cap: Confidence,
): Confidence | WorldEvidenceResult {
  if (requested === null || requested === undefined) return cap
  if (!CONFIDENCE_STATING_CHANNELS.includes(channel)) return worldRefusal('claim_fields_not_admissible')
  if (!isConfidenceValue(requested)) return worldRefusal('confidence_above_channel')
  if (WORLD_CONFIDENCE_RANK[requested] > WORLD_CONFIDENCE_RANK[cap]) {
    return worldRefusal('confidence_above_channel')
  }
  return requested
}

/**
 * Whether a value is one of the Brain's confidence categories.
 *
 * Written out rather than imported because the Brain exports the type and the rank
 * table but no validator. Checking membership *before* comparing ranks is what stops a
 * value outside the vocabulary from ranking as `undefined` and therefore sneaking past
 * the ceiling — which is exactly the kind of hole a rank comparison invites.
 */
function isConfidenceValue(value: unknown): value is Confidence {
  return (
    value === 'unknown' || value === 'low' || value === 'medium' || value === 'high' || value === 'verified'
  )
}

/**
 * Which refusals an un-normalisable name might mean.
 *
 * Named separately so the caller can be told *why* — a reserved name and a
 * capability name are both "no", but they are different problems, and a refusal
 * that says only "no" is one a person cannot act on.
 */
function nameRefusal(raw: string): WorldEvidenceResult {
  // Reserved before capability before unusable, so the reason names the actual
  // problem: "that name belongs to Freya" and "a capability is not a thing in the
  // world" are different faults with different fixes.
  if (isReservedWorldName(raw)) return worldRefusal('name_reserved')
  if (looksLikeCapability(raw.trim())) return worldRefusal('name_is_capability')
  return worldRefusal('name_unusable')
}

/**
 * Whether an endpoint's name may be referred to.
 *
 * The singletons pass here even though `normaliseWorldName` refuses them, because
 * refusing to *mention* Freya would make her unreachable in every sentence that
 * refers to her while adding nothing to her protection: the singleton already exists,
 * and no evidence can redefine it.
 */
function addressableName(raw: string, limits: WorldLimits): boolean {
  return addressesSingleton(raw) || normaliseWorldName(raw, limits.maxNameChars) !== null
}

function validateEntityClaim(
  entityType: NamedWorldEntityKind,
  name: string,
  aliases: readonly string[],
  attributes: Readonly<Record<string, string>>,
  limits: WorldLimits,
): WorldEntityClaim | WorldEvidenceResult {
  if (!isNamedWorldEntityKind(entityType)) return worldRefusal('entity_unknown')
  if (typeof name !== 'string') return worldRefusal('name_unusable')

  const normalised = normaliseWorldName(name, limits.maxNameChars)
  if (normalised === null) return nameRefusal(name)

  const cleanAliases: string[] = []
  if (Array.isArray(aliases)) {
    if (aliases.length > limits.maxAliasesPerEntity) return worldRefusal('too_many_aliases')
    for (const alias of aliases) {
      if (typeof alias !== 'string') return worldRefusal('alias_unusable')
      const normalisedAlias = normaliseWorldName(alias, limits.maxNameChars)
      if (normalisedAlias === null) return worldRefusal('alias_unusable')
      if (normalisedAlias === normalised) continue
      cleanAliases.push(normalisedAlias)
    }
  }

  const cleanAttributes: Record<string, string> = {}
  const entries = Object.entries(attributes ?? {})
  if (entries.length > limits.maxAttributesPerEntity) return worldRefusal('too_many_attributes')
  for (const [key, value] of entries) {
    const trimmed = key.trim()
    if (trimmed.length === 0 || trimmed.length > limits.maxAttributeKeyChars) {
      return worldRefusal('attribute_key_unusable')
    }
    if (!/^[\p{L}\p{N} _-]+$/u.test(trimmed)) return worldRefusal('attribute_key_unusable')
    if (typeof value !== 'string') return worldRefusal('attribute_value_too_large')
    if (value.length > limits.maxAttributeValueChars) return worldRefusal('attribute_value_too_large')
    cleanAttributes[trimmed] = value
  }

  return { entityType, name: normalised, aliases: cleanAliases, attributes: cleanAttributes }
}

function validateRelationClaim(
  relationType: WorldRelationType,
  subject: WorldEndpointClaim,
  object: WorldEndpointClaim,
  validUntil: string | null,
  limits: WorldLimits,
): WorldRelationClaim | WorldEvidenceResult {
  if (!isWorldRelationType(relationType)) return worldRefusal('relation_type_unknown')
  if (!isWorldEndpointClaim(subject)) return worldRefusal('relation_endpoints_invalid')
  if (!isWorldEndpointClaim(object)) return worldRefusal('relation_endpoints_invalid')
  // A relation either points at something or states a value. Never both, never
  // neither — which is why the endpoint union has no fourth member.
  if (subject.form === 'literal') return worldRefusal('relation_endpoints_invalid')

  const spec = worldRelationSpec(relationType)
  const subjectKind = endpointWorldKind(subject)
  const objectKind = object.form === 'literal' ? null : endpointWorldKind(object)

  if (objectKind === null) {
    // A literal stands in for an object, so it is admissible exactly where an
    // object entity would be. Every relation in the table takes an object, which
    // is why this is a table lookup and not a hard-coded list.
    if (spec.objects.length === 0) return worldRefusal('literal_required')
  } else if (objectKind !== 'literal' && !spec.objects.includes(objectKind)) {
    return worldRefusal('relation_endpoints_invalid')
  }
  if (subjectKind === 'literal' || !spec.subjects.includes(subjectKind)) {
    return worldRefusal('relation_endpoints_invalid')
  }

  const claim: WorldRelationClaim = {
    relationType,
    subject: normaliseEndpoint(subject, limits),
    object: object.form === 'literal' ? { form: 'literal', value: object.value.trim() } : normaliseEndpoint(object, limits),
    validUntil,
  }

  if (claim.object.form === 'literal' && claim.object.value.length === 0) {
    return worldRefusal('relation_endpoints_invalid')
  }
  if (claim.subject.form === 'named' && !addressableName(claim.subject.name, limits)) {
    return nameRefusal(claim.subject.name)
  }
  if (claim.object.form === 'named' && !addressableName(claim.object.name, limits)) {
    return nameRefusal(claim.object.name)
  }
  return claim
}

/** The entity kind an endpoint contributes to the pairing check. */
function endpointWorldKind(endpoint: WorldEndpointClaim): WorldEntityKind | 'literal' {
  if (endpoint.form === 'reference') return endpoint.refKind
  if (endpoint.form === 'named') return endpoint.entityType
  return 'literal'
}

/**
 * Whether a validator refused.
 *
 * A refusal is the only result carrying `ok: false`, and a built claim carries no
 * `ok` field at all — so the check is structural and needs no sentinel value.
 */
function isWorldRefusal<T>(value: T | WorldEvidenceResult): value is WorldEvidenceResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    (value as { ok: unknown }).ok === false
  )
}

function normaliseEndpoint(endpoint: WorldEndpointClaim, limits: WorldLimits): WorldEndpointClaim {
  if (endpoint.form === 'named') {
    const normalised = normaliseWorldName(endpoint.name, limits.maxNameChars)
    return { form: 'named', entityType: endpoint.entityType, name: normalised ?? endpoint.name.trim() }
  }
  if (endpoint.form === 'reference') {
    return { form: 'reference', refKind: endpoint.refKind, refId: endpoint.refId.trim() }
  }
  return { form: 'literal', value: endpoint.value.trim() }
}

/**
 * Refuse a raw payload that carries a claim-shaped or authority-shaped field.
 *
 * Applied by the engine before this module sees a request, because a typed
 * parameter is only a promise about a TypeScript caller. The rule is a closed
 * allowlist plus a named denylist, exactly as the Context adapter does it: an
 * authority-shaped key is refused **by name**, so an attempt reads as an attempt
 * rather than as an ignored extra field.
 */
export function rejectForbiddenWorldKeys(payload: unknown): WorldRefusal | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return worldRefusal('kind_unknown')
  }
  const keys = Object.keys(payload as Record<string, unknown>)
  if (keys.some((key) => WORLD_FORBIDDEN_REQUEST_KEYS.includes(key))) {
    return worldRefusal('claim_fields_not_admissible')
  }
  return null
}
