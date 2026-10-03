import type { CognitionCause, CognitionOrigin, PrincipalId } from '../protocol/core-protocol'
import type {
  EvaluationAuthor,
  EvaluationReason,
  EvaluationSubjectKind,
  ImprovementTarget,
  SkillKind,
  SkillRefusalCode,
  SkillRetirementReason,
  SkillSource,
  SkillStatus,
  SkillTrustClass,
  SkillVerdict,
} from '../skills/types'
import type {
  AttentionCondition,
  AttentionCueCode,
  AttentionEventKind,
  AttentionOutcome,
  AttentionReason,
  AttentionSource,
  FocusState,
  ImportanceLevel,
  SeverityHint,
  UrgencyLevel,
} from '../attention/types'
import type {
  RelayAction,
  RelayConnectorId,
  RelayFailureCode,
  RelayRiskClass,
} from '../relay/types'

/**
 * The durable Core event envelope.
 *
 * Every event Core records has this shape, permanently. The envelope is what
 * makes replay, correlation and audit possible; the payload is what may change.
 *
 * Two rules hold for the whole of Core:
 *   - an event becomes visible to subscribers only after its append succeeds;
 *   - replay never appends, never publishes, and never causes a side effect.
 */

export const CORE_EVENT_SCHEMA_VERSION = 1

/** Event types. Grouped by the subsystem that owns them. */
export const CORE_EVENT_TYPES = [
  // Lifecycle
  'core.started',
  'core.ready',
  'core.degraded',
  'core.integrity_fault',
  'core.stopping',
  'core.stopped',

  // Commands arriving from the user
  'command.received',

  // Guard
  'guard.decision',
  'security.stop_all.activated',
  'security.stop_all.cleared',

  // Cognition governance
  'cognition.requested',
  'cognition.allowed',
  'cognition.denied',
  'cognition.authorization_required',
  'cognition.grant.created',
  'cognition.grant.revoked',
  'cognition.grant.reserved',
  'cognition.grant.usage_reported',

  // Model execution
  //
  // The invariant the reducer relies on, and the reason `started` is written at
  // the last possible moment: `model.request.started` means the gateway was about
  // to hand this request to a provider. Every terminal event after it therefore
  // describes a provider that was contacted, and a `cancelled` that says
  // `providerContacted: false` is the one case where a start is withdrawn.
  'model.request.started',
  'model.request.completed',
  'model.request.failed',
  'model.request.cancelled',

  // Conversation — metadata only, never a word of what was said.
  //
  // The bodies live in the encrypted Conversation Store. What appears here is
  // enough to answer "did a turn happen, how big was it, which provider answered,
  // how did it end" and nothing more, because this file is audit surface: it is
  // read, copied and backed up far more freely than the conversation itself.
  'conversation.created',
  'conversation.turn.started',
  'conversation.turn.completed',
  'conversation.turn.cancelled',
  'conversation.turn.failed',
  'conversation.turn.denied',
  'conversation.turn.interrupted',

  // Local voice — metadata only. Audio never reaches this file.
  'voice.capture.started',
  'voice.capture.completed',
  'voice.capture.cancelled',

  // Brain — metadata only.
  //
  // The Brain holds the most valuable long-term state in the system and the
  // journal is the least protected place it could go: audit logs get read, copied,
  // exported into backups and forwarded to people debugging things. So these carry
  // ids, counts, source classes and lengths. Never what was learned, never a
  // memory's text, never a subject a person typed.
  //
  // Note what is absent too: there is no `brain.memory.recalled`. Recall happens
  // constantly and putting it in the durable log would turn the journal into a
  // record of Freya's private associations.
  'brain.seeded',
  'brain.memory.admitted',
  'brain.memory.reviewed',
  'brain.memory.archived',
  'brain.world.entity_noted',
  'brain.world.related',
  'brain.world.observed',
  'brain.experience.recorded',
  'brain.degraded',

  // Life History — metadata only, on the Brain's terms.
  //
  // A Life fault is never a security event: it cannot grant cognition or clear a
  // stop, and it does not lose authority either. It is a statement about a derived
  // layer, so Core keeps running and the surface says Life is degraded with a
  // reason. The event carries that reason and nothing else.
  'life.entry.recorded',
  'life.entry.withdrawn',
  'life.conflict.detected',
  'life.degraded',

  // Personality & Relationship — metadata only, on the Brain's terms.
  //
  // Relationship records are the most personal thing Freya holds: facts about a
  // person, their preferences, their habits, the shorthands they share. The
  // journal is the place least able to keep a secret — it is read, copied, exported
  // into backups and forwarded to whoever is debugging — so these carry an id, a
  // code-owned slug, closed kind and status labels, the trust class Core assigned,
  // counters, and a *closed* lifecycle reason.
  //
  // There is deliberately no payload field for the recorded text, for the owner's
  // clause that matched, or for a free-text reason of any kind. That is a property
  // of the payload type rather than of anyone's care: an audit reader can see that
  // a record was admitted, superseded, withdrawn or retired, and can see the trust
  // class it carries, without this file ever holding a word the person said.
  'personality.record_changed',
  'personality.degraded',

  // Research (Phase 5) — metadata only.
  //
  // The research stack sees the query, the URLs, the page text and the answer.
  // None of that may travel: this journal is read, copied, exported into backups
  // and forwarded to whoever is debugging, and a search history is a record of what
  // a person has been curious about.
  //
  // So these carry operation and session ids, a closed stage, integer counters and
  // fixed failure codes, and nothing else. There is deliberately no event type that
  // could hold a query, a URL, a domain, a snippet, a page, an answer or a
  // provider diagnostic.
  'research.search_started',
  'research.search_completed',
  'research.search_failed',
  'research.read_started',
  'research.read_completed',
  'research.read_failed',
  'research.started',
  'research.progress',
  'research.completed',
  'research.failed',
  'research.cancelled',


  // Work — the execution substrate. Metadata only, for the same reason as Brain
  // and with more force: a Step's input and an Observation's contents are the
  // content, and this file is the least protected place anything in Core could go.
  //
  // So a Work event carries ids, statuses, counts, risk classes and *measured
  // lengths*. `summaryLength` and `detailLength` are how a reader learns something
  // substantial happened without the journal becoming a transcript of what every
  // capability returned. Nothing here names a label, a task title, a step input,
  // a summary or a capability's data.
  //
  // `work.run.awaiting_approval` is recorded separately from `work.run.waiting`
  // even though one gates the other, because a board has to be able to tell "a
  // person is being asked" from "something external is pending".
  'work.run.created',
  'work.run.started',
  'work.run.resumed',
  'work.run.paused',
  'work.run.waiting',
  'work.run.awaiting_approval',
  'work.run.completed',
  'work.run.failed',
  'work.run.cancelled',
  /**
   * A Run was reconciled after a restart.
   *
   * `previousStatus` is carried in the payload rather than read back out of state,
   * because after a restart "what this Run was doing" is precisely the thing that
   * is no longer knowable. The fact that a status had to be reconciled is the
   * point: the journal records that history was *not* proof of execution.
   */
  'work.run.recovered',

  'work.step.ready',
  'work.step.started',
  'work.step.verified',
  'work.step.failed',
  'work.step.cancelled',
  'work.step.skipped',

  'work.action.started',
  'work.action.completed',
  'work.action.failed',
  'work.action.cancelled',

  /** Evidence, measured. The contents stay in the process that holds them. */
  'work.observation.recorded',
  'work.verification.requested',
  'work.verification.completed',

  /**
   * Approval is first-class execution state, so it is an event family rather than
   * a boolean on an Action.
   *
   * `requested` is the transition: the Run and its Step stop and begin waiting on
   * a named decision. One event, one fact — which is also what makes "nothing ran
   * yet" checkable, because the record exists strictly before any Action does.
   */
  'work.approval.requested',
  'work.approval.approved',
  'work.approval.denied',
  'work.approval.cancelled',
  'work.approval.expired',

  'work.task.created',
  'work.task.updated',
  'work.task.attached',
  'work.task.completed',

  /** A ceiling was reached. Recorded so a restart cannot hide one. */
  'work.limits.exceeded',

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


  // Foundry (Phase 15) — metadata only, and the family where deterministic
  // identity is the whole point.
  //
  // A Foundry event describes *that an artifact was produced, verified,
  // promoted or activated* and *what its deterministic identity is*. There is
  // no slot for the artifact's content, its spec, or its verification evidence:
  // those are process-local and never written here. Every field is an id, a
  // hash, a status, a closed enum, an integer counter, a measured length, or
  // a closed reason code.
  //
  // The hash is the deterministic identity — a SHA-256 of the artifact's
  // content and inputs. It is computed by the Foundry engine at creation time
  // and is never mutable.
  'foundry.artifact.created',
  'foundry.artifact.transitioned',
  'foundry.verification.recorded',
  'foundry.promotion.recorded',
  'foundry.activation.recorded',
  'foundry.tool.registered',
  'foundry.tool.transitioned',
  'foundry.module.registered',
  'foundry.module.transitioned',
  'foundry.app.registered',
  'foundry.app.transitioned',
  'foundry.limit.exceeded',

  // Office (Phase 14) — the bounded record of a presence request.
  //
  // A request is not a command to Presence. It carries a workerId and nothing
  // else: no principal, no authority, no capability, no expression. Whether
  // and how the agent appears on the desktop is a Presence concern (Phase 13),
  // and these events have no field that could influence it. The Office can
  // ask, and it can show that it asked, and it can do nothing else.
  'office.presence.requested',
  'office.presence.fulfilled',

  // Relay (Phase 16) — metadata only, and the family where the target is the
  // most that may be recorded.
  'relay.action.requested',
  'relay.approval.requested',
  'relay.approval.decided',
  'relay.approval.expired',
  'relay.action.executed',
  'relay.action.failed',
  'relay.action.cancelled',
  'relay.connector.faulted',
  'relay.limits.exceeded',
] as const

export type CoreEventType = (typeof CORE_EVENT_TYPES)[number]

export interface CoreEventEnvelope<T extends CoreEventType = CoreEventType> {
  eventId: string
  /** Monotonic per Core lifetime, and after replay, across the whole log. */
  sequence: number
  type: T
  schemaVersion: number
  occurredAt: string

  source: 'core' | 'renderer' | 'system'
  actor: PrincipalId

  /** Ties related events together across subsystems. */
  correlationId: string
  /** The event that caused this one. */
  causationId: string | null

  payload: CoreEventPayloads[T]
}

/**
 * One conversation turn's durable metadata.
 *
 * Every field here is either an id, a count, or a word a person would say out
 * loud. There is no field a message could hide in, and that is the whole
 * property: adding a field to a conversation event is a visible change to the
 * audit schema, not something that quietly starts retaining what someone typed.
 */
export interface ConversationTurnEvent {
  conversationId: string
  turnId: string
  /** Null only when the turn was refused before the message could be stored. */
  userMessageId: string | null
  /** Null until an answer exists, exactly as in the conversation store. */
  assistantMessageId: string | null
  /**
   * Size of the turn's largest stored message, in characters.
   *
   * A measurement, never the content. It is what lets an operator see that a turn
   * was substantial, and it is the only trace of anyone's words that leaves Core.
   */
  contentLength: number
  /** The single Model Gateway request for this turn, when it got that far. */
  requestId: string | null
  providerId: string | null
  model: string | null
  /** The terminal state, stated in the payload as well as implied by the type. */
  outcome: string
  reason: string | null
}

/** The payload each event type carries. */
export interface CoreEventPayloads {  'core.started': { version: string; storeKind: string; recoveredSequence: number }
  'core.ready': Record<string, never>
  'core.degraded': { reason: string }
  /**
   * A durable record that the journal was found corrupt.
   *
   * This is why a corrupt log stays failed closed. Recovery has to truncate the
   * damaged segment so the Core can still append, and truncating it would
   * otherwise leave a *clean* file that the next start would happily read as
   * healthy — with the STOP ALL that followed the damage already discarded.
   * Writing the fault into the trusted prefix makes it part of the journal, so
   * every subsequent start replays it and stays degraded until somebody acts.
   *
   * The damaged bytes are not thrown away: they are copied to a quarantine file
   * named here, so the evidence — including any event that came after the
   * damage — is still on disk to be read.
   */
  'core.integrity_fault': {
    reason: string
    /** The 1-indexed line where the damage was found. */
    line: number
    /** Where the original bytes were preserved. */
    quarantinePath: string
    /** Complete events that were read and believed, before the damage. */
    trustedPrefixEvents: number
    /** Bytes kept in the trusted prefix. */
    trustedPrefixBytes: number
    /** Bytes set aside as damaged. */
    damagedBytes: number
  }
  'core.stopping': { reason: string }
  'core.stopped': { durationMs: number }

  /**
   * The journal records that a command arrived, not what it said.
   *
   * An audit log is read by people, shipped in backups, and kept far longer
   * than a conversation. Whatever a user types belongs in conversation storage,
   * which has its own retention rules. The security journal needs only enough
   * to answer "did this happen, and was it this long".
   */
  'command.received': {
    commandId: string
    /** Characters in the submitted text. Metadata, not content. */
    contentLength: number
    /** Which surface submitted it, e.g. 'command-bar'. */
    source: string
  }

  'guard.decision': {
    outcome: 'allow' | 'deny' | 'approval_required'
    reason: string
    capability: string
    /** Never the token, never a secret: a claim, not a credential. */
    principal: PrincipalId
  }

  'security.stop_all.activated': { by: PrincipalId; reason: string }
  'security.stop_all.cleared': { by: PrincipalId }

  'cognition.requested': {
    requestId: string
    origin: CognitionOrigin
    cause: CognitionCause
    /** Metadata only. Prompts belong to future conversation storage. */
    maxOutputTokens: number
    requestedModel: string | null
    parentRunId: string | null
    goalId: string | null
  }
  // No provider is named here: authorization happens before one is chosen.
  'cognition.allowed': { requestId: string; grantId: string | null }
  'cognition.denied': { requestId: string; reason: string; grantId: string | null }
  'cognition.authorization_required': { requestId: string; reason: string }

  'cognition.grant.created': {
    grantId: string
    createdBy: PrincipalId
    expiresAt: string
    allowedOrigins: CognitionOrigin[]
    allowedCauses: CognitionCause[]
    goalId: string | null
    runId: string | null
    actor: PrincipalId | null
    backgroundAllowed: boolean
    maxCalls: number
    maxOutputTokens: number
  }
  'cognition.grant.revoked': { grantId: string; revokedBy: PrincipalId; reason: string }
  /**
   * The allowance taken out of the grant's budget, durably, *before* the provider
   * was called. Authorisation arithmetic, not usage: it moves whether or not the
   * call succeeds and whether or not the provider ever answers.
   *
   * Separate from the report below so that neither can overwrite the other. A
   * single event carrying both meant the report replaced the running total with
   * one call's figures.
   */
  'cognition.grant.reserved': {
    grantId: string
    requestId: string
    /** This call's share of the allowance. The reducer adds it to the total. */
    outputTokenBudgetReserved: number
  }
  /**
   * What the provider reported for one call. Nulls mean it reported nothing, or
   * only part of it — which the reducer records as an unknown rather than a zero.
   */
  'cognition.grant.usage_reported': {
    grantId: string
    requestId: string
    inputTokens: number | null
    outputTokens: number | null
  }

  'model.request.started': {
    requestId: string
    grantId: string | null
    providerId: string
    model: string
    maxOutputTokens: number
    /** When the gateway decided to contact a provider. Never a UI clock. */
    startedAt: string
  }
  'model.request.completed': {
    requestId: string
    providerId: string
    model: string
    inputTokens: number | null
    outputTokens: number | null
  }
  'model.request.failed': {
    requestId: string
    providerId: string
    reason: string
  }
  /**
   * A request the owner stopped, or that Core shut down with in flight.
   *
   * Not a failure, and the payload says why that is not a detail: a request
   * refused before the provider was contacted cost nothing, and one aborted
   * after it was reached was probably billed for the work it had already done.
   * Collapsing the two would report a cancelled request as either a free call or
   * a lost one, and both would be wrong.
   */
  'model.request.cancelled': {
    requestId: string
    providerId: string
    /** Why it was stopped, in words a person can act on. */
    reason: string
    /**
     * Whether the provider had already been asked. False means the call
     * happened and cost nothing; true means the figures stay a lower bound.
     */
    providerContacted: boolean
  }

  /* --------------------------------------------------------- conversation */

  'conversation.created': {
    conversationId: string
    /** Length of the derived title. The title's text is not here. */
    titleLength: number
  }

  /**
   * Shared shape for every conversation turn outcome.
   *
   * One shape rather than five, because the differences between them are
   * enumerated in `outcome` and keeping the rest identical is what makes the
   * events comparable in an audit without five field lists to keep in step.
   *
   * `contentLength` counts characters. It is the only measurement of anyone's
   * words that leaves Core, and it is what lets an operator see that a turn was
   * substantial without the journal becoming a transcript.
   */
  'conversation.turn.started': ConversationTurnEvent
  'conversation.turn.completed': ConversationTurnEvent
  'conversation.turn.cancelled': ConversationTurnEvent
  'conversation.turn.failed': ConversationTurnEvent
  'conversation.turn.denied': ConversationTurnEvent
  'conversation.turn.interrupted': ConversationTurnEvent

  /* --------------------------------------------------------------- voice */

  'voice.capture.started': {
    sessionId: string
    /** Chosen before any audio exists, so this is a format not a measurement. */
    format: string
    sampleRate: number
  }
  'voice.capture.completed': {
    sessionId: string
    /** Bytes of audio handled and then discarded. Never the audio itself. */
    byteLength: number
    durationMs: number
    /** Whether a local engine produced a transcript. Never implies a model call. */
    transcribed: boolean
    transcriptLength: number
  }
  'voice.capture.cancelled': {
    sessionId: string
    byteLength: number
    reason: string
  }

  /* --------------------------------------------------------------- brain */

  /** The identity root and self-definition were written, once. */
  'brain.seeded': {
    identityName: string
    identityClaimCount: number
    capabilityCount: number
    limitationCount: number
  }

  /**
   * A memory passed admission.
   *
   * `contentLength` is the only measurement of what was learned that leaves the
   * Brain, and it is measured for the same reason the conversation turn event
   * measures a message: so an operator can see that something substantial was
   * learned without the journal becoming a transcript of Freya's memory.
   */
  'brain.memory.admitted': {
    memoryId: string
    kind: string
    /** The trust class the trusted pathway assigned. Never the content's claim. */
    source: string
    confidence: string
    status: string
    /** How many stored records contradict this one. */
    conflictsWith: number
    contentLength: number
  }

  /**
   * A candidate was refused or deferred.
   *
   * The reason is recorded because a refusal somebody cannot examine is
   * indistinguishable from a refusal that was arbitrary. It states the *policy*
   * that decided, not the text that was refused.
   */
  'brain.memory.reviewed': {
    candidateId: string
    decision: 'rejected' | 'deferred'
    reason: string
  }

  /** A memory was withdrawn deliberately. Archived, never deleted. */
  'brain.memory.archived': { memoryId: string; reason: string }

  /** Something was noted. The name itself is not here, only its length. */
  'brain.world.entity_noted': {
    entityId: string
    entityType: string
    nameLength: number
    sourceType: string
  }

  /**
   * A relation was recorded.
   *
   * `conflictingRelations` above zero means the Brain now holds two current claims
   * that disagree. That is a fact about the Brain's honesty and it is exactly what
   * a reader of the journal needs to see — it is the difference between "Freya
   * learned this" and "Freya learned two contradictory things".
   */
  'brain.world.related': {
    subjectEntityId: string
    predicate: string
    conflictingRelations: number
  }

  /**
   * A source said something, kept as said.
   *
   * `statedLength` measures it; the statement stays in the Brain. An observation is
   * a record of a claim, not a claim, and promoting one is a separate decision that
   * produces a different event.
   */
  'brain.world.observed': {
    observationId: string
    sourceType: string
    statedLength: number
  }

  /**
   * What Freya attempted, as metadata.
   *
   * `providerContacted` is the field that matters for cost, and `conversationId` /
   * `turnId` point at the encrypted conversation that holds the actual words — the
   * Brain never duplicated them.
   */
  'brain.experience.recorded': {
    experienceId: string
    result: string
    modelsUsed: number
    providerContacted: boolean
    conversationId: string | null
    turnId: string | null
  }

  /**
   * The Brain's own integrity changed.
   *
   * A Brain-data fact, and emphatically **not** a security event. It is not in
   * `SECURITY_EVENT_TYPES`, and it must never be: a corrupt Brain cannot grant
   * cognition or clear a stop, and it does not lose authority either. Reporting it
   * in the security stream would let a disk error masquerade as a safety posture.
   */
  'brain.degraded': { reason: string }
  'life.entry.recorded': {
    entryId: string
    kind: string
    derivation: string
    confidence: string
    salience: string
    status: string
    revision: number
    sourceDomain: string
    sourceId: string | null
    occurredAtKnown: boolean
    titleLength: number
    summaryLength: number
    bodyLength: number
    referenceCount: number
    conflictCount: number
  }
  'life.entry.withdrawn': { entryId: string; revision: number; reason: string }
  'life.conflict.detected': { conflictId: string; entryA: string; entryB: string }
  'life.degraded': { reason: string }

  // Personality & Relationship. Metadata only, and the exact-key check in
  // `validate.ts` is what keeps it that way: a hand-edited line cannot smuggle a
  // recorded text, an owner's clause or a sentence into a payload whose schema has
  // no slot for one.
  'personality.record_changed': {
    operation: 'admitted' | 'rejected' | 'withdrawn' | 'retired' | 'superseded'
    itemId: string
    kind: 'fact' | 'preference' | 'habit' | 'catchphrase' | 'inside-joke'
    /** A code-owned slug. Never a sentence — `isSlug` is checked on recovery. */
    key: string
    sourceType:
      | 'owner-assertion'
      | 'system-observation'
      | 'experience-outcome'
      | 'freya-inference'
      | 'model-inference'
      | 'external-untrusted'
      | 'imported-document'
    confidence: 'unknown' | 'low' | 'medium' | 'high'
    lifecycleReason:
      | 'owner-withdrew-this-record'
      | 'owner-rejected-this-record'
      | 'superseded-by-a-newer-record'
      | 'retention-bound-reached'
      | null
    admitted: number
    retained: number
  }
  'personality.degraded': {
    reason: string
    mode: 'encrypted' | 'ephemeral'
    durable: false
  }

  /* ------------------------------------------------------------- research */

  /**
   * The one shape every research stage event uses.
   *
   * A single shape rather than several, because the fields that must never appear
   * are easier to guarantee for one type than for eight. Note what is absent: no
   * query, no URL, no domain, no snippet, no page text, no answer, no provider
   * diagnostic and no filesystem path. `failureCode` is a closed enum from
   * `ResearchErrorCode`, so a failure is reported as a code rather than as whatever
   * a provider chose to throw.
   */
  'research.search_started': ResearchStageEvent
  'research.search_completed': ResearchStageEvent
  'research.search_failed': ResearchStageEvent
  'research.read_started': ResearchStageEvent
  'research.read_completed': ResearchStageEvent
  'research.read_failed': ResearchStageEvent
  'research.started': ResearchStageEvent
  'research.progress': ResearchStageEvent
  'research.completed': ResearchStageEvent
  'research.failed': ResearchStageEvent
  'research.cancelled': ResearchStageEvent


  /* ----------------------------------------------------------------- work */

  /**
   * A Run was planned.
   *
   * `steps` names each step's id, key and the two registered things it depends on.
   * A capability *name* is safe here the way a Brain entity's *type* is safe: it is
   * a closed vocabulary this Core already holds. What the step was asked to do is
   * not, and never will be.
   */
  'work.run.created': {
    runId: string
    kind: string
    taskId: string | null
    /**
     * An opaque parent reference.
     *
     * Deliberately untyped: Phase 7 owns what a Mission is, and Work must not
     * grow a Mission-shaped field by accident. Two bounded tokens and nothing
     * more, so a later phase can attach without this schema changing shape.
     */
    parentKind: string | null
    parentId: string | null
    /** The ceilings this Run actually runs under, after clamping. */
    limits: {
      maxSteps: number
      maxActions: number
      maxDurationMs: number
      maxAttemptsPerStep: number
    }
    steps: readonly {
      stepId: string
      key: string
      capability: string
      verifier: string
    }[]
  }

  'work.run.started': { runId: string }
  'work.run.resumed': { runId: string; reason: string | null }
  'work.run.paused': { runId: string; reason: string }
  'work.run.waiting': { runId: string; reason: string }
  'work.run.awaiting_approval': { runId: string; reason: string }
  'work.run.completed': { runId: string; stepCount: number; verifiedCount: number }
  'work.run.failed': {
    runId: string
    reason: string
    stepCount: number
    verifiedCount: number
  }
  'work.run.cancelled': { runId: string; reason: string }
  'work.run.recovered': { runId: string; previousStatus: string; reason: string }

  'work.step.ready': { runId: string; stepId: string; stepKey: string }
  'work.step.started': {
    runId: string
    stepId: string
    stepKey: string
    index: number
    capability: string
    attempt: number
  }
  'work.step.verified': { runId: string; stepId: string; attempt: number }
  'work.step.failed': { runId: string; stepId: string; reason: string }
  'work.step.cancelled': { runId: string; stepId: string; reason: string }
  'work.step.skipped': { runId: string; stepId: string; reason: string }

  /**
   * A capability was actually attempted.
   *
   * The distinction the architecture insists on is right here: `work.step.started`
   * says work was *intended* and this says something was *tried*. `principal` is a
   * claim about who executed, assigned by Core and never taken from a payload.
   */
  'work.action.started': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    capability: string
    principal: PrincipalId
  }
  'work.action.completed': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    durationMs: number
  }
  /**
   * A failed action. Not a failed Step, and emphatically not a failed Run: the
   * step still holds its remaining attempts and each one gets its own events, so a
   * flapping capability's history stays visible rather than collapsing into one
   * error.
   */
  'work.action.failed': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    reason: string
    durationMs: number
  }
  'work.action.cancelled': {
    runId: string
    stepId: string
    actionId: string
    attempt: number
    reason: string
  }

  /**
   * Evidence was recorded.
   *
   * Both lengths, never the text. This is the whole reason a Work journal is safe
   * to keep in a backup: what a capability said stays in the process holding it.
   */
  'work.observation.recorded': {
    runId: string
    stepId: string
    actionId: string | null
    observationId: string
    kind: string
    summaryLength: number
    detailLength: number
  }

  /** Verification is requested on every attempt, including the ones that fail. */
  'work.verification.requested': {
    runId: string
    stepId: string
    verificationId: string
    verifier: string
  }
  'work.verification.completed': {
    runId: string
    stepId: string
    verificationId: string
    verdict: 'passed' | 'failed'
    reason: string
  }

  /**
   * Approval was requested, and the Run stopped.
   *
   * Enough to decide it and nothing that could be acted on: the capability that
   * asked, the Guard capability it needs, its risk class, why approval was
   * required, and one bounded sentence describing the effect. The step's *input*
   * is deliberately absent — describing the effect is the capability's job, and a
   * plan cannot rewrite what it is about to do by writing a flattering `proposal`.
   */
  'work.approval.requested': {
    approvalId: string
    runId: string
    stepId: string
    capability: string
    requiredCapability: string
    risk: 'none' | 'routine' | 'consequential'
    principal: PrincipalId
    justification: string
    proposal: string
  }
  'work.approval.approved': {
    approvalId: string
    runId: string
    stepId: string
    decidedBy: PrincipalId
    decisionSource: string
  }
  'work.approval.denied': {
    approvalId: string
    runId: string
    stepId: string
    decidedBy: PrincipalId
    decisionSource: string
    reason: string
  }
  'work.approval.cancelled': { approvalId: string; runId: string; stepId: string; reason: string }
  'work.approval.expired': { approvalId: string; runId: string; stepId: string; reason: string }

  /** The title is a measurement. As with an entity name, and for the same reason. */
  'work.task.created': { taskId: string; titleLength: number }
  'work.task.updated': { taskId: string; status: string }
  'work.task.attached': { taskId: string; runId: string }
  'work.task.completed': { taskId: string; status: string }

  'work.limits.exceeded': { runId: string; limit: string; reason: string; observed: number }

  /* --------------------------------------------------------------- mission */

  /**
   * A Mission exists.
   *
   * `deadlineAt` rather than a lifetime in milliseconds: the wall-clock bound is
   * resolved once, at creation, so every later reader agrees about when the Mission
   * expires without re-deriving it and without a timer watching it.
   */
  'mission.created': {
    missionId: string
    status: 'draft'
    createdAt: string
    deadlineAt: string
    limits: MissionLimitsPayload
  }

  /**
   * A lifecycle transition.
   *
   * `from` is in the payload as well as implied by the previous event, so the
   * reducer can refuse a transition whose history does not agree with itself. A
   * hand-edited line claiming `draft → completed` is refused rather than folded,
   * which is what stops a replayed journal manufacturing a completed Mission with
   * no verification behind it.
   */
  'mission.activated': MissionTransitionPayload
  'mission.paused': MissionTransitionPayload
  'mission.resumed': MissionTransitionPayload
  'mission.cancelled': MissionTransitionPayload
  'mission.failed': MissionTransitionPayload
  'mission.completed': MissionTransitionPayload

  /** A child Run was attached. Ids only. */
  'mission.run.attached': {
    missionId: string
    runId: string
    taskId: string | null
  }

  /**
   * Completion verification was requested.
   *
   * `runIds` names what this request required. No evidence, no expectation text,
   * no verifier internals.
   */
  'mission.verification.requested': {
    missionId: string
    verifierId: string
    runIds: string[]
  }

  /**
   * Verification answered.
   *
   * `outcome` and `reason` are both closed codes. A verifier's message and its
   * evidence are both deliberately absent: a verifier is the component most likely
   * to hold something private, and this is the boundary it cannot cross.
   */
  'mission.verification.completed': {
    missionId: string
    verifierId: string
    outcome: 'passed' | 'not_established' | 'timeout' | 'cancelled'
    reason: string | null
  }

  /** A code-owned ceiling stopped a child Run. Durable, so a restart cannot hide it. */
  'mission.limit.exceeded': {
    missionId: string
    limit: 'maxChildRuns' | 'maxConcurrentChildRuns' | 'lifetimeMs'
  }

  /* ------------------------------------------------------------- workforce */

  /**
   * A subordinate agent exists.
   *
   * `name` is Core's label for its own agent and is the only string in this family.
   * `budget` is frozen here rather than read from configuration later, so the numbers
   * a worker was governed by survive a restart and cannot drift underneath it — the
   * argument `MissionRecord.limits` makes, for the same reason.
   *
   * `status` is fixed to `idle` on creation. A worker is not born working: `working`
   * follows from holding an open assignment and nothing else.
   */
  'workforce.worker.created': {
    workerId: string
    name: string
    specialisation: string
    status: 'idle'
    createdAt: string
    budget: WorkforceBudgetPayload
  }

  /**
   * A worker changed status.
   *
   * `from` is in the payload as well as implied by the previous event, so the reducer
   * can refuse a transition whose history disagrees with itself. A hand-edited line
   * claiming `retired → working` is refused rather than folded.
   */
  'workforce.worker.transitioned': {
    workerId: string
    from: string
    to: string
    /** Closed code. Never a message, never a worker's words. */
    reason: string | null
  }

  /**
   * A worker was reconciled after a restart.
   *
   * `previousStatus` is carried rather than read back from state, for Work's reason:
   * after a restart "what this worker was doing" is precisely the thing that is no
   * longer knowable. The fact that it had to be reconciled is the point — the journal
   * records that history was not proof of execution.
   */
  'workforce.worker.reconciled': {
    workerId: string
    previousStatus: string
    reason: string
  }

  /**
   * Core assigned one capability to one worker.
   *
   * The validator checks this name against the **closed worker vocabulary**, not
   * against the full `Capability` list. A forged line naming `work.execute` or
   * `mission.manage` is refused by the durable schema and again by the fold, so the
   * only place a worker's authority can exist is a line this code wrote.
   */
  'workforce.capability.assigned': {
    workerId: string
    capability: string
  }

  /** A context reference id was assigned. The id, never the context behind it. */
  'workforce.context.assigned': {
    workerId: string
    contextRef: string
  }

  'workforce.team.created': {
    teamId: string
    name: string
    /** A team may have no specialisation. Null means unconstrained, not unknown. */
    specialisation: string | null
    status: 'active'
    createdAt: string
  }

  'workforce.team.transitioned': {
    teamId: string
    from: string
    to: string
    reason: string | null
  }

  /**
   * Membership changed.
   *
   * `present` rather than separate added/removed events: one field, so a replay cannot
   * read an "add" as a "remove" or vice versa, and the reducer treats a redelivery of
   * either as a no-op instead of doubling a membership.
   */
  'workforce.team.member.changed': {
    teamId: string
    workerId: string
    present: boolean
  }

  /**
   * A worker was handed bounded work.
   *
   * `capabilities` is the scope of this assignment and is validated as a subset of the
   * closed worker vocabulary. `contextRefs` are ids. `missionId` is an id, and is
   * attached by Core rather than asserted by whoever asked for the work.
   */
  'workforce.assignment.created': {
    assignmentId: string
    workerId: string
    status: 'open'
    createdAt: string
    /** The absolute deadline derived from `maxAssignmentMs` at creation. */
    deadlineAt: string
    budget: WorkforceBudgetPayload
    missionId: string | null
    capabilities: string[]
    contextRefs: string[]
  }

  /**
   * An assignment settled.
   *
   * `from` is in the payload for the same reason as the worker transition: a journal
   * that cannot say which edge it took cannot be audited. `reason` is a closed code.
   */
  'workforce.assignment.settled': {
    assignmentId: string
    from: string
    to: string
    reason: string | null
  }

  /**
   * A worker asked for something it cannot have, and was refused.
   *
   * `decision` has exactly one legal value. That is the structural version of "agent
   * permission claims are data, never authority": there is no spelling of this event
   * that records a claim being honoured, so there is nothing for a forged line to say.
   */
  'workforce.claim.recorded': {
    claimId: string
    workerId: string
    /** `capability` or `context`. A claim about *what*, not a grant. */
    kind: string
    /** A capability name or a context id. Never the context itself. */
    subject: string
    decision: 'refused'
    /** A closed refusal code. */
    refusal: string
  }

  /**
   * An agent sent a message.
   *
   * `fromWorkerId` is assigned by Core from the scope that sent it and is never read
   * from a payload — that is the whole of attributability. `bodyLength` is a
   * measurement, exactly like a conversation turn's `contentLength`: enough for an
   * operator to see a substantial message happened, and not one character of it.
   */
  'workforce.message.sent': {
    messageId: string
    fromWorkerId: string
    toWorkerId: string
    kind: string
    bodyLength: number
    /** A routing fact. Not authority, and not a permission to say anything. */
    sameTeam: boolean
  }

  /**
   * A worker was authorised to think, and this is what it reserved.
   *
   * Both fields are nullable-or-count for the reason `ModelUsage` documents: an
   * unaccounted call must not read as a free one. `calls: 0` with a token figure is
   * expressible on purpose — it is how a call whose *count* is in doubt is recorded
   * without either field lying.
   */
  'workforce.cognition.recorded': {
    workerId: string
    calls: number
    outputTokens: number | null
  }

  /** A code-owned ceiling was reached. Durable, so a restart cannot hide one. */
  'workforce.limit.exceeded': {
    workerId: string
    limit: string
  }

  /* ------------------------------------------------------------- attention */

  /**
   * An authorized source delivered an event.
   *
   * `dedupeKey` is the stable key replay uses: derived from the source's own
   * `sourceRef` when it has one, so a re-delivered event is recognised across a
   * restart. `textLength` is a measurement — the text is not here and never will
   * be. `source` is assigned by Core and is not a value a payload can supply.
   */
  'attention.event.ingested': {
    eventId: string
    dedupeKey: string
    source: AttentionSource
    kind: AttentionEventKind
    goalRef: string | null
    textLength: number
    severityHint: SeverityHint
    occurredAt: string
    dueAt: string | null
  }

  /**
   * Core reached a decision about one event.
   *
   * Every field is a closed label. `do-nothing` is written here like any other
   * outcome, because a decision not to act is a decision and a journal that only
   * recorded the loud ones would misrepresent how often Freya stays quiet.
   */
  'attention.decision.made': {
    decisionId: string
    eventId: string
    source: AttentionSource
    kind: AttentionEventKind
    goalRef: string | null
    outcome: AttentionOutcome
    importance: ImportanceLevel
    urgency: UrgencyLevel
    reason: AttentionReason
    cueCode: AttentionCueCode | null
    focus: FocusState
  }

  /** A code-owned ceiling demoted an outcome. Recorded so a restart cannot hide it. */
  'attention.budget.exceeded': {
    source: AttentionSource
    goalRef: string | null
    limit: string
    observed: number
  }

  /**
   * A schedule was registered.
   *
   * Metadata only, like everything else here. The schedule's text is process-local;
   * a schedule recovered from the journal after a restart therefore cannot fire and
   * is cancelled with a stated reason instead.
   */
  'attention.schedule.registered': {
    scheduleId: string
    kind: AttentionEventKind
    goalRef: string | null
    severityHint: SeverityHint
    dueAt: string
    intervalMs: number | null
    maxRepeats: number
    condition: AttentionCondition
  }

  /** A due schedule fired. One event, one fact; the resulting ingest follows. */
  'attention.schedule.fired': {
    scheduleId: string
    eventId: string
    repeats: number
  }

  'attention.schedule.cancelled': {
    scheduleId: string
    reason: string
  }

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

  /* ---------------------------------------------------------------- skills */

  /**
   * A skill was admitted, or a version was revised.
   *
   * One shape for both, because the fields that matter are the same: which skill, at
   * which version, whose act created it, from what source, at what trust class, and
   * how big its body is. `version` is 1 for an admission and always exactly one more
   * than the record it replaces for a revision ??? which the fold checks, so a
   * hand-edited "revision" that does not advance the version is refused rather than
   * folded.
   *
   * `contentHash` is here so a revision can be shown to be a change and an
   * identical-revision can be refused without holding either body.
   */
  'skill.admitted': SkillVersionEvent
  'skill.revised': SkillVersionEvent

  /**
   * A lifecycle transition.
   *
   * `from` is in the payload as well as implied by the previous event, so the fold can
   * refuse a transition whose history does not agree with itself. A hand-edited line
   * claiming `candidate ??? promoted` passes every field check ??? both names are in the
   * closed table ??? and is refused by `reduceSkillState`, which is the second of two
   * independent refusals.
   *
   * `evidence` is present for transitions that were gated and absent otherwise. It is
   * four integers and never a verdict a caller supplied: promotion reads the fold's own
   * evaluations and echoes the counts it found.
   */
  'skill.transitioned': {
    skillId: string
    from: SkillStatus
    to: SkillStatus
    /** A closed code from `PROMOTION_REASONS`. */
    reason: string
    evidence: {
      version: number
      established: number
      contradicted: number
      distinctSubjects: number
    } | null
  }

  /**
   * A skill was retired or blocked.
   *
   * Its own event family rather than a `skill.transitioned` with `to: 'retired'`,
   * because retirement is the one transition that needs its reason audited separately:
   * "this was retired because it was unsafe" and "this was retired because it was
   * superseded" are different facts about Freya's honesty.
   */
  'skill.retired': {
    skillId: string
    version: number
    to: 'retired' | 'blocked'
    reason: SkillRetirementReason
  }

  /**
   * An evaluation was recorded.
   *
   * `verdict` and `reason` are Core's own closed codes, computed by `evaluateOutcome`
   * from deterministic evidence. `commentaryChars` is a **count of model characters**,
   * stored next to the verdict precisely so an auditor can see that four thousand
   * characters of opinion moved nothing. `version` is written from the record rather
   * than from the payload, which is what makes stale-evidence reuse impossible.
   */
  'skill.evaluation.recorded': {
    evaluationId: string
    skillId: string
    version: number
    subjectKind: EvaluationSubjectKind
    subjectRef: string
    author: EvaluationAuthor
    verdict: SkillVerdict
    reason: EvaluationReason
    deterministicCount: number
    positiveCount: number
    negativeCount: number
    commentaryChars: number
  }

  /** A skill was planned into an existing Run and Step. Ids and a count. */
  'skill.execution.planned': {
    skillId: string
    version: number
    runId: string
    stepId: string
    stepCount: number
  }

  /**
   * An improvement was proposed.
   *
   * `target` is one of the three ordinary things improvement may touch, and
   * `targetRef` has already been checked against the closed protected-domain list ???
   * so a proposal naming the Constitution or a source file never becomes a line in
   * this journal. `basisEvaluationIds` are ids Core derived itself; a caller cannot
   * choose which evidence a proposal rests on.
   */
  'skill.improvement.proposed': {
    proposalId: string
    target: ImprovementTarget
    targetRef: string
    skillId: string | null
    baseVersion: number | null
    summaryLength: number
    basisEvaluationIds: string[]
    proposedBy: EvaluationAuthor
    /** How many proposals were already open, for the bound's audit trail. */
    openProposalsAt: number
  }

  /** A proposal was accepted or refused. `reason` is a closed refusal code. */
  'skill.improvement.settled': {
    proposalId: string
    decision: 'accepted' | 'refused'
    reason: SkillRefusalReason
  }

  /** An admission or improvement attempt was refused. A code and a bounded ref only. */
  'skill.proposal.rejected': {
    attemptId: string
    code: SkillRefusalCode | string
    targetRef: string | null
  }

  /**
   * An artifact could not enter runtime.
   *
   * One legal outcome, named for what it is. A body that had an `accepted` field, or a
   * sibling event for success, would be a place a self-rewriting runtime could be
   * recorded as having happened ??? and that is the claim Phase 17 must never make
   * possible to write down.
   */
  'skill.runtime.promotion.refused': {
    artifactId: string
    targetRef: string
    reason: SkillRefusalReason
  }


  /* ------------------------------------------------------------- foundry */

  'foundry.artifact.created': {
    artifactId: string
    hash: string
    kind: string
    runId: string
    stepId: string
    createdBy: PrincipalId
    parentHash: string | null
    specHash: string | null
    contentLength: number
  }

  'foundry.artifact.transitioned': {
    artifactId: string
    toStatus: string
  }

  'foundry.verification.recorded': {
    verificationId: string
    artifactHash: string
    verifierName: string
    verdict: 'passed' | 'failed' | 'inconclusive'
    evidenceHash: string
    evidenceLength: number
    verifiedAt: string
    requestedBy: PrincipalId
  }

  'foundry.promotion.recorded': {
    promotionId: string
    artifactHash: string
    fromStatus: string
    toStatus: string
    promotedBy: PrincipalId
    promotedAt: string
    reason: string
    verificationId: string
  }

  'foundry.activation.recorded': {
    activationId: string
    artifactHash: string
    fromStatus: string
    toStatus: string
    activatedBy: PrincipalId
    activatedAt: string
    reason: string
    expiresAt: string | null
  }

  'foundry.tool.registered': {
    toolId: string
    hash: string
    name: string
    capability: string
    createdBy: PrincipalId
    artifactHash: string
  }

  'foundry.tool.transitioned': {
    toolId: string
    toStatus: string
  }

  'foundry.module.registered': {
    moduleId: string
    hash: string
    name: string
    createdBy: PrincipalId
    artifactHash: string
  }

  'foundry.module.transitioned': {
    moduleId: string
    toStatus: string
  }

  'foundry.app.registered': {
    appId: string
    hash: string
    name: string
    createdBy: PrincipalId
    artifactHash: string
    moduleHashes: string[]
  }

  'foundry.app.transitioned': {
    appId: string
    toStatus: string
  }

  'foundry.limit.exceeded': {
    limit: string
    reason: string
  }

  'office.presence.requested': {
    workerId: string
  }

  'office.presence.fulfilled': {
    workerId: string
  }

  /* ----------------------------------------------------------------- relay */

  'relay.action.requested': {
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    risk: RelayRiskClass
    idempotencyKey: string
    summary: string
  }

  'relay.approval.requested': {
    approvalId: string
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    risk: RelayRiskClass
    summary: string
  }

  'relay.approval.decided': {
    approvalId: string
    actionId: string
    decision: 'approved' | 'denied'
    decidedBy: PrincipalId
  }

  'relay.approval.expired': {
    approvalId: string
    actionId: string
  }

  'relay.action.executed': {
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    outcome: 'read' | 'write'
    resultKind: string
    retries: number
  }

  'relay.action.failed': {
    actionId: string
    connector: RelayConnectorId
    action: RelayAction
    failureCode: RelayFailureCode
    retries: number
  }

  'relay.action.cancelled': {
    actionId: string
    failureCode: RelayFailureCode
  }

  'relay.connector.faulted': {
    connector: RelayConnectorId
    reason: string
  }

  'relay.limits.exceeded': {
    connector: RelayConnectorId
    action: RelayAction
    limit: string
    observed: number
  }
}

/**
 * A worker's durable budgets, as they appear in an event.
 *
 * Re-validated against the code-owned ceilings on read, for Mission's reason: a
 * hand-edited `maxCognitionTokens: 1000000` must not become a real budget, because then
 * the only limit would exist on disk.
 */
export interface WorkforceBudgetPayload {
  maxAssignments: number
  maxOpenAssignments: number
  maxAssignmentMs: number
  maxCognitionCalls: number
  maxCognitionTokens: number
  maxMessages: number
}

/** Ceilings as they appear in a durable event. Re-validated against code on read. */
export interface MissionLimitsPayload {
  maxChildRuns: number
  maxConcurrentChildRuns: number
  lifetimeMs: number
  verificationDeadlineMs: number
  maxRetainedMissions: number
  maxTitleChars: number
  maxIntentChars: number
  maxSuccessCriteria: number
  maxCriterionChars: number
}

export interface MissionTransitionPayload {
  missionId: string
  from: string
  to: string
  reason: string | null
  /** Present on completion only: which verifier established it. An id. */
  verifierId: string | null
}

/**
 * The closed refusal-code union, plus the one literal a settled acceptance carries.
 *
 * `SkillRefusalReason` exists because `skill.improvement.settled` has to be able to
 * say `accepted` on the line that records an acceptance, and the alternative ??? a free
 * string ??? would let that field carry anything. Widening the union by one literal
 * keeps the closed-set property while letting the accepted case be stated plainly.
 */
export type SkillRefusalReason = SkillRefusalCode | 'accepted'

/**
 * One admitted or revised skill version, as it appears in the journal.
 *
 * Every field is an id, a closed label, an integer, an instant or a measured length ???
 * with two bounded slugs. The reason both are allowed: identity is *derived* from the
 * name, so a fold that could not read the name could not detect a second skill with
 * the same identity, and selection matches on the applicability tags, so a fold that
 * could not read them could not rank anything. Neither is prose, both are
 * control-stripped on the way in and re-checked on replay, and neither could hold a
 * sentence.
 */
export interface SkillVersionEvent {
  skillId: string
  /** A normalised slug, `[a-z0-9][a-z0-9-]*`. The identity key. */
  name: string
  nameLength: number
  kind: SkillKind
  version: number
  contentHash: string
  source: SkillSource
  trustClass: SkillTrustClass
  admittedBy: string
  originRef: string | null
  stepCount: number
  requiredCapabilityCount: number
  applicabilityCount: number
  /** Bounded slugs. Declared applicability, and the only thing selection matches on. */
  applicability: string[]
  inputCount: number
  outputCount: number
  preconditionCount: number
  postconditionCount: number
  summaryLength: number
}

/**
 * Counters reported on a research event.
 *
 * Every field is an integer this subsystem counted itself. They are named rather
 * than bundled so a reader can see which budget moved, and they are integers rather
 * than a duration string so a validator can reject a substituted sentence.
 */
export interface ResearchStageCounters {
  iterations: number
  queries: number
  results: number
  pages: number
  evidenceChars: number
  modelTurns: number
  failures: number
  durationMs: number
}

export interface ResearchStageEvent {
  /** The operation id Core issued. An id, never content. */
  operationId: string
  /** The managed browser session, when the stage had one. */
  sessionId: string | null
  /** A closed enum. A renderer or provider cannot invent a stage name. */
  stage: string
  counters: ResearchStageCounters
  /** Null unless the stage failed. Always a code, never a message. */
  failureCode: string | null
}

/**
 * Every Core event, as a discriminated union.
 *
 * The mapping matters: it is what lets `Extract<Event, { type: T }>['payload']`
 * resolve to the payload of one specific event type rather than to a union of
 * every payload in the system.
 */
export type AnyCoreEvent = {
  [K in CoreEventType]: CoreEventEnvelope<K>
}[CoreEventType]

/**
 * Events that change durable security or governance state.
 *
 * ## No `work.*` event is in this list, and none may be
 *
 * The test is the same one that keeps `brain.degraded` out, and it is worth
 * restating because Work is the subsystem where it is most tempting to add one.
 * These events describe Freya *doing work*: what was planned, what was attempted,
 * what came back, whether it verified, and what a person decided about it.
 *
 * A Work fault or a Work success can neither grant cognition nor clear a stop. A
 * run that reached `completed` says nothing about whether Freya may think next,
 * and an execution ceiling that was hit says nothing about the authority to reach
 * it. Putting these in the security stream would let an ordinary work failure
 * masquerade as a safety posture, and let a real safety problem look like a
 * failing step.
 *
 * The genuinely security-relevant part of Work is already recorded in the events
 * that *are* in this list: `guard.decision` is written every time Guard refuses a
 * capability, and `work.action.started` names the principal whose capabilities were
 * evaluated. Approval decisions belong to Work's own stream because an approval
 * gates one capability execution; it does not alter what Freya is allowed to think,
 * which is what `cognition.grant.*` and `security.stop_all.*` are for.
 */
export const SECURITY_EVENT_TYPES: readonly CoreEventType[] = [
  'guard.decision',
  'security.stop_all.activated',
  'security.stop_all.cleared',
  'cognition.grant.created',
  'cognition.grant.revoked',
  'cognition.grant.reserved',
  'cognition.grant.usage_reported',
]

export function isSecurityEvent(type: CoreEventType): boolean {
  return SECURITY_EVENT_TYPES.includes(type)
}
