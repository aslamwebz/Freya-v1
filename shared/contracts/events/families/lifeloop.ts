export const LIFELOOP_EVENT_TYPES = [
// Continuous Life Loop (Phase 23) — metadata only, and the family where the
  // *absence of a model call* is the interesting record.
  //
  // These seventeen events describe the loop's own continuation: what woke it, what
  // the deterministic filter said, what it was authorized to think about, what it did
  // and what it verified. Not one of them carries a prompt, an answer, a provider
  // identity or the text of the event that woke the loop — a life-loop entry that
  // could carry a sentence would quietly turn the least protected file in the system
  // into a transcript of what Freya was thinking, so every string here is a closed
  // code or a reference, and the fold refuses a payload key outside the published
  // vocabulary rather than accepting a new field.
  //
  // None of these is a security event, on the argument given for `attention.*`: a
  // wake, a denial, a thought and a verification grant nothing. The two that come
  // closest — `lifeloop.stopped` and `lifeloop.unstopped` — do not mint authority
  // either, because the latch they record is written by Core from the owner's
  // `security.stopAll` / `security.resume` behind Guard, and the fold refuses a
  // clearable stop being lifted by anything other than the owner.
  'lifeloop.wake.received',
'lifeloop.wake.denied',
'lifeloop.filter.passed',
'lifeloop.filter.denied',
'lifeloop.cognition.requested',
'lifeloop.cognition.denied',
'lifeloop.action.started',
'lifeloop.action.completed',
'lifeloop.action.failed',
'lifeloop.verification.started',
'lifeloop.verification.passed',
'lifeloop.verification.failed',
'lifeloop.continuation.decided',
'lifeloop.reconciled',
'lifeloop.unstopped',
'lifeloop.reset',
'lifeloop.stopped',
] as const
