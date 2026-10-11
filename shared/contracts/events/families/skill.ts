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
