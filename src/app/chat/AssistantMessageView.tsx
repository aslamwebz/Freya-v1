import type { ReactNode } from 'react'
import { RichMessage } from './RichMessage'
import { splitAssistantContent } from './assistantParts'

export interface AssistantMessageViewProps {
  /** The literal text the journal stored for this assistant message. */
  readonly content: string
  /** Hand the renderer's link opener down so citations are still navigable. */
  readonly onOpenLink?: (url: string, provenance?: { readonly kind: 'citation' | 'source' | 'inline'; readonly title?: string }) => void
  /** Provenance counts `RichMessage` already understands. */
  readonly retrieved?: number
  /** Count of typed media items (search results, images, etc.). */
  readonly mediaCount?: number
  /** Optional children rendered below the answer body, e.g. a media grid. */
  readonly children?: ReactNode
}

/**
 * Render an assistant message the way a reader actually wants it.
 *
 * The journal stores the model's words, the model's `<think>` block, the
 * tool footer the Mind appends, and the typed media items. Showing all of
 * that in one paragraph is what made the chat look like a log dump. This
 * view splits the stored content into its parts and renders each one
 * where it belongs: reasoning behind a closed disclosure, the answer
 * inside a dark translucent bubble, the "What Freya did" trace behind
 * another disclosure, and the sources as a small inline citation list.
 *
 * The journal is still the source of truth — nothing here throws the
 * literal text away. The view just shows less of it by default.
 */
export function AssistantMessageView({ content, onOpenLink, retrieved, mediaCount, children }: AssistantMessageViewProps) {
  const parts = splitAssistantContent(content)
  const hasThinking = parts.thinking.length > 0
  const hasSteps = parts.steps.length > 0
  const hasSources = parts.sources.length > 0
  const hasMeta = hasThinking || hasSteps || hasSources || (retrieved !== undefined && retrieved > 0) || (mediaCount !== undefined && mediaCount > 0)

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
        {children}
      </div>

      {hasMeta ? (
        <footer className="f-assistant-meta">
          {hasSources ? (
            <ol className="f-assistant-sources" aria-label="Sources">
              {parts.sources.map((source) => (
                <li key={`${source.rank}-${source.url}`}>
                  <span className="f-assistant-source-rank">[{source.rank}]</span>
                  {onOpenLink !== undefined ? (
                    <button
                      type="button"
                      className="f-assistant-source-link"
                      onClick={() => onOpenLink(source.url, { kind: 'citation', title: source.title })}
                    >
                      {source.title}
                    </button>
                  ) : (
                    <a className="f-assistant-source-link" href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a>
                  )}
                </li>
              ))}
            </ol>
          ) : null}
          {hasSteps ? (
            <details className="f-assistant-steps">
              <summary>What Freya did for this answer</summary>
              <ul>
                {parts.steps.map((line, index) => <li key={index}>{line}</li>)}
              </ul>
            </details>
          ) : null}
        </footer>
      ) : null}
    </div>
  )
}
