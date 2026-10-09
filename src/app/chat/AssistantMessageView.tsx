import type { ReactNode } from 'react'
import { RichMessage, type RichCitation } from './RichMessage'
import { splitAssistantContent, stepRecordsAsFooterLines, type TypedSource } from './assistantParts'
import { ChartView, type ChartSpec } from './ChartView'
import type { ToolStepRecord } from '../../../core/mind/tools'

export interface AssistantMessageViewProps {
  /** The literal text the journal stored for this assistant message. */
  readonly content: string
  /** Hand the renderer's link opener down so citations are still navigable. */
  readonly onOpenLink?: (url: string, provenance?: { readonly kind: 'citation' | 'source' | 'inline'; readonly title?: string }) => void
  /** Provenance counts `RichMessage` already understands. */
  readonly retrieved?: number
  /** Count of typed media items (search results, images, etc.). */
  readonly mediaCount?: number
  /**
   * Typed web sources the Mind attached beside the prose. When present, the
   * renderer uses them as the source of truth (split into matched/related by
   * which ranks the answer body cited). Prose footers are not source evidence.
   */
  readonly sources?: readonly TypedSource[]
  /** Typed media citation table for turns without separate web sources. */
  readonly citations?: readonly RichCitation[]
  /**
   * Typed charts the model produced for this answer. The renderer draws them
   * from the data the model returned, not from prose, so a chart cannot be a
   * guess about numbers. One or many.
   */
  readonly charts?: readonly ChartSpec[]
  /**
   * The loop's own record of the tool steps this turn ran, in order.
   *
   * When present, the "What Freya did" panel is drawn from these records
   * rather than from the prose-parsed footer, so a turn that narrated an act
   * in prose but did not perform it cannot show a fabricated footer. When
   * absent, the panel is not rendered — a turn that looked nothing up has
   * nothing to say about what it did, and a model that wrote a footer
   * anyway has had the block stripped from the stored content by the Mind.
   */
  readonly steps?: readonly ToolStepRecord[]
  /** Optional handler to inspect tool execution trace in the right workspace. */
  readonly onOpenExecution?: () => void
  /** Optional handler to view a chart in the right workspace. */
  readonly onOpenChart?: (index: number) => void
  /** Optional children rendered below the answer body, e.g. a media grid. */
  readonly children?: ReactNode
}

function SourcePreview({ source, onOpen }: { source: TypedSource; onOpen?: (url: string, title: string) => void }) {
  return <li className="f-assistant-source-card">
    <span className="f-assistant-source-rank">[{source.rank}]</span>
    <div>
      <button type="button" className="f-assistant-source-link" disabled={onOpen === undefined}
        onClick={() => onOpen?.(source.url, source.title)} title={source.url}>{source.title}</button>
      <div className="f-assistant-source-origin"><span>{source.sourceDomain}</span>
        {source.retrievedAt && Number.isFinite(Date.parse(source.retrievedAt))
          ? <time dateTime={source.retrievedAt} title={source.retrievedAt}>Retrieved {source.retrievedAt.slice(0, 10)}</time> : null}
      </div>
      {source.snippet ? <p className="f-assistant-source-snippet">{source.snippet}</p> : null}
    </div>
  </li>
}

/**
 * Render an assistant message the way a reader actually wants it.
 *
 * The journal stores the model's words, the model's `<think>` block, the
 * tool footer the Mind appends, the typed media items, and the typed web
 * sources. Showing all of that in one paragraph is what made the chat look
 * like a log dump. This view splits the stored content into its parts and
 * renders each one where it belongs: reasoning behind a closed disclosure,
 * the answer directly on the chat surface, the "What Freya did" trace
 * behind another disclosure, the matched sources as inline citation pills,
 * and the related sources (everything else the search returned) behind a
 * closed "Show related" disclosure.
 *
 * The journal is still the source of truth — nothing here throws the
 * literal text away. The view just shows less of it by default.
 */
export function AssistantMessageView({
  content,
  onOpenLink,
  retrieved,
  mediaCount,
  sources,
  citations,
  charts,
  steps,
  onOpenExecution,
  onOpenChart,
  children,
}: AssistantMessageViewProps) {
  const parts = splitAssistantContent(content, sources)
  const hasThinking = parts.thinking.length > 0
  const stepLines = stepRecordsAsFooterLines(steps ?? [])
  const unverifiedFooter = stepLines.length === 0 ? parts.footer : ''
  const hasSteps = stepLines.length > 0
  const hasMatched = parts.matchedSources.length > 0
  const hasRelated = parts.relatedSources.length > 0
  const searches = (steps ?? []).filter(step => step.tool === 'web_search')
  const failedSearch = searches.some(step => step.outcome === 'failed')
  const deniedSearch = searches.some(step => step.outcome === 'denied')
  const searchStatus = failedSearch ? 'Search failed. No sources were retrieved for the failed step.'
    : deniedSearch ? 'Search was blocked. No sources were retrieved for the blocked step.'
      : searches.length > 0 && searches.every(step => step.sourceCount === 0) ? 'The search returned no sources.' : ''
  const hasMeta = hasThinking || hasSteps || hasMatched || hasRelated || unverifiedFooter.length > 0
    || (retrieved !== undefined && retrieved > 0) || (mediaCount !== undefined && mediaCount > 0)

  // Ranks need not be contiguous or arrive in array order. Missing ranks stay
  // literal text in RichMessage; they must not point at another source.
  const typedCitations: RichCitation[] = []
  const rankCounts = new Map<number, number>()
  for (const source of sources ?? []) rankCounts.set(source.rank, (rankCounts.get(source.rank) ?? 0) + 1)
  for (const source of sources ?? []) {
    if (Number.isInteger(source.rank) && source.rank > 0 && source.rank <= 1000 && rankCounts.get(source.rank) === 1) {
      typedCitations[source.rank - 1] = { url: source.url, title: source.title, host: source.sourceDomain }
    }
  }

  const openCitation = (url: string, title: string) => {
    onOpenLink?.(url, { kind: 'citation', title })
  }

  return (
    <div className="f-assistant">
      {hasThinking ? (
        <details className="f-assistant-thinking">
          <summary>
            <span className="f-assistant-thinking-dot" aria-hidden="true" />
            <span>Thinking</span>
          </summary>
          <pre className="f-assistant-thinking-body">{parts.thinking}</pre>
        </details>
      ) : null}

      <div className="f-assistant-bubble">
        {parts.body.length > 0 ? (
          <RichMessage
            content={parts.body}
            citations={sources && sources.length > 0 ? typedCitations : citations}
            onOpenLink={onOpenLink}
            enableCodeCopy
            enableToc
            collapseAbove={2400}
            provenance={retrieved !== undefined && retrieved > 0 ? { retrieved } : undefined}
          />
        ) : (
          <p className="f-assistant-empty">Freya did not return a written answer for this turn.</p>
        )}
        {charts !== undefined && charts.length > 0 ? (
          <div className="f-assistant-charts">
            {charts.map((chart, index) => (
              <div key={`c-${index}-${chart.title}`} className="f-assistant-chart-card">
                <ChartView chart={chart} />
                {onOpenChart ? (
                  <div className="f-assistant-chart-actions">
                    <button
                      type="button"
                      className="f-chart-workspace-btn"
                      onClick={() => onOpenChart(index)}
                      aria-label={`View ${chart.title} in right workspace`}
                    >
                      View in workspace
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {children}
      </div>

      {hasMeta ? (
        <footer className="f-assistant-meta">
          {searchStatus ? <p className="f-assistant-search-status" role="status">{searchStatus}</p> : null}
          {hasMatched ? (
            <ol className="f-assistant-sources" aria-label="Sources cited in the answer">
              {parts.matchedSources.map((source) => (
                <SourcePreview key={`m-${source.rank}-${source.url}`} source={source} onOpen={onOpenLink ? openCitation : undefined} />
              ))}
            </ol>
          ) : null}
          {hasRelated ? (
            <details className="f-assistant-related">
              <summary>
                Show related ({parts.relatedSources.length})
              </summary>
              <ol className="f-assistant-sources f-assistant-related-list" aria-label="Related sources">
                {parts.relatedSources.map((source) => (
                  <SourcePreview key={`r-${source.rank}-${source.url}`} source={source} onOpen={onOpenLink ? openCitation : undefined} />
                ))}
              </ol>
            </details>
          ) : null}
          {hasSteps ? (
            <details className="f-assistant-steps">
              <summary>
                <span>What Freya did for this answer</span>
                {onOpenExecution ? (
                  <button
                    type="button"
                    className="f-assistant-steps-action"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onOpenExecution()
                    }}
                    aria-label="Inspect execution steps in right workspace"
                  >
                    Inspect in workspace
                  </button>
                ) : null}
              </summary>
              <ul>
                {stepLines.map((line, index) => <li key={index}>{line}</li>)}
              </ul>
            </details>
          ) : null}
          {unverifiedFooter ? <details className="f-assistant-unverified">
            <summary>Unverified footer text</summary>
            <p>No structured execution record accompanies this stored footer.</p>
            <pre>{unverifiedFooter}</pre>
          </details> : null}
        </footer>
      ) : null}
    </div>
  )
}
