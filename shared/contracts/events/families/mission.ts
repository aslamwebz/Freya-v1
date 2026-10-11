export const MISSION_EVENT_TYPES = [
/**
   * A Phase 47 autonomy transition, for any edge the six named lifecycle events do
   * not name.
   *
   * A separate type rather than overloading `mission.activated` and friends, because
   * those six name *specific historical facts* — activated, resumed, paused — and a
   * journal that cannot tell a first activation from a resume cannot answer "was this
   * ever stopped?". `from` and `to` are carried explicitly so the reducer can refuse a
   * transition whose history does not agree with itself.
   */
  'mission.transitioned',
/**
   * A plan was committed.
   *
   * The whole plan arrives in one event, and every step in it is validated before the
   * commit is accepted: a plan with one unreadable step is refused whole rather than
   * half-committed. `revision` is checked against the Mission's own count, so a journal
   * cannot jump revisions to slip past the replan ceiling.
   */
  'mission.plan.committed',
/** One step changed status. */
  'mission.step.transitioned',
/**
   * A step's action was in flight when the process stopped.
   *
   * The honest record of an unknown effect. Its presence is what stops a restart from
   * re-running something that may already have happened.
   */
  'mission.step.interrupted',
/**
   * Evidence was recorded.
   *
   * `origin` is the load-bearing field: `observed` counts toward an outcome and
   * `reported` does not. A capability saying it found twelve things is `reported`.
   */
  'mission.evidence.recorded',
/** A blocker was raised or cleared. */
  'mission.blocker.changed',
/**
   * A step asked Work for a gate and Work opened one. A pointer, not a decision.
   *
   * There is deliberately **no** `mission.approval.decided` and **no**
   * `mission.approval.expired` in this closed list. A person's decision is recorded once,
   * by `work.approval.decided`; an unanswered gate is recorded once, by
   * `work.approval.expired`. A Mission event carrying either would be a second record of
   * the same fact that Core cannot enforce the truth of — and two records of one decision
   * is one more than a journal needs in order to disagree with itself.
   */
  'mission.approval.requested',
/** A durable, bounded next wake. `dueAt` is required on every one. */
  'mission.wake.scheduled',
/** That wake fired. A fact, and never an authorisation. */
  'mission.wake.fired',
/** What Freya decided to do next, and why. */
  'mission.continuation.decided',
/** A budget dimension was consumed. Counts only, never a total a caller supplies. */
  'mission.budget.spent',
/** A budget ceiling was reached. Recorded so a restart cannot hide one. */
  'mission.budget.exceeded',
/**
   * An owner correction was applied to this Mission.
   *
   * `changedFields` is a list of *field names*. The most this event can say is "the
   * context changed" — the new context itself is private and lives in the encrypted
   * intent store, exactly as the original did.
   */
  'mission.intent.corrected',
/**
   * An owner correction could not be resolved to one reading.
   *
   * Nothing changed. No constraint moved, no step was settled, no evidence discarded.
   * The Mission asked the owner instead of guessing, and that refusal is the record.
   */
  'mission.correction.ambiguous',
// Mission (Phase 7) — metadata only, and the strictest family in the journal.
  //
  // A Mission holds the most private text Freya will ever store: what a person is
  // trying to achieve. So there is **no slot** for a title, an intent, a success
  // criterion or a note, and the validators reject an unexpected field rather than
  // ignoring it. A payload with the right fields plus an `intent` would pass every
  // field check and quietly keep the intent.
  //
  // Every payload is an id, a status, a count, an instant, a closed reason code, a
  // verifier id, or a list of ids.
  'mission.created',
'mission.content.updated',
'mission.deleted',
'mission.activated',
'mission.paused',
'mission.resumed',
'mission.cancelled',
'mission.failed',
'mission.completed',
'mission.run.attached',
'mission.verification.requested',
'mission.verification.completed',
'mission.limit.exceeded',
] as const
