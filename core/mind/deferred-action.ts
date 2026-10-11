/**
 * Detecting a reply that *describes* an action instead of performing it.
 *
 * ## The failure this exists for
 *
 * A model asked to look something up sometimes answers in prose about looking
 * something up: "Let me check that for you", "I'll open that in my browser",
 * "Give me a moment". Nothing was looked up. The loop read it as an answer, the
 * turn completed, and the transcript recorded a reply that promised an action
 * which never happened — which is the exact thing the transcript is supposed to
 * make impossible.
 *
 * The tool instructions already forbid this, and forbidding it is not enough: a
 * smaller model reaches for the natural-language form more often than the
 * instructed one. So the loop does not trust the instruction alone. When a reply
 * is a promise to act, the loop hands the model back its own sentence as the next
 * observation and spends another call on making it act.
 *
 * ## What it deliberately does not do
 *
 * It never executes anything itself, and it never infers *which* tool the model
 * meant. The correction only tells the model that nothing happened and asks for
 * the envelope. Execution still happens through the registry and Guard, or not at
 * all.
 *
 * ## Why it is narrow
 *
 * A wrong positive costs a real provider call and can push a legitimate answer
 * into a second iteration, so the detector is deliberately reluctant:
 *
 *  - **Short replies only.** A promise is short. A long answer that happens to
 *    contain the phrase "I'll check" somewhere is an answer that checked
 *    something and then said so, and it is left alone.
 *  - **First-person promises only.** "The page will load in Chrome" is a
 *    statement about the world. "I'll open it in Chrome" is a promise by Freya.
 *  - **No citations.** A reply that carries `[1]` is quoting evidence it was
 *    given, which means it did the work.
 *  - **Bounded corrections.** {@link MAX_DEFERRED_CORRECTIONS} per turn, so a
 *    model that keeps promising cannot spend the whole turn being told off.
 */

/**
 * How many times one turn may spend a call telling the model it promised
 * instead of acting.
 *
 * One correction is enough for a model that made a slip. Two cover a model that
 * needed the format spelled out. A third means the model is not going to comply,
 * and continuing would burn the turn's allowance on a model that is answering in
 * prose no matter what it is told.
 */
export const MAX_DEFERRED_CORRECTIONS = 2

/** Longest reply still eligible to be read as a promise rather than an answer. */
const MAX_PROMISE_CHARS = 600

/**
 * A first-person statement of intent, immediately followed by the action.
 *
 * Each alternative names the actor first and the act second, so a sentence about
 * somebody else's intentions does not match.
 */
const PROMISE = [
  /\bi(?:'ll|’ll| will| am going to| can| could| would)\s+(?:now\s+|first\s+|go\s+and\s+)?(?:please\s+)?(?:open|launch|check|look|search|browse|browse\s+to|navigate|read|fetch|find|click|scroll|retrieve|verify|compare|research|pull\s+up|dig\s+up|look\s+into)\b/i,
  /\blet\s+me\s+(?:now\s+|first\s+)?(?:open|launch|check|look|search|browse|browse\s+to|navigate|read|fetch|find|click|scroll|retrieve|verify|compare|research|pull\s+up|dig\s+up|look\s+into)\b/i,
  /\bi(?:'m| am)\s+(?:going\s+to\s+|about\s+to\s+)?(?:open|launch|check|look|search|browse|navigate|read|fetch|retrieve|verify|compare|research)\b/i,
  /^(?:one\s+moment|give\s+me\s+a\s+(?:moment|second|sec)|bear\s+with\s+me|hold\s+on)\b/i,
  /\bi(?:'ll| will)\s+(?:take\s+a\s+look|see\s+if\s+i\s+can\s+find|do\s+a\s+quick\s+search)\b/i,
]

/** An evidence citation. A reply carrying one was given evidence and used it. */
const CITATION = /\[\d+\]/

/**
 * Whether a reply is a promise to act rather than an answer.
 *
 * `null` means "this is an answer", which is the common case and the safe
 * default. A string is the correction to hand back to the model, phrased so it
 * knows exactly what was wrong and what to do instead.
 */
export function deferredActionCorrection(text: string, correctionsSoFar: number): string | null {
  if (correctionsSoFar >= MAX_DEFERRED_CORRECTIONS) return null
  const value = text.trim()
  if (value.length === 0 || value.length > MAX_PROMISE_CHARS) return null
  if (CITATION.test(value)) return null
  if (!PROMISE.some(pattern => pattern.test(value))) return null

  return (
    'That reply described an action instead of taking it. Nothing was looked up, opened, ' +
    'read or clicked, and none of those is claimed. If the owner needs a lookup or a page ' +
    'read, reply now with exactly one tool call envelope and nothing else — no sentence ' +
    'before it, after it, or instead of it. If no tool is needed and the owner can be ' +
    'answered from what you already have, reply with the answer itself.'
  )
}