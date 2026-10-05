// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEVICE_HANDS_GATES,
  authoriseDeviceAction,
  normaliseSurfacePolicy,
  readTerminalCommand,
  type DeviceHandsActionRequest,
  type DeviceHandsGateContext,
} from '../../core/devicehands'
import { assertPublicBrowserUrl } from '../../core/browser'
import { browserDeleteReason, terminalDeleteReason } from '../../core/safety/no-delete'

function localPolicy() {
  const reading = normaliseSurfacePolicy({
    localUnrestricted: true,
    allowedRoots: [],
    deniedRoots: [],
    allowedHosts: [],
    allowedCommands: [],
    allowedEnvNames: [],
  })
  if (!reading.ok) throw new Error(reading.reason)
  return reading.policy
}

describe('local unrestricted development profile', () => {
  it('accepts an empty allowlist/denylist policy and reaches arbitrary local paths and hosts', () => {
    const policy = localPolicy()
    expect(policy.localUnrestricted).toBe(true)

    const command = readTerminalCommand({
      command: 'pwsh',
      args: ['-NoProfile', '-Command', 'Write-Host $env:HOME; echo ok'],
      workingDirectory: 'C:/work/freya',
      env: { HOME: 'C:/Users/you' },
    }, policy)

    expect(command.ok).toBe(true)
  })

  it('bypasses grants, approvals, strict budgets and policy-digest matching, but still walks the gates', () => {
    const policy = localPolicy()
    const request: DeviceHandsActionRequest = {
      actionId: 'local-act-1',
      principalId: 'agent:freya',
      scope: 'local',
      actionKey: 'terminal.run',
      claimsAction: 'read-vault',
      input: {
        command: 'git',
        args: ['status'],
        workingDirectory: 'C:/Users/you/Desktop/AI/Freya',
        env: {},
      },
      at: '2026-10-05T14:00:00.000Z',
      deadlineAt: '2026-10-05T14:30:00.000Z',
    }
    const context: DeviceHandsGateContext = {
      localUnrestricted: true,
      enabled: true,
      journalTrustworthy: true,
      stopped: false,
      policy,
      policyDigest: 'older-strict-policy',
      seenActionIds: new Set(),
      grant: null,
      approvals: [],
      actionCountThisSession: 999_999,
      transferCountThisSession: 999_999,
      bytesThisSession: 999_999_999,
      inFlightActions: 999,
    }

    const decision = authoriseDeviceAction(context, request)
    expect(decision.allowed).toBe(true)
    expect(decision.evaluated).toEqual([...DEVICE_HANDS_GATES])
    expect(decision.approvalRequired).toBe(false)
  })

  it('still honours STOP ALL because that is execution correctness, not permission friction', () => {
    const policy = localPolicy()
    const request: DeviceHandsActionRequest = {
      actionId: 'local-stop',
      principalId: 'agent:freya',
      scope: 'local',
      actionKey: 'browser.navigate',
      claimsAction: null,
      input: { url: 'http://127.0.0.1:4097/' },
      at: '2026-10-05T14:00:00.000Z',
      deadlineAt: '2026-10-05T14:30:00.000Z',
    }
    const context: DeviceHandsGateContext = {
      localUnrestricted: true,
      enabled: true,
      journalTrustworthy: true,
      stopped: true,
      policy,
      policyDigest: null,
      seenActionIds: new Set(),
      grant: null,
      approvals: [],
      actionCountThisSession: 0,
      transferCountThisSession: 0,
      bytesThisSession: 0,
      inFlightActions: 0,
    }

    const decision = authoriseDeviceAction(context, request)
    expect(decision.allowed).toBe(false)
    expect(decision.refusedAt).toBe('stop-all')
  })

  it('allows loopback and explicit dev ports only when the local browser profile opts in', () => {
    expect(assertPublicBrowserUrl('http://127.0.0.1:4097/').ok).toBe(false)

    const local = assertPublicBrowserUrl('http://127.0.0.1:4097/', {
      allowPrivateHosts: true,
      allowedHosts: [],
    })
    expect(local.ok).toBe(true)
    if (local.ok) expect(local.url).toBe('http://127.0.0.1:4097/')
  })
})

describe('temporary no-delete invariant', () => {
  it('blocks direct and wrapped destructive terminal operations', () => {
    expect(terminalDeleteReason('rm', ['-rf', '/tmp/demo'])).not.toBeNull()
    expect(terminalDeleteReason('git', ['reset', '--hard'])).not.toBeNull()
    expect(terminalDeleteReason('pwsh', ['-Command', 'Remove-Item C:/tmp/demo'])).not.toBeNull()
    expect(terminalDeleteReason('git', ['status'])).toBeNull()
  })

  it('is enforced by the local terminal parser too', () => {
    const result = readTerminalCommand({
      command: 'rm',
      args: ['-rf', 'C:/tmp/demo'],
      workingDirectory: 'C:/tmp',
      env: {},
    }, localPolicy())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('forbidden-action')
    expect(result.reason).toContain('no-delete')
  })

  it('recognises destructive browser controls without blocking ordinary actions', () => {
    expect(browserDeleteReason('Delete project')).not.toBeNull()
    expect(browserDeleteReason('Remove account')).not.toBeNull()
    expect(browserDeleteReason('Save changes')).toBeNull()
    expect(browserDeleteReason('Open dashboard')).toBeNull()
  })
})
