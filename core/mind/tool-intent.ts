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
      readonly name: 'web_search'
      readonly arguments: Readonly<Record<string, string>>
    }

const EXPLANATION_FRAME =
  /^\s*(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:explain|describe|teach|walk\s+me)\b|^\s*(?:explain|describe|teach)\b/

const EXPLICIT_BROWSER =
  /\b(?:use|open|launch|start|drive|pilot|operate|control)\b[^.!?]{0,36}\b(?:your|freya'?s|the)\s+(?:own\s+)?browser\b|\byour\s+own\s+browser\b|\bin\s+(?:your|freya'?s|the)\s+(?:own\s+)?browser\b|\bbrowse\s+to\b/

const HTTP_URL = /https?:\/\/[^\s<>(){}"']+/iu
const RETRIEVAL = /\b(?:find|search|look\s+(?:up|for)|locate|show|show\s+me|get|give|list|fetch|pull\s+up|surface)\b/
const IMAGE = /\b(?:image|images|picture|pictures|photo|photos|photograph|photographs|wallpaper|wallpapers|screenshot|screenshots)\b/
const VIDEO = /\b(?:video|videos|clip|clips|youtube|vimeo|tutorial|tutorials|walkthrough|walkthroughs|talk|talks|lecture|lectures)\b/
const DOCUMENT = /\b(?:pdf|pdfs|document|documents|paper|papers|white\s?paper|white\s?papers|manual|manuals|datasheet|datasheets|spec\s+sheet|spec\s+sheets)\b/

function cleanUrl(raw: string): string {
  return raw.replace(/[.,!?;:]+$/u, '')
}

function requestedMediaVertical(lower: string): 'images' | 'videos' | 'documents' | null {
  if (!RETRIEVAL.test(lower)) {
    // Natural shorthand such as "images of Saturn" or "a video about queues".
    if (/\b(?:images?|pictures?|photos?)\s+(?:of|for|about|showing)\b/.test(lower)) return 'images'
    if (/\b(?:videos?|clips?|tutorials?|talks?)\s+(?:of|for|about|on|showing|explaining)\b/.test(lower)) return 'videos'
    if (/\b(?:pdfs?|documents?|papers?|manuals?)\s+(?:of|for|about|on|covering)\b/.test(lower)) return 'documents'
    return null
  }

  const candidates = [
    { type: 'images' as const, index: lower.search(IMAGE) },
    { type: 'videos' as const, index: lower.search(VIDEO) },
    { type: 'documents' as const, index: lower.search(DOCUMENT) },
  ].filter((entry) => entry.index >= 0)

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.index - b.index)
  return candidates[0]!.type
}

/**
 * Resolve the owner's own text and any composer-held hints into an initial tool call.
 *
 * The hint branch runs first and outranks text-derived intent. The old behaviour —
 * prepending a directive onto the owner's words — is gone: the stored user
 * message is the text alone, and the hint is policy the Mind reads here.
 *
 * `browserUse` alone does **not** produce an initial tool request unless the
 * owner's text contains an `http(s)` address. Without a URL there is nothing
 * safe to navigate to, and an empty `browser_read` is a tool call with no
 * address, which is the shape of a bug. The button then falls through to the
 * text-derived routes, exactly as a turn without the button does.
 *
 * `webSearch` produces a `web_search` request for the trimmed text. The vertical
 * falls through to the text-derived detection when the owner's words name one,
 * which is what keeps "find me videos about Saturn" landing on the video index
 * rather than a generic web lookup.
 */
export function initialToolRequestForOwnerText(
  text: string,
  hints?: TurnIntentHints,
): InitialToolRequest | null {
  const value = text.trim()
  if (value.length === 0) return null

  const lower = value.toLowerCase().replace(/\s+/gu, ' ')
  if (EXPLANATION_FRAME.test(lower)) return null

  // Hint-derived overrides run first because the button is the owner's stronger
  // commitment than the wording. A turn the owner already chose to web-search
  // does not need to mention a verb; the route is set.
  if (hints?.webSearch === true) {
    const vertical = requestedMediaVertical(lower)
    return {
      name: 'web_search',
      // Stored query is the owner's text, untouched. A button that added or
      // removed words would be the contamination this whole seam exists to
      // prevent, so the arguments reflect what the owner typed and nothing else.
      arguments: Object.freeze({
        query: value,
        type: vertical ?? 'web',
      }),
    }
  }

  if (hints?.browserUse === true) {
    // Browser use without an address is a turn the model has to fill in from the
    // model's own answer; the loop's normal path gets us there. If the owner
    // did supply an address, we honour it as an initial tool call — same as the
    // old text-prefixed branch did, but with the text unchanged.
    const match = HTTP_URL.exec(value)
    if (match === null) return null
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

  // Explicit browser control is stronger than media retrieval. "Use your browser
  // to find images..." means browser, because that is the capability the owner named.
  if (EXPLICIT_BROWSER.test(lower)) {
    const match = HTTP_URL.exec(value)
    if (match === null) return null
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

  const type = requestedMediaVertical(lower)
  if (type === null) return null
  return {
    name: 'web_search',
    arguments: Object.freeze({ query: value, type }),
  }
}

