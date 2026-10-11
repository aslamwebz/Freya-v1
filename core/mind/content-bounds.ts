import { mediaFromObservations } from '../media/collect'
import type { MediaItem } from '../media/types'
import type { ChartSpec, CanvasSpec, ToolObservation, ToolSource } from './tools'
import { CONVERSATION_LIMITS } from '../conversation/types'
/**
 * The stored transcript entry for a turn whose answer was cut off.
 *
 * Two parts, and the second is the reason this function exists at all.
 *
 * **What the model actually produced**, unchanged, because throwing it away would
 * be its own kind of dishonesty — the owner can see that the first half of an
 * answer was real. It is placed first and immediately followed by the notice, so
 * there is no reading of the transcript in which the text above looks finished.
 * (This is the same shape as `renderToolFooter`: the model's words, then a truth
 * about them that the model cannot remove and no instruction can suppress.)
 *
 * **The notice**, written here in code from the provider's own finish reason. It
 * never guesses at the missing text, never paraphrases it, and never implies a
 * different answer was received. There is nothing to complete it with, so it
 * completes nothing: it says the answer stopped, and that the rest was never
 * generated.
 *
 * No retry happens here, and none is implied by the wording. Raising the ceiling
 * would change what a turn costs, which is a decision this code does not get to
 * make on the owner's behalf.
 */
export function renderTruncatedAnswer(text: string, footer = ''): string {
  let produced = text.trim()
  if (/<think(?:ing)?>/i.test(produced) && !/<\/think(?:ing)?>/i.test(produced)) {
    produced = `${produced}\n</think>`
  }
  const body = [produced, footer.trim()].filter((part) => part !== '').join('\n\n')
  const lead = body === '' ? '' : `${body}\n\n—\n`
  const before = produced === '' ? 'Freya produced no text at all. ' : 'Everything above is all that was produced. '
  return `${lead}${before}The reply was cut off before it finished, so it is incomplete and is not ` +
    `Freya's finished answer. The rest was never generated and has not been guessed at.`
}


/**
 * The `media` field for a stored answer, or nothing at all.
 *
 * Spread rather than assigned, so a turn that looked nothing up stores no `media` key
 * at all instead of an empty array — the difference between "there was nothing" and
 * "there was an empty list", which a later reader cannot otherwise tell apart.
 */
export function mediaField(observations: readonly ToolObservation[]): { media?: readonly MediaItem[] } {
  const media = mediaFromObservations(observations)
  return media.length === 0 ? {} : { media }
}

/**
 * The web search sources behind this turn, as typed rows beside the prose.
 *
 * Every observation the tools returned contributes its `sources`; the list is
 * flattened, de-duplicated by URL, and capped so an unusually rich search does
 * not blow up the journal. The renderer splits it at draw time into "matched"
 * (cited in the answer prose) and "related" (the rest of what came back).
 *
 * Returns an empty object — not an empty list — when nothing was found, so the
 * field's absence stays distinct from "found an empty list".
 */
export function sourcesField(observations: readonly ToolObservation[], cap: number, carried: readonly ToolSource[] = []): { sources?: readonly ToolSource[] } {
  const seen = new Set<string>()
  const collected: ToolSource[] = []
  for (const source of carried) {
    if (collected.length >= cap) break
    if (seen.has(source.url)) continue
    seen.add(source.url)
    collected.push(source)
  }
  for (const observation of observations) {
    if (observation.kind !== 'ok') continue
    for (const source of observation.sources) {
      const existing = collected.findIndex(item => item.url === source.url)
      if (existing !== -1) {
        // A new successful lookup updates the evidence, retaining the ledger's
        // citation identity rather than presenting an older carried snippet.
        collected[existing] = source
        continue
      }
      if (collected.length >= cap) return { sources: collected }
      if (seen.has(source.url)) continue
      seen.add(source.url)
      collected.push(source)
    }
  }
  return collected.length === 0 ? {} : { sources: collected }
}

/**
 * The typed charts the model produced for this turn.
 *
 * Like `media` and `sources`, the data travels beside the prose as a typed
 * artifact the renderer can draw without re-parsing. The journal keeps the
 * literal model text; the chart is the only honest way to display the
 * numbers, because a renderer that read numbers out of a paragraph would be
 * drawing from a guess, not a measurement.
 */
export function chartsField(observations: readonly ToolObservation[]): { charts?: readonly ChartSpec[] } {
  const collected: ChartSpec[] = []
  for (const observation of observations) {
    if (observation.kind !== 'ok') continue
    if (observation.chart === undefined) continue
    collected.push(observation.chart)
  }
  return collected.length === 0 ? {} : { charts: collected }
}

/**
 * The long-form artifact the model opened beside this turn, if any.
 *
 * Only one canvas per turn is kept — the chat says "I made X" and the canvas
 * carries the thing, so a turn that opened more than one is the kind of
 * answer that does not know what it is. The renderer opens a side panel for
 * the latest one, so the chat and the panel stay in sync.
 */
export function canvasField(observations: readonly ToolObservation[]): { canvas?: CanvasSpec } {
  let latest: CanvasSpec | null = null
  for (const observation of observations) {
    if (observation.kind !== 'ok') continue
    if (observation.canvas === undefined) continue
    latest = observation.canvas
  }
  return latest === null ? {} : { canvas: latest }
}


export function boundAssistantMessageContent(
  content: string,
  limit: number = CONVERSATION_LIMITS.maxMessageCharacters,
): string {
  if (content.length <= limit) return content
  const notice = '\n\n[Response safely preserved up to maximum message length]'
  const sliceLen = Math.max(0, limit - notice.length)

  // When a message has both thinking and body, do not let an oversized thinking
  // block consume the whole message budget and erase the visible answer.
  const thinkMatch = content.match(/^(<think(?:ing)?>)([\s\S]*?)(<\/think(?:ing)?>)([\s\S]*)$/i)
  if (thinkMatch) {
    const openTag = thinkMatch[1] ?? '<think>'
    const thinkingText = thinkMatch[2] ?? ''
    const closeTag = thinkMatch[3] ?? '</think>'
    const body = (thinkMatch[4] ?? '').trim()
    if (body.length > 0) {
      const overhead = openTag.length + closeTag.length + 2 + notice.length
      const bodyMax = Math.max(0, Math.min(body.length, limit - overhead - 200))
      const thinkingMax = Math.max(0, limit - overhead - bodyMax)
      const preservedThinking = thinkingText.length > thinkingMax
        ? `${thinkingText.slice(0, Math.max(0, thinkingMax - 30))}\n[Thinking trace summarized]`
        : thinkingText
      const preservedBody = body.length > bodyMax ? `${body.slice(0, bodyMax)}${notice}` : body
      return `${openTag}${preservedThinking}${closeTag}\n\n${preservedBody}`
    }
  }

  let sliced = content.slice(0, sliceLen)
  if (/<think(?:ing)?>/i.test(sliced) && !/<\/think(?:ing)?>/i.test(sliced)) {
    const closeTag = '\n</think>'
    const adjustedLen = Math.max(0, sliceLen - closeTag.length)
    sliced = `${content.slice(0, adjustedLen)}${closeTag}`
  }
  return `${sliced}${notice}`
}
