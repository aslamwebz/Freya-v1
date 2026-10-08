/**
 * Split an assistant message's stored `content` into the parts the renderer
 * actually wants to show.
 *
 * The journal keeps the literal text the model produced plus the tool footer
 * the Mind appends (see `core/mind/tools.ts` `renderToolFooter`). The visible
 * surface should not dump either of those into the same paragraph as the
 * answer. This function finds them, returns them as named pieces, and leaves
 * a clean prose body in the middle.
 *
 * The parser is deliberately small. It is not Markdown and it is not
 * Markdown-aware: it only looks for the two structural markers Freya itself
 * emits (`<think>…</think>` and the `—\nWhat Freya did for this answer:`
 * footer). Anything that does not match falls through to `body` and is
 * rendered normally.
 */
export interface AssistantParts {
  /** Model reasoning. Empty when the model did not emit a thinking block. */
  readonly thinking: string
  /** The actual answer prose, with thinking + steps + sources removed. */
  readonly body: string
  /** Lines from the "What Freya did for this answer" footer, excluding the
   *  sources list. Empty when the turn did not run any lookups. */
  readonly steps: readonly string[]
  /** Sources the footer listed, as `{ rank, title, url }` triples. Empty
   *  when the turn had no successful lookups. */
  readonly sources: readonly { rank: number; title: string; url: string }[]
}

const THINK_RE = /<think>([\s\S]*?)(?:<\/think>|$)/i
// The footer may be headed by a bare em-dash and `What Freya did...` either on
// the next line or on the same line, with any amount of whitespace. The Mind
// emits `—\nWhat Freya did...`; the model sometimes re-emits it as one paragraph.
const FOOTER_HEAD = /[ \t]*—[ \t]*(?:\n|\s)+What Freya did for this answer:[ \t]*(?:\n|$)([\s\S]*)$/
const SOURCE_LINE = /^\[(\d+)\]\s+(.+?)\s+—\s+(\S+)\s*$/
// Same shape, but as an inline run inside a paragraph.
const SOURCE_INLINE = /\[(\d+)\]\s+(.+?)\s+—\s+(https?:\/\/\S+)/g

export function splitAssistantContent(content: string): AssistantParts {
  let working = content

  // 1. Pull the <think>…</think> block, if present, out of the head.
  let thinking = ''
  const thinkMatch = working.match(THINK_RE)
  if (thinkMatch !== null) {
    const rawThinking = thinkMatch[1] ?? ''
    const start = thinkMatch.index ?? -1
    const end = start + thinkMatch[0].length
    if (start >= 0) {
      thinking = rawThinking.trim()
      working = working.slice(0, start) + working.slice(end)
    }
  }

  // 2. Pull the trailing footer, if present, off the tail.
  let steps: string[] = []
  let sources: { rank: number; title: string; url: string }[] = []
  const footerMatch = working.match(FOOTER_HEAD)
  if (footerMatch !== null && (footerMatch.index ?? -1) >= 0) {
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

  return { thinking, body, steps, sources }
}
