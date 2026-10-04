import { describe, expect, it } from 'vitest'
import { classifyThresholdClaim, forbiddenKeysIn, REFUSAL_REASONS } from '../../../core/threshold/prohibition'
import { validateThresholdWake, wakeRefusalReason } from '../../../core/threshold/wake'
import type { ThresholdRefusalCode } from '../../../core/threshold/types'
import type { ThresholdWakeRefusalCode } from '../../../core/threshold/types'
import { T0 } from './harness'

/**
 * Fail-closed conditions.
 */

describe('claim classification', () => {
  it('allows a clean claim', () => {
    const scan = classifyThresholdClaim({ dimension: 'autonomy', level: 'developing' })
    expect(scan.prohibited).toBe(false)
  })

  it('prohibits a claim with a forbidden key', () => {
    const scan = classifyThresholdClaim({ dimension: 'autonomy', realMoney: true })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) {
      expect(scan.code).toBe('authority-claim-prohibited')
    }
  })

  it('prohibits a claim with a capability key', () => {
    const scan = classifyThresholdClaim({ capability: 'work.execute' })
    expect(scan.prohibited).toBe(true)
  })

  it('prohibits a claim with a grant key', () => {
    const scan = classifyThresholdClaim({ grant: 'g-1' })
    expect(scan.prohibited).toBe(true)
  })

  it('prohibits a claim with a self-modification key', () => {
    const scan = classifyThresholdClaim({ selfModify: true })
    expect(scan.prohibited).toBe(true)
  })

  it('prohibits a claim with a maturity self-grant key', () => {
    const scan = classifyThresholdClaim({ selfGrantMaturity: true })
    expect(scan.prohibited).toBe(true)
  })

  it('prohibits a claim with a maturity authority widening key', () => {
    const scan = classifyThresholdClaim({ maturityWidensAuthority: true })
    expect(scan.prohibited).toBe(true)
  })

  it('prohibits a claim with an evidence fabrication key', () => {
    const scan = classifyThresholdClaim({ fabricateEvidence: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('forbidden keys', () => {
  it('finds forbidden keys in a payload', () => {
    const keys = forbiddenKeysIn({ capability: 'work.execute', dimension: 'autonomy' })
    expect(keys).toEqual(['capability'])
  })

  it('returns empty for a clean payload', () => {
    const keys = forbiddenKeysIn({ dimension: 'autonomy', level: 'developing' })
    expect(keys).toEqual([])
  })
})

describe('refusal reasons', () => {
  it('has a reason for every refusal code', () => {
    const codes: readonly ThresholdRefusalCode[] = [
      'journal-not-trustworthy',
      'stop-all-active',
      'threshold-disabled',
      'guard-denied',
      'governor-denied',
      'budget-exhausted',
      'approval-required',
      'real-money-prohibited',
      'real-order-prohibited',
      'spending-authority-prohibited',
      'capability-widening-prohibited',
      'grant-creation-prohibited',
      'self-approval-prohibited',
      'priority-escalation-prohibited',
      'budget-widening-prohibited',
      'authority-claim-prohibited',
      'polling-prohibited',
      'inference-without-wake-prohibited',
      'state-fabrication-prohibited',
      'silent-resume-prohibited',
      'self-modification-prohibited',
      'evidence-fabrication-prohibited',
      'maturity-self-grant-prohibited',
      'maturity-authority-widening-prohibited',
    ]
    for (const code of codes) {
      expect(REFUSAL_REASONS[code]).toBeDefined()
    }
  })
})

describe('wake validation', () => {
  const context = {
    now: T0,
    stopAllActive: false,
    journalTrustworthy: true,
    processedWakeKeys: [],
    busy: false,
    closed: false,
  }

  it('accepts a valid wake', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: T0 },
      'w-1',
      context,
    )
    expect(result.outcome).toBe('accepted')
  })

  it('denies an unknown source', () => {
    const result = validateThresholdWake(
      { source: 'unknown-source', kind: 'system-health', actor: 'core-subsystem', occurredAt: T0 },
      'w-1',
      context,
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('unknown-source')
    }
  })

  it('denies an unknown kind', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'unknown-kind', actor: 'core-subsystem', occurredAt: T0 },
      'w-1',
      context,
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('unknown-kind')
    }
  })

  it('denies a kind-source mismatch', () => {
    const result = validateThresholdWake(
      { source: 'owner-interaction', kind: 'system-health', actor: 'owner', occurredAt: T0 },
      'w-1',
      context,
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('kind-source-mismatch')
    }
  })

  it('denies an unauthorized actor', () => {
    const result = validateThresholdWake(
      { source: 'owner-interaction', kind: 'owner-message', actor: 'model', occurredAt: T0 },
      'w-1',
      context,
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('unauthorized-actor')
    }
  })

  it('denies a missing wake id', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: T0 },
      '',
      context,
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('missing-wake-id')
    }
  })

  it('denies a malformed timestamp', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: 'not-a-date' },
      'w-1',
      context,
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('malformed-timestamp')
    }
  })

  it('denies an observed-before-occurred wake', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: '2026-03-02T09:00:00.000Z' },
      'w-1',
      context,
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('observed-before-occurred')
    }
  })

  it('denies a duplicate wake', () => {
    const wake = { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: T0 }
    const first = validateThresholdWake(wake, 'w-1', context)
    expect(first.outcome).toBe('accepted')
    if (first.outcome !== 'accepted') throw new Error('first wake should be accepted')
    const second = validateThresholdWake(wake, 'w-2', { ...context, processedWakeKeys: [first.wakeKey] })
    expect(second.outcome).toBe('denied')
    if (second.outcome === 'denied') {
      expect(second.code).toBe('duplicate-wake')
    }
  })

  it('denies when STOP ALL is active', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: T0 },
      'w-1',
      { ...context, stopAllActive: true },
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('stop-all-active')
    }
  })

  it('denies when the journal is not trustworthy', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: T0 },
      'w-1',
      { ...context, journalTrustworthy: false },
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('journal-not-trustworthy')
    }
  })

  it('denies when the runtime is closed', () => {
    const result = validateThresholdWake(
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', occurredAt: T0 },
      'w-1',
      { ...context, closed: true },
    )
    expect(result.outcome).toBe('denied')
    if (result.outcome === 'denied') {
      expect(result.code).toBe('runtime-closed')
    }
  })
})

describe('wake refusal reasons', () => {
  it('has a reason for every wake refusal code', () => {
    const codes: readonly ThresholdWakeRefusalCode[] = [
      'unknown-source',
      'unknown-kind',
      'kind-source-mismatch',
      'unauthorized-actor',
      'missing-wake-id',
      'malformed-timestamp',
      'observed-before-occurred',
      'stop-all-active',
      'journal-not-trustworthy',
      'duplicate-wake',
      'runtime-busy',
      'runtime-closed',
      'polling-prohibited',
    ]
    for (const code of codes) {
      expect(wakeRefusalReason(code)).toBeDefined()
    }
  })
})
