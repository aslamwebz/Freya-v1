/**
 * Deterministic tool intent for explicit owner-directed browser reads.
 *
 * This is intentionally much narrower than the renderer's general chat router.
 * It does not decide whether a question needs the web. It recognizes only the
 * case where the owner explicitly told Freya to use its own browser and supplied
 * the exact http(s) address to open.
 *
 * The result grants no authority. It is only an initial tool request; the
 * MindToolRegistry still evaluates browser.read through Guard immediately
 * before the browser body can run.
 */

export interface InitialToolRequest {
  readonly name: 'browser_read'
  readonly arguments: Readonly<Record<string, string>>
}

const EXPLANATION_FRAME =
  /^\s*(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:explain|describe|teach|walk\s+me)\b|^\s*(?:explain|describe|teach)\b/

const EXPLICIT_BROWSER =
  /\b(?:use|open|launch|start|drive|pilot|operate|control)\b[^.!?]{0,36}\b(?:your|freya'?s|the)\s+(?:own\s+)?browser\b|\byour\s+own\s+browser\b|\bin\s+(?:your|freya'?s)\s+(?:own\s+)?browser\b|\bbrowse\s+to\b/

const HTTP_URL = /https?:\/\/[^\s<>()\[\]{}"']+/iu

function cleanUrl(raw: string): string {
  return raw.replace(/[.,!?;:]+$/u, '')
}

export function initialToolRequestForOwnerText(text: string): InitialToolRequest | null {
  const value = text.trim()
  if (value.length === 0) return null

  const lower = value.toLowerCase().replace(/\s+/gu, ' ')
  if (EXPLANATION_FRAME.test(lower)) return null
  if (!EXPLICIT_BROWSER.test(lower)) return null

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
