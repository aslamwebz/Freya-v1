// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadLocalEnv } from '../../electron/localEnv'

/**
 * The `.env` seam, and the isolation it is trusted to enforce.
 *
 * `loadLocalEnv` runs in the Electron main process and nowhere else. That makes
 * two things worth asserting directly: the loader's own rules (the real
 * environment wins, malformed lines are dropped, an oversized file is refused
 * whole, and nothing is ever reported by value), and the *negative* property —
 * that no renderer-side or bridge file ever names the credential or reads the
 * environment. The first half is behaviour; the second is a scan of exactly the
 * files that must not contain it, which is how a future widening gets caught in
 * review rather than in production.
 */

let dir = ''
const PLAIN = 'FREYA_LOCAL_ENV_PLAIN'
const QUOTED = 'FREYA_LOCAL_ENV_QUOTED'
const SINGLE = 'FREYA_LOCAL_ENV_SINGLE'
const INLINE = 'FREYA_LOCAL_ENV_INLINE'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-localenv-'))
  for (const key of [PLAIN, QUOTED, SINGLE, INLINE]) delete process.env[key]
})

afterEach(async () => {
  for (const key of [PLAIN, QUOTED, SINGLE, INLINE]) delete process.env[key]
  await rm(dir, { recursive: true, force: true })
})

function envPath(): string {
  return join(dir, '.env')
}

describe('loadLocalEnv', () => {
  it('sets plain, quoted and inline-commented values', async () => {
    await writeFile(
      envPath(),
      [
        '# a comment',
        '',
        `${PLAIN}=plain-value`,
        `${QUOTED}="quoted value"`,
        `${SINGLE}='single value'`,
        `${INLINE}=before-a-comment # trailing comment`,
      ].join('\n'),
      'utf8',
    )
    expect(loadLocalEnv(envPath()).loaded).toBe(4)
    expect(process.env[PLAIN]).toBe('plain-value')
    expect(process.env[QUOTED]).toBe('quoted value')
    expect(process.env[SINGLE]).toBe('single value')
    expect(process.env[INLINE]).toBe('before-a-comment')
  })

  it('never overrides a real environment variable', async () => {
    process.env[PLAIN] = 'from-the-real-environment'
    await writeFile(envPath(), `${PLAIN}=from-the-file`, 'utf8')
    expect(loadLocalEnv(envPath()).loaded).toBe(0)
    expect(process.env[PLAIN]).toBe('from-the-real-environment')
  })

  it('drops malformed names and lines, and stays silent for a missing file', async () => {
    await writeFile(envPath(), '2BAD=1\nnoequals\n=novalue\nbad key=1\n', 'utf8')
    expect(loadLocalEnv(envPath()).loaded).toBe(0)
    expect(loadLocalEnv(join(dir, 'no-such-file.env')).loaded).toBe(0)
  })

  it('refuses an oversized file whole rather than half-applying it', async () => {
    const padding = '# pad\n'.repeat(8_000) // ~48 KB, over the 32 KB ceiling
    await writeFile(envPath(), `${PLAIN}=should-not-be-set\n${padding}`, 'utf8')
    expect(loadLocalEnv(envPath()).loaded).toBe(0)
    expect(process.env[PLAIN]).toBeUndefined()
  })

  it('reports only a count — never a name, never a value', async () => {
    await writeFile(envPath(), `${PLAIN}=a-secret-shape-value`, 'utf8')
    const warnings: unknown[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      const result = loadLocalEnv(envPath())
      expect(result.loaded).toBe(1)
      expect(JSON.stringify(result)).not.toContain('a-secret-shape-value')
      expect(JSON.stringify(warnings)).not.toContain('a-secret-shape-value')
    } finally {
      console.warn = warn
    }
  })
})

describe('credential isolation across the boundary', () => {
  /**
   * The negative property, stated as scans.
   *
   * The provider credential is read in the main process — `electron/main.ts`,
   * fed by `electron/localEnv.ts` — and inside Core's provider from the *values*
   * the host hands it, never from the environment directly. No renderer file and
   * no preload bridge names a credential or reads `process.env`, and the
   * journal/chat/log exclusion is asserted behaviourally in
   * `tests/core/nanogpt-chat.test.ts`. A bridge that ever grows one of these is
   * a bridge handing the untrusted half a secret, and this test is where that
   * change has to be argued with.
   */
  const forbidden = /NANOGPT_API_KEY|BRAVE_SEARCH_API_KEY|OPENAI_API_KEY|process\.env/

  it('the preload bridge names no credential and reads no environment', async () => {
    const source = await readFile(join(import.meta.dirname, '..', '..', 'electron', 'preload.ts'), 'utf8')
    expect(source).not.toMatch(forbidden)
  })

  it('no renderer source reaches for the environment or a key', async () => {
    for (const relative of [
      'src/platform/modelClient.ts',
      'src/platform/coreClient.ts',
      'src/platform/conversationClient.ts',
      'src/ui/surfaces/ChatSurface.tsx',
    ]) {
      const source = await readFile(join(import.meta.dirname, '..', '..', relative), 'utf8')
      expect(source, relative).not.toMatch(forbidden)
    }
  })

  it('the main process reads .env once, at startup, and nothing else does', async () => {
    const main = await readFile(join(import.meta.dirname, '..', '..', 'electron', 'main.ts'), 'utf8')
    expect(main).toMatch(/loadLocalEnv\(join\(ROOT, '\.env'\)\)/)
    const host = await readFile(join(import.meta.dirname, '..', '..', 'electron', 'coreHost.ts'), 'utf8')
    expect(host).not.toMatch(/readFileSync|\.env['"]|localEnv/)
  })
})
