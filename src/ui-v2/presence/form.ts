/**
 * Which visual form Freya takes, and why.
 *
 * One personality in three embodiments (uiplan.md:31–105). This is the single
 * place that decision is made, so no surface can invent a fourth or pick a form
 * on a whim.
 *
 * - **The Brain** is App Mode's centre: cognition, never a face.
 * - **Adult** appears in Immersive when Freya is leading real work.
 * - **Chibi** is the lighter companion form for everyday desktop presence.
 *
 * Adult and Chibi are the documented extension points for Immersive Desktop Mode
 * (spec §E); their art is deferred, and until it lands every form renders the
 * Brain rather than a placeholder avatar.
 */
export type PresenceForm = 'adult' | 'chibi' | 'brain'

export function selectForm(context: { mode: 'app' | 'immersive'; hasWork: boolean }): PresenceForm {
  if (context.mode === 'app') return 'brain'
  return context.hasWork ? 'adult' : 'chibi'
}
