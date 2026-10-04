import { describe, expect, it } from 'vitest'
import {
  createEvidenceRecord,
  isEvidenceSufficient,
  verifyEvidence,
  EVIDENCE_RETENTION,
  EVIDENCE_SOURCE_CEILING,
} from '../../../core/evolution'

const AT = '2026-06-01T09:00:00.000Z'

function evidenceInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidenceId: 'ev-1',
    source: 'work-run',
    quality: 'strong',
    statement: 'the run completed in 200ms',
    verifiedAt: AT,
    ...overrides,
  }
}

function evidence(overrides: Record<string, unknown> = {}) {
  const created = createEvidenceRecord(evidenceInput(overrides))
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  return created.value
}

describe('evidence is verified', () => {
  it('creates an evidence record with a derived expiry', () => {
    const record = evidence()
    expect(record.evidenceId).toBe('ev-1')
    expect(record.source).toBe('work-run')
    expect(record.quality).toBe('strong')
    expect(record.verifiedAt).toBe(AT)
    expect(record.expiresAt).toBe(
      new Date(Date.parse(AT) + EVIDENCE_RETENTION.maxEvidenceLifetimeMs).toISOString(),
    )
  })

  it('verifies evidence that is fresh and sufficient', () => {
    const record = evidence()
    const result = verifyEvidence(record, AT)
    expect(result.outcome).toBe('verified')
  })

  it('refuses evidence that has expired', () => {
    const record = evidence()
    const past = new Date(Date.parse(AT) + EVIDENCE_RETENTION.maxEvidenceLifetimeMs + 1_000).toISOString()
    const result = verifyEvidence(record, past)
    expect(result.outcome).toBe('expired')
  })

  it('refuses evidence that is insufficient or weak', () => {
    for (const quality of ['insufficient', 'weak'] as const) {
      const record = evidence({ quality })
      const result = verifyEvidence(record, AT)
      expect(result.outcome).toBe('insufficient')
    }
  })

  it('is deterministic: same evidence + same clock = same verification', () => {
    const record = evidence()
    const a = verifyEvidence(record, AT)
    const b = verifyEvidence(record, AT)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('evidence quality is assessed', () => {
  it('caps quality at the source ceiling', () => {
    for (const [source, ceiling] of Object.entries(EVIDENCE_SOURCE_CEILING)) {
      expect(ceiling).toBeDefined()
      const above = createEvidenceRecord(evidenceInput({ source, quality: 'verified' }))
      if (ceiling === 'verified') {
        expect(above.ok).toBe(true)
      } else {
        expect(above.ok).toBe(false)
        expect(above.ok === false && above.code).toBe('invalid-quality')
      }
    }
  })

  it('refuses a quality above the source ceiling', () => {
    const result = createEvidenceRecord(evidenceInput({ source: 'system-health', quality: 'verified' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-quality')
  })

  it('accepts a quality at or below the source ceiling', () => {
    const result = createEvidenceRecord(evidenceInput({ source: 'work-run', quality: 'verified' }))
    expect(result.ok).toBe(true)
  })
})

describe('evidence is bounded', () => {
  it('refuses a statement that is too long', () => {
    const result = createEvidenceRecord(evidenceInput({ statement: 'x'.repeat(1_001) }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-statement')
  })

  it('refuses an evidenceId that is not a bounded ref', () => {
    const result = createEvidenceRecord(evidenceInput({ evidenceId: '' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-id')
  })

  it('refuses an unknown source', () => {
    const result = createEvidenceRecord(evidenceInput({ source: 'unknown-source' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-source')
  })

  it('refuses an unknown quality', () => {
    const result = createEvidenceRecord(evidenceInput({ quality: 'unknown-quality' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-quality')
  })

  it('refuses a malformed verifiedAt', () => {
    const result = createEvidenceRecord(evidenceInput({ verifiedAt: 'not-a-date' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-instant')
  })
})

describe('evidence is never fabricated', () => {
  it('refuses a payload with extra keys', () => {
    const result = createEvidenceRecord({ ...evidenceInput(), extra: 'value' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('key-set-mismatch')
  })

  it('refuses a non-object payload', () => {
    const result = createEvidenceRecord('not-an-object')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('not-an-object')
  })

  it('refuses a payload with a forbidden field', () => {
    const result = createEvidenceRecord({ ...evidenceInput(), capability: 'grant' })
    expect(result.ok).toBe(false)
  })
})

describe('evidence sufficiency', () => {
  it('is sufficient with one moderate piece of evidence', () => {
    const record = evidence({ quality: 'moderate' })
    const result = isEvidenceSufficient([record], AT)
    expect(result.sufficient).toBe(true)
  })

  it('is insufficient with no evidence', () => {
    const result = isEvidenceSufficient([], AT)
    expect(result.sufficient).toBe(false)
  })

  it('is insufficient with only weak evidence', () => {
    const record = evidence({ quality: 'weak' })
    const result = isEvidenceSufficient([record], AT)
    expect(result.sufficient).toBe(false)
  })

  it('is insufficient when all evidence is expired', () => {
    const record = evidence()
    const past = new Date(Date.parse(AT) + EVIDENCE_RETENTION.maxEvidenceLifetimeMs + 1_000).toISOString()
    const result = isEvidenceSufficient([record], past)
    expect(result.sufficient).toBe(false)
  })
})
