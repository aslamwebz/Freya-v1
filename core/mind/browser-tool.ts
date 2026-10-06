import type { BrowserCommand, BrowserTarget } from '../browser/types'
import type { BrowserRequest, BrowserResult } from '../browser/runtime'
import {
  EXTRACT_CUT_MARKER,
  MIND_TOOL_LIMITS,
  boundText,
  sanitiseUntrustedText,
  type MindTool,
  type ToolProvenance,
  type ToolSource,
} from './tools'

/**
 * The browser task tool: a bounded adapter over Freya's *own* dual-browser runtime.
 *
 * ## It is an adapter, not a browser
 *
 * Every command it issues is one of the closed entries in `BROWSER_COMMANDS`
 * (`core/browser/types.ts`), sent to `DualBrowserRuntime.execute`. There is no second
 * browser, no second session, no second window factory and no second approval path here.
 * The runtime routes, refuses and journals; this file only decides *which* of the existing
 * commands to ask for, in what order, and how to describe honestly what came back.
 *
 * ## The two authority checks are both deliberate
 *
 * This tool names one capability, `browser.read`, and
 * {@link MindToolRegistry.invoke} evaluates it against Guard immediately before the body
 * runs. Inside the runtime, the *same fact* is checked again: `page.navigate` and
 * `page.describe` map through `BROWSER_COMMAND_ACTION` to `browser.navigate` and
 * `browser.read-text`, and each of those goes through the Phase 35 Device Hands gate chain
 * (`BrowserAuthorityPort.perform`) with its own grant, deadline, policy and approval.
 *
 * **Checking one fact twice is the point, not an oversight.** The registry check answers
 * "may this turn spend `browser.read` at all"; the Device Hands check answers "may *this
 * action, on this page, for this principal, right now*". They are different questions with
 * different clocks, and a tool that relied on only one of them would be a tool whose
 * authority depends on which caller happened to construct it.
 *
 * ## It cannot click, and it does not pretend to
 *
 * `page.click` is `browser.click`: an `act`-mode command, approval-requiring, and a
 * *different* capability. A tool may name exactly one capability, so this tool has no
 * parameter, no argument and no code path that can reach a click or a keystroke. That is
 * structural rather than instructional — see {@link BROWSER_TASK_EFFECTS}, where
 * `'clicked'` and `'typed'` do not appear in the vocabulary at all.
 *
 * This matters because the failure mode the spec names is a tool that reports a click it
 * did not make. Here the report is generated from the command that was actually issued and
 * the verdict it actually got, so a read reads as a read.
 *
 * ## What it cannot do, and why that is the right answer
 *
 * It does not search. Searching is `search.web`, a separate capability with a separate
 * Guard evaluation (`core/research/coreIntegration.ts`), and a tool holding `browser.read`
 * that called `searchWeb` would spend a capability it was never evaluated for. So the
 * "search for X, then open the official result" turn is a *composition*: `web_search` on
 * one iteration, `browser_read` on the next. That fits inside
 * `MIND_TOOL_LIMITS.maxToolCalls` exactly, and `tests/core/mind/browser-task-tool.test.ts`
 * pins it.
 *
 * It also does not follow a section by clicking a heading. It follows one by navigating to
 * the anchor, because a click is `act` mode and a navigation is not. `page.describe` hands
 * back element *selectors*, not hrefs (`core/browser/refs.ts`), so there is no href to
 * resolve without clicking, and this tool will not click.
 *
 * ## Where the iteration ceiling actually bites
 *
 * `MIND_TOOL_LIMITS` counts **provider calls and tool executions**, not browser commands.
 * One `browser_read` execution is up to {@link BROWSER_TASK_LIMITS.maxCommands} browser
 * commands inside a single tool body, so a browser task does not need the ceiling raised
 * and does not get it raised. What it does need, and states plainly in its own summary, is
 * that the turn has **one provider call left after it** — enough to answer, not enough to
 * open a third tool. A model that searches, reads and then wants to follow another link
 * runs out of room, and the loop's existing "ran out of iterations" failure is the honest
 * outcome rather than a quiet widening of the ceiling.
 */

/* -------------------------------------------------------------------- limits */

/**
 * Every bound this tool obeys on its own account.
 *
 * Frozen and code-owned, for the reason `MIND_TOOL_LIMITS` gives: a bound that depends on
 * who is asking is a bound somebody can raise. A caller may narrow these and may not widen
 * them — see `createBrowserTaskTool`.
 */
export const BROWSER_TASK_LIMITS = Object.freeze({
  /**
   * Browser commands one execution may issue.
   *
   * Five is the longest honest sequence: open, navigate, navigate-to-anchor, describe,
   * close. The sixth is headroom so that an added step cannot silently fall outside the
   * bound — a command that would exceed this is *not issued*, and the tool reports that it
   * stopped rather than reporting an unbounded run as a bounded one.
   */
  maxCommands: 6,

  /**
   * Distinct pages one execution may visit.
   *
   * Two: the address, and the same address at an anchor. A browser that can walk a site
   * for as long as the model keeps producing links is a crawler, and a crawler inside a
   * turn is an unbounded spend wearing a tool's clothes.
   */
  maxPages: 2,

  /** Characters of quoted page text one execution may carry back. */
  maxExtractChars: 900,

  /** Described elements that may become extract lines. */
  maxExtractLines: 8,

  /** Characters allowed in a section anchor, before it is even looked at. */
  maxAnchorChars: 64,
})

/**
 * What a step in this tool can possibly have done.
 *
 * A closed four-value vocabulary, and the two `act`-mode words are **absent** rather than
 * merely unused: `'clicked'` and `'typed'` are not spellings this file can produce, so
 * there is no value of a variable and no branch that could grow one by accident. Every
 * line in the provenance block is built from one of these, which is what makes "Freya did
 * not click that" a statement about the code rather than about the model's behaviour.
 */
export type BrowserTaskEffect = 'session-opened' | 'navigated' | 'read-text' | 'closed'

/**
 * The command each effect came from, and whether it really happened.
 *
 * `null` is the honest default and it means *nothing happened*: a refused command is
 * recorded with no effect at all, rather than being recorded with the effect it would have
 * had. A refusal that reported `navigated` would be exactly the lie this module exists to
 * avoid.
 */
const EFFECT_OF_COMMAND: Readonly<Record<BrowserCommand, BrowserTaskEffect | null>> = Object.freeze({
  'session.open': 'session-opened',
  'page.navigate': 'navigated',
  'page.describe': 'read-text',
  'session.close': 'closed',
  // Reachable only through a future edit. `null` means "no effect is claimed", which is
  // the answer that cannot be wrong.
  'session.state': null,
  'page.read': null,
  'page.click': null,
  'page.type': null,
  'media.describe': null,
  'handoff.offer': null,
  'handoff.accept': null,
  'handoff.list': null,
  'handoff.cancel': null,
})

/* -------------------------------------------------------------- the vocabulary */

/**
 * The one capability this tool can spend.
 *
 * `browser.read` from `core/protocol/core-protocol.ts`, and nothing else. It is the
 * capability that "fetches an arbitrary public page and therefore executes an attacker's
 * HTML inside a managed sandbox", which is precisely what navigating Freya's own browser
 * does — as distinct from `search.web`, which asks a third party a question and executes
 * nothing.
 */
export const BROWSER_TASK_CAPABILITY = 'browser.read' as const

/**
 * How each of the two browsers is named in a transcript.
 *
 * Taken from the `BROWSER_TARGETS` vocabulary rather than invented here, and deliberately
 * verbose: `"public"` on its own means nothing to a person reading an answer, and the whole
 * reason this map exists is that the distinction between a credential-free embedded window
 * and the owner's logged-in Chrome is the distinction that matters. `authenticated` is not
 * a fallback spelling of `public` — see `auditRoutingDefaults` in `core/browser/routing.ts`
 * — so the two words never blur.
 */
export const BROWSER_PORT_NAMES: Readonly<Record<BrowserTarget, string>> = Object.freeze({
  public: 'native/public Freya browser',
  authenticated: 'paired Chrome extension',
})

/* ------------------------------------------------------------------- the port */

/**
 * The slice of `DualBrowserRuntime` this tool needs.
 *
 * Declared structurally rather than imported as the concrete class, for two reasons. A tool
 * that held a `DualBrowserRuntime` would hold a *stateful window-owning runtime*, which is
 * a far larger thing to hand a Mind tool than "send me a command"; and the tests can then
 * build a port that answers with a chosen `target` without standing up Electron, which is
 * what makes the native-vs-extension assertion a real assertion about this tool's honesty
 * rather than about a mock.
 *
 * `execute` and nothing else. In particular there is no `state()`, no `route()` and no
 * `stopAll()` here: reading the projection would let the tool infer what a browser is
 * doing without asking it, and a tool that reports a projection is reporting somebody
 * else's belief.
 */
export interface BrowserTaskPort {
  execute(request: BrowserRequest): Promise<BrowserResult>
}

/* ------------------------------------------------------------------- helpers */

/** A refusal from the runtime, as one bounded sentence. */
function refusalOf(result: Extract<BrowserResult, { ok: false }>): string {
  return `${result.code}: ${boundText(result.reason.replace(/\s+/gu, ' ').trim(), 160)}`
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * An anchor, or nothing.
 *
 * Only `#fragment` survives, and only characters a fragment legitimately contains. This
 * runs before the browser sees anything, so a model cannot smuggle a second address
 * through the "section" argument — `#` plus a path is dropped rather than repaired,
 * because a repaired anchor is not the thing that was asked for.
 */
const ANCHOR = /^#[A-Za-z0-9][A-Za-z0-9._~%-]{0,63}$/

/* ------------------------------------------------------------- the tool itself */

export interface BrowserTaskToolOptions {
  /** The existing dual-browser runtime. Never constructed here. */
  readonly browser: BrowserTaskPort
  readonly now?: () => Date
  /** Narrowing only, exactly as `createWebSearchTool` treats `maxResults`. */
  readonly maxCommands?: number
}

/**
 * The browser task tool.
 *
 * One bounded sequence: open a session, navigate, optionally navigate to an anchor,
 * describe, close. Bounded by {@link BROWSER_TASK_LIMITS}, cancellable between every pair
 * of commands, and reported with the port that answered and the effect each command really
 * had.
 */
export function createBrowserTaskTool(options: BrowserTaskToolOptions): MindTool {
  const now = options.now ?? (() => new Date())
  // `Math.min`, so a caller narrows and a request cannot widen. Same arithmetic, same
  // reason, as `createWebSearchTool`.
  const maxCommands = Math.max(
    2,
    Math.min(options.maxCommands ?? BROWSER_TASK_LIMITS.maxCommands, BROWSER_TASK_LIMITS.maxCommands),
  )

  return {
    name: 'browser_read',
    description:
      'Open one address in Freya\'s own browser, read the page as it renders, and return its title, ' +
      'address and bounded text. Optionally read a section of it. It reads and navigates only: it ' +
      'never clicks, types, logs in or submits anything.',
    capability: BROWSER_TASK_CAPABILITY,
    parameters: [
      { name: 'url', description: 'the address to open, http or https', required: true },
      {
        name: 'section',
        description: 'optional anchor to read instead, as #fragment — a heading anchor on the same page',
      },
    ],

    async run(request) {
      const base = (request.arguments['url'] ?? '').trim()
      if (base.length === 0) throw new Error('the browser tool was given no address to open')
      if (!/^https?:\/\//iu.test(base)) {
        throw new Error('the browser tool only opens http and https addresses, and nothing that names a file, a script or the machine')
      }
      const rawSection = (request.arguments['section'] ?? '').trim()
      const anchor = rawSection === '' ? null : ANCHOR.exec(rawSection)
      if (rawSection !== '' && anchor === null) {
        throw new Error('a section must be a "#fragment" on the same page; a second address is a separate browser tool call')
      }

      const steps: string[] = []
      let issued = 0
      /** Which port answered, as the runtime reported it. Never chosen here. */
      let actor: string | null = null
      let sessionId: string | null = null

      /**
       * One command, with the three checks that make a bounded run bounded.
       *
       * Cancellation is checked *between* commands and not during one, because
       * `BrowserRequest` carries no signal: the runtime's own STOP ALL latch and its
       * `maxCommandMs` deadline are what interrupt a command already in flight, and this
       * tool's job is to refuse to start the next one. That is the same division of labour
       * `runToolLoop` uses at its iteration boundary.
       */
      const call = async (
        command: BrowserCommand,
        extra: Omit<BrowserRequest, 'command'>,
      ): Promise<Extract<BrowserResult, { ok: true }>> => {
        if (request.signal?.aborted === true) throw new Error('the turn was cancelled between browser steps')
        if (issued >= maxCommands) {
          steps.push(`${String(issued + 1)}. ${command} — not issued: this task has used all ${String(maxCommands)} browser commands it is allowed`)
          throw new Error(`this browser task reached its bound of ${String(maxCommands)} browser commands`)
        }
        issued += 1

        const result = await options.browser.execute({ command, ...extra })

        if (result.ok) {
          // The runtime decided the target and reported it back. Recording *its* answer
          // rather than this tool's belief is the whole reason the port is observable.
          actor = BROWSER_PORT_NAMES[result.target]
          const effect = EFFECT_OF_COMMAND[command] ?? null
          steps.push(
            `${String(issued)}. ${command} — ${effect === null ? 'done' : effect} — served by ${actor}`,
          )
          return result
        }

        steps.push(`${String(issued)}. ${command} — REFUSED (${refusalOf(result)}) — nothing was done`)
        throw new Error(`the browser refused ${command}: ${refusalOf(result)}`)
      }

      try {
        /* -- 1. a session, in the credential-free browser, and nothing else -------- */

        const opened = await call('session.open', {})
        sessionId = asString(asRecord(opened.data)?.['sessionId'])
        if (sessionId === null) {
          throw new Error('the browser opened a session but did not name it, so no page can be addressed')
        }

        /* -- 2. the address, navigated for real ------------------------------------ */

        const navigated = await call('page.navigate', { sessionId, url: base })
        const landed = asString(asRecord(navigated.data)?.['url']) ?? base

        /* -- 3. the section, as a second real navigation rather than a click -------- */

        let readFrom = landed
        if (anchor !== null) {
          const here = await call('page.navigate', { sessionId, url: `${landed}${anchor[0]}` })
          readFrom = asString(asRecord(here.data)?.['url']) ?? `${landed}${anchor[0]}`
        }

        /* -- 4. the read ------------------------------------------------------------ */

        // `page.describe` and not `page.read`. Both are `browser.read-text`, but only
        // `page.describe` returns bounded material: `page.read` answers with a *byte
        // count* (`core/browser/runtime.ts`) and `describePage` returns the element labels
        // and the title. So the extract below is the live window's own view of the page,
        // and it is labelled as described content rather than as the page's prose.
        const described = await call('page.describe', { sessionId })
        const data = asRecord(described.data) ?? {}
        const url = asString(data['url']) ?? readFrom
        const title = asString(data['title']) ?? ''
        const extract = extractLines(data['elements'])

        const source: ToolSource | null = toSource(url, title, extract[0] ?? '', now())
        const at = now().toISOString()
        const navigatedTimes = steps.filter((line) => line.includes(' — navigated — ')).length

        const summary =
          `Freya's own browser opened ${String(url)}` +
          (title === '' ? '' : ` ("${boundText(title, MIND_TOOL_LIMITS.maxTitleChars)}")`) +
          `, performed ${String(navigatedTimes)} real navigation(s) and read the page as it rendered. ` +
          `Nothing was clicked, typed, submitted or logged into, and none of those is claimed. ` +
          `Freya can now answer from the page it actually observed without pretending another lookup happened.`

        const provenance: ToolProvenance = {
          actor: actor ?? BROWSER_PORT_NAMES.public,
          steps,
          extract,
        }

        return {
          summary,
          sources: source === null ? [] : [{ ...source, retrievedAt: at }],
          provenance,
        }
      } finally {
        /* -- 5. the window closes, whatever happened ------------------------------- */

        // In a `finally`, and therefore on the cancellation and the failure path too. A
        // session left open is a window left on the owner's screen with nobody driving it,
        // and "the turn was cancelled" is not a reason to leave one. This is deliberately
        // *not* skipped when the signal is already aborted: `BrowserRequest` carries no
        // signal, so a close here is not work the turn is doing — it is tidying up, and it
        // reaches the runtime, which refuses it under a latched STOP ALL all by itself.
        if (sessionId !== null) {
          const closing = await options.browser
            .execute({ command: 'session.close', sessionId })
            .catch(() => null)
          steps.push(
            closing === null || !closing.ok
              ? 'session.close — not performed by this task; the runtime owns the window now'
              : `session.close — closed — served by ${BROWSER_PORT_NAMES[closing.target]}`,
          )
        }
      }
    },
  }
}

/**
 * The quoted page text, bounded twice.
 *
 * `describePage` already bounds every label to 120 characters and the whole snapshot to
 * 4 KiB; this bounds the *result* again, on line count and on total characters, so that a
 * page of two thousand links cannot turn into a two-thousand-line observation.
 *
 * Two kinds are skipped and one flag is respected:
 *
 *   - **`field` elements are skipped entirely.** A field's *label* is not its value — the
 *     runtime never returns a value — but a search form's placeholder list is not the page
 *     either, and dropping them makes the extract say what the page is *about*.
 *   - **`protected` elements are skipped.** Their labels are safe to display, but this tool
 *     has no business quoting anything attached to a password, card or one-time-code field.
 *
 * The result is the page's own headings, prose and links, quoted, and nothing else.
 */
function extractLines(elements: unknown): string[] {
  if (!Array.isArray(elements)) return []
  const lines: string[] = []
  let chars = 0
  let cut = false
  for (const candidate of elements) {
    if (lines.length >= BROWSER_TASK_LIMITS.maxExtractLines) {
      cut = true
      break
    }
    const entry = asRecord(candidate)
    if (entry === null) continue
    const kind = asString(entry['kind'])
    if (kind === null || kind === 'field') continue
    if (entry['protected'] === true) continue
    const label = asString(entry['label'])
    if (label === null) continue
    const remaining = BROWSER_TASK_LIMITS.maxExtractChars - chars
    if (remaining <= 0) {
      cut = true
      break
    }
    const bounded = sanitiseUntrustedText(label, remaining)
    if (bounded === '') continue
    // Compared, not inferred from a trailing ellipsis: the page may legitimately end in one.
    if (bounded.length < label.length) cut = true
    lines.push(bounded)
    chars += bounded.length
  }
  // Stated rather than silent, and stated with the *same* marker the registry uses, so a
  // truncated quote reads as truncated whoever bound it.
  return cut ? [...lines, EXTRACT_CUT_MARKER] : lines
}

/** Narrow a read page to a citable source, or null when the address is not one. */
function toSource(url: string, title: string, snippet: string, at: Date): ToolSource | null {
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
    sourceDomain: sanitiseUntrustedText(hostnameOf(url), MIND_TOOL_LIMITS.maxTitleChars),
    snippet: sanitiseUntrustedText(snippet, MIND_TOOL_LIMITS.maxSnippetChars),
    rank: 1,
    retrievedAt: at.toISOString(),
  }
}
