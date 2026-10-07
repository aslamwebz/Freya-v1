// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { harness, ScriptedJournal } from './harness'
import { authoriseDeviceAction, normaliseSurfacePolicy, type DeviceHandsGateContext, type DeviceHandsActionRequest } from '../../../core/devicehands'
import { policy } from '../devicehands/harness'

const profile = { ownerPublicBrowser: true, allowedRoots: [], deniedRoots: ['/user-data/Freya/vault', '/user-data/Freya/keyring'], allowedHosts: [], allowedCommands: [], allowedEnvNames: [] }
function ownerPolicy() {
  const result = normaliseSurfacePolicy(profile)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.policy
}
function request(principalId = 'owner:browser', url = 'https://arbitrary.example.org/article'): DeviceHandsActionRequest {
  return { actionId: 'owner-action', principalId, scope: 'freya-0001', actionKey: 'browser.navigate', claimsAction: null, input: { url }, at: '2026-07-01T09:00:00.000Z', deadlineAt: '2026-07-01T09:00:30.000Z' }
}
function context(): DeviceHandsGateContext {
  const r = request()
  return { enabled: true, journalTrustworthy: true, stopped: false, policy: ownerPolicy(), policyDigest: null, seenActionIds: new Set(), grant: { grantId: 'owner-session', principalId: r.principalId, scope: r.scope, surfaces: ['browser'], actions: ['browser.navigate', 'browser.read-text'], issuedAt: r.at, expiresAt: '2026-07-01T09:15:00.000Z', revokedAt: null }, approvals: [], actionCountThisSession: 0, transferCountThisSession: 0, bytesThisSession: 0, inFlightActions: 0 }
}

describe('strict owner browser policy', () => {
  it('allows a public navigation only through all ten gates and its recorded owner grant', () => {
    const c = context()
    const result = authoriseDeviceAction(c, request())
    expect(result.allowed).toBe(true)
    expect(result.evaluated).toHaveLength(10)
    expect(authoriseDeviceAction({ ...c, grant: null }, request()).code).toBe('grant-missing')
    expect(authoriseDeviceAction({ ...c, stopped: true }, request()).code).toBe('stop-all-latched')
  })
  it('keeps agent host policy unchanged even with a matching agent grant', () => {
    const c = context()
    expect(authoriseDeviceAction({ ...c, grant: { ...c.grant!, principalId: 'agent:freya' } }, request('agent:freya')).allowed).toBe(false)
  })
  it('does not extend the owner grant to clicks, typing, clipboard or programs', () => {
    const c = context()
    for (const actionKey of ['browser.click', 'browser.type-text', 'clipboard.read', 'terminal.run'] as const) {
      expect(authoriseDeviceAction(c, { ...request(), actionKey }).allowed).toBe(false)
    }
  })
  it('refuses private/local URLs, credential URLs and non-web schemes', () => {
    const c = context()
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/', 'http://internal.local/', 'https://u:p@example.org/', 'file:///etc/passwd']) {
      expect(authoriseDeviceAction(c, request('owner:browser', url)).allowed).toBe(false)
    }
  })
  it('includes the owner browser profile in the policy digest without changing strict digests', () => {
    const base = policy()
    const enabled = normaliseSurfacePolicy({ ...base, ownerPublicBrowser: true })
    expect(enabled.ok).toBe(true)
    if (enabled.ok) expect(enabled.policy.digest).not.toBe(base.digest)
    expect(normaliseSurfacePolicy({ ...profile, ownerPublicBrowser: false }).ok).toBe(false)
  })
})

describe('owner browser runtime context', () => {
  it('assigns owner authority only to public navigation/read, with automation retaining its principal', async () => {
    const instance = harness()
    await instance.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const sessionId = String(opened.data.sessionId)
    const principals: string[] = []
    const original = instance.authority.perform.bind(instance.authority)
    instance.authority.perform = async r => { principals.push(r.principalId); return original(r) }
    await instance.runtime.execute({ command: 'page.navigate', target: 'public', sessionId, url: 'https://example.com/' }, { origin: 'owner' })
    await instance.runtime.execute({ command: 'page.read', target: 'public', sessionId }, { origin: 'owner' })
    await instance.runtime.execute({ command: 'page.describe', target: 'public', sessionId }, { origin: 'owner' })
    await instance.runtime.execute({ command: 'page.read', target: 'public', sessionId })
    expect(principals).toEqual(['owner:browser', 'owner:browser', 'owner:browser', 'agent:freya'])
  })
  it('does not accept a principal smuggled into the renderer request', async () => {
    const instance = harness()
    await instance.open()
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    const principals: string[] = []
    const original = instance.authority.perform.bind(instance.authority)
    instance.authority.perform = async r => { principals.push(r.principalId); return original(r) }
    await instance.runtime.execute({ command: 'page.navigate', target: 'public', sessionId: String(opened.data.sessionId), url: 'https://example.com/', principalId: 'owner:browser' } as never)
    expect(principals).toEqual(['agent:freya'])
  })
})

describe('native browser recovery', () => {
  it('retires lost sessions before enforcing the live session ceiling and never reuses their IDs', async () => {
    const journal = new ScriptedJournal()
    for (let sequence = 1; sequence <= 12; sequence++) {
      await journal.append('browser.dual.session.opened', { sessionId: `freya-${String(sequence).padStart(4, '0')}`, target: 'public', at: '2026-07-01T09:00:00.000Z' })
    }
    const instance = harness({ journal, maxSessions: 12 })
    const recovered = await instance.runtime.open()
    expect(recovered.sessionsLost).toHaveLength(12)
    expect(instance.pages.size).toBe(0)
    expect(instance.runtime.state().sessions.filter(s => s.session === 'open')).toHaveLength(0)
    const opened = await instance.ok({ command: 'session.open', target: 'public' })
    expect(opened.data.sessionId).toBe('freya-0013')
    expect(instance.pages.size).toBe(1)
    const again = await instance.runtime.open()
    expect(instance.pages.size).toBe(1)
    expect(again.sessionsLost).toHaveLength(12)
  })
})
