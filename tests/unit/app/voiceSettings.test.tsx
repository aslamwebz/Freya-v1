import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceSettings, describeVoiceState } from '../../../src/app/voice/VoiceSettings'
import type { VoiceDock, VoiceView } from '../../../src/app/voice/useVoiceDock'
import { absentVoiceProjection } from '../../core/voice/fixture'

/**
 * The voice settings row.
 *
 * The properties worth pinning are all about *truthfulness of the control*, since
 * a switch that renders the wrong state is worse than no switch: a person who has
 * been told "send what I say" is on has made a different decision from one who has
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
    speak: () => pressed.push('speak'),
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
    expect(screen.getByText(/Freya cannot listen until you turn this on/i)).toBeTruthy()
  })

  it('says it is on, and says that only a press opens the device', () => {
    const d = dock({ micEnabled: true })
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /microphone/i }) as HTMLInputElement
    expect(row.checked).toBe(true)
    expect(screen.getByText(/only listens between a press and its release/i)).toBeTruthy()
  })
})

describe('the send-what-I-say switch', () => {
  it('defaults to off and says what off means', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /send what I say/i }) as HTMLInputElement
    expect(row.checked).toBe(false)
    expect(screen.getByText(/waits in the composer until you send it/i)).toBeTruthy()
  })

  it('when on, says it enters the same conversation path as typing', () => {
    const d = dock({ autoSubmit: true })
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /send what I say/i }) as HTMLInputElement
    expect(row.checked).toBe(true)
    expect(screen.getByText(/same conversation path as typing/i)).toBeTruthy()
  })
})

describe('hands-free', () => {
  it('is disabled and says why on a build with no local gate', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    const row = screen.getByRole('checkbox', { name: /hands-free/i }) as HTMLInputElement
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
    const row = screen.getByRole('checkbox', { name: /freya speaks/i }) as HTMLInputElement
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

describe('the state sentence', () => {
  it('names each state a person could be in', () => {
    expect(describeVoiceState('unsupported')).toMatch(/no microphone capture/i)
    expect(describeVoiceState('permission-required')).toMatch(/no permission has been asked/i)
    expect(describeVoiceState('permission-denied')).toMatch(/was denied/i)
    expect(describeVoiceState('ready')).toMatch(/nothing is being recorded/i)
    expect(describeVoiceState('listening')).toMatch(/recording locally/i)
    expect(describeVoiceState('transcribing')).toMatch(/reading the recording/i)
    expect(describeVoiceState('submitting')).toMatch(/sending what you said/i)
    expect(describeVoiceState('speaking')).toMatch(/^speaking/i)
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

  it('never calls the wake gate a wake word', () => {
    const d = dock()
    render(<VoiceSettings voice={d} />)
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    expect(screen.queryByText(/wake word/i)).toBeNull()
  })
})