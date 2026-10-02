// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { WorkforceSurface } from '../../src/ui/surfaces/WorkforceSurface'
import { resetWorkforceMirror } from '../../src/platform/workforceClient'
import {
  ABSENT_WORKFORCE_PROJECTION,
  NO_WORKFORCE_DOMAIN_REASON,
  type WorkforceProjection,
} from '../../core/protocol/workforce'

/**
 * The Workforce view.
 *
 * The properties worth a test here are about *truth*, because that is what a
 * dashboard is most likely to erode:
 *
 *   - Every value shown is Core's. The window cannot assert that a worker
 *     exists, cannot say who is on a team, and cannot grant or claim anything —
 *     it has no control that submits anything at all.
 *   - An absence reads as an absence. No Workforce domain and an empty
 *     Workforce are different sentences, and neither is drawn as a roster.
 *   - A claim is drawn as a claim, never merged into the assignment Core made.
 */

let coreSubmit: ReturnType<typeof vi.fn>
let current: WorkforceProjection | null

function ready(over: Partial<WorkforceProjection> = {}): WorkforceProjection {
  return {
    ...ABSENT_WORKFORCE_PROJECTION,
    health: 'ready',
    reason: null,
    counts: { workers: 2, working: 1, idle: 1, waiting: 0, teams: 1 },
    sequence: 12,
    workers: [
      {
        workerId: 'worker-alpha',
        name: 'Alpha',
        teamId: 'team-red',
        specialization: 'research and reading',
        state: 'working',
        assignment: { kind: 'run', id: 'run-1', label: 'Search the archive' },
        capabilities: ['search.web'],
        claims: [{ kind: 'capability', value: 'work.execute', assertedAt: null }],
        budget: { label: 'tokens this hour', used: 120, limit: 1_000 },
        concurrency: { active: 1, limit: 2 },
        lastActiveAt: '2026-10-01T00:00:00.000Z',
      },
      {
        workerId: 'worker-beta',
        name: 'Beta',
        teamId: null,
        specialization: null,
        // A state this lane has never heard of, reported verbatim. The state
        // vocabulary belongs to Core's Workforce domain, so a surface that
        // recognised only its own guesses would eventually show a person a
        // prettier word than the true one.
        state: 'thinking-hard',
        assignment: null,
        capabilities: [],
        claims: [],
        budget: null,
        concurrency: null,
        lastActiveAt: null,
      },
    ],
    teams: [
      {
        teamId: 'team-red',
        name: 'Red',
        purpose: 'reads things so nobody else has to',
        memberIds: ['worker-alpha'],
        state: 'active',
      },
    ],
    ...over,
  }
}

/**
 * Push a projection.
 *
 * With `deliver: false` the value is only made readable — which is what a Core
 * that has not pushed yet looks like. The mirror attaches by subscribing and
 * then reading, so this is the case where the surface must say "I don't know"
 * rather than render a workforce that was never reported.
 */
function push(projection: WorkforceProjection | null, options: { deliver?: boolean } = {}): void {
  current = projection
  window.freyaHost!.coreWorkforce = (async () => current) as never
  window.freyaHost!.onCoreWorkforce = ((handler: (p: WorkforceProjection) => void) => {
    if (options.deliver !== false && current !== null) handler(current)
    return () => {}
  }) as never
}

beforeEach(() => {
  resetWorkforceMirror()
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    workforce: { operation: 'status', ok: true },
  }))
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreWorkforce: (async () => current) as never,
    onCoreWorkforce: (() => () => {}) as never,
  } as never
  push(ready())
})

afterEach(() => {
  cleanup()
  resetWorkforceMirror()
  delete window.freyaHost
})

function renderSurface() {
  return render(<WorkforceSurface />)
}

describe('the Workforce view shows only what Core reported', () => {
  it('says Core has not reported when there is no bridge at all', async () => {
    // The browser case: no desktop host, so nothing has ever arrived. An empty
    // roster here would read as "Freya has no workers", which is a claim this
    // window is in no position to make.
    delete window.freyaHost
    renderSurface()
    expect(screen.getByText(/Core has not reported yet/i)).toBeInTheDocument()
    expect(screen.queryAllByText('Alpha')).toHaveLength(0)
  })

  it('states that no Workforce domain exists, and that nothing is simulated', async () => {
    push({
      ...ABSENT_WORKFORCE_PROJECTION,
      reason: NO_WORKFORCE_DOMAIN_REASON,
    })
    const { container } = renderSurface()

    expect(screen.getByText('NO WORKFORCE DOMAIN')).toBeInTheDocument()
    expect(container.querySelector('[data-domain="absent"]')).not.toBeNull()
    expect(screen.getByText(new RegExp(NO_WORKFORCE_DOMAIN_REASON))).toBeInTheDocument()
    expect(screen.getByText(/Nothing on this screen is simulated/i)).toBeInTheDocument()
    // And no rows: an absent domain is not drawn as an empty team.
    expect(container.querySelectorAll('.workforce-worker')).toHaveLength(0)
    expect(container.querySelectorAll('.workforce-team')).toHaveLength(0)
  })

  it('distinguishes "not reported yet" from "no domain"', async () => {
    push({ ...ABSENT_WORKFORCE_PROJECTION })
    const { container } = renderSurface()
    expect(screen.getByText('WORKFORCE UNAVAILABLE')).toBeInTheDocument()
    expect(container.querySelector('[data-domain="unknown"]')).not.toBeNull()
  })

  it('renders workers and teams exactly as Core words them', async () => {
    const { container } = renderSurface()

    const alpha = container.querySelector('[data-worker-id="worker-alpha"]')
    expect(alpha).not.toBeNull()
    expect(alpha?.getAttribute('data-state')).toBe('working')
    expect(alpha?.textContent).toContain('Alpha')
    expect(alpha?.textContent).toContain('research and reading')
    expect(alpha?.textContent).toContain('Assigned: Search the archive (run run-1)')
    expect(alpha?.textContent).toContain('1 of 2 slots in use')
    expect(alpha?.textContent).toContain('tokens this hour: 120 of 1000')

    // A state this lane has never seen, shown verbatim rather than softened.
    const beta = container.querySelector('[data-worker-id="worker-beta"]')
    expect(beta?.getAttribute('data-state')).toBe('thinking-hard')
    expect(beta?.textContent).toContain('thinking-hard')

    const team = container.querySelector('[data-team-id="team-red"]')
    expect(team?.textContent).toContain('Red')
    expect(team?.textContent).toContain('reads things so nobody else has to')
    expect(team?.textContent).toContain('Alpha (worker-alpha)')

    // Core's counts, as Core counted them.
    expect(screen.getByText(/2 workers · 1 working · 1 idle · 1 team/)).toBeInTheDocument()
  })

  it('draws a claim as a claim, never as an assignment', async () => {
    const { container } = renderSurface()
    const alpha = container.querySelector('[data-worker-id="worker-alpha"]')

    expect(alpha?.textContent).toContain('Assigned by Core: search.web')
    expect(alpha?.textContent).toContain('Claimed, not granted — capability: work.execute')
    // The two lists stay separate: the claim is not folded into the line that
    // says what Core assigned, because one is a worker's word and the other is
    // Core's.
    expect(alpha?.querySelector('.workforce-capabilities')?.textContent).not.toContain(
      'work.execute',
    )
    expect(alpha?.querySelectorAll('.workforce-claim')).toHaveLength(1)
  })

  it('says so plainly when the domain is running and empty', async () => {
    push(
      ready({
        workers: [],
        teams: [],
        counts: { workers: 0, working: 0, idle: 0, waiting: 0, teams: 0 },
      }),
    )
    renderSurface()
    expect(screen.getByText(/Core reports no workers and no teams/i)).toBeInTheDocument()
    expect(screen.getByText(/not a paused view/i)).toBeInTheDocument()
  })

  it('offers no control at all, and submits only the payloadless read', async () => {
    const { container } = renderSurface()

    // The structural version of "the renderer cannot submit a claim": there is
    // nothing here to submit with. No button, no input, no form.
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('input, textarea, select, form')).toHaveLength(0)

    await waitFor(() => expect(coreSubmit).toHaveBeenCalledTimes(1))
    expect(coreSubmit.mock.calls[0]).toEqual(['workforce.status.read'])
  })

  it('shows a refusal as Core’s sentence, next to the view it left behind', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: false,
      refusal: { reason: 'the Workforce read is not permitted for this window' },
    }))
    renderSurface()

    await waitFor(() =>
      expect(
        screen.getByText(/Core refused the workforce read: the Workforce read is not permitted/i),
      ).toBeInTheDocument(),
    )
    // The projection is still on screen: a refused read does not hide what Core
    // already reported, it explains that this window may not ask again.
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })
})
