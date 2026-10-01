import { useEffect, useState } from 'react'
import { missionMirror } from '../platform/missionClient'
import type { MissionProjection } from '../../core/missions/types'

/**
 * The Mission projection, as a React value.
 *
 * Attached alongside the conversation, the Brain and Work, because the four answer
 * different questions about the same moment: what was said, what Freya already knows,
 * what she is executing, and what the owner asked her to accomplish.
 *
 * Read-only in the stronger sense that matters here: a panel cannot move a Mission by
 * assigning to something it received, and cannot complete one, because the projection
 * has no writable field for either. Every change goes to Core as a command and comes
 * back as Core's own answer.
 */
export function useMission(): MissionProjection | null {
  const [projection, setProjection] = useState<MissionProjection | null>(null)
  const mirror = missionMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}