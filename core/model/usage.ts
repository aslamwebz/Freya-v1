import type { ModelUsage } from '../protocol/core-protocol'

/**
 * Accumulating reported provider usage.
 *
 * One implementation, used by the gateway's session counters, the durable
 * reducer and the grant's own record — because the bug this fixes was three
 * places each doing the arithmetic slightly differently, one of which replaced
 * a running total with a single call's figure.
 *
 * The rules:
 *
 *   - a reported figure is **added** to the total, never substituted for it;
 *   - a call that reported nothing contributes nothing and increments
 *     `unknownUsageCalls`, so the totals stay a declared lower bound rather than
 *     a quiet lie;
 *   - a partially reported call counts as unknown, because half a figure is not a
 *     total;
 *   - nothing is ever estimated.
 */

export function emptyUsage(): ModelUsage {
  return { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 }
}

/** True when this call did not report a complete pair of figures. */
export function isUsageIncomplete(usage: {
  inputTokens: number | null
  outputTokens: number | null
}): boolean {
  return usage.inputTokens === null || usage.outputTokens === null
}

/**
 * Add one call's reported usage to a running total.
 *
 * `countCall` is separate because the gateway counts an attempt when it happens
 * while the reducer counts a completion when the event arrives, and conflating
 * them would double-count or lose attempts.
 */
/**
 * Record that a call was attempted, and nothing else.
 *
 * Deliberately does not touch the unknown counter. An attempt is not an unknown
 * *usage* — the report has not arrived yet, and the completion event will supply
 * it. Counting the attempt as unknown would make every call look unaccounted
 * until the second one landed.
 */
export function accumulateAttempt(current: ModelUsage): ModelUsage {
  return { ...current, calls: current.calls + 1 }
}

export function accumulateUsage(
  current: ModelUsage,
  reported: { inputTokens: number | null; outputTokens: number | null },
  options: { countCall?: boolean } = {},
): ModelUsage {
  return {
    ...accumulateReported(current, reported),
    calls: current.calls + (options.countCall === true ? 1 : 0),
  }
}

/**
 * Add one call's reported usage to any record that carries the same three
 * fields, leaving everything else — a grant's authorisation budget, a call
 * count — exactly as it was.
 *
 * Generic rather than specific to `ModelUsage` because a grant's usage record has
 * the same three reported fields *plus* its budget, and a function that rebuilt
 * the object would have to know about the budget to avoid dropping it.
 */
export function accumulateReported<
  T extends { inputTokens: number | null; outputTokens: number | null; unknownUsageCalls: number },
>(current: T, reported: { inputTokens: number | null; outputTokens: number | null }): T {
  return {
    ...current,
    inputTokens: addKnown(current.inputTokens, reported.inputTokens),
    outputTokens: addKnown(current.outputTokens, reported.outputTokens),
    unknownUsageCalls: current.unknownUsageCalls + (isUsageIncomplete(reported) ? 1 : 0),
  }
}

/**
 * Add a known figure to a total that may not exist yet.
 *
 * `null + null` stays null because nothing is known. `null + 5` becomes 5: the
 * one call that did report is real, and `unknownUsageCalls` says the total is
 * not the whole story.
 */
function addKnown(current: number | null, reported: number | null): number | null {
  if (reported === null) return current
  return (current ?? 0) + reported
}
