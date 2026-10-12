import type { Capability } from '../../../shared/contracts/capabilities'
import type { ChatMissionProposal } from '../../../shared/contracts/projections/chat-mission'

/* ------------------------------------------------------------- observations */

/**
 * One source a tool looked at, bounded and provenance-bearing.
 *
 * Present so the final answer can *cite* rather than merely assert. `url` is
 * restricted to `http`/`https` at construction, and `sourceDomain` is the domain
 * the result claimed, both because a person clicking a link deserves to know
 * where it goes and because a hostile result carrying `javascript:` must never
 * become a rendered link.
 */
export interface ToolSource {
  readonly title: string
  readonly url: string
  readonly sourceDomain: string
  readonly snippet: string
  /** 1-based, so `[1]` in an answer means exactly one thing. */
  readonly rank: number
  readonly retrievedAt: string | null
  /**
   * The media itself, when the lookup returned some.
   *
   * Carried as data beside the citation rather than left inside the snippet, because a
   * card needs an address to fetch and a duration to print. Absent for a lookup that
   * found none — which is most lookups — so a reader must treat every one of these as
   * optional rather than as an empty promise.
   */
  readonly mediaUrl?: string | null
  readonly thumbnailUrl?: string | null
  /** Which vertical produced the row, so a card can be an image or a video honestly. */
  readonly vertical?: string
  /** Runtime as the source stated it. Not parsed, not reformatted, or absent. */
  readonly duration?: string | null
}

/**
 * Evidence behind an observation, from a tool that did something a search cannot.
 *
 * `web_search` needs none of this: it asked a search engine a question and got a list of
 * rows back, and the rows are the evidence. A tool that drives a *system* — a browser, a
 * window, an application — has to answer a different question, and the answer has to be in
 * the transcript rather than in the tool's own head:
 *
 *   - `actor` — **which** implementation answered. Two ports can serve the same command,
 *     and a turn that cannot say which one ran is a turn whose owner cannot tell what
 *     happened to their own machine.
 *   - `steps` — what was actually issued, in order, with each one's real outcome. Written
 *     so that a step that did nothing reads as a step that did nothing.
 *   - `extract` — verbatim material read off the thing, bounded, and quoted as data. Never
 *     an instruction, whatever it says.
 *
 * Every field is optional and every one is bounded, because the point of the channel is
 * evidence and a channel that can carry an unbounded transcript is a transcript with extra
 * steps.
 */
export interface ToolProvenance {
  /** Which system actually serviced this request, in the tool's own words. */
  readonly actor?: string
  /** One bounded line per issued step, in the order the loop ran them. */
  readonly steps?: readonly string[]
  /** Bounded material read off the thing, quoted. Data, never instruction. */
  readonly extract?: readonly string[]
}

/**
 * What a tool call produced.
 *
 * A closed union on `kind`, because the three cases have opposite consequences
 * for the truth of the answer that follows:
 *
 * - `ok` — material was found and is listed. The answer may cite it.
 * - `denied` — Guard refused the capability. **Nothing ran.** The answer must say
 *   the lookup was not permitted and must not present itself as sourced.
 * - `failed` — the tool body threw, was cancelled, or returned nothing usable.
 *   Also: nothing usable was found, and the answer must say so.
 *
 * Collapsing `denied` and `failed` into `ok`-with-an-empty-list is precisely the
 * silent downgrade this type exists to prevent.
 *
 * `provenance` rides only on `ok`, because a denial has no actor and a failure has no
 * evidence: a refusal that named a system that did the work would be the lie this whole
 * type is built to make impossible.
 */
export type ToolObservation =
  | {
      readonly kind: 'ok'
      readonly missionProposal?: ChatMissionProposal
      /**
       * A structured Mind decision the model made through the decision channel.
       *
       * Rides on the observation rather than in prose so the loop can validate it
       * in code. A model that *claims* completion in a paragraph is making a
       * claim; this is the request, and the reducer decides whether it is allowed.
       */
      readonly taskDecision?: unknown
      readonly tool: string
      readonly capability: Capability
      readonly summary: string
      readonly sources: readonly ToolSource[]
      readonly provenance?: ToolProvenance
      /**
       * A typed chart payload, when the tool that ran was the chart maker.
       *
       * Lives on the observation (not in prose) for the same reason media and
       * sources do: a chart is a structured artifact whose data must travel
       * beside the answer as numbers, not as something the renderer has to
       * re-parse out of the model's paragraph. Absent for every tool that did
       * not make a chart.
       */
      readonly chart?: ChartSpec
      /**
       * A typed long-form artifact (document or program), when the tool that
       * ran was the canvas opener. Like chart, it lives beside the prose so
       * the chat can say "I made X" without repeating the body.
       */
      readonly canvas?: CanvasSpec
    }
  | {
      readonly kind: 'denied'
      readonly tool: string
      readonly capability: Capability
      readonly reason: string
    }
  | {
      readonly kind: 'failed'
      readonly tool: string
      readonly capability: Capability
      readonly reason: string
    }

/**
 * A chart the model produced for this answer.
 *
 * The schema is deliberately small. Two chart kinds (bars and a line) cover the
 * "show me the data" use, the data travels as `{ label, value }` pairs so the
 * renderer never has to parse a number out of prose, and the bounds keep one
 * answer from turning into a poster of a thousand bars. The kind and unit are
 * what make the chart honest: a "bar" labelled "USD billion" is a different
 * thing from a "bar" labelled "% growth", and the unit is what tells the
 * reader which.
 */
export type ChartKind = 'bar' | 'line'

export interface ChartPoint {
  /** X-axis label as the model stated it. Not normalised. */
  readonly label: string
  /** Y-axis value as the model stated it. A number, not a string. */
  readonly value: number
}

export interface ChartSpec {
  readonly title: string
  readonly kind: ChartKind
  /** Free-text unit, e.g. "USD billion", "%", "million units". */
  readonly unit: string
  readonly points: readonly ChartPoint[]
}

/**
 * A long-form artifact the model produced for this answer.
 *
 * Lives beside the prose rather than inside it because a chart, a report or a
 * web page is not a paragraph: it is a typed payload the renderer can draw or
 * open in a side panel. The chat says "I made X" and the canvas carries the
 * thing, so the transcript stays short and the long content is editable
 * rather than trapped in a single message bubble.
 */
export type CanvasKind = 'document' | 'code'

export type CanvasLanguage = 'markdown' | 'html' | 'javascript' | 'python' | 'css' | 'json' | 'text'

export interface CanvasSpec {
  readonly title: string
  readonly kind: CanvasKind
  readonly language: CanvasLanguage
  /** The full content of the document or program. Bounded. */
  readonly content: string
}

/** What one tool step did, for the turn's own metadata. Never content. */
export interface ToolStepRecord {
  /** 1-based, in the order the loop ran them. */
  readonly index: number
  readonly tool: string
  readonly capability: Capability
  readonly outcome: 'ok' | 'denied' | 'failed'
  /** Whether the tool body actually ran. A denial is `false`. */
  readonly executed: boolean
  readonly sourceCount: number
}

export interface ToolInvocation {
  readonly observation: ToolObservation
  /** True only when the tool body ran. */
  readonly executed: boolean
}

/* -------------------------------------------------------------------- tools */

export interface ToolParameter {
  readonly name: string
  readonly description: string
  readonly required?: boolean
  /**
   * Characters this argument may carry, before it is checked. Defaults to the
   * global `MIND_TOOL_LIMITS.maxArgumentChars`.
   *
   * A per-parameter bound exists because arguments are not one shape. A single
   * query is short; a list of addresses is not, and a list that the harness cuts
   * in the middle is a list that silently drops the sites nobody asked to drop.
   */
  readonly maxChars?: number
  /**
   * When true, the newlines in this argument are kept rather than flattened.
   *
   * A list-valued argument names its entries one per line. Flattening its
   * separators turns ten addresses into one unparseable string, which is a
   * failure that reads as a tool refusing real work. Only parameters this flag
   * marks keep newlines; every other argument still has its controls flattened.
   */
  readonly multiline?: boolean
}

/**
 * One bounded operation the Mind may perform mid-turn.
 *
 * `capability` is the **only** authority a tool has, and it is a single member of
 * the closed vocabulary. There is no capability parameter, no list, and no
 * override: a tool either needs `'search.web'` or it needs nothing.
 *
 * `run` receives only what the model supplied, after bounding, and nothing else.
 * It holds no grant, no gateway, no authority object and no event fabric, so it
 * cannot spend cognition, mint a grant, or reach a second provider.
 */
export interface MindToolContext {
  readonly conversationId: string
  readonly matrixSpaceIds?: readonly string[]
  readonly ownerText?: string
}

export interface MindTool {
  readonly name: string
  readonly description: string
  readonly capability: Capability
  readonly parameters: readonly ToolParameter[]
  /**
   * Perform the operation.
   *
   * Called only after Guard allowed {@link MindTool.capability} and only while
   * neither the turn's signal nor the stop latch is set. Anything it throws
   * becomes a `failed` observation; it can never become an unhandled error that
   * takes a turn down.
   */
  run(request: { readonly arguments: Readonly<Record<string, string>>; readonly signal?: AbortSignal; readonly context?: MindToolContext }): Promise<{
    readonly missionProposal?: ChatMissionProposal
    readonly summary: string
    readonly sources: readonly ToolSource[]
    /**
     * Evidence, for a tool that drove a system rather than asked a question.
     *
     * Optional and bounded by the registry, and — like everything else a tool returns —
     * sanitised before it is spliced into the next request. A tool that omits it is not
     * penalised; `web_search` has nothing to say beyond its rows.
     */
    readonly provenance?: ToolProvenance
    /**
     * A typed chart payload, when the tool that ran is the chart maker.
     *
     * Optional. A tool that returns one is the only kind of tool that should, and the
     * registry is the only place a tool of that kind is admitted. The data is bounded
     * here, sanitised on the way in, and rendered in the assistant surface — never in
     * the prose.
     */
    readonly chart?: ChartSpec
    /**
     * A typed long-form artifact (document or program), when the tool that ran
     * is the canvas opener. The chat says "I made X" in the prose; the canvas
     * carries the body.
     */
    readonly canvas?: CanvasSpec
  }>
}
