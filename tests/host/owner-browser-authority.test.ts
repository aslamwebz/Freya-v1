// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import { denyAllAuthority } from '../../electron/devicehands/activation'
import { hostHarness, memoryJournal } from './devicehands/harness'

let dir = ''
let host: ElectronCoreHost
let effects: Awaited<ReturnType<typeof hostHarness>>
const profile = { ownerPublicBrowser: true, allowedRoots: [], deniedRoots: ['/user-data/Freya/vault', '/user-data/Freya/keyring'], allowedHosts: [], allowedCommands: [], allowedEnvNames: [] }
const action = (actionKey: 'browser.navigate' | 'browser.read-text' | 'browser.click' = 'browser.navigate', actionId = 'owner-test') => {
  const now = Date.now()
  return { actionId, principalId: 'owner:browser', scope: 'freya-0001', actionKey, input: { url: 'https://example.com/' }, at: new Date(now).toISOString(), deadlineAt: new Date(now + 15_000).toISOString() }
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-owner-browser-'))
  effects = await hostHarness()
  host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, { deviceHands: { enabled: true, effects: effects.effects, journal: memoryJournal(), authority: denyAllAuthority({ enabled: () => true }), policy: profile } })
  await host.start()
})
afterEach(async () => { await host?.stop('teardown'); await effects?.activation.dispose(); await rm(dir, { recursive: true, force: true }) })

describe('owner browser authority in CoreHost', () => {
  it('registers a narrow grant in the existing journal and performs through DeviceHands', async () => {
    const result = await host.performOwnerBrowserAction(action())
    expect(result.performed).toBe(true)
    const grant = host.ownerBrowserGrant('owner:browser', 'freya-0001')
    expect(grant?.surfaces).toEqual(['browser'])
    expect(grant?.actions).toEqual(['browser.navigate', 'browser.read-text'])
    expect(Date.parse(grant!.expiresAt) - Date.parse(grant!.issuedAt)).toBe(15 * 60_000)
    expect(host.ownerBrowserGrant('agent:freya', 'freya-0001')).toBeNull()
    expect((await host.performDeviceHandsAction({ ...action('browser.read-text', 'automation-test'), principalId: 'agent:freya' })).performed).toBe(false)
  })
  it('keeps STOP ALL ahead of registering or performing an owner action', async () => {
    await host.submit({ command: 'security.stopAll', requestId: 'stop-owner' })
    expect((await host.performOwnerBrowserAction(action())).performed).toBe(false)
    expect(host.ownerBrowserGrant('owner:browser', 'freya-0001')).toBeNull()
    expect(effects.counts.browserNavigate).toBe(0)
  })
  it('refuses consequential actions and arbitrary scopes without granting them', async () => {
    expect((await host.performOwnerBrowserAction(action('browser.click'))).performed).toBe(false)
    expect((await host.performOwnerBrowserAction({ ...action(), scope: 'any-session' })).performed).toBe(false)
    expect(host.ownerBrowserGrant('owner:browser', 'freya-0001')).toBeNull()
  })
  it('serializes concurrent registration for the same session', async () => {
    const results = await Promise.all([host.performOwnerBrowserAction(action('browser.navigate', 'one')), host.performOwnerBrowserAction(action('browser.navigate', 'two'))])
    expect(results.every(result => result.performed)).toBe(true)
    const journal = host.deviceHandsJournal()!
    const records = await journal.replay()
    expect(records.filter(entry => entry.type === 'hands.grant.registered')).toHaveLength(1)
  })
})

describe('saved owner browser profile upgrade in CoreHost', () => {
  it('activates an existing strict profile without replacing its journal or its other permissions', async () => {
    await host.stop('replace-test-host')
    const { policyInput } = await import('./devicehands/harness')
    const journal = effects.journal
    const previousEntries = journal.entries.slice()
    host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, { deviceHands: { enabled: true, effects: effects.effects, journal, authority: denyAllAuthority({ enabled: () => true }), policy: { ...policyInput(), ownerPublicBrowser: true } } })
    await host.start()
    expect(host.deviceHandsStatus()?.active).toBe(true)
    expect((await host.performOwnerBrowserAction(action())).performed).toBe(true)
    expect(journal.entries.slice(0, previousEntries.length)).toEqual(previousEntries)
    expect(journal.entries.filter(e => e.type === 'hands.policy.set')).toHaveLength(2)
    expect(journal.entries.filter(e => e.type === 'hands.policy.owner-browser-enabled')).toHaveLength(1)
  })
  it('keeps activation refused when any other saved policy permission changes', async () => {
    await host.stop('replace-test-host')
    const { policyInput } = await import('./devicehands/harness')
    const journal = effects.journal
    host = new ElectronCoreHost(join(dir, 'events.jsonl'), {}, { deviceHands: { enabled: true, effects: effects.effects, journal, authority: denyAllAuthority({ enabled: () => true }), policy: { ...policyInput(), ownerPublicBrowser: true, allowedHosts: ['different.example'] } } })
    await host.start()
    expect(host.deviceHandsStatus()?.active).toBe(false)
    expect((await host.performOwnerBrowserAction(action())).performed).toBe(false)
    expect(journal.entries.filter(e => e.type === 'hands.policy.set')).toHaveLength(1)
  })
})
