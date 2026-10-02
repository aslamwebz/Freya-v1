import { describe, expect, it } from 'vitest'
import {
  hasExactKeys,
  isSupportedCapabilityKind,
  validateActionEnvelope,
} from '../../../core/hands/validation'

describe('hasExactKeys', () => {
  it('returns true for exact match', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true)
  })

  it('returns false for extra keys', () => {
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false)
  })

  it('returns false for missing keys', () => {
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
  })

  it('returns false for empty object with non-empty keys', () => {
    expect(hasExactKeys({}, ['a'])).toBe(false)
  })

  it('returns true for empty object with empty keys', () => {
    expect(hasExactKeys({}, [])).toBe(true)
  })
})

describe('validateActionEnvelope', () => {
  const validEnvelope = {
    actionId: 'action-1',
    capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1' },
    action: 'navigate',
    input: { url: 'https://example.com' },
    timeoutMs: 5000,
    correlationId: 'corr-1',
  }

  it('accepts a valid envelope', () => {
    const result = validateActionEnvelope(validEnvelope)
    expect(result.ok).toBe(true)
  })

  it('rejects non-object envelopes', () => {
    expect(validateActionEnvelope(null).ok).toBe(false)
    expect(validateActionEnvelope(42).ok).toBe(false)
    expect(validateActionEnvelope('string').ok).toBe(false)
    expect(validateActionEnvelope([]).ok).toBe(false)
  })

  it('rejects envelopes with extra keys', () => {
    const hostile = { ...validEnvelope, extra: 'field' }
    const result = validateActionEnvelope(hostile)
    expect(result.ok).toBe(false)
  })

  it('rejects envelopes with missing keys', () => {
    const { correlationId: _omit, ...missing } = validEnvelope
    const result = validateActionEnvelope(missing)
    expect(result.ok).toBe(false)
  })

  it('rejects envelopes with extra keys in capabilityRef', () => {
    const hostile = {
      ...validEnvelope,
      capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1', extra: 'field' },
    }
    const result = validateActionEnvelope(hostile)
    expect(result.ok).toBe(false)
  })

  it('rejects envelopes with missing keys in capabilityRef', () => {
    const hostile = {
      ...validEnvelope,
      capabilityRef: { capabilityId: 'cap-browser' },
    }
    const result = validateActionEnvelope(hostile)
    expect(result.ok).toBe(false)
  })

  it('rejects invalid actionId', () => {
    const hostile = { ...validEnvelope, actionId: '' }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects invalid action name', () => {
    const hostile = { ...validEnvelope, action: '' }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects invalid timeout', () => {
    const hostile = { ...validEnvelope, timeoutMs: -1 }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects timeout exceeding the ceiling', () => {
    const hostile = { ...validEnvelope, timeoutMs: 999_999_999 }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects non-object input', () => {
    const hostile = { ...validEnvelope, input: 'not-an-object' }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects input with too many fields', () => {
    const input: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) input[`field${i}`] = i
    const hostile = { ...validEnvelope, input }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects input with invalid field names', () => {
    const hostile = { ...validEnvelope, input: JSON.parse('{"__proto__": "polluted"}') }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects input with nested objects', () => {
    const hostile = { ...validEnvelope, input: { nested: { deep: true } } }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('rejects input with non-finite numbers', () => {
    const hostile = { ...validEnvelope, input: { value: Infinity } }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })

  it('accepts input with null values', () => {
    const envelope = { ...validEnvelope, input: { value: null } }
    expect(validateActionEnvelope(envelope).ok).toBe(true)
  })

  it('accepts input with boolean values', () => {
    const envelope = { ...validEnvelope, input: { value: true } }
    expect(validateActionEnvelope(envelope).ok).toBe(true)
  })

  it('accepts input with finite numbers', () => {
    const envelope = { ...validEnvelope, input: { value: 42 } }
    expect(validateActionEnvelope(envelope).ok).toBe(true)
  })

  it('accepts optional fields being null', () => {
    const envelope = { ...validEnvelope, timeoutMs: null, correlationId: null }
    expect(validateActionEnvelope(envelope).ok).toBe(true)
  })

  it('rejects invalid correlationId', () => {
    const hostile = { ...validEnvelope, correlationId: 42 }
    expect(validateActionEnvelope(hostile).ok).toBe(false)
  })
})

describe('isSupportedCapabilityKind', () => {
  it('returns true for supported kinds', () => {
    expect(isSupportedCapabilityKind('browser')).toBe(true)
    expect(isSupportedCapabilityKind('desktop')).toBe(true)
  })

  it('returns false for unsupported kinds', () => {
    expect(isSupportedCapabilityKind('unknown')).toBe(false)
    expect(isSupportedCapabilityKind('')).toBe(false)
  })
})
