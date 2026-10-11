import { MIND_TOOL_LIMITS } from './limits'
import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from './markers'
import { sanitiseArgumentText } from './text'

/**
 * What a provider response turned out to be.
 *
 * `answer` and `request` are the two honest readings of the same text. `invalid`
 * exists for the third case — the model clearly *meant* to ask for a tool and
 * wrote something unreadable — and it is separated rather than folded into
 * `answer` so that the loop can tell the model its request was malformed instead
 * of storing a JSON fragment as if it were the answer to the owner's question.
 */
export type ParsedToolResponse =
  | { readonly kind: 'answer' }
  | { readonly kind: 'request'; readonly tool: string; readonly arguments: Readonly<Record<string, string>> }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Read one provider response as either an answer or a tool request.
 *
 * This was "the envelope must be the entire response", and live acceptance broke
 * it: `qwen/qwen3.8-27b-uncensored` narrated first -- "I'll do this with two
 * tools: a web_search for the doc page, and a browser_read for the section
 * anchor." -- and then wrote a correct envelope. The strict reading discarded the
 * whole reply, and because an unreadable envelope was also being treated as an
 * ordinary answer, the owner was shown a raw `FREYA_TOOL_CALL` JSON block as
 * though it were Freya's reply. That second half was the real defect.
 *
 * The envelope is now located rather than assumed, with three limits that keep the
 * original protection: exactly **one** envelope; **bounded** surrounding prose,
 * which is discarded rather than read; and a present-but-unreadable envelope is
 * `invalid`, never `answer`. That last one is the point -- protocol syntax must
 * never reach a transcript as if it were prose.
 *
 * The injection risk strictness was serving is real, since untrusted page text can
 * reach the model inside an observation. It is not answered by demanding position
 * zero, because a tool call is only ever a *request*: {@link MindToolRegistry.invoke}
 * refuses an unknown name and evaluates Guard before any body runs, so a smuggled
 * envelope buys nothing it could not have asked for by asking.
 *
 * A name outside the registry is not rejected here. This function has no
 * registry; {@link MindToolRegistry.invoke} is what refuses an unknown name, and
 * it refuses it under Guard like any other request.
 */
export function parseToolResponse(text: string, known: (name: string) => boolean): ParsedToolResponse {
  // A reasoning model may put its chain of thought in the same reply, sometimes in
  // the same message as the request. A closed reasoning block is presentation, not
  // protocol: strip it before anything else, so its length cannot make a real
  // request look like "mostly prose". An unclosed tag is left alone, because the
  // request may sit after it and there is no reliable end to cut at.
  const withoutReasoning = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/giu, '')
  let trimmed = withoutReasoning.trim()

  // Clean leading provider delimiter noise if attached to tool envelope
  trimmed = trimmed.replace(/\]?<\]minimax(?:\[>\[|\[\[|\[>|\[|\])?/gi, '')

  // Determine whether this text carries a Freya tool envelope or an alternative provider tool envelope.
  const freyaOpen = trimmed.indexOf(TOOL_CALL_OPEN)
  const altMatch = trimmed.match(/\[?<tool_call>\]?/i)
  const toolUseMatch = trimmed.match(/(?:يا-?|-)?ToolUse\|/i)
  const hasAlt = altMatch && altMatch.index !== undefined
  const hasToolUse = toolUseMatch && toolUseMatch.index !== undefined

  // Neither envelope present -> this is a direct prose answer.
  if (freyaOpen === -1 && !hasAlt && !hasToolUse) return { kind: 'answer' }

  // Use the envelope that appears first if multiple are present
  type EnvelopeKind = 'freya' | 'alt' | 'toolUse'
  let bestKind: EnvelopeKind = 'freya'
  let bestIndex = freyaOpen !== -1 ? freyaOpen : Infinity

  if (hasAlt && altMatch.index! < bestIndex) {
    bestKind = 'alt'
    bestIndex = altMatch.index!
  }
  if (hasToolUse && toolUseMatch.index! < bestIndex) {
    bestKind = 'toolUse'
    bestIndex = toolUseMatch.index!
  }

  const open = bestIndex
  const useFreya = bestKind === 'freya'
  let openMarker: string
  let closePattern: RegExp

  if (bestKind === 'freya') {
    openMarker = TOOL_CALL_OPEN
    closePattern = /FREYA_TOOL_CALL_END/u
  } else if (bestKind === 'alt') {
    openMarker = altMatch![0]
    closePattern = /\[?<\/tool_call>\]?/i
  } else {
    openMarker = toolUseMatch![0]
    closePattern = /-?ToolUse\|/i
  }

  let closing = -1
  let closeMarkerLen = 0
  if (bestKind === 'freya') {
    closing = trimmed.indexOf(TOOL_CALL_CLOSE, open)
    closeMarkerLen = TOOL_CALL_CLOSE.length
  } else {
    const closeMatch = trimmed.slice(open + openMarker.length).match(closePattern)
    if (closeMatch && closeMatch.index !== undefined) {
      closing = open + openMarker.length + closeMatch.index
      closeMarkerLen = closeMatch[0].length
    }
  }

  if (closing === -1) {
    // Some text-only providers emit the entire JSON object but omit just the
    // closing sentinel. Recover ONLY an exact single JSON object with a known
    // tool and at least one valid string argument; no prose, fences, trailing
    // bytes, or multiple requests can enter this compatibility path.
    const candidate = trimmed.slice(open + openMarker.length).trim()
    const proseBefore = trimmed.slice(0, open).trim()
    const cleanCandidate = candidate
      .replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/u, '')
      .replace(/\r?\n?```$/u, '')
      .trim()
    const cleanProseBefore = proseBefore.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/giu, '').trim()
    const allowUnclosed = useFreya ? open === 0 : cleanProseBefore.length <= MIND_TOOL_LIMITS.maxToolCallProseChars
    if (allowUnclosed && cleanCandidate.length <= MIND_TOOL_LIMITS.maxCanvasChars) {
      // A missing closing sentinel is recoverable only for a complete, single
      // JSON object. Never silently execute the first item in a list/stream.
      if (cleanCandidate.startsWith('{') && cleanCandidate.endsWith('}')) {
        try {
          const value: unknown = JSON.parse(cleanCandidate)
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const record = value as Record<string, unknown>
            const name = record['tool'] ?? record['name']
            if (typeof name === 'string' && known(name)
                && Object.entries(record).some(([key, item]) => key !== 'tool' && key !== 'name' && typeof item === 'string' && item.trim().length > 0)) {
              if (name !== 'workspace_save_report' && name !== 'open_canvas' && cleanCandidate.length > MIND_TOOL_LIMITS.maxRequestChars) {
                return { kind: 'invalid', reason: 'the tool request was too long to be read' }
              }
              return { kind: 'request', tool: name, arguments: readArguments(record) }
            }
          }
        } catch { /* Malformed or partial JSON must never execute. */ }
      }
    }
    return { kind: 'invalid', reason: 'the tool request was not closed' }
  }

  // Two envelopes is not a request; it is a reply that could be read two ways.
  const afterClose = closing + closeMarkerLen
  const rest = trimmed.slice(afterClose)
  if (rest.indexOf(TOOL_CALL_OPEN) !== -1 || /\[?<tool_call>\]?|(?:يا-?|-)?ToolUse\|/i.test(rest)) {
    return { kind: 'invalid', reason: 'the reply contained more than one tool request' }
  }

  // Surrounding prose is discarded, never read. Capped so a long ramble cannot
  // ride along with a request. Thinking blocks are presentation, never prose.
  const cleanProseHead = trimmed.slice(0, open).replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/giu, '').trim()
  const cleanRest = rest.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/giu, '').trim()
  const prose = cleanProseHead.length + cleanRest.length
  if (prose > MIND_TOOL_LIMITS.maxToolCallProseChars) {
    return { kind: 'invalid', reason: 'the reply was mostly prose around a tool request' }
  }

  let body = trimmed.slice(open + openMarker.length, closing).trim()
  // Models habitually wrap JSON in a Markdown code fence, even inside the
  // envelope. The fence is presentation; the JSON inside it is the request. Strip
  // a surrounding ```lang ... ``` pair so a good request is not lost to it. A body
  // with no fence is untouched, because the leading pattern requires the backticks.
  body = body
    .replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/u, '')
    .replace(/\r?\n?```$/u, '')
    .trim()
  if (body.length === 0) {
    return { kind: 'invalid', reason: 'the tool request was empty' }
  }
  if (body.length > MIND_TOOL_LIMITS.maxCanvasChars) {
    return { kind: 'invalid', reason: 'the tool request was too long to be read' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Concatenated tool objects are not one request. Reject rather than
    // silently running only the first action.
    return { kind: 'invalid', reason: 'the tool request was not valid JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'the tool request was not a single object' }
  }
  const record = parsed as Record<string, unknown>

  const name = record['tool'] ?? record['name']
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    return { kind: 'invalid', reason: 'the tool request did not name a tool' }
  }
  if (name !== 'workspace_save_report' && name !== 'open_canvas' && body.length > MIND_TOOL_LIMITS.maxRequestChars) {
    return { kind: 'invalid', reason: 'the tool request was too long to be read' }
  }
  if (!known(name)) {
    // Not malformed — refused. Kept distinct so the loop reports "no such tool"
    // rather than "you wrote nonsense".
    return { kind: 'request', tool: name, arguments: readArguments(record) }
  }

  return { kind: 'request', tool: name, arguments: readArguments(record) }
}

/** Read `tool`'s siblings (or input object properties) as bounded strings, ignoring everything else. */
function readArguments(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  const toolName = record['tool'] ?? record['name']
  const source = record.input && typeof record.input === 'object' && !Array.isArray(record.input)
    ? record.input as Record<string, unknown>
    : record
  for (const [key, value] of Object.entries(source)) {
    if (key === 'tool' || key === 'name' || key === 'input') continue
    if (typeof value !== 'string') continue
    // Larger content is permitted only for the named, Guard-controlled artifact tools.
    const maxChars = key === 'content' && toolName === 'workspace_save_report'
      ? 32_000
      : key === 'content' && toolName === 'open_canvas'
        ? MIND_TOOL_LIMITS.maxCanvasChars
        : MIND_TOOL_LIMITS.maxRequestChars
    out[key] = sanitiseArgumentText(value, maxChars, true)
  }
  return out
}
