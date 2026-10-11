export const RESEARCH_EVENT_TYPES = [
// Research (Phase 5) — metadata only.
  //
  // The research stack sees the query, the URLs, the page text and the answer.
  // None of that may travel: this journal is read, copied, exported into backups
  // and forwarded to whoever is debugging, and a search history is a record of what
  // a person has been curious about.
  //
  // So these carry operation and session ids, a closed stage, integer counters and
  // fixed failure codes, and nothing else. There is deliberately no event type that
  // could hold a query, a URL, a domain, a snippet, a page, an answer or a
  // provider diagnostic.
  'research.search_started',
'research.search_completed',
'research.search_failed',
'research.read_started',
'research.read_completed',
'research.read_failed',
'research.started',
'research.progress',
'research.completed',
'research.failed',
'research.cancelled',
] as const
