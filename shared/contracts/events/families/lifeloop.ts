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
export interface LifeloopEventPayloads {
/* ------------------------------------------------- continuous life loop */

  /**
   * The wake was honoured, and this is the whole of it.
   *
   * Flat rather than nested, because this is the one entry the fold has to rebuild
   * the loop's position from, and a nested object would be a second shape to keep in
   * step. Every field is an id, a closed code or an instant — `goalRef` and
   * `sourceRef` are references and are never a title, an intent or a piece of
   * content, which is why a Mission can be woken about without its text being able
   * to reach the journal on the way.
   */
  'lifeloop.wake.received': {
    wakeId: string
    source: string
    kind: string
    /** The durable dedupe key. Derived from source, kind and reference, never the id. */
    wakeKey: string
    iteration: number
    goalRef: string | null
    sourceRef: string | null
    occurredAt: string
    observedAt: string
  }

/**
   * The registry refused a wake.
   *
   * Bookkeeping rather than a state change: a wake that never entered the
   * continuation leaves the loop exactly where it was, and the refusal is the only
   * trace it makes. `code` is a closed reason and never the rejected value, so a
   * caller's own text cannot reach the journal through a refusal.
   */
  'lifeloop.wake.denied': {
    wakeId: string
    source: string
    code: string
    iteration: number
  }

/** Every deterministic gate allowed a thought. Journaled *before* any request. */
  'lifeloop.filter.passed': {
    wakeId: string
    wakeKey: string
    code: string
    iteration: number
  }

/**
   * A gate refused, or held the wake back.
   *
   * One event, two outcomes, so a reader can never be left wondering whether a wait
   * was a refusal. `deadlineExpiresAt` is absolute and written rather than derived,
   * because two of the short holds this carries are minutes long and re-deriving
   * them from a thirty-day default would turn a two-second backoff into a month of
   * not trying, across a single restart.
   */
  'lifeloop.filter.denied': {
    wakeId: string
    wakeKey: string
    outcome: string
    code: string
    deadlineType: string | null
    deadlineExpiresAt: string | null
    iteration: number
  }

/**
   * A thought was about to be requested.
   *
   * Written before the request, and it carries no prompt, no token count and no
   * provider. What it does carry is `cognitionRequest`, the id the Governor and the
   * Gateway will use — so an auditor can join this entry to `cognition.requested`
   * and see that the request that spent money was the one the filter allowed, and
   * nothing else was.
   */
  'lifeloop.cognition.requested': {
    wakeId: string
    wakeKey: string
    iteration: number
    cognitionRequest: string
  }

/** The Governor refused the thought, or the provider failed. Nothing was spent. */
  'lifeloop.cognition.denied': {
    wakeId: string
    wakeKey: string
    code: string
    iteration: number
  }

/** One bounded action began. Exactly one per iteration; the ceilings are the rest. */
  'lifeloop.action.started': {
    wakeId: string
    iteration: number
    actionIndex: number
    deadlineType: string | null
    deadlineExpiresAt: string | null
  }

'lifeloop.action.completed': {
    wakeId: string
    iteration: number
    actionIndex: number
  }

/** The bounded action failed. The attempt count advances, because that is the point. */
  'lifeloop.action.failed': {
    wakeId: string
    iteration: number
    actionIndex: number
    code: string
  }

'lifeloop.verification.started': {
    wakeId: string
    iteration: number
    verificationIndex: number
    deadlineType: string | null
    deadlineExpiresAt: string | null
  }

'lifeloop.verification.passed': {
    wakeId: string
    iteration: number
    verificationIndex: number
  }

'lifeloop.verification.failed': {
    wakeId: string
    iteration: number
    verificationIndex: number
    code: string
  }

/**
   * What the loop concluded, and how loudly it was allowed to be.
   *
   * `outcome` and `escalation` are both here because the gap between them is the
   * whole of Phase 23's restraint: focus suppresses an `interrupt` and nothing else,
   * and STOP ALL suppresses everything. Recording only the quieter of the two would
   * make "she decided not to interrupt" and "she was told not to" the same line in
   * the journal, and they are very different things to have happened to a person.
   */
  'lifeloop.continuation.decided': {
    wakeId: string
    iteration: number
    decision: string
    outcome: string | null
    escalation: string | null
    attentionSuppressed: boolean
    actionCount: number
    verificationCount: number
  }

/**
   * The loop's position was reconciled to what the journal actually proves.
   *
   * Not a continuation step and not in the ordinary transition table on purpose: a
   * restart, the owner pre-empting, and the owner clearing a stop are all moves no
   * continuation signal points at, because none of them is a step. `code` is from the
   * loop's closed reconciliation vocabulary, and the deadline pair is present only
   * when a wait was preserved rather than abandoned.
   */
  'lifeloop.reconciled': {
    code: string
    from: string
    deadlineType: string | null
    deadlineExpiresAt: string | null
    wakeId: string
    iteration: number
  }

/**
   * STOP ALL was lifted.
   *
   * One key, and the narrowest event in the journal. It is written from exactly one
   * place in the system — the owner's `security.resume`, behind Guard — and the fold
   * insists there was a stop to lift, so a stray entry moves nothing.
   */
  'lifeloop.unstopped': {
    code: string
  }

/**
   * The loop was closed out and returned to being idle.
   *
   * `code` says why the wake is over, which is the difference between "nothing is in
   * flight" and "something was in flight and was given up on" — a distinction a
   * system eventually needs, because one reports a clean idle over lost work.
   */
  'lifeloop.reset': {
    wakeId: string
    iteration: number
    code: string
  }

/**
   * The loop stopped.
   *
   * Reaches every state including a terminal one, because it does not consult the
   * ordinary table: it is the one event that may override terminality and it can only
   * ever move *to* STOP. `code` is what makes a completion clearable and an owner's
   * stop not, so a close-out can never be the thing that unfreightens a panic button.
   */
  'lifeloop.stopped': {
    wakeId: string
    iteration: number
    code: string | null
  }
}