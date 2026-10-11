import type {
  EvaluationAuthor,
  EvaluationReason,
  EvaluationSubjectKind,
  ImprovementTarget,
  SkillKind,
  SkillRefusalCode,
  SkillRetirementReason,
  SkillSource,
  SkillStatus,
  SkillTrustClass,
  SkillVerdict,
} from '../vocabulary/skill'

export const SKILL_EVENT_TYPES = [
// Skills (Phase 17) ??? metadata only, and the family where the *body* is absent.
  //
  // A skill is a reusable procedure: its inputs, outputs, preconditions,
  // postconditions, its steps and the capability map it will ask for. None of that is
  // here. What is here is the metadata a fold needs to know the skill exists, what
  // version it is at, what state its lifecycle is in, and what the evidence behind it
  // said ??? which is what makes a stolen laptop useless as a way to learn what Freya
  // can do, and what makes the journal safe to keep in a backup.
  //
  // The two string-bearing fields are both deliberate and both bounded:
  //   - `name`, normalised to a slug, because identity is *derived* from it and a fold
  //     that could not say what a skill is called could not check for duplicates.
  //   - `applicability`, a bounded list of the same slug shape, because selection has
  //     to match on it and a closed-shape token is what makes that match auditable.
  // Everything else is an id, a closed label, an integer count, an instant, or a
  // measured length. A skill's summary is measured; a contract entry's description is
  // counted; model commentary is *counted in characters and nothing else*.
  'skill.admitted',
'skill.revised',
'skill.transitioned',
'skill.retired',
'skill.evaluation.recorded',
'skill.execution.planned',
'skill.improvement.proposed',
'skill.improvement.settled',
/**
   * An attempt to admit or improve something was refused.
   *
   * Recorded rather than dropped, for the same reason `workforce.claim.recorded`
   * exists: an unaudited refusal hides a probing pattern, and a poisoned-skill
   * admission attempt is exactly the thing somebody would want to be able to audit.
   * The payload is a **closed refusal code** and a bounded reference ??? never the text
   * that was refused, because the text is the attack.
   */
  'skill.proposal.rejected',
/**
   * Somebody asked for an artifact to enter Freya's running code.
   *
   * `skill.runtime.promotion.refused` has **one** legal value for its name and no
   * counterpart that records a success. There is no spelling of this journal in which
   * an artifact reached runtime, which is the structural form of "no automatic
   * source-code self-rewrite of the production runtime".
   */
  'skill.runtime.promotion.refused',
] as const

/**
 * The closed refusal-code union, plus the one literal a settled acceptance carries.
 *
 * `SkillRefusalReason` exists because `skill.improvement.settled` has to be able to
 * say `accepted` on the line that records an acceptance, and the alternative ??? a free
 * string ??? would let that field carry anything. Widening the union by one literal
 * keeps the closed-set property while letting the accepted case be stated plainly.
 */
export type SkillRefusalReason = SkillRefusalCode | 'accepted'

/**
 * One admitted or revised skill version, as it appears in the journal.
 *
 * Every field is an id, a closed label, an integer, an instant or a measured length ???
 * with two bounded slugs. The reason both are allowed: identity is *derived* from the
 * name, so a fold that could not read the name could not detect a second skill with
 * the same identity, and selection matches on the applicability tags, so a fold that
 * could not read them could not rank anything. Neither is prose, both are
 * control-stripped on the way in and re-checked on replay, and neither could hold a
 * sentence.
 */
export interface SkillVersionEvent {
  skillId: string
  /** A normalised slug, `[a-z0-9][a-z0-9-]*`. The identity key. */
  name: string
  nameLength: number
  kind: SkillKind
  version: number
  contentHash: string
  source: SkillSource
  trustClass: SkillTrustClass
  admittedBy: string
  originRef: string | null
  stepCount: number
  requiredCapabilityCount: number
  applicabilityCount: number
  /** Bounded slugs. Declared applicability, and the only thing selection matches on. */
  applicability: string[]
  inputCount: number
  outputCount: number
  preconditionCount: number
  postconditionCount: number
  summaryLength: number
}

export interface SkillEventPayloads {
/* ---------------------------------------------------------------- skills */

  /**
   * A skill was admitted, or a version was revised.
   *
   * One shape for both, because the fields that matter are the same: which skill, at
   * which version, whose act created it, from what source, at what trust class, and
   * how big its body is. `version` is 1 for an admission and always exactly one more
   * than the record it replaces for a revision ??? which the fold checks, so a
   * hand-edited "revision" that does not advance the version is refused rather than
   * folded.
   *
   * `contentHash` is here so a revision can be shown to be a change and an
   * identical-revision can be refused without holding either body.
   */
  'skill.admitted': SkillVersionEvent

'skill.revised': SkillVersionEvent

/**
   * A lifecycle transition.
   *
   * `from` is in the payload as well as implied by the previous event, so the fold can
   * refuse a transition whose history does not agree with itself. A hand-edited line
   * claiming `candidate ??? promoted` passes every field check ??? both names are in the
   * closed table ??? and is refused by `reduceSkillState`, which is the second of two
   * independent refusals.
   *
   * `evidence` is present for transitions that were gated and absent otherwise. It is
   * four integers and never a verdict a caller supplied: promotion reads the fold's own
   * evaluations and echoes the counts it found.
   */
  'skill.transitioned': {
    skillId: string
    from: SkillStatus
    to: SkillStatus
    /** A closed code from `PROMOTION_REASONS`. */
    reason: string
    evidence: {
      version: number
      established: number
      contradicted: number
      distinctSubjects: number
    } | null
  }

/**
   * A skill was retired or blocked.
   *
   * Its own event family rather than a `skill.transitioned` with `to: 'retired'`,
   * because retirement is the one transition that needs its reason audited separately:
   * "this was retired because it was unsafe" and "this was retired because it was
   * superseded" are different facts about Freya's honesty.
   */
  'skill.retired': {
    skillId: string
    version: number
    to: 'retired' | 'blocked'
    reason: SkillRetirementReason
  }

/**
   * An evaluation was recorded.
   *
   * `verdict` and `reason` are Core's own closed codes, computed by `evaluateOutcome`
   * from deterministic evidence. `commentaryChars` is a **count of model characters**,
   * stored next to the verdict precisely so an auditor can see that four thousand
   * characters of opinion moved nothing. `version` is written from the record rather
   * than from the payload, which is what makes stale-evidence reuse impossible.
   */
  'skill.evaluation.recorded': {
    evaluationId: string
    skillId: string
    version: number
    subjectKind: EvaluationSubjectKind
    subjectRef: string
    author: EvaluationAuthor
    verdict: SkillVerdict
    reason: EvaluationReason
    deterministicCount: number
    positiveCount: number
    negativeCount: number
    commentaryChars: number
  }

/** A skill was planned into an existing Run and Step. Ids and a count. */
  'skill.execution.planned': {
    skillId: string
    version: number
    runId: string
    stepId: string
    stepCount: number
  }

/**
   * An improvement was proposed.
   *
   * `target` is one of the three ordinary things improvement may touch, and
   * `targetRef` has already been checked against the closed protected-domain list ???
   * so a proposal naming the Constitution or a source file never becomes a line in
   * this journal. `basisEvaluationIds` are ids Core derived itself; a caller cannot
   * choose which evidence a proposal rests on.
   */
  'skill.improvement.proposed': {
    proposalId: string
    target: ImprovementTarget
    targetRef: string
    skillId: string | null
    baseVersion: number | null
    summaryLength: number
    basisEvaluationIds: string[]
    proposedBy: EvaluationAuthor
    /** How many proposals were already open, for the bound's audit trail. */
    openProposalsAt: number
  }

/** A proposal was accepted or refused. `reason` is a closed refusal code. */
  'skill.improvement.settled': {
    proposalId: string
    decision: 'accepted' | 'refused'
    reason: SkillRefusalReason
  }

/** An admission or improvement attempt was refused. A code and a bounded ref only. */
  'skill.proposal.rejected': {
    attemptId: string
    code: SkillRefusalCode | string
    targetRef: string | null
  }

/**
   * An artifact could not enter runtime.
   *
   * One legal outcome, named for what it is. A body that had an `accepted` field, or a
   * sibling event for success, would be a place a self-rewriting runtime could be
   * recorded as having happened ??? and that is the claim Phase 17 must never make
   * possible to write down.
   */
  'skill.runtime.promotion.refused': {
    artifactId: string
    targetRef: string
    reason: SkillRefusalReason
  }
}