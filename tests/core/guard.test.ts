// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DefaultGuard,
  isCapability,
  isPrincipalId,
  ownerPrincipal,
  systemPrincipal,
  workerPrincipal,
  type Principal,
} from '../../core/security/guard'
import { CAPABILITIES, type Capability } from '../../core/protocol/core-protocol'

const owner = ownerPrincipal([...CAPABILITIES])
const weakOwner = ownerPrincipal([])
const nobody = systemPrincipal([])

describe('capability vocabulary', () => {
  it('is closed and typed', () => {
    expect(CAPABILITIES).toContain('core.status.read')
    expect(CAPABILITIES).toContain('security.stop')
    expect(CAPABILITIES).toContain('security.resume')
  })

  it('does not contain a capability that would let a model or worker self-grant', () => {
    // There is deliberately no `grant.create`, `capability.mint`, `policy.write`
    // or anything a provider response could reach.
    const dangerous = CAPABILITIES.filter((c) =>
      /grant|mint|policy|privilege|escalat/i.test(c),
    )
    // `cognition.grant.manage` is the owner's authority and is deliberately
    // not something a worker or a model ever holds.
    expect(dangerous).toEqual(['cognition.grant.manage'])
  })

  it('rejects unknown capability strings', () => {
    expect(isCapability('core.status.read')).toBe(true)
    expect(isCapability('core.everything')).toBe(false)
    expect(isCapability(undefined)).toBe(false)
    expect(isCapability(42)).toBe(false)
  })
})

describe('principal identity', () => {
  it('recognises owner and system', () => {
    expect(isPrincipalId('owner')).toBe(true)
    expect(isPrincipalId('system')).toBe(true)
  })

  it('recognises future-compatible scoped identities', () => {
    expect(isPrincipalId('agent:smith')).toBe(true)
    expect(isPrincipalId('module:vault')).toBe(true)
    expect(isPrincipalId('agent:')).toBe(false)
    expect(isPrincipalId('agent:a/b')).toBe(false)
    expect(isPrincipalId('root')).toBe(false)
    expect(isPrincipalId('')).toBe(false)
    expect(isPrincipalId(null)).toBe(false)
  })
})

describe('DefaultGuard — deny by default', () => {
  const guard = new DefaultGuard()

  it('denies a principal that holds nothing', () => {
    const verdict = guard.evaluate(nobody, 'core.status.read')
    expect(verdict.allowed).toBe(false)
    expect(verdict).toMatchObject({ outcome: 'deny' })
  })

  it('allows a capability the principal holds', () => {
    expect(guard.evaluate(owner, 'core.status.read')).toEqual({ allowed: true })
  })

  it('denies a capability the principal does not hold', () => {
    const verdict = guard.evaluate(weakOwner, 'security.stop')
    expect(verdict.allowed).toBe(false)
    expect(verdict).toMatchObject({ outcome: 'deny', reason: expect.stringContaining('does not hold') })
  })

  it('denies a capability outside the vocabulary', () => {
    const principal: Principal = ownerPrincipal(['root' as Capability])
    const verdict = guard.evaluate(principal, 'root' as Capability)
    expect(verdict).toMatchObject({ allowed: false, outcome: 'deny' })
  })

  it('denies every capability to an untrusted principal, whatever it claims', () => {
    const liar = workerPrincipal('impostor', [...CAPABILITIES])
    expect(liar.trusted).toBe(false)
    for (const capability of CAPABILITIES) {
      expect(guard.evaluate(liar, capability).allowed).toBe(false)
    }
  })

  it('never grants a worker the ability to govern grants', () => {
    const worker = workerPrincipal('smith', [...CAPABILITIES])
    expect(guard.evaluate(worker, 'cognition.grant.manage').allowed).toBe(false)
  })

  it('can express APPROVAL_REQUIRED without pretending a workflow exists', () => {
    const cautious = new DefaultGuard(new Set<Capability>(['cognition.request']))
    const verdict = cautious.evaluate(weakOwner, 'cognition.request')
    expect(verdict).toMatchObject({ allowed: false, outcome: 'approval_required' })
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('no approval workflow exists')
    }
  })

  it('honours an explicitly denied capability even when it is held', () => {
    const paranoid = new DefaultGuard(new Set(), new Set<Capability>(['security.resume']))
    expect(paranoid.evaluate(owner, 'security.resume').allowed).toBe(false)
  })

  it('answers holds() consistently with evaluate()', () => {
    expect(guard.holds(owner, 'core.status.read')).toBe(true)
    expect(guard.holds(weakOwner, 'core.status.read')).toBe(false)
    expect(guard.holds(nobody, 'core.status.read')).toBe(false)
  })
})
