import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveTurnTracker } from '../../../src/app/chat/ActiveTurnTracker'
import type { ActiveTurnView } from '../../../core/protocol/conversation'
import type { CoreActivityEvent } from '../../../core/protocol/activity'

// Mock coreClient
const mockActivity: CoreActivityEvent[] = []
let activitySubscriber: ((events: readonly CoreActivityEvent[]) => void) | null = null

vi.mock('../../../src/platform/coreClient', () => ({
  ensureActivityAttached: vi.fn(async () => {}),
  coreMirror: () => ({
    get activity() {
      return mockActivity
    },
    subscribeActivity: (listener: (events: readonly CoreActivityEvent[]) => void) => {
      activitySubscriber = listener
      return () => {
        if (activitySubscriber === listener) activitySubscriber = null
      }
    },
  }),
}))

describe('ActiveTurnTracker', () => {
  beforeEach(() => {
    mockActivity.length = 0
    activitySubscriber = null
  })

  afterEach(cleanup)

  it('renders thinking and planning status when turn is compiling or planning', () => {
    const activeTurn: ActiveTurnView = {
      turnId: 'turn-123',
      conversationId: 'conv-123',
      startedAt: new Date(Date.now() - 3000).toISOString(),
      providerExecuting: false,
    }

    render(<ActiveTurnTracker activeTurn={activeTurn} />)

    expect(screen.getByTestId('active-turn-tracker')).toBeInTheDocument()
    expect(screen.getByText('Thinking & planning')).toBeInTheDocument()
    expect(screen.getByText(/· \d+s/)).toBeInTheDocument()
  })

  it('renders generating response when provider is executing', () => {
    const activeTurn: ActiveTurnView = {
      turnId: 'turn-456',
      conversationId: 'conv-456',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      providerExecuting: true,
    }

    render(<ActiveTurnTracker activeTurn={activeTurn} />)

    expect(screen.getByText('Generating response')).toBeInTheDocument()
  })

  it('offers a stop button that invokes onStopResponse', () => {
    const onStop = vi.fn()
    const activeTurn: ActiveTurnView = {
      turnId: 'turn-789',
      conversationId: 'conv-789',
      startedAt: new Date().toISOString(),
      providerExecuting: true,
    }

    render(<ActiveTurnTracker activeTurn={activeTurn} onStopResponse={onStop} />)

    const stopBtn = screen.getByRole('button', { name: 'Stop response' })
    expect(stopBtn).toBeInTheDocument()
    fireEvent.click(stopBtn)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('displays approval request card when an operation requires Core Guard authorization', () => {
    const activeTurn: ActiveTurnView = {
      turnId: 'turn-approval',
      conversationId: 'conv-approval',
      startedAt: new Date(Date.now() - 4000).toISOString(),
      providerExecuting: false,
    }

    mockActivity.push({
      id: 'work.approval.requested:1',
      kind: 'work.approval.requested',
      type: 'work.approval.requested',
      sequence: 1,
      at: Date.now() - 1000,
      text: 'Run stopped for approval: capability "fs.write" requires owner permission',
      tone: 'warn',
    })

    render(<ActiveTurnTracker activeTurn={activeTurn} />)

    expect(screen.getByRole('alert', { name: 'Approval required' })).toBeInTheDocument()
    expect(screen.getByText('Approval Required by Core Guard')).toBeInTheDocument()
    expect(screen.getAllByText(/capability "fs.write" requires owner permission/).length).toBeGreaterThanOrEqual(1)
  })
})
