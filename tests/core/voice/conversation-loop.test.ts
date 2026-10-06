// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCore, type Core } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { buildLocalWakeGate } from '../../../core/voice/wake'
import { StandInTts, voiceOptions } from './fixture'
import type { VoiceCommandOutcome } from '../../../core/protocol/conversation'

let dir = ''
let core: Core
let transcript = ''
let tts: StandInTts
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-loop-'))
  tts = new StandInTts()
  core = createCore(voiceOptions(dir, {
    providers: [new FakeModelProvider()], voiceTts: tts, voiceWake: buildLocalWakeGate(),
    voiceStt: {
      id: 'test-stt', kind: 'local', availability: 'available', detail: 'test', streaming: false,
      transcribe: async () => ({ text: transcript, engine: 'test-stt' }),
    },
  }))
  await core.start()
  await core.handleCommand({ command: 'voice.mic.enable', requestId: 'enable' })
  await core.handleCommand({ command: 'voice.permission.report', requestId: 'permission', payload: { outcome: 'granted' } })
  await core.handleCommand({ command: 'voice.wake.arm', requestId: 'arm' })
})
afterEach(async () => { await core?.stop('teardown'); await rm(dir, { recursive: true, force: true }) })

async function say(text: string): Promise<VoiceCommandOutcome | undefined> {
  transcript = text
  const capture = await core.handleCommand({ command: 'voice.capture.start', requestId: 'start' })
  const voice = capture.voice as VoiceCommandOutcome
  if (voice.operation !== 'capture-started') throw new Error(JSON.stringify(capture))
  const result = await core.handleCommand({ command: 'voice.capture.end', requestId: 'end', payload: {
    sessionId: voice.sessionId, audio: new Uint8Array(3200), durationMs: 100,
    format: 'pcm-s16le', codec: 'pcm_s16le', mimeType: 'audio/pcm', sampleRate: 16000, channels: 1,
  } })
  return result.voice as VoiceCommandOutcome
}

describe('hands-free conversation attention', () => {
  it('accepts a trusted local keyword hit without transcription or a Chat turn', async () => {
    expect(await core.detectVoiceWake()).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(tts.spoken.map(s => s.text)).toEqual(['Yes?'])
    expect(core.voice().attention?.active).toBe(true)
    expect((await core.conversation()).messages).toEqual([])
    await say('')
    expect(tts.spoken.map(s => s.text)).toEqual(['Yes?'])
    await core.handleCommand({ command: 'voice.mic.disable', requestId: 'off' })
    expect(await core.detectVoiceWake()).toBe(false)
  })

  it('acknowledges only the wake name without creating a conversation or model call', async () => {
    await say('Freya')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(tts.spoken.map(s => s.text)).toEqual(['Yes?'])
    expect((await core.conversation()).messages).toEqual([])
  })
  it('ignores room speech in standby, strips the name, and continues the same conversation', async () => {
    await say('Someone left the television on')
    expect((await core.conversation()).messages).toEqual([])
    await say('Freya, hello there')
    const first = await core.conversation()
    expect(first.messages.find(m => m.role === 'user')?.content).toBe('hello there')
    await say('What were we talking about?')
    const second = await core.conversation()
    expect(second.activeConversationId).toBe(first.activeConversationId)
    expect(second.messages.filter(m => m.role === 'user')).toHaveLength(2)
    expect(tts.spoken.length).toBeGreaterThanOrEqual(1)
  })
  it('returns to standby on that is all and discards further room speech', async () => {
    await say('Freya')
    await say("That's all.")
    await say('We should order dinner')
    expect((await core.conversation()).messages).toEqual([])
    expect(core.voice().attention?.active).toBe(false)
  })
})
