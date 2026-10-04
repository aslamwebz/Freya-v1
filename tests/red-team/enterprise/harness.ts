import {
  ENTERPRISE_LIMITS,
  FORBIDDEN_ENTERPRISE_ACTIONS,
  analyseZeroHiddenSpend,
  createEnterpriseRuntime,
  deriveNextBoundedAction,
  effectiveForbiddenActions,
  normaliseBoundaries,
  reduceEnterpriseState,
  verifyExternalAction,
  type ApprovalRecord,
  type EnterpriseEventType,
  type EnterpriseJournalEntry,
  type EnterprisePayload,
  type EnterprisePorts,
  type EnterpriseState,
} from '../../../core/enterprise'

/**
 * A red-team harness for the enterprise slice.
 *
 * The point of this file is that **it cannot succeed at anything**. There is no provider,
 * no gateway, no grant store, no payment rail and no network: the effect port counts
 * calls and returns a scripted answer, and the approval port reports whoever the test
 * told it to. Every test built on this therefore proves a *refusal* by asserting that a
 * counter did not move — which is the only way to prove "no real money", "no
 * autonomous action" and "no authority widening" without a real Core that might have
 * already done the thing.
 *
 * Every instant is a literal and every id is a counter, so a run is reproducible byte
 * for byte and a failure is reproducible forever.
 */

export const T0 = '2026-06-01T09:00:00.000Z'
export const T_PLUS_1M = '2026-06-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-06-01T10:00:00.000Z'
export const T_PLUS_2D = '2026-06-03T09:00:00.000Z'

export const ENV_ID = 'env-1'
export const ALLOWED_DOMAIN = 'example.com'

export const LIMITS = Object.freeze({
  maxTotalSpend: 10_000,
  maxPerAction: 2_500,
  maxPerDay: 5_000,
  currency: 'USD',
  hardCeiling: true as const,
})

export const BOUNDARIES = Object.freeze({
  maxTasks: 8,
  maxMissions: 4,
  maxWebzoneOperations: 16,
  maxConcurrentOperations: 2,
  allowedDomains: [ALLOWED_DOMAIN],
  forbiddenActions: [],
})

export interface AttackResult {
  readonly performed: boolean
  readonly refusedAt: string | null
  readonly code: string | null
  readonly reason: string
  /** How many times the bounded effect port was reached. The number that must not move. */
  readonly effects: number
  /** How many times a reversal was attempted. */
  readonly reversals: number
  /** Every journal type written, in order. */
  readonly journalTypes: readonly string[]
  /** Every payload written, for asserting on what was refused and why. */
  readonly journal: readonly EnterpriseJournalEntry[]
}

export interface AttackOptions {
  readonly stopAll?: boolean
  readonly enabled?: boolean
  readonly journalTrustworthy?: boolean
  readonly effectHolds?: boolean
  readonly decidedBy?: 'owner' | 'core'
  readonly granted?: boolean
}

export interface Attacker {
  /** An environment already open, active, and inside its ceilings. */
  ready(): Promise<void>
  /**
   * Attempt one action and report what happened, with the effect counter attached.
   *
   * The counter is attached to the result rather than read afterwards so that no test
   * can forget to check it — the whole point is that a refusal is proved by a counter
   * that did not move, and a test that does not look at the counter proves nothing.
   */
  attempt(overrides?: {
    readonly actionId?: string
    readonly kind?: 'publish' | 'update' | 'delete' | 'query' | 'interact'
    readonly target?: string
    readonly payload?: string
    readonly consequential?: boolean
    readonly amountMinor?: number
    readonly currency?: string
    readonly claimsAction?: string | null
    readonly performed?: boolean
    readonly at?: string
  }): Promise<AttackResult>
  /** Raise a wake, forged or genuine. */
  wake(wake: {
    readonly source?: string
    readonly kind?: string
    readonly actor?: string
    readonly wakeKey?: string
    readonly at?: string
  }): Promise<{ readonly accepted: boolean; readonly code: string | null; readonly reason: string }>
  /** Ask the owner for an approval, with the digest under the attacker's control. */
  seekApproval(input?: {
    readonly subjectRef?: string
    readonly subjectDigest?: string
    readonly kind?: string
    readonly subjectKind?: string
    readonly reasoning?: string
    readonly expiresAt?: string
  }): Promise<{ readonly ok: boolean; readonly reason: string; readonly approvalId: string | null }>
  /** A granted approval the attacker can present, for substitution tests. */
  grantApproval(overrides?: Partial<ApprovalRecord>): ApprovalRecord
  readonly effects: () => number
  readonly reversals: () => number
  /** Throw or clear STOP ALL between attempts, to prove the latch is read fresh. */
  setStopAll(active: boolean): void
  /** Throw or clear the journal-trustworthy flag between attempts. */
  setJournalTrustworthy(trustworthy: boolean): void
  /** Make the effect port report that the thing did or did not happen. */
  setEffectHolds(holds: boolean): void
  readonly journalTypes: () => readonly string[]
  readonly entries: () => readonly EnterpriseJournalEntry[]
  readonly journalOfType: (type: string) => EnterprisePayload | null
  readonly projection: () => ReturnType<ReturnType<typeof createEnterpriseRuntime>['projection']>
  readonly snapshot: () => EnterpriseState
  /**
   * The ports, so a test can build a second runtime over the same journal.
   *
   * Exposed deliberately: the restart-forgery suite needs to construct a fresh runtime
   * over an existing log, and handing out a copy would not test what it claims to.
   */
  readonly ports: EnterprisePorts
}

/** Build an attacker whose only capability is asking. */
export function attacker(options: AttackOptions = {}): Attacker {
  const journal: EnterpriseJournalEntry[] = []
  // `const` for everything the attacker's option bag fixes at construction. Only the
  // three the tests can move mid-run — the stop latch, the journal flag and the effect
  // result — are `let`, so "was this ever mutable?" is answerable by reading this line.
  const clock = T0
  let stopAll = options.stopAll ?? false
  let trustworthy = options.journalTrustworthy ?? true
  const enabled = options.enabled ?? true
  let effectHolds = options.effectHolds ?? true
  const decidedBy = options.decidedBy ?? 'owner'
  const granted = options.granted ?? true
  let ids = 0
  let effects = 0
  let reversals = 0

  const ports = {
    now: () => clock,
    newId: () => `a-${(ids += 1)}`,
    append: async (type: EnterpriseEventType, payload: EnterprisePayload) => {
      journal.push({ type, recordedAt: clock, payload: { ...payload } })
    },
    replay: async () => journal,
    stopAllActive: () => stopAll,
    journalTrustworthy: () => trustworthy,
    enabled: () => enabled,
    performWebzoneEffect: async () => {
      effects += 1
      return { holds: effectHolds, code: effectHolds ? 'observed' : 'not-observed', restorable: true }
    },
    reverseWebzoneEffect: async () => {
      reversals += 1
      return { holds: effectHolds, code: effectHolds ? 'reversed' : 'not-reversed', restorable: true }
    },
    requestOwnerApproval: async () => ({
      approvalId: `a-${(ids += 1)}`,
      granted,
      decidedBy,
      decidedAt: clock,
    }),
    approvalStillValid: () => true,
    onChange: () => {},
  }

  const runtime = createEnterpriseRuntime({ ports })

  return {
    ready: async () => {
      await runtime.open()
      await runtime.openEnvironment({
        environmentId: ENV_ID,
        kind: 'webzone',
        title: 'Owner site',
        boundaries: BOUNDARIES,
        spendingLimits: LIMITS,
        at: clock,
      })
    },
    attempt: async (overrides = {}) => {
      const before = effects
      const outcome = await runtime.performAction({
        actionId: overrides.actionId ?? 'act-1',
        environmentId: ENV_ID,
        kind: overrides.kind ?? 'publish',
        target: overrides.target ?? `https://${ALLOWED_DOMAIN}/about`,
        payload: overrides.payload ?? 'hello',
        consequential: overrides.consequential ?? false,
        amountMinor: overrides.amountMinor ?? 0,
        currency: overrides.currency ?? 'USD',
        claimsAction: overrides.claimsAction ?? null,
        performed: overrides.performed ?? false,
        at: overrides.at ?? clock,
      })
      return {
        performed: outcome.performed,
        refusedAt: outcome.refusedAt,
        code: outcome.code,
        reason: outcome.reason,
        effects: effects - before,
        reversals,
        journalTypes: journal.map((item) => item.type),
        journal: [...journal],
      }
    },
    wake: (wake) =>
      runtime.handleWake({
        source: wake.source ?? 'owner',
        kind: wake.kind ?? 'owner-request',
        actor: wake.actor ?? 'owner',
        environmentId: ENV_ID,
        sourceRef: null,
        wakeKey: wake.wakeKey ?? 'wake-1',
        at: wake.at ?? clock,
      }),
    seekApproval: async (input = {}) => {
      const result = await runtime.requestApproval({
        environmentId: ENV_ID,
        kind: input.kind ?? 'action',
        subjectKind: input.subjectKind ?? 'webzone-operation',
        subjectRef: input.subjectRef ?? 'act-1',
        subjectDigest: input.subjectDigest ?? 'digest-1',
        reasoning: input.reasoning ?? 'the attacker would like to proceed',
        expiresAt: input.expiresAt ?? T_PLUS_1H,
      })
      return result
    },
    grantApproval: (overrides = {}) => ({
      approvalId: 'ap-forged',
      environmentId: ENV_ID,
      kind: 'action',
      subjectKind: 'webzone-operation',
      subjectRef: 'act-1',
      subjectDigest: 'digest-1',
      reasoning: 'forged',
      state: 'granted',
      requestedAt: T0,
      decidedAt: T0,
      expiresAt: T_PLUS_2D,
      ...overrides,
    }),
    effects: () => effects,
    reversals: () => reversals,
    setStopAll: (active) => {
      stopAll = active
    },
    setJournalTrustworthy: (next) => {
      trustworthy = next
    },
    setEffectHolds: (holds) => {
      effectHolds = holds
    },
    journalTypes: () => journal.map((item) => item.type),
    entries: () => [...journal],
    journalOfType: (type) => {
      const found = journal.find((item) => item.type === type)
      return found === undefined ? null : (found.payload as EnterprisePayload)
    },
    projection: () => runtime.projection(),
    snapshot: () => runtime.snapshot(),
    ports,
  }
}

/* ------------------------------------------------------------- invariants */

/**
 * Refuse an outcome that claims a refusal while having performed something.
 *
 * The check every attack test ends with, so no individual test can forget it: an
 * outcome that says `performed: false` must be backed by `effects === 0`.
 */
export function assertNoEffect(result: AttackResult): void {
  if (!result.performed && result.effects !== 0) {
    throw new Error(
      `the runtime reported a refusal (${String(result.code)}) while performing ${String(result.effects)} effect(s)`,
    )
  }
}

/** Every absolute deny entry, so a suite can iterate the whole list. */
export function absoluteDenials(): readonly string[] {
  return FORBIDDEN_ENTERPRISE_ACTIONS
}

export { effectiveForbiddenActions, normaliseBoundaries, ENTERPRISE_LIMITS }
export { analyseZeroHiddenSpend, deriveNextBoundedAction, reduceEnterpriseState, verifyExternalAction }