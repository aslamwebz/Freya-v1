// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_SETTINGS } from '../../core/voice/settings'
import { effectiveVoiceSettings, voiceCapabilityReadiness, gateVoiceInput, gateVoiceOutput } from '../../electron/voiceCapabilities'
import { DeterministicSttAdapter } from '../../core/voice/stt'
import { DeterministicTtsAdapter } from '../../core/voice/tts'

describe('voice capability dispatch', () => {
  const readiness = voiceCapabilityReadiness({ platformAvailable: true, localInstalled: true, nanoKeyPresent: true, remoteAudioEnabled: true })
  it('selects available actual adapters in saved order, preserving consent and model preferences', () => {
    const settings = { ...DEFAULT_VOICE_SETTINGS, remoteAudioEnabled: true, inputModel: 'chosen-model' }
    const result = effectiveVoiceSettings(settings, { stt: ['minimax', 'local', 'nanogpt'], tts: ['minimax', 'native'] }, readiness)
    expect(result.settings.inputProvider).toBe('local-whisper')
    expect(result.settings.outputProvider).toBe('platform')
    expect(result.settings.inputModel).toBe('chosen-model')
    expect(result.settings.remoteAudioEnabled).toBe(true)
    expect(result.inputProvider).toBe('local')
    expect(result.outputProvider).toBe('native')
  })
  it('never enables remote audio consent from a capability selection', () => {
    const result = effectiveVoiceSettings(DEFAULT_VOICE_SETTINGS, { stt: ['nanogpt'] }, readiness)
    expect(result.inputProvider).toBeNull()
    expect(result.settings.remoteAudioEnabled).toBe(false)
  })
  it('refuses unsupported-only selections rather than calling the existing adapters', async () => {
    const selected = () => effectiveVoiceSettings(DEFAULT_VOICE_SETTINGS, { stt: ['minimax'], tts: ['nanogpt'] }, readiness)
    const input = new DeterministicSttAdapter('text')
    const output = new DeterministicTtsAdapter()
    const transcribe = vi.spyOn(input, 'transcribe')
    const speak = vi.spyOn(output, 'speak')
    const guardedInput = gateVoiceInput(input, selected)
    const guardedOutput = gateVoiceOutput(output, selected)
    expect(guardedInput.availability).toBe('configuration-required')
    expect(guardedOutput.availability).toBe('configuration-required')
    await expect(guardedInput.transcribe({} as never)).rejects.toThrow('speech recognition')
    await expect(guardedOutput.speak({} as never)).rejects.toThrow('speech output')
    expect(transcribe).not.toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
  })
  it('describes readiness per speech capability without deriving TTS support from the NanoGPT key', () => {
    expect(readiness.stt?.nanogpt?.ready).toBe(true)
    expect(readiness.stt?.local?.ready).toBe(true)
    expect(readiness.tts?.native?.ready).toBe(true)
    expect(readiness.tts?.nanogpt?.ready).toBe(false)
    expect(readiness.tts?.minimax?.ready).toBe(false)
  })
})
