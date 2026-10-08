// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { harness, POLICY_INPUT } from './harness'
import { normaliseSurfacePolicy } from '../../../core/devicehands'

describe('narrow owner public browser policy upgrade', () => {
  it('upgrades a saved strict profile by adding only owner public browsing and journals the new digest', async () => {
    const previous = harness()
    await previous.ready()
    const restarted = harness()
    restarted.seed(previous.entries)
    await restarted.runtime.open()
    const candidate = { ...POLICY_INPUT, ownerPublicBrowser: true }
    expect((await restarted.runtime.loadPolicy(candidate)).code).toBe('policy-mismatch')
    expect((await restarted.runtime.enableOwnerPublicBrowser(candidate)).ok).toBe(true)
    const next = normaliseSurfacePolicy(candidate)
    if (!next.ok) throw new Error(next.reason)
    expect(restarted.runtime.snapshot().policyDigest).toBe(next.policy.digest)
    expect(previous.entries.filter(e => e.type === 'hands.policy.set')).toHaveLength(1)
    expect(restarted.payloadsOf('hands.policy.set')).toHaveLength(1)
    expect(restarted.payloadsOf('hands.policy.owner-browser-enabled')).toHaveLength(1)
    expect((await restarted.runtime.loadPolicy(candidate)).ok).toBe(true)
    const again = harness()
    again.seed(restarted.entries)
    await again.runtime.open()
    expect((await again.runtime.loadPolicy(candidate)).ok).toBe(true)
    expect(again.runtime.snapshot().policyDigest).toBe(next.policy.digest)
  })
  it('rejects every unrelated policy change while preserving the old journal digest', async () => {
    const h = harness()
    await h.ready()
    const digest = h.runtime.snapshot().policyDigest
    for (const change of [
      { allowedRoots: ['/different'] }, { deniedRoots: ['/different-vault'] },
      { allowedHosts: ['different.example'] }, { allowedCommands: ['node'] },
      { allowedEnvNames: ['CI'] }, { maxTransferBytes: 1 }, { localUnrestricted: true },
      { ownerPublicBrowser: false },
    ]) {
      expect((await h.runtime.enableOwnerPublicBrowser({ ...POLICY_INPUT, ownerPublicBrowser: true, ...change })).ok).toBe(false)
      expect(h.runtime.snapshot().policyDigest).toBe(digest)
    }
    expect(h.payloadsOf('hands.policy.set')).toHaveLength(1)
  })
  it('refuses upgrades while STOP ALL is latched or the journal is untrusted', async () => {
    const h = harness()
    await h.ready()
    h.setStopAll(true)
    expect((await h.runtime.enableOwnerPublicBrowser({ ...POLICY_INPUT, ownerPublicBrowser: true })).code).toBe('stop-all-latched')
    h.setStopAll(false)
    h.setJournalTrustworthy(false)
    expect((await h.runtime.enableOwnerPublicBrowser({ ...POLICY_INPUT, ownerPublicBrowser: true })).code).toBe('journal-untrustworthy')
    expect(h.payloadsOf('hands.policy.set')).toHaveLength(1)
  })
})
