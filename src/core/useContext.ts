import { useEffect, useState } from 'react'
import { contextMirror } from '../platform/contextClient'
import type { ContextProjection } from '../../core/protocol/context'

/**
 * The Context projection, as a React value.
 *
 * Attached alongside the conversation, the Brain, Work, Missions and the
 * Workforce, because each answers a different question about the same moment —
 * and this one asks *what is around the current question*, in Core's words and
 * only in Core's words.
 *
 * Read-only in the strongest sense in this repository: the mirror it reads has
 * no method that submits anything, the bridge it rides has no write channel,
 * and the projection itself carries reports rather than content. A panel cannot
 * select, revoke, resolve or capture by reaching for something on this value,
 * because no such field or method exists to reach.
 */
export function useContext(): ContextProjection | null {
  const [projection, setProjection] = useState<ContextProjection | null>(null)
  const mirror = contextMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}
