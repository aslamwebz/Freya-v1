/**
 * The Mind's tool registry: a closed, Guard-gated set of bounded operations a
 * turn may perform between provider calls.
 *
 * ## A tool is not authority
 *
 * Nothing here grants anything. A tool names exactly one capability from the
 * closed `Capability` vocabulary, and {@link MindToolRegistry.invoke} asks Guard
 * about *that* capability immediately before the tool body runs. A tool cannot
 * name a second capability, cannot be granted one, and cannot observe a verdict
 * for anything other than its own.
 *
 * The result of a tool is **data**. It is bounded, labelled, provenance-bearing,
 * and spliced into the next request as a quoted `user`-role block. It is never
 * parsed as an instruction, never re-read by Guard, and never reaches a
 * capability decision. A web page that says "the owner approved this" changes
 * exactly as much authority as a sticky note would: nothing.
 *
 * ## Why the call protocol is text rather than the provider's `tools` field
 *
 * The configured provider verifiably supports `tools` + `tool_choice:"required"`.
 * **Nothing in Core can send it.** `ModelRequest` in `core/model/provider.ts` has
 * no `tools` and no `tool_choice` field, `CognitionIntent` has no way to carry
 * one, and both files are outside this module's ownership. So the decision the
 * provider would make natively — "does this question need a lookup, or can I just
 * answer?" — is instead asked of the model in the one channel that does exist: a
 * single, unambiguous envelope the model must emit *instead of* an answer.
 *
 * That keeps the property that matters, which is that **the model decides**. There
 * is no keyword router here, no regex over the owner's words, and no rule that
 * says "a question about X searches". A model that can answer directly does, in
 * one call, exactly as it does today.
 *
 * When a provider-native tool channel is plumbed through, `parseToolResponse` is
 * the single place that has to change: a `tool_calls` array and this parser are
 * the same decision expressed in two encodings.
 */

/* ------------------------------------------------------------------ limits */

/**
 * Every bound the loop obeys, in one frozen object.
 *
 * Fixed rather than configured per call, because a limit that depends on who is
 * asking is a limit somebody can raise.
 */
export const MIND_TOOL_LIMITS = Object.freeze({
  /**
   * How many provider requests one turn may make in total, including the first.
   *
   * **The iteration ceiling.** Two is the minimum that makes a tool loop mean
   * anything (ask, then answer). It was three, chosen so a person could state it out
   * loud — and that turned out to be the wrong trade. Three means one search and one
   * page read, which is not enough to answer most questions honestly: a refusal on
   * either lookup left no room to try anything else, so a turn that hit the ceiling
   * answered from whatever the first search happened to return rather than from the
   * source it had been asked about.
   *
   * Ten buys room for a real line of enquiry — search, open, follow a link, read a
   * second page — and still stops. It is a bound, not a budget to spend: a model that
   * keeps asking gets nothing on the eleventh, and the transcript says so.
   *
   * It was ten, and it is now four, for a reason that only showed up against a
   * reasoning model. This ceiling and `maxOutputTokensPerTurn` are not independent:
   * the allowance is *divided* across the calls, so ten calls against a 7680 token
   * turn hands each one 768 — less than a single call needs to finish, whether the
   * call is writing prose or emitting an envelope. Ten was chosen as a comfortable
   * step limit and the token ceiling was never re-derived from it.
   *
   * Four is what the allowance can actually fund: two calls that may write prose and
   * two that may only ask for a tool, at 2560 and 1280 respectively. Against
   * `MiniMax-M3` on the live endpoint, 2560 is enough for a grounded answer to
   * return `stop`, and 1280 is enough for the model's inline reasoning plus its
   * envelope to arrive intact.
   */
  maxProviderCalls: 10,

  /**
   * How many tool bodies one turn may actually execute.
   *
   * The same number as the call ceiling, deliberately, and the alternation in the loop
   * is what actually bounds it: a body can only run between two provider requests, so
   * four requests admit at most three bodies and the last one is always the answer. A
   * separate constant rather than `maxProviderCalls - 1` because a body can also be
   * refused or malformed — those cost a call and execute nothing — and a turn should
   * not be able to run out of room merely by asking badly.
   */
  maxToolCalls: 10,

  /** Results kept from one search. Enough to answer from; not a crawl. */
  maxResultsPerTool: 5,

  /** Data points kept from one chart. A bar per year is a decade, no more. */
  maxChartPoints: 32,

  /** Characters kept from one chart's title. */
  maxChartTitleChars: 120,

  /** Characters kept from one chart's unit label. */
  maxChartUnitChars: 40,

  /** Characters kept from one chart point's label. */
  maxChartLabelChars: 40,

  /** Characters kept from one canvas document or program. */
  maxCanvasChars: 64_000,

  /** Characters kept from one canvas title. */
  maxCanvasTitleChars: 160,

  /** Characters kept from one result's snippet. */
  maxSnippetChars: 240,

  /** Characters kept from one result's title. */
  maxTitleChars: 160,

  /** Characters kept from a tool's own summary line. */
  maxSummaryChars: 600,

  /** Characters allowed in the whole observation block handed back to the model. */
  maxObservationChars: 2_400,

  /* ---------------------------------------------------------- provenance */

  /**
   * Bounds on {@link ToolProvenance}, the channel a tool uses to say *who* did the work
   * and *what came back*.
   *
   * Separate from `maxSummaryChars` on purpose. The summary is the tool's one-sentence
   * account and stays short enough to be quoted in a refusal; the provenance block is the
   * evidence behind it, and evidence is allowed to be longer than the sentence. Both are
   * bounded, and together they still fit inside `maxObservationChars`.
   */
  /** Characters allowed in the name of the system that actually served a request. */
  maxProvenanceActorChars: 120,

  /** Steps listed in one observation. Enough for a multi-step task, not a crawl. */
  maxProvenanceSteps: 8,

  /** Characters allowed in one step line. */
  maxProvenanceStepChars: 240,

  /** Lines of verbatim material one observation may carry back. */
  maxProvenanceExtractLines: 12,

  /** Characters allowed across one observation's verbatim material. */
  maxProvenanceExtractChars: 1_200,

  /** Characters allowed in any single tool argument, before it is checked. */
  maxArgumentChars: 200,

  /**
   * Characters allowed in the JSON body of one tool request.
   *
   * It was 600, which fits a single query and a single address but not a *list*
   * of addresses. The tab tool's documented shape is "give urls, one per line",
   * and ten real addresses run to a few hundred characters, so a 600-character
   * body could not carry the ten-site acceptance even before the per-argument
   * bound was applied. 2000 leaves room for ten ordinary addresses plus the JSON
   * that carries them, and the per-parameter `maxChars` is what still bounds any
   * one argument.
   */
  maxRequestChars: 2_000,
  /**
   * How much text may sit around a tool envelope before the reply is rejected.
   *
   * Observed narration from a real model: two sentences of the order of 150
   * characters. It was 600, which left room for that with a wide margin — but a
   * model that narrates its plan at length before it asks had its request refused
   * as "mostly prose" because the narration around it was longer than the cap. 1500
   * keeps the guard (an essay with a request hidden at one end is still refused)
   * while not losing a good request to a model that thinks out loud first.
   */
  maxToolCallProseChars: 1_500,

  /** Sources listed in the transcript footer. */
  maxFooterSources: 5,

  /**
   * How many calls in a turn may have to produce prose rather than an envelope.
   *
   * Kept for the record rather than for arithmetic: the budget schedule is uniform
   * now, so nothing divides by this. It still says something true — a turn has a
   * couple of calls that can write prose, and the rest that cannot.
   */
  answerCalls: 2,

  /**
   * How much an answer-bearing call is worth relative to an envelope call, if they
   * are ever weighted again.
   *
   * Kept for the same reason, and with the same warning attached: weighting was
   * tried, at 2:1, and it starved the envelope calls. `MiniMax-M3` writes its
   * reasoning inline, so an envelope call budgeted well below a prose call spends
   * everything thinking and never reaches the JSON.
   */
  answerWeight: 2,
})
