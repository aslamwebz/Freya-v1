import type { CognitionCause, CognitionOrigin, PrincipalId } from '../protocol/core-protocol'

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

/** Events that change durable security or governance state. */
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
