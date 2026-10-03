import {
  CORE_EVENT_SCHEMA_VERSION,
  CORE_EVENT_TYPES,
  type AnyCoreEvent,
  type CoreEventType,
} from './envelope'
import { isCapability, isPrincipalId } from '../security/guard'
import {
  DECIDE_OUTCOMES,
  FORBIDDEN_PAYLOAD_KEYS,
  LIFE_LOOP_CLOSE_OUT_CODES,
  LIFE_LOOP_DECISIONS,
  LIFE_LOOP_LIMITS,
  LIFE_LOOP_STOP_CODES,
  LIFE_LOOP_WAIT_CODES,
  OWNER_ESCALATIONS,
  WAKE_KIND_SOURCE,
  isContinuationState,
  isReconciliationCode,
  isWakeKind,
  isWakeSource,
} from '../lifeloop/types'

function isDeadlineType(value: unknown): boolean {
  return (
    value === 'verification' || value === 'approval' || value === 'wait' || value === 'action'
  )
}
import { DEFAULT_MISSION_LIMITS, MISSION_REASONS } from '../missions/types'
import { DEFAULT_GOAL_LIMITS, GOAL_REASONS } from '../longhorizon/types'
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
import {
  EVALUATION_AUTHORS,
  EVALUATION_REASONS,
  EVALUATION_SUBJECT_KINDS,
  isImprovementTarget,
  isSkillKind,
  isSkillRefusalCode,
  isSkillRetirementReason,
  isSkillSource,
  isSkillTrustClass,
  isSkillVerdict,
  SKILL_LIMITS,
  SKILL_STATUSES,
} from '../skills/types'
import { PROMOTION_REASONS } from '../skills/promotion'
import { targetIsProtected } from '../skills/state'

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
import {
  isRelayAction,
  isRelayConnectorId,
  isRelayFailureCode,
  isRelayRiskClass,
} from '../relay/types'

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
 * - **torn tail** â€” the log ends part-way through a line. That is what a crash
 *   during a write looks like: the bytes after the last complete line were never
 *   committed. The prefix is the whole truth, and recovery is ordinary.
 *
 * - **corruption** â€” a *complete* line failed validation, or there was more data
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

/**
 * A life-loop wake reference, which may legitimately be *absent*.
 *
 * Three of the loop's seventeen events describe something that happened to the loop
 * rather than to a wake: a restart, the owner taking precedence, the owner clearing a
 * stop. Those are exactly the events where there is no wake to name, and the
 * alternative â€” requiring a non-empty id â€” would mean inventing one.
 *
 * An empty string therefore means "no wake was held", and it is the honest encoding:
 * a lifecycle entry that carried a fabricated wake id would put an invented
 * reference into the durable record and could be mistaken later for a wake that
 * actually happened. The ceiling is still the life loop's 200-character payload
 * limit, enforced by `lifeLoopRule` on every value, so nothing here widens what a
 * payload may contain.
 */
function isOptionalWakeRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= LIFE_LOOP_LIMITS.maxPayloadTextLength
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
 * no stored message and an interrupted turn has no answer â€” and a schema that
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

/**
 * Closed reason codes, read from the domain's own tables rather than restated.
 *
 * A Mission event cannot carry free text as a reason, and the set of codes that may
 * appear is `MISSION_REASONS` itself: deriving it means a code added to the domain
 * cannot leave this validator rejecting a line Core would have written, and no code
 * can be accepted here that the domain would refuse.
 */
const MISSION_REASON_CODES: ReadonlySet<string> = new Set<string>(Object.keys(MISSION_REASONS))

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

/**
 * Closed reason codes for every goal event, read from `GOAL_REASONS` rather than
 * restated — the same reasoning as `MISSION_REASON_CODES`, and the reason one
 * definition serves goal creation, transitions, checkpoint outcomes and
 * cancellation rather than five drifting copies of it.
 */
const GOAL_REASON_CODES: ReadonlySet<string> = new Set<string>(Object.keys(GOAL_REASONS))

const GOAL_STATE_SET: ReadonlySet<string> = new Set([
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
])

/** The name/applicability slug shape, checked identically everywhere. */
const SKILL_SLUG = /^[a-z0-9][a-z0-9-]*$/

const SKILL_STATUS_SET: ReadonlySet<string> = new Set(SKILL_STATUSES)
const EVALUATION_SUBJECT_KIND_SET: ReadonlySet<string> = new Set(EVALUATION_SUBJECT_KINDS)
const EVALUATION_AUTHOR_SET: ReadonlySet<string> = new Set(EVALUATION_AUTHORS)
const EVALUATION_REASON_SET: ReadonlySet<string> = new Set(EVALUATION_REASONS)
const PROMOTION_REASON_SET: ReadonlySet<string> = new Set(PROMOTION_REASONS)
// `SKILL_REFUSAL_CODES` is read through `isSkillRefusalCode` rather than through a
// second Set, so there is exactly one closed list of refusal codes in the build.

/**
 * One admitted or revised skill version.
 *
 * `applicability` is a bounded list of the *same* slug shape as a name, checked
 * exactly. That is the one piece of a skill's *content* the journal keeps, and the
 * justification is that selection has to match on it: a closed-shape token is what
 * makes "which procedures apply here?" an auditable question rather than a fuzzy one.
 * A sentence could not be in that field, and the length bound means it cannot hide one.
 */
const SKILL_VERSION = workRule(
  [
    'skillId',
    'name',
    'nameLength',
    'kind',
    'version',
    'contentHash',
    'source',
    'trustClass',
    'admittedBy',
    'originRef',
    'stepCount',
    'requiredCapabilityCount',
    'applicabilityCount',
    'applicability',
    'inputCount',
    'outputCount',
    'preconditionCount',
    'postconditionCount',
    'summaryLength',
  ],
  (p) =>
    isEventId(p.skillId) &&
    typeof p.name === 'string' &&
    SKILL_SLUG.test(p.name) &&
    p.name.length <= SKILL_LIMITS.maxNameChars &&
    isPositiveInt(p.nameLength) &&
    isSkillKind(p.kind) &&
    isPositiveInt(p.version) &&
    typeof p.contentHash === 'string' &&
    /^[a-f0-9]{8,64}$/.test(p.contentHash) &&
    isSkillSource(p.source) &&
    isSkillTrustClass(p.trustClass) &&
    isNonEmptyString(p.admittedBy) &&
    (p.originRef === null || isNonEmptyString(p.originRef)) &&
    isNonNegativeInt(p.stepCount) &&
    isNonNegativeInt(p.requiredCapabilityCount) &&
    isNonNegativeInt(p.applicabilityCount) &&
    Array.isArray(p.applicability) &&
    p.applicability.length <= SKILL_LIMITS.maxApplicabilityTags &&
    p.applicability.every(
      (tag) =>
        typeof tag === 'string' && tag.length > 0 && tag.length <= SKILL_LIMITS.maxTagChars && SKILL_SLUG.test(tag),
    ) &&
    p.applicabilityCount === p.applicability.length &&
    isNonNegativeInt(p.inputCount) &&
    isNonNegativeInt(p.outputCount) &&
    isNonNegativeInt(p.preconditionCount) &&
    isNonNegativeInt(p.postconditionCount) &&
    isNonNegativeInt(p.summaryLength),
)

/** Four integers the promotion engine counted itself. */
function isPromotionEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const evidence = value as Record<string, unknown>
  return (
    onlyNamedKeys(evidence, ['version', 'established', 'contradicted', 'distinctSubjects']) &&
    isPositiveInt(evidence.version) &&
    isNonNegativeInt(evidence.established) &&
    isNonNegativeInt(evidence.contradicted) &&
    isNonNegativeInt(evidence.distinctSubjects)
  )
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
  // accounting cannot be trusted â€” and refusing to read the line is the
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
  // metadata, and this is the list of what "metadata" is allowed to mean â€” a
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
  // cannot smuggle a field the schema does not name â€” which for the Brain is the
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

  /**
   * Life History (Phase 21).
   *
   * Three types the Life engine emits, declared here because an event type the engine can
   * write and the journal cannot parse ends the log on the next start. Metadata only:
   * ids, closed labels, a revision number and the measured lengths of the three
   * text-bearing fields. There is no slot for an entry's title, summary or body, so
   * neither the engine nor a hand-edited line can put a day of someone's life into the
   * journal's most-read file.
   */
  'life.entry.recorded': (p) =>
    isEventId(p.entryId) &&
    isNonEmptyString(p.kind) &&
    isNonEmptyString(p.derivation) &&
    isNonEmptyString(p.confidence) &&
    isNonEmptyString(p.salience) &&
    isNonEmptyString(p.status) &&
    isPositiveInt(p.revision) &&
    isNonEmptyString(p.sourceDomain) &&
    (p.sourceId === null || isEventId(p.sourceId)) &&
    typeof p.occurredAtKnown === 'boolean' &&
    isNonNegativeInt(p.titleLength) &&
    isNonNegativeInt(p.summaryLength) &&
    isNonNegativeInt(p.bodyLength) &&
    isNonNegativeInt(p.referenceCount) &&
    isNonNegativeInt(p.conflictCount),
  'life.entry.withdrawn': (p) =>
    isEventId(p.entryId) &&
    isPositiveInt(p.revision) &&
    isBoundedText(p.reason, 500),
  'life.conflict.detected': (p) =>
    isEventId(p.conflictId) &&
    isEventId(p.entryA) &&
    isEventId(p.entryB),
  'life.degraded': (p) => isNonEmptyString(p.reason),

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
  // they read named fields rather than passing the object through â€” so a
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

  /* --------------------------------------------------------- long-horizon */

  // The strictest family in the journal after Mission, and for the same reason: a
  // goal holds what a person is trying to achieve. So every rule below reads named
  // fields *and* checks the key set exactly, which means a hand-edited line cannot
  // attach a title, a description or a completion criterion â€” there is no spelling of
  // these payloads that carries content.
  'longhorizon.goal.created': workRule(
    ['goalId', 'state', 'createdAt', 'deadlineAt', 'dependencies', 'limits'],
    (p) =>
      isEventId(p.goalId) &&
      p.state === 'draft' &&
      isInstant(p.createdAt) &&
      isInstant(p.deadlineAt) &&
      isIdList(p.dependencies) &&
      isGoalLimits(p.limits),
  ),

  'longhorizon.goal.state-changed': workRule(
    ['goalId', 'from', 'to', 'reason'],
    (p) =>
      isEventId(p.goalId) &&
      GOAL_STATE_SET.has(p.from as string) &&
      GOAL_STATE_SET.has(p.to as string) &&
      (p.reason === null || GOAL_REASON_CODES.has(p.reason as string)),
  ),

  'longhorizon.goal.completed': workRule(
    ['goalId', 'verifierId'],
    (p) => isEventId(p.goalId) && isEventId(p.verifierId),
  ),

  'longhorizon.goal.failed': workRule(
    ['goalId', 'reason'],
    (p) => isEventId(p.goalId) && (p.reason === null || GOAL_REASON_CODES.has(p.reason as string)),
  ),

  'longhorizon.goal.cancelled': workRule(
    ['goalId', 'reason'],
    (p) => isEventId(p.goalId) && (p.reason === null || GOAL_REASON_CODES.has(p.reason as string)),
  ),

  'longhorizon.checkpoint.started': workRule(
    ['goalId', 'checkpointId', 'order', 'kind'],
    (p) =>
      isEventId(p.goalId) &&
      isEventId(p.checkpointId) &&
      isNonNegativeInt(p.order) &&
      isNonEmptyString(p.kind),
  ),

  'longhorizon.checkpoint.verified': workRule(
    ['goalId', 'checkpointId', 'outcome', 'reason'],
    (p) =>
      isEventId(p.goalId) &&
      isEventId(p.checkpointId) &&
      (p.outcome === 'passed' ||
        p.outcome === 'not_established' ||
        p.outcome === 'timeout' ||
        p.outcome === 'cancelled') &&
      (p.reason === null || GOAL_REASON_CODES.has(p.reason as string)),
  ),

  'longhorizon.checkpoint.failed': workRule(
    ['goalId', 'checkpointId', 'reason', 'attempts'],
    (p) =>
      isEventId(p.goalId) &&
      isEventId(p.checkpointId) &&
      GOAL_REASON_CODES.has(p.reason as string) &&
      isPositiveInt(p.attempts),
  ),

  'longhorizon.continuation.decided': workRule(
    ['goalId', 'decision', 'reason'],
    (p) =>
      isEventId(p.goalId) &&
      (p.decision === 'continue' ||
        p.decision === 'pause' ||
        p.decision === 'complete' ||
        p.decision === 'fail' ||
        p.decision === 'wait') &&
      isNonEmptyString(p.reason),
  ),

  'longhorizon.schedule.fired': workRule(
    ['scheduleId', 'goalId', 'wakeId'],
    (p) => isEventId(p.scheduleId) && isEventId(p.goalId) && isEventId(p.wakeId),
  ),

  'longhorizon.schedule.expired': workRule(
    ['scheduleId', 'goalId', 'reason'],
    (p) => isEventId(p.scheduleId) && isEventId(p.goalId) && isNonEmptyString(p.reason),
  ),

  'longhorizon.wake.received': workRule(
    ['wakeId', 'source', 'goalId'],
    (p) => isEventId(p.wakeId) && isNonEmptyString(p.source) && (p.goalId === null || isEventId(p.goalId)),
  ),

  'longhorizon.wake.denied': workRule(
    ['wakeId', 'source', 'goalId', 'reason'],
    (p) =>
      isEventId(p.wakeId) &&
      isNonEmptyString(p.source) &&
      (p.goalId === null || isEventId(p.goalId)) &&
      isNonEmptyString(p.reason),
  ),

  /* ------------------------------------------------------------- workforce */

  // The strictest family in the journal, and the one with the most to lose.
  //
  // A workforce event describes who Freya's subordinates are and what they were
  // allowed to attempt. So every rule below reads named fields *and* checks the key
  // set exactly, which means a hand-edited line cannot attach a message body, a
  // context item, a grant, a trust flag or a `decision: 'granted'` â€” there is no
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

  /* ------------------------------------------------- continuous life loop */

  /**
   * Life-loop payloads are validated against the loop's *own* published vocabulary,
   * not against a hand-copied list here.
   *
   * That is the whole reason the rule is `isLifeLoopPayload`. A validator that
   * enumerated the seventeen payload shapes separately from
   * `core/lifeloop/types.ts` would be a second source of truth that could fall out
   * of step with the first, and the failure would be silent: an unknown key would
   * be *accepted* by the journal and then *refused* by the fold as an anomaly, so
   * the log would contain an entry the loop itself considers tampering. Importing
   * the table means the journal can only ever accept what the loop declared.
   *
   * The closed-vocabulary check is therefore mandatory rather than advisory: an
   * entry carrying a key outside `LIFE_LOOP_PAYLOAD_KEYS`, or a key in
   * `FORBIDDEN_PAYLOAD_KEYS` â€” anything shaped like a capability, a grant, a
   * verdict or a budget â€” is corruption, because authority is minted by the Guard
   * and the Governor and never by an event.
   */
  'lifeloop.wake.received': lifeLoopRule(
    ['wakeId', 'source', 'kind', 'wakeKey', 'iteration', 'goalRef', 'sourceRef', 'occurredAt', 'observedAt'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isWakeSource(p.source) &&
      isWakeKind(p.kind) &&
      WAKE_KIND_SOURCE[p.kind as never] === p.source &&
      isOptionalWakeRef(p.wakeKey) &&
      // Zero-based, because the prefilter refuses once `iterationCount` has reached
      // the ceiling: a one-based counter would refuse the last permitted iteration
      // and quietly make `maxLoopIterations` one smaller than it says. A negative
      // value is still refused â€” a journal that counts backwards is not a journal
      // this fold can reason about.
      isNonNegativeInt(p.iteration) &&
      isNullableRef(p.goalRef) &&
      isNullableRef(p.sourceRef) &&
      isInstant(p.occurredAt) &&
      isInstant(p.observedAt),
  ),

  'lifeloop.wake.denied': lifeLoopRule(
    ['wakeId', 'source', 'code', 'iteration'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isWakeSource(p.source) &&
      isNonEmptyString(p.code) &&
      isNonNegativeInt(p.iteration),
  ),

  'lifeloop.filter.passed': lifeLoopRule(
    ['wakeId', 'wakeKey', 'code', 'iteration'],
    (p) =>
      isOptionalWakeRef(p.wakeId) && isOptionalWakeRef(p.wakeKey) && isNonEmptyString(p.code) && isNonNegativeInt(p.iteration),
  ),

  'lifeloop.filter.denied': lifeLoopRule(
    ['wakeId', 'wakeKey', 'outcome', 'code', 'deadlineType', 'deadlineExpiresAt', 'iteration'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isNonEmptyString(p.wakeKey) &&
      (p.outcome === 'deny' || p.outcome === 'wait') &&
      // A `wait`'s code is a **closed list**, and this is the one place in the
      // journal where that matters most: it is the only thing standing between
      // "Freya is holding something" and "Freya is holding something for ever". A
      // free-text code here would let a future writer name a hold the loop has no
      // ceiling for. A `deny`'s code is left open, because the filter's denial
      // vocabulary is published separately and is expected to grow with it.
      (p.outcome === 'wait' ? isClosedValue(p.code, LIFE_LOOP_WAIT_CODES) : isNonEmptyString(p.code)) &&
      (p.deadlineType === null || isDeadlineType(p.deadlineType)) &&
      (p.deadlineExpiresAt === null || isInstant(p.deadlineExpiresAt)) &&
      isNonNegativeInt(p.iteration),
  ),

  'lifeloop.cognition.requested': lifeLoopRule(
    ['wakeId', 'wakeKey', 'iteration', 'cognitionRequest'],
    (p) =>
      isOptionalWakeRef(p.wakeId) && isOptionalWakeRef(p.wakeKey) && isNonNegativeInt(p.iteration) && isNonEmptyString(p.cognitionRequest),
  ),

  'lifeloop.cognition.denied': lifeLoopRule(
    ['wakeId', 'wakeKey', 'code', 'iteration'],
    (p) =>
      isOptionalWakeRef(p.wakeId) && isOptionalWakeRef(p.wakeKey) && isNonEmptyString(p.code) && isNonNegativeInt(p.iteration),
  ),

  'lifeloop.action.started': lifeLoopRule(
    ['wakeId', 'iteration', 'actionIndex', 'deadlineType', 'deadlineExpiresAt'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isNonNegativeInt(p.iteration) &&
      isPositiveInt(p.actionIndex) &&
      (p.deadlineType === null || isDeadlineType(p.deadlineType)) &&
      (p.deadlineExpiresAt === null || isInstant(p.deadlineExpiresAt)),
  ),

  'lifeloop.action.completed': lifeLoopRule(
    ['wakeId', 'iteration', 'actionIndex'],
    (p) => isOptionalWakeRef(p.wakeId) && isNonNegativeInt(p.iteration) && isPositiveInt(p.actionIndex),
  ),

  'lifeloop.action.failed': lifeLoopRule(
    ['wakeId', 'iteration', 'actionIndex', 'code'],
    (p) =>
      isOptionalWakeRef(p.wakeId) && isNonNegativeInt(p.iteration) && isPositiveInt(p.actionIndex) && isNonEmptyString(p.code),
  ),

  'lifeloop.verification.started': lifeLoopRule(
    ['wakeId', 'iteration', 'verificationIndex', 'deadlineType', 'deadlineExpiresAt'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isNonNegativeInt(p.iteration) &&
      isPositiveInt(p.verificationIndex) &&
      (p.deadlineType === null || isDeadlineType(p.deadlineType)) &&
      (p.deadlineExpiresAt === null || isInstant(p.deadlineExpiresAt)),
  ),

  'lifeloop.verification.passed': lifeLoopRule(
    ['wakeId', 'iteration', 'verificationIndex'],
    (p) =>
      isOptionalWakeRef(p.wakeId) && isNonNegativeInt(p.iteration) && isPositiveInt(p.verificationIndex),
  ),

  'lifeloop.verification.failed': lifeLoopRule(
    ['wakeId', 'iteration', 'verificationIndex', 'code'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isNonNegativeInt(p.iteration) &&
      isPositiveInt(p.verificationIndex) &&
      isNonEmptyString(p.code),
  ),

  'lifeloop.continuation.decided': lifeLoopRule(
    ['wakeId', 'iteration', 'decision', 'outcome', 'escalation', 'attentionSuppressed', 'actionCount', 'verificationCount'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isNonNegativeInt(p.iteration) &&
      // Closed, and checked rather than merely declared: a `decision` free-text field
      // in a durable record is a place a caller could eventually write a sentence, and
      // `LIFE_LOOP_DECISIONS` is the whole vocabulary of what the loop may have decided.
      isClosedValue(p.decision, LIFE_LOOP_DECISIONS) &&
      (p.outcome === null || isClosedValue(p.outcome, DECIDE_OUTCOMES)) &&
      (p.escalation === null || isClosedValue(p.escalation, OWNER_ESCALATIONS)) &&
      typeof p.attentionSuppressed === 'boolean' &&
      isNonNegativeInt(p.actionCount) &&
      isNonNegativeInt(p.verificationCount),
  ),

  'lifeloop.reconciled': lifeLoopRule(
    ['code', 'from', 'deadlineType', 'deadlineExpiresAt', 'wakeId', 'iteration'],
    (p) =>
      isReconciliationCode(p.code) &&
      isContinuationState(p.from) &&
      (p.deadlineType === null || isDeadlineType(p.deadlineType)) &&
      (p.deadlineExpiresAt === null || isInstant(p.deadlineExpiresAt)) &&
      isOptionalWakeRef(p.wakeId) &&
      isNonNegativeInt(p.iteration),
  ),

  'lifeloop.unstopped': lifeLoopRule(
    ['code'],
    (p) => isReconciliationCode(p.code),
  ),

  'lifeloop.reset': lifeLoopRule(
    ['wakeId', 'iteration', 'code'],
    (p) => isOptionalWakeRef(p.wakeId) && isNonNegativeInt(p.iteration) && isClosedValue(p.code, LIFE_LOOP_CLOSE_OUT_CODES),
  ),

  'lifeloop.stopped': lifeLoopRule(
    ['wakeId', 'iteration', 'code'],
    (p) =>
      isOptionalWakeRef(p.wakeId) &&
      isNonNegativeInt(p.iteration) &&
      (p.code === null || isClosedValue(p.code, LIFE_LOOP_STOP_CODES)),
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

  /* ----------------------------------------------------------------- relay */

  // Metadata only, and the rule is Work's: an undeclared key is refused rather
  // than ignored. The `summary` field is the only human-readable value in the
  // family, and it is bounded â€” a summary that could hold a paragraph would be
  // a summary that could hold a message body.
  'relay.action.requested': workRule(
    ['actionId', 'connector', 'action', 'risk', 'idempotencyKey', 'summary'],
    (p) =>
      isEventId(p.actionId) &&
      isRelayConnectorId(p.connector) &&
      isRelayAction(p.action) &&
      isRelayRiskClass(p.risk) &&
      isBoundedText(p.idempotencyKey, 128) &&
      isBoundedText(p.summary, 400),
  ),

  'relay.approval.requested': workRule(
    ['approvalId', 'actionId', 'connector', 'action', 'risk', 'summary'],
    (p) =>
      isEventId(p.approvalId) &&
      isEventId(p.actionId) &&
      isRelayConnectorId(p.connector) &&
      isRelayAction(p.action) &&
      isRelayRiskClass(p.risk) &&
      isBoundedText(p.summary, 400),
  ),

  'relay.approval.decided': workRule(
    ['approvalId', 'actionId', 'decision', 'decidedBy'],
    (p) =>
      isEventId(p.approvalId) &&
      isEventId(p.actionId) &&
      (p.decision === 'approved' || p.decision === 'denied') &&
      isPrincipalId(p.decidedBy),
  ),

  'relay.approval.expired': workRule(
    ['approvalId', 'actionId'],
    (p) => isEventId(p.approvalId) && isEventId(p.actionId),
  ),

  'relay.action.executed': workRule(
    ['actionId', 'connector', 'action', 'outcome', 'resultKind', 'retries'],
    (p) =>
      isEventId(p.actionId) &&
      isRelayConnectorId(p.connector) &&
      isRelayAction(p.action) &&
      (p.outcome === 'read' || p.outcome === 'write') &&
      isBoundedText(p.resultKind, 64) &&
      isNonNegativeInt(p.retries),
  ),

  'relay.action.failed': workRule(
    ['actionId', 'connector', 'action', 'failureCode', 'retries'],
    (p) =>
      isEventId(p.actionId) &&
      isRelayConnectorId(p.connector) &&
      isRelayAction(p.action) &&
      isRelayFailureCode(p.failureCode) &&
      isNonNegativeInt(p.retries),
  ),

  'relay.action.cancelled': workRule(
    ['actionId', 'failureCode'],
    (p) => isEventId(p.actionId) && isRelayFailureCode(p.failureCode),
  ),

  'relay.connector.faulted': workRule(
    ['connector', 'reason'],
    (p) => isRelayConnectorId(p.connector) && isBoundedText(p.reason, 400),
  ),

  'relay.limits.exceeded': workRule(
    ['connector', 'action', 'limit', 'observed'],
    (p) =>
      isRelayConnectorId(p.connector) &&
      isRelayAction(p.action) &&
      isNonEmptyString(p.limit) &&
      isNonNegativeInt(p.observed),
  ),

  /* ---------------------------------------------------------------- skills */

  // The Work rule, applied to Skills for the same reason and with the same force: an
  // undeclared key is refused rather than ignored. This family's whole safety
  // argument is that there is **no slot a skill body could occupy** ??? no summary
  // text, no contract description, no step input, no commentary. A payload with the
  // right fields plus a `summary` string would pass every field check and quietly
  // write a procedure into a backup.
  'skill.admitted': SKILL_VERSION,
  'skill.revised': SKILL_VERSION,

  // `evidence` is nullable so a downgrade (which needs no evidence) records honestly.
  // When present it is four integers the engine counted itself; there is no field here
  // a caller could write a verdict into.
  'skill.transitioned': workRule(
    ['skillId', 'from', 'to', 'reason', 'evidence'],
    (p) =>
      isEventId(p.skillId) &&
      SKILL_STATUS_SET.has(p.from as string) &&
      SKILL_STATUS_SET.has(p.to as string) &&
      PROMOTION_REASON_SET.has(p.reason as string) &&
      // `promoted` is the only status this family may reach with a lifecycle line,
      // and retirement has its own event so a terminal status cannot hide its reason.
      (p.to !== 'retired' && p.to !== 'blocked') &&
      (p.evidence === null || isPromotionEvidence(p.evidence)),
  ),

  'skill.retired': workRule(
    ['skillId', 'version', 'to', 'reason'],
    (p) =>
      isEventId(p.skillId) &&
      isPositiveInt(p.version) &&
      (p.to === 'retired' || p.to === 'blocked') &&
      isSkillRetirementReason(p.reason),
  ),

  // `author` is checked against the two-member `EVALUATION_AUTHORS` set rather than
  // being a free string, so there is no spelling of this payload in which a model
  // authored an evaluation. `version` is a positive integer because the fold compares
  // it against the record's own version, and a mismatch is refused there.
  'skill.evaluation.recorded': workRule(
    [
      'evaluationId',
      'skillId',
      'version',
      'subjectKind',
      'subjectRef',
      'author',
      'verdict',
      'reason',
      'deterministicCount',
      'positiveCount',
      'negativeCount',
      'commentaryChars',
    ],
    (p) =>
      isEventId(p.evaluationId) &&
      isEventId(p.skillId) &&
      isPositiveInt(p.version) &&
      EVALUATION_SUBJECT_KIND_SET.has(p.subjectKind as string) &&
      isEventId(p.subjectRef) &&
      EVALUATION_AUTHOR_SET.has(p.author as string) &&
      isSkillVerdict(p.verdict) &&
      EVALUATION_REASON_SET.has(p.reason as string) &&
      isNonNegativeInt(p.deterministicCount) &&
      isNonNegativeInt(p.positiveCount) &&
      isNonNegativeInt(p.negativeCount) &&
      isNonNegativeInt(p.commentaryChars),
  ),

  'skill.execution.planned': workRule(
    ['skillId', 'version', 'runId', 'stepId', 'stepCount'],
    (p) =>
      isEventId(p.skillId) &&
      isPositiveInt(p.version) &&
      isEventId(p.runId) &&
      isEventId(p.stepId) &&
      isPositiveInt(p.stepCount),
  ),

  // `targetRef` is checked against the protected-domain table as well as the id shape,
  // so a hand-edited line cannot record a proposal against the Constitution or a
  // source path. A refusal is the *event* one level up, and this is the second place
  // the same claim is made.
  'skill.improvement.proposed': workRule(
    [
      'proposalId',
      'target',
      'targetRef',
      'skillId',
      'baseVersion',
      'summaryLength',
      'basisEvaluationIds',
      'proposedBy',
      'openProposalsAt',
    ],
    (p) =>
      isEventId(p.proposalId) &&
      isImprovementTarget(p.target) &&
      isNonEmptyString(p.targetRef) &&
      p.targetRef.length <= SKILL_LIMITS.maxRefChars &&
      !targetIsProtected(p.targetRef) &&
      (p.skillId === null || isEventId(p.skillId)) &&
      (p.baseVersion === null || isPositiveInt(p.baseVersion)) &&
      isNonNegativeInt(p.summaryLength) &&
      isIdList(p.basisEvaluationIds) &&
      EVALUATION_AUTHOR_SET.has(p.proposedBy as string) &&
      isNonNegativeInt(p.openProposalsAt),
  ),

  'skill.improvement.settled': workRule(
    ['proposalId', 'decision', 'reason'],
    (p) =>
      isEventId(p.proposalId) &&
      (p.decision === 'accepted' || p.decision === 'refused') &&
      // An accepted proposal carries the word `accepted`, which is also a legal refusal
      // code ??? that overlap is intentional, so a line cannot claim "accepted" while
      // naming a refusal reason that contradicts it.
      (p.reason === 'accepted' || isSkillRefusalCode(p.reason)),
  ),

  // A closed refusal code and a bounded reference. There is no field here for the text
  // that was refused, which is the whole point: the submitted text is the attack.
  'skill.proposal.rejected': workRule(
    ['attemptId', 'code', 'targetRef'],
    (p) =>
      isEventId(p.attemptId) &&
      isNonEmptyString(p.code) &&
      p.code.length <= 64 &&
      (p.targetRef === null || isEventId(p.targetRef)),
  ),

  'skill.runtime.promotion.refused': workRule(
    ['artifactId', 'targetRef', 'reason'],
    (p) =>
      isEventId(p.artifactId) &&
      isNonEmptyString(p.targetRef) &&
      !targetIsProtected(p.targetRef) &&
      (p.reason === 'runtime-promotion-unavailable' || p.reason === 'artifact-refused' || p.reason === 'boundary-violation'),
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
 * Goal ceilings as they appear in a durable record.
 *
 * Positive integers, re-checked against the code-owned ceilings on read: a
 * hand-edited `maxCheckpointsPerGoal: 1000000` must not become a real ceiling the
 * engine enforces, because then the only limit would exist on disk.
 */
function isGoalLimits(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const limits = value as Record<string, unknown>
  if (!onlyNamedKeys(limits, Object.keys(DEFAULT_GOAL_LIMITS))) return false
  if (!Object.values(limits).every(isPositiveInt)) return false
  for (const [key, ceiling] of Object.entries(DEFAULT_GOAL_LIMITS)) {
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
 * line *can* carry an extra key past them â€” it simply has nowhere to be read from,
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
 * Wrap a life-loop payload rule with the loop's own closed vocabulary.
 *
 * `allowed` is the per-event key list, and it is checked *against* the published
 * table rather than in place of it, so a validator can be neither wider nor narrower
 * than `core/lifeloop/types.ts` â€” the two cannot fall out of step because the rule
 * refuses any divergence in either direction. On top of that, a payload carrying a
 * key from `FORBIDDEN_PAYLOAD_KEYS` is refused outright: authority is minted by the
 * Guard and the Governor and never by an event, so a payload shaped like a
 * capability, a grant, a verdict or a budget is not a new field, it is an
 * escalation attempt, and the journal is the last place it should be able to appear.
 *
 * The text ceiling is enforced on the value as well as the key, for the reason the
 * limits table gives: a long string in a life-loop entry is how the journal quietly
 * becomes a transcript of what Freya was thinking.
 */
function lifeLoopRule(
  allowed: readonly string[],
  rule: (payload: Record<string, unknown>) => boolean,
): (payload: Record<string, unknown>) => boolean {
  return (payload) => {
    if (!onlyNamedKeys(payload, allowed)) return false
    for (const key of Object.keys(payload)) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(key)) return false
    }
    for (const value of Object.values(payload)) {
      if (typeof value === 'string' && value.length > LIFE_LOOP_LIMITS.maxPayloadTextLength) return false
    }
    return rule(payload)
  }
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


