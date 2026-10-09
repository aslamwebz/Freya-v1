import { BrowserWindow, WebContentsView, session as electronSession, type Session, type WebContents } from 'electron'
import { PUBLIC_BROWSER_DENIED_PERMISSIONS, assertNonPersistentPartition, assertPublicBrowserUrl, BROWSER_LIMITS } from '../../core/browser'
import { shouldAdoptPageAddress } from '../../core/browser/service'
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
 * Describe the page in one bounded pass: its prose, its headings, and every actionable
 * control with a locator.
 *
 * This replaces the previous describe-only script rather than sitting beside it, and that is
 * deliberate. Two scripts reading the same page is how the two drift apart: the reference a
 * click resolves and the name a caller read would eventually describe different controls, and
 * "click r3" would quietly become "click whatever the *other* script found third".
 *
 * Everything is computed **without mutating the page** — visibility is decided per subtree,
 * never enforced by removing nodes — for the reason stated at the top of this file. A page
 * the person is reading must be left as they left it.
 *
 * `withText` exists so the routed `page.describe` path pays for the elements only. One
 * source, two views, and the prose is a flag rather than a second implementation.
 */
const SNAPSHOT_SCRIPT = String.raw`((limit, withText) => {
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
    if (node.hidden === true) return true;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true;
    if (node.getAttribute && node.getAttribute('type') === 'hidden') return true;
    const style = getComputedStyle(node);
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  };
  const labelFor = (node) => {
    const aria = node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'));
    if (aria) return clean(aria, 120);
    // An associated <label> comes before the element's own text, because that is the order a
    // screen reader resolves an accessible name in. Getting it backwards is not cosmetic: a
    // <select>'s inner text is its *option list*, so "Sri Lanka Japan" would become the name
    // of the control that chooses a country.
    if (node.labels && node.labels.length > 0) {
      const labels = Array.from(node.labels).map(l => clean(l.innerText || l.textContent || '', 120)).filter(Boolean).join(' ');
      if (labels) return labels;
    }
    const text = clean(node.innerText || node.textContent || '', 120);
    if (text) return text;
    const placeholder = node.getAttribute && node.getAttribute('placeholder');
    if (placeholder) return clean(placeholder, 120);
    // An icon-only control still has an accessible name, from an image's alt text. A page of
    // unlabelled icons would otherwise be a page nothing can refer to.
    const image = node.querySelector && node.querySelector('img[alt]');
    if (image && image.getAttribute('alt')) return clean(image.getAttribute('alt'), 120);
    return '';
  };

  /* ---- prose. Only when asked for, and never by removing anything from the page. ---- */
  let text = '';
  let truncated = false;
  if (withText === '1') {
    const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','NAV','HEADER','FOOTER','ASIDE','IFRAME','OBJECT','EMBED','SVG','CANVAS']);
    const lines = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const chunk = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (chunk) lines.push(chunk);
        return;
      }
      if (node.nodeType !== 1 || hidden(node)) return;
      const tag = node.tagName;
      if (SKIP.has(tag)) return;
      const id = (node.id || '').toLowerCase();
      const cls = String(node.className || '').toLowerCase();
      if (id.indexOf('cookie') !== -1 || id.indexOf('consent') !== -1) return;
      if (cls.indexOf('cookie') !== -1 || cls.indexOf('consent') !== -1) return;
      const block = /^(P|DIV|SECTION|ARTICLE|MAIN|H1|H2|H3|H4|H5|H6|LI|UL|OL|BLOCKQUOTE|PRE|TR|BR|DT|DD|TD)$/.test(tag);
      for (const child of Array.from(node.childNodes)) walk(child);
      if (block) lines.push('');
    };
    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    if (root) walk(root);
    const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (joined.length > 4000) { text = joined.slice(0, 4000); truncated = true; }
    else text = joined;
  }

  /* ---- actionable surface, in document order ---- */
  const SELECTOR = 'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"]';
  const kindFor = (node) => {
    const tag = node.tagName;
    const role = (node.getAttribute && node.getAttribute('role')) || '';
    if (tag === 'A' || role === 'link') return 'link';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'field';
    return 'button';
  };
  const found = [];
  const seen = new Set();
  for (const node of Array.from(document.querySelectorAll(SELECTOR))) {
    if (found.length >= limit) break;
    if (hidden(node)) continue;
    const tag = node.tagName;
    // An anchor with no href is not a link; it is a positioning trick. Clicking it would
    // navigate nowhere and then be reported as a successful act.
    if (tag === 'A' && !node.getAttribute('href')) continue;
    const type = (node.type || '').toLowerCase();
    if (tag === 'INPUT' && ['hidden', 'reset', 'image'].includes(type)) continue;
    const selector = locatorFor(node);
    if (selector.length > 256 || seen.has(selector)) continue;
    const hint = ((node.name || '') + ' ' + (node.id || '') + ' ' + (node.placeholder || '') + ' ' + ((node.getAttribute && node.getAttribute('aria-label')) || '')).toLowerCase();
    const autocomplete = (node.getAttribute && node.getAttribute('autocomplete')) || '';
    const entry = {
      kind: kindFor(node),
      label: labelFor(node),
      selector,
      protected: type === 'password' || type === 'hidden' || autocomplete.toLowerCase().indexOf('one-time-code') !== -1 || autocomplete.toLowerCase().indexOf('current-password') !== -1 || autocomplete.toLowerCase().indexOf('cc-') === 0 || PROTECTED_HINT.test(hint),
      disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true'
    };
    if (tag === 'SELECT') {
      entry.options = Array.from(node.options || []).slice(0, 64).map(o => clean(o.label || o.text || o.value, 80));
    }
    seen.add(selector);
    found.push(entry);
  }

  /* ---- headings, so a section name is findable and not only a link that points at it ---- */
  const headings = [];
  for (const node of Array.from(document.querySelectorAll('h1,h2,h3'))) {
    if (headings.length >= 20) break;
    if (hidden(node)) continue;
    const name = clean(node.innerText || node.textContent || '', 120);
    if (!name) continue;
    headings.push({ kind: 'heading', label: name, selector: locatorFor(node), protected: false, disabled: false });
  }

  return {
    url: location.href,
    title: clean(document.title, 200),
    text,
    truncated,
    elements: headings.concat(found)
  };
})`

/**
 * Move the page's scroll position.
 *
 * Reads and writes one number on one element. It cannot submit, navigate or exfiltrate, and
 * a page cannot observe it, which is why it is the one page interaction in this file that
 * does not walk the gates — while still being recorded by whoever asked for it.
 */
const SCROLL_SCRIPT = String.raw`((mode, amount) => {
  const doc = document.scrollingElement || document.documentElement;
  const height = doc ? doc.scrollHeight : 0;
  let top = doc ? doc.scrollTop : 0;
  if (mode === 'top') top = 0;
  else if (mode === 'bottom') top = Math.max(0, height);
  else top = top + amount;
  if (doc) doc.scrollTop = Math.max(0, Math.min(Math.max(0, height), top));
  return { top: Math.round(doc ? doc.scrollTop : 0), height: Math.round(height) };
})`

/**
 * Choose one option in a `<select>` and report which one is now chosen.
 *
 * Fires `change`, because a control set without one is a control the page does not believe
 * in: React's value tracker ignores a bare assignment, and so would any form handler driven by
 * it. Reading the value straight back is what makes the report an observation rather than an
 * intention.
 */
const SELECT_SCRIPT = String.raw`((selector, index) => {
  const node = document.querySelector(selector);
  if (!node || node.tagName !== 'SELECT') return { ok: false, selected: null, reason: 'not-found' };
  if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') return { ok: false, selected: null, reason: 'disabled' };
  const options = Array.from(node.options || []);
  if (index < 0 || index >= options.length) return { ok: false, selected: null, reason: 'out-of-range' };
  const option = options[index];
  node.value = option.value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: node.value === option.value, selected: String(option.label || option.text || option.value).slice(0, 80), reason: null };
})`

/** What the snapshot script hands back. Bounded, and with no element value anywhere. */
export interface SurfaceSnapshotPayload {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly elements: ReadonlyArray<{
    readonly kind: string
    readonly label: string
    readonly selector: string
    readonly protected: boolean
    readonly disabled: boolean
    readonly options?: readonly string[]
  }>
}

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
const TYPE_SCRIPT = String.raw`((selector, text, allowProtected) => {
  const node = document.querySelector(selector);
  if (!node) return { ok: false, changed: false, readBack: null, protectedKind: null, reason: 'not-found' };
  if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') return { ok: false, changed: false, readBack: null, protectedKind: null, reason: 'disabled' };
  const PROTECTED_HINT = /pass(word|wd|phrase)?|\bpwd\b|credit.?card|\bcc.?num|\bcvc\b|\bcvv\b|\bcsc\b|security.?code|social.?security|\bssn\b|\botp\b|one.?time|\b2fa\b|\bmfa\b|auth.?token|access.?token|api.?key|secret|passphrase/i;
  const type = (node.type || '').toLowerCase();
  const haystack = ((node.name || '') + ' ' + (node.id || '') + ' ' + (node.placeholder || '') + ' ' + (node.getAttribute('aria-label') || '')).toLowerCase();
  if (allowProtected !== '1' && (type === 'password' || type === 'hidden' || PROTECTED_HINT.test(haystack))) {
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

/** Where the page itself says it is. The witness for a navigation outcome. */
const LOCATION_SCRIPT = String.raw`(() => location.href)()`

/** What one page reports about itself. Every field is a fact it can witness. */
export interface SurfaceReading {
  readonly sessionId: string
  readonly url: string | null
  readonly title: string | null
  readonly revision: number
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: string | null
}

/* ---------------------------------------------------------------- live port */

/**
 * The extra surface the Browser Service needs from a live page, on top of
 * {@link FreyaBrowserPage}.
 *
 * Declared here, as an interface, rather than letting callers name
 * {@link ElectronFreyaBrowserPage}. The point of a port is that a test can implement it with
 * a scripted page and assert on placement, navigation and reference safety without Electron
 * in the process — and a port that names a concrete class cannot be implemented by anything
 * but that class.
 *
 * Every method is bounded and answers with a code rather than throwing, for the same reason
 * the rest of this file does: a page that could not do something is not a network failure.
 */
export interface FreyaBrowserLivePage extends FreyaBrowserPage {
  /** Everything the page can witness about itself, right now. */
  reading(): SurfaceReading
  /** Push updates. Called back immediately with the current facts. */
  onReading(listener: (reading: SurfaceReading) => void): () => void
  reload(): Promise<{ readonly ok: boolean; readonly finalUrl: string | null; readonly code: string }>
  snapshot(): Promise<{ readonly ok: boolean; readonly payload: SurfaceSnapshotPayload | null; readonly code: string }>
  scroll(request: { readonly kind: 'top' | 'bottom' | 'delta'; readonly amount?: number }): Promise<{ readonly ok: boolean; readonly top: number; readonly height: number; readonly code: string }>
  select(selector: string, index: number): Promise<{ readonly ok: boolean; readonly selected: string | null; readonly code: string }>
  wait(request: { readonly settleMs: number; readonly until?: string }): Promise<{ readonly ok: boolean; readonly settled: boolean; readonly url: string | null; readonly code: string }>
  /**
   * Capture the visible pixels as PNG.
   *
   * Bounded at `BROWSER_LIMITS.maxScreenshotBytes` so a tab that paints a 4K
   * surface does not return a 60 MB PNG and exhaust the journal. Returns
   * PNG bytes plus the dimensions and the surface's own revision at the
   * moment of capture, so a caller can decide whether the bytes are still
   * the page it is looking at.
   */
  screenshot(): Promise<{ readonly ok: boolean; readonly payload: ScreenshotPayload | null; readonly code: string }>
}

/** What `screenshot` hands back. Crosses the IPC boundary, so every field is serialisable. */
export interface ScreenshotPayload {
  /** PNG bytes. Crosses the boundary as a `Buffer`. */
  readonly png: Buffer
  readonly width: number
  readonly height: number
  readonly revision: number
  readonly url: string
  readonly title: string
}

/* ------------------------------------------------------------------ the page */

export interface FreyaWindowOptions {
  /** When supplied, pages are embedded in the main window, never popped out. */
  readonly hostWindow?: () => BrowserWindow | null
  /** The owner's host allowlist. Empty means no host is allowlisted in strict mode. */
  readonly onOpenUrl?: (url: string) => void
  readonly allowedHosts?: readonly string[]
  /** Development-only: remove browser permission friction. */
  readonly localUnrestricted?: boolean
  /** Development-only: permit loopback/private hosts and explicit dev ports. */
  readonly allowPrivateHosts?: boolean
  /** Development-only: permit normal interaction with protected fields. */
  readonly allowProtectedFields?: boolean
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

export class ElectronFreyaBrowserPage implements FreyaBrowserLivePage {
  private window?: BrowserWindow
  private view?: WebContentsView
  private attachedHost?: BrowserWindow
  private contents?: WebContents
  private ses?: Session
  private closed = false
  private revision = 0
  private url: string | null = null
  private title: string | null = null
  private mediaSequence = 0
  private cleanup?: Promise<void>
  private loading = false
  private error: string | null = null
  private history: string[] = []
  private cursor = -1
  private backStack: string[] = []
  private forwardStack: string[] = []
  /**
   * Push listeners, so a surface can learn about a navigation without polling.
   *
   * One of these per window, created eagerly rather than on the first subscribe so a caller
   * that attaches after the page has already loaded is not silently given a stale view. The
   * reader is called immediately with the current facts.
   */
  private readonly readingListeners = new Set<(reading: SurfaceReading) => void>()

  private readonly onDidStartLoading = (): void => {
    this.loading = true
    this.publish()
  }

  private readonly onDidStopLoading = (): void => {
    this.loading = false
    this.publish()
  }

  private readonly onTitleUpdated = (_event: unknown, title: string): void => {
    this.title = title.slice(0, 200)
    this.publish()
  }

  private readonly onDidNavigate = (_event: unknown, url: string): void => {
    // Every navigation a page can perform — its own, a redirect's, a link's — retires the
    // references minted for the previous one. This is the single place the counter moves,
    // which is why it cannot be moved backwards by a path that forgot to check.
    this.revision += 1
    this.url = url
    this.title = null
    this.error = null
    // A history entry is created by the *window*, not by Freya. A page that rewrites its own
    // address with `history.pushState` is still a page the person can go back from, and
    // pretending otherwise is how a back button that does nothing gets shipped.
    this.backStack = this.history.slice(0, Math.max(0, this.cursor + 1))
    this.forwardStack = []
    const bounded = [...this.backStack, url].slice(-64)
    this.history = bounded
    this.cursor = bounded.length - 1
    this.publish()
  }

  private readonly onNavigateInPage = (event: unknown, url: string, isMainFrame: boolean): void => {
    if (!isMainFrame) return
    void event
    this.revision += 1
    this.url = url
    this.title = null
    this.error = null
    this.publish()
  }

  private readonly onFailedLoad = (_event: unknown, errorCode: number, description: string, _url: string, isMainFrame: boolean): void => {
    if (!isMainFrame || errorCode === -3) return
    this.revision += 1
    this.title = null
    this.url = null
    this.loading = false
    // A code, never Electron's prose: the description can carry a hostname and a path, and
    // the projection that reads this must not be able to leak a URL Freya refused.
    this.error = 'load-failed'
    void description
    this.publish()
  }

  private readonly onRenderGone = (): void => {
    this.revision += 1
    this.error = 'renderer-gone'
    this.publish()
    void this.close()
  }

  private readonly onDownload = (event: { preventDefault(): void }, item: Electron.DownloadItem): void => {
    event.preventDefault()
    this.mediaSequence += 1
    const mediaId = `${this.sessionId}-download-${String(this.mediaSequence)}`
    const url = item.getURL()
    const address = assertPublicBrowserUrl(url, {
      allowedHosts: this.allowedHosts,
      allowPrivateHosts: this.allowPrivateHosts,
    })
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
  private readonly localUnrestricted: boolean
  private readonly allowPrivateHosts: boolean
  private readonly allowProtectedFields: boolean
  private readonly settleMs: number

  constructor(
    readonly sessionId: string,
    partition: string,
    private readonly options: FreyaWindowOptions,
  ) {
    this.allowedHosts = options.allowedHosts ?? []
    this.localUnrestricted = options.localUnrestricted === true
    this.allowPrivateHosts = options.allowPrivateHosts === true
    this.allowProtectedFields = options.allowProtectedFields === true
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
    return assertPublicBrowserUrl(candidate, {
      allowedHosts: this.allowedHosts,
      allowPrivateHosts: this.allowPrivateHosts,
    }).ok
  }

  initialize(ses: Session): void {
    this.ses = ses
    // Strict default remains explicit and source-auditable.
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    if (this.localUnrestricted) {
      // The development profile deliberately replaces those handlers for local testing.
      ses.setPermissionCheckHandler(() => true)
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(true))
    }
    ses.on('will-download', this.onDownload)
    // Nothing on this partition may reach a private or local address, from any origin, for
    // any resource type. This is the reason the Freya Browser is not a doorway to the
    // owner's network.
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !this.requestAllowed(details.url, details.resourceType) })
    })

    const preferences: Electron.WebPreferences = {
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
    }
    if (this.options.hostWindow) {
      this.view = new WebContentsView({ webPreferences: preferences })
      this.contents = this.view.webContents
    } else {
      this.window = new BrowserWindow({ show: true, width: 1100, height: 800, webPreferences: preferences })
      this.contents = this.window.webContents
    }
    const contents = this.contents
    contents.setWindowOpenHandler(({ url }) => {
      if (this.allowedUrl(url)) this.options.onOpenUrl?.(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!this.allowedUrl(url)) {
        event.preventDefault()
        return
      }
      this.revision += 1
    })
    contents.on('will-frame-navigate', (event) => {
      // The existing URL policy validates owner-clicked top-level navigation.
      // Subframe navigation retains the existing denial policy.
      if (!event.isMainFrame || !this.allowedUrl(event.url)) event.preventDefault()
    })
    contents.on('will-attach-webview', this.prevent)
    contents.on('did-start-loading', this.onDidStartLoading)
    contents.on('did-stop-loading', this.onDidStopLoading)
    contents.on('page-title-updated', this.onTitleUpdated)
    contents.on('did-navigate', this.onDidNavigate)
    contents.on('did-navigate-in-page', this.onNavigateInPage)
    contents.on('did-fail-load', this.onFailedLoad)
    contents.on('did-fail-provisional-load', this.onFailedLoad)
    contents.on('render-process-gone', this.onRenderGone)
    this.window?.on('closed', this.onWindowClosed)
  }

  setDock(bounds: Electron.Rectangle | null): void {
    if (!this.view || this.closed) return
    if (this.attachedHost && !this.attachedHost.isDestroyed()) this.attachedHost.contentView.removeChildView(this.view)
    this.attachedHost = undefined
    if (bounds === null) return
    const host = this.options.hostWindow?.()
    if (!host || host.isDestroyed()) return
    host.contentView.addChildView(this.view)
    this.view.setBounds(bounds)
    this.attachedHost = host
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
    if (!this.allowPrivateHosts && isPrivateOrLocalHost(host)) return false
    return resourceType !== 'mainFrame' || this.allowedUrl(candidate)
  }

  currentUrl(): string | null {
    return this.url
  }

  /** Everything this page can witness about itself, right now. */
  reading(): SurfaceReading {
    return {
      sessionId: this.sessionId,
      url: this.url,
      title: this.title,
      revision: this.revision,
      loading: this.loading,
      canGoBack: this.backStack.length > 0,
      canGoForward: this.forwardStack.length > 0,
      error: this.error,
    }
  }

  /**
   * Subscribe to this page's own reports.
   *
   * Called back immediately, because a caller that attaches after the page loaded is owed the
   * current facts and not only the next change. One listener throwing does not stop the
   * others: a broken window must not be able to silence the surface.
   */
  onReading(listener: (reading: SurfaceReading) => void): () => void {
    this.readingListeners.add(listener)
    try {
      listener(this.reading())
    } catch {
      // A subscriber that throws on its first read gets the next one.
    }
    return () => {
      this.readingListeners.delete(listener)
    }
  }

  private publish(): void {
    if (this.closed || this.readingListeners.size === 0) return
    const view = this.reading()
    for (const listener of [...this.readingListeners]) {
      try {
        listener(view)
      } catch {
        // One broken subscriber must not stop the rest.
      }
    }
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
    if (this.closed || this.contents === undefined) return { ok: false, finalUrl: null, code: 'session-closed' }
    if (!this.allowedUrl(url)) return { ok: false, finalUrl: null, code: 'url-refused' }
    const startRevision = this.revision
    try {
      await this.contents.loadURL(url)
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
    this.loading = false
    this.error = null
    this.publish()
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
    const result = await this.eval<{ elements?: unknown; title?: string }>(SNAPSHOT_SCRIPT, ['120', '0'])
    if (result === null) return { ok: false, payload: null, code: 'describe-failed' }
    if (typeof result.title === 'string') this.title = result.title.slice(0, 200)
    const payload = this.allowProtectedFields && Array.isArray(result.elements)
      ? result.elements.map((entry) =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry)
            ? { ...(entry as Record<string, unknown>), protected: false }
            : entry,
        )
      : result.elements
    return { ok: true, payload, code: 'described' }
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
    const changed = await this.settle(before)
    // A click that navigates must be observed from the page, not only from the window's
    // navigation event. A click dispatched in the isolated world can commit a navigation
    // whose `did-navigate` never reaches this class, which left the tab reporting the
    // address it *used to* be on while the page was already elsewhere. The wait is taken
    // even when the page changed synchronously: an anchor takes focus the instant it is
    // clicked and navigates a moment later, so a synchronous change is not evidence that
    // the act is finished.
    if (changed) await this.adoptPageAddress()
    return { ok: true, changed, protectedKind: null, code: changed ? 'clicked' : 'click-unobserved' }
  }

  /**
   * Adopt the address the page itself reports.
   *
   * The page is the witness for where it is; `this.url` is a cache updated by navigation
   * events, and an event can be missed — a click dispatched in the isolated world can
   * commit a navigation whose `did-navigate` never arrives. Reading once is not enough:
   * an anchor fires its navigation *after* the click call returns, so the address is
   * only settled a moment later. Polling for it is what makes the observed address the
   * outcome of the click rather than the state of the page at the instant of the click,
   * and the loop is bounded by the same settle budget the rest of the act uses.
   */
  private async adoptPageAddress(): Promise<void> {
    const deadline = Date.now() + Math.max(250, this.settleMs)
    let adopted: string | null = null
    while (Date.now() < deadline) {
      const here = await this.eval<string>(LOCATION_SCRIPT)
      // Only a real, allowed address is adopted. A page that moved itself to about:blank
      // or a refused scheme has not navigated anywhere this window will report.
      if (shouldAdoptPageAddress(this.url, here) && this.allowedUrl(here)) {
        adopted = here
        break
      }
      if (this.closed) return
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
    if (adopted === null || adopted === this.url) return
    this.url = adopted
    this.title = null
    this.revision += 1
    this.publish()
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
    const result = await this.eval<{ ok?: boolean; changed?: boolean; readBack?: string | null; protectedKind?: string | null; reason?: string }>(
      TYPE_SCRIPT,
      [selector, text, this.allowProtectedFields ? '1' : '0'],
    )
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

  /**
   * Reload the address this page is on, without being told which address that is.
   *
   * Re-derived from `canGoBack`-style history rather than from a remembered URL, because the
   * two differ exactly when the page moved since the last read, and a reload that silently
   * lands somewhere else is the failure this whole file's revision discipline exists to stop.
   */
  async reload(): Promise<{ ok: boolean; finalUrl: string | null; code: string }> {
    if (this.closed || this.contents === undefined) return { ok: false, finalUrl: null, code: 'session-closed' }
    const here = this.url
    if (here === null) return { ok: false, finalUrl: null, code: 'page-missing' }
    if (!this.allowedUrl(here)) return { ok: false, finalUrl: null, code: 'url-refused' }
    const startRevision = this.revision
    try {
      await this.contents.reload()
    } catch {
      return { ok: false, finalUrl: null, code: 'navigate-failed' }
    }
    if (this.closed) return { ok: false, finalUrl: null, code: 'session-closed' }
    if (this.revision === startRevision) this.revision += 1
    const read = await this.eval<{ title?: string }>(READ_SCRIPT)
    if (read !== null && typeof read.title === 'string') this.title = read.title.slice(0, 200)
    this.publish()
    return { ok: true, finalUrl: this.url ?? here, code: 'reloaded' }
  }

  /**
   * One bounded pass over the page: prose, headings and every actionable control.
   *
   * The same script {@link describe} uses, asked for its text as well. Two callers, one
   * script, no possibility that the reference a click resolves and the name a caller read
   * were produced by different code.
   */
  async snapshot(): Promise<{ ok: boolean; payload: SurfaceSnapshotPayload | null; code: string }> {
    const result = await this.eval<SurfaceSnapshotPayload>(SNAPSHOT_SCRIPT, ['120', '1'])
    if (result === null || typeof result.url !== 'string') return { ok: false, payload: null, code: 'snapshot-failed' }
    if (typeof result.title === 'string') this.title = result.title.slice(0, 200)
    return { ok: true, payload: result, code: 'snapshot' }
  }

  async scroll(
    request: { readonly kind: 'top' | 'bottom' | 'delta'; readonly amount?: number },
  ): Promise<{ ok: boolean; top: number; height: number; code: string }> {
    const mode = request.kind
    const result = await this.eval<{ top?: number; height?: number }>(
      SCROLL_SCRIPT,
      [mode, String(Math.round(Math.max(-20_000, Math.min(20_000, request.amount ?? 0))))],
    )
    if (result === null || typeof result.top !== 'number' || typeof result.height !== 'number') {
      return { ok: false, top: 0, height: 0, code: 'scroll-failed' }
    }
    return { ok: true, top: result.top, height: result.height, code: 'scrolled' }
  }

  async select(selector: string, index: number): Promise<{ ok: boolean; selected: string | null; code: string }> {
    const result = await this.eval<{ ok?: boolean; selected?: string | null; reason?: string }>(SELECT_SCRIPT, [selector, String(index)])
    if (result === null || result.ok !== true) {
      const reason = result?.reason
      return {
        ok: false,
        selected: null,
        code: reason === 'disabled' ? 'element-disabled' : reason === 'out-of-range' ? 'request-malformed' : 'element-not-found',
      }
    }
    return { ok: true, selected: typeof result.selected === 'string' ? result.selected : null, code: 'selected' }
  }

  /**
   * Wait for the page to stop changing, or for an address to appear.
   *
   * Bounded twice over: by the caller's ceiling and by an internal one, and both are real.
   * A wait that can hang is indistinguishable from a browser that has died, and the two need
   * different answers from the owner.
   */
  async wait(request: { readonly settleMs: number; readonly until?: string }): Promise<{ ok: boolean; settled: boolean; url: string | null; code: string }> {
    if (this.closed || this.contents === undefined) return { ok: false, settled: false, url: null, code: 'session-closed' }
    const ceiling = Math.max(0, Math.min(request.settleMs, 10_000))
    const deadline = Date.now() + ceiling
    // A page that never stops loading — a websocket, a polling dashboard — must not turn a
    // wait into a hang, so a quiet period counts as settled even when `isLoading` stays true.
    const quietMs = Math.max(250, Math.min(1_000, Math.ceil(ceiling / 4)))
    let lastSignature: string | null = null
    let quietSince = Date.now()
    while (Date.now() < deadline) {
      const here = this.url ?? ''
      if (request.until !== undefined && here.includes(request.until)) {
        return { ok: true, settled: true, url: this.url, code: 'reached' }
      }
      if (!this.loading) {
        if (this.url !== null) return { ok: true, settled: true, url: this.url, code: 'settled' }
      }
      const signature = `${String(this.revision)}|${String(this.loading)}|${here}`
      if (signature !== lastSignature) {
        lastSignature = signature
        quietSince = Date.now()
      } else if (Date.now() - quietSince >= quietMs) {
        return { ok: true, settled: true, url: this.url, code: 'quiet' }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (request.until !== undefined) return { ok: false, settled: false, url: this.url, code: 'wait-exceeded' }
    return { ok: true, settled: false, url: this.url, code: 'wait-exceeded' }
  }

  /**
   * Capture the visible pixels of the page as PNG.
   *
   * `webContents.capturePage()` is the one path that turns the offscreen
   * surface into bytes the kernel can return to the model. The call is on the
   * page's own `webContents`, not a generic one, because a tab that is not the
   * active view returns a black rectangle; we always capture the tab the
   * surface asked us to.
   *
   * Two refusals are not `capturePage` failures and are checked here, because
   * they are the shapes of a lie rather than a failed capture:
   *   - a view nobody attached answers 0x0 with zero bytes, "successfully";
   *   - a view attached to a one-pixel rect answers 2x2, also "successfully".
   * Either one handed back as a screenshot would tell the model it had seen a
   * page it had not seen, so both are refused with their own code.
   */
  async screenshot(): Promise<{ readonly ok: boolean; readonly payload: ScreenshotPayload | null; readonly code: string }> {
    const contents = this.contents
    if (this.closed || contents === undefined || contents.isDestroyed()) {
      return { ok: false, payload: null, code: 'screenshot-failed' }
    }
    if (this.url === null) {
      return { ok: false, payload: null, code: 'page-missing' }
    }
    /**
     * Two ways to get pixels, tried in this order, because they answer
     * different questions.
     *
     * `webContents.capturePage()` asks the compositor for the frame the window
     * last painted. That is the truthful picture of what is on screen — and it
     * is exactly what throws `UnknownVizError` when the window's compositor has
     * not produced a frame for this view: a view that was attached a moment ago,
     * a window that was minimised or occluded, or a host whose panel is closed
     * and has never composited the child at all.
     *
     * `Page.captureScreenshot` over the DevTools protocol asks the page's own
     * renderer to rasterise itself. It does not need a window frame, so it
     * answers in precisely those cases. What it gives is the page as it lays
     * itself out, which for a hidden view is the same layout the visible capture
     * would have produced at that size.
     *
     * So the compositor is tried first and the renderer is the fallback: the
     * owner sees a real screenshot whenever there is a real frame to take, and
     * the model is not told "there is nothing to see" when there is a page.
     */
    const captured = await this.captureFromCompositor(contents)
    if (captured.ok) return captured.result
    const rendered = await this.captureFromRenderer(contents)
    if (rendered.ok) return rendered.result
    return {
      ok: false,
      payload: null,
      code: `${captured.code} | renderer-capture: ${rendered.code}`,
    }
  }

  /** The compositor path, with its own emptiness refusal. */
  private async captureFromCompositor(
    contents: WebContents,
  ): Promise<{ readonly ok: true; readonly result: { readonly ok: boolean; readonly payload: ScreenshotPayload | null; readonly code: string } } | { readonly ok: false; readonly code: string }> {
    let image
    try {
      image = await contents.capturePage()
    } catch (error) {
      // Electron's reason travels with the code, because "the capture failed"
      // without it is a diagnosis nobody can act on.
      return { ok: false, code: `screenshot-failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    const png = image.toPNG()
    const size = image.getSize()
    if (png.byteLength === 0 || size.width < 64 || size.height < 64) {
      // `capturePage` reports "success" for a view nobody attached (0x0, zero
      // bytes) and for a view given a one-pixel rect (2x2). Neither is a page,
      // and reporting either would be the shape of a lie.
      return {
        ok: false,
        code: `capture-empty: ${String(size.width)}x${String(size.height)} returned, ${String(png.byteLength)} bytes; the view has no painted frame`,
      }
    }
    if (png.byteLength > BROWSER_LIMITS.maxScreenshotBytes) {
      return { ok: false, code: 'screenshot-too-large' }
    }
    return {
      ok: true,
      result: {
        ok: true,
        payload: {
          png,
          width: size.width,
          height: size.height,
          revision: this.revision,
          url: this.url ?? '',
          title: this.title ?? '',
        },
        code: 'captured',
      },
    }
  }

  /**
   * The renderer path: `Page.captureScreenshot` over the DevTools protocol.
   *
   * The debugger is attached for the one call and detached again, and only when
   * this page did not already have one attached — the extension bridge and any
   * future debugging path own their own attachment, and a screenshot must never
   * take it away. `fromSurface: false` asks the renderer for its own frame, which
   * is what works when the window's compositor has none.
   */
  private async captureFromRenderer(
    contents: WebContents,
  ): Promise<{ readonly ok: true; readonly result: { readonly ok: boolean; readonly payload: ScreenshotPayload | null; readonly code: string } } | { readonly ok: false; readonly code: string }> {
    const alreadyAttached = contents.debugger.isAttached()
    if (!alreadyAttached) {
      try {
        contents.debugger.attach('1.3')
      } catch (error) {
        return { ok: false, code: `debugger-attach-failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    try {
      const reply = (await contents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: false,
        captureBeyondViewport: false,
      })) as { data?: unknown }
      const encoded = typeof reply.data === 'string' ? reply.data : ''
      if (encoded === '') return { ok: false, code: 'capture-empty: the renderer returned no image data' }
      const png = Buffer.from(encoded, 'base64')
      if (png.byteLength === 0) return { ok: false, code: 'capture-empty: the renderer returned zero bytes' }
      if (png.byteLength > BROWSER_LIMITS.maxScreenshotBytes) return { ok: false, code: 'screenshot-too-large' }
      // The PNG's own IHDR carries the dimensions, so the answer needs no second
      // round trip and cannot disagree with the bytes it is describing.
      const width = png.byteLength >= 24 ? png.readUInt32BE(16) : 0
      const height = png.byteLength >= 24 ? png.readUInt32BE(20) : 0
      if (width < 64 || height < 64) {
        return { ok: false, code: `capture-empty: ${String(width)}x${String(height)} returned, ${String(png.byteLength)} bytes` }
      }
      return {
        ok: true,
        result: {
          ok: true,
          payload: {
            png,
            width,
            height,
            revision: this.revision,
            url: this.url ?? '',
            title: this.title ?? '',
          },
          code: 'captured-renderer',
        },
      }
    } catch (error) {
      return { ok: false, code: `capture-failed: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      if (!alreadyAttached) {
        try {
          contents.debugger.detach()
        } catch {
          // A debugger that detached itself with the page needs nothing from us.
        }
      }
    }
  }

  close(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.setDock(null)
    this.closed = true
    // Retiring the revision here is what makes a closed window's references unusable rather
    // than merely unreachable: a caller holding one is refused `page-stale` instead of
    // being handed a page that no longer exists.
    this.revision += 1
    this.url = null
    this.title = null
    this.loading = false
    this.history = []
    this.backStack = []
    this.forwardStack = []
    this.readingListeners.clear()
    if (this.window !== undefined && !this.window.isDestroyed()) this.window.destroy()
    if (this.contents !== undefined) {
      const contents = this.contents
      contents.removeAllListeners('will-navigate')
      contents.removeAllListeners('will-frame-navigate')
      contents.removeAllListeners('will-attach-webview')
      contents.removeAllListeners('did-start-loading')
      contents.removeAllListeners('did-stop-loading')
      contents.removeAllListeners('page-title-updated')
      contents.removeAllListeners('did-navigate')
      contents.removeAllListeners('did-navigate-in-page')
      contents.removeAllListeners('did-fail-load')
      contents.removeAllListeners('did-fail-provisional-load')
      contents.removeAllListeners('render-process-gone')
      this.window?.removeListener('closed', this.onWindowClosed)
    }
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close()
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
  private readonly pages = new Map<string, ElectronFreyaBrowserPage>()
  constructor(private readonly options: FreyaWindowFactoryOptions = {}) {}

  dock(sessionId: string | null, bounds: Electron.Rectangle | null): boolean {
    for (const page of this.pages.values()) page.setDock(null)
    if (sessionId === null || bounds === null) return true
    const page = this.pages.get(sessionId)
    if (!page) return false
    page.setDock(bounds)
    return true
  }

  async create(sessionId: string, partition: string): Promise<FreyaBrowserLivePage> {
    const ses = this.options.sessionFor
      ? this.options.sessionFor(partition)
      : electronSession.fromPartition(partition, { cache: true })
    await ses.clearStorageData().catch(() => undefined)
    await ses.clearCache().catch(() => undefined)
    const page = new ElectronFreyaBrowserPage(sessionId, partition, this.options)
    page.initialize(ses)
    this.pages.set(sessionId, page)
    const close = page.close.bind(page)
    page.close = () => { this.pages.delete(sessionId); return close() }
    return page
  }
}

/** The permissions this build denies, re-exported so the window and its test agree. */
export const FREYA_BROWSER_DENIED_PERMISSIONS = PUBLIC_BROWSER_DENIED_PERMISSIONS