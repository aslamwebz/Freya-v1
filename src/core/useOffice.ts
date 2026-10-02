import { useEffect, useState } from 'react'
import { officeMirror } from '../platform/officeClient'
import type { OfficeProjection } from '../../core/office/projection'

/**
 * The Office projection, as a React value.
 *
 * Attached alongside the conversation, the Brain, Work, Missions and Workforce,
 * because the Office is the spatial view of the same moment: where Freya is,
 * what is executing, who is working and what is waiting.
 *
 * Read-only in the stronger sense that matters here: a panel cannot invent a
 * station, inflate a count or fabricate a percentage, because the projection
 * has no writable field for any of those and the client has no method that
 * sends them. Everything a surface shows is what Core pushed, and everything
 * it can do about that is look — or ask for an agent to join the desktop
 * Presence through the one bounded command.
 */
export function useOffice(): OfficeProjection | null {
  const [projection, setProjection] = useState<OfficeProjection | null>(null)
  const mirror = officeMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}
