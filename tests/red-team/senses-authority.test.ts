// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as senses from '../../core/senses'
import {
  admitCapabilityAction,
  testCaller,
  SENSES_TEST_NOW,
  type CapabilityActionRequest,
  type SensesAdmissionInput,
  type SensesCaller,
} from '../../core/senses'

/**
 * Attack family: capability expansion does not widen authority.
 *
 * Phase 25 adds clipboard, download and upload, and expands browser and
 * terminal. None of that is a new authority path. These attacks try to make a
 * capability mint authority, skip Guard/Governor/STOP ALL/budget/approval, or
 * widen its own bound.
 *
 * The invariant under attack:
 *
 *   > Hands are bounded tools, not unrestricted computer control.
 */

function request(over: Partial<CapabilityActionRequest> = {}): CapabilityActionRequest {
  return {
    actionId: 'action-1',
    capabilityKind: 'browser',
    action: 'navigate',
    input: { url: 'https://example.com' },
    ...over,
  }
}

function admission(over: Partial<SensesAdmissionInput> = {}): SensesAdmissionInput {
  return {
    request: request(),
    caller: testCaller(),
    stopAllActive: false,
    now: SENSES_TEST_NOW,
    budgetRemaining: 1000,
    requiredBudget: 10,
    approvals: new Set(['action-1']),
    requiresCognition: false,
    cognitionGrantId: null,
    ...over,
  }
}

function codeOf(over: Partial<SensesAdmissionInput>): string {
  const decision = admitCapabilityAction(admission(over))
  return decision.decision === 'refused' ? decision.code : 'admitted'
}

function caller(over: Partial<SensesCaller>): SensesCaller {
  return testCaller(over)
}

describe('redteam: a caller cannot claim authority it does not hold', () => {
  it('worker-claims-capability: a caller holding nothing is refused', () => {
    expect(codeOf({ caller: caller({ heldCapabilities: [] }) })).toBe('capability_unauthorized')
  })

  it('worker-claims-authority: an untrusted caller is refused whatever it holds', () => {
    expect(codeOf({ caller: caller({ trusted: false }) })).toBe('capability_unauthorized')
  })

  it('worker-claims-owner: naming yourself owner does not make you trusted', () => {
    expect(codeOf({ caller: caller({ principalId: 'owner', trusted: false }) })).toBe(
      'capability_unauthorized',
    )
  })

  it('worker-claims-budget: the request cannot set the budget it is measured against', () => {
    expect(codeOf({ budgetRemaining: 5, requiredBudget: 10 })).toBe('budget_exceeded')
  })

  it('worker-claims-approval: a forged approval field is rejected as an extra key', () => {
    const forged = request({
      capabilityKind: 'terminal',
      action: 'command-run',
      input: { command: 'echo hi', approved: true },
    })
    expect(codeOf({ request: forged })).toBe('invalid_input')
  })
})

describe('redteam: boundary violations are refusals, not warnings', () => {
  it('bypass-guard: an untrusted principal never reaches execution', () => {
    expect(codeOf({ caller: caller({ trusted: false }) })).toBe('capability_unauthorized')
  })

  it('bypass-governor: cognition without a grant is refused', () => {
    expect(codeOf({ requiresCognition: true, cognitionGrantId: null })).toBe('governor_denied')
  })

  it('bypass-stop-all: STOP ALL outranks every other check', () => {
    expect(
      codeOf({ stopAllActive: true, caller: caller({ trusted: false }), budgetRemaining: 0 }),
    ).toBe('stop_all')
  })

  it('exceed-budget: the budget bound is never exceeded', () => {
    expect(codeOf({ budgetRemaining: 9, requiredBudget: 10 })).toBe('budget_exceeded')
  })

  it('skip-approval: an action needing approval is refused without one', () => {
    const terminal = request({ capabilityKind: 'terminal', action: 'command-run', input: { command: 'echo hi' } })
    expect(codeOf({ request: terminal, approvals: new Set() })).toBe('approval_required')
  })

  it('widen-capability: a request cannot raise its own timeout bound', () => {
    const decision = admitCapabilityAction(
      admission({ request: request({ timeoutMs: 10 * 60 * 60 * 1000 }) }),
    )
    expect(decision.decision).toBe('admitted')
    if (decision.decision === 'admitted') {
      expect(decision.admitted.timeoutMs).toBeLessThanOrEqual(30_000)
    }
  })

  it('create-grant: the capability vocabulary has no grant mint', () => {
    const minting = Object.keys(senses).filter((key) =>
      /createGrant|mint|approve|bypass|spend/i.test(key),
    )
    expect(minting).toEqual([])
  })

  it('self-approve: admission never adds to the approval set', () => {
    const approvals = new Set<string>()
    const terminal = request({ capabilityKind: 'terminal', action: 'command-run', input: { command: 'echo hi' } })
    const first = admitCapabilityAction(admission({ request: terminal, approvals }))
    expect(first.decision).toBe('refused')
    expect(approvals.size).toBe(0)
    // A second attempt with the same empty set is refused again: nothing stuck.
    const second = admitCapabilityAction(admission({ request: terminal, approvals }))
    expect(second.decision).toBe('refused')
  })

  it('hidden-inference and continuous-polling: the module reaches no model or timer', () => {
    const suspicious = Object.keys(senses).filter((key) =>
      /provider|model|poll|interval|setTimeout|timer/i.test(key),
    )
    expect(suspicious).toEqual([])
  })
})

describe('redteam: capability-specific unrestricted attempts', () => {
  it('browser.unrestricted-navigation: only http(s) URLs are accepted', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x']) {
      expect(codeOf({ request: request({ action: 'navigate', input: { url } }) })).toBe('invalid_input')
    }
  })

  it('browser.unrestricted-click: an empty selector is refused', () => {
    expect(codeOf({ request: request({ action: 'click', input: { selector: '' } }) })).toBe('invalid_input')
  })

  it('terminal.unrestricted-command: empty and oversized commands are refused', () => {
    const terminal = (command: string): CapabilityActionRequest =>
      request({ capabilityKind: 'terminal', action: 'command-run', input: { command } })
    expect(codeOf({ request: terminal('') })).toBe('invalid_input')
    expect(codeOf({ request: terminal('x'.repeat(5000)) })).toBe('invalid_input')
    expect(codeOf({ request: terminal('echo hi') })).toBe('admitted')
  })

  it('clipboard.unrestricted-read: a read takes no fields at all', () => {
    const read = request({ capabilityKind: 'clipboard', action: 'clipboard-read', input: { filter: 'x' } })
    expect(codeOf({ request: read })).toBe('invalid_input')
  })

  it('clipboard.unrestricted-write: content is bounded and must be text', () => {
    const write = (content: unknown): CapabilityActionRequest =>
      request({ capabilityKind: 'clipboard', action: 'clipboard-write', input: { content } })
    expect(codeOf({ request: write(42) })).toBe('invalid_input')
    expect(codeOf({ request: write('x'.repeat(20_000)) })).toBe('invalid_input')
    expect(codeOf({ request: write('hello') })).toBe('admitted')
  })

  it('download.unrestricted-url: only http(s) URLs and bounded destinations', () => {
    const start = (url: string, destination: string): CapabilityActionRequest =>
      request({ capabilityKind: 'download', action: 'download-start', input: { url, destination } })
    expect(codeOf({ request: start('file:///etc/passwd', '/tmp/x') })).toBe('invalid_input')
    expect(codeOf({ request: start('https://example.com/f', '') })).toBe('invalid_input')
  })

  it('upload.unrestricted-source and destination are refused', () => {
    const start = (source: string, destination: string): CapabilityActionRequest =>
      request({ capabilityKind: 'upload', action: 'upload-start', input: { source, destination } })
    expect(codeOf({ request: start('', 'https://example.com/u') })).toBe('invalid_input')
    expect(codeOf({ request: start('/tmp/f', '') })).toBe('invalid_input')
    expect(codeOf({ request: start('/tmp/f', 'https://example.com/u') })).toBe('admitted')
  })
})
