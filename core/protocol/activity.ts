import type { CoreEventType } from '../events/envelope'

/**
 * Activity: the shell's read-only view of durable Core events.
 *
 * Core publishes these instead of exposing its event fabric to the renderer.
 * That boundary is the point. A renderer that could read `EventFabric` could
 * read the whole journal, including event ids, principal ids and correlation
 * ids — and, the moment a future event carried text, the prompts and responses
 * that went with it. This type is the entire contract, and it carries no field
 * that could hold a payload.
 *
 * The consequences are deliberate and are enforced by the mapping in
 * `describeActivity`:
 *
 * - **No command text, ever.** `command.received` becomes "A command was
 *   received" with a length. The journal has never held the text and neither
 *   does this.
 * - **No raw payloads.** Each entry is a fixed shape the Core chooses. Adding a
 *   field to an event does not automatically add it here.
 * - **Replay and live agree.** The same function maps an event whether it came
 *   off disk or off the fabric, so a renderer that attaches late sees the same
 *   list it would have seen had it been running the whole time.
 */

/**
 * The kinds of activity the shell can show.
 *
 * A closed set on purpose. An unrecognised event maps to `other` with its type
 * name preserved, so adding an event to Core degrades the activity list rather
 * than breaking it.
 */
export type ActivityKind =
  | 'core.started'
  | 'core.ready'
  | 'core.degraded'
  | 'integrity.fault'
  | 'command.received'
  | 'stop_all.activated'
  | 'stop_all.cleared'
  | 'cognition.allowed'
  | 'cognition.denied'
  | 'provider.started'
  | 'provider.completed'
  | 'provider.failed'
  | 'provider.cancelled'
  | 'conversation.created'
  | 'conversation.turn.completed'
  | 'conversation.turn.failed'
  | 'voice.capture'
  | 'grant.created'
  | 'grant.revoked'
  | 'work.run.started'
  | 'work.run.completed'
  | 'work.run.failed'
  | 'work.run.cancelled'
  | 'work.run.recovered'
  | 'work.step.verified'
  | 'work.approval.requested'
  // Continuous Life Loop (Phase 23). Four of the loop's seventeen events earn a row
  // and thirteen deliberately do not: a wake, a deterministic refusal, a stop and a
  // lift are things a person might want to see, whereas an action index or a
  // continuation decision is bookkeeping at a granularity that would bury the feed.
  // The loop's own projection carries the rest, and `describeActivity` returning
  // `null` is how "not worth an activity row" is spelled.
  | 'lifeloop.woke'
  | 'lifeloop.refused'
  | 'lifeloop.stopped'
  | 'lifeloop.unstopped'
  | 'work.approval.decided'
  // Missions. Every one of the eleven is named, because the distinction between
  // "established" and "hit a ceiling" is the reason the subsystem exists and a feed
  // that renders both as an unworded row has thrown it away.
  | 'mission.created'
  | 'mission.activated'
  | 'mission.paused'
  | 'mission.resumed'
  | 'mission.cancelled'
  | 'mission.failed'
  | 'mission.completed'
  | 'mission.run.attached'
  | 'mission.verification.requested'
  | 'mission.verification.completed'
  | 'mission.limit.exceeded'
  // Mission autonomy (Phase 47). Half of the sixteen new events earn a row, for the
  // same reason the eleven above do: each is a fact a person would want to read as news —
  // a Mission is stuck, a step is waiting on a person, a correction was applied or could
  // not be, a restart left something unknown — and each would otherwise render as its bare
  // event type, which is exactly the flattening these rows exist to prevent.
  //
  // The other nine deliberately earn none: a lifecycle edge, a step changing status,
  // evidence accruing, a wake being armed or firing, a budget being charged, a
  // continuation being chosen and a plan being committed are bookkeeping at a granularity
  // that would bury the feed. The Mission board carries all of them, in place, on the
  // Mission they belong to.
  //
  // Note what is **not** here: no "a Mission approval was granted/denied/expired" row.
  // Those decisions belong to Work and are already on this feed, from
  // `work.approval.approved` and friends. A Mission row for them would be the same fact
  // twice — and the second copy is the one nothing enforces.
  | 'mission.blocked'
  | 'mission.approval.requested'
  | 'mission.intent.corrected'
  | 'mission.intent.ambiguous'
  | 'mission.step.interrupted'
  | 'mission.budget.exceeded'
  // Workforce. Only the facts a person would want to read as news are named: a claim
  // that was refused and an agent that had to be reconciled are events; the sixteen that
  // describe a team gaining a member are not.
  | 'workforce.worker.retired'
  | 'workforce.worker.stopped'
  | 'workforce.worker.reconciled'
  | 'workforce.claim.recorded'
  | 'workforce.limit.exceeded'
  // Attention. Only the facts a person would want as news: an event was received,
  // what Core decided about it, a budget that ran out and a schedule that fired.
  // No event text exists on any of these rows because none is in the journal.
  | 'attention.ingested'
  | 'attention.decision'
  | 'attention.budget'
  | 'attention.schedule'
  // Skills. Only the facts a person would want as news: a procedure was recorded, one
  // was verified or promoted, one was retired or blocked, and one attempt to admit or
  // improve something was refused. No summary text, no contract description and no
  // model commentary exists on any of these rows, because none of those is in the
  // journal ??? a row's commentary length is the only trace of an opinion, and it is a
  // number.
  | 'skill.admitted'
  | 'skill.revised'
  | 'skill.evaluated'
  | 'skill.promoted'
  | 'skill.retired'
  | 'skill.rejected'
  | 'skill.improvement'

  // Relay. Only the facts a person would want as news: an action was requested
  // and is waiting on a decision, an action settled, an approval was decided
  // and a ceiling was reached. No content exists on any of these rows because
  // none is in the journal.
  | 'relay.requested'
  | 'relay.approval'
  | 'relay.executed'
  | 'relay.failed'
  | 'relay.limits'
  | 'other'

export interface CoreActivityEvent {
  /** Stable per event: `kind:sequence`. Two runs of the same log agree. */
  id: string
  kind: ActivityKind
  /** The event type as Core named it, for the detail view. */
  type: CoreEventType
  /** Durable sequence, so any row can be traced back to the journal. */
  sequence: number
  /** Epoch ms, taken from the event envelope, never from a UI clock. */
  at: number
  /** One sentence. Never contains command text, prompt text or a response. */
  text: string
  tone: 'neutral' | 'good' | 'busy' | 'warn' | 'bad'
  /** Present only for conversation turns, to associate status with its transcript. */
  conversationId?: string
  turnId?: string
}

/** How many entries a renderer may be handed at once. */
export const ACTIVITY_LIMIT = 60

/**
 * Map one durable event to at most one activity entry.
 *
 * Returns `null` for events that are not worth a line in the activity feed —
 * which is most of them. The journal records a great deal that no person wants
 * to read as news, and an activity feed that lists everything is a log file
 * with extra steps.
 */
export function describeActivity(event: {
  type: CoreEventType
  sequence: number
  at: number
  payload: Record<string, unknown>
}): CoreActivityEvent | null {
  const base = {
    id: `${event.type}:${event.sequence}`,
    type: event.type,
    sequence: event.sequence,
    at: event.at,
    ...(event.type.startsWith('conversation.turn.') ? {
      ...(typeof event.payload.conversationId === 'string' ? { conversationId: event.payload.conversationId } : {}),
      ...(typeof event.payload.turnId === 'string' ? { turnId: event.payload.turnId } : {}),
    } : {}),
  }

  switch (event.type) {
    case 'core.started':
      return {
        ...base,
        kind: 'core.started',
        text: 'Core started.',
        tone: 'neutral',
      }

    case 'core.ready':
      return { ...base, kind: 'core.ready', text: 'Core ready.', tone: 'good' }

    case 'core.degraded':
      return {
        ...base,
        kind: 'core.degraded',
        text: `Core started degraded: ${text(event.payload.reason)}`,
        tone: 'bad',
      }

    case 'core.integrity_fault':
      return {
        ...base,
        kind: 'integrity.fault',
        text: `Event journal found corrupt at line ${number(event.payload.line, 0)}. Cognition stays refused until it is dealt with.`,
        tone: 'bad',
      }

    case 'command.received': {
      // The length is not a disclosure: it is how a person can tell an empty
      // submission from a pasted paragraph without the shell ever reading the
      // words themselves.
      const length = number(event.payload.contentLength, 0)
      return {
        ...base,
        kind: 'command.received',
        text:
          length > 0
            ? `Command received (${length} characters). Recorded, not yet acted on.`
            : 'Command received (empty).',
        tone: 'neutral',
      }
    }

    case 'security.stop_all.activated':
      return {
        ...base,
        kind: 'stop_all.activated',
        text: `STOP ALL activated: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'security.stop_all.cleared':
      return {
        ...base,
        kind: 'stop_all.cleared',
        text: 'STOP ALL cleared. Model requests can be authorised again.',
        tone: 'good',
      }

    case 'cognition.allowed': {
      const grant = event.payload.grantId
      return {
        ...base,
        kind: 'cognition.allowed',
        // An explicit user turn needs no grant, and saying "authorised by no
        // grant" would read as a problem where there is none.
        text:
          typeof grant === 'string' && grant.length > 0
            ? `Cognition authorised by grant ${grant}.`
            : 'Cognition authorised by an explicit user turn.',
        tone: 'neutral',
      }
    }

    case 'cognition.denied':
      return {
        ...base,
        kind: 'cognition.denied',
        text: `Cognition refused: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'cognition.authorization_required':
      return {
        ...base,
        kind: 'cognition.denied',
        text: `Cognition needs authorisation: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'model.request.started':
      return {
        ...base,
        kind: 'provider.started',
        text: `Model request started${modelSuffix(event.payload)}`,
        tone: 'busy',
      }

    case 'model.request.completed':
      return {
        ...base,
        kind: 'provider.completed',
        text: `Model request completed${modelSuffix(event.payload)}.`,
        tone: 'good',
      }

    case 'model.request.failed':
      return {
        ...base,
        kind: 'provider.failed',
        text: `Model request failed: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'model.request.cancelled':
      // The two cases read differently on purpose. One was stopped before it
      // cost anything; the other may already have been paid for, and saying
      // "cancelled" about that without qualification would be the most
      // reassuring lie in this feed.
      return {
        ...base,
        kind: 'provider.cancelled',
        text: event.payload.providerContacted
          ? `Model request cancelled after reaching the provider: ${text(event.payload.reason)}. Its usage is unknown, so the totals are a lower bound.`
          : `Model request cancelled before the provider was contacted: ${text(event.payload.reason)}. Nothing was spent.`,
        tone: 'warn',
      }

    /* --------------------------------------------------------- conversation */
    //
    // Metadata only, and the wording is chosen so a row can never be mistaken for
    // a transcript. A turn's *size* is reported; its words are not here and cannot
    // be added by accident, because the row is built from named fields.

    case 'conversation.created':
      return {
        ...base,
        kind: 'conversation.created',
        text: 'Conversation created.',
        tone: 'neutral',
      }

    case 'conversation.turn.started':
      return {
        ...base,
        kind: 'provider.started',
        text: `Turn started${modelSuffix(event.payload)}.`,
        tone: 'busy',
      }

    case 'conversation.turn.completed':
      return {
        ...base,
        kind: 'conversation.turn.completed',
        text: `Turn completed${modelSuffix(event.payload)}.`,
        tone: 'good',
      }

    case 'conversation.turn.cancelled':
      return {
        ...base,
        kind: 'conversation.turn.failed',
        text: `Turn cancelled: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'conversation.turn.failed':
      return {
        ...base,
        kind: 'conversation.turn.failed',
        text: `Turn failed: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'conversation.turn.denied':
      return {
        ...base,
        kind: 'conversation.turn.failed',
        text: `Turn not started: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'conversation.turn.interrupted':
      return {
        ...base,
        kind: 'conversation.turn.failed',
        text: 'A turn was interrupted before it finished. It was not retried.',
        tone: 'warn',
      }

    /* --------------------------------------------------------------- voice */
    //
    // A capture is a thing that happened. The audio is not here, the transcript is
    // not here, and the duration is the only measurement worth showing.

    case 'voice.capture.started':
      return {
        ...base,
        kind: 'voice.capture',
        text: 'Microphone opened. Local capture only.',
        tone: 'busy',
      }

    case 'voice.capture.completed':
      return {
        ...base,
        kind: 'voice.capture',
        text:
          event.payload.transcribed === true
            ? `Local recording transcribed (${number(event.payload.durationMs, 0)}ms). Not sent anywhere.`
            : `Local recording ended (${number(event.payload.durationMs, 0)}ms). No local speech engine was configured.`,
        tone: 'neutral',
      }

    case 'voice.capture.cancelled':
      return {
        ...base,
        kind: 'voice.capture',
        text: `Local recording discarded: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    /* ---------------------------------------------------------------- work */
    //
    // Metadata only, and worded so a row can never be mistaken for what happened.
    // No step label, no task title, no observation text and no capability data
    // appears here — none of it is in the journal either, so there is nothing to
    // leak. The feed says a run finished and how much of it verified, which is the
    // question somebody watching actually has.

    case 'work.run.created':
      return {
        ...base,
        kind: 'other',
        text: `Run planned: ${number(event.payload.steps && (event.payload.steps as unknown[]).length, 0)} steps.`,
        tone: 'neutral',
      }

    case 'work.run.started':
      return { ...base, kind: 'work.run.started', text: 'Run started.', tone: 'busy' }

    case 'work.run.resumed':
      return {
        ...base,
        kind: 'work.run.started',
        text: `Run resumed${event.payload.reason ? `: ${text(event.payload.reason)}` : '.'}`,
        tone: 'busy',
      }

    case 'work.run.paused':
      return {
        ...base,
        kind: 'other',
        text: `Run paused: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'work.run.waiting':
      return {
        ...base,
        kind: 'other',
        text: `Run waiting: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'work.run.awaiting_approval':
      return {
        ...base,
        kind: 'work.approval.requested',
        text: `Run stopped for approval: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'work.run.completed':
      return {
        ...base,
        kind: 'work.run.completed',
        text: `Run completed: ${number(event.payload.verifiedCount, 0)} of ${number(event.payload.stepCount, 0)} steps verified.`,
        tone: 'good',
      }

    case 'work.run.failed':
      return {
        ...base,
        kind: 'work.run.failed',
        text: `Run failed: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'work.run.cancelled':
      return {
        ...base,
        kind: 'work.run.cancelled',
        text: `Run cancelled: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    // Stated in the feed rather than hidden in the projection, because a run that
    // was still executing when the process died is exactly the thing a person
    // would otherwise assume came back to life on its own.
    case 'work.run.recovered':
      return {
        ...base,
        kind: 'work.run.recovered',
        text: `A run was interrupted by a restart and has been recorded as failed: ${text(event.payload.reason)}`,
        tone: 'warn',
      }

    case 'work.step.verified':
      return { ...base, kind: 'work.step.verified', text: 'A step was verified.', tone: 'good' }

    case 'work.step.failed':
      return {
        ...base,
        kind: 'other',
        text: `Step failed: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'work.step.cancelled':
      return {
        ...base,
        kind: 'other',
        text: `Step cancelled: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'work.step.skipped':
      return { ...base, kind: 'other', text: 'A step was skipped.', tone: 'neutral' }

    case 'work.action.started':
      return {
        ...base,
        kind: 'other',
        text: `Capability "${text(event.payload.capability)}" attempted (${number(event.payload.attempt, 1)}).`,
        tone: 'busy',
      }

    case 'work.action.completed':
      return { ...base, kind: 'other', text: 'A capability returned.', tone: 'neutral' }

    case 'work.action.failed':
      return {
        ...base,
        kind: 'other',
        text: `A capability failed: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'work.action.cancelled':
      return {
        ...base,
        kind: 'other',
        text: `A capability was cancelled: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    // Measured, never quoted. The lengths are the whole disclosure: they let an
    // operator see that something substantial came back without this feed becoming a
    // transcript of what every capability produced.
    case 'work.observation.recorded':
      return {
        ...base,
        kind: 'other',
        text: `Observation recorded (${text(event.payload.kind, 'result')}, ${number(event.payload.summaryLength, 0)} characters).`,
        tone: 'neutral',
      }

    case 'work.verification.requested':
      return {
        ...base,
        kind: 'other',
        text: `Verification requested from "${text(event.payload.verifier)}".`,
        tone: 'neutral',
      }

    case 'work.verification.completed':
      // Passed and failed read differently on purpose. A verification that passed
      // and one that failed are the same event shape, and flattening them would
      // erase the only distinction this architecture exists to preserve.
      return event.payload.verdict === 'passed'
        ? { ...base, kind: 'other', text: 'Verification passed.', tone: 'good' }
        : {
            ...base,
            kind: 'other',
            text: `Verification failed: ${text(event.payload.reason, 'no reason given')}`,
            tone: 'bad',
          }

    case 'work.approval.requested':
      return {
        ...base,
        kind: 'work.approval.requested',
        text: `Approval requested before "${text(event.payload.capability)}" runs: ${text(event.payload.proposal)}. Nothing has run yet.`,
        tone: 'warn',
      }

    case 'work.approval.approved':
      return { ...base, kind: 'work.approval.decided', text: 'An approval was granted.', tone: 'good' }

    case 'work.approval.denied':
      return {
        ...base,
        kind: 'work.approval.decided',
        text: `An approval was denied: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'bad',
      }

    case 'work.approval.cancelled':
      return {
        ...base,
        kind: 'work.approval.decided',
        text: `An approval request was withdrawn: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'work.approval.expired':
      return {
        ...base,
        kind: 'work.approval.decided',
        text: `An approval request expired: ${text(event.payload.reason, 'no reason given')}`,
        tone: 'warn',
      }

    case 'work.limits.exceeded':
      return {
        ...base,
        kind: 'other',
        text: `A run reached its ${text(event.payload.limit, 'limit')} ceiling and stopped.`,
        tone: 'warn',
      }

    case 'cognition.grant.created':
      return {
        ...base,
        kind: 'grant.created',
        text: `Grant ${text(event.payload.grantId)} created.`,
        tone: 'neutral',
      }

    case 'cognition.grant.revoked':
      return {
        ...base,
        kind: 'grant.revoked',
        text: `Grant ${text(event.payload.grantId)} revoked.`,
        tone: 'neutral',
      }

    // Missions.
    //
    // These get sentences rather than falling through, because flattening them was
    // hiding the exact distinction this subsystem exists to draw: `mission.completed`
    // is a verifier saying the outcome was established, and `mission.limit.exceeded` is
    // a ceiling stopping it. As unworded rows they rendered identically, which is the
    // same flattening Work's doc refuses when a verification passes or fails.
    //
    // Every field read here is a named one - an id, a status, a closed reason - and no
    // Mission text exists on any of these events to leak. The sentences say what
    // happened to an *outcome*, never what the outcome was.
    case 'mission.created':
      return { ...base, kind: 'mission.created', text: 'Mission created.', tone: 'neutral' }

    case 'mission.activated':
      return { ...base, kind: 'mission.activated', text: 'Mission activated.', tone: 'neutral' }

    case 'mission.paused':
      return { ...base, kind: 'mission.paused', text: 'Mission paused.', tone: 'neutral' }

    case 'mission.resumed':
      return { ...base, kind: 'mission.resumed', text: 'Mission resumed.', tone: 'neutral' }

    case 'mission.cancelled':
      return {
        ...base,
        kind: 'mission.cancelled',
        text: `Mission cancelled (${text(event.payload.reason, 'no reason given')}).`,
        tone: 'neutral',
      }

    case 'mission.failed':
      return {
        ...base,
        kind: 'mission.failed',
        text: `Mission concluded as not achieved (${text(event.payload.reason, 'no reason given')}).`,
        tone: 'bad',
      }

    case 'mission.completed':
      return {
        ...base,
        kind: 'mission.completed',
        text: `Mission completed, established by verifier ${text(event.payload.verifierId, 'unknown')}.`,
        // Distinctly good. This is the one event in the system that means something a
        // person asked for was achieved, and it should not read like a ceiling failure.
        tone: 'good',
      }

    case 'mission.run.attached':
      return { ...base, kind: 'mission.run.attached', text: 'Run attached to a Mission.', tone: 'neutral' }

    case 'mission.verification.requested':
      return {
        ...base,
        kind: 'mission.verification.requested',
        text: `Mission completion asked of verifier ${text(event.payload.verifierId, 'unknown')}.`,
        tone: 'neutral',
      }

    case 'mission.verification.completed':
      return {
        ...base,
        kind: 'mission.verification.completed',
        // The outcome is named rather than blurred, because "asked" and "answered" and
        // "ran out of time" are three different facts about whether anything was proved.
        text: `Mission verification ${text(event.payload.outcome, 'unanswered')}.`,
        tone: event.payload.outcome === 'passed' ? 'good' : 'neutral',
      }

    case 'mission.limit.exceeded':
      return {
        ...base,
        kind: 'mission.limit.exceeded',
        text: `Mission ceiling reached: ${text(event.payload.limit, 'unknown')}.`,
        tone: 'warn',
      }

    /* ------------------------------------------ mission autonomy (Phase 47) */

    // Eight of the sixteen new events earn a row and eight deliberately do not, and the
    // split is drawn by the question the eleven rows above were written for: would a
    // person want to read this as news?
    //
    // Yes, and named: a Mission is stuck and a person is being asked, a person answered,
    // an owner corrected what was being looked for (or said something too vague to
    // correct), a restart left an external effect unknown, a ceiling was hit.
    //
    // No, and silent: `mission.transitioned`, `mission.plan.committed`,
    // `mission.step.transitioned`, `mission.evidence.recorded`,
    // `mission.wake.scheduled`, `mission.wake.fired`, `mission.continuation.decided`
    // and `mission.budget.spent`. These are the loop keeping its own books: a plan being
    // committed, a step moving to running, evidence arriving, a wake being armed, a
    // continuation being chosen. All of it is on the Mission board, on the Mission it
    // belongs to, and a feed that repeated it would be a second copy of the board
    // competing with the first — which is why returning `null` is spelled here rather
    // than left to the `default` arm, whose bare `event.type` is the one thing the
    // Mission rows must never become.
    //
    // Every field read below is an id, a count, a closed status or a closed code. There
    // is no Mission text on any of these payloads to leak, and none is added here: what
    // the Mission is looking for stays in the encrypted intent store.

    case 'mission.blocker.changed':
      // Raised and cleared read differently, because they mean different things. A
      // Mission that is blocked is asking for something; a Mission that just stopped
      // being blocked has been let go, and saying "blocker raised" for both would make a
      // recovery read as a fresh failure.
      return event.payload.raised === true
        ? {
            ...base,
            kind: 'mission.blocked',
            text: `Mission blocked: ${text(event.payload.code, 'unknown')}. It will not proceed until that clears.`,
            tone: 'warn',
          }
        : {
            ...base,
            kind: 'mission.blocked',
            text: `Mission blocker cleared: ${text(event.payload.code, 'unknown')}.`,
            tone: 'good',
          }

    case 'mission.approval.requested':
      // One row, and it says the thing that is true: a step is waiting on a person, and
      // nothing has run.
      //
      // It does **not** name a capability or a risk. It could not: this event is a pointer
      // to a Work gate and deliberately carries no facts about it, so there is nothing to
      // print. Work's own `work.approval.requested` row is the one that says what would
      // happen — which is correct, because that is the surface the person answers on, and a
      // second copy here would be a second question.
      //
      // `source` is kept because it changes what the row means. `observed` means Guard
      // demanded a gate the plan did not anticipate, which is a fact about the capability
      // rather than about the goal — and a person watching a Mission should be able to
      // tell those apart.
      return {
        ...base,
        kind: 'mission.approval.requested',
        text:
          event.payload.source === 'observed'
            ? 'A Mission step is waiting on an approval Work asked for. Nothing has run yet.'
            : 'A Mission step is waiting on an approval it asked for. Nothing has run yet.',
        tone: 'warn',
      }

    case 'mission.intent.corrected':
      // The correction the phase is built around, and the row says as much as it can:
      // which *field names* changed, how much was settled, how much evidence survived. It
      // cannot say the new value, because the new value is private.
      return {
        ...base,
        kind: 'mission.intent.corrected',
        text: `A Mission was corrected (${(Array.isArray(event.payload.changedFields) ? event.payload.changedFields.length : 0)} field(s) changed, ${number(event.payload.settledSteps, 0)} step(s) settled, ${number(event.payload.preservedEvidence, 0)} evidence item(s) kept).`,
        tone: 'neutral',
      }

    case 'mission.correction.ambiguous':
      // `ambiguity` is Core's own closed code, which is the only honest thing this row
      // can carry: what the owner said is private, so the feed can report that it was
      // not clear enough to apply and nothing changed as a result.
      return {
        ...base,
        kind: 'mission.intent.ambiguous',
        text: `A Mission correction was too unclear to apply (${text(event.payload.ambiguity, 'unknown')}). Nothing was changed.`,
        tone: 'warn',
      }

    case 'mission.step.interrupted':
      // Stated rather than hidden, for the same reason `work.run.recovered` is: a step
      // that was mid-effect when the process died is the one thing someone would
      // otherwise assume finished on its own. `consequential` is what separates "it did
      // not happen" from "nobody knows".
      return event.payload.consequential === true
        ? {
            ...base,
            kind: 'mission.step.interrupted',
            text: 'A Mission step was interrupted by a restart and may have had an effect that is unknown. It was not retried.',
            tone: 'warn',
          }
        : {
            ...base,
            kind: 'mission.step.interrupted',
            text: 'A Mission step was interrupted by a restart. It had no external effect and was not retried.',
            tone: 'neutral',
          }

    case 'mission.budget.exceeded':
      // A *Mission* budget rather than a Work ceiling, and the wording keeps the two
      // apart: this Mission is out of room, whatever else is still running.
      return {
        ...base,
        kind: 'mission.budget.exceeded',
        text: `Mission budget reached: ${text(event.payload.budget, 'unknown')}. It will not spend further.`,
        tone: 'warn',
      }

    // The eight that earn no row, spelled out here rather than left to the `default`
    // arm. That arm is the failure mode this file is built against: it prints
    // `event.type`, so an unhandled Mission event reaches the feed as the bare string
    // "mission.transitioned" — a row with no sentence, which is precisely the
    // flattening the eleven rows above were written to stop. `return null` is how
    // "not worth an activity row" is stated; an absent case means "nobody has decided
    // yet", which is a different and worse thing.
    case 'mission.transitioned':
    case 'mission.plan.committed':
    case 'mission.step.transitioned':
    case 'mission.evidence.recorded':
    case 'mission.wake.scheduled':
    case 'mission.wake.fired':
    case 'mission.continuation.decided':
    case 'mission.budget.spent':
      return null

    /* ------------------------------------------------------------- workforce */

    // Four rows, and every field read here is an id, a status or a closed code.
    //
    // No message body is available to leak, because none is journalled; no context
    // content either. What these rows *do* say is that an agent asked for something and
    // was refused, which is the one workforce fact worth putting in front of a person —
    // a subordinate claiming authority it does not have is the attack this subsystem is
    // built against, and it should be visible rather than silent.

    // Two rows out of one event type, because two of the transitions are things a person
    // would want to read as news and the rest are routine lifecycle noise that would drown
    // the feed. `stopped` is the panic button's consequence on an agent; `retired` is the
    // only transition that removes one for good.
    case 'workforce.worker.transitioned':
      if (event.payload.to === 'stopped') {
        return {
          ...base,
          kind: 'workforce.worker.stopped',
          text: `Worker stopped (${event.payload.workerId}).`,
          tone: 'warn',
        }
      }
      if (event.payload.to !== 'retired') {
        return { ...base, kind: 'other', text: event.type, tone: 'neutral' }
      }
      return {
        ...base,
        kind: 'workforce.worker.retired',
        text: `Worker retired (${event.payload.workerId}).`,
        tone: 'neutral',
      }

    case 'workforce.worker.reconciled':
      return {
        ...base,
        kind: 'workforce.worker.reconciled',
        // Says what happened rather than what it looks like: the agent was executing when
        // the process died, so nothing it was doing could be continued.
        text: `Worker reconciled after restart (${event.payload.workerId}); it cannot continue.`,
        tone: 'warn',
      }

    case 'workforce.claim.recorded':
      return {
        ...base,
        kind: 'workforce.claim.recorded',
        // "refused" is the only word this row can carry, and that is the point: there is
        // no spelling of a claim that was granted.
        text: `Worker claim refused: ${text(event.payload.subject, 'unknown')}.`,
        tone: 'warn',
      }

    case 'workforce.limit.exceeded':
      return {
        ...base,
        kind: 'workforce.limit.exceeded',
        text: `Workforce ceiling reached: ${text(event.payload.limit, 'unknown')}.`,
        tone: 'warn',
      }

    /* ----------------------------------------------- continuous life loop */

    // Metadata only, and worded so a row cannot say more than the journal does. The
    // closed kind and the closed code are the whole content: no event text, no
    // prompt, no reference spelled out as anything a person could read as content.
    case 'lifeloop.wake.received':
      return {
        ...base,
        kind: 'lifeloop.woke',
        text: `Freya woke up (${event.payload.kind}); she will decide whether it is worth thinking about.`,
        tone: 'neutral',
      }

    case 'lifeloop.filter.denied':
      // The one row here that is genuinely news: a deterministic gate said no, and
      // naming the closed code is what lets a person tell "nothing authorized this"
      // apart from "she thought and chose silence".
      return {
        ...base,
        kind: 'lifeloop.refused',
        text: `Freya decided not to think: ${event.payload.code}.`,
        tone: 'neutral',
      }

    case 'lifeloop.wake.denied':
      return {
        ...base,
        kind: 'lifeloop.refused',
        text: `Freya did not wake for that: ${event.payload.code}.`,
        tone: 'neutral',
      }

    case 'lifeloop.stopped':
      return {
        ...base,
        kind: 'lifeloop.stopped',
        text: 'The life loop stopped.',
        tone: 'warn',
      }

    case 'lifeloop.unstopped':
      return {
        ...base,
        kind: 'lifeloop.unstopped',
        text: 'The owner cleared the stop and the life loop is running again.',
        tone: 'good',
      }

    /* ------------------------------------------------------------ attention */
    //
    // Metadata only, and worded so a row can never be mistaken for the event's
    // content. The kind, the source and the outcome are Core's own closed labels;
    // the length is the only measurement of the text that left the domain.

    case 'attention.event.ingested':
      return {
        ...base,
        kind: 'attention.ingested',
        text: `Attention event received from ${text(event.payload.source, 'unknown')} (${text(event.payload.kind, 'unknown')}, ${number(event.payload.textLength, 0)} characters).`,
        tone: 'neutral',
      }

    case 'attention.decision.made': {
      const outcome = text(event.payload.outcome, 'unknown')
      const reason = text(event.payload.reason, 'unknown')
      return {
        ...base,
        kind: 'attention.decision',
        text:
          outcome === 'do-nothing'
            ? `Attention: do nothing (${reason}).`
            : `Attention: ${outcome} (${text(event.payload.importance, 'unknown')} importance, ${text(event.payload.urgency, 'unknown')} urgency, ${reason}).`,
        tone: outcome === 'interrupt' ? 'warn' : outcome === 'do-nothing' ? 'neutral' : 'busy',
      }
    }

    case 'attention.budget.exceeded':
      return {
        ...base,
        kind: 'attention.budget',
        text: `Attention budget reached (${text(event.payload.limit, 'unknown')}); the outcome was demoted.`,
        tone: 'warn',
      }

    case 'attention.schedule.registered':
      return {
        ...base,
        kind: 'attention.schedule',
        text: `Attention schedule registered for ${text(event.payload.dueAt, 'an unknown time')}.`,
        tone: 'neutral',
      }

    case 'attention.schedule.fired':
      return {
        ...base,
        kind: 'attention.schedule',
        text: 'An attention schedule came due.',
        tone: 'neutral',
      }

    case 'attention.schedule.cancelled':
      return {
        ...base,
        kind: 'attention.schedule',
        text: `An attention schedule was cancelled (${text(event.payload.reason, 'no reason given')}).`,
        tone: 'neutral',
      }

    /* ---------------------------------------------------------------- relay */
    //
    // Metadata only, and worded so a row can never be mistaken for the action's
    // content. The connector, the action and the outcome are Core's own closed
    // labels; the summary is the bounded target sentence. No message body, no
    // event title and no issue text is available to leak, because none is in
    // the journal.

    case 'relay.action.requested':
      return {
        ...base,
        kind: 'relay.requested',
        text: `Relay action requested: ${text(event.payload.summary, 'unknown action')}. Awaiting approval.`,
        tone: 'warn',
      }

    case 'relay.approval.requested':
      // Deliberately not a row of its own: the request row above already says
      // "awaiting approval", and two rows for one fact would read as two
      // requests.
      return null

    case 'relay.approval.decided':
      return event.payload.decision === 'approved'
        ? { ...base, kind: 'relay.approval', text: 'A Relay approval was granted.', tone: 'good' }
        : { ...base, kind: 'relay.approval', text: 'A Relay approval was denied.', tone: 'neutral' }

    case 'relay.approval.expired':
      return {
        ...base,
        kind: 'relay.approval',
        text: 'A Relay approval expired before it was decided.',
        tone: 'warn',
      }

    case 'relay.action.executed':
      return {
        ...base,
        kind: 'relay.executed',
        text: `Relay action completed (${text(event.payload.connector, 'unknown')}.${text(event.payload.action, 'unknown')}).`,
        tone: 'good',
      }

    case 'relay.action.failed':
      return {
        ...base,
        kind: 'relay.failed',
        text: `Relay action failed: ${text(event.payload.failureCode, 'unknown reason')}.`,
        tone: 'bad',
      }

    case 'relay.action.cancelled':
      return {
        ...base,
        kind: 'relay.failed',
        text: `Relay action cancelled: ${text(event.payload.failureCode, 'no reason given')}.`,
        tone: 'warn',
      }

    case 'relay.connector.faulted':
      return {
        ...base,
        kind: 'relay.failed',
        text: `A connector was marked faulted: ${text(event.payload.reason, 'no reason given')}.`,
        tone: 'bad',
      }

    case 'relay.limits.exceeded':
      return {
        ...base,
        kind: 'relay.limits',
        text: `A Relay ceiling was reached (${text(event.payload.limit, 'unknown')}).`,
        tone: 'warn',
      }

    /* --------------------------------------------------------------- skills */
    //
    // Metadata only, and worded so a row can never be mistaken for the procedure's
    // content. The name is Core's own slug, the counts are integers, and the
    // evaluation row reports a **verdict and a character count** rather than any
    // sentence a model wrote ??? because there is no sentence in the journal to report.

    case 'skill.admitted':
      return {
        ...base,
        kind: 'skill.admitted',
        text: `A ${text(event.payload.kind, 'procedure')} was recorded as ${text(event.payload.name, 'a skill')} v${number(event.payload.version, 0)} (${number(event.payload.stepCount, 0)} steps, ${text(event.payload.trustClass, 'unknown')} trust).`,
        tone: 'neutral',
      }

    case 'skill.revised':
      return {
        ...base,
        kind: 'skill.revised',
        // A revision deliberately says "re-entered verification", because that is the
        // promise the revision makes and a feed that only showed the version bump
        // would leave a reader believing the old evidence still backed it.
        text: `${text(event.payload.name, 'A skill')} was revised to v${number(event.payload.version, 0)} and re-entered verification.`,
        tone: 'busy',
      }

    case 'skill.evaluation.recorded':
      return {
        ...base,
        kind: 'skill.evaluated',
        text: `Skill v${number(event.payload.version, 0)} evaluated: ${text(event.payload.verdict, 'unknown')} (${text(event.payload.reason, 'no reason')}), from ${number(event.payload.deterministicCount, 0)} deterministic evidence item(s) and ${number(event.payload.commentaryChars, 0)} characters of model commentary.`,
        tone: event.payload.verdict === 'established' ? 'good' : event.payload.verdict === 'contradicted' ? 'warn' : 'neutral',
      }

    case 'skill.transitioned': {
      const to = text(event.payload.to, 'unknown')
      // `payload` is `Record<string, unknown>` here by design, so the nested evidence
      // object is read through a guard rather than trusted ??? and a missing or malformed
      // one renders as zero established evaluations, which is the conservative reading.
      const evidence = record(event.payload.evidence)
      return {
        ...base,
        kind: to === 'promoted' ? 'skill.promoted' : 'skill.admitted',
        text: to === 'promoted'
          ? `A skill was promoted (${number(evidence.established, 0)} established evaluation(s) across ${number(evidence.distinctSubjects, 0)} subject(s)).`
          : `A skill moved to ${to} (${text(event.payload.reason, 'no reason given')}).`,
        tone: to === 'promoted' ? 'good' : to === 'blocked' ? 'bad' : 'neutral',
      }
    }

    case 'skill.retired':
      return {
        ...base,
        kind: 'skill.retired',
        text: `A skill was ${text(event.payload.to, 'retired')} (${text(event.payload.reason, 'no reason given')}).`,
        tone: event.payload.to === 'blocked' ? 'bad' : 'warn',
      }

    case 'skill.proposal.rejected':
      return {
        ...base,
        kind: 'skill.rejected',
        text: `A skill proposal was refused (${text(event.payload.code, 'unknown')}).`,
        tone: 'warn',
      }

    case 'skill.improvement.proposed':
      return {
        ...base,
        kind: 'skill.improvement',
        text: `An improvement was proposed against ${text(event.payload.target, 'an unknown target')}, resting on ${Array.isArray(event.payload.basisEvaluationIds) ? event.payload.basisEvaluationIds.length : 0} recorded evaluation(s).`,
        tone: 'neutral',
      }

    case 'skill.improvement.settled':
      return {
        ...base,
        kind: 'skill.improvement',
        text: `An improvement proposal was ${text(event.payload.decision, 'settled')} (${text(event.payload.reason, 'no reason given')}).`,
        tone: event.payload.decision === 'refused' ? 'warn' : 'neutral',
      }

    case 'skill.execution.planned':
      return {
        ...base,
        kind: 'skill.admitted',
        text: `A skill was planned into an existing Run (${number(event.payload.stepCount, 0)} step(s)).`,
        tone: 'busy',
      }

    case 'skill.runtime.promotion.refused':
      return {
        ...base,
        kind: 'skill.rejected',
        text: `An artifact was refused entry into Freya's running code (${text(event.payload.reason, 'no reason given')}).`,
        tone: 'warn',
      }

    // Runtime activation decisions are bookkeeping, not news. They describe
    // which domains Core did or did not bring up, and a person watching the
    // activity feed does not need one line per domain on every start. They are
    // served in full through `Core.runtime()`, which is the surface built for
    // them, so the feed deliberately has no row for them rather than a row that
    // says the event's own type name.
    case 'runtime.activation.decided':
    case 'runtime.activation.changed':
    case 'runtime.activation.stopped':
    case 'runtime.activation.reconciled':
      return null

    default:
      // Kept, but not promoted to a headline: an event type nobody has given a
      // sentence yet still deserves a row rather than a silent gap.
      return { ...base, kind: 'other', text: event.type, tone: 'neutral' }
  }
}

/**
 * Fold a batch of activity events, newest last.
 *
 * Duplicate sequences are dropped rather than reordered, because a replayed log
 * and a live subscription can overlap and a feed that shows the same line twice
 * is worse than one that shows it once.
 */
export function mergeActivity(
  existing: readonly CoreActivityEvent[],
  incoming: readonly CoreActivityEvent[],
  limit = ACTIVITY_LIMIT,
): CoreActivityEvent[] {
  if (incoming.length === 0) return existing as CoreActivityEvent[]
  const seen = new Set(existing.map((item) => item.id))
  const added: CoreActivityEvent[] = []
  for (const item of incoming) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    added.push(item)
  }
  if (added.length === 0) return existing as CoreActivityEvent[]
  return [...existing, ...added].sort((a, b) => a.sequence - b.sequence).slice(-limit)
}

function text(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A nested payload object, or an empty one. Never trusts its input's shape. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function modelSuffix(payload: Record<string, unknown>): string {
  const model = payload.model
  return typeof model === 'string' && model.length > 0 ? ` (${model})` : ''
}
