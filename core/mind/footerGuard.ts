import type { ToolStepRecord } from './tools'

/**
 * The structural shape Freya's code uses for the "What Freya did for this answer"
 * footer, expressed as a regex. A trailing em-dash followed (on the next line or
 * on the same line) by the literal header line, then the body of the footer.
 *
 * Two surfaces emit strings that match this regex, and one of them must not:
 *
 *  - `core/mind/tools.ts` `renderToolFooter` appends a code-written block whose
 *    first line is `What Freya did for this answer:`. That emission is the only
 *    legitimate source — the code is the witness for what the loop actually did.
 *  - `src/app/chat/assistantParts.ts` parses the stored content and uses the
 *    same regex to lift the block out of the prose for the renderer's collapsible
 *    "What Freya did" panel.
 *  - A model that has seen a previous turn's footer may copy the format into its
 *    own reply, producing a string that also matches this regex. That string is
 *    *not* a witness — there is no tool iteration behind it — and the Mind must
 *    not let it be presented to a reader as the transcript's account of its own
 *    actions.
 *
 * The regex lives in one place so the two code surfaces agree on the shape and
 * the model cannot exploit a divergence. Do not duplicate it.
 */
export const FOOTER_HEAD = /[ \t]*—[ \t]*(?:\n|\s)+What Freya did for this answer:[ \t]*(?:\n|$)([\s\S]*)$/

/**
 * The result of removing a model-written footer block from the model's reply.
 *
 * `text` is the prose Freya will keep, with any model-written footer removed.
 * `forgery` is true when the model wrote a footer block that matched the code's
 * shape; it is the only signal the rest of the Mind has that the model *intended*
 * to claim an act the loop did not perform. The stored transcript contains
 * `text` and never the original model-written block.
 */
export interface StrippedModelText {
  readonly text: string
  readonly forgery: boolean
}

/**
 * Remove a model-written footer block from a provider reply.
 *
 * The model sees prior turns' code-written footers in its context and occasionally
 * reproduces the format in its own output. When the loop produced no iterations
 * the code footer is empty, so the transcript would otherwise store the model's
 * own fabrication as if it were the Mind's own record of what happened. A
 * fabrication stripped here is the difference between a transcript that names the
 * act and a transcript that does not, and the absence of the footer is the
 * honest signal: a turn that did no lookups has no "What Freya did" section.
 *
 * The function does not touch the body of the reply. A model that wrote "I
 * closed the tab." in prose before the forged footer is left with that sentence
 * intact, because the sentence is its own claim and a future reader deserves to
 * see it side by side with the missing footer.
 */
export function stripModelWrittenFooter(modelText: string): StrippedModelText {
  if (typeof modelText !== 'string' || modelText.length === 0) {
    return { text: modelText, forgery: false }
  }
  const match = modelText.match(FOOTER_HEAD)
  if (match === null) return { text: modelText, forgery: false }
  const cutAt = match.index ?? -1
  if (cutAt < 0) return { text: modelText, forgery: false }
  // The match is anchored to the end of the string (greedy `[\s\S]*$`), so the
  // header and its body are dropped and the prose before the `—` is kept.
  return { text: modelText.slice(0, cutAt).replace(/\s+$/u, ''), forgery: true }
}

/**
 * The step records the loop produced for one turn, as a value the conversation
 * message is allowed to carry beside the prose.
 *
 * Empty on a turn that looked nothing up, which is most turns — so a reader
 * that finds this field absent on an assistant message must not treat that as
 * "the data is empty", only "the data is not on this message". The renderer
 * prefers this list over the content-parsed footer for the "What Freya did"
 * section, so the loop's record of what it actually did is the transcript's
 * record, not whatever the model happened to write.
 */
export function iterationsAsStepRecords(
  iterations: ReadonlyArray<{ readonly step: ToolStepRecord }>,
): readonly ToolStepRecord[] | undefined {
  if (iterations.length === 0) return undefined
  return iterations.map((iteration) => iteration.step)
}
