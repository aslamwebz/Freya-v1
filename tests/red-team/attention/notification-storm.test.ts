// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  ingest,
  startAttentionCore,
  stopAttentionCore,
  type AttentionFixture,
} from './harness'
import {
  ATTENTION_LIMITS,
  decideAttention,
  initialAttentionState,
  recentDecisions,
  reduceAttention,
} from '../../../core/attention'
import type { AnyCoreEvent } from '../../../core/events/envelope'

/**
 * NOTIFICATION STORMS.
 *
 * The attack: flood Core with urgent events so that many interrupts escape. The
 * defence is a rolling per-source ingest limit and a code-owned interruption
 * budget across all sources, per source and per goal. A storm should produce a
 * bounded number of expressive outcomes and a great many `do-nothing`s.
 */

const fixtures: AttentionFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('a storm cannot become a stream of interruptions', () => {
  it('caps interrupts and speaks within the rolling window', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const urgent = new Date(fixture.clock.now.getTime() + 1_000).toISOString()
    for (let i = 0; i < 40; i += 1) {
      await ingest(fixture, { kind: 'deadline', text: `deadline ${i}`, dueAt: urgent })
    }
    const counts = fixture.core.attention().counts
    expect(counts.interrupted).toBeLessThanOrEqual(ATTENTION_LIMITS.maxInterruptsPerWindow)
    expect(counts.spoke).toBeLessThanOrEqual(ATTENTION_LIMITS.maxSpeaksPerWindowPerSource)
    // Most of a storm is refused or demoted, not escalated.
    expect(counts.doNothing + counts.remembered).toBeGreaterThan(30)
  })

  it('rate-limits a source that floods the ingest window', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const reminder = 'please look'
    let lastReason = ''
    for (let i = 0; i <= ATTENTION_LIMITS.maxIngestPerWindowPerSource; i += 1) {
      const result = await ingest(fixture, { kind: 'reminder', text: `${reminder} ${i}` })
      lastReason = result.attention?.decision?.reason ?? ''
    }
    expect(lastReason).toBe('rate-limit')
  })

  it('a flood of journalled refusals cannot evict the history the budget is measured against', () => {
    // The engine journals an `attention.decision.made` for every ingest, including
    // the rate-limited `do-nothing`s a flood produces. This attack feeds that
    // exact durable stream to the fold the real policy reads: if the refusals
    // crowded out the one interrupt decision, the cooldown and per-source budget
    // would be forgotten inside their own window and the next fire would
    // interrupt again.
    const NOW = new Date('2026-10-02T09:00:00.000Z')
    const at = NOW.toISOString()
    let seq = 0
    const durable = (type: string, payload: Record<string, unknown>): AnyCoreEvent => {
      seq += 1
      return {
        eventId: `rt-${seq}`,
        sequence: seq,
        type,
        schemaVersion: 1,
        occurredAt: at,
        source: 'system',
        actor: 'system',
        correlationId: `rt-c${seq}`,
        causationId: null,
        payload,
      } as unknown as AnyCoreEvent
    }

    let state = initialAttentionState()
    state = reduceAttention(
      state,
      durable('attention.event.ingested', {
        eventId: 'fire-1',
        dedupeKey: 'sch-1:1',
        source: 'system',
        kind: 'reminder',
        goalRef: null,
        textLength: 6,
        severityHint: 'none',
        occurredAt: at,
        dueAt: at,
      }),
    )
    state = reduceAttention(
      state,
      durable('attention.decision.made', {
        decisionId: 'd-1',
        eventId: 'fire-1',
        source: 'system',
        kind: 'reminder',
        goalRef: null,
        outcome: 'interrupt',
        importance: 'normal',
        urgency: 'urgent',
        reason: 'scheduled',
        cueCode: 'gentle-nudge',
        focus: 'available',
      }),
    )

    for (let i = 0; i < 300; i += 1) {
      state = reduceAttention(
        state,
        durable('attention.event.ingested', {
          eventId: `f-${i}`,
          dedupeKey: `f-${i}`,
          source: 'owner',
          kind: 'reminder',
          goalRef: null,
          textLength: 5,
          severityHint: 'none',
          occurredAt: at,
          dueAt: null,
        }),
      )
      state = reduceAttention(
        state,
        durable('attention.decision.made', {
          decisionId: `fd-${i}`,
          eventId: `f-${i}`,
          source: 'owner',
          kind: 'reminder',
          goalRef: null,
          outcome: 'do-nothing',
          importance: 'normal',
          urgency: 'normal',
          reason: 'rate-limit',
          cueCode: null,
          focus: 'available',
        }),
      )
    }

    const result = decideAttention({
      event: {
        eventId: 'fire-2',
        source: 'system',
        kind: 'reminder',
        goalRef: null,
        sourceRef: 'sch-1:2',
        text: 'again',
        severityHint: 'none',
        occurredAt: at,
        observedAt: at,
        dueAt: at,
      },
      now: NOW,
      focus: 'available',
      stopAll: false,
      recentDecisions: recentDecisions(state).map((record) => ({
        source: record.source,
        goalRef: record.goalRef,
        outcome: record.outcome,
        at: record.decidedAt,
      })),
      recentIngests: state.ingests,
      scheduled: true,
    })
    expect(result.outcome).toBe('remember')
    expect(result.reason).toBe('cooldown')
  })
})
