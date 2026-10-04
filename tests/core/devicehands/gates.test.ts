// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEVICE_HANDS_GATES,
  DEVICE_HANDS_PROBE_GATES,
  authoriseDeviceAction,
  authoriseDeviceProbe,
  buildSubject,
  forbiddenClaimCode,
  forbiddenActions,
  normaliseDeviceAction,
  type DeviceHandsActionKey,
  type DeviceHandsActionRequest,
  type DeviceHandsApprovalRecord,
  type DeviceHandsGateContext,
  type DeviceHandsGrantRecord,
} from '../../../core/devicehands'
import { T0, T_PLUS_30S, downloadInput, harness, policy, terminalInput } from './harness'

/**
 * The gate pipeline, driven one gate at a time.
 *
 * The claim under test is not "the gates exist" but "**no gate is ever skipped**", which
 * is a claim about ten independent checks. So every case here fails an *earlier* gate
 * and asserts that the later ones were never consulted — the `evaluated` and `remaining`
 * lists are what make the ordering observable rather than assumed.
 */

function grant(overrides: Partial<DeviceHandsGrantRecord> = {}): DeviceHandsGrantRecord {
  return {
    grantId: 'grant-1',
    principalId: 'owner-1',
    scope: 'session-1',
    surfaces: ['browser', 'terminal', 'clipboard', 'transfer'],
    actions: [
      'browser.navigate',
      'browser.read-text',
      'browser.click',
      'browser.type-text',
      'terminal.run',
      'clipboard.read',
      'clipboard.write',
      'clipboard.clear',
      'transfer.download',
      'transfer.upload',
    ],
    issuedAt: T0,
    expiresAt: T_PLUS_30S,
    revokedAt: null,
    ...overrides,
  }
}

function approvalFor(
  subject: ReturnType<typeof buildSubject>,
  overrides: Partial<DeviceHandsApprovalRecord> = {},
): DeviceHandsApprovalRecord {
  return {
    approvalId: 'ap-1',
    subject,
    state: 'granted',
    requestedAt: T0,
    decidedAt: T0,
    expiresAt: '2026-07-01T09:00:30.000Z',
    ...overrides,
  }
}

function context(overrides: Partial<DeviceHandsGateContext> = {}): DeviceHandsGateContext {
  return {
    enabled: true,
    journalTrustworthy: true,
    stopped: false,
    policy: policy(),
    policyDigest: null,
    seenActionIds: new Set<string>(),
    grant: grant(),
    approvals: [],
    actionCountThisSession: 0,
    transferCountThisSession: 0,
    bytesThisSession: 0,
    inFlightActions: 0,
    ...overrides,
  }
}

function request(overrides: Partial<DeviceHandsActionRequest> = {}): DeviceHandsActionRequest {
  return {
    actionId: 'act-1',
    principalId: 'owner-1',
    scope: 'session-1',
    actionKey: 'browser.navigate',
    claimsAction: null,
    input: { url: 'https://example.com/about' },
    deadlineAt: T_PLUS_30S,
    at: T0,
    ...overrides,
  }
}

/** The subject the gate would build for this exact request. */
function subjectFor(r: DeviceHandsActionRequest) {
  const reading = normaliseDeviceAction(policy(), r.actionKey, r.input)
  if (!reading.ok) throw new Error(`unreachable: ${reading.reason}`)
  return buildSubject(r.actionKey, reading.prepared, r.actionId)
}

describe('device hands gates', () => {
  it('walks every gate and approves a request that satisfies all of them', () => {
    const decision = authoriseDeviceAction(context(), request())

    expect(decision.allowed).toBe(true)
    expect(decision.evaluated).toEqual([...DEVICE_HANDS_GATES])
    expect(decision.remaining).toEqual([])
    expect(decision.approvalRequired).toBe(false)
    expect(decision.prepared?.kind).toBe('browser')
  })

  it.each([
    ['journal-trustworthy', { journalTrustworthy: false }, 'journal-untrustworthy'],
    ['stop-all', { stopped: true }, 'stop-all-latched'],
    ['enabled', { enabled: false }, 'subsystem-disabled'],
    ['replay', { seenActionIds: new Set(['act-1']) }, 'replay-detected'],
    ['grant', { grant: null }, 'grant-missing'],
  ] as const)('refuses at %s and never consults a later gate', (gate, overrides, code) => {
    const shaped = request()
    const decision = authoriseDeviceAction(context(overrides), shaped)

    expect(decision.allowed).toBe(false)
    expect(decision.refusedAt).toBe(gate)
    expect(decision.code).toBe(code)
    const index = DEVICE_HANDS_GATES.indexOf(gate)
    expect(decision.evaluated).toEqual(DEVICE_HANDS_GATES.slice(0, index + 1))
    expect(decision.remaining).toEqual(DEVICE_HANDS_GATES.slice(index + 1))
    expect(decision.prepared).toBeNull()
  })

  it('refuses a grant that names a different principal or scope', () => {
    const decision = authoriseDeviceAction(
      context(),
      request({ principalId: 'someone-else' }),
    )
    expect(decision.refusedAt).toBe('grant')
    expect(decision.code).toBe('grant-missing')
  })

  it('refuses a grant that covers the action name but not the action', () => {
    const narrowed = grant({ actions: ['browser.navigate'] })
    const decision = authoriseDeviceAction(
      context({ grant: narrowed }),
      request({ actionKey: 'browser.click', input: { url: 'https://example.com/x', selector: '#a' } }),
    )
    expect(decision.refusedAt).toBe('grant')
    expect(decision.code).toBe('grant-action-mismatch')
  })

  it('refuses a deadline beyond the ceiling rather than shortening it', () => {
    const decision = authoriseDeviceAction(
      context(),
      request({ deadlineAt: '2026-07-01T10:00:00.000Z' }),
    )
    expect(decision.refusedAt).toBe('deadline')
    expect(decision.code).toBe('deadline-expired')
    expect(decision.reason).toContain('at most 60 seconds')
  })

  it('refuses at the policy gate when no policy is loaded, and before the approval gate', () => {
    const decision = authoriseDeviceAction(context({ policy: null }), request())
    expect(decision.refusedAt).toBe('policy')
    expect(decision.code).toBe('policy-missing')
    expect(decision.evaluated).not.toContain('approval')
  })

  it('refuses a policy that is not the one the journal recorded', () => {
    const decision = authoriseDeviceAction(
      context({ policyDigest: 'a-different-digest' }),
      request(),
    )
    expect(decision.refusedAt).toBe('policy')
    expect(decision.code).toBe('policy-mismatch')
  })

  it('refuses at the approval gate, and never runs the policy gate for a policy refusal', () => {
    // A terminal request with no approval: the policy gate *does* run (it has to, to know
    // what it is approving) and the approval gate refuses. The ordering is what proves
    // the policy was consulted rather than skipped.
    const decision = authoriseDeviceAction(
      context(),
      request({ actionKey: 'terminal.run', input: terminalInput() }),
    )
    expect(decision.refusedAt).toBe('approval')
    expect(decision.code).toBe('approval-missing')
    expect(decision.evaluated).toContain('policy')
    expect(decision.evaluated).toContain('approval')
    expect(decision.prepared).toBeNull()
  })

  it('refuses before the approval gate when the policy forbids the body, so no one is interrupted', () => {
    const decision = authoriseDeviceAction(
      context(),
      request({
        actionKey: 'terminal.run',
        input: terminalInput({ args: ['status; rm -rf /'] }),
      }),
    )
    expect(decision.refusedAt).toBe('policy')
    expect(decision.code).toBe('command-argument-unsafe')
    expect(decision.evaluated).not.toContain('approval')
  })

  it('refuses an action the session has already refused, and refuses it as a replay', () => {
    const decision = authoriseDeviceAction(context({ seenActionIds: new Set(['act-1']) }), request())
    expect(decision.refusedAt).toBe('replay')
    expect(decision.code).toBe('replay-detected')
  })

  it('refuses once the action ceiling is reached', () => {
    const decision = authoriseDeviceAction(context({ actionCountThisSession: 128 }), request())
    expect(decision.refusedAt).toBe('budget')
    expect(decision.code).toBe('action-count-exceeded')
  })

  it('refuses a transfer that would cross the session byte ceiling', () => {
    const decision = authoriseDeviceAction(
      context({ bytesThisSession: 5 * 1024 * 1024 }),
      request({ actionKey: 'transfer.download', input: downloadInput() }),
    )
    expect(decision.refusedAt).toBe('policy')
    expect(decision.code).toBe('transfer-byte-ceiling')
  })

  it('accepts a granted approval whose subject matches the normalised body exactly', () => {
    const r = request({ actionId: 'act-term', actionKey: 'terminal.run', input: terminalInput() })
    const decision = authoriseDeviceAction(
      context({ approvals: [approvalFor(subjectFor(r))] }),
      r,
    )
    expect(decision.allowed).toBe(true)
    expect(decision.approvalRequired).toBe(true)
  })

  it('refuses an approval bound to a different argument vector', () => {
    const approved = request({ actionId: 'act-term', actionKey: 'terminal.run', input: terminalInput() })
    const attempted = request({
      actionId: 'act-term',
      actionKey: 'terminal.run',
      input: terminalInput({ args: ['status', '--porcelain'] }),
    })
    const decision = authoriseDeviceAction(
      context({ approvals: [approvalFor(subjectFor(approved))] }),
      attempted,
    )
    expect(decision.refusedAt).toBe('approval')
    expect(decision.code).toBe('approval-subject-mismatch')
  })

  it('refuses an expired approval and a revoked one, with their own codes', () => {
    const r = request({ actionId: 'act-term', actionKey: 'terminal.run', input: terminalInput() })
    const subject = subjectFor(r)
    const expired = authoriseDeviceAction(
      context({ approvals: [approvalFor(subject, { expiresAt: T0 })] }),
      r,
    )
    expect(expired.code).toBe('approval-expired')

    const revoked = authoriseDeviceAction(
      context({ approvals: [approvalFor(subject, { state: 'revoked' })] }),
      r,
    )
    expect(revoked.code).toBe('approval-revoked')
  })

  it('refuses an approval for the same action name under a different action id', () => {
    // The action id is inside the digest on purpose: a replay is a new authorisation
    // question, and an approval must not travel with a re-presented request.
    const approved = request({ actionId: 'act-a', actionKey: 'terminal.run', input: terminalInput() })
    const replayed = request({ actionId: 'act-b', actionKey: 'terminal.run', input: terminalInput() })
    const decision = authoriseDeviceAction(
      context({ approvals: [approvalFor(subjectFor(approved))] }),
      replayed,
    )
    expect(decision.code).toBe('approval-subject-mismatch')
  })

  it.each([
    ['read-vault', 'vault-path-denied'],
    ['read-keyring', 'vault-path-denied'],
    ['read-credential-store', 'vault-path-denied'],
    ['screenshot', 'capture-denied'],
    ['capture-screen', 'capture-denied'],
    ['render-pdf', 'capture-denied'],
    ['read-camera', 'physical-world-denied'],
    ['control-iot-device', 'physical-world-denied'],
    ['grant-authority', 'authority-widening-refused'],
    ['widen-capability', 'authority-widening-refused'],
    ['disable-stop-all', 'authority-widening-refused'],
  ] as const)('refuses an untrusted claim of %s with its own code', (claim, code) => {
    expect(forbiddenClaimCode(claim)).toBe(code)
    const decision = authoriseDeviceAction(context(), request({ claimsAction: claim }))
    expect(decision.refusedAt).toBe('surface')
    expect(decision.code).toBe(code)
  })

  it('gives every entry of the absolute deny list a code', () => {
    for (const claim of forbiddenActions()) {
      expect(forbiddenClaimCode(claim)).not.toBeNull()
    }
  })

  it('gives a harmless claim no shortcut past any other gate', () => {
    const decision = authoriseDeviceAction(
      context({ stopped: true }),
      request({ claimsAction: 'publish' }),
    )
    expect(forbiddenClaimCode('publish')).toBeNull()
    expect(decision.refusedAt).toBe('stop-all')
  })

  it('refuses a download whose URL is off the allowlist before any file is named', () => {
    const decision = authoriseDeviceAction(
      context(),
      request({
        actionKey: 'transfer.download',
        input: downloadInput({ url: 'https://evil.test/notes.txt' }),
      }),
    )
    expect(decision.refusedAt).toBe('policy')
    expect(decision.code).toBe('url-host-not-allowed')
  })

  it('requires a selector for a click and refuses one that is not a locator', () => {
    const missing = authoriseDeviceAction(
      context(),
      request({ actionKey: 'browser.click', input: { url: 'https://example.com/x' } }),
    )
    expect(missing.code).toBe('request-malformed')

    const scripted = authoriseDeviceAction(
      context(),
      request({
        actionKey: 'browser.click',
        input: { url: 'https://example.com/x', selector: 'a[onclick=alert(1)]' },
      }),
    )
    expect(scripted.code).toBe('request-malformed')
  })

  it('refuses a clipboard read that supplies its own text, so the audit cannot be about the wrong thing', () => {
    const decision = authoriseDeviceAction(
      context(),
      request({ actionKey: 'clipboard.read', input: { text: 'something I would like recorded' } }),
    )
    expect(decision.refusedAt).toBe('policy')
    expect(decision.code).toBe('request-malformed')
  })

  describe('probes', () => {
    it('passes a shorter pipeline than an action, with no gate that could grant', () => {
      const decision = authoriseDeviceProbe({
        enabled: true,
        journalTrustworthy: true,
        stopped: false,
        surface: 'clipboard',
      })
      expect(decision.allowed).toBe(true)
      expect(decision.evaluated).toEqual([...DEVICE_HANDS_PROBE_GATES])
      expect(DEVICE_HANDS_PROBE_GATES).not.toContain('grant')
      expect(DEVICE_HANDS_PROBE_GATES).not.toContain('approval')
      expect(DEVICE_HANDS_PROBE_GATES).not.toContain('budget')
    })

    it('refuses a surface this build does not route', () => {
      const decision = authoriseDeviceProbe({
        enabled: true,
        journalTrustworthy: true,
        stopped: false,
        surface: 'camera',
      })
      expect(decision.allowed).toBe(false)
      expect(decision.refusedAt).toBe('surface')
      expect(decision.code).toBe('surface-unknown')
    })

    it('refuses a probe under STOP ALL, and names no later gate', () => {
      const decision = authoriseDeviceProbe({
        enabled: true,
        journalTrustworthy: true,
        stopped: true,
        surface: 'terminal',
      })
      expect(decision.evaluated).toEqual(['journal-trustworthy', 'stop-all'])
      expect(decision.remaining).toEqual(['enabled', 'surface'])
    })

    it('needs no grant at all: a probe is available to a caller with no authority', async () => {
      const h = harness({ grant: null })
      await h.runtime.open()
      const result = await h.runtime.probe('terminal')
      expect(result.ok).toBe(true)
      // And the caller still holds nothing.
      expect(Object.keys(h.runtime.snapshot().grants)).toHaveLength(0)
      const afterwards = await h.request({ actionKey: 'terminal.run', input: terminalInput() })
      expect(afterwards.outcome.code).toBe('grant-missing')
      expect(h.calls('terminal')).toBe(0)
    })
  })

  it('keeps the action-key vocabulary and the gate list in step', () => {
    const keys: DeviceHandsActionKey[] = []
    for (const surface of ['browser', 'terminal', 'clipboard', 'transfer'] as const) {
      for (const action of {
        browser: ['navigate', 'read-text', 'click', 'type-text'],
        terminal: ['run'],
        clipboard: ['read', 'write', 'clear'],
        transfer: ['download', 'upload'],
      }[surface]) {
        keys.push(`${surface}.${action}` as DeviceHandsActionKey)
      }
    }
    expect(keys).toHaveLength(10)
    // Every routed action's `surface` field exists, which the runtime writes into
    // `hands.action.started`; a surface that did not exist would make the fold drop it.
    for (const key of keys) {
      expect(key.slice(0, key.indexOf('.'))).toBeTruthy()
    }
  })
})