// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_VOICE_CONFIG,
  VoiceConfigStore,
  sttRuntimeConfig,
} from '../../electron/voiceConfig'

let dir = ''
let path = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-voice-config-'))
  path = join(dir, 'voice.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('VoiceConfigStore', () => {
  it('defaults to a separate NanoGPT voice configuration without enabling remote audio', async () => {
    const store = new VoiceConfigStore(path)
    const value = await store.read()

    expect(value).toEqual(DEFAULT_VOICE_CONFIG)
    expect(value.sttProvider).toBe('nanogpt')
    expect(value.sttModel).toBe('Whisper-Large-V3')
    expect(value.remoteSttEnabled).toBe(false)
    expect(value.ttsProvider).toBe('platform')
    expect(value.wakeProvider).toBe('off')
    expect(value.proactiveAlerts).toBe(false)
  })

  it('persists only voice preferences and never a NanoGPT credential', async () => {
    const store = new VoiceConfigStore(path)
    const saved = await store.write({
      sttProvider: 'nanogpt',
      sttModel: 'Whisper-Large-V3',
      remoteSttEnabled: true,
      wakeProvider: 'selected-stt',
      ttsProvider: 'platform',
      ttsVoiceId: 'voice-one',
      autoSpeak: true,
      proactiveAlerts: true,
    })

    expect(saved.remoteSttEnabled).toBe(true)
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toMatch(/api.?key/i)
    expect(raw).not.toMatch(/credential/i)
    expect(JSON.parse(raw).sttModel).toBe('Whisper-Large-V3')
  })

  it('translates the stored Voice choice into the narrow STT runtime config', async () => {
    const store = new VoiceConfigStore(path)
    const saved = await store.write({
      sttProvider: 'nanogpt',
      sttModel: 'Whisper-Large-V3',
      remoteSttEnabled: true,
    })
    expect(sttRuntimeConfig(saved)).toEqual({
      provider: 'nanogpt',
      model: 'Whisper-Large-V3',
      remoteEnabled: true,
    })
  })

  it('falls back safely when the file is malformed', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{ definitely not json', 'utf8')
    const store = new VoiceConfigStore(path)
    expect(await store.read()).toEqual(DEFAULT_VOICE_CONFIG)
  })
})
