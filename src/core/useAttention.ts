import { useEffect, useState } from 'react'
import { attentionMirror } from '../platform/attentionClient'
import type { AttentionProjection } from '../../core/protocol/attention'

/**
 * The Attention projection, as a React value.
 *
 * Attached alongside the conversation, the Brain, Work and the rest, because they
 * answer different questions about the same moment: what was said, what Freya
 * already knows, what she is executing — and, here, what arrived and what Core
 * decided to do about it.
 *
 * Read-only in the stronger sense that matters: a component cannot set an
 * importance, assert an urgency, choose an outcome, spend a budget or bypass a
 * cooldown by writing to something it received, because the projection has no
 * writable field for any of those and the mirror has no method that sends them.
 * Everything a surface shows is what Core pushed.
 */
export function useAttention(): AttentionProjection | null {
  const [projection, setProjection] = useState<AttentionProjection | null>(null)
  const mirror = attentionMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}
