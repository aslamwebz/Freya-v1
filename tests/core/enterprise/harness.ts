import {
  ENTERPRISE_LIMITS,
  accumulateSpend,
  emptyLedger,
  normaliseBoundaries,
  readSpendingLimits,
  type ApprovalRecord,
  type AuthorizationContext,
  type EnterpriseApprovalDecision,
  type EnterpriseApprovalRequest,
  type EnterpriseEffectOutcome,
  type EnterpriseEffectRequest,
  type EnterpriseEventType,
  type EnterpriseJournalEntry,
  type EnterprisePayload,
  type VerificationRecord,
} from '../../../core/enterprise'
import type { EnterprisePorts } from '../../../core/enterprise'

/**
 * A Core-free harness for the enterprise slice.
 *
 * The point of this file is that **nothing in it can spend or act for real**. There is
 * no provider, no gateway, no grant store, no payment rail and no network: the effect
 * port returns a scripted answer and counts the calls. That is deliberate, because a
 * test that wanted to prove "an authorization gate ran before the effect" could not use
 * a real Core — a real Core could have performed the effect before the assertion ran.
 *
 * Every instant is a literal and every id is a counter, so "after the deadline" means
 * exactly that, and two runs over the same script produce byte-identical journals.
 */

export const T0 = '2026-05-01T09:00:00.000Z'
export const T_PLUS_1M = '2026-05-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-05-01T10:00:00.000Z'
export const T_PLUS_25H = '2026-05-02T11:00:00.000Z'
export const T_NEXT_DAY = '2026-05-02T09:00:00.000Z'
export const T_PLUS_200D = '2026-11-17T09:00:00.000Z'

export const ENV_ID = 'env-1'
export const ALLOWED_DOMAIN = 'example.com'

/** Spending in whole USD minor units (cents), so the numbers in tests are readable. */
export const LIMITS = Object.freeze({
  maxTotalSpend: 10_000,
  maxPerAction: 2_500,
  maxPerDay: 5_000,
  currency: 'USD',
  hardCeiling: true as const,
})

export const BOUNDARIES_INPUT = Object.freeze({
  maxTasks: 8,
  maxMissions: 4,
  maxWebzoneOperations: 16,
  maxConcurrentOperations: 2,
  allowedDomains: [ALLOWED_DOMAIN],
  forbiddenActions: ['custom-forbidden-thing'],
})

export interface HarnessEntry extends EnterpriseJournalEntry {
  readonly type: string
  readonly recordedAt: string
  readonly payload: Record<string, unknown>
}

export interface HarnessOptions {
  readonly clock?: string
  readonly stopAll?: boolean
  readonly journalTrustworthy?: boolean
  readonly enabled?: boolean
  /** Whether the effect port reports that the thing happened. */
  readonly effectHolds?: boolean
  /** Whether the effect port says a restorable copy exists. */
  readonly effectRestorable?: boolean
  /** Who the approval port claims decided. */
  readonly decidedBy?: 'owner' | 'core'
  readonly granted?: boolean
}

export interface Harness {
  readonly ports: EnterprisePorts
  readonly entries: readonly HarnessEntry[]
  /** Pre-load the journal, as a previous process would have left it. */
  seed(entries: readonly HarnessEntry[]): void
  types(): readonly string[]
  setClock(instant: string): void
  setStopAll(active: boolean): void
  setEnabled(enabled: boolean): void
  setJournalTrustworthy(trustworthy: boolean): void
  setEffectHolds(holds: boolean): void
  setEffectRestorable(restorable: boolean): void
  setDecidedBy(who: 'owner' | 'core'): void
  /** How many times the effect port was reached. The spend-adjacent number. */
  effectCalls(): number
  reverseCalls(): number
  approvalRequests(): readonly EnterpriseApprovalRequest[]
  approvalDecisions(): readonly EnterpriseApprovalDecision[]
  changes(): number
  appendRefusals(): readonly string[]
}

/**
 * Build the ports a runtime needs, and record everything it writes.
 *
 * The journal is a plain array rather than a file, which is what lets the harness assert
 * the strongest property available at this level: **every payload the runtime writes
 * validates against the published per-event key table**. A payload that did not would
 * be rejected on read, which truncates the log at that line — so a mismatch is not a
 * cosmetic test failure but a corrupted journal, and it is the one failure mode a
 * runtime test can catch and a unit test cannot.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const entries: HarnessEntry[] = []
  let clock = options.clock ?? T0
  let stopAll = options.stopAll ?? false
  let trustworthy = options.journalTrustworthy ?? true
  let enabled = options.enabled ?? true
  let effectHolds = options.effectHolds ?? true
  let effectRestorable = options.effectRestorable ?? true
  let decidedBy = options.decidedBy ?? 'owner'
  let ids = 0
  let effects = 0
  let reverses = 0
  let changes = 0
  const requests: EnterpriseApprovalRequest[] = []
  const decisions: EnterpriseApprovalDecision[] = []

  const ports: EnterprisePorts = {
    now: () => clock,
    newId: () => `h-${(ids += 1)}`,
    append: async (type: EnterpriseEventType, payload: EnterprisePayload) => {
      entries.push({ type, recordedAt: clock, payload: { ...payload } })
    },
    replay: async () => entries,
    stopAllActive: () => stopAll,
    journalTrustworthy: () => trustworthy,
    enabled: () => enabled,
    performWebzoneEffect: async (_request: EnterpriseEffectRequest): Promise<EnterpriseEffectOutcome> => {
      effects += 1
      return { holds: effectHolds, code: effectHolds ? 'observed' : 'not-observed', restorable: effectRestorable }
    },
    reverseWebzoneEffect: async (_request: EnterpriseEffectRequest): Promise<EnterpriseEffectOutcome> => {
      reverses += 1
      return { holds: effectHolds, code: effectHolds ? 'reversed' : 'not-reversed', restorable: true }
    },
    requestOwnerApproval: async (request: EnterpriseApprovalRequest): Promise<EnterpriseApprovalDecision> => {
      requests.push(request)
      const decision: EnterpriseApprovalDecision = {
        approvalId: `h-${(ids += 1)}`,
        granted: options.granted ?? true,
        decidedBy,
        decidedAt: clock,
      }
      decisions.push(decision)
      return decision
    },
    approvalStillValid: () => true,
    onChange: () => {
      changes += 1
    },
  }

  return {
    ports,
    get entries() {
      return entries
    },
    seed: (prior) => {
      for (const entry of prior) entries.push({ ...entry, payload: { ...entry.payload } })
    },
    types: () => entries.map((entry) => entry.type),
    setClock: (instant) => {
      clock = instant
    },
    setStopAll: (active) => {
      stopAll = active
    },
    setEnabled: (next) => {
      enabled = next
    },
    setJournalTrustworthy: (next) => {
      trustworthy = next
    },
    setEffectHolds: (holds) => {
      effectHolds = holds
    },
    setEffectRestorable: (restorable) => {
      effectRestorable = restorable
    },
    setDecidedBy: (who) => {
      decidedBy = who
    },
    effectCalls: () => effects,
    reverseCalls: () => reverses,
    approvalRequests: () => requests,
    approvalDecisions: () => decisions,
    changes: () => changes,
    appendRefusals: () => entries.filter((entry) => entry.type === 'enterprise.action.refused').map((entry) => entry.type),
  }
}

/** The narrow boundary set, already normalised. */
export function boundaries() {
  const reading = normaliseBoundaries(BOUNDARIES_INPUT)
  if (!reading.ok || reading.boundaries === null) {
    throw new Error(`test boundaries were refused: ${reading.reason}`)
  }
  return reading.boundaries
}

/** The owner-set spending ceilings, already validated. */
export function limits() {
  const reading = readSpendingLimits(LIMITS)
  if (!reading.ok || reading.limits === null) {
    throw new Error(`test spending limits were refused: ${reading.reason}`)
  }
  return reading.limits
}

/** A legal webzone effect request, for the pipeline. */
export function actionRequest(overrides: {
  readonly actionId?: string
  readonly environmentId?: string
  readonly kind?: 'publish' | 'update' | 'delete' | 'query' | 'interact'
  readonly target?: string
  readonly payload?: string
  readonly consequential?: boolean
  readonly amountMinor?: number
  readonly currency?: string
  readonly claimsAction?: string | null
  readonly performed?: boolean
  readonly at?: string
} = {}) {
  return {
    actionId: overrides.actionId ?? 'act-1',
    environmentId: overrides.environmentId ?? ENV_ID,
    kind: overrides.kind ?? ('publish' as const),
    target: overrides.target ?? `https://${ALLOWED_DOMAIN}/about`,
    payload: overrides.payload ?? 'hello',
    consequential: overrides.consequential ?? false,
    amountMinor: overrides.amountMinor ?? 0,
    currency: overrides.currency ?? 'USD',
    claimsAction: overrides.claimsAction ?? null,
    performed: overrides.performed ?? false,
    at: overrides.at ?? T0,
  }
}

/** An authorization context whose every gate holds, overridable one gate at a time. */
export function passingContext(overrides: {
  readonly stopped?: boolean
  readonly journalTrustworthy?: boolean
  readonly enabled?: boolean
  readonly approvals?: readonly ApprovalRecord[]
  readonly verification?: VerificationRecord | null
  readonly counts?: { tasks: number; missions: number; operations: number; concurrent: number }
  readonly createdAt?: string
  readonly deadlineAt?: string | null
  readonly state?: 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled'
  readonly spentMinor?: number
} = {}): AuthorizationContext {
  let ledger = emptyLedger('USD')
  if (overrides.spentMinor !== undefined && overrides.spentMinor > 0) {
    ledger = accumulateSpend(ledger, T0, overrides.spentMinor)
  }
  return {
    enabled: overrides.enabled ?? true,
    journalTrustworthy: overrides.journalTrustworthy ?? true,
    stopped: overrides.stopped ?? false,
    environment: {
      environmentId: ENV_ID,
      state: overrides.state ?? ('active' as const),
      boundaries: boundaries(),
      spendingLimits: limits(),
      ledger,
      createdAt: overrides.createdAt ?? T0,
      deadlineAt: overrides.deadlineAt ?? null,
      counts: overrides.counts ?? { tasks: 0, missions: 0, operations: 0, concurrent: 0 },
    },
    approvals: overrides.approvals ?? [],
    verification: overrides.verification ?? null,
  }
}

export { ENTERPRISE_LIMITS }