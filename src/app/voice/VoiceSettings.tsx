import { useState } from 'react'
import type { VoiceDock } from './useVoiceDock'

/**
 * Voice controls.
 *
 * A settings row rather than anything on the board, and that placement is a
 * decision about *what belongs where*: the composer has one microphone control
 * because it has one job — talk to Freya now. Everything that is a durable
 * preference (is the microphone on at all, should Freya speak, should a finished
 * transcript be sent without review, is hands-free armed) belongs in the place a
 * person goes when they want to change how Freya behaves.
 *
 * ## Every control states its real state
 *
 * Each switch is read from Core's projection and each carries a sentence saying
 * why it is where it is. The three that matter most:
 *
 * - **The microphone is off by default and says so.** There is no preference to
 *   hydrate and nothing to restore, so a restart is off without being told to be.
 * - **Hands-free is off by default and, on a build with no local gate, refuses.**
 *   It says the reason instead of presenting a switch that does nothing.
 * - **"Send what I say" is off by default.** With it off, a transcript lands in the
 *   composer for review; with it on, Core enters the *same* conversation path typed
 *   text uses. Either way it is one model call, never two, and nothing about it
 *   bypasses the Governor.
 */
export function VoiceSettings({ voice, expanded = false }: { voice: VoiceDock; expanded?: boolean }) {
  const [open, setOpen] = useState(false)
  const { view } = voice
  const projection = view.projection

  // Nothing to configure without a projection, and saying so is better than
  // rendering five switches that all silently do nothing.
  if (projection === null) {
    return <p className="freya-v2 sr-only" role="status">Voice status is unavailable in this window.</p>
  }

  return (
    <section className="freya-v2" aria-label="Voice settings">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Voice
      </button>
      {open || expanded ? (
        <div role="group" aria-label="Voice">
          <p role="status" data-voice-state={view.state}>
            {!view.micEnabled ? 'Off. Microphone closed.' : view.wakeArmed && !projection.attention?.active ? 'Standby. Say “Freya” to begin.' : projection.attention?.active ? 'Listening. Say “stand by” when finished.' : describe(view.state)}
          </p>

          <Switch
            label="Microphone"
            detail={
              view.micEnabled
                ? view.wakeArmed ? 'On. Checks the name locally in standby; listens to speech after you call Freya.' : 'On. Freya only listens between a press and its release.'
                : 'Off. Freya cannot listen until you turn this on.'
            }
            on={view.micEnabled}
            onChange={voice.toggleMic}
          />

          <Switch
            label="Freya speaks"
            detail={
              view.muted
                ? 'Muted. Stored answers are not read aloud.'
                : projection.synthesis.detail
            }
            on={!view.muted && projection.synthesis.available}
            disabled={!projection.synthesis.available}
            onChange={() => voice.toggleMute()}
          />

          <Switch
            label="Send what I say"
            detail={
              projection.autoSubmit
                ? 'On. A finished transcript enters the same conversation path as typing.'
                : 'Off. A finished transcript waits in the composer until you send it.'
            }
            on={projection.autoSubmit}
            onChange={voice.toggleAutoSubmit}
          />

          <Switch
            label="Hands-free"
            detail={projection.wake.detail}
            on={view.wakeArmed}
            disabled={!projection.wake.available}
            onChange={voice.toggleWake}
          />

          {view.speaking ? (
            <button type="button" onClick={voice.stopSpeaking}>
              Stop Freya speaking
            </button>
          ) : null}

          {view.voices.length > 0 ? (
            <label>
              <span>Voice</span>
              <select
                value={projection.selectedVoiceId ?? ''}
                onChange={(event) => voice.chooseVoice(event.target.value)}
              >
                <option value="">Platform default</option>
                {view.voices.map((entry) => (
                  <option key={entry.voiceId} value={entry.voiceId}>
                    {entry.label}
                    {entry.language ? ` (${entry.language})` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {view.capturing ? (
            <button type="button" onClick={voice.cancel}>
              Discard this recording
            </button>
          ) : null}

          {projection.faults.length > 0 ? (
            <ul aria-label="Voice faults">
              {projection.faults.map((fault) => (
                <li key={fault}>{fault}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function Switch({
  label,
  detail,
  on,
  disabled = false,
  onChange,
}: {
  label: string
  detail: string
  on: boolean
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <label>
      <input type="checkbox" checked={on} disabled={disabled} onChange={onChange} />
      <span>{label}</span>
      <small>{detail}</small>
    </label>
  )
}

/**
 * The state string, as a sentence.
 *
 * A closed switch on purpose. A projection could in principle carry a state this
 * build does not know, and the fallback is "not sure" rather than a confident
 * guess — which is the honest reading of an unrecognised value.
 */
function describe(state: string): string {
  switch (state) {
    case 'unsupported':
      return 'This build offers no microphone capture.'
    case 'permission-required':
      return 'The microphone is off and no permission has been asked for yet.'
    case 'permission-denied':
      return 'Microphone permission was denied.'
    case 'ready':
      return 'Ready. The microphone is on and nothing is being recorded.'
    case 'listening':
      return 'Recording locally.'
    case 'transcribing':
      return 'Reading the recording.'
    case 'submitting':
      return 'Sending what you said.'
    case 'speaking':
      return 'Speaking.'
    case 'interrupted':
      return 'Speaking was interrupted.'
    case 'degraded':
      return 'Partly working. See the notes below.'
    case 'failed':
      return 'The last attempt failed.'
    case 'stopped-by-STOP-ALL':
      return 'Freya is stopped, so the microphone and playback are off.'
    default:
      return 'Voice state is not known.'
  }
}

/**
 * A tiny wrapper so a component that only wants the state string does not need
 * the whole dock.
 *
 * Exported for the settings tests, which assert on the sentence rather than on
 * Core's own enum — a status line is what a person reads, so that is the thing
 * worth testing.
 */
export function describeVoiceState(state: string): string {
  return describe(state)
}
