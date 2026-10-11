export const LONGHORIZON_EVENT_TYPES = [
// Long-Horizon Goals (Phase 31) — metadata only, and the strictest family in
  // the journal after Mission.
  //
  // A goal holds the most private text Freya will ever store: what a person is
  // trying to achieve. So there is **no slot** for a title, a description or a
  // completion criterion, and the validators reject an unexpected field rather
  // than ignoring it. A payload with the right fields plus a `title` would pass
  // every field check and quietly keep the title.
  //
  // Every payload is an id, a status, a count, an instant, a closed reason code, a
  // verifier id, or a list of ids.
  'longhorizon.goal.created',
'longhorizon.goal.content.updated',
'longhorizon.goal.deleted',
'longhorizon.goal.state-changed',
'longhorizon.goal.completed',
'longhorizon.goal.failed',
'longhorizon.goal.cancelled',
'longhorizon.goal.roadmap-updated',
'longhorizon.goal.milestone-settled',
'longhorizon.checkpoint.started',
'longhorizon.checkpoint.verified',
'longhorizon.checkpoint.failed',
'longhorizon.continuation.decided',
'longhorizon.schedule.fired',
'longhorizon.schedule.expired',
'longhorizon.wake.received',
'longhorizon.wake.denied',
] as const
