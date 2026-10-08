import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { requiredGates } from '../../core/qualification'

/**
 * CI enforcement for the Phase 49 gate.
 *
 * The gate catalogue is only worth having if something runs it. A qualification layer that
 * exists only as a document is exactly the kind of thing that rots into a lie, so the
 * workflow has to actually invoke it — and has to do so after the build, because a verdict
 * computed over artifacts that do not exist yet is not a verdict.
 */

const workflow = async (): Promise<string> =>
  await readFile(resolve(__dirname, '../../.github/workflows/verify.yml'), 'utf8')

describe('Phase 49 qualification gate CI enforcement', () => {
  it('runs the qualification in CI', async () => {
    expect(await workflow()).toContain('npm run qualify')
  })

  it('runs it after the build, so the verdict describes artifacts that exist', async () => {
    const content = await workflow()
    const pkg = JSON.parse(await readFile(resolve(__dirname, '../../package.json'), 'utf8'))
    expect(pkg.scripts['verify:full']).toContain('npm run build')
    const buildIndex = content.indexOf('npm run verify:full')
    const qualifyIndex = content.indexOf('npm run qualify')
    expect(buildIndex).toBeGreaterThan(-1)
    expect(qualifyIndex).toBeGreaterThan(buildIndex)
  })

  it('runs it after the Electron end-to-end pass, which needs a display', async () => {
    const content = await workflow()
    expect(content.indexOf('npm run test:e2e')).toBeLessThan(content.indexOf('npm run qualify'))
  })

  it('uploads the report, so the verdict is readable without re-running anything', async () => {
    const content = await workflow()
    expect(content).toContain('upload-artifact')
    expect(content).toContain('release/release-qualification.json')
    expect(content).toContain('release/release-qualification.md')
  })

  it('gives the job enough time for the gates it now runs twice', async () => {
    const content = await workflow()
    const timeout = /timeout-minutes:\s*(\d+)/.exec(content)
    expect(timeout).not.toBeNull()
    // The qualification pass re-executes every suite, so the old 20-minute bound no longer
    // describes the work. Asserting the floor rather than the exact number keeps this from
    // becoming a number nobody dares touch.
    expect(Number(timeout?.[1])).toBeGreaterThanOrEqual(30)
  })

  it('declares an npm script the runner can actually invoke for every gate', async () => {
    const pkg = JSON.parse(
      await readFile(resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    for (const declaration of requiredGates()) {
      const script = (declaration.command ?? [])[2]
      expect(typeof script).toBe('string')
      expect(Object.keys(pkg.scripts)).toContain(String(script))
    }
  })
})
