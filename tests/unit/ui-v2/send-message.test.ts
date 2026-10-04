import { describe, expect, it, vi } from 'vitest'
import { sendMessage, type ConversationSender } from '../../../src/ui-v2/chat/sendMessage'
import type { ConversationCommandOutcome } from '../../../core/protocol/conversation'

const created: ConversationCommandOutcome = {
  operation: 'created',
  conversation: { conversationId: 'c1', title: 'New conversation', updatedAt: 't', messageCount: 0, lastTurnOutcome: null },
}

const completedTurn: ConversationCommandOutcome = {
  operation: 'turn',
  turn: { turnId: 'r1', conversationId: 'c1', outcome: 'completed', reason: null, providerId: 'nanogpt', model: 'm', providerContacted: true, assistantMessage: null },
}

function sender(overrides: Partial<{ create: ConversationCommandOutcome; submit: ConversationCommandOutcome }> = {}): {
  mirror: ConversationSender
  create: ReturnType<typeof vi.fn>
  submit: ReturnType<typeof vi.fn>
} {
  const create = vi.fn(async () => overrides.create ?? created)
  const submit = vi.fn(async () => overrides.submit ?? completedTurn)
  return { mirror: { create, submitTurn: submit }, create, submit }
}

describe('sendMessage', () => {
  it('sends nothing for an empty draft and touches Core not at all', async () => {
    const { mirror, create, submit } = sender()
    const result = await sendMessage(mirror, null, '   ')
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('')
    expect(create).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('creates a conversation when there is none, then submits the trimmed text', async () => {
    const { mirror, create, submit } = sender()
    const result = await sendMessage(mirror, null, '  hello Freya  ')
    expect(create).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('c1', 'hello Freya')
    expect(result.ok).toBe(true)
    expect(result.conversationId).toBe('c1')
  })

  it('reuses an existing conversation and never creates a second one', async () => {
    const { mirror, create, submit } = sender()
    const result = await sendMessage(mirror, 'existing', 'again')
    expect(create).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledWith('existing', 'again')
    expect(result.ok).toBe(true)
    expect(result.conversationId).toBe('existing')
  })

  it('reports a refusal when no conversation could be created', async () => {
    const { mirror, submit } = sender({ create: { operation: 'refused', reason: 'Core is stopped' } })
    const result = await sendMessage(mirror, null, 'hello')
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('Core is stopped')
    expect(submit).not.toHaveBeenCalled()
  })

  it('surfaces the turn reason when a turn does not complete', async () => {
    const { mirror } = sender({
      submit: {
        operation: 'turn',
        turn: { turnId: 'r1', conversationId: 'c1', outcome: 'denied', reason: 'No cognition provider is configured.', providerId: null, model: null, providerContacted: false, assistantMessage: null },
      },
    })
    const result = await sendMessage(mirror, 'c1', 'hello')
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('No cognition provider is configured.')
  })

  it('surfaces a refused submit', async () => {
    const { mirror } = sender({ submit: { operation: 'refused', reason: 'the message was too long' } })
    const result = await sendMessage(mirror, 'c1', 'hello')
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('the message was too long')
  })
})
