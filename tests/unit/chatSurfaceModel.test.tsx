// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatSurface } from '../../src/ui/surfaces/ChatSurface'
import { resetConversationMirror } from '../../src/platform/conversationClient'
import { resetCoreMirror } from '../../src/platform/coreClient'
import type { ConversationProjection } from '../../core/protocol/conversation'
import type { CoreCommandResult } from '../../core/protocol/core-protocol'

/**
 * Chat, end to end from the window's side.
 *
 * The fake Core here answers exactly the way the real one does over IPC — a
 * command in, an outcome slot out, projections pushed on change — so what this
 * pins down is the *contract*: the composer submits a real
 * `conversation.turn.submit` and renders only what Core pushed back; the
 * selector reads its catalogue from Core and names its choice back to Core;
 * and nothing network-shaped happens until a person asks. The model lane's
 * Core-side behaviour — validation, propagation, failure truth — lives in
 * `tests/core/nanogpt-chat.test.ts`, where the real Gateway and Mind run.
 */

const CATALOG = [
  { id: 'anthropic/claude-sonnet-5', ownedBy: 'anthropic' },
  { id: 'openai/gpt-4.1-nano', ownedBy: 'openai' },
  // Listed, then withdrawn by the provider between the read and the select —
  // the drift case, where Core must refuse the turn to accept the choice.
  { id: 'ghost/model', ownedBy: null },
]

function projection(over: Partial<ConversationProjection> = {}): ConversationProjection {
  return {
    persistence: { mode: 'ephemeral', reason: 'test store' },
    conversations: [
      {
        conversationId: 'c1',
        title: 'Test chat',
        updatedAt: '2026-10-01T09:00:00.000Z',
        messageCount: 0,
        lastTurnOutcome: null,
      },
    ],
    activeConversationId: 'c1',
    messages: [],
    activeTurn: null,
    cognition: { available: true, reason: null },
    stopAll: { active: false, activatedAt: null },
    maxMessageCharacters: 8000,
    faults: [],
    ...over,
  }
}

let current: ConversationProjection = projection()
let pushProjection: ((p: ConversationProjection) => void) | null = null
let coreSubmit: ReturnType<typeof vi.fn>
let turnCount = 0

function setProjection(p: ConversationProjection): void {
  current = p
  pushProjection?.(p)
}

beforeEach(() => {
  turnCount = 0
  pushProjection = null
  current = projection()
  resetCoreMirror()
  resetConversationMirror()
  coreSubmit = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
    const reply = (over: Partial<CoreCommandResult>): CoreCommandResult => ({
      requestId: `req-${command}`,
      ok: true,
      ...over,
    })
    switch (command) {
      case 'conversation.list':
        return reply({ conversation: { operation: 'listed', conversations: current.conversations } })
      case 'conversation.turn.submit': {
        turnCount += 1
        const text = String(payload?.text ?? '')
        const answer = `Freya says back ${text}`
        // The real Core pushes the transcript with both messages once the
        // turn settles; mirror that here so the render path is the shipped one.
        setProjection(
          projection({
            messages: [
              {
                messageId: `u${turnCount}`,
                role: 'user',
                content: text,
                createdAt: '2026-10-01T09:00:01.000Z',
                turnId: `t${turnCount}`,
              },
              {
                messageId: `a${turnCount}`,
                role: 'assistant',
                content: answer,
                createdAt: '2026-10-01T09:00:02.000Z',
                turnId: `t${turnCount}`,
              },
            ],
          }),
        )
        return reply({
          conversation: {
            operation: 'turn',
            turn: {
              turnId: `t${turnCount}`,
              conversationId: 'c1',
              outcome: 'completed',
              reason: null,
              providerId: 'nanogpt',
              model: 'anthropic/claude-sonnet-5',
              providerContacted: true,
              assistantMessage: {
                messageId: `a${turnCount}`,
                role: 'assistant',
                content: answer,
                createdAt: '2026-10-01T09:00:02.000Z',
                turnId: `t${turnCount}`,
              },
            },
          },
        })
      }
      case 'model.catalog.read':
        return reply({
          model: { operation: 'catalog', models: CATALOG, defaultModel: 'openai/gpt-4.1-nano', selected: null },
        })
      case 'model.select': {
        const model = payload?.model
        if (typeof model === 'string' && model === 'ghost/model') {
          return reply({
            ok: false,
            refusal: { reason: 'no configured provider can serve model "ghost/model"' },
            model: { operation: 'refused', reason: 'no configured provider can serve model "ghost/model"' },
          })
        }
        return reply({ model: { operation: 'selected', selected: typeof model === 'string' ? model : null } })
      }
      default:
        return reply({})
    }
  })
  window.freyaHost = {
    isDesktop: true,
    getRuntimeInfo: vi.fn(),
    loadWorkspace: vi.fn(),
    saveWorkspace: vi.fn(),
    onCollect: vi.fn(),
    coreSubmit: coreSubmit as never,
    coreStatus: (async () => undefined) as never,
    onCoreStatus: (() => () => {}) as never,
    coreConversation: (async () => current) as never,
    onCoreConversation: ((handler: (p: ConversationProjection) => void) => {
      pushProjection = handler
      return () => {
        pushProjection = null
      }
    }) as never,
    coreVoice: (async () => null) as never,
  } as never
})

afterEach(() => {
  cleanup()
  delete window.freyaHost
  resetCoreMirror()
  resetConversationMirror()
})

function renderChat(): void {
  render(<ChatSurface />)
}

describe('chat submits through Core and renders Core\'s answer', () => {
  it('a sent message goes out as a turn command, and the reply arrives only as a projection', async () => {
    renderChat()
    const box = await screen.findByLabelText('Message Freya')
    fireEvent.change(box, { target: { value: 'hello freya' } })
    fireEvent.click(screen.getByLabelText('Send'))

    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith('conversation.turn.submit', {
        conversationId: 'c1',
        text: 'hello freya',
      })
    })
    // The transcript shows Core's assistant message. Not a local echo: the
    // content rendered is the one the pushed projection carries.
    expect(await screen.findByText('Freya says back hello freya')).toBeInTheDocument()
    // And the question itself, as stored by Core.
    expect(screen.getByText('hello freya')).toBeInTheDocument()
  })

  it('a turn that did not complete is reported, never smoothed over', async () => {
    coreSubmit.mockImplementation(async (command: string) =>
      command === 'conversation.turn.submit'
        ? ({
            requestId: 'r',
            ok: true,
            conversation: {
              operation: 'turn',
              turn: {
                turnId: 't1',
                conversationId: 'c1',
                outcome: 'failed',
                reason: 'nanogpt responded 500',
                providerId: 'nanogpt',
                model: null,
                providerContacted: true,
                assistantMessage: null,
              },
            },
          })
        : ({ requestId: 'r', ok: true, conversation: { operation: 'listed', conversations: [] } }),
    )
    renderChat()
    const box = await screen.findByLabelText('Message Freya')
    fireEvent.change(box, { target: { value: 'trigger failure' } })
    fireEvent.click(screen.getByLabelText('Send'))
    expect(await screen.findByText(/nanogpt responded 500/)).toBeInTheDocument()
    expect(screen.queryByText(/Freya says back/)).not.toBeInTheDocument()
  })
})

describe('the model selector', () => {
  it('does not touch the model lane until the person asks', async () => {
    renderChat()
    await screen.findByLabelText('Message Freya')
    // Mounted, attached, listed history — and still zero model commands. An
    // open chat window is not a reason to read a network.
    expect(coreSubmit.mock.calls.filter(([c]) => String(c).startsWith('model.'))).toHaveLength(0)
  })

  it('loads the catalogue on demand from Core and lists what Core returned', async () => {
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: /load models/i }))
    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith('model.catalog.read', undefined)
    })
    const select = await screen.findByLabelText('Model')
    await waitFor(() => {
      for (const model of CATALOG) {
        expect(select.querySelector(`option[value="${model.id}"]`)).not.toBeNull()
      }
    })
    // The default option is labelled as the default, not presented as a model.
    expect(select.querySelector('option[value=""]')?.textContent).toMatch(/provider default/i)
  })

  it('a choice is sent to Core, and the value the window shows is the one Core accepted', async () => {
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: /load models/i }))
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement
    await waitFor(() => expect(select.querySelector('option[value="anthropic/claude-sonnet-5"]')).not.toBeNull())
    fireEvent.change(select, { target: { value: 'anthropic/claude-sonnet-5' } })
    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith('model.select', { model: 'anthropic/claude-sonnet-5' })
    })
    expect(select.value).toBe('anthropic/claude-sonnet-5')
    // Selecting a model is not asking for an answer: still zero turns.
    expect(coreSubmit.mock.calls.filter(([c]) => c === 'conversation.turn.submit')).toHaveLength(0)
  })

  it('a refused selection keeps Core\'s words visible and the old value in place', async () => {
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: /load models/i }))
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement
    await waitFor(() => expect(select.querySelector('option[value="ghost/model"]')).not.toBeNull())
    // The catalogue listed `ghost/model`; by the time the choice arrives, Core
    // — the real validator — refuses it. The window reports that sentence and
    // does not pretend the selection took.
    fireEvent.change(select, { target: { value: 'ghost/model' } })
    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith('model.select', { model: 'ghost/model' })
    })
    expect(await screen.findByText(/can serve model "ghost\/model"/)).toBeInTheDocument()
    // The visible selection reverted to what Core holds, because the component
    // never assumed the choice — it asked.
    expect(select.value).toBe('')
  })

  it('the selected model rides the very next turn through Core', async () => {
    renderChat()
    fireEvent.click(await screen.findByRole('button', { name: /load models/i }))
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement
    await waitFor(() => expect(select.querySelector('option[value="anthropic/claude-sonnet-5"]')).not.toBeNull())
    fireEvent.change(select, { target: { value: 'anthropic/claude-sonnet-5' } })
    await waitFor(() =>
      expect(coreSubmit).toHaveBeenCalledWith('model.select', { model: 'anthropic/claude-sonnet-5' }),
    )

    const box = await screen.findByLabelText('Message Freya')
    fireEvent.change(box, { target: { value: 'after selecting' } })
    fireEvent.click(screen.getByLabelText('Send'))
    expect(await screen.findByText('Freya says back after selecting')).toBeInTheDocument()

    // The turn command itself carries only a conversation and text — the
    // selection lives in Core and reaches the provider there. The window's
    // job ends at "ask the next question".
    const turnCall = coreSubmit.mock.calls.find(([c]) => c === 'conversation.turn.submit')
    expect(turnCall?.[1]).not.toHaveProperty('model')
  })
})
