// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The live provider probe is only safe because of where it is *not*.
 *
 * A probe that makes a real, paid request is fine once and dangerous by
 * accident, so the things that would make it run without a person asking are
 * worth asserting. These are cheap checks about wiring, not about behaviour.
 */

const ROOT = resolve(import.meta.dirname, '..', '..')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('the live model probe', () => {
  it('is not reachable from verify, test, build or e2e', () => {
    // The whole point: none of these can spend money, so none of them may reach
    // the probe, directly or by calling another script that does.
    for (const name of ['verify', 'test', 'build', 'test:e2e', 'typecheck', 'lint']) {
      expect(pkg.scripts[name] ?? '', name).not.toMatch(/model-probe/)
    }
  })

  it('is invoked only by its own explicit script name', () => {
    const callers = Object.entries(pkg.scripts)
      .filter(([name, command]) => name !== 'core:model-probe' && /model-probe/.test(command))
      .map(([name]) => name)
    expect(callers).toEqual([])
    expect(pkg.scripts['core:model-probe']).toBeTruthy()
  })

  it('refuses on configuration alone, and names the flag that is missing', async () => {
    // The script text is checked rather than executed, so this test cannot spend
    // anything even if the guard were removed.
    const source = await readFile(join(ROOT, 'scripts', 'core-model-probe.ts'), 'utf8')

    // Both conditions, checked independently.
    expect(source).toMatch(/if \(!config\)/)
    expect(source).toMatch(/FREYA_ALLOW_LIVE_MODEL !== '1'/)
    // It goes through the real Core rather than calling fetch itself.
    expect(source).toMatch(/ownerAuthority\(core\)\.request/)
    // One small request, not a loop.
    expect(source).toMatch(/PROBE_MAX_OUTPUT_TOKENS = 16/)
    expect(source).not.toMatch(/\bfor\s*\(|while\s*\(/)
    // The key is never printed.
    expect(source).not.toMatch(/console\.(log|error)\([^)]*apiKey/)
  })

  it('does not run from application boot', async () => {
    for (const file of ['electron/main.ts', 'core/index.ts', 'src/ui/boot.ts']) {
      const source = await readFile(join(ROOT, file), 'utf8')
      expect(source, file).not.toMatch(/model-probe|modelProbe/)
    }
  })
})
