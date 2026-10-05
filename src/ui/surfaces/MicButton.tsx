import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../icons'
import { voiceEnvelope } from '../../presence/voiceEnvelope'
import { micLevel, subscribeMicLevel } from '../../presence/micLevel'
import type { VoiceProjection } from '../../../core/protocol/conversation'
import { voiceMirror } from '../../platform/voiceClient'
import { VoiceRuntime } from '../../voice/runtime'

/**
 * The microphone control.
 *
 * Press to record, release to stop — and that is the whole interaction. There is no
 * always-on mode, no wake word, and no background capture: the device is opened by
 * this press and released by the next one, on every path including errors and
 * unmount.
 *
 * ## What it does not do any more
 *
 * Phase 3 had this component drive the device itself and ask Core only afterwards.
 * Phase 45 inverts that: the runtime asks Core *first* and opens the microphone
 * second. The host's permission gate reads Core's projection, so a capture the
 * trusted half has not agreed to cannot obtain a device even if this file asked
 * for one. Nothing about the interaction changed; the order of two calls did.
 *
 * ## What a recording becomes
 *
 * Text in the composer. **Not** a turn, unless the owner turned auto-submit on
 * before speaking — and then it goes through the same canonical conversation path
 * typed text uses, with one model call rather than two.
 */
export function MicButton({
  voice,
  onTranscript,
}: {
  voice: VoiceProjection | null
  onTranscript: (text: string) => void
}) {
  const [capturing, setCapturing] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const mirror = useMemo(() => voiceMirror(), [])
  const runtime = useMemo(
    () =>
      new VoiceRuntime(mirror, {
        onTranscript: (text, turnId) => {
          // A transcript Core already submitted is not offered to the composer
          // again; showing it there would invite a second send of the same sentence.
          if (turnId !== null) return
          onTranscript(text)
        },
        onNotice: (message) => setDetail(message.endsWith('.') ? message : `${message}.`),
      }),
    [mirror, onTranscript],
  )
  // Presence reads the level through the envelope, not through React. This
  // subscription is only so the button can show a meter, and it is throttled by
  // the envelope's own smoothing rather than by a re-render per audio frame.
  useEffect(() => subscribeMicLevel(setLevel), [])

  // `capturing` follows Core, not the press. A window that set it from its own
  // pointer events would show a live microphone for the frame between the press
  // and Core's refusal.
  useEffect(() => mirror.subscribe((projection) => setCapturing(projection?.capturing === true)), [mirror])

  useEffect(() => {
    let disposed = false
    void mirror.attach().then((dispose) => {
      if (disposed) dispose()
    })
    return () => {
      disposed = true
      // An unmount mid-press must not leave the device open. The commonest way a
      // microphone leaks is a window that goes away while a finger is still down.
      void runtime.dispose()
    }
  }, [mirror, runtime])

  const begin = useCallback(async () => {
    if (capturing) return
    setDetail(null)
    await runtime.press()
    setCapturing(runtime.listening)
    if (runtime.listening) voiceEnvelope.setRealLevel(0)
  }, [capturing, runtime])

  const end = useCallback(
    async (cancelled: boolean) => {
      setCapturing(false)
      voiceEnvelope.setRealLevel(null)
      await runtime.release(cancelled)
    },
    [runtime],
  )

  const engineMissing = voice !== null && !voice.transcription.available

  return (
    <div className="mic">
      <button
        type="button"
        className="mic-button"
        // `onPointerDown`/`onPointerUp` rather than click, because a press-to-talk
        // control that waits for a full click cannot be stopped by letting go.
        onPointerDown={(event) => {
          event.preventDefault()
          void begin()
        }}
        onPointerUp={() => void end(false)}
        onPointerLeave={() => {
          if (capturing) void end(false)
        }}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            void begin()
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') void end(false)
        }}
        onContextMenu={(event) => event.preventDefault()}
        aria-pressed={capturing}
        aria-label={capturing ? 'Release to stop recording' : 'Hold to record'}
        title={
          engineMissing
            ? `${voice.transcription.detail} Nothing is uploaded.`
            : 'Hold to record. Audio never leaves this machine.'
        }
        data-capturing={capturing || undefined}
        data-voice-state={voice?.state}
        data-level={capturing ? Math.round(micLevel() * 100) / 100 : undefined}
        data-level-state={capturing ? String(Math.round(level * 4)) : undefined}
      >
        <Icon name="mic" />
      </button>
      {capturing ? <span className="mic-live" aria-hidden="true" /> : null}
      {/* Status in words, for a person and for a screen reader. Not a colour. */}
      <span className="sr-only" role="status" aria-live="polite">
        {capturing ? 'Recording locally. Release to stop.' : (detail ?? '')}
      </span>
      {detail ? <span className="mic-detail">{detail}</span> : null}
    </div>
  )
}