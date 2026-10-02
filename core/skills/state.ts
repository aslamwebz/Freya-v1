import type { AnyCoreEvent } from '../events/envelope'
import {
  canTransitionSkill,
  isProtectedDomain,
  PROTECTED_DOMAINS,
  SKILL_LIMITS,
  SKILL_TERMINAL_STATUSES,
  type EvaluationSubjectKind,
  type ImprovementTarget,
  type SkillEvaluation,
  type SkillEvaluationDecision,
  type SkillKind,
  type SkillRetirementReason,
  type SkillSource,
  type SkillStatus,
  type SkillTrustClass,
  type SkillVerificationState,
} from './types'
import { deriveVerificationState } from './promotion'

/**
 * SKILL STATE — the fold of the durable `skill.*` events.
 *
 * The same rule as every other subsystem in this repository: there is no mutable
 * state that is not the journal's image. Status, verification, provenance, version
 * history, evaluation records and open proposals are all *derived* from events,
 * which is what makes them survive a restart without a second store and without a
 * hidden preference on disk.
 *
 * ## What is deliberately not here
 *
 * **No skill content.** A contract entry's description, a summary and an
 * applicability tag are private procedure text. The journal is metadata only — ids,
 * closed labels, counts, instants and measured lengths — so the fold cannot hold a
 * procedure even if it wanted to. The body lives in the encrypted skill store, and
 * this file never sees it.
 *
 * ## Two independent refusals
 *
 * A replayed journal is a door, and the properties this file exists to hold are
 * checked twice: once in `events/validate.ts`, which refuses a malformed line before
 * it becomes an event, and once here, which refuses a *well-formed but illegal*
 * transition. A hand-edited `candidate → promoted` line passes every field check —
 * both names are in the closed table — and is refused here, because the fold knows
 * what the record was and the payload's `from` does not have to agree with it.
 *
 * ## Bounded
 *
 * `maxRetainedSkills`, `maxVersionsPerSkill`, `maxRetainedEvaluations` and
 * `maxOpenProposals` are caps rather than a leak waiting to happen. Version metadata
 * is dropped oldest-first, and dropping it cannot change identity or the current
 * version — those live on the record, not in the history list.
 */

export interface SkillCounts {
  readonly admitted: number
  readonly revised: number
  readonly evaluations: number
  readonly established: number
  readonly contradicted: number
  readonly inconclusive: number
  readonly executionsPlanned: number
  readonly promotions: number
  readonly retirements: number
  readonly proposals: number
  readonly proposalsRefused: number
  readonly rejectedAdmissions: number
  readonly runtimePromotionsRefused: number
}

export interface SkillProposalRecord {
  readonly proposalId: string
  readonly target: ImprovementTarget
  readonly targetRef: string
  readonly skillId: string | null
  readonly baseVersion: number | null
  readonly summaryLength: number
  readonly basisEvaluationIds: readonly string[]
  readonly proposedBy: 'system' | 'owner'
  readonly createdAt: string
  readonly status: 'open' | 'accepted' | 'refused'
  readonly settledAt: string | null
  readonly settledReason: string | null
}

export interface SkillVersionMetadata {
  readonly version: number
  readonly contentHash: string
  readonly createdAt: string
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly stepCount: number
  readonly requiredCapabilityCount: number
  readonly applicabilityCount: number
  readonly inputCount: number
  readonly outputCount: number
  readonly preconditionCount: number
  readonly postconditionCount: number
  readonly summaryLength: number
  /** How many revisions this version spawned. The improvement loop's bound. */
  readonly revisions: number
}

export interface SkillFoldRecord {
  readonly skillId: string
  readonly name: string
  readonly nameLength: number
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly admittedAt: string
  readonly promotedAt: string | null
  readonly retiredAt: string | null
  readonly retirementReason: SkillRetirementReason | null
  /**
   * The declared applicability tags, as bounded slugs.
   *
   * Slugs rather than prose, so a tag can be journalled and matched on without
   * becoming a place a sentence could hide. This is the only content-bearing field
   * the fold holds for a skill, it is a list of `[a-z0-9-]` tokens of at most
   * `maxTagChars`, and the validator checks exactly that on replay.
   */
  readonly applicability: readonly string[]
  readonly versions: readonly SkillVersionMetadata[]
  readonly evaluations: readonly SkillEvaluation[]
  readonly executionsPlanned: number
  readonly updatedAt: string
}

export interface SkillState {
  readonly records: readonly SkillFoldRecord[]
  readonly proposals: readonly SkillProposalRecord[]
  readonly rejectedAdmissions: readonly { attemptId: string; code: string; targetRef: string | null }[]
  readonly runtimePromotionRefusals: readonly { artifactId: string; targetRef: string; reason: string }[]
  readonly counts: SkillCounts
}

export function initialSkillState(): SkillState {
  return {
    records: [],
    proposals: [],
    rejectedAdmissions: [],
    runtimePromotionRefusals: [],
    counts: {
      admitted: 0,
      revised: 0,
      evaluations: 0,
      established: 0,
      contradicted: 0,
      inconclusive: 0,
      executionsPlanned: 0,
      promotions: 0,
      retirements: 0,
      proposals: 0,
      proposalsRefused: 0,
      rejectedAdmissions: 0,
      runtimePromotionsRefused: 0,
    },
  }
}

function pushBounded<T>(list: readonly T[], value: T, max: number): readonly T[] {
  const next = [...list, value]
  return next.length > max ? next.slice(next.length - max) : next
}

function withRecord(
  state: SkillState,
  skillId: string,
  change: (record: SkillFoldRecord) => SkillFoldRecord,
): { state: SkillState; changed: boolean } {
  const existing = findSkill(state, skillId)
  if (existing === null) return { state, changed: false }
  const next = change(existing)
  if (next === existing) return { state, changed: false }
  return { state: { ...state, records: state.records.map((record) => (record.skillId === skillId ? next : record)) }, changed: true }
}

/** Add one to a counter, immutably. */
function bump(counts: SkillCounts, key: keyof SkillCounts, by = 1): SkillCounts {
  return { ...counts, [key]: counts[key] + by }
}

export type { SkillEvaluation }

/** The record for one skill, or null. The only lookup the fold offers. */
export function findSkill(state: SkillState, skillId: string): SkillFoldRecord | null {
  for (const record of state.records) if (record.skillId === skillId) return record
  return null
}

/**
 * The record a *name* resolves to.
 *
 * Present so a caller can be shown "you already have a skill called that" rather
 * than being admitted a second one, and so admission is idempotent by construction:
 * identity is derived from the name, and this is the same derivation read back.
 */
export function findSkillByName(state: SkillState, name: string): SkillFoldRecord | null {
  for (const record of state.records) if (record.name === name) return record
  return null
}

/** Skills whose status permits planning them into a Run. */
export function executableSkills(state: SkillState): readonly SkillFoldRecord[] {
  return state.records.filter(
    (record) =>
      (record.status === 'trial' ||
        record.status === 'verified' ||
        record.status === 'promoted') &&
      record.trustClass !== 'untrusted-content',
  )
}

function versionMetadataFrom(
  event: Extract<AnyCoreEvent, { type: 'skill.admitted' | 'skill.revised' }>,
  revisions: number,
): SkillVersionMetadata {
  return {
    version: event.payload.version,
    contentHash: event.payload.contentHash,
    createdAt: event.occurredAt,
    source: event.payload.source,
    trustClass: event.payload.trustClass,
    admittedBy: event.payload.admittedBy,
    stepCount: event.payload.stepCount,
    requiredCapabilityCount: event.payload.requiredCapabilityCount,
    applicabilityCount: event.payload.applicabilityCount,
    inputCount: event.payload.inputCount,
    outputCount: event.payload.outputCount,
    preconditionCount: event.payload.preconditionCount,
    postconditionCount: event.payload.postconditionCount,
    summaryLength: event.payload.summaryLength,
    revisions,
  }
}

function decisionFrom(payload: {
  verdict: SkillEvaluationDecision['verdict']
  reason: SkillEvaluationDecision['reason']
  deterministicCount: number
  positiveCount: number
  negativeCount: number
  commentaryChars: number
}): SkillEvaluationDecision {
  return {
    verdict: payload.verdict,
    reason: payload.reason,
    deterministicCount: payload.deterministicCount,
    positiveCount: payload.positiveCount,
    negativeCount: payload.negativeCount,
    commentaryChars: payload.commentaryChars,
  }
}

/**
 * Fold one durable event into skill state.
 *
 * Only `skill.*` events change it; everything else returns the same object, so this
 * can be called for every event in the log without cost.
 *
 * Every case is total: an event that is well-formed but *illegal* (a transition the
 * record's own history does not support, a revision of a retired skill, an
 * evaluation for a version that does not exist) leaves the state untouched rather than
 * throwing or partially applying. Recovery reads a journal nobody can trust, so the
 * fold's job is to believe as little as possible and say so.
 */
export function reduceSkillState(state: SkillState, event: AnyCoreEvent): SkillState {
  if (!event.type.startsWith('skill.')) return state

  switch (event.type) {
    case 'skill.admitted': {
      const p = event.payload
      // Identity is derived from the name, so a second record for the same name is a
      // duplicate however it got here. Refused rather than replaced: overwriting a
      // record because a forged line repeated its name would let anyone rewrite a
      // skill's status by appending one more `skill.admitted`.
      if (findSkillByName(state, p.name) !== null) {
        return {
          ...state,
          rejectedAdmissions: pushBounded(
            state.rejectedAdmissions,
            { attemptId: event.eventId, code: 'duplicate-identity', targetRef: p.name },
            SKILL_LIMITS.maxOpenProposals,
          ),
          counts: { ...state.counts, rejectedAdmissions: state.counts.rejectedAdmissions + 1 },
        }
      }
      if (state.records.length >= SKILL_LIMITS.maxRetainedSkills) return state

      const record: SkillFoldRecord = {
        skillId: p.skillId,
        name: p.name,
        nameLength: p.nameLength,
        kind: p.kind,
        status: 'candidate',
        version: p.version,
        verification: 'unverified',
        source: p.source,
        trustClass: p.trustClass,
        admittedBy: p.admittedBy,
        admittedAt: event.occurredAt,
        promotedAt: null,
        retiredAt: null,
        retirementReason: null,
        applicability: [...p.applicability],
        versions: [versionMetadataFrom(event, 0)],
        evaluations: [],
        executionsPlanned: 0,
        updatedAt: event.occurredAt,
      }
      return {
        ...state,
        records: [...state.records, record],
        counts: { ...state.counts, admitted: state.counts.admitted + 1 },
      }
    }

    case 'skill.revised': {
      const p = event.payload
      const applied = withRecord(state, p.skillId, (record) => {
        // A revision of a terminal skill is refused, and so is one that does not
        // advance the version by exactly one. Both are the shape a forged line takes:
        // "bump a retired procedure back to life" and "rewrite version 2 in place".
        if (SKILL_TERMINAL_STATUSES.includes(record.status as 'retired')) return record
        if (p.version !== record.version + 1) return record
        if (p.name !== record.name) return record
        const revisions = record.versions.find((version) => version.version === record.version)
        const nextRevisions = (revisions?.revisions ?? 0) + 1
        const versions = record.versions
          .map((version) =>
            version.version === record.version ? { ...version, revisions: nextRevisions } : version,
          )
          .concat(versionMetadataFrom(event, 0))
        return {
          ...record,
          // Every revision re-enters verification from the bottom. A new version
          // starts at `candidate` even when the one it replaces was `promoted`:
          // promotion is granted for a version, not for a name.
          status: 'candidate' as SkillStatus,
          version: p.version,
          verification: 'unverified' as SkillVerificationState,
          // Trust is inherited, never raised. An improvement cannot promote
          // `untrusted-content` into `derived`, which is what stops a revision loop
          // from laundering trust upward one version at a time.
          source: 'improvement' as SkillSource,
          trustClass: record.trustClass,
          promotedAt: null,
          // Applicability may change with a revision; the *name* may not, because the
          // name is the identity and identity is what makes a revision a revision.
          applicability: [...p.applicability],
          versions: versions.slice(-SKILL_LIMITS.maxVersionsPerSkill),
          // The previous version's evaluations stay on the record but stop counting,
          // because `currentVersionEvaluations` filters on the version. They are kept
          // so an audit can still see what the evidence was before the change.
          updatedAt: event.occurredAt,
        }
      })
      return applied.changed
        ? { ...applied.state, counts: bump(applied.state.counts, 'revised') }
        : state
    }

    case 'skill.transitioned': {
      const p = event.payload
      const applied = withRecord(state, p.skillId, (record) => {
        if (record.status !== p.from) return record
        if (!canTransitionSkill(p.from, p.to)) return record
        // Retirement is its own event family, so a lifecycle line cannot quietly
        // reach a terminal status and hide the reason.
        if (SKILL_TERMINAL_STATUSES.includes(p.to as 'retired')) return record
        return {
          ...record,
          status: p.to,
          promotedAt: p.to === 'promoted' ? event.occurredAt : record.promotedAt,
          updatedAt: event.occurredAt,
          // `stale` only on a *withdrawal*: leaving `verified` or `promoted` for a
          // lower status is a decision to stop relying on the evidence, and the record
          // must stop claiming it is verified. The ordinary first pass
          // `candidate → draft` is not a withdrawal — the version never had evidence
          // to lose — so it leaves the state alone.
          ...(p.to === 'draft' && (p.from === 'verified' || p.from === 'promoted')
            ? { verification: 'stale' as SkillVerificationState }
            : {}),
        }
      })
      return applied.changed && p.to === 'promoted'
        ? { ...applied.state, counts: bump(applied.state.counts, 'promotions') }
        : applied.state
    }

    case 'skill.retired': {
      const p = event.payload
      const applied = withRecord(state, p.skillId, (record) => {
        if (SKILL_TERMINAL_STATUSES.includes(record.status as 'retired')) return record
        return {
          ...record,
          status: p.to,
          retiredAt: event.occurredAt,
          retirementReason: p.reason,
          verification: 'stale' as SkillVerificationState,
          promotedAt: null,
          updatedAt: event.occurredAt,
        }
      })
      return applied.changed
        ? { ...applied.state, counts: bump(applied.state.counts, 'retirements') }
        : state
    }

    case 'skill.evaluation.recorded': {
      const p = event.payload
      const applied = withRecord(state, p.skillId, (record) => {
        // Evidence for a version this record never had is refused: it is the exact
        // shape of "reuse the evidence from three versions ago to promote this one".
        if (p.version !== record.version) return record
        const evaluation: SkillEvaluation = {
          evaluationId: p.evaluationId,
          skillId: p.skillId,
          version: p.version,
          subjectKind: p.subjectKind as EvaluationSubjectKind,
          subjectRef: p.subjectRef,
          author: p.author,
          evaluatedAt: event.occurredAt,
          decision: decisionFrom(p),
        }
        const evaluations = pushBounded(
          record.evaluations,
          evaluation,
          SKILL_LIMITS.maxRetainedEvaluations,
        )
        const next: SkillFoldRecord = {
          ...record,
          evaluations,
          updatedAt: event.occurredAt,
        }
        // Verification state is *derived* from the evaluations rather than carried in
        // the event, so there is no spelling of the journal that can mark a version
        // verified without the evaluations that justify it.
        return { ...next, verification: deriveVerificationState(next) }
      })
      if (!applied.changed) return state
      const evaluated = applied.state.records.find((record) => record.skillId === p.skillId)
      const latest = evaluated?.evaluations[evaluated.evaluations.length - 1]
      let counts = bump(applied.state.counts, 'evaluations')
      // One counter for the total, one for the verdict shape. Both are counts of
      // records, and both are derived here rather than carried in the event, so a
      // forged line cannot make a registry claim more successes than it holds.
      if (latest !== undefined) {
        if (latest.decision.verdict === 'established') counts = bump(counts, 'established')
        else if (latest.decision.verdict === 'contradicted') counts = bump(counts, 'contradicted')
        else if (latest.decision.verdict === 'inconclusive') counts = bump(counts, 'inconclusive')
      }
      return { ...applied.state, counts }
    }

    case 'skill.execution.planned': {
      const applied = withRecord(state, event.payload.skillId, (record) => {
        if (event.payload.version !== record.version) return record
        return { ...record, executionsPlanned: record.executionsPlanned + 1, updatedAt: event.occurredAt }
      })
      return applied.changed
        ? { ...applied.state, counts: bump(applied.state.counts, 'executionsPlanned') }
        : state
    }

    case 'skill.improvement.proposed': {
      const p = event.payload
      if (p.openProposalsAt >= SKILL_LIMITS.maxOpenProposals) return state
      const proposal: SkillProposalRecord = {
        proposalId: p.proposalId,
        target: p.target,
        targetRef: p.targetRef,
        skillId: p.skillId,
        baseVersion: p.baseVersion,
        summaryLength: p.summaryLength,
        basisEvaluationIds: p.basisEvaluationIds,
        proposedBy: p.proposedBy,
        createdAt: event.occurredAt,
        status: 'open',
        settledAt: null,
        settledReason: null,
      }
      return {
        ...state,
        proposals: pushBounded(state.proposals, proposal, SKILL_LIMITS.maxRetainedSkills),
        counts: { ...state.counts, proposals: state.counts.proposals + 1 },
      }
    }

    case 'skill.improvement.settled': {
      const p = event.payload
      const proposals = state.proposals.map((proposal) =>
        proposal.proposalId === p.proposalId && proposal.status === 'open'
          ? {
              ...proposal,
              status: p.decision,
              settledAt: event.occurredAt,
              settledReason: p.reason,
            }
          : proposal,
      )
      return {
        ...state,
        proposals,
        counts: {
          ...state.counts,
          proposalsRefused: p.decision === 'refused' ? state.counts.proposalsRefused + 1 : state.counts.proposalsRefused,
        },
      }
    }

    case 'skill.proposal.rejected':
      return {
        ...state,
        rejectedAdmissions: pushBounded(
          state.rejectedAdmissions,
          { attemptId: event.payload.attemptId, code: event.payload.code, targetRef: event.payload.targetRef },
          SKILL_LIMITS.maxOpenProposals,
        ),
        counts: { ...state.counts, rejectedAdmissions: state.counts.rejectedAdmissions + 1 },
      }

    case 'skill.runtime.promotion.refused':
      return {
        ...state,
        runtimePromotionRefusals: pushBounded(
          state.runtimePromotionRefusals,
          {
            artifactId: event.payload.artifactId,
            targetRef: event.payload.targetRef,
            reason: event.payload.reason,
          },
          SKILL_LIMITS.maxOpenProposals,
        ),
        counts: {
          ...state.counts,
          runtimePromotionsRefused: state.counts.runtimePromotionsRefused + 1,
        },
      }

    default:
      return state
  }
}

/** Total counts across the whole fold, for the projection. */
export function summariseSkillCounts(state: SkillState): SkillCounts & {
  readonly established: number
  readonly promoted: number
  readonly executable: number
} {
  let established = 0
  let contradicted = 0
  let inconclusive = 0
  let promoted = 0
  let executable = 0
  for (const record of state.records) {
    for (const evaluation of record.evaluations) {
      if (evaluation.decision.verdict === 'established') established += 1
      else if (evaluation.decision.verdict === 'contradicted') contradicted += 1
      else if (evaluation.decision.verdict === 'inconclusive') inconclusive += 1
    }
    if (record.status === 'promoted') promoted += 1
    if (
      record.trustClass !== 'untrusted-content' &&
      (record.status === 'trial' || record.status === 'verified' || record.status === 'promoted')
    ) {
      executable += 1
    }
  }
  return {
    ...state.counts,
    established,
    contradicted,
    inconclusive,
    promoted,
    executable,
  }
}

/**
 * Whether a target reference is one of the protected domains.
 *
 * Exported so the engine, the validator and the tests all answer the boundary
 * question from the same table, rather than each having its own list of things that
 * must not be touched.
 */
export function targetIsProtected(targetRef: string): boolean {
  return isProtectedDomain(targetRef) || PROTECTED_DOMAINS.some((domain) => targetRef.includes(domain))
}