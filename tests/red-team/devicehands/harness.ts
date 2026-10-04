import {
  canonicalDigest,
  createDeviceHandsRuntime,
  normaliseDeviceAction,
  normaliseSurfacePolicy,
  type DeviceHandsActionKey,
  type DeviceHandsEventType,
  type DeviceHandsPayload,
  type DeviceHandsPorts,
  type DeviceHandsRuntime,
  type GrantFact,
  type SurfacePolicy,
} from '../../../core/devicehands'
import type {
  BrowserPortOutcome,
  DeviceHandsApprovalAnswer,
  DeviceHandsApprovalAsk,
  TerminalPortOutcome,
  TransferPortOutcome,
} from '../../../core/devicehands'

/**
 * A red-team harness for the Device Hands slice.
 *
 * The point of this file is that **it cannot succeed at anything**. There is no disk, no
 * browser, no process, no clipboard and no network: every effect port counts its calls
 * and returns a scripted answer, and the approval port reports whoever the test told it
 * to. Every test built on this therefore proves a *refusal* by asserting that a counter
 * did not move — which is the only way to prove "the Vault is unreachable", "no
 * authority widening" and "no screenshot" without a real machine that might have done the
 * thing before the assertion ran.
 *
 * Every instant is a literal and every id is a counter, so a run is reproducible byte for
 * byte and a failure is reproducible forever.
 */

export const T0 = '2026-07-01T09:00:00.000Z'
export const T_PLUS_30S = '2026-07-01T09:00:30.000Z'
export const T_PLUS_5M = '2026-07-01T09:05:00.000Z'
export const T_PLUS_1D = '2026-07-02T09:00:00.000Z'

export const PRINCIPAL = 'owner-1'
export const SCOPE = 'session-1'
export const GRANT_ID = 'grant-1'

export const ALLOWED_ROOT = '/workspace/project'
export const VAULT_ROOT = '/user-data/Freya/vault'
export const ALLOWED_HOST = 'example.com'

export const POLICY_INPUT = Object.freeze({
  allowedRoots: [ALLOWED_ROOT],
  deniedRoots: [VAULT_ROOT],
  allowedHosts: [ALLOWED_HOST],
  allowedCommands: ['git', 'ls', 'cat'],
  allowedEnvNames: ['CI', 'LANG'],
  maxTransferBytes: 64 * 1024,
})

export function policy(): SurfacePolicy {
  const reading = normaliseSurfacePolicy(POLICY_INPUT)
  if (!reading.ok) throw new Error(`test policy was refused: ${reading.reason}`)
  return reading.policy
}

export interface AttackEntry {
  readonly type: string
  readonly recordedAt: string
  readonly payload: Record<string, unknown>
}

export interface EffectCounts {
  browser: number
  terminal: number
  clipboardRead: number
  clipboardWrite: number
  clipboardClear: number
  download: number
  upload: number
  probe: number
}

export interface AttackOptions {
  readonly stopAll?: boolean
  readonly enabled?: boolean
  readonly journalTrustworthy?: boolean
  readonly holds?: boolean
  readonly observes?: boolean
  readonly decidedBy?: DeviceHandsApprovalAnswer['decidedBy']
  readonly granted?: boolean
  readonly approvalStillValid?: boolean
  readonly clipboard?: string
}

export interface AttackResult {
  readonly performed: boolean
  readonly refusedAt: string | null
  readonly code: string | null
  readonly reason: string
  readonly verdict: string | null
  /** How many effect ports this one attempt reached. The number that must be zero. */
  readonly effects: number
  /** Every journal type written so far, in order. */
  readonly journalTypes: readonly string[]
  /** Whether the bytes this attempt moved. Zero unless it verifiably completed. */
  readonly bytes: number
}

export interface Attacker {
  /** Open, load the policy, and register the default grant. */
  ready(): Promise<void>
  /** Open and load the policy, but hold *no* grant. */
  readyWithoutGrant(): Promise<void>
  /** Open with no policy at all. */
  readyWithoutPolicy(): Promise<void>
  /** Attempt one action, reporting what happened with the counters attached. */
  attempt(overrides?: AttemptOverrides): Promise<AttackResult>
  /** Attempt an action and read the outcome directly, for ordering assertions. */
  raw(overrides?: AttemptOverrides): Promise<Awaited<ReturnType<DeviceHandsRuntime['perform']>>>
  /** Obtain an owner approval for this exact body, through the real approval path. */
  seekApproval(input: {
    readonly actionId?: string
    readonly actionKey?: DeviceHandsActionKey
    readonly input?: Record<string, unknown>
    readonly approvalId?: string
    readonly expiresAt?: string
  }): Promise<{ readonly ok: boolean; readonly approvalId: string | null; readonly reason: string }>
  /** Probe a surface. */
  probe(surface: string): Promise<{ readonly ok: boolean; readonly reason: string; available: boolean | null }>
  /** Try to swap the policy underneath the record. */
  swapPolicy(next: unknown): Promise<{ readonly ok: boolean; readonly code: string | null; readonly reason: string }>
  /** Try to register a grant. */
  grant(overrides: Partial<GrantFact>): Promise<{ readonly ok: boolean; readonly code: string | null; readonly reason: string }>
  /** What Core reports as the live grant. */
  reportGrant(next: GrantFact | null): void
  readonly runtime: DeviceHandsRuntime
  readonly entries: readonly AttackEntry[]
  /**
   * Plant one entry in the journal, as a previous process would have left it.
   *
   * Exposed for the restart-truthfulness attacks, which need a journal that stops
   * halfway — the one thing a well-behaved runtime will never write on its own.
   */
  seed(entry: AttackEntry): void
  readonly counts: () => EffectCounts
  readonly calls: (name: keyof EffectCounts) => number
  readonly effects: () => number
  readonly journalTypes: () => readonly string[]
  readonly snapshot: () => ReturnType<DeviceHandsRuntime['snapshot']>
  /** Restart over the same journal, as a new process would. */
  restart(): Promise<DeviceHandsRuntime>
  setStopAll(active: boolean): void
  setEnabled(enabled: boolean): void
  setObserves(observes: boolean): void
  setClipboard(text: string): void
}

export interface AttemptOverrides {
  readonly actionId?: string
  readonly actionKey?: DeviceHandsActionKey
  readonly principalId?: string
  readonly scope?: string
  readonly claimsAction?: string | null
  readonly input?: Record<string, unknown>
  readonly deadlineAt?: string
  readonly at?: string
}

const ALL_ACTIONS: readonly DeviceHandsActionKey[] = [
  'browser.navigate',
  'browser.read-text',
  'browser.click',
  'browser.type-text',
  'terminal.run',
  'clipboard.read',
  'clipboard.write',
  'clipboard.clear',
  'transfer.download',
  'transfer.upload',
]

export function defaultGrant(overrides: Partial<GrantFact> = {}): GrantFact {
  return {
    grantId: GRANT_ID,
    principalId: PRINCIPAL,
    scope: SCOPE,
    surfaces: ['browser', 'terminal', 'clipboard', 'transfer'],
    actions: [...ALL_ACTIONS],
    issuedAt: T0,
    expiresAt: T_PLUS_5M,
    revokedAt: null,
    ...overrides,
  }
}

/** A legal terminal body, so a terminal attack only states what it is attacking. */
export function terminalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: 'git', args: ['status'], workingDirectory: ALLOWED_ROOT, env: {}, ...overrides }
}

export function attacker(options: AttackOptions = {}): Attacker {
  const entries: AttackEntry[] = []
  const clock = T0
  let stopAll = options.stopAll ?? false
  let enabled = options.enabled ?? true
  const trustworthy = options.journalTrustworthy ?? true
  const holds = options.holds ?? true
  let observes = options.observes ?? true
  let clipboard = options.clipboard ?? 'harmless text'
  let grant: GrantFact | null = defaultGrant()
  let ids = 0

  const counts: EffectCounts = {
    browser: 0,
    terminal: 0,
    clipboardRead: 0,
    clipboardWrite: 0,
    clipboardClear: 0,
    download: 0,
    upload: 0,
    probe: 0,
  }

  const outcome = (code: string) => ({
    holds,
    evidence: observes ? ('observed' as const) : ('reported' as const),
    code,
  })

  const ports: DeviceHandsPorts = {
    now: () => clock,
    newId: () => `a-${(ids += 1)}`,
    append: async (type: DeviceHandsEventType, payload: DeviceHandsPayload) => {
      entries.push({ type, recordedAt: clock, payload: { ...payload } })
    },
    replay: async () => entries,
    stopAllActive: () => stopAll,
    journalTrustworthy: () => trustworthy,
    enabled: () => enabled,
    activeGrant: () => grant,
    requestOwnerApproval: async (ask: DeviceHandsApprovalAsk): Promise<DeviceHandsApprovalAnswer> => ({
      approvalId: ask.approvalId,
      granted: options.granted ?? true,
      decidedBy: options.decidedBy ?? 'owner',
      decidedAt: clock,
    }),
    approvalStillValid: () => options.approvalStillValid ?? true,
    probeSurface: async () => {
      counts.probe += 1
      return { available: true, code: 'available' }
    },
    performBrowser: async (): Promise<BrowserPortOutcome> => {
      counts.browser += 1
      return { ...outcome('navigated'), finalUrl: `https://${ALLOWED_HOST}/`, textBytes: 8 }
    },
    runTerminal: async (): Promise<TerminalPortOutcome> => {
      counts.terminal += 1
      return { ...outcome('exited-0'), exitCode: 0, timedOut: false, stdoutBytes: 1, stderrBytes: 0 }
    },
    readClipboard: async () => {
      counts.clipboardRead += 1
      return { text: clipboard }
    },
    writeClipboard: async () => {
      counts.clipboardWrite += 1
      return outcome('written')
    },
    clearClipboard: async () => {
      counts.clipboardClear += 1
      return outcome('cleared')
    },
    fetchDownload: async (request): Promise<TransferPortOutcome> => {
      counts.download += 1
      return { ...outcome('fetched'), bytes: request.target.bytes, mediaType: request.target.mediaType }
    },
    sendUpload: async (request): Promise<TransferPortOutcome> => {
      counts.upload += 1
      return { ...outcome('sent'), bytes: request.target.bytes, mediaType: request.target.mediaType }
    },
    onChange: () => {},
  }

  const runtime = createDeviceHandsRuntime({ ports })

  function shape(overrides: AttemptOverrides): {
    actionId: string
    principalId: string
    scope: string
    actionKey: DeviceHandsActionKey
    claimsAction: string | null
    input: Record<string, unknown>
    deadlineAt: string
    at: string
  } {
    return {
      actionId: overrides.actionId ?? 'atk-1',
      principalId: overrides.principalId ?? PRINCIPAL,
      scope: overrides.scope ?? SCOPE,
      actionKey: overrides.actionKey ?? 'browser.navigate',
      claimsAction: overrides.claimsAction ?? null,
      input: overrides.input ?? { url: `https://${ALLOWED_HOST}/about` },
      deadlineAt: overrides.deadlineAt ?? T_PLUS_30S,
      at: overrides.at ?? T0,
    }
  }

  const approvalReading = (actionKey: DeviceHandsActionKey, body: Record<string, unknown>) => {
    const reading = normaliseDeviceAction(policy(), actionKey, body)
    return reading.ok ? reading.prepared : null
  }

  return {
    runtime,
    get entries() {
      return entries
    },
    seed: (entry) => {
      entries.push({ ...entry, payload: { ...entry.payload } })
    },
    ready: async () => {
      await runtime.open()
      const loaded = await runtime.loadPolicy(POLICY_INPUT)
      if (!loaded.ok) throw new Error(`policy refused: ${loaded.reason}`)
      const recorded = await runtime.registerGrant(defaultGrant())
      if (!recorded.ok) throw new Error(`grant refused: ${recorded.reason}`)
    },
    readyWithoutGrant: async () => {
      await runtime.open()
      const loaded = await runtime.loadPolicy(POLICY_INPUT)
      if (!loaded.ok) throw new Error(`policy refused: ${loaded.reason}`)
      grant = null
    },
    readyWithoutPolicy: async () => {
      await runtime.open()
      grant = null
    },
    raw: async (overrides = {}) => runtime.perform(shape(overrides)),
    attempt: async (overrides = {}) => {
      const before = totalEffects(counts)
      const outcome = await runtime.perform(shape(overrides))
      const after = totalEffects(counts)
      return {
        performed: outcome.performed,
        refusedAt: outcome.refusedAt,
        code: outcome.code,
        reason: outcome.reason,
        verdict: outcome.verdict,
        effects: after - before,
        bytes: outcome.bytes,
        journalTypes: entries.map((entry) => entry.type),
      }
    },
    seekApproval: async (input) => {
      const actionKey = input.actionKey ?? 'terminal.run'
      const body = input.input ?? terminalInput()
      const reading = approvalReading(actionKey, body)
      if (reading === null) {
        return { ok: false, approvalId: null, reason: 'that body is not one the policy accepts' }
      }
      return runtime.requestApproval({
        approvalId: input.approvalId ?? `ap-${String(ids + 1)}`,
        actionId: input.actionId ?? 'atk-1',
        actionKey,
        subjectRef: input.actionId ?? 'atk-1',
        prepared: reading,
        expiresAt: input.expiresAt ?? T_PLUS_5M,
      })
    },
    probe: async (surface) => {
      const result = await runtime.probe(surface)
      return { ok: result.ok, reason: result.reason, available: result.outcome?.available ?? null }
    },
    swapPolicy: async (next) => runtime.loadPolicy(next),
    grant: async (overrides) => runtime.registerGrant(defaultGrant(overrides)),
    reportGrant: (next) => {
      grant = next
    },
    counts: () => ({ ...counts }),
    calls: (name) => counts[name],
    effects: () => totalEffects(counts),
    journalTypes: () => entries.map((entry) => entry.type),
    snapshot: () => runtime.snapshot(),
    restart: async () => {
      const next = createDeviceHandsRuntime({ ports })
      await next.open()
      return next
    },
    setStopAll: (active) => {
      stopAll = active
    },
    setEnabled: (next) => {
      enabled = next
    },
    setObserves: (next) => {
      observes = next
    },
    setClipboard: (next) => {
      clipboard = next
    },
  }
}

function totalEffects(counts: EffectCounts): number {
  return (
    counts.browser +
    counts.terminal +
    counts.clipboardRead +
    counts.clipboardWrite +
    counts.clipboardClear +
    counts.download +
    counts.upload
  )
}

/* --------------------------------------------------------------- invariants */

/**
 * Refuse an outcome that claims a refusal while having reached something.
 *
 * The check every attack test ends with, so no individual test can forget it: an outcome
 * with `performed: false` and a non-zero effect count is a contradiction, and it is the
 * one contradiction a red-team suite must never let through.
 */
export function assertNoEffect(result: AttackResult): void {
  if (!result.performed && result.effects !== 0) {
    throw new Error(
      `the runtime reported a refusal (${String(result.code)}) while reaching ${String(result.effects)} effect port(s)`,
    )
  }
}

/** The absolute deny list, so a suite can iterate the whole thing. */
export function absoluteDenials(): readonly string[] {
  return POLICY_INPUT.deniedRoots as readonly string[]
}

export { canonicalDigest, policy as readPolicy }