import { useState } from 'react'
import type { VoiceDock } from './useVoiceDock'

/**
 * Freya's voice settings.
 *
 * Chat cognition and Voice are deliberately separate here. The Chat model decides
 * how Freya reasons; these controls decide only how she hears and speaks.
 *
 * No credential is shown or accepted on this surface. NanoGPT speech recognition
 * reuses the main-process NanoGPT credential already configured for Freya.
 */
export function VoiceSettings({ voice }: { voice: VoiceDock }) {
  const [open, setOpen] = useState(false)
  const { view } = voice
  const projection = view.projection
  const config = view.config

  if (projection === null) {
    return <p className="freya-v2 sr-only" role="status">Voice status is unavailable in this window.</p>
  }

  return (
    <section className="freya-v2" aria-label="Voice settings">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Voice
      </button>

      {open ? (
        <div role="group" aria-label="Voice">
          <p role="status" data-voice-state={view.state}>
            {describe(view.state)}
          </p>

          <p>
            Voice is an input/output system for Freya. Changing these settings does not
            change Freya's Chat model, memory, identity, goals, or authority.
          </p>

          <Switch
            label="Microphone"
            detail={
              view.micEnabled
                ? 'On. Push-to-talk records only while pressed; hands-free requires its own switch below.'
                : 'Off. Freya cannot hear anything until you turn this on.'
            }
            on={view.micEnabled}
            onChange={voice.toggleMic}
          />

          <fieldset>
            <legend>Speech recognition</legend>

            <label>
              <span>Provider</span>
              <select
                aria-label="Speech recognition provider"
                value={config?.sttProvider ?? 'off'}
                disabled={view.configBusy}
                onChange={(event) => {
                  const provider = event.target.value === 'nanogpt' ? 'nanogpt' : 'off'
                  voice.saveConfig({ sttProvider: provider })
                }}
              >
                <option value="off">Off</option>
                <option value="nanogpt">NanoGPT</option>
              </select>
            </label>

            <label>
              <span>Speech recognition model</span>
              <input
                aria-label="Speech recognition model"
                type="text"
                maxLength={160}
                value={config?.sttModel ?? ''}
                placeholder="Whisper-Large-V3"
                disabled={view.configBusy || config?.sttProvider !== 'nanogpt'}
                onChange={(event) => {
                  const model = event.target.value.trim()
                  if (model.length > 0) voice.saveConfig({ sttModel: model })
                }}
              />
            </label>

            <Switch
              label="Allow remote speech recognition"
              detail={
                config?.remoteSttEnabled
                  ? 'On. A bounded recording may be sent to NanoGPT for transcription. Audio is not written to Freya logs or memory.'
                  : 'Off. Microphone audio is not sent to NanoGPT; hosted speech recognition remains unavailable.'
              }
              on={config?.remoteSttEnabled ?? false}
              disabled={view.configBusy || config?.sttProvider !== 'nanogpt'}
              onChange={() => voice.saveConfig({ remoteSttEnabled: !(config?.remoteSttEnabled ?? false) })}
            />

            <small>
              Voice reuses the NanoGPT key already stored for Freya. There is no separate
              Voice API key and the key never enters this window.
            </small>
          </fieldset>

          <fieldset>
            <legend>Freya speaking</legend>

            <label>
              <span>Speech output provider</span>
              <select
                aria-label="Speech output provider"
                value={config?.ttsProvider ?? 'off'}
                disabled={view.configBusy}
                onChange={(event) => {
                  const provider = event.target.value === 'platform' ? 'platform' : 'off'
                  voice.saveConfig({ ttsProvider: provider })
                }}
              >
                <option value="off">Off</option>
                <option value="platform">System voice — free / local</option>
              </select>
            </label>

            <Switch
              label="Freya answers aloud"
              detail={
                !projection.synthesis.available
                  ? projection.synthesis.detail
                  : config?.autoSpeak
                    ? 'On. Answers produced by a spoken turn are read aloud after Core stores them.'
                    : 'Off. Freya still answers in Chat, but does not automatically read the answer.'
              }
              on={config?.autoSpeak ?? false}
              disabled={
                view.configBusy ||
                config?.ttsProvider !== 'platform' ||
                !projection.synthesis.available
              }
              onChange={() => voice.saveConfig({ autoSpeak: !(config?.autoSpeak ?? false) })}
            />

            <Switch
              label="Speak important alerts"
              detail={
                config?.proactiveAlerts
                  ? 'On. Only Attention decisions rated speak or interrupt may use Freya’s voice, and the spoken sentence comes from Core’s closed event vocabulary.'
                  : 'Off. Work, Mission, Research and system events stay visual even when Attention marks them important.'
              }
              on={config?.proactiveAlerts ?? false}
              disabled={view.configBusy || config?.ttsProvider !== 'platform'}
              onChange={() =>
                voice.saveConfig({ proactiveAlerts: !(config?.proactiveAlerts ?? false) })
              }
            />

            {view.voices.length > 0 && config?.ttsProvider === 'platform' ? (
              <label>
                <span>System voice</span>
                <select
                  aria-label="System voice"
                  value={config?.ttsVoiceId ?? projection.selectedVoiceId ?? ''}
                  disabled={view.configBusy}
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
          </fieldset>

          <fieldset>
            <legend>Attention</legend>

            <Switch
              label={'Wake on "Freya"'}
              detail={wakeDetail(view)}
              on={view.wakeArmed}
              disabled={
                view.configBusy ||
                !projection.wake.available ||
                config?.sttProvider === 'off' ||
                !config?.remoteSttEnabled
              }
              onChange={voice.toggleWake}
            />

            <p>
              When armed, local speech activity opens one short in-memory clip. With the
              current NanoGPT wake fallback, that clip is transcribed remotely so Core can
              decide whether it began with “Freya”. This is not continuous cloud streaming,
              but nearby speech clips can leave the device while hands-free is armed.
            </p>

            <p>
              After “Freya” is heard, Freya stays attentive for{' '}
              {Math.round(projection.attention.followUpWindowMs / 1000)} seconds, so you can
              continue naturally without repeating her name. Say “stand by”, “that’s all”,
              or wait for the window to expire to return to standby.
            </p>
          </fieldset>

          <Switch
            label="Send push-to-talk transcripts automatically"
            detail={
              projection.autoSubmit
                ? 'On. A finished push-to-talk transcript enters the same Conversation/Mind path as typing.'
                : 'Off. Push-to-talk text waits for review before it is sent.'
            }
            on={projection.autoSubmit}
            onChange={voice.toggleAutoSubmit}
          />

          {view.speaking ? (
            <button type="button" onClick={voice.stopSpeaking}>
              Stop Freya speaking
            </button>
          ) : null}

          {view.capturing ? (
            <button type="button" onClick={voice.cancel}>
              Discard this recording
            </button>
          ) : null}

          {view.notice ? <p role="alert">{view.notice}</p> : null}

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

function wakeDetail(view: VoiceDock['view']): string {
  const p = view.projection
  if (p === null) return 'Voice status is unavailable.'
  if (!p.wake.available) return p.wake.detail
  if (view.wakeArmed) {
    return p.attention.state === 'attentive'
      ? `Armed. Freya is attentive until ${p.attention.attentiveUntil ?? 'the follow-up window ends'}.`
      : 'Armed. Say “Freya” followed by a request.'
  }
  return 'Off. No hands-free microphone stream is held.'
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

function describe(state: string): string {
  switch (state) {
    case 'unsupported':
      return 'This build offers no microphone capture.'
    case 'permission-required':
      return 'The microphone is off or waiting for operating-system permission.'
    case 'permission-denied':
      return 'Microphone permission was denied.'
    case 'ready':
      return 'Ready. The microphone is available and nothing is being recorded.'
    case 'listening':
      return 'Listening to one bounded utterance.'
    case 'transcribing':
      return 'Transcribing one bounded utterance.'
    case 'submitting':
      return 'Sending what you said through Freya’s normal Conversation/Mind path.'
    case 'speaking':
      return 'Freya is speaking.'
    case 'interrupted':
      return 'Freya was interrupted.'
    case 'degraded':
      return 'Voice is partly working. See the notes below.'
    case 'failed':
      return 'The last voice attempt failed.'
    case 'stopped-by-STOP-ALL':
      return 'Freya is stopped, so listening and playback are off.'
    default:
      return 'Voice state is not known.'
  }
}

export function describeVoiceState(state: string): string {
  return describe(state)
}
