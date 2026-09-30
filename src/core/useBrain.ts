import { useEffect, useState } from 'react'
import { brainMirror } from '../platform/brainClient'
import type { BrainProjection } from '../../core/brain/brain'

/**
 * The Brain projection, as a React value.
 *
 * Attached alongside the conversation, because the two answer different questions
 * about the same moment: what was said, and what Freya already knows. A window that
 * shows a memory surface needs the identity, the durability label and the conflict
 * count before anybody presses anything.
 *
 * Read-only. The one write path is a command, not a projection field — a panel
 * cannot mutate what Freya remembers by assigning to something it received.
 */
export function useBrain(): BrainProjection | null {
  const [projection, setProjection] = useState<BrainProjection | null>(null)
  const mirror = brainMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}