import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceSettings, describeVoiceState } from '../../../src/app/voice/VoiceSettings'
import type { VoiceDock, VoiceView } from '../../../src/app/voice/useVoiceDock'
import { absentVoiceProjection } from '../../core/voice/fixture'
import type { VoiceConfig } from '../../../electron/voiceConfig'

const DEFAULT_TEST_VOICE_CONFIG: VoiceConfig = {
  version: 1,
  sttProvider: 'nanogpt',
  sttModel: 'Whisper-Large-V3',
  remoteSttEnabled: true,
  ttsProvider: 'platform',
  ttsVoiceId: null,
  ttsModel: 'system',
  wakeProvider: 'off',
  autoSpeak: true,
  proactiveAlerts: false,
}

/**
 * The voice settings row.
 *
 * The properties worth pinning are all about *truthfulness of the control*, since
 * a switch that renders the wrong state is worse than no switch: a person who has
 * been told "send push-to-talk transcripts automatically" is on has made a different decision from one who has
 * been told it is off.
 */

afterEach(() => {
  cleanup()
})

function dock(overrides: Partial<VoiceView> & { autoSubmit?: boolean } = {}): VoiceDock & { pressed: string[] } {
  const pressed: string[] = []
  const projection = absentVoiceProjection({
    micEnabled: overrides.micEnabled ?? true,
    muted: overrides.muted ?? false,
    autoSubmit: overrides.autoSubmit ?? false,
    synthesis: {
      available: overrides.capabilities?.capture ?? false,
      engine: null,
      kind: 'platform',
      availability: 'unavailable',
      detail: 'No speech output engine is configured, so Freya does not read replies aloud.',
    },
    wake: { armed: overrides.wakeArmed ?? false, available: false, gate: 'none', kind: 'speech-activity', detail: 'no gate', maxArmedMs: 0 },
  })
  return {
    view: {
      state: 'ready',
      projection,
      interim: '',
      micEnabled: overrides.micEnabled ?? true,
      capturing: false,
      speaking: false,
      muted: overrides.muted ?? false,
      wakeArmed: overrides.wakeArmed ?? false,
      notice: '',
      unavailableReason: null,
      capabilities: { capture: true, recognition: { available: false, local: false, detail: 'no API' } },
      voices: [],
      ...overrides,
      config: overrides.config ?? DEFAULT_TEST_VOICE_CONFIG,
      configBusy: overrides.configBusy ?? false,
    },
    pressed,
    press: () => pressed.push('press'),
    release: () => pressed.push('release'),
    cancel: () => pressed.push('cancel'),
    toggleMic: () => pressed.push('toggleMic'),
    toggleMute: () => pressed.push('toggleMute'),
    toggleWake: () => pressed.push('toggleWake'),
    toggleAutoSubmit: () => pressed.push('toggleAutoSubmit'),
    stopSpeaking: () => pressed.push('stopSpeaking'),
    chooseVoice: () => pressed.push('chooseVoice'),
    saveConfig: () => pressed.push('saveConfig'),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('the microphone switch', () => {
  it('says the microphone is off, and offers to turn it on', () => {
    const d = dock({ micEnabled: false })
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /microphone/i }) as HTMLInputElement
    expect(row.checked).toBe(false)
    expect(screen.getByText(/Freya cannot hear anything until you turn this on/i)).toBeTruthy()
  })

  it('says it is on, and says that only a press opens the device', () => {
    const d = dock({ micEnabled: true })
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /microphone/i }) as HTMLInputElement
    expect(row.checked).toBe(true)
    expect(screen.getByText(/Push-to-talk records only while pressed/i)).toBeTruthy()
  })
})

describe('the send-what-I-say switch', () => {
  it('defaults to off and says what off means', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /send push-to-talk transcripts automatically/i }) as HTMLInputElement
    expect(row.checked).toBe(false)
    expect(screen.getByText(/waits for review before it is sent/i)).toBeTruthy()
  })

  it('when on, says it enters the same conversation path as typing', () => {
    const d = dock({ autoSubmit: true })
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /send push-to-talk transcripts automatically/i }) as HTMLInputElement
    expect(row.checked).toBe(true)
    expect(screen.getByText(/same Conversation\/Mind path as typing/i)).toBeTruthy()
  })
})

describe('wake on "Freya"', () => {
  it('is disabled and says why on a build with no local gate', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /wake on "Freya"/i }) as HTMLInputElement
    // Disabled rather than merely ineffective: a control that cannot work must not
    // look like one that can.
    expect(row.disabled).toBe(true)
    expect(screen.getByText('no gate')).toBeTruthy()
  })
})

describe('an unavailable engine', () => {
  it('disables the speaking switch and quotes the reason', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /Freya answers aloud/i }) as HTMLInputElement
    expect(row.disabled).toBe(true)
    expect(screen.getAllByText(/does not read replies aloud/i).length).toBeGreaterThan(0)
  })
})

describe('a window that cannot reach Core', () => {
  it('says so rather than rendering switches that do nothing', () => {
    const d = dock()
    const view: VoiceDock = { ...d, view: { ...d.view, projection: null, state: 'unreachable' } }
    render(<VoiceSettings voice={view} />)
    expect(screen.getByText(/voice status is unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('separate voice provider settings', () => {
  it('shows NanoGPT STT separately from the Chat model and exposes its own model field', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    expect((screen.getByRole('combobox', { name: /speech recognition provider/i }) as HTMLSelectElement).value).toBe('nanogpt')
    expect((screen.getByRole('textbox', { name: /speech recognition model/i }) as HTMLInputElement).value).toBe('Whisper-Large-V3')
    expect(screen.getByText(/does not change Freya's Chat model/i)).toBeTruthy()
  })

  it('keeps proactive Attention speech off by default', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /speak important alerts/i }) as HTMLInputElement
    expect(row.checked).toBe(false)
  })
})

describe('the state sentence', () => {
  it('names each state a person could be in', () => {
    expect(describeVoiceState('unsupported')).toMatch(/no microphone capture/i)
    expect(describeVoiceState('permission-required')).toMatch(/waiting for operating-system permission/i)
    expect(describeVoiceState('permission-denied')).toMatch(/was denied/i)
    expect(describeVoiceState('ready')).toMatch(/nothing is being recorded/i)
    expect(describeVoiceState('listening')).toMatch(/bounded utterance/i)
    expect(describeVoiceState('transcribing')).toMatch(/transcribing/i)
    expect(describeVoiceState('submitting')).toMatch(/Conversation\/Mind path/i)
    expect(describeVoiceState('speaking')).toMatch(/Freya is speaking/i)
    expect(describeVoiceState('interrupted')).toMatch(/interrupted/i)
    expect(describeVoiceState('degraded')).toMatch(/partly working/i)
    expect(describeVoiceState('failed')).toMatch(/failed/i)
    expect(describeVoiceState('stopped-by-STOP-ALL')).toMatch(/is stopped/i)
  })

  it('says "not known" for a state it does not recognise', () => {
    // A projection could carry a value from a newer Core. The fallback is the honest
    // reading, not a confident guess.
    expect(describeVoiceState('something-new')).toMatch(/not known/i)
  })

  it('names the real Freya wake phrase and explains the remote fallback', () => {
    const d = dock({
      config: { ...DEFAULT_TEST_VOICE_CONFIG, remoteSttEnabled: true },
      projection: absentVoiceProjection({
        wake: {
          armed: false,
          available: true,
          gate: 'local-energy',
          kind: 'wake-phrase',
          detail: 'wake phrase available',
          maxArmedMs: 60_000,
        },
      }),
    })
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    expect(screen.getByRole('checkbox', { name: /wake on "Freya"/i })).toBeTruthy()
    expect(screen.getByText(/nearby speech clips can leave the device/i)).toBeTruthy()
  })
})