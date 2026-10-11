import type { SearchVertical } from '../../research/types'
import { videoDurationConstraint, matchesVideoDuration } from '../../research/video-duration'
import type { MindTool, ToolSource } from './types'
import { MIND_TOOL_LIMITS } from './limits'
import { toSource } from './source-bounds'

/* ------------------------------------------------------------- the search tool */

/**
 * The one tool that ships, and it is an adapter, not a search system.
 *
 * `searchWeb` is `ResearchIntegration.searchWeb` — the existing seam, already
 * Guard-gated on `search.web` inside `core/research/coreIntegration.ts`. Calling
 * it means the turn reuses the one Searcher, the one provider, the one approval
 * path and the one abort path the system already has. There is no second
 * browser, no second engine and no credential here.
 *
 * Rows arrive as `unknown` and are narrowed below, because a provider's rows are
 * remote input even when the code that fetched them was ours.
 */
export function createWebSearchTool(options: {
  /**
   * Runs one query in one vertical.
   *
   * The vertical is named rather than implied because the model chooses it, and it
   * cannot choose what it is not offered: without this the tool could only ever search
   * the web, so "find me pictures of the telescope" came back as links to pages *about*
   * telescopes — and the model, having no image tool, said so rather than inventing
   * one. Asking for images and asking for pages are different searches with different
   * results, and only the first returns something a card can draw.
   */
  readonly searchWeb: (
    query: string,
    vertical: SearchVertical,
    signal?: AbortSignal,
    site?: string,
  ) => Promise<readonly unknown[]>
  readonly now?: () => Date
  readonly maxResults?: number
  readonly verticals?: readonly SearchVertical[]
}): MindTool {
  const now = options.now ?? (() => new Date())
  const maxResults = Math.min(options.maxResults ?? MIND_TOOL_LIMITS.maxResultsPerTool, MIND_TOOL_LIMITS.maxResultsPerTool)

  return {
    name: 'web_search',
    description:
      'Search the public web and return ranked results with their titles, URLs and snippets. '
      + 'Name the kind of thing being looked for, so the right index is searched.',
    capability: 'search.web',
    parameters: [
      { name: 'query', description: 'the search query', required: true },
      {
        name: 'type',
        description: 'what to look for: web (default), images, videos, documents, audio or pages',
        required: false,
      },
      { name: 'site', description: 'optional domain constraint, independent of media type', required: false },
    ],
    async run(request) {
      const query = request.arguments['query'] ?? ''
      if (query.trim().length === 0) throw new Error('the search query was empty')
      const vertical = readVertical(request.arguments['type'], options.verticals ?? DEFAULT_VERTICALS)
      const rows = await options.searchWeb(query, vertical, request.signal, request.arguments['site'])
      const duration = videoDurationConstraint(request.context?.ownerText ?? query)
      const at = now().toISOString()
      const results: ToolSource[] = []
      for (const row of rows.slice(0, 100)) {
        const source = toSource(row, results.length + 1, at)
        if (source !== null && (!duration || (vertical === 'videos' && matchesVideoDuration(source.duration, duration)))) results.push(source)
        if (results.length >= maxResults) break
      }
      return {
        summary:
          results.length === 0
            ? `The ${vertical} search for "${query}" returned nothing.${duration ? ' No returned video had a reported duration matching the owner’s constraint; unknown runtimes were excluded.' : ''}`
            : `The ${vertical} search for "${query}" returned ${results.length} result${results.length === 1 ? '' : 's'}.`,
        sources: results,
      }
    },
  }
}

/** The verticals a search may name, in the words the model is offered. */
const DEFAULT_VERTICALS = ['web', 'images', 'videos', 'documents', 'audio', 'pages'] as const satisfies readonly SearchVertical[]

/**
 * The vertical a request asked for, or `web`.
 *
 * An unknown word is `web` rather than a refusal: the model naming a kind this build
 * does not have should still get an answer, and the alternative — throwing away a
 * perfectly good query because of one bad adjective — helps nobody.
 */
function readVertical(value: unknown, allowed: readonly SearchVertical[]): SearchVertical {
  if (typeof value !== 'string') return 'web'
  const asked = value.trim().toLowerCase()
  const match = allowed.find((vertical) => vertical === asked)
  if (match !== undefined) return match
  // A couple of words people and models both reach for, mapped rather than refused.
  if (asked === 'image' || asked === 'picture' || asked === 'photo') return 'images'
  if (asked === 'video' || asked === 'clip') return 'videos'
  if (asked === 'document' || asked === 'pdf' || asked === 'file') return 'documents'
  return 'web'
}
