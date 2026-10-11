import type { MindTool, CanvasKind } from './types'
import { MIND_TOOL_LIMITS } from './limits'
import { boundCanvas, readCanvasLanguage } from './artifact-bounds'

/**
 * The canvas opener.
 *
 * A long-form artifact (a report, a plan, a landing page, a small web app) is
 * not a paragraph. The chat says "I made X" in one or two sentences; the
 * canvas carries the thing, editable in a side panel. The model passes the
 * whole content here so the renderer never has to re-parse prose to find a
 * document body.
 *
 * Capability: `search.web`. Same gate as the chart tool: the owner is the only
 * principal that holds it, and a canvas is a visible artifact produced
 * alongside an answer.
 */
export function createCanvasTool(): MindTool {
  return {
    name: 'open_canvas',
    description:
      'Open a side canvas beside the chat with something you made, for the person to read, edit and copy. '
      + 'Use it whenever the answer is a long document, a small web page, a program, or anything longer than '
      + 'a short paragraph. The chat itself should say in one or two sentences what you made, then refer to '
      + 'the canvas. Pass the whole body as `content`.',
    capability: 'search.web',
    parameters: [
      { name: 'title', description: 'A short title, e.g. "Q3 sales report" or "Bakery landing page".', required: true },
      { name: 'kind', description: '`document` for writing; `code` for a program or web page.', required: true },
      { name: 'language', description: 'The content language: `markdown`, `html`, `javascript`, `python`, `css`, `json` or `text`.', required: true },
      { name: 'content', description: 'The full body of the document or program.', required: true, maxChars: MIND_TOOL_LIMITS.maxCanvasChars, multiline: true },
    ],
    async run(request) {
      const title = request.arguments['title'] ?? ''
      if (title.trim().length === 0) throw new Error('the canvas title was empty')
      const kind = readCanvasKind(request.arguments['kind'])
      const language = readCanvasLanguage(request.arguments['language'])
      const content = request.arguments['content'] ?? ''
      if (content.trim().length === 0) throw new Error('the canvas content was empty')
      const canvas = boundCanvas({ title, kind, language, content })
      return {
        summary: `Opened a ${kind} canvas "${canvas.title}" (${canvas.content.length} characters).`,
        sources: [],
        canvas,
      }
    },
  }
}

function readCanvasKind(value: unknown): CanvasKind {
  if (typeof value !== 'string') return 'document'
  const asked = value.trim().toLowerCase()
  if (asked === 'code' || asked === 'program' || asked === 'app' || asked === 'page' || asked === 'web' || asked === 'html' || asked === 'javascript' || asked === 'python' || asked === 'css' || asked === 'json') return 'code'
  return 'document'
}
