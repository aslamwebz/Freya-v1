// @vitest-environment node
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { SourceWorkspace } from '../../core/explorer/source-workspace'

it('stages edits in another worktree, refuses escape and stale revisions, and shows diffs', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'freya-source-'))
  execFileSync('git', ['init', repo]); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']); execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid'])
  await writeFile(join(repo, 'example.ts'), 'const value = 1\n')
  execFileSync('git', ['-C', repo, 'add', 'example.ts']); execFileSync('git', ['-C', repo, 'commit', '-m', 'initial'])
  const service = new SourceWorkspace(repo, join(repo, '.development'))
  try {
    const original = await service.execute({ operation: 'read', path: 'example.ts' })
    await service.execute({ operation: 'write', path: 'example.ts', revision: original.revision, content: 'const value = 2\n' })
    expect(await readFile(join(repo, 'example.ts'), 'utf8')).toContain('1')
    expect((await service.execute({ operation: 'diff' })).output).toContain('+const value = 2')
    await expect(service.execute({ operation: 'write', path: 'example.ts', revision: original.revision, content: 'bad' })).rejects.toThrow(/revision/)
    await expect(service.execute({ operation: 'read', path: '../.env' })).rejects.toThrow()
    await expect(service.execute({ operation: 'read', path: '.git/config' })).rejects.toThrow()
    await expect(service.execute({ operation: 'read', path: '.env' })).rejects.toThrow()
    await expect(service.execute({ operation: 'write', path: 'example.ts', content: 'bad', authority: 'owner' } as never)).rejects.toThrow()
    const current = await service.execute({ operation: 'read', path: 'example.ts' })
    await expect(service.execute({ operation: 'write', path: 'example.ts', revision: current.revision, content: 'é'.repeat(130000) })).rejects.toThrow(/bounded/)
    await expect(service.execute({ operation: 'create', path: 'binary.ts', content: 'a\0b' })).rejects.toThrow(/text/)
    const deleted = await service.execute({ operation: 'delete', path: 'example.ts', revision: current.revision })
    await service.execute({ operation: 'rollback', path: 'example.ts', revision: deleted.revision })
    expect((await service.execute({ operation: 'read', path: 'example.ts' })).content).toContain('value = 1')
    const safe = await service.execute({ operation: 'read', path: 'example.ts' })
    await service.execute({ operation: 'write', path: 'example.ts', revision: safe.revision, content: 'const value = 3\n' })
    const pattern = await service.execute({ operation: 'create', path: '[e]xample.ts', content: 'separate file\n' })
    await expect(service.execute({ operation: 'rollback', path: '[e]xample.ts', revision: pattern.revision })).rejects.toThrow()
    expect((await service.execute({ operation: 'read', path: 'example.ts' })).content).toContain('value = 3')
    const patternDeleted = await service.execute({ operation: 'delete', path: '[e]xample.ts', revision: pattern.revision })
    await expect(service.execute({ operation: 'rollback', path: '[e]xample.ts', revision: patternDeleted.revision })).rejects.toThrow()
    expect((await service.execute({ operation: 'read', path: 'example.ts' })).content).toContain('value = 3')
    await writeFile(join(repo, '.development', 'vite.config.ts'), "throw new Error('MUST NOT EXECUTE')")
    expect((await service.execute({ operation: 'test' })).output).toContain('No test process was launched')
    await writeFile(join(repo, '.development', '.env'), 'PRIVATE_SENTINEL')
    execFileSync('git', ['-C', join(repo, '.development'), 'add', '.env'])
    expect((await service.execute({ operation: 'diff' })).output).not.toContain('PRIVATE_SENTINEL')
    await expect(service.execute({ operation: 'commit', message: 'refuse protected staged file' })).rejects.toThrow(/protected/)
    for (const path of ['.env.', '.. /example.ts', 'NUL.txt', 'example.ts:stream']) await expect(service.execute({ operation: 'read', path })).rejects.toThrow()
    if (process.platform === 'win32') {
      const root = join(repo, '.development'), saved = join(repo, '.saved-development')
      await rename(root, saved)
      try {
        await symlink(repo, root, 'junction')
        await expect(service.execute({ operation: 'write', path: 'example.ts', revision: original.revision, content: 'redirected' })).rejects.toThrow(/junction/)
        expect(await readFile(join(repo, 'example.ts'), 'utf8')).toContain('value = 1')
      } finally { await unlink(root); await rename(saved, root) }
    }
  } finally {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', join(repo, '.development')])
    await rm(repo, { recursive: true, force: true })
  }
})
