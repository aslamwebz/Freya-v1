import { describe, expect, it } from 'vitest'
import {
  VoiceAttentionSession,
  interpretVoiceAddress,
} from '../../../core/voice/attention'

describe('voice conversational attention', () => {
  it('ignores unrelated room speech while Freya is in standby', () => {
    expect(interpretVoiceAddress('turn the television down', false)).toEqual({ kind: 'ignore' })
    expect(interpretVoiceAddress('I told Freya about that yesterday', false)).toEqual({ kind: 'ignore' })
  })

  it('recognises Freya only as an address at the beginning of an utterance', () => {
    expect(interpretVoiceAddress('Freya', false)).toEqual({ kind: 'wake-only' })
    expect(interpretVoiceAddress('hey Freya', false)).toEqual({ kind: 'wake-only' })
    expect(interpretVoiceAddress('Freya, check the build', false)).toEqual({
      kind: 'command',
      text: 'check the build',
    })
    expect(interpretVoiceAddress('Hey Freya — search the web', false)).toEqual({
      kind: 'command',
      text: 'search the web',
    })
  })

  it('accepts natural follow-ups only while attention is open', () => {
    expect(interpretVoiceAddress('what about tomorrow?', true)).toEqual({
      kind: 'command',
      text: 'what about tomorrow?',
    })
    expect(interpretVoiceAddress('what about tomorrow?', false)).toEqual({ kind: 'ignore' })
  })

  it('recognises explicit standby phrases without sending them to Mind', () => {
    for (const phrase of ['stand by', "that's all", 'stop listening', 'thank you Freya']) {
      expect(interpretVoiceAddress(phrase, true)).toEqual({ kind: 'standby' })
    }
    expect(interpretVoiceAddress('Freya, stand by', false)).toEqual({ kind: 'standby' })
  })

  it('keeps a bounded follow-up window and expires back to standby', () => {
    let now = new Date('2026-10-06T12:00:00.000Z')
    const session = new VoiceAttentionSession(45_000, () => now)

    expect(session.state).toBe('standby')
    session.activate()
    expect(session.state).toBe('attentive')
    expect(session.attentiveUntil).toBe('2026-10-06T12:00:45.000Z')

    now = new Date('2026-10-06T12:00:30.000Z')
    session.touch()
    expect(session.attentiveUntil).toBe('2026-10-06T12:01:15.000Z')

    now = new Date('2026-10-06T12:01:16.000Z')
    expect(session.state).toBe('standby')
    expect(session.attentiveUntil).toBeNull()
  })

  it('returns to standby immediately when told', () => {
    const session = new VoiceAttentionSession()
    session.activate()
    expect(session.state).toBe('attentive')
    session.standby()
    expect(session.state).toBe('standby')
  })
})
