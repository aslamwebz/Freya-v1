// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * RENDERER AND HANDS DENIAL (structural proof).
 *
 * The Vault must be unreachable from the renderer and from Digital Hands, and — while
 * the binding audit is open — no Core module may hardcode a native SQLCipher package.
 * The strongest available proof is structural and deliberately blunt: no renderer
 * source may import the Vault, the preload bridge may not mention the database file or
 * the cipher pragma, the Hands domain may not import the Vault, the public Core
 * interface may not expose a Vault handle, and the binding is injected rather than
 * imported by `core/`. The runtime path-denial predicate is covered by
 * `path-policy.test.ts`.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const SQLCIPHER_IMPORT = /(?:from\s+|require\(|import\()\s*['"][^'"]*sqlcipher[^'"]*['"]/i

async function sourceFiles(dir: string, extensions = ['.ts', '.tsx']): Promise<string[]> {
  const output: string[] = []
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) output.push(path)
    }
  }
  await walk(dir)
  return output
}

async function readAll(
  dir: string,
  extensions = ['.ts', '.tsx'],
): Promise<{ path: string; source: string }[]> {
  const files = await sourceFiles(join(REPO_ROOT, dir), extensions)
  return Promise.all(files.map(async (path) => ({ path, source: await readFile(path, 'utf8') })))
}

describe('Vault renderer/Hands boundary', () => {
  it('keeps the native binding out of core: no core module imports a sqlcipher package', async () => {
    for (const file of await readAll('core')) {
      expect(file.source).not.toMatch(SQLCIPHER_IMPORT)
    }
  })

  it('is not imported by any renderer source', async () => {
    for (const file of await readAll('src')) {
      expect(file.source).not.toMatch(SQLCIPHER_IMPORT)
      expect(file.source).not.toMatch(/from\s+['"][^'"]*core\/vault/)
    }
  })

  it('is not named by the preload bridge', async () => {
    const preload = await readFile(join(REPO_ROOT, 'electron', 'preload.ts'), 'utf8')
    expect(preload).not.toMatch(SQLCIPHER_IMPORT)
    expect(preload).not.toContain('freya.db')
    expect(preload).not.toContain('cipher_version')
  })

  it('is not imported by the Digital Hands domain', async () => {
    for (const file of await readAll('core/hands')) {
      expect(file.source).not.toMatch(SQLCIPHER_IMPORT)
      expect(file.source).not.toMatch(/from\s+['"][^'"]*vault/)
    }
  })

  it('keeps the test-only SQL adapter out of core and out of the bridge', async () => {
    // `tests/core/vault/sql-adapter.ts` runs the ledger's SQL against Node's built-in
    // SQLite so the assertions are not all skipped while binding selection is blocked.
    // That is a *test* affordance and nothing else: plain SQLite must never reach the
    // product, or "no plaintext fallback" would have a second door in it.
    // Import forms only: `core/events/jsonl-store.ts` names the module in a comment
    // explaining why the journal does *not* use it, and a prose mention is not a door.
    const SQLITE_IMPORT = /(?:from\s+|require\(|import\()\s*['"][^'"]*node:sqlite[^'"]*['"]/
    for (const dir of ['core', 'src', 'electron']) {
      for (const file of await readAll(dir)) {
        expect(file.source).not.toMatch(SQLITE_IMPORT)
      }
    }
    for (const file of await readAll('scripts', ['.mjs', '.ts'])) {
      expect(file.source).not.toMatch(SQLITE_IMPORT)
    }
  })

  it('keeps every durable world store in the Vault, with no bespoke world file', async () => {
    // `PLAN.md` Step E: no new custom durable store for Phase 22. The structural proof
    // is that `core/world` cannot reach a filesystem at all, so a per-domain encrypted
    // world file cannot reappear without failing a test.
    for (const file of await readAll('core/world')) {
      expect(file.source).not.toMatch(/from ['"]node:fs/)
      expect(file.source).not.toMatch(/from ['"][^'"]*vault/)
    }
    // And the world tables live in the Vault's own migration list.
    const schema = await readFile(join(REPO_ROOT, 'core', 'vault', 'schema.ts'), 'utf8')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS world_evidence')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS world_meta')
  })

  it('does not expose a Vault accessor on the public Core interface', async () => {
    const coreIndex = await readFile(join(REPO_ROOT, 'core', 'index.ts'), 'utf8')
    const coreInterface = coreIndex.slice(
      coreIndex.indexOf('export interface Core {'),
      coreIndex.indexOf('class FreyaCore'),
    )
    expect(coreInterface).not.toMatch(/\bvault\b/i)
  })
})
