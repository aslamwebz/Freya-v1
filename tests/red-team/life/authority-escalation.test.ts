// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITIES, WORKER_CAPABILITIES } from '../../../core/protocol/core-protocol'
import { lifeOwnerScope } from '../../../core/testing'
import { entryDraft, startLifeCore, stopLifeCore, type LifeFixture } from './harness'

/**
 * AUTHORITY ESCALATION.
 *
 * The attack: a window or a worker reaches the owner scope, raises a confidence,
 * grants itself a capability or records an entry through a path other than Core.
 * The defences are structural: the capability is owner-only, a worker's vocabulary
 * has no Life entry, and the owner scope has no method that grants, approves,
 * executes, raises a confidence or reaches a model.
 */

const fixtures: LifeFixture[] = []
async function start(): Promise<LifeFixture> {
  const fixture = await startLifeCore()
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopLifeCore(fixture)
})

describe('life authority cannot be widened', () => {
  it('keeps the life read owner-only and out of the worker vocabulary', () => {
    expect(CAPABILITIES).toContain('life.status.read')
    expect(WORKER_CAPABILITIES).not.toContain('life.status.read')
    expect(WORKER_CAPABILITIES).toEqual(['cognition.request'])
  })

  it('exposes an owner scope with no granting, approving, executing or confidence-setting method', async () => {
    const fixture = await start()
    const scope = lifeOwnerScope(fixture.core) as unknown as Record<string, unknown>
    for (const forbidden of ['grant', 'approve', 'execute', 'setConfidence', 'promote', 'admit', 'delete']) {
      expect(typeof scope[forbidden]).not.toBe('function')
    }
    for (const allowed of ['record', 'consolidate', 'revise', 'withdraw']) {
      expect(typeof scope[allowed]).toBe('function')
    }
  })

  it('caps a confidence a caller tries to raise', async () => {
    const fixture = await start()
    const raised = await fixture.scope().record(
      entryDraft({
        derivation: 'inferred',
        confidence: 'verified',
        references: [{ domain: 'brain', refKind: 'memory', refId: 'm1', label: null }],
      }),
    )
    expect(raised.entry!.confidence).toBe('low')
  })

  it('does not let a worker reach the life commands', async () => {
    const fixture = await start()
    const worker = fixture.worker as unknown as Record<string, unknown>
    for (const forbidden of ['life', 'recordLife', 'lifeOwnerScope']) {
      expect(worker[forbidden]).toBeUndefined()
    }
  })
})
