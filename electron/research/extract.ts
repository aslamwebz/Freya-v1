import type { ReadableDocument } from '../../core/research/browser'
import { ResearchError } from '../../core/research/errors'
import { assertPublicUrl, normalizeSourceUrl } from '../../core/research/url-policy'

/** Constant trusted source: no selectors, expressions or page values are interpolated. */
export const EXTRACTION_SCRIPT = String.raw`(() => {
  const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const title = clean(document.title, 512);
  const canonicalUrl = document.querySelector('link[rel~="canonical"]')?.getAttribute('href')?.slice(0, 8192) || null;
  const metadata = {};
  for (const [key, selector] of Object.entries({description:'meta[name="description"]',author:'meta[name="author"]',publishedTime:'meta[property="article:published_time"]'})) {
    const value = clean(document.querySelector(selector)?.getAttribute('content'), 512);
    if (value) metadata[key] = value;
  }
  const language = clean(document.documentElement.lang, 64);
  if (language) metadata.language = language;
  // Inspect computed visibility while the original style rules still exist.
  const hidden = [];
  for (const node of document.querySelectorAll('*')) {
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') hidden.push(node);
  }
  for (const node of hidden) node.remove();
  for (const node of document.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,input,button,select,textarea,iframe,frame,frameset,object,embed,template,svg,canvas,[role="navigation"],[role="dialog"],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]')) node.remove();
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  if (!root) return {title,canonicalUrl,metadata,headings:[],links:[],text:'',contentLength:0,truncated:false};
  const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0,32).map(node => clean(node.textContent,256)).filter(Boolean);
  const links = [];
  for (const node of root.querySelectorAll('a[href]')) {
    if (links.length >= 32) break;
    const url = node.getAttribute('href');
    if (url && url.length <= 8192) links.push({title:clean(node.textContent,512),url});
  }
  // Block boundaries survive without conflating adjacent paragraphs or list items.
  const copy = root.cloneNode(true);
  for (const node of copy.querySelectorAll('p,div,section,article,main,h1,h2,h3,h4,h5,h6,li,ul,ol,blockquote,pre,tr,br')) {
    node.before(document.createTextNode('\n'));
    node.after(document.createTextNode('\n'));
  }
  const text = (copy.textContent || '').split(/\n+/).map(line => line.replace(/[^\S\n]+/g,' ').trim()).filter(Boolean).join('\n');
  return {title,canonicalUrl,metadata,headings,links,text:text.slice(0,24000),contentLength:text.length,truncated:text.length>24000};
})()`

const boundedString = (value: unknown, limit: number): string => typeof value === 'string' ? value.trim().slice(0, limit) : ''
function sourceLink(value: unknown, source: string): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try { return assertPublicUrl(new URL(value, source).href).href } catch { return null }
}

/** Rebuild the isolated-world result as known bounded fields in the trusted host. */
export function normalizeExtractedDocument(value: unknown, source: { id: string; url: string; retrievedAt: string }): ReadableDocument {
  if (!value || typeof value !== 'object') throw new ResearchError('unsupported_document')
  const row = value as Record<string, unknown>
  if (typeof row.text !== 'string') throw new ResearchError('unsupported_document')
  const url = assertPublicUrl(source.url).href
  const sourceDomain = new URL(url).hostname
  const canonical = sourceLink(row.canonicalUrl, url)
  const canonicalUrl = canonical && new URL(canonical).hostname === sourceDomain ? normalizeSourceUrl(canonical) : null
  const links: ReadableDocument['links'] = []
  const seen = new Set<string>()
  if (Array.isArray(row.links)) for (const entry of row.links.slice(0, 32)) {
    if (!entry || typeof entry !== 'object') continue
    const link = entry as Record<string, unknown>
    const href = sourceLink(link.url, url)
    if (!href || seen.has(href)) continue
    seen.add(href)
    links.push({ title: boundedString(link.title, 512), url: href })
  }
  const metadata: Record<string, string> = {}
  if (row.metadata && typeof row.metadata === 'object') for (const key of ['description', 'author', 'publishedTime', 'language']) {
    const text = boundedString((row.metadata as Record<string, unknown>)[key], key === 'language' ? 64 : 512)
    if (text) metadata[key] = text
  }
  const text = row.text.slice(0, 24000)
  const reportedLength = typeof row.contentLength === 'number' && Number.isFinite(row.contentLength) ? Math.floor(row.contentLength) : row.text.length
  const contentLength = Math.max(text.length, Math.min(2097152, reportedLength))
  return {
    id: source.id, url, canonicalUrl, title: boundedString(row.title, 512), sourceDomain,
    retrievedAt: source.retrievedAt, text, contentLength,
    truncated: row.truncated === true || contentLength > text.length,
    headings: Array.isArray(row.headings) ? row.headings.slice(0, 32).map((heading) => boundedString(heading, 256)).filter(Boolean) : [],
    links, metadata,
  }
}
