export const ATTENTION_EVENT_TYPES = [
// Attention (Phase 12) — metadata only, and the family where "do nothing" is a
  // first-class outcome rather than an absence.
  //
  // An attention event describes *that an authorized source delivered something*
  // and *what Core decided about it*. There is no slot for the event's text: the
  // text is process-local data, never written here, and comes back only from an
  // explicit owner detail read. Every field is an id, a closed label, an instant or
  // a measured length.
  //
  // None of these is a security event. A decision cannot grant cognition, clear a
  // stop or widen a permission, and a budget that ran out says nothing about the
  // authority to run anything — the same argument that keeps `work.*` and
  // `brain.degraded` out of `SECURITY_EVENT_TYPES`.
  'attention.event.ingested',
'attention.decision.made',
'attention.budget.exceeded',
'attention.schedule.registered',
'attention.schedule.fired',
'attention.schedule.cancelled',
] as const
