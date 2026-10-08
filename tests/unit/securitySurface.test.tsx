// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SecuritySurface } from '../../src/ui/surfaces/SecuritySurface'
import { resetCoreMirror } from '../../src/platform/coreClient'
import type { CoreStatus } from '../../core/protocol/core-protocol'

/**
 * The Security surface.
 *
 * Two things are worth a test each, and they pull in opposite directions:
 *
 *   - STOP ALL must be easy to reach in an emergency, and hard to trigger by
 *     accident. So a single click must not stop anything, and the armed state
 *     must expire on its own.
 *   - Every value shown must be Core's. So nothing may be asserted as fact
 *     before Core has reported it, and a refused control must read as refused.
 */

const STATUS: CoreStatus = {
  lifecycle: 'ready',

        operational: true,
        persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null }, diagnostics: { path: null, writeFailures: 0 },  eventSequence: 12,
  coreStartedAt: '2026-03-01T12:00:00.000Z',
  integrity: { integrity: 'ok' as const, reason: 'test fixture', line: null, eventsRead: 0, bytesDiscarded: 0 },
  stopAll: { active: false, activatedAt: null, activatedBy: null },
  guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
  governor: { status: 'ready', grantsActive: 2 },
  providers: [
    {
      id: 'nanogpt',
      kind: 'nanogpt',
      status: 'unconfigured',
      model: null,
      detail: 'Set NANOGPT_API_KEY, NANOGPT_BASE_URL and NANOGPT_MODEL to enable.',
      liveEnabled: false,
    },
  ],
  activeProviderCalls: 0,
  sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  durableUsage: { calls: 3, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  faults: [],
}

const STOPPED: CoreStatus = {
  ...STATUS,
  stopAll: { active: true, activatedAt: '2026-03-01T12:30:00.000Z', activatedBy: 'owner' },
  governor: { status: 'deny_all', grantsActive: 2 },
}

let coreSubmit: ReturnType<typeof vi.fn>
let current: CoreStatus

/**
 * A bridge whose push and whose read always agree.
 *
 * The mirror attaches by subscribing and then reading, so a bridge that pushed
 * one value and returned another would leave the surface showing whichever the
 * read happened to be. Keeping them in step makes a failure mean something.
 */
function setBridgeStatus(status: CoreStatus): void {
  current = status
  window.freyaHost!.coreStatus = (async () => current) as never
  window.freyaHost!.onCoreStatus = ((handler: (s: CoreStatus) => void) => {
    handler(current)
    return () => {}
  }) as never
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  // The mirror is a module singleton, so a test that swaps the bridge has to
  // drop the old subscription first.
  resetCoreMirror()
  current = STATUS
  coreSubmit = vi.fn(async (command: string) =>
    command === 'security.stopAll'
      ? { requestId: 'r1', ok: true, status: STOPPED, durableSequence: 13 }
      : { requestId: 'r2', ok: true, status: STATUS },
  )
  window.freyaHost = {
    isDesktop: true,
    getRuntimeInfo: vi.fn(),
    loadWorkspace: vi.fn(),
    saveWorkspace: vi.fn(),
    onCollect: vi.fn(),
    coreSubmit: coreSubmit as never,
    coreStatus: (async () => current) as never,
    onCoreStatus: (() => () => {}) as never,
  } as never
  setBridgeStatus(STATUS)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete window.freyaHost
})

function renderSurface() {
  render(<SecuritySurface />)
}

describe('the Security surface reads Core', () => {
  it('shows Core values rather than anything it decided itself', () => {
    renderSurface()
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
    expect(screen.getByText(/deny — anything not explicitly permitted is refused/i)).toBeInTheDocument()
    expect(screen.getByText(/no approval workflow exists/i)).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument() // active grants
    expect(screen.getByText(/0 this session · 3 durable/)).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument() // event sequence
    expect(screen.getByText('unconfigured')).toBeInTheDocument()
  })

  it('labels a provider that can spend money as able to', () => {
    setBridgeStatus({
      ...STATUS,
      providers: [{ ...STATUS.providers[0]!, status: 'configured', liveEnabled: true }],
    })
    renderSurface()
    expect(screen.getByText(/live calls possible/i)).toBeInTheDocument()
  })

  it('waits rather than claiming a posture it has not been told', () => {
    // A bridge that never pushes and never answers a read.
    window.freyaHost!.onCoreStatus = (() => () => {}) as never
    window.freyaHost!.coreStatus = (() => new Promise<never>(() => {})) as never
    renderSurface()
    expect(screen.getByText(/waiting for freya core/i)).toBeInTheDocument()
    expect(screen.queryByText('RUNNING')).not.toBeInTheDocument()
    expect(screen.queryByText('STOPPED')).not.toBeInTheDocument()
  })
})

describe('STOP ALL is hard to trigger by accident', () => {
  it('does not stop anything on a single click', async () => {
    renderSurface()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop all/i }))
    })
    // Armed, not stopped: this is the whole point of the confirmation.
    expect(coreSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog', { name: /confirm stop all/i })).toBeInTheDocument()
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
  })

  it('stops only after the confirming press', async () => {
    renderSurface()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop all/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /yes, stop everything/i }))
    })
    expect(coreSubmit).toHaveBeenCalledWith('security.stopAll', {
      reason: 'confirmed from the Security surface',
      origin: 'security-surface',
    })
  })

  it('can be cancelled without sending anything', async () => {
    renderSurface()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop all/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    })
    expect(coreSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /stop all/i })).toBeInTheDocument()
  })

  it('disarms itself if nobody confirms', async () => {
    renderSurface()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop all/i }))
    })
    expect(screen.getByRole('alertdialog', { name: /confirm stop all/i })).toBeInTheDocument()

    // Walk away. The loaded trigger must not sit on screen waiting.
    await act(async () => {
      vi.advanceTimersByTime(7000)
    })
    expect(screen.queryByRole('alertdialog', { name: /confirm stop all/i })).not.toBeInTheDocument()
    expect(coreSubmit).not.toHaveBeenCalled()
  })
})

describe('resuming is explicit and reports what Core said', () => {
  beforeEach(() => {
    setBridgeStatus(STOPPED)
  })

  it('offers resume when stopped, and says who stopped it', () => {
    renderSurface()
    expect(screen.getByText('STOPPED')).toBeInTheDocument()
    expect(screen.getByText(/by owner/i)).toBeInTheDocument()
    // The stop control is replaced, not offered alongside resume.
    expect(screen.queryByRole('button', { name: /stop all/i })).not.toBeInTheDocument()
  })

  it('resumes on one explicit press', async () => {
    renderSurface()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /resume core/i }))
    })
    expect(coreSubmit).toHaveBeenCalledWith('security.resume', {
      reason: 'resumed from the Security surface',
      origin: 'security-surface',
    })
  })

  it('shows a refusal as a refusal', async () => {
    coreSubmit.mockResolvedValue({
      requestId: 'r1',
      ok: false,
      refusal: { reason: 'principal does not hold the capability' },
    })
    renderSurface()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /resume core/i }))
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/refused/i)
    expect(alert.textContent).toContain('principal does not hold the capability')
    // Still showing Core's state, because Core did not change it.
    expect(screen.getByText('STOPPED')).toBeInTheDocument()
  })
})
