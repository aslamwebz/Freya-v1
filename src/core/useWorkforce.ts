import { useEffect, useState } from 'react'
import { workforceMirror } from '../platform/workforceClient'
import type { WorkforceProjection } from '../../core/protocol/workforce'

/**
 * The Workforce projection, as a React value.
 *
 * Attached alongside the conversation, the Brain, Work and Missions, because
 * the five answer different questions about the same moment: what was said,
 * what Freya already knows, what she is executing, what the owner asked her to
 * accomplish, and who is working at all.
 *
 * Read-only in the stronger sense that matters here: a panel cannot move a
 * worker by assigning to something it received, cannot put one on a team, and
 * cannot grant anything, because the projection has no writable field for any
 * of those and the client has no method that sends them. Everything a surface
 * shows is what Core pushed, and everything it can do about that is look.
 */
export function useWorkforce(): WorkforceProjection | null {
  const [projection, setProjection] = useState<WorkforceProjection | null>(null)
  const mirror = workforceMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}
