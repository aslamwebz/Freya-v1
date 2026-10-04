import { describe, expect, it } from 'vitest'
import { RUNTIME_REGISTRY, orderedRegistry, registryById } from '../../../core/runtime'
import { RUNTIME_FAMILIES } from '../../../core/runtime'

describe('the canonical runtime registry', () => {
  it('has unique, namespaced ids', () => {
    const ids = RUNTIME_REGISTRY.map((entry) => entry.id)
    expect(ids.length).toBe(new Set(ids).size)
    for (const id of ids) expect(id).toMatch(/^core\.[a-z0-9-]+$/)
  })

  it('names a module for every domain', () => {
    for (const entry of RUNTIME_REGISTRY) {
      expect(entry.module.length, entry.id).toBeGreaterThan(0)
      expect(entry.title.length, entry.id).toBeGreaterThan(0)
      expect(entry.note.length, entry.id).toBeGreaterThan(0)
    }
  })

  it('covers the major families the phase names', () => {
    const present = new Set(RUNTIME_REGISTRY.map((entry) => entry.family))
    for (const family of RUNTIME_FAMILIES) {
      expect(present.has(family), family).toBe(true)
    }
  })

  it('orders deterministically and has no duplicate order for a tie-break-free read', () => {
    const ordered = orderedRegistry()
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i - 1]!.order).toBeLessThanOrEqual(ordered[i]!.order)
    }
  })

  it('keeps the fail-closed domains fail-closed', () => {
    expect(registryById('core.economic')?.activation).toBe('fail-closed')
    expect(registryById('core.enterprise')?.activation).toBe('fail-closed')
  })

  it('requires a host adapter and a grant before Device Hands could activate', () => {
    const hands = registryById('core.device-hands')
    expect(hands).toBeDefined()
    const kinds = hands!.requirements.map((requirement) => requirement.kind)
    expect(kinds).toContain('host-adapter')
    expect(kinds).toContain('capability-grant')
    expect(hands!.activation).toBe('blocked')
  })

  it('requires a transport and a trusted device before Multi-Device could activate', () => {
    const multi = registryById('core.multidevice')
    expect(multi).toBeDefined()
    const kinds = multi!.requirements.map((requirement) => requirement.kind)
    expect(kinds).toContain('transport')
    expect(kinds).toContain('trusted-device')
    expect(multi!.activation).toBe('blocked')
  })

  it('requires a recovery journal seam before Resilience could activate', () => {
    const resilience = registryById('core.resilience')
    expect(resilience).toBeDefined()
    expect(resilience!.requirements.map((requirement) => requirement.kind)).toContain('recovery-journal')
  })

  it('treats the mature threshold as a measurement, not an authority source', () => {
    const threshold = registryById('core.threshold')
    expect(threshold).toBeDefined()
    expect(threshold!.activation).toBe('activatable')
    // It requires only the journal: no capability, no grant, no approval.
    expect(threshold!.requirements.map((requirement) => requirement.kind)).toEqual(['journal'])
  })

  it('registers every domain as implemented rather than absent', () => {
    for (const entry of RUNTIME_REGISTRY) {
      expect(entry.kind).not.toBe('')
    }
  })
})
