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
  | 'attachment_image'
  | 'attachment_document'
  | 'native_browser_task'

export const CHAT_INTENTS: readonly ChatIntent[] = [
  'direct_answer',
  'web_search',
  'image_search',
  'document_search',
  'video_search',
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
  /\b(?:video|videos|clip|clips|youtube|vimeo|tiktok|screencasts?|walkthroughs?|webinars?|documentar(?:y|ies)|talks?|keynotes?|lectures?|tutorials?)\b/

/** "a video explaining X", "a talk on X", "tutorials for beginners". */
const VIDEO_ATTRITUTIVE =
  /\b(?:video|videos|clip|clips|screencasts?|walkthroughs?|webinars?|documentar(?:y|ies)|talks?|keynotes?|lectures?|tutorials?)\s+(?:explaining|about|on|showing|covering|teaching|that|which|for)\b/

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

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export function routeChatIntent(text: string, context: ChatIntentContext): ChatIntentRoute {
  const value = text.trim()
  const lower = value.toLowerCase().replace(/\s+/g, ' ')

  // Rule 1 — explicit "drive my own browser". Outranks every search intent: if
  // the owner named the browser, the browser is the answer.
  if (isNativeBrowserRequest(lower)) {
    return { kind: 'native_browser_task', reason: 'owner asked Freya to drive its own browser' }
  }

  // Rule 2 — a real attachment outranks wording. Never derived from a filename.
  const attached = attachmentRoute(context, value)
  if (attached !== null) return attached

  // Rule 3 — nothing typed. Not a search request.
  if (value.length === 0) return { kind: 'direct_answer', reason: 'empty prompt' }

  // Rule 4 — the owner named the channel ("search the web", "find sources").
  if (isWebChannelRequest(lower)) {
    return { kind: 'web_search', reason: 'online lookup requested' }
  }

  // Rule 5 — a retrieval verb plus a media noun is more specific than "find".
  const media = mediaRequest(lower)
  if (media !== null) return media

  // Rule 6 — "what's the latest…" needs facts Freya does not already hold.
  if (isFreshInformationRequest(lower)) {
    return { kind: 'web_search', reason: 'asks for information that changes over time' }
  }

  // Rule 7 — default. Genuinely uncertain stays a conversation.
  return { kind: 'direct_answer', reason: 'no search intent stated' }
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
function attachmentRoute(context: ChatIntentContext, value: string): ChatIntentRoute | null {
  const hasImage = context.hasImage === true
  const hasDocument = context.hasDocument === true
  if (!hasImage && !hasDocument) return null

  const note = value.length === 0 ? ', no text' : ''
  if (hasImage) return { kind: 'attachment_image', reason: `image attached${note}` }
  return { kind: 'attachment_document', reason: `document attached${note}` }
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
function mediaRequest(lower: string): ChatIntentRoute | null {
  const image = firstMediaMatch(lower, IMAGE_NOUNS, IMAGE_ATTRITUTIVE)
  const video = firstMediaMatch(lower, VIDEO_NOUNS, VIDEO_ATTRITUTIVE)
  const document = documentMatch(lower)

  const candidates: readonly { kind: ChatIntent; index: number; reason: string }[] = [
    ...(image === -1 ? [] : [{ kind: 'image_search' as const, index: image, reason: 'image retrieval requested' }]),
    ...(video === -1 ? [] : [{ kind: 'video_search' as const, index: video, reason: 'video retrieval requested' }]),
    ...(document === -1 ? [] : [{ kind: 'document_search' as const, index: document, reason: 'document retrieval requested' }]),
  ]
  if (candidates.length === 0) return null

  const earliest = candidates.reduce((best, candidate) => (candidate.index < best.index ? candidate : best))
  return { kind: earliest.kind, reason: earliest.reason }
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

/* ------------------------------------------------------------------ *
 * Composer compatibility
 * ------------------------------------------------------------------ */

export type PromptRoute =
  | { readonly kind: 'chat'; readonly reason: 'conversation' | 'ambiguous' }
  | { readonly kind: 'eye-new'; readonly reason: 'explicit-search' | 'media-discovery' | 'fresh-information' }
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
      return { kind: 'chat', reason: 'conversation' }
    case 'image_search':
    case 'video_search':
    case 'attachment_image':
    case 'attachment_document':
      return { kind: 'eye-new', reason: 'media-discovery' }
    case 'web_search':
    case 'document_search':
    case 'native_browser_task':
      return { kind: 'eye-new', reason: 'explicit-search' }
  }
}

export function isExplicitDeepResearchRequest(text: string): boolean {
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
