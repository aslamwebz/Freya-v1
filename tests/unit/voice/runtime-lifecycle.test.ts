import { describe, expect, it, vi } from 'vitest'
import { VoiceRuntime } from '../../../src/voice/runtime'
import { absentVoiceProjection } from '../../core/voice/fixture'
import type { VoiceMirror } from '../../../src/platform/voiceClient'
import { openMicrophone, type MicCapture } from '../../../src/ui/surfaces/microphone'
vi.mock('../../../src/ui/surfaces/microphone', () => ({ openMicrophone: vi.fn(), MicrophoneError: class extends Error {} }))

it('closes a device that finishes opening after the owner releases the button', async () => {
  let open!: (value: MicCapture) => void
  vi.mocked(openMicrophone).mockImplementation(() => new Promise(resolve => { open = resolve }))
  const projection = absentVoiceProjection({ micEnabled: true, permission: 'granted' })
  const mirror = { projection, micEnable: async () => ({ ok: true }), interruptSpeaking: async () => {}, startCapture: async () => ({ ok: true, sessionId: 's' }), cancelCapture: vi.fn(async () => {}), subscribe: () => () => {} } as unknown as VoiceMirror
  const runtime = new VoiceRuntime(mirror)
  vi.spyOn(runtime, 'capabilities').mockReturnValue({ capture: true, recognition: { available: false, detail: 'test' } } as ReturnType<VoiceRuntime['capabilities']>)
  const press = runtime.press()
  await vi.waitFor(() => expect(open).toBeTypeOf('function'))
  await runtime.release(true)
  const capture = { stop: vi.fn(async () => ({ audio: new Uint8Array(), durationMs: 0 })), abandon: vi.fn(async () => {}) }
  open(capture)
  await press
  expect(capture.abandon).toHaveBeenCalledOnce()
  expect(runtime.listening).toBe(false)
})

describe('runtime lifetime', () => {
  it('refuses to reopen a disposed runtime', async () => {
    const mirror = { projection: null } as unknown as VoiceMirror
    const runtime = new VoiceRuntime(mirror)
    await runtime.dispose()
    const enable = vi.fn()
    mirror.micEnable = enable
    await runtime.press()
    expect(enable).not.toHaveBeenCalled()
  })
})



it('cancels a pending recognizer and suppresses its late transcript on disposal', async () => {
  let finish!: (value: { ok: boolean; text: string; turnId: string; reason: string }) => void
  vi.mocked(openMicrophone).mockResolvedValue({ stop: async () => ({ audio: new Uint8Array(3200), durationMs: 100 }), abandon: async () => {} })
  const mirror = { projection: absentVoiceProjection({ micEnabled: true, permission: 'granted' }), micEnable: async () => ({ ok: true }), interruptSpeaking: async () => {}, startCapture: async () => ({ ok: true, sessionId: 's' }), cancelCapture: vi.fn(async () => {}), endCapture: () => new Promise(resolve => { finish = resolve }) } as unknown as VoiceMirror
  const transcript = vi.fn()
  const runtime = new VoiceRuntime(mirror, { onTranscript: transcript })
  vi.spyOn(runtime, 'capabilities').mockReturnValue({ capture: true, recognition: { available: false, detail: 'test' } } as ReturnType<VoiceRuntime['capabilities']>)
  await runtime.press()
  const release = runtime.release()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await runtime.dispose()
  expect(mirror.cancelCapture).toHaveBeenCalledOnce()
  finish({ ok: true, text: 'late words', turnId: 'turn', reason: 'completed' })
  await release
  expect(transcript).not.toHaveBeenCalled()
})

it('ignores standby activity for interruption, interrupts active attention, and expires hands-free', async () => {
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const projection = absentVoiceProjection({ micEnabled: true, permission: 'granted', attention: { active: false, state: 'standby', wakePhrase: 'Freya', attentiveUntil: null, followUpWindowMs: 45_000 } })
  projection.transcription.available = true
  projection.wake.armed = true
  projection.wake.maxArmedMs = 900_000
  const mirror = { projection, micEnable: async () => ({ ok: true }), armWake: async () => ({ ok: true }), refresh: async () => {}, disarmWake: vi.fn(async () => {}), interruptSpeaking: vi.fn(async () => {}), startCapture: async () => ({ ok: true, sessionId: 's' }), cancelCapture: vi.fn(async () => {}) } as unknown as VoiceMirror
  const runtime = new VoiceRuntime(mirror)
  vi.spyOn(runtime, 'capabilities').mockReturnValue({ capture: true, recognition: { available: false, detail: 'test' } } as ReturnType<VoiceRuntime['capabilities']>)
  const abandon = vi.fn(async () => {})
  vi.mocked(openMicrophone).mockResolvedValue({ stop: async () => ({ audio: new Uint8Array(), durationMs: 0 }), abandon })
  await runtime.armWake()
  const options = vi.mocked(openMicrophone).mock.calls.at(-1)![0]
  options.onSpeechStart?.()
  expect(mirror.interruptSpeaking).not.toHaveBeenCalled()
  projection.attention = { active: true, state: 'attentive', wakePhrase: 'Freya', attentiveUntil: new Date(Date.now() + 45_000).toISOString(), followUpWindowMs: 45_000 }
  options.onSpeechStart?.()
  expect(mirror.interruptSpeaking).toHaveBeenCalledOnce()
  now = projection.wake.maxArmedMs + 1
  await (runtime as unknown as { pump(): Promise<void> }).pump()
  expect(mirror.disarmWake).toHaveBeenCalledOnce()
  expect(runtime.listening).toBe(false)
  await runtime.dispose()
  clock.mockRestore()
})


it('refreshes confirmed standby without starting a transcription capture, then promotes after wake', async () => {
  const projection = absentVoiceProjection({ micEnabled: true, permission: 'granted' })
  projection.transcription.available = true
  projection.wake.maxArmedMs = 900_000
  const start = vi.fn(async () => ({ ok: true, sessionId: 's' }))
  const mirror = { projection, micEnable: async () => ({ ok: true }), armWake: async () => ({ ok: true }), refresh: vi.fn(async () => { projection.wake.armed = true }), startCapture: start, cancelCapture: async () => {} } as unknown as VoiceMirror
  vi.mocked(openMicrophone).mockResolvedValue({ stop: async () => ({ audio: new Uint8Array(), durationMs: 0 }), abandon: async () => {} })
  const runtime = new VoiceRuntime(mirror)
  vi.spyOn(runtime, 'capabilities').mockReturnValue({ capture: true, recognition: { available: false, detail: 'test' } } as ReturnType<VoiceRuntime['capabilities']>)
  await runtime.armWake()
  expect(start).not.toHaveBeenCalled()
  expect(vi.mocked(openMicrophone).mock.calls.at(-1)![0].standby).toBe(true)
  projection.attention = { active: true, state: 'attentive', wakePhrase: 'Freya', attentiveUntil: new Date(Date.now() + 45_000).toISOString(), followUpWindowMs: 45_000 }
  await (runtime as unknown as { pump(): Promise<void> }).pump()
  expect(start).toHaveBeenCalledOnce()
  await runtime.dispose()
})

