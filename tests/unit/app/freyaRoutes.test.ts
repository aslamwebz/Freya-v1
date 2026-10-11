import { describe, expect, it } from 'vitest'
import { PRIMARY_DESTINATIONS, MIND_SECTIONS, resolveRoute } from '../../../src/app/state/routes'

describe('Freya navigation compatibility', () => {
  it('names the intelligence workspace Freya and exposes its system and map', () => {
    expect(PRIMARY_DESTINATIONS.find(([id]) => id === 'mind')?.[1]).toBe('Freya')
    expect(MIND_SECTIONS).toContain('system')
    expect(MIND_SECTIONS).toContain('map')
  })
  it('retains saved Mind routes and accepts Freya shortcuts', () => {
    for (const section of ['overview', 'focus', 'memory', 'self']) {
      expect(resolveRoute(`mind/${section}`).path).toBe(`mind/${section}`)
      expect(resolveRoute(`freya/${section}`).path).toBe(`mind/${section}`)
    }
  })
})
