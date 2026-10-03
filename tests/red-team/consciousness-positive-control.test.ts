// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { RED_TEAM_SENTINELS, startRedTeamCore, stopRedTeamCore, type RedTeamCore } from './harness'

/**
 * RED-TEAM: the positive control for the Phase 20 leakage family.
 *
 * A leak test asserts an *absence*, and an absence assertion passes for the wrong
 * reason more easily than any other kind of test: if the fixture failed to plant
 * anything, the sweep finds nothing, and the test reports a clean boundary that
 * was never tested.
 *
 * So this file plants the same sentinels by the same calls and then proves each
 * one is genuinely readable from the private channel it was planted in — and
 * genuinely absent from the conscious context. If a plant breaks, *this* file
 * fails, and the failure names which channel went quiet.
 */

let fixture: RedTeamCore | null = null

const AT = new Date('2026-10-03T12:00:00.000Z')

async function plant(): Promise<void> {
  const f = fixture
  if (f === null) throw new Error('no fixture')
  await f.core.handleCommand({
    command: 'brain.memory.write',
    requestId: 'plant-memory',
    payload: {
      kind: 'semantic',
      subject: `about ${RED_TEAM_SENTINELS[0]}`,
      content: `the value is ${RED_TEAM_SENTINELS[1]} and it matters`,
      source: 'owner-assertion',
      confidence: 'high',
    },
  })
}

beforeEach(async () => {
  fixture = await startRedTeamCore()
})

afterEach(async () => {
  await stopRedTeamCore(fixture)
  fixture = null
})

describe('the positive control: the sentinel really is in Core', () => {
  it('is readable from the Brain, which is the private channel it was planted in', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    await plant()

    // Read it back the way the owner would, deliberately. If this returns nothing,
    // the plant silently failed and every absence assertion below is vacuous.
    const recalled = f.core.brain().recentAdmissions
    const serialised = JSON.stringify(recalled)
    expect(serialised.includes(RED_TEAM_SENTINELS[0]), 'the subject was not planted').toBe(true)
    expect(recalled.length, 'no memory was admitted at all').toBeGreaterThan(0)
  })

  it('is absent from the conscious context, having been proven present in the Brain', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    await plant()

    // Both halves in one test, in this order, so the precondition is visible.
    expect(JSON.stringify(f.core.brain().recentAdmissions)).toContain(RED_TEAM_SENTINELS[0])
    expect(JSON.stringify(f.core.consciousness(AT))).not.toContain(RED_TEAM_SENTINELS[0])
  })

  it('still admits the memory, so the boundary did not work by refusing to learn', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    await plant()
    const snapshot = f.core.consciousness(AT)
    // The point of the boundary is that Freya *can* hold something private and
    // still describe her situation honestly. A snapshot that reported zero
    // memories because it refused to show them would pass the leak test and fail
    // the product.
    expect(snapshot.continuity.state).toBe('available')
    expect(snapshot.continuity.listed).toBeGreaterThan(0)
    expect(snapshot.continuity.items[0]?.subjectLength).toBeGreaterThan(0)
  })
})