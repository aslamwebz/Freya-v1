import { BrowserWindow, session as electronSession, type Session, type WebContents } from 'electron'
import { PUBLIC_BROWSER_DENIED_PERMISSIONS, assertNonPersistentPartition, assertPublicBrowserUrl } from '../../core/browser'
import { isPrivateOrLocalHost, utf8Bytes } from '../../core/browserext'
import type { FieldDescriptor, FreyaBrowserPage, FreyaBrowserPageFactory } from './publicAdapter'

/**
 * The embedded Freya Browser: a window Freya owns, in a session partition that holds
 * nothing.
 *
 * ## The isolation argument, stated once
 *
 * This window is allowed to be a real browser. It runs the page's own JavaScript, because
 * a client-rendered page that yields nothing is not a browser and Phase 5 was honest that
 * its managed target is a *reader*, not an agent (`docs/BROWSER-ROADMAP.md`).
 *
 * What it is not allowed to be is a browser that knows anything about the person using it.
 * That is four rules, each of which is enforced here rather than promised:
 *
 *   1. **A non-persistent partition.** `freya-public-<id>`, never `persist:`-prefixed, so
 *      nothing is written to `userData` and nothing survives the process. Cleared on
 *      acquire and again on release.
 *   2. **Every permission denied.** Camera, microphone, geolocation, notifications, MIDI,
 *      pointer lock, clipboard reads, display capture, window management — all of them, with
 *      no exception table. A permission is authority, and this browser holds none.
 *   3. **No local or private address.** `webRequest.onBeforeRequest` cancels any request
 *      that is not a public `http`/`https` URL, so a page cannot use DNS rebinding, a
 *      `<img>` or a `fetch` to reach `192.168.0.1`, `localhost` or a metadata endpoint. This
 *      is the same posture the Phase 5 research transport takes, for the same reason.
 *   4. **No downloads.** `will-download` is cancelled and only *described* — the URL, the
 *      file name, the media type, the declared size. Moving the bytes is a separate,
 *      already-gated `transfer.download`.
 *
 * ## What is deliberately not reused
 *
 * `EXTRACTION_SCRIPT` from `electron/research/extract.ts` is **not** used here, and the
 * reason is worth stating because "reuse everything" is usually the wrong instruction
 * anyway. That script is correct for its own window: it *mutates* the live DOM, removing
 * hidden nodes, scripts and navigation so that what Freya extracts is what a reader would
 * see. In a throwaway window rendered from a CSP'd internal URL, that is exactly right.
 *
 * In a window the owner may be looking at, it would be vandalism. So this file carries its
 * own read-only extraction script that computes the same thing **without touching the
 * page**, and the difference is the point: a page the person is reading must be left as
 * they left it.
 */

/* ------------------------------------------------------------------- scripts */

/** The isolated world id. Distinct from the research window's, so the two cannot collide. */
const WORLD_ID = 1002

/**
 * Read the page. Constant trusted source: no page value is interpolated into it.
 *
 * Non-mutating by construction. Visibility is *decided* per subtree rather than enforced
 * by removing nodes, so a hidden comment, a cookie banner and an `<script>` body are all
 * skipped while the document itself is untouched.
 */
const READ_SCRIPT = String.raw`( () => {
  const clean = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','NAV','HEADER','FOOTER','ASIDE','FORM','IFRAME','OBJECT','EMBED','SVG','CANVAS','SELECT']);
  const skipish = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (SKIP.has(tag)) return true;
    const id = (node.id || '').toLowerCase();
    const cls = String(node.className || '').toLowerCase();
    if (id.indexOf('cookie') !== -1 || id.indexOf('consent') !== -1) return true;
    if (cls.indexOf('cookie') !== -1 || cls.indexOf('consent') !== -1) return true;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true;
    if (node.hidden) return true;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    return false;
  };
  const lines = [];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      return;
    }
    if (node.nodeType !== 1 || skipish(node)) return;
    const block = node.nodeType === 1 && /^(P|DIV|SECTION|ARTICLE|MAIN|H1|H2|H3|H4|H5|H6|LI|UL|OL|BLOCKQUOTE|PRE|TR|BR|DT|DD)$/.test(node.tagName);
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) lines.push('');
  };
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  if (root) walk(root);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: clean(document.title, 512), url: location.href, text: text.slice(0, 24000), bytes: text.length };
})`

/**
 * Describe the actionable surface: at most 120 elements, each with a locator.
 *
 * A locator is built from the id, then a name, then classes, and is emitted at most once —
 * a duplicate locator would make two references point at one element and quietly turn a
 * description into a lie. Every part is restricted to the character class
 * `core/devicehands` accepts for a selector, so nothing is described here that the gate
 * would later refuse.
 */
const DESCRIBE_SCRIPT = String.raw`(() => {
  const clean = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
  const QUOTED = /^[A-Za-z0-9 _.:-]{1,64}$/;
  const locatorFor = (node) => {
    const tag = node.tagName.toLowerCase();
    const id = node.id || '';
    if (SAFE.test(id)) return '#' + id;
    const name = node.getAttribute && node.getAttribute('name');
    if (name && QUOTED.test(name)) return tag + '[name="' + name + '"]';
    const classes = String((node.className || '')).split(/\s+/).filter(c => SAFE.test(c)).slice(0, 2);
    if (classes.length > 0) return tag + '.' + classes.join('.');
    return tag;
  };
  const PROTECTED_HINT = /pass(word|wd|phrase)?|\bpwd\b|credit.?card|card.?(number|num|no)\b|\bcc.?(num|number|no)\b|\bcvc\b|\bcvv\b|\bcsc\b|security.?code|social.?security|\bssn\b|\botp\b|one.?time|\b2fa\b|\bmfa\b|auth.?token|access.?token|api.?key|secret|passphrase/i;
  const hidden = (node) => {
    if (!node || node.nodeType !== 1) return true;
    const style = getComputedStyle(node);
    return node.hidden === true || style.display === 'none' || style.visibility === 'hidden' || node.getAttribute('aria-hidden') === 'true';
  };
  const labelFor = (node) => {
    const aria = node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'));
    if (aria) return clean(aria, 120);
    const text = clean(node.innerText || node.textContent || '', 120);
    if (text) return text;
    const placeholder = node.getAttribute && node.getAttribute('placeholder');
    return placeholder ? clean(placeholder, 120) : '';
  };
  const kinds = [['A', 'link'], ['BUTTON', 'button'], ['INPUT', 'field'], ['TEXTAREA', 'field'], ['SELECT', 'field'], ['H1', 'heading'], ['H2', 'heading'], ['H3', 'heading'], ['SUMMARY', 'button']];
  const found = [];
  const seen = new Set();
  for (const [tag, kind] of kinds) {
    for (const node of Array.from(document.querySelectorAll(tag))) {
      if (found.length >= 120) break;
      if (hidden(node)) continue;
      const selector = locatorFor(node);
      if (selector.length > 256 || seen.has(selector)) continue;
      const input = node;
      const type = (input.type || '').toLowerCase();
      const name = (input.name || '') + ' ' + (input.id || '') + ' ' + (input.placeholder || '') + ' ' + ((node.getAttribute && node.getAttribute('aria-label')) || '');
      const autocomplete = (input.getAttribute && input.getAttribute('autocomplete')) || '';
      const protectedField = type === 'password' || type === 'hidden' || autocomplete.toLowerCase().indexOf('one-time-code') !== -1 || autocomplete.toLowerCase().indexOf('current-password') !== -1 || autocomplete.toLowerCase().indexOf('cc-') === 0 || PROTECTED_HINT.test(name.toLowerCase());
      seen.add(selector);
      found.push({
        kind,
        label: labelFor(node),
        selector,
        protected: protectedField === true,
        disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true'
      });
    }
  }
  return { elements: found, title: clean(document.title, 512), url: location.href };
})`

/** The descriptor of one element, for the host-side protected-field classification. */
const INSPECT_SCRIPT = String.raw`((selector) => {
  const node = document.querySelector(selector);
  if (!node) return null;
  return {
    tagName: node.tagName.toLowerCase(),
    type: (node.type || null),
    name: node.getAttribute('name'),
    id: node.id || null,
    autocomplete: node.getAttribute('autocomplete'),
    placeholder: node.getAttribute('placeholder'),
    ariaLabel: node.getAttribute('aria-label')
  };
})`

/** Click one element and report whether the page reacted. */
const CLICK_SCRIPT = String.raw`((selector) => {
  const node = document.querySelector(selector);
  if (!node) return { ok: false, changed: false, protectedKind: null, reason: 'not-found' };
  if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') return { ok: false, changed: false, protectedKind: null, reason: 'disabled' };
  const before = document.querySelectorAll('*').length + '|' + (document.title || '') + '|' + location.href;
  node.scrollIntoView({ block: 'center' });
  node.click();
  return { ok: true, changed: document.querySelectorAll('*').length + '|' + (document.title || '') + '|' + location.href !== before, protectedKind: null };
})`

/**
 * Type into one element and read the value straight back out.
 *
 * The prototype setter is used rather than `element.value = text` because a framework that
 * tracks its own value will not see a plain assignment — which is exactly the case where
 * reporting a successful keystroke would be a lie.
 */
const TYPE_SCRIPT = String.raw`((selector, text) => {
  const node = document.querySelector(selector);
  if (!node) return { ok: false, changed: false, readBack: null, protectedKind: null, reason: 'not-found' };
  if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') return { ok: false, changed: false, readBack: null, protectedKind: null, reason: 'disabled' };
  const PROTECTED_HINT = /pass(word|wd|phrase)?|\bpwd\b|credit.?card|\bcc.?num|\bcvc\b|\bcvv\b|\bcsc\b|security.?code|social.?security|\bssn\b|\botp\b|one.?time|\b2fa\b|\bmfa\b|auth.?token|access.?token|api.?key|secret|passphrase/i;
  const type = (node.type || '').toLowerCase();
  const haystack = ((node.name || '') + ' ' + (node.id || '') + ' ' + (node.placeholder || '') + ' ' + (node.getAttribute('aria-label') || '')).toLowerCase();
  if (type === 'password' || type === 'hidden' || PROTECTED_HINT.test(haystack)) {
    return { ok: false, changed: false, readBack: null, protectedKind: type === 'password' ? 'password' : 'authentication' };
  }
  if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
    const proto = Object.getPrototypeOf(node);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(node, text);
    else node.value = text;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, changed: node.value !== '', readBack: node.value, protectedKind: null };
  }
  if (node.isContentEditable) {
    node.textContent = text;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, changed: true, readBack: node.textContent, protectedKind: null };
  }
  return { ok: false, changed: false, readBack: null, protectedKind: null, reason: 'not-editable' };
})`

/** A cheap signature of the page, used only to notice that something changed. */
const SIGNATURE_SCRIPT = String.raw`(() => {
  const input = document.querySelector('input, textarea');
  return [location.href, document.title, document.querySelectorAll('*').length, input ? String(input.value || '').length : '0', document.activeElement ? document.activeElement.tagName : ''].join('|');
})`

/* ------------------------------------------------------------------ the page */

export interface FreyaWindowOptions {
  /** The owner's host allowlist. Empty means no host is allowlisted. */
  readonly allowedHosts?: readonly string[]
  /** Called for every download the page starts. The window has already cancelled it. */
  readonly onMedia?: (observation: {
    readonly sessionId: string
    readonly mediaId: string
    readonly url: string
    readonly fileName: string
    readonly mediaType: string | null
    readonly bytes: number | null
    readonly observedAt: string
  }) => void
  readonly now?: () => Date
  /** How long to wait for a page to react after a click. Bounded, and never a hang. */
  readonly settleMs?: number
}

const DEFAULT_SETTLE_MS = 1_500

function toFieldDescriptor(value: unknown): FieldDescriptor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return {
    tagName: typeof row.tagName === 'string' ? row.tagName : 'unknown',
    type: typeof row.type === 'string' ? row.type : null,
    name: typeof row.name === 'string' ? row.name : null,
    id: typeof row.id === 'string' ? row.id : null,
    autocomplete: typeof row.autocomplete === 'string' ? row.autocomplete : null,
    placeholder: typeof row.placeholder === 'string' ? row.placeholder : null,
    ariaLabel: typeof row.ariaLabel === 'string' ? row.ariaLabel : null,
  }
}

class ElectronFreyaBrowserPage implements FreyaBrowserPage {
  private window?: BrowserWindow
  private contents?: WebContents
  private ses?: Session
  private closed = false
  private revision = 0
  private url: string | null = null
  private title: string | null = null
  private mediaSequence = 0
  private cleanup?: Promise<void>

  private readonly onDidNavigate = (_event: unknown, url: string): void => {
    // Every navigation a page can perform — its own, a redirect's, a link's — retires the
    // references minted for the previous one. This is the single place the counter moves,
    // which is why it cannot be moved backwards by a path that forgot to check.
    this.revision += 1
    this.url = url
    this.title = null
  }

  private readonly onNavigateInPage = (event: unknown, url: string, isMainFrame: boolean): void => {
    if (!isMainFrame) return
    void event
    this.revision += 1
    this.url = url
    this.title = null
  }

  private readonly onFailedLoad = (_event: unknown, errorCode: number): void => {
    this.revision += 1
    this.title = null
    this.url = null
    void errorCode
  }

  private readonly onRenderGone = (): void => {
    this.revision += 1
    void this.close()
  }

  private readonly onDownload = (event: { preventDefault(): void }, item: Electron.DownloadItem): void => {
    event.preventDefault()
    this.mediaSequence += 1
    const mediaId = `${this.sessionId}-download-${String(this.mediaSequence)}`
    const url = item.getURL()
    const address = assertPublicBrowserUrl(url, { allowedHosts: this.allowedHosts })
    const at = this.currentTime()
    this.options.onMedia?.({
      sessionId: this.sessionId,
      mediaId,
      // A download from an address the URL policy refuses is described with an empty URL
      // rather than normalised into a plausible one: the page asked for something Freya
      // will not name as though it were fine.
      url: address.ok ? address.url : '',
      fileName: item.getFilename().slice(0, 128),
      mediaType: item.getMimeType().split(';')[0]?.trim().toLowerCase() ?? null,
      bytes: item.getTotalBytes() > 0 ? Math.floor(item.getTotalBytes()) : null,
      observedAt: at,
    })
  }

  private readonly prevent = (event: { preventDefault(): void }): void => event.preventDefault()

  private readonly onWindowClosed = (): void => {
    if (!this.closed) void this.close()
  }

  private readonly allowedHosts: readonly string[]
  private readonly settleMs: number

  constructor(
    readonly sessionId: string,
    partition: string,
    private readonly options: FreyaWindowOptions,
  ) {
    this.allowedHosts = options.allowedHosts ?? []
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    // Held, and asserted rather than trusted: a partition name that would be persistent is
    // refused here, at the point a window would be created, rather than further down.
    const checked = assertNonPersistentPartition(partition)
    if (!checked.ok) throw new Error(checked.reason)
    this.partition = partition
  }

  private readonly partition: string

  /** The partition this window lives in. For the host's own diagnostics. */
  partitionName(): string {
    return this.partition
  }

  private currentTime(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  private allowedUrl(candidate: string): boolean {
    return assertPublicBrowserUrl(candidate, { allowedHosts: this.allowedHosts }).ok
  }

  initialize(ses: Session): void {
    this.ses = ses
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.on('will-download', this.onDownload)
    // Nothing on this partition may reach a private or local address, from any origin, for
    // any resource type. This is the reason the Freya Browser is not a doorway to the
    // owner's network.
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !this.requestAllowed(details.url, details.resourceType) })
    })

    this.window = new BrowserWindow({
      show: true,
      width: 1100,
      height: 800,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: false,
      },
    })
    const contents = (this.contents = this.window.webContents)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!this.allowedUrl(url)) {
        event.preventDefault()
        return
      }
      this.revision += 1
    })
    contents.on('will-frame-navigate', this.prevent)
    contents.on('will-attach-webview', this.prevent)
    contents.on('did-navigate', this.onDidNavigate)
    contents.on('did-navigate-in-page', this.onNavigateInPage)
    contents.on('did-fail-load', this.onFailedLoad)
    contents.on('did-fail-provisional-load', this.onFailedLoad)
    contents.on('render-process-gone', this.onRenderGone)
    this.window.on('closed', this.onWindowClosed)
  }

  /**
   * Whether one network request may proceed.
   *
   * The main frame is checked against the same URL policy as everything else, and a
   * subresource needs only a public `http`/`https` URL — the host allowlist is the
   * *owner's* rule about where Freya goes, and applying it to a page's own image requests
   * would break ordinary pages without making anything safer.
   */
  private requestAllowed(candidate: string, resourceType: string): boolean {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
    if (isPrivateOrLocalHost(host)) return false
    return resourceType !== 'mainFrame' || this.allowedUrl(candidate)
  }

  currentUrl(): string | null {
    return this.url
  }

  currentRevision(): number {
    return this.revision
  }

  currentTitle(): string | null {
    return this.title
  }

  private async run<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.closed || this.contents === undefined) return null
    try {
      return await operation()
    } catch {
      return null
    }
  }

  /**
   * Run one constant script in the isolated world, with bounded arguments.
   *
   * Electron's `executeJavaScriptInIsolatedWorld` takes a *source string* and no argument
   * list, so an argument has to reach the script somehow. It arrives as a `JSON.stringify`d
   * array that the wrapper applies to the function, and that is the one place in this file
   * where a value is placed into source text — so the guard is here, and it is not
   * optional:
   *
   *   - every argument must be a **string** of at most 4096 UTF-8 bytes;
   *   - every argument must contain **no control character**, which is already refused
   *     upstream by the Device Hands typed-text gate and is refused again here;
   *   - `JSON.stringify` escapes quotes, backslashes and newlines, so a value cannot close
   *     the literal and become code.
   *
   * The scripts themselves are constant trusted source and contain no page value at all:
   * everything they learn about the page comes out through their return value.
   */
  private async eval<T>(code: string, args: readonly string[] = []): Promise<T | null> {
    for (const value of args) {
      if (typeof value !== 'string' || utf8Bytes(value) > 4096) return null
      for (let index = 0; index < value.length; index += 1) {
        const point = value.charCodeAt(index)
        if (point < 32 || point === 127) return null
      }
    }
    const source =
      args.length === 0
        ? `(${code})()`
        : `(() => { const __freyaArgs = ${JSON.stringify(args)}; return (${code}).apply(null, __freyaArgs); })()`
    return await this.run(async () => {
      const contents = this.contents
      if (contents === undefined || contents.isDestroyed()) return null
      const result: unknown = await contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: source }], false)
      return result as T
    })
  }

  async navigate(url: string): Promise<{ ok: boolean; finalUrl: string | null; code: string }> {
    if (this.closed || this.window === undefined) return { ok: false, finalUrl: null, code: 'session-closed' }
    if (!this.allowedUrl(url)) return { ok: false, finalUrl: null, code: 'url-refused' }
    const startRevision = this.revision
    try {
      await this.window.loadURL(url)
    } catch {
      return { ok: false, finalUrl: null, code: 'navigate-failed' }
    }
    const landed = this.url
    if (this.closed || landed === null) return { ok: false, finalUrl: null, code: 'navigate-failed' }
    if (this.revision === startRevision) {
      // Electron reported a load and the counter did not move, which means nothing about
      // the page was actually replaced. The revision is the honest witness.
      this.revision += 1
    }
    const read = await this.eval<{ title?: string }>(READ_SCRIPT)
    if (read !== null && typeof read.title === 'string') this.title = read.title.slice(0, 200)
    return { ok: true, finalUrl: landed, code: 'navigated' }
  }

  async read(): Promise<{ ok: boolean; text: string; bytes: number; code: string }> {
    const result = await this.eval<{ title?: string; text?: string }>(READ_SCRIPT)
    if (result === null) return { ok: false, text: '', bytes: 0, code: 'read-failed' }
    if (typeof result.title === 'string') this.title = result.title.slice(0, 200)
    const text = typeof result.text === 'string' ? result.text : ''
    return { ok: true, text, bytes: utf8Bytes(text), code: 'read' }
  }

  /**
   * The element list, and only the element list.
   *
   * The description's *text* comes from {@link read}, not from here: a description exists to
   * hand out references, and a caller that wanted the prose asks for it. Keeping the two apart
   * means describePage normalises one shape instead of two.
   */
  async describe(): Promise<{ ok: boolean; payload: unknown; code: string }> {
    const result = await this.eval<{ elements?: unknown; title?: string }>(DESCRIBE_SCRIPT)
    if (result === null) return { ok: false, payload: null, code: 'describe-failed' }
    if (typeof result.title === 'string') this.title = result.title.slice(0, 200)
    return { ok: true, payload: result.elements, code: 'described' }
  }

  async inspect(selector: string): Promise<{ ok: boolean; field: FieldDescriptor | null; code: string }> {
    const result = await this.eval<unknown>(INSPECT_SCRIPT, [selector])
    const field = toFieldDescriptor(result)
    if (field === null) return { ok: false, field: null, code: 'element-not-found' }
    return { ok: true, field, code: 'inspected' }
  }

  async click(selector: string): Promise<{ ok: boolean; changed: boolean; protectedKind: string | null; code: string }> {
    const before = await this.eval<string>(SIGNATURE_SCRIPT)
    const result = await this.eval<{ ok?: boolean; changed?: boolean; protectedKind?: string | null; reason?: string }>(CLICK_SCRIPT, [selector])
    if (result === null || result.ok !== true) {
      return { ok: false, changed: false, protectedKind: null, code: result?.reason === 'disabled' ? 'element-disabled' : 'click-failed' }
    }
    if (result.changed === true) return { ok: true, changed: true, protectedKind: null, code: 'clicked' }
    // Nothing changed synchronously. Pages that navigate or re-render take a moment, so the
    // change is looked for once more inside a hard bound. Nothing here can hang: two
    // attempts and a fixed ceiling.
    const settled = await this.settle(before)
    return { ok: true, changed: settled, protectedKind: null, code: settled ? 'clicked' : 'click-unobserved' }
  }

  private async settle(before: string | null): Promise<boolean> {
    if (before === null) return false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(1, Math.floor(this.settleMs / 2)))
      })
      const after = await this.eval<string>(SIGNATURE_SCRIPT)
      if (after === null) return false
      if (after !== before) return true
      if (this.revision !== 0 && this.url !== null) {
        // A navigation bumps the revision; if it moved at all the page was replaced.
        return this.revision > 0 && after !== before
      }
    }
    return false
  }

  async type(selector: string, text: string): Promise<{ ok: boolean; changed: boolean; readBack: string | null; protectedKind: string | null; code: string }> {
    const result = await this.eval<{ ok?: boolean; changed?: boolean; readBack?: string | null; protectedKind?: string | null; reason?: string }>(TYPE_SCRIPT, [selector, text])
    if (result === null || result.ok !== true) {
      return { ok: false, changed: false, readBack: null, protectedKind: null, code: result?.reason ?? 'type-failed' }
    }
    const readBack = typeof result.readBack === 'string' ? result.readBack : null
    return {
      ok: true,
      changed: result.changed === true,
      readBack,
      protectedKind: typeof result.protectedKind === 'string' ? result.protectedKind : null,
      code: 'typed',
    }
  }

  close(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.closed = true
    // Retiring the revision here is what makes a closed window's references unusable rather
    // than merely unreachable: a caller holding one is refused `page-stale` instead of
    // being handed a page that no longer exists.
    this.revision += 1
    this.url = null
    this.title = null
    if (this.window !== undefined && !this.window.isDestroyed()) this.window.destroy()
    if (this.contents !== undefined) {
      const contents = this.contents
      contents.removeAllListeners('will-navigate')
      contents.removeAllListeners('will-frame-navigate')
      contents.removeAllListeners('will-attach-webview')
      contents.removeAllListeners('did-navigate')
      contents.removeAllListeners('did-navigate-in-page')
      contents.removeAllListeners('did-fail-load')
      contents.removeAllListeners('did-fail-provisional-load')
      contents.removeAllListeners('render-process-gone')
      this.window?.removeListener('closed', this.onWindowClosed)
    }
    const ses = this.ses
    // Independent teardown steps: one failed Electron call must not skip the rest, and in
    // particular must not skip the storage clear.
    for (const dispose of [
      (): void => {
        ses?.removeListener('will-download', this.onDownload)
      },
      (): void => {
        ses?.webRequest.onBeforeRequest(null)
      },
      (): void => {
        ses?.setPermissionCheckHandler(null)
      },
      (): void => {
        ses?.setPermissionRequestHandler(null)
      },
    ]) {
      try {
        dispose()
      } catch {
        try {
          dispose()
        } catch {
          // The window is already destroyed and inaccessible; nothing below depends on it.
        }
      }
    }
    this.cleanup = (ses === undefined
      ? Promise.resolve()
      : Promise.allSettled([ses.clearStorageData(), ses.clearCache()])
    )
      .then(() => undefined)
      .catch(() => undefined)
    return this.cleanup
  }
}

/* ------------------------------------------------------------------ the factory */

export interface FreyaWindowFactoryOptions extends FreyaWindowOptions {
  /** Overrides the session lookup. For tests that assert the partition rules. */
  readonly sessionFor?: (partition: string) => Session
}

/**
 * Main process only. Requires Electron app readiness.
 *
 * The partition is asked for by name and then **cleared**, on acquire and again on
 * release. Clearing on acquire as well as on release is what stops a partition whose
 * previous close was interrupted from handing its cookies to the next session — a leak
 * that would otherwise be invisible, because the partition name is deterministic.
 */
export class ElectronFreyaWindowFactory implements FreyaBrowserPageFactory {
  constructor(private readonly options: FreyaWindowFactoryOptions = {}) {}

  async create(sessionId: string, partition: string): Promise<FreyaBrowserPage> {
    const ses = this.options.sessionFor
      ? this.options.sessionFor(partition)
      : electronSession.fromPartition(partition, { cache: true })
    await ses.clearStorageData().catch(() => undefined)
    await ses.clearCache().catch(() => undefined)
    const page = new ElectronFreyaBrowserPage(sessionId, partition, this.options)
    page.initialize(ses)
    return page
  }
}

/** The permissions this build denies, re-exported so the window and its test agree. */
export const FREYA_BROWSER_DENIED_PERMISSIONS = PUBLIC_BROWSER_DENIED_PERMISSIONS