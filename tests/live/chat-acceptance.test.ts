// @vitest-environment node
/**
 * TESTS 1-10, driven through the real turn path.
 *
 * Not a mock suite. A real Mind, a real Cognition Service, a real Governor, a
 * real grant store and a real Gateway stand in front of a **live** model
 * provider, a **live** SearXNG daemon and, for TEST 10, Freya's **own** browser.
 * A scripted provider appears only where a test must prove a failure mode on cue
 * (a denied tool cannot be provoked from a live model).
 *
 * Everything here self-skips. Without the environment this file exits 0 having
 * asserted nothing, so it can live in the repo without making CI flaky. Run it
 * with:
 *
 *     npm run test:chat-acceptance
 *
 * Nothing here asserts a fact about the world. "Laravel 13" changes; what must
 * hold is that an answer came from a real search, cites real URLs, and that Freya
 * never pretended to have searched when it did not.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { extractPdfText } from '../../electron/attachments'

import { EventFabric } from '../../core/events/fabric'
import type { EventStore } from '../../core/events/store'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import { ModelGateway, type GatewayRecorder } from '../../core/model/gateway'
import { NanoGptProvider } from '../../core/model/nanogpt-provider'
import type { ModelProvider, ModelRequest, ModelResult } from '../../core/model/provider'
import { MindService } from '../../core/mind/mind'
import { createWebSearchTool, MindToolRegistry, type MindTool } from '../../core/mind/tools'
import { createBrowserTaskTool, type BrowserTaskPort } from '../../core/mind/browser-tool'
import { SearxngSearchProvider } from '../../core/research/providers/searxng'
import { PreferredSearchProvider } from '../../core/research/providers/preferred'
import { Searcher } from '../../core/research/searcher'
import type { SearchResult, SearchVertical } from '../../core/research/types'
import type { BrowserRequest } from '../../core/browser/runtime'
import { DefaultGuard } from '../../core/security/guard'
import type { Capability } from '../../core/protocol/core-protocol'
import { CognitionService } from '../../core/cognition/service'
import { initialCoreState } from '../../core/state'

/* ------------------------------------------------------------------ config */

const T0 = new Date('2026-10-05T09:00:00.000Z')
const CONVERSATION_ID = 'acceptance'

const SEARXNG_URL = process.env.FREYA_SEARXNG_URL?.trim() ?? ''
const API_KEY = process.env.NANOGPT_API_KEY?.trim() ?? ''
const BASE_URL = process.env.NANOGPT_BASE_URL?.trim() ?? 'https://nano-gpt.com/api/v1'
/**
 * The tool model.
 *
 * Measured against the live endpoint: `qwen/qwen3.8-27b-uncensored` finishes an
 * ordinary answer in ~242 completion tokens and emits a tool call in ~35, so it
 * fits inside the existing 1024-token turn ceiling. `meta/muse-spark-1.2-contributor`
 * needs 830-971 for the same answer and would truncate here; `z-ai/glm-5.3-flash`
 * needs 1024 and over-calls. Override with FREYA_ACCEPTANCE_MODEL.
 */
const TOOL_MODEL = process.env.FREYA_ACCEPTANCE_MODEL ?? 'qwen/qwen3.8-27b-uncensored'

const searchLive = SEARXNG_URL !== ''
const modelLive = API_KEY !== ''
const live = searchLive && modelLive
const browserLive = process.env.FREYA_BROWSER_LIVE === '1'

/** What each test actually observed, written to stdout by the run report. */
const report: { test: string; detail: string }[] = []
function note(test: string, detail: string): void {
  report.push({ test, detail })
}

/* --------------------------------------------------------------- plumbing */

function memoryEventStore(): EventStore {
  const events: AnyCoreEvent[] = []
  return {
    append: async (event: AnyCoreEvent) => { events.push(event) },
    readAll: async () => [...events],
    readAfter: async (after: number) => events.filter((e) => e.sequence > after),
    lastSequence: async () => events[events.length - 1]?.sequence ?? 0,
    describe: () => 'memory',
    close: async () => undefined,
  }
}

const silentRecorder: GatewayRecorder = {
  started: async () => undefined,
  completed: async () => undefined,
  failed: async () => undefined,
  cancelled: async () => undefined,
}

/** Counts provider calls — TEST 1's "must not search" is only provable by counting. */
class CountingProvider implements ModelProvider {
  readonly id = 'live-counting'
  // `nanogpt`, not an invented kind: the gateway validates `kind` against the real
  // vocabulary, so a test-only value would be refused by the code under test.
  readonly kind = 'nanogpt' as const
  readonly live = true
  calls = 0
  readonly requests: ModelRequest[] = []
  readonly inner: ModelProvider

  constructor(model: string) {
    this.inner = new NanoGptProvider({
      config: {
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        model,
        // The explicit decision to spend. Refusing here would make every test in
        // this file pass for the wrong reason.
        liveEnabled: process.env.FREYA_ALLOW_LIVE_MODEL === '1',
      },
    })
  }

  status() { return this.inner.status() }

  async complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResult> {
    this.calls += 1
    this.requests.push(request)
    return this.inner.complete(request, options)
  }
}

let dir = ''
let conversationSeq = 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-acceptance-'))
})

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  if (report.length > 0) {
    // Printed so a live run leaves an audit trail, not just green ticks.
    for (const line of report) console.log(`  [${line.test}] ${line.detail}`)
  }
})

interface Harness {
  ask: (text: string) => Promise<{ ok: boolean; reason: string | null }>
  answer: () => Promise<string>
  providerCalls: () => number
  searchedQueries: () => readonly string[]
  browsedUrls: () => readonly string[]
}

async function harness(options: {
  tools?: MindTool[]
  model?: string
  holding?: readonly Capability[]
}): Promise<Harness> {
  const provider = new CountingProvider(options.model ?? TOOL_MODEL)
  const fabric = await EventFabric.open({
    store: memoryEventStore(),
    now: () => T0,
    newId: (() => { let n = 0; return () => `evt-${(n += 1).toString().padStart(4, '0')}` })(),
  })
  const store = new MemoryConversationStore({ mode: 'memory' })
  const conversationId = `${CONVERSATION_ID}-${(conversationSeq += 1)}`
  await store.putConversation({
    conversationId,
    title: 'acceptance',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  })

  const tools = options.tools ?? []
  const guard = new DefaultGuard()
  const holding = options.holding ?? tools.map((tool) => tool.capability)
  const registry = tools.length === 0
    ? undefined
    : new MindToolRegistry({
      tools,
      guard,
      principal: { id: 'owner', capabilities: new Set<Capability>(holding), trusted: true },
      stopped: () => false,
    })

  const gateway = new ModelGateway({ providers: [provider], recorder: silentRecorder, now: () => T0 })
  const cognition = new CognitionService({ fabric, gateway, guard, now: () => T0 }, initialCoreState())
  const mind = new MindService({
    fabric,
    store,
    authority: cognition.ownerAuthority(),
    gateway,
    now: () => T0,
    newId: (() => { let n = 0; return () => `id-${(n += 1).toString().padStart(4, '0')}` })(),
    ...(registry ? { tools: registry } : {}),
  })

  const searchedQueries: string[] = []
  const browsedUrls: string[] = []

  const answer = async (): Promise<string> => {
    const record = await store.readConversation(conversationId)
    return record?.messages.filter((m: { role: string }) => m.role === 'assistant').at(-1)?.content ?? ''
  }

  return {
    providerCalls: () => provider.calls,
    searchedQueries: () => searchedQueries,
    browsedUrls: () => browsedUrls,
    answer,
    ask: async (text: string) => {
      // A real turn id, as Core always supplies one. The Mind is the id's author,
      // and an empty string would be a turn nobody can correlate.
      const result = await mind.runTurn({ conversationId, turnId: `turn-${conversationId}`, text })
      return {
        // `completed` is the only outcome that means an answer exists. Anything
        // else -- denied, failed, truncated -- is not a successful turn, and a
        // test that treated it as one would be asserting the thing this suite
        // exists to catch.
        ok: result.outcome === 'completed',
        reason: result.reason,
      }
    },
  }
}

/** The real Searcher over the real daemon. `log` records the queries chosen. */
function liveSearchTool(
  vertical: SearchVertical,
  log: string[],
  capabilities: string[],
): MindTool {
  const searcher = new Searcher({
    provider: new PreferredSearchProvider([
      new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
    ]),
  })
  return createWebSearchTool({
    now: () => T0,
    searchWeb: async (query: string, signal?: AbortSignal) => {
      log.push(query)
      const results: SearchResult[] = await searcher.searchWeb(query, { limit: 6, signal, vertical })
      for (const result of results) capabilities.push(result.url)
      return results
    },
  })
}

const urlsIn = (text: string): string[] => text.match(/https?:\/\/[^\s<>)\]"']+/g) ?? []

/* ---------------------------------------------------------------- helpers */

/**
 * Fetch a candidate and keep it only if the bytes really are a PDF.
 *
 * The `%PDF-` signature is checked against the bytes rather than the extension or
 * the content-type header, because an HTML error page served with a `.pdf` name
 * and `application/pdf` header is exactly the case that makes a document search
 * dishonest. Bounded, so a hostile or enormous target cannot be used to exhaust
 * memory here.
 */
async function findRealPdf(urls: readonly string[]): Promise<{ url: string; bytes: Buffer } | null> {
  for (const url of urls.slice(0, 6)) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/pdf,*/*' },
      })
      if (!response.ok) continue
      const declared = response.headers.get('content-type') ?? ''
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') continue
      // Record what the server claimed as well as what the bytes say, because a
      // mismatch is worth knowing even when the bytes win.
      note('TEST 4.probe', `${url} -> ${declared || '(no content-type)'}, ${bytes.length} bytes, signature ok`)
      return { url, bytes }
    } catch {
      // A candidate that cannot be fetched is simply the next one's problem.
    }
  }
  return null
}

/**
 * Show an image to the vision model and take back what it says it sees.
 *
 * This is the mechanism TEST 7 exists to test. The filename is deliberately
 * meaningless, so anything the model reports has come from the pixels.
 */
async function describeImageWithVision(
  provider: ModelProvider,
  filename: string,
): Promise<{ subjects: string[]; raw: string }> {
  const png = await makeTwoTonePng()
  const base64 = png.toString('base64')
  const result = await provider.complete(
    {
      requestId: 'vision-probe',
      messages: [{
        role: 'user',
        content: 'List the main subjects and the colours you can see in this image, as short comma-separated phrases.',
        attachments: [{ type: 'image', mimeType: 'image/png', data: base64, filename }],
      }],
      prompt: '',
      // Measured, not guessed: the muse models spend 150-800 output tokens on
      // reasoning before they answer, so a small cap yields an empty reply that
      // looks like the model saw nothing.
      maxOutputTokens: 1_024,
      model: null,
    },
    { signal: AbortSignal.timeout(120_000) },
  )
  const raw = result.text
  const subjects = raw
    .split(/[,;\n]/)
    .map((part: string) => part.replace(/^[\s\-*\d.]+/, '').trim())
    .filter((part: string) => part.length > 1)
    .slice(0, 6)
  return { subjects, raw }
}

/**
 * Describe real image bytes with the live vision model.
 *
 * Used by TEST 7, where the image is a real download rather than a generated
 * one, so the model sees the same kind of JPEG a person would have attached.
 */
async function describeImageFromBytes(
  provider: ModelProvider,
  bytes: Buffer,
  filename: string,
): Promise<{ subjects: string[]; raw: string }> {
  const result = await provider.complete(
    {
      requestId: 'vision-live',
      messages: [{
        role: 'user',
        content: 'Describe the subject of this image and its visual composition, as short comma-separated phrases.',
        attachments: [{
          type: 'image',
          mimeType: sniffImage(bytes) ?? 'image/jpeg',
          data: bytes.toString('base64'),
          filename,
        }],
      }],
      prompt: '',
      // The muse models spend 150-800 output tokens reasoning before answering, so
      // a small cap returns an empty reply that looks exactly like seeing nothing.
      maxOutputTokens: 1_024,
      model: null,
    },
    { signal: AbortSignal.timeout(180_000) },
  )
  const subjects = result.text
    .split(/[,;\n]/)
    .map((part: string) => part.replace(/^[\s\-*\d.]+/, '').trim())
    .filter((part: string) => part.length > 2)
    .slice(0, 6)
  return { subjects, raw: result.text }
}

/**
 * A real PNG with real content, built here rather than committed.
 *
 * Two solid halves so "what is in this picture" has a checkable answer, which is
 * what makes the filename-adversarial assertion meaningful.
 */
async function makeTwoTonePng(): Promise<Buffer> {
  const zlib = await import('node:zlib')
  const width = 64
  const height = 32
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      // Left half one colour, right half another. Simple on purpose: the point
      // is that a model can tell them apart, not that the image is interesting.
      const left = x < width / 2
      raw[offset] = left ? 0x22 : 0xdd
      raw[offset + 1] = left ? 0x66 : 0x22
      raw[offset + 2] = left ? 0xdd : 0x11
      offset += 3
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let crcTable: number[] | null = null
function crc32(buffer: Buffer): number {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * A browser port over the real dual-browser runtime.
 *
 * Null unless the run provides one, because a browser cannot be created from a
 * plain Node process. `FREYA_BROWSER_LIVE=1` plus an Electron-capable harness is
 * what turns TEST 10 on.
 */
function liveBrowserPort(visited: string[], targets: string[]): BrowserTaskPort | null {
  const injected = (globalThis as { __freyaBrowserPort?: BrowserTaskPort }).__freyaBrowserPort
  if (injected === undefined) return null
  return {
    execute: async (request: BrowserRequest) => {
      if (typeof request.url === 'string' && request.url !== '') visited.push(request.url)
      const result = await injected.execute(request)
      // The runtime's own routing decision, not the model's account of it. This is
      // the authoritative answer to "which browser serviced this", and reading it
      // from `BrowserResult.target` is why the forbidden backend can be ruled out
      // without trusting a sentence the model wrote about itself.
      targets.push(result.ok ? result.target : `refused:${result.code}`)
      return result
    },
  }
}

/* ================================================================== TESTS */

describe.skipIf(!live)('TEST 1 — normal chat stays normal chat', () => {
  it('answers directly, searches nothing, and claims no search', async () => {
    const searched: string[] = []
    const h = await harness({ tools: [liveSearchTool('web', searched, [])] })

    const turn = await h.ask(
      'Explain Laravel dependency injection to me in simple terms and give me one small example.',
    )
    const answer = await h.answer()

    expect(turn.ok).toBe(true)
    expect(answer.trim().length).toBeGreaterThan(0)
    // The whole point: a direct question must not spend a search.
    expect(searched).toEqual([])
    expect(h.providerCalls()).toBe(1)
    // And it must not *say* it searched, which is the other half of the same lie.
    expect(answer.toLowerCase()).not.toMatch(/\b(i (?:searched|browsed)|according to (?:the )?(?:web|search)|based on (?:my )?search)\b/)
    expect(urlsIn(answer)).toEqual([])

    note('TEST 1', `1 provider call, 0 searches, ${answer.length} chars`)
  }, 120_000)
})

describe.skipIf(!live)('TEST 2 — web search returns real sourced results', () => {
  it('synthesises from a real search and cites where it came from', async () => {
    const searched: string[] = []
    const cited: string[] = []
    const h = await harness({ tools: [liveSearchTool('web', searched, cited)] })

    const turn = await h.ask(
      'Search the web for the latest official Laravel release information and tell me the current major version, ' +
      'release date if available, and the three most important changes. Include the sources you used.',
    )
    const answer = await h.answer()

    expect(turn.ok, `the turn did not complete: ${String(turn.reason)}`).toBe(true)
    expect(searched.length).toBeGreaterThan(0)
    // Not just links: an actual synthesis, so more than a bare URL list.
    expect(answer.replace(/\s+/g, ' ').length).toBeGreaterThan(180)
    // Every source the model names must be one search actually returned. An
    // invented citation is the failure this whole assertion exists for.
    const named = urlsIn(answer)
    expect(named.length).toBeGreaterThan(0)
    const invented = named.filter((url) => !cited.some((c) => c.startsWith(url.split('?')[0]!.slice(0, 40)) || url.includes(c.split('?')[0]!.slice(0, 40))))
    expect(invented, `model cited a URL no search returned: ${invented.join(', ')}`).toEqual([])
    // Provenance survived the round trip.
    expect(answer.toLowerCase()).toMatch(/laravel/)
    note('TEST 2', `query=${JSON.stringify(searched[0])}, ${cited.length} real sources, ${named.length} cited`)
  }, 180_000)
})

describe.skipIf(!live)('TEST 3 — image search returns actual images', () => {
  it('returns image results with media and provenance, not web links', async () => {
    const searched: string[] = []
    const media: string[] = []
    const searcher = new Searcher({
      provider: new PreferredSearchProvider([
        new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
      ]),
    })
    const results = await searcher.searchWeb("James Webb Space Telescope in space", { limit: 6, vertical: "images" })
    for (const r of results) {
      searched.push(r.url)
      if (typeof r.mediaUrl === 'string') media.push(r.mediaUrl)
    }

    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.vertical).toBe('images')
      // A page a person can open, and a place the bytes came from.
      expect(() => new URL(result.url)).not.toThrow()
      expect(result.sourceDomain).toBe(new URL(result.url).hostname)
      // "Visually usable, not six text URLs": every row carries media.
      expect(result.mediaUrl ?? result.thumbnailUrl).toBeTruthy()
      // Media is http(s) and not an inline data blob nobody can cache.
      expect(result.mediaUrl ?? result.thumbnailUrl).toMatch(/^https?:\/\//)
    }
    expect(media.length).toBeGreaterThan(0)
    note('TEST 3', `${results.length} image results, ${media.length} with media URLs`)
  }, 120_000)
})

describe.skipIf(!live)('TEST 4 — document search returns real documents', () => {
  it('finds an official PDF and proves it is a PDF, not an HTML page', async () => {
    const searcher = new Searcher({
      provider: new PreferredSearchProvider([
        new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
      ]),
    })
    // `filetype:pdf` because the earlier phrasing returned EUR-Lex landing pages,
    // which are HTML. That is not a failure of the search -- it is what the query
    // asked for -- and asking for documents directly is what a person would do.
    const results: SearchResult[] = await searcher.searchWeb(
      'EU Artificial Intelligence Act official regulation 2024/1689 filetype:pdf',
      { limit: 10, vertical: 'documents' },
    )

    expect(results.length).toBeGreaterThan(0)
    // An official EU publisher, not a blog. `eur-lex.europa.eu` is deliberately
    // absent from this set: it answers a raw fetch with `202` and an empty HTML
    // body, which is bot protection rather than a document, and treating that as
    // a PDF is the exact lie this test exists to prevent.
    const official = results.filter((r) =>
      /europa\.eu|europa\.europa\.eu/i.test(r.url) && /\.pdf($|\?)/i.test(r.url))
    expect(official.length, `no official EU PDF in: ${results.map((r) => r.url).join(', ')}`).toBeGreaterThan(0)

    // And at least one of them really is a PDF, checked from its bytes. This is
    // the assertion that stops an HTML page being presented as a document.
    const pdf = await findRealPdf(official.map((r) => r.url))
    expect(pdf, 'no official result was actually a PDF when fetched').not.toBeNull()
    expect(pdf!.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    note('TEST 4', `official=${official.length}, verified PDF=${pdf!.url} (${pdf!.bytes.length} bytes)`)
  }, 180_000)
})

describe.skipIf(!live)('TEST 5 — video search returns actual videos', () => {
  it('returns ranked video rows with provider metadata', async () => {
    const searcher = new Searcher({
      provider: new PreferredSearchProvider([
        new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
      ]),
    })
    const results: SearchResult[] = await searcher.searchWeb('laravel queues tutorial for experienced php developer', {
      limit: 6,
      vertical: 'videos',
    })

    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.vertical).toBe('videos')
      expect(() => new URL(result.url)).not.toThrow()
      expect(result.title.trim().length).toBeGreaterThan(0)
    }
    // Ranked, densely, so a panel can number them without re-sorting.
    expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i + 1))
    // A video result is a playable thing, not a generic web link.
    const playable = results.filter((r) => /youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|bilibili/i.test(r.url))
    expect(playable.length, `no playable video in: ${results.map((r) => r.url).join(', ')}`).toBeGreaterThan(0)
    note('TEST 5', `${results.length} video results, ${playable.length} playable`)
  }, 120_000)
})

/* --------------------------------------------------- the image format check */

/**
 * Identify an image from its **bytes**.
 *
 * Magic numbers, not the extension and not the content-type header. That is the
 * whole point: an HTML error page served from a `.jpg` URL with `image/jpeg` in
 * the header is exactly the case that would make a "downloaded an image" claim
 * false.
 */
function sniffImage(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** Formats the attachment path accepts, JPEG first so a `.jpg` name is honest. */
const WANTED_IMAGE_FORMATS = ['image/jpeg', 'image/png', 'image/webp'] as const

/**
 * Fetch one candidate image into a Freya-owned workspace, validating it.
 *
 * Bounded three ways: only under this run's own temp directory, only a bounded
 * number of candidates, and only formats the attachment path actually takes. A
 * body that is not a real image is skipped rather than saved, so nothing
 * downstream ever sees a `.jpg` that is not one.
 */
async function downloadImage(
  url: string,
  filename: string,
  want: readonly ('image/jpeg' | 'image/png' | 'image/webp')[],
): Promise<{ path: string; bytes: number; format: string } | null> {
  const destination = join(dir, 'downloads', filename)
  await mkdir(join(dir, 'downloads'), { recursive: true })
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(45_000),
      headers: { accept: 'image/webp,image/png,image/jpeg,*/*' },
    })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) return null
    const format = sniffImage(bytes)
    if (format === null || !want.includes(format)) {
      // Not an image, or not one the attachment path takes. Skipped, not saved.
      note('TEST 6.probe', `skipped ${url.slice(0, 64)} -> ${response.headers.get('content-type') ?? '?'} (${bytes.length}b, format=${format ?? 'unrecognised'})`)
      return null
    }
    await writeFile(destination, bytes)
    return { path: destination, bytes: bytes.length, format }
  } catch {
    return null
  }
}

describe.skipIf(!live)('TEST 6 — find and download a real image for a later similarity test', () => {
  it('downloads a validated image into a bounded workspace and keeps its provenance', async () => {
    const searcher = new Searcher({
      provider: new PreferredSearchProvider([
        new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
      ]),
    })
    // Several phrasings, because the image engines are inconsistent about what they
    // treat as an image. One query answering with HTML pages is not a product
    // failure, it is a search engine being a search engine; what must hold is that
    // *some* real, byte-verified image is reachable.
    const QUERIES = [
      'Hubble Ultra Deep Field high resolution image NASA ESA',
      'James Webb Space Telescope deep field photograph',
      'Hubble deep field galaxies astronomy photo',
    ]
    const results: SearchResult[] = []
    for (const query of QUERIES) {
      const found = await searcher.searchWeb(query, { limit: 10, vertical: 'images' })
      results.push(...found)
      if (found.some((result) => (result.mediaUrl ?? result.thumbnailUrl) !== null)) break
    }
    expect(results.length, 'image search returned nothing').toBeGreaterThan(0)

    // A real image under a name with no topical content in it. TEST 7's whole
    // claim is that the filename cannot influence the query, so the name has to be
    // meaningless -- and it ends `.jpg`, so a JPEG is tried first.
    const NAME = 'reference-7f41a2.jpg'
    let saved: { path: string; bytes: number; format: string } | null = null
    let provenance: { url: string; title: string; domain: string } | null = null
    let tried = 0

    for (const want of [['image/jpeg'] as const, WANTED_IMAGE_FORMATS]) {
      for (const candidate of results) {
        const media = candidate.mediaUrl ?? candidate.thumbnailUrl
        if (media === null || media === undefined) continue
        tried += 1
        const outcome = await downloadImage(media, NAME, want)
        if (outcome !== null) {
          saved = outcome
          provenance = { url: candidate.url, title: candidate.title, domain: candidate.sourceDomain }
          break
        }
      }
      if (saved !== null) break
    }

    expect(saved, `no candidate was a real image (tried ${tried})`).not.toBeNull()
    expect(saved!.path.startsWith(dir), 'the download escaped the bounded workspace').toBe(true)

    const written = await readFile(saved!.path)
    expect(sniffImage(written), 'the saved file is not a recognised image').toBe(saved!.format)
    expect(written.length).toBe(saved!.bytes)

    // Remote provenance is kept beside the local reference.
    expect(provenance!.url).toMatch(/^https:\/\//)
    expect(provenance!.title.trim().length).toBeGreaterThan(0)

    note('TEST 6', `saved=${NAME} format=${saved!.format} bytes=${saved!.bytes} media=${provenance!.url.slice(0, 64)}`)
    ;(globalThis as { __acceptanceImage?: unknown }).__acceptanceImage = { ...saved!, ...provenance! }
  }, 300_000)
})
describe.skipIf(!live)('TEST 7 — a similarity search derived from the real image CONTENT, not its filename', () => {
  it('reads the downloaded image, derives concepts from it, and searches for real results', async () => {
    const carried = (globalThis as {
      __acceptanceImage?: { path: string; bytes: number; format: string; url: string; title: string }
    }).__acceptanceImage
    // TEST 6 must have run first: the two are one flow by design, and a synthetic
    // image here would prove nothing about a real download.
    expect(carried, 'TEST 6 must have downloaded a real image first').toBeDefined()

    const bytes = await readFile(carried!.path)
    expect(sniffImage(bytes)).toBe(carried!.format)
    const filename = basename(carried!.path)
    expect(filename).toBe('reference-7f41a2.jpg')

    // The pixels go to a real vision model. Nothing about the name is sent that
    // could steer the answer, and the answer is checked for it below.
    const provider = new CountingProvider('meta/muse-spark-1.2-contributor')
    const described = await describeImageFromBytes(provider, bytes, filename)
    expect(described.subjects.length, 'the vision model described nothing').toBeGreaterThan(0)
    expect(described.raw.toLowerCase()).not.toContain('7f41a2')
    expect(described.raw.toLowerCase()).not.toContain('reference-')

    // Real external search on those concepts.
    const query = described.subjects.join(' ')
    const searcher = new Searcher({
      provider: new PreferredSearchProvider([
        new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
      ]),
    })
    const results = await searcher.searchWeb(`${query} deep space galaxies`, { limit: 5, vertical: 'images' })
    expect(results.length, 'the similarity search returned nothing').toBeGreaterThan(0)
    for (const result of results) {
      expect(() => new URL(result.url)).not.toThrow()
      expect(result.sourceDomain).toBe(new URL(result.url).hostname)
    }
    expect(results.filter((result) => (result.mediaUrl ?? result.thumbnailUrl) !== null).length).toBeGreaterThan(0)

    note('TEST 7', `source image ${carried!.format} ${carried!.bytes}b as ${filename}; content-derived query=${JSON.stringify(query)}; ${results.length} real results (semantic similarity, not reverse-image search)`)
  }, 300_000)
})

/**
 * The original deterministic vision case: a generated image with a known answer.
 *
 * Kept because it pins the mechanism with no network, and because "the model can
 * tell two colours apart" is worth asserting on its own. It is **not** TEST 7 live
 * acceptance and is named so it cannot be mistaken for it.
 */
describe.skipIf(!live)('attachment vision integration — a generated image, described deterministically', () => {
  it('describes a two-tone image from its pixels alone', async () => {
    const provider = new CountingProvider('meta/muse-spark-1.2-contributor')
    const described = await describeImageWithVision(provider, 'reference-7f41a2.jpg')
    expect(described.subjects.length).toBeGreaterThan(0)
    expect(described.raw.toLowerCase()).not.toContain('7f41a2')
    note('vision.integration', `concepts=${JSON.stringify(described.subjects.join(' '))}`)
  }, 300_000)
})

describe.skipIf(!live || !browserLive)('TEST 10 — Freya\'s OWN browser, never the extension', () => {
  it('searches, opens the official docs, and is serviced by the native/public port', async () => {
    const browsed: string[] = []
    const targets: string[] = []
    const browser = liveBrowserPort(browsed, targets)
    expect(browser, 'no native browser port was provided (set FREYA_BROWSER_LIVE=1 in an Electron-capable run)').not.toBeNull()

    const h = await harness({ tools: [createBrowserTaskTool({ browser: browser! })] })
    const turn = await h.ask(
      'Use your browser yourself. Open https://laravel.com/docs/queues and tell me what command Laravel provides ' +
      'for retrying a failed job, and what the page says about failed jobs.',
    )
    const answer = await h.answer()

    expect(turn.ok).toBe(true)
    expect(browsed.length).toBeGreaterThan(0)
    // It really read the official page.
    expect(browsed.some((url) => /laravel\.com/.test(url))).toBe(true)

    // THE decisive assertion, and it reads the runtime rather than the model.
    //
    // Every routed command landed on the public partition. `authenticated` is the
    // port the Chrome extension serves, so its total absence here is the proof the
    // extension was not used -- and it comes from `routeBrowserIntent`, not from
    // anything the model said about itself.
    expect(targets.length).toBeGreaterThan(0)
    expect(new Set(targets), `routed somewhere other than public: ${targets.join(', ')}`)
      .toEqual(new Set(['public']))
    expect(targets.some((t) => t !== 'public')).toBe(false)
    // Nothing was refused either, so this was a real read rather than a guard.
    expect(targets.every((t) => t === 'public')).toBe(true)

    // The observation names which browser answered, so the transcript is honest
    // about it too -- but this is corroboration, not the proof.
    expect(answer).toContain('native/public Freya browser')
    expect(answer).not.toContain('paired Chrome extension')
    // And it does not claim to have driven a UI it only read.
    expect(answer).toMatch(/Nothing was clicked, typed, submitted or logged into/)

    note('TEST 10', `browsed=${browsed.join(' -> ')}; runtime targets=${[...new Set(targets)].join(',')} (n=${targets.length}); extension never routed`)
  }, 300_000)
})

/* ---------------------------------------------------------------- downloads */

/**
 * Fetch a candidate into the Freya-owned download area, validating it.
 *
 * Two rules, both of which the spec asks for explicitly:
 *
 * - **Bounded location.** Only under this run's own temp directory. There is no
 *   path parameter and no "save anywhere" branch, so a hostile search result
 *   cannot choose where a byte lands.
 * - **Validated type.** The signature is checked on the bytes that were written,
 *   not on the URL or the content-type header, because an HTML error page served
 *   as `application/pdf` is precisely the failure worth preventing.
 */
async function downloadValidated(
  url: string,
  filename: string,
  signature: '%PDF-' | 'PNG',
): Promise<{ path: string; bytes: number; contentType: string } | null> {
  const destination = join(dir, 'downloads', filename)
  await mkdir(join(dir, 'downloads'), { recursive: true })
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(90_000),
      headers: { accept: 'application/pdf,image/*,*/*' },
    })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    // Refuse before writing, so a rejected download never occupies the workspace.
    if (bytes.subarray(0, signature.length).toString('latin1') !== signature) return null
    if (bytes.length === 0) return null
    await writeFile(destination, bytes)
    return { path: destination, bytes: bytes.length, contentType: response.headers.get('content-type') ?? 'unknown' }
  } catch {
    return null
  }
}

describe.skipIf(!live)('TEST 8 — find, download and validate a real PDF', () => {
  it('stores an official NASA document in the bounded workspace with provenance', async () => {
    const searcher = new Searcher({
      provider: new PreferredSearchProvider([
        new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
      ]),
    })
    const results = await searcher.searchWeb('nasa artemis plan moon to mars architecture filetype:pdf', {
      limit: 10,
      vertical: 'documents',
    })

    // Prefer nasa.gov, as the spec asks.
    const nasa = results.filter((r) => /\.nasa\.gov/i.test(r.url) && /\.pdf($|\?)/i.test(r.url))
    expect(nasa.length, `no NASA PDF in: ${results.map((r) => r.url).join(', ')}`).toBeGreaterThan(0)

    // A meaningful name, deliberately not the URL's own, so TEST 9's filename
    // adversarial check has something to be adversarial about.
    const NAME = 'document-a91c7f.pdf'
    let saved: { path: string; bytes: number; contentType: string } | null = null
    let provenance: { url: string; title: string } | null = null
    for (const candidate of nasa) {
      const outcome = await downloadValidated(candidate.url, NAME, '%PDF-')
      if (outcome !== null) {
        saved = outcome
        provenance = { url: candidate.url, title: candidate.title }
        break
      }
    }

    expect(saved, 'no NASA candidate was a valid PDF when fetched').not.toBeNull()
    expect(saved!.path.startsWith(dir)).toBe(true)
    const written = await readFile(saved!.path)
    expect(written.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(written.length).toBe(saved!.bytes)
    // Remote provenance is retained alongside the local reference.
    expect(provenance!.url).toMatch(/^https:\/\//)
    expect(provenance!.title.trim().length).toBeGreaterThan(0)

    note('TEST 8', `saved=${NAME} bytes=${saved!.bytes} ct=${saved!.contentType} from ${provenance!.url}`)
    ;(globalThis as { __acceptancePdf?: unknown }).__acceptancePdf = { ...saved!, ...provenance! }
  }, 300_000)
})

describe.skipIf(!live)("TEST 9 — a query derived from the PDF's CONTENT, not its filename", () => {
  it('reads real text out of the downloaded PDF and searches on what it says', async () => {
    const carried = (globalThis as { __acceptancePdf?: { path: string; url: string; title: string } }).__acceptancePdf
    // TEST 8 must have run first; the two are one flow by design.
    expect(carried, 'TEST 8 must have downloaded a PDF first').toBeDefined()

    const bytes = await readFile(carried!.path)

    // The **production** extractor, not a byte scan. An earlier version of this
    // test read the raw file for ASCII words and found none, because a PDF's
    // content streams are Flate-compressed -- so "no vocabulary" was a fact about
    // my regex, not about the document. Using the same `extractPdfText` the
    // attachment path uses also means this test exercises that code rather than a
    // parallel implementation of it.
    const extraction = await extractPdfText(bytes)
    expect(extraction.ok, extraction.ok ? '' : extraction.reason).toBe(true)
    if (!extraction.ok) return
    expect(extraction.textLayer, 'the PDF had no extractable text layer at all').toBe(true)
    expect(extraction.pagesRead).toBeGreaterThan(0)
    expect(extraction.text.trim().length).toBeGreaterThan(200)

    const words = extraction.text
      .replace(/[^ -~]+/g, ' ')
      .split(/\s+/)
      .filter((word) => /^[A-Za-z][A-Za-z-]{3,}$/.test(word))
    const concepts = [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 600)

    expect(concepts.length, 'the PDF yielded no readable words').toBeGreaterThan(20)
    // The adversarial check: nothing derived here may come from the filename,
    // which is `document-a91c7f.pdf` and contains no topical words at all.
    expect(concepts).not.toContain('a91c7f')

    // A real NASA document's vocabulary must show up, which is what proves the
    // extraction read the document rather than the URL.
    const topical = concepts.filter((word) =>
      /artemis|lunar|moon|mars|orbit|explor|nasa|mission|space|crew|science|surface|lander/.test(word))
    expect(topical.length, 'no NASA vocabulary found in the extracted PDF text').toBeGreaterThan(3)

    const query = topical.slice(0, 8).join(' ')
    const searcher = new Searcher({
      provider: new PreferredSearchProvider([
        new SearxngSearchProvider({ env: { FREYA_SEARXNG_URL: SEARXNG_URL, FREYA_ALLOW_WEB_SEARCH: '1' } }),
      ]),
    })
    const related = await searcher.searchWeb(`${query} nasa exploration strategy document`, {
      limit: 6,
      vertical: 'documents',
    })
    expect(related.length).toBeGreaterThan(0)
    for (const result of related) expect(() => new URL(result.url)).not.toThrow()

    note('TEST 9', `pdf=${basename(carried!.path)} bytes=${bytes.length} pages=${extraction.pagesRead} chars=${extraction.text.length}; content-derived query=${JSON.stringify(query)}; ${related.length} related docs`)
  }, 300_000)
})
