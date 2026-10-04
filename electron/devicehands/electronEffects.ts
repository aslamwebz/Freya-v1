import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import { clipboard } from 'electron'
import { SafeHttpTransport } from '../../core/research/transport'
import { assertPublicUrl } from '../../core/research/url-policy'
import type { BrowserTarget } from '../../core/research/browser'
import { ElectronBrowserTargetFactory } from '../research/managedTarget'
import {
  createDeviceHandsEffects,
  type DeviceBrowserFactory,
  type DeviceBrowserSession,
  type DeviceHandsEffects,
  type HttpGetLike,
  type HttpGetLikeResult,
  type HttpPostLike,
  type SpawnFn,
  type SpawnedProcess,
} from './effects'

/**
 * The production primitives behind the Device Hands effect adapters.
 *
 * This is the only file in the phase that imports Electron's clipboard, Node's process
 * spawner, the filesystem or a network socket. Everything it builds is handed to
 * `createDeviceHandsEffects`, which is the module the tests exercise; this file exists
 * so that "the real machine" is one small, reviewable translation layer rather than
 * being spread through the adapters.
 *
 * The clipboard is Electron's, the browser is the same sandboxed, script-free,
 * non-persistent managed target Phase 5 research already uses, and the HTTP transport
 * is the same pinned, public-address-only `SafeHttpTransport` — so a Device Hands
 * download cannot reach a private address and cannot follow a redirect off the
 * allowlisted host.
 */

/* ------------------------------------------------------------- executable */

/**
 * Resolve a bare, allowlisted program name to an executable path.
 *
 * Resolution only: the resolved path is handed to `spawn`, and the child's environment
 * is still the constructed one — `PATH` is consulted to find the program and is not
 * passed on. On Windows only real executables (`.exe`, `.com`, extensionless) are
 * resolved; a `.cmd` or `.bat` needs a shell, and this phase never uses one, so such a
 * command is reported `command-not-found` rather than being run through `cmd.exe`.
 */
export function resolveExecutableOnPath(command: string): string | null {
  if (command.length === 0 || command.includes('/') || command.includes('\\') || command.includes(':')) {
    return null
  }
  const pathValue = process.env.PATH ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : ['']
  for (const directory of pathValue.split(separator)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        // An unreadable directory is skipped rather than aborting the search.
      }
    }
  }
  return null
}

const spawnChild: SpawnFn = (file, args, options) => {
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    windowsHide: options.windowsHide,
  })
  const adapted: SpawnedProcess = {
    stdout: child.stdout === null ? null : { onData: (listener) => child.stdout?.on('data', listener) },
    stderr: child.stderr === null ? null : { onData: (listener) => child.stderr?.on('data', listener) },
    onError: (listener) => {
      child.on('error', listener)
    },
    onExit: (listener) => {
      child.on('exit', listener)
    },
    kill: () => child.kill(),
  }
  return adapted
}

/* -------------------------------------------------------------------- HTTP */

function createHttpGet(transport: SafeHttpTransport): HttpGetLike {
  return async (url, options): Promise<HttpGetLikeResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const result = await transport.get(url, {
        signal: controller.signal,
        maxBytes: options.maxBytes,
        timeoutMs: options.timeoutMs,
        redirects: options.redirects,
      })
      return {
        ok: true,
        status: result.status,
        body: result.body,
        contentType: result.headers['content-type'] ?? null,
        url: result.url,
        code: 'fetched',
      }
    } catch {
      return { ok: false, status: 0, body: new Uint8Array(0), contentType: null, url, code: 'transfer-failed' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * A pinned POST, for uploads.
 *
 * The address is resolved once and pinned into the socket lookup, exactly as the
 * research transport pins a GET, so a DNS rebind between the allowlist check and the
 * connection cannot redirect the bytes to a private address. Redirects are not
 * followed: a 3xx is returned as-is and the adapter refuses it.
 */
function createHttpPost(): HttpPostLike {
  return async (url, body, options) => {
    let parsed: URL
    try {
      parsed = assertPublicUrl(url)
    } catch {
      return { ok: false, status: 0, code: 'url-refused' }
    }
    let address: { address: string; family: number }
    try {
      const resolved = await lookup(parsed.hostname, { all: true, verbatim: true })
      const first = resolved[0]
      if (first === undefined) return { ok: false, status: 0, code: 'dns-failed' }
      address = first
    } catch {
      return { ok: false, status: 0, code: 'dns-failed' }
    }
    return await new Promise((resolve) => {
      let settled = false
      const finish = (result: { ok: boolean; status: number; code: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(
        parsed,
        {
          method: 'POST',
          agent: false,
          headers: { 'content-type': options.contentType, 'content-length': String(body.byteLength) },
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [address])
            else callback(null, address.address, address.family)
          },
          rejectUnauthorized: true,
          maxHeaderSize: 16384,
        },
        (response) => {
          let received = 0
          response.on('data', (chunk: Uint8Array) => {
            received += chunk.length
            if (received > 4096) response.destroy()
          })
          response.on('end', () => finish({ ok: true, status: response.statusCode ?? 0, code: 'posted' }))
          response.on('error', () => finish({ ok: false, status: 0, code: 'transfer-failed' }))
        },
      )
      const timer = setTimeout(() => {
        request.destroy()
        finish({ ok: false, status: 0, code: 'timeout' })
      }, options.timeoutMs)
      request.on('error', () => finish({ ok: false, status: 0, code: 'transfer-failed' }))
      request.write(body)
      request.end()
    })
  }
}

/* ----------------------------------------------------------------- browser */

class ManagedBrowserSession implements DeviceBrowserSession {
  constructor(private readonly target: BrowserTarget) {}

  async navigate(url: string): Promise<{ readonly ok: boolean; readonly finalUrl: string | null; readonly code: string }> {
    const controller = new AbortController()
    try {
      await this.target.navigate(url, controller.signal)
      return { ok: true, finalUrl: url, code: 'navigated' }
    } catch {
      return { ok: false, finalUrl: null, code: 'browser-navigate-failed' }
    }
  }

  async readText(): Promise<{ readonly ok: boolean; readonly textBytes: number; readonly code: string }> {
    const controller = new AbortController()
    try {
      const document = await this.target.read(controller.signal)
      return { ok: true, textBytes: new TextEncoder().encode(document.text).length, code: 'read' }
    } catch {
      return { ok: false, textBytes: 0, code: 'browser-read-failed' }
    }
  }

  async close(): Promise<void> {
    await this.target.close()
  }
}

class ManagedBrowserFactory implements DeviceBrowserFactory {
  constructor(private readonly factory: ElectronBrowserTargetFactory) {}

  async open(): Promise<DeviceBrowserSession> {
    const target = await this.factory.create(`device-hands-${String(Date.now())}`, new AbortController().signal)
    return new ManagedBrowserSession(target)
  }
}

/* ---------------------------------------------------------------- assembly */

export interface ElectronDeviceHandsEffectsOptions {
  /** Overrides the managed browser. For tests; production uses the real one. */
  readonly browserFactory?: DeviceBrowserFactory
  /** Notifies the host that something a surface might be showing changed. */
  readonly onChange?: () => void
}

/**
 * Build the production effects.
 *
 * Nothing is opened or spawned by constructing this: each primitive is a function that
 * acts only when an adapter calls it, and the adapters are only called after every
 * Phase 35 gate has held.
 */
export function createElectronDeviceHandsEffects(
  options: ElectronDeviceHandsEffectsOptions = {},
): DeviceHandsEffects {
  const transport = new SafeHttpTransport()
  return createDeviceHandsEffects({
    terminal: { spawn: spawnChild, resolveExecutable: resolveExecutableOnPath },
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
      clear: () => clipboard.clear(),
    },
    browser: options.browserFactory ?? new ManagedBrowserFactory(new ElectronBrowserTargetFactory(transport)),
    transfer: {
      httpGet: createHttpGet(transport),
      httpPost: createHttpPost(),
      readFile: (path) => readFile(path),
      writeFile: (path, bytes) => writeFile(path, bytes),
      statSize: async (path) => (await stat(path)).size,
    },
    ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
  })
}
