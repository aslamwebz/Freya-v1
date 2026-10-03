// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  capabilityRegistration,
  actionRegistration,
  validateAction,
  validateInput,
  getRisk,
  requiresApproval,
  actionTimeoutMs,
  unregisteredActions,
  capabilityMatrix,
  inputDepth,
  PHASE25_CAPABILITY_KINDS,
} from '../../../core/senses'

describe('registry.lookup', () => {
  it('returns a registration for a valid kind', () => {
    const registration = capabilityRegistration('browser')
    expect(registration).not.toBeNull()
    expect(registration?.kind).toBe('browser')
    expect(registration?.actions.length).toBeGreaterThan(0)
  })

  it('returns null for an invalid kind', () => {
    // @ts-expect-error deliberately outside the closed vocabulary
    expect(capabilityRegistration('telepathy')).toBeNull()
  })
})

describe('registry.validate-action', () => {
  it('returns true for a supported action', () => {
    expect(validateAction('browser', 'navigate')).toBe(true)
    expect(validateAction('terminal', 'command-execute')).toBe(true)
    expect(validateAction('clipboard', 'clipboard-write')).toBe(true)
    expect(validateAction('download', 'download-status')).toBe(true)
    expect(validateAction('upload', 'upload-start')).toBe(true)
  })

  it('returns false for an unsupported action', () => {
    expect(validateAction('browser', 'launch-missile')).toBe(false)
    expect(validateAction('clipboard', 'clipboard-format')).toBe(false)
  })
})

describe('registry.validate-input', () => {
  it('accepts valid input', () => {
    expect(validateInput('browser', 'navigate', { url: 'https://example.com' })).toEqual({ ok: true })
    expect(validateInput('clipboard', 'clipboard-read', {})).toEqual({ ok: true })
    expect(validateInput('terminal', 'command-execute', { command: 'echo hi', maxOutputBytes: 1024 })).toEqual({ ok: true })
  })

  it('rejects missing, extra, mistyped and out-of-bound input', () => {
    expect(validateInput('browser', 'navigate', {}).ok).toBe(false)
    expect(validateInput('browser', 'navigate', { url: 'https://x', extra: 1 }).ok).toBe(false)
    expect(validateInput('browser', 'navigate', { url: 42 }).ok).toBe(false)
    expect(validateInput('browser', 'navigate', { url: 'file:///etc/passwd' }).ok).toBe(false)
    expect(validateInput('browser', 'page-scroll', { direction: 'sideways', amount: 1 }).ok).toBe(false)
    expect(validateInput('terminal', 'command-execute', { command: 'x', maxOutputBytes: 0 }).ok).toBe(false)
    expect(validateInput('clipboard', 'clipboard-write', { content: 7 }).ok).toBe(false)
  })

  it('rejects an unsupported action outright', () => {
    expect(validateInput('browser', 'launch-missile', {}).ok).toBe(false)
  })
})

describe('registry.get-risk and get-approval', () => {
  it('returns the declared risk', () => {
    expect(getRisk('browser', 'read')).toBe('none')
    expect(getRisk('browser', 'navigate')).toBe('routine')
    expect(getRisk('terminal', 'command-run')).toBe('consequential')
    expect(getRisk('download', 'download-start')).toBe('consequential')
    expect(getRisk('browser', 'launch-missile')).toBeNull()
  })

  it('returns the declared approval requirement', () => {
    expect(requiresApproval('terminal', 'command-run')).toBe(true)
    expect(requiresApproval('download', 'download-start')).toBe(true)
    expect(requiresApproval('upload', 'upload-start')).toBe(true)
    expect(requiresApproval('browser', 'read')).toBe(false)
    expect(requiresApproval('clipboard', 'clipboard-read')).toBe(false)
  })

  it('returns the declared timeout', () => {
    expect(actionTimeoutMs('browser', 'navigate')).toBe(30_000)
    expect(actionTimeoutMs('terminal', 'command-run')).toBe(60_000)
    expect(actionTimeoutMs('download', 'download-start')).toBe(300_000)
    expect(actionTimeoutMs('browser', 'launch-missile')).toBeNull()
  })
})

describe('registry consistency', () => {
  it('registers every declared action and only known kinds', () => {
    expect(unregisteredActions()).toEqual([])
    for (const kind of PHASE25_CAPABILITY_KINDS) {
      const registration = capabilityRegistration(kind)
      expect(registration?.kind).toBe(kind)
    }
  })

  it('the capability matrix is the closed routed surface', () => {
    const rows = capabilityMatrix()
    expect(rows.length).toBe(8 + 3 + 2 + 3 + 3)
    for (const row of rows) {
      expect(validateAction(row.capabilityKind, row.action)).toBe(true)
    }
  })

  it('actionRegistration agrees with the table', () => {
    expect(actionRegistration('browser', 'navigate')?.inputFields).toEqual(['url'])
    expect(actionRegistration('browser', 'nope')).toBeNull()
  })
})

describe('inputDepth', () => {
  it('measures nesting depth', () => {
    expect(inputDepth(1)).toBe(0)
    expect(inputDepth({ a: 1 })).toBe(1)
    expect(inputDepth({ a: { b: 1 } })).toBe(2)
  })
})
