// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CHAT_INTENTS,
  isExplicitDeepResearchRequest,
  routeChatIntent,
  routePromptIntent,
  type ChatIntent,
  type ChatIntentContext,
} from '../../src/app/chat/intent'

/*
 * One message in, one intent out.
 *
 * The router is pure, so it is tested as pure: no host bridge, no filesystem, no
 * clock. Two failure modes matter here. The first is the bug this file exists
 * for — a leading preposition ("In your opinion…", "With the new layout…") used
 * to be enough to push a conversation into a web-search session. The second is
 * over-eager search: routing something to the wrong kind of search is worse
 * than answering it, so genuine uncertainty has to land on `direct_answer`.
 */

const NONE: ChatIntentContext = { activeEyeSession: false }

describe('explicit research restrictions', () => {
  it.each([
    'Do not use web search. Format the supplied values.',
    "Don't search the web for this. Explain the example.",
    'Answer without searching online, even though I mentioned the latest release.',
    'No web search; show me sources already in this conversation.',
    'Do not use your browser. Explain the supplied page text.',
  ])('keeps a declined lookup in conversation: %s', text => {
    expect(routeChatIntent(text, NONE).kind).toBe('direct_answer')
  })
  it('does not promote a declined deep research mention', () => {
    expect(routePromptIntent('Do not do deep research. Summarise my notes.', NONE).kind).toBe('chat')
  })
  it('does not mistake an empty-result description for a search restriction', () => {
    expect(routeChatIntent('There are no search results yet. Search the web for caching.', NONE).kind).toBe('web_search')
  })
  it('keeps an explicit no-search instruction out of an existing Eye session', () => {
    expect(routePromptIntent('No web search; summarise the existing results.', { activeEyeSession: true }).kind).toBe('chat')
  })
})

function route(text: string, context: ChatIntentContext = NONE): ChatIntent {
  return routeChatIntent(text, context).kind
}

interface TableRow {
  readonly text: string
  readonly intent: ChatIntent
}

const CONVERSATION: readonly TableRow[] = [
  { text: 'In your opinion, what is the best approach to caching?', intent: 'direct_answer' },
  { text: 'With the new layout, how would you restructure this component?', intent: 'direct_answer' },
  { text: 'About the roadmap, can you summarise the three themes?', intent: 'direct_answer' },
  { text: 'From my perspective, this trade-off is the wrong default.', intent: 'direct_answer' },
  { text: 'During onboarding, which tools do new hires need?', intent: 'direct_answer' },
  { text: 'At the standup, remind me what I promised the design team.', intent: 'direct_answer' },
  { text: 'Near the end of the file there is an off-by-one leak.', intent: 'direct_answer' },
  {
    text: 'Explain Laravel dependency injection in simple terms and give me one small example',
    intent: 'direct_answer',
  },
  { text: 'What is the difference between a migration and a seeder?', intent: 'direct_answer' },
  { text: 'Why is a whitepaper different from a paper?', intent: 'direct_answer' },
  { text: 'Explain the difference between a whitepaper and a research paper', intent: 'direct_answer' },
  { text: 'Rewrite this function so it handles empty arrays.', intent: 'direct_answer' },
  { text: 'Watch out for null bytes in this parser.', intent: 'direct_answer' },
  { text: 'Show me the code in src/app/chat/intent.ts', intent: 'direct_answer' },
  { text: 'Where can I find the nearest coffee shop?', intent: 'direct_answer' },
  { text: 'Find a good recipe for ossobuco.', intent: 'direct_answer' },
  { text: 'What browser should I use for automated testing?', intent: 'direct_answer' },
]

const WEB: readonly TableRow[] = [
  { text: 'Look this up for me.', intent: 'web_search' },
  { text: 'search online for a cheap standing desk', intent: 'web_search' },
  { text: 'Find sources on the EU AI Act enforcement timeline.', intent: 'web_search' },
  { text: 'search the web for the latest Laravel release notes', intent: 'web_search' },
  { text: "what's the latest stable Node.js LTS?", intent: 'web_search' },
  { text: 'Find an article about idempotency keys.', intent: 'web_search' },
  { text: 'Find documentation for the Laravel scheduler.', intent: 'web_search' },
]

const IMAGES: readonly TableRow[] = [
  { text: 'find me 6 good images of the James Webb Space Telescope', intent: 'image_search' },
  { text: 'show me images of nebulae', intent: 'image_search' },
  { text: 'pictures of brutalist libraries in Tokyo', intent: 'image_search' },
  { text: 'find pictures of the Cinque Terre', intent: 'image_search' },
]

const DOCUMENTS: readonly TableRow[] = [
  { text: 'Find the official PDF version of the EU AI Act', intent: 'document_search' },
  { text: 'Find the paper on attention mechanisms.', intent: 'document_search' },
  { text: 'Locate the official document for GDPR data processing.', intent: 'document_search' },
  { text: 'Do you have the Anthropic whitepaper?', intent: 'document_search' },
  { text: 'What is the spec sheet for the Ryzen 9?', intent: 'document_search' },
]

const VIDEOS: readonly TableRow[] = [
  { text: 'find 5 useful recent videos explaining Laravel queues', intent: 'video_search' },
  { text: 'a video explaining how HTTP caching works', intent: 'video_search' },
  { text: 'watch a tutorial on Postgres indexes', intent: 'video_search' },
  { text: 'find a talk on Rust for async', intent: 'video_search' },
]

const BROWSER: readonly TableRow[] = [
  { text: 'use your browser yourself', intent: 'native_browser_task' },
  { text: 'Use your own browser to check the pricing page.', intent: 'native_browser_task' },
  { text: 'Use your browser to find images of the Eiffel Tower', intent: 'native_browser_task' },
  { text: 'drive your browser to the admin panel', intent: 'native_browser_task' },
  { text: 'browse to example.com/pricing and tell me what it says', intent: 'native_browser_task' },
  { text: 'Open the page yourself and summarise it.', intent: 'native_browser_task' },
  { text: 'go look it up yourself and tell me the price', intent: 'native_browser_task' },
  { text: 'search and click the result', intent: 'native_browser_task' },
  { text: 'Log in to my bank yourself and check the balance.', intent: 'native_browser_task' },
]

const AUDIO: readonly TableRow[] = [
  { text: 'find me podcasts about cryptography', intent: 'audio_search' },
  { text: 'play music for sleeping', intent: 'audio_search' },
  { text: 'find a song called Freya', intent: 'audio_search' },
]

const PAGES: readonly TableRow[] = [
  { text: 'find galleries of brutalist libraries', intent: 'page_search' },
  { text: 'find me a thread on this topic', intent: 'page_search' },
  { text: 'show me a writeup of the EU AI Act timeline', intent: 'page_search' },
]

const TABLE: readonly TableRow[] = [...CONVERSATION, ...WEB, ...IMAGES, ...DOCUMENTS, ...VIDEOS, ...BROWSER, ...AUDIO, ...PAGES]

const ATTACHMENT_CASES: readonly {
  readonly text: string
  readonly context: ChatIntentContext
  readonly intent: ChatIntent
}[] = [
  {
    text: 'What is similar to this image?',
    context: { activeEyeSession: false, hasImage: true },
    intent: 'attachment_image',
  },
  {
    text: 'Find documents similar to this.',
    context: { activeEyeSession: false, hasDocument: true },
    intent: 'attachment_document',
  },
]

describe('every intent is reachable and every route carries a reason', () => {
  it('routes into exactly the declared intents', () => {
    expect(CHAT_INTENTS).toHaveLength(10)
    const reached = new Set([
      ...TABLE.map((row) => row.intent),
      ...ATTACHMENT_CASES.map((row) => route(row.text, row.context)),
    ])
    expect([...reached].sort()).toEqual([...CHAT_INTENTS].sort())
  })

  it('gives every route a short factual reason', () => {
    for (const row of TABLE) {
      const result = routeChatIntent(row.text, NONE)
      expect(result.kind).toBe(row.intent)
      expect(result.reason.length).toBeGreaterThan(0)
      expect(result.reason.length).toBeLessThan(80)
    }
    for (const row of ATTACHMENT_CASES) {
      const result = routeChatIntent(row.text, row.context)
      expect(result.kind).toBe(row.intent)
      expect(result.reason.length).toBeGreaterThan(0)
      expect(result.reason.length).toBeLessThan(80)
    }
  })

  it('routes the same message to the same intent every time', () => {
    for (const row of TABLE) {
      expect(route(row.text)).toBe(route(row.text))
      expect(route(row.text.toUpperCase())).toBe(row.intent)
    }
  })

  it('preserves the exact query text on every route', () => {
    const phrases = [
      'find 10 cat videos on YouTube',
      '   hello there   ',
      'A search for "EU AI Act" white papers',
    ]
    for (const phrase of phrases) {
      const route = routeChatIntent(phrase, NONE)
      expect(route.query).toBe(phrase)
    }
  })

  it('surfaces the vertical a search wants without hardcoding a provider', () => {
    expect(routeChatIntent('find pictures of nebulae', NONE).vertical).toBe('images')
    expect(routeChatIntent('find me a podcast about Kotlin', NONE).vertical).toBe('audio')
    expect(routeChatIntent('find galleries of brutalist libraries', NONE).vertical).toBe('pages')
    expect(routeChatIntent('search the web for Laravel release notes', NONE).vertical).toBe('web')
    expect(routeChatIntent('find the official PDF version of GDPR', NONE).vertical).toBe('documents')
    expect(routeChatIntent('find me videos explaining Postgres indexes', NONE).vertical).toBe('videos')
  })
})

describe('a leading preposition is never a search signal', () => {
  const PREPOSITIONS = ['In', 'With', 'About', 'From', 'At', 'During', 'Near', 'On', 'For', 'After']

  it.each(PREPOSITIONS)('"%s …" stays a conversation', (preposition) => {
    expect(route(`${preposition} your opinion, what is the best approach here?`)).toBe('direct_answer')
  })

  it('keeps the exact sentences that used to be misrouted', () => {
    expect(route('In your opinion, what is the best approach?')).toBe('direct_answer')
    expect(route('With the new layout, how would you do it?')).toBe('direct_answer')
    expect(route('About the roadmap, can you summarise?')).toBe('direct_answer')
    expect(route('From my perspective, this is the wrong default.')).toBe('direct_answer')
  })

  it('does not treat a refinement preposition as a refinement either', () => {
    expect(routePromptIntent('In your opinion, which should we ship?', { activeEyeSession: true })).toEqual({
      kind: 'chat',
      reason: 'conversation',
    })
    expect(routePromptIntent('only YouTube', { activeEyeSession: true }).kind).toBe('eye-follow-up')
  })
})

describe('a media noun beats a generic find or search', () => {
  it('prefers the media the owner actually named', () => {
    expect(route('find me 6 good images of the James Webb Space Telescope')).toBe('image_search')
    expect(route('search the web for the latest Laravel release notes')).toBe('web_search')
    expect(route('find 5 useful recent videos explaining Laravel queues')).toBe('video_search')
    expect(route('find the official PDF version of the EU AI Act')).toBe('document_search')
    expect(route('Explain Laravel dependency injection in simple terms and give me one small example')).toBe(
      'direct_answer',
    )
  })

  it('takes the earliest media noun when several are named', () => {
    expect(route('find videos and images of the aurora')).toBe('video_search')
    expect(route('find images and videos of the aurora')).toBe('image_search')
  })
})

describe('an attachment outranks the wording', () => {
  it('routes a deictic image question to the image, never to a filename search', () => {
    expect(route('What is similar to this image?', { activeEyeSession: false, hasImage: true })).toBe(
      'attachment_image',
    )
    expect(route('What is in this screenshot?', { activeEyeSession: false, hasImage: true })).toBe(
      'attachment_image',
    )
  })

  it('routes a deictic document question to the document', () => {
    expect(route('Find documents similar to this.', { activeEyeSession: false, hasDocument: true })).toBe(
      'attachment_document',
    )
    expect(route('Compare this invoice to my last one', { activeEyeSession: false, hasDocument: true })).toBe(
      'attachment_document',
    )
  })

  it('prefers the attachment intent over what the same words would mean without one', () => {
    expect(route('What is similar to this image?')).toBe('direct_answer')
    expect(route('Find documents similar to this.')).toBe('document_search')
  })

  it('reads an attachment with no text at all as the subject', () => {
    expect(route('   ', { activeEyeSession: false, hasImage: true })).toBe('attachment_image')
  })

  it('prefers the image when both kinds are attached', () => {
    expect(route('Anything like this?', { activeEyeSession: false, hasImage: true, hasDocument: true })).toBe(
      'attachment_image',
    )
  })

  it('still lets an explicit browser request win over an attachment', () => {
    expect(route('Use your browser to check this invoice', { activeEyeSession: false, hasDocument: true })).toBe(
      'native_browser_task',
    )
  })
})

describe('driving the browser wins over any search signal in the same message', () => {
  it('beats an image request', () => {
    expect(route('Use your browser to find images of the Eiffel Tower')).toBe('native_browser_task')
  })

  it('beats a web request', () => {
    expect(route('Search the web yourself and click the first result')).toBe('native_browser_task')
  })

  it('still answers a plain question about a browser in conversation', () => {
    expect(route('What browser should I use for automated testing?')).toBe('direct_answer')
    expect(route('Explain how to click the link yourself')).toBe('direct_answer')
  })
})

describe('uncertainty defaults to a direct answer', () => {
  it('never searches on a bare noun or a bare verb', () => {
    expect(route('Show me the code in src/app/chat/intent.ts')).toBe('direct_answer')
    expect(route('list the open issues on the tracker')).toBe('direct_answer')
    expect(route('download the release notes for v2')).toBe('direct_answer')
    expect(route('What is a talk?')).toBe('direct_answer')
    expect(route('How do I talk to my manager about a raise?')).toBe('direct_answer')
  })

  it('needs freshness plus a question before it looks anything up', () => {
    expect(route("what's the latest stable Node.js LTS?")).toBe('web_search')
    expect(route('Is the current implementation thread-safe?')).toBe('direct_answer')
    expect(route('Currently, how does the importer work?')).toBe('direct_answer')
  })
})

describe('empty input is safe', () => {
  it('returns a direct answer for empty and whitespace-only prompts', () => {
    expect(route('')).toBe('direct_answer')
    expect(route('   ')).toBe('direct_answer')
    expect(route('\n\t  \n')).toBe('direct_answer')
    expect(routeChatIntent('', NONE).reason).toBe('empty prompt')
  })
})

describe('the composer adapter keeps its old contract', () => {
  it('reports an empty prompt as an ambiguous conversation', () => {
    expect(routePromptIntent('   ', { activeEyeSession: false })).toEqual({ kind: 'chat', reason: 'ambiguous' })
  })

  it('promotes an explicit deep-research request', () => {
    expect(routePromptIntent('Do deep research on our Q3 churn', { activeEyeSession: false })).toEqual({
      kind: 'deep-research',
      reason: 'explicit-deep-research',
    })
    expect(isExplicitDeepResearchRequest('compare several independent sources on X')).toBe(true)
    expect(isExplicitDeepResearchRequest('compare the two options')).toBe(false)
  })

  it('keeps short corrections on the live search', () => {
    expect(routePromptIntent('only YouTube', { activeEyeSession: true })).toEqual({
      kind: 'eye-follow-up',
      reason: 'search-refinement',
    })
    expect(routePromptIntent('make it 50', { activeEyeSession: true }).kind).toBe('eye-follow-up')
    expect(routePromptIntent('only YouTube', { activeEyeSession: false })).toEqual({
      kind: 'chat',
      reason: 'conversation',
    })
  })

  it('keeps media discovery and normal questions in conversation', () => {
    // Images, video and documents are ordinary Chat results. Eye remains an
    // explicit mode rather than an automatic detour.
    expect(routePromptIntent('find 5 videos about Laravel queues', { activeEyeSession: false })).toEqual({
      kind: 'chat',
      reason: 'conversation',
    })

    // A question is a question. This used to open a research session instead, which
    // meant the shipping window could not reach the search tools at all: the run
    // reported into a research card and the conversation got no answer.
    expect(routePromptIntent('search the web for the latest Laravel release notes', { activeEyeSession: false })).toEqual({
      kind: 'chat',
      reason: 'conversation',
    })
    expect(routePromptIntent('About the roadmap, can you summarise?', { activeEyeSession: false })).toEqual({
      kind: 'chat',
      reason: 'conversation',
    })
  })

  it('keeps an explicit Deep Research ask in Deep Research', () => {
    expect(routePromptIntent('deep research the EU AI Act across multiple sources', { activeEyeSession: false })).toEqual({
      kind: 'deep-research',
      reason: 'explicit-deep-research',
    })
  })
})

describe('the realistic prompt table holds', () => {
  it.each(TABLE)('$intent — $text', ({ text, intent }) => {
    expect(route(text)).toBe(intent)
  })
})

describe('site constraints come from the owner, not from the kind', () => {
  it('extracts a host from a "on …" preposition', () => {
    const route = routeChatIntent('find 10 cat videos on youtube.com', NONE)
    expect(route.site).toBe('youtube.com')
    expect(route.kind).toBe('video_search')
  })

  it('extracts a host from a site: operator', () => {
    const route = routeChatIntent('site:arxiv.org find papers on transformers', NONE)
    expect(route.site).toBe('arxiv.org')
  })

  it('extracts a host from an embedded URL', () => {
    const route = routeChatIntent('summarise https://example.org/pricing for me', NONE)
    expect(route.site).toBe('example.org')
  })

  it('does not invent a site when the owner did not name one', () => {
    expect(routeChatIntent('find 10 cat videos', NONE).site).toBeNull()
    expect(routeChatIntent('search the web for the latest Laravel release notes', NONE).site).toBeNull()
  })

  it('does not treat bare prepositions in conversation as site constraints', () => {
    // "in your opinion" is conversation, not a search on "opinion.com".
    expect(routeChatIntent('In your opinion, what is the best approach?', NONE).site).toBeNull()
  })
})
