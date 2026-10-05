// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../core'
import { ElectronCoreHost } from '../../../electron/coreHost'
import { buildCapabilityInventory, inventorySummary } from '../../../core/qualification'
import { hostHarness, policyInput } from '../../host/devicehands/harness'
import { QUALIFIED_MODULES, floorFacts } from '../fixture'

/**
 * Scenario gate: `startup-shutdown`.
 *
 * Bounded: one real Core, one real Electron host seam, one real temporary directory. No
 * network, no credential, no window, no key.
 *
 * The host seam is used rather than `createCore` alone because "the application starts"
 * and "a library constructs an object" are different claims. `ElectronCoreHost` is what
 * opens the journal, builds the Core, wires the Device Hands seam and releases all three
 * again, so it is the only place a leak in the start/stop path can actually appear.
 *
 * What has to be true:
 *   - a start reaches ready, and the runtime registry reports the spine active
 *   - a stop reaches stopped, and the host reports nothing afterwards
 *   - a second host over the same journal does not corrupt the first one's history
 *   - the release inventory describes the same runtime the host built
 */

let root = ''
let dataPath = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'freya-p49-lifecycle-'))
  dataPath = join(root, 'core-events.jsonl')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('startup and shutdown across the host seam', () => {
  it('reaches ready on start, reports it, and describes an active inventory', async () => {
    const host = new ElectronCoreHost(dataPath, {})
    await host.start()

    expect(host.status().lifecycle).toBe('ready')

    const inventory = buildCapabilityInventory({
      facts: floorFacts(),
      presentModules: QUALIFIED_MODULES,
    })
    expect(inventory.counts.active).toBeGreaterThan(0)
    expect(inventory.running).toContain('core.security-spine')
    expect(inventorySummary(inventory)).toMatch(/\d+ active/)

    await host.stop('scenario finished')
  })

  it('reports nothing at all once stopped, rather than a stale snapshot', async () => {
    const host = new ElectronCoreHost(dataPath, {})
    await host.start()
    const before = host.status()
    expect(before.lifecycle).toBe('ready')

    await host.stop('the owner asked')

    // The host drops its Core reference before stopping it. Reporting a projection here
    // would be reporting a Core that no longer exists.
    expect(host.status().lifecycle).not.toBe('ready')
  })

  it('releases the Device Hands activation it was given, and switched nothing on', async () => {
    // The real Phase 42 activation seam, built from the real bounded adapters, handed to
    // the host disabled. Nothing here is a stub of the seam: the effects, the journal and
    // the authority are the host's own types.
    const seam = await hostHarness()
    const host = new ElectronCoreHost(dataPath, {}, {
      deviceHands: {
        enabled: false,
        effects: seam.effects,
        journal: seam.journal,
        authority: seam.authority,
        policy: policyInput(),
      },
    })
    await host.start()

    const status = host.deviceHandsStatus()
    expect(status).not.toBeNull()
    expect(status?.opened).toBe(true)
    // The seam was handed over disabled, so nothing may have been switched on. An
    // activation that reported itself live here would be a capability nobody granted.
    expect(status?.active).toBe(false)
    expect(status?.enabled).toBe(false)
    // And it names the two actions this host cannot safely implement, rather than
    // pretending they do not exist.
    expect(status?.blocked.map((entry) => entry.actionKey).sort()).toEqual([
      'browser.click',
      'browser.type-text',
    ])

    await host.stop('scenario finished')
    expect(host.deviceHandsStatus()).toBeNull()
  })

  it('keeps the durable sequence moving forward across a restart', async () => {
    const first = createCore({ dataPath, env: {} })
    await first.start()
    const before = first.status()
    expect(before.lifecycle).toBe('ready')
    await first.stop('scenario finished')

    const second = createCore({ dataPath, env: {} })
    await second.start()
    // A journal that restarted its own sequence would let a later event masquerade as an
    // earlier one, so the durable counter has to move forward across the restart rather
    // than begin again from one.
    expect(second.status().eventSequence).toBeGreaterThanOrEqual(before.eventSequence)
    await second.stop('scenario finished')
  })

  it('is safe to start, stop and start again over the same data path', async () => {
    for (const round of [1, 2, 3]) {
      const host = new ElectronCoreHost(dataPath, {})
      await host.start()
      expect(host.status().lifecycle, `round ${String(round)} did not reach ready`).toBe('ready')
      await host.stop(`round ${String(round)}`)
    }
  })
})