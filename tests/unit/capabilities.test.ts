// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  applyReadiness,
  buildCapabilityRegistry,
  CAPABILITY_IDS,
  DEFAULT_CAPABILITY_SELECTION,
  describeCapability,
  describeProvider,
  isCapabilityId,
  isProviderId,
  PROVIDER_IDS,
  withCapabilityPreference,
  type CapabilityId,
  type ProviderId,
} from '../../core/capabilities'

/**
 * The capability seam is small on purpose. The tests therefore cover three things
 * and nothing more:
 *
 *   - The vocabulary is closed. Every id the registry reports is one of the
 *     names we wrote down, never a typo, never a synonym.
 *   - The defaults name MiniMax first where a chat-style brain is wanted and
 *     fall back to NanoGPT. Browser is anchored to Freya's own runtime.
 *   - Readiness is reported truthfully: a provider that answered ready is the
 *     one that becomes `available`, and one that didn't is not.
 *
 * These are the only facts the seam has to defend. Wiring each capability to
 * a real provider is a future lane; today this module is the closed shape the
 * lane can build against.
 */

describe('the capability vocabulary is closed', () => {
  it('has a known set of providers', () => {
    expect(PROVIDER_IDS).toEqual(['minimax', 'nanogpt', 'local', 'loopback', 'openai', 'searxng', 'brave', 'native'])
    for (const id of PROVIDER_IDS) {
      expect(isProviderId(id)).toBe(true)
    }
  })

  it('has a known set of capabilities', () => {
    expect(CAPABILITY_IDS).toContain('chat')
    expect(CAPABILITY_IDS).toContain('search')
    expect(CAPABILITY_IDS).toContain('browser')
    expect(CAPABILITY_IDS).toContain('eye')
    expect(CAPABILITY_IDS).toContain('vision')
    for (const id of CAPABILITY_IDS) {
      expect(isCapabilityId(id)).toBe(true)
    }
    expect(isCapabilityId('telepathy')).toBe(false)
  })

  it('names every provider id', () => {
    for (const id of PROVIDER_IDS) {
      expect(typeof describeProvider(id)).toBe('string')
      expect(describeProvider(id).length).toBeGreaterThan(0)
    }
  })

  it('names every capability id', () => {
    for (const id of CAPABILITY_IDS) {
      const description = describeCapability(id)
      expect(typeof description.name).toBe('string')
      expect(description.name.length).toBeGreaterThan(0)
      expect(typeof description.blurb).toBe('string')
    }
  })
})

describe('the defaults follow the seams we document', () => {
  it('uses MiniMax as the preferred brain for chat and vision', () => {
    expect(DEFAULT_CAPABILITY_SELECTION.chat[0]).toBe('minimax')
    expect(DEFAULT_CAPABILITY_SELECTION.vision[0]).toBe('minimax')
  })

  it('keeps NanoGPT as the documented fallback for chat and vision', () => {
    expect(DEFAULT_CAPABILITY_SELECTION.chat).toContain('nanogpt')
    expect(DEFAULT_CAPABILITY_SELECTION.vision).toContain('nanogpt')
  })

  it('anchors the browser capability to the embedded Freya Browser', () => {
    expect(DEFAULT_CAPABILITY_SELECTION.browser).toContain('minimax')
  })
})

describe('the registry surfaces what each capability actually answered', () => {
  it('reports unknown when no readiness was provided', () => {
    const registry = buildCapabilityRegistry()
    for (const capability of CAPABILITY_IDS) {
      expect(registry[capability].status).toBe('unknown')
      expect(registry[capability].available).toBeNull()
    }
  })

  it('uses the first provider that answered ready', () => {
    const base = buildCapabilityRegistry({
      chat: ['nanogpt', 'minimax'],
    })
    const registry = applyReadiness(base, {
      nanogpt: { ready: false, reason: 'disabled' },
      minimax: { ready: true, reason: '' },
    })
    expect(registry.chat.available).toBe('minimax')
    expect(registry.chat.status).toBe('ready')
  })

  it('reports unconfigured when no provider in the preference list is known', () => {
    const base = buildCapabilityRegistry({ chat: ['minimax', 'nanogpt'] })
    const registry = applyReadiness(base, {
      loopback: { ready: true, reason: '' },
    })
    expect(registry.chat.available).toBeNull()
    expect(registry.chat.status).toBe('unconfigured')
  })

  it('reports disabled when at least one provider was checked and none are ready', () => {
    const base = buildCapabilityRegistry({ chat: ['minimax', 'nanogpt'] })
    const registry = applyReadiness(base, {
      minimax: { ready: false, reason: 'key missing' },
      nanogpt: { ready: false, reason: 'over budget' },
    })
    expect(registry.chat.available).toBeNull()
    expect(registry.chat.status).toBe('disabled')
    expect(registry.chat.reason).toContain('key')
  })
})

describe('the registry defends the preference list', () => {
  it('rejects an empty preference list', () => {
    const base = buildCapabilityRegistry()
    const next = withCapabilityPreference(base, 'chat', [])
    expect(next.chat.providers).toEqual(base.chat.providers)
  })

  it('rejects an unknown provider id', () => {
    const base = buildCapabilityRegistry()
    const next = withCapabilityPreference(base, 'chat', ['unknown' as ProviderId, 'minimax'])
    expect(next.chat.providers).toEqual(['minimax'])
  })

  it('preserves the existing preference list when every id is unknown', () => {
    const base = buildCapabilityRegistry()
    const next = withCapabilityPreference(base, 'chat', ['not-a-provider' as ProviderId])
    expect(next.chat.providers).toEqual(base.chat.providers)
  })

  it('rewrites only the requested capability', () => {
    const base = buildCapabilityRegistry()
    const next = withCapabilityPreference(base, 'chat', ['nanogpt', 'minimax'])
    expect(next.chat.providers).toEqual(['nanogpt', 'minimax'])
    expect(next.eye.providers).toEqual(base.eye.providers)
  })
})

describe('the capability types are stable for downstream consumers', () => {
  it('produces a registry whose capability ids are typed', () => {
    const registry = buildCapabilityRegistry()
    const id: CapabilityId = registry.chat.capability
    expect(id).toBe('chat')
  })
})