/**
 * Intent routing for the global composer.
 *
 * A plain-Chat message is classified into exactly one of eight intents before
 * Freya decides whether to answer it or to reach for a search tool. The old
 * router tried to guess from single keywords and a leading-preposition rule,
 * which meant ordinary English ("In your opinion, what's the best approach?")
 * was pushed into a web-search session. That whole bug class is gone: no
 * preposition, no single noun and no single verb can promote a message into a
 * search on its own.
 *
 * Design rules:
 *  1. `native_browser_task` is evaluated first. If the owner asked Freya to drive
 *     its own browser, that is what Freya does, whatever else the message says.
 *  2. A real attachment is a stronger signal than any wording. The attachment is
 *     the subject of the turn, so the route is never derived from a filename.
 *  3. Media nouns ("videos", "pictures", "PDFs") are more specific than a generic
 *     "find"/"search", so a retrieval verb + media noun outranks a bare lookup.
 *  4. Uncertain means `direct_answer`. A wrong-kind search is worse than a plain
 *     answer, and no clarification is ever emitted from here — that is a
 *     conversational decision, not a routing one.
 *
 * The function is pure: no I/O, no clock, no randomness, no imports from `core/`.
 * Every route carries a short factual `reason` so the UI can be honest about what
 * it decided without exposing deliberation.
 */

export type ChatIntent =
  | 'direct_answer'
  | 'web_search'
  | 'image_search'
  | 'document_search'
  | 'video_search'
  | 'audio_search'
  | 'page_search'
  | 'attachment_image'
  | 'attachment_document'
  | 'native_browser_task'

export const CHAT_INTENTS: readonly ChatIntent[] = [
  'direct_answer',
  'web_search',
  'image_search',
  'document_search',
  'video_search',
  'audio_search',
  'page_search',
  'attachment_image',
  'attachment_document',
  'native_browser_task',
] as const

/**
 * Everything the router is allowed to know. Attachment facts are optional so
 * existing callers that only know about the Eye session still typecheck.
 */
export interface ChatIntentContext {
  readonly activeEyeSession: boolean
  readonly hasImage?: boolean
  readonly hasDocument?: boolean
}

export interface ChatIntentRoute {
  readonly kind: ChatIntent
  readonly reason: string
  /**
   * The exact text the router decided to retrieve for. Preserved verbatim — no
   * prefixing, noising, or "search:" wrapping.
   *
   * The wire form of this is `intents.query` on the chat turn, so the agent
   * that answers has the same words the owner typed. A search bar that quietly
   * rewrites the question is the contamination class this whole seam exists to
   * prevent.
   */
  readonly query: string
  /**
   * Where the owner asked us to look, if they named a site, domain or category.
   * `null` means "anywhere the search vertical reaches", and the provider stack
   * decides — never an assumption that "videos" means YouTube.
   */
  readonly site: string | null
  /**
   * The vertical the request is for. `web` is the default and is what every
   * retrieval asks for when nothing more specific was named.
   */
  readonly vertical: 'web' | 'images' | 'videos' | 'documents' | 'audio' | 'pages'
}

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * Retrieval verbs. Deliberately excludes "want", "need" and "recommend a talk":
 * they attach to far too much ordinary conversation ("I need to talk about…").
 */
const RETRIEVAL_VERB =
  /\b(?:find|search|look\s+(?:up|for)|lookup|locate|show|get|give|list|fetch|download|grab|pull\s+up|dig\s+up|surface|hunt\s+down|track\s+down|watch|send|share|email)\b/

/** "do you have…", "is there a…", "where can I find…" */
const EXISTENCE_QUESTION =
  /\b(?:is|are)\s+there\s+(?:any|a|an)\b|\b(?:do|does|did|can)\s+(?:you|we|i|they)\s+(?:have|know)\b|\bwhere\s+can\s+i\s+find\b|\banyone\s+(?:know|got)\b/

const IMAGE_NOUNS =
  /\b(?:image|images|picture|pictures|photo|photos|photograph|photographs|graphics?|artwork|illustrations?|wallpapers?|memes?|screenshots?|thumbnails?)\b/

/** "pictures of X", "images showing X" — a media noun used attributively. */
const IMAGE_ATTRITUTIVE =
  /\b(?:image|images|picture|pictures|photo|photos|photograph|photographs|graphics?|artwork|illustrations?|wallpapers?|screenshots?)\s+(?:of|for|about|showing|depicting|from|related|similar)\b/

const VIDEO_NOUNS =
  /\b(?:video|videos|clip|clips|screencasts?|walkthroughs?|webinars?|documentar(?:y|ies)|talks?|keynotes?|lectures?|tutorials?)\b/

/** "a video explaining X", "a talk on X", "tutorials for beginners". */
const VIDEO_ATTRITUTIVE =
  /\b(?:video|videos|clip|clips|screencasts?|walkthroughs?|webinars?|documentar(?:y|ies)|talks?|keynotes?|lectures?|tutorials?)\s+(?:explaining|about|on|showing|covering|teaching|that|which|for)\b/

const AUDIO_NOUNS =
  /\b(?:audio|sound|sounds|song|songs|track|tracks|music|podcast|podcasts|episode|episodes|interview|interviews|mix|mixes|sample|samples)\b/

/** "a podcast about X", "music for sleeping". */
const AUDIO_ATTRITUTIVE =
  /\b(?:audio|sound|music|podcast|podcasts|episode|interview|interviews|song|songs|track|tracks)\s+(?:of|for|about|on|covering|that|which)\b/

/**
 * Page-shaped results: galleries, threads, writeups, columns, entries. Deliberately
 * narrower than {@link WEB_SOURCE_NOUNS}: nouns like "article", "post" and
 * "blog post" already route through the web-source path because they are the
 * common way of saying "find sources about X". Page-noun shapes are the cases
 * where the owner is naming a specific kind of webpage they want to look at.
 */
const PAGE_NOUNS =
  /\b(?:gallery|galleries|thread|threads|writeup|writeups|column|columns|entry|entries|wiki|wikis|article)(?:\s+(?:of|for|about|on|covering))?\b/

/** "an article about X", "a page on Y". */
const PAGE_ATTRITUTIVE =
  /\b(?:gallery|galleries|thread|threads|writeup|writeups|column|columns|entry|entries|wiki|wikis|article)\s+(?:of|for|about|on|covering|that|which)\b/

const DOCUMENT_NOUNS =
  /\b(?:pdf|pdfs|document|documents|paper|papers|white\s?papers?|spec\s+sheets?|specification\s+sheets?|datasheets?|data\s+sheets?|manuals?|preprints?|thesis|theses|dissertation|dissertations?)\b/

const DOCUMENT_ATTRITUTIVE =
  /\b(?:pdf|pdfs|documents?|papers?|white\s?papers?|spec\s+sheets?|datasheets?|manuals?|preprints?|dissertations?)\s+(?:about|on|covering|version|copy|edition|regarding|text)\b/

/** "the official PDF", "the actual paper", "the current spec sheet". */
const DOCUMENT_QUALIFIED =
  /\b(?:official|actual|real|original|full|current|latest|primary|published)\s+(?:pdf|papers?|documents?|white\s?papers?|spec\s+sheets?|datasheets?|manuals?|editions?|copies)\b/

/** Jargon-specific document nouns. Strong enough to stand alone as a request. */
const DOCUMENT_JARGON = /\b(?:white\s?papers?|spec\s+sheets?|specification\s+sheets?|datasheets?|data\s?sheets?)\b/

/** "what is a whitepaper", "difference between a paper and a whitepaper". */
const METADEFINITION_QUESTION =
  /\b(?:what|why|how)\s+(?:is|are|does|do|differ|works?)\b[^.!?]{0,48}\b(?:white\s?papers?|spec\s?sheets?|datasheets?)\b|\b(?:difference|differences|distinction)\s+(?:between|of)\b|\bvs\.?\b|\bdefine\b/

/** "the spec sheet for the Ryzen 9" is a request, not a discussion of the noun. */
const DOCUMENT_COMPLEMENT = /\b(?:white\s?papers?|spec\s?sheets?|specification\s+sheets?|datasheets?|data\s?sheets?)\s+(?:for|of|from)\b/

/** Web destinations: a fetch, not a media file. */
const WEB_SOURCE_NOUNS =
  /\b(?:sources?|links?|websites?|articles?|blogs?|news|publications?|references?|docs|documentation|posts?)\b/

const FRESHNESS =
  /\b(?:latest|newest|most\s+recent|right\s+now|up\s+to\s+date|today(?:'s)?|this\s+week|this\s+month)\b/

const QUESTION =
  /\b(?:what|whats|what's|who|whom|whose|when|where|which|why|how|is|are|any|anyone|tell\s+me|heard\s+about)\b/

/** The owner is asking for an explanation, not for Freya to act. */
const EXPLANATION_FRAME =
  /^\s*(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:explain|describe|teach|walk\s+me)\b|^\s*(?:explain|describe|teach|show)\b|^\s*(?:how|what|why|where)\s+(?:do|can|should|is|are|does)\b/

/** Explicit current-turn restrictions, never inferred from a passing tool mention. */
export function retrievalRestrictions(text: string): { webSearch: boolean; browser: boolean; deepResearch: boolean } {
  const lower = text.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ')
  const negative = "\\b(?:do\\s+not|don't|never|avoid|skip|without|no)\\s+"
  const modifiers = '(?:(?:use|using|do|doing|any|a|the)\\s+){0,3}'
  const offline = new RegExp(`${negative}${modifiers}(?:internet|online|web)\\s+(?:access|retrieval|lookups?)\\b`).test(lower)
  return {
    webSearch: offline || new RegExp(`${negative}${modifiers}(?:(?:web|internet|online)\\s+search(?:ing)?|search(?:ing)?(?!\\s+results?\\b)(?:\\s+(?:on\\s+)?(?:the\\s+)?(?:web|internet|online|again))?|look(?:ing)?\\s+up\\s+(?:on\\s+)?(?:the\\s+)?(?:web|internet|online))\\b`).test(lower),
    browser: offline || new RegExp(`${negative}(?:(?:use|using|open|opening|launch|launching)\\s+)?(?:(?:your|the|freya's)\\s+)?(?:own\\s+)?browser\\b|${negative}brows(?:e|ing)\\b`).test(lower),
    deepResearch: offline || new RegExp(`${negative}${modifiers}deep\\s+research\\b`).test(lower),
  }
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export function routeChatIntent(text: string, context: ChatIntentContext): ChatIntentRoute {
  const value = text.trim()
  const lower = value.toLowerCase().replace(/\s+/g, ' ')
  const site = extractSiteConstraint(value)
  const restrictions = retrievalRestrictions(value)

  // Rule 1 — explicit "drive my own browser". Outranks every search intent: if
  // the owner named the browser, the browser is the answer.
  if (!restrictions.browser && isNativeBrowserRequest(lower)) {
    return {
      kind: 'native_browser_task',
      reason: 'owner asked Freya to drive its own browser',
      query: text,
      site,
      vertical: 'pages',
    }
  }

  // Rule 2 — a real attachment outranks wording. Never derived from a filename.
  const attached = attachmentRoute(context, value)
  if (attached !== null) return { ...attached, query: text, site, vertical: attached.kind === 'attachment_image' ? 'images' : 'documents' }

  // Rule 3 — nothing typed. Not a search request.
  if (value.length === 0) return { kind: 'direct_answer', reason: 'empty prompt', query: text, site, vertical: 'web' }

  if (restrictions.webSearch || (restrictions.browser && isNativeBrowserRequest(lower))) {
    return { kind: 'direct_answer', reason: 'owner declined this lookup', query: text, site, vertical: 'web' }
  }

  // Media type is independent of the requested site/search channel.
  const mediaFirst = mediaRequest(lower)
  if (mediaFirst !== null && mediaFirst.kind !== 'page_search') return { ...mediaFirst, query: text, site }

  // Rule 4 — the owner named the channel ("search the web", "find sources").
  if (isWebChannelRequest(lower)) {
    return { kind: 'web_search', reason: 'online lookup requested', query: text, site, vertical: 'web' }
  }

  // Rule 5 — a retrieval verb plus a media noun is more specific than "find".
  const media = mediaRequest(lower)
  if (media !== null) return { ...media, query: text, site }

  // Rule 6 — "what's the latest…" needs facts Freya does not already hold.
  if (isFreshInformationRequest(lower)) {
    return { kind: 'web_search', reason: 'asks for information that changes over time', query: text, site, vertical: 'web' }
  }

  // Rule 7 — default. Genuinely uncertain stays a conversation.
  return { kind: 'direct_answer', reason: 'no search intent stated', query: text, site, vertical: 'web' }
}

/**
 * Rule 1. Each alternative needs the owner's own words about the browser; a
 * passing mention of "browser" ("what browser should I use?") is a question,
 * not a driving request.
 */
function isNativeBrowserRequest(lower: string): boolean {
  if (
    /\b(?:use|open|launch|start|control|spin\s+up)\b[^.!?]{0,24}\b(?:your|its|freya'?s|the)\s+(?:own\s+)?browser\b/.test(lower) ||
    /\b(?:drive|pilot|operate|steer)\s+(?:your|its|the)\s+browser\b/.test(lower) ||
    /\byour\s+own\s+browser\b/.test(lower) ||
    /\bbrowse\s+to\b/.test(lower) ||
    /\bin\s+(?:your|its|freya'?s)\s+(?:own\s+)?browser\b/.test(lower) ||
    /\b(?:browser|tab|page)\b[^.!?]{0,32}\b(?:yourself|manually|by\s+hand)\b/.test(lower) ||
    /\bsearch\s+and\s+(?:click|open|select|choose|pick)\b/.test(lower)
  ) {
    return true
  }

  // The weaker "…yourself" family only counts as a driving request when the
  // sentence is not framing an explanation of the action.
  if (EXPLANATION_FRAME.test(lower)) return false

  return (
    /\bgo\s+look\s+(?:it|this|that|them|these|those)?\s*up\s+yourself\b/.test(lower) ||
    /\b(?:open|open\s+up|go\s+to|navigate\s+to|visit)\b[^.!?]{0,32}\b(?:page|site|website|url|link)\b[^.!?]{0,24}\byourself\b/.test(lower) ||
    /\b(?:click|tap|fill\s+in|scroll|log\s?in|sign\s?in)\b[^.!?]{0,32}\byourself\b/.test(lower) ||
    /\byourself\b[^.!?]{0,48}\b(?:click|tap|open|select|choose|scroll|fill\s+in|log\s?in|sign\s?in)\b/.test(lower)
  )
}

/**
 * Rule 2. When both an image and a document are attached the image wins: it is
 * the attachment the owner most recently put in front of Freya.
 */
function attachmentRoute(context: ChatIntentContext, value: string): Omit<ChatIntentRoute, 'query' | 'site'> | null {
  const hasImage = context.hasImage === true
  const hasDocument = context.hasDocument === true
  if (!hasImage && !hasDocument) return null

  const note = value.length === 0 ? ', no text' : ''
  if (hasImage) return { kind: 'attachment_image', reason: `image attached${note}`, vertical: 'images' }
  return { kind: 'attachment_document', reason: `document attached${note}`, vertical: 'documents' }
}

/** Rule 4. Naming the web, naming a source, or asking to be shown a link. */
function isWebChannelRequest(lower: string): boolean {
  return (
    /\b(?:search|browse|look)\s+(?:me\s+)?(?:up\s+)?(?:on\s+)?(?:the\s+)?(?:web|internet|online)\b/.test(lower) ||
    /\b(?:web|internet|online)\s+search\b/.test(lower) ||
    /\blook\s+(?:this|that|it|them|these|those)\s+up\b/.test(lower) ||
    /\bgoogle\s+(?:it|this|that|them|for\s+me|me)\b/.test(lower) ||
    /\b(?:cite|citation|reference|references)\b[^.!?]{0,30}\b(?:sources?|links?|websites?|articles?)\b/.test(lower) ||
    isRetrievalBefore(lower, WEB_SOURCE_NOUNS) !== -1
  )
}

/**
 * Rule 5. A retrieval verb paired with a media noun, or a media noun used
 * attributively. When several media nouns appear the earliest one wins, so
 * "find videos and images of X" is a video request.
 */
function mediaRequest(lower: string): Omit<ChatIntentRoute, 'query' | 'site'> | null {
  const image = firstMediaMatch(lower, IMAGE_NOUNS, IMAGE_ATTRITUTIVE)
  const video = firstMediaMatch(lower, VIDEO_NOUNS, VIDEO_ATTRITUTIVE)
  const document = documentMatch(lower)
  const audio = firstMediaMatch(lower, AUDIO_NOUNS, AUDIO_ATTRITUTIVE)
  const page = firstMediaMatch(lower, PAGE_NOUNS, PAGE_ATTRITUTIVE)

  const candidates: readonly { kind: ChatIntent; index: number; reason: string; vertical: ChatIntentRoute['vertical'] }[] = [
    ...(image === -1 ? [] : [{ kind: 'image_search' as const, index: image, reason: 'image retrieval requested', vertical: 'images' as const }]),
    ...(video === -1 ? [] : [{ kind: 'video_search' as const, index: video, reason: 'video retrieval requested', vertical: 'videos' as const }]),
    ...(document === -1 ? [] : [{ kind: 'document_search' as const, index: document, reason: 'document retrieval requested', vertical: 'documents' as const }]),
    ...(audio === -1 ? [] : [{ kind: 'audio_search' as const, index: audio, reason: 'audio retrieval requested', vertical: 'audio' as const }]),
    ...(page === -1 ? [] : [{ kind: 'page_search' as const, index: page, reason: 'page retrieval requested', vertical: 'pages' as const }]),
  ]
  if (candidates.length === 0) return null

  const earliest = candidates.reduce((best, candidate) => (candidate.index < best.index ? candidate : best))
  return { kind: earliest.kind, reason: earliest.reason, vertical: earliest.vertical }
}

function firstMediaMatch(lower: string, nouns: RegExp, attributive: RegExp): number {
  const afterVerb = isRetrievalBefore(lower, nouns)
  if (afterVerb !== -1) return afterVerb
  return lower.search(attributive)
}

/** Index of the media noun when a retrieval verb precedes it, else -1. */
function isRetrievalBefore(text: string, nouns: RegExp): number {
  const verb = text.search(RETRIEVAL_VERB)
  if (verb === -1) return -1
  const noun = text.search(nouns)
  if (noun === -1 || noun < verb) return -1
  return noun
}

function documentMatch(lower: string): number {
  const afterVerb = isRetrievalBefore(lower, DOCUMENT_NOUNS)
  if (afterVerb !== -1) return afterVerb
  if (EXISTENCE_QUESTION.test(lower)) {
    const noun = lower.search(DOCUMENT_NOUNS)
    if (noun !== -1) return noun
  }
  const qualified = lower.search(DOCUMENT_QUALIFIED)
  if (qualified !== -1) return qualified
  const attributive = lower.search(DOCUMENT_ATTRITUTIVE)
  if (attributive !== -1) return attributive
  if (!METADEFINITION_QUESTION.test(lower) || DOCUMENT_COMPLEMENT.test(lower)) {
    const jargon = lower.search(DOCUMENT_JARGON)
    if (jargon !== -1) return jargon
  }
  return -1
}

/** Rule 6. Freshness needs a question or a retrieval verb, not just the word. */
function isFreshInformationRequest(lower: string): boolean {
  if (!FRESHNESS.test(lower)) return false
  return RETRIEVAL_VERB.test(lower) || QUESTION.test(lower)
}

/** A new lookup can override a stored-source follow-up, but merely showing a source cannot. */
export function requestsNewLookup(text: string): boolean {
  const lower = text.toLowerCase().replace(/\s+/g, ' ')
  return !retrievalRestrictions(text).webSearch && (/\b(?:search|google|browse|fetch|look\s+up)\b/.test(lower) || isFreshInformationRequest(lower))
}

/* ------------------------------------------------------------------ *
 * Composer compatibility
 * ------------------------------------------------------------------ */

export type PromptRoute =
  | { readonly kind: 'chat'; readonly reason: 'conversation' | 'ambiguous' }
  | { readonly kind: 'eye-new'; readonly reason: 'media-discovery' }
  | { readonly kind: 'eye-follow-up'; readonly reason: 'search-refinement' }
  | { readonly kind: 'deep-research'; readonly reason: 'explicit-deep-research' }

/**
 * Composer-facing adapter. Kept so `App.tsx` keeps compiling and keeps its
 * current behaviour: Deep Research is promoted explicitly, active-search
 * refinements stay on their session, and the eight-intent router decides
 * everything else.
 *
 * Note the missing leading-preposition branch. "In your opinion…", "With the
 * new layout…" and "About the roadmap…" are ordinary conversation, so there is
 * no longer any rule that can turn a preposition into a search.
 */
export function routePromptIntent(
  text: string,
  context: { readonly activeEyeSession: boolean },
): PromptRoute {
  const value = text.trim()
  const restrictions = retrievalRestrictions(value)
  if (restrictions.webSearch || (restrictions.browser && isNativeBrowserRequest(value.toLowerCase()))) {
    return { kind: 'chat', reason: 'conversation' }
  }

  if (isExplicitDeepResearchRequest(value)) {
    return { kind: 'deep-research', reason: 'explicit-deep-research' }
  }

  if (context.activeEyeSession && isSearchRefinement(value)) {
    return { kind: 'eye-follow-up', reason: 'search-refinement' }
  }

  const routed = routeChatIntent(value, context)
  if (value.length === 0) return { kind: 'chat', reason: 'ambiguous' }

  switch (routed.kind) {
    case 'direct_answer':
    case 'image_search':
    case 'video_search':
    case 'document_search':
    case 'audio_search':
    case 'page_search':
    case 'attachment_image':
    case 'attachment_document':
    case 'web_search':
    case 'native_browser_task':
      // Ordinary Chat is the default human interface. Explicit image, video and
      // document requests stay in the conversation so the Mind can use the typed
      // search vertical and attach real media cards to Freya's answer. Freya's Eye
      // remains available only when the owner explicitly selects that mode or is
      // refining an already-open Eye session.
      return { kind: 'chat', reason: 'conversation' }
  }
}

export function isExplicitDeepResearchRequest(text: string): boolean {
  const restrictions = retrievalRestrictions(text)
  if (restrictions.deepResearch || restrictions.webSearch) return false
  const lower = text.toLowerCase().replace(/\s+/g, ' ')
  return (
    /\bdeep\s+research\b/.test(lower) ||
    /\bresearch\s+(?:this\s+)?(?:deeply|thoroughly|in[- ]depth)\b/.test(lower) ||
    /\b(?:investigate|analyse|analyze)\s+(?:this\s+)?(?:thoroughly|in[- ]depth)\b/.test(lower) ||
    /\bcomprehensive\s+(?:research|report|analysis)\b/.test(lower) ||
    /\b(?:compare|verify|fact[- ]check)\b.{0,80}\b(?:multiple|several|independent)\s+sources\b/.test(lower)
  )
}

/**
 * Short corrections to a live search. Deliberately narrow: a bare preposition
 * is not a refinement, and neither is anything that would need a fresh search.
 */
function isSearchRefinement(value: string): boolean {
  return (
    /^(?:make\s+it|change(?:\s+it)?\s+to|only)\s+\d{1,3}(?:\s+results?)?$/i.test(value) ||
    /^only\s+(?:youtube|vimeo|tiktok|reddit)(?:\.com)?$/i.test(value) ||
    /^only\s+(?:videos?|images?|photos?|audio|podcasts?|pdfs?|documents?|files?|websites?|sites?)$/i.test(value) ||
    /^(?:not|without|exclude|no)\s+.+/i.test(value)
  )
}

/* ------------------------------------------------------------------ *
 * Site constraint extraction
 * ------------------------------------------------------------------ */

/**
 * The site (or domain) the owner asked us to look at, when they actually named one.
 *
 * Deliberately narrow: a stray noun like "the documentation" is not a site, and
 * an "on YouTube" inside a question about Chrome is the Chrome question rather
 * than a YouTube search. The rule is "an explicit preposition followed by what
 * looks like a host or a URL", and that is the only thing this returns.
 */
export function extractSiteConstraint(text: string): string | null {
  const lower = text.toLowerCase()
  // "on example.com", "from docs.example.com/foo", "at en.wikipedia.org"
  const prepMatch = lower.match(/(?:^|\s)(?:on|from|at|in|via|over|using)\s+([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:\/[a-z0-9/_.-]*)?)\b/)
  if (prepMatch) return normaliseSite(prepMatch[1]!)

  // "site:example.com foo" — explicit site operator
  const opMatch = lower.match(/\bsite\s*:\s*([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b/)
  if (opMatch) return normaliseSite(opMatch[1]!)

  // "https://example.com/foo" embedded in the prompt
  const urlMatch = text.match(/\bhttps?:\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s,]+)?/i)
  if (urlMatch) return normaliseSite(urlMatch[1]!)

  // Bare domain in a retrieval clause: "find articles example.com" (rare but real)
  const bareMatch = lower.match(/(?:^|\s)([a-z0-9][a-z0-9-]*\.(?:com|org|net|io|co|gov|edu|dev|app|me|ai|uk|de|fr|jp|cn|ru|us|info|biz|gg|app|ai))\b/)
  if (bareMatch && /\b(?:find|search|look|fetch|grab|show|list)\b/.test(lower)) {
    return normaliseSite(bareMatch[1]!)
  }
  return null
}

function normaliseSite(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/^www\./, '')
  const slash = trimmed.indexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(0, slash)
}

/**
 * Make the intent summary legible at a glance. Used by the composer rail so the
 * owner can see what Freya understood, without having to retype the question.
 */
export function describeIntentRoute(route: ChatIntentRoute): string {
  switch (route.kind) {
    case 'direct_answer':
      return 'Conversation'
    case 'web_search':
      return route.site ? `Web search · ${route.site}` : 'Web search'
    case 'image_search':
      return route.site ? `Images on ${route.site}` : 'Image search'
    case 'video_search':
      return route.site ? `Videos on ${route.site}` : 'Video search'
    case 'document_search':
      return route.site ? `Documents on ${route.site}` : 'Document search'
    case 'audio_search':
      return route.site ? `Audio on ${route.site}` : 'Audio search'
    case 'page_search':
      return route.site ? `Pages on ${route.site}` : 'Page search'
    case 'attachment_image':
      return 'Image attached'
    case 'attachment_document':
      return 'Document attached'
    case 'native_browser_task':
      return 'Drive the browser'
  }
}

export function intentHasSiteConstraint(route: ChatIntentRoute): boolean {
  return route.site !== null
}
