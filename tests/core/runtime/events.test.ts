import { describe, expect, it } from 'vitest'
import { validateDurableEvent } from '../../../core/events/validate'
import { isSecurityEvent } from '../../../core/events/envelope'
import { describeActivity } from '../../../core/protocol/activity'
import { RUNTIME_EVENT_TYPES } from '../../../core/runtime'

function envelope(type: string, payload: Record<string, unknown>) {
  return {
    eventId: 'runtime-evt-1',
    sequence: 1,
    type,
    schemaVersion: 1,
    occurredAt: '2026-04-01T09:00:00.000Z',
    source: 'core',
    actor: 'system',
    correlationId: 'corr-1',
    causationId: null,
    payload,
  }
}

describe('the runtime activation event family', () => {
  it('validates a well-formed decision', () => {
    const result = validateDurableEvent(
      envelope('runtime.activation.decided', {
        domainId: 'core.device-hands',
        outcome: 'blocked',
        status: 'blocked',
        reason: 'missing required dependency: the Device Hands host adapter',
        missing: ['the Device Hands host adapter'],
        requestedAt: '2026-04-01T09:00:00.000Z',
      }),
      0,
    )
    expect(result.ok).toBe(true)
  })

  it('refuses an extra field on a decision', () => {
    const result = validateDurableEvent(
      envelope('runtime.activation.decided', {
        domainId: 'core.work',
        outcome: 'allowed',
        status: 'active',
        reason: 'owned and running under this Core',
        missing: [],
        requestedAt: '2026-04-01T09:00:00.000Z',
        secret: 'a hidden field',
      }),
      0,
    )
    expect(result.ok).toBe(false)
  })

  it('refuses an unknown status', () => {
    const result = validateDurableEvent(
      envelope('runtime.activation.changed', {
        domainId: 'core.work',
        from: 'active',
        to: 'exploded',
        reason: 'x',
        missing: [],
      }),
      0,
    )
    expect(result.ok).toBe(false)
  })

  it('keeps every runtime event out of the security stream', () => {
    for (const type of RUNTIME_EVENT_TYPES) {
      expect(isSecurityEvent(type), type).toBe(false)
    }
  })

  it('adds no row to the activity feed', () => {
    for (const type of RUNTIME_EVENT_TYPES) {
      const row = describeActivity({
        type,
        sequence: 1,
        at: Date.parse('2026-04-01T09:00:00.000Z'),
        payload: {
          domainId: 'core.work',
          outcome: 'allowed',
          status: 'active',
          from: 'active',
          to: 'active',
          reason: 'x',
          missing: [],
          requestedAt: '2026-04-01T09:00:00.000Z',
        },
      })
      expect(row, type).toBeNull()
    }
  })
})
