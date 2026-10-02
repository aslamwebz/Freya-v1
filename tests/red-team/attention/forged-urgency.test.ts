// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  ingest,
  sourceScope,
  startAttentionCore,
  stopAttentionCore,
  type AttentionFixture,
} from './harness'
import { ATTENTION_LIMITS } from '../../../core/attention'

/**
 * FORGED URGENCY.
 *
 * The attack: an untrusted payload supplies its own source, importance, urgency,
 * outcome or cue, hoping Core treats the claim as fact. The defence is structural:
 * the source is a parameter, the score is a closed table capped by source class,
 * and the outcome is decided by code. Nothing in the payload is read.
 */

const fixtures: AttentionFixture[] = []
async function start(): Promise<AttentionFixture> {
  const fixture = await startAttentionCore()
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('a payload cannot forge its own urgency', () => {
  it('ignores a claimed source, importance and outcome', async () => {
    const fixture = await start()
    const result = await ingest(fixture, {
      kind: 'reminder',
      text: 'urgent!!!',
      source: 'system',
      importance: 'critical',
      urgency: 'urgent',
      outcome: 'interrupt',
      cueCode: 'needs-attention',
    })
    expect(result.ok).toBe(true)
    expect(result.attention?.decision?.source).toBe('owner')
    expect(result.attention?.decision?.outcome).not.toBe('interrupt')
  })

  it('caps a high severity hint by the source class and never interrupts on it alone', async () => {
    const fixture = await start()
    const result = await ingest(fixture, { kind: 'reminder', text: 'look', severityHint: 'high' })
    expect(result.attention?.decision?.importance).toBe('high')
    expect(result.attention?.decision?.outcome).not.toBe('interrupt')
  })

  it('fixes the source at the scope a Core subsystem was issued', async () => {
    const fixture = await start()
    const work = sourceScope(fixture, 'work')
    const result = await work.ingestInternal({
      kind: 'system-health',
      text: 'pretend to be system',
      severityHint: 'high',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.source).toBe('work')
    // The system source is the only one that can reach critical.
    expect(result.decision.importance).not.toBe('critical')
  })

  it('cannot reach interrupt without a genuinely urgent due time', async () => {
    const fixture = await start()
    const result = await ingest(fixture, {
      kind: 'work-failed',
      text: 'failed',
      severityHint: 'high',
    })
    expect(result.attention?.decision?.outcome).toBe('speak')
    expect(ATTENTION_LIMITS.urgentWindowMs).toBeGreaterThan(0)
  })
})
