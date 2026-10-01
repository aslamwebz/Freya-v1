import { describe, expect, it } from 'vitest'
import { EXTRACTION_SCRIPT, normalizeExtractedDocument } from '../../electron/research/extract'

function extract(html: string) {
  const dom = Reflect.get(globalThis, 'document') as { documentElement: { innerHTML: string } }
  dom.documentElement.innerHTML = html
  const evaluate = Reflect.get(globalThis, 'eval') as (code: string) => unknown
  return normalizeExtractedDocument(evaluate(EXTRACTION_SCRIPT), { id: 'doc', url: 'https://example.com/articles/current', retrievedAt: '2026-10-01T00:00:00.000Z' })
}
describe('trusted DOM extractor', () => {
  it('preserves article text/headings while removing hostile and hidden junk', () => {
    const doc = extract(`<title>Story</title><meta name="description" content="Summary"><style>.invisible{display:none}</style><nav>Menu</nav><main><article><h1>Heading</h1><p>First paragraph.</p><p>Second <b>bold</b> paragraph.</p><script>stolen()</script><style>CSS junk</style><form>Form junk</form><iframe>Frame junk</iframe><p hidden>Hidden junk</p><p class="invisible">CSS hidden junk</p><p aria-hidden="true">ARIA junk</p><div id="cookie-banner">Cookie junk</div><a href="../source">Read more</a></article></main><footer>Footer junk</footer>`)
    expect(doc.title).toBe('Story')
    expect(doc.headings).toEqual(['Heading'])
    expect(doc.text).toContain('First paragraph.\nSecond bold paragraph.')
    expect(doc.text).not.toMatch(/junk|Menu|stolen|Cookie/)
    expect(doc.links).toEqual([{ title: 'Read more', url: 'https://example.com/source' }])
    expect(doc.metadata).toEqual({ description: 'Summary' })
    expect(doc.sourceDomain).toBe('example.com')
    expect(doc.contentLength).toBe(doc.text.length)
  })
  it('ignores page base URL and admits only same-host public canonical identity', () => {
    const doc = extract('<base href="http://127.0.0.1/"><link rel="canonical" href="/article?utm_source=no#frag"><p>Body</p><a href="relative">Relative</a>')
    expect(doc.canonicalUrl).toBe('https://example.com/article')
    expect(doc.links[0]?.url).toBe('https://example.com/articles/relative')
  })
  it.each(['http://127.0.0.1/', 'https://elsewhere.com/', 'javascript:alert(1)', 'https://user:pass@example.com/'])('discards hostile canonical %s', (canonical) => {
    expect(extract(`<link rel="canonical" href="${canonical}"><p>Body</p>`).canonicalUrl).toBeNull()
  })
  it('bounds text, title, headings, link count and metadata; strips private and executable links', () => {
    const doc = extract(`<title>${'T'.repeat(900)}</title><meta name="author" content="${'A'.repeat(900)}"><main><p>${'x'.repeat(30000)}</p>${Array.from({ length: 40 }, (_, i) => `<h2>Heading ${i}</h2><a href="/${i}">Link ${i}</a>`).join('')}<a href="javascript:alert(1)">execute</a><a href="http://127.0.0.1/">private</a></main>`)
    expect(doc.text).toHaveLength(24000)
    expect(doc.contentLength).toBeGreaterThan(24000)
    expect(doc.truncated).toBe(true)
    expect(doc.title).toHaveLength(512)
    expect(doc.headings).toHaveLength(32)
    expect(doc.links).toHaveLength(32)
    expect(doc.metadata.author).toHaveLength(512)
    expect(doc.links.every((link) => link.url.startsWith('https://example.com/'))).toBe(true)
  })
  it('falls back to body, handles empty documents and does not admit unknown fields', () => {
    expect(extract('<p>Simple body</p>').text).toBe('Simple body')
    expect(extract('<script>hostile()</script>').text).toBe('')
    const doc = normalizeExtractedDocument({ title: 'T', text: 'Text', headings: [], links: [{ title: 'bad', url: 'data:text/html,foo' }], canonicalUrl: 'http://127.0.0.1', metadata: { secret: 'discard' }, secret: 'discard' }, { id: 'doc', url: 'https://example.com/', retrievedAt: 'time' })
    expect(doc.links).toEqual([])
    expect(doc.metadata).toEqual({})
    expect(JSON.stringify(doc)).not.toContain('discard')
  })
  it('rejects malformed extractor output', () => {
    expect(() => normalizeExtractedDocument(null, { id: 'doc', url: 'https://example.com/', retrievedAt: 'time' })).toThrow()
  })
})
