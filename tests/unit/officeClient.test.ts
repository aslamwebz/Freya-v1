import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ABSENT_OFFICE_PROJECTION, type OfficeProjection } from '../../core/office/projection'
import {
  createOfficeMirror,
  resetOfficeMirror,
} from '../../src/platform/officeClient'

function projection(over: Partial<OfficeProjection> = {}): OfficeProjection {
  return {
    ...ABSENT_OFFICE_PROJECTION,
    health: 'ready',
    reason: null,
    freya: {
      stationId: 'freya',
      kind: 'freya',
      zone: 'freya',
      entityId: 'freya',
      label: 'Freya',
      state: 'idle',
      reason: 'nothing is executing',
      position: { x: 856, y: 262 },
      detail: 'Nothing is executing.',
      status: 'ready',
      counts: { stepsTotal: 0, stepsSettled: 0, stepsVerified: 0, stepsFailed: 0, actions: 0, attempts: 0 },
      live: false,
      activeStepKey: null,
      openAssignments: 0,
      approval: null,
    },
    stations: [],
    history: [],
    presenceRequests: [],
    counts: {
      runs: 0,
      runsLive: 0,
      workers: 0,
      workersByIdle: 0,
      workersWorking: 0,
      workersBlocked: 0,
      workersStopped: 0,
      workersRetired: 0,
      approvalsPending: 0,
      floorStationsShown: 0,
      floorStationsHidden: 0,
      workforceStationsShown: 0,
      workforceStationsHidden: 0,
      approvalStationsShown: 0,
      approvalStationsHidden: 0,
      historyShown: 0,
      historyHidden: 0,
    },
    sequence: 0,
    ...over,
  }
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreOffice: ReturnType<typeof vi.fn>
let handler: ((p: OfficeProjection) => void) | null = null

beforeEach(() => {
  resetOfficeMirror()
  handler = null
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    office: { operation: 'presence-requested', ok: true, workerId: 'alpha' },
  }))
  coreOffice = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreOffice: coreOffice as never,
    onCoreOffice: ((next: (p: OfficeProjection) => void) => {
      handler = next
      return () => {
        handler = null
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetOfficeMirror()
  vi.restoreAllMocks()
})

describe('office client', () => {
  it('submits the presence request with a workerId and nothing else', async () => {
    const mirror = createOfficeMirror()
    const outcome = await mirror.requestPresence('alpha')
    expect(outcome.ok).toBe(true)
    expect(coreSubmit).toHaveBeenCalledWith('office.presence.request', { workerId: 'alpha' })
  })

  it('refuses when the bridge is unavailable', async () => {
    window.freyaHost = undefined
    const mirror = createOfficeMirror()
    const outcome = await mirror.requestPresence('alpha')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('not available')
  })

  it('delivers the current projection on subscribe', () => {
    const mirror = createOfficeMirror()
    const seen: (OfficeProjection | null)[] = []
    mirror.subscribe((p) => seen.push(p))
    expect(seen).toHaveLength(1)
  })

  it('follows pushes from the host', async () => {
    const mirror = createOfficeMirror()
    await mirror.attach()
    const next = projection({ sequence: 5 })
    handler?.(next)
    expect(mirror.projection?.sequence).toBe(5)
  })

  it('reads once as a backstop after attaching', async () => {
    const mirror = createOfficeMirror()
    await mirror.attach()
    expect(coreOffice).toHaveBeenCalled()
  })

  it('resets to null', () => {
    const mirror = createOfficeMirror()
    mirror.reset()
    expect(mirror.projection).toBeNull()
  })
})
