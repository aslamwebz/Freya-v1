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
 */

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
  /\b(?:use|open|launch|start|drive|pilot|operate|control)\b[^.!?]{0,36}\b(?:your|freya'?s|the)\s+(?:own\s+)?browser\b|\byour\s+own\s+browser\b|\bin\s+(?:your|freya'?s)\s+(?:own\s+)?browser\b|\bbrowse\s+to\b/

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

export function initialToolRequestForOwnerText(text: string): InitialToolRequest | null {
  const value = text.trim()
  if (value.length === 0) return null

  const lower = value.toLowerCase().replace(/\s+/gu, ' ')
  if (EXPLANATION_FRAME.test(lower)) return null

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
