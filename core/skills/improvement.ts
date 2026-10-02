import {
  IMPROVEMENT_TARGETS,
  isImprovementTarget,
  isProtectedDomain,
  normaliseSkillName,
  PROTECTED_DOMAINS,
  sanitiseSkillText,
  SKILL_LIMITS,
  type ImprovementTarget,
  type SkillRefusalCode,
} from './types'

/**
 * CONTROLLED IMPROVEMENT — bounded, explicit, and re-entering verification.
 *
 * Phase 17's promise is narrow on purpose: *Freya may improve ordinary
 * implementation and procedures.* This file is where "narrow" is enforced, and every
 * limit in it exists because of a specific way the broad version goes wrong.
 *
 * ## The five rules, and the attack each one answers
 *
 * 1. **A revision targets one of three ordinary things, never a protected domain.**
 *    `assertMutableTarget` refuses anything in `PROTECTED_DOMAINS`, anything that
 *    *contains* one of those names as a path segment, and anything whose text looks
 *    like a source-file reference into Core's own directories. A proposal naming
 *    `core/security/guard.ts` is refused with `boundary-violation` and journalled.
 * 2. **A revision is a new version, always.** `planRevision` returns version + 1 and
 *    status `candidate`. There is no "edit in place" operation in this domain at all —
 *    not hidden, not for the owner, not for Core — so "a promoted procedure was
 *    quietly swapped" has no spelling.
 * 3. **A new version starts its evidence from zero.** `currentVersionEvaluations`
 *    filters on version, so the previous version's evidence stops counting the moment
 *    the version changes. Stale-evidence reuse is refused by arithmetic rather than by
 *    a check somebody has to remember.
 * 4. **Revisions are bounded per lineage.** `maxRevisionsPerSkill` (3), counted as
 *    `version - 1` — because a bound that resets on every revision is not a bound, and
 *    a loop that always revises what it just made would never trip a per-version one.
 *    An
 *    improvement loop that does not converge stops after three attempts with
 *    `revision-limit`, which is the answer to "no infinite retry/training loops".
 * 5. **Nothing here burns a model call.** No gateway, no provider, no authority
 *    object appears in this file or in `core/skills/` at all. A proposal is recorded;
 *    whether a model was ever asked is not this domain's business, and `proposal`
 *    carries `proposedBy` so a reader can see who actually authored it.
 *
 * ## Runtime promotion does not exist
 *
 * Requirement: no automatic source-code self-rewrite of Freya's production runtime.
 * So `promoteIntoRuntime` does not have an implementation that writes anything. It
 * has an implementation that **records the refusal** and returns
 * `runtime-promotion-unavailable`, and `SkillArtifactSink` — the port a later,
 * reconciled architecture fills — is declared here with exactly one method,
 * `recordCandidate`, which returns a decision rather than performing a write.
 *
 * `InertSkillArtifactSink` is the shipped one. It accepts a candidate as *data* and
 * declines promotion, forever, in code that contains no filesystem import.
 */

export interface ProposalAttempt {
  readonly target: unknown
  readonly targetRef: unknown
  readonly summary: unknown
}

/** What a target is allowed to be. A closed list, or a refusal. */
export interface TargetVerdict {
  readonly ok: boolean
  readonly target: ImprovementTarget | null
  readonly targetRef: string | null
  readonly code: SkillRefusalCode | null
  readonly reason: string
}

const SOURCE_PATH_HINTS = [
  'core/',
  'src/',
  'electron/',
  'scripts/',
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  'package.json',
  'tsconfig',
] as const

/**
 * Refuse a target that is a protected domain, by name or by path shape.
 *
 * Two independent checks, because one of them is bypassable on its own:
 *
 * - **The closed vocabulary.** `PROTECTED_DOMAINS` is the list of things that must
 *   not be modified. A target that *is* one of those names is refused.
 * - **Path shape.** A target that contains a protected name as a substring, or that
 *   names a source file or a source directory, is refused even when the protected
 *   name is not present at all — because "improve `core/index.ts`" is the same
 *   request as "improve Core", wearing a path.
 *
 * The second check is deliberately blunt. It will also refuse a hypothetical
 * legitimate artifact under a path containing `src/`, and that is the correct
 * trade on an isolated phase: the cost is a human filing the artifact under a
 * different name, and the benefit is that there is no spelling of "rewrite Core"
 * this function accepts.
 */
export function assertMutableTarget(attempt: ProposalAttempt): TargetVerdict {
  if (!isImprovementTarget(attempt.target)) {
    return {
      ok: false,
      target: null,
      targetRef: null,
      code: 'invalid-skill-kind',
      reason: `an improvement target must be one of ${IMPROVEMENT_TARGETS.join(', ')}`,
    }
  }
  if (typeof attempt.targetRef !== 'string' || attempt.targetRef.trim().length === 0) {
    return {
      ok: false,
      target: null,
      targetRef: null,
      code: 'no-such-skill',
      reason: 'an improvement needs a target reference',
    }
  }
  const ref = attempt.targetRef.trim()
  if (ref.length > SKILL_LIMITS.maxRefChars) {
    return {
      ok: false,
      target: null,
      targetRef: null,
      code: 'contract-oversize',
      reason: `a target reference is at most ${SKILL_LIMITS.maxRefChars} characters`,
    }
  }
  if (isProtectedDomain(ref) || PROTECTED_DOMAINS.some((domain) => ref.includes(domain))) {
    return {
      ok: false,
      target: attempt.target,
      targetRef: ref,
      code: 'boundary-violation',
      reason: `${ref} is part of Freya's protected boundary and no revision may target it`,
    }
  }
  const lowered = ref.toLowerCase()
  for (const hint of SOURCE_PATH_HINTS) {
    if (lowered.includes(hint)) {
      return {
        ok: false,
        target: attempt.target,
        targetRef: ref,
        code: 'boundary-violation',
        reason: `${ref} names a source file or directory; production code is not a revision target`,
      }
    }
  }
  return { ok: true, target: attempt.target, targetRef: ref, code: null, reason: 'ordinary target' }
}

/** What a revision plan is, before anything is written. */
export interface RevisionPlan {
  readonly baseVersion: number
  readonly nextVersion: number
  readonly nextStatus: 'candidate'
  readonly summary: string
  readonly summaryLength: number
  readonly refusal: SkillRefusalCode | null
  readonly reason: string
}

export interface RevisionRequest {
  /** The version being revised. Read from the record; never from a payload. */
  readonly currentVersion: number
  /**
   * How many revisions this lineage already has (`version - 1`).
   *
   * Counted over the lineage so the bound can actually stop a loop.
   */
  readonly revisionsSoFar: number
  /** A digest of the current version's body, for the identical-revision check. */
  readonly currentContentHash: string
  /** A digest of the proposed body. */
  readonly proposedContentHash: string
  /** The proposed summary. Sanitised and bounded here, never trusted raw. */
  readonly summary: unknown
}

/**
 * Plan one revision.
 *
 * Pure: same request, same plan. It writes nothing, appends nothing and reads no
 * clock, so the whole of "what would happen" is checkable without a Core.
 *
 * Three refusals, in the order they are checked:
 *
 * - `revision-limit` — this version has already spawned its allowance. The loop bound.
 * - `identical-revision` — the proposed body hashes to the current body's hash, so
 *   the "change" changes nothing and would only dilute the version history.
 * - `contract-oversize` — the summary is over the bound after sanitising.
 *
 * On success the plan is always `nextVersion = baseVersion + 1` at status
 * `candidate`. That is the whole of "every revision gets a new version and must
 * re-enter verification", and it is structural: there is no other value this
 * function can return.
 */
export function planRevision(request: RevisionRequest): RevisionPlan {
  const summary = sanitiseSkillText(request.summary, SKILL_LIMITS.maxSummaryChars)
  const nextVersion = request.currentVersion + 1
  const base = {
    nextVersion,
    nextStatus: 'candidate' as const,
    summary,
    summaryLength: summary.length,
  }

  if (request.revisionsSoFar >= SKILL_LIMITS.maxRevisionsPerSkill) {
    return {
      ...base,
      baseVersion: request.currentVersion,
      refusal: 'revision-limit',
      reason: `this procedure already has ${request.revisionsSoFar} revisions; a revision loop must converge`,
    }
  }

  if (request.proposedContentHash === request.currentContentHash) {
    return {
      ...base,
      baseVersion: request.currentVersion,
      refusal: 'identical-revision',
      reason: 'the proposed body is byte-identical to the current version, so it is not a revision',
    }
  }

  if (typeof request.summary === 'string' && request.summary.length > SKILL_LIMITS.maxSummaryChars * 4) {
    return {
      ...base,
      baseVersion: request.currentVersion,
      refusal: 'contract-oversize',
      reason: `a summary is at most ${SKILL_LIMITS.maxSummaryChars} characters`,
    }
  }

  return {
    ...base,
    baseVersion: request.currentVersion,
    refusal: null,
    reason: `version ${nextVersion} starts again at candidate and re-enters verification`,
  }
}

/**
 * Whether a proposed revision raised the trust class of what it revises.
 *
 * Declared here so the engine can assert the invariant rather than re-derive it:
 * trust is inherited, never earned. `untrusted-content` cannot become `derived` by
 * being revised a few times, which is the laundering route a naive implementation
 * would leave open.
 */
export function wouldRaiseTrustClass(current: string, proposed: string): boolean {
  const order = ['untrusted-content', 'derived', 'owner-declared', 'code-owned']
  return order.indexOf(proposed) > order.indexOf(current)
}

/* ------------------------------------------------------- artifact contract */

/**
 * The only interface a later architecture may implement to receive an artifact
 * candidate.
 *
 * Deliberately shaped as *record, do not perform*: it returns a decision and it is
 * given no path, no handle and no capability. There is no `apply`, `write`,
 * `install`, `commit` or `promoteToRuntime` member, so implementing it cannot mean
 * editing Freya's source — the interface simply has no way to say that.
 *
 * When the reconciled Foundry architecture lands, it supplies an implementation that
 * records candidates in Foundry's own store. Until then the shipped sink declines
 * promotion, and this phase's promise — no automatic production self-rewrite — is
 * true by construction rather than by configuration.
 */
export interface SkillArtifactCandidate {
  readonly artifactId: string
  readonly target: Extract<ImprovementTarget, 'implementation-artifact'>
  readonly targetRef: string
  readonly skillId: string | null
  readonly baseVersion: number | null
  /** What the proposal was for, as a length. Never the text. */
  readonly summaryLength: number
  readonly proposedBy: 'system' | 'owner'
}

export interface SkillArtifactDecision {
  readonly accepted: boolean
  /** The closed reason, so a refusal is countable and testable. */
  readonly reason: SkillRefusalCode | null
  readonly detail: string
}

export interface SkillArtifactSink {
  /**
   * Record a candidate as *data*.
   *
   * The returned decision is whether the artifact may be *promoted into Freya's
   * running code*, which in this phase is always no.
   */
  recordCandidate(candidate: SkillArtifactCandidate): Promise<SkillArtifactDecision>
}

/**
 * The shipped sink: records the candidate and declines promotion.
 *
 * It holds no path, no filesystem import, no capability and no authority. The only
 * thing it does is exist, so that `SkillEngine` has a real dependency rather than a
 * nullable one that callers must remember to check.
 */
export class InertSkillArtifactSink implements SkillArtifactSink {
  async recordCandidate(_candidate: SkillArtifactCandidate): Promise<SkillArtifactDecision> {
    return {
      accepted: false,
      reason: 'runtime-promotion-unavailable',
      detail:
        'promoting an artifact into Freya\'s running code needs an explicit verified workflow that this build does not have; the candidate is recorded and nothing else happens',
    }
  }
}

/**
 * Ask a sink to promote an artifact into runtime.
 *
 * Exists so the refusal is a *recorded, testable* outcome on the normal path rather
 * than an absence of code. It always returns a decision, appends nothing, and never
 * throws: a caller that wanted to rewrite Core gets a refusal in words.
 */
export async function promoteIntoRuntime(
  sink: SkillArtifactSink,
  candidate: SkillArtifactCandidate,
): Promise<SkillArtifactDecision> {
  const decision = await sink.recordCandidate(candidate)
  if (decision.accepted && decision.reason === null) {
    // Belt and braces. A sink that reported success *without a reason* is treated as
    // a refusal, because an unaccountable acceptance is indistinguishable from a bug
    // in the sink and the safe reading of an unaccountable claim is "no".
    return {
      accepted: false,
      reason: 'runtime-promotion-unavailable',
      detail: 'the sink reported success without a reason, which is refused as unaccountable',
    }
  }
  return decision
}

/** A bounded artifact reference. Slug only — never a path. */
export function normaliseArtifactRef(raw: unknown): string | null {
  return normaliseSkillName(raw)
}