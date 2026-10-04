import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_ENTERPRISE_ACTIONS,
  REAL_MONEY_ACTIONS,
  authorizeEnterpriseAction,
  checkForbiddenAction,
  domainAllowed,
} from '../../../core/enterprise'
import { actionRequest, boundaries, passingContext } from './harness'

/**
 * The absolute deny list, tested as the thing that makes "no real money" a property of
 * the code rather than a statement in a document.
 *
 * Every case here is one an implementation could plausibly get wrong. The point of the
 * file is that the refusals come out of the *same* union regardless of which shape the
 * attempt arrives in — that is what "cannot be widened" means when someone is actively
 * trying to widen it.
 */

describe('the real-money actions are refused in every shape an attempt can take', () => {
  for (const action of REAL_MONEY_ACTIONS) {
    it(`refuses a request that names ${action} as what it is doing`, () => {
      const decision = authorizeEnterpriseAction(
        passingContext(),
        actionRequest({ claimsAction: action }),
      )
      expect(decision.allowed).toBe(false)
      expect(decision.refusedAt).toBe('boundary')
      expect(decision.code).toBe('forbidden-action')
    })

    it(`refuses ${action} even when the environment forbids nothing else`, () => {
      const verdict = checkForbiddenAction(action, boundaries())
      expect(verdict.held).toBe(false)
      expect(verdict.code).toBe('forbidden-action')
    })
  }

  it('refuses them whatever the payload, target or amount', () => {
    // Same action, wildly different request shape. The refusal must not vary.
    const shapes = [
      actionRequest({ claimsAction: 'real-money-transfer' }),
      actionRequest({ claimsAction: 'real-money-transfer', amountMinor: 0, target: 'https://example.com/pay' }),
      actionRequest({ claimsAction: 'real-money-transfer', consequential: true, amountMinor: 1 }),
      actionRequest({ claimsAction: 'real-money-transfer', kind: 'query' }),
      actionRequest({ claimsAction: 'real-money-transfer', kind: 'delete', payload: 'x'.repeat(1000) }),
    ]
    for (const shape of shapes) {
      const decision = authorizeEnterpriseAction(passingContext(), shape)
      expect(decision.allowed, String(shape.claimsAction)).toBe(false)
      expect(decision.code, String(shape.claimsAction)).toBe('forbidden-action')
    }
  })
})

describe('the whole deny list is refused, not just the money ones', () => {
  for (const action of FORBIDDEN_ENTERPRISE_ACTIONS) {
    it(`refuses ${action}`, () => {
      const decision = authorizeEnterpriseAction(passingContext(), actionRequest({ claimsAction: action }))
      expect(decision.code).toBe('forbidden-action')
    })
  }
})

describe('a well-formed action is not mistaken for a forbidden one', () => {
  it('lets an ordinary publish through the deny check', () => {
    const decision = authorizeEnterpriseAction(passingContext(), actionRequest({ claimsAction: 'publish' }))
    expect(decision.allowed).toBe(true)
  })

  it('lets a request that names nothing at all through the deny check', () => {
    // The common case. A check so eager it refuses everything protects nothing,
    // because it gets switched off.
    expect(authorizeEnterpriseAction(passingContext(), actionRequest({ claimsAction: null })).allowed).toBe(true)
  })

  it('does not widen when handed a non-string claim', () => {
    // A nonsense claim is not a permission. It is simply not a forbidden action, and
    // the rest of the boundary gate still applies.
    for (const claim of [42, {}, [], true, undefined]) {
      const verdict = checkForbiddenAction(claim, boundaries())
      expect(verdict.held, String(claim)).toBe(true)
    }
  })

  it('still refuses a money claim that arrives as a non-string-shaped lie', () => {
    // Case matters not at all: the check is exact-string membership, so a clever
    // spelling is simply a different action — and a different action is still checked.
    const verdict = checkForbiddenAction('Real-Money-Transfer', boundaries())
    expect(verdict.held).toBe(true)
    expect(checkForbiddenAction('real-money-transfer', boundaries()).held).toBe(false)
  })
})

describe('the owner can add a denial, and cannot add a permission', () => {
  it('refuses an action the owner forbade for this environment', () => {
    const verdict = checkForbiddenAction('custom-forbidden-thing', boundaries())
    expect(verdict.held).toBe(false)
  })

  it('refuses a forbidden action even when the owner never listed it', () => {
    const bare = { ...boundaries(), forbiddenActions: [] }
    expect(checkForbiddenAction('self-approve', bare).held).toBe(false)
  })
})

describe('the domain allowlist matches on label boundaries, not on suffixes', () => {
  const allowed = ['example.com', '*.example.com']

  it('allows an exact host and its subdomains', () => {
    for (const target of [
      'https://example.com/',
      'https://www.example.com/page',
      'http://shop.example.com/thing',
    ]) {
      expect(domainAllowed(target, allowed), target).toBe(true)
    }
  })

  it('refuses a host that merely ends with the allowed suffix', () => {
    // `endsWith('example.com')` is how an allowlist stops being one.
    for (const target of [
      'https://notexample.com/',
      'https://evil-example.com/',
      'https://example.com.evil.test/',
    ]) {
      expect(domainAllowed(target, allowed), target).toBe(false)
    }
  })

  it('refuses a target that smuggles the allowed host somewhere other than the host', () => {
    expect(domainAllowed('https://evil.test/?next=https://example.com', allowed)).toBe(false)
    expect(domainAllowed('https://evil.test/example.com', allowed)).toBe(false)
  })

  it('refuses a target carrying credentials, which would put a secret in a record', () => {
    expect(domainAllowed('https://user:pass@example.com/', allowed)).toBe(false)
    expect(domainAllowed('https://user@example.com/', allowed)).toBe(false)
  })

  it('refuses a non-http scheme', () => {
    for (const target of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'javascript:alert(1)',
      'data:text/html,x',
    ]) {
      expect(domainAllowed(target, allowed), target).toBe(false)
    }
  })

  it('refuses something that is not a URL at all', () => {
    for (const target of ['', 'example.com', 'not a url', '/relative/path']) {
      expect(domainAllowed(target, allowed), target).toBe(false)
    }
  })
})