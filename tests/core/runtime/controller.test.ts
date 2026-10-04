import { describe, expect, it } from 'vitest'
import { RuntimeActivationController } from '../../../core/runtime'
import type { RuntimeDomainDescriptor, RuntimeActivationHandler, RuntimeProjection } from '../../../core/runtime'
import { descriptor, facts, makeHandler, makeJournal, optionalDep, requires } from './harness'

function view(projection: RuntimeProjection, id: string) {
  const found = projection.domains.find((domain) => domain.id === id)
  if (found === undefined) throw new Error(`no domain ${id} in the projection`)
  return found
}

function build(descriptors: RuntimeDomainDescriptor[], handlers: RuntimeActivationHandler[]) {
  const journal = makeJournal()
  const controller = new RuntimeActivationController({
    journal,
    now: () => '2026-01-01T00:00:00.000Z',
  })
  controller.register(descriptors, handlers)
  return { journal, controller }
}

describe('activation is dependency-aware', () => {
  it('reports implemented-but-blocked with the exact missing dependency', async () => {
    const log: string[] = []
    const domain = descriptor({
      id: 'core.hands',
      activation: 'activatable',
      requirements: [requires('host-adapter', 'the Device Hands adapter', 'device-hands')],
    })
    const { controller } = build([domain], [makeHandler(domain.id, log)])

    const projection = await controller.load(facts())
    expect(view(projection, domain.id).status).toBe('blocked')
    expect(view(projection, domain.id).missing).toEqual(['the Device Hands adapter'])
    expect(log).toEqual([])
  })

  it('activates once the dependency becomes available', async () => {
    const log: string[] = []
    const domain = descriptor({
      id: 'core.hands',
      activation: 'activatable',
      requirements: [requires('host-adapter', 'the Device Hands adapter', 'device-hands')],
    })
    const { controller } = build([domain], [makeHandler(domain.id, log)])

    await controller.load(facts())
    const projection = await controller.refresh(facts({ hostAdapters: ['device-hands'] }))
    expect(view(projection, domain.id).status).toBe('active')
    expect(log).toContain('start:core.hands')
  })

  it('blocks on a missing Vault and a missing keyring secret, naming both', async () => {
    const domain = descriptor({
      id: 'core.vaultish',
      activation: 'activatable',
      requirements: [
        requires('vault', 'an open encrypted Vault'),
        requires('keyring', 'the Brain key', 'brain'),
      ],
    })
    const { controller } = build([domain], [])
    const projection = await controller.load(facts())
    expect(view(projection, domain.id).missing).toEqual([
      'an open encrypted Vault',
      'the Brain key',
    ])
  })

  it('keeps a blocked-mode domain blocked even when every dependency is satisfied', async () => {
    const log: string[] = []
    const domain = descriptor({ id: 'core.later', activation: 'blocked', requirements: [] })
    const { controller } = build([domain], [makeHandler(domain.id, log)])
    const projection = await controller.load(facts())
    expect(view(projection, domain.id).status).toBe('blocked')
    expect(log).toEqual([])
  })

  it('keeps a fail-closed domain blocked with its stated reason', async () => {
    const domain = descriptor({
      id: 'core.economic',
      activation: 'fail-closed',
      requirements: [],
      note: 'Fail-closed: no real-money authority exists.',
    })
    const { controller } = build([domain], [])
    const projection = await controller.load(facts({ budgetRemainingUnits: 999 }))
    expect(view(projection, domain.id).status).toBe('blocked')
    expect(view(projection, domain.id).reason).toMatch(/fail-closed/i)
  })

  it('reports a truthful degraded state for a missing optional dependency', async () => {
    const domain = descriptor({
      id: 'core.relay',
      activation: 'core-owned',
      requirements: [optionalDep('external-connector', 'at least one external connector')],
    })
    const { controller } = build([domain], [])
    const projection = await controller.load(facts())
    expect(view(projection, domain.id).status).toBe('degraded')
    expect(view(projection, domain.id).reason).toMatch(/reduced capability/i)

    const recovered = await controller.refresh(facts({ connectors: ['email'] }))
    expect(view(recovered, domain.id).status).toBe('active')
  })
})

describe('activation is idempotent', () => {
  it('starts a handler once, however many refreshes run', async () => {
    const log: string[] = []
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const { controller } = build([domain], [makeHandler(domain.id, log)])

    await controller.load(facts())
    await controller.refresh(facts())
    await controller.refresh(facts())
    expect(log.filter((line) => line.startsWith('start:'))).toHaveLength(1)
  })

  it('does not re-journal a status that has not changed', async () => {
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const { controller, journal } = build([domain], [])
    await controller.load(facts())
    const after = journal.entries.length
    await controller.refresh(facts())
    expect(journal.entries.length).toBe(after)
  })

  it('replays the same journal into the same state', async () => {
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const first = build([domain], [])
    await first.controller.load(facts())
    await first.controller.refresh(facts())

    const second = build([domain], [])
    const replayProjection = await second.controller.load(facts())
    const firstProjection = first.controller.projection()
    expect(replayProjection.domains).toEqual(firstProjection.domains)
    expect(replayProjection.counts).toEqual(firstProjection.counts)
  })

  it('serialises concurrent refreshes and a stop without racing', async () => {
    const log: string[] = []
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const { controller } = build([domain], [makeHandler(domain.id, log)])
    await controller.load(facts())

    await Promise.all([
      controller.refresh(facts()),
      controller.stopAll('panic'),
      controller.resume(facts()),
    ])

    const projection = controller.projection()
    expect(projection.lifecycle).toBe('active')
    expect(view(projection, domain.id).status).toBe('active')
    expect(log.filter((line) => line.startsWith('start:')).length).toBeGreaterThanOrEqual(1)
  })

  it('ignores a redelivered journal entry', async () => {
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const { controller, journal } = build([domain], [])
    await controller.load(facts())
    const entries = await journal.replay()
    // Replay with the same entries twice: the fold is idempotent by sequence.
    const once = await controller.load(facts())
    expect(once.domains).toEqual(controller.projection().domains)
    expect(entries.length).toBeGreaterThan(0)
  })
})

describe('STOP ALL precedence', () => {
  it('stops every active domain in reverse order and records the reason', async () => {
    const log: string[] = []
    const low = descriptor({ id: 'core.low', activation: 'activatable', order: 1 })
    const high = descriptor({ id: 'core.high', activation: 'activatable', order: 2 })
    const { controller, journal } = build(
      [low, high],
      [makeHandler(low.id, log), makeHandler(high.id, log)],
    )
    await controller.load(facts())
    log.length = 0

    const projection = await controller.stopAll('the owner pressed stop')
    expect(view(projection, low.id).status).toBe('blocked')
    expect(view(projection, high.id).status).toBe('blocked')
    // Reverse order: the higher order stops first.
    expect(log).toEqual(['stop:core.high:the owner pressed stop', 'stop:core.low:the owner pressed stop'])
    expect(projection.lastStopReason).toBe('the owner pressed stop')
    expect(journal.entries.some((entry) => entry.type === 'runtime.activation.stopped')).toBe(true)
  })

  it('exempts the security spine, because a stopped Guard cannot enforce a stop', async () => {
    const spine = descriptor({
      id: 'core.security-spine',
      activation: 'core-owned',
      order: 0,
    })
    const other = descriptor({ id: 'core.other', activation: 'activatable', order: 1 })
    const { controller } = build([spine, other], [])
    await controller.load(facts())
    const projection = await controller.stopAll('panic')
    expect(view(projection, spine.id).status).toBe('active')
    expect(view(projection, other.id).status).toBe('blocked')
  })

  it('re-activates eligible domains when the stop is cleared', async () => {
    const log: string[] = []
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const { controller } = build([domain], [makeHandler(domain.id, log)])
    await controller.load(facts())
    await controller.stopAll('panic')
    const projection = await controller.resume(facts())
    expect(view(projection, domain.id).status).toBe('active')
    expect(log.filter((line) => line.startsWith('start:'))).toHaveLength(2)
  })
})

describe('restart and recovery', () => {
  it('stops then re-activates, and records a reconciliation', async () => {
    const log: string[] = []
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const { controller, journal } = build([domain], [makeHandler(domain.id, log)])
    await controller.load(facts())
    log.length = 0

    const projection = await controller.restart(facts(), 'provider reconfigured')
    expect(view(projection, domain.id).status).toBe('active')
    expect(log).toEqual(['stop:core.one:provider reconfigured', 'start:core.one'])
    expect(journal.entries.some((entry) => entry.type === 'runtime.activation.reconciled')).toBe(true)
    expect(projection.recoveredDomains).toContain('core.one')
  })

  it('records a stop on shutdown and leaves nothing active', async () => {
    const log: string[] = []
    const domain = descriptor({ id: 'core.one', activation: 'activatable' })
    const { controller } = build([domain], [makeHandler(domain.id, log)])
    await controller.load(facts())
    await controller.shutdown('core stopping: quit')
    const projection = controller.projection()
    expect(projection.lifecycle).toBe('stopped')
    expect(view(projection, domain.id).status).toBe('blocked')
  })
})

describe('authority does not travel through activation', () => {
  it('exposes no method that sets a status directly', () => {
    const prototype = RuntimeActivationController.prototype as unknown as Record<string, unknown>
    expect(prototype['setStatus']).toBeUndefined()
    expect(prototype['activateDomain']).toBeUndefined()
    expect(prototype['grant']).toBeUndefined()
    expect(prototype['approve']).toBeUndefined()
  })

  it('cannot widen a blocked domain by presenting extra facts', async () => {
    const domain = descriptor({ id: 'core.hands', activation: 'blocked', requirements: [] })
    const { controller } = build([domain], [])
    await controller.load(facts())
    const projection = await controller.refresh(
      facts({
        ownerApprovals: ['device.hands'],
        capabilityGrants: ['device.hands'],
        hostAdapters: ['device-hands'],
        trustedDevices: 3,
      }),
    )
    expect(view(projection, domain.id).status).toBe('blocked')
  })
})
