import { createHash } from 'node:crypto'

import { CAPABILITIES, type Capability } from '../../shared/contracts/capabilities'
import {
  WORLD_LIMITS,
  WORLD_OWNER_ENTITY_ID,
  WORLD_RELATION_TYPES,
  WORLD_SELF_ENTITY_ID,
  isNamedWorldEntityKind,
  isReferenceWorldEntityKind,
  isWorldRelationType,
  type NamedWorldEntityKind,
  type ReferenceWorldEntityKind,
  type WorldEndpointClaim,
} from './types'

/**
 * DETERMINISTIC IDENTITY.
 *
 * Every id in the world model is a *digest of content*, never a counter and never
 * a clock reading. That single decision is what makes replay work: the same
 * evidence always produces the same entity and the same edge, so a restart can
 * reproduce a byte-identical projection without replaying a sequence generator and
 * without any part of the domain being able to read the wall clock.
 *
 * It is exactly the argument `deriveSkillId` makes, for the same reason.
 */

/**
 * This domain's own label, used as the digest prefix and as the store's crypto
 * domain.
 *
 * `identity` is prefixed to the relation digest as well as the entity digest, so
 * an entity id can never be read as an edge id.
 */
export const WORLD_CRYPTO_DOMAIN = 'freya.world.store.v1'
const ENTITY_DOMAIN = `${WORLD_CRYPTO_DOMAIN}|entity`
const EDGE_DOMAIN = `${WORLD_CRYPTO_DOMAIN}|edge`

/** A byte rather than a source escape, for the same reason the stores use one. */
const ZERO = Buffer.from([0])

export const WORLD_ENTITY_ID_PREFIX = 'ent_'
export const WORLD_EDGE_ID_PREFIX = 'edge_'
export const WORLD_EVIDENCE_ID_PREFIX = 'wev-'

const DIGEST_CHARS = 16

/* --------------------------------------------------------------- names */

/**
 * Normalise a name into an entity identity, or refuse.
 *
 * ## Refuse, never repair
 *
 * A name that cannot be normalised is refused rather than cleaned up. Repairing it
 * would mean guessing which of two entities a mangled name belonged to, and a
 * guess here is an identity merge performed by an attacker who chose the mangling.
 *
 * ## What is accepted
 *
 * Letters, digits, spaces and a small set of punctuation that appears in real
 * names, bounded by `maxNameChars`, collapsed to single spaces and trimmed. Case
 * is preserved — `Ana` and `ANA` stay two entities, because two people are more
 * likely than one person who changed their spelling, and silently unifying them
 * would be a merge this phase explicitly does not perform.
 *
 * ## Two refusals that are security, not tidiness
 *
 * - **Reserved names.** `Freya` and `owner` belong to Core-owned singletons, so an
 *   admission cannot create, shadow or redefine them. This is the identity
 *   spoofing defence: `ent_freya`'s identity is not a record anybody can write.
 * - **Capability names.** `security.stop` cannot become a thing in the world. If it
 *   could, a poisoned entity could be rendered in a list beside real ones and read
 *   as a capability Freya holds. A capability is a name in a closed vocabulary
 *   and not a person, a project or a place.
 */
/**
 * The characters a name may contain.
 *
 * Letters, combining marks, digits, any kind of space, dashes, and the three pieces
 * of punctuation that turn up in real names: apostrophes in both spellings, a full
 * stop and a comma.
 *
 * Unicode-aware on purpose. A filter restricted to ASCII could not describe most of
 * the people a world model exists for, and "refuse everything non-English" is not a
 * data-protection property; it is a bias wearing a safety rule's clothes. Combining
 * marks are in for the same reason — a name written with its diacritics decomposed is
 * the same name, and refusing it would file a different person.
 *
 * What is deliberately absent is anything structural: slashes, brackets, quotes,
 * angle brackets, semicolons and control characters all fail, so a name can never
 * carry a path, a tag or a statement into a surface that renders it.
 */
const NAME_CHARACTERS = /^[\p{L}\p{M}\p{N}\p{Zs}\p{Pd}'’.]+$/u

/**
 * Whether a name carries a control character.
 *
 * Compared by character code rather than by a regular expression, so no source file
 * in this repository contains a literal control byte. That is not fussiness: a raw
 * control character in source is invisible in review and some editors helpfully
 * "fix" it into something else — and a name filter that silently changed meaning
 * would let control characters into entity names, which is the whole reason it
 * exists. Tab, newline and carriage return are all in range and all refused.
 */
function hasControlCharacter(raw: string): boolean {
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function normaliseWorldName(raw: unknown, maxChars: number = WORLD_LIMITS.maxNameChars): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > maxChars * 2) return null
  // Control characters, tabs and newlines are refused outright rather than
  // stripped: a name carrying one is not a name that was typed badly.
  if (hasControlCharacter(raw)) return null
  if (!NAME_CHARACTERS.test(raw)) return null

  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0 || collapsed.length > maxChars) return null
  if (isReservedWorldName(collapsed)) return null
  if (looksLikeCapability(collapsed)) return null
  return collapsed
}

/**
 * Whether a name belongs to a Core-owned singleton.
 *
 * Compared case-insensitively, because the reserved names exist to stop
 * *impersonation*, and impersonation does not care about capitalisation.
 */
export function isReservedWorldName(name: string): boolean {
  const lowered = name.trim().toLowerCase()
  return lowered === 'freya' || lowered === 'owner' || lowered === WORLD_SELF_ENTITY_ID
}

/**
 * Whether a name addresses a Core-owned singleton rather than naming a new thing.
 *
 * `Freya` and `owner` are refused when a request *creates* an entity and allowed when
 * a request *refers* to one. That asymmetry is the whole point: the two singletons
 * must be impossible to define and perfectly possible to talk about, and a rule that
 * refused both would make the self node unreachable in every sentence mentioning it.
 */
export function addressesSingleton(name: string): boolean {
  const lowered = name.trim().toLowerCase()
  return lowered === 'freya' || lowered === 'owner'
}

/**
 * Whether a name is a capability, or is written like one.
 *
 * `security.stop` is refused by the second test; `stop` alone is not, because a
 * person may be called Stop and refusing that would be a bug that quietly deletes
 * a real entity. The test is deliberately narrow: a dotted, lowercase identifier
 * whose whole string is in the capability vocabulary.
 */
export function looksLikeCapability(name: string): boolean {
  const candidate = name.trim()
  if (candidate.length === 0 || candidate.includes(' ')) return false
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/.test(candidate)) return false
  return (CAPABILITIES as readonly string[]).includes(candidate)
}

/**
 * Whether a value is usable as a source reference.
 *
 * An id and nothing else: letters, digits, dots, colons, underscores and dashes.
 *
 * This is the same `isRef` shape the Skills snapshot codec uses, and for the same
 * reason. A `sourceRef` is projected verbatim, so a permissive character class would
 * let a hostile payload carry a sentence into a provenance field and out to a
 * surface — which is a data leak dressed as a field. Bounded, id-shaped, and it can
 * only ever name a record.
 */
export function isWorldSourceRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}

/** Whether a value is a capability name this Core knows. */
export function isWorldCapabilityName(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

/* ----------------------------------------------------------- entity ids */

/**
 * The deterministic id of a named entity.
 *
 * The kind is in the digest, so a person called `Atlas` and a project called
 * `Atlas` are two entities. That is not a limitation to be tidied away later: the
 * only honest way to merge them is evidence that they are the same thing, and no
 * amount of name matching produces that.
 */
export function deriveEntityId(entityType: NamedWorldEntityKind, normalisedName: string): string {
  const digest = createHash('sha256')
    .update(ENTITY_DOMAIN)
    .update(ZERO)
    .update(entityType)
    .update(ZERO)
    .update(normalisedName, 'utf8')
    .digest('hex')
    .slice(0, DIGEST_CHARS)
  return `${WORLD_ENTITY_ID_PREFIX}${digest}`
}

/** The deterministic id of a reference node. */
export function deriveReferenceId(refKind: ReferenceWorldEntityKind, refId: string): string {
  const digest = createHash('sha256')
    .update(ENTITY_DOMAIN)
    .update(ZERO)
    .update('reference')
    .update(ZERO)
    .update(refKind)
    .update(ZERO)
    .update(refId, 'utf8')
    .digest('hex')
    .slice(0, DIGEST_CHARS)
  return `${WORLD_ENTITY_ID_PREFIX}${digest}`
}

/** An entity id this module minted, or one of the two singletons. */
export function isWorldEntityId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === WORLD_SELF_ENTITY_ID || value === WORLD_OWNER_ENTITY_ID) return true
  return new RegExp(`^${WORLD_ENTITY_ID_PREFIX}[0-9a-f]{${DIGEST_CHARS}}$`).test(value)
}

/** An edge id this module minted. */
export function isWorldEdgeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^${WORLD_EDGE_ID_PREFIX}[0-9a-f]{${DIGEST_CHARS}}$`).test(value)
  )
}

/** An evidence id this module minted. */
export function isWorldEvidenceId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return new RegExp(`^${WORLD_EVIDENCE_ID_PREFIX}[0-9]{6,}$`).test(value)
}

/* -------------------------------------------------------------- edge ids */

/**
 * The deterministic id of one relation edge.
 *
 * `evidenceId` is inside the digest, so two people saying the same thing produce
 * two edges — which is what makes a *conflict* between them representable rather
 * than something the id space silently collapsed. A derived edge passes
 * `'domain'` in that position, and can never collide with an admitted one.
 */
export function deriveEdgeId(
  fromEntityId: string,
  relationType: string,
  toEntityId: string | null,
  literalValue: string | null,
  discriminator: string,
): string {
  const digest = createHash('sha256')
    .update(EDGE_DOMAIN)
    .update(ZERO)
    .update(fromEntityId)
    .update(ZERO)
    .update(relationType)
    .update(ZERO)
    .update(toEntityId ?? '')
    .update(ZERO)
    .update(literalValue ?? '')
    .update(ZERO)
    .update(discriminator)
    .digest('hex')
    .slice(0, DIGEST_CHARS)
  return `${WORLD_EDGE_ID_PREFIX}${digest}`
}

/** The edge id an admitted relation produces, from its evidence. */
export function evidenceEdgeId(
  fromEntityId: string,
  relationType: string,
  toEntityId: string | null,
  literalValue: string | null,
  evidenceId: string,
): string {
  return deriveEdgeId(fromEntityId, relationType, toEntityId, literalValue, evidenceId)
}

/** The edge id a derived domain record produces. Deterministic per record. */
export function domainEdgeId(
  fromEntityId: string,
  relationType: string,
  toEntityId: string | null,
  sourceRef: string,
): string {
  return deriveEdgeId(fromEntityId, relationType, toEntityId, null, `domain|${sourceRef}`)
}

/* ---------------------------------------------------------- evidence ids */

/**
 * Mint the next evidence id.
 *
 * A zero-padded counter, re-seeded from the durable records on recovery in exactly
 * the way `ContextStore` re-seeds its own. The counter is the *only* sequential
 * thing in this domain, and it exists because evidence must be individually
 * addressable so it can be withdrawn — never to decide what an entity is.
 */
export function nextEvidenceId(counter: number): { evidenceId: string; counter: number } {
  const next = counter + 1
  return { evidenceId: `${WORLD_EVIDENCE_ID_PREFIX}${String(next).padStart(6, '0')}`, counter: next }
}

/** Read the counter back out of an id, for recovery. Zero when unrecognised. */
export function evidenceIdCounter(evidenceId: string): number {
  const match = new RegExp(`^${WORLD_EVIDENCE_ID_PREFIX}(\\d+)$`).exec(evidenceId)
  if (match === null) return 0
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) ? parsed : 0
}

/* ------------------------------------------------------------ endpoints */

/** What a resolved endpoint looks like once the world has been folded. */
export interface ResolvedEndpoint {
  readonly entityId: string
  readonly kind: 'named' | 'reference' | 'literal' | 'singleton'
  readonly literalValue: string | null
}

/** Whether a claim's endpoint is one this domain can resolve. */
export function isWorldEndpointClaim(value: unknown): value is WorldEndpointClaim {
  if (typeof value !== 'object' || value === null) return false
  const endpoint = value as Record<string, unknown>
  if (endpoint.form === 'named') {
    return (
      isNamedWorldEntityKind(endpoint.entityType) &&
      typeof endpoint.name === 'string' &&
      endpoint.name.length > 0 &&
      endpoint.name.length <= WORLD_LIMITS.maxNameChars
    )
  }
  if (endpoint.form === 'reference') {
    return (
      isReferenceWorldEntityKind(endpoint.refKind) &&
      typeof endpoint.refId === 'string' &&
      endpoint.refId.length > 0 &&
      endpoint.refId.length <= WORLD_LIMITS.maxSourceRefChars
    )
  }
  if (endpoint.form === 'literal') {
    return (
      typeof endpoint.value === 'string' &&
      endpoint.value.length > 0 &&
      endpoint.value.length <= WORLD_LIMITS.maxLiteralValueChars
    )
  }
  return false
}

/** The kind an endpoint contributes to the endpoint-pairing check. */
export function endpointKind(endpoint: WorldEndpointClaim): WorldEntityKindOfEndpoint {
  if (endpoint.form === 'reference') return endpoint.refKind
  if (endpoint.form === 'named') return endpoint.entityType
  return 'literal'
}

type WorldEntityKindOfEndpoint = string

/** The singleton entity ids, resolved. Never derived from evidence. */
export const WORLD_SELF_ENDPOINT: ResolvedEndpoint = Object.freeze({
  entityId: WORLD_SELF_ENTITY_ID,
  kind: 'singleton',
  literalValue: null,
})

export const WORLD_OWNER_ENDPOINT: ResolvedEndpoint = Object.freeze({
  entityId: WORLD_OWNER_ENTITY_ID,
  kind: 'singleton',
  literalValue: null,
})

/**
 * Resolve a claim's endpoint to an entity id.
 *
 * A singleton name — `Freya`, `owner` — resolves to the Core-owned node rather
 * than creating anything, which is why a statement about Freya can be *about* her
 * without being able to *define* her.
 */
export function resolveClaimEndpoint(
  endpoint: WorldEndpointClaim,
): { resolved: ResolvedEndpoint; normalisedName: string | null } {
  if (endpoint.form === 'literal') {
    return {
      resolved: { entityId: '', kind: 'literal', literalValue: endpoint.value },
      normalisedName: null,
    }
  }
  if (endpoint.form === 'reference') {
    return {
      resolved: {
        entityId: deriveReferenceId(endpoint.refKind, endpoint.refId),
        kind: 'reference',
        literalValue: null,
      },
      normalisedName: null,
    }
  }

  if (endpoint.entityType === 'person') {
    const lowered = endpoint.name.trim().toLowerCase()
    if (lowered === 'owner') return { resolved: WORLD_OWNER_ENDPOINT, normalisedName: null }
    if (lowered === 'freya') return { resolved: WORLD_SELF_ENDPOINT, normalisedName: null }
  }

  const normalisedName = normaliseWorldName(endpoint.name)
  if (normalisedName === null) {
    return { resolved: { entityId: '', kind: 'named', literalValue: null }, normalisedName: null }
  }
  return {
    resolved: {
      entityId: deriveEntityId(endpoint.entityType, normalisedName),
      kind: 'named',
      literalValue: null,
    },
    normalisedName,
  }
}

/**
 * The subject endpoint kinds a *claim* may use.
 *
 * Narrower than the relation spec table, because a claim is a statement about the
 * world and a reference node's identity belongs to the domain that owns it. A
 * claim can therefore point at a Mission, but it cannot claim to *be* one.
 */
export const WORLD_CLAIM_SUBJECT_FORMS = Object.freeze(['named', 'reference'] as const)

/** Re-exported so a call site validating a relation needs one import. */
export { WORLD_RELATION_TYPES, isWorldRelationType }