import { useEffect, useState } from 'react'
import { relayMirror } from '../platform/relayClient'
import type { RelayProjection } from '../../core/protocol/relay'

/**
 * The Relay projection, as a React value.
 *
 * Read-only in the stronger sense that matters: a component cannot register a
 * connector, fault one, set an allowlist, execute an action or decide an
 * approval by writing to something it received, because the projection has no
 * writable field for any of those and the mirror has no method that sends
 * them. Everything a surface shows is what Core pushed.
 */
export function useRelay(): RelayProjection | null {
  const [projection, setProjection] = useState<RelayProjection | null>(null)
  const mirror = relayMirror()

  useEffect(() => {
    const dispose = mirror.subscribe(setProjection)
    void mirror.attach()
    return dispose
  }, [mirror])

  return projection
}
