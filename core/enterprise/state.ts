import { customerValueIsClean } from './catalog'
import { dayKeyOf, emptyLedger, isCurrency, type SpendingLedger } from './spending'
import {
  APPROVAL_STATES,
  CATALOG_ITEM_STATES,
  CUSTOMER_STATES,
  AUTHORIZATION_GATES,
  ENTERPRISE_EVENT_TYPE_SET,
  ENTERPRISE_LIMITS,
  ENTERPRISE_PAYLOAD_KEYS,
  ENVIRONMENT_STATES,
  FORBIDDEN_ENTERPRISE_ACTIONS,
  FORBIDDEN_ENTERPRISE_PAYLOAD_KEYS,
  MISSION_STATES,
  SPENDING_GATE_KINDS,
  TASK_STATES,
  WEBZONE_OPERATION_KINDS,
  WEBZONE_OPERATION_STATES,
  isApprovalKind,
  isApprovalState,
  isApprovalSubjectKind,
  isAuthorizationGate,
  isCatalogItemKind,
  isCatalogItemState,
  isCustomerState,
  isEnvironmentKind,
  isEnvironmentState,
  isMissionState,
  isSpendingGateKind,
  isTaskState,
  isVerificationOutcome,
  isWebzoneOperationKind,
  isWebzoneOperationState,
  type ApprovalKind,
  type ApprovalState,
  type ApprovalSubjectKind,
  type CatalogItemKind,
  type CatalogItemState,
  type CustomerState,
  type EnterpriseEventType,
  type EnterpriseJournalEntry,
  type EnvironmentKind,
  type EnvironmentState,
  type MissionState,
  type SpendingGateKind,
  type TaskState,
  type VerificationOutcome,
  type WebzoneOperationKind,
  type WebzoneOperationState,
} from './types'
import {
APPROVAL_TRANSITIONS,
  ENVIRONMENT_TRANSITIONS,
  MISSION_TRANSITIONS,
  TASK_TRANSITIONS,
environmentTransition,
  missionTransition,
  taskTransition,
  webzoneTransition,
} from './machine'
import type { ApprovalRecord } from './approvals'
import type { CatalogItem, CustomerRecord } from './catalog'
import type { EnterpriseBoundaries } from './boundaries'
import type { CountContext } from './boundaries'
import type { SpendingLimits } from './types'
import type { RollbackRecord } from './rollback'
import type { VerificationRecord } from './verification'

/**
 * The fold.
 *
 * Every fact this subsystem holds is derived from the journal, and this file is the
 * only thing that derives it. There is no second copy, no cache and no in-memory record
 * that a restart would not lose — which is what makes "replay the journal and the state
 * comes back" a property rather than a hope.
 *
 * The fold is deliberately untrusting of its own input. For every entry it:
 *
 *   - checks the type is one this phase knows, and records `unknown-event-type`
 *     otherwise rather than ignoring it;
 *   - rejects any key outside the published per-event table, and any key shaped like
 *     authority, in *either* direction, recording which and why;
 *   - enforces the text ceiling on every string *value*, so the journal cannot quietly
 *     become a transcript of the business;
 *   - checks every state change against the machine in `./machine`, recording
 *     `illegal-transition` for an edge that does not exist;
 *   - bounds every collection it grows.
 *
 * What it never does is repair. A tampered journal produces a *visible* wrong answer
 * with the wrongness named in `anomalies`, never a quietly plausible one — because the
 * one thing an enterprise journal must not be is a source of confident fiction about
 * what a business has already done.
 */

/* ------------------------------------------------------------- anomalies */

export type FoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'terminal-state-re-entered'
  | 'unknown-record'
  | 'duplicate-record'

export interface FoldAnomaly {
  readonly code: FoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

export interface FoldResult {
  readonly state: EnterpriseState
  readonly anomalies: readonly FoldAnomaly[]
}

/* ----------------------------------------------------------------- state */

export interface EnvironmentRecord {
  readonly environmentId: string
  readonly kind: EnvironmentKind
  readonly state: EnvironmentState
  readonly title: string
  readonly boundaries: EnterpriseBoundaries | null
  readonly spendingLimits: SpendingLimits | null
  readonly ledger: SpendingLedger
  readonly createdAt: string
  readonly updatedAt: string
  readonly deadlineAt: string | null
  readonly completedAt: string | null
  readonly stopCode: string | null
}

export interface TaskRecord {
  readonly taskId: string
  readonly environmentId: string
  readonly state: TaskState
  readonly dependencies: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export interface MissionRecord {
  readonly missionId: string
  readonly environmentId: string
  readonly state: MissionState
  readonly childTaskIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export interface OperationRecord {
  readonly operationId: string
  readonly environmentId: string
  readonly state: WebzoneOperationState
  readonly kind: WebzoneOperationKind
  readonly target: string
  readonly verificationId: string | null
  readonly createdAt: string
  readonly completedAt: string | null
}

export interface EnterpriseState {
  readonly environments: Readonly<Record<string, EnvironmentRecord>>
  readonly tasks: Readonly<Record<string, TaskRecord>>
  readonly missions: Readonly<Record<string, MissionRecord>>
  readonly operations: Readonly<Record<string, OperationRecord>>
  readonly catalogItems: Readonly<Record<string, CatalogItem>>
  readonly customers: Readonly<Record<string, CustomerRecord>>
  readonly approvals: Readonly<Record<string, ApprovalRecord>>
  readonly verifications: Readonly<Record<string, VerificationRecord>>
  readonly rollbacks: readonly RollbackRecord[]
  /** Refusals, newest last, bounded. The owner's record of what was declined. */
  readonly refusals: readonly EnterpriseRefusal[]
  readonly lastRefusal: EnterpriseRefusal | null
  readonly lastContinuation: { readonly environmentId: string; readonly decision: string } | null
  readonly wakeKeys: readonly string[]
}

export interface EnterpriseRefusal {
  readonly actionId: string
  readonly environmentId: string
  readonly gate: string
  readonly code: string
  readonly reason: string
  readonly at: string
}

export function initialEnterpriseState(): EnterpriseState {
  return Object.freeze({
    environments: Object.freeze({}),
    tasks: Object.freeze({}),
    missions: Object.freeze({}),
    operations: Object.freeze({}),
    catalogItems: Object.freeze({}),
    customers: Object.freeze({}),
    approvals: Object.freeze({}),
    verifications: Object.freeze({}),
    rollbacks: Object.freeze([]),
    refusals: Object.freeze([]),
    lastRefusal: null,
    lastContinuation: null,
    wakeKeys: Object.freeze([]),
  })
}

/* -------------------------------------------------------------- reading */

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

/**
 * A record id for use as a computed property name.
 *
 * Returns `''` rather than null when the id is absent, and that is deliberate: an
 * absent id then indexes the table to `undefined`, which every case already handles
 * with its "no such record" guard. It exists so the id is statically a `string` at the
 * point it is used as a key — `const current = id === null ? undefined : table[id]`
 * does *not* narrow `id`, so a computed property name built from it is
 * `string | null` and TypeScript rejects it in fourteen places.
 *
 * Use {@link readString} where the difference between "absent" and "present but
 * unrecognised" carries meaning — such as refusing a completion with no verification
 * id, which is a different thing from refusing one naming the wrong id.
 */
function readId(payload: Record<string, unknown>, key: string): string {
  return readString(payload, key) ?? ''
}

function readInteger(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key]
  return typeof value === 'boolean' ? value : null
}

function readText(payload: Record<string, unknown>, key: string): string | null {
  const value = readString(payload, key)
  if (value === null) return null
  return value.length <= ENTERPRISE_LIMITS.maxPayloadTextLength ? value : null
}

/* ------------------------------------------------------------ inspection */

function onlyNamedKeys(payload: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) return false
  }
  return true
}

/**
 * Reject anything authority-shaped before anything else looks at the entry.
 *
 * A payload carrying `capability`, `grant`, `budget` or `approved` is not a new field.
 * It is an escalation attempt, and the durable journal is the last place in the system
 * where one should be able to appear. Checked against a fixed deny list rather than
 * the event's own key table so it also catches a key that is *both* allowed and
 * dangerous, which a per-event allowlist cannot express.
 */
export function inspectEnterprisePayload(
  type: EnterpriseEventType,
  payload: Record<string, unknown>,
): FoldAnomaly[] {
  const anomalies: FoldAnomaly[] = []
  const allowed = ENTERPRISE_PAYLOAD_KEYS[type]

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_ENTERPRISE_PAYLOAD_KEYS.has(key)) {
      anomalies.push({
        code: 'forbidden-payload-key',
        eventType: type,
        detail: `"${key}" names authority. Authority is minted by the Guard and the Governor, never by an event.`,
      })
    } else if (!allowed.includes(key)) {
      anomalies.push({
        code: 'unknown-payload-key',
        eventType: type,
        detail: `"${key}" is not a field of ${type}. A field nothing reads is a field something can hide in.`,
      })
    }
  }
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.length > ENTERPRISE_LIMITS.maxPayloadTextLength) {
      anomalies.push({
        code: 'oversized-payload-text',
        eventType: type,
        detail: `A payload string exceeded ${String(ENTERPRISE_LIMITS.maxPayloadTextLength)} characters.`,
      })
    }
  }
  if (anomalies.length > 0) return anomalies

  // Only the key *shape* is checked above; the values are checked per event below, so
  // that a payload with a plausible key and an impossible value is caught by the rule
  // that knows what the field means.
  const scalarProblems = inspectScalarValues(type, payload)
  if (scalarProblems.length > 0) return scalarProblems

  if (!onlyNamedKeys(payload, allowed)) {
    return [
      {
        code: 'unknown-payload-key',
        eventType: type,
        detail: `${type} carries a key outside its published table.`,
      },
    ]
  }
  return []
}

/**
 * Per-event value checks.
 *
 * The value is only ever narrowed *towards* a closed vocabulary. An unrecognised state
 * yields null and the caller records `malformed-payload` rather than defaulting, which
 * is the difference between "this entry said something impossible" and "this entry
 * quietly decided what it meant".
 */
function inspectScalarValues(
  type: EnterpriseEventType,
  payload: Record<string, unknown>,
): FoldAnomaly[] {
  const problems: FoldAnomaly[] = []
  const malformed = (detail: string) => problems.push({ code: 'malformed-payload', eventType: type, detail })

  if ('state' in payload && !isEnvironmentState(payload.state)) {
    malformed(`"state" is not one of ${ENVIRONMENT_STATES.join(', ')}.`)
  }
  if ('to' in payload && !isEnvironmentState(payload.to) && !isTaskState(payload.to) && !isMissionState(payload.to) && !isWebzoneOperationState(payload.to) && !isApprovalState(payload.to) && !isCatalogItemState(payload.to) && !isCustomerState(payload.to)) {
    malformed(`"to" is not a known state in any closed state set.`)
  }
  if ('from' in payload && !isEnvironmentState(payload.from) && !isTaskState(payload.from) && !isMissionState(payload.from) && !isWebzoneOperationState(payload.from) && !isApprovalState(payload.from) && !isCatalogItemState(payload.from) && !isCustomerState(payload.from)) {
    malformed(`"from" is not a known state in any closed state set.`)
  }
  if ('kind' in payload && type === 'enterprise.environment.created' && !isEnvironmentKind(payload.kind)) {
    malformed(`"kind" is not one of the environment kinds.`)
  }
  if ('itemKind' in payload && !isCatalogItemKind(payload.itemKind)) {
    malformed(`"itemKind" is not one of project, product or service.`)
  }
  // Scoped by event type, because `gate` means two unrelated things in this
  // vocabulary: the spending gate being checked on a `spending-gate.*` entry, and the
  // *authorization* gate that refused on an `action.refused` entry. Validating both
  // against the spending vocabulary meant every refusal whose gate was `boundary` was
  // discarded as malformed — so the audit trail silently dropped refusals, which is the
  // one thing an audit trail must never do.
  if ('gate' in payload) {
    if (type.startsWith('enterprise.spending-gate.')) {
      if (!isSpendingGateKind(payload.gate)) {
        malformed(`"gate" is not one of ${SPENDING_GATE_KINDS.join(', ')}.`)
      }
    } else if (!isAuthorizationGate(payload.gate)) {
      malformed(`"gate" is not one of ${AUTHORIZATION_GATES.join(', ')}.`)
    }
  }
  if ('outcome' in payload) {
    const outcome = payload.outcome
    const known =
      isVerificationOutcome(outcome) ||
      outcome === 'success' ||
      outcome === 'partial' ||
      outcome === 'failed' ||
      outcome === 'not-reversible'
    if (!known) malformed(`"outcome" is not a known verification or rollback outcome.`)
  }
  if ('held' in payload && readBoolean(payload, 'held') === null) {
    malformed(`"held" must be a boolean.`)
  }
  return problems
}

/* ---------------------------------------------------------------- helpers */

function appendBounded<T>(list: readonly T[], item: T, max: number): readonly T[] {
  const next = [...list, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * States a record cannot leave.
 *
 * Kept as a `Set` for the anomaly reason rather than reusing the machine's list, because
 * the question here is different: the machine asks "is this transition allowed?" and the
 * fold asks "was this record already finished?" — and naming that second question
 * separately keeps the anomaly legible. `completed` reached from `draft` is an illegal
 * transition; `active` reached from `completed` is a *finished* record being reopened,
 * and those are different mistakes.
 */
const TERMINAL: ReadonlySet<EnvironmentState> = new Set<EnvironmentState>([
  'completed',
  'failed',
  'cancelled',
])

const TASK_TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(['completed', 'failed', 'cancelled'])
const MISSION_TERMINAL: ReadonlySet<MissionState> = new Set<MissionState>([
  'completed',
  'failed',
  'cancelled',
])



/**
 * Terminal transitions for tasks and missions.
 *
 * Both share the environment table, so the helper is generic over the task-shaped state
 * union. Written out rather than reusing {@link resolveTerminal} because that one is
 * typed to `EnvironmentState` for the catalog items that share its lifecycle, and a
 * cast between the unions would be a cast somebody eventually removes.
 */
function resolveTerminalTask(
  current: TaskState,
  to: TaskState,
): { readonly reason: string; readonly finished: boolean } | null {
  const allowed = taskTransition(current, to)
  if (allowed.allowed) return null
  return {
    reason: TASK_TERMINAL.has(current)
      ? `This task is already ${current}, so it cannot become ${to}.`
      : allowed.reason,
    finished: TASK_TERMINAL.has(current),
  }
}

function resolveTerminalMission(
  current: MissionState,
  to: MissionState,
): { readonly reason: string; readonly finished: boolean } | null {
  const allowed = missionTransition(current, to)
  if (allowed.allowed) return null
  return {
    reason: MISSION_TERMINAL.has(current)
      ? `This mission is already ${current}, so it cannot become ${to}.`
      : allowed.reason,
    finished: MISSION_TERMINAL.has(current),
  }
}

/**
 * Resolve a transition into a terminal state.
 *
 * Separate from {@link resolveTransition} because these events carry no `from`: the
 * terminal state is implied by the event type. The finished check matters — a record
 * that is already `completed` must not be "completed" again, or a second completion
 * event would overwrite `completedAt` and quietly rewrite when the work actually
 * finished.
 */
function resolveTerminal(
  current: EnvironmentState,
  to: EnvironmentState,
): { readonly reason: string; readonly finished: boolean } | null {
  const allowed = environmentTransition(current, to)
  if (allowed.allowed) return null
  return {
    reason: TERMINAL.has(current)
      ? `This environment is already ${current}, so it cannot become ${to}.`
      : allowed.reason,
    finished: TERMINAL.has(current),
  }
}

/**
 * Resolve a claimed transition against the record's real state.
 *
 * Shared by all five folds that accept a `from`/`to` pair, because doing it five times
 * is five chances to forget that `from` is a *claim*. Returns null when the transition
 * is genuinely permitted, and otherwise a reason naming both what was claimed and what
 * is true.
 */
function resolveTransition<S extends string>(
  table: readonly { readonly from: S; readonly to: S }[],
  states: readonly S[],
  current: S,
  claimedFrom: S,
  to: S,
): { readonly reason: string; readonly finished: boolean } | null {
  const finished = TERMINAL.has(current as EnvironmentState)

  // A misreported `from` is refused on its own, before the edge is even consulted.
  //
  // This is stricter than checking the edge alone, and deliberately so. If a wrong
  // `from` were merely ignored, an entry claiming `draft` for a record that is really
  // `active` would be evaluated as `active -> active` and *permitted* by an edge check
  // that never noticed the lie. Requiring the claim to match the record means both the
  // claim and the effect have to be true, and a journal that has been edited stops
  // agreeing with itself at exactly the point somebody has tampered with it.
  if (current !== claimedFrom) {
    return {
      reason: `The entry claimed this record was ${claimedFrom}, but it is ${current}. The transition was refused rather than applied against the claimed state.`,
      finished,
    }
  }

  const allowed = table.some((edge) => edge.from === current && edge.to === to)
  if (allowed) return null

  return {
    reason: states.includes(current)
      ? `No edge from ${current} to ${to}.`
      : `The record is in the unrecognised state "${current}".`,
    finished,
  }
}

/* ----------------------------------------------------------------- apply */

type Anomalies = FoldAnomaly[]

function applyEntry(state: EnterpriseState, entry: EnterpriseJournalEntry, anomalies: Anomalies): EnterpriseState {
  const type = entry.type
  if (!ENTERPRISE_EVENT_TYPE_SET.has(type)) {
    anomalies.push({
      code: 'unknown-event-type',
      eventType: type,
      detail: 'Not an event this subsystem writes. It is recorded, not acted on.',
    })
    return state
  }
  const typed = type as EnterpriseEventType
  const payload =
    typeof entry.payload === 'object' && entry.payload !== null && !Array.isArray(entry.payload)
      ? (entry.payload as Record<string, unknown>)
      : null
  if (payload === null) {
    anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'Payload was not an object.' })
    return state
  }

  const found = inspectEnterprisePayload(typed, payload)
  if (found.length > 0) {
    anomalies.push(...found)
    return state
  }

  const at = readText(payload, 'at') ?? entry.recordedAt ?? ''

  switch (typed) {
    /* ---------------------------------------------------- environments */
    case 'enterprise.environment.created': {
      const environmentId = readString(payload, 'environmentId')
      const kind = isEnvironmentKind(payload.kind) ? payload.kind : null
      const initialState = isEnvironmentState(payload.state) ? payload.state : null
      const title = readText(payload, 'title')
      if (environmentId === null || kind === null || initialState === null || title === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'An environment could not be read from this entry.' })
        return state
      }
      if (state.environments[environmentId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Environment ${environmentId} already exists.` })
        return state
      }
      if (Object.keys(state.environments).length >= ENTERPRISE_LIMITS.maxEnvironments) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: `The ceiling of ${String(ENTERPRISE_LIMITS.maxEnvironments)} environments is already reached.` })
        return state
      }
      return {
        ...state,
        environments: {
          ...state.environments,
          [environmentId]: {
            environmentId,
            kind,
            state: initialState,
            title,
            boundaries: null,
            spendingLimits: null,
            ledger: emptyLedger('XXX'),
            createdAt: at,
            updatedAt: at,
            deadlineAt: null,
            completedAt: null,
            stopCode: null,
          },
        },
      }
    }

    case 'enterprise.environment.boundaries-set': {
      const environmentId = readId(payload, 'environmentId')
      const current = state.environments[environmentId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment.' })
        return state
      }
      const maxTasks = readInteger(payload, 'maxTasks')
      const maxMissions = readInteger(payload, 'maxMissions')
      const maxWebzoneOperations = readInteger(payload, 'maxWebzoneOperations')
      const maxConcurrentOperations = readInteger(payload, 'maxConcurrentOperations')
      if (
        maxTasks === null ||
        maxMissions === null ||
        maxWebzoneOperations === null ||
        maxConcurrentOperations === null
      ) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'Boundaries could not be read.' })
        return state
      }
      // Only ever narrowed. An entry claiming a *larger* ceiling than the code-owned
      // one is refused outright rather than clamped, because a widened ceiling is exactly
      // the thing this record exists to make impossible and a clamp would hide it.
      if (
        maxTasks > ENTERPRISE_LIMITS.maxTasksPerEnvironment ||
        maxMissions > ENTERPRISE_LIMITS.maxMissionsPerEnvironment ||
        maxWebzoneOperations > ENTERPRISE_LIMITS.maxWebzoneOperationsPerEnvironment ||
        maxConcurrentOperations > ENTERPRISE_LIMITS.maxConcurrentOperations
      ) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: typed,
          detail: 'A journal entry claimed a boundary above the code-owned ceiling. The claim was refused.',
        })
        return state
      }
      // Only the *numeric* boundaries are journaled. `allowedDomains` and
      // `forbiddenActions` are a list and a list, and the enterprise payload vocabulary
      // is deliberately flat scalars — a JSON array in a journal payload is the shape
      // this phase refuses everywhere else, for the same reason it refuses an authority
      // key: a field whose structure nothing validates is a field something can hide in.
      //
      // So the two lists stay absent here and remain **fail-closed**: an environment
      // whose allowlist is not present is one the gate will not operate. That is the safe
      // direction for the omission, and it is recorded in the README as a known
      // integration task rather than papered over here.
      return {
        ...state,
        environments: {
          ...state.environments,
          [environmentId]: {
            ...current,
            boundaries: Object.freeze({
              maxTasks,
              maxMissions,
              maxWebzoneOperations,
              maxConcurrentOperations,
              allowedDomains: current.boundaries?.allowedDomains ?? Object.freeze([]),
              forbiddenActions: FORBIDDEN_ENTERPRISE_ACTIONS,
            }),
          },
        },
      }
    }

    case 'enterprise.environment.spending-limits-set': {
      const environmentId = readId(payload, 'environmentId')
      const current = state.environments[environmentId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment.' })
        return state
      }
      const maxTotalSpend = readInteger(payload, 'maxTotalSpend')
      const maxPerAction = readInteger(payload, 'maxPerAction')
      const maxPerDay = readInteger(payload, 'maxPerDay')
      const currency = readString(payload, 'currency')
      if (
        maxTotalSpend === null ||
        maxPerAction === null ||
        maxPerDay === null ||
        currency === null ||
        !isCurrency(currency) ||
        readBoolean(payload, 'hardCeiling') !== true
      ) {
        // A soft or unparseable ceiling is refused, not honoured loosely.
        anomalies.push({
          code: 'malformed-payload',
          eventType: typed,
          detail: 'Spending limits could not be read as whole minor units in one currency with a hard ceiling.',
        })
        return state
      }
      return {
        ...state,
        environments: {
          ...state.environments,
          [environmentId]: {
            ...current,
            spendingLimits: Object.freeze({ maxTotalSpend, maxPerAction, maxPerDay, currency, hardCeiling: true }),
          },
        },
      }
    }

    case 'enterprise.environment.updated': {
      const environmentId = readId(payload, 'environmentId')
      const current = state.environments[environmentId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment.' })
        return state
      }
      return {
        ...state,
        environments: { ...state.environments, [environmentId]: { ...current, updatedAt: at } },
      }
    }

    case 'enterprise.environment.state-changed': {
      const environmentId = readId(payload, 'environmentId')
      const current = state.environments[environmentId]
      const to = isEnvironmentState(payload.to) ? payload.to : null
      const from = isEnvironmentState(payload.from) ? payload.from : null
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment.' })
        return state
      }
      if (to === null || from === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'An environment transition could not be read.' })
        return state
      }
      // The transition is resolved against the record's **actual** state, not against
      // the `from` the payload claims.
      //
      // This distinction is the whole reason the fold is untrusting. Checking
      // `transition(from, to)` as the payload describes it lets a hand-edited entry
      // assert `from: 'draft', to: 'completed'` for an environment that is already
      // `active`, and the table would be consulted with a pair that is not the record's
      // situation at all. Requiring the claim to match the record makes both the claim
      // and the effect have to be true.
      const refusal = resolveTransition(
        ENVIRONMENT_TRANSITIONS,
        ENVIRONMENT_STATES,
        current.state,
        from,
        to,
      )
      if (refusal !== null) {
        anomalies.push({
          code: refusal.finished ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: refusal.reason,
        })
        return state
      }
      return {
        ...state,
        environments: {
          ...state.environments,
          [environmentId]: {
            ...current,
            state: to,
            updatedAt: at,
            completedAt: to === 'completed' ? at : current.completedAt,
            stopCode: readText(payload, 'code') ?? current.stopCode,
          },
        },
      }
    }

    case 'enterprise.environment.completed':
    case 'enterprise.environment.failed':
    case 'enterprise.environment.cancelled': {
      const environmentId = readId(payload, 'environmentId')
      const current = state.environments[environmentId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment.' })
        return state
      }
      const terminal: EnvironmentState =
        typed === 'enterprise.environment.completed'
          ? 'completed'
          : typed === 'enterprise.environment.failed'
            ? 'failed'
            : 'cancelled'
      const refusal = resolveTerminal(current.state, terminal)
      if (refusal !== null) {
        anomalies.push({
          code: refusal.finished ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: refusal.reason,
        })
        return state
      }
      return {
        ...state,
        environments: {
          ...state.environments,
          [environmentId]: { ...current, state: terminal, updatedAt: at, completedAt: at },
        },
      }
    }

    /* ----------------------------------------------------------- tasks */
    case 'enterprise.task.created': {
      const taskId = readString(payload, 'taskId')
      const environmentId = readString(payload, 'environmentId')
      const taskState = isTaskState(payload.state) ? payload.state : null
      if (taskId === null || environmentId === null || taskState === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A task could not be read from this entry.' })
        return state
      }
      if (state.tasks[taskId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Task ${taskId} already exists.` })
        return state
      }
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [taskId]: {
            taskId,
            environmentId,
            state: taskState,
            dependencies: [],
            createdAt: at,
            updatedAt: at,
            completedAt: null,
          },
        },
      }
    }

    case 'enterprise.task.state-changed': {
      const taskId = readId(payload, 'taskId')
      const current = state.tasks[taskId]
      const to = isTaskState(payload.to) ? payload.to : null
      const from = isTaskState(payload.from) ? payload.from : null
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such task.' })
        return state
      }
      if (to === null || from === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A task transition could not be read.' })
        return state
      }
      const refusal = resolveTransition(TASK_TRANSITIONS, TASK_STATES, current.state, from, to)
      if (refusal !== null) {
        anomalies.push({
          code: refusal.finished ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: refusal.reason,
        })
        return state
      }
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [taskId]: { ...current, state: to, updatedAt: at, completedAt: to === 'completed' ? at : current.completedAt },
        },
      }
    }

    case 'enterprise.task.completed':
    case 'enterprise.task.failed': {
      const taskId = readId(payload, 'taskId')
      const current = state.tasks[taskId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such task.' })
        return state
      }
      const terminal: TaskState = typed === 'enterprise.task.completed' ? 'completed' : 'failed'
      const refusal = resolveTerminalTask(current.state, terminal)
      if (refusal !== null) {
        anomalies.push({
          code: refusal.finished ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: refusal.reason,
        })
        return state
      }
      return {
        ...state,
        tasks: { ...state.tasks, [taskId]: { ...current, state: terminal, updatedAt: at, completedAt: at } },
      }
    }

    /* -------------------------------------------------------- missions */
    case 'enterprise.mission.created': {
      const missionId = readString(payload, 'missionId')
      const environmentId = readString(payload, 'environmentId')
      const missionState = isMissionState(payload.state) ? payload.state : null
      if (missionId === null || environmentId === null || missionState === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A mission could not be read from this entry.' })
        return state
      }
      if (state.missions[missionId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Mission ${missionId} already exists.` })
        return state
      }
      return {
        ...state,
        missions: {
          ...state.missions,
          [missionId]: { missionId, environmentId, state: missionState, childTaskIds: [], createdAt: at, updatedAt: at, completedAt: null },
        },
      }
    }

    case 'enterprise.mission.state-changed': {
      const missionId = readId(payload, 'missionId')
      const current = state.missions[missionId]
      const to = isMissionState(payload.to) ? payload.to : null
      const from = isMissionState(payload.from) ? payload.from : null
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such mission.' })
        return state
      }
      if (to === null || from === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A mission transition could not be read.' })
        return state
      }
      const refusal = resolveTransition(
        MISSION_TRANSITIONS,
        MISSION_STATES,
        current.state,
        from,
        to,
      )
      if (refusal !== null) {
        anomalies.push({
          code: refusal.finished ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: refusal.reason,
        })
        return state
      }
      return {
        ...state,
        missions: {
          ...state.missions,
          [missionId]: { ...current, state: to, updatedAt: at, completedAt: to === 'completed' ? at : current.completedAt },
        },
      }
    }

    case 'enterprise.mission.completed':
    case 'enterprise.mission.failed': {
      const missionId = readId(payload, 'missionId')
      const current = state.missions[missionId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such mission.' })
        return state
      }
      const terminal: MissionState = typed === 'enterprise.mission.completed' ? 'completed' : 'failed'
      const refusal = resolveTerminalMission(current.state, terminal)
      if (refusal !== null) {
        anomalies.push({
          code: refusal.finished ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: refusal.reason,
        })
        return state
      }
      return {
        ...state,
        missions: { ...state.missions, [missionId]: { ...current, state: terminal, updatedAt: at, completedAt: at } },
      }
    }

    /* ------------------------------------------------------- webzone */
    case 'enterprise.webzone-operation.started': {
      const operationId = readString(payload, 'operationId')
      const environmentId = readString(payload, 'environmentId')
      const kind = isWebzoneOperationKind(payload.kind) ? payload.kind : null
      const target = readString(payload, 'target')
      if (operationId === null || environmentId === null || kind === null || target === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'An operation could not be read from this entry.' })
        return state
      }
      if (state.operations[operationId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Operation ${operationId} already exists.` })
        return state
      }
      const environment = state.environments[environmentId]
      if (environment === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment for this operation.' })
        return state
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          [operationId]: {
            operationId,
            environmentId,
            state: 'active',
            kind,
            target,
            verificationId: null,
            createdAt: at,
            completedAt: null,
          },
        },
      }
    }

    case 'enterprise.webzone-operation.completed': {
      const operationId = readId(payload, 'operationId')
      const current = state.operations[operationId]
      // Deliberately `readString`, not `readId`: "absent" and "present but empty" are
      // the same refusal here, and this is the one place the difference between them
      // does *not* carry meaning — an empty verification id is no verification id.
      const verificationId = readString(payload, 'verificationId')
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such operation.' })
        return state
      }
      // The whole verification invariant, in one place: an operation with no
      // verification id cannot be marked complete. This is the single most important
      // line in the fold, because it is what makes "no operation is complete without
      // verification" true of the *record* and not only of the runtime that wrote it.
      if (verificationId === null) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: typed,
          detail: 'An operation was marked complete with no verification. The entry is refused rather than believed.',
        })
        return state
      }
      const closed = webzoneTransition(current.state, 'completed')
      if (!closed.allowed) {
        anomalies.push({
          code: TERMINAL.has(current.state as EnvironmentState) ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: closed.reason,
        })
        return state
      }
      return {
        ...state,
        operations: {
          ...state.operations,
          [operationId]: { ...current, state: 'completed', verificationId, completedAt: at },
        },
      }
    }

    case 'enterprise.webzone-operation.failed': {
      const operationId = readId(payload, 'operationId')
      const current = state.operations[operationId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such operation.' })
        return state
      }
      const closed = webzoneTransition(current.state, 'failed')
      if (!closed.allowed) {
        anomalies.push({
          code: TERMINAL.has(current.state as EnvironmentState) ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: closed.reason,
        })
        return state
      }
      return {
        ...state,
        operations: { ...state.operations, [operationId]: { ...current, state: 'failed', completedAt: at } },
      }
    }

    /* -------------------------------------------------------- catalog */
    case 'enterprise.catalog.item-created': {
      const itemId = readString(payload, 'itemId')
      const environmentId = readString(payload, 'environmentId')
      const itemKind = isCatalogItemKind(payload.itemKind) ? payload.itemKind : null
      const name = readText(payload, 'name')
      const itemState = isCatalogItemState(payload.state) ? payload.state : null
      if (itemId === null || environmentId === null || itemKind === null || name === null || itemState === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A catalog item could not be read.' })
        return state
      }
      // A catalog item must belong to an environment that exists, exactly as an operation
      // must. Without the check a planted entry creates work that belongs to nowhere.
      if (state.environments[environmentId] === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment for this catalog item.' })
        return state
      }
      if (state.catalogItems[itemId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Catalog item ${itemId} already exists.` })
        return state
      }
      return {
        ...state,
        catalogItems: {
          ...state.catalogItems,
          [itemId]: {
            itemId,
            environmentId,
            kind: itemKind,
            name,
            state: itemState,
            createdAt: at,
            updatedAt: at,
            completedAt: null,
          },
        },
      }
    }

    case 'enterprise.catalog.item-state-changed': {
      const itemId = readId(payload, 'itemId')
      const current = state.catalogItems[itemId]
      const to = isCatalogItemState(payload.to) ? payload.to : null
      const from = isCatalogItemState(payload.from) ? payload.from : null
      if (current === undefined || to === null || from === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A catalog transition could not be read.' })
        return state
      }
      const verdict = environmentTransition(from as EnvironmentState, to as EnvironmentState)
      if (!verdict.allowed) {
        anomalies.push({ code: 'illegal-transition', eventType: typed, detail: verdict.reason })
        return state
      }
      return {
        ...state,
        catalogItems: {
          ...state.catalogItems,
          [itemId]: {
            ...current,
            state: to,
            updatedAt: at,
            completedAt: to === 'completed' ? at : current.completedAt,
          },
        },
      }
    }

    case 'enterprise.catalog.item.failed': {
      const itemId = readId(payload, 'itemId')
      const current = state.catalogItems[itemId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such catalog item.' })
        return state
      }
      return {
        ...state,
        catalogItems: { ...state.catalogItems, [itemId]: { ...current, state: 'failed', updatedAt: at, completedAt: at } },
      }
    }

    /* ------------------------------------------------------ customers */
    case 'enterprise.customer.created': {
      const customerId = readString(payload, 'customerId')
      const environmentId = readString(payload, 'environmentId')
      const displayName = readText(payload, 'displayName')
      const customerState = isCustomerState(payload.state) ? payload.state : null
      if (customerId === null || environmentId === null || displayName === null || customerState === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A customer record could not be read.' })
        return state
      }
      // A customer belongs to an environment. A planted entry for an environment that
      // does not exist creates a record about a real third party inside a business that
      // was never set up — which is the shape a privacy incident takes.
      if (state.environments[environmentId] === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment for this customer.' })
        return state
      }
      // The fold re-applies the writer's content rules, because a journal edit bypasses
      // `readCustomer` entirely. A display name that looks like a payment or credential
      // is refused here for the same reason it is refused at write time.
      if (!customerValueIsClean(displayName)) {
        anomalies.push({
          code: 'malformed-payload',
          eventType: typed,
          detail: 'A customer display name contained something that looks like a payment, bank or credential detail.',
        })
        return state
      }
      if (state.customers[customerId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Customer ${customerId} already exists.` })
        return state
      }
      return {
        ...state,
        customers: {
          ...state.customers,
          [customerId]: {
            customerId,
            environmentId,
            displayName,
            state: customerState,
            createdAt: at,
            updatedAt: at,
            withdrawnAt: null,
          },
        },
      }
    }

    case 'enterprise.customer.state-changed': {
      const customerId = readId(payload, 'customerId')
      const current = state.customers[customerId]
      const to = isCustomerState(payload.to) ? payload.to : null
      const from = isCustomerState(payload.from) ? payload.from : null
      if (current === undefined || to === null || from === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A customer transition could not be read.' })
        return state
      }
      if (current.state === 'withdrawn') {
        anomalies.push({
          code: 'terminal-state-re-entered',
          eventType: typed,
          detail: 'A withdrawn customer record was written to again. Withdrawal has to mean something.',
        })
        return state
      }
      return {
        ...state,
        customers: {
          ...state.customers,
          [customerId]: { ...current, state: to, updatedAt: at, withdrawnAt: to === 'withdrawn' ? at : current.withdrawnAt },
        },
      }
    }

    case 'enterprise.customer.withdrawn': {
      const customerId = readId(payload, 'customerId')
      const current = state.customers[customerId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such customer record.' })
        return state
      }
      if (current.state === 'withdrawn') {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: 'That customer record is already withdrawn.' })
        return state
      }
      return {
        ...state,
        customers: { ...state.customers, [customerId]: { ...current, state: 'withdrawn', updatedAt: at, withdrawnAt: at } },
      }
    }

    /* --------------------------------------------------------- gates */
    case 'enterprise.spending-gate.checked':
    case 'enterprise.spending-gate.exceeded': {
      const environmentId = readString(payload, 'environmentId')
      const actionId = readString(payload, 'actionId')
      const projected = readInteger(payload, 'projectedMinor')
      if (environmentId === null || actionId === null || projected === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A spending gate record could not be read.' })
        return state
      }
      const current = state.environments[environmentId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment for this spending record.' })
        return state
      }
      // Only an *exceeded* gate records spend as not-happened; a held gate records the
      // projection as a fact about what was permitted. Neither adds to the ledger:
      // the ledger moves on completion, in `external-action.verified`.
      return { ...state, environments: { ...state.environments, [environmentId]: { ...current, updatedAt: at } } }
    }

    case 'enterprise.boundary.checked': {
      const environmentId = readId(payload, 'environmentId')
      const current = state.environments[environmentId]
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment for this boundary record.' })
        return state
      }
      return { ...state, environments: { ...state.environments, [environmentId]: { ...current, updatedAt: at } } }
    }

    /* ----------------------------------------------------- approvals */
    case 'enterprise.approval.requested': {
      const approvalId = readString(payload, 'approvalId')
      const environmentId = readString(payload, 'environmentId')
      const kind = isApprovalKind(payload.kind) ? payload.kind : null
      const subjectKind = isApprovalSubjectKind(payload.subjectKind) ? payload.subjectKind : null
      const subjectRef = readText(payload, 'subjectRef')
      const subjectDigest = readText(payload, 'subjectDigest')
      const expiresAt = readText(payload, 'expiresAt')
      if (approvalId === null || environmentId === null || kind === null || subjectKind === null || subjectRef === null || subjectDigest === null || expiresAt === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'An approval request could not be read.' })
        return state
      }
      if (state.approvals[approvalId] !== undefined) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: `Approval ${approvalId} already exists.` })
        return state
      }
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [approvalId]: {
            approvalId,
            environmentId,
            kind,
            subjectKind,
            subjectRef,
            subjectDigest,
            reasoning: 'requested',
            state: 'pending',
            requestedAt: at,
            decidedAt: null,
            expiresAt,
          },
        },
      }
    }

    case 'enterprise.approval.granted':
    case 'enterprise.approval.denied':
    case 'enterprise.approval.revoked':
    case 'enterprise.approval.expired': {
      const approvalId = readId(payload, 'approvalId')
      const current = state.approvals[approvalId]
      // Note `decidedAt` is recorded for *every* decision including a revocation, even
      // though the field is named for the owner's decision. The alternative is a second
      // field, and the value genuinely is "when this approval last changed state".
      if (current === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such approval.' })
        return state
      }
      const to: ApprovalState =
        typed === 'enterprise.approval.granted'
          ? 'granted'
          : typed === 'enterprise.approval.denied'
            ? 'denied'
            : typed === 'enterprise.approval.revoked'
              ? 'revoked'
              : 'expired'
      const refusal = resolveApprovalTransition(current.state, to)
      if (refusal !== null) {
        anomalies.push({
          code: refusal.finished ? 'terminal-state-re-entered' : 'illegal-transition',
          eventType: typed,
          detail: refusal.reason,
        })
        return state
      }
      return {
        ...state,
        approvals: { ...state.approvals, [approvalId]: { ...current, state: to, decidedAt: at } },
      }
    }

    /* ------------------------------------------------- verification */
    case 'enterprise.external-action.verified':
    case 'enterprise.external-action.failed': {
      const verificationId = readString(payload, 'verificationId')
      const actionId = readString(payload, 'actionId')
      const environmentId = readString(payload, 'environmentId')
      const outcome = payload.outcome
      if (verificationId === null || actionId === null || environmentId === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A verification could not be read.' })
        return state
      }
      const resolved: VerificationOutcome | null =
        typed === 'enterprise.external-action.verified' && isVerificationOutcome(outcome)
          ? outcome
          : typed === 'enterprise.external-action.failed'
            ? 'failed'
            : null
      if (resolved === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A verification outcome could not be read.' })
        return state
      }
      const record: VerificationRecord = {
        verificationId,
        actionId,
        environmentId,
        outcome: resolved,
        reason: readText(payload, 'reason') ?? 'no reason recorded',
        verifiedAt: at,
      }
      return { ...state, verifications: { ...state.verifications, [verificationId]: record } }
    }

    /* ----------------------------------------------------- rollback */
case 'enterprise.rollback.executed':
    case 'enterprise.rollback.failed': {
      const rollbackId = readId(payload, 'rollbackId')
      const actionId = readId(payload, 'actionId')
      const environmentId = readId(payload, 'environmentId')
      if (rollbackId === '' || actionId === '' || environmentId === '') {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A rollback record could not be read.' })
        return state
      }
      // A rollback must name an action that exists and an environment that exists.
      // Without this check a hand-edited journal could attribute a rollback to an action
      // that never ran, and the audit would claim a reversal of something that never
      // happened — which is the one record an owner has most reason to distrust.
      if (state.environments[environmentId] === undefined) {
        anomalies.push({ code: 'unknown-record', eventType: typed, detail: 'No such environment for this rollback.' })
        return state
      }
      // A rollback must name an action the journal knows about. Checked unconditionally
      // rather than "only when other operations exist", because the attack is exactly the
      // case where the journal is otherwise empty: a lone forged rollback claiming a
      // reversal of something that never ran.
      const knownAction =
        Object.values(state.operations).some((operation) => operation.operationId === actionId) ||
        Object.keys(state.verifications).some((id) => id === actionId)
      if (!knownAction) {
        anomalies.push({
          code: 'unknown-record',
          eventType: typed,
          detail: 'No such action for this rollback. An audit claiming a reversal of something that never ran is refused.',
        })
        return state
      }
      const outcome =
        typed === 'enterprise.rollback.failed'
          ? 'failed'
          : payload.outcome === 'success' ||
              payload.outcome === 'partial' ||
              payload.outcome === 'failed' ||
              payload.outcome === 'not-reversible'
            ? payload.outcome
            : null
      if (outcome === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A rollback outcome could not be read.' })
        return state
      }
      const record: RollbackRecord = {
        rollbackId,
        actionId,
        environmentId,
        outcome,
        reason: readText(payload, 'reason') ?? 'no reason recorded',
        rolledBackAt: at,
      }
      return {
        ...state,
        rollbacks: appendBounded(state.rollbacks, record, ENTERPRISE_LIMITS.maxRollbacksPerEnvironment * ENTERPRISE_LIMITS.maxEnvironments),
      }
    }

    /* -------------------------------------------------- lifecycle */
    case 'enterprise.action.refused': {
      const actionId = readString(payload, 'actionId')
      const environmentId = readString(payload, 'environmentId')
      if (actionId === null || environmentId === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A refusal could not be read.' })
        return state
      }
      const refusal: EnterpriseRefusal = {
        actionId,
        environmentId,
        gate: readText(payload, 'gate') ?? 'unknown',
        code: readText(payload, 'code') ?? 'unknown',
        reason: readText(payload, 'reason') ?? 'no reason recorded',
        at,
      }
      return {
        ...state,
        refusals: appendBounded(state.refusals, refusal, ENTERPRISE_LIMITS.maxRetainedRefusals),
        lastRefusal: refusal,
      }
    }

    case 'enterprise.continuation.decided': {
      const environmentId = readString(payload, 'environmentId')
      if (environmentId === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A continuation could not be read.' })
        return state
      }
      return { ...state, lastContinuation: { environmentId, decision: readText(payload, 'decision') ?? 'unknown' } }
    }

    case 'enterprise.wake.received': {
      const wakeKey = readText(payload, 'wakeKey')
      if (wakeKey === null) {
        anomalies.push({ code: 'malformed-payload', eventType: typed, detail: 'A wake key could not be read.' })
        return state
      }
      if (state.wakeKeys.includes(wakeKey)) {
        anomalies.push({ code: 'duplicate-record', eventType: typed, detail: 'That wake has already been seen.' })
        return state
      }
      return { ...state, wakeKeys: appendBounded(state.wakeKeys, wakeKey, 256) }
    }

    case 'enterprise.wake.denied':
    case 'enterprise.action.started':
    case 'enterprise.reconciled':
    case 'enterprise.stopped':
      // Lifecycle bookkeeping. Recorded by their presence in the journal and read by
      // the projection, which does not need them folded into a record. A `stopped`
      // with an environment id is surfaced by the projection rather than by mutating
      // the environment's state here: a stop is the owner's, and it is lifted by the
      // owner, not by the fold.
      return state

    default:
      return state
  }
}

/**
 * Resolve an approval transition, naming the specific mistake.
 *
 * `granted -> revoked` is the only edge out of a "settled" state, so an entry trying to
 * re-grant a revoked approval, or to grant one twice, is refused here. Reported as
 * `terminal-state-re-entered` because that is exactly what it is: an approval that was
 * finished being made to answer again.
 */
function resolveApprovalTransition(
  current: ApprovalState,
  to: ApprovalState,
): { readonly reason: string; readonly finished: boolean } | null {
  const allowed = APPROVAL_TRANSITIONS.some((edge) => edge.from === current && edge.to === to)
  if (allowed) return null
  const finished = current === 'denied' || current === 'revoked' || current === 'expired'
  return {
    reason: finished
      ? `This approval is already ${current}, and only the owner may move it from here.`
      : `No edge from ${current} to ${to}.`,
    finished,
  }
}

/* ------------------------------------------------------------- entry points */

/** Fold the whole journal. */
export function reduceEnterpriseState(
  entries: readonly EnterpriseJournalEntry[],
): FoldResult {
  let state = initialEnterpriseState()
  const anomalies: FoldAnomaly[] = []
  for (const entry of entries) {
    state = applyEntry(state, entry, anomalies)
  }
  return { state, anomalies }
}

/**
 * Fold one entry onto a state the caller already holds.
 *
 * Exposed so a runtime can keep its state and fold incrementally, and so a test can
 * fold an attacker-supplied single entry without having to build a plausible history
 * around it.
 */
export function reduceEnterpriseEntry(
  state: EnterpriseState,
  entry: EnterpriseJournalEntry,
): FoldResult {
  const anomalies: FoldAnomaly[] = []
  const next = applyEntry(state, entry, anomalies)
  return { state: next, anomalies }
}

/** The counts the boundary gate needs, derived rather than tracked. */
export function countsFor(state: EnterpriseState, environmentId: string): CountContext {
  const tasks = Object.values(state.tasks).filter((task) => task.environmentId === environmentId)
  const missions = Object.values(state.missions).filter((mission) => mission.environmentId === environmentId)
  const operations = Object.values(state.operations).filter(
    (operation) => operation.environmentId === environmentId,
  )
  return {
    tasks: tasks.length,
    missions: missions.length,
    operations: operations.length,
    concurrent: [...tasks, ...missions, ...operations].filter((record) => record.state === 'active').length,
  }
}

/** The day key for an instant, re-exported so the fold and the gate agree. */
export { dayKeyOf }

/** The closed state vocabularies, for exhaustive tests. */
export function enterpriseVocabularies() {
  return {
    environmentStates: ENVIRONMENT_STATES,
    taskStates: TASK_STATES,
    missionStates: MISSION_STATES,
    operationStates: WEBZONE_OPERATION_STATES,
    approvalStates: APPROVAL_STATES,
    catalogItemStates: CATALOG_ITEM_STATES,
    customerStates: CUSTOMER_STATES,
    operationKinds: WEBZONE_OPERATION_KINDS,
    spendingGates: SPENDING_GATE_KINDS,
  }
}

export type { ApprovalKind, ApprovalState, ApprovalSubjectKind, CatalogItemKind, CatalogItemState, CustomerState, SpendingGateKind }