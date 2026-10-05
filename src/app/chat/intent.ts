export type PromptRoute =
  | { readonly kind: 'chat'; readonly reason: 'conversation' | 'ambiguous' }
  | { readonly kind: 'eye-new'; readonly reason: 'explicit-search' | 'media-discovery' | 'fresh-information' }
  | { readonly kind: 'eye-follow-up'; readonly reason: 'search-refinement' }
  | { readonly kind: 'deep-research'; readonly reason: 'explicit-deep-research' }

/**
 * Product-level intent routing for the global composer.
 *
 * This is deliberately conservative in only one direction: Freya may promote a
 * clearly search-shaped request into Eye without asking the owner to choose a tool.
 * Anything that is not high-confidence remains ordinary Chat, where conversation
 * context can resolve pronouns and nuance better than a regex ever could.
 *
 * Importantly, "uncertain" does NOT mean "ask a question". It means "let Freya answer
 * normally". Clarification is a conversational decision only when the missing fact
 * materially changes the answer/action.
 */
export function routePromptIntent(
  text: string,
  context: { readonly activeEyeSession: boolean },
): PromptRoute {
  const value = text.trim()
  const lower = value.toLowerCase()
  if (!value) return { kind: 'chat', reason: 'ambiguous' }

  if (isExplicitDeepResearch(lower)) {
    return { kind: 'deep-research', reason: 'explicit-deep-research' }
  }

  if (context.activeEyeSession && isEyeRefinement(value)) {
    return { kind: 'eye-follow-up', reason: 'search-refinement' }
  }

  if (isMediaDiscovery(lower)) {
    return { kind: 'eye-new', reason: 'media-discovery' }
  }

  if (isExplicitSearch(lower)) {
    return { kind: 'eye-new', reason: 'explicit-search' }
  }

  if (isFreshInformationRequest(lower)) {
    return { kind: 'eye-new', reason: 'fresh-information' }
  }

  return { kind: 'chat', reason: 'conversation' }
}

function isExplicitDeepResearch(lower: string): boolean {
  return (
    /\bdeep\s+research\b/.test(lower) ||
    /\bresearch\s+(?:this\s+)?(?:deeply|thoroughly|in[- ]depth)\b/.test(lower) ||
    /\b(?:investigate|analyse|analyze)\s+(?:this\s+)?(?:thoroughly|in[- ]depth)\b/.test(lower) ||
    /\bcomprehensive\s+(?:research|report|analysis)\b/.test(lower) ||
    /\b(?:compare|verify|fact[- ]check)\b.{0,80}\b(?:multiple|several|independent)\s+sources\b/.test(lower)
  )
}

function isEyeRefinement(value: string): boolean {
  return (
    /^(?:make\s+it|change(?:\s+it)?\s+to|only)\s+\d{1,3}(?:\s+results?)?$/i.test(value) ||
    /^only\s+(?:youtube|vimeo|tiktok|reddit)(?:\.com)?$/i.test(value) ||
    /^only\s+(?:videos?|images?|photos?|audio|podcasts?|pdfs?|documents?|files?|websites?|sites?)$/i.test(value) ||
    /^(?:not|without|exclude|no)\s+.+/i.test(value) ||
    /^(?:in|at|from|with|about|during|near)\s+.+/i.test(value)
  )
}

function isExplicitSearch(lower: string): boolean {
  return (
    /^\s*(?:please\s+)?(?:find|search(?:\s+for)?|look\s+up|locate|browse\s+for|get\s+me|show\s+me)\b/.test(lower) &&
    (
      /\b(?:online|web|internet|source|sources|result|results|link|links|website|websites|site|sites|article|articles|paper|papers|news)\b/.test(lower) ||
      MEDIA_NOUN.test(lower)
    )
  ) || /\b(?:search|browse)\s+(?:the\s+)?(?:web|internet)\b/.test(lower)
}

const MEDIA_NOUN = /\b(?:videos?|clips?|images?|photos?|pictures?|audio|podcasts?|pdfs?|documents?|files?)\b/

function isMediaDiscovery(lower: string): boolean {
  if (!MEDIA_NOUN.test(lower)) return false

  // "Explain video compression" is a normal question. A discovery request carries
  // either a retrieval verb, a requested count, or a result-oriented determiner.
  const retrieval =
    /\b(?:find|search|show|get|give|list|locate|watch|look\s+for)\b/.test(lower) ||
    /\b\d{1,3}\s+[^.!?]{0,80}\b(?:videos?|clips?|images?|photos?|pictures?|podcasts?|pdfs?|documents?|files?)\b/.test(lower)

  return retrieval
}

function isFreshInformationRequest(lower: string): boolean {
  const freshness = /\b(?:latest|today(?:'s)?|currently|current|right\s+now|this\s+week|recent|newest)\b/.test(lower)
  const discovery = /\b(?:find|show|get|search|news|updates?|prices?|results?|availability|openings?)\b/.test(lower)
  return freshness && discovery
}
