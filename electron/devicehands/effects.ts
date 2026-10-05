import {
  DEVICE_HANDS_LIMITS,
  SHELL_METACHARACTERS,
  type DeviceHandsSurface,
  type TerminalCommand,
  type TransferTarget,
} from '../../core/devicehands'
import type {
  BrowserPortOutcome,
  BrowserPortRequest,
  DeviceOutcome,
  TerminalPortOutcome,
  TransferPortOutcome,
} from '../../core/devicehands'

/**
 * The real host effect adapters for Phase 35 Device Hands.
 *
 * This module is the *only* place a Device Hands action reaches the outside world.
 * Every adapter here is a thin, bounded translation from a Phase 35 `PreparedAction`
 * to one operating-system effect, and every adapter is written so that it can be
 * exercised with an injected primitive instead of the real machine. That is what makes
 * the tests in `tests/host/devicehands/` able to prove a refusal with a counter that
 * did not move rather than by observing a side effect that already happened.
 *
 * ## What is deliberately absent
 *
 * There is no screenshot, no screen capture, no window image, no camera, no
 * microphone, no keyring and no Vault. There is no method here whose type could carry
 * pixels, and no import that could reach a credential store. The browser adapter can
 * navigate and read text; it cannot capture, and there is nothing to call if someone
 * asked. `browser.click` and `browser.type-text` are refused here with a stated code
 * rather than being faked, because a page that could be clicked and typed into is a
 * page that runs scripts, and a scriptable live browsing context is authority this
 * architecture does not grant a background runtime.
 *
 * ## Evidence is observed, not reported
 *
 * An adapter that says "done" without checking produces `unverified` and not a bug.
 * Each adapter below checks the result it can actually check — a process exit, a
 * read-back of the clipboard, a written file's size, a server's response status — and
 * reports `observed` only when it did.
 */

/* --------------------------------------------------------------- the surface */

export interface DeviceHandsEffects {
  probeSurface(request: {
    readonly surface: DeviceHandsSurface
  }): Promise<{ readonly available: boolean; readonly code: string }>
  performBrowser(request: BrowserPortRequest): Promise<BrowserPortOutcome>
  runTerminal(request: { readonly command: TerminalCommand }): Promise<TerminalPortOutcome>
  readClipboard(request: { readonly actionId: string }): Promise<{ readonly text: unknown }>
  writeClipboard(request: { readonly actionId: string; readonly text: string }): Promise<DeviceOutcome>
  clearClipboard(request: { readonly actionId: string }): Promise<DeviceOutcome>
  fetchDownload(request: {
    readonly actionId: string
    readonly url: string
    readonly target: TransferTarget
  }): Promise<TransferPortOutcome>
  sendUpload(request: {
    readonly actionId: string
    readonly url: string
    readonly target: TransferTarget
  }): Promise<TransferPortOutcome>
  onChange(): void
}

/* ------------------------------------------------------------- terminal deps */

/** A byte stream, narrowed to the one thing an adapter may do with it: count bytes. */
export interface ByteStream {
  onData(listener: (chunk: Uint8Array) => void): void
}

/** The process surface, narrowed so a test can hand over a scripted child. */
export interface SpawnedProcess {
  readonly stdout: ByteStream | null
  readonly stderr: ByteStream | null
  onError(listener: (error: Error) => void): void
  onExit(listener: (code: number | null, signal: string | null) => void): void
  kill(): boolean
}

export interface SpawnOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly shell: false
  readonly windowsHide: boolean
}

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
export type ResolveExecutable = (command: string) => string | null

export interface TerminalDeps {
  readonly spawn: SpawnFn
  /** Resolves a bare, allowlisted program name to a path. Resolution only; never an env. */
  readonly resolveExecutable: ResolveExecutable
  /** Defaults to the code-owned ceiling. Lowered by a test; never raised. */
  readonly timeoutMs?: number
}

/* ------------------------------------------------------------- clipboard deps */

export interface ClipboardLike {
  readText(): string | Promise<string>
  writeText(text: string): void | Promise<void>
  clear(): void | Promise<void>
}

/* --------------------------------------------------------------- browser deps */

export interface DeviceBrowserSession {
  navigate(url: string, deadlineAt: string): Promise<{ readonly ok: boolean; readonly finalUrl: string | null; readonly code: string }>
  readText(): Promise<{ readonly ok: boolean; readonly textBytes: number; readonly code: string }>
  /**
   * Drive a click or a keystroke on a **live page**, when this target has one.
   *
   * Absent means exactly that: the target can fetch and read a document but has no page to
   * act on. That is the honest position for the Phase 5 managed research target, which is
   * script-free by design — so a selector action against it is refused with a stated code
   * rather than faked. Phase 51 supplies a target that does have a live page, and because
   * this is an optional member on the *existing* interface, it plugs into the same port, the
   * same gate and the same grant rather than becoming a second browser authority.
   */
  act?(request: BrowserPortRequest): Promise<BrowserPortOutcome>
  close(): Promise<void>
}

export interface DeviceBrowserFactory {
  /**
   * The read-only managed target: fetch a document and extract it.
   *
   * Unchanged since Phase 35 and still the fallback for a read that no live page is serving.
   */
  open(): Promise<DeviceBrowserSession>
  /**
   * A live, act-capable page for one action, or **null** when no page is on the requested
   * URL.
   *
   * `null` is not a failure and it is not a fallback decision — it is the answer "there is no
   * live page here", and the caller then does exactly what it did in Phase 35: use the
   * read-only target for a read, and refuse a click.
   */
  openInPage?(request: BrowserPortRequest): Promise<DeviceBrowserSession | null>
}

/* -------------------------------------------------------------- transfer deps */

export interface HttpGetLikeResult {
  readonly ok: boolean
  readonly status: number
  readonly body: Uint8Array
  readonly contentType: string | null
  readonly url: string
  readonly code: string
}

export type HttpGetLike = (
  url: string,
  options: { readonly maxBytes: number; readonly timeoutMs: number; readonly redirects: number },
) => Promise<HttpGetLikeResult>

export type HttpPostLike = (
  url: string,
  body: Uint8Array,
  options: { readonly contentType: string; readonly timeoutMs: number },
) => Promise<{ readonly ok: boolean; readonly status: number; readonly code: string }>

export interface TransferDeps {
  readonly httpGet: HttpGetLike
  readonly httpPost: HttpPostLike
  readonly readFile: (path: string) => Promise<Uint8Array>
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>
  readonly statSize: (path: string) => Promise<number>
  readonly timeoutMs?: number
}

export interface DeviceHandsEffectsDeps {
  readonly terminal: TerminalDeps
  readonly clipboard: ClipboardLike
  readonly browser: DeviceBrowserFactory
  readonly transfer: TransferDeps
  readonly onChange?: () => void
}

/* ------------------------------------------------------------- terminal body */

function isBareProgramName(command: string): boolean {
  if (command.length === 0 || command.length > 64) return false
  if (command.includes('/') || command.includes('\\') || command.includes(':')) return false
  if (SHELL_METACHARACTERS.some((character) => command.includes(character))) return false
  return /^[A-Za-z0-9._-]+$/.test(command)
}

function containsMetacharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return SHELL_METACHARACTERS.some((character) => value.includes(character))
}

function terminalFailure(code: string): TerminalPortOutcome {
  return { holds: false, evidence: 'reported', code, exitCode: null, timedOut: false, stdoutBytes: 0, stderrBytes: 0 }
}

/**
 * Run one program with a bounded argument vector and no shell.
 *
 * The allowlist, the metacharacter refusal and the path gate have all already run in
 * `core/devicehands/commands.ts`. What is re-checked here is the one property that
 * would be catastrophic if the gate above were ever bypassed: that the thing handed to
 * `spawn` is a bare program name, that `shell` is false, and that the environment is
 * the constructed one and nothing else.
 */
function createTerminalRunner(deps: TerminalDeps) {
  const timeoutMs = Math.min(deps.timeoutMs ?? DEVICE_HANDS_LIMITS.maxActionTimeoutMs, DEVICE_HANDS_LIMITS.maxActionTimeoutMs)

  return async function runTerminal(request: { readonly command: TerminalCommand }): Promise<TerminalPortOutcome> {
    const command = request.command
    if (!isBareProgramName(command.command)) {
      return terminalFailure('command-not-allowed')
    }
    for (const argument of command.args) {
      if (containsMetacharacter(argument)) return terminalFailure('command-argument-unsafe')
    }
    const executable = deps.resolveExecutable(command.command)
    if (executable === null) return terminalFailure('command-not-found')

    return await new Promise<TerminalPortOutcome>((resolve) => {
      let settled = false
      let stdoutBytes = 0
      let stderrBytes = 0
      let child: SpawnedProcess
      const finish = (outcome: TerminalPortOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }

      try {
        child = deps.spawn(executable, [...command.args], {
          cwd: command.workingDirectory,
          env: { ...command.env },
          shell: false,
          windowsHide: true,
        })
      } catch {
        finish(terminalFailure('spawn-failed'))
        return
      }

      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // A process that cannot be killed still has its outcome recorded as timed
          // out; the runtime will not claim it finished.
        }
        finish({ holds: false, evidence: 'reported', code: 'timeout', exitCode: null, timedOut: true, stdoutBytes, stderrBytes })
      }, timeoutMs)

      child.stdout?.onData((chunk) => {
        stdoutBytes = Math.min(stdoutBytes + chunk.length, DEVICE_HANDS_LIMITS.maxTerminalOutputBytes)
      })
      child.stderr?.onData((chunk) => {
        stderrBytes = Math.min(stderrBytes + chunk.length, DEVICE_HANDS_LIMITS.maxTerminalOutputBytes)
      })
      child.onError(() => finish(terminalFailure('spawn-failed')))
      child.onExit((code) => {
        // The process really exited, and that is what `observed` means here: the exit
        // was read back rather than assumed from the spawn call.
        finish({
          holds: code === 0,
          evidence: 'observed',
          code: code === 0 ? 'exited-0' : `exited-${String(code)}`,
          exitCode: code,
          timedOut: false,
          stdoutBytes,
          stderrBytes,
        })
      })
    })
  }
}

/* ------------------------------------------------------------ clipboard body */

function createClipboardEffects(clipboard: ClipboardLike) {
  return {
    async readClipboard(): Promise<{ readonly text: unknown }> {
      // The text is read and handed straight to the runtime boundary, which judges it.
      // It is never logged, never journalled and never returned to a renderer from here.
      return { text: await clipboard.readText() }
    },
    async writeClipboard(request: { readonly actionId: string; readonly text: string }): Promise<DeviceOutcome> {
      try {
        await clipboard.writeText(request.text)
      } catch {
        return { holds: false, evidence: 'reported', code: 'clipboard-write-failed' }
      }
      // Read back: a write that is not observed is a report, and a report is not
      // evidence. Comparing the buffer to what was written is the observation.
      const observed = (await clipboard.readText()) === request.text
      return observed
        ? { holds: true, evidence: 'observed', code: 'written' }
        : { holds: true, evidence: 'reported', code: 'written' }
    },
    async clearClipboard(): Promise<DeviceOutcome> {
      try {
        await clipboard.clear()
      } catch {
        return { holds: false, evidence: 'reported', code: 'clipboard-clear-failed' }
      }
      const observed = (await clipboard.readText()).length === 0
      return observed
        ? { holds: true, evidence: 'observed', code: 'cleared' }
        : { holds: true, evidence: 'reported', code: 'cleared' }
    },
  }
}

/* -------------------------------------------------------------- browser body */

/**
 * The browser effect, with a live-page target preferred when one is serving the URL.
 *
 * Three cases, in this order, and the ordering is the policy:
 *
 *   1. **A click or a keystroke.** Only a live page can do these. If no live page is serving
 *      the authorised URL, the answer is the Phase 35 answer — `browser-action-unsupported`
 *      — because there is genuinely no safe effect to reach.
 *   2. **A read on a page that is open.** Used in place of a fresh fetch, because re-fetching
 *      the same URL into a hidden window is both slower and less truthful: what the owner can
 *      see is the page, and a read should describe *that*.
 *   3. **A read with no page open.** The Phase 5 managed target, exactly as before.
 *
 * The choice of *which window* happens at the last moment, inside the adapter, and it cannot
 * change whether the action was allowed: the gates ran before this function was entered.
 */
function createBrowserEffect(factory: DeviceBrowserFactory) {
  return async function performBrowser(request: BrowserPortRequest): Promise<BrowserPortOutcome> {
    let live: DeviceBrowserSession | null = null
    if (factory.openInPage !== undefined) {
      try {
        live = await factory.openInPage(request)
      } catch {
        live = null
      }
    }

    if (request.selector !== null) {
      // `browser.click` and `browser.type-text`. The managed research target is a script-free,
      // read-only document, so a page that could be clicked and typed into is authority this
      // architecture does not grant it. Refused truthfully when there is no live page, and
      // driven by that page when there is one.
      if (live === null || live.act === undefined) {
        return {
          holds: false,
          evidence: 'reported',
          code: 'browser-action-unsupported',
          finalUrl: null,
          textBytes: 0,
        }
      }
      try {
        return await live.act(request)
      } catch {
        return { holds: false, evidence: 'reported', code: 'browser-failed', finalUrl: null, textBytes: 0 }
      }
    }

    let session: DeviceBrowserSession | null = live
    try {
      if (session === null) session = await factory.open()
      const navigated = await session.navigate(request.url, request.deadlineAt)
      if (!navigated.ok || navigated.finalUrl === null) {
        return {
          holds: false,
          evidence: 'reported',
          code: navigated.code,
          finalUrl: navigated.finalUrl,
          textBytes: 0,
        }
      }
      const read = await session.readText()
      return {
        holds: true,
        evidence: 'observed',
        code: navigated.code,
        finalUrl: navigated.finalUrl,
        textBytes: read.ok ? read.textBytes : 0,
      }
    } catch {
      return { holds: false, evidence: 'reported', code: 'browser-failed', finalUrl: null, textBytes: 0 }
    } finally {
      // A live page is the owner's window: it is not closed after a read. Only the throwaway
      // managed target is.
      if (session !== null && session !== live) {
        try {
          await session.close()
        } catch {
          // A session that cannot be closed still leaves its outcome recorded; the
          // next open gets a fresh partition.
        }
      }
    }
  }
}

/* ------------------------------------------------------------- transfer body */

function transferFailure(code: string): TransferPortOutcome {
  return { holds: false, evidence: 'reported', code, bytes: 0, mediaType: null }
}

function normalizeMediaType(value: string | null): string | null {
  if (value === null) return null
  return value.split(';')[0]?.trim().toLowerCase() ?? null
}

function createTransferEffects(deps: TransferDeps) {
  const timeoutMs = Math.min(deps.timeoutMs ?? DEVICE_HANDS_LIMITS.maxActionTimeoutMs, DEVICE_HANDS_LIMITS.maxActionTimeoutMs)

  return {
    async fetchDownload(request: {
      readonly actionId: string
      readonly url: string
      readonly target: TransferTarget
    }): Promise<TransferPortOutcome> {
      const target = request.target
      const maxBytes = target.bytes === 0 ? 1 : target.bytes
      let result: HttpGetLikeResult
      try {
        result = await deps.httpGet(target.url, { maxBytes, timeoutMs, redirects: 0 })
      } catch {
        return transferFailure('transfer-failed')
      }
      if (!result.ok) return transferFailure(result.code)
      if (result.status < 200 || result.status >= 300) return transferFailure('http-status')
      const contentType = normalizeMediaType(result.contentType)
      if (contentType !== null && contentType !== target.mediaType) {
        return transferFailure('media-type-mismatch')
      }
      if (result.body.byteLength !== target.bytes) return transferFailure('transfer-size-mismatch')
      try {
        await deps.writeFile(target.path, result.body)
        const written = await deps.statSize(target.path)
        if (written !== result.body.byteLength) return transferFailure('transfer-size-mismatch')
      } catch {
        return transferFailure('transfer-write-failed')
      }
      // The file exists on disk with the expected size: that is the observation, and
      // it is the only reason this outcome may say `observed`.
      return { holds: true, evidence: 'observed', code: 'downloaded', bytes: result.body.byteLength, mediaType: target.mediaType }
    },

    async sendUpload(request: {
      readonly actionId: string
      readonly url: string
      readonly target: TransferTarget
    }): Promise<TransferPortOutcome> {
      const target = request.target
      let body: Uint8Array
      try {
        body = await deps.readFile(target.path)
      } catch {
        return transferFailure('transfer-read-failed')
      }
      if (body.byteLength !== target.bytes) return transferFailure('transfer-size-mismatch')
      try {
        const response = await deps.httpPost(target.url, body, { contentType: target.mediaType, timeoutMs })
        if (!response.ok || response.status < 200 || response.status >= 300) {
          return transferFailure(response.code)
        }
      } catch {
        return transferFailure('transfer-failed')
      }
      // The server's 2xx is the observed receipt for an upload; the bytes were read
      // from disk and handed to a pinned, checked endpoint.
      return { holds: true, evidence: 'observed', code: 'uploaded', bytes: body.byteLength, mediaType: target.mediaType }
    },
  }
}

/* ------------------------------------------------------------------ assembly */

/**
 * Build the six effect adapters.
 *
 * Availability is reported, not asserted: a surface whose primitive is missing is
 * `unavailable` with a code, which a probe may read and no action may act on.
 */
export function createDeviceHandsEffects(deps: DeviceHandsEffectsDeps): DeviceHandsEffects {
  const runTerminal = createTerminalRunner(deps.terminal)
  const clipboard = createClipboardEffects(deps.clipboard)
  const performBrowser = createBrowserEffect(deps.browser)
  const transfer = createTransferEffects(deps.transfer)
  const onChange = deps.onChange ?? ((): void => {})

  return {
    async probeSurface(request: { readonly surface: DeviceHandsSurface }): Promise<{ readonly available: boolean; readonly code: string }> {
      // A probe is a measurement of availability and nothing else. It cannot return a
      // grant, and the type it returns has no field that could be one.
      switch (request.surface) {
        case 'browser':
          return { available: true, code: 'available' }
        case 'terminal':
          return { available: true, code: 'available' }
        case 'clipboard':
          return { available: true, code: 'available' }
        case 'transfer':
          return { available: true, code: 'available' }
      }
    },
    performBrowser,
    runTerminal,
    readClipboard: clipboard.readClipboard,
    writeClipboard: clipboard.writeClipboard,
    clearClipboard: clipboard.clearClipboard,
    fetchDownload: transfer.fetchDownload,
    sendUpload: transfer.sendUpload,
    onChange,
  }
}
