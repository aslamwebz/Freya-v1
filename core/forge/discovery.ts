import { FORGE_LIMITS, type ForgeStatus, type ForgeRuntimeKind } from './types'

/**
 * DISCOVERY — finding what Freya already has, without asking a model.
 *
 * The brief for this phase says discovery should work "without model call if
 * possible", and here it is simply possible: the catalog is small, bounded, and
 * holds slugs, tags and a bounded description. Lexical scoring over those is
 * deterministic, costs nothing, works offline, and — unlike a model call — cannot
 * be talked into inventing a package that does not exist.
 *
 * What it deliberately does **not** do is download anything. Remote acquisition,
 * when it exists at all elsewhere in the codebase, produces an untrusted
 * candidate that has to come through the same pipeline as a generated one; this
 * module has no network, no fetch and no path it could take to reach one.
 */

export interface ForgeSearchRecord {
  readonly skillId: string
  readonly name: string
  readonly descriptionLength: number
  readonly runtime: ForgeRuntimeKind
  readonly status: ForgeStatus
  readonly version: number
  readonly enabled: boolean
  readonly tags: readonly string[]
  readonly capabilitiesRequired: readonly string[]
  /** The description is matched locally and never leaves this module. */
  readonly description: string
}

export interface ForgeSearchQuery {
  /** Free text. Matched against name, tags, capabilities and description. */
  readonly query?: string | null
  readonly tags?: readonly string[]
  readonly capability?: string | null
  readonly runtime?: ForgeRuntimeKind | null
  /** Include candidates and quarantined packages. Default false. */
  readonly includeUnavailable?: boolean
  readonly limit?: number | null
}

export interface ForgeSearchHit {
  readonly skillId: string
  readonly name: string
  readonly runtime: ForgeRuntimeKind
  readonly status: ForgeStatus
  readonly version: number
  readonly enabled: boolean
  readonly score: number
  readonly matchedTags: readonly string[]
}

export interface ForgeSearchReport {
  readonly hits: readonly ForgeSearchHit[]
  readonly considered: number
  readonly emptyReason: 'no-match' | 'limit-zero' | 'nothing-searchable' | null
}

const UNAVAILABLE: readonly ForgeStatus[] = Object.freeze([
  'candidate',
  'generated',
  'validating',
  'rejected',
  'quarantined',
  'superseded',
  'removed',
])

/** The searchable text of one record, lower-cased once. */
function haystack(record: ForgeSearchRecord): string {
  return `${record.name} ${record.tags.join(' ')} ${record.capabilitiesRequired.join(' ')} ${record.runtime} ${record.description}`
    .toLowerCase()
}

function scoreRecord(record: ForgeSearchRecord, query: ForgeSearchQuery): { score: number; matched: readonly string[] } | null {
  const wantedTags = query.tags ?? []
  const matched: string[] = []

  if (query.capability !== null && query.capability !== undefined) {
    if (!record.capabilitiesRequired.includes(query.capability)) return null
  }
  if (query.runtime !== null && query.runtime !== undefined && record.runtime !== query.runtime) return null

  for (const tag of wantedTags) {
    if (!record.tags.includes(tag)) return null
    matched.push(tag)
  }

  let score = 1 + matched.length * 2
  if (record.enabled) score += 3
  if (record.status === 'installed' || record.status === 'enabled') score += 2

  const text = query.query
  if (text !== null && text !== undefined && text.trim().length > 0) {
    const needle = text.trim().toLowerCase()
    if (needle.length > FORGE_LIMITS.maxRefChars) return null
    const hay = haystack(record)
    const nameHit = record.name.includes(needle)
    const tagHit = record.tags.some((tag) => tag.includes(needle))
    if (!nameHit && !tagHit && !hay.includes(needle)) return null
    score += nameHit ? 5 : 0
    score += tagHit ? 4 : 0
    score += hay.includes(needle) ? 1 : 0
    for (const word of needle.split(/\s+/)) {
      if (word.length >= 3 && hay.includes(word)) score += 1
    }
  }

  if (query.includeUnavailable !== true && UNAVAILABLE.includes(record.status)) return null
  return { score, matched }
}

export function discoverForgePackages(
  records: readonly ForgeSearchRecord[],
  query: ForgeSearchQuery = {},
): ForgeSearchReport {
  const limit = query.limit ?? 20
  if (limit <= 0) return { hits: [], considered: 0, emptyReason: 'limit-zero' }
  const capped = Math.min(limit, FORGE_LIMITS.maxPackages)

  const scored: ForgeSearchHit[] = []
  for (const record of records) {
    const outcome = scoreRecord(record, query)
    if (outcome === null) continue
    scored.push({
      skillId: record.skillId,
      name: record.name,
      runtime: record.runtime,
      status: record.status,
      version: record.version,
      enabled: record.enabled,
      score: outcome.score,
      matchedTags: [...outcome.matched],
    })
  }

  // Deterministic order: score first, then name, so two equal scores cannot swap
  // between runs and make a projection look like it changed on its own.
  scored.sort((left, right) => (right.score - left.score) || left.name.localeCompare(right.name))

  const hits = scored.slice(0, capped)
  return {
    hits,
    considered: records.length,
    emptyReason: hits.length === 0 ? (records.length === 0 ? 'nothing-searchable' : 'no-match') : null,
  }
}
