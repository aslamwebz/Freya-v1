// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ingest, startAttentionCore, stopAttentionCore, submit, type AttentionFixture } from './harness'

/**
 * MODEL-CALL AMPLIFICATION.
 *
 * The attack: make attention evaluation spend cognition — directly or through a
 * "helpful" summariser — so a storm becomes a bill. Attention imports no gateway,
 * no provider and no cognition authority, and the whole evaluation path is code.
 * The fake provider's call count stays zero through any amount of traffic.
 */

const fixtures: AttentionFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('attention spends nothing', () => {
  it('makes no provider call for ingests, ticks or schedules', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const before = fixture.core.status().durableUsage
    for (let i = 0; i < 30; i += 1) {
      await ingest(fixture, { kind: 'deadline', text: `d ${i}`, dueAt: fixture.clock.now.toISOString() })
    }
    await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 's',
      dueAt: fixture.clock.now.toISOString(),
    })
    await fixture.core.attentionTick(fixture.clock.now)
    expect(fixture.fake.calls).toBe(0)
    expect(fixture.core.status().durableUsage).toEqual(before)
    expect(fixture.core.status().activeProviderCalls).toBe(0)
  })

  it('imports no gateway, provider or cognition authority anywhere in the domain', async () => {
    const files = ['types.ts', 'policy.ts', 'ingest.ts', 'state.ts', 'projection.ts', 'engine.ts']
    for (const file of files) {
      const source = await readFile(new URL(`../../../core/attention/${file}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/from '\.\.\/(model|cognition|authority)/)
      expect(source).not.toMatch(/\b(ModelGateway|ModelProvider|OwnerAuthority|WorkerAuthority)\b/)
      expect(source).not.toMatch(/cognition\.request/)
    }
  })
})
