import { describe, expect, it } from 'vitest'
import { emptyWorkspace, parseWorkspace, WORKSPACE_SCHEMA } from '../../src/core/workspace'
import { SurfaceManager } from '../../src/core/surfaces/manager'

function workspaceFile(overrides: Record<string, unknown> = {}) {
  return {
    schema: WORKSPACE_SCHEMA,
    presence: 'working',
    nav: 'vault',
    savedAt: 1_700_000_000_000,
    surfaces: [
      {
        id: 'search-1',
        type: 'search',
        title: 'Search',
        context: { scope: 'vault' },
        layout: {
          x: 120,
          y: 90,
          width: 640,
          height: 500,
          minimized: false,
          maximized: false,
          pinned: true,
          z: 3,
          restoreBounds: null,
        },
      },
    ],
    ...overrides,
  }
}

describe('workspace file parsing', () => {
  it('accepts a well-formed workspace', () => {
    const parsed = parseWorkspace(workspaceFile())
    expect(parsed).not.toBeNull()
    expect(parsed?.surfaces).toHaveLength(1)
    expect(parsed?.surfaces[0]?.id).toBe('search-1')
    expect(parsed?.surfaces[0]?.context).toEqual({ scope: 'vault' })
    expect(parsed?.presence).toBe('working')
    expect(parsed?.nav).toBe('vault')
  })

  it('rejects a file written by a different schema version', () => {
    expect(parseWorkspace(workspaceFile({ schema: 99 }))).toBeNull()
  })

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['an array', []],
    ['a number', 4],
  ])('rejects %s', (_label, value) => {
    expect(parseWorkspace(value)).toBeNull()
  })

  it('refuses a surface type the shell does not know', () => {
    const parsed = parseWorkspace(
      workspaceFile({
        surfaces: [{ ...workspaceFile().surfaces[0], type: 'backdoor' }],
      }),
    )
    expect(parsed?.surfaces).toHaveLength(0)
  })

  it('refuses a surface id that is not a safe identifier', () => {
    for (const id of ['../../etc/passwd', 'Chat 1', '', 'x'.repeat(80)]) {
      const parsed = parseWorkspace(
        workspaceFile({ surfaces: [{ ...workspaceFile().surfaces[0], id }] }),
      )
      expect(parsed?.surfaces).toHaveLength(0)
    }
  })

  it('drops entries with unusable geometry instead of failing the whole file', () => {
    const base = workspaceFile().surfaces[0]!
    const parsed = parseWorkspace(
      workspaceFile({
        surfaces: [
          { ...base, id: 'ok-1' },
          { ...base, id: 'zero-1', layout: { ...base.layout, width: 0 } },
          { ...base, id: 'nan-1', layout: { ...base.layout, width: Number.NaN } },
        ],
      }),
    )
    expect(parsed?.surfaces.map((s) => s.id)).toEqual(['ok-1'])
  })

  it('de-duplicates repeated ids', () => {
    const base = workspaceFile().surfaces[0]!
    const parsed = parseWorkspace(
      workspaceFile({ surfaces: [{ ...base }, { ...base, title: 'dupe' }] }),
    )
    expect(parsed?.surfaces).toHaveLength(1)
  })

  it('coerces non-finite numbers and unknown flags to safe values', () => {
    const base = workspaceFile().surfaces[0]!
    const parsed = parseWorkspace(
      workspaceFile({
        surfaces: [
          {
            ...base,
            layout: {
              ...base.layout,
              x: Number.POSITIVE_INFINITY,
              y: -50,
              minimized: 'yes',
              pinned: 1,
            },
          },
        ],
      }),
    )
    const layout = parsed?.surfaces[0]?.layout
    expect(Number.isFinite(layout?.x ?? Number.NaN)).toBe(true)
    expect(layout?.y).toBe(-50)
    expect(layout?.minimized).toBe(false)
    expect(layout?.pinned).toBe(false)
  })

  it('never restores a surface in the maximised state', () => {
    const base = workspaceFile().surfaces[0]!
    const parsed = parseWorkspace(
      workspaceFile({ surfaces: [{ ...base, layout: { ...base.layout, maximized: true } }] }),
    )
    expect(parsed?.surfaces[0]?.layout.maximized).toBe(false)
  })

  it('falls back to defaults for an unknown presence or nav', () => {
    const parsed = parseWorkspace(workspaceFile({ presence: 'ascendant', nav: 42 }))
    expect(parsed?.presence).toBe('idle')
    expect(parsed?.nav).toBe('home')
  })

  it('caps the number of surfaces it will restore', () => {
    const base = workspaceFile().surfaces[0]!
    const surfaces = Array.from({ length: 80 }, (_, i) => ({ ...base, id: `s-${i}` }))
    expect(parseWorkspace(workspaceFile({ surfaces }))?.surfaces).toHaveLength(32)
  })

  it('produces an empty workspace that the manager can boot from', () => {
    const manager = new SurfaceManager({ frame: { width: 1200, height: 800 } })
    manager.restore(parseWorkspace(emptyWorkspace())?.surfaces ?? [])
    expect(manager.surfaces).toHaveLength(0)
  })
})
