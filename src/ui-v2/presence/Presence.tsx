import { Brain } from './Brain'
import type { BrainState } from './state'
import type { PresenceForm } from './form'

/**
 * Presence — the single entry point that renders whichever form Freya is in.
 *
 * `form` is chosen by `selectForm` and nowhere else. Only the Brain is built;
 * Adult and Chibi are the Immersive Desktop Mode extension points (spec §E), and
 * until their art lands this renders the cognition orb rather than inventing an
 * avatar. When they arrive, their slots go here and nowhere else changes.
 */
export function Presence({ form, state }: { form: PresenceForm; state: BrainState }) {
  switch (form) {
    case 'brain':
    case 'adult':
    case 'chibi':
      return <Brain state={state} />
  }
}
