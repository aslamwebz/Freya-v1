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
    // `activatable`, not `blocked`. This was `blocked` when Phase 40 landed, which in
    // the controller is unconditional — it short-circuits before requirements are
    // consulted, so Phase 42's wiring could never move it. The note has always been
    // conditional ("without a truthful adapter and grants"), and now the requirement
    // set is what decides. STOP ALL is checked before this branch, so the latch
    // still outranks a satisfied requirement set.
    expect(hands!.activation).toBe('activatable')
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

  it('keeps authority vocabulary out of every note, because notes reach the journal', () => {
    /**
     * A `fail-closed` domain's `note` becomes `computed.reason`, which the activation
     * controller writes into the **durable event journal** verbatim
     * (`controller.ts` records `reason: computed.reason`).
     *
     * So a note is not a comment. Three separate red-team suites assert that
     * particular vocabulary never appears in a journal — `personality`,
     * `consciousness-leakage` and `enterprise` all forbid it — which makes the
     * wording of every note a cross-domain hazard rather than a local style choice.
     *
     * This was found the hard way: a browserext note reading "…and no STOP ALL"
     * wrote that literal string into the journal of an unrelated personality test
     * and failed it deterministically. The assertion was right and the prose was
     * wrong.
     *
     * Cheaper to catch here than to rediscover one red-team suite at a time.
     */
    const forbidden = ['STOP ALL', 'Guard', 'Constitution', 'work.execute']
    for (const entry of RUNTIME_REGISTRY) {
      for (const word of forbidden) {
        expect(entry.note.includes(word), `${entry.id} note contains "${word}", which reaches the journal`).toBe(false)
      }
    }
    // Titles are deliberately exempt, and the reason is worth stating: only `reason`
    // is journalled — `runtime.activation.decided` carries `domainId`, `outcome`,
    // `status`, `reason`, `missing` and `requestedAt`, and no title. `core.security-spine`
    // is *named* for the stop authority and would be wrong if it were not, so a rule
    // that forbade the words in titles would be forcing that domain to be vague about
    // what it is in order to satisfy a constraint that does not apply to it.
  })

  it('registers the browser extension as a port onto the hands, not its own capability', () => {
    const browserext = registryById('core.browserext')
    expect(browserext).toBeDefined()
    // Requirement-governed for the same reason as Device Hands: it shipped
    // `fail-closed` while Phase 42 was absent, which blocked it unconditionally.
    expect(browserext!.activation).toBe('activatable')
    // It requires the *same* adapter and a grant, so an extension cannot hold authority
    // the hands themselves lack. This is the whole safety argument for the entry.
    expect(browserext!.requirements.map((r) => r.kind).sort()).toEqual(
      ['capability-grant', 'host-adapter', 'journal'].sort(),
    )
    expect(browserext!.requirements.find((r) => r.kind === 'host-adapter')?.key).toBe('device-hands')
  })
})
