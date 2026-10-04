import {
  createDeviceHandsEffects,
  type ByteStream,
  type ClipboardLike,
  type DeviceBrowserFactory,
  type DeviceBrowserSession,
  type DeviceHandsEffects,
  type HttpGetLikeResult,
  type SpawnFn,
  type SpawnOptions,
  type SpawnedProcess,
  type TransferDeps,
} from '../../../electron/devicehands/effects'
import {
  createDeviceHandsActivation,
  type DeviceHandsActivation,
  type DeviceHandsAuthority,
} from '../../../electron/devicehands/activation'
import type {
  DeviceHandsApprovalAsk,
  DeviceHandsApprovalAnswer,
  DeviceHandsEventType,
  DeviceHandsJournalEntry,
  DeviceHandsPayload,
  GrantFact,
} from '../../../core/devicehands'
import { normaliseDeviceAction, normaliseSurfacePolicy } from '../../../core/devicehands'
import type { DeviceHandsJournal } from '../../../electron/devicehands/journal'

/**
 * A host-layer harness for Phase 42.
 *
 * It supplies every operating-system primitive with a scripted fake, so a test can
 * prove a refusal by a counter that did not move and prove an effect by the same
 * counter moving exactly once. No disk, no process, no clipboard and no network are
 * touched: the journal is in memory, the child is an object, and the transport is a
 * function.
 */

export const T0 = '2026-07-01T09:00:00.000Z'
export const T_PLUS_30S = '2026-07-01T09:00:30.000Z'
export const T_PLUS_5M = '2026-07-01T09:05:00.000Z'

export const PRINCIPAL = 'owner-1'
export const SCOPE = 'session-1'
export const GRANT_ID = 'grant-1'
export const ALLOWED_ROOT = '/workspace/project'
export const VAULT_ROOT = '/user-data/Freya/vault'
export const ALLOWED_HOST = 'example.com'

export function policyInput(): Record<string, unknown> {
  return {
    allowedRoots: [ALLOWED_ROOT],
    deniedRoots: [VAULT_ROOT],
    allowedHosts: [ALLOWED_HOST],
    allowedCommands: ['git', 'ls', 'cat'],
    allowedEnvNames: ['CI', 'LANG'],
    maxTransferBytes: 64 * 1024,
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

/* ------------------------------------------------------------------- journal */

export interface MemoryJournal extends DeviceHandsJournal {
  readonly entries: DeviceHandsJournalEntry[]
  setTrustworthy(value: boolean): void
}

export function memoryJournal(): MemoryJournal {
  const entries: DeviceHandsJournalEntry[] = []
  let trustworthy = true
  return {
    entries,
    setTrustworthy: (value: boolean) => {
      trustworthy = value
    },
    async append(type: DeviceHandsEventType, payload: DeviceHandsPayload): Promise<void> {
      entries.push({ type, recordedAt: T0, payload })
    },
    async replay(): Promise<readonly DeviceHandsJournalEntry[]> {
      return entries.slice()
    },
    trustworthy: () => trustworthy,
    path: () => 'memory',
  }
}

/* ------------------------------------------------------------------ counters */

export interface HostCounts {
  spawn: number
  resolve: number
  clipboardRead: number
  clipboardWrite: number
  clipboardClear: number
  browserOpen: number
  browserNavigate: number
  browserRead: number
  httpGet: number
  httpPost: number
  readFile: number
  writeFile: number
  statSize: number
}

export function zeroCounts(): HostCounts {
  return {
    spawn: 0,
    resolve: 0,
    clipboardRead: 0,
    clipboardWrite: 0,
    clipboardClear: 0,
    browserOpen: 0,
    browserNavigate: 0,
    browserRead: 0,
    httpGet: 0,
    httpPost: 0,
    readFile: 0,
    writeFile: 0,
    statSize: 0,
  }
}

export function totalEffects(counts: HostCounts): number {
  return (
    counts.spawn +
    counts.clipboardRead +
    counts.clipboardWrite +
    counts.clipboardClear +
    counts.browserNavigate +
    counts.browserRead +
    counts.httpGet +
    counts.httpPost
  )
}

/* ------------------------------------------------------------- fake terminal */

export class FakeChild implements SpawnedProcess {
  readonly stdout: ByteStream | null
  readonly stderr: ByteStream | null
  killed = false
  private stdoutListener: ((chunk: Uint8Array) => void) | null = null
  private stderrListener: ((chunk: Uint8Array) => void) | null = null
  private errorListener: ((error: Error) => void) | null = null
  private exitListener: ((code: number | null, signal: string | null) => void) | null = null

  constructor() {
    this.stdout = { onData: (listener) => { this.stdoutListener = listener } }
    this.stderr = { onData: (listener) => { this.stderrListener = listener } }
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListener = listener
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  emitStdout(bytes: Uint8Array): void {
    this.stdoutListener?.(bytes)
  }

  emitStderr(bytes: Uint8Array): void {
    this.stderrListener?.(bytes)
  }

  emitExit(code: number | null): void {
    this.exitListener?.(code, null)
  }

  emitError(error: Error): void {
    this.errorListener?.(error)
  }
}

export interface TerminalFake {
  readonly spawn: SpawnFn
  readonly resolveExecutable: (command: string) => string | null
  readonly calls: readonly { file: string; args: readonly string[]; options: SpawnOptions }[]
  readonly children: readonly FakeChild[]
  readonly resolve: (command: string) => string | null
  setResolve(value: (command: string) => string | null): void
}

export function terminalFake(): TerminalFake {
  const calls: { file: string; args: readonly string[]; options: SpawnOptions }[] = []
  const children: FakeChild[] = []
  let resolver: (command: string) => string | null = (command) => `/usr/bin/${command}`
  return {
    calls,
    children,
    spawn: (file, args, options) => {
      calls.push({ file, args: [...args], options })
      const child = new FakeChild()
      children.push(child)
      return child
    },
    resolve: (command) => resolver(command),
    resolveExecutable: (command) => resolver(command),
    setResolve: (value) => {
      resolver = value
    },
  }
}

/* ------------------------------------------------------------ fake clipboard */

export interface ClipboardFake extends ClipboardLike {
  value: string
  readonly counts: { read: number; write: number; clear: number }
}

export function clipboardFake(initial = ''): ClipboardFake {
  const state: ClipboardFake = {
    value: initial,
    counts: { read: 0, write: 0, clear: 0 },
    readText: () => {
      state.counts.read += 1
      return state.value
    },
    writeText: (text: string) => {
      state.counts.write += 1
      state.value = text
    },
    clear: () => {
      state.counts.clear += 1
      state.value = ''
    },
  }
  return state
}

/* -------------------------------------------------------------- fake browser */

export interface BrowserFake extends DeviceBrowserFactory {
  readonly counts: { open: number; navigate: number; read: number; close: number }
  navigateResult: { ok: boolean; finalUrl: string | null; code: string }
  readResult: { ok: boolean; textBytes: number; code: string }
}

export function browserFake(): BrowserFake {
  const counts = { open: 0, navigate: 0, read: 0, close: 0 }
  const state: BrowserFake = {
    counts,
    navigateResult: { ok: true, finalUrl: `https://${ALLOWED_HOST}/`, code: 'navigated' },
    readResult: { ok: true, textBytes: 42, code: 'read' },
    async open(): Promise<DeviceBrowserSession> {
      counts.open += 1
      return {
        async navigate() {
          counts.navigate += 1
          return state.navigateResult
        },
        async readText() {
          counts.read += 1
          return state.readResult
        },
        async close() {
          counts.close += 1
        },
      }
    },
  }
  return state
}

/* ------------------------------------------------------------- fake transfer */

export interface TransferFake extends TransferDeps {
  readonly counts: { get: number; post: number; read: number; write: number; stat: number }
  readonly files: Map<string, Uint8Array>
  getResult: HttpGetLikeResult
  postResult: { ok: boolean; status: number; code: string }
}

export function transferFake(): TransferFake {
  const counts = { get: 0, post: 0, read: 0, write: 0, stat: 0 }
  const files = new Map<string, Uint8Array>()
  const state: TransferFake = {
    counts,
    files,
    getResult: {
      ok: true,
      status: 200,
      body: new TextEncoder().encode('hello world'),
      contentType: 'text/plain',
      url: `https://${ALLOWED_HOST}/file.txt`,
      code: 'fetched',
    },
    postResult: { ok: true, status: 200, code: 'posted' },
    async httpGet(_url: string, _options): Promise<HttpGetLikeResult> {
      counts.get += 1
      return state.getResult
    },
    async httpPost(_url: string, body: Uint8Array, _options): Promise<{ ok: boolean; status: number; code: string }> {
      counts.post += 1
      // Simulate the server having received the bytes.
      files.set('uploaded', body)
      return state.postResult
    },
    async readFile(path: string): Promise<Uint8Array> {
      counts.read += 1
      return files.get(path) ?? new Uint8Array(0)
    },
    async writeFile(path: string, bytes: Uint8Array): Promise<void> {
      counts.write += 1
      files.set(path, bytes)
    },
    async statSize(path: string): Promise<number> {
      counts.stat += 1
      return files.get(path)?.byteLength ?? 0
    },
  }
  return state
}

/* ------------------------------------------------------------------ authority */

export interface AuthorityFake extends DeviceHandsAuthority {
  grant: GrantFact | null
  enabledFlag: boolean
  stopped: boolean
  approvalValid: boolean
  granted: boolean
  decidedBy: DeviceHandsApprovalAnswer['decidedBy']
}

export function authorityFake(overrides: Partial<AuthorityFake> = {}): AuthorityFake {
  const state: AuthorityFake = {
    grant: defaultGrant(),
    enabledFlag: true,
    stopped: false,
    approvalValid: true,
    granted: true,
    decidedBy: 'owner',
    stopAllActive: () => state.stopped,
    enabled: () => state.enabledFlag,
    activeGrant: (principalId, scope) =>
      state.grant !== null && state.grant.principalId === principalId && state.grant.scope === scope
        ? state.grant
        : null,
    requestOwnerApproval: async (ask: DeviceHandsApprovalAsk): Promise<DeviceHandsApprovalAnswer> => ({
      approvalId: ask.approvalId,
      granted: state.granted,
      decidedBy: state.decidedBy,
      decidedAt: T0,
    }),
    approvalStillValid: () => state.approvalValid,
    ...overrides,
  }
  return state
}

/* -------------------------------------------------------------------- harness */

export interface HostHarnessOptions {
  readonly policy?: unknown
  readonly grants?: readonly unknown[]
  readonly enabled?: boolean
  readonly terminalTimeoutMs?: number
  readonly transferTimeoutMs?: number
  /**
   * Replace the authority wholesale.
   *
   * Added because the harness otherwise hardcodes `authorityFake()`, whose
   * `activeGrant` always answers with the default unrevoked grant. That made two
   * real properties untestable from outside: that an action is refused when **no**
   * grant exists, and that a latched STOP ALL refuses an action a grant would
   * otherwise permit. Both are gate behaviour, and the gate only asks the authority
   * — so the authority has to be the thing a test varies.
   *
   * `HostHarness.authority` remains mutable, so a test can also flip the latch
   * between two actions on one harness.
   */
  readonly authority?: AuthorityFake
}

export interface HostHarness {
  readonly activation: DeviceHandsActivation
  readonly effects: DeviceHandsEffects
  readonly journal: MemoryJournal
  readonly authority: AuthorityFake
  readonly terminal: TerminalFake
  readonly clipboard: ClipboardFake
  readonly browser: BrowserFake
  readonly transfer: TransferFake
  readonly counts: HostCounts
  readonly ids: () => number
  setNow(value: string): void
  restart(): Promise<DeviceHandsActivation>
  perform(actionKey: string, input: Record<string, unknown>, overrides?: Record<string, unknown>): Promise<Awaited<ReturnType<DeviceHandsActivation['runtime']['perform']>>>
  approve(actionKey: string, input: Record<string, unknown>, actionId: string): Promise<{ ok: boolean; reason: string }>
}

export async function hostHarness(options: HostHarnessOptions = {}): Promise<HostHarness> {
  const terminal = terminalFake()
  const clipboard = clipboardFake('harmless text')
  const browser = browserFake()
  const transfer = transferFake()
  const journal = memoryJournal()
  const authority = options.authority ?? authorityFake()
  const counts = zeroCounts()
  let clock = T0
  let ids = 0

  const effects = createDeviceHandsEffects({
    terminal: {
      spawn: (file, args, spawnOptions) => {
        counts.spawn += 1
        return terminal.spawn(file, args, spawnOptions)
      },
      resolveExecutable: (command) => {
        counts.resolve += 1
        return terminal.resolve(command)
      },
      ...(options.terminalTimeoutMs === undefined ? {} : { timeoutMs: options.terminalTimeoutMs }),
    },
    clipboard: {
      readText: () => {
        counts.clipboardRead += 1
        return clipboard.readText()
      },
      writeText: (text) => {
        counts.clipboardWrite += 1
        clipboard.writeText(text)
      },
      clear: () => {
        counts.clipboardClear += 1
        clipboard.clear()
      },
    },
    browser: {
      async open() {
        counts.browserOpen += 1
        const session = await browser.open()
        return {
          async navigate(url: string, deadlineAt: string) {
            counts.browserNavigate += 1
            return session.navigate(url, deadlineAt)
          },
          async readText() {
            counts.browserRead += 1
            return session.readText()
          },
          close: () => session.close(),
        }
      },
    },
    transfer: {
      httpGet: (url, opts) => {
        counts.httpGet += 1
        return transfer.httpGet(url, opts)
      },
      httpPost: (url, body, opts) => {
        counts.httpPost += 1
        return transfer.httpPost(url, body, opts)
      },
      readFile: (path) => {
        counts.readFile += 1
        return transfer.readFile(path)
      },
      writeFile: (path, bytes) => {
        counts.writeFile += 1
        return transfer.writeFile(path, bytes)
      },
      statSize: (path) => {
        counts.statSize += 1
        return transfer.statSize(path)
      },
      ...(options.transferTimeoutMs === undefined ? {} : { timeoutMs: options.transferTimeoutMs }),
    },
    onChange: () => {},
  })

  function build(): DeviceHandsActivation {
    return createDeviceHandsActivation({
      effects,
      journal,
      authority,
      now: () => clock,
      newId: () => `a-${(ids += 1)}`,
    })
  }

  const activation = build()
  await activation.open()
  const loaded = await activation.activate({
    policy: options.policy ?? policyInput(),
    grants: options.grants ?? [defaultGrant()],
  })
  if (!loaded.ok) throw new Error(`harness activation failed: ${loaded.reason}`)
  if (options.enabled === false) authority.enabledFlag = false

  const policyReading = normaliseSurfacePolicy(options.policy ?? policyInput())
  if (!policyReading.ok) throw new Error(`harness policy failed: ${policyReading.reason}`)
  const loadedPolicy = policyReading.policy

  return {
    activation,
    effects,
    journal,
    authority,
    terminal,
    clipboard,
    browser,
    transfer,
    counts,
    ids: () => ids,
    setNow: (value: string) => {
      clock = value
    },
    restart: async () => {
      const next = build()
      await next.open()
      return next
    },
    perform: async (actionKey, input, overrides = {}) =>
      activation.runtime.perform({
        actionId: (overrides.actionId as string | undefined) ?? `act-${(ids += 1)}`,
        principalId: (overrides.principalId as string | undefined) ?? PRINCIPAL,
        scope: (overrides.scope as string | undefined) ?? SCOPE,
        actionKey: actionKey as never,
        claimsAction: null,
        input,
        deadlineAt: (overrides.deadlineAt as string | undefined) ?? T_PLUS_30S,
        at: (overrides.at as string | undefined) ?? clock,
      }),
    approve: async (actionKey, input, actionId) => {
      const normalised = normaliseDeviceAction(loadedPolicy, actionKey as never, input)
      if (!normalised.ok) return { ok: false, reason: normalised.reason }
      return activation.runtime.requestApproval({
        approvalId: `ap-${(ids += 1)}`,
        actionId,
        actionKey,
        subjectRef: actionId,
        prepared: normalised.prepared,
        expiresAt: T_PLUS_5M,
      })
    },
  }
}
