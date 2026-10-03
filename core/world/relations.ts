import { SENSITIVITY_RANK, type EpistemicStatus } from '../brain/types'
import { isReferenceWorldEntityKind, worldRelationSpec, type WorldLimits } from './types'
import type { WorldEdge } from './state'

/**
 * FRESHNESS AND CONFLICT.
 *
 * Two questions a world model must answer honestly and refuse to fudge:
 *
 * 1. **Is this still true?** Freshness is computed from a record's own instants
 *    against an instant the caller supplies. It is never stored, because a stored
 *    freshness is one that can drift away from the evidence it describes.
 *
 * 2. **What do we do when two sources disagree?** Keep both, mark both, choose
 *    neither. There is deliberately no "most trusted wins" rule here, and the
 *    absence is the design.
 */

/** Is this instant usable at all? An unusable instant judges nothing. */
export function isValidWorldInstant(now: Date): boolean {
  return now instanceof Date && Number.isFinite(now.getTime())
}

/**
 * The freshness of one edge.
 *
 * Checked in a fixed order, and the order is the argument:
 *
 * - **withdrawn** outranks everything, because evidence a person took back is not
 *   a stale truth, it is nothing.
 * - **conflicted** outranks age, because a disagreement is more urgent to show than
 *   a clock reading, and an edge that is both contested and old must not be
 *   reported as merely aging.
 * - **historical** before age, because a claim with an end time is finished
 *   regardless of how recently it was refreshed — that is what the end time means.
 * - **superseded** next to historical, for the same reason: a claim someone has
 *   explicitly replaced was true and is not now, which is precisely `historical`.
 *   Reporting it as merely `stale` would suggest nobody had said otherwise, which is
 *   the opposite of what a supersession is.
 */
export function edgeFreshness(edge: {
  readonly withdrawn: boolean
  readonly conflicted: boolean
  readonly validUntil: string | null
  readonly supersededBy: string | null
  readonly observedAt: string
}, now: Date, limits: WorldLimits): WorldEdge['freshness'] {
  if (edge.withdrawn) return 'withdrawn'
  if (edge.conflicted) return 'conflicted'
  if (edge.validUntil !== null) {
    const until = Date.parse(edge.validUntil)
    if (Number.isFinite(until) && until <= now.getTime()) return 'historical'
    // An unparseable end time is not treated as "still current" — it is treated
    // as absent, and the codec refuses those records anyway.
  }
  if (edge.supersededBy !== null) return 'historical'
  const observed = Date.parse(edge.observedAt)
  if (!Number.isFinite(observed)) return 'stale'
  const age = now.getTime() - observed
  if (age > limits.staleAfterMs) return 'stale'
  if (age > limits.freshnessHorizonMs) return 'aging'
  return 'current'
}

/**
 * A node's freshness, derived from the edges it carries.
 *
 * Precedence is deliberate and disclosed: a node with any current edge is
 * `current` even if it also has an old one, because the newest evidence about a
 * thing is what a person means by "do we still know this". A node whose edges all
 * disagree is `conflicted` regardless of age.
 */
export function nodeFreshness(
  ownFreshness: WorldEdge['freshness'],
  edgeFreshnesses: readonly WorldEdge['freshness'][],
): WorldEdge['freshness'] {
  if (edgeFreshnesses.includes('conflicted')) return 'conflicted'
  if (edgeFreshnesses.includes('current')) return 'current'
  if (edgeFreshnesses.includes('aging')) return 'aging'
  if (edgeFreshnesses.includes('historical')) return 'historical'
  if (edgeFreshnesses.includes('stale')) return 'stale'
  if (edgeFreshnesses.includes('withdrawn')) return 'withdrawn'
  return ownFreshness
}

/**
 * Whether evidence at this sensitivity may appear in a projection at all.
 *
 * `secret-reference` and `sensitive` are counted and withheld. The reasoning is
 * the Brain's, and it is a good one: being told that a credential exists is
 * legitimate and useful; being handed the credential is not, and a graph is the
 * worst possible place for one.
 */
export function isWorldProjectionVisible(sensitivityRank: number): boolean {
  return sensitivityRank < SENSITIVITY_RANK['sensitive']
}

/* ------------------------------------------------------------- conflicts */

/** What one unresolved disagreement looks like, for the summary. */
export interface WorldConflict {
  readonly subjectEntityId: string
  readonly relationType: string
  readonly objectKey: string
  readonly edgeIds: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly reason: 'disagreeing_values' | 'disagreeing_objects'
}

/** The key a single-valued relation groups by. */
function subjectKey(edge: WorldEdge): string {
  return `${edge.fromEntityId}|${edge.relationType}`
}

/**
 * The key an edge groups by for the "disagreeing values" rule.
 *
 * A literal object is deliberately **not** part of the key. Two claims that "Ana works
 * on: Atlas" and "Ana works on: Helios" disagree about the *value* of one relation,
 * and including the value in the grouping key would put them in different buckets —
 * so the rule would never fire and the conflict would be invisible. Two claims that
 * point at the *same* entity are the same claim, not a disagreement, so an entity
 * object is part of the key and a literal is not.
 */
function tripleKey(edge: WorldEdge): string {
  return edge.toEntityId === null
    ? `${edge.fromEntityId}|${edge.relationType}|#literal`
    : `${edge.fromEntityId}|${edge.relationType}|${edge.toEntityId}`
}

/**
 * Find every unresolved disagreement among edges, and report both sides of each.
 *
 * ## The rule, and why there is no other one
 *
 * Two rules, and neither of them picks a winner:
 *
 * 1. **Disagreeing values.** Two edges about the same triple whose literal values
 *    differ. "Alpha's status is blocked" and "Alpha's status is running" are both
 *    kept and both marked.
 * 2. **Disagreeing objects, on a single-valued relation.** A worker cannot be in
 *    two teams, so two edges of `member_of` from one worker are a disagreement
 *    rather than two facts.
 *
 * `SOURCE_TRUST_RANK` is deliberately not consulted. It exists to bias
 * *admission* — an untrusted page is less welcome than the owner's own word — and
 * using it to arbitrate here would let one system observation silently overwrite
 * what a person said. A world model that resolves its own conflicts is a world
 * model that cannot be disagreed with.
 *
 * Supersession is the one exception, and it is explicit: an edge whose evidence
 * names an earlier edge as superseded retires that edge rather than conflicting
 * with it. Someone saying "no, it is this instead" is an update, not a conflict.
 */
export function findWorldConflicts(edges: readonly WorldEdge[]): {
  readonly conflicts: readonly WorldConflict[]
  readonly conflictsByEdge: ReadonlyMap<string, readonly string[]>
} {
  const candidates = edges.filter(
    (edge) => edge.origin === 'admitted_evidence' && edge.freshness !== 'withdrawn',
  )

  const byTriple = new Map<string, WorldEdge[]>()
  for (const edge of candidates) {
    if (edge.supersededBy !== null || edge.superseded.length > 0) continue
    const key = tripleKey(edge)
    const bucket = byTriple.get(key)
    if (bucket === undefined) byTriple.set(key, [edge])
    else bucket.push(edge)
  }

  const bySubject = new Map<string, WorldEdge[]>()
  for (const edge of candidates) {
    if (edge.supersededBy !== null || edge.superseded.length > 0) continue
    const spec = worldRelationSpec(edge.relationType)
    if (!spec.singleValued) continue
    const key = subjectKey(edge)
    const bucket = bySubject.get(key)
    if (bucket === undefined) bySubject.set(key, [edge])
    else bucket.push(edge)
  }

  const conflicts: WorldConflict[] = []
  const conflictsByEdge = new Map<string, string[]>()

  const record = (
    subjectEntityId: string,
    relationType: string,
    objectKey: string,
    group: readonly WorldEdge[],
    reason: WorldConflict['reason'],
  ): void => {
    const ids = [...group.map((edge) => edge.edgeId)].sort()
    conflicts.push({
      subjectEntityId,
      relationType,
      objectKey,
      edgeIds: ids,
      evidenceIds: [...new Set(group.map((edge) => edge.evidenceId).filter((id): id is string => id !== null))].sort(),
      reason,
    })
    for (const id of ids) {
      const existing = conflictsByEdge.get(id)
      if (existing === undefined) conflictsByEdge.set(id, [id])
    }
  }

  for (const [key, group] of [...byTriple.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < 2) continue
    const values = new Set(group.map((edge) => edge.literalValue ?? ''))
    if (values.size < 2) continue
    const parts = key.split('|')
    record(parts[0] ?? '', parts[1] ?? '', '#literal', group, 'disagreeing_values')
  }

  for (const [key, group] of [...bySubject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < 2) continue
    const objects = new Set(group.map((edge) => edge.toEntityId ?? ''))
    if (objects.size < 2) continue
    const [subject, relationType] = key.split('|')
    record(subject ?? '', relationType ?? '', '*', group, 'disagreeing_objects')
  }

  // Every edge in a conflict lists every other edge in it, so a surface reading
  // one edge does not have to go looking for the other side.
  for (const conflict of conflicts) {
    for (const id of conflict.edgeIds) conflictsByEdge.set(id, [...conflict.edgeIds])
  }

  conflicts.sort((a, b) => {
    const aKey = `${a.subjectEntityId}|${a.relationType}|${a.objectKey}`
    const bKey = `${b.subjectEntityId}|${b.relationType}|${b.objectKey}`
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })

  return { conflicts, conflictsByEdge }
}

/* -------------------------------------------------------------- dangling */

/**
 * Whether an edge points at a reference node the owning domain does not have.
 *
 * "Ana works on mission X" where no mission X exists is not a fact and not a
 * lie; it is a claim about something that is not there. Counting these rather
 * than rendering them is the honest answer, and the count is reported so the
 * claim is not invisible either.
 */
export function isDanglingEdge(
  edge: Pick<WorldEdge, 'toEntityId'>,
  nodes: ReadonlyMap<string, { readonly reference: unknown }>,
): boolean {
  if (edge.toEntityId === null) return false
  const node = nodes.get(edge.toEntityId)
  if (node === undefined) return true
  return node.reference === null || node.reference === undefined
}

/**
 * The epistemic status a derived domain edge carries.
 *
 * A record Core itself holds is the only thing in this domain that is `verified`.
 * It is what makes "facts versus claims" a distinction with something on the
 * verified side of it — and it is unreachable from every evidence channel, so a
 * rumour can never be promoted into it to fill a gap.
 */
export function domainRecordEpistemic(): EpistemicStatus {
  return 'verified'
}

/** Whether a reference kind's domain is one this build knows how to read. */
export function isKnownReferenceDomain(value: unknown): value is string {
  return isReferenceWorldEntityKind(value)
}