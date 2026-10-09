import type { ReactNode } from 'react'
import { RichMessage } from './RichMessage'
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
   * which ranks the answer body cited). When absent, the renderer falls back
   * to the prose footer's `Sources:` list.
   */
  readonly sources?: readonly TypedSource[]
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
  /** Optional children rendered below the answer body, e.g. a media grid. */
  readonly children?: ReactNode
}

/**
 * Render an assistant message the way a reader actually wants it.
 *
 * The journal stores the model's words, the model's `<think>` block, the
 * tool footer the Mind appends, the typed media items, and the typed web
 * sources. Showing all of that in one paragraph is what made the chat look
 * like a log dump. This view splits the stored content into its parts and
 * renders each one where it belongs: reasoning behind a closed disclosure,
 * the answer inside a dark translucent bubble, the "What Freya did" trace
 * behind another disclosure, the matched sources as inline citation pills,
 * and the related sources (everything else the search returned) behind a
 * closed "Show related" disclosure.
 *
 * The journal is still the source of truth — nothing here throws the
 * literal text away. The view just shows less of it by default.
 */
export function AssistantMessageView({ content, onOpenLink, retrieved, mediaCount, sources, charts, steps, children }: AssistantMessageViewProps) {
  const parts = splitAssistantContent(content, sources)
  const hasThinking = parts.thinking.length > 0
  // The "What Freya did" panel is drawn from the loop's step records when they
  // are present, and not at all otherwise. The prose-parsed footer is the
  // fallback for messages that pre-date the change and still carry the code
  // footer in their `content`; once the Mind is rebuilt, new messages will
  // have empty `parts.steps` and rely on `steps` instead.
  const stepLines = steps !== undefined && steps.length > 0 ? stepRecordsAsFooterLines(steps) : parts.steps
  const hasSteps = stepLines.length > 0
  const hasMatched = parts.matchedSources.length > 0
  const hasRelated = parts.relatedSources.length > 0
  const hasFooterSources = parts.sources.length > 0
  const hasMeta = hasThinking || hasSteps || hasMatched || hasRelated || hasFooterSources
    || (retrieved !== undefined && retrieved > 0) || (mediaCount !== undefined && mediaCount > 0)

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
            {charts.map((chart, index) => <ChartView key={`c-${index}-${chart.title}`} chart={chart} />)}
          </div>
        ) : null}
        {children}
      </div>

      {hasMeta ? (
        <footer className="f-assistant-meta">
          {hasMatched ? (
            <ol className="f-assistant-sources" aria-label="Sources cited in the answer">
              {parts.matchedSources.map((source) => (
                <li key={`m-${source.rank}-${source.url}`}>
                  <span className="f-assistant-source-rank">[{source.rank}]</span>
                  {onOpenLink !== undefined ? (
                    <button
                      type="button"
                      className="f-assistant-source-link"
                      onClick={() => openCitation(source.url, source.title)}
                    >
                      {source.title}
                    </button>
                  ) : (
                    <a className="f-assistant-source-link" href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>
                  )}
                </li>
              ))}
            </ol>
          ) : hasFooterSources ? (
            // No typed sources were attached, but the model wrote a Sources: block
            // in the prose. Show that as a fallback so the answer is still citable.
            <ol className="f-assistant-sources" aria-label="Sources">
              {parts.sources.map((source) => (
                <li key={`f-${source.rank}-${source.url}`}>
                  <span className="f-assistant-source-rank">[{source.rank}]</span>
                  <a className="f-assistant-source-link" href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>
                </li>
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
                  <li key={`r-${source.rank}-${source.url}`}>
                    <span className="f-assistant-source-rank">[{source.rank}]</span>
                    {onOpenLink !== undefined ? (
                      <button
                        type="button"
                        className="f-assistant-source-link"
                        onClick={() => openCitation(source.url, source.title)}
                      >
                        {source.title}
                      </button>
                    ) : (
                      <a className="f-assistant-source-link" href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {hasSteps ? (
            <details className="f-assistant-steps">
              <summary>What Freya did for this answer</summary>
              <ul>
                {stepLines.map((line, index) => <li key={index}>{line}</li>)}
              </ul>
            </details>
          ) : null}
        </footer>
      ) : null}
    </div>
  )
}
