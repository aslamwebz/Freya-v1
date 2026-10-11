import { BROWSER_SERVICE_LIMITS, type SemanticElement, type SemanticElementKind, type SemanticSnapshot, type SemanticSurface } from './types'
import { boundText } from './surface'

/**
 * Semantic references, and the revision they belong to.
 *
 * ## The problem
 *
 * An agent reads a page, decides to click something, and by the time the click lands the page
 * has been replaced. Acting on the memory of a page is how an agent clicks the wrong button
 * on a page that *looks* the same — a different product, a different account, a different
 * invoice. Screen coordinates have the same failure with less ceremony: a window moved and
 * the coordinates now name something else.
 *
 * ## The rule
 *
 * A reference names exactly one `(tab, revision)` pair. Every navigation, reload and failed
 * load moves the revision, which retires every reference from before it. A caller that acts
 * on a reference from an older revision is refused `stale-reference` and told to take a new
 * snapshot — never quietly redirected at whatever now occupies that position.
 *
 * The revision is named by the caller, not merely tracked by us. That is deliberate: a
 * protocol that could infer the revision would let a caller act on a page it had not read.
 * Forcing the number through the request turns "I read this" into something checkable.
 *
 * ## What a reference is *not*
 *
 * It is not a selector and it is not an index. It never crosses the IPC boundary, never
 * reaches a model, and never appears in the journal. A caller holds an opaque `r7` and this
 * module is the only thing that knows what `r7` meant thirty seconds ago.
 */

/** The handle a resolved reference becomes. Opaque by construction: no selector inside. */
export interface SemanticHandle {
  readonly ref: string
  readonly kind: SemanticElementKind
  readonly name: string
  readonly selector: string
  readonly options: readonly string[]
}

export type RefReading =
  | { readonly ok: true; readonly handle: SemanticHandle }
  | { readonly ok: false; readonly code: 'stale-reference' | 'ref-unknown' | 'revision-required' | 'protected-field' | 'element-disabled'; readonly reason: string; readonly currentRevision: number }

/** One minted reference. Immutable, so a caller cannot retarget one after the fact. */
interface MintedRef {
  readonly revision: number
  readonly handle: SemanticHandle
  /** Carried on the entry rather than read back off the handle, so a handle stays opaque. */
  readonly protected: boolean
  readonly disabled: boolean
}

/** A retired reference, remembered only so the refusal can name the revision it came from. */
interface Tombstone {
  readonly revision: number
}

const REF_PATTERN = /^r[1-9][0-9]{0,5}$/

/** Is this the shape of a reference this protocol hands out? Cheap, and it stops guessing. */
export function isSemanticRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= BROWSER_SERVICE_LIMITS.maxRefChars && REF_PATTERN.test(value)
}

/**
 * The references for one tab.
 *
 * Bounded in three places, all of them necessary: the live set (a page has a ceiling on
 * elements), the tombstone set (so a stale refusal can be specific), and the number of
 * revisions remembered (so a caller two navigations behind still gets "stale-reference" rather
 * than "never heard of it").
 */
export class SemanticRefTable {
  private readonly live = new Map<string, MintedRef>()
  private readonly tombstones = new Map<string, Tombstone>()
  private revision = 0

  constructor(readonly tabId: string, revision = 0) {
    this.revision = revision
  }

  get currentRevision(): number {
    return this.revision
  }

  get size(): number {
    return this.live.size
  }

  /**
   * Move to a new revision and retire everything from before it.
   *
   * A revision that does not advance is ignored. Two observations of the same page must not
   * look like a navigation, or every reference would go stale the moment somebody looked at
   * the page twice.
   */
  retire(next: number): void {
    if (!Number.isFinite(next) || next <= this.revision) return
    this.revision = next
    for (const [ref, minted] of this.live) {
      if (minted.revision >= next) continue
      this.live.delete(ref)
      this.tombstones.set(ref, { revision: minted.revision })
    }
    while (this.tombstones.size > BROWSER_SERVICE_LIMITS.maxSnapshotElements) {
      const oldest = this.tombstones.keys().next().value
      if (oldest === undefined) break
      this.tombstones.delete(oldest)
    }
  }

  /**
   * Mint the references for one snapshot.
   *
   * Numbering restarts at `r1` on every revision, and that is not a weakness: the number is
   * meaningless without its revision, and the revision has to be named alongside it. What
   * makes a stale reference *fail* is the revision check in {@link resolve}, not the fact
   * that `r3` used to mean something else.
   */
  mint(elements: readonly SemanticSurface[]): readonly SemanticElement[] {
    this.live.clear()
    const minted: SemanticElement[] = []
    const bounded = elements.slice(0, BROWSER_SERVICE_LIMITS.maxSnapshotElements)
    for (let index = 0; index < bounded.length; index += 1) {
      const element = bounded[index]!
      const ref = `r${String(index + 1)}`
      this.live.set(ref, {
        revision: this.revision,
        protected: element.protected,
        disabled: element.disabled,
        handle: Object.freeze({
          ref,
          kind: element.kind,
          name: element.name,
          selector: element.selector,
          options: Object.freeze([...(element.options ?? [])]),
        }),
      })
      minted.push(
        Object.freeze({
          ref,
          kind: element.kind,
          name: boundText(element.name, BROWSER_SERVICE_LIMITS.maxSnapshotLineChars),
          disabled: element.disabled,
          protected: element.protected,
          destructive: element.destructive,
          ...(element.options === undefined || element.options.length === 0
            ? {}
            : { options: Object.freeze(element.options.slice(0, 64).map((option) => boundText(option, 80))) }),
        }),
      )
    }
    return Object.freeze(minted)
  }

  /** Forget everything. Called when the tab closes, so no reference outlives its document. */
  clear(): void {
    this.live.clear()
    this.tombstones.clear()
  }

  /**
   * Resolve a reference against a revision the caller says it decided from.
   *
   * The order is the argument. A missing `claimedRevision` is refused first because it is a
   * malformed request rather than a stale one. Then a revision that does not match the
   * current one, then a reference that was never minted, and only then the element's own
   * problems — protected and disabled are facts about an element that *is* there, and
   * reporting them for a reference from another page would be a different lie.
   */
  resolve(ref: unknown, claimedRevision: unknown): RefReading {
    if (typeof claimedRevision !== 'number' || !Number.isFinite(claimedRevision)) {
      return {
        ok: false,
        code: 'revision-required',
        reason: `That action must name the revision it was decided from. The page is at revision ${String(this.revision)}; take a snapshot and use its revision.`,
        currentRevision: this.revision,
      }
    }
    if (!isSemanticRef(ref)) {
      return {
        ok: false,
        code: 'ref-unknown',
        reason: 'An element reference looks like r1, r2, r3 and comes from a snapshot of this tab.',
        currentRevision: this.revision,
      }
    }
    if (claimedRevision !== this.revision) {
      const minted = this.live.get(ref)
      const tombstone = this.tombstones.get(ref)
      const from = minted?.revision ?? tombstone?.revision ?? null
      return {
        ok: false,
        code: 'stale-reference',
        reason:
          from === null
            ? `That action was decided from revision ${String(claimedRevision)} and the page is now at revision ${String(this.revision)}. Nothing was acted on. Take a new snapshot and try again.`
            : `Reference ${ref} belongs to revision ${String(from)} and the page is now at revision ${String(this.revision)}, so it was not acted on. Take a new snapshot and try again.`,
        currentRevision: this.revision,
      }
    }
    const entry = this.live.get(ref)
    if (entry === undefined) {
      return {
        ok: false,
        code: 'ref-unknown',
        reason: `Reference ${ref} was never handed out for revision ${String(this.revision)}. Take a new snapshot and use a reference from it.`,
        currentRevision: this.revision,
      }
    }
    // Protected before disabled, and both after the revision checks: these are facts about an
    // element that *is* there, and reporting them for a reference from another page would be
    // a different lie.
    if (entry.protected) {
      return {
        ok: false,
        code: 'protected-field',
        reason: 'That reference is a protected field. Freya does not read, click or type into a password, card or one-time-code field in either browser.',
        currentRevision: this.revision,
      }
    }
    if (entry.disabled) {
      return {
        ok: false,
        code: 'element-disabled',
        reason: 'That element is disabled, so acting on it would report something that did not happen.',
        currentRevision: this.revision,
      }
    }
    return { ok: true, handle: entry.handle }
  }

  /** The element behind a live reference, for a caller that only wants to describe it. */
  peek(ref: string): MintedRef | null {
    return this.live.get(ref) ?? null
  }
}

/* --------------------------------------------------------------- rendering */

/**
 * Render a snapshot in the form a caller reads.
 *
 * Refs first and elements in document order, so the interesting part of a page is above the
 * prose rather than below it, and every line is bounded. `truncated` is stated rather than
 * implied, because a caller handed a fragment with no marker will describe it as the whole
 * page, and confidently.
 */
export function renderSemanticSnapshot(input: {
  readonly tabId: string
  readonly url: string
  readonly title: string | null
  readonly revision: number
  readonly text: string
  readonly truncated: boolean
  readonly elements: readonly SemanticElement[]
  readonly superseded: boolean
}): SemanticSnapshot {
  const lines: string[] = []
  lines.push(`tab: ${input.tabId}`)
  lines.push(`url: ${input.url}`)
  if (input.title !== null && input.title !== '') lines.push(`title: ${input.title}`)
  lines.push(`revision: ${String(input.revision)}`)
  if (input.superseded) lines.push('note: this page has moved on since this snapshot; take another before acting')
  if (input.elements.length > 0) {
    lines.push('')
    for (const element of input.elements) {
      const flags = [
        element.protected ? 'protected' : null,
        element.disabled ? 'disabled' : null,
        element.destructive ? 'destructive' : null,
      ].filter((flag) => flag !== null)
      const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : ''
      lines.push(`[${element.ref}] ${element.kind} "${element.name}"${suffix}`)
    }
  }
  const prose = boundText(input.text, BROWSER_SERVICE_LIMITS.maxSnapshotTextChars)
  if (prose !== '') {
    lines.push('')
    lines.push('text:')
    lines.push(input.truncated ? `${prose}…` : prose)
  }
  if (input.truncated) lines.push('note: the page text was cut; the element list above is complete')

  let rendered = lines.join('\n')
  if (rendered.length > BROWSER_SERVICE_LIMITS.maxRenderedSnapshotChars) {
    rendered = `${rendered.slice(0, BROWSER_SERVICE_LIMITS.maxRenderedSnapshotChars)}…`
    // The element list is the part a model can act on, so being cut here is a
    // different failure from the prose being cut and has to say so. The old note
    // claimed the element list was complete even when this truncation had just
    // removed most of it, which is how a scrolled-to-bottom snapshot could report
    // that a footer link did not exist when it had simply never been shown.
    rendered +=
      '\nnote: this snapshot was cut short and some elements are missing from the list above. ' +
      'If what you need is not listed, take another snapshot after scrolling further, or use ' +
      'screenshot to see the page directly. Do not conclude the element is absent from the page.'
  }

  return Object.freeze({
    tabId: input.tabId,
    url: input.url,
    title: input.title,
    revision: input.revision,
    text: prose,
    truncated: input.truncated,
    elements: input.elements,
    rendered,
    superseded: input.superseded,
  })
}

/** An empty snapshot, for a tab whose page has not loaded. Never a blank success. */
export function emptySemanticSnapshot(input: {
  readonly tabId: string
  readonly url: string | null
  readonly revision: number
  readonly reason: string
}): SemanticSnapshot {
  return Object.freeze({
    tabId: input.tabId,
    url: input.url ?? '',
    title: null,
    revision: input.revision,
    text: '',
    truncated: false,
    elements: Object.freeze([]) as readonly SemanticElement[],
    rendered: [`tab: ${input.tabId}`, `revision: ${String(input.revision)}`, `note: ${input.reason}`].join('\n'),
    superseded: false,
  })
}