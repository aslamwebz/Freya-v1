import { useEffect, useState } from 'react'
import { conversationMirror } from '../platform/conversationClient'
import type { VoiceProjection } from '../../core/protocol/conversation'

/**
 * The voice projection, as a React value.
 *
 * Attached alongside the conversation, because the two arrive together and a
 * window that shows a microphone needs to know whether a local engine exists
 * before someone presses it — otherwise the button is a live-looking control
 * whose honest outcome is "recording discarded".
 *
 * Read-only. There is no way from here to configure a speech service, because
 * voice is local-only and there is no service to configure.
 */
export function useVoice(): VoiceProjection | null {
  const [voice, setVoice] = useState<VoiceProjection | null>(null)
  const mirror = conversationMirror()

  useEffect(() => {
    const dispose = mirror.subscribeVoice(setVoice)
    void mirror.attachVoice()
    return dispose
  }, [mirror])

  return voice
}
