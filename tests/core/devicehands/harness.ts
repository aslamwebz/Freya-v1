import {
  DEVICE_HANDS_LIMITS,
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
  BrowserPortRequest,
  BrowserPortOutcome,
  DeviceHandsApprovalAnswer,
  DeviceHandsApprovalAsk,
  TerminalPortOutcome,
  TransferPortOutcome,
} from '../../../core/devicehands'

/**
 * A Core-free harness for the Device Hands slice.
 *
 * The point of this file is that **nothing in it can reach the disk, a browser, a
 * process or the real clipboard**. Every effect port counts its calls and returns a
 * scripted answer. That is deliberate: a test that wanted to prove "the gate ran before
 * the terminal" could not use a real Core — a real Core could have run the command
 * before the assertion did.
 *
 * Every instant is a literal and every id is a counter, so "after the deadline" means
 * exactly that and two runs over the same script produce byte-identical journals.
 */

export const T0 = '2026-07-01T09:00:00.000Z'
export const T_PLUS_30S = '2026-07-01T09:00:30.000Z'
export const T_PLUS_1M = '2026-07-01T09:01:00.000Z'
export const T_PLUS_5M = '2026-07-01T09:05:00.000Z'
export const T_PLUS_2H = '2026-07-01T11:00:00.000Z'

export const PRINCIPAL = 'owner-1'
export const SCOPE = 'session-1'
export const GRANT_ID = 'grant-1'

export const ALLOWED_ROOT = '/workspace/project'
export const VAULT_ROOT = '/user-data/Freya/vault'
export const ALLOWED_HOST = 'example.com'
export const ALLOWED_COMMAND = 'git'

export const POLICY_INPUT = Object.freeze({
  allowedRoots: [ALLOWED_ROOT],
  deniedRoots: [VAULT_ROOT],
  allowedHosts: [ALLOWED_HOST],
  allowedCommands: [ALLOWED_COMMAND, 'ls', 'cat'],
  allowedEnvNames: ['CI', 'LANG'],
  maxTransferBytes: 64 * 1024,
})

export function policy(): SurfacePolicy {
  const reading = normaliseSurfacePolicy(POLICY_INPUT)
  if (!reading.ok) {
    throw new Error(`test policy was refused: ${reading.reason}`)
  }
  return reading.policy
}

export interface HarnessEntry {
  readonly type: string
  readonly recordedAt: string
  readonly payload: Record<string, unknown>
}

export interface HarnessOptions {
  readonly clock?: string
  readonly stopAll?: boolean
  readonly journalTrustworthy?: boolean
  readonly enabled?: boolean
  /** Whether every effect port reports that it did the thing, and that it observed it. */
  readonly holds?: boolean
  /**
   * Whether the effect ports report success without observing it.
   *
   * This is the interesting failure mode: a port that says "done" is a *claim*, and the
   * verdict must be `unverified` rather than `passed`.
   */
  readonly observes?: boolean
  readonly grant?: GrantFact | null
  readonly decidedBy?: DeviceHandsApprovalAnswer['decidedBy']
  readonly granted?: boolean
  /** What the clipboard port holds. */
  readonly clipboard?: string
  /** Whether the clipboard ports report the clipboard exists at all. */
  readonly surfaceAvailable?: boolean
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

export interface Harness {
  readonly ports: DeviceHandsPorts
  readonly runtime: DeviceHandsRuntime
  readonly entries: readonly HarnessEntry[]
  /** Pre-load the journal, as a previous process would have left it. */
  seed(entries: readonly HarnessEntry[]): void
  types(): readonly string[]
  payloadsOf(type: string): readonly Record<string, unknown>[]
  setClock(instant: string): void
  setStopAll(active: boolean): void
  setEnabled(enabled: boolean): void
  setJournalTrustworthy(trustworthy: boolean): void
  setHolds(holds: boolean): void
  setObserves(observes: boolean): void
  setGrant(grant: GrantFact | null): void
  setClipboard(text: string): void
  setSurfaceAvailable(available: boolean): void
  /**
   * Hold the terminal port open until `release()` is called.
   *
   * Needed to test cancellation and the STOP ALL latch *during* an action. Without it
   * every action settles inside a single microtask, and a test of "what happens if the
   * latch is thrown while the command is running" would be a test of nothing.
   */
  block(): void
  release(): void
  /** Resolves once at least one effect has been counted, so a test can act mid-action. */
  countsChange(): Promise<void>
  counts(): EffectCounts
  calls(name: keyof EffectCounts): number
  approvalRequests(): readonly DeviceHandsApprovalAsk[]
  approvalAnswers(): readonly DeviceHandsApprovalAnswer[]
  refusals(): readonly { readonly actionId: string; readonly actionKey: string; readonly gate: string; readonly code: string; readonly reason: string }[]
  changes(): number
  /** Open, load the policy, and register the default grant. */
  ready(): Promise<void>
  /**
   * Obtain an owner approval for exactly this action body.
   *
   * It normalises the input with the *same* function the gate will use, so the digest
   * the owner is asked about is the digest the gate will check. Writing the subject by
   * hand in a test would be testing a second implementation, and a test that proves
   * "the approval matched" against a hand-rolled digest proves nothing about the real one.
   */
  approve(options: {
    readonly actionId: string
    readonly actionKey: DeviceHandsActionKey
    readonly input: Record<string, unknown>
    readonly approvalId?: string
  }): Promise<{ readonly ok: boolean; readonly approvalId: string | null; readonly reason: string }>
  /**
   * Perform one action and return both the request and the outcome.
   *
   * Returned as a pair so no test can assert on the outcome while forgetting what it
   * actually asked for — and, more importantly, so the effect counters are already on
   * screen next to the verdict, which is the only way a refusal is provable.
   */
  request(
    overrides?: Partial<RequestShape>,
  ): Promise<{ readonly request: RequestShape; readonly outcome: Awaited<ReturnType<DeviceHandsRuntime['perform']>> }>
}

/** A request as the runtime takes it. */
export interface RequestShape {
  readonly actionId: string
  readonly principalId: string
  readonly scope: string
  readonly actionKey: DeviceHandsActionKey
  readonly claimsAction: string | null
  readonly input: Record<string, unknown>
  readonly deadlineAt: string
  readonly at: string
}

export function defaultRequest(overrides: Partial<RequestShape> = {}): RequestShape {
  return {
    actionId: overrides.actionId ?? 'act-1',
    principalId: overrides.principalId ?? PRINCIPAL,
    scope: overrides.scope ?? SCOPE,
    actionKey: overrides.actionKey ?? 'browser.navigate',
    claimsAction: overrides.claimsAction ?? null,
    input: overrides.input ?? { url: `https://${ALLOWED_HOST}/about` },
    deadlineAt: overrides.deadlineAt ?? T_PLUS_30S,
    at: overrides.at ?? T0,
  }
}

export function defaultGrant(overrides: Partial<GrantFact> = {}): GrantFact {
  return {
    grantId: GRANT_ID,
    principalId: PRINCIPAL,
    scope: SCOPE,
    surfaces: ['browser', 'terminal', 'clipboard', 'transfer'],
    actions: [
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
    ],
    issuedAt: T0,
    expiresAt: T_PLUS_5M,
    revokedAt: null,
    ...overrides,
  }
}

const GRANT_ACTIONS = [
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

/** A legal terminal input, so a terminal test only has to state what it is attacking. */
export function terminalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'git',
    args: ['status'],
    workingDirectory: ALLOWED_ROOT,
    env: {},
    ...overrides,
  }
}

/** A legal clipboard-write input. */
export function clipboardInput(text: string): Record<string, unknown> {
  return { text }
}

/** A legal download input. */
export function downloadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: `https://${ALLOWED_HOST}/notes.txt`,
    destinationPath: ALLOWED_ROOT,
    fileName: 'notes.txt',
    mediaType: 'text/plain',
    bytes: 2048,
    ...overrides,
  }
}

/** A legal upload input. */
export function uploadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: `https://${ALLOWED_HOST}/inbox`,
    sourcePath: ALLOWED_ROOT,
    fileName: 'report.csv',
    mediaType: 'text/csv',
    bytes: 4096,
    ...overrides,
  }
}

/** The approval a terminal action needs, built from the same body the gate normalises. */
export function terminalApprovalBody(actionId: string, command: string, cwd: string): string {
  return canonicalDigest([
    actionId,
    'terminal.run',
    command,
    cwd,
  ])
}

export function harness(options: HarnessOptions = {}): Harness {
  const entries: HarnessEntry[] = []
  let clock = options.clock ?? T0
  let stopAll = options.stopAll ?? false
  let trustworthy = options.journalTrustworthy ?? true
  let enabled = options.enabled ?? true
  let holds = options.holds ?? true
  let observes = options.observes ?? true
  let grant = options.grant === undefined ? defaultGrant() : options.grant
  let clipboard = options.clipboard ?? 'hello'
  let surfaceAvailable = options.surfaceAvailable ?? true
  let ids = 0
  let changes = 0

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
  const asks: DeviceHandsApprovalAsk[] = []
  const answers: DeviceHandsApprovalAnswer[] = []
  let gate: Promise<void> | null = null
  let openGate: (() => void) | null = null
  const reached: (() => void)[] = []

  const outcome = (code: string): { holds: boolean; evidence: 'observed' | 'reported'; code: string } => ({
    holds,
    evidence: observes ? 'observed' : 'reported',
    code,
  })

  const ports: DeviceHandsPorts = {
    now: () => clock,
    newId: () => `h-${(ids += 1)}`,
    append: async (type: DeviceHandsEventType, payload: DeviceHandsPayload) => {
      entries.push({ type, recordedAt: clock, payload: { ...payload } })
    },
    replay: async () => entries,
    stopAllActive: () => stopAll,
    journalTrustworthy: () => trustworthy,
    enabled: () => enabled,
    activeGrant: () => grant,
    requestOwnerApproval: async (ask: DeviceHandsApprovalAsk): Promise<DeviceHandsApprovalAnswer> => {
      asks.push(ask)
      const answer: DeviceHandsApprovalAnswer = {
        approvalId: ask.approvalId,
        granted: options.granted ?? true,
        decidedBy: options.decidedBy ?? 'owner',
        decidedAt: clock,
      }
      answers.push(answer)
      return answer
    },
    approvalStillValid: () => true,
    probeSurface: async () => {
      counts.probe += 1
      return { available: surfaceAvailable, code: surfaceAvailable ? 'available' : 'unavailable' }
    },
    performBrowser: async (_request: BrowserPortRequest): Promise<BrowserPortOutcome> => {
      counts.browser += 1
      return {
        ...outcome('navigated'),
        finalUrl: `https://${ALLOWED_HOST}/about`,
        textBytes: 512,
      }
    },
    runTerminal: async (): Promise<TerminalPortOutcome> => {
      counts.terminal += 1
      for (const notify of reached.splice(0)) notify()
      if (gate !== null) await gate
      return { ...outcome('exited-0'), exitCode: 0, timedOut: false, stdoutBytes: 128, stderrBytes: 0 }
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
    onChange: () => {
      changes += 1
    },
  }

  const runtime = createDeviceHandsRuntime({ ports })

  return {
    ports,
    runtime,
    get entries() {
      return entries
    },
    seed: (prior) => {
      for (const entry of prior) entries.push({ ...entry, payload: { ...entry.payload } })
    },
    types: () => entries.map((entry) => entry.type),
    payloadsOf: (type) => entries.filter((e) => e.type === type).map((e) => e.payload),
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
    setHolds: (next) => {
      holds = next
    },
    setObserves: (next) => {
      observes = next
    },
    setGrant: (next) => {
      grant = next
    },
    setClipboard: (next) => {
      clipboard = next
    },
    setSurfaceAvailable: (next) => {
      surfaceAvailable = next
    },
    block: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    release: () => {
      const resolve = openGate
      gate = null
      openGate = null
      resolve?.()
    },
    countsChange: () =>
      new Promise<void>((resolve) => {
        reached.push(resolve)
      }),
    counts: () => ({ ...counts }),
    calls: (name) => counts[name],
    approvalRequests: () => asks,
    approvalAnswers: () => answers,
    refusals: () => runtime.refusals(),
    changes: () => changes,
    ready: async () => {
      await runtime.open()
      const loaded = await runtime.loadPolicy(POLICY_INPUT)
      if (!loaded.ok) throw new Error(`test policy was refused by the runtime: ${loaded.reason}`)
      const recorded = await runtime.registerGrant(defaultGrant())
      if (!recorded.ok) throw new Error(`test grant was refused by the runtime: ${recorded.reason}`)
    },
    request: async (overrides = {}) => {
      const shaped = defaultRequest(overrides)
      const outcome = await runtime.perform(shaped)
      return { request: shaped, outcome }
    },
    approve: async ({ actionId, actionKey, input, approvalId }) => {
      const reading = normaliseDeviceAction(policy(), actionKey, input)
      if (!reading.ok) {
        throw new Error(`test approval body was refused by the policy: ${reading.reason}`)
      }
      return runtime.requestApproval({
        approvalId: approvalId ?? `ap-${actionId}`,
        actionId,
        actionKey,
        subjectRef: actionId,
        prepared: reading.prepared,
        expiresAt: T_PLUS_5M,
      })
    },
  }
}

export { DEVICE_HANDS_LIMITS, GRANT_ACTIONS }