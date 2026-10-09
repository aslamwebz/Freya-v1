import { retrievalRestrictions, routeChatIntent } from '../research/chat-intent'
/**
 * Core-owned deterministic tool intent for explicit owner requests.
 *
 * This is intentionally narrow. It does not decide whether arbitrary questions
 * need the web. It only honors two concrete choices the owner already made:
 *
 *  - "use Freya's own browser" + an exact URL -> browser_read
 *  - an explicit request to find/show images, videos or documents -> web_search
 *    with that exact vertical
 *
 * Neither branch grants authority. MindToolRegistry still evaluates the tool's
 * capability through Guard immediately before anything runs.
 *
 * ## Turn intent hints
 *
 * The composer's two intent buttons used to **prepend** "find on the web: " and
 * "use your browser: " to the owner's text, so the existing text-based routes
 * would fire. That contaminated the stored user message: the words the owner
 * actually said were not the words Core stored, the words it journaled and the
 * words the next turn would put in front of a model.
 *
 * Hints travel separately, as structured metadata on the turn. They never
 * replace the text; they are *policy* the Mind reads alongside the text. The
 * text itself is stored verbatim, and a later re-compile of the same conversation
 * produces the same words the owner typed.
 *
 * Hints outrank text-derived intent: an explicit composer decision about which
 * tool to use is the one that should fire, and falling back to "what the words
 * would have meant" is what the old contamination did.
 */

/**
 * The two composer-held directives.
 *
 * Closed on purpose: every new directive needs a corresponding button, a
 * corresponding test, and a corresponding guard. Nothing else can be named here.
 *
 * Both default to `false`. A `true` means the owner pressed the button before
 * pressing Send, and the value travels for one turn only — Send clears them.
 */
export interface TurnIntentHints {
  /** The owner pressed "Web search" for this turn. */
  readonly webSearch?: boolean
  /** The owner pressed "Browser use" for this turn. */
  readonly browserUse?: boolean
}

/** An empty hint set — the normal state of a turn with no button held. */
export const EMPTY_INTENT_HINTS: TurnIntentHints = Object.freeze({})

export type InitialToolRequest =
  | {
      readonly name: 'browser_read'
      readonly arguments: Readonly<Record<string, string>>
    }
  | {
      readonly name: 'browser_tabs'
      readonly arguments: Readonly<Record<string, string>>
    }
  | {
      readonly name: 'web_search'
      readonly arguments: Readonly<Record<string, string>>
    }

const EXPLANATION_FRAME =
  /^\s*(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:explain|describe|teach|walk\s+me)\b|^\s*(?:explain|describe|teach)\b/

const EXPLICIT_BROWSER =
  /\b(?:use|open|launch|start|drive|pilot|operate|control)\b[^.!?]{0,36}\b(?:your|freya'?s|the)\s+(?:own\s+)?browser\b|\byour\s+own\s+browser\b|\bin\s+(?:your|freya'?s|the)\s+(?:own\s+)?browser\b|\bbrowse\s+to\b/

const HTTP_URL = /https?:\/\/[^\s<>(){}"']+/iu
const WEB_ADDRESS = /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s,;]*)?/giu
function cleanUrl(raw: string): string { return raw.replace(/[.,!?;:]+$/u, '') }
function browserAddresses(text: string): readonly string[] {
  const out: string[] = []
  for (const match of text.matchAll(WEB_ADDRESS)) {
    const raw = cleanUrl(match[0])
    const candidate = /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      const normalized = parsed.toString()
      if (!out.includes(normalized)) out.push(normalized)
    } catch { /* Ignore prose that only resembles a web address. */ }
  }
  return out
}

/**
 * Resolve the owner's own text and any composer-held hints into an initial tool call.
 *
 * The hint branch runs first and outranks text-derived intent. The old behaviour —
 * prepending a directive onto the owner's words — is gone: the stored user
 * message is the text alone, and the hint is policy the Mind reads here.
 *
 * `browserUse` honours concrete web addresses in the owner's text. A list of
 * domains or URLs becomes one bounded `browser_tabs` open request, so the model
 * cannot silently replace an explicit Browser-mode action with web search. If
 * the owner supplied no address at all, the hint does not invent one and the
 * model may decide what to do next.
 *
 * `webSearch` produces a `web_search` request for the exact text. The vertical
 * falls through to the text-derived detection when the owner's words name one,
 * which is what keeps "find me videos about Saturn" landing on the video index
 * rather than a generic web lookup.
 */
export function initialToolRequestForOwnerText(
  text: string,
  hints?: TurnIntentHints,
): InitialToolRequest | null {
  const value = text
  const route = routeChatIntent(text, { activeEyeSession: false })
  const search = (): InitialToolRequest => ({ name: 'web_search', arguments: Object.freeze({ query: text, type: route.kind === 'native_browser_task' ? 'web' : route.vertical, ...(route.site ? { site: route.site } : {}) }) })
  if (value.trim().length === 0) return null

  const lower = value.toLowerCase().replace(/\s+/gu, ' ')

  // Hint-derived overrides run first because the button is the owner's stronger
  // commitment than the wording. A turn the owner already chose to web-search
  // does not need to mention a verb; the route is set.
  if (hints?.webSearch === true) return search()

  if (hints?.browserUse === true) {
    const addresses = browserAddresses(value)
    if (addresses.length === 0) return null
    return {
      name: 'browser_tabs',
      arguments: Object.freeze({ op: 'open', urls: addresses.join('\n') }),
    }
  }

  // Explicit browser control is stronger than media retrieval. "Use your browser
  // to find images..." means browser, because that is the capability the owner named.
  if (!retrievalRestrictions(text).browser && EXPLICIT_BROWSER.test(lower)) {
    const match = HTTP_URL.exec(value)
    if (match === null) return search()
    const candidate = cleanUrl(match[0])
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return {
        name: 'browser_read',
        arguments: Object.freeze({ url: parsed.toString() }),
      }
    } catch {
      return null
    }
  }

  if (EXPLANATION_FRAME.test(lower)) return null
  if (route.kind === 'direct_answer' || route.kind.startsWith('attachment_')) return null
  return search()
}
