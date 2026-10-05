import { utf8Bytes, classifyProtectedField, type BridgeFieldDescriptor } from '../../core/browserext'
import type { BrowserPortOutcome, BrowserPortRequest } from '../../core/devicehands'
import type { DeviceBrowserFactory, DeviceBrowserSession } from '../devicehands/effects'
import {
  PUBLIC_BROWSER_POOL_SIZE,
  assertNonPersistentPartition,
  type BrowserActionContext,
  type BrowserCommand,
  type BrowserAdapterPort,
  type BrowserObservation,
  type BrowserSessionPort,
} from '../../core/browser'

/**
 * The Freya Browser's implementation of the Device Hands browser port.
 *
 * This is the **second implementation of an existing port**, not a new port. The first is
 * `electron/browserext/browserAdapter.ts`, which fills the same `performBrowser` from a
 * paired Chrome extension. Both sit *downstream* of the same ten gates, receive the same
 * `BrowserPortRequest`, and return the same `BrowserPortOutcome`. That is the structural
 * statement this phase is built on: **one browser authority, two doors.**
 *
 * ## What makes this file different from the extension adapter
 *
 * The extension adapter asks a device to do something in *the person's* tab. This one asks
 * a window Freya owns. Two consequences:
 *
 *   - It is **Electron-free**. `freyaWindow.ts` owns every Electron call; this file talks
 *     to a {@link FreyaBrowserPage}, so the refusal logic below — a protected field, a
 *     click nobody observed, a page that moved — is testable without a display, which is
 *     the same reason `electron/devicehands/effects.ts` takes injected primitives.
 *   - It observes **every** act rather than reporting it. A click is `holds: false,
 *     code: 'click-unobserved'` unless the page demonstrably changed, and a keystroke is
 *     `holds: false` unless the field reads back exactly what was typed. A port that
 *     answers optimistically produces `passed` verdicts for things that never happened,
 *     and this phase has enough ways to be wrong without adding one.
 */

/* ------------------------------------------------------------------ the page */

export interface FieldDescriptor extends BridgeFieldDescriptor {
  readonly value?: string
}

/**
 * One live Freya Browser window, as this module needs it.
 *
 * Every method is bounded and answers with a code rather than throwing: a port that
 * throws is a port the runtime reports as a network-shaped failure, and a browser that
 * could not open a window is not a network error.
 */
export interface FreyaBrowserPage {
  readonly sessionId: string
  /** Where the page ended up. Null before anything has loaded. */
  currentUrl(): string | null
  /** The window's own monotonic page counter. Never decreases, never resets. */
  currentRevision(): number
  currentTitle(): string | null
  navigate(url: string): Promise<{ readonly ok: boolean; readonly finalUrl: string | null; readonly code: string }>
  read(): Promise<{ readonly ok: boolean; readonly text: string; readonly bytes: number; readonly code: string }>
  /** Raw elements and text, in the shape `describePage` normalises. */
  describe(): Promise<{ readonly ok: boolean; readonly payload: unknown; readonly code: string }>
  inspect(selector: string): Promise<{ readonly ok: boolean; readonly field: FieldDescriptor | null; readonly code: string }>
  click(selector: string): Promise<{ readonly ok: boolean; readonly changed: boolean; readonly protectedKind: string | null; readonly code: string }>
  type(selector: string, text: string): Promise<{ readonly ok: boolean; readonly changed: boolean; readonly readBack: string | null; readonly protectedKind: string | null; readonly code: string }>
  close(): Promise<void>
}

export interface FreyaBrowserPageFactory {
  create(sessionId: string, partition: string): Promise<FreyaBrowserPage>
}

export interface FreyaBrowserAdapterOptions {
  readonly factory: FreyaBrowserPageFactory
  /** Reported to the router. False when the host has not activated the browser. */
  publicAvailable: () => boolean
  readonly now?: () => number
  readonly poolSize?: number
}

/* ---------------------------------------------------------------- the adapter */

const STASH_LIMIT = 8
const STASH_TTL_MS = 60_000

function failure(code: string, textBytes = 0): BrowserPortOutcome {
  return { holds: false, evidence: 'observed', code, finalUrl: null, textBytes }
}

export interface FreyaBrowserAdapter extends BrowserAdapterPort, BrowserSessionPort {
  /** The live windows, for the host's own diagnostics. Never page content. */
  openSessions(): readonly string[]
  /**
   * The Device Hands browser factory that reaches a live Freya Browser page.
   *
   * This is the object that makes the Phase 35 runtime able to click and type: it fills the
   * **existing** `DeviceBrowserFactory`, and it is handed to the Phase 42/43 effects as
   * `openInPage`. One runtime, one grant, one gate chain, two doors.
   */
  readonly inPage: DeviceBrowserFactory
}

export function createFreyaBrowserAdapter(options: FreyaBrowserAdapterOptions): FreyaBrowserAdapter {
  const now = options.now ?? (() => Date.now())
  const poolSize = Math.min(options.poolSize ?? PUBLIC_BROWSER_POOL_SIZE, PUBLIC_BROWSER_POOL_SIZE)
  const pages = new Map<string, FreyaBrowserPage>()
  const contexts = new Map<string, BrowserActionContext>()
  const observed = new Map<string, { readonly value: BrowserObservation; readonly expiresAt: number }>()

  function stash(actionId: string, value: BrowserObservation): void {
    observed.set(actionId, { value, expiresAt: now() + STASH_TTL_MS })
    while (observed.size > STASH_LIMIT) {
      const oldest = observed.keys().next().value
      if (oldest === undefined) break
      observed.delete(oldest)
    }
  }

  /**
   * The live page on a URL, when exactly one window is serving it.
   *
   * **The rule is the URL, not an id.** `BrowserPortRequest` carries the authorised URL and
   * no session id, and that is fine: an act is applied to the window that is actually on the
   * page the authority checked. Two windows on the same URL is a refusal rather than a coin
   * toss — with two sessions the second gets its own window rather than the first's.
   *
   * A window whose session has been dropped has `currentUrl() === null`, so it can never be
   * matched here and a closed window is never acted on.
   */
  function pageOnUrl(url: string): FreyaBrowserPage | null {
    const matches = [...pages.values()].filter((page) => page.currentUrl() === url)
    if (matches.length !== 1) return null
    return matches[0] ?? null
  }

  /**
   * The page this action was routed against.
   *
   * `begin` is called by the Phase 51 runtime *before* the authority is asked, so a context
   * exists by the time the in-page factory is consulted — which is what makes a **navigation**
   * resolvable at all, since before the navigation there is by definition no window on the URL.
   * Without a context the answer is the URL match, which is right for the extension-shaped
   * call where the URL is the only thing the port carries.
   */
  function contextPage(actionId: string): FreyaBrowserPage | null {
    const context = contexts.get(actionId)
    if (context === undefined) return null
    return pages.get(context.sessionId) ?? null
  }

  return {
    async openSession(sessionId, partition) {
      if (pages.has(sessionId)) return
      if (pages.size >= poolSize) {
        throw new Error(`The Freya Browser holds at most ${String(poolSize)} session(s) at once.`)
      }
      const checked = assertNonPersistentPartition(partition)
      if (!checked.ok) throw new Error(checked.reason)
      pages.set(sessionId, await options.factory.create(sessionId, partition))
    },

    async closeSession(sessionId) {
      const page = pages.get(sessionId)
      pages.delete(sessionId)
      if (page === undefined) return
      try {
        await page.close()
      } catch {
        // A window that cannot be closed still leaves the session gone: the partition is
        // cleared by the window's own teardown and the next session gets a fresh one.
      }
    },

    publicAvailable() {
      return options.publicAvailable()
    },

    openSessions() {
      return [...pages.keys()].sort()
    },

    begin(_sessionId, actionId, context) {
      contexts.set(actionId, context)
    },

    abandon(actionId) {
      contexts.delete(actionId)
    },

    takeObserved(actionId) {
      const entry = observed.get(actionId)
      observed.delete(actionId)
      if (entry === undefined) return null
      if (entry.expiresAt < now()) return null
      return entry.value
    },


    /**
     * The one place a Device Hands browser request becomes a page operation.
     *
     * Two callers reach it, and both are downstream of the same ten gates:
     *
     *   - the **Phase 51 runtime** calls `begin` first, so the command is known exactly and the
     *     session is known exactly;
     *   - the **Phase 35 runtime**, through `inPage.openInPage`, calls it with a bare
     *     `BrowserPortRequest` and no context — because that runtime *is* the authority and has
     *     already decided what the action is.
     *
     * With no context the command is read off the request itself, which is unambiguous
     * because the Phase 35 vocabulary has only four browser actions: a selector with text is
     * a keystroke, a selector alone is a click, and neither is "go there and read". Nothing is
     * inferred about *permission* — only about which of four already-authorised actions to run.
     */
    async performBrowser(request: BrowserPortRequest): Promise<BrowserPortOutcome> {
      const context = contexts.get(request.actionId) ?? null
      const command: BrowserCommand | null =
        context?.command ??
        (request.selector === null ? null : request.text === null ? 'page.click' : 'page.type')
      if (context !== null && command === null) {
        return failure('command-unsupported')
      }
      const page = context === null ? pageOnUrl(request.url) : pages.get(context.sessionId) ?? null
      if (page === null) {
        // No context means this did not come through a routed command, so there is nothing to
        // know which locator or which session. Refused, not guessed at.
        return failure(context === null ? 'no-page-for-url' : 'session-closed')
      }
      return await drivePage(page, command, request, stash)
    },

    /**
     * The Phase 35 browser factory, pointed at a live Freya Browser page.
     *
     * `open()` is the read-only managed target and this factory does not have one: it is
     * never asked for a read that no window is serving, because the caller falls back to the
     * Phase 5 target in that case. Returning null there is what keeps the Phase 35 behaviour
     * — including `browser-action-unsupported` for a click against a document — completely
     * unchanged for every caller that has no Freya Browser switched on.
     */
    inPage: {
      async open(): Promise<DeviceBrowserSession> {
        throw new Error('The Freya Browser has no read-only target; the Phase 5 managed browser is that target.')
      },
async openInPage(request: BrowserPortRequest): Promise<DeviceBrowserSession | null> {
        const page = contextPage(request.actionId) ?? pageOnUrl(request.url)
        if (page === null) return null
        const context = contexts.get(request.actionId) ?? null
        const command: BrowserCommand | null =
          context?.command ??
          (request.selector === null ? 'page.read' : request.text === null ? 'page.click' : 'page.type')
return {
          async navigate(url: string): Promise<{ ok: boolean; finalUrl: string | null; code: string }> {
            // A live page that is already on the authorised URL is *there*. Navigating it again
            // would reload the page behind the owner's back and lose the state they can see, so
            // "already there" is the honest answer and no work is done.
            if (page.currentUrl() === url) return { ok: true, finalUrl: url, code: 'already-there' }
            const result = await drivePage(page, 'page.navigate', { ...request, url }, stash)
            return { ok: result.holds, finalUrl: result.finalUrl, code: result.code }
          },
          async readText(): Promise<{ ok: boolean; textBytes: number; code: string }> {
            // One read produces the prose **and** the element list, so `page.read` and
            // `page.describe` are one `browser.read-text` action seen two ways rather than two
            // actions — which is what keeps them the same Device Hands key.
            const result = await drivePage(page, command ?? 'page.describe', request, stash)
            return { ok: result.holds, textBytes: result.textBytes, code: result.code }
          },
          async act(action: BrowserPortRequest): Promise<BrowserPortOutcome> {
            const key = action.selector !== null && action.text !== null ? 'page.type' : 'page.click'
            return await drivePage(page, key, action, stash)
          },
          async close(): Promise<void> {
            // Deliberately a no-op: this is the owner's window, not a throwaway target. The
            // session lifecycle owns closing it, and a read must never close a page.
          },
        }
      },
    },
  }
}

/**
 * Run one already-authorised action against one page.
 *
 * Every refusal here is a *fact about the page*, and each one is checked before the effect
 * rather than after: a protected field is refused by name before a click is dispatched, and a
 * click nobody observed is reported as not done rather than as a success.
 */
async function drivePage(
  page: FreyaBrowserPage,
  command: BrowserCommand | null,
  request: BrowserPortRequest,
  stash: (actionId: string, value: BrowserObservation) => void,
): Promise<BrowserPortOutcome> {
  const notHeld = (code: string, textBytes = 0): BrowserPortOutcome => ({ holds: false, evidence: 'observed', code, finalUrl: null, textBytes })

  /** Whether a field is one this browser will never touch. Shared with the extension. */
  const protectedKind = async (selector: string): Promise<boolean> => {
    const inspected = await page.inspect(selector)
    return inspected.ok && inspected.field !== null && classifyProtectedField(inspected.field) !== null
  }

  switch (command) {
    case 'page.navigate': {
      const result = await page.navigate(request.url)
      if (!result.ok || result.finalUrl === null) return notHeld(result.code)
      stash(request.actionId, {
        revision: page.currentRevision(),
        url: result.finalUrl,
        ...(page.currentTitle() === null ? {} : { title: page.currentTitle() as string }),
      })
      return { holds: true, evidence: 'observed', code: 'navigated', finalUrl: result.finalUrl, textBytes: 0 }
    }

    case 'page.read': {
      // The page must still be the page the authority checked, or this is a different page.
      if (page.currentUrl() !== request.url) return notHeld('page-moved')
      const result = await page.read()
      if (!result.ok) return notHeld(result.code)
      stash(request.actionId, {
        revision: page.currentRevision(),
        url: page.currentUrl(),
        text: result.text,
        ...(page.currentTitle() === null ? {} : { title: page.currentTitle() as string }),
      })
      return { holds: true, evidence: 'observed', code: 'read', finalUrl: page.currentUrl(), textBytes: result.bytes }
    }

case 'page.describe': {
      if (page.currentUrl() !== request.url) return notHeld('page-moved')
      const result = await page.describe()
      if (!result.ok) return notHeld(result.code)
      // The prose comes from the same read. Two calls, one action: the element list without the
      // text would describe a page a caller cannot read, and the text without the list would be
      // a read a caller cannot act on.
      const read = await page.read()
      stash(request.actionId, {
        revision: page.currentRevision(),
        url: page.currentUrl(),
        elements: result.payload,
        ...(read.ok ? { text: read.text } : {}),
        ...(page.currentTitle() === null ? {} : { title: page.currentTitle() as string }),
      })
      return {
        holds: true,
        evidence: 'observed',
        code: 'described',
        finalUrl: page.currentUrl(),
        textBytes: read.ok ? read.bytes : 0,
      }
    }

    case 'page.click': {
      if (request.selector === null) return notHeld('request-malformed')
      if (page.currentUrl() !== request.url) return notHeld('page-moved')
      if (await protectedKind(request.selector)) return notHeld('protected-field')
      const result = await page.click(request.selector)
      if (result.protectedKind !== null) return notHeld('protected-field')
      if (!result.ok) return notHeld(result.code)
      // The observation gate. A click the page did not react to is reported as not done,
      // because "the element was clicked" is a claim about the element and the useful claim is
      // about what the page then did.
      if (!result.changed) return notHeld('click-unobserved')
      stash(request.actionId, { revision: page.currentRevision(), url: page.currentUrl(), changed: true })
      return { holds: true, evidence: 'observed', code: 'clicked', finalUrl: page.currentUrl(), textBytes: 0 }
    }

    case 'page.type': {
      if (request.selector === null || request.text === null) return notHeld('request-malformed')
      if (page.currentUrl() !== request.url) return notHeld('page-moved')
      if (await protectedKind(request.selector)) return notHeld('protected-field')
      const result = await page.type(request.selector, request.text)
      if (result.protectedKind !== null) return notHeld('protected-field')
      if (!result.ok) return notHeld(result.code)
      if (result.readBack !== request.text) return notHeld('type-unobserved')
      if (!result.changed) return notHeld('click-unobserved')
      stash(request.actionId, {
        revision: page.currentRevision(),
        url: page.currentUrl(),
        changed: true,
        fieldValue: result.readBack,
      })
      return { holds: true, evidence: 'observed', code: 'typed', finalUrl: page.currentUrl(), textBytes: utf8Bytes(request.text) }
    }

    default:
      return notHeld('command-unsupported')
  }
}
