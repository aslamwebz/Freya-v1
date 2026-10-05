import { useEffect, useMemo, useState } from 'react'
import type { VoiceProjection } from '../../core/protocol/conversation'
import { voiceMirror } from '../platform/voiceClient'

/**
 * The voice projection, as a React value.
 *
 * Read-only, and attached to the voice client rather than the conversation one.
 *
 * Phase 3 read voice off the conversation mirror because there was nowhere else
 * for it. There is now: `voiceClient` follows the same push Core sends, and the
 * reason to split them is cadence. A conversation projection is rebuilt by reading
 * the store, and rebuilding that because a microphone closed would put a personal
 * transcript read on the critical path of a device release.
 *
 * There is no way from here to configure a speech engine. Adapters are supplied
 * when Core is built; a window cannot introduce one, name an endpoint, or hold a
 * credential.
 */
export function useVoice(): VoiceProjection | null {
  const [voice, setVoice] = useState<VoiceProjection | null>(null)
  const mirror = useMemo(() => voiceMirror(), [])

  useEffect(() => {
    const dispose = mirror.subscribe(setVoice)
    let released = false
    let detach: (() => void) | null = null
    void mirror.attach().then((disposeAttach) => {
      if (released) disposeAttach()
      else detach = disposeAttach
    })
    return () => {
      released = true
      detach?.()
      dispose()
    }
  }, [mirror])

  return voice
}