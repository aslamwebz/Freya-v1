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

  // Long-Horizon Goals (Phase 5).
  'goal.status.read',
  'goal.manage',
  'attention.schedule.manage',
  'matrix.manage',

  // Proactive Intelligence (Phase 6).
  'proactive.status.read',
  'proactive.manage',
  'proactive.ingest',

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
  'workspace.report.save',
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
