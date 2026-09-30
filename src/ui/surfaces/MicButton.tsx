import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { shellStore } from '../store'
import { conversationMirror } from '../../platform/conversationClient'
import { micLevel, subscribeMicLevel } from '../../presence/micLevel'
import { voiceEnvelope } from '../../presence/voiceEnvelope'
import { MicrophoneError, openMicrophone, type MicCapture } from './microphone'
import type { VoiceProjection } from '../../../core/protocol/conversation'

/**
 * The microphone control.
 *
 * Press to record, release to stop — and that is the whole interaction. There is
 * no always-on mode, no wake word, and no background capture: the device is
 * opened by this press and released by the next one, on every path including
 * errors and unmount.
 *
 * ## What a recording becomes
 *
 * Text in the composer. **Not** a turn, and not a model call.
 *
 * That separation is the important design decision in the whole voice section. A
 * transcript is inserted where the user can read it, and they press Send like
 * they would for anything they typed — because it *is* something they typed, and
 * speech recognition and thinking are different systems with different costs and
 * different privacy. An automatic send would make a microphone press a purchase.
 *
 * ## When there is no engine
 *
 * On most machines there is no local speech engine, and the button says so before
 * it is pressed. The honest outcome is "recording discarded", never a fallback to
 * a cloud service — there is no cloud service, and there is no code path that
 * could reach one.
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
  const capture = useRef<MicCapture | null>(null)
  const session = useRef<string | null>(null)
  const mirror = conversationMirror()

  // Core's own bounds, so the UI cannot offer a capture the Core would refuse.
  // The sample rate is the one the capture format is defined at; it is not a
  // user-facing setting, so it is not part of the projection.
  const limits = {
    maxDurationMs: voice?.limits.maxDurationMs ?? 30_000,
    maxBytes: voice?.limits.maxAudioBytes ?? 4 * 1024 * 1024,
    sampleRate: 16_000,
  }

  // Presence reads the level through the envelope, not through React. This
  // subscription is only so the button can show a meter, and it is throttled by
  // the envelope's own smoothing rather than by a re-render per audio frame.
  useEffect(() => subscribeMicLevel(setLevel), [])

  const release = useCallback(async (cancelled: boolean) => {
    const active = capture.current
    const sessionId = session.current
    capture.current = null
    session.current = null
    setCapturing(false)
    voiceEnvelope.setRealLevel(null)
    shellStore.dispatch({ type: 'voice.toggle', listening: false })

    if (!active || !sessionId) return
    const { audio, durationMs } = await active.stop(cancelled)
    const outcome = await mirror.voiceCaptureEnd({ sessionId, audio, durationMs, cancelled })
    // The status line has to reflect the session that actually ended, not the one
    // the window assumed. Core is asked rather than guessed at.
    void mirror.refreshVoice()
    if (outcome.text) {
      onTranscript(outcome.text)
      setDetail(null)
    } else {
      setDetail(outcome.detail ?? outcome.reason ?? 'The recording was discarded.')
    }
  }, [mirror, onTranscript])

  // An unmount mid-press must not leave the device open. The commonest way a
  // microphone leaks is a window that goes away while a finger is still down.
  useEffect(() => {
    return () => {
      void capture.current?.abandon()
      capture.current = null
      session.current = null
      voiceEnvelope.setRealLevel(null)
    }
  }, [])

  const begin = useCallback(async () => {
    if (capturing) return
    setDetail(null)
    try {
      // Core first: the host only relaxes the microphone permission once the
      // trusted half has agreed a capture is running.
      const started = await mirror.voiceCaptureStart()
      if (!started.ok || started.sessionId === null) {
        setDetail(started.reason ?? 'The microphone could not be opened.')
        return
      }
      session.current = started.sessionId
      void mirror.refreshVoice()
      capture.current = await openMicrophone(limits)
      setCapturing(true)
      voiceEnvelope.setRealLevel(0)
      shellStore.dispatch({ type: 'voice.toggle', listening: true })
    } catch (error) {
      const reason =
        error instanceof MicrophoneError ? error.message : 'the microphone could not be opened'
      setDetail(`${reason}.`)
      // Whatever went wrong, the device is not ours to keep.
      if (session.current !== null) {
        await mirror.voiceCaptureCancel()
        session.current = null
      }
      setCapturing(false)
      voiceEnvelope.setRealLevel(null)
    }
  }, [capturing, limits, mirror])

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
        onPointerUp={() => void release(false)}
        onPointerLeave={() => {
          if (capturing) void release(false)
        }}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault()
            void begin()
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') void release(false)
        }}
        onContextMenu={(event) => event.preventDefault()}
        aria-pressed={capturing}
        aria-label={capturing ? 'Release to stop recording' : 'Hold to record'}
        title={
          engineMissing
            ? 'No local speech engine is configured — recording is discarded, never uploaded'
            : 'Hold to record. Local only. You review the transcript, then send it.'
        }
        data-capturing={capturing || undefined}
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
