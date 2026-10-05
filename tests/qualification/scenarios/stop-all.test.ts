// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core'
import { STOP_ALL_EXEMPT_DOMAIN, capabilityReadiness, orderedRegistry } from '../../../core/qualification'
import { hostHarness, ALLOWED_HOST } from '../../host/devicehands/harness'
import { QUALIFIED_MODULES, floorFacts } from '../fixture'

/**
 * Scenario gate: `stop-all`.
 *
 * Bounded: real Cores over real temporary journals, one real Device Hands activation, no
 * network, no credential.
 *
 * The claim is the one sentence the whole security posture rests on:
 *
 * > A latched STOP ALL refuses work on every lane, survives a real restart, and is lifted
 * > only by an explicit owner resume.
 *
 * Three properties are checked here that unit tests of each lane cannot check together:
 *
 *   - **Lateral.** Latching stops *every* registered domain at once, not the one under
 *     test. A stop that reached one lane and quietly spared eleven is a worse bug than no
 *     stop at all, because it reads as protection.
 *   - **Durable.** The latch is derived from the journal, so it survives a process. A stop
 *     that un-pressed itself on restart is not a stop.
 *   - **Irreversible by accident.** Nothing on any lane may clear it. Only the owner
 *     command may, and the security spine is never itself stopped.
 */

let root = ''
let dataPath = ''
let core: Core | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'freya-p49-stopall-'))
  dataPath = join(root, 'core-events.jsonl')
  core = null
})

afterEach(async () => {
  if (core !== null) await core.stop('scenario cleanup')
  core = null
  await rm(root, { recursive: true, force: true })
})

async function open(): Promise<Core> {
  core = createCore({ dataPath, env: {} })
  await core.start()
  return core
}

describe('STOP ALL across every lane', () => {
  it('stops every registered domain except the security spine', async () => {
    const started = await open()

    // Before: the spine and a good number of Core-owned lanes are running.
    const before = started.runtime()
    expect(before.active.length).toBeGreaterThan(5)

    await started.handleCommand({ command: 'security.stopAll', requestId: 's0' })

    const after = started.runtime()
    expect(after.stopAllActive).toBe(true)
    expect(after.lifecycle).toBe('stopped-all')
    expect(after.active).toEqual([STOP_ALL_EXEMPT_DOMAIN])
    // Every non-spine domain is stopped, and each says why. `available` is accepted here
    // for the same reason the controller accepts it: an `activatable` domain with no
    // handler was never running, so a stop changes nothing about it.
    for (const domain of after.domains) {
      if (domain.id === STOP_ALL_EXEMPT_DOMAIN) continue
      expect(['blocked', 'available'], `${domain.id} is ${domain.status}`).toContain(domain.status)
      expect(domain.reason.length).toBeGreaterThan(0)
    }
  })

  it('keeps the spine active, because a stopped Guard cannot enforce the stop', async () => {
    const started = await open()
    await started.handleCommand({ command: 'security.stopAll', requestId: 's0' })
    const after = started.runtime()
    const spine = after.domains.find((domain) => domain.id === STOP_ALL_EXEMPT_DOMAIN)!
    expect(spine.status).toBe('active')
  })

  it('refuses new work on every lane while latched, and says it is stopped', async () => {
    const started = await open()
    const created = await started.handleCommand({
      command: 'mission.create',
      requestId: 'm0',
      payload: { title: 'Blocked', intent: 'This must not activate while Freya is stopped.' },
    })
    expect(created.ok).toBe(true)
    const missionId = (created as { mission?: { missionId?: string } }).mission?.missionId
    expect(missionId).toBeTruthy()

    await started.handleCommand({ command: 'security.stopAll', requestId: 's0' })

    // Activation is the consequential step, so it is the one that has to be refused.
    const activated = await started.handleCommand({
      command: 'mission.activate',
      requestId: 'm1',
      payload: { missionId },
    })
    expect(activated.ok).toBe(false)
    // The refusal has to say *why*, in words. A bare false is a boolean that a caller can
    // guess at, and a guessed refusal is how a stop ends up "cleared" by a retry loop.
    const reason = [
      activated.refusal?.reason,
      (activated as { mission?: { reason?: string } }).mission?.reason,
      activated.error?.message,
    ].find((value): value is string => typeof value === 'string' && value.length > 0)
    expect(reason, 'the refusal named no reason').toBeTruthy()
    expect(reason).toMatch(/stopped|stop all|stop-all/i)

    // Stopping must not blind the owner to what is in flight, though. Reading is not
    // acting, and a stop that hid state would be indistinguishable from a stop that lost
    // it.
    const read = await started.handleCommand({ command: 'mission.status.read', requestId: 'm2' })
    expect(read.ok).toBe(true)
    expect(
      started.mission().missions.some((mission) => mission.missionId === missionId),
    ).toBe(true)

    // The status a window would render has to name the stop, not merely look idle.
    expect(started.status().stopAll.active).toBe(true)
    expect(started.status().stopAll.activatedBy).toBe('owner')
    expect(started.status().stopAll.activatedAt).toBeTruthy()
  })

  it('survives a real restart, because a panic button does not un-press itself', async () => {
    const first = await open()
    await first.handleCommand({ command: 'security.stopAll', requestId: 's0' })
    const activatedAt = first.status().stopAll.activatedAt
    expect(activatedAt).toBeTruthy()
    await first.stop('scenario finished')
    core = null

    const second = await open()
    // The latch is derived from durable events, so a fresh process finds it already set.
    expect(second.status().stopAll.active).toBe(true)
    expect(second.status().stopAll.activatedAt).toBe(activatedAt)
    expect(second.runtime().stopAllActive).toBe(true)

    // And a fresh window finds Core already stopped, without anything asking it to stop.
    expect(second.runtime().active).toEqual([STOP_ALL_EXEMPT_DOMAIN])
  })

  it('is lifted only by an explicit owner resume, and only then', async () => {
    const first = await open()
    await first.handleCommand({ command: 'security.stopAll', requestId: 's0' })
    await first.stop('scenario finished')
    core = null

    const second = await open()
    // Re-running the stop is idempotent and does not reopen anything.
    await second.handleCommand({ command: 'security.stopAll', requestId: 's1' })
    expect(second.status().stopAll.active).toBe(true)

    const resumed = await second.handleCommand({ command: 'security.resume', requestId: 's2' })
    expect(resumed.ok).toBe(true)
    expect(second.status().stopAll.active).toBe(false)
    expect(second.runtime().stopAllActive).toBe(false)
    expect(second.runtime().active.length).toBeGreaterThan(5)
  })

  it('stops Device Hands too, before any effect is reached', async () => {
    const h = await hostHarness()
    expect(h.authority.stopped).toBe(false)

    h.authority.stopped = true
    const outcome = await h.perform('browser.navigate', { url: `https://${ALLOWED_HOST}/` })

    // The refusal names the stop, and the host counter proves no browser primitive moved.
    expect(outcome.refusedAt).toBe('stop-all')
    expect(outcome.code).toBe('stop-all-latched')
    expect(h.counts.browserNavigate).toBe(0)
  })

  it('is reported the same way by the release inventory and by the live runtime', async () => {
    const started = await open()
    await started.handleCommand({ command: 'security.stopAll', requestId: 's0' })
    const projection = started.runtime()
    const facts = floorFacts({ stopAllActive: true })
    await started.stop('scenario finished')
    core = null

    // A release report built while stopped must describe the same stopped system. If the
    // inventory said `active` here while the runtime said otherwise, the report would be
    // describing a Freya that is not running.
    const stillActive = orderedRegistry()
      .map((descriptor) => [
        descriptor.id,
        capabilityReadiness(descriptor, {
          facts,
          presentModules: QUALIFIED_MODULES,
        }).readiness,
      ])
      .filter(([, readiness]) => readiness === 'active' || readiness === 'degraded')

    expect(stillActive.map(([id]) => id)).toEqual([STOP_ALL_EXEMPT_DOMAIN])
    expect(projection.active).toEqual([STOP_ALL_EXEMPT_DOMAIN])
  })
})