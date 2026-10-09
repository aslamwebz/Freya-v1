import { BROWSER_SERVICE_LIMITS, type SemanticBrowserRequest, type SemanticBrowserResult, type SemanticSnapshot } from '../browser/service'
import type { ToolParameter } from './tools'
import {
  MIND_TOOL_LIMITS,
  boundText,
  sanitiseUntrustedText,
  type MindTool,
  type ToolProvenance,
  type ToolSource,
} from './tools'
import { BROWSER_PORT_NAMES } from './browser-tool'

/**
 * The Mind-side door onto the Semantic Browser Protocol.
 *
 * ## Why a second tool rather than a wider first one
 *
 * `browser_read` in `./browser-tool` is a *reader*: one address, no clicks, no keystrokes,
 * bounded by `maxPages: 2`. That bound is the reason it is safe for a model to reach for
 * unasked — a browser that can walk a site for as long as the model keeps producing links is
 * a crawler, and a crawler inside a turn is an unbounded spend wearing a tool's clothes.
 *
 * This tool is the other shape: **tabs**, chosen by the owner, driven by semantic references
 * that must be quoted with the revision they came from. Its bounds are different — a fixed
 * number of operations, tabs and acts — and they bound the *shape of the page* rather than how
 * many pages a single read may visit.
 *
 * ## What it deliberately does not have
 *
 * No selector parameter, no coordinates, and no "click whatever is third". Every act names
 * `ref` **and** `revision`, both of which can only have come from a snapshot this tool took.
 * That is what stops a model clicking a button it never saw on a page that has since changed,
 * and it is why `revision` is a required parameter rather than an optional one that defaults
 * to "now".
 *
 * ## The acts
 *
 * `click`, `type` and `select` reach the same place every other browser act reaches — through
 * the Phase 51 routed commands and therefore the Phase 35 Device Hands gates. A protected
 * field, a disabled control, a destructive-sounding control and an authentication control are
 * all refused by that layer; this tool reports the refusal and does not second-guess it.
 *
 * ## Attribution
 *
 * `createdBy` is `'freya'` for everything this tool opens. The owner asked for the tabs, but
 * Freya is the one navigating, and a tab Freya moved is a tab Freya may re-navigate. A tab a
 * person typed an address into is a different record with a different attribution, and the
 * two must not blur.
 */

/** The slice of the Browser Service this tool needs. One method, so nothing else can leak. */
export interface BrowserTabsPort {
  run(request: SemanticBrowserRequest): Promise<SemanticBrowserResult>
}

/** Ceilings for one execution. Narrowing only; a request cannot raise one. */
export const BROWSER_TABS_LIMITS = Object.freeze({
  /** Protocol operations one execution may issue. */
  maxCommands: 24,
  /** Tabs one execution may open. Ten is the acceptance number, and the ceiling allows it. */
  maxTabs: 12,
  /** Clicks, keystrokes and selections one execution may issue. */
  maxActs: 8,
  /** Characters of a snapshot the model may read. */
  maxSnapshotChars: BROWSER_SERVICE_LIMITS.maxRenderedSnapshotChars,
  /** Addresses accepted in one "open these" list, before the tab ceiling is applied. */
  maxRequestedUrls: 24,
})

/** The operations this tool can ask for, in its own names. Closed. */
const OPERATIONS = ['tabs', 'open', 'close', 'activate', 'navigate', 'snapshot', 'screenshot', 'click', 'type', 'select', 'scroll', 'back', 'forward', 'reload', 'wait'] as const
type Operation = (typeof OPERATIONS)[number]

function isOperation(value: unknown): value is Operation {
  return typeof value === 'string' && (OPERATIONS as readonly string[]).includes(value)
}

/** The three operations that change a page, and therefore the ones with an act ceiling. */
const ACT_OPERATIONS = new Set<string>(['click', 'type', 'select'])

export interface BrowserTabsToolOptions {
  readonly browser: BrowserTabsPort
  readonly now?: () => Date
  /** Narrowing only, exactly as the reader tool treats `maxCommands`. */
  readonly maxCommands?: number
  readonly maxTabs?: number
}

const PARAMETERS: readonly ToolParameter[] = Object.freeze([
  { name: 'op', description: 'tabs — list every open tab. open — open an address in a new tab (or give "urls", one tab each). close — close a tab. activate — bring a tab to the front. navigate — point a tab at an address. snapshot — read the front tab as numbered elements plus the revision they belong to. screenshot — capture the front tab as an image, for a page the element list cannot describe. click, type, select — act on an element. scroll — top, bottom or a number of pixels. back, forward, reload, wait — page motion.', required: true },
  { name: 'url', description: 'for open and navigate: the address, http or https only' },
  {
    name: 'urls',
    description: 'for opening several pages at once: the addresses, one per line or separated by commas, one tab each',
    // A list, not a word: it keeps its newlines so the separator survives, and it
    // carries the whole-request ceiling so ten real addresses are not cut down to
    // the first two by the single-argument default.
    maxChars: BROWSER_TABS_LIMITS.maxRequestedUrls * 200,
    multiline: true,
  },
  { name: 'tab', description: 'for a request about one tab: which tab id. Omit to mean the tab in front.' },
  { name: 'ref', description: 'for click, type and select: the element number from a snapshot, such as r3' },
  { name: 'revision', description: 'for click, type and select: the revision the snapshot reported, as a number. Both ref and revision are required.' },
  { name: 'text', description: 'for type: what to type' },
  { name: 'index', description: 'for select: the option number from the snapshot, counting from zero' },
  { name: 'to', description: 'for scroll: top, bottom, or a number of pixels' },
  { name: 'until', description: 'for wait: text to wait for in the address' },
])

export function createBrowserTabsTool(options: BrowserTabsToolOptions): MindTool {
  // `Math.min`, so a caller narrows and a request cannot widen. The same arithmetic and the
  // same reason as every other ceiling in this package.
  const maxCommands = Math.max(2, Math.min(options.maxCommands ?? BROWSER_TABS_LIMITS.maxCommands, BROWSER_TABS_LIMITS.maxCommands))
  const maxTabs = Math.max(1, Math.min(options.maxTabs ?? BROWSER_TABS_LIMITS.maxTabs, BROWSER_TABS_LIMITS.maxTabs))

  return {
    name: 'browser_tabs',
    description:
      "Drive Freya's embedded browser as a set of tabs. Open addresses in separate tabs, switch between them, " +
      'read a page as a list of numbered elements, and act on one by quoting its number together with the revision ' +
      'it came from. Take a screenshot when the element list cannot answer the question, and the owner needs to see ' +
      'the page itself. Use this when the owner asks for several pages at once, or to click something you just read. ' +
      'Every act must quote both a reference and a revision; a page that changed since you read it refuses the act ' +
      'rather than guessing. It cannot log in, solve a captcha, buy anything or upload a file.',
    capability: 'browser.read',
    parameters: PARAMETERS,

    async run(request) {
      const args = request.arguments
      const issued: string[] = []
      const opened: string[] = []
      const lines: string[] = []
      let commands = 0
      let acts = 0

      /**
       * One protocol call, with the three bounds this tool holds itself to.
       *
       * The bounds are checked *before* the call rather than after it, so a request that would
       * exceed one is refused without the call happening at all. A ceiling that is enforced
       * after the fact is a ceiling that has already been passed.
       */
      const send = async (command: SemanticBrowserRequest): Promise<SemanticBrowserResult> => {
        if (commands >= maxCommands) {
          return localRefusal(`That is more than ${String(maxCommands)} browser operations in one step. Do them in separate steps.`)
        }
        if (ACT_OPERATIONS.has(command.op) && acts >= BROWSER_TABS_LIMITS.maxActs) {
          return localRefusal(`That is more than ${String(BROWSER_TABS_LIMITS.maxActs)} actions on a page in one step.`)
        }
        if (command.op === 'open' && opened.length >= maxTabs) {
          return localRefusal(`That is more than ${String(maxTabs)} tabs in one step.`)
        }
        commands += 1
        if (ACT_OPERATIONS.has(command.op)) acts += 1
        const result = await options.browser.run(command)
        if (result.ok) {
          issued.push(command.op)
          if (command.op === 'open') opened.push(String(result.data.tabId))
        }
        return result
      }

      /* ------------------------------------------- several addresses at once */

      const rawList = (args['urls'] ?? '').trim()
      if (rawList !== '') {
        // Split on newlines first and commas second: a model asked for ten URLs writes ten
        // lines, and a comma inside a query string must not be mistaken for a separator.
        const addresses = rawList
          .split(/[\r\n]+/)
          // A comma is a separator only in a line with no query string. `?a=1,2` is one
          // address; `https://a.com, https://b.com` is two. Splitting a query turns one real
          // address into two broken ones, and a browser that silently truncated a URL is worse
          // than a list that needed a second line.
          .flatMap((line) => (line.includes(',') && !line.includes('?') ? line.split(',') : [line]))
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(0, BROWSER_TABS_LIMITS.maxRequestedUrls)
        if (addresses.length === 0) throw new Error('the list of addresses was empty or contained nothing usable')

        let refusedCount = 0
        for (const [index, address] of addresses.entries()) {
          if (!/^https?:\/\//iu.test(address)) {
            lines.push(`refused ${address.slice(0, 60)}: not an http or https address`)
            refusedCount += 1
            continue
          }
          if (commands >= maxCommands || opened.length >= maxTabs) {
            lines.push(`stopped at ${String(opened.length)} tab(s); ${String(addresses.length - index)} address(es) were not opened`)
            break
          }
          const result = await send({
            op: 'open',
            url: address,
            origin: { kind: 'link', from: 'chat', ownerText: 'browser_tabs' },
            createdBy: 'freya',
            activate: opened.length === 0,
          })
          if (!result.ok) {
            lines.push(`refused ${address.slice(0, 60)}: ${result.code}`)
            refusedCount += 1
          }
        }
        const summary = [
          `Opened ${String(opened.length)} tab(s)${refusedCount > 0 ? `, refused ${String(refusedCount)}` : ''}.`,
          opened.length === 0 ? '' : `tab ids: ${opened.join(', ')}`,
          ...lines,
        ].filter((line) => line !== '').join('\n')
        return { summary, sources: [], provenance: provenance(issued) }
      }

      /* --------------------------------------------------------- one operation */

      const op = args['op']
      if (!isOperation(op)) throw new Error(`"op" must be one of: ${OPERATIONS.join(', ')}`)
      const tab = (args['tab'] ?? '').trim() === '' ? null : args['tab']!.trim()

      switch (op) {
        case 'tabs': {
          const result = await send({ op: 'tabs' })
          if (!result.ok) return refusal(result, issued)
          const rows = result.data.tabs as { tabId: string; url: string | null; status: string; title: string | null; active: boolean; createdBy: string }[]
          const summary = [
            `${String(rows.length)} tab(s) open; ${String(result.data.activeTabId ?? 'none')} is in front.`,
            ...rows.map((row) => `  ${row.tabId}  ${row.status.padEnd(10)} ${row.createdBy.padEnd(5)}  ${row.title ?? row.url ?? '(no address)'}`),
          ].join('\n')
          return { summary, sources: [], provenance: provenance(issued) }
        }

        case 'open': {
          const url = (args['url'] ?? '').trim()
          if (!/^https?:\/\//iu.test(url)) {
            throw new Error('opening a tab needs an http or https address, and nothing that names a file, a script or the machine')
          }
          const result = await send({ op: 'open', url, origin: { kind: 'link', from: 'chat', ownerText: 'browser_tabs' }, createdBy: 'freya' })
          if (!result.ok) return refusal(result, issued)
          return { summary: `Opened ${String(result.data.tabId)} on ${String(result.data.url ?? url)}.`, sources: [], provenance: provenance(issued) }
        }

        case 'close': {
          const result = await send({ op: 'close', tabId: tab })
          if (!result.ok) return refusal(result, issued)
          return { summary: `Closed ${String(result.data.tabId)}; ${String(result.data.activeTabId ?? 'no tab')} is now in front.`, sources: [], provenance: provenance(issued) }
        }

        case 'activate': {
          if (tab === null) throw new Error('switching tabs needs "tab"')
          const result = await send({ op: 'activate', tabId: tab })
          if (!result.ok) return refusal(result, issued)
          return { summary: `${String(result.data.tabId)} is in front.`, sources: [], provenance: provenance(issued) }
        }

        case 'navigate': {
          const url = (args['url'] ?? '').trim()
          if (!/^https?:\/\//iu.test(url)) throw new Error('navigating needs an http or https address')
          const result = await send({ op: 'navigate', tabId: tab, url })
          if (!result.ok) return refusal(result, issued)
          return { summary: `${String(result.data.tabId)} is on ${String(result.data.url ?? url)}.`, sources: [], provenance: provenance(issued) }
        }

        case 'snapshot': {
          const result = await send({ op: 'snapshot', tabId: tab })
          if (!result.ok) return refusal(result, issued)
          const snapshot = result.data.snapshot as SemanticSnapshot
          // The revision goes back with the elements, because an element number on its own is
          // meaningless: it says "the third thing", which is a different thing on every load.
          const quoted = snapshot.elements.length > 0
            ? `\nTo act on one of these, quote its number and this revision together: click {"ref":"r1","revision":${String(snapshot.revision)}}`
            : ''
          const summary = `${snapshot.rendered.slice(0, BROWSER_TABS_LIMITS.maxSnapshotChars)}${quoted}`
          return { summary, sources: toSources(snapshot), provenance: provenance(issued) }
        }

        case 'screenshot': {
          const result = await send({ op: 'screenshot', tabId: tab })
          if (!result.ok) return refusal(result, issued)
          const d = result.data
          // The summary is what the model reads. It carries the facts a snapshot cannot:
          // that there *are* pixels, how big they are, and which instant they belong to.
          // The URL is the owner's path to the same bytes, drawn by the chat surface.
          const summary = [
            `Screenshot of ${String(d.url ?? 'the tab')} — ${String(d.width ?? '?')}x${String(d.height ?? '?')} pixels, ` +
              `${String(d.bytes ?? 0)} bytes, taken at revision ${String(d.revision ?? '?')}.`,
            `Image: ${String(d.mediaUrl ?? '(none)')}`,
            'The image is for the owner to look at. Describe what you asked about only if the element list above already told you, otherwise say what the page claims in text.',
          ].join('\n')
          return { summary, sources: [], provenance: provenance(issued) }
        }

        case 'click':
        case 'type':
        case 'select': {
          const ref = (args['ref'] ?? '').trim()
          if (ref === '') throw new Error(`${op} needs "ref": the element number from a snapshot, such as r1`)
          const rawRevision = (args['revision'] ?? '').trim()
          const revision = Number(rawRevision)
          if (rawRevision === '' || !Number.isInteger(revision) || revision < 1) {
            throw new Error(
              `${op} needs "revision": the revision the snapshot reported, as a whole number. A snapshot is a cache of ` +
                'one instant, and acting on one without saying which instant is how the wrong button gets pressed.',
            )
          }
          // The revision is **forwarded**, not checked here. This tool has no memory between
          // calls — it is constructed per turn and holds no instance state, which is the right
          // shape for a Mind tool and also means it could not know which snapshot the caller
          // was looking at anyway. The service is where a mismatch is caught, because the
          // service is the only thing that knows the revision each tab is at now, and it
          // refuses with `stale-reference` rather than acting. What this layer owes the caller
          // is that the number cannot be left out, which is why `revision` is required.
          if (op === 'click') {
            const result = await send({ op: 'click', tabId: tab, ref, revision })
            if (!result.ok) return refusal(result, issued)
            return { summary: `Clicked "${String(result.data.name ?? ref)}".`, sources: [], provenance: provenance(issued) }
          }
          if (op === 'select') {
            const rawIndex = (args['index'] ?? '').trim()
            const index = Number(rawIndex)
            // The empty string is refused rather than coerced. `Number('')` is zero, and
            // quietly choosing the first option of a select is not what anybody meant.
            if (rawIndex === '' || !Number.isInteger(index) || index < 0) throw new Error('select needs "index": the option number from the snapshot, counting from zero')
            const result = await send({ op: 'select', tabId: tab, ref, revision, index })
            if (!result.ok) return refusal(result, issued)
            return { summary: `Chose "${String(result.data.selected ?? '')}" in "${String(result.data.name ?? ref)}".`, sources: [], provenance: provenance(issued) }
          }
          const text = args['text'] ?? ''
          if (text === '') throw new Error('type needs "text"')
          const result = await send({ op: 'type', tabId: tab, ref, revision, text })
          if (!result.ok) return refusal(result, issued)
          return { summary: `Typed into "${String(result.data.name ?? ref)}".`, sources: [], provenance: provenance(issued) }
        }

        case 'scroll': {
          const to = (args['to'] ?? '').trim()
          const target: 'top' | 'bottom' | number = to === 'top' || to === 'bottom' ? to : Number.isFinite(Number(to)) && to !== '' ? Number(to) : 'bottom'
          const result = await send({ op: 'scroll', tabId: tab, to: target })
          if (!result.ok) return refusal(result, issued)
          return { summary: `Scrolled; the page is now at ${String(result.data.top)}.`, sources: [], provenance: provenance(issued) }
        }

        case 'back':
        case 'forward':
        case 'reload': {
          const result = await send({ op, tabId: tab })
          if (!result.ok) return refusal(result, issued)
          return { summary: `${op}: ${String(result.data.url ?? 'the tab is where it was')}.`, sources: [], provenance: provenance(issued) }
        }

        case 'wait': {
          const until = (args['until'] ?? '').trim()
          const result = await send({ op: 'wait', tabId: tab, settleMs: 2_000, ...(until === '' ? {} : { until }) })
          if (!result.ok) return refusal(result, issued)
          return { summary: `Settled on ${String(result.data.url ?? 'the page')}.`, sources: [], provenance: provenance(issued) }
        }

        /* istanbul ignore next -- the operation list is closed and handled above. */
        default:
          return { summary: 'That browser operation is not one this build performs.', sources: [] }
      }
    },
  }
}

/* ------------------------------------------------------------------ helpers */

function localRefusal(reason: string): SemanticBrowserResult {
  return { ok: false, op: 'tabs', code: 'request-malformed', reason, data: {} }
}

/** One bounded sentence from a refusal. The code is kept: it is the part that says what to do. */
function refusal(result: Extract<SemanticBrowserResult, { ok: false }>, issued: readonly string[]): { summary: string; sources: ToolSource[]; provenance: ToolProvenance } {
  return {
    summary: `${result.code}: ${sanitiseUntrustedText(result.reason.replace(/\s+/gu, ' '), 200)}`,
    sources: [],
    provenance: provenance(issued),
  }
}

function provenance(issued: readonly string[]): ToolProvenance {
  return {
    actor: BROWSER_PORT_NAMES.public,
    steps: [...issued].map((op) => `browser_tabs:${op} — performed — served by ${BROWSER_PORT_NAMES.public}`),
  }
}

function toSources(snapshot: SemanticSnapshot): ToolSource[] {
  const source = toSource(snapshot.url, snapshot.title ?? '', snapshot.text.slice(0, 200))
  return source === null ? [] : [source]
}

/**
 * A page as a citable source.
 *
 * Every field is run through the same untrusted-text sanitiser the reader tool uses, because
 * a page title and a page's own words are attacker-controlled text arriving in a tool result.
 */
function toSource(url: string, title: string, snippet: string): ToolSource | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return {
    title: sanitiseUntrustedText(title === '' ? url : title, MIND_TOOL_LIMITS.maxTitleChars),
    url: boundText(parsed.toString(), MIND_TOOL_LIMITS.maxTitleChars * 2),
    sourceDomain: sanitiseUntrustedText(parsed.hostname.toLowerCase(), MIND_TOOL_LIMITS.maxTitleChars),
    snippet: sanitiseUntrustedText(snippet, MIND_TOOL_LIMITS.maxSnippetChars),
    rank: 1,
    retrievedAt: new Date().toISOString(),
  }
}

/**
 * Structural audit over the tool.
 *
 * The claim worth auditing is that the tool cannot aim the browser. A `selector` or a
 * `coordinates` parameter would reintroduce exactly the failure the reference discipline
 * exists to prevent, and it would do so in the one place a model reads the parameter names.
 */
export function auditBrowserTabsTool(): readonly string[] {
  const names = PARAMETERS.map((parameter) => parameter.name)
  const findings: string[] = []
  for (const banned of ['selector', 'coordinates', 'js', 'eval', 'execute', 'cookie', 'password', 'token']) {
    if (names.includes(banned)) findings.push(`the browser tool exposes a "${banned}" parameter.`)
  }
  for (const required of ['op', 'ref', 'revision']) {
    if (!names.includes(required)) findings.push(`the browser tool is missing the "${required}" parameter.`)
  }
  if (BROWSER_TABS_LIMITS.maxTabs < 10) findings.push('the tab ceiling is below the ten-tab acceptance number.')
  if (BROWSER_TABS_LIMITS.maxActs > BROWSER_TABS_LIMITS.maxCommands) findings.push('the act ceiling exceeds the command ceiling.')
  if (OPERATIONS.length !== 15) findings.push('the operation vocabulary is not the fifteen operations this build performs.')
  return findings
}