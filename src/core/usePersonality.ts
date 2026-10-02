import { useEffect, useState } from 'react'
import { personalityMirror } from '../platform/personalityClient'
import type { PersonalityProjection } from '../../core/protocol/personality'

/**
 * The Personality projection, as a React value.
 *
 * Attached alongside the conversation, the Brain, Work and the rest, because
 * they answer different questions about the same moment: what was said, what
 * Freya already knows, what she is executing — and, here, who she is as a
 * temperament and what she has actually recorded about the person she is
 * talking to.
 *
 * Read-only in the stronger sense that matters: a component cannot file a
 * preference, mark a habit, declare an inside joke or choose a cue by writing
 * to something it received, because the projection has no writable field for
 * any of those and the client has no method that sends them. Everything a
 * surface shows is what Core pushed, and everything it can do about that is
 * look.
 */
export function usePersonality(): PersonalityProjection | null {
  const [projection, setProjection] = useState<PersonalityProjection | null>(null)
  const mirror = personalityMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}
