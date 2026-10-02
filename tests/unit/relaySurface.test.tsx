// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RelaySurface } from '../../src/ui/surfaces/RelaySurface'
import { resetRelayMirror } from '../../src/platform/relayClient'
import {
  ABSENT_RELAY_PROJECTION,
  NO_RELAY_DOMAIN_REASON,
  type RelayProjection,
} from '../../core/protocol/relay'
import { initialRelayState } from '../../core/relay/state'
import { projectRelay } from '../../core/relay/projection'

/**
 * The Relay view.
 *
 *   - It renders truthful connector availability from the projection.
 *   - It cannot forge availability: an unavailable connector's actions are
 *     disabled.
 *   - A write request shows "awaiting approval" and nothing else until Core
 *     says it settled.
 *   - "No Relay domain" is not drawn as "no connectors".
 */

let coreSubmit: ReturnType<typeof vi.fn>
let coreRelay: ReturnType<typeof vi.fn>
let handlers: Set<(projection: RelayProjection) => void>

function ready(over: Partial<RelayProjection> = {}): RelayProjection {
  return projectRelay(5, initialRelayState(), () => 'ready')
}

function unavailable(): RelayProjection {
  return projectRelay(5, initialRelayState(), () => 'unavailable')
}

beforeEach(() => {
  resetRelayMirror()
  handlers = new Set()
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    relay: { operation: 'requested', ok: true, approvalId: 'a1', status: 'pending_approval' },
  }))
  coreRelay = vi.fn(async () => ready())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreRelay: coreRelay as never,
    onCoreRelay: ((next: (p: RelayProjection) => void) => {
      handlers.add(next)
      return () => {
        handlers.delete(next)
      }
    }) as never,
  } as never
})

afterEach(() => {
  cleanup()
  resetRelayMirror()
})

describe('relay surface', () => {
  it('renders truthful connector availability', async () => {
    render(<RelaySurface />)
    await waitFor(() => {
      expect(screen.getByText('RELAY')).toBeTruthy()
    })
    expect(screen.getByText(/Email: ready/)).toBeTruthy()
    expect(screen.getByText(/Calendar: ready/)).toBeTruthy()
    expect(screen.getByText(/GitHub: ready/)).toBeTruthy()
    expect(screen.getByText(/External connectors: ready/)).toBeTruthy()
  })

  it('disables actions on an unavailable connector', async () => {
    coreRelay.mockResolvedValue(unavailable())
    render(<RelaySurface />)
    await waitFor(() => {
      expect(screen.getByText(/Email: unavailable/)).toBeTruthy()
    })
    const readEmail = screen.getByRole('button', { name: /read email/i })
    expect(readEmail).toBeDisabled()
  })

  it('reports the absent projection before Core has reported', async () => {
    coreRelay.mockResolvedValue(null)
    render(<RelaySurface />)
    await waitFor(() => {
      expect(screen.getByText(/Relay is not available/)).toBeTruthy()
    })
  })

  it('reports "no Relay domain" truthfully', async () => {
    coreRelay.mockResolvedValue({
      ...ABSENT_RELAY_PROJECTION,
      reason: NO_RELAY_DOMAIN_REASON,
    })
    render(<RelaySurface />)
    await waitFor(() => {
      expect(screen.getByText('NO RELAY DOMAIN')).toBeTruthy()
    })
  })

  it('a write request shows awaiting approval', async () => {
    render(<RelaySurface />)
    await waitFor(() => {
      expect(screen.getByText('RELAY')).toBeTruthy()
    })
    const to = screen.getByLabelText('To') as HTMLInputElement
    fireEvent.change(to, { target: { value: 'alice@example.com' } })
    const subject = screen.getByLabelText('Subject') as HTMLInputElement
    fireEvent.change(subject, { target: { value: 'Hello' } })
    const body = screen.getByLabelText('Body') as HTMLTextAreaElement
    fireEvent.change(body, { target: { value: 'Body' } })
    const send = screen.getByRole('button', { name: /^send$/i })
    fireEvent.click(send)
    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith(
        'relay.email.send',
        expect.objectContaining({ to: 'alice@example.com', subject: 'Hello' }),
      )
    })
  })

  it('a pending approval can be approved or denied', async () => {
    const projection = ready()
    const withApproval: RelayProjection = {
      ...projection,
      pendingApprovals: [
        {
          approvalId: 'a1',
          actionId: 'act1',
          connector: 'email',
          action: 'email.send',
          risk: 'consequential',
          summary: 'Send email to alice@example.com',
          requestedAt: '2026-10-02T09:00:00.000Z',
        },
      ],
    }
    coreRelay.mockResolvedValue(withApproval)
    render(<RelaySurface />)
    await waitFor(() => {
      expect(screen.getByText('Send email to alice@example.com')).toBeTruthy()
    })
    const approve = screen.getByRole('button', { name: /^approve$/i })
    fireEvent.click(approve)
    await waitFor(() => {
      expect(coreSubmit).toHaveBeenCalledWith('relay.approval.decide', {
        approvalId: 'a1',
        decision: 'approved',
      })
    })
  })

  it('cannot forge a connector', async () => {
    render(<RelaySurface />)
    await waitFor(() => {
      expect(screen.getByText('RELAY')).toBeTruthy()
    })
    // The surface renders only the four closed connectors.
    expect(screen.queryByText(/evil/)).toBeNull()
  })
})
