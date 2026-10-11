import type { CoreEventType } from '../../shared/contracts/events/names'
export { CORE_EVENT_SCHEMA_VERSION, CORE_EVENT_TYPES } from '../../shared/contracts/events/names'
export type { CoreEventType } from '../../shared/contracts/events/names'

import type { CognitionCause, CognitionOrigin } from '../../shared/contracts/security'
import type { PrincipalId } from '../../shared/contracts/identity'
import type { Capability } from '../../shared/contracts/capabilities'
import type {
  ForgeAccessLevel,
  ForgeOrigin,
  ForgeRefusalCode,
  ForgeRunFailureCode,
  ForgeRunState,
  ForgeRuntimeKind,
  ForgeStageVerdict,
  ForgeValidationStage,
} from '../forge/types'
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
import type { ConnectorFailureCode, ConnectorKind } from '../connectors/types'
import type { RuntimeStatus } from '../runtime/types'



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
  /**
   * A code-owned repair of one fully recognised historical journal defect.
   * The original and the degraded replacement are both preserved on disk.
   */
  'core.integrity_repaired': {
    code: 'legacy-tool-loop-request-id' | 'voice-wake-threshold-validator' | 'interrupted-conversation-id-recovery'
    repairedEvents: number
    sourceQuarantinePath: string
    archivedDegradedPath: string | null
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
  'conversation.archived': {
    conversationId: string
    /** Length only; closing a chat never copies its title into the audit journal. */
    titleLength: number
  }
  'conversation.renamed': {
    conversationId: string
    /** Title text remains exclusively in the encrypted conversation store. */
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
    channels: number
    /**
     * How this session opened.
     *
     * `explicit` means a person pressed something. `wake` means a local
     * speech-activity gate asked — which is recorded separately precisely so an
     * operator can tell a hands-free capture from a deliberate one without the
     * audio either way.
     */
    activation: 'explicit' | 'wake'
  }
  'voice.capture.completed': {
    sessionId: string
    /** Bytes of audio handled and then discarded. Never the audio itself. */
    byteLength: number
    durationMs: number
    /** Sample frames. A second ceiling, because metadata is attacker-controlled. */
    frames: number
    /** Whether an engine produced a transcript. Never implies a model call. */
    transcribed: boolean
    transcriptLength: number
    /** How many times the engine revised its guess. A count, never the guesses. */
    interimFragments: number
  }
  'voice.capture.cancelled': {
    sessionId: string
    byteLength: number
    durationMs: number
    reason: string
  }
  'voice.transcribe.started': {
    sessionId: string
    /** A named engine, or a stand-in that names itself as one. Never a credential. */
    engine: string
    /** Where the engine runs: this machine, the OS, or a configured provider. */
    kind: string
    frames: number
  }
  'voice.transcribe.completed': {
    sessionId: string
    engine: string
    transcriptLength: number
    interimFragments: number
  }
  'voice.transcribe.failed': {
    sessionId: string
    engine: string
    /** A closed vocabulary of *causes*, never an engine's error text. */
    reason: 'timeout' | 'unconfigured' | 'engine-failed'
  }
  /**
   * A confirmed transcript entered the canonical conversation path.
   *
   * `turnId` is the reference that makes this auditable without being a
   * transcript: an operator can follow it to the turn event and see what the
   * Mind, the Governor and the provider each did. The words themselves live in
   * the encrypted conversation store and are not here.
   */
  'voice.submitted': {
    sessionId: string
    turnId: string
    outcome: string
    transcriptLength: number
  }
  'voice.speech.started': {
    utteranceId: string
    /** Which stored turn is being read. Freya never says anything she did not write. */
    turnId: string
    characters: number
    voice: 'default' | 'selected'
    queued: number
  }
  'voice.speech.stopped': { utteranceId: string; turnId: string; completed: boolean }
  'voice.speech.interrupted': { utteranceId: string; turnId: string; reason: string }
  'voice.permission.changed': {
    /** Which capability the owner was asked about. One category today. */
    category: 'microphone'
    outcome: 'granted' | 'denied' | 'revoked'
    source: 'idle' | 'capturing'
  }
  'voice.wake.armed': { gate: string; threshold: number; maxArmedMs: number }
  'voice.wake.fired': { gate: string; sustainedMs: number }
  'voice.wake.disarmed': { gate: string; reason: string }
  /** STOP ALL reached the voice subsystem. The only `scope` is `all`, today. */
  'voice.stopped': { scope: 'all'; reason: string }

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

  /**
   * The owner changed what Freya keeps in view.
   *
   * Metadata only, and the shape is the defence: `reasonLength` rather than
   * `reason`, because the journal is audit surface that gets read, copied and
   * backed up far more freely than the Brain itself, and an owner's explanation of
   * why they pinned something is exactly the kind of private aside that has no
   * business in it. The words stay in the encrypted record; only the fact, the
   * target and the size of the explanation are journalled.
   */
  'brain.memory.ownership_set': { memoryId: string; pinned: boolean; reasonLength: number }

  /**
   * The owner corrected a memory.
   *
   * `corrects` names the superseded record rather than replacing it. A correction
   * that erased its target would be indistinguishable, from the outside, from a
   * memory quietly changing its own mind — so both ids are here, and the old one
   * stays readable in the Brain.
   */
  'brain.memory.corrected': { memoryId: string; corrects: string; source: string }

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
  'mission.content.updated': { missionId: string }
  'mission.deleted': { missionId: string }
  'mission.created': {
    missionId: string
    status: 'draft'
    createdAt: string
    deadlineAt: string
    limits: MissionLimitsPayload
    /**
     * Phase 47. Optional on the wire so a journal written by an earlier build still
     * validates; absent means the code-owned ceiling, which is the *same* bound a new
     * Mission would be allowed — so reading an old journal cannot grant more than
     * creating a new one.
     */
    budget?: MissionBudgetPayload
    priority?: string
    /**
     * The two numbers about the goal. Both are counts, which is why they may be here:
     * progress has to be computable, and refusing to store them would force the
     * projection to invent a percentage instead.
     */
    requestedQuantity?: number | null
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

  /* ------------------------------------------ mission autonomy (Phase 47) */

  /** Any lifecycle edge the six named events do not name. */
  'mission.transitioned': MissionTransitionPayload

  /** A bounded plan, committed whole or not at all. */
  'mission.plan.committed': {
    missionId: string
    planId: string
    revision: number
    supersedes: string | null
    reason: string | null
    steps: readonly MissionStepPayload[]
  }

  /** One step changed status. `from` is carried so the fold can refuse a liar. */
  'mission.step.transitioned': {
    missionId: string
    planId: string
    stepId: string
    from: string
    to: string
    workerId: string | null
    runId: string | null
    attempts: number
    reason: string | null
  }

  /**
   * An action was in flight when the process stopped.
   *
   * `consequential` is recorded so a restart knows the external effect is unknown
   * rather than merely unfinished — the difference between "retry" and "ask".
   */
  'mission.step.interrupted': {
    missionId: string
    planId: string
    stepId: string
    consequential: boolean
  }

  /**
   * Evidence.
   *
   * `summaryLength` is a measurement, the same argument as `work.task.created`'s
   * `titleLength`. There is no `summary` field, so no spelling of this payload
   * carries content.
   */
  'mission.evidence.recorded': {
    missionId: string
    evidenceId: string
    stepId: string | null
    kind: 'result' | 'observation' | 'report' | 'refusal'
    origin: 'observed' | 'reported'
    summaryLength: number
    expiresAt: string | null
  }

  'mission.blocker.changed': {
    missionId: string
    code: string
    stepId: string | null
    raised: boolean
  }

  /**
   * A Mission step asked Work for a gate, and Work opened one.
   *
   * There is no `mission.approval.decided` or `mission.approval.expired`, and their
   * absence is the design. A person answers an approval exactly once, on Work's surface,
   * through `work.approval.decide`, which evaluates `work.approval.decide` on the owner
   * and is the only path in the codebase where an approval becomes `approved`. A Mission
   * event that could record a decision would be a second door, and it would be one
   * nothing enforces.
   *
   * So this event says only **"this Mission is now waiting on that Work approval"**, and
   * `approvalId` is Work's own id — the same one `work.approval.requested` carries. The
   * Mission holds a pointer to a gate it does not own; the gate's outcome is read back
   * from Work, never written here.
   *
   * `source` is `requested` when the Mission's plan asked for the gate up front and
   * `observed` when Work's Guard demanded one the plan did not anticipate. That
   * distinction matters to a person reading the feed: a gate nobody predicted is a fact
   * about the capability, not about the goal.
   */
  'mission.approval.requested': {
    missionId: string
    stepId: string
    approvalId: string
    source: 'requested' | 'observed'
    /** Work's own open instant, copied from `work.approval.requested`. Not a new clock. */
    requestedAt: string
  }

  /**
   * The next wake.
   *
   * `dueAt` is required for every kind, including an event wake. A wake with no end is
   * the open-ended wait this subsystem must not be able to record.
   */
  'mission.wake.scheduled': {
    missionId: string
    wakeId: string
    kind: 'event' | 'time' | 'manual'
    source: 'fabric' | 'time' | 'owner'
    dueAt: string
    eventType: string | null
  }

  'mission.wake.fired': {
    missionId: string
    wakeId: string
  }

  /**
   * What to do next.
   *
   * `nextWakeAt` is required exactly when `decision` is `wait` and forbidden
   * otherwise, and both halves are checked in the validator and again in the fold.
   */
  'mission.continuation.decided': {
    missionId: string
    decision: string
    reason: string
    stepId: string | null
    nextWakeAt: string | null
  }

  /** Consumption. Five counts, all non-negative, never a total a caller may supply. */
  'mission.budget.spent': {
    missionId: string
    modelCalls: number
    actions: number
    externalRequests: number
    retries: number
    delegations: number
  }

  'mission.budget.exceeded': {
    missionId: string
    budget: string
  }

  /**
   * An applied correction.
   *
   * Field *names*, counts, and ids. The most this can say is "the location changed",
   * and the new location is private and lives in the encrypted intent store.
   *
   * `requestedQuantity` is the single exception, and it exists because it is the one
   * intent field the journal has always been allowed to hold — `mission.created`
   * carries it too — so leaving it out here would make a corrected quantity survive in
   * memory and revert on the next restart. It is bound to `changedFields` containing
   * `'quantity'` by the validator, so it cannot ride along on a correction that did not
   * change the quantity, and it is a count: it says how many, never of what.
   */
  'mission.intent.corrected': {
    missionId: string
    correctionId: string
    kind: 'patch'
    changedFields: readonly string[]
    settledSteps: number
    preservedEvidence: number
    replannedFrom: string | null
    requestedQuantity?: number | null
  }

  /**
   * An ambiguous correction.
   *
   * There is no `kind` here, and that asymmetry is the design: a recorded ambiguity
   * has exactly one meaning, so it cannot also mean "applied".
   */
  'mission.correction.ambiguous': {
    missionId: string
    correctionId: string
    ambiguity: string
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
    maxRepeats: number | null
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

  /* ------------------------------------------------------ economic intelligence */

  /**
   * An experiment was defined.
   *
   * `criteria` is the one field in this whole family wide enough to be worth explaining:
   * a bounded, ` | `-joined list of slugs, capped by `ECONIC_LIMITS`, which is what lets
   * a completion criterion be a *claim key* rather than a sentence. Nothing else in
   * Phase 32 is allowed to be prose, and this is a list of keys.
   */
  'economic.experiment.created': {
    experimentId: string
    kind: string
    state: string
    title: string
    question: string
    criteria: string
    criteriaCount: number
    progress: number
    deadlineAt: string
    createdAt: string
    updatedAt: string
  }

  /**
   * The experiment moved one bounded stage.
   *
   * `from` and `to` are both recorded **and** both checked by the fold against the state
   * machine's own answer, so an entry claiming an impossible move is refused rather than
   * believed. Recording them anyway is what makes that check possible — and it means the
   * journal cannot rewind a stage by asserting it used to be elsewhere.
   */
  'economic.experiment.state-changed': {
    experimentId: string
    from: string
    to: string
    signal: string
    progress: number
    reasoning: string
    updatedAt: string
  }

  /** Terminal success. Carries no conclusion — the criteria are re-derived from evidence. */
  'economic.experiment.completed': {
    experimentId: string
    from: string
    progress: number
    criteriaMet: number
    completedAt: string
  }

  /**
   * Terminal failure, with a closed code.
   *
   * Also the event a **cancellation** is journalled as, because the stage machine tracks
   * progress and a cancelled experiment has none. The distinction the owner cares about —
   * finished, failed, or stopped looking — lives in the experiment's lifecycle state,
   * which has three separate terminal values.
   */
  'economic.experiment.failed': {
    experimentId: string
    from: string
    code: string
    updatedAt: string
  }

  'economic.experiment.cancelled': {
    experimentId: string
    from: string
    reason: string
    updatedAt: string
  }

  /**
   * One piece of evidence about one claim.
   *
   * `state` and `confidence` are recorded but **not trusted**: the fold re-derives both
   * from `observedAt` and the set of source references on every read, because freshness
   * is a function of the clock and a journalled "fresh" would stop being fresh.
   */
  'economic.evidence.gathered': {
    evidenceId: string
    experimentId: string
    source: string
    sourceRef: string
    citation: string
    claim: string
    observedAt: string
    state: string
    confidence: string
  }

  /** A scenario started. Counts, never parameters or a series. */
  'economic.simulation.started': {
    scenarioId: string
    experimentId: string
    strategy: string
    parameterCount: number
    assumptionCount: number
    observationCount: number
    startedAt: string
  }

  /**
   * A scenario finished.
   *
   * **No metrics.** A metric carries a name, a value, a denominator and a unit, and
   * letting the journal hold them would make it the place a simulation's numbers live —
   * which is exactly the thing a reader would then have to trust. What is durable here is
   * that a run happened, over how many observations, and the numbers are recomputed from
   * the series on demand. `failed` says whether there was a result at all.
   */
  'economic.simulation.completed': {
    scenarioId: string
    experimentId: string
    resultId: string
    strategy: string
    metricCount: number
    observationCount: number
    completedAt: string
    failed: boolean
  }

  /**
   * A **simulated** order was placed.
   *
   * There is no venue field, no account field and no broker field, and there is nothing
   * in this shape for one to go in. `reasoning` is a single closed code rather than a
   * list, because a durable payload is scalars and a list would be the first open-ended
   * structure in a file whose whole value is that it cannot hold one.
   */
  'economic.paper-order.placed': {
    orderId: string
    experimentId: string
    symbol: string
    side: string
    quantity: number
    price: number
    placedAt: string
    reasoning: string
  }

  /**
   * A simulated order was filled against the simulated portfolio.
   *
   * `realizedPnl` is recorded but **recomputed** by the fold from the position
   * arithmetic, and a mismatch is an anomaly. A journal that could assert a profit the
   * arithmetic does not support would be the one place in Phase 32 where a number could
   * be made up.
   */
  'economic.paper-order.filled': {
    orderId: string
    experimentId: string
    positionId: string
    symbol: string
    side: string
    quantity: number
    price: number
    realizedPnl: number
  }

  /**
   * One metric. `denominator` and `unit` are **not optional**, and a metric whose
   * denominator would be zero is never emitted at all rather than reported as `0/0`.
   */
  'economic.metric.computed': {
    metricId: string
    experimentId: string
    name: string
    value: number
    denominator: number
    unit: string
    computedAt: string
  }

  /**
   * What the continuation decided, before it moved.
   *
   * Journalled separately from the move that follows, so a reader sees what was concluded
   * before seeing where it went — and so a decision to stop is recorded even if the
   * process died between deciding and moving. `reasoning` is one closed code and `blocker`
   * is one closed code or empty, because this is the entry that answers "why did Freya do
   * nothing here?", and an answer with a free-text field in it is not one.
   */
  'economic.continuation.decided': {
    experimentId: string
    wakeId: string
    decision: string
    stage: string
    reasoning: string
    blocker: string
    evidenceCount: number
    scenarioCount: number
    orderCount: number
    attempt: number
  }

  /**
   * Which gates cleared, and which one refused.
   *
   * `checked` is the ordered prefix that passed, ` | `-joined, so a denial reads as
   * "three cleared and then the budget ran out" rather than as a bare no. Journalled on
   * the allowed path too: the record that a thing *was* permitted is worth as much to an
   * auditor as the record that it was not. `remainingUnits` is a count of bounded work,
   * never an amount of anything.
   */
  'economic.gate.decided': {
    wakeId: string
    experimentId: string
    outcome: string
    code: string
    checked: string
    remainingUnits: number
    at: string
  }

  /**
   * A request was refused.
   *
   * `code` is closed and `subject` is a closed kind, so a caller's own text can never
   * reach the journal through a refusal — which is the oldest mistake in this trade and
   * the reason the shape is two codes rather than one string.
   */
  'economic.refusal.recorded': {
    refusalId: string
    code: string
    subject: string
    experimentId: string
    wakeId: string
    at: string
  }

  /** Metadata only, and the wake the whole family hangs off. */
  'economic.wake.received': {
    wakeId: string
    source: string
    kind: string
    wakeKey: string
    experimentId: string
    goalRef: string
    sourceRef: string
    occurredAt: string
    observedAt: string
  }

  /**
   * The registry refused a wake. Bookkeeping, not a move: a wake that never entered the
   * continuation leaves the subsystem exactly where it was, and this is the only trace it
   * leaves. The dedupe key is deliberately not consumed, so a wake that was never
   * processed may legitimately arrive again.
   */
  'economic.wake.denied': {
    wakeId: string
    source: string
    kind: string
    code: string
    experimentId: string
  }

  /**
   * A restart or an owner pre-emption reconciled the position to what the journal proves.
   *
   * Not a continuation step, and deliberately not in the state machine's ordinary table:
   * a process that died mid-stage cannot be resumed, so the experiment is *recorded as
   * interrupted* and left where it was. Putting a fake signal in the table would make
   * every entry in it less trustworthy.
   */
  'economic.reconciled': {
    code: string
    from: string
    experimentId: string
    atStage: string
  }

  /**
   * STOP ALL reached the subsystem.
   *
   * The one event that may override terminality, and it can only ever *set* the latch.
   * Re-asserting a clearable stop is legitimate — a subsystem that closed out cleanly
   * sits latched with a clearable code, and the owner pressing the button in the same turn
   * has to leave a latch behind. The upgrade is one-directional, so accepting it cannot
   * release anything.
   */
  'economic.stopped': {
    experimentId: string
    stage: string
    code: string
  }

  /**
   * The owner cleared the latch. One key, deliberately.
   *
   * This is the owner's act and nothing in Phase 32 may write it; the fold refuses an
   * entry that arrives without a `security.stop_all.cleared` behind it, which is what
   * stops one line in a text file from un-pressing a panic button.
   */
  'economic.unstopped': {
    code: string
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

  /* --------------------------------------------------------------- forge */

  /**
   * A candidate package exists, as a version, with a hash.
   *
   * `declaredCapabilities` is the one list here, and it is a list of **Guard
   * vocabulary entries** rather than the package's own words — a capability map
   * that survives a restart is exactly the thing an attacker would want to edit,
   * so the fold stores the closed names and re-derives the permission question at
   * install and at every run. It is bounded by the domain's own limit.
   */
  'forge.candidate.created': {
    skillId: string
    name: string
    runtime: ForgeRuntimeKind
    version: number
    integrityHash: string
    origin: ForgeOrigin
    model: string | null
    requestHash: string | null
    originRef: string | null
    accessNetwork: ForgeAccessLevel
    accessDevice: ForgeAccessLevel
    declaredCapabilities: Capability[]
    tags: string[]
    dependencyCount: number
    programStepCount: number
    descriptionLength: number
    createdAt: string
  }

  /** A validation attempt began. Distinct from its result so an audit can see the attempt. */
  'forge.validating.recorded': {
    skillId: string
    version: number
    integrityHash: string
    startedAt: string
  }

  /**
   * The whole pipeline's result, as one verdict and one closed code per stage.
   *
   * `stageVerdicts` always has one entry per stage in pipeline order, including
   * the stages that did not run — a truncated pipeline is the shape that lets a
   * reader assume the rest was considered.
   */
  'forge.validation.recorded': {
    skillId: string
    version: number
    integrityHash: string
    passed: boolean
    failingStage: ForgeValidationStage | null
    code: ForgeRefusalCode | null
    ranAt: string
    stageVerdicts: ForgeStageVerdict[]
    testChecks: number
    testFailures: number
  }

  'forge.installed': {
    skillId: string
    version: number
    integrityHash: string
    action: 'install-new' | 'upgrade' | 'downgrade'
    installedAt: string
  }

  'forge.enabled': {
    skillId: string
    version: number
    enabledAt: string
  }

  'forge.disabled': {
    skillId: string
    version: number
    disabledAt: string
    reason: string
  }

  'forge.rolledback': {
    skillId: string
    fromVersion: number
    toVersion: number
    at: string
  }

  'forge.quarantined': {
    skillId: string
    version: number
    code: ForgeRefusalCode
    reason: string
    at: string
  }

  'forge.degraded': {
    skillId: string
    version: number
    code: ForgeRunFailureCode
    reason: string
    at: string
  }

  'forge.removed': {
    skillId: string
    version: number
    at: string
    reason: string
  }

  'forge.approval.recorded': {
    skillId: string
    version: number
    state: 'approved' | 'refused'
    decidedBy: string
    decidedAt: string
    reason: string
  }

  /**
   * A run, twice: once when it starts and once when it ends.
   *
   * A run whose `finishedAt` is null is one that was in flight. Recovery turns
   * those into `interrupted` rather than retrying them, because a result that was
   * not durably recorded did not provably happen.
   */
  'forge.run.recorded': {
    runId: string
    skillId: string
    version: number
    state: ForgeRunState
    failure: ForgeRunFailureCode | null
    startedAt: string
    finishedAt: string | null
    idempotencyKey: string | null
    inputHash: string | null
    opsUsed: number
    outputChars: number
    durationMs: number
    outputHash: string | null
  }

  'forge.refused': {
    code: ForgeRefusalCode
    skillId: string | null
    at: string
  }

  'forge.limit.exceeded': {
    limit: string
    reason: string
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

  /* ------------------------------------------------------------ connectors */

  // Metadata only, and the exact-key rules in `validate.ts` are load-bearing:
  // there is no slot for a token, a client secret, an authorization header or
  // an event's content. `accountLabel` is a display label Core assigned, never
  // an account credential.
  'connector.connection.requested': {
    requestId: string
    connector: ConnectorKind
  }

  'connector.connection.authorized': {
    connector: ConnectorKind
    accountLabel: string
    scopes: string[]
    expiresAt: string | null
  }

  'connector.connection.refreshed': {
    connector: ConnectorKind
    expiresAt: string | null
  }

  'connector.connection.degraded': {
    connector: ConnectorKind
    failureCode: ConnectorFailureCode
    reason: string
  }

  'connector.connection.expired': {
    connector: ConnectorKind
  }

  'connector.connection.revoked': {
    connector: ConnectorKind
    reason: string
  }

  'connector.connection.failed': {
    connector: ConnectorKind
    failureCode: ConnectorFailureCode
    reason: string
  }

  'connector.connection.blocked': {
    connector: ConnectorKind
    failureCode: ConnectorFailureCode
    reason: string
  }

  'connector.event.received': {
    eventId: string
    connector: ConnectorKind
    accountLabel: string | null
    kind: string
    dedupeKey: string
    payloadLength: number
  }

  'connector.event.denied': {
    eventId: string
    connector: ConnectorKind
    kind: string
    dedupeKey: string
    failureCode: ConnectorFailureCode
    reason: string
  }

  'connector.action.reconciled': {
    connector: ConnectorKind
    actionId: string
    outcome: string
  }

  /* --------------------------------------------------------- long-horizon */

  /**
   * A goal exists.
   *
   * `deadlineAt` rather than a lifetime in milliseconds: the wall-clock bound is
   * resolved once, at creation, so every later reader agrees about when the goal
   * expires without re-deriving it and without a timer watching it.
   */
  'longhorizon.goal.content.updated': { goalId: string }
  'longhorizon.goal.deleted': { goalId: string }
  'longhorizon.goal.created': {
    goalId: string
    state: 'draft'
    createdAt: string
    deadlineAt: string
    dependencies: string[]
    limits: GoalLimitsPayload
  }

  /**
   * A lifecycle transition.
   *
   * `from` is in the payload as well as implied by the previous event, so the
   * reducer can refuse a transition whose history does not agree with itself. A
   * hand-edited line claiming `draft → completed` is refused rather than folded,
   * which is what stops a replayed journal manufacturing a completed goal with
   * no verification behind it.
   */
  'longhorizon.goal.state-changed': {
    goalId: string
    from: string
    to: string
    /** Closed code. Never a message, never content. */
    reason: string | null
  }

  'longhorizon.goal.completed': {
    goalId: string
    verifierId: string
  }

  'longhorizon.goal.failed': {
    goalId: string
    reason: string | null
  }

  'longhorizon.goal.cancelled': {
    goalId: string
    reason: string | null
  }

  'longhorizon.goal.roadmap-updated': {
    goalId: string
    revision: number
    milestoneCount: number
  }

  'longhorizon.goal.milestone-settled': {
    goalId: string
    milestoneId: string
    outcome: string
    revision: number
  }

  /**
   * A checkpoint was started.
   *
   * `kind` is a closed code from the goal's own vocabulary. No description, no
   * evidence, no verifier internals.
   */
  'longhorizon.checkpoint.started': {
    goalId: string
    checkpointId: string
    order: number
    kind: string
  }

  /**
   * A checkpoint was verified.
   *
   * `outcome` and `reason` are both closed codes. A verifier's message and its
   * evidence are both deliberately absent: a verifier is the component most likely
   * to hold something private, and this is the boundary it cannot cross.
   */
  'longhorizon.checkpoint.verified': {
    goalId: string
    checkpointId: string
    outcome: 'passed' | 'not_established' | 'timeout' | 'cancelled'
    reason: string | null
  }

  'longhorizon.checkpoint.failed': {
    goalId: string
    checkpointId: string
    reason: string | null
    attempts: number
  }

  /**
   * A continuation decision was made.
   *
   * `decision` is a closed code. The decision is recorded for audit, but the
   * goal's state machine is the only thing that changes a goal's state.
   */
  'longhorizon.continuation.decided': {
    goalId: string
    decision: 'continue' | 'pause' | 'complete' | 'fail' | 'wait'
    reason: string
  }

  /** A schedule fired. One event, one fact. */
  'longhorizon.schedule.fired': {
    scheduleId: string
    goalId: string
    wakeId: string
  }

  'longhorizon.schedule.expired': {
    scheduleId: string
    goalId: string
    reason: string
  }

  /**
   * A wake was received.
   *
   * `source` is a closed code from the wake-source vocabulary. No payload, no
   * content, no authority claim.
   */
  'longhorizon.wake.received': {
    wakeId: string
    source: string
    goalId: string | null
  }

  /**
   * A wake was denied.
   *
   * `reason` is a closed refusal code. Recorded rather than dropped, because an
   * unaudited refusal hides a probing pattern.
   */
  'longhorizon.wake.denied': {
    wakeId: string
    source: string
    goalId: string | null
    reason: string
  }

  /* ------------------------------------------------------ runtime activation */

  /**
   * One domain's registration decision.
   *
   * `outcome` is the allowed/blocked verdict; `status` is where the domain now
   * stands; `missing` names the dependency labels that blocked it, if any.
   */
  'runtime.activation.decided': {
    domainId: string
    outcome: 'allowed' | 'blocked'
    status: RuntimeStatus
    reason: string
    missing: string[]
    requestedAt: string
  }

  /** A domain's status changed after it had already been evaluated. */
  'runtime.activation.changed': {
    domainId: string
    from: RuntimeStatus
    to: RuntimeStatus
    reason: string
    missing: string[]
  }

  /** A domain was stopped, with the reason recorded. */
  'runtime.activation.stopped': {
    domainId: string
    reason: string
    missing: string[]
  }

  /**
   * A domain was reconciled after a Core restart.
   *
   * `previousStatus` is carried rather than read back from state, for Work's
   * reason: after a restart "what this domain was doing" is precisely the thing
   * that is no longer knowable from memory.
   */
  'runtime.activation.reconciled': {
    domainId: string
    previousStatus: RuntimeStatus
    status: RuntimeStatus
    reason: string
    missing: string[]
  }

  /* ---------------------------------------------------- proactive intelligence */

  'proactive.observation.received': {
    observationId: string
    sourceType: string
    sourceId: string
    trust: string
    dedupeKey: string
    observedAt: string
    goalId: string | null
    milestoneId: string | null
    evidenceRef: string | null
  }

  'proactive.observation.dropped': {
    sourceType: string
    sourceId: string
    dedupeKey: string
    reason: string
  }

  'proactive.subscription.updated': {
    subscriptionId: string
    sourceId: string
    active: boolean
    expiresAt: string | null
  }

  'proactive.relevance.evaluated': {
    observationId: string
    goalId: string | null
    classification: string
    isRelevant: boolean
    confidence: number
    reasoningApplied: boolean
  }

  'proactive.decision.made': {
    decisionId: string
    observationId: string
    decision: string
    level: number
    actionRef: string | null
    reason: string
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

/**
 * One step, as the journal carries it.
 *
 * A separate interface from `MissionStepPayload` even though the shapes match, and the
 * reason is provenance: `envelope.ts` must not import the Mission domain's record types,
 * because the envelope is the layer *below* the domain. Describing the same shape twice
 * in the two layers is the cost of that ordering, and it is cheaper than an import cycle
 * between the journal and the thing it journals.
 */
export interface MissionStepPayload {
  stepId: string
  index: number
  capability: string
  verifier: string
  dependsOn: readonly string[]
  status: string
  workerId: string | null
  runId: string | null
  attempts: number
  risk: 'none' | 'routine' | 'consequential'
  requiresApproval: boolean
  approvalId: string | null
  reason: string | null
  startedAt: string | null
  settledAt: string | null
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

/**
 * Phase 47 autonomy ceilings, as they appear in `mission.created`.
 *
 * Separate from `MissionLimitsPayload` because the two bound different things:
 * `limits` bounds child Runs, `budget` bounds what the Mission does itself. Fusing
 * them would make "raise the retry ceiling" a way to raise the child-Run ceiling.
 *
 * There is deliberately no `maxMoney` field anywhere in this shape. Freya has no way
 * to represent spending money, so no code path can be written that does it.
 */
export interface MissionBudgetPayload {
  maxModelCalls: number
  maxActions: number
  maxExternalRequests: number
  maxDurationMs: number
  maxRetries: number
  maxDelegations: number
  maxConcurrentDelegations: number
  maxPlanRevisions: number
  maxStepsPerPlan: number
}

/**
 * One step, as it appears inside a `mission.plan.committed` payload.
 *
 * No `label`. A step's description is exactly the kind of sentence that would make a
 * Mission journal readable to somebody it was never meant to be readable by, and a
 * planner that wanted one would have to smuggle it through a capability name.
 */
export interface MissionStepPayload {
  stepId: string
  index: number
  capability: string
  verifier: string
  dependsOn: readonly string[]
  status: string
  workerId: string | null
  runId: string | null
  attempts: number
  risk: 'none' | 'routine' | 'consequential'
  requiresApproval: boolean
  approvalId: string | null
  reason: string | null
  startedAt: string | null
  settledAt: string | null
}

/**
 * A Mission lifecycle transition, for all nine transition events.
 *
 * `from` is in the payload as well as implied by the previous event, so the reducer can
 * refuse a transition whose history does not agree with itself. A hand-edited line
 * claiming `draft → completed` is refused rather than folded, which is what stops a
 * replayed journal manufacturing a completed Mission with no verification behind it.
 */
export interface MissionTransitionPayload {
  missionId: string
  from: string
  to: string
  reason: string | null
  /** Present on completion only: which verifier established it. An id. */
  verifierId: string | null
}

/** Ceilings as they appear in a goal event. Re-validated against code on read. */
export interface GoalLimitsPayload {
  maxRetainedGoals: number
  maxTitleChars: number
  maxDescriptionChars: number
  maxCompletionCriteria: number
  maxCriterionChars: number
  maxDependencies: number
  maxCheckpointsPerGoal: number
  lifetimeMs: number
  verificationDeadlineMs: number
  maxRetryCeiling: number
  maxBackoffMs: number
  baseBackoffMs: number
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
