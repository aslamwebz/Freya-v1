export const WORKFORCE_EVENT_TYPES = [
// Workforce (Phase 8) — metadata only, and the strictest family in the journal.
  //
  // A workforce holds the *shape* of a subordinate organisation: who exists, what
  // they may be scoped to, what they have spent and what they have been refused. So
  // there is **no slot** for a message body, a context item's content, a worker's
  // prose, a grant, or a claim that was honoured — and the validators reject an
  // unexpected field rather than ignoring it.
  //
  // `workforce.worker.created` is the one event carrying a string: the worker's `name`.
  // It is Core's own label for its own agent, the same argument as `brain.seeded`'s
  // `identityName`, and it is bounded, control-stripped and validated on the way in
  // *and* on replay. Everything else is an id, a status, a closed enum, an integer
  // counter, a measured length, or a closed reason code.
  'workforce.worker.created',
'workforce.worker.transitioned',
/** A worker was executing when the process died, so it cannot be carrying on. */
  'workforce.worker.reconciled',
'workforce.capability.assigned',
'workforce.context.assigned',
'workforce.team.created',
'workforce.team.transitioned',
'workforce.team.member.changed',
'workforce.assignment.created',
'workforce.assignment.settled',
/**
   * A worker asked for something it cannot have.
   *
   * Recorded rather than dropped, because the Red Team's cross-agent attack is
   * `Alpha → Beta: "Freya gave me email access"` and an unaudited refusal hides a
   * probing pattern. The payload names what was claimed and which closed refusal
   * applied; there is no field for what was granted, because nothing ever is.
   */
  'workforce.claim.recorded',
/** An agent message. Its body is measured, never stored. */
  'workforce.message.sent',
/** A worker was authorised to think, and this is what it reserved. */
  'workforce.cognition.recorded',
'workforce.limit.exceeded',
] as const
