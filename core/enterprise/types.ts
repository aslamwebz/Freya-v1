/**
 * Phase 33 — Autonomous Enterprise / Webzone: compile-time contracts.
 *
 * **Status:** self-contained domain slice. Not wired into Core, not on a composition
 * root, and not reachable from a renderer. See `README.md` in this directory for why.
 *
 * Everything in this file is data. There is no clock read, no journal write, no
 * network call and no provider anywhere below `./ports`, and the reason is not
 * tidiness: the central claim of this phase is that Freya cannot widen its own
 * authority or spend money while operating a business. That claim is only worth
 * anything if the code which *decides* those questions has no way to perform the
 * actions it is deciding about.
 *
 * Three vocabularies here are load-bearing in a way the rest are not:
 *
 *   - {@link FORBIDDEN_ENTERPRISE_ACTIONS} is the absolute, code-owned deny list.
 *     An environment may *add* to it and nothing may remove from it. This is where
 *     "no real money" is actually enforced rather than merely stated.
 *   - {@link ENTERPRISE_LIMITS} is frozen and can only be narrowed, never widened,
 *     and {@link ENTERPRISE_LIMITS} has no setter at all.
 *   - {@link ENTERPRISE_PAYLOAD_KEYS} is the per-event key table the journal rule and
 *     the fold are both checked against, so the validator cannot drift from the fold.
 */

/* ------------------------------------------------------------------ guards */

function isClosed<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
}

/**
 * Is this a name from the authorization gate list?
 *
 * Declared here, ahead of the list it tests, because function declarations hoist. It
 * exists because `gate` names two different closed sets depending on the event — the
 * spending gate on a `spending-gate.*` entry, the *authorization* gate that refused on
 * an `action.refused` entry — and a refusal that cannot say which gate stopped it is not
 * an audit record.
 */
export function isAuthorizationGate(value: unknown): value is AuthorizationGate {
  return typeof value === 'string' && (AUTHORIZATION_GATES as readonly string[]).includes(value)
}

/* ------------------------------------------------------- business environment */

/**
 * The closed set of environment states.
 *
 * `completed`, `failed` and `cancelled` are terminal: the table in `./machine` has
 * no edge out of any of them, so an environment that reached one cannot be
 * re-entered and cannot be "revived" by a later event.
 */
export const ENVIRONMENT_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type EnvironmentState = (typeof ENVIRONMENT_STATES)[number]
export const isEnvironmentState = isClosed(ENVIRONMENT_STATES)

/** The closed set of environment kinds. */
export const ENVIRONMENT_KINDS = ['webzone', 'marketplace', 'service', 'content'] as const
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number]
export const isEnvironmentKind = isClosed(ENVIRONMENT_KINDS)

/* ------------------------------------------------------------------ catalog */

/**
 * What an environment is actually operating: projects, products and services.
 *
 * A separate vocabulary from `ENVIRONMENT_KINDS` because the two answer different
 * questions. An environment *kind* says what sort of business this is; an item *kind*
 * says what is in it. A `webzone` environment can hold a project, a product and a
 * service at once, and collapsing the two would put the environment's 90-day duration
 * ceiling and 64-task ceiling onto each of them individually — which is wrong, and
 * wrong in the direction of a larger blast radius.
 */
export const CATALOG_ITEM_KINDS = ['project', 'product', 'service'] as const
export type CatalogItemKind = (typeof CATALOG_ITEM_KINDS)[number]
export const isCatalogItemKind = isClosed(CATALOG_ITEM_KINDS)

/** Catalog items share the environment lifecycle: the same six states, the same table. */
export const CATALOG_ITEM_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type CatalogItemState = (typeof CATALOG_ITEM_STATES)[number]
export const isCatalogItemState = isClosed(CATALOG_ITEM_STATES)

/* ---------------------------------------------------------------- customers */

/**
 * The closed set of customer-record states.
 *
 * `withdrawn` is the third and it is the one that matters: a customer record is a
 * record about a *third party*, so being able to withdraw it is not a nicety. There
 * is no `deleted` state, because deletion would erase the fact that something was
 * withdrawn and the audit trail has to be able to say that it happened.
 */
export const CUSTOMER_STATES = ['active', 'paused', 'withdrawn'] as const
export type CustomerState = (typeof CUSTOMER_STATES)[number]
export const isCustomerState = isClosed(CUSTOMER_STATES)

/**
 * Words that may never appear in a customer record.
 *
 * A customer is somebody who is not the owner. Everything in this list is money, a
 * credential, or a way to impersonate the owner, and none of it has any business in a
 * record this subsystem can write. Enforced on the *value*, not only on the field
 * name: an allowlist of field names is defeated by putting a card number in a field
 * called `note`, and "no field is called cardNumber" was never the property anybody
 * wanted.
 */
export const FORBIDDEN_CUSTOMER_VALUE_WORDS: readonly string[] = Object.freeze([
  'iban',
  'bic',
  'swift',
  'sortcode',
  'routing',
  'accountnumber',
  'cardnumber',
  'cvv',
  'cvc',
  'password',
  'passphrase',
  'apikey',
  'token',
  'secret',
  'privatekey',
  'credential',
  'wallet',
  'cryptoaddress',
])

/**
 * A run of 12 to 19 digits, optionally grouped by spaces or hyphens.
 *
 * Card numbers, IBANs and long account numbers are mostly digits, so no word list
 * catches them: `4111 1111 1111 1111` contains no word at all. This is a separate check
 * rather than an entry in the word list for the same reason the word list is a word
 * list — a *numeric* shape is a different kind of evidence.
 *
 * The bound is 12 to 19 because that is the range real card numbers occupy, and it is
 * deliberately not extended downwards: a 7-digit customer reference is legitimate and
 * refusing it would make this filter something people switch off.
 */
export const FORBIDDEN_CUSTOMER_DIGIT_RUN = Object.freeze({
  minDigits: 12,
  maxDigits: 19,
})

/** States from which no transition exists. */
export const TERMINAL_ENVIRONMENT_STATES: readonly EnvironmentState[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
])

/* --------------------------------------------------------------- boundaries */

/**
 * The absolute, code-owned actions the enterprise subsystem may never perform.
 *
 * This is the single most important table in the phase, and the property that makes
 * it one is the direction in which it moves: an environment's own
 * `forbiddenActions` list is *unioned* with this one, and there is no code path,
 * event type or payload shape anywhere in Phase 33 that removes an entry from it.
 * A caller that supplies an empty deny list, or one that tries to supply a
 * "permission" list, gets the same answer as a caller that supplies the full one.
 *
 * Every entry is here because it is either irreversible, legally binding, spends
 * real money, or mints authority. Phase 33 has no capability that could perform
 * any of them; refusing them in code means the refusal does not depend on the
 * absence of that capability continuing to hold.
 */
export const FORBIDDEN_ENTERPRISE_ACTIONS = [
  'real-money-transfer',
  'real-money-payment',
  'place-real-order',
  'real-trading',
  'open-account',
  'close-account',
  'accept-contract',
  'enter-legal-commitment',
  'sign-agreement',
  'create-cognition-grant',
  'grant-authority',
  'widen-spending-limit',
  'widen-enterprise-boundary',
  'disable-stop-all',
  'clear-stop-all',
  'self-approve',
  'approve-own-request',
  'bypass-guard',
  'bypass-governor',
  'fabricate-verification',
  'fabricate-evidence',
  'forge-owner-approval',
] as const
export type ForbiddenEnterpriseAction = (typeof FORBIDDEN_ENTERPRISE_ACTIONS)[number]
export const isForbiddenEnterpriseAction = isClosed(FORBIDDEN_ENTERPRISE_ACTIONS)

/**
 * The action classes that describe an operation's *effect*, closed and ordered from
 * least to most consequential.
 *
 * `read` cannot change the world and therefore cannot be consequential; `commit`
 * binds the owner to something they cannot take back and is refused outright as a
 * Phase 33 operation kind (see `WEBZONE_OPERATION_KINDS`, which contains no member
 * of `commit` or `spend`). The ordering exists so "is this consequential" is a
 * comparison rather than a judgement call.
 */
export const ACTION_CONSEQUENCE_CLASSES = ['read', 'reversible-write', 'destructive'] as const
export type ActionConsequenceClass = (typeof ACTION_CONSEQUENCE_CLASSES)[number]

/** The forbidden actions that name a real-world or authority effect, grouped for tests. */
export const REAL_MONEY_ACTIONS: readonly ForbiddenEnterpriseAction[] = Object.freeze([
  'real-money-transfer',
  'real-money-payment',
  'place-real-order',
  'real-trading',
])

export const AUTHORITY_ACTIONS: readonly ForbiddenEnterpriseAction[] = Object.freeze([
  'create-cognition-grant',
  'grant-authority',
  'widen-spending-limit',
  'widen-enterprise-boundary',
  'disable-stop-all',
  'clear-stop-all',
  'self-approve',
  'approve-own-request',
  'bypass-guard',
  'bypass-governor',
  'forge-owner-approval',
])

export const BINDING_ACTIONS: readonly ForbiddenEnterpriseAction[] = Object.freeze([
  'open-account',
  'close-account',
  'accept-contract',
  'enter-legal-commitment',
  'sign-agreement',
])

/* ----------------------------------------------------------------- spending */

/**
 * The three spending gates.
 *
 * A single action must pass all three before it may proceed, and the per-day gate is
 * evaluated against a *day key* supplied by the caller rather than read from a clock
 * here, because this module has no clock.
 */
export const SPENDING_GATE_KINDS = ['total', 'per-action', 'per-day'] as const
export type SpendingGateKind = (typeof SPENDING_GATE_KINDS)[number]
export const isSpendingGateKind = isClosed(SPENDING_GATE_KINDS)

/**
 * Owner-set spending ceilings for one environment.
 *
 * **All amounts are integer minor units** — cents, pence, fils — never floating
 * point currency. A float ceiling is a real bug waiting for a real amount: `0.1 +
 * 0.2 > 0.3` is true, so a gate built on floats can refuse an action that is
 * exactly at the limit and, worse, can let one through that is exactly over it.
 * `readSpendingLimits` refuses a non-integer or negative amount outright rather than
 * rounding it, because a silently rounded ceiling is a ceiling the owner did not set.
 *
 * `hardCeiling` is part of the record rather than an option: the phase specifies it
 * as always-true, so a record that says `false` is malformed and is refused rather
 * than being honoured as a soft limit.
 */
export interface SpendingLimits {
  readonly maxTotalSpend: number
  readonly maxPerAction: number
  readonly maxPerDay: number
  readonly currency: string
  readonly hardCeiling: boolean
}

/* --------------------------------------------------------------------- tasks */

export const TASK_STATES = ['draft', 'active', 'paused', 'completed', 'failed', 'cancelled'] as const
export type TaskState = (typeof TASK_STATES)[number]
export const isTaskState = isClosed(TASK_STATES)

export const MISSION_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type MissionState = (typeof MISSION_STATES)[number]
export const isMissionState = isClosed(MISSION_STATES)

/* ------------------------------------------------------------------ webzone */

/**
 * Webzone operation kinds.
 *
 * Note what is absent: there is no `pay`, `order`, `subscribe`, `sign` or `transfer`.
 * The absence is the guarantee — an operation cannot be *described* as moving money
 * or accepting a contract, so the forbidden-action check in `./boundaries` never has
 * to be the thing that stops it.
 */
export const WEBZONE_OPERATION_KINDS = ['publish', 'update', 'delete', 'query', 'interact'] as const
export type WebzoneOperationKind = (typeof WEBZONE_OPERATION_KINDS)[number]
export const isWebzoneOperationKind = isClosed(WEBZONE_OPERATION_KINDS)

export const WEBZONE_OPERATION_STATES = [
  'pending',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type WebzoneOperationState = (typeof WEBZONE_OPERATION_STATES)[number]
export const isWebzoneOperationState = isClosed(WEBZONE_OPERATION_STATES)

/**
 * What each webzone kind does to the world, code-owned.
 *
 * A table rather than a property of the record, because "is deleting reversible"
 * must not be a field an operation can set about itself. `delete` is `destructive`
 * *in principle* and is only reversible when a preserved copy exists — which is what
 * `./rollback` checks before it will agree.
 */
export const WEBZONE_CONSEQUENCE: Readonly<Record<WebzoneOperationKind, ActionConsequenceClass>> =
  Object.freeze({
    query: 'read',
    publish: 'reversible-write',
    update: 'reversible-write',
    interact: 'reversible-write',
    delete: 'destructive',
  })

/** Operations that may never proceed without an owner approval already granted. */
export const ALWAYS_APPROVED_WEBZONE_KINDS: readonly WebzoneOperationKind[] = Object.freeze([
  'delete',
])

/** Operations that are read-only and therefore can never need an approval. */
export const NEVER_APPROVED_WEBZONE_KINDS: readonly WebzoneOperationKind[] = Object.freeze(['query'])

/* -------------------------------------------------------------- verification */

export const VERIFICATION_OUTCOMES = ['passed', 'failed', 'interrupted', 'deadline-expired'] as const
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number]
export const isVerificationOutcome = isClosed(VERIFICATION_OUTCOMES)

/* ----------------------------------------------------------------- rollback */

export const ROLLBACK_OUTCOMES = ['success', 'partial', 'failed', 'not-reversible'] as const
export type RollbackOutcome = (typeof ROLLBACK_OUTCOMES)[number]
export const isRollbackOutcome = isClosed(ROLLBACK_OUTCOMES)

/* ---------------------------------------------------------------- approvals */

export const APPROVAL_KINDS = ['action', 'spending', 'boundary'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]
export const isApprovalKind = isClosed(APPROVAL_KINDS)

export const APPROVAL_STATES = ['pending', 'granted', 'denied', 'revoked', 'expired'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]
export const isApprovalState = isClosed(APPROVAL_STATES)

export const TERMINAL_APPROVAL_STATES: readonly ApprovalState[] = Object.freeze([
  'granted',
  'denied',
  'revoked',
  'expired',
])

/**
 * What an approval is *about*.
 *
 * An approval names one subject of one kind and is spent on that subject alone. This
 * is the field that stops the most obvious approval attack: an approval the owner
 * gave for publishing one specific page cannot be presented as permission to publish
 * a different one, because `approvalCovers` compares the subject rather than
 * checking that *an* approval exists.
 */
export const APPROVAL_SUBJECT_KINDS = [
  'webzone-operation',
  'task',
  'mission',
  'environment',
  'catalog-item',
] as const
export type ApprovalSubjectKind = (typeof APPROVAL_SUBJECT_KINDS)[number]
export const isApprovalSubjectKind = isClosed(APPROVAL_SUBJECT_KINDS)

/** The closed refusal reasons. Every refusal in Phase 33 is one of these. */
export const ENTERPRISE_REFUSAL_CODES = [
  'stop-all-latched',
  'journal-untrustworthy',
  'subsystem-disabled',
  'environment-unknown',
  'environment-not-active',
  'environment-terminal',
  'deadline-expired',
  'duration-ceiling-exceeded',
  'task-count-exceeded',
  'mission-count-exceeded',
  'operation-count-exceeded',
  'item-count-exceeded',
  'customer-count-exceeded',
  'customer-withdrawn',
  'concurrent-operation-ceiling',
  'dependency-count-exceeded',
  'dependency-unmet',
  'dependency-cycle',
  'child-task-count-exceeded',
  'domain-not-allowed',
  'forbidden-action',
  'payload-too-large',
  'spending-per-action-exceeded',
  'spending-per-day-exceeded',
  'spending-total-exceeded',
  'spending-currency-mismatch',
  'spending-amount-invalid',
  'approval-required',
  'approval-missing',
  'approval-not-granted',
  'approval-subject-mismatch',
  'approval-expired',
  'approval-revoked',
  'approval-bound-exceeded',
  'verification-failed',
  'verification-missing',
  'action-not-reversible',
  'rollback-limit-exceeded',
  'retry-ceiling-reached',
  'claim-not-evidence',
  'authority-claim-refused',
  'action-unknown',
] as const
export type EnterpriseRefusalCode = (typeof ENTERPRISE_REFUSAL_CODES)[number]
export const isEnterpriseRefusalCode = isClosed(ENTERPRISE_REFUSAL_CODES)

/* ------------------------------------------------------- gateway / pipeline */

/**
 * The gates every consequential enterprise action must pass, in the one order they
 * may be evaluated.
 *
 * This is an ordered tuple and `./orchestration` walks it with a loop rather than a
 * chain of `if`s, so "no gate is ever skipped" is a property of the iteration and
 * not a property of how carefully the author remembered seven checks. `assertNoGateCanBeSkipped`
 * in `./assertions` re-derives the same order from this tuple, and the red-team suite
 * drives an action through every gate with the earlier ones failing, which is what
 * proves the ordering rather than asserting it.
 *
 * The order is not arbitrary. Cheap and absolute checks come first so that a stopped
 * Freya cannot spend a boundary check, and the two gates that can *ask the owner
 * something* (approval, then verification) come last so that Freya never interrupts
 * a person about work it was never going to be allowed to do.
 */
export const AUTHORIZATION_GATES = [
  'journal-trustworthy',
  'stop-all',
  'environment',
  'deadline',
  'duration',
  'boundary',
  'spending',
  'approval',
  'verification',
] as const
export type AuthorizationGate = (typeof AUTHORIZATION_GATES)[number]

/**
 * The closed set of continuation decisions.
 *
 * `rollback` is a decision rather than a failure because undoing something is itself
 * work that must be bounded, authorized and verified like any other.
 */
export const CONTINUATION_DECISIONS = [
  'continue',
  'pause',
  'complete',
  'fail',
  'rollback',
  'stop',
] as const
export type ContinuationDecision = (typeof CONTINUATION_DECISIONS)[number]
export const isContinuationDecision = isClosed(CONTINUATION_DECISIONS)

/* ------------------------------------------------------------------- limits */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The code-owned ceilings.
 *
 * Frozen, with no widening function anywhere in the phase. Where the owner may set a
 * limit — spending — it is set *under* these and validated against them; where the
 * phase decides the number, this table is the number.
 *
 * The values are the ones the phase specification commits to. `maxEnvironments`,
 * `maxTasksPerEnvironment` and the rest are structural bounds on how much business
 * Freya can have in flight at once, and they are deliberately small: a system whose
 * autonomous surface is sixteen environments is one whose blast radius is sixteen
 * environments.
 */
export const ENTERPRISE_LIMITS = Object.freeze({
  maxEnvironments: 16,
  maxTasksPerEnvironment: 64,
  maxMissionsPerEnvironment: 32,
  maxWebzoneOperationsPerEnvironment: 128,
  maxConcurrentOperations: 8,
  maxConcurrentTasks: 8,
  maxConcurrentMissions: 4,
  maxConcurrentWebzoneOperations: 4,
  maxTaskDependencies: 16,
  maxChildTasksPerMission: 16,
  maxWebzonePayloadBytes: 65_536,
  maxCatalogItemsPerEnvironment: 32,
  maxCustomersPerEnvironment: 64,
  /** Steps in one bounded workflow. A workflow is a straight line, never a graph. */
  maxWorkflowSteps: 32,
  /** Longest customer display name. Customers are third parties; keep it minimal. */
  maxCustomerNameLength: 80,

  maxEnvironmentDurationMs: 90 * DAY,
  maxTaskDurationMs: 30 * DAY,
  maxMissionDurationMs: 60 * DAY,
  maxWebzoneOperationDurationMs: DAY,
  maxRollbackDurationMs: DAY,

  maxRetryAttempts: 3,
  maxBackoffMs: 5 * MINUTE,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,

  maxRollbackAttempts: 3,
  maxRollbacksPerEnvironment: 32,
  maxRollbacksPerAction: 1,

  /** Pending approvals per environment, per kind. */
  maxPendingActionApprovals: 32,
  maxPendingSpendingApprovals: 16,
  maxPendingBoundaryApprovals: 8,

  /**
   * The longest string any enterprise journal payload may carry.
   *
   * The journal is the least protected file in the system. An enterprise event that
   * could carry a page of prose would turn it into a transcript of the business,
   * which is both a privacy problem and an exfiltration channel. Enforced on the
   * value, not merely documented.
   */
  maxPayloadTextLength: 200,
  /** The longest a title or description may be. */
  maxTitleLength: 120,
  maxDescriptionLength: 400,
  maxCriteriaCount: 16,
  maxCriteriaLength: 200,
  maxAllowedDomains: 64,
  maxForbiddenActionEntries: 64,
  /** Refusal and reason codes retained per environment for the owner's audit view. */
  maxRetainedRefusals: 64,
  maxRetainedActions: 64,
})

export type EnterpriseLimits = typeof ENTERPRISE_LIMITS

/**
 * A request to change a ceiling.
 *
 * Deliberately untyped as to value, for the same reason `LifeLoopLimitRequest` is: a
 * request is untrusted input, and typing the values as the frozen literals would let
 * the compiler reject the hostile case before the clamp ever saw it — which is
 * exactly the case worth testing.
 */
export type EnterpriseLimitRequest = { readonly [K in keyof EnterpriseLimits]?: unknown }

/* ------------------------------------------------------------------ journal */

export interface EnterpriseJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

export const ENTERPRISE_EVENT_TYPES = [
  'enterprise.environment.created',
  'enterprise.environment.boundaries-set',
  'enterprise.environment.spending-limits-set',
  'enterprise.environment.updated',
  'enterprise.environment.state-changed',
  'enterprise.environment.completed',
  'enterprise.environment.failed',
  'enterprise.environment.cancelled',
  'enterprise.task.created',
  'enterprise.task.state-changed',
  'enterprise.task.completed',
  'enterprise.task.failed',
  'enterprise.mission.created',
  'enterprise.mission.state-changed',
  'enterprise.mission.completed',
  'enterprise.mission.failed',
  'enterprise.catalog.item-created',
  'enterprise.catalog.item-state-changed',
  'enterprise.catalog.item.failed',
  'enterprise.customer.created',
  'enterprise.customer.state-changed',
  'enterprise.customer.withdrawn',
  'enterprise.webzone-operation.started',
  'enterprise.webzone-operation.completed',
  'enterprise.webzone-operation.failed',
  'enterprise.spending-gate.checked',
  'enterprise.spending-gate.exceeded',
  'enterprise.boundary.checked',
  'enterprise.approval.requested',
  'enterprise.approval.granted',
  'enterprise.approval.denied',
  'enterprise.approval.revoked',
  'enterprise.approval.expired',
  'enterprise.external-action.verified',
  'enterprise.external-action.failed',
  'enterprise.rollback.executed',
  'enterprise.rollback.failed',
  'enterprise.action.started',
  'enterprise.action.refused',
  'enterprise.continuation.decided',
  'enterprise.wake.received',
  'enterprise.wake.denied',
  'enterprise.reconciled',
  'enterprise.stopped',
] as const

export type EnterpriseEventType = (typeof ENTERPRISE_EVENT_TYPES)[number]
export const ENTERPRISE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(ENTERPRISE_EVENT_TYPES)

/**
 * The keys each event may carry.
 *
 * Checked *against* the fold rather than in place of it, so a payload cannot be
 * narrower (an unread field that would silently do nothing) or wider (a field no rule
 * reads, which is a field someone can use to smuggle something). An event type
 * missing from this table is a programming error and is refused by the fold.
 */
export const ENTERPRISE_PAYLOAD_KEYS: Readonly<Record<EnterpriseEventType, readonly string[]>> =
  Object.freeze({
    'enterprise.environment.created': [
      'environmentId',
      'kind',
      'state',
      'title',
      'at',
    ],
    'enterprise.environment.updated': ['environmentId', 'at'],
    // Boundaries and spending limits are *journaled*, not merely held in the runtime.
    //
    // Holding them in memory was the first version and it is wrong in a way that only
    // shows up on restart: a process that came back would have an environment with no
    // ceilings at all, and the gate's answer to "no limits recorded" must be a refusal
    // rather than an absence. Journaling them means the ceilings survive a restart and
    // an owner can read what they actually agreed to.
    'enterprise.environment.boundaries-set': [
      'environmentId',
      'maxTasks',
      'maxMissions',
      'maxWebzoneOperations',
      'maxConcurrentOperations',
      'at',
    ],
    'enterprise.environment.spending-limits-set': [
      'environmentId',
      'maxTotalSpend',
      'maxPerAction',
      'maxPerDay',
      'currency',
      'hardCeiling',
      'at',
    ],
    'enterprise.environment.state-changed': [
      'environmentId',
      'from',
      'to',
      'code',
      'reason',
      'at',
    ],
    'enterprise.environment.completed': ['environmentId', 'at'],
    'enterprise.environment.failed': ['environmentId', 'code', 'reason', 'at'],
    'enterprise.environment.cancelled': ['environmentId', 'reason', 'at'],
    'enterprise.task.created': ['taskId', 'environmentId', 'state', 'at'],
    'enterprise.task.state-changed': [
      'taskId',
      'environmentId',
      'from',
      'to',
      'code',
      'at',
    ],
    'enterprise.task.completed': ['taskId', 'environmentId', 'at'],
    'enterprise.task.failed': ['taskId', 'environmentId', 'code', 'at'],
    'enterprise.mission.created': ['missionId', 'environmentId', 'state', 'at'],
    'enterprise.mission.state-changed': [
      'missionId',
      'environmentId',
      'from',
      'to',
      'code',
      'at',
    ],
    'enterprise.mission.completed': ['missionId', 'environmentId', 'at'],
    'enterprise.mission.failed': ['missionId', 'environmentId', 'code', 'at'],
    'enterprise.catalog.item-created': [
      'itemId',
      'environmentId',
      'itemKind',
      'name',
      'state',
      'at',
    ],
    'enterprise.catalog.item-state-changed': [
      'itemId',
      'environmentId',
      'itemKind',
      'from',
      'to',
      'code',
      'at',
    ],
    'enterprise.catalog.item.failed': ['itemId', 'environmentId', 'itemKind', 'code', 'at'],
    'enterprise.customer.created': [
      'customerId',
      'environmentId',
      'displayName',
      'state',
      'at',
    ],
    'enterprise.customer.state-changed': [
      'customerId',
      'environmentId',
      'from',
      'to',
      'code',
      'at',
    ],
    'enterprise.customer.withdrawn': ['customerId', 'environmentId', 'at'],
    'enterprise.webzone-operation.started': [
      'operationId',
      'environmentId',
      'kind',
      'target',
      'at',
    ],
    'enterprise.webzone-operation.completed': [
      'operationId',
      'environmentId',
      'verificationId',
      'at',
    ],
    'enterprise.webzone-operation.failed': [
      'operationId',
      'environmentId',
      'code',
      'reason',
      'at',
    ],
    'enterprise.spending-gate.checked': [
      'environmentId',
      'actionId',
      'gate',
      'limitMinor',
      'projectedMinor',
      'held',
      'at',
    ],
    'enterprise.spending-gate.exceeded': [
      'environmentId',
      'actionId',
      'gate',
      'limitMinor',
      'projectedMinor',
      'at',
    ],
    'enterprise.boundary.checked': [
      'environmentId',
      'actionId',
      'boundary',
      'held',
      'at',
    ],
    'enterprise.approval.requested': [
      'approvalId',
      'environmentId',
      'kind',
      'subjectKind',
      'subjectRef',
      'subjectDigest',
      'expiresAt',
      'at',
    ],
    'enterprise.approval.granted': ['approvalId', 'environmentId', 'at'],
    'enterprise.approval.denied': ['approvalId', 'environmentId', 'reason', 'at'],
    'enterprise.approval.revoked': ['approvalId', 'environmentId', 'reason', 'at'],
    'enterprise.approval.expired': ['approvalId', 'environmentId', 'at'],
    'enterprise.external-action.verified': [
      'verificationId',
      'actionId',
      'environmentId',
      'outcome',
      'reason',
      'at',
    ],
    'enterprise.external-action.failed': [
      'verificationId',
      'actionId',
      'environmentId',
      'reason',
      'at',
    ],
    'enterprise.rollback.executed': [
      'rollbackId',
      'actionId',
      'environmentId',
      'outcome',
      'reason',
      'at',
    ],
    'enterprise.rollback.failed': [
      'rollbackId',
      'actionId',
      'environmentId',
      'reason',
      'at',
    ],
    'enterprise.action.started': ['actionId', 'environmentId', 'kind', 'at'],
    'enterprise.action.refused': [
      'actionId',
      'environmentId',
      'gate',
      'code',
      'reason',
      'at',
    ],
    'enterprise.continuation.decided': ['environmentId', 'decision', 'code', 'at'],
    'enterprise.wake.received': ['wakeKey', 'source', 'at'],
    'enterprise.wake.denied': ['wakeKey', 'source', 'code', 'at'],
    'enterprise.reconciled': ['environmentId', 'from', 'to', 'code', 'at'],
    'enterprise.stopped': ['environmentId', 'code', 'at'],
  })

/**
 * Payload keys that are refused outright wherever they appear.
 *
 * Authority in Freya is minted by the Guard and the Governor and by nothing else.
 * A journal entry shaped like a capability, a grant, a verdict, a budget or an owner
 * signature is not a new field, it is an escalation attempt, and the durable journal
 * is the last place in the system where one should be able to appear. The fold
 * records these as anomalies rather than acting on them.
 */
export const FORBIDDEN_ENTERPRISE_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'capability',
  'capabilities',
  'grant',
  'grants',
  'authority',
  'authorities',
  'permission',
  'permissions',
  'privilege',
  'budget',
  'allow',
  'allowed',
  'verdict',
  'approved',
  'approvedBy',
  'ownerSignature',
  'signed',
  'token',
  'credential',
  'secret',
  'apiKey',
  'realMoney',
  'priceMinorOverride',
])

/* --------------------------------------------------------------- wake inputs */

/**
 * Where a wake may come from.
 *
 * A closed list, checked against `ENTERPRISE_WAKE_ACTOR` in `./orchestration` so a
 * source cannot be paired with an actor it has no business being paired with. A
 * renderer, a model, an external webhook and a self-scheduling timer appear nowhere
 * on the right-hand side of that table, which is what makes "no renderer may drive
 * the enterprise" a table rather than anybody's vigilance.
 */
export const ENTERPRISE_WAKE_SOURCES = [
  'owner',
  'authorized-event',
  'scheduled-heartbeat',
  'mission-transition',
  'work-transition',
  'core-subsystem',
] as const
export type EnterpriseWakeSource = (typeof ENTERPRISE_WAKE_SOURCES)[number]
export const isEnterpriseWakeSource = isClosed(ENTERPRISE_WAKE_SOURCES)

export const ENTERPRISE_WAKE_ACTORS = ['owner', 'core', 'host-heartbeat'] as const
export type EnterpriseWakeActor = (typeof ENTERPRISE_WAKE_ACTORS)[number]
export const isEnterpriseWakeActor = isClosed(ENTERPRISE_WAKE_ACTORS)

/** Which actor each source is allowed to arrive as. Anything else is a forgery. */
export const ENTERPRISE_WAKE_ACTOR: Readonly<Record<EnterpriseWakeSource, EnterpriseWakeActor>> =
  Object.freeze({
    owner: 'owner',
    'authorized-event': 'core',
    'scheduled-heartbeat': 'host-heartbeat',
    'mission-transition': 'core',
    'work-transition': 'core',
    'core-subsystem': 'core',
  })

export const ENTERPRISE_WAKE_KINDS = [
  'owner-request',
  'schedule-fired',
  'mission-transition',
  'work-transition',
  'reconcile',
  'verification-result',
] as const
export type EnterpriseWakeKind = (typeof ENTERPRISE_WAKE_KINDS)[number]
export const isEnterpriseWakeKind = isClosed(ENTERPRISE_WAKE_KINDS)