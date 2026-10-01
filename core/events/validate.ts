import {
  CORE_EVENT_SCHEMA_VERSION,
  CORE_EVENT_TYPES,
  type AnyCoreEvent,
  type CoreEventType,
} from './envelope'
import { isPrincipalId } from '../security/guard'

/**
 * Durable event validation.
 *
 * A security journal is only as trustworthy as the least validated byte in it.
 * "Looks like an envelope" is not a standard: a hand-edited log, a truncated
 * write, or a line from a future schema must not be able to inject a sequence
 * number, a principal, or a STOP ALL latch.
 *
 * These are small explicit checks, not a schema library. The rules are few and
 * each one corresponds to a way a forged line could change behaviour.
 *
 * **`parseDurableEvent` never throws and never returns a partial event.** It
 * returns the event or `null`, and the caller treats `null` as "the log ends
 * here".
 */

export interface ValidationFailure {
  line: number
  reason: string
}

/**
 * What recovery found, and how much to trust it.
 *
 * The two cases are genuinely different and must not be reported as one thing:
 *
 * - **torn tail** — the log ends part-way through a line. That is what a crash
 *   during a write looks like: the bytes after the last complete line were never
 *   committed. The prefix is the whole truth, and recovery is ordinary.
 *
 * - **corruption** — a *complete* line failed validation, or there was more data
 *   after the first bad line. A complete line that is wrong is not a crash. It
 *   means the journal contains something that was never written by this code, or
 *   was edited, or arrived out of order.
 *
 * Corruption means the log can no longer be replayed into trustworthy security
 * state, because a discarded segment could have contained the STOP ALL that
 * followed it. Core refuses to present a damaged journal as healthy.
 */
export interface RecoveryReport {
  /** A crash truncated the final line. The surviving prefix is complete. */
  tornTail: boolean
  /** A complete line was invalid, or data followed one. Not a crash. */
  corruption: ValidationFailure | null
  /** Complete events that were read and are believed. */
  eventsRead: number
  /** Bytes discarded, including the discarded lines and any torn bytes. */
  bytesDiscarded: number
  /**
   * Where the damaged bytes were preserved, or null when there was no corruption
   * to set aside. The file exists after recovery; nothing is thrown away.
   */
  quarantinePath: string | null
  /** True when the journal can be replayed as the whole truth. */
  trustworthy: boolean
}

export const HEALTHY_RECOVERY: RecoveryReport = {
  tornTail: false,
  corruption: null,
  eventsRead: 0,
  bytesDiscarded: 0,
  quarantinePath: null,
  trustworthy: true,
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(CORE_EVENT_TYPES)

const SOURCES: ReadonlySet<string> = new Set(['core', 'renderer', 'system'])

/** Ids we generate or accept must look like ids: bounded, no whitespace, no
 *  control characters, so a hostile line cannot smuggle structure. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function isEventId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

export function isCoreEventType(value: unknown): value is CoreEventType {
  return typeof value === 'string' && EVENT_TYPE_SET.has(value)
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** An ISO-8601 instant. Validated rather than trusted, because a grant
 *  `expiresAt` is compared against the clock during replay. */
function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
}

function isNullable<T>(value: unknown, check: (v: unknown) => v is T): value is T | null {
  return value === null || check(value)
}

function isNullableString(value: unknown): value is string | null {
  return isNullable(value, isNonEmptyString)
}

function isNullablePositiveInt(value: unknown): value is number | null {
  return isNullable(value, isPositiveInt)
}

/**
 * Per-type payload validation.
 *
 * Only the fields Core actually reads during replay are checked, plus enough of
 * the rest that a malformed record cannot reach a projection. A payload that
 * fails here ends the log rather than being partially believed.
 */
/**
 * The conversation turn rule.
 *
 * Declared as a function rather than a spread of six near-identical arrow bodies,
 * because a shared schema that gets edited in one place and not the other is how
 * a validation rule starts disagreeing with itself.
 *
 * `userMessageId` and `assistantMessageId` are nullable because a denied turn has
 * no stored message and an interrupted turn has no answer — and a schema that
 * pretended otherwise would push a fabrication into the audit.
 */
const CONVERSATION_TURN = (p: Record<string, unknown>): boolean =>
  isEventId(p.conversationId) &&
  isEventId(p.turnId) &&
  isNullableString(p.userMessageId) &&
  isNullableString(p.assistantMessageId) &&
  isNonNegativeInt(p.contentLength) &&
  isNullableString(p.requestId) &&
  isNullableString(p.providerId) &&
  isNullableString(p.model) &&
  isNonEmptyString(p.outcome) &&
  isNullableString(p.reason)

/**
 * Validate one parsed JSON value as a durable Core event.
 *
 * Returns the event, or `null` with the reason. `previousSequence` enforces
 * strict monotonicity across the log; pass 0 for the first line.
 */
export function validateDurableEvent(
  value: unknown,
  previousSequence: number,
): { ok: true; event: AnyCoreEvent } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not an object' }
  }
  const e = value as Record<string, unknown>

  if (!isEventId(e.eventId)) return { ok: false, reason: 'eventId is missing or malformed' }

  // The type must be one Core knows. A line naming a future event is refused
  // rather than partially understood.
  if (!isCoreEventType(e.type)) {
    return { ok: false, reason: `unknown event type ${JSON.stringify(e.type)}` }
  }
  const type = e.type

  if (e.schemaVersion !== CORE_EVENT_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schema version ${String(e.schemaVersion)}` }
  }

  // Positive, and strictly greater than everything before it. A duplicate or a
  // reversal means the log is not the log we wrote.
  if (!isPositiveInt(e.sequence)) {
    return { ok: false, reason: `sequence is not a positive integer: ${String(e.sequence)}` }
  }
  if (e.sequence <= previousSequence) {
    return {
      ok: false,
      reason: `sequence ${e.sequence} is not greater than the previous ${previousSequence}`,
    }
  }

  if (!isInstant(e.occurredAt)) return { ok: false, reason: 'occurredAt is not an instant' }

  if (typeof e.source !== 'string' || !SOURCES.has(e.source)) {
    return { ok: false, reason: `source is not one of core/renderer/system: ${String(e.source)}` }
  }

  // The principal must be a real principal id. This is the check that stops a
  // hand-written line from acting as `owner`.
  if (!isPrincipalId(e.actor)) {
    return { ok: false, reason: `actor is not a valid principal: ${String(e.actor)}` }
  }

  if (!isEventId(e.correlationId)) {
    return { ok: false, reason: 'correlationId is missing or malformed' }
  }
  if (e.causationId !== null && !isEventId(e.causationId)) {
    return { ok: false, reason: 'causationId is malformed' }
  }

  if (typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) {
    return { ok: false, reason: 'payload is not an object' }
  }
  if (!PAYLOAD_RULES[type](e.payload as Record<string, unknown>)) {
    return { ok: false, reason: `payload does not match the shape of ${type}` }
  }

  return { ok: true, event: e as unknown as AnyCoreEvent }
}

/** Parse and validate one line. `null` means "not a usable event". */
export function parseDurableEvent(
  line: string,
  previousSequence: number,
): { ok: true; event: AnyCoreEvent } | { ok: false; reason: string } {
  if (line.trim().length === 0) return { ok: false, reason: 'line is blank' }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    return {
      ok: false,
      reason: `line is not JSON: ${error instanceof Error ? error.message : 'parse error'}`,
    }
  }
  return validateDurableEvent(value, previousSequence)
}

/**
 * Reject a payload whose key set is not exactly the one the schema names.
 *
 * Reading named fields is not enough on its own: a payload with the right fields
 * *plus* a query would pass every field check and quietly keep the query. This is
 * what makes "no query in a research event" a property of the validator rather than
 * a property of everyone remembering.
 */
function exactKeys(p: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(p).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const RESEARCH_STAGE_KEYS = ['operationId', 'sessionId', 'stage', 'counters', 'failureCode'] as const

const RESEARCH_STAGE_COUNTER_KEYS = [
  'iterations',
  'queries',
  'results',
  'pages',
  'evidenceChars',
  'modelTurns',
  'failures',
  'durationMs',
] as const

const RESEARCH_STAGES = [
  'authorizing',
  'planning',
  'gap',
  'searching',
  'reading',
  'synthesizing',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'creating',
  'ready',
  'navigating',
  'closed',
] as const

/**
 * One research stage, for all eleven event types.
 *
 * Every field is either an id Core issued, a closed enum, an integer the subsystem
 * counted itself, or a fixed failure code. There is no slot for a query, a URL, a
 * domain, a snippet, page text, an answer or a provider diagnostic, and the key check
 * above means an extra field cannot be attached either.
 */
const RESEARCH_STAGE = (p: Record<string, unknown>): boolean => {
  if (!exactKeys(p, RESEARCH_STAGE_KEYS)) return false
  if (!isNonEmptyString(p.operationId)) return false
  if (!(p.sessionId === null || isNonEmptyString(p.sessionId))) return false
  if (typeof p.stage !== 'string' || !RESEARCH_STAGES.includes(p.stage as never)) return false
  if (!(p.failureCode === null || isNonEmptyString(p.failureCode))) return false
  const counters = p.counters
  if (typeof counters !== 'object' || counters === null || Array.isArray(counters)) return false
  if (!exactKeys(counters as Record<string, unknown>, RESEARCH_STAGE_COUNTER_KEYS)) return false
  return RESEARCH_STAGE_COUNTER_KEYS.every((key) => isNonNegativeInt((counters as Record<string, unknown>)[key]))
}

const PAYLOAD_RULES: {
  [K in CoreEventType]: (payload: Record<string, unknown>) => boolean
} = {
  'core.started': (p) =>
    isNonEmptyString(p.version) && isNonEmptyString(p.storeKind) && isNonNegativeInt(p.recoveredSequence),
  'core.ready': (p) => Object.keys(p).length === 0,
  'core.degraded': (p) => isNonEmptyString(p.reason),
  'core.integrity_fault': (p) =>
    isNonEmptyString(p.reason) &&
    isPositiveInt(p.line) &&
    isNonEmptyString(p.quarantinePath) &&
    isNonNegativeInt(p.trustedPrefixEvents) &&
    isNonNegativeInt(p.trustedPrefixBytes) &&
    isNonNegativeInt(p.damagedBytes),
  'core.stopping': (p) => isNonEmptyString(p.reason),
  'core.stopped': (p) => isNonNegativeInt(p.durationMs),

  // Metadata only. The command's text is not in the journal, so there is
  // nothing here that could be a secret.
  'command.received': (p) =>
    isNonEmptyString(p.commandId) && isNonEmptyString(p.source) && isNonNegativeInt(p.contentLength),

  'guard.decision': (p) =>
    (p.outcome === 'allow' || p.outcome === 'deny' || p.outcome === 'approval_required') &&
    isNonEmptyString(p.reason) &&
    isNonEmptyString(p.capability) &&
    isPrincipalId(p.principal),

  'security.stop_all.activated': (p) => isPrincipalId(p.by) && isNonEmptyString(p.reason),
  'security.stop_all.cleared': (p) => isPrincipalId(p.by),

  'cognition.requested': (p) =>
    isEventId(p.requestId) &&
    isNonEmptyString(p.origin) &&
    isNonEmptyString(p.cause) &&
    isPositiveInt(p.maxOutputTokens) &&
    isNullableString(p.requestedModel) &&
    isNullableString(p.parentRunId) &&
    isNullableString(p.goalId),
  'cognition.allowed': (p) => isEventId(p.requestId) && isNullableString(p.grantId),
  'cognition.denied': (p) =>
    isEventId(p.requestId) && isNonEmptyString(p.reason) && isNullableString(p.grantId),
  'cognition.authorization_required': (p) => isEventId(p.requestId) && isNonEmptyString(p.reason),

  'cognition.grant.created': (p) =>
    isEventId(p.grantId) &&
    isPrincipalId(p.createdBy) &&
    isInstant(p.expiresAt) &&
    Array.isArray(p.allowedOrigins) &&
    Array.isArray(p.allowedCauses) &&
    isNullableString(p.goalId) &&
    isNullableString(p.runId) &&
    isNullable(p.actor, isPrincipalId) &&
    typeof p.backgroundAllowed === 'boolean' &&
    isPositiveInt(p.maxCalls) &&
    isPositiveInt(p.maxOutputTokens),

  'cognition.grant.revoked': (p) =>
    isEventId(p.grantId) && isPrincipalId(p.revokedBy) && isNonEmptyString(p.reason),

  'cognition.grant.reserved': (p) =>
    isEventId(p.grantId) && isEventId(p.requestId) && isPositiveInt(p.outputTokenBudgetReserved),
  'cognition.grant.usage_reported': (p) =>
    isEventId(p.grantId) &&
    isEventId(p.requestId) &&
    isNullablePositiveInt(p.inputTokens) &&
    isNullablePositiveInt(p.outputTokens),

  'model.request.started': (p) =>
    isEventId(p.requestId) &&
    isNullableString(p.grantId) &&
    isNonEmptyString(p.providerId) &&
    isNonEmptyString(p.model) &&
    isPositiveInt(p.maxOutputTokens) &&
    isInstant(p.startedAt),
  'model.request.completed': (p) =>
    isEventId(p.requestId) &&
    isNonEmptyString(p.providerId) &&
    isNonEmptyString(p.model) &&
    isNullablePositiveInt(p.inputTokens) &&
    isNullablePositiveInt(p.outputTokens),
  'model.request.failed': (p) =>
    isEventId(p.requestId) &&
    isNonEmptyString(p.providerId) &&
    isNonEmptyString(p.reason),
  // `providerContacted` is checked as a boolean rather than left to a default,
  // because a cancellation with an unknown contact is a cancellation whose
  // accounting cannot be trusted — and refusing to read the line is the
  // fail-closed answer to that.
  'model.request.cancelled': (p) =>
    isEventId(p.requestId) &&
    isNonEmptyString(p.providerId) &&
    isNonEmptyString(p.reason) &&
    typeof p.providerContacted === 'boolean',

  /* --------------------------------------------------------- conversation */

  'conversation.created': (p) =>
    isEventId(p.conversationId) && isNonNegativeInt(p.titleLength),

  // One rule for all six turn outcomes, applied to each. A conversation event is
  // metadata, and this is the list of what "metadata" is allowed to mean — a
  // hand-edited line cannot smuggle a field the schema does not name, because the
  // rule reads named fields rather than passing the object through.
  'conversation.turn.started': CONVERSATION_TURN,
  'conversation.turn.completed': CONVERSATION_TURN,
  'conversation.turn.cancelled': CONVERSATION_TURN,
  'conversation.turn.failed': CONVERSATION_TURN,
  'conversation.turn.denied': CONVERSATION_TURN,
  'conversation.turn.interrupted': CONVERSATION_TURN,

  /* --------------------------------------------------------------- voice */

  'voice.capture.started': (p) =>
    isEventId(p.sessionId) && isNonEmptyString(p.format) && isPositiveInt(p.sampleRate),
  'voice.capture.completed': (p) =>
    isEventId(p.sessionId) &&
    isNonNegativeInt(p.byteLength) &&
    isNonNegativeInt(p.durationMs) &&
    typeof p.transcribed === 'boolean' &&
    isNonNegativeInt(p.transcriptLength),
  'voice.capture.cancelled': (p) =>
    isEventId(p.sessionId) && isNonNegativeInt(p.byteLength) && isNonEmptyString(p.reason),

  /* --------------------------------------------------------------- brain */

  // Metadata only, and the rules below are the list of what that means. They read
  // named fields rather than passing the object through, so a hand-edited line
  // cannot smuggle a field the schema does not name — which for the Brain is the
  // difference between a journal that measures what was learned and one that
  // quietly starts retaining it.
  'brain.seeded': (p) =>
    isNonEmptyString(p.identityName) &&
    isNonNegativeInt(p.identityClaimCount) &&
    isNonNegativeInt(p.capabilityCount) &&
    isNonNegativeInt(p.limitationCount),

  'brain.memory.admitted': (p) =>
    isEventId(p.memoryId) &&
    isNonEmptyString(p.kind) &&
    isNonEmptyString(p.source) &&
    isNonEmptyString(p.confidence) &&
    isNonEmptyString(p.status) &&
    isNonNegativeInt(p.conflictsWith) &&
    isNonNegativeInt(p.contentLength),

  'brain.memory.reviewed': (p) =>
    isEventId(p.candidateId) &&
    (p.decision === 'rejected' || p.decision === 'deferred') &&
    isNonEmptyString(p.reason),

  'brain.memory.archived': (p) => isEventId(p.memoryId) && isNonEmptyString(p.reason),

  'brain.world.entity_noted': (p) =>
    isEventId(p.entityId) &&
    isNonEmptyString(p.entityType) &&
    isNonNegativeInt(p.nameLength) &&
    isNonEmptyString(p.sourceType),

  'brain.world.related': (p) =>
    isEventId(p.subjectEntityId) &&
    isNonEmptyString(p.predicate) &&
    isNonNegativeInt(p.conflictingRelations),

  'brain.world.observed': (p) =>
    isEventId(p.observationId) &&
    isNonEmptyString(p.sourceType) &&
    isNonNegativeInt(p.statedLength),

  'brain.experience.recorded': (p) =>
    isEventId(p.experienceId) &&
    isNonEmptyString(p.result) &&
    isNonNegativeInt(p.modelsUsed) &&
    typeof p.providerContacted === 'boolean' &&
    (p.conversationId === null || isEventId(p.conversationId)) &&
    (p.turnId === null || isEventId(p.turnId)),

  'brain.degraded': (p) => isNonEmptyString(p.reason),

  /* ------------------------------------------------------------- research */

  // One rule for all eleven research stages, applied to each. The rule reads
  // *named* fields and checks the key set exactly, so a hand-edited line cannot
  // smuggle a query, a URL, a snippet or a page into a payload whose schema does not
  // have a slot for it. `exactKeys` is the load-bearing part: without it an extra
  // field would be retained and simply ignored, which is precisely the failure mode
  // this whole event family exists to prevent.
  'research.search_started': RESEARCH_STAGE,
  'research.search_completed': RESEARCH_STAGE,
  'research.search_failed': RESEARCH_STAGE,
  'research.read_started': RESEARCH_STAGE,
  'research.read_completed': RESEARCH_STAGE,
  'research.read_failed': RESEARCH_STAGE,
  'research.started': RESEARCH_STAGE,
  'research.progress': RESEARCH_STAGE,
  'research.completed': RESEARCH_STAGE,
  'research.failed': RESEARCH_STAGE,
  'research.cancelled': RESEARCH_STAGE,


  /* ----------------------------------------------------------------- work */

  // Metadata only. The rules below are the list of what that means for Work, and
  // they read named fields rather than passing the object through — so a
  // hand-edited line cannot smuggle in a field the schema does not name, which for
  // Work is the difference between a journal that *measures* what happened and one
  // that quietly starts retaining what every capability returned.
'work.run.created': workRule(
    ['runId', 'kind', 'taskId', 'parentKind', 'parentId', 'limits', 'steps'],
    (p) =>
      isEventId(p.runId) &&
      isNonEmptyString(p.kind) &&
      isNullableString(p.taskId) &&
      isNullableString(p.parentKind) &&
      isNullableString(p.parentId) &&
      isRunLimits(p.limits) &&
      Array.isArray(p.steps) &&
      p.steps.length > 0 &&
      p.steps.every(isStepSeed),
  ),

  'work.run.started': workRule(['runId'], (p) => isEventId(p.runId)),

  'work.run.resumed': workRule(
    ['runId', 'reason'],
    (p) => isEventId(p.runId) && isNullableString(p.reason),
  ),

  'work.run.paused': workRule(
    ['runId', 'reason'],
    (p) => isEventId(p.runId) && isNonEmptyString(p.reason),
  ),

  'work.run.waiting': workRule(
    ['runId', 'reason'],
    (p) => isEventId(p.runId) && isNonEmptyString(p.reason),
  ),

  'work.run.awaiting_approval': workRule(
    ['runId', 'reason'],
    (p) => isEventId(p.runId) && isNonEmptyString(p.reason),
  ),

  'work.run.completed': workRule(
    ['runId', 'stepCount', 'verifiedCount'],
    (p) =>
      isEventId(p.runId) && isNonNegativeInt(p.stepCount) && isNonNegativeInt(p.verifiedCount),
  ),

  'work.run.failed': workRule(
    ['runId', 'reason', 'stepCount', 'verifiedCount'],
    (p) =>
      isEventId(p.runId) &&
      isNonEmptyString(p.reason) &&
      isNonNegativeInt(p.stepCount) &&
      isNonNegativeInt(p.verifiedCount),
  ),

  'work.run.cancelled': workRule(
    ['runId', 'reason'],
    (p) => isEventId(p.runId) && isNonEmptyString(p.reason),
  ),

  'work.run.recovered': workRule(
    ['runId', 'previousStatus', 'reason'],
    (p) =>
      isEventId(p.runId) && isNonEmptyString(p.previousStatus) && isNonEmptyString(p.reason),
  ),

  'work.step.ready': workRule(
    ['runId', 'stepId', 'stepKey'],
    (p) => isEventId(p.runId) && isEventId(p.stepId) && isNonEmptyString(p.stepKey),
  ),

  'work.step.started': workRule(
    ['runId', 'stepId', 'stepKey', 'index', 'capability', 'attempt'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isNonEmptyString(p.stepKey) &&
      isNonNegativeInt(p.index) &&
      isNonEmptyString(p.capability) &&
      isPositiveInt(p.attempt),
  ),

  'work.step.verified': workRule(
    ['runId', 'stepId', 'attempt'],
    (p) => isEventId(p.runId) && isEventId(p.stepId) && isNonNegativeInt(p.attempt),
  ),

  'work.step.failed': workRule(
    ['runId', 'stepId', 'reason'],
    (p) => isEventId(p.runId) && isEventId(p.stepId) && isNonEmptyString(p.reason),
  ),

  'work.step.cancelled': workRule(
    ['runId', 'stepId', 'reason'],
    (p) => isEventId(p.runId) && isEventId(p.stepId) && isNonEmptyString(p.reason),
  ),

  'work.step.skipped': workRule(
    ['runId', 'stepId', 'reason'],
    (p) => isEventId(p.runId) && isEventId(p.stepId) && isNonEmptyString(p.reason),
  ),

  // `principal` is checked here rather than trusted, because this is the field that
  // says who executed. A forged line claiming `owner` is exactly what the
  // envelope-level principal check exists to stop, and this is the second place the
  // same claim is made.
  'work.action.started': workRule(
    ['runId', 'stepId', 'actionId', 'attempt', 'capability', 'principal'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isEventId(p.actionId) &&
      isPositiveInt(p.attempt) &&
      isNonEmptyString(p.capability) &&
      isPrincipalId(p.principal),
  ),

  'work.action.completed': workRule(
    ['runId', 'stepId', 'actionId', 'attempt', 'durationMs'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isEventId(p.actionId) &&
      isPositiveInt(p.attempt) &&
      isNonNegativeInt(p.durationMs),
  ),

  'work.action.failed': workRule(
    ['runId', 'stepId', 'actionId', 'attempt', 'reason', 'durationMs'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isEventId(p.actionId) &&
      isPositiveInt(p.attempt) &&
      isNonEmptyString(p.reason) &&
      isNonNegativeInt(p.durationMs),
  ),

  'work.action.cancelled': workRule(
    ['runId', 'stepId', 'actionId', 'attempt', 'reason'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isEventId(p.actionId) &&
      isPositiveInt(p.attempt) &&
      isNonEmptyString(p.reason),
  ),

  'work.observation.recorded': workRule(
    ['runId', 'stepId', 'actionId', 'observationId', 'kind', 'summaryLength', 'detailLength'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isNullableString(p.actionId) &&
      isEventId(p.observationId) &&
      isNonEmptyString(p.kind) &&
      isNonNegativeInt(p.summaryLength) &&
      isNonNegativeInt(p.detailLength),
  ),

  'work.verification.requested': workRule(
    ['runId', 'stepId', 'verificationId', 'verifier'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isEventId(p.verificationId) &&
      isNonEmptyString(p.verifier),
  ),

  'work.verification.completed': workRule(
    ['runId', 'stepId', 'verificationId', 'verdict', 'reason'],
    (p) =>
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isEventId(p.verificationId) &&
      (p.verdict === 'passed' || p.verdict === 'failed') &&
      isNonEmptyString(p.reason),
  ),

  'work.approval.requested': workRule(
    [
      'approvalId',
      'runId',
      'stepId',
      'capability',
      'requiredCapability',
      'risk',
      'principal',
      'justification',
      'proposal',
    ],
    (p) =>
      isEventId(p.approvalId) &&
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isNonEmptyString(p.capability) &&
      isNonEmptyString(p.requiredCapability) &&
      (p.risk === 'none' || p.risk === 'routine' || p.risk === 'consequential') &&
      isPrincipalId(p.principal) &&
      isNonEmptyString(p.justification) &&
      isNonEmptyString(p.proposal),
  ),

  'work.approval.approved': workRule(
    ['approvalId', 'runId', 'stepId', 'decidedBy', 'decisionSource'],
    (p) =>
      isEventId(p.approvalId) &&
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isPrincipalId(p.decidedBy) &&
      isNonEmptyString(p.decisionSource),
  ),

  'work.approval.denied': workRule(
    ['approvalId', 'runId', 'stepId', 'decidedBy', 'decisionSource', 'reason'],
    (p) =>
      isEventId(p.approvalId) &&
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isPrincipalId(p.decidedBy) &&
      isNonEmptyString(p.decisionSource) &&
      isNonEmptyString(p.reason),
  ),

  'work.approval.cancelled': workRule(
    ['approvalId', 'runId', 'stepId', 'reason'],
    (p) =>
      isEventId(p.approvalId) &&
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isNonEmptyString(p.reason),
  ),

  'work.approval.expired': workRule(
    ['approvalId', 'runId', 'stepId', 'reason'],
    (p) =>
      isEventId(p.approvalId) &&
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isNonEmptyString(p.reason),
  ),

  'work.task.created': workRule(
    ['taskId', 'titleLength'],
    (p) => isEventId(p.taskId) && isPositiveInt(p.titleLength),
  ),

  'work.task.updated': workRule(
    ['taskId', 'status'],
    (p) => isEventId(p.taskId) && isNonEmptyString(p.status),
  ),

  'work.task.attached': workRule(
    ['taskId', 'runId'],
    (p) => isEventId(p.taskId) && isEventId(p.runId),
  ),

  'work.task.completed': workRule(
    ['taskId', 'status'],
    (p) => isEventId(p.taskId) && isNonEmptyString(p.status),
  ),

  'work.limits.exceeded': workRule(
    ['runId', 'limit', 'reason', 'observed'],
    (p) =>
      isEventId(p.runId) &&
      isNonEmptyString(p.limit) &&
      isNonEmptyString(p.reason) &&
      isNonNegativeInt(p.observed),
  ),
}

/**
 * One planned step inside `work.run.created`.
 *
 * Named fields only, exactly like `CONVERSATION_TURN`: a schema that passed the
 * object through would let a hand-edited line attach a `label` or an `input` to a
 * step seed, which is the precise hole that would turn the Work journal into a
 * record of what Freya was asked to do.
 */
function isStepSeed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const step = value as Record<string, unknown>
  return (
    isEventId(step.stepId) &&
    isNonEmptyString(step.key) &&
    isNonEmptyString(step.capability) &&
    isNonEmptyString(step.verifier) &&
    onlyNamedKeys(step, ['stepId', 'key', 'capability', 'verifier'])
  )
}

/**
 * Reject a payload field the schema does not name.
 *
 * ## Why only the Work family gets this
 *
 * The other rules read named fields and ignore the rest, which means a hand-edited
 * line *can* carry an extra key past them — it simply has nowhere to be read from,
 * so it never reaches a reducer or a projection. That is a real defence, and it is
 * the reason this is not an urgent fix for the existing families.
 *
 * It is not enough for Work, though. The entire safety argument for putting
 * execution history in this file is that there is **no field a body could hide
 * in**: a step's input, an observation's text and a task's title are all things a
 * person might not want in a backup. Ignoring an undeclared key means such a value
 * can still be *written to disk* by anyone editing the file, and "the reducer
 * ignores it" is a weaker statement than "it was never accepted".
 *
 * Work is new, so it starts the stronger way. Adding the same rule to an older
 * family is a schema-version question, not a code one, and belongs with whatever
 * next changes that family's payload.
 */
function onlyNamedKeys(payload: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) return false
  }
  return true
}

/** Wrap a Work payload rule with the no-unnamed-fields check. */
function workRule(
  allowed: readonly string[],
  rule: (payload: Record<string, unknown>) => boolean,
): (payload: Record<string, unknown>) => boolean {
  return (payload) => onlyNamedKeys(payload, allowed) && rule(payload)
}

/**
 * A Run's resolved ceilings.
 *
 * Positive integers, because a zero or negative ceiling in a durable record would
 * either make every run instantly over budget or make "bounded" mean nothing.
 */
function isRunLimits(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const limits = value as Record<string, unknown>
  return (
    isPositiveInt(limits.maxSteps) &&
    isPositiveInt(limits.maxActions) &&
    isPositiveInt(limits.maxDurationMs) &&
    isPositiveInt(limits.maxAttemptsPerStep)
  )
}
