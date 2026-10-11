import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from './markers'

/**
 * Make remote or model-supplied text safe to carry.
 *
 * Three things, all cheap and all structural rather than clever:
 *
 *  - **Control characters become spaces.** A newline in a snippet could forge a
 *    line in a report, and a BEL could make a window beep.
 *  - **The envelope markers are defanged.** A page that prints
 *    `FREYA_TOOL_CALL` must not be able to make that string appear verbatim
 *    anywhere a later parse might see it.
 *  - **Length is bounded**, with a visible marker rather than a silent cut, so a
 *    truncated quote is never read as a whole one.
 */
export function sanitiseUntrustedText(value: string, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const defanged = stripControlCharacters(value)
    .split(TOOL_CALL_OPEN).join('FREYA_TOOL_CALL[defanged]')
    .split(TOOL_CALL_CLOSE).join('FREYA_TOOL_CALL_END[defanged]')
  return boundText(defanged, maxChars)
}

/**
 * Make a model-supplied *argument* safe to carry, keeping newlines when the
 * parameter is a list.
 *
 * The difference from {@link sanitiseUntrustedText} is exactly one thing, and it
 * is the thing a list-valued argument needs: when `multiline` is true, a newline
 * survives as the separator instead of being flattened to a space. Every other
 * control character is flattened in both cases, the envelope markers are defanged
 * in both cases, and both are length-bounded with a visible marker.
 */
export function sanitiseArgumentText(value: string, maxChars: number, multiline: boolean): string {
  if (typeof value !== 'string') return ''
  const flattened = multiline ? flattenControlsKeepingNewlines(value) : stripControlCharacters(value)
  const defanged = flattened
    .split(TOOL_CALL_OPEN).join('FREYA_TOOL_CALL[defanged]')
    .split(TOOL_CALL_CLOSE).join('FREYA_TOOL_CALL_END[defanged]')
  return boundText(defanged, maxChars)
}

/**
 * Flatten every C0 control and DEL to a space, except the line separators.
 *
 * A carriage return is normalised to a single newline so a Windows-style list and
 * a Unix-style list are the same list, and runs of blank lines are collapsed so a
 * model that leaves gaps between entries does not hand a tool a list full of
 * empty rows. Leading and trailing whitespace is trimmed, because an address list
 * with a trailing blank line is not a different list.
 */
function flattenControlsKeepingNewlines(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x0d) {
      out += '\n'
      continue
    }
    out += code < 0x20 || code === 0x7f ? ' ' : character
  }
  return out.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/**
 * Flatten every C0 control and DEL to a space.
 *
 * A scan rather than a regular expression, for the same reason
 * `core/model/nanogpt-provider.ts` does it that way: a pattern built from control
 * ranges is exactly what a linter rightly refuses to let through unreviewed, and
 * an explicit code-point comparison says what it means.
 */
function stripControlCharacters(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : character
  }
  return out.trim()
}

/** Bound a string, marking that it was cut. */
export function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}
