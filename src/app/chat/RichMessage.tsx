import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface RichMessageProps {
  readonly content: string
  /**
   * Links are actions, not raw anchors. Until a browser workspace is attached, they
   * render visibly but cannot escape Freya through the renderer on their own.
   */
  readonly onOpenLink?: (url: string) => void
  /**
   * Show a "Copy" affordance on every code block. Defaults to `false` so the
   * plain-text path stays zero-feature.
   */
  readonly enableCodeCopy?: boolean
  /**
   * Show a contents table above the body when the markdown contains two or
   * more headings. Defaults to `false`.
   */
  readonly enableToc?: boolean
  /**
   * Collapse very long answers behind a "Show more" affordance. When set, any
   * body longer than this many characters is truncated. The toggle restores
   * the full content. Defaults to "off".
   */
  readonly collapseAbove?: number
  /**
   * Provenance counts the renderer can state honestly. None of the numbers
   * are invented; absent counts are not shown at all.
   */
  readonly provenance?: {
    /** Distinct sources the answer drew on (typed media, citations). */
    readonly retrieved?: number
    /** Direct observations Core recorded from this turn. */
    readonly observed?: number
    /** Inferences the answer made without a source — flagged, not hidden. */
    readonly inferred?: number
  }
  /** When true, the message is still being written and the collapse is bypassed. */
  readonly streaming?: boolean
}

interface Block {
  kind: 'paragraph' | 'heading' | 'quote' | 'code' | 'ul' | 'ol' | 'table'
  level?: number
  text?: string
  language?: string
  items?: string[]
  rows?: string[][]
}

const FENCE = /^\s*```([^\s`]*)\s*$/
const HEADING = /^(#{1,3})\s+(.+)$/
const QUOTE = /^>\s?(.*)$/
const UL = /^\s*[-*]\s+(.+)$/
const OL = /^\s*\d+[.)]\s+(.+)$/

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function tableDivider(line: string): boolean {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

/**
 * A deliberately small Markdown reader.
 *
 * Model output is untrusted. This parser never creates HTML strings and never uses
 * dangerouslySetInnerHTML; every token becomes ordinary React text/nodes. Unsupported
 * syntax stays visible as text rather than being guessed into markup.
 */
export function parseRichBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    const text = paragraph.join(' ').trim()
    if (text) blocks.push({ kind: 'paragraph', text })
    paragraph = []
  }

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ''
    const fence = line.match(FENCE)
    if (fence) {
      flushParagraph()
      const language = fence[1] ?? ''
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').match(FENCE)) {
        body.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
      index += 1
      continue
    }

    const quote = line.match(QUOTE)
    if (quote) {
      flushParagraph()
      const quoted: string[] = []
      while (index < lines.length) {
        const hit = (lines[index] ?? '').match(QUOTE)
        if (!hit) break
        quoted.push(hit[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'quote', text: quoted.join(' ') })
      continue
    }

    const unordered = line.match(UL)
    if (unordered) {
      flushParagraph()
      const items: string[] = []
      while (index < lines.length) {
        const hit = (lines[index] ?? '').match(UL)
        if (!hit) break
        items.push(hit[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'ul', items })
      continue
    }

    const ordered = line.match(OL)
    if (ordered) {
      flushParagraph()
      const items: string[] = []
      while (index < lines.length) {
        const hit = (lines[index] ?? '').match(OL)
        if (!hit) break
        items.push(hit[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'ol', items })
      continue
    }

    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      tableDivider(lines[index + 1] ?? '')
    ) {
      flushParagraph()
      const rows: string[][] = [tableCells(line)]
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        rows.push(tableCells(lines[index] ?? ''))
        index += 1
      }
      blocks.push({ kind: 'table', rows })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }

    paragraph.push(line.trim())
    index += 1
  }

  flushParagraph()
  return blocks
}

function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Inline formatting with a closed token set.
 *
 * The tokenizer only recognises code, strong/emphasis and explicit http(s) links.
 * HTML tags are never interpreted; React escapes them as text.
 */
export function inlineRichText(text: string, onOpenLink?: (url: string) => void): ReactNode[] {
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g
  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = token.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const raw = match[0]
    if (raw.startsWith('`')) {
      nodes.push(<code key={key++}>{raw.slice(1, -1)}</code>)
    } else if (raw.startsWith('**')) {
      nodes.push(<strong key={key++}>{raw.slice(2, -2)}</strong>)
    } else if (raw.startsWith('*')) {
      nodes.push(<em key={key++}>{raw.slice(1, -1)}</em>)
    } else {
      const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const label = link?.[1] ?? raw
      const url = safeWebUrl(link?.[2] ?? '')
      if (url === null) {
        nodes.push(raw)
      } else {
        nodes.push(
          <button
            key={key++}
            type="button"
            className="chats-rich-link"
            disabled={onOpenLink === undefined}
            title={onOpenLink === undefined ? 'Browser workspace is not attached to this message yet.' : url}
            onClick={() => onOpenLink?.(url)}
          >
            {label}
          </button>,
        )
      }
    }
    cursor = match.index + raw.length
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function CodeBlock({ language, text, enableCopy }: { language?: string; text: string; enableCopy: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])
  const onCopy = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for environments without the clipboard API (older WebViews, some tests).
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
      }
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // A failed copy is not a render error; the user will retry.
    }
  }
  return (
    <figure className="chats-code">
      {language || enableCopy ? (
        <figcaption>
          <span className="chats-code-lang">{language || 'code'}</span>
          {enableCopy ? (
            <button
              type="button"
              className="chats-code-copy"
              onClick={() => void onCopy()}
              aria-live="polite"
              data-copied={copied || undefined}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </figcaption>
      ) : null}
      <pre><code>{text}</code></pre>
    </figure>
  )
}

/**
 * Stable id for a heading. The same input must produce the same id, because
 * a TOC built during render must reference the heading the DOM actually mounts.
 */
function headingId(index: number, text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return `rich-h-${String(index)}-${slug || 'section'}`
}

export function RichMessage({
  content,
  onOpenLink,
  enableCodeCopy = false,
  enableToc = false,
  collapseAbove,
  provenance,
  streaming = false,
}: RichMessageProps) {
  const blocks = parseRichBlocks(content)
  const headingBlocks = blocks
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block.kind === 'heading')

  const showToc = enableToc && headingBlocks.length >= 2
  const collapsed = collapseAbove !== undefined && !streaming && content.length > collapseAbove
  const [expanded, setExpanded] = useState(false)
  const showToggle = collapsed
  const visible = showToggle && !expanded ? blocks.slice(0, Math.min(2, blocks.length)) : blocks

  const scrollTo = (id: string) => {
    if (typeof document === 'undefined') return
    const target = document.getElementById(id)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div className="chats-rich" data-streaming={streaming || undefined}>
      {provenance ? (
        <ProvenanceBadge provenance={provenance} />
      ) : null}

      {showToc ? (
        <details className="chats-toc">
          <summary>
            <b>Contents</b>
            <small>{String(headingBlocks.length)} section{headingBlocks.length === 1 ? '' : 's'}</small>
          </summary>
          <ol className="chats-toc-list">
            {headingBlocks.map(({ block, index }) => {
              const id = headingId(index, block.text ?? '')
              const label = inlineRichText(block.text ?? '', onOpenLink)
              return (
                <li key={`toc-${String(index)}`} data-level={block.level ?? 1}>
                  <button type="button" onClick={() => scrollTo(id)} aria-label={`Jump to: ${block.text ?? ''}`}>
                    {label}
                  </button>
                </li>
              )
            })}
          </ol>
        </details>
      ) : null}

      {visible.map((block, index) => {
        const key = `${block.kind}-${index}`
        if (block.kind === 'heading') {
          const body = inlineRichText(block.text ?? '', onOpenLink)
          const id = headingId(index, block.text ?? '')
          if (block.level === 1) return <h2 key={key} id={id}>{body}</h2>
          if (block.level === 2) return <h3 key={key} id={id}>{body}</h3>
          return <h4 key={key} id={id}>{body}</h4>
        }
        if (block.kind === 'code') {
          return <CodeBlock key={key} language={block.language} text={block.text ?? ''} enableCopy={enableCodeCopy} />
        }
        if (block.kind === 'quote') {
          return <blockquote key={key}>{inlineRichText(block.text ?? '', onOpenLink)}</blockquote>
        }
        if (block.kind === 'ul') {
          return <ul key={key}>{(block.items ?? []).map((item, itemIndex) =>
            <li key={itemIndex}>{inlineRichText(item, onOpenLink)}</li>)}</ul>
        }
        if (block.kind === 'ol') {
          return <ol key={key}>{(block.items ?? []).map((item, itemIndex) =>
            <li key={itemIndex}>{inlineRichText(item, onOpenLink)}</li>)}</ol>
        }
        if (block.kind === 'table') {
          const [head = [], ...body] = block.rows ?? []
          return <div key={key} className="chats-table-wrap"><table>
            <thead><tr>{head.map((cell, cellIndex) => <th key={cellIndex}>{inlineRichText(cell, onOpenLink)}</th>)}</tr></thead>
            <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) =>
              <td key={cellIndex}>{inlineRichText(cell, onOpenLink)}</td>)}</tr>)}</tbody>
          </table></div>
        }
        return <p key={key}>{inlineRichText(block.text ?? '', onOpenLink)}</p>
      })}

      {showToggle ? (
        <button
          type="button"
          className="chats-rich-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? `Show less (${String(content.length - 2)} block${content.length - 2 === 1 ? '' : 's'} hidden)`
            : `Show more (${String(content.length - 2)} block${content.length - 2 === 1 ? '' : 's'} hidden)`}
        </button>
      ) : null}
    </div>
  )
}

function ProvenanceBadge({ provenance }: { provenance: NonNullable<RichMessageProps['provenance']> }) {
  const chips: { label: string; value: number; tone: string }[] = []
  if (typeof provenance.retrieved === 'number' && provenance.retrieved > 0) {
    chips.push({ label: 'retrieved', value: provenance.retrieved, tone: 'retrieved' })
  }
  if (typeof provenance.observed === 'number' && provenance.observed > 0) {
    chips.push({ label: 'observed', value: provenance.observed, tone: 'observed' })
  }
  if (typeof provenance.inferred === 'number' && provenance.inferred > 0) {
    chips.push({ label: 'inferred', value: provenance.inferred, tone: 'inferred' })
  }
  if (chips.length === 0) return null
  return (
    <div className="chats-provenance" aria-label="Provenance of this answer">
      {chips.map((chip) => (
        <span key={chip.label} data-tone={chip.tone}>
          <b>{chip.value}</b>
          <small>{chip.label}</small>
        </span>
      ))}
    </div>
  )
}

export function plainTextFromRich(content: string): string {
  return parseRichBlocks(content)
    .map((block) => {
      if (block.items) return block.items.join('\n')
      if (block.rows) return block.rows.map((row) => row.join('\t')).join('\n')
      return block.text ?? ''
    })
    .join('\n')
}
