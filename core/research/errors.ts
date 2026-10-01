const messages = {
  invalid_query: 'Enter a search query of at most 512 characters.',
  invalid_url: 'The source URL is invalid.',
  unsafe_url: 'The source URL is not a public HTTP or HTTPS destination.',
  unconfigured: 'Web search is not configured.',
  disabled: 'Web search is disabled.',
  cancelled: 'Research was cancelled.',
  timeout: 'The research request timed out.',
  response_too_large: 'The source response exceeded its size limit.',
  too_many_redirects: 'The source exceeded its redirect limit.',
  network_error: 'The network request failed.',
  dns_failed: 'The source address could not be resolved.',
  tls_failed: 'The secure connection could not be verified.',
  provider_error: 'The search provider failed.',
  invalid_credentials: 'The search provider rejected its credentials.',
  rate_limited: 'The search provider rate limit was reached.',
  invalid_response: 'The search provider returned an invalid response.',
  unsupported_document: 'The source document format is not supported.',
} as const

export type ResearchErrorCode = keyof typeof messages

/** Closed public failures: no vendor text, URL, query, cause or abort reason. */
export class ResearchError extends Error {
  readonly code: ResearchErrorCode

  constructor(code: ResearchErrorCode) {
    super(messages[code])
    this.name = 'ResearchError'
    this.code = code
  }
}

export function safeResearchError(error: unknown, fallback: ResearchErrorCode): ResearchError {
  const code = error instanceof ResearchError && typeof error.code === 'string' && Object.hasOwn(messages, error.code) ? error.code : fallback
  return new ResearchError(code)
}
