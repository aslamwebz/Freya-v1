import {
  isSelectableSkillStatus,
  SKILL_LIMITS,
  statusPreference,
  type SkillKind,
  type SkillStatus,
} from './types'
import type { SkillFoldRecord, SkillState } from './state'
import { currentVersionEvaluations } from './promotion'

/**
 * SKILL SELECTION — deterministic ranking from declared applicability and evidence.
 *
 * ## Why there is no model in this file
 *
 * Selection decides which reusable procedure a Run will execute. A model choosing
 * which procedure to run is a model choosing what Freya is permitted to do with the
 * capabilities that Run already holds, and that is authority dressed as preference.
 * So this function takes a list of tags and a list of records and returns a total
 * order. There is no scoring model, no embedding and no provider here, and nothing in
 * `core/skills/` imports a gateway.
 *
 * The ordering, in full:
 *
 * 1. **Applicability.** A skill with no tag in common is not a candidate. Matching is
 *    intersection over *declared* tags — what the skill says it is for — and not over
 *    its text, its name, or anything a caller could pad.
 * 2. **Trust.** `untrusted-content` is excluded before anything else can promote it,
 *    and a blocked or retired skill is excluded whatever its tags say.
 * 3. **Established evidence, descending.** The count of `established` evaluations
 *    *for this exact version*. A version with no evidence sorts below one with
 *    evidence, and evidence from an older version counts for nothing.
 * 4. **Version, descending.** Newer first, so a revision outranks what it replaced
 *    once both have evidence.
 * 5. **Skill id, ascending.** The tiebreak. Without it two equally-evidenced skills
 *    would come back in whatever order the fold happened to hold them, and the same
 *    input would produce two different answers.
 *
 * Every comparison is a total order over comparable keys, so the result is a
 * *permutation*, not a partial ranking: `selectSkills` on the same state always
 * returns the same array, element for element.
 */

/** One ranked candidate, with the reason it ranked where it did. */
export interface SkillSelectionCandidate {
  readonly skillId: string
  readonly name: string
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillFoldRecord['verification']
  readonly trustClass: SkillFoldRecord['trustClass']
  /** Established evaluations for the current version. The primary ordering key. */
  readonly establishedCount: number
  /** How many declared tags the request matched. Reported, never ordered on. */
  readonly matchedTags: readonly string[]
  readonly executionsPlanned: number
}

export interface SkillSelectionRequest {
  /** Declared applicability the caller needs. Empty means "no filter". */
  readonly applicability?: readonly string[]
  /**
   * Whether a `trial` skill may be returned.
   *
   * Off by default. A trial skill is executable — that is what trial means — but
   * *selecting* one is an explicit choice, so it is a parameter rather than a
   * default. A renderer can ask for trials; a subsystem cannot get one by forgetting.
   */
  readonly includeTrial?: boolean
  /** Whether a `verified` but unpromoted skill may be returned. Off by default. */
  readonly includeVerified?: boolean
  /** Overrides `SKILL_LIMITS.maxSelection`. Can only lower it. */
  readonly limit?: number
  /** Injected for the evidence-age filter, so a test needs no clock. */
  readonly now: Date
}

export interface SkillSelection {
  readonly candidates: readonly SkillSelectionCandidate[]
  /** How many records were considered before filtering. */
  readonly considered: number
  /** Why the list is empty, or null when it is not. Never a guess. */
  readonly emptyReason:
    | 'no-applicable-skill'
    | 'no-executable-skill'
    | 'limit-zero'
    | null
}

/** The evidence window a selection will accept. Same constant as promotion. */
const EVIDENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

function isEvidenceFresh(record: SkillFoldRecord, now: Date): boolean {
  for (const evaluation of currentVersionEvaluations(record)) {
    const at = Date.parse(evaluation.evaluatedAt)
    if (!Number.isFinite(at)) return false
    if (at > now.getTime()) return false
    if (now.getTime() - at > EVIDENCE_WINDOW_MS) return false
  }
  return true
}

function statusAllowed(status: SkillStatus, request: SkillSelectionRequest): boolean {
  if (!isSelectableSkillStatus(status)) return false
  if (status === 'promoted') return true
  if (status === 'trial') return request.includeTrial === true
  return request.includeVerified === true
}

function matchedTagsOf(record: SkillFoldRecord, tags: readonly string[]): readonly string[] {
  if (tags.length === 0) return []
  return tags.filter((tag) => record.applicability.includes(tag))
}

/**
 * Rank the skills a request may use.
 *
 * Pure: same state, same request, same array. No clock read beyond the injected one,
 * no randomness, no I/O, and nothing here can reach a model or a capability.
 */
export function selectSkills(state: SkillState, request: SkillSelectionRequest): SkillSelection {
  const tags = (request.applicability ?? []).slice(0, SKILL_LIMITS.maxApplicabilityTags)
  const limit = Math.max(0, Math.min(request.limit ?? SKILL_LIMITS.maxSelection, SKILL_LIMITS.maxSelection))

  const considered = state.records.length
  if (limit === 0) {
    return { candidates: [], considered, emptyReason: 'limit-zero' }
  }

  let sawExecutable = false
  const scored: Array<{ candidate: SkillSelectionCandidate; stale: boolean }> = []

  for (const record of state.records) {
    if (record.trustClass === 'untrusted-content') continue
    if (!statusAllowed(record.status, request)) continue
    sawExecutable = true
    const matched = matchedTagsOf(record, tags)
    // An empty tag list means "no filter", so nothing can be excluded for
    // non-matching. A non-empty one excludes everything that does not match.
    if (tags.length > 0 && matched.length === 0) continue
    const established = currentVersionEvaluations(record).filter(
      (evaluation) => evaluation.decision.verdict === 'established',
    ).length
    scored.push({
      candidate: {
        skillId: record.skillId,
        name: record.name,
        kind: record.kind,
        status: record.status,
        version: record.version,
        verification: record.verification,
        trustClass: record.trustClass,
        establishedCount: established,
        matchedTags: matched,
        executionsPlanned: record.executionsPlanned,
      },
      stale: !isEvidenceFresh(record, request.now),
    })
  }

  if (scored.length === 0) {
    return {
      candidates: [],
      considered,
      emptyReason: sawExecutable ? 'no-applicable-skill' : 'no-executable-skill',
    }
  }

  // Stale evidence does not remove a skill — a promoted skill whose evidence aged out
  // is still promoted, and removing it here would make the *list* lie about the
  // record. It only loses its place in the ordering, which is what makes staleness
  // matter without making it invisible.
  const ordered = [...scored].sort((left, right) => {
    if (left.stale !== right.stale) return left.stale ? 1 : -1
    if (left.candidate.establishedCount !== right.candidate.establishedCount) {
      return right.candidate.establishedCount - left.candidate.establishedCount
    }
    if (left.candidate.version !== right.candidate.version) {
      return right.candidate.version - left.candidate.version
    }
    const preference = statusPreference(left.candidate.status) - statusPreference(right.candidate.status)
    if (preference !== 0) return preference
    if (left.candidate.name !== right.candidate.name) {
      return left.candidate.name < right.candidate.name ? -1 : 1
    }
    // The final tiebreak is the id itself, so two records cannot compare equal.
    return left.candidate.skillId < right.candidate.skillId ? -1 : 1
  })

  return {
    candidates: ordered.slice(0, limit).map((entry) => entry.candidate),
    considered,
    emptyReason: null,
  }
}