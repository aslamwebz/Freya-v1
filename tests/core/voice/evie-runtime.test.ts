// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { buildLocalWakeGate } from '../../../core/voice/wake'
import type { SttRequest, VoiceSttAdapter } from '../../../core/voice/types'
import type { VoiceCommandOutcome } from '../../../core/protocol/conversation'
import { StandInTts, voiceOptions } from './fixture'

class MutableStt implements VoiceSttAdapter {
  readonly id = 'mutable-stt'
  readonly kind = 'local' as const
  readonly availability = 'available' as const
  readonly detail = 'Deterministic speech for E.V.-style voice integration tests.'
  readonly streaming = false
  calls = 0

  constructor(public text: string) {}

  async transcribe(request: SttRequest): Promise<{ text: string; engine: string }> {
    this.calls += 1
    if (request.signal.aborted) throw request.signal.reason ?? new Error('cancelled')
    return { text: this.text, engine: this.id }
  }
}

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-ev-voice-'))
})

afterEach(async () => {
  await core?.stop('E.V. voice test teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

async function start(
  stt: MutableStt,
  overrides: Partial<CoreOptions> = {},
): Promise<{ core: Core; provider: FakeModelProvider; tts: StandInTts }> {
  const provider = new FakeModelProvider()
  const tts = new StandInTts()
  const instance = createCore(
    voiceOptions(dir, {
      providers: [provider],
      voiceStt: stt,
      voiceTts: tts,
      voiceWake: buildLocalWakeGate(),
      ...overrides,
    }),
  )
  core = instance
  await instance.start()
  await instance.handleCommand({ command: 'voice.mic.enable', requestId: 'mic' })
  await instance.handleCommand({
    command: 'voice.permission.report',
    requestId: 'permission',
    payload: { outcome: 'granted' },
  })
  const armed = await instance.handleCommand({ command: 'voice.wake.arm', requestId: 'arm' })
  expect(armed.ok).toBe(true)
  return { core: instance, provider, tts }
}

async function beginWake(instance: Core): Promise<string> {
  const fired = await instance.handleCommand({
    command: 'voice.wake.energy',
    requestId: `wake-${Date.now()}`,
    payload: { level: 0.99, sustainedMs: 1_000 },
  })
  expect(fired.ok).toBe(true)
  const sessionId = instance.voice().sessionId
  expect(sessionId).not.toBeNull()
  return sessionId!
}

async function finishWake(instance: Core, sessionId: string): Promise<VoiceCommandOutcome> {
  const frames = 480
  const result = await instance.handleCommand({
    command: 'voice.capture.end',
    requestId: `end-${Date.now()}`,
    payload: {
      sessionId,
      bytes: new Uint8Array(frames * 2),
      durationMs: 30,
      cancelled: false,
      format: 'pcm-s16le',
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
      sampleRate: 16_000,
      channels: 1,
    },
  })
  return result.voice as VoiceCommandOutcome
}

async function speakWake(instance: Core): Promise<VoiceCommandOutcome> {
  return finishWake(instance, await beginWake(instance))
}

describe('E.V.-style Freya voice attention', () => {
  it('hears "Freya", acknowledges locally, and opens a bounded attentive window without calling the LLM', async () => {
    const stt = new MutableStt('Freya')
    const { core: c, provider, tts } = await start(stt)

    const result = await speakWake(c)

    expect(result.operation).toBe('capture-ended')
    expect(c.voice().attention.state).toBe('attentive')
    expect(c.voice().attention.wakePhrase).toBe('Freya')
    expect(c.voice().attention.attentiveUntil).not.toBeNull()
    expect(provider.calls).toBe(0)
    expect(tts.spoken.map((entry) => entry.text)).toContain('Yes?')
    expect((await c.conversation()).messages).toEqual([])
  })

  it('strips the wake phrase and sends exactly one ordinary Conversation/Mind turn', async () => {
    const stt = new MutableStt('Freya, explain dependency injection')
    const { core: c, provider } = await start(stt)

    const result = await speakWake(c)
    expect(result.operation).toBe('capture-ended')
    if (result.operation !== 'capture-ended') return

    expect(result.turnId).not.toBeNull()
    expect(provider.calls).toBe(1)
    const projection = await c.conversation()
    const user = projection.messages.filter((message) => message.role === 'user')
    expect(user).toHaveLength(1)
    expect(user[0]?.content).toBe('explain dependency injection')
    expect(user[0]?.content).not.toMatch(/^Freya\b/i)
    expect(c.voice().attention.state).toBe('attentive')
  })

  it('accepts a natural follow-up without repeating Freya while the attention window is open', async () => {
    const stt = new MutableStt('Freya, check the build')
    const { core: c, provider } = await start(stt)

    await speakWake(c)
    stt.text = 'what failed?'
    await speakWake(c)

    expect(provider.calls).toBe(2)
    const projection = await c.conversation()
    expect(
      projection.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['check the build', 'what failed?'])
    expect(c.voice().attention.state).toBe('attentive')
  })

  it('does not turn unrelated room speech into a conversation turn while in standby', async () => {
    const stt = new MutableStt('I told Freya about that yesterday')
    const { core: c, provider } = await start(stt)

    const result = await speakWake(c)
    expect(result.operation).toBe('capture-ended')
    if (result.operation !== 'capture-ended') return

    expect(result.turnId).toBeNull()
    expect(result.text).toBeNull()
    expect(provider.calls).toBe(0)
    expect(c.voice().attention.state).toBe('standby')
    expect((await c.conversation()).messages).toEqual([])
  })

  it('returns to standby on a natural stop phrase without sending the phrase to Mind', async () => {
    const stt = new MutableStt('Freya')
    const { core: c, provider, tts } = await start(stt)

    await speakWake(c)
    expect(c.voice().attention.state).toBe('attentive')

    stt.text = 'stand by'
    await speakWake(c)

    expect(c.voice().attention.state).toBe('standby')
    expect(provider.calls).toBe(0)
    expect(tts.spoken.map((entry) => entry.text)).toEqual(expect.arrayContaining(['Yes?', 'Okay.']))
    expect((await c.conversation()).messages).toEqual([])
  })

  it('journals wake completion metadata but never the wake words or room speech', async () => {
    const sentinel = 'Freya private-room-sentinel'
    const stt = new MutableStt(sentinel)
    const { core: c } = await start(stt)

    await speakWake(c)
    await c.stop('inspect journal')
    core = null

    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).toContain('voice.transcribe.completed')
    expect(raw).toContain('voice.capture.completed')
    expect(raw).not.toContain(sentinel)
    expect(raw).not.toMatch(/"audio"/)
    expect(raw).not.toMatch(/"bytes":\[/)
  })
})

describe('E.V.-style proactive speech is subordinate to Attention', () => {
  it('speaks a closed Core phrase only when Attention itself chooses speak/interrupt', async () => {
    const stt = new MutableStt('unused')
    const now = new Date('2026-10-06T12:00:00.000Z')
    const { core: c, tts, provider } = await start(stt, {
      now: () => now,
      voiceProactiveAlerts: true,
    })

    const result = await c.handleCommand({
      command: 'attention.event.ingest',
      requestId: 'deadline',
      payload: {
        kind: 'deadline',
        text: 'SECRET EVENT WORDS THAT MUST NOT BE SPOKEN',
        dueAt: now.toISOString(),
      },
    })

    expect(result.ok).toBe(true)
    expect(['speak', 'interrupt']).toContain(result.attention?.decision?.outcome)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(tts.spoken.length).toBeGreaterThan(0)
    const spoken = tts.spoken.map((entry) => entry.text).join(' ')
    expect(spoken).not.toContain('SECRET EVENT WORDS')
    expect(spoken).toMatch(/deadline|attention|due/i)
    expect(provider.calls).toBe(0)
  })

  it('stays silent for the same Attention event when proactive voice is disabled', async () => {
    const stt = new MutableStt('unused')
    const now = new Date('2026-10-06T12:00:00.000Z')
    const { core: c, tts } = await start(stt, {
      now: () => now,
      voiceProactiveAlerts: false,
    })

    const result = await c.handleCommand({
      command: 'attention.event.ingest',
      requestId: 'deadline-muted',
      payload: {
        kind: 'deadline',
        text: 'private deadline text',
        dueAt: now.toISOString(),
      },
    })
    expect(result.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tts.spoken).toHaveLength(0)
  })
})
