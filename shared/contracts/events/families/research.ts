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
export interface ResearchStageEvent {
  /** The operation id Core issued. An id, never content. */
  operationId: string
  /** The managed browser session, when the stage had one. */
  sessionId: string | null
  /** A closed enum. A renderer or provider cannot invent a stage name. */
  stage: string
  counters: ResearchStageCounters
  /** Null unless the stage failed. Always a code, never a message. */
  failureCode: string | null
}

/**
 * Counters reported on a research event.
 *
 * Every field is an integer this subsystem counted itself. They are named rather
 * than bundled so a reader can see which budget moved, and they are integers rather
 * than a duration string so a validator can reject a substituted sentence.
 */
export interface ResearchStageCounters {
  iterations: number
  queries: number
  results: number
  pages: number
  evidenceChars: number
  modelTurns: number
  failures: number
  durationMs: number
}

export interface ResearchEventPayloads {
/* ------------------------------------------------------------- research */

  /**
   * The one shape every research stage event uses.
   *
   * A single shape rather than several, because the fields that must never appear
   * are easier to guarantee for one type than for eight. Note what is absent: no
   * query, no URL, no domain, no snippet, no page text, no answer, no provider
   * diagnostic and no filesystem path. `failureCode` is a closed enum from
   * `ResearchErrorCode`, so a failure is reported as a code rather than as whatever
   * a provider chose to throw.
   */
  'research.search_started': ResearchStageEvent

'research.search_completed': ResearchStageEvent

'research.search_failed': ResearchStageEvent

'research.read_started': ResearchStageEvent

'research.read_completed': ResearchStageEvent

'research.read_failed': ResearchStageEvent

'research.started': ResearchStageEvent

'research.progress': ResearchStageEvent

'research.completed': ResearchStageEvent

'research.failed': ResearchStageEvent

'research.cancelled': ResearchStageEvent
}