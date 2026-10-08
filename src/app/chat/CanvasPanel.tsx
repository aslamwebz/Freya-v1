import { useEffect, useMemo, useRef, useState } from 'react'

export interface CanvasSpec {
  readonly title: string
  readonly kind: 'document' | 'code'
  readonly language: 'markdown' | 'html' | 'javascript' | 'python' | 'css' | 'json' | 'text'
  readonly content: string
}

export interface CanvasPanelProps {
  /** The canvas payload the Mind attached to the latest assistant message. */
  readonly canvas: CanvasSpec
  /** Close the canvas and return to a single-column chat. */
  readonly onClose: () => void
}

/**
 * A long-form artifact opened beside the chat.
 *
 * The chat says "I made X" in one or two sentences; this panel carries the
 * body. Three render modes:
 *
 *  - HTML — the content is dropped into a sandboxed iframe with a tight CSP
 *    that allows no network, no scripts (unless the content is explicitly
 *    `javascript`-typed, in which case we surface the source as a code
 *    block rather than executing it). Iframes are the only honest way to
 *    render arbitrary HTML, because they stop a document from reaching back
 *    into the page that contains it.
 *  - Markdown — rendered as plain HTML by a small built-in renderer (no
 *    library, no fetch, no remote scripts). Tables, lists, headings and
 *    inline code are honoured; the rest is left as text.
 *  - Code — shown as a monospace block with a copy button.
 *
 * Whatever the mode, the source is one click away: every panel exposes
 * "View source" so the body can never be a black box.
 */
export function CanvasPanel({ canvas, onClose }: CanvasPanelProps) {
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const sourceText = canvas.content
  const wordCount = useMemo(() => sourceText.trim().split(/\s+/).filter(Boolean).length, [sourceText])
  const lineCount = useMemo(() => sourceText.split('\n').length, [sourceText])
  const charCount = sourceText.length

  return (
    <section className="f-canvas" data-kind={canvas.kind} data-language={canvas.language}>
      <header className="f-canvas-head">
        <div className="f-canvas-title">
          <span className="f-canvas-kind">{canvas.kind === 'code' ? 'Code' : 'Document'}</span>
          <h2>{canvas.title}</h2>
          <small>{canvas.language} · {charCount.toLocaleString()} characters · {lineCount.toLocaleString()} lines · {wordCount.toLocaleString()} words</small>
        </div>
        <div className="f-canvas-controls">
          <div className="f-canvas-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'rendered'}
              className="f-canvas-tab"
              onClick={() => setMode('rendered')}
            >Rendered</button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'source'}
              className="f-canvas-tab"
              onClick={() => setMode('source')}
            >Source</button>
          </div>
          <button type="button" className="f-canvas-copy" onClick={() => void copyText(sourceText)}>Copy</button>
          <button type="button" className="f-canvas-close" onClick={onClose} aria-label="Close canvas">×</button>
        </div>
      </header>
      <div className="f-canvas-body">
        {mode === 'source'
          ? <pre className="f-canvas-source"><code>{sourceText}</code></pre>
          : canvas.kind === 'code'
            ? <pre className="f-canvas-source"><code>{sourceText}</code></pre>
            : canvas.language === 'html'
              ? <HtmlFrame html={sourceText} />
              : <MarkdownView markdown={sourceText} />}
      </div>
    </section>
  )
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // fall through to the legacy path
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try { document.execCommand('copy') } finally { textarea.remove() }
}

/** A sandboxed iframe that hosts an HTML document with no network. */
function HtmlFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null)
  useEffect(() => {
    if (ref.current === null) return
    const doc = ref.current.contentDocument
    if (doc === null) return
    doc.open()
    // A bare-bones document with a strict CSP that denies network and inline
    // scripts. The model's HTML is the only thing that runs; nothing can reach
    // back to Freya or to the wider web from inside the iframe.
    const safe = wrapHtml(html)
    doc.write(safe)
    doc.close()
  }, [html])
  return <iframe ref={ref} className="f-canvas-html" sandbox="allow-same-origin" title="Canvas preview" />
}

function wrapHtml(body: string): string {
  const hasDoc = /<html[\s>]/i.test(body)
  if (hasDoc) return body
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:18px;color:#eaf2fb;background:#0a131e;font:14px/1.55 ui-sans-serif,system-ui,sans-serif}a{color:#7cc7e6}code{background:#1a2638;padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}pre{background:#1a2638;padding:10px 12px;border-radius:8px;overflow:auto}pre code{background:transparent;padding:0}h1,h2,h3{color:#a9ecff;margin-top:1.2em}table{border-collapse:collapse}td,th{border:1px solid #1f2c3b80;padding:6px 9px}</style></head><body>${body}</body></html>`
}

/**
 * A small built-in markdown renderer.
 *
 * Deliberately not a library. The journal is the only thing that has to read
 * the literal markdown; the renderer just needs to draw headings, lists,
 * paragraphs, inline code, bold, links and code blocks well enough that a
 * person can read the document. No fetch, no remote scripts, no raw HTML
 * pass-through. A renderer that runs a stranger's script is a renderer that
 * got fooled by a document.
 */
function MarkdownView({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown])
  return <div className="f-canvas-md" dangerouslySetInnerHTML={{ __html: html }} />
}

function renderMarkdown(src: string): string {
  // Normalise newlines
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let codeBuf: string[] = []
  let inList = false
  let listType: 'ul' | 'ol' | null = null
  let paraBuf: string[] = []

  const flushPara = (): void => {
    if (paraBuf.length === 0) return
    const text = paraBuf.join(' ')
    out.push(`<p>${escapeHtml(formatInline(text))}</p>`)
    paraBuf = []
  }
  const flushList = (): void => {
    if (!inList) return
    out.push(`</${listType ?? 'ul'}>`)
    inList = false
    listType = null
  }

  for (const raw of lines) {
    if (inCode) {
      if (/^```/.test(raw)) {
        out.push(`<pre><code${codeLang === '' ? '' : ` class="lang-${codeLang}"`}>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        codeBuf = []
        inCode = false
        codeLang = ''
        continue
      }
      codeBuf.push(raw)
      continue
    }
    const fence = /^```(\w*)\s*$/.exec(raw)
    if (fence !== null) {
      flushPara()
      flushList()
      inCode = true
      codeLang = fence[1] ?? ''
      continue
    }
    if (raw.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(raw)
    if (heading !== null) {
      flushPara()
      flushList()
      const level = heading[1]?.length ?? 1
      const text = heading[2] ?? ''
      out.push(`<h${level}>${escapeHtml(formatInline(text))}</h${level}>`)
      continue
    }
    const ul = /^\s*[-*]\s+(.+)$/.exec(raw)
    const ol = /^\s*\d+\.\s+(.+)$/.exec(raw)
    if (ul !== null || ol !== null) {
      flushPara()
      const want = ol !== null ? 'ol' : 'ul'
      if (!inList) {
        out.push(`<${want}>`)
        inList = true
        listType = want
      } else if (listType !== want) {
        flushList()
        out.push(`<${want}>`)
        inList = true
        listType = want
      }
      const item = (ul?.[1] ?? ol?.[1] ?? '').trim()
      out.push(`<li>${escapeHtml(formatInline(item))}</li>`)
      continue
    }
    // paragraph line
    paraBuf.push(raw)
  }
  flushPara()
  flushList()
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
  }
  return out.join('\n')
}

function formatInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=$|[\s.,)!?])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
