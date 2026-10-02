// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AttentionSurface } from '../../src/ui/surfaces/AttentionSurface'
import { resetAttentionMirror } from '../../src/platform/attentionClient'
import {
  ABSENT_ATTENTION_PROJECTION,
  NO_ATTENTION_DOMAIN_REASON,
  type AttentionProjection,
} from '../../core/protocol/attention'
import { initialAttentionState, projectAttention } from '../../core/attention'

/**
 * The Attention view.
 *
 *   - It submits only the two owner actions Core permits, and never a source.
 *   - The event text does not appear from a projection — only its length — and
 *     the one way to see it is the explicit per-event read.
 *   - "No Attention domain" is not drawn as "nothing needs attention".
 */

let coreSubmit: ReturnType<typeof vi.fn>
let coreAttention: ReturnType<typeof vi.fn>
let current: AttentionProjection | null

function ready(over: Partial<AttentionProjection> = {}): AttentionProjection {
  const base = projectAttention({
    sequence: 5,
    state: {
      ...initialAttentionState(),
      counts: {
        ingested: 4,
        decisions: 4,
        doNothing: 1,
        remembered: 1,
        cued: 1,
        spoke: 1,
        interrupted: 0,
        budgetExceeded: 0,
      },
    },
    focus: 'available',
    directive: {
      eventId: 'e3',
      source: 'owner',
      kind: 'deadline',
      outcome: 'speak',
      cueCode: 'deadline-soon',
      importance: 'high',
      urgency: 'elevated',
      decidedAt: '2026-10-02T09:00:00.000Z',
    },
    inbox: [
      {
        event: {
          eventId: 'e1',
          source: 'owner',
          kind: 'reminder',
          goalRef: null,
          sourceRef: null,
          text: 'FREYA_RED_TEAM_SECRET_7A91',
          severityHint: 'none',
          occurredAt: '2026-10-02T09:00:00.000Z',
          observedAt: '2026-10-02T09:00:00.000Z',
          dueAt: null,
        },
        outcome: 'remember',
      },
    ],
  })
  return { ...base, ...over }
}

beforeEach(() => {
  resetAttentionMirror()
  current = ready()
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    attention: { operation: 'ingested', ok: true },
  }))
  coreAttention = vi.fn(async () => current)
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreAttention: coreAttention as never,
    onCoreAttention: (() => () => {}) as never,
  } as never
})

afterEach(() => {
  cleanup()
  resetAttentionMirror()
  delete window.freyaHost
})

describe('the Attention view renders Core’s truth', () => {
  it('shows counts, focus and the directive Core decided', async () => {
    render(<AttentionSurface />)
    await waitFor(() => expect(screen.getByText(/ATTENTION/)).toBeInTheDocument())
    expect(screen.getByText(/4 decisions/)).toBeInTheDocument()
    expect(screen.getByText(/Focus: available/)).toBeInTheDocument()
    expect(screen.getByText(/speak: deadline-soon/)).toBeInTheDocument()
  })

  it('never draws the event text from the projection', async () => {
    render(<AttentionSurface />)
    await waitFor(() => expect(screen.getByText(/ATTENTION/)).toBeInTheDocument())
    expect(screen.queryByText(/FREYA_RED_TEAM_SECRET_7A91/)).toBeNull()
    expect(screen.getByText(/characters/)).toBeInTheDocument()
  })

  it('reads one retained event back only when asked', async () => {
    coreSubmit.mockImplementation(async (command: string) => {
      if (command === 'attention.inbox.read') {
        return {
          requestId: 'r1',
          ok: true,
          attention: {
            operation: 'detail',
            ok: true,
            detail: {
              eventId: 'e1',
              source: 'owner',
              kind: 'reminder',
              goalRef: null,
              text: 'FREYA_RED_TEAM_SECRET_7A91',
              severityHint: 'none',
              observedAt: '2026-10-02T09:00:00.000Z',
              dueAt: null,
              outcome: 'remember',
            },
          },
        }
      }
      return { requestId: 'r1', ok: true, attention: { operation: 'ingested', ok: true } }
    })
    render(<AttentionSurface />)
    await waitFor(() => expect(screen.getByText(/ATTENTION/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(screen.getByText(/FREYA_RED_TEAM_SECRET_7A91/)).toBeInTheDocument())
    expect(coreSubmit).toHaveBeenCalledWith('attention.inbox.read', { eventId: 'e1' })
  })

  it('submits an event without a source field', async () => {
    render(<AttentionSurface />)
    await waitFor(() => expect(screen.getByText(/ATTENTION/)).toBeInTheDocument())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Core' }))
    await waitFor(() => expect(coreSubmit).toHaveBeenCalled())
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('attention.event.ingest')
    expect(payload).toMatchObject({ kind: 'reminder', text: 'a note' })
    expect('source' in payload).toBe(false)
  })

  it('draws "no Attention domain" as a domain absence, not as calm', async () => {
    current = { ...ABSENT_ATTENTION_PROJECTION, reason: NO_ATTENTION_DOMAIN_REASON }
    const { container } = render(<AttentionSurface />)
    await waitFor(() => expect(screen.getByText(/NO ATTENTION DOMAIN/)).toBeInTheDocument())
    // It is the unavailable posture, not a ready window with an empty queue.
    expect(container.querySelector('.attention-surface')?.getAttribute('data-health')).toBe('unavailable')
    expect(screen.queryByText(/Last decision/)).toBeNull()
  })
})
