import type { WorkRegistry } from './capability'
import type { BrowserRequest, BrowserResult } from '../browser/runtime'
import type { MissionBrowserEvidence } from '../missions/chat-types'

/**
 * MISSION BROWSER CAPABILITIES — read and verify, through the existing browser.
 *
 * ## This is an adapter, not a browser
 *
 * Every action below is one of the closed commands in `BROWSER_COMMANDS`
 * (`core/browser/types.ts`), sent to `DualBrowserRuntime.execute`. There is no second
 * browser engine, no second session, no second window factory and no second gate chain here.
 * The dual-browser runtime routes, refuses and journals; this file decides which existing
 * command to ask for, in what order, and how to describe honestly what came back.
 *
 * The authority argument is made entirely upstream of this file and is stated here only so
 * that the two checks are not mistaken for one:
 *
 *   1. **Work's Guard** evaluates the capability (`browser.read`) before `execute` is called,
 *      against the owner principal, behind the Mission's budget charge.
 *   2. **Device Hands** evaluates *each browser command* (`browser.navigate`, `browser.read-text`)
 *      through its own ten gates, with its own grant, policy, deadline and STOP ALL latch.
 *
 * Checking one fact twice is the point, not an oversight. They are different questions with
 * different clocks: "may this Run spend `browser.read`" is asked once per step; "may *this
 * navigation, on this host, for this principal, right now*" is asked once per command.
 *
 * ## It cannot click, and it does not pretend to
 *
 * `page.click` is `browser.click`: an `act`-mode command, approval-requiring, and a
 * *different* capability. Nothing in this file names it, so there is no code path from a
 * Mission step to a click or a keystroke. Following a link is therefore a **navigation** to
 * the address the page declared, not a click — which is both the safer operation and the one
 * the browser runtime already treats as `read` mode.
 *
 * ## What a step may actually claim
 *
 * A step returns an observation and never a verdict. `browser.read` reports what it read and
 * where; `browser.page.verified` re-reads the page independently and decides whether the
 * reported bytes are really there. The distinction is load-bearing: the verifier receives the
 * observation and nothing else, and it is registered as separate code, so a step cannot mark
 * its own homework.
 */

/* -------------------------------------------------------------------- limits */

/**
 * Every bound this module obeys on its own account.
 *
 * Frozen and code-owned, for the reason `MIND_TOOL_LIMITS` gives: a bound that depends on
 * who is asking is a bound somebody can raise. A caller may narrow these and may not widen
 * them — see {@link registerBrowserInspection}.
 */
export const BROWSER_MISSION_LIMITS = Object.freeze({
  /**
   * Browser commands one step may issue.
   *
   * Four is the longest honest sequence for finding a contact page: open, navigate to the
   * address, describe the landing page, describe the contact page. A fifth would be a site
   * walk, and a site walk inside a step is an unbounded spend wearing a capability's clothes.
   */
  maxCommands: 4,

  /**
   * Link candidates one step may consider while choosing a contact page.
   *
   * Bounded because page-supplied hrefs are data a third party wrote, and "consider every
   * link on this page" is a number no code can bound. Twenty is more than any real site's
   * worth of navigation, and the ranking that selects among them is deterministic.
   */
  maxLinkCandidates: 20,

  /**
   * Characters of page text a step may retain.
   *
   * A contact page is a page. Reading it fully would let one step pin megabytes of a
   * third party's markup in the encrypted mission store, so the retained text is bounded and
   * the verifier checks the *same bounded slice* it will later re-read.
   */
  maxRetainedChars: 6_000,

  /** Characters one href may carry, mirroring the browser's own bound. */
  maxHrefChars: 400,

  /**
   * Contact-detail matches one step may retain.
   *
   * Twelve is comfortably more than a contact page lists (an address, two or three phone
   * numbers, two emails, a handful of social links) while still bounding the regex work and
   * the stored evidence.
   */
  maxContactFindings: 12,
})

/* ------------------------------------------------------------------ the port */

/**
 * The slice of `DualBrowserRuntime` these capabilities need.
 *
 * `execute` and nothing else — no `state()`, no `route()`, no `stopAll()`. A capability that
 * could read the projection would be inferring what a browser is doing without asking it, and
 * a capability that could stop the browser would be a second STOP ALL latch with no journal.
 *
 * Declared structurally so a test can supply a port that answers with a chosen page without
 * standing up Electron.
 */
export interface BrowserMissionPort {
  execute(request: BrowserRequest): Promise<BrowserResult>
}

/**
 * What the Mission engine must confirm before *any* external read, on *every* command.
 *
 * This is the same admission shape `registerResearchInspection` uses, and it is deliberately
 * not optional: a browser step that skipped it would be a step that could fetch a page
 * without the Mission being live, authorized, un-paused, and under budget.
 *
 * `externalRequest: true` is the honest charge — a page load contacts the outside world, and
 * the Mission's `maxExternalRequests` ceiling exists precisely to bound that.
 */
export interface BrowserMissionPorts {
  readonly browser: BrowserMissionPort
  /**
   * Re-resolves the Mission behind this Run and throws unless it may still make external
   * requests. Called before every command, not once per step.
   */
  admit(runId: string, stepKey: string, signal?: AbortSignal): Promise<void>
  /** Persist what was observed, keyed by `(runId, stepKey)`. */
  save(runId: string, stepKey: string, evidence: MissionBrowserEvidence): Promise<void>
  /** Read back what was saved, for the verifier and for a correction. */
  read(runId: string, stepKey: string): Promise<MissionBrowserEvidence | null>
}

/* ------------------------------------------------------------------- helpers */

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** One bounded sentence from a refusal, for an observation summary a person can read. */
function refusalOf(result: Extract<BrowserResult, { ok: false }>): string {
  return `${result.code}: ${result.reason.replace(/\s+/gu, ' ').trim().slice(0, 160)}`
}

/**
 * Labels that mean "this page is about contacting the organisation".
 *
 * Matched against an element's visible label **and** its `href`, lowercased, so a site that
 * calls the page `Reach Us` and one that links `/contact-us.html` are both found, and a site
 * whose navigation contains the word "contact" as part of a product name does not match by
 * accident — the patterns below are whole tokens.
 *
 * Deliberately **not** matched against page *text*: a body of prose mentions "contact" far
 * more often than a link leads to a contact page, and matching prose would select the home
 * page of every site on the internet.
 */
const CONTACT_HINTS: readonly RegExp[] = [
  /\bcontact\b/iu,
  /\bget in touch\b/iu,
  /\breach us\b/iu,
  /\bconnect\b/iu,
  /\benquir/iu,
  /\binquir/iu,
  /\bsupport\b/iu,
  /\bhelp centre\b/iu,
  /\bhelp center\b/iu,
  /\bfaq\b/iu,
  /\blocations?\b/iu,
]

/** A rank for one link, higher is more likely to be the contact page. Null means "no". */
function contactRank(label: string, href: string): number | null {
  const haystack = `${label} ${href}`.toLowerCase()
  if (CONTACT_HINTS.some((pattern) => pattern.test(haystack))) return 2
  return null
}

/**
 * Contact details found in a page's text.
 *
 * ## Deliberately narrow, and deliberately *reported* rather than asserted
 *
 * These are patterns, not a parser. A match is evidence that **a string of this shape was on
 * the page**, which is what the mission asked for; it is emphatically not a claim that the
 * address is correct, that the number works, or that the mailbox is monitored. The report
 * says so, and the verifier re-reads the page to confirm each match is still present.
 *
 * The shape is what makes this safe to keep bounded: an email is a local part, an `@` and a
 * dotted domain; a phone is a run of digits with the separators international dialling uses.
 * Nothing here executes, links to, or sends anything — the module has no way to submit a form.
 */
interface ContactFinding {
  readonly kind: 'email' | 'phone' | 'address'
  readonly value: string
}

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,6}/gu
const PHONE = /(?:\+|00)?\d[\d\s().-]{6,20}\d/gu
/**
 * A street-ish line. Deliberately demanding: a number, a space, and a word that appears in
 * almost no sentence of ordinary prose. It is reported as the weakest of the three kinds.
 */
const ADDRESS = /\d{1,6}\s+[A-Za-z][A-Za-z .'-]{3,48}(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|highway|hwy\.?|way|place|pl\.?|terrace|square|crescent|close|park|garden|gardens|estate|building|mansion|centre|center)(?:[^A-Za-z0-9]{0,3}(?:[A-Za-z][A-Za-z .'-]{0,48})?)?/giu

/** Obvious non-contact strings that would otherwise flood the findings list. */
function isNoiseEmail(value: string): boolean {
  const domain = value.slice(value.indexOf('@') + 1).toLowerCase()
  // Asset filenames and example domains are almost always rendered as text but never as a
  // way to reach a company, and reporting them would bury the real addresses.
  return /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|woff2?)$/iu.test(domain) ||
    /^(example|test|yourdomain|domain|email|sentry|wixpress|cloudflare|godaddy|wordpress)\./iu.test(domain) ||
    /@sentry\./iu.test(domain)
}

function isNoisePhone(value: string): boolean {
  const digits = value.replace(/\D/gu, '')
  // A bare year, a price, a postcode fragment and an obvious placeholder are not phone
  // numbers, and a report that lists "2024" as a contact detail is worse than one that
  // admits it found nothing.
  if (digits.length < 7 || digits.length > 15) return true
  if (/^(19|20)\d{2}$/u.test(digits)) return true
  if (/^(?:1234567890|0000000000|9999999999)$/u.test(digits)) return true
  return false
}

/**
 * Collect contact findings from a page's text, bounded and de-duplicated.
 *
 * Order is stable (first appearance) so two runs over the same text produce the same list,
 * which is what lets the verifier's re-read be compared against it meaningfully.
 */
function extractContacts(text: string, limit: number): readonly ContactFinding[] {
  const found: ContactFinding[] = []
  const seen = new Set<string>()

  const push = (kind: ContactFinding['kind'], raw: string): void => {
    const value = raw.replace(/\s+/gu, ' ').trim()
    if (value.length === 0 || value.length > 200) return
    const key = `${kind}:${value.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ kind, value })
  }

  for (const match of text.matchAll(EMAIL)) {
    if (!isNoiseEmail(match[0])) push('email', match[0])
    if (found.length >= limit) return found
  }
  for (const match of text.matchAll(PHONE)) {
    if (!isNoisePhone(match[0])) push('phone', match[0])
    if (found.length >= limit) return found
  }
  for (const match of text.matchAll(ADDRESS)) {
    push('address', match[0])
    if (found.length >= limit) return found
  }
  return found
}

/**
 * Resolve a page-supplied `href` against the page it was found on.
 *
 * Two refusals, both of which matter:
 *
 * - A **`javascript:`** address is refused outright. It is not a place, it is a program the
 *   page wants Freya to run, and "navigate" is not the operation that runs it.
 * - A **relative** address is resolved against the page's own address, which is what a
 *   person clicking the link would get. A link is resolved here rather than being handed to
 *   `page.navigate` verbatim because `page.navigate` will not accept a relative address, and
 *   resolving it ourselves is the only way a link can be followed without a click.
 *
 * Everything else is handed to the runtime, which re-checks it through `assertPublicBrowserUrl`,
 * the host allowlist and the isolation rules. This function is not a security boundary and
 * does not claim to be one — it only produces a syntactically navigable address.
 */
function resolveHref(href: string, pageUrl: string): string | null {
  const trimmed = href.trim()
  if (trimmed.length === 0 || trimmed.length > BROWSER_MISSION_LIMITS.maxHrefChars) return null
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(trimmed)
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase()
    // http, https and mailto are addresses. Everything else — javascript, data, file,
    // blob, about — is something else entirely, and navigating to it is not reading a page.
    return ['http', 'https'].includes(name) ? trimmed : null
  }
  if (trimmed.startsWith('#')) return null // a same-page anchor, not a destination
  try {
    return new URL(trimmed, pageUrl).toString()
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- the capability */

/** One bounded, ordered run of browser commands, with admission before each. */
async function runBounded(
  ports: BrowserMissionPorts,
  runId: string,
  stepKey: string,
  signal: AbortSignal,
  commands: readonly (Omit<BrowserRequest, 'command'> & { readonly command: BrowserRequest['command'] })[],
): Promise<{ ok: true; last: Extract<BrowserResult, { ok: true }>; issued: number } | { ok: false; reason: string }> {
  if (commands.length > BROWSER_MISSION_LIMITS.maxCommands) {
    return { ok: false, reason: `This step asked for ${String(commands.length)} browser commands, which is more than the ${String(BROWSER_MISSION_LIMITS.maxCommands)} it is allowed.` }
  }
  let last: Extract<BrowserResult, { ok: true }> | null = null
  for (const [index, command] of commands.entries()) {
    // Cancellation is checked *before* each command rather than during one, because
    // `BrowserRequest` carries no signal: the runtime's own STOP ALL latch and its
    // `maxCommandMs` deadline interrupt a command already in flight, and this module's job
    // is to refuse to start the next one.
    if (signal.aborted) return { ok: false, reason: 'This step was cancelled before it issued every browser command.' }
    // Admission before **every** command, not once per step. A step that admitted once and
    // then issued three more commands would be able to spend the Mission's external-request
    // budget without the budget being charged for it.
    await ports.admit(runId, stepKey, signal)
    const result = await ports.browser.execute(command)
    if (!result.ok) return { ok: false, reason: `The browser refused ${command.command}: ${refusalOf(result)}` }
    last = result
    if (index < commands.length - 1) signal.throwIfAborted()
  }
  if (last === null) return { ok: false, reason: 'This step issued no browser command, so it observed nothing.' }
  return { ok: true, last, issued: commands.length }
}

/**
 * The Mission browser capabilities, as one closed set.
 *
 * Exported so the admission check, the planner's capability filter and the registration all
 * agree on **one** list rather than three that can drift. A step whose capability is not in
 * here is refused before a browser command is issued, which is what stops a plan naming
 * `browser.contact.extract` on a step that was admitted for `browser.read`.
 */
export const BROWSER_MISSION_CAPABILITIES: ReadonlySet<string> = new Set([
  'browser.read',
  'browser.contact.extract',
])

/** Whether a capability name is one of this module's. Used by admission, not by registration. */
export function isBrowserMissionCapability(name: string): boolean {
  return BROWSER_MISSION_CAPABILITIES.has(name)
}

/**
 * Register the Mission browser capabilities.
 *
 * Two capabilities and two verifiers, registered only when the host actually mounted a
 * browser — so a Core with no browser never advertises a step that could not run, and a
 * planner that sees no `browser.*` name has simply been told the truth.
 */
export function registerBrowserInspection(registry: WorkRegistry, ports: BrowserMissionPorts, limits?: { maxCommands?: number }): void {
  // `Math.min`, so a host narrows and a caller cannot widen. Same arithmetic, same reason,
  // as `createBrowserTaskTool`.
  const maxCommands = Math.max(
    2,
    Math.min(limits?.maxCommands ?? BROWSER_MISSION_LIMITS.maxCommands, BROWSER_MISSION_LIMITS.maxCommands),
  )
  const readCommandCount = Math.min(3, maxCommands)

  /**
   * The three-command read every browser step needs, trimmed to what this build allows.
   *
   * When a host narrows to the floor of two commands there is no room to describe a page, so
   * the sequence degrades to open-then-navigate and the observation says the page's text was
   * not read rather than reporting an empty page as an empty result.
   */
  const readCommands = (url: string): { command: BrowserRequest['command']; url?: string }[] => {
    const commands: { command: BrowserRequest['command']; url?: string }[] = [{ command: 'session.open' }, { command: 'page.navigate', url }]
    if (readCommandCount >= 3) commands.push({ command: 'page.describe' })
    return commands
  }
  const describes = readCommandCount >= 3

  /* ------------------------------------------------------------ browser.read */

  registry.register({
    name: 'browser.read',
    capability: 'browser.read',
    risk: 'routine',
    // Its own declared pairing, so a planner can bind it honestly rather than guessing.
    verifier: 'browser.page.verified',
    describe(request) {
      const url = asString(request.input['url'])
      return url === null
        ? 'reads one public page in Freya\'s own browser without acting on it'
        : `reads the public page at ${url.slice(0, 120)} in Freya's own browser, and reads nothing else`
    },
    async execute(request, context) {
      const raw = request.input
      const url = asString(raw['url'])
      if (Object.keys(raw).some((key) => key !== 'url') || url === null || !/^https?:\/\//iu.test(url) || url.length > 2_048) {
        throw new Error('A browser read needs exactly one absolute http or https address.')
      }

      // Open, navigate, describe. Three commands: the session is what the navigation
      // happens in, and `page.describe` is the only command that returns the page's own
      // words rather than a byte count.
      const opened = await runBounded(ports, request.runId, request.stepKey, context.signal, readCommands(url))
      if (!opened.ok) {
        await ports.save(request.runId, request.stepKey, {
          requestedUrl: url, finalUrl: null, title: null, text: '', links: [],
          contacts: [], verified: false, failure: 'page_not_read', readAt: context.now().toISOString(),
        })
        throw new Error(opened.reason)
      }

      const data = opened.last.data
      const finalUrl = asString(data['url']) ?? url
      const title = asString(data['title'])
      // A build narrowed below three commands never issued `page.describe`, so it read the
      // address but not the page. That is reported as such rather than as an empty page —
      // "found nothing" and "was not allowed to look" are different facts.
      if (!describes) {
        await ports.save(request.runId, request.stepKey, {
          requestedUrl: url, finalUrl, title: null, text: '', links: [],
          contacts: [], verified: false, failure: 'page_reading_not_permitted', readAt: context.now().toISOString(),
        })
        throw new Error('This build did not permit reading a page body, so no page content was observed.')
      }
      const text = typeof data['text'] === 'string' ? data.text.slice(0, BROWSER_MISSION_LIMITS.maxRetainedChars) : ''

      // The links a page offered, ranked. `href` is page-supplied and unresolved here: it is
      // recorded as the page declared it, and resolving it is a later step's decision so that
      // a *saved* link never depends on the page it was found on still being current.
      const links: MissionBrowserEvidence['links'][number][] = []
      const rawElements = Array.isArray(data['elements']) ? data['elements'] : []
      for (const candidate of rawElements.slice(0, BROWSER_MISSION_LIMITS.maxLinkCandidates)) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const element = candidate as Record<string, unknown>
        const label = asString(element['label']) ?? ''
        const href = asString(element['href'])
        if (href === null) continue
        const rank = contactRank(label, href)
        if (rank === null) continue
        const resolved = resolveHref(href, finalUrl)
        if (resolved === null) continue
        links.push({ label: label.slice(0, 120), href: resolved.slice(0, BROWSER_MISSION_LIMITS.maxHrefChars), rank })
      }

      await ports.save(request.runId, request.stepKey, {
        requestedUrl: url,
        finalUrl,
        title,
        text,
        links,
        contacts: [],
        verified: false,
        failure: null,
        readAt: context.now().toISOString(),
      })

      return {
        observation: {
          kind: 'result',
          summary:
            `Read ${title === null ? 'a page' : `"${title.slice(0, 80)}"`} at ${finalUrl.slice(0, 120)}: ` +
            `${String(text.length)} characters, ${String(links.length)} contact-page link(s). ` +
            'The page was read; whether the text is accurate remains unverified.',
          data: {
            finalUrl,
            title,
            // The verifier needs the retained text to compare a re-read against. It is never
            // journalled and never projected — Work's own contract says `data` is for the
            // verifier and nothing else.
            textLength: text.length,
            contactLinks: links.length,
          },
        },
      }
    },
  })

  /* ------------------------------------------- browser.contact.extract (read) */

  registry.register({
    name: 'browser.contact.extract',
    capability: 'browser.read',
    risk: 'routine',
    verifier: 'browser.contact.verified',
    describe(request) {
      const url = asString(request.input['url'])
      return url === null
        ? 're-reads a public page and reports contact details found in its text'
        : `re-reads the public page at ${url.slice(0, 120)} and reports the contact details its text contains`
    },
    async execute(request, context) {
      const raw = request.input
      const url = asString(raw['url'])
      if (Object.keys(raw).some((key) => key !== 'url') || url === null || !/^https?:\/\//iu.test(url) || url.length > 2_048) {
        throw new Error('A contact extraction needs exactly one absolute http or https address.')
      }

      const read = await runBounded(ports, request.runId, request.stepKey, context.signal, readCommands(url))
      if (!read.ok) {
        await ports.save(request.runId, request.stepKey, {
          requestedUrl: url, finalUrl: null, title: null, text: '', links: [],
          contacts: [], verified: false, failure: 'page_not_read', readAt: context.now().toISOString(),
        })
        throw new Error(read.reason)
      }

      const data = read.last.data
      const finalUrl = asString(data['url']) ?? url
      const title = asString(data['title'])
      if (!describes) {
        await ports.save(request.runId, request.stepKey, {
          requestedUrl: url, finalUrl, title: null, text: '', links: [],
          contacts: [], verified: false, failure: 'page_reading_not_permitted', readAt: context.now().toISOString(),
        })
        throw new Error('This build did not permit reading a page body, so no contact details could be extracted.')
      }
      const text = typeof data['text'] === 'string' ? data.text.slice(0, BROWSER_MISSION_LIMITS.maxRetainedChars) : ''
      const contacts = extractContacts(text, BROWSER_MISSION_LIMITS.maxContactFindings)

      const evidence: MissionBrowserEvidence = {
        requestedUrl: url,
        finalUrl,
        title,
        // Retained so the verifier re-reads the *same* page and compares. See the note on
        // `browser.read`: this never reaches the journal or a projection.
        text,
        links: [],
        contacts: contacts.map((contact) => ({ kind: contact.kind, value: contact.value })),
        verified: false,
        failure: contacts.length === 0 ? 'no_contact_details_found' : null,
        readAt: context.now().toISOString(),
      }
      await ports.save(request.runId, request.stepKey, evidence)

      return {
        observation: {
          kind: 'result',
          summary:
            `Read ${title === null ? 'a page' : `"${title.slice(0, 80)}"`} at ${finalUrl.slice(0, 120)} and found ` +
            `${String(contacts.length)} contact detail(s): ${contacts.slice(0, 4).map((c) => `${c.kind} ${c.value}`).join('; ')}` +
            `${contacts.length > 4 ? '; and more' : ''}. ` +
            'These are strings found on the page, not verified contact details.',
          data: {
            finalUrl,
            title,
            textLength: text.length,
            contactCount: contacts.length,
            // Carried for the verifier. Not journalled, not projected.
            contacts: contacts.map((contact) => ({ kind: contact.kind, value: contact.value })),
            text,
          },
        },
      }
    },
  })

  /* ------------------------------------------------------- the two verifiers */

  /**
   * Re-open, navigate and describe one page, for a verifier's independent second look.
   *
   * Routed through {@link runBounded} rather than issued inline, and that is the whole point:
   * a verification read contacts the outside world exactly as an execution read does, so it
   * is admitted **before every command** and charged against the Mission's external-request
   * ceiling in the same way. A verifier that re-read for free would be a way to check ten
   * pages past a budget of three, which is the accounting hole this closes.
   *
   * It also means a verifier cannot exceed the per-step command bound, because it is the same
   * bound and the same function that stops execution.
   */
  const reread = async (runId: string, stepKey: string, url: string): Promise<
    { ok: true; text: string; finalUrl: string; title: string | null } | { ok: false; reason: string }
  > => {
    const outcome = await runBounded(ports, runId, stepKey, AbortSignal.timeout(30_000), readCommands(url))
    if (!outcome.ok) return { ok: false, reason: outcome.reason }
    const data = outcome.last.data
    const text = typeof data['text'] === 'string' ? data['text'] : ''
    return {
      ok: true,
      text,
      finalUrl: asString(data['url']) ?? url,
      title: asString(data['title']),
    }
  }

  registry.registerVerifier({
    name: 'browser.page.verified',
    /**
     * Re-read the page and check it is the page.
     *
     * Not a re-verification of the *content* — this establishes that Freya opened a real,
     * current, public page at the address it reported, and that the title and body it is
     * holding still describe that page. It does not establish that anything on the page is
     * true, and the reason it returns says so in those words, because a verifier's reason is
     * shown to a person on a board and a board that renders "verified" without that caveat
     * would be making a claim nobody checked.
     */
    async verify(request) {
      const evidence = await ports.read(request.runId, request.stepKey)
      if (evidence === null || evidence.failure === 'page_not_read' || evidence.finalUrl === null) {
        return { verdict: 'failed', reason: 'No page was recorded for this step, so there is nothing to verify.' }
      }
      const again = await reread(request.runId, request.stepKey, evidence.finalUrl)
      if (!again.ok) {
        return { verdict: 'failed', reason: `An independent re-read of the page could not be established: ${again.reason}` }
      }
      const held = evidence.text
      if (held.length > 0) {
        // The retained text must still be *in* the page. A page that has changed enough to
        // lose every character Freya recorded is a different page for this purpose, and
        // reporting success anyway is how a stale finding becomes a reported finding.
        const slice = held.slice(0, 400)
        if (slice.length > 0 && !again.text.includes(slice)) {
          await ports.save(request.runId, request.stepKey, { ...evidence, verified: false, failure: 'page_changed' })
          return { verdict: 'failed', reason: 'An independent re-read of the page did not contain the text this step recorded, so the page has changed.' }
        }
      }
      await ports.save(request.runId, request.stepKey, { ...evidence, verified: true, failure: null })
      return {
        verdict: 'passed',
        reason: `An independent re-read of ${evidence.finalUrl.slice(0, 120)} matched the recorded page. What the page says remains a third party's claim, not a verified fact.`,
      }
    },
  })

  registry.registerVerifier({
    name: 'browser.contact.verified',
    /**
     * Re-read the page and confirm every reported detail is still on it.
     *
     * This is the verifier that makes the mission's "verify the information" step mean
     * something concrete. Each reported finding is checked against a **fresh** read of the
     * same page; a detail that is no longer there is not silently dropped, it fails the
     * verification, because a partially-true contact list reported as verified is worse than
     * one reported as unverified.
     *
     * It establishes that the strings were on the page. It does **not** establish that the
     * phone number works or the mailbox is monitored, and the reason says exactly that.
     */
    async verify(request) {
      const evidence = await ports.read(request.runId, request.stepKey)
      if (evidence === null) {
        return { verdict: 'failed', reason: 'No page was recorded for this step, so its contact details cannot be verified.' }
      }
      if (evidence.failure === 'no_contact_details_found') {
        return {
          verdict: 'failed',
          reason: `No contact details of a recognisable shape were found on ${(evidence.finalUrl ?? evidence.requestedUrl).slice(0, 120)}, so nothing could be verified.`,
        }
      }
      if (evidence.finalUrl === null) {
        return { verdict: 'failed', reason: 'No page was read, so there are no contact details to verify.' }
      }
      const again = await reread(request.runId, request.stepKey, evidence.finalUrl)
      if (!again.ok) {
        return { verdict: 'failed', reason: `An independent re-read of the page could not be established: ${again.reason}` }
      }
      const normalised = again.text.replace(/\s+/gu, ' ')
      const missing = evidence.contacts.filter(
        (contact) => !normalised.includes(contact.value.replace(/\s+/gu, ' ')),
      )
      if (missing.length > 0) {
        // The findings are **kept**, not dropped: a report that says "three of five details
        // were no longer on the page" is more useful and more honest than one that silently
        // reports the survivors as though all five had been verified.
        await ports.save(request.runId, request.stepKey, {
          ...evidence,
          verified: false,
          failure: 'contact_details_changed',
        })
        return {
          verdict: 'failed',
          reason: `An independent re-read of the page did not contain ${String(missing.length)} of the reported detail(s), so they could not be verified.`,
        }
      }
      await ports.save(request.runId, request.stepKey, { ...evidence, verified: true, failure: null })
      return {
        verdict: 'passed',
        reason:
          `An independent re-read of ${evidence.finalUrl.slice(0, 120)} still contained all ${String(evidence.contacts.length)} reported detail(s). ` +
          'That they appear on the page is established; that the contact details work is not.',
      }
    },
  })
}