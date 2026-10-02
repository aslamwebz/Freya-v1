import type { CueKind } from '../../core/personality/types'
import type { PersonalityCueView, PersonalityProjection } from '../../core/protocol/personality'
import type { AttentionCueCode } from '../../core/attention/types'
import type { AttentionDirectiveView, AttentionProjection } from '../../core/protocol/attention'

/**
 * The one expression cue Presence is allowed to draw.
 *
 * A cue is a *label*, not the gesture: Core says which kind of cue it offered
 * this turn, and this module turns that into one short line. The cue's identity
 * on the projection is a hash and its words never cross the bridge at all, so
 * there is nothing here that reproduces recorded content — a person sees that a
 * greeting cue was offered, not the text of the greeting someone recorded.
 *
 * ## Bounded, and Core's to choose
 *
 * One line, `MAX_EXPRESSION_CUE_CHARS` of it, from a closed four-word table.
 * There is no path by which a window *supplies* a cue: the only input is a
 * projection Core built, and the only output is display text this file wrote.
 * Growth beyond four kinds means editing this table visibly, the same rule the
 * domain's own vocabulary follows.
 *
 * ## A held cue draws nothing
 *
 * Anti-repetition holds a cue because Freya used it too recently. Drawing it
 * anyway would express the gesture the ledger just suppressed — the cue would
 * be on screen whether or not it was used — so `mode: 'hold'` answers `null`
 * and the Personality window reports the hold as a count instead.
 */

export const MAX_EXPRESSION_CUE_CHARS = 48

/** The closed words a cue kind is drawn under. Display only, never parsed. */
export const EXPRESSION_CUE_LABELS: Readonly<Record<CueKind, string>> = Object.freeze({
  greeting: 'greeting',
  catchphrase: 'catchphrase',
  habit: 'habit',
  'inside-joke': 'inside joke',
})

function bounded(text: string): string {
  return text.length > MAX_EXPRESSION_CUE_CHARS
    ? `${text.slice(0, MAX_EXPRESSION_CUE_CHARS - 1)}…`
    : text
}

/**
 * The line Presence shows, or null when there is nothing honest to show.
 *
 * Null for no cue, null for a held cue, and otherwise exactly one bounded
 * sentence naming the kind Core chose.
 */
export function expressionCueLine(cue: PersonalityCueView | null): string | null {
  if (cue === null || cue.mode !== 'offer') return null
  return bounded(`Expression cue: ${EXPRESSION_CUE_LABELS[cue.kind]}`)
}

/** The same, read straight off a projection. */
export function projectionCueLine(projection: PersonalityProjection | null): string | null {
  return projection === null ? null : expressionCueLine(projection.presenceCue)
}

/**
 * The one attention cue Presence is allowed to draw.
 *
 * The same discipline as the personality cue: Core chose the outcome and the
 * code-owned cue label, and this module turns that into one short line. The
 * event's text never crosses the bridge, so there is nothing here that reproduces
 * content — a person sees *that* Core decided to cue and *what class* of thing it
 * was about, never the words. A renderer cannot invent an urgency; it can only
 * draw the label Core sent.
 */
export const ATTENTION_CUE_LABELS: Readonly<Record<AttentionCueCode, string>> = Object.freeze({
  'gentle-nudge': 'gentle nudge',
  'deadline-soon': 'deadline soon',
  'task-finished': 'task finished',
  'needs-attention': 'needs attention',
  'status-update': 'status update',
  'all-clear': 'all clear',
})

export function attentionCueLine(directive: AttentionDirectiveView | null): string | null {
  if (directive === null) return null
  const label = ATTENTION_CUE_LABELS[directive.cueCode ?? 'status-update']
  return bounded(`Attention: ${label} (${directive.outcome})`)
}

/** The same, read straight off an attention projection. */
export function projectionAttentionCueLine(projection: AttentionProjection | null): string | null {
  return projection === null ? null : attentionCueLine(projection.directive)
}
