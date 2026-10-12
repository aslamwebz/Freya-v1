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

/** Compatibility exports; implementations live in the modules below. */
export { MIND_TOOL_LIMITS } from './tools/limits'
export type { ToolSource, ToolProvenance, ToolObservation, ChartKind, ChartPoint, ChartSpec, CanvasKind, CanvasLanguage, CanvasSpec, ToolStepRecord, ToolInvocation, ToolParameter, MindToolContext, MindTool } from './tools/types'
export type { MindToolRegistryOptions } from './tools/registry'
export { MindToolRegistry } from './tools/registry'
export { TOOL_CALL_OPEN, TOOL_CALL_CLOSE, EXTRACT_CUT_MARKER } from './tools/markers'
export type { ParsedToolResponse } from './tools/response-parser'
export { parseToolResponse } from './tools/response-parser'
export { renderObservation, renderToolFooter } from './tools/observation-format'
export { createWebSearchTool } from './tools/web-search'
export { createChartTool } from './tools/chart'
export { createCanvasTool } from './tools/canvas'
export { createMindTaskTool } from './tools/task-state'
export { sanitiseUntrustedText, sanitiseArgumentText, boundText } from './tools/text'
