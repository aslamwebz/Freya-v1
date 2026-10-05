/**
 * The Core protocol: the vocabulary shared by Core and the renderer.
 *
 * Types only, and no runtime values, so the renderer can depend on the shape
 * of Core without depending on Core's implementation. Everything the renderer
 * is allowed to see is declared here.
 *
 * A renderer that can name a projection field cannot thereby acquire the
 * capability to change one.
 */

import type { ConversationCommandOutcome, VoiceCommandOutcome } from './conversation'
import type { ContextCommandOutcome } from './context'
import type { WorkforceCommandOutcome } from './workforce'
import type { AttentionCommandOutcome } from './attention'
import type { FoundryCommandOutcome } from './foundry'
import type { RelayCommandOutcome } from './relay'
import type { ConnectorCommandOutcome } from './connectors'
import type { SkillCommandOutcome } from './skills'
import type { LifeCommandOutcome } from './life'
import type { WorldCommandOutcome } from './world'

/* ------------------------------------------------------------ identity */

/** A principal asking Core for something. Never carries credentials. */
export type PrincipalId =
  | 'owner'
  | 'system'
  | `agent:${string}`
  | `module:${string}`

/* --------------------------------------------------------- capabilities */

/**
 * The Phase 1 capability vocabulary. Deny by default: a principal holds only
 * what has been explicitly granted, and the vocabulary is closed.
 */
export const CAPABILITIES = [
  'core.status.read',
  'core.command.submit',
  'cognition.status.read',
  'cognition.request',
  'cognition.grant.manage',
  'security.status.read',
  'security.stop',
  'security.resume',
  /**
   * Phase 5 research capabilities.
   *
   * Separate names, because they are separate kinds of privilege. Search asks a
   * third party about the world; `browser.read` fetches an arbitrary public page
   * and therefore executes an attacker's HTML inside a managed sandbox; research
   * starts a multi-stage operation that spends model calls. A capability vocabulary
   * that collapsed them into one `research.use` would make it impossible to widen
   * one without widening all three.
   *
   * None is a grant a model or a page can obtain. They are held by the owner
   * principal only, and each is evaluated by Guard before the privileged work
   * happens rather than after it.
   */
  'search.web',
  'browser.read',
  'research.start',

  // Work — Phase 6.
  //
  // `work.execute` is the one a `WorkCapability` names and the engine evaluates
  // before calling it. A capability states which vocabulary entry it needs, so a
  // future Searcher capability names `searcher.execute` and gets a policy decision
  // of its own rather than borrowing Work's.
  'work.status.read',
  'work.execute',
  'work.run.manage',
  'work.task.manage',
  /**
   * Deciding an approval.
   *
   * Separate from `work.run.manage` on purpose, because it is the only Work
   * capability that means *a person is being trusted*, and it is the one a model
   * must never be able to reach. Splitting it out means that capability can be
   * withheld, audited or re-gated without touching the rest of Work.
   */
  'work.approval.decide',

  // Missions — Phase 7.
  //
  // Two, not one, and the split is the point.
  //
  // `mission.status.read` is held by the owner only and is what a Mission surface
  // needs in order to render. `mission.manage` is what creates, activates, pauses,
  // resumes, cancels, concludes and *asks for completion*. Splitting them means a
  // future body can be given the ability to watch a Mission without being able to
  // conclude one — and concluding is the only operation that can say "this is done",
  // which is the one thing nobody should reach by accident.
  'mission.status.read',
  'mission.manage',

  /**
   * Skills (Phase 17). Two, and the split is the same one `work.*` and `mission.*`
   * make.
   *
   * `skill.status.read` is the owner's read: procedures, their lifecycle status, and
   * the evidence behind them as metadata. It grants nothing.
   *
   * `skill.manage` is admission, revision, promotion, retirement and improvement
   * proposals. It is deliberately *not* a capability a worker may ever hold (see
   * `WORKER_CAPABILITIES`), because a subordinate agent that could promote its own
   * procedure would be a self-awarded success with a capability string instead of a
   * method ??? and one that survives every argument about method interfaces.
   *
   * What is conspicuously **absent** from this vocabulary: nothing that lets a skill
   * be executed. Execution is Work's business; a skill is planned into a Run through
   * `work.run.create` and reaches a capability only through the capability the Run
   * already holds. There is no `skill.execute`, and adding one would be the single
   * most dangerous line this file could contain.
   */
  'skill.status.read',
  'skill.manage',

  // Life History — Phase 21.
  //
  // One read capability, and it is the owner's: what Freya remembers of her own
  // life is hers. There is no `life.manage` capability because recording,
  // revising, consolidating and withdrawing are not window commands at all —
  // they are Core-internal acts the owner scope performs, and no capability
  // string can reach them. A worker holds none of these.
  'life.status.read',

  // Foundry — Phase 15.
  //
  // Three, not one, and the split is the point.
  //
  // `foundry.status.read` is held by the owner only and is what a Foundry
  // surface needs in order to render. `foundry.artifact.manage` creates and
  // transitions artifacts. `foundry.activation.manage` activates, deactivates,
  // promotes and installs. Splitting them means a future body can be given
  // the ability to watch the foundry without being able to activate anything —
  // and activating is the only operation that can make a thing runnable,
  // which is the one thing nobody should reach by accident.
  'foundry.status.read',
  'foundry.artifact.manage',
  'foundry.activation.manage',
  // Relay — Phase 16.
  //
  // Email, calendar, GitHub and external connectors through bounded capabilities
  // rather than raw account access. Every action is separately bounded: one
  // capability per action, so there is no `relay.use` that widens every
  // connector at once.
  //
  // Reads and writes are different names on purpose. `relay.email.read` does not
  // imply `relay.email.send`; a principal holding every read capability and no
  // write capability can read and nothing else. Write/send/mutate actions
  // (`relay.email.send`, `relay.calendar.create`, `relay.github.issue.create`,
  // `relay.external.invoke`, …) each name their own capability, and each is
  // evaluated by Guard before the privileged work happens.
  //
  // `relay.approval.decide` is separate from every action capability because it
  // is the one Relay capability that means *a person is being trusted* with an
  // effect that leaves the building. Splitting it out means it can be withheld,
  // audited or re-gated without touching the rest of Relay.
  //
  // None of these is a grant a model or a worker can obtain. They are held by
  // the owner principal only, and `WORKER_CAPABILITIES` below deliberately adds
  // none of them: a worker can ask to think, and that is the end of it.
  'relay.status.read',
  'relay.email.read',
  'relay.email.draft',
  'relay.email.send',
  'relay.calendar.read',
  'relay.calendar.create',
  'relay.calendar.update',
  'relay.calendar.cancel',
  'relay.github.read',
  'relay.github.issue.create',
  'relay.github.pr.create',
  'relay.drive.read',
  'relay.drive.file.create',
  'relay.telegram.read',
  'relay.telegram.send',
  'relay.external.invoke',
  'relay.approval.decide',

  // Connectors — Phase 44.
  //
  // The connection plane. `connector.status.read` is the owner's read of the
  // connection projection and grants nothing. `connector.connect` starts an
  // authorization; `connector.disconnect` revokes one. `connector.read` and
  // `connector.action` are the two doors into Relay's action plane, and the
  // specific per-action authority is still Relay's own capability, checked by
  // Relay's engine after these. None is held by a worker.
  'connector.status.read',
  'connector.connect',
  'connector.disconnect',
  'connector.read',
  'connector.action',

  // World & self (Phase 22). Two, and the split is the same one `work.*`,
  // `mission.*` and `skill.*` make: reading what Freya thinks she knows is a
  // different privilege from being able to tell her something.
  //
  // Neither appears in `WORKER_CAPABILITIES`, so a worker principal can neither read
  // nor write the world model. A worker is `trusted: false`, and Guard refuses on
  // `trusted` before it looks at capabilities at all.
  //
  // Holding either of these is *not* evidence. A capability name cannot be expressed
  // as an entity or as a relation in the world model at all, so there is nothing a
  // claim could contain that would widen what these two permit.
  'world.status.read',
  'world.statement.submit',
  /**
   * Autonomous Capability Acquisition (Phase 29). Four, and the split is the phase.
   *
   * `acquisition.status.read` is the owner's read: the gap ledger, what is blocked and on what.
   * It grants nothing, and it is deliberately readable while building is *paused*, so an owner
   * can always see why an activation is stuck.
   *
   * `acquisition.propose` is what detects a gap and proposes a build. A worker principal does
   * **not** hold it: a subordinate agent that could raise its own capability requests would be
   * the whole acquisition loop with an agent at one end of it.
   *
   * `acquisition.verification.record` is what records that a *named* verifier found something.
   * It is not `verification.decide` — it can never report a gate as satisfied for something it
   * did not check, because `recordGateVerdict` requires the verifier's name and refuses the
   * evaluator's own authority on an evidence gate.
   *
   * `acquisition.activation.manage` is the one that means **a person is being trusted**, and it
   * is separate for the same reason `work.approval.decide` and `relay.approval.decide` are: it
   * can be withheld, audited and re-gated without touching the rest of the domain. Nothing in
   * this vocabulary makes an approved capability *do* anything — an activation means the owner
   * approved that request, and what an approved capability may do is decided by the runtime that
   * holds it, under its own authority.
   */
  'acquisition.status.read',
  'acquisition.propose',
  'acquisition.verification.record',
  'acquisition.activation.manage',

  /**
   * Self-Improving Architecture (Phase 30). Five, and the split is the phase.
   *
   * `improvement.status.read` is the owner's read: what Freya is trying to change about herself,
   * what is blocked and which landed changes are now past their own review date. It grants
   * nothing, and it is deliberately readable while everything else is *paused*, so an owner can
   * always see why a merge is stuck.
   *
   * `improvement.propose` raises a change. A worker principal does **not** hold it: an agent that
   * could file tickets against Freya's own architecture is the first step of the loop this phase
   * exists to keep human.
   *
   * `improvement.stage` and `improvement.verify` stage a change and record that a *named* verifier
   * found something. Neither can report a gate as satisfied for something it did not check, and
   * neither can touch the merge gate at all.
   *
   * `improvement.merge.approve` is the one that means **a person is being trusted**, and it is
   * separate for the same reason `work.approval.decide` and `acquisition.activation.manage` are: it
   * can be withheld, audited and re-gated without touching the rest of the domain.
   * `improvement.rollback` is separate again, and that separation is the point: a merge is a
   * forward change to Freya's own architecture and a rollback is another, so neither implies the
   * other. Giving the engine one capability for "change herself" would let a merge grant a
   * rollback by accident.
   *
   * Nothing here makes a change *apply*. An approved merge means the owner approved it; what
   * happens next is the owner's own action, and `StageExecution.appliedBy` is hard-set to
   * `'owner'` with no producer, so a self-merge is unrepresentable rather than merely forbidden.
   */
  'improvement.status.read',
  'improvement.propose',
  'improvement.stage',
  'improvement.verify',
  'improvement.merge.approve',
  'improvement.rollback',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * Everything the owner holds, in one place.
 *
 * The owner principal is built from this rather than from a list written out at
 * the call site, so a capability added to the vocabulary cannot be quietly left
 * off the one principal that is supposed to have it.
 */
export const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES

/**
 * The capabilities a worker may ever hold.
 *
 * Deliberately excludes `cognition.grant.manage`, every `security.*` capability,
 * and **every `work.*` capability**: a worker can ask to think, and that is the
 * end of it.
 *
 * `mission.*` is excluded for the same reason as `work.*`, and the exclusion is
 * stated here for the same reason: a Run executing under a worker principal must
 * never be able to conclude the Mission it belongs to. A Mission is a person's
 * outcome, and an agent deciding on its own that it has been achieved is precisely
 * the failure Missions exist to prevent.
 *
 * `work.*` being here in the negative is the single most important line in the
 * vocabulary. A Run executing under a worker principal can therefore never plan
 * further work, never cancel, never move a task, and — above all — never approve
 * its own request. Approval is the one capability in this system whose absence must
 * not be a matter of configuration.
 *
 * Phase 5 deliberately adds none of `search.web`, `browser.read` or
 * `research.start` here. A worker can already ask for cognition under a grant, and
 * cognition is where a research operation's model turns happen. Giving a worker the
 * ability to reach the network or a browser as well would mean an agent could
 * exfiltrate whatever it was told, which is the opposite of what a bounded worker
 * is for.
 */
export const WORKER_CAPABILITIES: readonly Capability[] = ['cognition.request']

/* --------------------------------------------------------------- Guard */

export type GuardOutcome = 'allow' | 'deny' | 'approval_required'

export interface GuardDecision {
  outcome: GuardOutcome
  /** The rule that decided it, for the audit trail. */
  reason: string
  capability: Capability
  principal: PrincipalId
}

/* ------------------------------------------------------------ cognition */

export type CognitionOrigin = 'user' | 'goal' | 'workflow' | 'agent' | 'learning' | 'system'

export type CognitionCause =
  | 'user_message'
  | 'user_requested_test'
  | 'explicit_review'
  | 'goal_started'
  | 'run_finished'
  | 'world_changed'
  | 'scheduled_grant'
  | 'learning_consolidation'

export type GovernorOutcome = 'allow' | 'ask' | 'deny'

export interface GovernorDecision {
  outcome: GovernorOutcome
  reason: string
  grantId: string | null
}

/* --------------------------------------------------------------- model */

export type ProviderStatusKind = 'disabled' | 'unconfigured' | 'configured' | 'faulted'

export interface ProviderStatus {
  id: string
  kind: 'fake' | 'nanogpt'
  status: ProviderStatusKind
  /** Never a secret: a shape, not a value. */
  model: string | null
  /** Why it is in this state, in words a person can act on. */
  detail: string
  /** True only when a live external call is possible and permitted. */
  liveEnabled: boolean
}

/**
 * Reported provider usage, accumulated over many calls.
 *
 * The two figures are sums of what providers *said*, and the counter is what
 * makes them honest:
 *
 * - `inputTokens` / `outputTokens` are the totals of the calls that reported
 *   usage. They are a **lower bound** whenever `unknownUsageCalls` is above zero,
 *   because the calls that reported nothing are simply not in the sum.
 * - `unknownUsageCalls` counts the calls that reported no usage, or only part of
 *   it. This is the explicit representation of "we do not know", chosen over
 *   treating an unreported call as zero — which would make an unaccounted call
 *   look like a free one — and over making the whole total null, which would
 *   throw away the calls that *were* accounted for.
 *
 * Nothing here is ever estimated. A caller that needs a true total must check
 * `unknownUsageCalls` first; presenting these two numbers as exact is the bug
 * this shape exists to prevent.
 *
 * This is entirely separate from a grant's *authorisation* budget, which is
 * reserved before a call and never depends on what a provider reports.
 */
export interface ModelUsage {
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  /** Calls whose usage was not fully reported. Makes the totals a lower bound. */
  unknownUsageCalls: number
}

  /* ---------------------------------------------------------- projection */

export type CoreLifecycle = 'booting' | 'ready' | 'degraded' | 'stopping' | 'stopped'

/**
 * Everything the renderer may know about Core.
 *
 * This is a projection of durable state, not a live handle. A field that is
 * genuinely unknown is `null`, never a placeholder number.
 */
/**
 * Whether the journal can be believed.
 *
 * `torn` is ordinary: a crash interrupted the last write and the surviving
 * prefix is the whole truth. `corrupt` is not: a complete line failed
 * validation, so the journal cannot be replayed into security state — the
 * discarded segment could have contained a STOP ALL. A Core in this state denies
 * cognition regardless of what the replayed prefix says.
 */
export type JournalIntegrity = 'ok' | 'torn' | 'corrupt'

export interface JournalFault {
  integrity: JournalIntegrity
  /** Why, in words a person can act on. Never null. */
  reason: string
  /** Which line the problem was found on, 1-indexed. */
  line: number | null
  /** Complete events that were read and believed. */
  eventsRead: number
  /** Bytes discarded during recovery, including a torn tail. */
  bytesDiscarded: number
}

export interface CoreStatus {
  lifecycle: CoreLifecycle
  /** Last durable event sequence, or 0 when the log is empty. */
  eventSequence: number
  coreStartedAt: string | null
  /**
   * Always present. A healthy journal says so explicitly, because the absence of
   * a warning is not the same thing as a warning that is absent.
   */
  integrity: JournalFault
  /** The latch is derived from durable events, so it survives a restart. */
  stopAll: {
    active: boolean
    activatedAt: string | null
    activatedBy: PrincipalId | null
  }
  guard: {
    /** Deny by default; shown so the posture is visible rather than implied. */
    defaultOutcome: GuardOutcome
    /** Capable of approval, but no approval workflow exists in Phase 1. */
    approvalWorkflow: 'unavailable'
  }
  governor: {
    /**
     * `unknown` is not the same as `deny_all`. A Core that has not finished
     * booting has no answer, and reporting "denying everything" there would
     * claim a stop latch that may well not be set.
     */
    status: 'ready' | 'deny_all' | 'unknown'
    grantsActive: number
  }
  providers: ProviderStatus[]
  /**
   * Provider requests executing **right now**, in this Core process.
   *
   * Read straight from the Model Gateway's active registry, which is the only
   * in-process record of live work. Deliberately not derived from the durable
   * journal: a journal can say a request was started and cannot say whether it
   * is still running, and a Core that died mid-call leaves a start with no
   * finish forever. Inferring "working" from that history is how an idle Freya
   * ends up claiming it is thinking.
   *
   * Zero means nothing is being spent, which is the normal state.
   */
  activeProviderCalls: number
  /** Usage for this Core session. Durable totals are separate. */
  sessionUsage: ModelUsage
  durableUsage: ModelUsage
  /** Non-empty when something is wrong; Core says what, rather than hiding it. */
  faults: string[]
}

/* ----------------------------------------------------------------- RPC */

export type CoreCommandName =
  | 'core.status.read'
  | 'core.command.submit'
  | 'security.status.read'
  | 'security.stopAll'
  | 'security.resume'
  | 'cognition.status.read'
  /**
   * Grant governance. The handler ignores any principal in the payload and
   * records the owner, because identity is assigned by Core and never
   * accepted from a caller.
   */
  | 'cognition.grant.create'
  | 'cognition.grant.revoke'
  /* ------------------------------------------------------ conversation */
  | 'conversation.create'
  | 'conversation.list'
  | 'conversation.read'
  /** The only door from a window into cognition. */
  | 'conversation.turn.submit'
  /** Scoped: stops one response. Does not latch STOP ALL. */
  | 'conversation.turn.cancel'
  /* -------------------------------------------------------------- voice */

  /**
   * The voice family.
   *
   * Read the comment before adding a name. Every one of these is reachable only
   * by the owner's own window, and every one of them is either a display concern
   * or an *input* concern. None of them is a way to say something to Freya that
   * she did not already write:
   *
   * - `voice.tts.speak` takes a **turn id**. Core reads the stored answer out of
   *   its own conversation store. A window cannot supply the words, so it cannot
   *   synthesise a sentence in Freya's voice.
   * - `voice.permission.report` is a *report* of what the operating system said.
   *   Core cannot grant permission, and capture is refused unless the last thing
   *   reported was `granted`.
   * - `voice.transcript.interim` is display text. It is not on a composer and
   *   there is no command that would submit it.
   * - `voice.submit.set` decides whether a *confirmed* transcript is submitted on
   *   the owner's behalf. It defaults to off, it never chooses the conversation,
   *   the turn id, the grant or the model, and it changes nothing until the next
   *   time somebody speaks.
   */
  | 'voice.status.read'
  /** Turn the microphone on. Explicit, and the only thing that sets `micEnabled`. */
  | 'voice.mic.enable'
  /** Turn the microphone off and release any open capture. */
  | 'voice.mic.disable'
  /** What the OS said. Never a request, and never a grant. */
  | 'voice.permission.report'
  | 'voice.capture.start'
  /** Display-only interim text from a streaming engine. */
  | 'voice.transcript.interim'
  | 'voice.capture.end'
  | 'voice.capture.cancel'
  /** Whether a confirmed transcript enters the conversation path unprompted. */
  | 'voice.submit.set'
  /** Read a stored turn aloud. The payload is a turn id and nothing else. */
  | 'voice.tts.speak'
  /** Finish at a boundary and drop the queue. */
  | 'voice.tts.stop'
  /** Cut off mid-word. Barge-in and STOP ALL both come through here. */
  | 'voice.tts.cancel'
  /** The output adapter reports playback finished, or failed. */
  | 'voice.tts.settle'
  | 'voice.tts.voice.read'
  | 'voice.tts.voice.select'
  | 'voice.mute.set'
  /** Arm or disarm the local speech-activity gate. Off until asked. */
  | 'voice.wake.arm'
  | 'voice.wake.disarm'
  /** A local energy reading. Arms nothing; may only ask for a capture. */
  | 'voice.wake.energy'
  /* -------------------------------------------------------------- brain */
  /** Read-only. Reports what the Brain is and what it holds. */
  | 'brain.status.read'
  /**
   * Ask Freya to remember something.
   *
   * The renderer's *request*, not a write. It carries what the person wants
   * remembered and nothing about how trusted it is — the source class is assigned
   * by the pathway that admits it, in Core, because a caller that could name its own
   * source could launder a web page's contents in as an owner assertion.
   */
  | 'brain.memory.write'
  /** Withdraw a memory deliberately. Archived, never deleted. */
  | 'brain.memory.archive'
  /** Recall on demand, so a person can see what Freya would bring to a question. */
  | 'brain.recall'
  /* ----------------------------------------------------------- research */
  /**
   * Phase 5. Five commands, and each payload is one field.
   *
   * `query`, `url` and `researchId` are the entire renderer-controlled input. Not
   * provenance, provider, model, limits, budget, principal or capability — a
   * renderer that could name any of those could either launder a web page's
   * contents in as an owner assertion, or raise its own budgets.
   */
  | 'search.web'
  | 'browser.read'
  | 'research.start'
  | 'research.cancel'
  | 'research.status.read'
  /* Freya's Eye: persistent, bounded search sessions. */
  | 'research.session.create'
  | 'research.session.list'
  | 'research.session.read'
  | 'research.session.followup'
  | 'research.session.collect'
  | 'research.session.pause'
  | 'research.session.resume'
  | 'research.session.cancel'

  /* --------------------------------------------------------------- work */
  /** Read-only. Reports the board: tasks, runs, approvals and progress. */
  | 'work.status.read'
  /**
   * Create a Task.
   *
   * A task is a user-visible piece of work, not a Step: one Task may contain
   * several Runs, and turning every internal Step into a Task would put the
   * engine's own mechanics on the user's board.
   */
  | 'work.task.create'
  | 'work.task.update'
  /**
   * Plan and start a Run.
   *
   * The renderer supplies a *plan* and Core validates every part of it against the
   * registered capability and verifier set. A plan is a request, not an authority:
   * it cannot name a capability that does not exist, cannot raise a ceiling, and
   * cannot assert that something is safe to run without a check.
   */
  | 'work.run.create'
  | 'work.run.start'
  | 'work.run.pause'
  | 'work.run.resume'
  /** Scoped: stops one Run. Does not latch STOP ALL. */
  | 'work.run.cancel'
  /**
   * Approve or deny a gated action.
   *
   * The payload carries the decision and nothing else. There is deliberately no
   * `decidedBy` field to read, because identity for a decision is assigned by Core
   * from the principal that reached the command — a caller that could name its own
   * approver could approve its own request.
   */
  | 'work.approval.decide'
  /* ----------------------------------------------------------- workforce */
  /**
   * Phase 8. The *only* Workforce command, and a read.
   *
   * There is deliberately no `workforce.worker.create`, no `workforce.assign`,
   * no `workforce.team.manage` and no `workforce.claim.submit` in this
   * vocabulary: naming a worker, placing one on a team, assigning a capability
   * or recording a claim are Workforce authority, and Workforce authority lives
   * in Core (issue #10) rather than in a window. A renderer reaching for any of
   * those names finds `unknown command`, which is the correct answer.
   *
   * The read takes no payload either — see `WORKFORCE_NO_PAYLOAD`. A window may
   * ask what the workforce is, and may not accompany the question with an owner,
   * a principal, an authority, a trust level, a provenance, a capability or a
   * claim of its own.
   */
  | 'workforce.status.read'
  | 'mission.status.read'
  | 'mission.create'
  | 'mission.activate'
  | 'mission.pause'
  | 'mission.resume'
  | 'mission.cancel'
  | 'mission.fail'
  | 'mission.requestCompletion'
  /* -------------------------------------------------------------- life */
  /**
   * Phase 21. Three reads and nothing else.
   *
   * `life.status.read` is a payloadless read of the projection. `life.timeline.read`
   * is a bounded, filtered chronological read. `life.entry.read` is the explicit
   * single-id read of one entry's own text — the only route to an entry body.
   *
   * There is deliberately no `life.record`, `life.revise`, `life.withdraw`,
   * `life.consolidate`, `life.confidence.set` or `life.promote` here: those are
   * Core-internal acts the owner scope performs, and a window has no name for any
   * of them. A window reaching for one finds `unknown command`.
   */
  | 'life.status.read'
  | 'life.timeline.read'
  | 'life.entry.read'
  /* ------------------------------------------------------------ context */
  /**
   * Phase 9. Context is *held*, not granted.
   *
   * Five commands, and none of them is a resolve. `context.reference.read` answers
   * whether "this" resolves and names ids; there is deliberately no command whose
   * result carries the content somebody selected, because the answer to "here" is
   * consumed by the code inside Core that was about to use it and must not become
   * a value a window can hold, log or replay. See `core/protocol/context.ts`.
   *
   * `context.admit` takes a `channel` from a closed list of the *owner's* doors and
   * no `source`, no `principal` and no authority of any kind: Core decides where
   * content came from, and a request that names one is refused whole rather than
   * stripped. Its `scope` must be a scope Core already holds, and the ambient
   * `session` scope is never a wire target — Core places a Mission there itself.
   *
   * A window reaching for `context.resolve`, `context.item.read` or any `context.*`
   * name outside this list finds `unknown command`, which is the correct answer.
   */
  | 'context.status.read'
  | 'context.scope.activate'
  | 'context.admit'
  | 'context.revoke'
  | 'context.revokeScope'
  | 'context.reference.read'
  /* --------------------------------------------------------------- model */
  /**
   * The model catalogue and the owner's selection.
   *
   * `model.catalog.read` lists the callable text models from the configured
   * provider. It is a metadata read — no inference, no spend, no grant — and it
   * runs only when a person asks, never on boot and never while idle.
   * `model.select` records one model id as the answer for *subsequent* turns.
   *
   * Note what a selection is not: it names no provider, no budget, no ceiling
   * and no capability. Core validates it against what a configured provider can
   * actually serve, refuses what it cannot serve with a stated reason, and a
   * selected turn still passes Guard, the Governor, its grant, the compiled
   * context and the contact gate exactly as every turn before any selector
   * existed. A selection that cannot be honoured fails truthfully.
   */
  | 'model.catalog.read'
  | 'model.select'

  /* ------------------------------------------------------------- attention */
  /**
   * Phase 12. Events and attention.
   *
   * A window may submit an authorized event, register a bounded schedule, cancel
   * one, read the projection and read back the text of one retained event. It may
   * **not** name its own source (Core fixes it to `owner`), choose an importance,
   * assert an urgency, decide an outcome, spend an interruption budget, bypass a
   * cooldown or reach a model. `attention.status.read` carries no payload at all.
   *
   * There is deliberately no `attention.decide`, no `attention.escalate` and no
   * `attention.budget.set`: deciding is Core's, and a window that could set a budget
   * could remove one.
   */
  | 'attention.status.read'
  | 'attention.event.ingest'
  | 'attention.schedule.register'
  | 'attention.schedule.cancel'
  | 'attention.inbox.read'
  /* ------------------------------------------------------------- foundry */
  | 'foundry.status.read'
  /* --------------------------------------------------------------- office */
  /**
   * Phase 14. The Office: a truthful spatial view of real Work/Workforce state.
   *
   * `office.status.read` is a payloadless read of the Office projection —
   * Freya's station, live run stations, worker stations, approval stations and
   * the history timeline. It carries no payload, and it is ungated like
   * `work.status.read`: knowing what is happening in the office is the owner's
   * own business.
   *
   * `office.presence.request` asks that an agent join the desktop Presence.
   * It takes a `workerId` and nothing else — no principal, no authority, no
   * capability, no expression. Core validates the worker exists, journals the
   * request as metadata, and the Office reports it as pending. Whether and how
   * the agent appears is a Presence concern (Phase 13); the Office can ask and
   * show that it asked, and it can do nothing else.
   */
  | 'office.status.read'
  | 'office.presence.request'
  /* --------------------------------------------------------------- relay */
  /**
   * Phase 16. Connectors through bounded capabilities.
   *
   * A window may read the Relay projection, request a read on a connector, and
   * request a write — which creates a pending approval and executes only after
   * the owner decides. It may **not** name a capability, a credential, a budget
   * or a limit; it may not execute a write without an approval; and it may not
   * decide an approval that is not pending.
   *
   * There is deliberately no `relay.connector.register`, no `relay.connector.fault`
   * and no `relay.allowlist.set` in this vocabulary: connector registration,
   * faulting and the GitHub repo allowlist are Core/host authority, and a
   * window that could register a connector could launder an arbitrary adapter
   * into the transport plane. A window reaching for any of those names finds
   * `unknown command`, which is the correct answer.
   */
  | 'relay.status.read'
  | 'relay.email.read'
  | 'relay.email.draft.create'
  | 'relay.email.send'
  | 'relay.calendar.read'
  | 'relay.calendar.create'
  | 'relay.calendar.update'
  | 'relay.calendar.cancel'
  | 'relay.github.read'
  | 'relay.github.issue.create'
  | 'relay.github.pr.create'
  | 'relay.drive.read'
  | 'relay.drive.file.create'
  | 'relay.telegram.read'
  | 'relay.telegram.send'
  | 'relay.external.invoke'
  | 'relay.approval.decide'

  /* ------------------------------------------------------------ connectors */
  /**
   * Phase 44. Connectors through a connection plane plus Relay's action plane.
   *
   * A window may read the connector projection, start an authorization, revoke
   * one, submit a typed read, and submit a typed action (which Relay turns into
   * a pending approval). It may **not** name a scope, a token, an account, a
   * capability, a budget or a limit, and there is deliberately no
   * `connector.authorize` and no `connector.event.ingest`: completing an
   * authorization and delivering an authenticated event are host-only acts, and
   * a window reaching for those names finds `unknown command`.
   */
  | 'connector.status.read'
  | 'connector.connect.start'
  | 'connector.disconnect'
  | 'connector.read'
  | 'connector.action.execute'

  /* --------------------------------------------------------------- skills */
  /**
   * Phase 17. Nine commands, and every one of them is either a read or an owner act
   * that routes through Core's own admission, evaluation and promotion tables.
   *
   * A window may admit a procedure it wrote, revise it, report what it observed about
   * one, ask Core to move a lifecycle status, retire one, propose an improvement,
   * read the projection, ask for a deterministic selection, and read back one
   * procedure's own text.
   *
   * It may **not**: name a skill's trust class, assert its verification state, submit
   * a verification record, set a promotion threshold, skip the evidence window,
   * promote an artifact into Freya's running code, or plan a skill into work. There is
   * deliberately no `skill.execute`, no `skill.verify`, no `skill.promote.artifact` and
   * no `skill.threshold.set`; a window reaching for those names finds `unknown
   * command`, which is the correct answer.
   *
   * `skill.recordEvaluation` takes evidence a *person* observed ??? test results, checks,
   * their own confirmation, a completion result ??? and never a verification record.
   * Core's own Work and Mission verifiers supply those, from inside Core.
   */
  | 'skill.status.read'
  | 'skill.admit'
  | 'skill.revise'
  | 'skill.recordEvaluation'
  | 'skill.transition'
  | 'skill.retire'
  | 'skill.propose'
  | 'skill.proposal.settle'
  | 'skill.select'
  | 'skill.detail.read'

  /* --------------------------------------------------------- world & self */
  /**
   * Phase 22. Five reads and two owner acts, and the shape of the group is the whole
   * argument: a window may *ask* what Freya believes about the world and about
   * herself, and the owner may add or withdraw a claim. Nothing else.
   *
   * It may **not**: invent an entity, invent a relationship, state its own source or
   * certainty, name a capability as a fact, promote a claim to verified, resolve a
   * conflict, or touch Freya's identity. There is deliberately no
   * `world.entity.create`, no `world.relation.assert`, no `world.confidence.set` and
   * no `world.identity.write`; a window reaching for those finds `unknown command`,
   * which is the correct answer.
   *
   * `world.statement.submit` and `world.statement.withdraw` are owner-only through
   * Guard and are **not** in the preload command allowlist, so a renderer cannot
   * reach them at all. Core's own observation seams call the same admission
   * directly, with a channel Core assigned.
   */
  | 'world.summary.read'
  | 'world.entities.read'
  | 'world.entity.read'
  | 'world.relations.read'
  | 'self.status.read'
  | 'world.statement.submit'
  | 'world.statement.withdraw'

export interface CoreCommandEnvelope {
  command: CoreCommandName
  /** Correlates the acknowledgement with the request that caused it. */
  requestId: string
  payload?: unknown
}

export interface CoreCommandResult {
  requestId: string
  ok: boolean
  /** Present when the command was understood; absent on rejection. */
  status?: CoreStatus
  /** Present on a deliberate refusal: Guard, Governor, validation. */
  refusal?: { reason: string }
  /** Present on an unexpected failure. Never carries a stack to the renderer. */
  error?: { message: string }
  /**
   * The durable sequence number of the event this command produced. Present only
   * when the command actually appended something, so a renderer can verify the
   * effect is on disk instead of taking a boolean on trust.
   */
  durableSequence?: number
  /**
   * The conversation view of a conversation command's result.
   *
   * A separate slot rather than a wider `status`, because the two answer different
   * questions and merging them would let a panel read a conversation out of a
   * security projection. Nothing here is writable by the renderer: it is what
   * Core built, and the next push overwrites it.
   */
  conversation?: ConversationCommandOutcome
  /**
   * The voice view of a voice command's result.
   *
   * Its own slot for the same reason the conversation slot exists: a window must
   * never have to dig a transcript or a capture result out of a security
   * projection, and two unrelated streams sharing one field is how that starts.
   */
  voice?: VoiceCommandOutcome
  /**
   * The Brain view of a Brain command's result.
   *
   * Its own slot, for the same reason the conversation and voice slots exist: the
   * Brain is where Freya's long-term knowledge lives, and it must never have to be
   * dug out of a security projection — where it would be copied and cached
   * wherever status is.
   */
  brain?: BrainCommandOutcome
  /**
   * The Mission view of a Mission command's result.
   *
   * Its own slot for the same reason as every other subsystem's: a Mission carries
   * what the owner asked for, and a security projection is exactly the kind of thing
   * that gets cached, logged and copied around. It is also where a *refusal* lands
   * separately from `ok`, because "the engine declined" and "Core understood you" are
   * different facts and a window that cannot tell them apart will report a refusal as
   * a success.
   */
  mission?: MissionCommandOutcomeView
  /**
   * The research view of a research command's result.
   *
   * Its own slot for the same reason the conversation, voice and Brain slots exist:
   * a window must never have to dig a search result or a research answer out of a
   * security projection, where it would travel wherever status is cached or logged.
   */
  research?: ResearchCommandOutcome

  /**
   * The Work view of a Work command's result.
   *
   * Its own slot, for the same reason the Brain and conversation slots exist: this
   * is the answer to "what did Core do with the work", and it must never have to be
   * dug out of a security projection where it would be cached and copied wherever
   * status is.
   *
   * The projection itself arrives on its own channel — see `work.status.read` and
   * the Work mirror — so this slot carries the *outcome* of one command rather than
   * a second copy of the board.
   */
  work?: WorkCommandOutcome

  /**
   * The Workforce view of a Workforce command's result.
   *
   * Its own slot for the same reason every other subsystem's exists: whether
   * Core answered a workforce read, or refused it, is a fact about Workforce
   * and must never have to be dug out of a security projection where it would
   * travel wherever status is cached or logged.
   *
   * The projection itself arrives on its own channel — see
   * `workforce.status.read` and the Workforce mirror — so this slot carries the
   * *outcome* of one command rather than a second copy of the workforce. It is
   * also where a refusal lands separately from `ok`, for the same reason as the
   * Mission slot: "the read was refused" and "Core understood you" are different
   * facts.
   */
  workforce?: WorkforceCommandOutcome

  /**
   * The World & self view of a world command's result.
   *
   * Its own slot, and one worth naming: the world model is the first subsystem whose
   * projection is a *graph* rather than a list, so a window that received it on a
   * shared channel would receive every node and edge of the owner's world at once.
   * The outcome carries exactly one operation's bounded view instead, and both
   * mutating operations answer with the evidence id they produced, so a caller can
   * withdraw that claim later by id rather than by guessing at it.
   */
  world?: WorldCommandOutcome

  /**
   * The Context view of a Context command's result.
   *
   * Its own slot for the same reason every other subsystem's exists, and for one
   * more reason as well: this is the one subsystem whose *content* is not merely
   * private but has no business being in a projection that gets copied, cached and
   * logged. So the outcome carries ids, closed reasons and counts, and the only
   * thing in this file that could hold a selected sentence is deliberately absent.
   *
   * A refusal lands here separately from `ok` for the same reason as the Mission
   * slot: "Core understood you and declined" and "Core did not understand you" are
   * different facts, and a window that cannot tell them apart reports one as the
   * other.
   */
  context?: ContextCommandOutcome

  /**
   * The model view of a model command's result.
   *
   * Its own slot for the same reason every other subsystem's exists, and here
   * the contents are deliberately only ids and states: a catalogue is display
   * metadata, a selection is a session setting, and neither is a place for a
   * credential, a provider object, or anything a window could re-send as an
   * authorisation. A refusal lands here with its reason, because "Core
   * understood and declined" must never render as success.
   */
  model?: ModelCommandOutcome

  /**
   * The Attention view of an attention command's result.
   *
   * Its own slot for the same reason every other subsystem's exists: whether Core
   * accepted an event, registered a schedule or refused a read is a fact about
   * attention and must never have to be dug out of a security projection. The
   * projection itself arrives on its own channel — see `attention.status.read` and
   * the Attention mirror — so this slot carries the *outcome* of one command rather
   * than a second copy of the state.
   */
  attention?: AttentionCommandOutcome

  /**
   * The Skills view of a skill command's result.
   *
   * Its own slot for the same reason every other subsystem's exists: whether Core
   * admitted a procedure, refused a promotion, or recorded an evaluation is a fact
   * about Skills and must never have to be dug out of a security projection where it
   * would be cached and copied wherever status is.
   *
   * The projection itself arrives on its own channel ??? see `skill.status.read` and the
   * Skills mirror ??? so this slot carries the *outcome* of one command rather than a
   * second copy of the registry. A refusal lands here with its **closed code**, so a
   * surface can distinguish "this may never be true" from "this is not true yet"
   * without parsing a sentence.
   */
  skill?: SkillCommandOutcome

  /**
   * The Life History view of a life command's result.
   *
   * Its own slot for the same reason every other subsystem's exists: whether Core
   * answered a life read, or refused it, is a fact about Life History and must
   * never have to be dug out of a security projection where it would be cached
   * and copied wherever status is.
   *
   * The projection itself arrives on its own channel — see `life.status.read` and
   * the Life mirror — so this slot carries the *outcome* of one command rather
   * than a second copy of the history. A refusal lands here with its **closed
   * code**, so a surface can distinguish "there is no such entry" from "the read
   * was refused" without parsing a sentence.
   */
  life?: LifeCommandOutcome

  /** The Foundry outcome for the current command. */
  foundry?: FoundryCommandOutcome

  /**
   * The Office view of an office command's result.
   *
   * Its own slot for the same reason every other subsystem's exists: whether
   * Core answered an office read, or accepted or refused a presence request,
   * is a fact about the Office and must never have to be dug out of a security
   * projection. The projection itself arrives on its own channel — see
   * `office.status.read` and the Office mirror — so this slot carries the
   * *outcome* of one command rather than a second copy of the office.
   */
  office?: OfficeCommandOutcome

  /**
   * The Relay view of a Relay command's result.
   *
   * Its own slot for the same reason every other subsystem's exists: whether
   * Core accepted an action request, created a pending approval or refused a
   * read is a fact about Relay and must never have to be dug out of a security
   * projection. The projection itself arrives on its own channel — see
   * `relay.status.read` and the Relay mirror — so this slot carries the
   * *outcome* of one command rather than a second copy of the state.
   */
  relay?: RelayCommandOutcome

  /**
   * The connector view of a connector command's result.
   *
   * Its own slot for the same reason every other subsystem's exists: whether
   * Core started an authorization, revoked a connector or refused a read is a
   * fact about connectors and must never have to be dug out of a security
   * projection. The projection itself arrives on its own channel.
   */
  connectors?: ConnectorCommandOutcome
}

/**
 * What an Office command produced.
 *
 * `status` is the payloadless read. `presence-requested` means Core validated
 * the worker exists and journalled the request. `refused` covers every way the
 * request can be declined: no such worker, a malformed id, a full request set.
 */
export interface OfficeCommandOutcome {
  operation: 'status' | 'presence-requested' | 'refused'
  ok: boolean
  reason?: string
  /** The worker whose presence was requested, when the command was understood. */
  workerId?: string
  /** The durable sequence of the journalled request, when one was written. */
  durableSequence?: number
}

/**
 * One listed model, in the words the provider used.
 *
 * An id and an owner label — the whole of what a selector needs and the whole
 * of what may cross the bridge. Nothing about a model's cost, capability or
 * context window is asserted here, because Freya is not the authority on any
 * of those and an invented figure would be a lie the size of a number.
 */
export interface ModelView {
  id: string
  ownedBy: string | null
}

/**
 * What a model command produced.
 *
 * `refused` is an outcome rather than an exception everywhere: a missing key,
 * a network failure and an unusable selection all answer in words, and none of
 * them is ever papered over with an empty list or an echoed default.
 */
export interface ModelCommandOutcome {
  operation: 'catalog' | 'selected' | 'refused'
  reason?: string
  models?: readonly ModelView[]
  /** The provider's own configured default, which is what "no selection" means. */
  defaultModel?: string | null
  /** The selection after the command: a name, or null for "the default". */
  selected?: string | null
}

/**
 * What a research command produced.
 *
 * Bounded in every direction. `limits` is the code-owned ceiling, echoed so a window
 * can show what Freya is actually allowed to spend; it is never an input. Sources
 * carry the URL a person would need in order to check a claim — that is the point of
 * a citation — while the journal, the activity feed and every event carry only ids
 * and counts.
 */
export interface ResearchCommandOutcome {
  operation:
    | 'search'
    | 'read'
    | 'research'
    | 'cancelled'
    | 'status'
    | 'session-created'
    | 'session-list'
    | 'session-read'
    | 'session-updated'
    | 'session-collected'
    | 'session-paused'
    | 'session-resumed'
    | 'session-cancelled'
    | 'refused'
  reason?: string
  operationId?: string
  limits?: {
    iterations: number
    queries: number
    results: number
    pages: number
    evidenceChars: number
    durationMs: number
    modelTurns: number
    maxOutputTokens: number
  }
  results?: readonly {
    title: string
    url: string
    snippet: string
    sourceDomain: string
  }[]
  document?: {
    title: string
    url: string
    sourceDomain: string
    retrievedAt: string
    headings: string[]
    text: string
    links: readonly { title: string; url: string }[]
    truncated: boolean
  }
  result?: {
    id: string
    state: 'completed' | 'partial' | 'failed' | 'cancelled'
    findings: readonly { text: string; sourceIds: string[] }[]
    conflicts: readonly { text: string; sourceIds: string[] }[]
    uncertainties: string[]
    sources: readonly {
      sourceId: string
      url: string
      title: string
      domain: string
      retrievedAt: string
      excerpt: string
    }[]
    failures: readonly { stage: string; code: string }[]
    usage: Record<string, number>
  }
  status?: { operationId: string; stage: string } | null
  /** Freya's Eye sessions. Queries/results are private response data, never journal fields. */
  session?: {
    sessionId: string
    state: 'active' | 'paused' | 'completed' | 'partial' | 'cancelled' | 'failed'
    intentVersion: number
    intent: {
      subject: string
      targetCount: number
      mediaType: 'auto' | 'web' | 'image' | 'video' | 'audio' | 'document' | 'file'
      constraints: string[]
      exclusions: string[]
      site: string | null
    }
    page: number
    resultCount: number
    createdAt: string
    updatedAt: string
    lastError: string | null
    persistence: { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null }
    results: readonly {
      resultId: string
      rank: number
      title: string
      url: string
      snippet: string
      sourceDomain: string
      mediaType: 'web' | 'image' | 'video' | 'audio' | 'document' | 'file'
      confidence: 'exact' | 'probable' | 'weak'
      collection: 'Videos Found' | 'Images Found' | 'Audio Found' | 'Files Found' | 'Sources'
    }[]
  }
  sessions?: readonly {
    sessionId: string
    state: 'active' | 'paused' | 'completed' | 'partial' | 'cancelled' | 'failed'
    subject: string
    targetCount: number
    mediaType: 'auto' | 'web' | 'image' | 'video' | 'audio' | 'document' | 'file'
    resultCount: number
    updatedAt: string
  }[]
  ambiguous?: boolean
}

/**
 * What a Brain command produced.
 *
 * `recall` is the interesting one, and its shape is the point: a pack that names
 * every item's source class and confidence, discloses the contradictions it found,
 * and counts what it left out. "Freya recalled this" is only a meaningful thing to
 * show somebody if they can also see where it came from and what was dropped.
 */
/**
 * What a Mission command produced, as the renderer sees it.
 *
 * A structural copy of `MissionCommandOutcome` rather than a re-export, because the
 * protocol is what a window is typed against and Core's engine types are not part of
 * that contract. Nothing here is writable: Core overwrites it on the next push.
 */
export interface MissionCommandOutcomeView {
  /** Which Mission operation this was, in the vocabulary Core knows. */
  operation: string
  ok: boolean
  /** The Mission's id, once one exists. */
  missionId?: string
  /** The status after the command, when it changed anything. */
  status?: string
  /** Why a refusal or a non-establishment happened, in words. Never evidence. */
  reason?: string
}

export interface BrainCommandOutcome {
  operation:
    | 'status'
    | 'memory-written'
    | 'memory-refused'
    | 'memory-archived'
    | 'recall'
  reason?: string
  memory?: {
    memoryId: string
    kind: string
    subject: string
    status: string
    source: string
    confidence: string
    admittedAt: string
  }
  recall?: {
    query: string
    items: readonly {
      memoryId: string
      subject: string
      content: string
      source: string
      confidence: string
      status: string
      score: number
    }[]
    conflicts: readonly { memoryId: string; conflictsWith: readonly string[]; detail: string }[]
    candidatesConsidered: number
    omittedCount: number
    estimatedTokens: number
    empty: boolean
  }
}

/**
 * What a Work command produced.
 *
 * `ok` is here and not inferred from the presence of a result, because a Work
 * command that was *refused* still produces a result — and "your approval request
 * was denied" and "the engine could not be reached" must never look the same as
 * success. `reason` carries Core's own words on every refusal, for the same reason
 * the Vault shows one: a refusal somebody cannot examine is indistinguishable from
 * a refusal that was arbitrary.
 *
 * Note what this type does **not** carry: a step plan, a capability input, an
 * observation, or an approval proposal. The outcome says what happened to a
 * command. What the work consists of is on the Work projection.
 */
export interface WorkCommandOutcome {
  operation: string
  ok: boolean
  reason?: string
  runId?: string
  stepId?: string
  approvalId?: string
  taskId?: string
  /** The Run's status after the command, which is the honest answer to "where is it now". */
  runStatus?: string
}
