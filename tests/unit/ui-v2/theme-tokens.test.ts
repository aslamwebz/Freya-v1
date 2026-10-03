import { describe, expect, it } from 'vitest'
import { THEMES, themeCss, themeTokens, allThemeCss } from '../../../src/ui-v2/theme/tokens'

describe('theme tokens', () => {
  it('defines abyss, dawn, violet and vessel', () => {
    expect(THEMES).toEqual(['abyss', 'dawn', 'violet', 'vessel'])
  })
  it('abyss uses the plan identity palette (no gold)', () => {
    const t = themeTokens('abyss')
    expect(t.intelligence).toMatch(/^#[0-9a-f]{6}$/i)
    expect(t.colorScheme).toBe('dark')
    expect(t.glow).not.toBe('none')
    for (const value of Object.values(t)) {
      expect(String(value).toLowerCase()).not.toContain('gold')
    }
  })
  it('emits a data-theme selector for each theme with --f- prefixed vars', () => {
    expect(themeCss('abyss')).toContain("[data-theme='abyss']")
    expect(themeCss('vessel')).toContain('--f-action:')
    const all = allThemeCss()
    expect(all.match(/data-theme=/g)?.length).toBe(THEMES.length)
  })
  it('fully populates every role for every theme without placeholders', () => {
    for (const id of THEMES) {
      const tokens = themeTokens(id)
      for (const [key, value] of Object.entries(tokens)) {
        expect(String(value), `${id}.${key}`).not.toBe('')
        expect(String(value), `${id}.${key}`).not.toMatch(/TODO|placeholder/i)
      }
      expect(['dark', 'light']).toContain(tokens.colorScheme)
    }
  })
  it('dawn is light and vessel is dark, both using a no-gold identity accent', () => {
    expect(themeTokens('dawn').colorScheme).toBe('light')
    expect(themeTokens('vessel').colorScheme).toBe('dark')
    for (const id of THEMES) {
      const tokens = themeTokens(id)
      expect(tokens.intelligence).toMatch(/^#[0-9a-f]{6}$/i)
      for (const value of Object.values(tokens)) {
        expect(String(value).toLowerCase()).not.toContain('gold')
      }
    }
  })
})
