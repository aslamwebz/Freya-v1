/**
 * Render the loop's own step records as the lines the chat shows in the
 * "What Freya did" panel.
 *
 * Using only the loop's record, never a prose-parsed footer, is the only way
 * the chat can be honest about a turn that narrated an act without
 * performing it: the Mind strips any model-written footer block from the
 * stored content, so the prose no longer carries a forgery, and the panel is
 * drawn from the records the tool loop actually produced.
 */
import type { ToolStepRecord } from '../../../core/mind/tools'

export function stepRecordsAsFooterLines(steps: readonly ToolStepRecord[]): string[] {
  return steps.map(step => {
    const tool = step.tool.replace(/_/g, ' ')
    const status = step.outcome === 'denied' ? 'Blocked' : step.outcome === 'failed' ? 'Failed' : 'Completed'
    const execution = step.executed ? 'tool ran' : 'tool did not run'
    const sources = step.sourceCount > 0 ? `; ${step.sourceCount} source${step.sourceCount === 1 ? '' : 's'} returned` : ''
    return `${tool}: ${status} — ${execution}${sources}.`
  })
}
export interface AssistantParts {
  /** Model reasoning. Empty when the model did not emit a thinking block. */
  readonly thinking: string
  /** The actual answer prose, with thinking + steps + sources removed. */
  readonly body: string
  /** Original stored footer text. Parsing it provides no proof of execution. */
  readonly footer: string
  /** Unverified lines parsed from the stored footer, excluding its source list. */
  readonly steps: readonly string[]
  /** Unverified source claims parsed from the stored footer. */
  readonly sources: readonly { rank: number; title: string; url: string }[]
  /** The typed sources the Mind attached to this turn. When present, the
   *  renderer uses these as evidence rather than footer-derived claims. */
  readonly typedSources?: readonly TypedSource[]
  /** Ranks cited in the answer body, in the order they appear. Used to
   *  split the typed sources into matched and related at render time. */
  readonly citedRanks: readonly number[]
  /** Sources the model actually cited in the answer body, derived from
   *  `typedSources` by intersecting with `citedRanks`. */
  readonly matchedSources: readonly TypedSource[]
  /** Sources the search returned that the model did not cite, in the
   *  order the search returned them. */
  readonly relatedSources: readonly TypedSource[]
}

/** A typed web source, mirrored from the Core `ToolSource`. */
export interface TypedSource {
  readonly title: string
  readonly url: string
  readonly sourceDomain: string
  readonly snippet: string
  readonly rank: number
  readonly retrievedAt: string | null
  readonly mediaUrl?: string | null
  readonly thumbnailUrl?: string | null
  readonly vertical?: string
  readonly duration?: string | null
}

const THINK_RE = /<think>([\s\S]*?)(?:<\/think>|$)/i
// The footer shape is owned by the Mind and lives in `core/mind/footerGuard.ts`
// alongside the strip that prevents a model from writing the same shape into its
// own reply. Importing the shared regex is what makes the two surfaces agree on
// what a footer is, and a divergence would be a forgery window.
import { FOOTER_HEAD } from '../../../core/mind/footerGuard'
const SOURCE_LINE = /^\[(\d+)\]\s+(.+?)\s+—\s+(\S+)\s*$/
// Same shape, but as an inline run inside a paragraph.
const SOURCE_INLINE = /\[(\d+)\]\s+(.+?)\s+—\s+(https?:\/\/\S+)/g

export function splitAssistantContent(
  content: string,
  typedSources?: readonly TypedSource[],
): AssistantParts {
  let working = content

  // 1. Pull the <think>…</think> block, if present, out of the head.
  let thinking = ''
  const thinkMatch = working.match(THINK_RE)
  if (thinkMatch !== null) {
    let rawThinking = thinkMatch[1] ?? ''
    const start = thinkMatch.index ?? -1
    let end = start + thinkMatch[0].length

    // If the match extended to the end without an explicit </think> close tag,
    // ensure any trailing system notice or preservation marker is preserved in working.
    if (!/<\/think>/i.test(thinkMatch[0])) {
      const noticeMatch = rawThinking.match(/\n\n(?:—\n[\s\S]*|\[Response safely preserved[\s\S]*)$/)
      if (noticeMatch !== null && noticeMatch.index !== undefined) {
        end = start + '<think>'.length + noticeMatch.index
        rawThinking = rawThinking.slice(0, noticeMatch.index)
      }
    }

    if (start >= 0) {
      thinking = rawThinking.trim()
      working = working.slice(0, start) + working.slice(end)
    }
  }

  // 2. Pull the trailing footer, if present, off the tail.
  let steps: string[] = []
  let footer = ''
  let sources: { rank: number; title: string; url: string }[] = []
  const footerMatch = working.match(FOOTER_HEAD)
  if (footerMatch !== null && (footerMatch.index ?? -1) >= 0) {
    footer = footerMatch[0].trim()
    const footerText = footerMatch[1] ?? ''
    const lines = footerText.split('\n')
    const collectedSteps: string[] = []
    const collectedSources: { rank: number; title: string; url: string }[] = []
    let inSources = false
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (line.length === 0) continue
      if (/^Sources:\s*/.test(line)) {
        inSources = true
        // Sources may also appear inline on the same line: "Sources: [1] A — url [2] B — url".
        const inline = line.replace(/^Sources:\s*/, '')
        for (const m of inline.matchAll(SOURCE_INLINE)) {
          collectedSources.push({
            rank: Number(m[1] ?? '0'),
            title: (m[2] ?? '').trim(),
            url: (m[3] ?? '').trim(),
          })
        }
        continue
      }
      if (inSources) {
        const sourceMatch = line.match(SOURCE_LINE)
        if (sourceMatch !== null) {
          collectedSources.push({
            rank: Number(sourceMatch[1] ?? '0'),
            title: (sourceMatch[2] ?? '').trim(),
            url: (sourceMatch[3] ?? '').trim(),
          })
        } else if (/^\(/.test(line)) {
          // "(\d further sources were not listed.)" — a note about truncation,
          // not a source. Append to the previous step so it is still honest.
          const last = collectedSteps[collectedSteps.length - 1]
          if (last !== undefined) collectedSteps[collectedSteps.length - 1] = `${last} ${line}`
        }
        continue
      }
      collectedSteps.push(line)
    }
    steps = collectedSteps
    sources = collectedSources
    const cutAt = footerMatch.index ?? working.length
    working = working.slice(0, cutAt)
  }

  // 3. Trim the body and drop a leading "—\n" the model sometimes leaves
  //    behind when it tries to set up its own separator.
  let body = working.replace(/\n{3,}/g, '\n\n').trim()
  body = body.replace(/^[ \t]*—[ \t]*\n+/, '')

  // 4. Split the typed sources into "matched" (cited in the answer body) and
  //    "related" (the rest of what the search returned). The rank marks in the
  //    body are the model's contract: whatever it wrote `[N]` for, it intended
  //    to cite; everything else came back from the search but did not make the
  //    cut. Cited ranks are de-duplicated and ordered by first appearance so
  //    the matched list reflects the answer, not the search order.
  const citedRanksSet = new Set<number>()
  const rankRe = /\[(\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = rankRe.exec(body)) !== null) {
    const n = Number(m[1] ?? '0')
    if (Number.isFinite(n) && n > 0) citedRanksSet.add(n)
  }
  const citedRanks: number[] = [...citedRanksSet]
  const matchedSources: TypedSource[] = []
  const relatedSources: TypedSource[] = []
  if (typedSources !== undefined) {
    const matchedSet = new Set(citedRanks)
    for (const source of typedSources) {
      if (matchedSet.has(source.rank)) matchedSources.push(source)
      else relatedSources.push(source)
    }
  }

  return { thinking, body, footer, steps, sources, typedSources, citedRanks, matchedSources, relatedSources }
}
