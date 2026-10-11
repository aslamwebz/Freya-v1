import { canonicalDigest } from '../devicehands'
import { FORBIDDEN_SELECTOR_TOKENS } from '../devicehands'
import { truncateUtf8, utf8Bytes } from '../browserext'
import { BROWSER_LIMITS } from './types'
import type { BrowserRefusalCode } from './types'

/**
 * Page descriptions and the stable references they hand out.
 *
 * The problem this solves is the one that makes agent browsing dangerous: an agent reads
 * a page, decides to click something, and by the time the click lands the page has been
 * replaced. Acting on the *memory* of a page is how an agent clicks the wrong button on a
 * page that happens to look the same — a different product, a different account, a
 * different invoice.
 *
 * ## The rule
 *
 * A reference belongs to exactly one `(pageId, revision)` pair. A navigation or a reload
 * increments the revision, which retires every reference from before it. A caller holding
 * an old reference is refused `page-stale` and told to describe the page again.
 *
 * ## Why the reference is a digest rather than an index
 *
 * Two reasons, and both matter:
 *
 *   - An index into a list is trivially forgeable and silently means "the third thing on
 *     the page", so a caller could name a ref that was never handed out and have it
 *     resolve to whatever happens to be third *now*.
 *   - A digest of `(pageId, revision, ordinal, kind, selector)` changes when any of those
 *     change, so a reference cannot be carried from one revision to another without the
 *     check failing, and it cannot be replayed against a different page.
 *
 * It is **not** a security primitive, and it does not need to be. `canonicalDigest` is
 * two FNV-1a lanes and says so itself. What closes the forging concern is not the digest
 * being unguessable — it is that {@link RefTable.resolve} only ever resolves a ref
 * against the entries this runtime actually minted for the *current* revision. A digest
 * nobody minted is `ref-unknown`, however well it was computed.
 */

/* ------------------------------------------------------------------- shapes */

/** What an element on a described page is. Closed, and deliberately not a DOM role list. */
export const ELEMENT_KINDS = ['link', 'button', 'field', 'heading', 'text'] as const
export type ElementKind = (typeof ELEMENT_KINDS)[number]

export function isElementKind(value: unknown): value is ElementKind {
  return typeof value === 'string' && (ELEMENT_KINDS as readonly string[]).includes(value)
}

export interface PageElement {
  /** Opaque. Only meaningful against the `(pageId, revision)` that produced it. */
  readonly ref: string
  readonly ordinal: number
  readonly kind: ElementKind
  /** Visible label, bounded. Never the element's value. */
  readonly label: string
  /** A locator, already checked against the Phase 35 forbidden-selector list. */
  readonly selector: string
  /** A password, card, OTP or other protected field. Never actionable in either browser. */
  readonly protected: boolean
  readonly disabled: boolean
  /**
   * Where an anchor points, when the adapter reported one. Null for every other kind.
   *
   * ## Why this exists, and why it is not a locator
   *
   * `selector` is a *locator*: it says where the element is in this document, so it changes
   * the moment the page does. An `href` is an *address*: it says where the link leads, so it
   * survives navigation and can be handed to a later `page.navigate`. Following a link is
   * therefore navigable without ever clicking, which is why `core/mind/browser-tool.ts`
   * documents that it "does not follow a section by clicking a heading".
   *
   * The adapter has always collected this — `electron/browser/freyaWindow.ts` reads
   * `getAttribute('href')` — and `describePage` was dropping it, which left a described page
   * with no way to say *where its links go*. That is the gap.
   *
   * ## What it deliberately is not
   *
   * It is **not** resolved, **not** normalised against the page's base, and **not** trusted.
   * A page fully controls its own markup, so an `href` is page-supplied data of exactly the
   * same standing as any other text on the page: it may be absolute, relative, a `javascript:`
   * URL, or nonsense. `isNavigableBrowserUrl` and `assertPublicBrowserUrl` are the authority
   * on whether an address may be opened, and they are consulted at *navigate* time — so this
   * field only ever tells a caller what the page claimed, and opening it still goes through
   * the same routing, isolation and Device Hands gates as any other navigation.
   *
   * Bounded to {@link MAX_HREF_CHARS} and refused outright when it contains a control
   * character, because a value that can carry a newline or a NUL into a later request is a
   * value that has to be dropped rather than truncated into something that still means it.
   */
  readonly href: string | null
}

export interface PageSnapshot {
  readonly pageId: string
  readonly revision: number
  readonly url: string
  readonly title: string
  readonly elements: readonly PageElement[]
  readonly textBytes: number
  readonly truncated: boolean
}

/* -------------------------------------------------------------------- minting */

const REF_PREFIX = 'r1'

/**
 * One reference, derived from everything that identifies the element.
 *
 * Sixteen hex characters of a non-cryptographic digest, prefixed so a ref is visibly not
 * a CSS selector and cannot be pasted into a `document.querySelector` by accident.
 */
export function mintRef(input: {
  readonly pageId: string
  readonly revision: number
  readonly ordinal: number
  readonly kind: ElementKind
  readonly selector: string
}): string {
  const digest = canonicalDigest([
    'freya.browser.ref',
    input.pageId,
    input.revision,
    input.ordinal,
    input.kind,
    input.selector,
  ])
  return `${REF_PREFIX}-${digest.slice(0, 16)}`
}

/* ---------------------------------------------------------------- describing */

export type DescribeReading =
  | {
      readonly ok: true
      readonly snapshot: PageSnapshot
      readonly elements: readonly PageElement[]
      /**
       * The page's own words, bounded to {@link BROWSER_LIMITS.maxSnapshotTextBytes}.
       *
       * Deliberately **not** a field of {@link PageSnapshot}. A snapshot is the *reference*
       * view, and it reports `textBytes` rather than the text so that describing a page and
       * handing out handles for it cannot be confused with reading the page. The Semantic
       * Browser Protocol needs both at once, so it is offered here as a second thing beside
       * the snapshot rather than smuggled into it.
       */
      readonly text: string
    }
  | { readonly ok: false; readonly code: BrowserRefusalCode; readonly reason: string }

/** The raw shape an adapter is asked for. Every field is untrusted. */
interface RawElement {
  readonly ordinal?: unknown
  readonly kind?: unknown
  readonly label?: unknown
  readonly selector?: unknown
  readonly protected?: unknown
  readonly disabled?: unknown
  /** Present only for anchors, and only when the page declared one. Untrusted like any text. */
  readonly href?: unknown
}

function refuse(code: BrowserRefusalCode, reason: string): DescribeReading {
  return { ok: false, code, reason }
}

/**
 * The selector charset, mirrored from the gate rather than invented here.
 *
 * `core/devicehands/gates.ts` keeps `SELECTOR_PATTERN` private and refuses a click whose
 * selector falls outside it. This is the *same* character class, written out again
 * because a description module that imported a gate constant would depend on the gate,
 * and because the useful property is the opposite: a description must never offer a
 * locator the gate would refuse, so the two have to agree and a test asserts they do.
 * See `tests/core/browser/refs.test.ts`, which runs every described locator through the
 * real `normaliseDeviceAction`.
 */
const SAFE_SELECTOR = /^[\p{L}\p{N}#._\-[\]="':, ]{1,256}$/u
const MAX_SELECTOR_CHARS = 256

function readSelector(value: unknown): { ok: true; selector: string } | { ok: false; reason: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'An element with no locator cannot be referenced, so it is not described.' }
  }
  if (value.length > MAX_SELECTOR_CHARS) {
    return { ok: false, reason: `A locator longer than ${String(MAX_SELECTOR_CHARS)} characters is not described.` }
  }
  const lowered = value.toLowerCase()
  const token = FORBIDDEN_SELECTOR_TOKENS.find((candidate) => lowered.includes(candidate))
  if (token !== undefined) {
    return { ok: false, reason: `A locator containing "${token}" is refused rather than described.` }
  }
  if (!SAFE_SELECTOR.test(value)) {
    return { ok: false, reason: 'A locator may only contain letters, digits and the punctuation a selector needs; the gate that authorises a click accepts nothing else either.' }
  }
  return { ok: true, selector: value }
}

/**
 * Characters an address never needs, and therefore may never carry.
 *
 * Newline, carriage return, tab, NUL and every other C0/C1 control. An `href` containing one
 * of these is dropped rather than cleaned, because cleaning would produce an address the page
 * did not declare — and an address that is not what the page said is exactly the kind of
 * thing that must not be navigated to.
 */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f]/u

/** The bound on one described address. Comfortably above any real `href`. */
export const MAX_HREF_CHARS = 400

/**
 * Read the address an anchor claimed, or `null` for "it did not claim one".
 *
 * A non-string, an empty string, a control character or an over-long value all read as
 * `null` — which is the honest reading of a page that did not give a usable address, and it
 * is what makes the field **absent** rather than empty. Nothing here resolves, escapes or
 * repairs the value; `null` is the only refusal shape, because there is no partial href.
 */
function readHref(value: unknown, kind: ElementKind): string | null {
  if (kind !== 'link') return null
  if (typeof value !== 'string') return null
  const href = value.trim()
  if (href.length === 0 || href.length > MAX_HREF_CHARS) return null
  if (UNPRINTABLE.test(href)) return null
  return href
}

/**
 * Turn whatever the adapter extracted into a bounded, referenced description.
 *
 * Every field is untrusted and nothing is repaired. An element with a bad locator, an
 * unknown kind, or a missing label is **dropped with a count** rather than coerced, because
 * a description that quietly turned "a div with an onclick" into "a button" is a
 * description that will be clicked.
 *
 * Text is bounded on a UTF-8 boundary and only its *byte count* is returned, so the
 * description does not become a second copy of the page in an object graph nobody bounded.
 */
export function describePage(
  raw: unknown,
  options: { readonly pageId: string; readonly revision: number; readonly url: string; readonly title?: unknown },
): DescribeReading {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse('adapter-failed', 'A page description must be an object, and this was not one.')
  }
  const record = raw as Record<string, unknown>
  const rawElements = Array.isArray(record.elements) ? record.elements : []
  const title =
    typeof options.title === 'string' ? truncateUtf8(options.title, BROWSER_LIMITS.maxTitleChars) : ''

  const elements: PageElement[] = []
  let dropped = 0
  let ordinal = 0

  for (const candidate of rawElements.slice(0, BROWSER_LIMITS.maxSnapshotElements)) {
    if (typeof candidate !== 'object' || candidate === null) {
      dropped += 1
      continue
    }
    const entry = candidate as RawElement
    const kind = isElementKind(entry.kind) ? entry.kind : null
    if (kind === null) {
      dropped += 1
      continue
    }
    const selector = readSelector(entry.selector)
    if (!selector.ok) {
      dropped += 1
      continue
    }
    const label =
      typeof entry.label === 'string'
        ? truncateUtf8(entry.label.replace(/\s+/gu, ' ').trim(), 120)
        : ''
    const ref = mintRef({
      pageId: options.pageId,
      revision: options.revision,
      ordinal,
      kind,
      selector: selector.selector,
    })
    elements.push(
      Object.freeze({
        ref,
        ordinal,
        kind,
        label,
        selector: selector.selector,
        protected: entry.protected === true,
        disabled: entry.disabled === true,
        // Read last and independently of the locator, because an anchor can carry a usable
        // locator and no address (a `#fragment` is a locator target, not a destination) and
        // the reverse. Neither failing costs the element its description.
        href: readHref(entry.href, kind),
      }),
    )
    ordinal += 1
  }

  const rawText = typeof record.text === 'string' ? record.text : ''
  const text = truncateUtf8(rawText, BROWSER_LIMITS.maxSnapshotTextBytes)
  const truncated =
    dropped > 0 ||
    rawElements.length > BROWSER_LIMITS.maxSnapshotElements ||
    utf8Bytes(rawText) > BROWSER_LIMITS.maxSnapshotTextBytes

  const snapshot: PageSnapshot = Object.freeze({
    pageId: options.pageId,
    revision: options.revision,
    url: options.url,
    title,
    elements: Object.freeze(elements),
    textBytes: utf8Bytes(text),
    truncated,
  })
  return { ok: true, snapshot, elements, text }
}

/* --------------------------------------------------------------- the ref table */

export type ResolveReading =
  | { readonly ok: true; readonly element: PageElement }
  | { readonly ok: false; readonly code: BrowserRefusalCode; readonly reason: string }

interface RefEntry {
  readonly pageId: string
  readonly revision: number
  readonly element: PageElement
}

/**
 * The references one runtime has minted, and the revision they belong to.
 *
 * Two operations and one rule. `retire(revision)` moves every entry from before that
 * revision into a bounded **tombstone** set — called on every navigation, every reload and
 * every failed load — and `resolve` refuses anything that is not a live entry for the
 * current revision.
 *
 * ## Why retired references are remembered rather than deleted
 *
 * Because the *reason* is the useful part. A caller holding a reference from before a
 * navigation needs to be told "that belongs to revision 4 and the page is now at revision 5,
 * describe it again", not "I have never heard of that reference". The first sentence tells it
 * what to do; the second sends it round the loop.
 *
 * Both sets are bounded, and the **oldest** go. Retiring is the safe direction: a reference
 * that stops working is a nuisance, and a table that stops accepting references is a page
 * nothing can be done to.
 */
export class RefTable {
  private readonly entries = new Map<string, RefEntry>()
  /** Bounded. A retired reference is remembered only so the refusal can name its revision. */
  private readonly tombstones = new Map<string, number>()
  private revision = 0

  constructor(
    private readonly pageId: string,
    revision = 0,
  ) {
    this.revision = revision
  }

  /** The revision this table currently believes the page is at. */
  get currentRevision(): number {
    return this.revision
  }

  /**
   * Move to a new revision and retire everything before it.
   *
   * A revision that does not advance is ignored rather than applied: two observations of
   * the same page must not look like a navigation, or every reference would go stale the
   * moment somebody looked at the page twice.
   */
  retire(next: number): void {
    if (next <= this.revision) return
    this.revision = next
    for (const [ref, entry] of this.entries) {
      if (entry.revision >= next) continue
      this.entries.delete(ref)
      this.tombstones.set(ref, entry.revision)
    }
    while (this.tombstones.size > BROWSER_LIMITS.maxSnapshotElements) {
      const oldest = this.tombstones.keys().next().value
      if (oldest === undefined) break
      this.tombstones.delete(oldest)
    }
  }

  /** Mint and remember the references for one description. */
  adopt(snapshot: PageSnapshot): readonly PageElement[] {
    this.retire(snapshot.revision)
    for (const element of snapshot.elements) {
      this.entries.set(element.ref, {
        pageId: this.pageId,
        revision: snapshot.revision,
        element,
      })
    }
    while (this.entries.size > BROWSER_LIMITS.maxSnapshotElements * 2) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return snapshot.elements
  }

  /** Drop every reference. Used when a session closes or its window is destroyed. */
  clear(): void {
    this.entries.clear()
    this.tombstones.clear()
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * The element a reference names, or the refusal that says why it cannot.
   *
   * Ordered deliberately: unknown before stale before protected before disabled. "I have
   * never heard of that reference" and "that reference is from an older page" are
   * different facts and a caller that conflates them will retry with the same ref.
   */
  resolve(ref: unknown): ResolveReading {
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 64) {
      return { ok: false, code: 'ref-unknown', reason: 'An element reference must be a short, non-empty string.' }
    }
    const entry = this.entries.get(ref)
    if (entry === undefined) {
      const retired = this.tombstones.get(ref)
      if (retired !== undefined) {
        return {
          ok: false,
          code: 'page-stale',
          reason: `That reference belongs to revision ${String(retired)} and the page is now at revision ${String(this.revision)}. The page was replaced, so the old reference is not acted on. Describe the page again.`,
        }
      }
      return {
        ok: false,
        code: 'ref-unknown',
        reason: 'That reference was never minted for the page currently loaded. Describe the page again.',
      }
    }
    if (entry.revision !== this.revision) {
      return {
        ok: false,
        code: 'page-stale',
        reason: `That reference belongs to revision ${String(entry.revision)} and the page is now at revision ${String(this.revision)}. The page was replaced, so the old reference is not acted on.`,
      }
    }
    if (entry.element.protected) {
      return {
        ok: false,
        code: 'protected-field',
        reason: 'That reference is a protected field. Freya does not click, read or type into a password, card or one-time-code field in either browser.',
      }
    }
    if (entry.element.disabled) {
      return {
        ok: false,
        code: 'element-disabled',
        reason: 'That reference is a disabled element, so acting on it would report something that did not happen.',
      }
    }
    return { ok: true, element: entry.element }
  }
}

/* -------------------------------------------------------------------- audits */

/**
 * Structural audits over this module. Never used by production code.
 *
 * The claim worth auditing is the boring one: a ref must depend on the revision. If a
 * future edit makes {@link mintRef} omit it, every stale-page guarantee in the phase
 * silently evaporates while every test still passes — because a ref that is revision-free
 * *resolves*, just against the wrong page. So the audit recomputes that dependency.
 */
export function auditRefMinting(): readonly string[] {
  const findings: string[] = []
  const base = { pageId: 'page-1', ordinal: 0, kind: 'link' as const, selector: 'a[href]' }
  const r1 = mintRef({ ...base, revision: 1 })
  const r2 = mintRef({ ...base, revision: 2 })
  if (r1 === r2) findings.push('A minted reference does not depend on the page revision.')
  if (!r1.startsWith(`${REF_PREFIX}-`)) findings.push('A minted reference is not prefixed.')
  if (r1.length !== REF_PREFIX.length + 1 + 16) findings.push('A minted reference has an unexpected length.')

  const other = mintRef({ ...base, pageId: 'page-2', revision: 1 })
  if (other === r1) findings.push('A minted reference does not depend on the page id.')
  const otherSelector = mintRef({ ...base, selector: 'button', revision: 1 })
  if (otherSelector === r1) findings.push('A minted reference does not depend on the locator.')

  // Determinism: the same inputs must give the same reference across processes, or a
  // restart could not recognise a reference it minted itself.
  if (mintRef({ ...base, revision: 1 }) !== r1) findings.push('Reference minting is not deterministic.')

  return findings
}