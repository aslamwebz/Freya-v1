import { useEffect, useState } from 'react'
import { workMirror } from '../platform/workClient'
import type { WorkProjection } from '../../core/work/projection'

/**
 * The Work projection, as a React value.
 *
 * Attached alongside the conversation and the Brain, because the three answer
 * different questions about the same moment: what was said, what Freya already
 * knows, and what she is doing now.
 *
 * Read-only, and read-only in the stronger sense that matters here: a panel cannot
 * move a Run by assigning to something it received, and cannot mark a step verified
 * because there is no field for it to assign. Every change to Work state goes to
 * Core as a command and comes back as Core's own answer.
 */
export function useWork(): WorkProjection | null {
  const [projection, setProjection] = useState<WorkProjection | null>(null)
  const mirror = workMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}