import {
  CORE_EVENT_SCHEMA_VERSION,
  CORE_EVENT_TYPES,
  type AnyCoreEvent,
  type CoreEventType,
} from './envelope'
import { isCapability, isPrincipalId } from '../security/guard'
import { DEFAULT_MISSION_LIMITS } from '../missions/types'
import {
  DEFAULT_WORKER_BUDGET,
  WORKFORCE_LIMITS,
  isAssignableToWorker,
  isWorkerSpecialisation,
  normaliseContextRef,
  normaliseWorkforceName,
} from '../workforce/types'
import {
  RELATIONSHIP_ITEM_KINDS,
  RELATIONSHIP_LIFECYCLE_REASONS,
  isSlug,
} from '../personality/types'
import { SOURCE_TRUST_RANK } from '../brain/types'
import {
  isAttentionCondition,
  isAttentionCueCode,
  isAttentionEventKind,
  isAttentionOutcome,
  isAttentionReason,
  isAttentionScheduleCancelReason,
  isAttentionSource,
  isFocusState,
  isImportanceLevel,
  isSeverityHint,
  isUrgencyLevel,
} from '../attention/types'
import { APP_STATUSES, ARTIFACT_KINDS, ARTIFACT_STATUSES, MODULE_STATUSES, TOOL_STATUSES } from '../foundry/types'

/**
 * The closed vocabularies the Personality event payloads are checked against.
 *
 * Derived from the domain's own tables rather than restated, so a vocabulary that
 * grows cannot leave the journal validator accepting something the domain would
 * refuse. `SOURCE_TRUST_RANK` is used for the source classes because it is keyed
 * by exactly that closed union.
 */
const PERSONALITY_OPERATION_SET: ReadonlySet<string> = new Set([
  'admitted',
  'rejected',
  'withdrawn',
  'retired',
  'superseded',
])
const PERSONALITY_KIND_SET: ReadonlySet<string> = new Set(RELATIONSHIP_ITEM_KINDS)
const PERSONALITY_LIFECYCLE_SET: ReadonlySet<string> = new Set(RELATIONSHIP_LIFECYCLE_REASONS)
const PERSONALITY_SOURCE_SET: ReadonlySet<string> = new Set(Object.keys(SOURCE_TRUST_RANK))
/** `verified` is excluded: no relationship record may ever claim it. */
const PERSONALITY_CONFIDENCE_SET: ReadonlySet<string> = new Set([
  'unknown',
  'low',
  'medium',
  'high',
])

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

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value)
}

function isClosedValue(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value)
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

/** A bounded opaque string that is not required to be a bare id (a dedupe key). */
function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** A goal reference: null, or an id. */
function isNullableRef(value: unknown): value is string | null {
  return value === null || isEventId(value)
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

/** Closed reason codes. A Mission event cannot carry free text as a reason. */
const MISSION_REASON_CODES: ReadonlySet<string> = new Set([
  'owner',
  'verification_passed',
  'verification_not_established',
  'verification_timeout',
  'no_child_runs',
  'child_run_failed',
  'child_run_cancelled',
  'child_run_unverified',
  'deadline_expired',
  'child_run_limit',
  'concurrent_run_limit',
  'retention_limit',
  'lifetime_limit',
  'recovery',
  'shutdown',
])

/**
 * A lifecycle transition.
 *
 * `from` and `to` are checked against the closed tables here as well as in the
 * reducer. Validation is the door a replayed journal comes through, so an illegal
 * pair should be refused before it ever reaches the fold.
 */
const MISSION_TRANSITION = workRule(
  ['missionId', 'from', 'to', 'reason', 'verifierId'],
  (p) =>
    isEventId(p.missionId) &&
    MISSION_STATUS_SET.has(p.from as string) &&
    MISSION_STATUS_SET.has(p.to as string) &&
    (p.reason === null || MISSION_REASON_CODES.has(p.reason as string)) &&
    (p.verifierId === null || isEventId(p.verifierId)),
)

const MISSION_STATUS_SET: ReadonlySet<string> = new Set([
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
])

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

  /* --------------------------------------------------- personality (P11) */

  // Metadata only, and the exact-key check is load-bearing here for the same
  // reason it is for the research stages: an extra field is retained and simply
  // ignored without it, and an ignored field in a journal is a field somebody will
  // eventually trust. These two payloads have no slot for a recorded text, an
  // owner's clause or a sentence, so none can reach this file even by hand.
  'personality.record_changed': (p) =>
    exactKeys(p, [
      'operation',
      'itemId',
      'kind',
      'key',
      'sourceType',
      'confidence',
      'lifecycleReason',
      'admitted',
      'retained',
    ]) &&
    PERSONALITY_OPERATION_SET.has(p.operation as string) &&
    isEventId(p.itemId) &&
    PERSONALITY_KIND_SET.has(p.kind as string) &&
    isSlug(p.key) &&
    PERSONALITY_SOURCE_SET.has(p.sourceType as string) &&
    PERSONALITY_CONFIDENCE_SET.has(p.confidence as string) &&
    (p.lifecycleReason === null || PERSONALITY_LIFECYCLE_SET.has(p.lifecycleReason as string)) &&
    isNonNegativeInt(p.admitted) &&
    isNonNegativeInt(p.retained),

  'personality.degraded': (p) =>
    exactKeys(p, ['reason', 'mode', 'durable']) &&
    isNonEmptyString(p.reason) &&
    (p.mode === 'encrypted' || p.mode === 'ephemeral') &&
    p.durable === false,

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

  /* --------------------------------------------------------------- mission */

  // `workRule` refuses a field the schema does not name. That property is the whole
  // reason a Mission journal is safe to keep: a Mission holds what a person is
  // trying to achieve, there is no slot for a title or an intent, and a hand-edited
  // line cannot attach one because the key set is checked exactly.
  'mission.created': workRule(
    ['missionId', 'status', 'createdAt', 'deadlineAt', 'limits'],
    (p) =>
      isEventId(p.missionId) &&
      p.status === 'draft' &&
      isInstant(p.createdAt) &&
      isInstant(p.deadlineAt) &&
      isMissionLimits(p.limits),
  ),

  'mission.activated': MISSION_TRANSITION,
  'mission.resumed': MISSION_TRANSITION,
  'mission.paused': MISSION_TRANSITION,
  'mission.cancelled': MISSION_TRANSITION,
  'mission.failed': MISSION_TRANSITION,
  'mission.completed': MISSION_TRANSITION,

  'mission.run.attached': workRule(
    ['missionId', 'runId', 'taskId'],
    (p) =>
      isEventId(p.missionId) && isEventId(p.runId) && (p.taskId === null || isEventId(p.taskId)),
  ),

  'mission.verification.requested': workRule(
    ['missionId', 'verifierId', 'runIds'],
    (p) =>
      isEventId(p.missionId) &&
      isEventId(p.verifierId) &&
      isIdList(p.runIds),
  ),

  'mission.verification.completed': workRule(
    ['missionId', 'verifierId', 'outcome', 'reason'],
    (p) =>
      isEventId(p.missionId) &&
      isEventId(p.verifierId) &&
      (p.outcome === 'passed' ||
        p.outcome === 'not_established' ||
        p.outcome === 'timeout' ||
        p.outcome === 'cancelled') &&
      // A closed code, never a verifier's message. `reason` being free text here
      // would make the verifier the one component able to write to the journal.
      (p.reason === null || MISSION_REASON_CODES.has(p.reason as string)),
  ),

  'mission.limit.exceeded': workRule(
    ['missionId', 'limit'],
    (p) =>
      isEventId(p.missionId) &&
      (p.limit === 'maxChildRuns' || p.limit === 'maxConcurrentChildRuns' || p.limit === 'lifetimeMs'),
  ),

  /* ------------------------------------------------------------- workforce */

  // The strictest family in the journal, and the one with the most to lose.
  //
  // A workforce event describes who Freya's subordinates are and what they were
  // allowed to attempt. So every rule below reads named fields *and* checks the key
  // set exactly, which means a hand-edited line cannot attach a message body, a
  // context item, a grant, a trust flag or a `decision: 'granted'` — there is no
  // spelling of these payloads that carries authority.
  'workforce.worker.created': workRule(
    ['workerId', 'name', 'specialisation', 'status', 'createdAt', 'budget'],
    (p) =>
      isEventId(p.workerId) &&
      isBoundedName(p.name, WORKFORCE_LIMITS.maxNameChars) &&
      isSpecialisation(p.specialisation) &&
      p.status === 'idle' &&
      isInstant(p.createdAt) &&
      isWorkerBudgetPayload(p.budget),
  ),

  'workforce.worker.transitioned': workRule(
    ['workerId', 'from', 'to', 'reason'],
    (p) =>
      isEventId(p.workerId) &&
      WORKER_STATUS_SET.has(p.from as string) &&
      WORKER_STATUS_SET.has(p.to as string) &&
      (p.reason === null || WORKFORCE_REASON_CODES.has(p.reason as string)),
  ),

  'workforce.worker.reconciled': workRule(
    ['workerId', 'previousStatus', 'reason'],
    (p) =>
      isEventId(p.workerId) &&
      WORKER_STATUS_SET.has(p.previousStatus as string) &&
      WORKFORCE_REASON_CODES.has(p.reason as string),
  ),

  // The load-bearing check in this file. `isAssignableToWorker` consults the *closed
  // worker vocabulary* (`WORKER_CAPABILITIES`), which excludes every `work.*`,
  // `mission.*`, `workforce.*`, `security.*` and `cognition.grant.manage` entry. A
  // forged line naming one of those is refused here, before it can reach a fold, and
  // refused again by `state.ts`. Two independent refusals, because "the only place a
  // worker's authority exists is a durable line" is a strong enough claim to earn
  // being checked twice.
  'workforce.capability.assigned': workRule(
    ['workerId', 'capability'],
    (p) => isEventId(p.workerId) && isAssignableToWorker(p.capability),
  ),

  'workforce.context.assigned': workRule(
    ['workerId', 'contextRef'],
    // An id, and only an id. `normaliseContextRef` is the same predicate Phase 9's
    // references will have to satisfy, so a context item's *content* cannot be smuggled
    // into a field named after one.
    (p) => isEventId(p.workerId) && normaliseContextRef(p.contextRef) !== null,
  ),

  'workforce.team.created': workRule(
    ['teamId', 'name', 'specialisation', 'status', 'createdAt'],
    (p) =>
      isEventId(p.teamId) &&
      isBoundedName(p.name, WORKFORCE_LIMITS.maxTeamNameChars) &&
      (p.specialisation === null || isSpecialisation(p.specialisation)) &&
      p.status === 'active' &&
      isInstant(p.createdAt),
  ),

  'workforce.team.transitioned': workRule(
    ['teamId', 'from', 'to', 'reason'],
    (p) =>
      isEventId(p.teamId) &&
      p.from === 'active' &&
      p.to === 'disbanded' &&
      (p.reason === null || WORKFORCE_REASON_CODES.has(p.reason as string)),
  ),

  'workforce.team.member.changed': workRule(
    ['teamId', 'workerId', 'present'],
    (p) => isEventId(p.teamId) && isEventId(p.workerId) && typeof p.present === 'boolean',
  ),

  'workforce.assignment.created': workRule(
    [
      'assignmentId',
      'workerId',
      'status',
      'createdAt',
      'deadlineAt',
      'budget',
      'missionId',
      'capabilities',
      'contextRefs',
    ],
    (p) =>
      isEventId(p.assignmentId) &&
      isEventId(p.workerId) &&
      p.status === 'open' &&
      isInstant(p.createdAt) &&
      isInstant(p.deadlineAt) &&
      isWorkerBudgetPayload(p.budget) &&
      (p.missionId === null || isEventId(p.missionId)) &&
      // Every element assignable to a worker, and a bounded list of ids. Same reasoning
      // as the capability rule: an assignment's scope is authority, so it is checked
      // against the closed vocabulary rather than merely being an array of strings.
      isAssignableCapabilityList(p.capabilities, WORKFORCE_LIMITS.maxContextRefsPerWorker) &&
      isContextRefList(p.contextRefs),
  ),

  'workforce.assignment.settled': workRule(
    ['assignmentId', 'from', 'to', 'reason'],
    (p) =>
      isEventId(p.assignmentId) &&
      ASSIGNMENT_STATUS_SET.has(p.from as string) &&
      p.from === 'open' &&
      ASSIGNMENT_TERMINAL_SET.has(p.to as string) &&
      (p.reason === null || WORKFORCE_REASON_CODES.has(p.reason as string)),
  ),

  // `decision` has one legal spelling. A line claiming a claim was granted cannot
  // validate, which is the structural form of "claims are data, never authority".
  'workforce.claim.recorded': workRule(
    ['claimId', 'workerId', 'kind', 'subject', 'decision', 'refusal'],
    (p) =>
      isEventId(p.claimId) &&
      isEventId(p.workerId) &&
      WORKFORCE_CLAIM_KIND_SET.has(p.kind as string) &&
      isNonEmptyString(p.subject) &&
      p.subject.length <= 256 &&
      p.decision === 'refused' &&
      WORKFORCE_CLAIM_REFUSAL_SET.has(p.refusal as string),
  ),

  // The body is measured. `bodyLength` is the only trace of an agent message that
  // leaves this process, and it exists so an operator can see a substantial message
  // happened without the journal becoming a transcript of the workforce talking.
  'workforce.message.sent': workRule(
    ['messageId', 'fromWorkerId', 'toWorkerId', 'kind', 'bodyLength', 'sameTeam'],
    (p) =>
      isEventId(p.messageId) &&
      // Both ends are *worker* ids rather than principal ids, and that is deliberate: the
      // envelope's `actor` already carries the sending agent's principal (validated by
      // `isPrincipalId` on every replay), so naming it again here would be a second,
      // weaker copy of the same claim. These are the ids the fold keys its state on, and
      // they must be event ids or the fold would hold unreferenceable records.
      isEventId(p.fromWorkerId) &&
      isEventId(p.toWorkerId) &&
      // A message to oneself is not a message, and it would otherwise be the cheapest way
      // to inflate a mailbox count.
      p.fromWorkerId !== p.toWorkerId &&
      WORKFORCE_MESSAGE_KIND_SET.has(p.kind as string) &&
      isNonNegativeInt(p.bodyLength) &&
      typeof p.sameTeam === 'boolean',
  ),

  'workforce.limit.exceeded': workRule(
    ['workerId', 'limit'],
    (p) => isEventId(p.workerId) && WORKFORCE_LIMIT_NAME_SET.has(p.limit as string),
  ),

  // Budget spend, and the reason it is durable at all.
  //
  // `calls` may be 0 and `outputTokens` may be null, because the honest statement is
  // sometimes "a call happened and I do not know what it cost". A schema that demanded
  // a positive count and a positive token figure would force one of the two to be
  // invented, and an invented budget figure is worse than a missing one.
  'workforce.cognition.recorded': workRule(
    ['workerId', 'calls', 'outputTokens'],
    (p) =>
      isEventId(p.workerId) &&
      isNonNegativeInt(p.calls) &&
      (p.outputTokens === null || isPositiveInt(p.outputTokens)),
  ),

  /* ------------------------------------------------------------- attention */

  // Metadata only, and the rule is Work's: an undeclared key is refused rather
  // than ignored, because the whole safety argument for keeping attention in this
  // file is that there is no slot the event's text could occupy.
  'attention.event.ingested': workRule(
    ['eventId', 'dedupeKey', 'source', 'kind', 'goalRef', 'textLength', 'severityHint', 'occurredAt', 'dueAt'],
    (p) =>
      isEventId(p.eventId) &&
      isBoundedText(p.dedupeKey, 384) &&
      isAttentionSource(p.source) &&
      isAttentionEventKind(p.kind) &&
      isNullableRef(p.goalRef) &&
      isNonNegativeInt(p.textLength) &&
      isSeverityHint(p.severityHint) &&
      isInstant(p.occurredAt) &&
      (p.dueAt === null || isInstant(p.dueAt)),
  ),

  'attention.decision.made': workRule(
    ['decisionId', 'eventId', 'source', 'kind', 'goalRef', 'outcome', 'importance', 'urgency', 'reason', 'cueCode', 'focus'],
    (p) =>
      isEventId(p.decisionId) &&
      isEventId(p.eventId) &&
      isAttentionSource(p.source) &&
      isAttentionEventKind(p.kind) &&
      isNullableRef(p.goalRef) &&
      isAttentionOutcome(p.outcome) &&
      isImportanceLevel(p.importance) &&
      isUrgencyLevel(p.urgency) &&
      isAttentionReason(p.reason) &&
      (p.cueCode === null || isAttentionCueCode(p.cueCode)) &&
      isFocusState(p.focus),
  ),

  'attention.budget.exceeded': workRule(
    ['source', 'goalRef', 'limit', 'observed'],
    (p) =>
      isAttentionSource(p.source) &&
      isNullableRef(p.goalRef) &&
      isNonEmptyString(p.limit) &&
      isNonNegativeInt(p.observed),
  ),

  'attention.schedule.registered': workRule(
    ['scheduleId', 'kind', 'goalRef', 'severityHint', 'dueAt', 'intervalMs', 'maxRepeats', 'condition'],
    (p) =>
      isEventId(p.scheduleId) &&
      isAttentionEventKind(p.kind) &&
      isNullableRef(p.goalRef) &&
      isSeverityHint(p.severityHint) &&
      isInstant(p.dueAt) &&
      (p.intervalMs === null || isPositiveInt(p.intervalMs)) &&
      isNonNegativeInt(p.maxRepeats) &&
      isAttentionCondition(p.condition),
  ),

  'attention.schedule.fired': workRule(
    ['scheduleId', 'eventId', 'repeats'],
    (p) => isEventId(p.scheduleId) && isEventId(p.eventId) && isNonNegativeInt(p.repeats),
  ),

  'attention.schedule.cancelled': workRule(
    ['scheduleId', 'reason'],
    (p) => isEventId(p.scheduleId) && isAttentionScheduleCancelReason(p.reason),
  ),

  'office.presence.requested': workRule(
    ['workerId'],
    (p) => isEventId(p.workerId),
  ),

  'office.presence.fulfilled': workRule(
    ['workerId'],
    (p) => isEventId(p.workerId),
  ),

  /* ------------------------------------------------------------- foundry */

  'foundry.artifact.created': workRule(
    ['artifactId', 'hash', 'kind', 'runId', 'stepId', 'createdBy', 'parentHash', 'specHash', 'contentLength'],
    (p) =>
      isEventId(p.artifactId) &&
      isSha256Hex(p.hash) &&
      isClosedValue(p.kind, ARTIFACT_KINDS) &&
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isPrincipalId(p.createdBy) &&
      (p.parentHash === null || isSha256Hex(p.parentHash)) &&
      (p.specHash === null || isSha256Hex(p.specHash)) &&
      isNonNegativeInt(p.contentLength),
  ),

  'foundry.artifact.transitioned': workRule(
    ['artifactId', 'toStatus'],
    (p) => isEventId(p.artifactId) && isClosedValue(p.toStatus, ARTIFACT_STATUSES),
  ),

  'foundry.verification.recorded': workRule(
    ['verificationId', 'artifactHash', 'verifierName', 'verdict', 'evidenceHash', 'evidenceLength', 'verifiedAt', 'requestedBy'],
    (p) =>
      isEventId(p.verificationId) &&
      isSha256Hex(p.artifactHash) &&
      isNonEmptyString(p.verifierName) &&
      (p.verdict === 'passed' || p.verdict === 'failed' || p.verdict === 'inconclusive') &&
      isSha256Hex(p.evidenceHash) &&
      isNonNegativeInt(p.evidenceLength) &&
      isInstant(p.verifiedAt) &&
      isPrincipalId(p.requestedBy),
  ),

  'foundry.promotion.recorded': workRule(
    ['promotionId', 'artifactHash', 'fromStatus', 'toStatus', 'promotedBy', 'promotedAt', 'reason', 'verificationId'],
    (p) =>
      isEventId(p.promotionId) &&
      isSha256Hex(p.artifactHash) &&
      isClosedValue(p.fromStatus, ARTIFACT_STATUSES) &&
      p.toStatus === 'promoted' &&
      isPrincipalId(p.promotedBy) &&
      isInstant(p.promotedAt) &&
      isNonEmptyString(p.reason) &&
      isEventId(p.verificationId),
  ),

  'foundry.activation.recorded': workRule(
    ['activationId', 'artifactHash', 'fromStatus', 'toStatus', 'activatedBy', 'activatedAt', 'reason', 'expiresAt'],
    (p) =>
      isEventId(p.activationId) &&
      isSha256Hex(p.artifactHash) &&
      isClosedValue(p.fromStatus, ARTIFACT_STATUSES) &&
      p.toStatus === 'active' &&
      isPrincipalId(p.activatedBy) &&
      isInstant(p.activatedAt) &&
      isNonEmptyString(p.reason) &&
      (p.expiresAt === null || isInstant(p.expiresAt)),
  ),

  'foundry.tool.registered': workRule(
    ['toolId', 'hash', 'name', 'capability', 'createdBy', 'artifactHash'],
    (p) =>
      isEventId(p.toolId) &&
      isNonEmptyString(p.hash) &&
      isNonEmptyString(p.name) &&
      isCapability(p.capability) &&
      isPrincipalId(p.createdBy) &&
      isNonEmptyString(p.artifactHash),
  ),

  'foundry.tool.transitioned': workRule(
    ['toolId', 'toStatus'],
    (p) => isEventId(p.toolId) && isClosedValue(p.toStatus, TOOL_STATUSES),
  ),

  'foundry.module.registered': workRule(
    ['moduleId', 'hash', 'name', 'createdBy', 'artifactHash'],
    (p) =>
      isEventId(p.moduleId) &&
      isNonEmptyString(p.hash) &&
      isNonEmptyString(p.name) &&
      isPrincipalId(p.createdBy) &&
      isNonEmptyString(p.artifactHash),
  ),

  'foundry.module.transitioned': workRule(
    ['moduleId', 'toStatus'],
    (p) => isEventId(p.moduleId) && isClosedValue(p.toStatus, MODULE_STATUSES),
  ),

  'foundry.app.registered': workRule(
    ['appId', 'hash', 'name', 'createdBy', 'artifactHash', 'moduleHashes'],
    (p) =>
      isEventId(p.appId) &&
      isNonEmptyString(p.hash) &&
      isNonEmptyString(p.name) &&
      isPrincipalId(p.createdBy) &&
      isNonEmptyString(p.artifactHash) &&
      Array.isArray(p.moduleHashes) &&
      p.moduleHashes.every((h: unknown) => isNonEmptyString(h)),
  ),

  'foundry.app.transitioned': workRule(
    ['appId', 'toStatus'],
    (p) => isEventId(p.appId) && isClosedValue(p.toStatus, APP_STATUSES),
  ),

  'foundry.limit.exceeded': workRule(
    ['limit', 'reason'],
    (p) => isNonEmptyString(p.limit) && isNonEmptyString(p.reason),
  ),
}

/** A bounded, control-character-free label. A name, never prose. */
function isBoundedName(value: unknown, max: number): boolean {
  return typeof value === 'string' && normaliseWorkforceName(value, max) !== null
}

function isSpecialisation(value: unknown): boolean {
  return isWorkerSpecialisation(value)
}

/**
 * A list of capabilities, every element assignable to a worker.
 *
 * Refused wholesale rather than filtered, for the reason Brain admission refuses
 * rather than repairs: an assignment whose scope silently lost one element looks like
 * valid work that was simply scoped smaller, and the difference is invisible in review.
 */
function isAssignableCapabilityList(value: unknown, max: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => isAssignableToWorker(item))
  )
}

function isContextRefList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= WORKFORCE_LIMITS.maxContextRefsPerWorker &&
    value.every((item) => normaliseContextRef(item) !== null)
  )
}

/**
 * A worker's durable budget, re-checked against the code-owned ceilings.
 *
 * Positive integers and no value above its ceiling: a budget that exists only on disk
 * is not a budget.
 */
function isWorkerBudgetPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const budget = value as Record<string, unknown>
  if (!onlyNamedKeys(budget, Object.keys(DEFAULT_WORKER_BUDGET))) return false
  if (!Object.values(budget).every(isPositiveInt)) return false
  for (const [key, ceiling] of Object.entries(DEFAULT_WORKER_BUDGET)) {
    if ((budget[key] as number) > ceiling) return false
  }
  return true
}

const WORKER_STATUS_SET: ReadonlySet<string> = new Set([
  'idle',
  'working',
  'blocked',
  'stopped',
  'retired',
])

const ASSIGNMENT_STATUS_SET: ReadonlySet<string> = new Set(['open', 'completed', 'failed', 'cancelled'])

const ASSIGNMENT_TERMINAL_SET: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

const WORKFORCE_MESSAGE_KIND_SET: ReadonlySet<string> = new Set(['request', 'finding', 'handoff', 'status'])

const WORKFORCE_CLAIM_KIND_SET: ReadonlySet<string> = new Set(['capability', 'context'])

const WORKFORCE_CLAIM_REFUSAL_SET: ReadonlySet<string> = new Set([
  'claims_are_not_authority',
  'capability_not_assignable',
  'capability_already_held',
  'context_not_assignable',
  'context_already_assigned',
  'no_such_worker',
  'worker_retired',
])

/** Both the global ceilings and the per-worker budgets a limit event may name. */
const WORKFORCE_LIMIT_NAME_SET: ReadonlySet<string> = new Set([
  'maxWorkers',
  'maxTeams',
  'maxMembersPerTeam',
  'maxTeamsPerWorker',
  'maxContextRefsPerWorker',
  'maxConcurrentAssignments',
  'maxRetainedClaims',
  'maxMailboxMessages',
  'maxNameChars',
  'maxTeamNameChars',
  'maxMessageChars',
  'maxAssignments',
  'maxOpenAssignments',
  'maxAssignmentMs',
  'maxCognitionCalls',
  'maxCognitionTokens',
  'maxMessages',
])

/** Closed reason codes, mirroring `WORKFORCE_REASONS` in `core/workforce/types.ts`. */
const WORKFORCE_REASON_CODES: ReadonlySet<string> = new Set([
  'owner',
  'assignment',
  'assignment_completed',
  'assignment_failed',
  'assignment_cancelled',
  'assignment_expired',
  'owner_suspended',
  'owner_resumed',
  'stop_all',
  'retirement',
  'limit',
  'recovery',
  'shutdown',
])

function isIdList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
  )
}

/**
 * Mission ceilings as they appear in a durable record.
 *
 * Positive integers, re-checked against the code-owned ceilings on read: a
 * hand-edited `maxChildRuns: 1000000` must not become a real ceiling the engine
 * enforces, because then the only limit would exist on disk.
 */
function isMissionLimits(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const limits = value as Record<string, unknown>
  if (!onlyNamedKeys(limits, Object.keys(DEFAULT_MISSION_LIMITS))) return false
  if (!Object.values(limits).every(isPositiveInt)) return false
  for (const [key, ceiling] of Object.entries(DEFAULT_MISSION_LIMITS)) {
    if ((limits[key] as number) > ceiling) return false
  }
  return true
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
